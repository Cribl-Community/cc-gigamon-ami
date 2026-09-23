// What Phase 2 saves, said in a way that cannot be mistaken for a bill.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS MODULE HAS. Every number it produces is going on a screen in
// front of a customer, next to the word "saves", and every one of them is an
// extrapolation from twelve search jobs measured on ONE workspace, on ONE date,
// against a demo feed. That is enough to decide whether to build the thing. It is
// nowhere near enough to promise somebody a figure on their invoice.
//
// A module that returns a bare number invites the UI to render a bare number, and
// then a screenshot of that number ends up in a procurement conversation. So
// nothing here returns a bare number: every estimate comes with the band it was
// derived under, the BASIS it rests on (measured once, or modelled), and the
// sentence the UI is expected to render beside it. `provenance` is not
// documentation — it is a return value.
//
// ── THE FIT, AND THE PART OF IT WE THREW AWAY ───────────────────────────────
// A-SP0, least-squares over 12 jobs: `CPU-s ≈ −1.1 + 2.62 × data-minutes`,
// r² = 0.978, residual RMS 6.6 CPU-s. "Data-minutes" is how many minutes of data
// the query reads.
//
// WHAT SHIPS IS `0 + 2.6 × data-minutes`, and both changes are deliberate:
//
//   THE INTERCEPT IS DROPPED AND THE FLOOR IS 0, NOT −1.1. A negative intercept
//   is an artefact of fitting a straight line through a cloud that does not reach
//   the origin — it says the model has no information below about half a
//   data-minute, not that a small query refunds you 1.1 CPU-seconds. Shipped as
//   −1.1 it produces a negative cost for any window under 26 seconds, and a
//   negative cost is not a conservative estimate, it is a wrong one that also
//   destroys the reader's trust in the rest of the column. The floor bites where
//   it should: at the bottom of the ±6.6 band, where a 2-minute window's low
//   bound would otherwise be −1.4 CPU-s.
//
//   2.6 RATHER THAN 2.62. Three significant figures on a slope whose residuals
//   are ±6.6 CPU-s is false precision; carrying 2.62 would suggest the second
//   decimal means something.
//
// ── THE DOMAIN, WHICH IS THE THING PEOPLE WILL GET WRONG ────────────────────
// The fit was measured over the minutes of a single hour. Applied to the
// Lake-total entry's 30-day window it predicts 112,320 CPU-s; that query
// **measured 9,297.7**. It is out by a factor of twelve, because it reads a
// different dataset with a different shape and the relationship is not linear out
// there. The model is therefore used in exactly one place in this module — the
// 2-minute scheduled sample, which is inside the domain — and every other figure
// is a measurement. `estimateCpuSeconds` flags an out-of-domain call rather than
// refusing it, because refusing would hide the arithmetic from whoever is trying
// to check it; estimate.test.ts pins the factor-of-twelve gap so that nobody
// "improves" this module by wiring the model up to the 30-day entry.
// ─────────────────────────────────────────────────────────────────────────────

import { CPU_SECONDS_PER_CREDIT } from '../jobCost'
import { MANIFEST, accelEntry, type AccelEntry, type AccelId } from './manifest'
import { cronIntervalMs } from './status'

// ── The fit, as measured and as shipped ─────────────────────────────────────

/** Billable CPU-seconds per minute of data read. A-SP0's 2.62, rounded to the
 *  precision the residuals support. */
export const CPU_PER_DATA_MINUTE = 2.6

/** No query bills less than nothing. See the header for why this is 0 and not
 *  the fitted −1.1. */
export const CPU_FLOOR = 0

/** The fit exactly as it was measured, kept so the shipped constants above can
 *  be checked against it rather than taken on trust. */
export const FIT = Object.freeze({
  intercept: -1.1,
  slope: 2.62,
  rSquared: 0.978,
  /** Root-mean-square residual, in CPU-seconds. The half-width of the band every
   *  modelled figure carries. */
  residualRmsCpuSeconds: 6.6,
  jobs: 12,
  /** Data-minutes beyond which this was never measured. One hour: the fit was
   *  made over the minutes of a single hour's prefix. */
  domainMaxDataMinutes: 60,
  measuredOn: 'one workspace, September 2026',
})

/**
 * How much more a wide result body bills than the `count()` body the fit was made
 * on, over the same bytes: up to 1.43×, measured.
 *
 * It is carried per shape rather than folded into the slope because the two are
 * different claims. The slope is about how much data a query reads; this is about
 * how much of each record it carries back. A `| limit 5000` of whole AMI events
 * is the wide case and the scheduled sample is one, so it gets the full
 * multiplier — the pessimistic end, which is the right end to be wrong at when
 * the number is going next to the word "saves".
 */
export const WIDE_BODY_MULTIPLIER = 1.43
export const NARROW_BODY_MULTIPLIER = 1

/** A `$vt_results` read: 0.3 s, 0.2 billable CPU-s, measured against 6 s / 127
 *  CPU-s for the same body run live. This is the whole mechanism of the phase. */
export const STORED_READ_CPU_SECONDS = 0.2

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A low and a high bound. Never a single number pretending to be certain. */
export interface Span {
  low: number
  high: number
}

export type EstimateBasis =
  /** Somebody ran it and read the meter. n = 1. */
  | 'measured'
  /** The fit produced it. Carries the fit's band. */
  | 'modelled'

export interface CpuEstimate {
  cpuSeconds: number
  band: Span
  basis: EstimateBasis
  /** True when the model was asked about a window wider than it was ever
   *  measured over. The number is still returned; it is not an estimate. */
  extrapolated: boolean
  provenance: string
}

/** Billable CPU-seconds → credits. The divisor is jobCost.ts's, imported rather
 *  than restated: one definition of a credit in the app. */
export function creditsFor(cpuSeconds: number): number {
  return cpuSeconds / CPU_SECONDS_PER_CREDIT
}

export const MODEL_PROVENANCE =
  `Estimated from a least-squares fit over ${FIT.jobs} Cribl Search jobs measured on ${FIT.measuredOn} ` +
  `(r² ${FIT.rSquared}, residual ±${FIT.residualRmsCpuSeconds} CPU-s). An estimate, not a bill: your data volume, ` +
  'engine and query shapes will differ.'

export const EXTRAPOLATION_WARNING =
  `Beyond the ${FIT.domainMaxDataMinutes} data-minutes the fit was measured over, where it is known to be wrong by ` +
  'more than an order of magnitude. Treat it as arithmetic, not as an estimate.'

export const MEASUREMENT_PROVENANCE =
  'Measured once on this workspace against its demo feed during Phase 2 planning (September 2026). One run, so no ' +
  'spread is claimed — a production tenant reads more data in the same wall time.'

/**
 * What the model says a query over `dataMinutes` of data costs.
 *
 * The band is the fit's residual RMS, floored at 0 — it is the spread of the
 * twelve jobs around the line, not a confidence interval, and it says nothing
 * whatever about a different tenant.
 */
export function estimateCpuSeconds(dataMinutes: number, shapeMultiplier = NARROW_BODY_MULTIPLIER): CpuEstimate {
  const minutes = Number.isFinite(dataMinutes) ? Math.max(0, dataMinutes) : 0
  const cpuSeconds = Math.max(CPU_FLOOR, CPU_PER_DATA_MINUTE * minutes * shapeMultiplier)
  const extrapolated = minutes > FIT.domainMaxDataMinutes
  return {
    cpuSeconds,
    band: {
      low: Math.max(CPU_FLOOR, cpuSeconds - FIT.residualRmsCpuSeconds),
      high: cpuSeconds + FIT.residualRmsCpuSeconds,
    },
    basis: 'modelled',
    extrapolated,
    provenance: extrapolated ? `${MODEL_PROVENANCE} ${EXTRAPOLATION_WARNING}` : MODEL_PROVENANCE,
  }
}

/** A figure somebody actually measured. No band: one run is one run, and
 *  inventing a spread for it would be inventing data. */
export function measuredCpuSeconds(cpuSeconds: number): CpuEstimate {
  return {
    cpuSeconds,
    band: { low: cpuSeconds, high: cpuSeconds },
    basis: 'measured',
    extrapolated: false,
    provenance: MEASUREMENT_PROVENANCE,
  }
}

// ── What each entry costs today ─────────────────────────────────────────────

export interface MeasuredEntry {
  /**
   * Billable CPU-seconds one LIVE paint of everything this entry serves costs.
   *
   * Measured on the two Phase 2 entries. On the three hourly ones it is
   * MODELLED — nobody ran a stopwatch over the Capacity tiles — and
   * `liveCostModelled` says so, so a saving built on it is never printed as a
   * measurement.
   */
  liveRunCpuSeconds: number
  /** True where `liveRunCpuSeconds` comes from the model rather than a run. */
  liveCostModelled?: boolean
  /** How often it runs live today. Measured, or null when nobody measured it. */
  liveRunsPerDay: Span | null
  /** Stands in when `liveRunsPerDay` is null. AN ASSUMPTION; every figure
   *  derived through it is flagged `assumedFrequency`. */
  assumedRunsPerDay: number
  /**
   * Billable CPU-seconds the SCHEDULED run costs, where it has been measured.
   * Null hands the question to the model — only defensible while the scheduled
   * window is inside the fit's domain, which is asserted in the tests.
   */
  scheduledRunCpuSeconds: number | null
  /** Which shape multiplier the scheduled body takes, when it is modelled. */
  shapeMultiplier: number
  /** What a reader is being told about, in the panel's own words. */
  what: string
}

/**
 * The measured inputs, keyed by manifest id.
 *
 * `Record<AccelId, …>` on purpose: adding a third entry to the manifest is then
 * a BUILD ERROR here until somebody measures what it costs. An acceleration whose
 * saving nobody measured is the thing this phase's own bar forbids — "it must
 * replace something, and the saving must be measured rather than assumed."
 */
export const MEASURED: Readonly<Record<AccelId, MeasuredEntry>> = Object.freeze({
  gno_lake_30d_c1d: {
    liveRunCpuSeconds: 9297.7,
    // 15–24 paints a day, counted from this workspace's own job history: every
    // viewer's first paint of the Data Flow tab asks for it again.
    liveRunsPerDay: { low: 15, high: 24 },
    assumedRunsPerDay: 15,
    // The schedule runs THE SAME BODY over THE SAME 30-day window, so the
    // scheduled run's cost is the measured live run's cost. Nothing is modelled
    // here, which matters: the model is out by 12× at this window.
    scheduledRunCpuSeconds: 9297.7,
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'Data Flow — Lake total (30 days)',
  },
  gno_sample_2m_c1h: {
    liveRunCpuSeconds: 754.9,
    // NOT MEASURED. Nobody counted how often the Field Explorer tab is opened,
    // and it is per-viewer behaviour rather than a property of the workspace.
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    // Modelled: the scheduled run reads a settled two minutes, not the panel's
    // window, so the measured 754.9 says nothing about it. Two data-minutes is
    // well inside the fit's domain.
    scheduledRunCpuSeconds: null,
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'Field Explorer — In feed (field summaries)',
  },

  gno_presence_c1h: {
    // MEASURED on the live workspace, 2026-09-18, two runs over -15m read from
    // /jobs/:id/metrics: 187.6 CPU-s in 4.6 s and 354.8 CPU-s in 5.5 s. The mean
    // is what ships; the spread is 1.9x on identical query text over the same
    // window length, which is the run-to-run variance this workspace shows
    // everywhere (A-SP0 saw 4-17 CPU-s between back-to-back identical jobs, and
    // a trivial count() measured 102.4 one day and 73.6 the next). Do not quote
    // this to three figures.
    //
    // This is the scan that kept Field Explorer at eight seconds after its
    // sample was already being served from a snapshot: the tab fires TWO jobs on
    // mount and only one of them was accelerated.
    liveRunCpuSeconds: 271.2,
    // NOT MEASURED, and per-viewer rather than a property of the workspace:
    // nobody counted how often Field Explorer is opened. Same assumption as the
    // sample entry beside it, and it must move if either ever is counted.
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    // Modelled. Fifteen data-minutes is inside A-SP0's fitted domain (5–50),
    // which the 30-day entry's window is not.
    scheduledRunCpuSeconds: null,
    // ~96 count() aggregates in one pass. Wider than a sum-or-count body by some
    // margin, and the measured 1.43x is the widest this plan has evidence for —
    // so this is the right multiplier and probably still an under-estimate.
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'Field Explorer — AMI field coverage (which fields are arriving)',
  },
  // ── The three hourly snapshots ────────────────────────────────────────────
  // These are not here to save money and the numbers below should not be read as
  // if they were. They exist so a viewer can ask what the tiles said at 04:20,
  // which no live query answers at any price. Every figure on them is MODELLED
  // from A-SP0 (CPU-s ≈ 2.6 × data-minutes × shape) over the manifest's own
  // 15-minute window, and both flags are set, so the panel that renders a saving
  // from them says out loud that it is an estimate on an assumption.
  gno_overview_c1h: {
    // Five panels, each a whole-window scan of its own at the modelled 39 CPU-s.
    liveRunCpuSeconds: 195,
    liveCostModelled: true,
    // Nobody counted how often these five tabs get opened, and it is per-viewer
    // behaviour rather than a property of the workspace.
    liveRunsPerDay: null,
    assumedRunsPerDay: 12,
    scheduledRunCpuSeconds: null,
    // Wide: the union body carries roughly forty aggregates, which is the shape
    // the 1.43 multiplier was measured on.
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'Capacity, Web, Security, Findings and Data Flow — the opening tiles on five tabs',
  },
  gno_svc_nodes_c1h: {
    liveRunCpuSeconds: 55.8,
    liveCostModelled: true,
    liveRunsPerDay: null,
    // Flow map is the default route: every arrival at the app runs it.
    assumedRunsPerDay: 24,
    scheduledRunCpuSeconds: null,
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'Flow map — the graph nodes',
  },
  gno_svc_edges_c1h: {
    // 39, and it was 78. It used to be two live scans of the window — the edges
    // and the per-source totals — at the modelled 39 CPU-s each. The tab now
    // runs the union body ONCE and derives both client-side, so a live paint of
    // everything this entry serves is one scan, in Live mode as well as through
    // the schedule. The saving below therefore got smaller and truer: the thing
    // it is measured against is cheaper than it was.
    liveRunCpuSeconds: 39,
    liveCostModelled: true,
    liveRunsPerDay: null,
    assumedRunsPerDay: 24,
    scheduledRunCpuSeconds: null,
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'Flow map — the edges and the per-source outbound totals',
  },

  gno_app_src_c1h: {
    // Three unfiltered whole-window scans on mount at the modelled 39 CPU-s
    // each. MODELLED, not measured — nobody put a stopwatch on the Shadow AI
    // tab; what was observed is the wall time, about eight seconds, which is
    // mostly the ~1.6 s admission stagger between the three jobs rather than any
    // one of them being slow.
    liveRunCpuSeconds: 117,
    liveCostModelled: true,
    // NOT MEASURED. Shadow AI is a discovery tab somebody opens when they are
    // asking the question, not the route the app lands on, so this is the same
    // assumption Field Explorer carries and it must move if either is ever
    // counted.
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    // Modelled. Fifteen data-minutes is inside A-SP0's fitted domain.
    scheduledRunCpuSeconds: null,
    // WIDE, and the body is a two-aggregate count-and-sum, which argues for
    // narrow. The multiplier is used here for the other half of what it stands
    // for: this body returns one row per (app_name, src_ip) pair, and that
    // cardinality is the one thing about this entry nobody has measured. 1.43 is
    // the widest shape this plan has evidence for, so it is the pessimistic end
    // — the right end to be wrong at when the figure sits beside the word
    // "saves".
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'Shadow AI — the AI tiles, the app and SaaS bar lists, and the top AI users',
  },

  gno_dns_resolver_c1h: {
    // The per-resolver grouping (PER_RESOLVER) alone now: 55.8, the same
    // 2.6 x 15 x 1.43 the flow-map node query carries and for the same reason —
    // a percentile over a grouping returns many rows. MODELLED; the tiles' 39
    // moved to gno_dns_overall_c1h when the two were split (2026-09-23).
    liveRunCpuSeconds: 55.8,
    liveCostModelled: true,
    // NOT MEASURED. DNS health is an operational tab somebody opens when DNS is
    // suspected, not the route the app lands on. The same assumption Field
    // Explorer and Shadow AI carry, and it must move if any of them is counted.
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    // Modelled. Fifteen data-minutes is inside A-SP0's fitted domain.
    scheduledRunCpuSeconds: null,
    // WIDE: one row per resolver, up to the 500 the body keeps.
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'DNS health — the resolver table',
  },

  gno_dns_overall_c1h: {
    // The five-aggregate single row (OVERALL): 39, MODELLED, as it was when it
    // was one half of the DNS entry.
    liveRunCpuSeconds: 39,
    liveCostModelled: true,
    // The same tab, opened the same number of times, as the resolver table.
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    scheduledRunCpuSeconds: null,
    // NARROW: one row.
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'DNS health — the three tiles above the resolver table',
  },


  gno_pipeline_c1h: {
    // ── THE FIGURE BELOW IS THE MODEL'S, AND THE MODEL WAS NOT FIT ON THIS
    //    DATASET. Said plainly because this row is the one place in the table
    //    where that is true.
    //
    // A-SP0 was fit over twelve scans of gigamon_ami. METRICS_QUERY reads
    // cribl_metrics — a counter series, not flow records — and the only
    // measurement this workspace has on that dataset is the 30-day Lake total:
    // 9,297.7 CPU-s over 43,200 data-minutes, which is 0.215 CPU-s per
    // data-minute against A-SP0's 2.6. Scaled that way, fifteen minutes of
    // cribl_metrics would be about 3 CPU-s rather than the 39 below.
    //
    // 39 SHIPS ANYWAY, and deliberately: the scheduled side of this row is
    // modelled from the same fit, so both sides carry the same unknown factor
    // and the one number that matters survives it. `breakEvenRunsPerDay` is a
    // RATIO of the two — 24.1 views a day at either scaling (39/39 gives 24.1,
    // 3.2/3.2 gives 25.6) — and that is the honest statement about this entry:
    // it pays for itself only if the tab is opened about as often as it runs.
    // What does not survive is the absolute CPU-s column, which is an order of
    // magnitude high on both sides. Do not quote it; quote the break-even.
    liveRunCpuSeconds: 39,
    liveCostModelled: true,
    // MEASURED, and this is the one hourly entry that can say so. This query
    // runs on the same mount as the 30-day Lake total, whose 15-24 paints a day
    // were counted from this workspace's own job history. It is a lower bound
    // rather than an estimate: the Lake tile is pinned to -30d and does not
    // re-run on a range change, while this one follows the picker and does.
    liveRunsPerDay: { low: 15, high: 24 },
    assumedRunsPerDay: 15,
    scheduledRunCpuSeconds: null,
    // NARROW: six sum(iif(…)) counters, one row out. Whatever the dataset costs
    // to read, the result body is as small as a body gets.
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'Data Flow — the Cribl stage counters behind the diagram',
  },

  // ── The four Web & API health scans ───────────────────────────────────────
  // Every figure in these four rows is MODELLED — nobody put a stopwatch on this
  // tab. What was observed is the wall time: roughly 6.4 s for the three queries
  // that fire on mount, and another ~8 s when the reader scrolls the three
  // deferred panels into view. Most of that is the ~1.6 s admission stagger
  // between concurrent jobs from one account plus this workspace's ~5 s floor,
  // not any one of these queries being expensive. The modelled 39 CPU-s is
  // A-SP0's 2.6 x 15 data-minutes at the narrow shape.
  //
  // liveRunsPerDay is null on all four for the same reason it is null on Shadow
  // AI and DNS: nobody counted how often this tab is opened, and it is
  // per-viewer behaviour rather than a property of the workspace. 4 is the
  // house assumption for a tab somebody opens when they are asking the question.
  // Every figure derived through it is flagged `assumedFrequency`.

  gno_web_host_c1h: {
    // Two whole-window groupings by http_host at the modelled 39 CPU-s each.
    liveRunCpuSeconds: 78,
    liveCostModelled: true,
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    // Modelled. Fifteen data-minutes is inside A-SP0's fitted domain (5-50).
    scheduledRunCpuSeconds: null,
    // WIDE: one row per distinct HTTP host, carrying a percentile. A percentile
    // over a grouping is the shape gno_svc_nodes_c1h and gno_dns_resolver_c1h
    // both carry the wide multiplier for, and this feed's http_host cardinality
    // is the one thing about this entry nobody has measured. 1.43 is the widest
    // shape this plan has evidence for, so it is the pessimistic end — the right
    // end to be wrong at beside the word "saves".
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'Web and API health — the top endpoints and the slowest hosts',
  },

  gno_web_code_c1h: {
    liveRunCpuSeconds: 39,
    liveCostModelled: true,
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    scheduledRunCpuSeconds: null,
    // NARROW: one count() by status code, at most a couple of dozen rows out.
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'Web and API health — the status-code distribution',
  },

  gno_web_trend_c1h: {
    liveRunCpuSeconds: 39,
    liveCostModelled: true,
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    scheduledRunCpuSeconds: null,
    // NARROW: two counters by minute, fifteen rows out.
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'Web and API health — requests and errors over time',
  },

  gno_web_h2_c1h: {
    liveRunCpuSeconds: 39,
    liveCostModelled: true,
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    scheduledRunCpuSeconds: null,
    // NARROW: one count() by http2_host, capped at ten rows in the body itself.
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'Web and API health — the HTTP/2 hosts',
  },
  // ── TCP health's two subnet heatmaps ──────────────────────────────────────
  // The live figure below is DELIBERATELY UNDERSTATED, and the understatement is
  // in the safe direction. 55.8 is one scan — the modelled 2.6 × 15 × 1.43 that
  // every grouped body in this table carries — and one scan is what ONE PAINT of
  // the heatmap costs. But the panel this entry serves has four metric buttons
  // and each press is another whole scan, so a reader actually comparing resets
  // against CRC errors pays two, three, four times this. Counting only the first
  // paint makes the saving smaller than it is, which is the right end to be wrong
  // at when the number sits next to the word "saves".

  gno_tcp_subnet24_c1h: {
    liveRunCpuSeconds: 55.8,
    liveCostModelled: true,
    // NOT MEASURED. TCP health is an operational tab somebody opens when the
    // network is suspected, not the route the app lands on — the same assumption
    // DNS health, Shadow AI and Field Explorer carry, and it must move if any of
    // them is ever counted.
    liveRunsPerDay: null,
    assumedRunsPerDay: 4,
    // Modelled. Fifteen data-minutes is inside A-SP0's fitted domain.
    scheduledRunCpuSeconds: null,
    // WIDE: up to 120 rows of five aggregates. The body carries four sums where
    // the live query carries one, which is more work per row and is exactly what
    // buys the other three panel states.
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'TCP health — the wire-error heatmap at /24, all four metrics',
  },

  gno_tcp_subnet16_c1h: {
    liveRunCpuSeconds: 55.8,
    liveCostModelled: true,
    liveRunsPerDay: null,
    // Two rather than the /24 entry's four, and the difference is a judgement
    // rather than a measurement: /24 is the state the tab opens in, and /16 is a
    // second look somebody takes deliberately. Stated separately so that it is
    // an assumption somebody can argue with rather than a copied number.
    assumedRunsPerDay: 2,
    scheduledRunCpuSeconds: null,
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'TCP health — the wire-error heatmap at /16, all four metrics',
  },


  gno_talkers_src_c1h: {
    // One narrow whole-window scan ending in `limit 12`: the 39 CPU-s the
    // model gives every such scan on this tab. MODELLED, like the rest of
    // Capacity. What WAS measured is its wall time in the browser trace,
    // 2.4-3.0 s, which is why it is scheduled.
    liveRunCpuSeconds: 39,
    liveCostModelled: true,
    // The overview entry's assumption for how often this tab is opened, for the
    // reason gno_app_l4_c1h gives: one tab, one answer.
    liveRunsPerDay: null,
    assumedRunsPerDay: 12,
    scheduledRunCpuSeconds: null,
    shapeMultiplier: NARROW_BODY_MULTIPLIER,
    what: 'Capacity & top talkers — the top talkers by source IP',
  },

  gno_app_l4_c1h: {
    // Three whole-window scans on mount in the tab's default view at the
    // modelled 39 CPU-s each: the top-talkers bar list, the app-mix donut and
    // the L4 split. MODELLED, not measured — nobody put a stopwatch on this
    // tab; what was observed is the wall time, about five seconds, and most of
    // that is this workspace's ~5 s floor plus the ~1.6 s admission stagger
    // rather than any one of the three being expensive.
    //
    // NARROW on the live side, and it is worth saying why when the scheduled
    // side below is wide. All three live queries end in a `limit` of 12, 8 or a
    // handful of protocol rows, so the result body each one carries back is as
    // small as a body gets. The 1.43x multiplier was measured on a body of
    // whole AMI events; applying it here would overstate what the tab costs
    // today, and the figure this row feeds sits beside the word "saves".
    liveRunCpuSeconds: 117,
    liveCostModelled: true,
    // NOT MEASURED. Nobody counted how often this tab is opened. 12 is the
    // overview entry's assumption, taken deliberately rather than reinvented:
    // that row already stands behind this same tab's KPI strip, so two rows
    // serving one tab assuming different open rates would be two answers to one
    // question.
    liveRunsPerDay: null,
    assumedRunsPerDay: 12,
    // Modelled. Fifteen data-minutes is inside A-SP0's fitted domain.
    scheduledRunCpuSeconds: null,
    // WIDE, where the three live queries are narrow, and the asymmetry is the
    // point: the scan stores the whole (app_name, l4_proto) cross product so
    // that each panel can sum it back along one key, which the audit puts at
    // roughly 450 rows — about ninety applications by a few protocols. That is
    // an estimate of a cardinality nobody has counted, so the pessimistic
    // multiplier is the right end to be wrong at.
    shapeMultiplier: WIDE_BODY_MULTIPLIER,
    what: 'Capacity & top talkers — the app mix, the L4 split and the top-apps bar list',
  },
})

// ── Windows ─────────────────────────────────────────────────────────────────

const UNITS: Readonly<Record<string, number>> = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080 }

/** A relative bound (`-30d`, `-4m`, `now`) as minutes before now, or null. */
function boundMinutes(bound: string): number | null {
  const b = bound.trim()
  if (b === 'now') return 0
  const m = /^-(\d+)\s*([smhdw])$/.exec(b)
  if (!m) return null
  return Number(m[1]) * UNITS[m[2]]
}

/**
 * How many minutes of data an entry's window covers.
 *
 * Read from the manifest rather than typed here, so the sample entry's
 * `-4m … -2m` cannot end up costed as the two minutes it used to be while the
 * manifest says something else.
 */
export function windowMinutes(entry: AccelEntry): number | null {
  const from = boundMinutes(entry.earliest)
  const to = boundMinutes(entry.latest)
  if (from === null || to === null) return null
  return Math.max(0, from - to)
}

/** How many times a day this entry's cron fires, or null when the cron shape
 *  cannot be read. */
export function runsPerDay(entry: AccelEntry): number | null {
  const interval = cronIntervalMs(entry.cron)
  return interval === null || interval <= 0 ? null : (24 * 60 * 60 * 1000) / interval
}

// ── The saving ──────────────────────────────────────────────────────────────

export interface EntrySaving {
  id: AccelId
  what: string
  /** CPU-seconds a day the live query bills now, across the frequency span. */
  beforeCpuSeconds: Span
  /** CPU-seconds a day after: the scheduled runs, plus a stored read for each
   *  paint that used to be a live query. */
  afterCpuSeconds: Span
  savedCpuSeconds: Span
  savedCredits: Span
  /** What one scheduled run costs, with its basis and band. */
  scheduledRun: CpuEstimate
  scheduledRunsPerDay: number
  /**
   * How often the panel has to be looked at before the schedule pays for itself.
   *
   * The honest counterpart to a saving: a schedule bills whether or not anybody
   * opens the tab, so below this rate acceleration COSTS money. It is what makes
   * "turn it off" a supportable answer rather than an admission.
   */
  breakEvenRunsPerDay: number | null
  /** True when the frequency this rests on is an assumption, not a measurement. */
  assumedFrequency: boolean
  /** True when what the panels cost live was modelled rather than run. The
   *  saving is then an estimate on both sides, and a surface quoting it has to
   *  say so — see `provenance`. */
  modelledLiveCost: boolean
  provenance: string
}

/** One entry's arithmetic, at one frequency. */
function dailyAt(measured: MeasuredEntry, scheduledCpu: number, scheduledPerDay: number, runs: number) {
  const before = measured.liveRunCpuSeconds * runs
  const after = scheduledCpu * scheduledPerDay + STORED_READ_CPU_SECONDS * runs
  return { before, after, saved: before - after }
}

/**
 * What one manifest entry saves in a day.
 *
 * `runsPerDayOverride` is how a caller that knows better — a workspace that has
 * counted its own paints — replaces the measured span or the assumption.
 */
export function estimateEntrySaving(id: AccelId, runsPerDayOverride?: number): EntrySaving {
  const entry = accelEntry(id)
  const measured = MEASURED[id]
  const scheduledPerDay = runsPerDay(entry) ?? 1
  const minutes = windowMinutes(entry) ?? 0
  const scheduledRun =
    measured.scheduledRunCpuSeconds !== null
      ? measuredCpuSeconds(measured.scheduledRunCpuSeconds)
      : estimateCpuSeconds(minutes, measured.shapeMultiplier)

  const span: Span =
    runsPerDayOverride !== undefined
      ? { low: runsPerDayOverride, high: runsPerDayOverride }
      : (measured.liveRunsPerDay ?? { low: measured.assumedRunsPerDay, high: measured.assumedRunsPerDay })

  const low = dailyAt(measured, scheduledRun.cpuSeconds, scheduledPerDay, span.low)
  const high = dailyAt(measured, scheduledRun.cpuSeconds, scheduledPerDay, span.high)

  // Saving rises with how often the panel is read, so the low bound is the low
  // frequency's saving and not some combination of independent extremes.
  const savedCpuSeconds: Span = { low: low.saved, high: high.saved }
  const perRead = measured.liveRunCpuSeconds - STORED_READ_CPU_SECONDS
  const assumedFrequency = runsPerDayOverride === undefined && measured.liveRunsPerDay === null

  return {
    id,
    what: measured.what,
    beforeCpuSeconds: { low: low.before, high: high.before },
    afterCpuSeconds: { low: low.after, high: high.after },
    savedCpuSeconds,
    savedCredits: { low: creditsFor(savedCpuSeconds.low), high: creditsFor(savedCpuSeconds.high) },
    scheduledRun,
    scheduledRunsPerDay: scheduledPerDay,
    breakEvenRunsPerDay: perRead > 0 ? (scheduledRun.cpuSeconds * scheduledPerDay) / perRead : null,
    assumedFrequency,
    modelledLiveCost: measured.liveCostModelled === true,
    provenance: [
      scheduledRun.provenance,
      assumedFrequency
        ? `How often this panel is opened was never measured; ${measured.assumedRunsPerDay} views a day is an assumption.`
        : '',
      // Said separately from the frequency assumption because they are different
      // admissions: one is about how often somebody looks, the other about what
      // the thing they are looking at costs when it runs. An entry that exists to
      // make a past state readable rather than to save money has both, and the
      // saving it prints is arithmetic over two estimates.
      measured.liveCostModelled
        ? 'What these panels cost run live is modelled from the same fit, not measured, so the saving is an estimate on both sides.'
        : '',
    ]
      .filter((s) => s !== '')
      .join(' '),
  }
}

export interface WorkspaceSaving {
  entries: readonly EntrySaving[]
  savedCpuSeconds: Span
  savedCredits: Span
  /** True when any entry's figure rests on an assumed frequency. The total is
   *  then an assumption too, and a UI that shows only the total must say so. */
  assumedFrequency: boolean
  /** True when any entry's live cost was modelled rather than measured. */
  modelledLiveCost: boolean
  provenance: string
}

/** Everything the manifest accelerates, added up. */
export function estimateWorkspaceSaving(ids: readonly AccelId[] = MANIFEST.map((e) => e.id)): WorkspaceSaving {
  const entries = ids.map((id) => estimateEntrySaving(id))
  const savedCpuSeconds: Span = {
    low: entries.reduce((n, e) => n + e.savedCpuSeconds.low, 0),
    high: entries.reduce((n, e) => n + e.savedCpuSeconds.high, 0),
  }
  const assumedFrequency = entries.some((e) => e.assumedFrequency)
  const modelledLiveCost = entries.some((e) => e.modelledLiveCost)
  return {
    entries,
    savedCpuSeconds,
    savedCredits: { low: creditsFor(savedCpuSeconds.low), high: creditsFor(savedCpuSeconds.high) },
    assumedFrequency,
    modelledLiveCost,
    provenance: assumedFrequency
      ? `${MEASUREMENT_PROVENANCE} Part of this total rests on an assumed viewing frequency rather than a measured one.`
      : MEASUREMENT_PROVENANCE,
  }
}
