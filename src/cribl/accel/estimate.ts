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
  /** Billable CPU-seconds one LIVE run of the panel's query costs. Measured. */
  liveRunCpuSeconds: number
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
    provenance: assumedFrequency
      ? `${scheduledRun.provenance} How often this panel is opened was never measured; ${measured.assumedRunsPerDay} views a day is an assumption.`
      : scheduledRun.provenance,
  }
}

export interface WorkspaceSaving {
  entries: readonly EntrySaving[]
  savedCpuSeconds: Span
  savedCredits: Span
  /** True when any entry's figure rests on an assumed frequency. The total is
   *  then an assumption too, and a UI that shows only the total must say so. */
  assumedFrequency: boolean
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
  return {
    entries,
    savedCpuSeconds,
    savedCredits: { low: creditsFor(savedCpuSeconds.low), high: creditsFor(savedCpuSeconds.high) },
    assumedFrequency,
    provenance: assumedFrequency
      ? `${MEASUREMENT_PROVENANCE} Part of this total rests on an assumed viewing frequency rather than a measured one.`
      : MEASUREMENT_PROVENANCE,
  }
}
