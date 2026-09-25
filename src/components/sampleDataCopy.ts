// The words the app says while it is reading the pack's sample dataset.
//
// ONE TREATMENT, APP-LEVEL (owner decision, 2026-09-24): a banner in the one
// banner slot, on every tab, and nothing per panel. The banner says the one
// thing a reader must not miss — these are not your flows — and the ⓘ beside
// it carries the rest. Pure functions of the verdict, so what the screen claims
// is tested without a DOM.

import { REAL_DATASET, SAMPLE_DATASET } from '../queries/datasets'
import type { DatasetTarget } from '../cribl/datasetTarget'
import type { SwitchState } from '../cribl/accel/tabs'

export const SAMPLE_TITLE = 'Sample data'

/** The banner's one sentence. */
export function sampleBody(target: DatasetTarget): string {
  const why = target.reason === 'real-absent' ? `${REAL_DATASET} does not exist yet` : `${REAL_DATASET} holds no data yet`
  return `Every tab is showing synthetic flows from ${SAMPLE_DATASET}, because ${why}. Your own Gigamon data replaces them automatically once it lands.`
}

/** Everything else, behind the ⓘ. */
export const SAMPLE_TIP = [
  'These flows come from the onboarding pack’s optional sample feed. They are generated, not observed, and describe no real network.',
  `While ${REAL_DATASET} is empty, every query, every ⓘ and every “Open in Search” link names ${SAMPLE_DATASET} instead.`,
  `Snapshot mode steps aside: its stored runs are scheduled over ${REAL_DATASET}, so every panel runs live over the sample, and the time range applies as usual.`,
  'Acceleration cannot be switched on until real data exists, because it would schedule searches over an empty dataset.',
  `How this is known: Cribl Lake’s dataset list and, when that cannot tell, one search for a single record of ${REAL_DATASET}. Press Refresh to check again; with auto-refresh on, the app also checks by itself every ten minutes.`,
].join(' ')

/** Why an acceleration control will not turn schedules on. Shown beside the
 *  control that was pressed, and above the switches. */
export const SAMPLE_ACCEL_OFF = `Off while only sample data exists: scheduled searches read ${REAL_DATASET}, which holds no data yet. They can be switched on once it does.`

/** The same refusal while the check has not given a final answer — the page
 *  cannot yet say which dataset holds data, so it does not claim either. */
export const ACCEL_UNVERIFIED_OFF = `Cannot be switched on yet: the app is still checking whether ${REAL_DATASET} holds data.`

/** The Acceleration panel's strip once real data has been SEEN in the
 *  customer's dataset while every schedule this app installed is paused —
 *  which is how onboarding leaves them on a sample-only workspace. */
export const REAL_DATA_ARRIVED_OFF = 'Real data has arrived. Acceleration is installed but off.'

/** Behind the strip's ⓘ: where to turn it on. */
export const REAL_DATA_ARRIVED_TIP =
  `${REAL_DATASET} holds data now, and every scheduled search this app installed is paused. The “Every dashboard” switch below ` +
  'turns them all on, after a confirmation that states what they cost; each dashboard’s own switch turns on only its own.'

/**
 * Whether the strip shows: the verdict SAW data in the customer's dataset (Lake's
 * size figure or the one-record probe — never only "no sample dataset", and
 * never a provisional answer), and the master switch reads `off` (installed,
 * none running). A pure function of two reads; it writes nothing.
 */
export function realDataArrivedOff(target: DatasetTarget, master: SwitchState | null): boolean {
  const seen = target.known && !target.sample && (target.reason === 'has-data' || target.reason === 'probe-found')
  return seen && master === 'off'
}
