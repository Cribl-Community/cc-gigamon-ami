// The words the app says while it is reading the pack's sample dataset.
//
// ONE TREATMENT, APP-LEVEL (owner decision, 2026-09-24): a banner in the one
// banner slot, on every tab, and nothing per panel. The banner says the one
// thing a reader must not miss — these are not your flows — and the ⓘ beside
// it carries the rest. Pure functions of the verdict, so what the screen claims
// is tested without a DOM.

import { REAL_DATASET, SAMPLE_DATASET } from '../queries/datasets'
import type { DatasetTarget } from '../cribl/datasetTarget'

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
  `How this is known: Cribl Lake’s dataset list and, when that cannot tell, one search for a single record of ${REAL_DATASET}. Press Refresh to check again.`,
].join(' ')

/** Why an acceleration control will not turn schedules on. Shown beside the
 *  control that was pressed, and above the switches. */
export const SAMPLE_ACCEL_OFF = `Off while only sample data exists: scheduled searches read ${REAL_DATASET}, which holds no data yet. They can be switched on once it does.`
