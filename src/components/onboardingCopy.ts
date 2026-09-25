// What the onboarding panel and its confirmations say, pure and DOM-free — the
// sentences src/cribl/onboarding/plan.ts puts into its dialogs and
// components/OnboardingPanel.tsx puts on the page. Kept here, beside
// provisionPanelCopy.ts and accelPanelCopy.ts, for the reason those exist: a
// sentence about somebody's configuration is the thing that can be wrong, and
// a pure string can be asserted directly.
//
// No internal project history in anything here: no spike ids, phase numbers,
// decision numbers or dates. plan.test.ts's copy-hygiene test holds that over
// everything the dialog built from these says, and onboardingCopy.test.ts over
// every string this module exports.

import {
  PACK_CLOUD_PORT_RANGE, PACK_HTTP_INPUT_ID, PACK_ID, PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID,
  PACK_VERSION,
} from '../cribl/pack'
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

/** When the run changes nothing in the group: no commit, no deploy. */
export const nothingToDeploySentence = (group: string): string =>
  `Nothing in ${group} changes, so nothing is committed or deployed and its Worker Processes are not restarted.`

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

// ── The panel ───────────────────────────────────────────────────────────────

/** The one line under the panel title. */
export const ONBOARDING_LEAD =
  'Installs the Gigamon AMI pack in the worker group below and lands Gigamon AMX data in Cribl Lake.'

/** The rest, behind the ⓘ at the end of the lead. */
export const ONBOARDING_LEAD_TIP =
  `The pack is ${PACK_ID}. The Leader installs it from the GitHub release this app pins, with custom functions refused. ` +
  'Onboard names every object it creates or changes, in one confirmation, before anything is written. It then creates the ' +
  'Cribl Lake datasets, installs the pack, gives its Raw HTTP source a port, a new auth token and TLS for the group, commits ' +
  'and deploys, and installs the scheduled searches that make the dashboards fast.'

/** While the Raw HTTP stack's panel holds the page's picker. */
export const groupElsewhereNote = (group: string): string => `Worker group ${group}, picked in the panel below.`

/** Beside "Worker group" when this panel holds the picker. */
export const ONBOARDING_GROUP_TIP =
  'The pack is installed, committed and deployed in this group. The Cribl Lake datasets belong to no group. Your pick is remembered, so this tab opens on it next time.'

/** Beside the port field. */
export const ONBOARDING_PORT_TIP =
  `Set once, when the pack’s Raw HTTP source is configured. A Cribl-managed group only exposes ports ${PACK_CLOUD_PORT_RANGE.min}–${PACK_CLOUD_PORT_RANGE.max} and its source uses Cribl’s TLS certificate; ` +
  'a hybrid group takes any free port and starts without TLS. Ports other sources in the group already use are refused.'

export const SAMPLE_LABEL = 'Also send sample data'

/** Behind the ⓘ beside the checkbox. */
export const SAMPLE_TIP =
  `Synthetic flows at 5 events a second, into their own dataset ${PACK_SAMPLE_DATASET_ID} and never ${PACK_LAKE_DATASET_ID}. ` +
  `The dashboards read them only while ${PACK_LAKE_DATASET_ID} is empty, and Cribl Lake cannot delete rows, so the two are kept apart. ` +
  'How soon the first sample flows appear has not been checked.'

/** Under the Onboard button. */
export const onboardNote = (group: string): string => `Creates, commits and deploys in ${group}. You review every change first.`

/** The trigger's label, by what the run would do. */
export function onboardLabel(state: { installed: boolean; httpNeedsWork: boolean }): string {
  if (!state.installed) return 'Onboard'
  return state.httpNeedsWork ? 'Finish onboarding' : 'Run onboarding again'
}

/** Why Onboard is refused, for an installed copy it may not onboard over. */
export function installedRefusal(p: { version: string | null; published: boolean; fromRelease: boolean; group: string }): string {
  const v = p.version ?? 'of an unknown version'
  if (!p.published) return `${PACK_ID} ${v} is installed in ${p.group}, and this app did not publish that version, so it will not onboard over it.`
  if (!p.fromRelease) {
    return `${PACK_ID} ${v} is installed in ${p.group}, but not from this app’s release of that version, so this app does not treat it as its own.`
  }
  return `${PACK_ID} ${v} is installed in ${p.group}, and this app installs ${PACK_VERSION}. Upgrade it before onboarding.`
}

/** The Upgrade control's reason, while upgrading is not offered here. */
export const UPGRADE_NOT_OFFERED =
  'Upgrading in place is not offered on this screen yet, because nothing here checks yet that the Raw HTTP source keeps its port, ' +
  `token and state through an upgrade. Upgrade ${PACK_ID} in Cribl, or remove it here and onboard again.`

// ── Status rows ─────────────────────────────────────────────────────────────

export const STATUS_LABELS = Object.freeze({
  pack: 'Pack',
  datasets: 'Cribl Lake datasets',
  http: 'Raw HTTP source',
  sample: 'Sample source',
  accel: 'Acceleration',
})

/** The pack row's detail. */
export function packStatusWords(p: { installed: boolean; version: string | null; current: boolean; error: string | null }): string {
  if (p.error) return `could not be read: ${p.error}`
  if (!p.installed) return 'not installed'
  if (p.current) return `${p.version} · up to date`
  return `${p.version ?? 'unknown version'} · this app installs ${PACK_VERSION}`
}

/** One dataset in the datasets row. */
export function datasetWords(id: string, d: { format: string | null; retentionPeriodInDays: number | null } | null): string {
  if (!d) return `${id} · not created`
  const days = d.retentionPeriodInDays === null ? 'retention unknown' : `${d.retentionPeriodInDays}-day retention`
  return `${id} · ${(d.format ?? 'json').toUpperCase()} · ${days}`
}

/** The Raw HTTP source's row. Never the token: only whether one is set. */
export function httpStatusWords(h: { port: number | null; tls: boolean; tokenSet: boolean; disabled: boolean } | null): string {
  if (!h) return 'not installed'
  return [
    `port ${h.port ?? 'unknown'}`,
    h.tls ? 'TLS on' : 'TLS off',
    h.tokenSet ? 'token set' : 'no token',
    h.disabled ? 'off' : 'on',
  ].join(' · ')
}

/** The acceleration row. */
export function accelStatusWords(a: { total: number; installed: number; running: number; error: string | null }): string {
  if (a.error) return 'could not be read'
  if (a.installed === 0) return 'not installed'
  if (a.running === 0) return 'installed, off'
  return `${a.running} of ${a.total} running`
}

// ── The endpoint card ───────────────────────────────────────────────────────

/** Behind the ⓘ on the card's lead. */
export const PACK_ENDPOINT_TIP =
  `Send the token as the whole header value, with no "Bearer" prefix. The records land in ${PACK_LAKE_DATASET_ID}, which the dashboards read; ` +
  `the pack also writes a Parquet copy of each one to ${PACK_PARQUET_DATASET_ID}, which they do not. Point Gigamon AMX at one source only, ` +
  'or each record is stored twice.'

/** What the card says instead of claiming data is arriving. */
export const NOT_SEEN_YET = 'Configured and deployed. This app has not yet seen a record from this source.'
export const NOT_SEEN_TIP =
  'This screen does not look for incoming records. Data Flow shows what reaches Cribl Lake.'

/** Where the token line is when it is not being shown. */
export const PACK_TOKEN_ELSEWHERE =
  'The token was shown once, when this app configured the source. It is in the source’s authentication settings in Cribl.'

/** Beside a token shown after the write that set it reported an error. */
export const TOKEN_AFTER_ERROR =
  'The change reported an error, but the source now has a token, and this is the one this app sent. Check the source in Cribl before you rely on it.'

// ── Remove pack ─────────────────────────────────────────────────────────────

export const removePackIrreversible = (group: string): string =>
  `Removing the pack deletes its sources, event breaker, pipeline, routes and destinations. They are recoverable only from ${group}’s Git history, ` +
  'and onboarding again makes a new auth token, so Gigamon AMX has to be given the new one.'

export function keptDatasetsSentence(ids: readonly string[]): string {
  return (
    `Kept: the Cribl Lake datasets ${ids.join(', ')}. This app never deletes a Lake dataset: ${PACK_LAKE_DATASET_ID} holds your data, and Lake keeps ` +
    `no history to restore one from. Delete ${PACK_SAMPLE_DATASET_ID} in Cribl Lake if you want the sample flows gone.`
  )
}

export const keptSchedulesSentence = (): string =>
  'Kept: the scheduled searches, which keep running and billing. Remove them in Acceleration.'

export const keptGlobalStackSentence = (group: string): string =>
  `Any Raw HTTP stack created outside the pack in ${group} is not touched.`

export const REMOVE_PACK_UNDO =
  'Onboard, on this tab, installs the pack again, with a new auth token. The datasets and the data in them stay where they are.'

/** Type-to-confirm's label. */
export const removeTypeLabel = (group: string): string => `To confirm, type the worker group name ${group}`

// ── The Raw HTTP stack's panel, when the pack onboards ──────────────────────

export const REMOVE_ONLY_LEAD = 'This group also has the Raw HTTP stack created outside the pack.'
export const REMOVE_ONLY_TIP =
  `Point Gigamon AMX at one source, ${PACK_HTTP_INPUT_ID} or this stack’s, or every record is stored twice. ` +
  'This panel only removes that stack: the pack panel above is how this app onboards now.'
