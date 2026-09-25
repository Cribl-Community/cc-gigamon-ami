// The onboarding run, as data: which steps it takes and in what order, what its
// one confirmation says, and the handful of derivations both need. PURE — no
// network call, no clock, no DOM, no KV — so the dialog and the run are built
// from one plan and cannot describe two different sets of writes.
//
// ── WHERE THIS SITS ─────────────────────────────────────────────────────────
// Guided Setup's pack flow (design 2026-09-24, owner answers applied): one
// Onboard press reads the workspace, shows ONE <ConfirmDialog>, and then runs
// the steps below strictly in order. This module is the first half of that —
// the plan. The runner and the panel are the next change; until they land,
// nothing on screen calls `onboardingDialog` or `onboardingSteps`, and nothing
// here can write. The page does read `onboardingPath` today, to decide which
// "What gets created" list it shows.
//
// ── WHAT IT MAY IMPORT ──────────────────────────────────────────────────────
// Never packClient.ts: that module is on paths.ts `UNREACHED_MODULES`, and the
// page imports this one, so importing it here would make the pack client
// reachable before its grants are declared (policyCoverage.test.ts fails).
// What the plan needs from the pack — its ids, its objects, whether its release
// may be installed — is in pack.ts, which is pure. The words come from the
// pure copy modules in src/components/, the same sentences the other Guided
// Setup dialogs say, so one fact is said one way.
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
  ONBOARDING_FAILURE_PROMISE, ONBOARDING_UNDO, ONBOARDING_UNINSTALL, accelCostWords, emptyRealDatasetSentence,
  globalStackSentence, lakeEntryNotCreatedSentence, sampleVolumeWords, storageCostWords,
} from '../../components/onboardingCopy'
import { approvedWrites, type AccelState, type ApprovedWrites } from '../accel/provision'
import { estimateScheduleSetCost } from '../accel/estimate'
import type { AccelId } from '../accel/manifest'
import { realDataConfirmed, type DatasetTarget } from '../datasetTarget'
import { DEFAULT_PROFILE, DEPLOY_CONSEQUENCES, datasetSpec, type DiffRow } from '../landing'
import {
  PACK_HTTP_INPUT_ID, PACK_HTTP_PLACEHOLDER_PORT, PACK_ID, PACK_LAKE_DATASET_ID, PACK_OBJECTS,
  PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID, type PackObjectKind, type PackRelease,
} from '../pack'
import { DATASET_SPEC, PARQUET_DATASET_SPEC, tlsFor, type CommitScope, type LakeDatasetSpec } from '../provision'

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

/** Starting the sample DataGen, as its diff: the one key it changes. */
export const SAMPLE_START_DIFF: readonly DiffRow[] = Object.freeze([
  Object.freeze({ key: 'disabled', kind: 'changed' as const, before: true, after: false }),
])

/** A source's raw diff as the dialog's table rows: each value printed the way
 *  the Lake landing dialog prints one, under the source it belongs to. */
const printed = (resourceId: string, rows: readonly DiffRow[]): DiffEntry[] =>
  rows.map((r) => ({ resourceId, key: r.key, before: printValue(r.before), after: printValue(r.after) }))

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
  steps.push(
    { key: 'commit_deploy', what: 'Commit and deploy', onFailure: 'stop' },
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

  // 5–6. The two sources, each replaced whole.
  const httpDiff: readonly DiffRow[] = ctx.liveHttpDiff ?? expectedConfigureDiff(ctx.hosting, ctx.port)
  resources.push({
    action: 'replace', kind: 'Raw HTTP source', id: PACK_HTTP_INPUT_ID, group,
    detail: `a new auth token, port ${ctx.port}, TLS for a ${ctx.hosting === 'managed' ? 'Cribl-managed' : 'hybrid'} group, and started`,
  })
  let sampleDiff: readonly DiffRow[] = []
  if (ctx.sample) {
    sampleDiff = ctx.liveSampleDiff ?? SAMPLE_START_DIFF
    resources.push({ action: 'replace', kind: 'Source', id: PACK_SAMPLE_INPUT_ID, group, detail: `started, writing only to ${PACK_SAMPLE_DATASET_ID}` })
  }

  // 7. The deploy.
  resources.push({ action: 'deploy', kind: 'Worker group', id: group, detail: 'restarts its Worker Processes' })

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
    carriesSentence(commitCtx, 'change'),
    pendingSentence(commitCtx),
    ...(undeployedLine ? [undeployedLine] : []),
    ...DEPLOY_CONSEQUENCES,
    HTTP_RESTART_PRECAUTION,
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
    steps: onboardingSteps({ sample: ctx.sample, packInstalled: ctx.packInstalled }),
    accelMode: mode,
    approvedAccel,
    approvedHttp: [...httpDiff],
    approvedSample: ctx.sample ? [...sampleDiff] : null,
  }
}

