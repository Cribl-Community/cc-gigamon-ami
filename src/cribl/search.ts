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

export type Row = Record<string, unknown>

export interface SearchOptions {
  earliest?: string | number // e.g. '-15m' or epoch seconds
  latest?: string | number // e.g. 'now'
  limit?: number
  signal?: AbortSignal
  pollMs?: number
  timeoutMs?: number
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
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

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
  const { earliest = '-15m', latest = 'now', limit = 5000, signal, pollMs = 700, timeoutMs = 90000 } = opts

  const created = await api<{ items: Array<{ id: string }> }>(
    searchUrl('/search/jobs'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, earliest, latest }),
    },
    signal,
  )
  const jobId = created.items?.[0]?.id
  if (!jobId) throw new Error('Cribl Search did not return a job id')

  const started = Date.now()
  // Poll job status until terminal state.
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('Cribl Search timed out')
    const st = await api<{ items: Array<{ status?: string }> }>(
      searchUrl(`/search/jobs/${jobId}/status`),
      { method: 'GET' },
      signal,
    )
    const status = st.items?.[0]?.status
    if (status === 'failed' || status === 'canceled') throw new Error(`Cribl Search ${status}`)
    if (status === 'completed') break
    await sleep(pollMs, signal)
  }

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
  const { earliest = '-15m', latest = 'now', signal, pollMs = 700, timeoutMs = 90000 } = opts
  const created = await api<{ items: Array<{ id: string }> }>(
    searchUrl('/search/jobs'),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, earliest, latest }) },
    signal,
  )
  const jobId = created.items?.[0]?.id
  if (!jobId) throw new Error('Cribl Search did not return a job id')
  const started = Date.now()
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('Cribl Search timed out')
    const st = await api<{ items: Array<{ status?: string }> }>(searchUrl(`/search/jobs/${jobId}/status`), { method: 'GET' }, signal)
    const status = st.items?.[0]?.status
    if (status === 'failed' || status === 'canceled') throw new Error(`Cribl Search ${status}`)
    if (status === 'completed') break
    await new Promise((r) => setTimeout(r, pollMs))
  }
  const data = await api<{ fields?: FieldSummary[] }>(searchUrl(`/search/jobs/${jobId}/field-summaries`), { method: 'GET' }, signal)
  const fields = data.fields ?? []
  const sampled = fields.reduce((m, f) => Math.max(m, f.count + f.countNull), 0)
  return { fields, sampled }
}
