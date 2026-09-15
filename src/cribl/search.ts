// Cribl Search client: submit a KQL job, poll to completion, return result rows.
//
// Cribl Search uses KQL. Results are returned as NDJSON: a header line with
// `totalEventCount`/`job`, followed by one JSON object per result row.
//
// Query language reminders (learned against this workspace):
//   dataset="gigamon_ami" | where app_name=="dns" | summarize c=count() by dns_host
//     | sort by c desc | limit 10
//   aggregations: count(), sum(f), avg(f), min/max(f), count_distinct(f), percentile(f,95)
//   NOT `dc()` — use count_distinct(). Sorting is `sort by <col> desc`.

import { searchUrl, LAKE_DATASET } from './config'
import { beginQuery, endQuery } from './inflight'
import { recordJobCost, type CostSlot } from './jobCost'

export type Row = Record<string, unknown>

export interface SearchOptions {
  earliest?: string | number // e.g. '-15m' or epoch seconds
  latest?: string | number // e.g. 'now'
  limit?: number
  signal?: AbortSignal
  pollMs?: number
  timeoutMs?: number
  /** Where to record this job's measured cost (the auto-refresh cost labels). */
  costSlot?: CostSlot
}

export interface SearchResult {
  jobId: string
  rows: Row[]
  totalEventCount: number
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fetch with retry on 429 / 5xx (Cribl search queue back-pressure). */
async function fetchRetry(url: string, init: RequestInit, signal?: AbortSignal, tries = 4): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal })
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < tries - 1) {
          await wait(300 * Math.pow(2, attempt) + Math.random() * 200)
          continue
        }
      }
      return res
    } catch (e) {
      if (signal?.aborted) throw e
      lastErr = e
      if (attempt < tries - 1) await wait(300 * Math.pow(2, attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Cribl request failed')
}

async function api<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await fetchRetry(url, init, signal)
  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(`Cribl API ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }
  return res.json() as Promise<T>
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Seconds a relative earliest bound ('-15m', '-24h', '-30d') or epoch-seconds bound reaches back. */
function windowSpanSeconds(earliest: string | number): number {
  if (typeof earliest === 'number') return Math.max(0, Date.now() / 1000 - earliest)
  const m = /^-(\d+)\s*([smhdw])$/.exec(earliest.trim())
  if (!m) return 0
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 's' | 'm' | 'h' | 'd' | 'w']
  return Number(m[1]) * unit
}

/**
 * Server-side running-time cap for a live query, scaled by the window it reads:
 * up to 1 h → 120 s, 4 h → 300 s, 24 h → 600 s, longer (Data Flow's pinned
 * 30 days) → 900 s. A flat 120 s would cut off `-24h` panels on a tenant with a
 * larger feed; the values are checked against measured wall time per range.
 */
export function capSecondsFor(earliest: string | number): number {
  const span = windowSpanSeconds(earliest)
  if (span <= 3600) return 120
  if (span <= 4 * 3600) return 300
  if (span <= 86400) return 600
  return 900
}

/** How long the client waits before giving up and cancelling: 30 s past the
 *  server cap, so the cap — which reports why it stopped — acts first. A flat
 *  90 s would cancel legitimate long-range searches the cap allows (Data
 *  Flow's 30-day total has taken 154 s). */
function clientTimeoutMs(capSeconds: number): number {
  return (capSeconds + 30) * 1000
}

/** A search Cribl stopped because it reached its running-time cap. */
export class SearchTimeLimitError extends Error {
  readonly capSeconds: number
  constructor(capSeconds: number) {
    super(`This search reached its ${Math.round(capSeconds / 60)}-minute time limit and was stopped. Try a shorter time range.`)
    this.name = 'SearchTimeLimitError'
    this.capSeconds = capSeconds
  }
}

/** Whether a failed job was ended by its running-time cap: Cribl records "Job
 *  has been running for the maximum allowed duration" among the job's errors
 *  (a user cancel records "User canceled execution" instead). */
async function stoppedByTimeLimit(jobId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const job = await api<{ items?: Array<{ errorStateConfig?: { errors?: Array<{ message?: unknown }> } }> }>(
      searchUrl(`/search/jobs/${jobId}`),
      { method: 'GET' },
      signal,
    )
    return (job.items?.[0]?.errorStateConfig?.errors ?? []).some((e) => String(e.message ?? '').includes('maximum allowed duration'))
  } catch {
    return false
  }
}

/** The query as executed. The `set` prefix goes into the job body only — a
 *  panel's ⓘ keeps showing the query string it was given. */
function withExecPrefix(query: string, earliest: string | number): string {
  return `set max_running_time_per_search=${capSecondsFor(earliest)}; ${query}`
}

/**
 * Ask Cribl Search to stop a job this session created, so an abandoned search
 * stops billing instead of running to its cap. Fire-and-forget: `keepalive`
 * lets the request outlive an unmounting tab, and a failure (the job already
 * finished, a network error) changes nothing for the caller.
 */
export function cancelJob(jobId: string): void {
  try {
    void fetch(searchUrl(`/search/jobs/${encodeURIComponent(jobId)}/cancel`), { method: 'POST', keepalive: true }).catch(() => {})
  } catch {
    /* ignore */
  }
}

async function submitJob(query: string, earliest: string | number, latest: string | number, signal?: AbortSignal): Promise<string> {
  const created = await api<{ items: Array<{ id: string }> }>(
    searchUrl('/search/jobs'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: withExecPrefix(query, earliest), earliest, latest }),
    },
    signal,
  )
  const jobId = created.items?.[0]?.id
  if (!jobId) throw new Error('Cribl Search did not return a job id')
  return jobId
}

/** Poll job status until it completes. On abort or the client timeout the job
 *  is cancelled on the server too. A job the server cap stopped throws
 *  SearchTimeLimitError, so the panel can say so instead of "failed". */
async function waitForJob(jobId: string, signal: AbortSignal | undefined, pollMs: number, timeoutMs: number, capSeconds: number): Promise<void> {
  const started = Date.now()
  try {
    for (;;) {
      if (Date.now() - started > timeoutMs) {
        cancelJob(jobId)
        throw new Error('Cribl Search timed out')
      }
      const st = await api<{ items: Array<{ status?: string }> }>(
        searchUrl(`/search/jobs/${jobId}/status`),
        { method: 'GET' },
        signal,
      )
      const status = st.items?.[0]?.status
      if (status === 'failed' && (await stoppedByTimeLimit(jobId, signal))) throw new SearchTimeLimitError(capSeconds)
      if (status === 'failed' || status === 'canceled') throw new Error(`Cribl Search ${status}`)
      if (status === 'completed') return
      await sleep(pollMs, signal)
    }
  } catch (err) {
    if (signal?.aborted) cancelJob(jobId)
    throw err
  }
}

/** Run a Cribl Search query and return the result rows once the job completes. */
export async function runSearch(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  beginQuery()
  try {
    return await runSearchInner(query, opts)
  } finally {
    endQuery()
  }
}

async function runSearchInner(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const { earliest = '-15m', latest = 'now', limit = 5000, signal, pollMs = 700, timeoutMs, costSlot } = opts
  const cap = capSecondsFor(earliest)

  const jobId = await submitJob(query, earliest, latest, signal)
  await waitForJob(jobId, signal, pollMs, timeoutMs ?? clientTimeoutMs(cap), cap)
  if (costSlot) void recordJobCost(costSlot, `${earliest} ${query}`, jobId)

  // Results are NDJSON: header line then row lines.
  const res = await fetchRetry(searchUrl(`/search/jobs/${jobId}/results?limit=${limit}`), {}, signal)
  if (!res.ok) throw new Error(`Cribl Search results ${res.status}`)
  const text = await res.text()
  let totalEventCount = 0
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let obj: Row
    try {
      obj = JSON.parse(s) as Row
    } catch {
      continue
    }
    if (typeof (obj as { totalEventCount?: number }).totalEventCount === 'number' && 'job' in obj) {
      totalEventCount = (obj as { totalEventCount: number }).totalEventCount
    } else {
      rows.push(obj)
    }
  }
  return { jobId, rows, totalEventCount }
}

/** Convenience: prefix a filter/pipeline onto the gigamon_ami dataset. */
export function q(pipeline: string): string {
  return `dataset="${LAKE_DATASET}" ${pipeline}`
}

export interface FieldSummary {
  name: string
  type: string
  count: number // events where the field is present
  countDistinct: number
  countNull: number
  topValues: { value: unknown; count: number }[]
}

export interface FieldSummariesResult {
  fields: FieldSummary[]
  sampled: number
}

/** Run a search and return per-field summaries (fill, cardinality, top values). */
export async function runFieldSummaries(query: string, opts: SearchOptions = {}): Promise<FieldSummariesResult> {
  beginQuery()
  try {
    return await runFieldSummariesInner(query, opts)
  } finally {
    endQuery()
  }
}

async function runFieldSummariesInner(query: string, opts: SearchOptions = {}): Promise<FieldSummariesResult> {
  const { earliest = '-15m', latest = 'now', signal, pollMs = 700, timeoutMs, costSlot } = opts
  const cap = capSecondsFor(earliest)
  const jobId = await submitJob(query, earliest, latest, signal)
  await waitForJob(jobId, signal, pollMs, timeoutMs ?? clientTimeoutMs(cap), cap)
  if (costSlot) void recordJobCost(costSlot, `${earliest} ${query}`, jobId)
  const data = await api<{ fields?: FieldSummary[] }>(searchUrl(`/search/jobs/${jobId}/field-summaries`), { method: 'GET' }, signal)
  const fields = data.fields ?? []
  const sampled = fields.reduce((m, f) => Math.max(m, f.count + f.countNull), 0)
  return { fields, sampled }
}
