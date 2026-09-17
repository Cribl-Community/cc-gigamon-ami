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

/** A window this long or shorter gets this running-time cap. */
export interface CapTier {
  upToSeconds: number
  capSeconds: number
}

/**
 * Server-side running-time cap for a live query, scaled by the window it reads:
 * up to 1 h → 120 s, 4 h → 300 s, 24 h → 600 s, longer (Data Flow's pinned
 * 30 days) → 900 s. A flat cap is wrong in both directions — low enough to
 * protect a `-15m` panel and it cuts off the 30-day total; high enough for
 * 30 days and a runaway 15-minute query bills for a quarter of an hour.
 *
 * **These seconds are sized against the demo feed, and are the weakest numbers
 * in this file.** The same query on a production tenant reads more data in the
 * same wall time, so a cap this table thinks is generous can stop a panel that
 * was working fine — and a stopped panel reads to the customer as a broken app,
 * not as a budget decision. An installer therefore has to be able to raise them
 * without a code change, and can: components/SearchLimitsPanel.tsx is that
 * surface and cribl/searchCaps.ts stores what it saves, both of them going
 * through `setCapTiers` below. This table is what applies when nothing is
 * stored, which is the normal case and the one every install starts in.
 */
export const DEFAULT_CAP_TIERS: readonly CapTier[] = [
  { upToSeconds: 3600, capSeconds: 120 },
  { upToSeconds: 4 * 3600, capSeconds: 300 },
  { upToSeconds: 86400, capSeconds: 600 },
  { upToSeconds: Infinity, capSeconds: 900 },
]

/**
 * The narrowest and widest cap an installer may set.
 *
 * `setCapTiers` refuses a table that is not a table. These refuse one that is a
 * perfectly well-formed table and still nonsense, which is the failure an
 * install-wide setting actually has: a typo, a copied figure in the wrong unit,
 * or a "make it never stop" that someone meant kindly. Both bounds are a
 * judgement rather than a measurement, so here is the judgement.
 *
 * THE CEILING. A cap is a wall-clock time somebody waits out — the client gives
 * up 30 s after it (clientTimeoutMs), and a panel that has not answered in an
 * hour has failed in every sense a customer cares about, whatever the job is
 * still doing. Cost says the same thing from the other side: the engine fans a
 * live query out across the dataset, so wall-clock seconds and billable
 * CPU-seconds are different quantities — one 6-second query measured on this
 * workspace billed 127 CPU-seconds, roughly twenty to one. At 1 credit per
 * billable CPU-hour that puts a single query running out a one-hour cap in the
 * region of twenty credits; the same arithmetic on a day-long cap is several
 * hundred credits for one runaway panel, which is why a day is not a cap but the
 * absence of one. That ratio is a demo-feed measurement quoted to show the
 * shape, not a number anything here computes from: the ceiling is a flat hour.
 *
 * THE FLOOR is the mirror image. A single query against this Lake dataset has a
 * measured floor near five seconds before it has read anything worth reading,
 * and the app's long-range panels have legitimately taken 154 s. Below 30 s a
 * cap can no longer tell a runaway query from an ordinary one; it stops both,
 * and every panel on the tab reports a time limit it never used to hit.
 */
export const MIN_CAP_SECONDS = 30
export const MAX_CAP_SECONDS = 3600

/**
 * Read a cap table from something untrusted — a KV document written by an older
 * version of this app, edited by hand in the store, or typed into the settings
 * form — and answer null when there is nothing usable in it.
 *
 * Null means "keep whatever is in force". That is deliberately the same answer
 * for absent, corrupt and absurd, because on the load path all three have the
 * same correct response: leave DEFAULT_CAP_TIERS alone and write nothing.
 *
 * A bad row refuses the WHOLE table rather than being filtered out the way
 * `setCapTiers` filters. Dropping one row silently changes which window gets
 * which cap, and what survives is a table nobody chose; refusing leaves the
 * table someone did choose.
 *
 * What it does NOT refuse: a wider window with a shorter cap than a narrower
 * one. It looks upside down, but "anything over 4 h fails fast, I only care
 * about the live panels" is a real position an installer can hold, and it is not
 * evidence of corruption.
 */
export function parseCapTiers(value: unknown): CapTier[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const tiers: CapTier[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object') return null
    const { upToSeconds, capSeconds } = row as { upToSeconds?: unknown; capSeconds?: unknown }
    if (typeof capSeconds !== 'number' || !Number.isFinite(capSeconds)) return null
    if (capSeconds < MIN_CAP_SECONDS || capSeconds > MAX_CAP_SECONDS) return null
    // JSON has no Infinity — `JSON.stringify` writes the widest tier's bound as
    // null — so null, and an absent field, mean "no upper bound" on the way back
    // in. Anything else has to be a real positive number.
    const upTo = upToSeconds === null || upToSeconds === undefined ? Infinity : upToSeconds
    if (typeof upTo !== 'number' || Number.isNaN(upTo) || upTo <= 0) return null
    tiers.push({ upToSeconds: upTo, capSeconds: Math.round(capSeconds) })
  }
  return tiers.sort((a, b) => a.upToSeconds - b.upToSeconds)
}

let capTiers: readonly CapTier[] = DEFAULT_CAP_TIERS

/**
 * Replace the cap table — from the settings surface, and from tests.
 * Tiers are sorted here, so a caller may pass them in any order. An empty or
 * malformed table is refused rather than accepted, because the failure mode of
 * losing the caps is an unbounded bill, which is the thing they exist to stop.
 *
 * This only checks that a table is a table. Anything reading numbers a person or
 * a stored document supplied runs them through `parseCapTiers` first, which is
 * where "well-formed but absurd" is caught.
 */
export function setCapTiers(tiers: readonly CapTier[]): void {
  const valid = tiers.filter((t) => t.capSeconds > 0 && t.upToSeconds > 0)
  if (!valid.length) {
    console.warn('Cribl Search: ignoring an empty running-time cap table; keeping the one in force')
    return
  }
  capTiers = [...valid].sort((a, b) => a.upToSeconds - b.upToSeconds)
}

/** The table in force — for the settings UI to show, and for tests to restore. */
export function capTiersInForce(): readonly CapTier[] {
  return capTiers
}

export function capSecondsFor(earliest: string | number): number {
  const span = windowSpanSeconds(earliest)
  // Past the widest tier, take the widest cap rather than running uncapped.
  return (capTiers.find((t) => span <= t.upToSeconds) ?? capTiers[capTiers.length - 1]).capSeconds
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
 * stops billing instead of running to its cap. Fire-and-forget: a failure
 * changes nothing for the caller, but it is logged, because a cancel that
 * silently never happens looks exactly like one that worked. No `keepalive`:
 * the platform's fetch proxy does not document it, and a tab switch does not
 * unload the page.
 */
export function cancelJob(jobId: string): void {
  try {
    fetch(searchUrl(`/search/jobs/${encodeURIComponent(jobId)}/cancel`), { method: 'POST' })
      .then((res) => {
        if (!res.ok) console.warn(`Cribl Search: cancel of job ${jobId} answered ${res.status}`)
      })
      .catch((err: unknown) => console.warn(`Cribl Search: cancel of job ${jobId} failed`, err))
  } catch (err) {
    console.warn(`Cribl Search: cancel of job ${jobId} failed`, err)
  }
}

/**
 * Submit a job. The POST is deliberately not aborted: if the search is
 * abandoned while it is in flight, aborting it would lose the job id while the
 * job still starts in Cribl. Instead the submit completes, and a job whose
 * search was abandoned meanwhile is cancelled at once.
 */
async function submitJob(query: string, earliest: string | number, latest: string | number, signal?: AbortSignal): Promise<string> {
  const created = await api<{ items: Array<{ id: string }> }>(searchUrl('/search/jobs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: withExecPrefix(query, earliest), earliest, latest }),
  })
  const jobId = created.items?.[0]?.id
  if (!jobId) throw new Error('Cribl Search did not return a job id')
  if (signal?.aborted) {
    cancelJob(jobId)
    throw new DOMException('Aborted', 'AbortError')
  }
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
