// The onboarding run, as data: which steps it takes and in what order, what its
// one confirmation says, and the handful of derivations both need. PURE — no
// network call, no clock, no DOM, no KV — so the dialog and the run are built
// from one plan and cannot describe two different sets of writes.
//
// ── WHERE THIS SITS ─────────────────────────────────────────────────────────
// Guided Setup's pack flow (design 2026-09-24, owner answers applied): one
// Onboard press reads the workspace, shows ONE <ConfirmDialog>, and then runs
// the steps below strictly in order. This module is the plan; the run is
// ./run.ts and the screen is components/OnboardingPanel.tsx, which builds the
// dialog from `onboardingDialog` and hands the run what that dialog showed.
// Nothing here can write.
//
// ── WHAT IT MAY IMPORT ──────────────────────────────────────────────────────
// Nothing that reaches the network. It stays PURE so the dialog is a function
// of what was read, and can be asserted without a Leader; in particular it
// does not import packClient.ts, whose reads and writes are the run's. What the
// plan needs from the pack — its ids, its objects, whether its release may be
// installed — is in pack.ts, which is pure. The words come from the pure copy
// modules in src/components/, the same sentences the other Guided Setup
// dialogs say, so one fact is said one way.
//
// ── OWNER ANSWERS THIS FOLLOWS (2026-09-24) ─────────────────────────────────
//   * No "Accelerate dashboards" box: onboarding always installs acceleration,
//     PAUSED while only sample data exists (`accelMode`), and the Lake schedule
//     is never created on an unresolved window (accel/provision.ts guards that
//     for every caller).
//   * gigamon_ami_sample keeps 30 days.
//   * gigamon_ami_pq keeps what gigamon_ami keeps if that dataset exists, else
//     30 days; Parquet, automatic schema, no partition fields.

import type { ConfirmResource, DiffEntry } from '../../components/ConfirmDialog'
import { applyResources, setCostWords } from '../../components/accelPanelCopy'
import { printValue } from '../../components/lakeLandingCopy'
import {
  HTTP_RESTART_PRECAUTION, carriesSentence, pendingSentence, undeployedSentence,
} from '../../components/provisionPanelCopy'
import {
  ONBOARDING_FAILURE_PROMISE, ONBOARDING_UNDO, ONBOARDING_UNINSTALL, REMOVE_PACK_UNDO, accelCostWords, emptyRealDatasetSentence,
  globalStackSentence, keptDatasetsSentence, keptSchedulesSentence, keptGlobalStackSentence, lakeEntryNotCreatedSentence,
  FINISH_REMOVAL_UNDO, finishRemovalSentence, nothingToDeploySentence, removePackIrreversible, sampleVolumeWords, storageCostWords,
  ROTATE_EXPORTER, ROTATE_UNDO, SAMPLE_START_UNDO, SAMPLE_STOP_KEEPS, SAMPLE_STOP_UNDO, UPGRADE_UNVERIFIED, movePortSentence, movePortUndo,
  upgradeDroppedSentence, upgradeDroppedSourcesSentence, upgradeNewSourceSentence, upgradeUndo,
} from '../../components/onboardingCopy'
import { approvedWrites, type AccelState, type ApprovedWrites } from '../accel/provision'
import { estimateScheduleSetCost } from '../accel/estimate'
import type { AccelId } from '../accel/manifest'
import { realDataConfirmed, type DatasetTarget } from '../datasetTarget'
import { DEFAULT_PROFILE, DEPLOY_CONSEQUENCES, datasetSpec, type DiffRow } from '../landing'
import {
  PACK_0_1_0, PACK_HTTP_INPUT_ID, PACK_HTTP_PLACEHOLDER_PORT, PACK_ID, PACK_LAKE_DATASET_ID, PACK_OBJECTS,
  PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID, type PackObjectKind, type PackRelease,
} from '../pack'
import { DATASET_SPEC, PARQUET_DATASET_SPEC, sameValue, tlsFor, type CommitScope, type LakeDatasetSpec } from '../provision'

// ── Datasets ────────────────────────────────────────────────────────────────

/** Retention for a dataset this run creates when nothing else decides it. */
export const ONBOARDING_RETENTION_DAYS = 30

/**
 * gigamon_ami_pq's create body: provision.ts's `PARQUET_DATASET_SPEC` (Parquet,
 * no partitions — the key is absent, not `[]`), with the retention of the live
 * gigamon_ami when it could be read, else 30 days. A Parquet copy that ages
 * out on a different day from the JSON it copies would make the two disagree
 * about what exists.
 */
export function parquetDatasetSpec(jsonRetentionDays: number | null): LakeDatasetSpec {
  const days = jsonRetentionDays !== null && Number.isInteger(jsonRetentionDays) && jsonRetentionDays > 0
    ? jsonRetentionDays
    : ONBOARDING_RETENTION_DAYS
  return Object.freeze({ ...PARQUET_DATASET_SPEC, retentionPeriodInDays: days })
}

/**
 * gigamon_ami_sample's create body: gigamon_ami's own JSON body under its own
 * id, 30 days, described as synthetic so nobody reading Cribl Lake mistakes it
 * for traffic. Its own dataset because Lake has no row delete: a generated
 * flow written into gigamon_ami could not be taken back out.
 */
export const SAMPLE_DATASET_SPEC = Object.freeze({
  ...(datasetSpec({ ...DEFAULT_PROFILE, datasetId: PACK_SAMPLE_DATASET_ID, retentionDays: ONBOARDING_RETENTION_DAYS, partitions: [] }) as LakeDatasetSpec),
  description: 'Synthetic Gigamon AMI sample flows (generated, not real traffic)',
})

/**
 * The retention gigamon_ami_pq copies: gigamon_ami's live retention when that
 * dataset is listed, and `DATASET_SPEC`'s when it is not — then this same run
 * creates gigamon_ami at that retention, so the two still match. A figure
 * passed for a dataset that is not listed is not used. Null only when
 * gigamon_ami is there and its retention could not be read.
 */
export function jsonRetentionFor(datasets: readonly string[], jsonRetentionDays: number | null): number | null {
  return datasets.includes(PACK_LAKE_DATASET_ID) ? jsonRetentionDays : (DATASET_SPEC.retentionPeriodInDays as number)
}

/**
 * The datasets the run ensures, in run order: the customer's, its Parquet
 * copy, and the sample's only when ticked. `jsonRetentionDays` is
 * `jsonRetentionFor(…)`, as the dialog computes it.
 *
 * gigamon_ami IS `DATASET_SPEC`, DELIBERATELY — the body Guided Setup's
 * dataset step has always created, and not a saved Lake landing profile.
 * That step builds `datasetSpec(ctx.profile)`, but `ctx.profile` is
 * `opts.profile ?? DEFAULT_PROFILE` and no caller passes one, so both
 * creators create the same body (JSON, 30 days, no partitions — the design's
 * "JSON, 30 days"). The profile is not used here because it can name a format
 * and partitions, which are fixed at creation, and the dashboards read JSON.
 * plan.test.ts fails if a caller of `deployAll` starts passing a profile, so
 * the two cannot drift apart silently.
 */
export function onboardingDatasets(opts: { sample: boolean; jsonRetentionDays: number | null }): LakeDatasetSpec[] {
  return [
    DATASET_SPEC as LakeDatasetSpec,
    parquetDatasetSpec(opts.jsonRetentionDays),
    ...(opts.sample ? [SAMPLE_DATASET_SPEC] : []),
  ]
}

// ── The sample feed's volume ────────────────────────────────────────────────

/** One DataGen sample: its rate (inputs.yml) and its file (samples.yml). */
export interface SampleFeedEntry {
  sample: string
  eventsPerSec: number
  /** Bytes of the sample file. */
  size: number
  /** Events in the sample file. */
  numEvents: number
}

/**
 * The pack's sample DataGen as it ships: each sample's rate from
 * default/inputs.yml and its size and event count from default/samples.yml.
 * plan.test.ts parses both files and fails if this differs, so the volume a
 * dialog states is the volume the pack produces.
 */
export const SAMPLE_FEED: readonly SampleFeedEntry[] = Object.freeze([
  { sample: 'gigamon_ami_services', eventsPerSec: 1, size: 85476, numEvents: 126 },
  { sample: 'gigamon_ami_web_api', eventsPerSec: 1, size: 96321, numEvents: 120 },
  { sample: 'gigamon_ami_dns', eventsPerSec: 1, size: 53294, numEvents: 97 },
  { sample: 'gigamon_ami_tls_apps', eventsPerSec: 1, size: 112043, numEvents: 142 },
  { sample: 'gigamon_ami_security', eventsPerSec: 1, size: 36224, numEvents: 88 },
].map((e) => Object.freeze(e)))

export interface SampleVolume {
  eventsPerSec: number
  eventsPerDay: number
  /** The sample files' own bytes, replayed at their rates: before the
   *  pipeline adds fields, and before Lake compresses anything. */
  bytesPerDay: number
}

/** What the sample feed writes a day, from its files alone. */
export function sampleVolume(feed: readonly SampleFeedEntry[] = SAMPLE_FEED): SampleVolume {
  const eventsPerSec = feed.reduce((n, e) => n + e.eventsPerSec, 0)
  const bytesPerSec = feed.reduce((n, e) => n + e.eventsPerSec * (e.size / e.numEvents), 0)
  return { eventsPerSec, eventsPerDay: eventsPerSec * 86_400, bytesPerDay: Math.round(bytesPerSec * 86_400) }
}

// ── The Raw HTTP source's before→after on a fresh install ───────────────────

/**
 * The fields of the pack's Raw HTTP source that the configure PATCH changes,
 * as default/inputs.yml ships them (plan.test.ts holds the two equal). No
 * token: the pack ships none.
 */
export const SHIPPED_HTTP_INPUT = Object.freeze({
  disabled: true,
  port: PACK_HTTP_PLACEHOLDER_PORT,
  tls: Object.freeze(tlsFor(true)),
})

/**
 * What the configure PATCH will change on a FRESHLY INSTALLED Raw HTTP source,
 * computed from the shipped file rather than read — there is nothing to read
 * before the pack is installed. Key-sorted, like packClient.ts's own diff, and
 * plan.test.ts holds it equal to what `previewPackInput` reads off a source
 * built from inputs.yml. The token is never a value: "a new token (not
 * shown)".
 */
export function expectedConfigureDiff(hosting: 'managed' | 'hybrid', port: number): DiffRow[] {
  const rows: DiffRow[] = [
    { key: 'authTokensExt', kind: 'added', before: undefined, after: 'a new token (not shown)' },
    { key: 'disabled', kind: 'changed', before: true, after: false },
  ]
  if (port !== SHIPPED_HTTP_INPUT.port) rows.push({ key: 'port', kind: 'changed', before: SHIPPED_HTTP_INPUT.port, after: port })
  // A hybrid group has no `$CRIBL_CLOUD_CRT`; the shipped block would never
  // start there, so TLS is turned off (and the endpoint card says so).
  if (hosting === 'hybrid') rows.push({ key: 'tls', kind: 'changed', before: { ...SHIPPED_HTTP_INPUT.tls }, after: tlsFor(false) })
  return rows
}

/**
 * Whether two diffs make the same WRITES: the same keys, each set to the same
 * value. Where each key started is left out, on purpose, and only for one use:
 * a fresh install's dialog shows `expectedConfigureDiff`, predicted from the
 * shipped `inputs.yml`, and the source it is compared with afterwards is the
 * Leader's installed copy of that file. A Leader that spells "nothing there"
 * its own way (an empty token list, no `disabled` key) moves a `before` and
 * nothing the run sends; one that installed another value for a key the run
 * would not otherwise set (a port, a TLS block) adds or drops a row, and is
 * refused. Everywhere else a source's diff is held exactly (landing.ts
 * `sameDiff`).
 */
export function sameWrites(a: readonly DiffRow[], b: readonly DiffRow[]): boolean {
  if (a.length !== b.length) return false
  const byKey = new Map(b.map((r) => [r.key, r]))
  return a.every((r) => {
    const other = byKey.get(r.key)
    return other !== undefined && sameValue(r.after, other.after)
  })
}

/** Starting the sample DataGen, as its diff: the one key it changes. */
export const SAMPLE_START_DIFF: readonly DiffRow[] = Object.freeze([
  Object.freeze({ key: 'disabled', kind: 'changed' as const, before: true, after: false }),
])

/** A source's raw diff as the dialog's table rows: each value printed the way
 *  the Lake landing dialog prints one, under the source it belongs to. */
const printed = (resourceId: string, rows: readonly DiffRow[]): DiffEntry[] =>
  rows.map((r) => ({ resourceId, key: r.key, before: printValue(r.before), after: printValue(r.after) }))

// ── What the run does to the Raw HTTP source ────────────────────────────────

/**
 * What step 3 does to the pack's Raw HTTP source:
 *   * `configure` — ONE whole-body PATCH: port, a NEW token, TLS for the
 *     group's hosting, and started. A fresh install, and any source with no
 *     token (it would accept a POST from anyone who can reach the port).
 *   * `enable` — it has a token and is only stopped: started, and nothing
 *     else. No rotation: the token an exporter may already hold keeps working.
 *   * `none` — it has a token and is running. Nothing is sent.
 */
export type HttpAction = 'configure' | 'enable' | 'none'

/** Step 3's action, from what `readPackState` says of the source — null when
 *  the pack is not installed, which is a fresh install: `configure`. */
export function httpActionOf(http: { tokenSet: boolean; disabled: boolean } | null): HttpAction {
  if (http === null || !http.tokenSet) return 'configure'
  return http.disabled ? 'enable' : 'none'
}

// ── Acceleration's mode ─────────────────────────────────────────────────────

export type AccelMode = 'running' | 'paused'

/**
 * Whether the run creates the scheduled searches running or paused.
 *
 * RUNNING ONLY ON EVIDENCE THAT gigamon_ami HOLDS DATA WORTH SCANNING.
 *   * A verdict that is not final (`realDataConfirmed` false: still reading,
 *     past the hold's deadline, or on the sample) → paused. This is stricter
 *     than "running otherwise": the Acceleration panel refuses to turn a
 *     schedule on on the same verdicts, and a run must not do what the panel
 *     would refuse.
 *   * Sample data ticked → paused unless gigamon_ami's data was actually SEEN
 *     (`has-data`, `probe-found`). `no-sample` only says no sample dataset
 *     exists yet, which this run is about to change.
 * Everything else — sample unticked on a final real verdict — runs, and the
 * dialog says the schedules may scan an empty dataset (`no-sample` and the
 * other verdicts that saw no data).
 */
export function accelMode(sampleTicked: boolean, target: DatasetTarget): AccelMode {
  if (!realDataConfirmed(target)) return 'paused'
  if (sampleTicked && target.reason !== 'has-data' && target.reason !== 'probe-found') return 'paused'
  return 'running'
}

/** Whether the verdict SAW data in gigamon_ami, rather than only finding no
 *  reason to read the sample. */
export const realDataSeen = (target: DatasetTarget): boolean =>
  target.known && (target.reason === 'has-data' || target.reason === 'probe-found')

// ── Which onboarding the page offers ────────────────────────────────────────

/** Whether the group holds Guided Setup's global objects: the Raw HTTP stack,
 *  or the Syslog stack an earlier release created. */
export interface GlobalStackPresence {
  http: boolean
  legacySyslog: boolean
}

export type OnboardingPath =
  /** The pack cannot be installed: the global Raw HTTP stack is THE onboarding,
   *  exactly as it is today. */
  | { mode: 'global'; provision: 'full'; why: string }
  /** The pack can be installed. The global stack's panel shows only while a
   *  global object is present (or could not be read), and then offers Remove
   *  only. */
  | { mode: 'pack'; provision: 'remove-only' | 'hidden' }

/**
 * Which onboarding path the page offers. The pack is offered only when its
 * release may be installed (`packRelease().installable`: published, with a
 * recorded sha256). A presence nobody could read is treated as present, so a
 * stack that exists is never hidden by a failed read.
 */
export function onboardingPath(release: PackRelease, presence: GlobalStackPresence | null): OnboardingPath {
  if (!release.installable) return { mode: 'global', provision: 'full', why: release.refusal ?? '' }
  if (presence === null || presence.http || presence.legacySyslog) return { mode: 'pack', provision: 'remove-only' }
  return { mode: 'pack', provision: 'hidden' }
}

// ── The steps ───────────────────────────────────────────────────────────────

export type OnboardingStepKey =
  | 'dataset_json' | 'dataset_parquet' | 'dataset_sample'
  | 'pack' | 'http_input' | 'sample_input' | 'commit_deploy' | 'acceleration' | 'recheck'

export interface OnboardingStep {
  key: OnboardingStepKey
  /** What it does, in a few words, for the step log. */
  what: string
  /** Whether a failure here stops the steps after it (they depend on it) or
   *  the run goes on and reports it. */
  onFailure: 'stop' | 'continue'
}

export interface StepContext {
  sample: boolean
  /** Whether the pack is already installed and current in the group. An older
   *  copy is not onboarded over: Upgrade is offered instead. */
  packInstalled: boolean
  /** Whether the run commits and deploys the group (`OnboardingDialog.deploys`).
   *  Absent is true. */
  deploys?: boolean
}

/** The run's steps, in the order they run. The run is strictly sequential. */
export function onboardingSteps(ctx: StepContext): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    { key: 'dataset_json', what: `Create ${PACK_LAKE_DATASET_ID} if absent`, onFailure: 'stop' },
    { key: 'dataset_parquet', what: `Create ${PACK_PARQUET_DATASET_ID} if absent`, onFailure: 'continue' },
  ]
  if (ctx.sample) steps.push({ key: 'dataset_sample', what: `Create ${PACK_SAMPLE_DATASET_ID} if absent`, onFailure: 'continue' })
  if (!ctx.packInstalled) steps.push({ key: 'pack', what: `Install ${PACK_ID}`, onFailure: 'stop' })
  steps.push({ key: 'http_input', what: `Configure and start ${PACK_HTTP_INPUT_ID}`, onFailure: 'stop' })
  if (ctx.sample) steps.push({ key: 'sample_input', what: `Start ${PACK_SAMPLE_INPUT_ID}`, onFailure: 'continue' })
  if (ctx.deploys !== false) steps.push({ key: 'commit_deploy', what: 'Commit and deploy', onFailure: 'stop' })
  steps.push(
    { key: 'acceleration', what: 'Create the scheduled searches', onFailure: 'continue' },
    { key: 'recheck', what: 'Read everything back', onFailure: 'continue' },
  )
  return steps
}

// ── The one confirmation ────────────────────────────────────────────────────

/** Everything the dialog is built from — all of it read before it opens. */
export interface OnboardingDialogContext {
  group: string
  hosting: 'managed' | 'hybrid'
  port: number
  /** "Also send sample data". */
  sample: boolean
  release: PackRelease
  /** Whether the pack is installed and current in the group. */
  packInstalled: boolean
  /** What step 3 does to the Raw HTTP source (`httpActionOf`). Absent is
   *  `configure`, which is what a fresh install always does. */
  httpAction?: HttpAction
  /** Ids Cribl Lake lists, from `listDatasets()`. */
  datasets: readonly string[]
  /** gigamon_ami's live retention, or null when it could not be read. */
  jsonRetentionDays: number | null
  /** With the pack installed: `previewPackInput`'s real diffs. Null on a
   *  fresh install, where the shipped file decides them. */
  liveHttpDiff: readonly DiffRow[] | null
  liveSampleDiff: readonly DiffRow[] | null
  accel: AccelState
  target: DatasetTarget
  /** What the commit carries (`packCommitScope`), and the group's undeployed
   *  HEAD as the dialog opened. */
  scope: CommitScope | null
  undeployed: string | null
  undeployedChecking?: boolean
  /** Guided Setup's global Raw HTTP (or legacy Syslog) stack is in the group. */
  globalStackPresent: boolean
}

export interface OnboardingDialog {
  title: string
  resources: ConfirmResource[]
  diff: DiffEntry[]
  costLine: string
  consequences: string[]
  undo: string
  steps: OnboardingStep[]
  /**
   * Whether the run commits and deploys the group. False only when it changes
   * nothing there (no install, no source to write) and none of the pack's own
   * files are already uncommitted: the dialog then names no deploy and says
   * nothing is committed, and the run skips the step rather than deploying a
   * group it did not change.
   */
  deploys: boolean
  accelMode: AccelMode
  /** The saved-search writes the dialog named — passed back to the run. */
  approvedAccel: ApprovedWrites
  /** The source diffs the dialog showed — passed back as `approved`. */
  approvedHttp: readonly DiffRow[]
  approvedSample: readonly DiffRow[] | null
}

const OBJECT_KIND: Record<PackObjectKind, string> = {
  inputs: 'Source',
  breakers: 'Event breaker ruleset',
  pipelines: 'Pipeline',
  routes: 'Route',
  outputs: 'Cribl Lake destination',
}

const LAKE = 'Cribl Lake dataset'

/**
 * Whether a schedule already in the workspace is running, and stays running
 * through this run: `enabled`, or `differs` with a flag that is not `false` —
 * applyAcceleration re-reads a drifted one and PATCHes it with its stored
 * flag, `true` when none is readable. A `foreign` one is somebody else's, and
 * not this app's to count.
 */
const keepsRunning = (row: AccelState['rows'][number] | undefined): boolean =>
  row !== undefined && (row.state === 'enabled' || (row.state === 'differs' && row.enabled !== false))

/**
 * The one confirmation before an onboarding run: every object in run order,
 * the before→after of both sources, the cost in words and every consequence.
 * The run is handed `approvedHttp`, `approvedSample` and `approvedAccel` from
 * this, so what it writes is what was shown.
 */
export function onboardingDialog(ctx: OnboardingDialogContext): OnboardingDialog {
  const { group } = ctx
  const has = (id: string) => ctx.datasets.includes(id)
  const resources: ConfirmResource[] = []

  // 1–3. The datasets, created when absent and never edited.
  const jsonAbsent = !has(PACK_LAKE_DATASET_ID)
  if (jsonAbsent) {
    resources.push({ action: 'create', kind: LAKE, id: PACK_LAKE_DATASET_ID, detail: `JSON · ${String(DATASET_SPEC.retentionPeriodInDays)}-day retention · never edited or deleted by this app` })
  }
  if (!has(PACK_PARQUET_DATASET_ID)) {
    const jsonDays = jsonRetentionFor(ctx.datasets, ctx.jsonRetentionDays)
    const pq = parquetDatasetSpec(jsonDays)
    const why = jsonAbsent
      ? `the same as ${PACK_LAKE_DATASET_ID}, created by this run`
      : jsonDays === null
        ? `the default, because ${PACK_LAKE_DATASET_ID}’s could not be read`
        : `the same as ${PACK_LAKE_DATASET_ID}`
    resources.push({
      action: 'create', kind: LAKE, id: PACK_PARQUET_DATASET_ID,
      detail: `Parquet · automatic schema · no partitions · ${String(pq.retentionPeriodInDays)}-day retention, ${why} · format and partitions are fixed at creation`,
    })
  }
  if (ctx.sample && !has(PACK_SAMPLE_DATASET_ID)) {
    resources.push({ action: 'create', kind: LAKE, id: PACK_SAMPLE_DATASET_ID, detail: `JSON · ${ONBOARDING_RETENTION_DAYS}-day retention · synthetic flows only` })
  }

  // 4. The pack and every object in it.
  if (!ctx.packInstalled) {
    resources.push({
      action: 'create', kind: 'Pack', id: PACK_ID, group,
      detail: `${ctx.release.version} from ${ctx.release.url}, with custom functions refused`,
    })
    for (const kind of Object.keys(PACK_OBJECTS) as PackObjectKind[]) {
      for (const id of PACK_OBJECTS[kind]) resources.push({ action: 'create', kind: OBJECT_KIND[kind], id, group, detail: `in pack ${PACK_ID}` })
    }
  }

  // 5–6. The two sources, each replaced whole — the Raw HTTP one only when
  // step 3 will write it at all (`httpActionOf`).
  const httpAction: HttpAction = ctx.httpAction ?? 'configure'
  const httpDiff: readonly DiffRow[] = httpAction === 'none'
    ? []
    : ctx.liveHttpDiff ?? (httpAction === 'configure' ? expectedConfigureDiff(ctx.hosting, ctx.port) : [])
  if (httpAction !== 'none') {
    resources.push({
      action: 'replace', kind: 'Raw HTTP source', id: PACK_HTTP_INPUT_ID, group,
      detail: httpAction === 'configure'
        ? `a new auth token, port ${ctx.port}, TLS for a ${ctx.hosting === 'managed' ? 'Cribl-managed' : 'hybrid'} group, and started`
        : 'started, keeping its auth token, port and TLS as they are',
    })
  }
  // The sample source is named only when there is something to change on it:
  // one already running reads back an empty diff, and the run writes nothing.
  let sampleDiff: readonly DiffRow[] = []
  if (ctx.sample) {
    sampleDiff = ctx.liveSampleDiff ?? SAMPLE_START_DIFF
    if (sampleDiff.length > 0) {
      resources.push({ action: 'replace', kind: 'Source', id: PACK_SAMPLE_INPUT_ID, group, detail: `started, writing only to ${PACK_SAMPLE_DATASET_ID}` })
    }
  }

  // 7. The deploy, only when the run changes the group or commits the pack's
  // own files somebody left uncommitted (the commit's scope says which). A Git
  // status nobody could read is not "nothing pending", so that one deploys.
  const groupWrites = !ctx.packInstalled || httpAction !== 'none' || sampleDiff.length > 0
  const deploys = groupWrites || ctx.scope === null || ctx.scope.unknown || ctx.scope.alreadyDirty.length > 0
  if (deploys) resources.push({ action: 'deploy', kind: 'Worker group', id: group, detail: 'restarts its Worker Processes' })

  // 8. The scheduled searches. A CREATE is marked with the mode it is created
  // in; a correction (`replace`) keeps the pause state Cribl holds for it
  // (applyAcceleration's `differs` branch), so it is marked with THAT — a
  // running schedule corrected during a paused-mode run goes on running.
  const mode = accelMode(ctx.sample, ctx.target)
  const approvedAccel = approvedWrites(ctx.accel)
  const byId = new Map(ctx.accel.rows.map((r) => [r.id as string, r]))
  for (const r of applyResources(ctx.accel)) {
    const state = r.action === 'create'
      ? (mode === 'running' ? 'running' : 'installed paused')
      : (keepsRunning(byId.get(r.id)) ? 'running' : 'paused')
    resources.push({ ...r, detail: `${state} · ${r.detail ?? ''}`.replace(/ · $/, '') })
  }
  const lakeUnresolved = ctx.accel.rows.filter((r) => r.windowUnresolved && (r.state === 'absent' || r.state === 'differs')).map((r) => r.id)

  const created = Object.entries(approvedAccel).filter(([, s]) => s === 'absent').map(([id]) => id as AccelId)
  const keepRunning = ctx.accel.rows.filter(keepsRunning).length
  const costLine = [
    accelCostWords(mode, mode === 'running' ? setCostWords(estimateScheduleSetCost(created)) : null, { created: created.length, keepRunning }),
    storageCostWords(),
    ...(ctx.sample ? [sampleVolumeWords(sampleVolume())] : []),
  ].join(' ')

  const commitCtx = { group, scope: ctx.scope, undeployed: ctx.undeployed, undeployedChecking: ctx.undeployedChecking }
  const undeployedLine = undeployedSentence(commitCtx)
  const consequences = [
    ...(deploys
      ? [
          carriesSentence(commitCtx, 'change'),
          pendingSentence(commitCtx),
          ...(undeployedLine ? [undeployedLine] : []),
          ...DEPLOY_CONSEQUENCES,
          HTTP_RESTART_PRECAUTION,
        ]
      : [nothingToDeploySentence(group)]),
    ...(ctx.globalStackPresent ? [globalStackSentence(group)] : []),
    ...(mode === 'running' && !realDataSeen(ctx.target) ? [emptyRealDatasetSentence()] : []),
    ...lakeUnresolved.map((id) => lakeEntryNotCreatedSentence(id)),
    ONBOARDING_FAILURE_PROMISE,
    ONBOARDING_UNINSTALL,
  ]

  return {
    title: `Onboard Gigamon AMI in ${group}`,
    resources,
    diff: [...printed(PACK_HTTP_INPUT_ID, httpDiff), ...printed(PACK_SAMPLE_INPUT_ID, sampleDiff)],
    costLine,
    consequences,
    undo: ONBOARDING_UNDO,
    steps: onboardingSteps({ sample: ctx.sample, packInstalled: ctx.packInstalled, deploys }),
    deploys,
    accelMode: mode,
    approvedAccel,
    approvedHttp: [...httpDiff],
    approvedSample: ctx.sample ? [...sampleDiff] : null,
  }
}

// ── Remove pack ─────────────────────────────────────────────────────────────

/**
 * The objects an installed copy of this pack holds, by the version it reports.
 * 0.1.0 is the published record (`PACK_0_1_0`), never the current ids: several
 * kept their names while their values moved. Any other version is named by
 * this build's own list, which is what a copy of `PACK_VERSION` holds.
 */
export function packObjectsOf(version: string | null): Readonly<Record<PackObjectKind, readonly string[]>> {
  if (version === PACK_0_1_0.version) {
    return {
      inputs: Object.values(PACK_0_1_0.inputs),
      breakers: [],
      pipelines: Object.values(PACK_0_1_0.pipelines),
      routes: Object.values(PACK_0_1_0.routes),
      outputs: Object.values(PACK_0_1_0.outputs),
    }
  }
  return PACK_OBJECTS
}

/** Everything the Remove confirmation is built from — read before it opens. */
export interface RemovalDialogContext {
  group: string
  /** The installed copy's version, as the pack list reports it. */
  version: string | null
  scope: CommitScope | null
  undeployed: string | null
  undeployedChecking?: boolean
}

export interface RemovalDialog {
  title: string
  resources: ConfirmResource[]
  irreversible: { why: string }
  consequences: string[]
  undo: string
  /** The Lake datasets the removal keeps, by name — all three, always. */
  kept: readonly string[]
}

/**
 * The Remove pack confirmation: a delete row for the pack and one per object
 * in it, then the deploy; what it keeps, by name; and the sentence that makes
 * it irreversible. It deletes NO Lake dataset — the app holds no Lake DELETE
 * grant, and that stays true — so the three are named as kept, with the one
 * thing to do about the sample's.
 */
export function packRemovalDialog(ctx: RemovalDialogContext): RemovalDialog {
  const { group } = ctx
  const objects = packObjectsOf(ctx.version)
  const resources: ConfirmResource[] = [
    { action: 'delete', kind: 'Pack', id: PACK_ID, group, detail: `${ctx.version ?? 'unknown version'}, and everything in it` },
  ]
  for (const kind of Object.keys(objects) as PackObjectKind[]) {
    for (const id of objects[kind]) resources.push({ action: 'delete', kind: OBJECT_KIND[kind], id, group, detail: `in pack ${PACK_ID}` })
  }
  resources.push({ action: 'deploy', kind: 'Worker group', id: group, detail: 'restarts its Worker Processes' })
  const kept = [PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID]
  const commitCtx = { group, scope: ctx.scope, undeployed: ctx.undeployed, undeployedChecking: ctx.undeployedChecking }
  const undeployedLine = undeployedSentence(commitCtx)
  return {
    title: `Remove the Gigamon AMI pack from ${group}`,
    resources,
    irreversible: { why: removePackIrreversible(group) },
    consequences: [
      keptDatasetsSentence(kept),
      keptSchedulesSentence(),
      keptGlobalStackSentence(group),
      carriesSentence(commitCtx, 'removal'),
      pendingSentence(commitCtx),
      ...(undeployedLine ? [undeployedLine] : []),
      ...DEPLOY_CONSEQUENCES,
    ],
    undo: REMOVE_PACK_UNDO,
    kept,
  }
}

/** Everything the Finish-removal confirmation is built from. */
export interface FinishRemovalContext {
  group: string
  /** The pack's files Git reports uncommitted in the group (`CommitScope.alreadyDirty`). */
  files: readonly string[]
  scope: CommitScope | null
  undeployed: string | null
  undeployedChecking?: boolean
}

export interface FinishRemovalDialog {
  title: string
  resources: ConfirmResource[]
  consequences: string[]
  undo: string
}

/**
 * The confirmation for a Remove whose DELETE landed and whose commit did not:
 * the pack is gone from the group, its removal is in no commit, and the Workers
 * still run it. Nothing is deleted here — the deletion already happened — so it
 * names the commit's files and the deploy, and needs no type-to-confirm.
 */
export function finishRemovalDialog(ctx: FinishRemovalContext): FinishRemovalDialog {
  const { group } = ctx
  const commitCtx = { group, scope: ctx.scope, undeployed: ctx.undeployed, undeployedChecking: ctx.undeployedChecking }
  const undeployedLine = undeployedSentence(commitCtx)
  return {
    title: `Commit and deploy the pack’s removal from ${group}`,
    resources: [{ action: 'deploy', kind: 'Worker group', id: group, detail: 'restarts its Worker Processes' }],
    consequences: [
      finishRemovalSentence(group, ctx.files),
      carriesSentence(commitCtx, 'removal'),
      pendingSentence(commitCtx),
      ...(undeployedLine ? [undeployedLine] : []),
      ...DEPLOY_CONSEQUENCES,
    ],
    undo: FINISH_REMOVAL_UNDO,
  }
}

// ── Upgrade ─────────────────────────────────────────────────────────────────

/** One object of the pack, by the kind of list it is in. */
export interface PackObjectRef {
  kind: PackObjectKind
  id: string
}

/**
 * What an in-place upgrade from `from` to this build's version does to the
 * pack's objects, by id: the ones only the new version has (added), the ones
 * both carry (the new version's shipped copy, under any settings the tenant
 * changed after install, which the upgrade keeps — measured 2026-09-25), and the ones only the
 * installed version has (dropped). The installed version's ids come from
 * `packObjectsOf` — 0.1.0's from its published record, never the current ids.
 *
 * DROPPED, NOT REMOVED. The upgrade takes a dropped object out of the pack's
 * shipped (`default/`) settings but keeps the pack's `local/` ones, so one the
 * tenant changed after install survives as an orphan (measured 2026-09-25 on a
 * Leader, 0.1.0 → 0.2.0: 0.1.0's `in_gno_syslog`, overridden, stayed behind as
 * a disabled input). Which objects carry an override is not in anything this
 * app reads before the upgrade, so the dialog claims no removal, and nothing
 * here deletes the leftovers. *(Corrected 2026-09-25, `feat/pack-flip-021`:
 * this was `removed`, and the dialog listed each one as a delete.)*
 */
export function upgradeObjectChanges(from: string | null): { added: PackObjectRef[]; dropped: PackObjectRef[]; kept: PackObjectRef[] } {
  const before = packObjectsOf(from)
  const added: PackObjectRef[] = []
  const dropped: PackObjectRef[] = []
  const kept: PackObjectRef[] = []
  for (const kind of Object.keys(PACK_OBJECTS) as PackObjectKind[]) {
    const was = new Set(before[kind])
    const now = new Set<string>(PACK_OBJECTS[kind])
    for (const id of before[kind]) (now.has(id) ? kept : dropped).push({ kind, id })
    for (const id of PACK_OBJECTS[kind]) if (!was.has(id)) added.push({ kind, id })
  }
  return { added, dropped, kept }
}

/** What the upgrade's read-back compares: the Raw HTTP source (never its
 *  token, only whether one is set) and whether the sample runs — the sample
 *  by the id the version read has for it (packClient.ts `installedSample`:
 *  0.1.0's `in_gno_sample` before an upgrade from 0.1.0, this build's after). */
export interface SourceSnapshot {
  http: { port: number | null; tokenSet: boolean; disabled: boolean; tls: boolean; tlsCert: string | null } | null
  sample: { id: string; disabled: boolean } | null
}

/**
 * What an upgrade did to what was set after install. `reset` stops the run
 * before any commit or deploy: the Raw HTTP source lost its token, its port,
 * its on state or its TLS, or is gone. TLS is stricter than the design's list
 * (token, port, on state) on purpose: a TLS block put back to the pack's own
 * names a certificate a hybrid group does not have, so the source would never
 * start — its on state lost by another route. So TLS counts as reset when it
 * went on or off, AND when it stayed on with another certificate (`tlsCert`):
 * a hybrid group's own certificate put back to the pack's `$CRIBL_CLOUD_CRT`
 * is still "TLS on". A source the installed version
 * did not have (0.1.0) had nothing to lose. `notes` are said and do not stop
 * it: a sample that was running and is now stopped.
 */
export function upgradeReadBack(before: SourceSnapshot, after: SourceSnapshot): { reset: string[]; notes: string[] } {
  const reset: string[] = []
  const notes: string[] = []
  const b = before.http
  const a = after.http
  if (b !== null) {
    if (a === null) reset.push(`${PACK_HTTP_INPUT_ID} itself`)
    else {
      if (b.tokenSet && !a.tokenSet) reset.push('its auth token')
      if (b.port !== null && a.port !== b.port) reset.push(`its port (${b.port}, now ${a.port ?? 'unknown'})`)
      if (!b.disabled && a.disabled) reset.push('its on state')
      if (b.tls !== a.tls) reset.push('its TLS')
      else if (b.tls && b.tlsCert !== a.tlsCert) reset.push('its TLS certificate')
    }
  }
  if (before.sample && !before.sample.disabled && (after.sample === null || after.sample.disabled)) {
    const now = after.sample?.id ?? PACK_SAMPLE_INPUT_ID
    notes.push(before.sample.id === now
      ? `${now} was running and is not now; start it again with Start sample data if you want it.`
      : `${before.sample.id} was running before the upgrade, and ${now}, the sample source that replaces it, is not running; start it with Start sample data if you want it.`)
  }
  return { reset, notes }
}

/** Everything the Upgrade confirmation is built from — read before it opens. */
export interface UpgradeDialogContext {
  group: string
  /** The installed version (owned, and older than `release.version`). */
  from: string
  release: PackRelease
  /** The sources as the dialog opened — what the read-back compares against. */
  before: SourceSnapshot
  scope: CommitScope | null
  undeployed: string | null
  undeployedChecking?: boolean
}

export interface UpgradeDialog {
  title: string
  resources: ConfirmResource[]
  consequences: string[]
  undo: string
}

/**
 * The Upgrade confirmation: the pack, replaced in place; each object the new
 * version adds or replaces; the deploy; the objects it no longer ships, named
 * in a sentence rather than as delete rows, because a changed one survives the
 * upgrade (`upgradeObjectChanges`); the commit's scope and every
 * consequence — and, always, the plain statement that settings made after
 * install are not verified to survive, with what the run does about it.
 */
export function packUpgradeDialog(ctx: UpgradeDialogContext): UpgradeDialog {
  const { group, from } = ctx
  const to = ctx.release.version
  const { added, dropped, kept } = upgradeObjectChanges(from)
  const resources: ConfirmResource[] = [{
    action: 'replace', kind: 'Pack', id: PACK_ID, group,
    detail: `${from} → ${to} from ${ctx.release.url}, with custom functions refused`,
  }]
  for (const o of added) resources.push({ action: 'create', kind: OBJECT_KIND[o.kind], id: o.id, group, detail: `new in ${to}` })
  for (const o of kept) resources.push({ action: 'replace', kind: OBJECT_KIND[o.kind], id: o.id, group, detail: `${to}’s shipped copy; settings changed after install are kept` })
  resources.push({ action: 'deploy', kind: 'Worker group', id: group, detail: 'restarts its Worker Processes' })

  const droppedInputs = dropped.filter((o) => o.kind === 'inputs').map((o) => o.id)
  const commitCtx = { group, scope: ctx.scope, undeployed: ctx.undeployed, undeployedChecking: ctx.undeployedChecking }
  const undeployedLine = undeployedSentence(commitCtx)
  return {
    title: `Upgrade the Gigamon AMI pack in ${group} to ${to}`,
    resources,
    consequences: [
      UPGRADE_UNVERIFIED,
      ...(ctx.before.http === null ? [upgradeNewSourceSentence()] : []),
      ...(dropped.length ? [upgradeDroppedSentence(to, dropped.map((o) => o.id))] : []),
      ...(droppedInputs.length ? [upgradeDroppedSourcesSentence(droppedInputs)] : []),
      carriesSentence(commitCtx, 'change'),
      pendingSentence(commitCtx),
      ...(undeployedLine ? [undeployedLine] : []),
      ...DEPLOY_CONSEQUENCES,
      HTTP_RESTART_PRECAUTION,
    ],
    undo: upgradeUndo(group),
  }
}

// ── The pack sources' own settings, outside a run ───────────────────────────

/**
 * One change to one of the pack's sources, as the screen offers it: a new auth
 * token for the Raw HTTP source (generated inside the run, never here), a new
 * port for it, or the sample DataGen started or stopped.
 */
export type SourceChange =
  | { kind: 'token' }
  | { kind: 'port'; port: number }
  | { kind: 'sample'; enabled: boolean }

/** Everything a source change's confirmation is built from. */
export interface SourceChangeContext {
  group: string
  change: SourceChange
  /** packClient.ts `previewPackInput`'s before→after, read as the dialog
   *  opened. Never a token value. */
  diff: readonly DiffRow[]
  /** The Raw HTTP source's port as the dialog opened. */
  fromPort: number | null
  /** How the group is hosted: decides the port range. Null when not read. */
  hosting: 'managed' | 'hybrid' | null
  scope: CommitScope | null
  undeployed: string | null
  undeployedChecking?: boolean
}

export interface SourceChangeDialog {
  title: string
  resources: ConfirmResource[]
  diff: DiffEntry[]
  costLine?: string
  consequences: string[]
  undo: string
  /** The diff shown — handed back to the write as `approved`. */
  approved: readonly DiffRow[]
}

/**
 * The confirmation for one source change: the source, replaced whole with one
 * key moved, then the deploy; its before→after; and what follows from it —
 * for a rotation, that Gigamon AMX has to be given the new token.
 */
export function sourceChangeDialog(ctx: SourceChangeContext): SourceChangeDialog {
  const { group, change } = ctx
  const http = change.kind !== 'sample'
  const id = http ? PACK_HTTP_INPUT_ID : PACK_SAMPLE_INPUT_ID
  const commitCtx = { group, scope: ctx.scope, undeployed: ctx.undeployed, undeployedChecking: ctx.undeployedChecking }
  const undeployedLine = undeployedSentence(commitCtx)
  const deployLines = [
    carriesSentence(commitCtx, 'change'),
    pendingSentence(commitCtx),
    ...(undeployedLine ? [undeployedLine] : []),
    ...DEPLOY_CONSEQUENCES,
    ...(http ? [HTTP_RESTART_PRECAUTION] : []),
  ]
  let title: string
  let detail: string
  let first: string[] = []
  let undo: string
  let costLine: string | undefined
  if (change.kind === 'token') {
    title = `Rotate the auth token of ${id} in ${group}`
    detail = 'a new auth token; the current one stops working when the group is deployed'
    first = [ROTATE_EXPORTER]
    undo = ROTATE_UNDO
  } else if (change.kind === 'port') {
    title = `Move ${id} in ${group} to port ${change.port}`
    detail = `port ${ctx.fromPort ?? 'unknown'} → ${change.port}`
    first = [movePortSentence(ctx.fromPort, change.port)]
    undo = movePortUndo(ctx.fromPort)
  } else if (change.enabled) {
    title = `Start the sample data in ${group}`
    detail = `started, writing only to ${PACK_SAMPLE_DATASET_ID}`
    undo = SAMPLE_START_UNDO
    costLine = sampleVolumeWords(sampleVolume())
  } else {
    title = `Stop the sample data in ${group}`
    detail = 'stopped'
    first = [SAMPLE_STOP_KEEPS]
    undo = SAMPLE_STOP_UNDO
  }
  return {
    title,
    resources: [
      { action: 'replace', kind: http ? 'Raw HTTP source' : 'Source', id, group, detail },
      { action: 'deploy', kind: 'Worker group', id: group, detail: 'restarts its Worker Processes' },
    ],
    diff: printed(id, ctx.diff),
    ...(costLine ? { costLine } : {}),
    consequences: [...first, ...deployLines],
    undo,
    approved: [...ctx.diff],
  }
}
