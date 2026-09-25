// "How fast is each store, on the same question?" — the comparison, as data.
//
// Pure. Nothing here calls `capi`, `fetch` or the KV store; it plans runs,
// prices them and reduces results. The submitting lives in the panel, so every
// rule below is testable without a network.
//
// ── WHY THIS IS NOT A STOPWATCH ─────────────────────────────────────────────
// Four mechanisms in this app will each produce a confident, wrong answer, and
// three of them point the SAME WAY as the effect being measured — which is the
// dangerous direction, because the result looks like success.
//
//   1. `allow_previous_results`. Every ordinary submit carries a 2-minute reuse
//      window; measured 30.92 s -> 0.95 s on a repeat. A benchmark that re-ran
//      anything inside that window would report a 32x artefact. Runs here are
//      submitted with reuse OFF, and `REUSE_GAP_MS` is how long a repeat has to
//      wait if it is ever run twice.
//   2. Cold start. The first query after a reader flip measured 105 s against
//      sub-second for the twelve after it. The first run of a session is
//      discarded, always, and the report says it happened.
//   3. Admission stagger. Concurrent jobs from one user are admitted ~1.6 s
//      apart, so three targets fired together would make the third look 3.2 s
//      slower for a reason that has nothing to do with the store. Runs are
//      SEQUENTIAL, and `planRuns` is what makes that structural.
//   4. Poll quantisation. The client polls on a ramp, so client wall-clock
//      cannot resolve a 0.15 s query from a 0.6 s one. This is why the primary
//      measurement is the job's OWN elapsed time, read back from the server.
//
// ── THE NUMBER NOBODY HAS LOOKED AT ─────────────────────────────────────────
// Reporting server time and client wall SEPARATELY is the point, not a detail.
// In Snapshot mode a stored read already answers in ~0.3 s, and the app's own
// round trips are a floor beneath it. If a store answers in 0.15 s and the
// panel still takes 1.5 s, the remaining 1.35 s is this app, and no storage
// format will move it. `overheadMs` is that gap, and it is the first honest
// measurement of it this project has.
//
// ── A FASTER WRONG ANSWER IS NOT A WIN ──────────────────────────────────────
// Parquet with an automatic schema materialises every column, so an absent
// field reads back as "" or 0 — `isnotnull(x)` becomes true for every row and a
// technique counter measured 18 -> 43,338. A benchmark that reported only speed
// would recommend the store that silently breaks the app. Every run therefore
// carries its row count and its checksum column, and `compare()` refuses to
// name a winner when the answers disagree.

/** What a run can be executed against. */
export type StoreKind = 'lake-json' | 'lake-parquet' | 'lakehouse'

export interface BenchTarget {
  id: string
  kind: StoreKind
  /** The dataset name a query is addressed to. */
  dataset: string
  /** What the reader calls it. */
  label: string
  /**
   * Absent means "not configured on this workspace", which is a state, not a
   * failure — most tenants will have exactly one target and the panel says so
   * rather than showing an empty comparison.
   */
  available: boolean
  /** Why it is unavailable, when it is. Never invented; the caller supplies it. */
  absentNote?: string
}

export const STORE_WORDS: Readonly<Record<StoreKind, string>> = Object.freeze({
  'lake-json': 'Cribl Lake · JSON',
  'lake-parquet': 'Cribl Lake · Parquet',
  lakehouse: 'Cribl Search Lakehouse Engine',
})

// ── Confounder controls, as constants so a caller cannot forget one ─────────

/** Discarded, always. Cold start measured 105 s against sub-second after. */
export const WARMUP_RUNS = 1
/** Median of three; a mean would be dragged by the ~1% of jobs that hang. */
export const MEASURED_RUNS = 3
/** `REUSE_WINDOW` is 2 minutes, so a repeat inside it is not a measurement. */
export const REUSE_GAP_MS = 125_000
/** Concurrent jobs are admitted ~1.6 s apart. Sequential runs avoid it entirely. */
export const ADMISSION_STAGGER_MS = 1_600

export interface PlannedRun {
  target: BenchTarget
  /** 0 is the warm-up. Its result is never reported. */
  index: number
  warmup: boolean
}

/**
 * The run order.
 *
 * SEQUENTIAL, AND INTERLEAVED BY ROUND rather than grouped by target. Grouping
 * would run every target A measurement inside one minute and every target B
 * measurement three minutes later, so any drift in the feed — a busy period, a
 * worker restart — would be charged entirely to one store. Interleaving spreads
 * it across all of them.
 */
export function planRuns(targets: readonly BenchTarget[]): PlannedRun[] {
  const live = targets.filter((t) => t.available)
  const runs: PlannedRun[] = []
  for (let i = 0; i < WARMUP_RUNS + MEASURED_RUNS; i++) {
    for (const target of live) runs.push({ target, index: i, warmup: i < WARMUP_RUNS })
  }
  return runs
}

// ── What a run produced ─────────────────────────────────────────────────────

export interface RunResult {
  targetId: string
  warmup: boolean
  /** The job's OWN elapsed time, read back from the server. The measurement. */
  serverMs: number | null
  /** Submit to rendered, measured in the browser. Includes this app's overhead. */
  clientMs: number
  /**
   * The work the store did, from the job's own metrics — Cribl calls the field
   * `billableCPUSeconds`, which is where the name comes from, but it is read
   * here as WORK rather than as money. Null when the meter could not be read,
   * which is not the same as zero and must not be rendered as it.
   */
  cpuSeconds: number | null
  /** Rows returned. The correctness signal — see `compare`. */
  rows: number | null
  /** Cribl's own sentence, when a run failed. Never invented here. */
  error?: string
}

export interface TargetSummary {
  target: BenchTarget
  /** Median of the measured runs. Null when every run failed. */
  serverMs: number | null
  clientMs: number | null
  cpuSeconds: number | null
  rows: number | null
  /**
   * `clientMs - serverMs`: what this app added on top of the store.
   *
   * The most useful number in the report and the one nothing has measured. It is
   * poll quantisation, admission wait and render, and no storage format moves it.
   */
  overheadMs: number | null
  ran: number
  failed: number
}

const median = (xs: number[]): number | null => {
  const ok = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (ok.length === 0) return null
  const mid = Math.floor(ok.length / 2)
  return ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2
}

export function summarise(target: BenchTarget, results: readonly RunResult[]): TargetSummary {
  const mine = results.filter((r) => r.targetId === target.id && !r.warmup)
  const good = mine.filter((r) => !r.error)
  const serverMs = median(good.map((r) => r.serverMs ?? NaN))
  const clientMs = median(good.map((r) => r.clientMs))
  return {
    target,
    serverMs,
    clientMs,
    cpuSeconds: median(good.map((r) => r.cpuSeconds ?? NaN)),
    rows: median(good.map((r) => r.rows ?? NaN)),
    overheadMs: serverMs !== null && clientMs !== null ? Math.max(0, clientMs - serverMs) : null,
    ran: mine.length,
    failed: mine.length - good.length,
  }
}

// ── The comparison ──────────────────────────────────────────────────────────

export interface Comparison {
  summaries: readonly TargetSummary[]
  /** The fastest by SERVER time, or null when there is no honest winner. */
  fastest: TargetSummary | null
  /** Why there is no winner, when there isn't. Rendered as-is. */
  noWinnerBecause: string | null
  /** True when the targets did not return the same row count. */
  disagree: boolean
  /** How many times faster the fastest is than the slowest, by server time. */
  speedup: number | null
}

/**
 * Reduce the summaries to a verdict, and REFUSE one where a verdict would lie.
 *
 * Four refusals, and each has cost somebody a wrong decision somewhere:
 *
 *  • Fewer than two targets ran — a comparison of one is not a comparison.
 *  • The row counts disagree. A store answering a different question faster is
 *    not faster. Parquet with an automatic schema does exactly this: absent
 *    fields read back as "" or 0, and a counter measured 18 against 43,338 on
 *    the same window. Naming that the winner is how the wrong format ships.
 *  • No server time. Client wall cannot resolve sub-second differences through
 *    a 700 ms poll, so a verdict from it would be noise with a decimal point.
 *  • A tie. Medians under 1.05× apart are not one store faster than the other
 *    (added 2026-09-25: an exact tie used to name whichever sorted first).
 */
export function compare(summaries: readonly TargetSummary[]): Comparison {
  const ran = summaries.filter((s) => s.serverMs !== null)
  const rowCounts = new Set(summaries.filter((s) => s.rows !== null).map((s) => s.rows))
  const disagree = rowCounts.size > 1

  let noWinnerBecause: string | null = null
  if (ran.length < 2) {
    noWinnerBecause =
      summaries.length < 2
        ? 'Only one store is configured, so there is nothing to compare it against. The timings below still stand on their own.'
        : 'Only one store returned a timing, so there is nothing to compare.'
  } else if (disagree) {
    noWinnerBecause =
      'The stores did not return the same number of rows, so they did not answer the same question. A faster answer to a different question is not a faster store — check the rows column before reading the timings.'
  }

  const byServer = [...ran].sort((a, b) => (a.serverMs as number) - (b.serverMs as number))
  const slowest = byServer[byServer.length - 1]
  const ratio = (s: TargetSummary | undefined) =>
    s && slowest && (s.serverMs as number) > 0
      ? Number(((slowest.serverMs as number) / (s.serverMs as number)).toFixed(1))
      : null

  // A fourth refusal: a tie. Two stores whose medians round to the same speed
  // (under 1.05×) are not one faster than the other, and naming whichever sorted
  // first would be a coin toss printed as a finding.
  if (noWinnerBecause === null && ratio(byServer[0]) === 1) {
    noWinnerBecause =
      'The stores’ median server times are within 5% of each other, so neither is named fastest. The timings below stand on their own.'
  }

  const fastest = noWinnerBecause === null ? (byServer[0] ?? null) : null
  const speedup = fastest ? ratio(fastest) : null

  return { summaries, fastest, noWinnerBecause, disagree, speedup }
}

// ── How long it takes ────────────────────────────────────────────
//
// NO COST ESTIMATE, NO CREDIT FIGURE, NO CONFIRMATION. The owner's call,
// 2026-09-22: cost is not a design constraint here. A benchmark that made
// somebody read a credit figure before pressing a button would be asking them
// to weigh something they have already decided not to weigh, and a benchmark
// nobody runs measures nothing.
//
// CPU-SECONDS STAY, RE-FRAMED FROM BILL TO WORK. They are still measured per
// run and still reported beside the timings, because 127 CPU-seconds against
// 0.2 for the same answer is 635x less WORK, and that is an efficiency fact
// whoever happens to pay for it. It is the second axis of this comparison: a
// store can win on wall-clock while doing far more work to get there, and that
// gap predicts how it behaves under load in a way one timing cannot.
//
// *(Corrected 2026-09-25, `feat/phase9-benchmark-panel`: the screen that
// renders this — Guided Setup's <BenchmarkPanel> — DOES confirm before it
// submits, and states work in words. Not a cost gate: no threshold refuses a
// run. It is the staging guard the Phase 8 design's §3.2 asks for, because
// Cribl puts no bound on a search's CPU (a Parquet group-by stopped by its
// 120 s cap billed 8,266 CPU-s): run each search once over one minute, show
// what it did, and offer the 15-minute runs only after a person has seen that
// figure multiplied out. benchmarkPlan.ts carries the rule.)*

/** How many searches a full benchmark submits. */
export function runCount(targets: readonly BenchTarget[]): number {
  return targets.filter((t) => t.available).length * (WARMUP_RUNS + MEASURED_RUNS)
}

/** Roughly how long the whole thing takes, so the button can say so. */
export function estimateDurationMs(targets: readonly BenchTarget[], msPerRun: number): number {
  // Sequential, plus one admission gap between runs. No reuse gap: every run is
  // submitted with reuse off, so none of them waits one out.
  return runCount(targets) * (msPerRun + ADMISSION_STAGGER_MS)
}

/** The line under the button: what it will DO, not what it will cost. */
export function runSentence(targets: readonly BenchTarget[]): string {
  const live = targets.filter((t) => t.available).length
  if (live === 0) return 'No store is configured, so there is nothing to run.'
  return (
    `${runCount(targets)} searches — ${WARMUP_RUNS} warm-up and ${MEASURED_RUNS} measured against ` +
    `${live === 1 ? 'one store' : `${live} stores`}, run one at a time so they cannot queue behind each other.`
  )
}
