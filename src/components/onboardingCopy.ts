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

// ── Upgrade ─────────────────────────────────────────────────────────────────

/** Behind the ⓘ beside Upgrade. */
export const UPGRADE_TIP =
  'Upgrades the pack in place from the GitHub release this app pins, with custom functions refused. The confirmation lists what ' +
  'the new version adds, and what it no longer ships. The pack’s Raw HTTP source is read back after the upgrade, and nothing is committed or deployed ' +
  'if its port, auth token or state was reset.'

/** The plain statement every Upgrade confirmation carries. */
export const UPGRADE_UNVERIFIED =
  'Settings made after install — the Raw HTTP source’s port, auth token, TLS and whether it is on — have not been verified to survive an ' +
  'upgrade. This app reads the source back after upgrading, and if any of them was reset it commits and deploys nothing and says so.'

/** When the installed version has no Raw HTTP source of its own (0.1.0). */
export const upgradeNewSourceSentence = (): string =>
  `${PACK_HTTP_INPUT_ID} arrives switched off and without an auth token. Finish onboarding gives it a port and a token after the upgrade.`

/**
 * The objects the new version no longer ships. NOT "removed": an in-place
 * upgrade replaces the pack's shipped settings but keeps its local ones, so an
 * object the tenant changed after install stays behind, as an orphan no route
 * of the new version reads (measured on a Leader: 0.1.0's syslog source,
 * changed before upgrading, was still there after). This app cannot tell from
 * what it reads which objects were changed, and removes none of them.
 */
export const upgradeDroppedSentence = (to: string, ids: readonly string[]): string =>
  `${to} no longer ships ${ids.join(', ')}. The upgrade takes ${ids.length === 1 ? 'it' : 'them'} out of the pack’s shipped settings, ` +
  `but ${ids.length === 1 ? 'if you changed it' : 'any of them you changed'} after install — a port, say, or switching it on — ` +
  `${ids.length === 1 ? 'it stays' : 'stays'} in the pack’s local settings, left over and unused by ${to}’s routes. This upgrade does not remove leftovers.`

/** The sources the new version no longer ships: where their senders must go. */
export const upgradeDroppedSourcesSentence = (ids: readonly string[]): string => {
  const one = ids.length === 1
  return `After the deploy, ${ids.join(', ')} ${one ? 'stops' : 'stop'} listening — unless ${one ? 'it was' : 'one was'} changed after install, ` +
    `when ${one ? 'it stays' : 'that one stays'} as a leftover whose events no route delivers. Anything sending to ${one ? 'it' : 'them'} has to be pointed at ${PACK_HTTP_INPUT_ID}.`
}

export const upgradeUndo = (group: string): string =>
  `This app does not downgrade. The version before is in ${group}’s Git history; Remove pack uninstalls the pack, and Onboard installs it again with a new auth token.`

/** The step that stops an upgrade whose read-back found a reset. Never a token. */
export const upgradeResetSentence = (group: string, what: readonly string[]): string =>
  `Nothing was committed or deployed, because the upgrade reset ${what.join(', ')} on ${PACK_HTTP_INPUT_ID}. The upgrade is in ` +
  `${group}’s configuration but uncommitted, and another admin’s commit and deploy of ${group} would push the reset to its Workers. ` +
  `Set ${what.length === 1 ? 'it' : 'them'} again in Cribl before anyone commits and deploys ${group}.`

/** The step that stops an upgrade after its PATCH, for any other reason. */
export const upgradeHeldSentence = (group: string, because: string): string =>
  `Nothing was committed or deployed, because ${because}. The upgrade is in ${group}’s configuration but uncommitted, and another ` +
  `admin’s commit and deploy of ${group} would push it as it is. Check the pack in Cribl.`

// ── The pack sources' own settings ──────────────────────────────────────────

/** Behind the ⓘ on the source controls' heading. */
export const SOURCE_SETTINGS_TIP =
  'Each change is one confirmation: this app reads the source, shows what changes, replaces the whole source with only that key ' +
  'moved, then commits the pack’s files and deploys the group. A source that changed after the confirmation opened is left alone.'

export const ROTATE_EXPORTER =
  `Gigamon AMX has to be given the new token, which is shown once after the change. Once the group is deployed, its POSTs to ${PACK_HTTP_INPUT_ID} are refused until it is.`

export const ROTATE_UNDO = 'The old token cannot be put back: this app never reads a token. Rotate again for another new one.'

/** Added to a failed rotation's step. */
/** Why a source change is refused while the pack's own version change is
 *  uncommitted — an upgrade held because it reset the source, or one nobody
 *  committed: the change's commit and deploy would carry it too. */
export const packManifestPendingSentence = (group: string, path: string): string =>
  `the pack’s own ${path.split('/').pop()} in ${group} is uncommitted — an upgrade or install nobody has committed — and this ` +
  `change would commit and deploy it too. Check the pack in Cribl, and commit and deploy ${group} there once it is right`

/** The same refusal when Git's status cannot be read, so the case above
 *  cannot be ruled out. */
export const packPendingUnknownSentence = (group: string): string =>
  `Cribl did not report what is uncommitted in ${group}, so this app cannot tell whether an uncommitted pack upgrade would be ` +
  'committed and deployed with this change'

/** Beside a rotated token whose commit or deploy failed. */
export const TOKEN_UNDEPLOYED =
  'This token is set in Cribl but not deployed: the Workers keep the old token, and refuse this one, until the group is committed and deployed.'

export const ROTATE_FAILED =
  'If Cribl applied the change anyway, the source holds a token nobody was shown, and nothing was committed or deployed. Rotate again.'

export const movePortSentence = (from: number | null, to: number): string =>
  `After the deploy, ${PACK_HTTP_INPUT_ID} listens on ${to} and no longer on ${from ?? 'its current port'}; Gigamon AMX has to send to the new port.`

export const movePortUndo = (from: number | null): string =>
  from === null ? 'Move it again the same way.' : `Move it back to port ${from} the same way.`

export const SAMPLE_STOP_KEEPS =
  `The flows already written stay in ${PACK_SAMPLE_DATASET_ID} until its retention removes them; this app never deletes a Cribl Lake dataset.`

export const SAMPLE_START_UNDO = `Stop sample data stops it again. What it wrote stays in ${PACK_SAMPLE_DATASET_ID} until its retention removes it.`
export const SAMPLE_STOP_UNDO = 'Start sample data starts it again.'

/** Why Start sample data is refused while its dataset does not exist. */
export const SAMPLE_START_REFUSAL =
  `Start sample data is not available: ${PACK_SAMPLE_DATASET_ID} does not exist yet. Onboarding with “Also send sample data” ticked creates it.`

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

// ── A removal that was never committed ──────────────────────────────────────

/** Beside the Finish control, when the pack is gone but its removal is not committed. */
export const finishRemovalNote = (group: string): string =>
  `The pack is no longer installed in ${group}, but its removal was never committed or deployed.`

/** In the Finish confirmation: which files, and why they are still uncommitted. */
export function finishRemovalSentence(group: string, files: readonly string[]): string {
  return (
    `Git reports the pack’s removal from ${group} uncommitted: ${files.join(', ')}. Until it is committed and deployed, ` +
    'the Workers keep running the pack as it was.'
  )
}

export const FINISH_REMOVAL_UNDO =
  'Onboard, on this tab, installs the pack again, with a new auth token.'

// ── The Raw HTTP stack's panel, when the pack onboards ──────────────────────

export const REMOVE_ONLY_LEAD = 'This group also has the Raw HTTP stack created outside the pack.'
export const REMOVE_ONLY_TIP =
  `Point Gigamon AMX at one source, ${PACK_HTTP_INPUT_ID} or this stack’s, or every record is stored twice. ` +
  'This panel only removes that stack: the pack panel above is how this app onboards now.'
