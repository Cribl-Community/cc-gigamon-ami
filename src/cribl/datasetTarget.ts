// Which Lake dataset the dashboards read: the customer's, or the pack's sample.
//
// ─────────────────────────────────────────────────────────────────────────────
// OWNER DECISIONS, 2026-09-24. The onboarding pack can feed SYNTHETIC flows (an
// opt-in DataGen) into a dataset of their own, `gigamon_ami_sample`, never into
// `gigamon_ami`. The app reads the sample dataset ONLY while the customer's holds
// no data, and goes back on its own once real data lands. Real wins whenever
// both exist; when neither does, the app is what it always was — reading
// `gigamon_ami`, with every panel's own empty state.
//
// ── HOW "REAL DATA EXISTS" IS DECIDED, CHEAPLY ──────────────────────────────
// One config-plane GET decides almost every install, and bills nothing:
// `GET /products/lake/lakes/default/datasets?includeMetrics=true` (`listDatasets`,
// already granted for Guided Setup).
//
//   * no sample dataset                → REAL. Every install that did not opt in.
//   * no customer dataset              → SAMPLE. Nothing can be in it.
//   * the customer's size figure > 0   → REAL. Lake's own daily metric.
//
// The size figure is DAILY and can be absent on a dataset that holds data
// (measured 2026-09-24: `cribl_metrics` reports `metrics: {}` with 30 days in
// it), so zero or absent is not "empty". Only then — sample dataset present,
// customer's dataset present, no positive size — does this submit one search:
// `REAL_DATA_PROBE_QUERY`, one row over the dataset's retention. Measured the
// same day: 0.08–0.38 billable CPU-s against an empty dataset, which is the
// case it runs in; 41.6 against a populated one.
//
// THE POPULATED CASE IS PAID ON EVERY PAGE LOAD until Lake's figure turns
// positive, not once. How long that is, measured 2026-09-24: every dataset
// this workspace created reports a dated size (`gigamon_ami`: 111 GB as of the
// day before), while the built-in ones (`cribl_*`, `default_*`) report `{}`
// whatever they hold — so for the customer's dataset it is the day between
// real data landing and Lake's next daily figure.
//
// A NARROWER WINDOW DOES NOT BUY IT BACK, which is why the probe is not
// widened in steps. `limit 1` over the populated `gigamon_ami`, measured
// 2026-09-24: 28.5 CPU-s over 5 minutes, 30.3 and 30.5 over an hour, 35.4 over
// a day, 40.2 and 41.6 over 30 days. Touching a populated dataset at all has a
// floor; a `-1h` first step would save about a quarter of it on the day real
// data lands, and add a probe and ~1.5 s to EVERY sample-install load — enough
// to push the verdict past HOLD_DEADLINE_MS and run every panel twice.
//
// CACHED FOR THE PAGE, never stored. A stored verdict would be a write on load
// and would outlive the thing it describes. A REAL verdict is final for the
// page. A SAMPLE verdict is re-checked — that is how an open page finds the
// first real record — on an explicit Refresh, and on an auto-refresh tick at
// most every TICK_RECHECK_MS, because a wall display left on sample data would
// otherwise never move back. That is a READ on a timer: one free listing and at
// most one probe of an empty dataset. Nothing here writes, on a timer or not.
//
// ── WHAT A VERDICT CHANGES ──────────────────────────────────────────────────
// `setActiveDataset` (config.ts): every job body (search.ts), deep link and
// Copilot brief (config.ts) names the sample dataset, and so does every ⓘ
// (components/PanelInfo.tsx). `setSnapshotWithheld` (dataMode.ts): Snapshot
// mode steps aside, because every scheduled search scans the customer's
// dataset. Acceleration's switches refuse to turn anything on
// (accel/tabs.ts). Nothing is written, anywhere, by any of it.
//
// ── WAITING FOR THE VERDICT ─────────────────────────────────────────────────
// A panel holds its first submit until this answers (useSearch), exactly as a
// snapshot panel waits for the viewer's mode: submitting to `gigamon_ami` and
// then again to the sample would be two jobs on every sample-install load. The
// hold has a floor — `HOLD_DEADLINE_MS` — after which the app proceeds on the
// customer's dataset and moves if the verdict later says sample.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react'
import { LAKE_DATASET, setActiveDataset } from './config'
import { setSnapshotWithheld } from './dataMode'
import { listDatasets, type LakeDataset, type ReadResult } from './lake'
import { runSearch } from './search'
import { REAL_DATA_PROBE_QUERY, SAMPLE_DATASET } from '../queries/datasets'

/** Why the app is reading the dataset it is. */
export type TargetReason =
  /** Not decided yet. */
  | 'reading'
  /** There is no sample dataset: every install that did not opt in. */
  | 'no-sample'
  /** Lake's own size figure says the customer's dataset holds data. */
  | 'has-data'
  /** The one-row probe found a record in the customer's dataset. */
  | 'probe-found'
  /** The Lake API could not be read. The customer's dataset, as before. */
  | 'unreadable'
  /** The probe failed or timed out. Real wins when it is not known. */
  | 'probe-failed'
  /** Nothing answered in time; provisional, and replaced when something does. */
  | 'deadline'
  /** SAMPLE: there is no customer dataset. */
  | 'real-absent'
  /** SAMPLE: the probe found no record in the customer's dataset. */
  | 'real-empty'

export interface DatasetTarget {
  /** False only while the first verdict is outstanding. */
  known: boolean
  /** Reading the sample dataset. */
  sample: boolean
  /** The dataset queries are sent to. */
  dataset: string
  reason: TargetReason
}

/** How long a panel waits for the first verdict before running on the
 *  customer's dataset. A listing answers in well under a second, and the probe
 *  in 0.6–1.9 s (measured); four seconds covers both without a panel looking
 *  broken, and past it the app does what it always did. */
export const HOLD_DEADLINE_MS = 4_000
/** The probe's own client timeout. A probe that has not answered by then is
 *  answered as "real" — the answer that can never show sample data over a
 *  customer's own. */
export const PROBE_TIMEOUT_MS = 20_000

/** How often an auto-refresh tick may look again while on the sample. Ten
 *  minutes: real data landing is a once-per-install event, and each look is a
 *  free listing plus a probe of 0.08–0.38 CPU-s against an empty dataset. */
export const TICK_RECHECK_MS = 10 * 60_000

const datasetFor = (sample: boolean) => (sample ? SAMPLE_DATASET : LAKE_DATASET)

const make = (known: boolean, sample: boolean, reason: TargetReason): DatasetTarget =>
  Object.freeze({ known, sample, dataset: datasetFor(sample), reason })

const READING = make(false, false, 'reading')

// ── The decision, pure ──────────────────────────────────────────────────────

export type ListingVerdict =
  | { kind: 'real'; reason: TargetReason }
  | { kind: 'sample'; reason: TargetReason }
  | { kind: 'probe'; earliest: string }

const live = (d: LakeDataset | undefined): LakeDataset | undefined => (d && d.deletionStartedAt === null ? d : undefined)

/** What the dataset listing alone can decide. A dataset being deleted counts as absent. */
export function judgeListing(r: ReadResult<LakeDataset[]>): ListingVerdict {
  if (r.outcome !== 'ok' || r.value === null) return { kind: 'real', reason: 'unreadable' }
  const real = live(r.value.find((d) => d.id === LAKE_DATASET))
  const sample = live(r.value.find((d) => d.id === SAMPLE_DATASET))
  if (!sample) return { kind: 'real', reason: 'no-sample' }
  if (!real) return { kind: 'sample', reason: 'real-absent' }
  const size = real.metrics?.currentSizeBytes ?? null
  if (size !== null && size > 0) return { kind: 'real', reason: 'has-data' }
  // Zero or absent is not "empty" — see the header. Probe the dataset's whole
  // retention: against an empty dataset the window costs nothing, and a
  // narrower one could miss a record Lake's daily figure has not counted yet.
  const days = real.retentionPeriodInDays
  return { kind: 'probe', earliest: `-${days !== null && days > 0 ? Math.round(days) : 30}d` }
}

/** What the probe decides. A failure is REAL: never show sample data over a
 *  customer's own because a search did not answer. */
export function judgeProbe(outcome: 'found' | 'empty' | 'failed'): { kind: 'real' | 'sample'; reason: TargetReason } {
  if (outcome === 'found') return { kind: 'real', reason: 'probe-found' }
  if (outcome === 'empty') return { kind: 'sample', reason: 'real-empty' }
  return { kind: 'real', reason: 'probe-failed' }
}

// ── The store ───────────────────────────────────────────────────────────────

let state: DatasetTarget = READING
let inFlight: Promise<DatasetTarget> | null = null
/** When the last read started, for the tick throttle. */
let lastLook = 0
const listeners = new Set<() => void>()

function publish(next: DatasetTarget): void {
  state = next
  // Both halves move together, before anyone is told: a listener that reads
  // the active dataset must see the same answer the state carries.
  setActiveDataset(next.dataset)
  setSnapshotWithheld(next.sample)
  for (const l of listeners) l()
}

async function probe(earliest: string): Promise<'found' | 'empty' | 'failed'> {
  try {
    const res = await runSearch(REAL_DATA_PROBE_QUERY, {
      earliest,
      latest: 'now',
      limit: 1,
      timeoutMs: PROBE_TIMEOUT_MS,
      // It asks about the customer's dataset by definition — never the sample.
      asWritten: true,
    })
    return res.rows.length > 0 ? 'found' : 'empty'
  } catch {
    return 'failed'
  }
}

async function decide(): Promise<DatasetTarget> {
  const verdict = judgeListing(await listDatasets({ background: true }))
  if (verdict.kind !== 'probe') return make(true, verdict.kind === 'sample', verdict.reason)
  const answer = judgeProbe(await probe(verdict.earliest))
  return make(true, answer.kind === 'sample', answer.reason)
}

function run(): Promise<DatasetTarget> {
  lastLook = Date.now()
  const p = decide()
  inFlight = p
  void p.then((next) => {
    if (inFlight !== p) return
    inFlight = null
    publish(next)
  })
  return p
}

/**
 * The verdict for this page, reading it once. Reads only: one GET, and at most
 * one search. Every caller shares the same read.
 */
export function resolveDatasetTarget(): Promise<DatasetTarget> {
  if (state.reason !== 'reading' && state.reason !== 'deadline') return Promise.resolve(state)
  if (inFlight !== null) return inFlight
  const p = run()
  if (!state.known) {
    const deadline = setTimeout(() => {
      if (!state.known) publish(make(true, false, 'deadline'))
    }, HOLD_DEADLINE_MS)
    void p.finally(() => clearTimeout(deadline))
  }
  return p
}

/**
 * Look again — from an explicit Refresh, and only while reading the sample.
 * Unthrottled: a person asked. (A tick goes through `recheckDatasetTargetOnTick`.)
 *
 * A REAL verdict is final for the page: data does not leave a dataset between
 * two presses. A SAMPLE one is how an open page finds the first real record,
 * and the panels keep reading the sample until the new verdict says otherwise.
 */
export function recheckDatasetTarget(): void {
  if (!state.sample || inFlight !== null) return
  void run()
}

/**
 * Look again from an auto-refresh tick — at most every TICK_RECHECK_MS since
 * the last read, and only while reading the sample. A read, never a write.
 */
export function recheckDatasetTargetOnTick(): void {
  if (!state.sample || inFlight !== null) return
  if (Date.now() - lastLook < TICK_RECHECK_MS) return
  void run()
}

/**
 * Look again after a CONFIRMED RUN that may have changed the answer — whatever
 * the current verdict, final or not. A read: one GET, and at most one probe.
 *
 * WHY A REAL VERDICT IS NOT FINAL HERE. "Final for the page" rests on data not
 * leaving a dataset between two presses, and that still holds. What it missed
 * is a dataset ARRIVING: onboarding with sample data ticked creates
 * `gigamon_ami_sample` on a page that already decided `no-sample`, and nothing
 * else ever looks again — `recheckDatasetTarget` and the tick run only while on
 * the sample. So the run calls this once it has finished writing, and never
 * anything else: not a mount, not a render, not a timer.
 *
 * A read already in flight is superseded rather than awaited. It started before
 * the run's writes, so its answer is about a workspace that no longer exists;
 * `run` drops the result of any read that is no longer the latest.
 */
export function reconsiderDatasetTarget(): Promise<DatasetTarget> {
  return run()
}

/**
 * Whether anything may turn a scheduled search ON.
 *
 * Only on a FINAL verdict of real data. `sample: false` is not enough: it is
 * also what the page says while the check is still out, and in the provisional
 * `deadline` state — both of which can still end on sample, and a schedule
 * created running in that window keeps billing over an empty dataset.
 */
export function realDataConfirmed(t: DatasetTarget): boolean {
  return t.known && t.reason !== 'deadline' && !t.sample
}

/** The verdict, for code that is not a component. */
export function datasetTarget(): DatasetTarget {
  return state
}

export function subscribeDatasetTarget(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function subscribe(listener: () => void): () => void {
  const off = subscribeDatasetTarget(listener)
  // The first subscriber starts the read — a READ on mount, which AGENTS.md
  // allows; main.tsx has usually started it already.
  void resolveDatasetTarget()
  return off
}

const getState = () => state

/** The verdict in a component. `known: false` while it is outstanding. */
export function useDatasetTarget(): DatasetTarget {
  return useSyncExternalStore(subscribe, getState, getState)
}

/** Tests only: a verdict, as if it had been read — no network. */
export function settleDatasetTarget(sample: boolean, reason: TargetReason = sample ? 'real-empty' : 'no-sample'): void {
  inFlight = null
  lastLook = Date.now()
  publish(make(true, sample, reason))
}

/** Tests only: back to a page that has read nothing. */
export function resetDatasetTarget(): void {
  inFlight = null
  lastLook = 0
  publish(READING)
}
