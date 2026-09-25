// What the onboarding confirmation says, pure and DOM-free — the sentences
// src/cribl/onboarding/plan.ts puts into its one dialog. Kept here, beside
// provisionPanelCopy.ts and accelPanelCopy.ts, for the reason those exist: a
// sentence about somebody's configuration is the thing that can be wrong, and
// a pure string can be asserted directly.
//
// No internal project history in anything here: no spike ids, phase numbers,
// decision numbers or dates. plan.test.ts's copy-hygiene test holds that, over
// everything the dialog built from these says.

import { PACK_HTTP_INPUT_ID, PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID } from '../cribl/pack'
import type { SampleVolume } from '../cribl/onboarding/plan'

const whole = (n: number) => Math.round(n).toLocaleString('en-US')

/**
 * The cost line's acceleration half.
 *
 * ABOUT THE SEARCHES THIS RUN CREATES, and then the ones already there. The
 * mode decides only how a CREATE is written (accel/provision.ts
 * `applyAcceleration` `{ enabled }`); a schedule an earlier Apply installed
 * keeps whatever pause state Cribl holds, and a correction keeps it too. So
 * "installed paused, nothing billed" is a claim about the new ones alone, and
 * the ones already running are counted in a sentence of their own — a line
 * that said "nothing is billed" over eighteen running schedules would be the
 * cost claim a reader acts on, and wrong.
 *
 * `runningWords` is accelPanelCopy.ts `setCostWords` over the searches this run
 * creates; read only in `running` mode.
 */
export function accelCostWords(
  mode: 'running' | 'paused',
  runningWords: string | null,
  counts: { created: number; keepRunning: number },
): string {
  const created =
    counts.created === 0
      ? 'Scheduled searches: this run creates none.'
      : mode === 'running'
        ? `Scheduled searches this run creates: ${runningWords ?? 'no scheduled search — nothing billed, nothing saved'}.`
        : 'Scheduled searches this run creates: installed paused, so they bill nothing until they are switched on in Acceleration.'
  if (counts.keepRunning === 0) return created
  const n = counts.keepRunning
  return `${created} ${n} already installed ${n === 1 ? 'keeps' : 'keep'} running and billing as ${n === 1 ? 'it does' : 'they do'} now.`
}

/** The cost line's storage half. The Parquet copy's size is not claimed. */
export const storageCostWords = (): string =>
  `Storage: every record is stored twice, in ${PACK_LAKE_DATASET_ID} (JSON) and ${PACK_PARQUET_DATASET_ID} (Parquet); the Parquet copy’s size has not been measured.`

/** The sample feed's volume, from the pack's own sample files. */
export function sampleVolumeWords(v: SampleVolume): string {
  const mb = v.bytesPerDay / 1_000_000
  return (
    `Sample data: about ${whole(v.eventsPerDay)} events a day (${whole(v.eventsPerSec)} a second), about ${whole(mb)} MB a day ` +
    `before compression, into ${PACK_SAMPLE_DATASET_ID}.`
  )
}

/** When Guided Setup's global Raw HTTP stack is already in the group. */
export const globalStackSentence = (group: string): string =>
  `The Raw HTTP stack already in ${group} is not touched and keeps listening. Point Gigamon AMX at one source — ` +
  `${PACK_HTTP_INPUT_ID} or the existing one — or every record is stored twice.`

/** When schedules are created running on a verdict that never saw data. */
export const emptyRealDatasetSentence = (): string =>
  `The scheduled searches start running now and read ${PACK_LAKE_DATASET_ID} whether or not it holds any data yet; ` +
  'until it does, they bill for scanning an empty dataset. Switch them off in Acceleration if no data is coming soon.'

/** The Lake total's schedule, when its window could not be resolved. */
export const lakeEntryNotCreatedSentence = (id: string): string =>
  `Scheduled search ${id} is not created: the dataset’s retention could not be read, so this app does not know which window it ` +
  'should read. Apply creates it in Acceleration once the retention can be read.'

/** What happens when a step fails. */
export const ONBOARDING_FAILURE_PROMISE =
  'The steps run in order, and the run stops at the first failure that later steps depend on. Nothing already done is undone; ' +
  'the step list says what was done and what was not. This app never deletes a Cribl Lake dataset.'

/** The schedules outlive the app. */
export const ONBOARDING_UNINSTALL =
  'Uninstalling this app does not remove the scheduled searches. Remove them in Acceleration first.'

export const ONBOARDING_UNDO =
  'Remove pack uninstalls the pack; its sources and the token go with it, and the datasets stay. ' +
  'Acceleration’s Remove deletes the scheduled searches.'
