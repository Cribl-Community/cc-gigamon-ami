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
  /**
   * Whether running a query here costs anything at the margin.
   *
   * NOT DECORATION — it changes how the whole comparison should be read. A
   * Lakehouse engine is provisioned at a tier size and runs continuously, so its
   * queries are SUNK: the thousandth costs what the first did, which is nothing
   * extra. A Cribl Lake query bills billable CPU-seconds through Search every
   * time; one live 15-minute scan has measured 127 on this workspace.
   *
   * So a three-way benchmark compares one store that is free at the margin
   * against two that are not, and "which was fastest" is only half the answer.
   * The panel shows both columns rather than collapsing them into a score.
   */
  billing: 'per-query' | 'sunk'
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
  /** Billable CPU-seconds, from the job's metrics. Null when not readable. */
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
 * Three refusals, and each has cost somebody a wrong decision somewhere:
 *
 *  • Fewer than two targets ran — a comparison of one is not a comparison.
 *  • The row counts disagree. A store answering a different question faster is
 *    not faster. Parquet with an automatic schema does exactly this: absent
 *    fields read back as "" or 0, and a counter measured 18 against 43,338 on
 *    the same window. Naming that the winner is how the wrong format ships.
 *  • No server time. Client wall cannot resolve sub-second differences through
 *    a 700 ms poll, so a verdict from it would be noise with a decimal point.
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
  const fastest = noWinnerBecause === null ? (byServer[0] ?? null) : null
  const slowest = byServer[byServer.length - 1]
  const speedup =
    fastest && slowest && (fastest.serverMs as number) > 0
      ? Number(((slowest.serverMs as number) / (fastest.serverMs as number)).toFixed(1))
      : null

  return { summaries, fastest, noWinnerBecause, disagree, speedup }
}

// ── What it costs, said plainly rather than gated ──────────────────────────
//
// There is NO confirmation in front of this. The owner's call, 2026-09-22: the
// engine tier is a sunk cost the user has already chosen, so the number of
// queries against it does not matter, and a benchmark nobody can run without
// clicking through a dialog is a benchmark nobody runs.
//
// The cost line stays, because two of the three stores DO bill per query and a
// panel that showed a three-way race without saying which lane is metered would
// be quietly misleading. It informs; it does not block.

export const CPU_SECONDS_PER_CREDIT = 3600

export interface CostEstimate {
  runs: number
  /** Runs against stores that bill per query. */
  meteredRuns: number
  /** Runs against a store whose compute is already paid for. */
  sunkRuns: number
  cpuSeconds: number
  credits: number
}

export function estimateCost(targets: readonly BenchTarget[], cpuSecondsPerRun: number): CostEstimate {
  const live = targets.filter((t) => t.available)
  const per = WARMUP_RUNS + MEASURED_RUNS
  const metered = live.filter((t) => t.billing === 'per-query').length
  const sunk = live.length - metered
  const cpuSeconds = metered * per * cpuSecondsPerRun
  return {
    runs: live.length * per,
    meteredRuns: metered * per,
    sunkRuns: sunk * per,
    cpuSeconds,
    credits: Number((cpuSeconds / CPU_SECONDS_PER_CREDIT).toFixed(2)),
  }
}

/** The line the panel prints under the button. Never a bare number. */
export function costSentence(targets: readonly BenchTarget[], cpuSecondsPerRun: number): string {
  const { runs, meteredRuns, sunkRuns, cpuSeconds, credits } = estimateCost(targets, cpuSecondsPerRun)
  if (runs === 0) return 'No store is configured, so there is nothing to run.'

  const shape = `${runs} searches — ${WARMUP_RUNS} warm-up and ${MEASURED_RUNS} measured per store, run one at a time.`
  if (meteredRuns === 0) {
    return `${shape} All of them run on an engine you have already provisioned, so they cost nothing beyond the tier you are paying for.`
  }
  const metered =
    `${meteredRuns} of them read Cribl Lake through Search and bill about ${Math.round(cpuSeconds)} ` +
    `billable CPU-seconds, roughly ${credits} credits, estimated from ${cpuSecondsPerRun} a run measured here.`
  if (sunkRuns === 0) return `${shape} ${metered}`
  return `${shape} ${metered} The other ${sunkRuns} run on an engine whose compute is already paid for.`
}

/** Roughly how long the whole thing takes, so the button can say so. */
export function estimateDurationMs(targets: readonly BenchTarget[], msPerRun: number): number {
  const { runs } = estimateCost(targets, 0)
  // Sequential, plus one admission gap between runs. No reuse gap: every run is
  // submitted with reuse off, so none of them waits one out.
  return runs * (msPerRun + ADMISSION_STAGGER_MS)
}
