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

import { activeDataset, searchUrl, toActiveDataset, LAKE_DATASET } from './config'
import { beginQuery, endQuery } from './inflight'
import { recordJobCost, type CostSlot } from './jobCost'

export type Row = Record<string, unknown>

export interface SearchOptions {
  earliest?: string | number // e.g. '-15m' or epoch seconds
  latest?: string | number // e.g. 'now'
  limit?: number
  signal?: AbortSignal
  /**
   * Fix the gap between status checks instead of letting it ramp. Tests, and a
   * caller that knows how long its job takes; everything else wants the ramp
   * (POLL_RAMP_MS), which is faster for a short job and cheaper for a long one.
   */
  pollMs?: number
  timeoutMs?: number
  /** Where to record this job's measured cost (the auto-refresh cost labels). */
  costSlot?: CostSlot
  /**
   * Let Cribl answer this from a result it already has, if one is recent enough
   * — see REUSE_WINDOW. Off by default: a caller that submits a job to MEASURE
   * something (the landing-lag probe) or to read something already stored (a
   * `$vt_results` read) must get a real run, and defaulting this on would have
   * changed what those calls mean without anybody editing them.
   */
  reuse?: boolean
  /**
   * Run the query against the dataset it names, whatever the app is reading.
   *
   * Every other query follows the active dataset (config.ts): while only sample
   * data exists, a panel written against `gigamon_ami` runs against the sample
   * dataset. Two kinds of caller must not follow it — the probe that DECIDES
   * which dataset is active (it asks about the customer's dataset by
   * definition), and a measurement of how the customer's dataset lands, which
   * is about that dataset and no other.
   */
  asWritten?: boolean
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

/**
 * How old a result Cribl already has may be before this app stops accepting it
 * in place of a new run.
 *
 * MEASURED (A-SP21): a repeat of the same query at the same relative range came
 * back in 0.95 s against 30.92 s live, and billed nothing. The match is on the
 * relative range SPEC — `-15m` matches `-15m`, not the resolved window — and the
 * `set` options are normalised out of the key, so the cap prefix above does not
 * stop a reuse and the original run needs no flag of its own.
 *
 * TWO MINUTES IS A CORRECTNESS DECISION, NOT A COST ONE (A-D15). The number on
 * screen is allowed to be up to this old, so the window has to be short enough
 * that a viewer watching a live panel cannot be misled by it and long enough to
 * cover the thing it exists for: the first paint of a tab, and switching away
 * and back. On a feed that lands in minutes, two minutes is inside the noise of
 * what a `-15m` panel already averages over. Anything materially longer would
 * be a cache with no expiry story, which is what the Snapshot mode is for —
 * dated, labelled and chosen, rather than silent.
 *
 * It is quoted because Cribl's parser wants a string here; A-SP21 measured
 * `"24h"` in exactly this shape.
 */
export const REUSE_WINDOW = '2min'
/** The same window in seconds, for callers deciding whether reuse can possibly
 *  help them — an auto-refresh faster than this would re-serve its own last
 *  answer. Kept beside the string so the two cannot drift. */
export const REUSE_WINDOW_SECONDS = 120

/**
 * The virtual table a stored scheduled result is read from, named here so this
 * module can refuse to put a reuse directive on one.
 *
 * accel/read.ts owns this name (it exports `VT_RESULTS`) and cannot be imported
 * from here — it imports this file. The duplication is deliberate and the reason
 * is A-D15: a stored-result read must carry no results directive, ever, and
 * "every call site remembers to pass `reuse: false`" is not a guarantee. This
 * is, and read.test.ts asserts the submitted body from the other side.
 */
const VT_RESULTS_TABLE = '$vt_results'

/** The query as executed. The `set` prefixes go into the job body only — a
 *  panel's ⓘ keeps showing the query string it was given. */
function withExecPrefix(query: string, earliest: string | number, reuse: boolean): string {
  const cap = `set max_running_time_per_search=${capSecondsFor(earliest)}; `
  if (!reuse || query.includes(VT_RESULTS_TABLE)) return `${cap}${query}`
  return `${cap}set allow_previous_results="${REUSE_WINDOW}"; ${query}`
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
/**
 * THE ONE PLACE A QUERY IS MOVED ONTO THE SAMPLE DATASET — the text a job
 * actually runs. `submitJob` sends it, so no panel, fallback or direct read can
 * forget the move; the ⓘ makes the same move for display
 * (components/PanelInfo.tsx).
 *
 * It is also what a job's measured cost is filed under (`costKey`). Filed
 * under the query as written, a figure measured on the sample would match the
 * same panel's first job on real data and never be measured again — a 0.1 CPU-s
 * sample price quoted for a 130 CPU-s scan (review 2026-09-24, defect 1).
 *
 * AND THE ONE PLACE A QUERY IS ROUTED (Phase 8.1, 2026-09-25). After the sample
 * seam — which takes precedence and, while the app reads the sample, is the
 * only move made — the installed router may send a query to the Parquet copy
 * (cribl/routing/route.ts). Computed ONCE per job, so the body sent and the
 * cost key filed describe the same run. `routed` says the router was asked,
 * so the client can tell it, once the job has answered, where it ran
 * (`landed`, below).
 */
function executedQuery(query: string, asWritten: boolean, earliest: string | number, latest: string | number): { text: string; routed: boolean } {
  if (asWritten) return { text: query, routed: false }
  if (activeDataset() !== LAKE_DATASET) return { text: toActiveDataset(query), routed: false }
  return { text: router(query, { earliest, latest }), routed: true }
}

/**
 * Chooses the dataset a query as written runs on. cribl/routing/route.ts
 * installs the real one from main.tsx; it cannot be imported here, because it
 * reaches every src/queries module and those import `q()` from this one.
 */
export type QueryRouter = (query: string, window: { earliest: string | number; latest: string | number }) => string

/**
 * Told, once a routed job's results have been read, the query as written and
 * the text that ran — so the ⓘ names the dataset of the figure now on screen,
 * never one a job still in flight, failed or aborted was sent to
 * (routing/ranOn.ts).
 */
export type RouteLanded = (query: string, executed: string) => void

const AS_WRITTEN: QueryRouter = (query) => query
let router: QueryRouter = AS_WRITTEN
let landed: RouteLanded | null = null

/** main.tsx (through `installQueryRouter`) and tests. `null` puts back "run as written" and forgets `onLanded`. */
export function setQueryRouter(next: QueryRouter | null, onLanded: RouteLanded | null = null): void {
  router = next ?? AS_WRITTEN
  landed = next ? onLanded : null
}

/** A routed job answered and was not abandoned: say where it ran. */
function reportLanded(query: string, executed: { text: string; routed: boolean }, signal: AbortSignal | undefined): void {
  if (executed.routed && !signal?.aborted) landed?.(query, executed.text)
}

/** The cost slot's key: the window and the text that actually ran. */
function costKey(executed: string, earliest: string | number): string {
  return `${earliest} ${executed}`
}

async function submitJob(
  executed: string,
  earliest: string | number,
  latest: string | number,
  signal?: AbortSignal,
  reuse = false,
): Promise<string> {
  const created = await api<{ items: Array<{ id: string }> }>(searchUrl('/search/jobs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: withExecPrefix(executed, earliest, reuse), earliest, latest }),
  })
  const jobId = created.items?.[0]?.id
  if (!jobId) throw new Error('Cribl Search did not return a job id')
  if (signal?.aborted) {
    cancelJob(jobId)
    throw new DOMException('Aborted', 'AbortError')
  }
  return jobId
}

/**
 * How long to wait after the nth status check before asking again.
 *
 * WHAT THE FLAT 700 ms COST. The status GET is at the top of the loop, so a job
 * that finishes inside one round trip pays no sleep at all — but anything that
 * does not is rounded up to the next 700 ms, and the jobs this app now runs
 * fastest are exactly the ones that lost the most to that: a `$vt_results`
 * stored read returns in ~0.3 s (measured 4×) and a reused result in ~0.95 s
 * (A-SP21), both of them waiting out most of a poll interval they never needed.
 * At the other end a 30-second scan was polled 43 times, every one of them a
 * round trip billed to nobody but spent by everybody.
 *
 * So it ramps: quick while the fast answers are plausible, backing off once the
 * job has proved it is not one of them. 100 ms is the floor because the check
 * is itself a round trip — this app's own status GETs have measured in that
 * region against Cribl.Cloud, so polling faster mostly overlaps requests.
 * 1.5 s is the ceiling because past a few seconds the wait is dominated by the
 * job, and a second and a half of extra latency on a half-minute scan is not
 * something a viewer can perceive.
 *
 * Cumulative wait: 0.1 · 0.25 · 0.5 · 0.9 · 1.5 · 2.4 s, then 1.5 s a step —
 * 25 checks to reach 30 s where the flat interval took 43, and the first answer
 * available seven times sooner.
 */
export const POLL_RAMP_MS: readonly number[] = [100, 150, 250, 400, 600, 900]
export const POLL_MAX_MS = 1500

/** The gap before the (check+1)th status check, 0-based. */
export function pollDelayMs(check: number): number {
  return POLL_RAMP_MS[check] ?? POLL_MAX_MS
}

/** Poll job status until it completes. On abort or the client timeout the job
 *  is cancelled on the server too. A job the server cap stopped throws
 *  SearchTimeLimitError, so the panel can say so instead of "failed". */
async function waitForJob(
  jobId: string,
  signal: AbortSignal | undefined,
  pollMs: number | undefined,
  timeoutMs: number,
  capSeconds: number,
): Promise<void> {
  const started = Date.now()
  try {
    for (let check = 0; ; check++) {
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
      await sleep(pollMs ?? pollDelayMs(check), signal)
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
  const { earliest = '-15m', latest = 'now', limit = 5000, signal, pollMs, timeoutMs, costSlot, reuse = false, asWritten = false } = opts
  const cap = capSecondsFor(earliest)

  const executed = executedQuery(query, asWritten, earliest, latest)
  const jobId = await submitJob(executed.text, earliest, latest, signal, reuse)
  await waitForJob(jobId, signal, pollMs, timeoutMs ?? clientTimeoutMs(cap), cap)
  if (costSlot) void recordJobCost(costSlot, costKey(executed.text, earliest), jobId)

  const { rows, totalEventCount } = await readJobResults(jobId, { limit, signal })
  reportLanded(query, executed, signal)
  return { jobId, rows, totalEventCount }
}

/**
 * Read the results a job ALREADY produced, by its id. No job is submitted and
 * nothing is billed — this reads an artifact that exists.
 *
 * Extracted from `runSearchInner` so that a SCHEDULED run can be read the same
 * way its live counterpart is, which is the only way to address one. Measured
 * 2026-09-21: `$vt_results` answers on `jobName="<savedSearchId>"` and returns
 * the NEWEST run only; every way of naming a specific run — `jobName` or
 * `jobId`, the `<id>.<epoch>.<rand>` form or the `…scheduled.scheduledSearch_…`
 * form — returns zero rows. `keepLastN: 24` retains twenty-four artifacts and
 * `$vt_results` exposes exactly one of them. This endpoint reaches the rest.
 */
export async function readJobResults(
  jobId: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ rows: Row[]; totalEventCount: number }> {
  const { limit = 5000, signal } = opts
  // Results are NDJSON: header line then row lines.
  const res = await fetchRetry(searchUrl(`/search/jobs/${encodeURIComponent(jobId)}/results?limit=${limit}`), {}, signal)
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
  return { rows, totalEventCount }
}

/**
 * Field summaries computed from rows this app already has, rather than by
 * asking Cribl to compute them over a query.
 *
 * The stored-run path needs this: a scheduled run's artifact is ROWS, and there
 * is no query that names it (see `readJobResults`), so `/field-summaries`
 * cannot be pointed at one. The same shape is produced either way, so a panel
 * cannot tell which path served it — which is the point.
 */
export function summariseRows(rows: Row[]): FieldSummariesResult {
  const acc = new Map<string, { count: number; nulls: number; types: Set<string>; vals: Map<string, { value: unknown; count: number }> }>()
  for (const row of rows) {
    for (const [name, value] of Object.entries(row)) {
      let f = acc.get(name)
      if (!f) { f = { count: 0, nulls: 0, types: new Set(), vals: new Map() }; acc.set(name, f) }
      if (value === null || value === undefined || value === '') { f.nulls++; continue }
      f.count++
      f.types.add(typeof value)
      const key = String(value)
      const seen = f.vals.get(key)
      if (seen) seen.count++
      else if (f.vals.size < 5000) f.vals.set(key, { value, count: 1 })
    }
  }
  const fields = [...acc.entries()].map(([name, f]) => ({
    name,
    // One type when the column is consistent, `mixed` when it is not — the same
    // two answers the server gives, and honest about the third case.
    type: f.types.size === 1 ? [...f.types][0] : f.types.size === 0 ? 'null' : 'mixed',
    count: f.count,
    countDistinct: f.vals.size,
    countNull: f.nulls,
    topValues: [...f.vals.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  }))
  fields.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
  return { fields, sampled: rows.length }
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
  const { earliest = '-15m', latest = 'now', signal, pollMs, timeoutMs, costSlot, reuse = false, asWritten = false } = opts
  const cap = capSecondsFor(earliest)
  const executed = executedQuery(query, asWritten, earliest, latest)
  const jobId = await submitJob(executed.text, earliest, latest, signal, reuse)
  await waitForJob(jobId, signal, pollMs, timeoutMs ?? clientTimeoutMs(cap), cap)
  if (costSlot) void recordJobCost(costSlot, costKey(executed.text, earliest), jobId)
  const data = await api<{ fields?: FieldSummary[] }>(searchUrl(`/search/jobs/${jobId}/field-summaries`), { method: 'GET' }, signal)
  reportLanded(query, executed, signal)
  const fields = data.fields ?? []
  const sampled = fields.reduce((m, f) => Math.max(m, f.count + f.countNull), 0)
  return { fields, sampled }
}
