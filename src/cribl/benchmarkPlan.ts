// The store benchmark's two stages, as data: which searches, against which
// stores, over which window, in which order — and the rule that the 15-minute
// stage is not offered until the one-minute stage's measured work is on screen.
//
// Pure. Nothing here calls `capi`, `fetch`, the KV store or a clock it was not
// handed. The engine it builds on is `benchmark.ts` (run order, medians, the
// verdict and its refusals), and the network half is `benchmarkRun.ts`.
//
// ── THE QUERY SET IS IMPORTED, NEVER RETYPED ────────────────────────────────
// src/queries/benchmark.ts holds it (so the query freeze sees it): Phase 8
// design §3.2's behaviour measurement, each entry the panel's or schedule's own
// constant. The Parquet side is the same text with its dataset selector moved,
// exactly as the sample seam and the router move it.
//
// ── WHY THERE ARE TWO STAGES ────────────────────────────────────────────────
// Cribl has no server-side CPU bound on a search: `max_running_time_per_search`
// stops the clock, not the work already spent in parallel (a Parquet group-by
// was stopped by its 120 s cap and billed 8,266 CPU-s anyway). The only guard
// that works is staging: run each search ONCE over one minute, read what it
// did, and go on to the 15-minute runs only after a person has seen that figure
// multiplied out and said yes. `fifteenRefusal` is that rule, and the panel
// renders no 15-minute control at all until a one-minute stage exists for the
// exact searches and stores selected.
//
// The one-minute stage is a WORK PROBE, not a timing benchmark: one cold run per
// search and store, no warm-up, so it states no verdict. The verdict comes from
// the 15-minute stage, which is `benchmark.ts`'s protocol unchanged — one
// discarded warm-up and three measured runs per store, interleaved, sequential,
// reuse off.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It routes nothing. A result here is a measurement on screen; moving a query to
// the Parquet copy is the routing table's evidence, a separate and deliberate
// step (cribl/routing/table.ts). It persists nothing either.
//
// And it is not a cost gate. `benchmark.ts`'s header records the owner's call
// that cost is not a design constraint and CPU-seconds are reported as WORK. The
// confirmation below is the staging guard §3.2 asks for — "acceptable to
// whoever approves the run" — so it states the work in words and lets a person
// decide. No threshold anywhere refuses a run for being expensive.

import { REAL_DATASET, retargetQuery } from '../queries/datasets'
import { BENCH_PARQUET_DATASET, BENCH_QUERIES, type BenchQuery, type BenchQueryId } from '../queries/benchmark'
import {
  MEASURED_RUNS,
  STORE_WORDS,
  WARMUP_RUNS,
  compare,
  planRuns,
  summarise,
  type BenchTarget,
  type Comparison,
  type RunResult,
} from './benchmark'
import { CPU_SECONDS_PER_CREDIT } from './jobCost'
import type { LakeDataset, ReadResult } from './lake'

export { BENCH_QUERIES, type BenchQuery, type BenchQueryId }

export const queryById = (id: BenchQueryId): BenchQuery => {
  const q = BENCH_QUERIES.find((b) => b.id === id)
  if (!q) throw new Error(`benchmark: no query ${id}`)
  return q
}

/** The text a run of `query` sends to `target` — the app's own string, with only
 *  its dataset selector moved. */
export function queryFor(query: BenchQuery, target: BenchTarget): string {
  return retargetQuery(query.query, target.dataset)
}

// ── The stores ──────────────────────────────────────────────────────────────

export const JSON_TARGET_ID = 'json'
export const PARQUET_TARGET_ID = 'parquet'
export const PARQUET_DATASET = BENCH_PARQUET_DATASET

/** What the Lake listing says about the Parquet copy. */
export type ParquetState = 'unreadable' | 'absent' | 'deleting' | 'empty' | 'holds-data'

const listed = (r: ReadResult<LakeDataset[]> | null, id: string): LakeDataset | undefined =>
  r?.outcome === 'ok' && r.value ? r.value.find((d) => d.id === id) : undefined

export function parquetState(r: ReadResult<LakeDataset[]> | null): ParquetState {
  if (!r || r.outcome !== 'ok' || !r.value) return 'unreadable'
  const d = listed(r, PARQUET_DATASET)
  if (!d) return 'absent'
  if (d.deletionStartedAt !== null) return 'deleting'
  const size = d.metrics?.currentSizeBytes ?? null
  return size !== null && size > 0 ? 'holds-data' : 'empty'
}

export const PARQUET_ABSENT_WORDS: Readonly<Record<Exclude<ParquetState, 'holds-data'>, string>> = Object.freeze({
  unreadable: `The Cribl Lake dataset list could not be read, so this app cannot tell whether ${PARQUET_DATASET} exists. Only the JSON dataset is offered.`,
  absent: `There is no ${PARQUET_DATASET} dataset on this workspace, so only the JSON dataset can be measured.`,
  deleting: `${PARQUET_DATASET} is being deleted, so only the JSON dataset can be measured.`,
  empty: `${PARQUET_DATASET} exists but Cribl Lake reports no data in it yet. Lake updates that figure about once a day, so a new dataset can take a day to be offered here.`,
})

/**
 * The stores a run may use. JSON unless the app is reading sample data (the
 * customer's dataset then holds nothing to time); Parquet only when the Lake
 * listing shows it exists and holds data, and only when the person asked for it.
 */
export function benchTargets(
  listing: ReadResult<LakeDataset[]> | null,
  opts: { sampleOnly: boolean; includeParquet: boolean },
): BenchTarget[] {
  const json: BenchTarget = {
    id: JSON_TARGET_ID,
    kind: 'lake-json',
    dataset: REAL_DATASET,
    label: `${STORE_WORDS['lake-json']} (${REAL_DATASET})`,
    available: !opts.sampleOnly,
    absentNote: opts.sampleOnly ? `${REAL_DATASET} holds no data yet, so there is nothing to measure.` : undefined,
  }
  const pq = parquetState(listing)
  const parquet: BenchTarget = {
    id: PARQUET_TARGET_ID,
    kind: 'lake-parquet',
    dataset: PARQUET_DATASET,
    label: `${STORE_WORDS['lake-parquet']} (${PARQUET_DATASET})`,
    available: pq === 'holds-data' && opts.includeParquet && !opts.sampleOnly,
    absentNote:
      pq !== 'holds-data'
        ? PARQUET_ABSENT_WORDS[pq]
        : !opts.includeParquet
          ? 'Left out of this run.'
          : undefined,
  }
  return [json, parquet]
}

// ── The windows ─────────────────────────────────────────────────────────────

export type Stage = 'one' | 'fifteen'

export const STAGE_SECONDS: Readonly<Record<Stage, number>> = Object.freeze({ one: 60, fifteen: 900 })

/**
 * How far behind now every window ends. §3.2: "one absolute 15 minutes ending
 * ≥10 min ago", so that both stores have landed every record in it — a window
 * still being written would differ in row count for a reason that has nothing to
 * do with the store.
 */
export const WINDOW_END_AGO_SECONDS = 600

export interface BenchWindow {
  /** Epoch seconds. Absolute, so every run of a stage reads the same rows. */
  earliest: number
  latest: number
}

/** The stage's window: absolute, on a whole minute, ending ten minutes ago. */
export function stageWindow(stage: Stage, nowMs: number): BenchWindow {
  const latest = Math.floor(nowMs / 60_000) * 60 - WINDOW_END_AGO_SECONDS
  return { earliest: latest - STAGE_SECONDS[stage], latest }
}

// ── The plans ───────────────────────────────────────────────────────────────

export interface PlannedBenchRun {
  queryId: BenchQueryId
  target: BenchTarget
  /** 0 is the warm-up in the 15-minute stage. */
  index: number
  warmup: boolean
}

const live = (targets: readonly BenchTarget[]) => targets.filter((t) => t.available)

/** One run per search and store, sequential. The one-minute stage. */
export function probePlan(queryIds: readonly BenchQueryId[], targets: readonly BenchTarget[]): PlannedBenchRun[] {
  return queryIds.flatMap((queryId) => live(targets).map((target) => ({ queryId, target, index: 0, warmup: false })))
}

/** `benchmark.ts`'s protocol for each search in turn. The 15-minute stage. */
export function benchPlan(queryIds: readonly BenchQueryId[], targets: readonly BenchTarget[]): PlannedBenchRun[] {
  return queryIds.flatMap((queryId) => planRuns(targets).map((r) => ({ queryId, ...r })))
}

export function planFor(stage: Stage, queryIds: readonly BenchQueryId[], targets: readonly BenchTarget[]): PlannedBenchRun[] {
  return stage === 'one' ? probePlan(queryIds, targets) : benchPlan(queryIds, targets)
}

/**
 * Which searches and stores a stage was run for. The 15-minute stage is judged
 * against the one-minute stage OF THE SAME SELECTION: tick another search, or
 * add the Parquet copy, and the one-minute figure no longer describes what the
 * 15-minute stage would run.
 */
export function selectionKey(queryIds: readonly BenchQueryId[], targets: readonly BenchTarget[]): string {
  const q = [...queryIds].sort().join(',')
  const t = live(targets).map((x) => x.id).sort().join(',')
  return `${q}|${t}`
}

// ── What a stage produced ───────────────────────────────────────────────────

export interface BenchRun extends RunResult {
  queryId: BenchQueryId
  /** The text that was submitted, dataset included. */
  query: string
  jobId: string | null
}

export interface StageRecord {
  stage: Stage
  key: string
  window: BenchWindow
  queryIds: readonly BenchQueryId[]
  targets: readonly BenchTarget[]
  runs: readonly BenchRun[]
  /** How many runs the stage planned; fewer in `runs` means it was stopped. */
  planned: number
}

const pairName = (r: BenchRun, targets: readonly BenchTarget[]) =>
  `${queryById(r.queryId).label} on ${targets.find((t) => t.id === r.targetId)?.dataset ?? r.targetId}`

/**
 * Why the 15-minute stage may not run yet, or null when it may. Every reason is
 * rendered as-is beside the control it holds closed.
 */
export function fifteenRefusal(probe: StageRecord | null, key: string): string | null {
  if (!probe || probe.stage !== 'one' || probe.key !== key) {
    return 'Measure one minute first, for the searches and stores selected. The 15-minute stage is offered once that stage’s work is on screen.'
  }
  if (probe.runs.length < probe.planned) {
    return 'The one-minute stage was stopped before every search ran. Run it again to completion first.'
  }
  const failed = probe.runs.filter((r) => r.error)
  if (failed.length > 0) {
    return `The one-minute stage did not complete for ${failed.map((r) => pairName(r, probe.targets)).join('; ')}. Run it again before the 15-minute stage.`
  }
  const unread = probe.runs.filter((r) => r.cpuSeconds === null)
  if (unread.length > 0) {
    return `Cribl did not report the work done by ${unread.map((r) => pairName(r, probe.targets)).join('; ')}, so there is nothing to judge the 15-minute stage against. Run the one-minute stage again.`
  }
  return null
}

// ── Words about work ────────────────────────────────────────────────────────

/** CPU-seconds as operator copy: never more precise than a meter reading. */
export function cpuWords(cpu: number): string {
  if (!Number.isFinite(cpu)) return 'unknown'
  if (cpu < 0.1) return 'under 0.1 CPU-seconds'
  const n = Number(cpu.toPrecision(3))
  return `${n >= 100 ? Math.round(n).toLocaleString('en-US') : n} CPU-seconds`
}

function creditsWords(cpu: number): string {
  const credits = cpu / CPU_SECONDS_PER_CREDIT
  if (credits < 0.01) return 'under 0.01 credits'
  return `about ${Number(credits.toPrecision(2))} credits`
}

/** The runs one search makes against one store in the 15-minute stage. */
export const FIFTEEN_RUNS_PER_PAIR = WARMUP_RUNS + MEASURED_RUNS

export interface Projection {
  /** One line per search and store: measured, then multiplied out. */
  pairs: { queryId: BenchQueryId; targetId: string; measured: number; projected: number }[]
  measuredTotal: number
  projectedTotal: number
}

/**
 * What the 15-minute stage should do, from what the one-minute stage did: 15
 * times the window, four runs each. Only valid when `fifteenRefusal` is null.
 *
 * "Work grows with the window" is an ASSUMPTION and every sentence that quotes
 * this says so: a fixed per-search overhead makes it an over-estimate, and a
 * store whose cost grows faster than the rows it reads makes it an under-one.
 */
export function projectFifteen(probe: StageRecord): Projection {
  const scale = STAGE_SECONDS.fifteen / STAGE_SECONDS.one
  const pairs = probe.runs.map((r) => {
    const measured = r.cpuSeconds ?? 0
    return { queryId: r.queryId, targetId: r.targetId, measured, projected: measured * scale * FIFTEEN_RUNS_PER_PAIR }
  })
  return {
    pairs,
    measuredTotal: pairs.reduce((s, p) => s + p.measured, 0),
    projectedTotal: pairs.reduce((s, p) => s + p.projected, 0),
  }
}

/** The one-minute stage's cost line: what it does, since nothing is measured yet. */
export function oneMinuteCostLine(searches: number): string {
  return (
    `${searches} search${searches === 1 ? '' : 'es'}, each run once over one minute. What each one costs is not known ` +
    'until it runs — that is what this stage measures, and why it reads a fifteenth of the 15-minute window. Cribl ' +
    'puts no limit on the work a search does; the running-time limit stops the clock, not work already done.'
  )
}

/** The 15-minute stage's cost line, from the one-minute stage's measured work. */
export function fifteenCostLine(probe: StageRecord): string {
  const p = projectFifteen(probe)
  const searches = p.pairs.length * FIFTEEN_RUNS_PER_PAIR
  return (
    `The one-minute stage did ${cpuWords(p.measuredTotal)} of work. This stage runs ${searches} searches — each ` +
    `search ${FIFTEEN_RUNS_PER_PAIR} times per store over 15 times the window — so expect about ` +
    `${cpuWords(p.projectedTotal)} (${creditsWords(p.projectedTotal)}) if work grows in step with the window. That ` +
    'is an assumption, not a measurement.'
  )
}

// ── The 15-minute report ────────────────────────────────────────────────────

export interface QueryReport {
  query: BenchQuery
  comparison: Comparison
  /** What the report says under the table: a verdict, or why there is none. */
  verdict: string
  /** True when a winner is named. */
  decided: boolean
}

/** The verdict in words. Row counts, not values: the parity check compares values. */
export function verdictWords(c: Comparison): string {
  // One store measured is a choice on this screen (the Parquet copy unticked,
  // or absent), not a configuration fault, so it is said in those terms.
  if (c.summaries.length < 2) return 'Only one store was measured, so there is nothing to compare it against; its timings stand on their own.'
  if (!c.fastest) return c.noWinnerBecause ?? 'No verdict.'
  const by = c.speedup !== null && c.speedup > 1 ? `, ${c.speedup}× faster than the slowest by server time` : ' by server time'
  return (
    `${STORE_WORDS[c.fastest.target.kind]} answered fastest${by}. Both stores returned the same number of rows; ` +
    'their values are not compared here.'
  )
}

export function benchReport(bench: StageRecord): QueryReport[] {
  return bench.queryIds.map((id) => {
    const runs = bench.runs.filter((r) => r.queryId === id)
    const summaries = live(bench.targets).map((t) => summarise(t, runs))
    const comparison = compare(summaries)
    return { query: queryById(id), comparison, verdict: verdictWords(comparison), decided: comparison.fastest !== null }
  })
}

/** Row counts that differ between stores for one search in the one-minute stage. */
export function probeDisagrees(probe: StageRecord, queryId: BenchQueryId): boolean {
  const rows = new Set(probe.runs.filter((r) => r.queryId === queryId && r.rows !== null).map((r) => r.rows))
  return rows.size > 1
}
