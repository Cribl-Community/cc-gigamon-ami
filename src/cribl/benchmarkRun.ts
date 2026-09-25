// The store benchmark's network half: submit one planned run, and read back
// what the server says it took and what it did.
//
// Everything that decides WHAT runs is `benchmarkPlan.ts` (pure); this module
// only executes a plan, one run at a time, and is reached from a confirmed click
// in <BenchmarkPanel> and nowhere else — never on a mount, a render or a timer.
//
// ── THE FOUR CONFOUNDERS, AND WHERE EACH IS HANDLED ─────────────────────────
// (`benchmark.ts`'s header has the evidence for each.)
//   1. Result reuse. Every run is submitted with `reuse: false`, so no
//      `allow_previous_results` directive is sent and Cribl runs it in full.
//   2. Cold start. The 15-minute stage's plan puts a discarded warm-up first for
//      each store; `summarise` never reads it.
//   3. Admission stagger. `runPlan` awaits each run before submitting the next.
//      There is no parallel path through this module.
//   4. Poll quantisation. The measurement is the job's OWN elapsed time, read
//      back from the job record (`runMeta`: `timeCompleted - timeStarted`);
//      client wall is reported beside it, and the gap is what this app adds.
//
// ── asWritten ───────────────────────────────────────────────────────────────
// Every run is submitted `asWritten`: the text names the store being measured,
// and neither the sample-data seam nor the query router may move it. A benchmark
// of the Parquet copy that the router quietly sent to JSON (or the reverse)
// would be a confident answer about the wrong store.
//
// ── WORK ────────────────────────────────────────────────────────────────────
// `billableCPUSeconds` from the job's metrics — the same read the header's cost
// label makes (jobCost.ts) and the Acceleration table makes (accel/status.ts).
// The meter lags the job: a completed run can read 0 for a few seconds, so an
// exact 0 is read once more after `WORK_RETRY_MS` and, if it is still 0,
// reported as NOT REPORTED (null) — never as zero work, which a finished search
// of this dataset never is.

import { capi } from './capi'
import { SearchRequestError, runSearch } from './search'
import { isDenial } from './authz'
import { JOBS_PATH, runMeta } from './accel/status'
import {
  canonicalAnswer,
  landingQueryFor,
  queryById,
  queryFor,
  type BenchRun,
  type BenchWindow,
  type LagReading,
  type PlannedBenchRun,
} from './benchmarkPlan'
import type { BenchTarget } from './benchmark'

/** How long to wait before reading the work meter a second time. */
export const WORK_RETRY_MS = 3_000

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

const abortable = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

async function readMeter(jobId: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const r = await capi('GET', `${JOBS_PATH}/${encodeURIComponent(jobId)}/metrics`, undefined, { signal })
    if (r.status !== 200) return null
    const body = r.body as { items?: Array<{ metrics?: { cpuMetrics?: { billableCPUSeconds?: unknown } } }> } | null
    const v = body?.items?.[0]?.metrics?.cpuMetrics?.billableCPUSeconds
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch (err) {
    if (signal?.aborted) throw err
    return null
  }
}

/** The work a completed job did, or null when the meter did not say. */
export async function readWork(jobId: string, signal?: AbortSignal): Promise<number | null> {
  const first = await readMeter(jobId, signal)
  if (first !== null && first > 0) return first
  await abortable(WORK_RETRY_MS, signal)
  const second = await readMeter(jobId, signal)
  return second !== null && second > 0 ? second : null
}

/** The job's own start-to-finish time, as its record states it. */
async function serverTime(jobId: string, signal?: AbortSignal): Promise<number | null> {
  const { run } = await runMeta(jobId, { signal })
  if (!run || run.startedAt === null || run.completedAt === null) return null
  const ms = run.completedAt - run.startedAt
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

const isAbort = (err: unknown, signal?: AbortSignal) =>
  !!signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')

/** Cribl refused the job submit itself: a 401/403 on POST …/search/jobs. */
function refusedSubmit(err: unknown): BenchRun['refused'] {
  if (!(err instanceof SearchRequestError) || !isDenial(err.status)) return undefined
  if (err.method !== 'POST' || !err.path.endsWith('/search/jobs')) return undefined
  return { method: err.method, path: err.path, status: err.status }
}

/**
 * Submit one planned run and measure it. A failed search is a RESULT (it carries
 * Cribl's own sentence); an abort is not, and is rethrown so the plan stops.
 */
export async function runOne(p: PlannedBenchRun, window: BenchWindow, signal?: AbortSignal): Promise<BenchRun> {
  const bq = queryById(p.queryId)
  const query = queryFor(bq, p.target)
  const base = { queryId: p.queryId, query, targetId: p.target.id, warmup: p.warmup }
  const t0 = now()
  let jobId: string
  let rows: number
  let answer: string | null | undefined
  try {
    const res = await runSearch(query, {
      earliest: window.earliest,
      latest: window.latest,
      reuse: false,
      asWritten: true,
      signal,
    })
    jobId = res.jobId
    // Rows the job PRODUCED, not rows read back: the read is capped, and two
    // stores truncated to the same cap would look as if they agreed.
    rows = res.totalEventCount
    // A search whose answer is a handful of rows (a count, a per-minute trend)
    // returns the same NUMBER of rows from any store, so its values are what
    // the verdict compares — and only when every row was read back.
    if (bq.answer === 'values') {
      answer = res.rows.length === res.totalEventCount ? canonicalAnswer(res.rows as Record<string, unknown>[]) : null
    }
  } catch (err) {
    if (isAbort(err, signal)) throw err
    const refused = refusedSubmit(err)
    return {
      ...base,
      jobId: null,
      serverMs: null,
      clientMs: now() - t0,
      cpuSeconds: null,
      rows: null,
      error: err instanceof Error ? err.message : 'The search failed.',
      ...(refused ? { refused } : {}),
    }
  }
  const clientMs = now() - t0
  const [serverMs, cpuSeconds] = await Promise.all([serverTime(jobId, signal), readWork(jobId, signal)])
  return { ...base, jobId, serverMs, clientMs, cpuSeconds, rows, ...(answer !== undefined ? { answer } : {}) }
}

const finiteNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * The 15-minute stage's landing check on one store: the Lake landing panel's
 * landing-lag search, over `read` (absolute), `asWritten` and reuse off like
 * every run here. Only `newest` and `n` are read; an empty window answers no row
 * at all, which is read as "nothing landed", never as zero lag. A failed search
 * is a result, carrying Cribl's sentence; an abort is rethrown so the stage stops.
 */
export async function readLanding(target: BenchTarget, read: BenchWindow, signal?: AbortSignal): Promise<LagReading> {
  const query = landingQueryFor(target)
  const base = { targetId: target.id, dataset: target.dataset, query }
  let jobId: string
  let newest: number | null = null
  let count: number | null = 0
  try {
    const res = await runSearch(query, { earliest: read.earliest, latest: read.latest, reuse: false, asWritten: true, signal })
    jobId = res.jobId
    const row = (res.rows[0] ?? null) as Record<string, unknown> | null
    if (row) {
      newest = finiteNumber(row.newest)
      count = finiteNumber(row.n)
    }
  } catch (err) {
    if (isAbort(err, signal)) throw err
    const refused = refusedSubmit(err)
    return {
      ...base,
      jobId: null,
      newest: null,
      count: null,
      cpuSeconds: null,
      error: err instanceof Error ? err.message : 'The search failed.',
      ...(refused ? { refused } : {}),
    }
  }
  const cpuSeconds = await readWork(jobId, signal)
  return { ...base, jobId, newest, count, cpuSeconds }
}

/**
 * Run a plan to the end, one run at a time, handing each result over as it
 * lands. Stops at the first abort — the run in flight is cancelled on the
 * server by `runSearch` — and at the first submit Cribl REFUSED (401/403):
 * every later submit is the same call and would be refused the same way, so
 * sending them would only fill the table with the same refusal. Resolves with
 * what completed.
 */
export async function runPlan(
  plan: readonly PlannedBenchRun[],
  window: BenchWindow,
  onRun: (run: BenchRun, done: number) => void,
  onStart: (next: PlannedBenchRun, index: number) => void,
  signal?: AbortSignal,
): Promise<{ stopped: boolean }> {
  for (let i = 0; i < plan.length; i++) {
    if (signal?.aborted) return { stopped: true }
    onStart(plan[i], i)
    try {
      const run = await runOne(plan[i], window, signal)
      onRun(run, i + 1)
      if (run.refused) return { stopped: true }
    } catch (err) {
      if (isAbort(err, signal)) return { stopped: true }
      throw err
    }
  }
  return { stopped: false }
}
