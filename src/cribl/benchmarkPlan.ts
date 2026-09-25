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
import { BENCH_LANDING_QUERY, BENCH_PARQUET_DATASET, BENCH_QUERIES, type AnswerCheck, type BenchQuery, type BenchQueryId } from '../queries/benchmark'
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

export { BENCH_QUERIES, type AnswerCheck, type BenchQuery, type BenchQueryId }

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

// ── The landing check (15-minute stage) ────────────────────────────────────
//
// "Ending ten minutes ago" assumes every store has landed every record in the
// window by then. A Parquet copy that is behind — a stalled destination, a
// backlog, a source that only just started — breaks that assumption silently:
// it answers with fewer rows, and all the verdict can do is refuse on the row
// count (or the count's value). So before the 15-minute stage picks its window
// it asks each store when its newest record is from, with the Lake landing
// panel's own landing-lag search, and:
//
//   * every store covers the usual end → the window is the usual one;
//   * one does not, but covers an end at most `LANDING_MAX_SHIFT_SECONDS`
//     earlier → the window moves back, whole minutes, to the latest end every
//     store covers, and the stage says by how much;
//   * one cannot be shown to cover even that → the stage runs nothing more and
//     says which store and why.
//
// "Covers" is a judgment, not a measurement: a store whose newest record is at
// T is taken to hold every record up to T − `LANDING_MARGIN_SECONDS`, because
// Cribl Lake writes a record when the file holding it closes, and another
// Worker's file with earlier records may stay open up to 300 s (the longest
// file-open time a destination here may carry — routing/completeness.ts uses
// the same figure). Nothing here has measured how late a store's oldest open
// file can actually be.
//
// NOT ON THE ONE-MINUTE STAGE, deliberately: the check reads the last
// `LANDING_READ_SECONDS` of each store (it must reach back past the window's
// usual end by the largest move it may make), which is 25 times the one minute
// that stage reads — the check would cost far more than the stage it guards.
// A lagging store shows up there as a row or value disagreement, which that
// stage already reports without naming a winner.

/** The furthest back the window may move before the stage refuses instead. */
export const LANDING_MAX_SHIFT_SECONDS = 900

/** Held back from a store's newest record for files still being written. */
export const LANDING_MARGIN_SECONDS = 300

/** How far back the landing check reads, from now. */
export const LANDING_READ_SECONDS = WINDOW_END_AGO_SECONDS + LANDING_MAX_SHIFT_SECONDS

/** The search the landing check sends to `target`. */
export function landingQueryFor(target: BenchTarget): string {
  return retargetQuery(BENCH_LANDING_QUERY, target.dataset)
}

/**
 * What the landing check reads: from the earliest end the window may move back
 * to, up to now. A store with no record in it cannot cover any window the stage
 * would accept, so reading further back would buy nothing.
 */
export function landingReadWindow(nowMs: number): BenchWindow {
  const usual = stageWindow('fifteen', nowMs)
  return { earliest: usual.latest - LANDING_MAX_SHIFT_SECONDS, latest: Math.floor(nowMs / 1000) }
}

export interface LagReading {
  targetId: string
  dataset: string
  /** The text submitted, dataset included. */
  query: string
  jobId: string | null
  /** Epoch seconds of the newest record in the read window; null when none. */
  newest: number | null
  /** Records in the read window, as the search counted them. */
  count: number | null
  cpuSeconds: number | null
  error?: string
  refused?: { method: string; path: string; status: number }
  /** A stand-in for a store the check never reached: it had already refused on another. */
  unchecked?: true
}

export interface LandingCheck {
  read: BenchWindow
  readings: readonly LagReading[]
  /** How far the window moved back from its usual end, in seconds. */
  shiftedSeconds: number
  /** Why the stage ran nothing more, or null. */
  refusal: string | null
  /**
   * True once `chooseWindow` has judged the readings. Until then — a check in
   * progress, or one Stop ended part way — nothing may be said about the window.
   */
  decided: boolean
}

const clock = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * The latest whole-minute end a reading lets the window reach: its newest
 * record, less the margin. Inferred from the newest record alone — it cannot
 * show a gap earlier in the window (the pack's Parquet destination drops under
 * backpressure), which would surface only as a row or value disagreement.
 */
export function coveredEnd(r: LagReading): number | null {
  if (r.error || r.newest === null || !Number.isFinite(r.newest) || !r.count) return null
  return Math.floor((r.newest - LANDING_MARGIN_SECONDS) / 60) * 60
}

/**
 * The 15-minute stage's window, from the landing check: the usual one when
 * every store covers its end, moved back to the latest end every store covers
 * when that is at most `LANDING_MAX_SHIFT_SECONDS` earlier, and otherwise a
 * refusal naming the store. Every reading must be present and read — a check
 * that did not complete proves nothing.
 */
/** The earliest end the window may move back to before the stage refuses. */
export function landingFloor(nowMs: number): number {
  return stageWindow('fifteen', nowMs).latest - LANDING_MAX_SHIFT_SECONDS
}

/**
 * True when this one reading already makes `chooseWindow` refuse, whatever the
 * other stores say — so the check need not (and must not, it is billed) read
 * the stores after it.
 */
export function readingRefuses(r: LagReading, nowMs: number): boolean {
  if (r.error) return true
  const end = coveredEnd(r)
  return end === null || end < landingFloor(nowMs)
}

export function chooseWindow(
  nowMs: number,
  readings: readonly LagReading[],
): { window: BenchWindow; shiftedSeconds: number; refusal: string | null } {
  const usual = stageWindow('fifteen', nowMs)
  const floor = landingFloor(nowMs)
  const read = landingReadWindow(nowMs)
  const refusals: string[] = []
  let latest = usual.latest
  for (const r of readings) {
    if (r.unchecked) {
      refusals.push(`${r.dataset} was not checked: the check had already refused on another store.`)
      continue
    }
    if (r.error) {
      refusals.push(`The landing check on ${r.dataset} did not complete (${r.error}), so when its newest record landed cannot be told.`)
      continue
    }
    const end = coveredEnd(r)
    if (end === null) {
      refusals.push(`Nothing has landed in ${r.dataset} since ${clock(read.earliest)}, so it holds none of any window this stage would measure.`)
      continue
    }
    if (end < floor) {
      refusals.push(
        `${r.dataset}’s newest record is from ${clock(r.newest as number)}. Allowing ${LANDING_MARGIN_SECONDS / 60} minutes for ` +
          `files still being written, the window could end no later than ${clock(end)} — more than ` +
          `${LANDING_MAX_SHIFT_SECONDS / 60} minutes before the window’s usual end, ${clock(usual.latest)}.`,
      )
      continue
    }
    latest = Math.min(latest, end)
  }
  if (readings.length === 0) refusals.push('No store was checked, so no window can be shown to be complete.')
  if (refusals.length > 0) {
    return {
      window: usual,
      shiftedSeconds: 0,
      refusal: `${refusals.join(' ')} The 15-minute stage ran nothing else: comparing stores over a window one of them has not finished landing would measure the lag, not the store. Try again later.`,
    }
  }
  return { window: { earliest: latest - STAGE_SECONDS.fifteen, latest }, shiftedSeconds: usual.latest - latest, refusal: null }
}

/**
 * What the landing check found, in words, for under the 15-minute table.
 * `ended`: the stage is over, so a check that never decided was stopped.
 */
export function landingWords(check: LandingCheck, ended = false): string[] {
  const found = check.readings
    .filter((r) => !r.error)
    .map((r) =>
      r.newest !== null && r.count
        ? `${r.dataset}’s newest record is from ${clock(r.newest)}`
        : `${r.dataset} has nothing since ${clock(check.read.earliest)}`,
    )
  const out: string[] = []
  if (found.length > 0) out.push(`Landing check: ${found.join('; ')}.`)
  if (!check.decided) {
    if (ended) out.push('The landing check was stopped before every store was checked, so no window was chosen.')
  } else if (!check.refusal && check.readings.length > 0) {
    out.push(
      check.shiftedSeconds > 0
        ? `The window was moved back ${Math.round(check.shiftedSeconds / 60)} minute${check.shiftedSeconds === 60 ? '' : 's'}, to end where every store’s newest record, less ${LANDING_MARGIN_SECONDS / 60} minutes, allows.`
        : 'Every store’s newest record is late enough that the window was not moved.',
    )
  }
  const done = check.readings.filter((r) => !r.error)
  const reported = done.filter((r) => r.cpuSeconds !== null)
  const total = reported.reduce((a, r) => a + (r.cpuSeconds as number), 0)
  if (done.length > 0) {
    out.push(
      reported.length === done.length
        ? `Work done by the landing check: ${cpuWords(total)}.`
        : reported.length === 0
          ? 'Work done by the landing check: not reported.'
          : `Work done by the landing check: at least ${cpuWords(total)} — Cribl did not report the work of ${done.length - reported.length} of its searches.`,
    )
  }
  return out
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
  /**
   * The rows it returned, in a canonical form that two stores' identical answers
   * share — only for a search whose check is `values`, and null when the rows
   * could not be read back in full (fewer read than the job produced). Absent
   * for every other search.
   */
  answer?: string | null
  /** Set when Cribl refused the job submit itself (401/403): what it refused. */
  refused?: { method: string; path: string; status: number }
}

/**
 * Rows as one string that does not depend on the order a store returned them
 * in, nor on the order of the fields inside a row. Values are compared exactly:
 * a sum that differs in its last digit is a different answer, and refusing a
 * winner on it is the safe direction.
 */
export function canonicalAnswer(rows: readonly Record<string, unknown>[]): string {
  return rows
    .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))
    .sort()
    .join('\n')
}

export interface StageRecord {
  stage: Stage
  key: string
  window: BenchWindow
  queryIds: readonly BenchQueryId[]
  targets: readonly BenchTarget[]
  runs: readonly BenchRun[]
  /** How many runs the stage planned. */
  planned: number
  /**
   * False while the stage is still running. Fewer runs than planned means the
   * stage was stopped ONLY once it has ended — mid-run every stage is short of
   * runs, and calling that "stopped" was a false sentence beside a live
   * progress line.
   */
  ended: boolean
  /** The 15-minute stage's landing check, once it has begun. */
  landing?: LandingCheck
}

/**
 * Ended with runs missing: stopped by a person, a refused submit or an error.
 * A stage the landing check refused is not "stopped" — it said why it ran
 * nothing, and that sentence is what is shown instead.
 */
export const stageStopped = (r: StageRecord): boolean =>
  r.ended && r.runs.length < r.planned && !r.landing?.refusal

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
  if (!probe.ended) return 'The one-minute stage is still running.'
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

/**
 * The landing check's work, estimated from the one-minute stage: the row count
 * reads every record in a minute, as the landing check does in its window, so
 * its measured work × the check's minutes is the same assumption the 15-minute
 * projection makes. Null when the row count was not in the one-minute stage for
 * that store, or its work was not reported.
 */
export function landingEstimate(probe: StageRecord, targetId: string): number | null {
  const count = probe.runs.find((r) => r.queryId === 'count' && r.targetId === targetId && !r.error)
  if (!count || count.cpuSeconds === null) return null
  return count.cpuSeconds * (LANDING_READ_SECONDS / STAGE_SECONDS.one)
}

/** The landing check's line in the 15-minute confirmation. */
export function landingCostLine(probe: StageRecord, targets: readonly BenchTarget[]): string {
  const stores = live(targets)
  const est = stores.map((t) => landingEstimate(probe, t.id))
  const minutes = LANDING_READ_SECONDS / 60
  const head =
    `First, ${stores.length === 1 ? 'one landing check reads' : `${stores.length} landing checks — one per store — read`} ` +
    `the last ${minutes} minutes to find when the newest record landed, and the window moves back up to ` +
    `${LANDING_MAX_SHIFT_SECONDS / 60} minutes when a store’s newest record is earlier than the window’s usual end.`
  if (est.every((e) => e !== null)) {
    const total = est.reduce((a: number, e) => a + (e as number), 0)
    return (
      `${head} Expect about ${cpuWords(total)} (${creditsWords(total)}) for ${stores.length === 1 ? 'it' : 'them'} — the row ` +
      `count’s one-minute work × ${minutes}, the same assumption.`
    )
  }
  return `${head} Their work is not known until they run: the row count was not measured on every store in the one-minute stage.`
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

/** What a named verdict says it checked, by the search's answer check. */
const CHECKED_WORDS: Readonly<Record<Exclude<AnswerCheck, 'none'>, string>> = Object.freeze({
  values: 'Every store returned the same rows, value for value.',
  rows: 'Both stores returned the same number of rows; their values are not compared here.',
})

/**
 * Why a comparison that named a winner must not, given what the search's
 * answer check can see — or null when the winner stands.
 *
 * A search whose answer is one row (a count) or a fixed set of bins (a
 * per-minute trend) returns the same NUMBER of rows from any store, so the
 * row-count refusal in `compare` can never fire for it: a Parquet copy holding
 * half the records would still return "the same number of rows", and a faster
 * store would be named for a different answer. Those searches are checked on
 * their values instead, and the one whose answer is known to differ is never
 * given a winner at all.
 */
export function answerRefusal(check: AnswerCheck, measured: readonly BenchRun[]): { why: string; disagree: boolean } | null {
  if (check === 'rows') return null
  if (check === 'none') {
    return {
      why: 'This search’s answer is known to differ on the Parquet copy, so the stores are not compared on it and neither is named fastest. Its timings and work stand on their own.',
      disagree: false,
    }
  }
  const answers = measured.map((r) => r.answer ?? null)
  if (answers.length === 0 || answers.some((a) => a === null)) {
    return {
      why: 'Its rows could not all be read back, so whether every store gave the same answer is unknown, and no store is named fastest.',
      disagree: false,
    }
  }
  if (new Set(answers).size > 1) {
    return {
      why: 'The stores returned the same number of rows but different values, so they did not answer the same question. A faster answer to a different question is not a faster store.',
      disagree: true,
    }
  }
  return null
}

/** The verdict in words. */
export function verdictWords(c: Comparison, check: AnswerCheck = 'rows'): string {
  // One store measured is a choice on this screen (the Parquet copy unticked,
  // or absent), not a configuration fault, so it is said in those terms.
  if (c.summaries.length < 2) return 'Only one store was measured, so there is nothing to compare it against; its timings stand on their own.'
  if (!c.fastest) return c.noWinnerBecause ?? 'No verdict.'
  const by = c.speedup !== null && c.speedup > 1 ? `, ${c.speedup}× faster than the slowest by server time` : ' by server time'
  return `${STORE_WORDS[c.fastest.target.kind]} answered fastest${by}. ${CHECKED_WORDS[check === 'none' ? 'rows' : check]}`
}

export function benchReport(bench: StageRecord): QueryReport[] {
  return bench.queryIds.map((id) => {
    const runs = bench.runs.filter((r) => r.queryId === id)
    const summaries = live(bench.targets).map((t) => summarise(t, runs))
    const query = queryById(id)
    let comparison = compare(summaries)
    if (comparison.fastest) {
      const refused = answerRefusal(query.answer, runs.filter((r) => !r.warmup && !r.error))
      if (refused) {
        comparison = {
          ...comparison,
          fastest: null,
          speedup: null,
          noWinnerBecause: refused.why,
          disagree: comparison.disagree || refused.disagree,
        }
      }
    }
    return { query, comparison, verdict: verdictWords(comparison, query.answer), decided: comparison.fastest !== null }
  })
}

/**
 * How the stores' answers to one search differ in the one-minute stage: in how
 * many rows, in the values of the rows (only for a search checked on values,
 * and only where every store's rows were read back in full), or not at all.
 */
export function probeDisagreement(probe: StageRecord, queryId: BenchQueryId): 'rows' | 'values' | null {
  const mine = probe.runs.filter((r) => r.queryId === queryId && !r.error)
  const rows = new Set(mine.filter((r) => r.rows !== null).map((r) => r.rows))
  if (rows.size > 1) return 'rows'
  if (queryById(queryId).answer !== 'values') return null
  const answers = mine.map((r) => r.answer ?? null)
  if (answers.some((a) => a === null)) return null
  return new Set(answers).size > 1 ? 'values' : null
}

/** Whether the stores' answers to one search differ in the one-minute stage. */
export function probeDisagrees(probe: StageRecord, queryId: BenchQueryId): boolean {
  return probeDisagreement(probe, queryId) !== null
}

/**
 * The stage's work in words. A run whose work Cribl did not report is NOT
 * counted as zero (benchmark.ts: null "is not the same as zero and must not be
 * rendered as it"): the figure becomes a floor, and the sentence says how many
 * searches it leaves out.
 */
export function stageWorkWords(runs: readonly BenchRun[]): string {
  const done = runs.filter((r) => !r.error)
  const reported = done.filter((r) => r.cpuSeconds !== null)
  const total = reported.reduce((s, r) => s + (r.cpuSeconds as number), 0)
  const missing = done.length - reported.length
  if (missing === 0) return `Work done by this stage: ${cpuWords(total)}.`
  if (reported.length === 0) return 'Work done by this stage: not reported — Cribl did not report the work of any of its searches.'
  return (
    `Work done by this stage: at least ${cpuWords(total)} — Cribl did not report the work of ${missing} of its ` +
    `${done.length} searches, and those are not counted.`
  )
}
