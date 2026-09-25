// The onboarding run: the reads that build its one confirmation, the steps it
// takes once that confirmation is accepted, and Remove pack.
//
// ── STRICTLY SEQUENTIAL, AND STOPPED BY WHAT LATER STEPS NEED ───────────────
// ./plan.ts `onboardingSteps` is the order and which failures stop the run;
// this module is that order, performed. Every step waits for the one before
// it. A step whose failure later steps depend on stops the run there; the
// others are reported and the run goes on. Nothing already done is undone —
// the step list says what was and was not done — and no Lake dataset is ever
// deleted (the app holds no Lake DELETE grant).
//
// ── WHAT WAS SHOWN IS WHAT IS WRITTEN ───────────────────────────────────────
// `prepareOnboarding` does the reads the dialog is built from (GETs only).
// `runOnboarding` is handed that context and the dialog built from it, and
// first re-reads everything the dialog's claims rest on — the group's hosting,
// the port, the release, the installed pack and its Raw HTTP source, and which
// datasets exist. If any of it moved, NOTHING IS WRITTEN and the step says what
// moved. After that, each write is held to what was confirmed: the sources'
// PATCHes to the diffs the dialog showed (packClient.ts refuses a moved one),
// the saved searches to the set it named (`approvedAccel`), and the mode they
// are created in to the mode it stated.
//
// ── THE TOKEN ───────────────────────────────────────────────────────────────
// Generated here, for step 3 only, and handed to the caller through
// `io.onToken` — only when the PATCH that set it answered `updated`, or when
// it answered an error AND a re-read shows the source now has a token (then
// with a warning). It is in no step, no log entry and no error text.
//
// ── NOTHING HERE RUNS ON ITS OWN ────────────────────────────────────────────
// `runOnboarding` and `runPackRemoval` are reached from a confirmed click in
// components/OnboardingPanel.tsx and from nowhere else; the panel holds the
// page's run lock (../setupRunLock.ts) around each.

import { appendLog } from '../kv'
import { denialMark, denialSince, latchDenial } from '../authz'
import { applyAcceleration, readAccelState, type AccelState, type AccelStep } from '../accel/provision'
import { publishAccelServing } from '../accel/serving'
import { reconsiderDatasetTarget, type DatasetTarget } from '../datasetTarget'
import { listDatasets, listStreamGroupsCurrent, type LakeDataset } from '../lake'
import { forgetLakeFacts } from '../lakeWindowRead'
import {
  PACK_HTTP_INPUT_ID, PACK_ID, PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID,
  PACK_VERSION,
} from '../pack'
import {
  commitAndDeployPack, configureHttpInput, enableHttpInput, installPack, packCommitScope, portsOfOthers, previewPackInput,
  readPackState, removePack, setSampleEnabled, thisPackRelease, type PackState, type PackStep,
} from '../packClient'
import {
  HTTP_SOURCE_ID, LEGACY_SYSLOG_SOURCE_ID, ensureLakeDataset, generateToken, groupInputs, hostingOf, leaderHostname,
  pendingConfigPaths, portProblem, type LakeDatasetStep, type StepResult,
} from '../provision'
import { installedRefusal } from '../../components/onboardingCopy'
import {
  SAMPLE_START_DIFF, accelMode, httpActionOf, jsonRetentionFor, onboardingDatasets, type HttpAction,
  type OnboardingDialog, type OnboardingDialogContext,
} from './plan'
import type { DiffRow } from '../landing'

// ── The step log ────────────────────────────────────────────────────────────

export type RunAction = 'created' | 'updated' | 'deleted' | 'exists' | 'error' | 'skipped' | 'refused'

/** One line of the step log. Never carries a token. */
export interface RunStep {
  key: string
  /** What the line is about, in a few words. */
  label: string
  action: RunAction
  detail?: string
  /** Done, but not the way the confirmation hoped — say so beside it. */
  warning?: boolean
}

export interface RunOutcome {
  steps: RunStep[]
  /** The step that stopped the run, or null when it ran to the end. */
  stopped: RunStep | null
  /** The pack as read back at the end, when it was. */
  pack: PackState | null
}

/** What the run needs from the screen that started it. */
export interface OnboardingIO {
  onStep: (s: RunStep) => void
  /** The token step 3 set: shown once by the caller, kept nowhere else.
   *  `afterError` when the write answered an error and a re-read found a token. */
  onToken: (token: string, afterError: boolean) => void
  /** Records a pack commit's hash in Guided Setup's commit memory, so the
   *  stranded-commit repair will deploy it (packClient.ts `PackCommitOptions`). */
  record: (hash: string, message: string) => Promise<unknown>
  /** The dataset verdict now, for step 6's re-check of the mode. */
  target: () => DatasetTarget
  /** Tests only: the token to use instead of a generated one. */
  token?: () => string
}

const LABELS: Record<string, string> = {
  precheck: 'Nothing moved since the confirmation',
  dataset_json: `Lake dataset ${PACK_LAKE_DATASET_ID}`,
  dataset_parquet: `Lake dataset ${PACK_PARQUET_DATASET_ID}`,
  dataset_sample: `Lake dataset ${PACK_SAMPLE_DATASET_ID}`,
  pack: `Pack ${PACK_ID}`,
  verify: 'Install read back',
  http_input: `Raw HTTP source ${PACK_HTTP_INPUT_ID}`,
  sample_input: `Sample source ${PACK_SAMPLE_INPUT_ID}`,
  commit: 'Commit',
  deploy: 'Deploy',
  acceleration: 'Scheduled searches',
  recheck: 'Read back',
}

const labelOf = (key: string): string => LABELS[key] ?? key

// ── The reads the dialog is built from ──────────────────────────────────────

/** Whether the group holds Guided Setup's global Raw HTTP or old Syslog source. */
function globalSourcePresent(inputs: readonly { id: string; pack: string | null }[] | null): boolean {
  // A group whose sources could not be read may hold one: say so rather than not.
  if (inputs === null) return true
  return inputs.some((i) => i.pack === null && (i.id === HTTP_SOURCE_ID || i.id === LEGACY_SYSLOG_SOURCE_ID))
}

const liveIds = (list: readonly LakeDataset[]): string[] => list.filter((d) => d.deletionStartedAt === null).map((d) => d.id)

export type PrepareResult =
  | { ok: true; ctx: OnboardingDialogContext }
  | { ok: false; why: string }

/**
 * Every read the Onboard confirmation is built from, in one place — GETs only.
 * Answers the dialog's context, or why the dialog cannot be opened. The
 * group's undeployed HEAD is the caller's to capture (it can take a while, and
 * a button that opens nothing for that long is its own bug).
 */
export async function prepareOnboarding(
  group: string,
  opts: { sample: boolean; port: number; target: DatasetTarget; undeployed: string | null; undeployedChecking: boolean },
): Promise<PrepareResult> {
  const release = thisPackRelease()
  if (!release.installable) return { ok: false, why: release.refusal ?? 'the pack’s release cannot be installed' }
  const [pack, datasets, inputs, groups, pending, accel] = await Promise.all([
    readPackState(group),
    listDatasets(),
    groupInputs(group).catch(() => null),
    listStreamGroupsCurrent(),
    pendingConfigPaths().catch(() => null),
    readAccelState(),
  ])
  if (pack.error) return { ok: false, why: pack.error }
  if (pack.installed && !pack.current) {
    return { ok: false, why: installedRefusal({ version: pack.version, published: pack.published, fromRelease: pack.fromRelease, group }) }
  }
  if (datasets.outcome !== 'ok' || datasets.value === null) return { ok: false, why: 'Cribl Lake’s dataset list could not be read' }
  if (accel.error !== null) return { ok: false, why: `the scheduled searches could not be read: ${accel.error}` }
  const rec = groups.outcome === 'ok' ? groups.value?.find((x) => x.id === group) : undefined
  const hosting = rec ? hostingOf(rec.onPrem, leaderHostname()) : null
  if (hosting === null) {
    return { ok: false, why: `this app could not tell whether ${group} is Cribl-managed or hybrid, which decides the port range and TLS` }
  }
  const httpAction: HttpAction = pack.installed ? httpActionOf(pack.http) : 'configure'
  if (httpAction === 'configure') {
    const problem = portProblem(opts.port, hosting === 'managed', await portsOfOthers(group))
    if (problem) return { ok: false, why: `port ${opts.port}: ${problem}` }
  }

  // With the pack installed, the sources' before→after is READ, not predicted.
  let liveHttpDiff: DiffRow[] | null = null
  let liveSampleDiff: DiffRow[] | null = null
  if (pack.installed) {
    if (httpAction === 'none') liveHttpDiff = []
    else {
      const preview = await previewPackInput(
        group,
        // The token is never shown, so the one in the preview is thrown away:
        // the diff reads "a new token (not shown)" whatever its value.
        httpAction === 'configure' ? { kind: 'configure', port: opts.port, token: generateToken(), hosting } : { kind: 'enable', hosting },
      )
      if (!preview.ok) return { ok: false, why: preview.step.detail ?? 'the pack’s Raw HTTP source could not be read' }
      liveHttpDiff = preview.diff
    }
    // Starting the sample changes one key, `disabled`; it is read off the
    // source rather than previewed, because a preview refuses until the sample
    // dataset exists — and this run is what creates it.
    if (opts.sample) liveSampleDiff = pack.sample === null ? null : pack.sample.disabled ? [...SAMPLE_START_DIFF] : []
  }

  const ids = liveIds(datasets.value)
  const json = datasets.value.find((d) => d.id === PACK_LAKE_DATASET_ID && d.deletionStartedAt === null)
  return {
    ok: true,
    ctx: {
      group,
      hosting,
      port: opts.port,
      sample: opts.sample,
      release,
      packInstalled: pack.installed,
      httpAction,
      datasets: ids,
      jsonRetentionDays: json?.retentionPeriodInDays ?? null,
      liveHttpDiff,
      liveSampleDiff,
      accel,
      target: opts.target,
      scope: packCommitScope(group, pending),
      undeployed: opts.undeployed,
      undeployedChecking: opts.undeployedChecking,
      globalStackPresent: globalSourcePresent(inputs),
    },
  }
}

// ── Step 0: nothing moved ───────────────────────────────────────────────────

/** What moved since the dialog was built, as phrases; empty when nothing did. */
async function whatMoved(ctx: OnboardingDialogContext): Promise<string[]> {
  const moved: string[] = []
  const release = thisPackRelease()
  if (!release.installable) moved.push(release.refusal ?? 'the pack’s release can no longer be installed')
  else if (release.version !== ctx.release.version) moved.push(`this app now installs ${release.version}, not ${ctx.release.version}`)

  const [groups, pack, datasets] = await Promise.all([listStreamGroupsCurrent(), readPackState(ctx.group), listDatasets()])
  const rec = groups.outcome === 'ok' ? groups.value?.find((x) => x.id === ctx.group) : undefined
  const hosting = rec ? hostingOf(rec.onPrem, leaderHostname()) : null
  if (hosting === null) moved.push(`this app can no longer tell whether ${ctx.group} is Cribl-managed or hybrid`)
  else if (hosting !== ctx.hosting) moved.push(`${ctx.group} now reads as ${hosting === 'managed' ? 'Cribl-managed' : 'hybrid'}`)

  const planned: HttpAction = ctx.httpAction ?? 'configure'
  if (pack.error) moved.push(`the group’s pack list could not be read again (${pack.error})`)
  else {
    if (ctx.packInstalled && !(pack.installed && pack.current)) {
      moved.push(pack.installed ? `${PACK_ID} ${pack.version ?? ''} is installed now, not this app’s current release` : `${PACK_ID} is no longer installed`)
    }
    if (!ctx.packInstalled && pack.installed) moved.push(`${PACK_ID} ${pack.version ?? ''} has been installed since`.replace('  ', ' '))
    const now: HttpAction = pack.installed ? httpActionOf(pack.http) : 'configure'
    if (now !== planned) moved.push(`${PACK_HTTP_INPUT_ID} changed: it would now be ${now === 'none' ? 'left as it is' : now === 'enable' ? 'started' : 'configured'}`)
  }
  if (planned === 'configure' && hosting !== null) {
    const problem = portProblem(ctx.port, hosting === 'managed', await portsOfOthers(ctx.group))
    if (problem) moved.push(`port ${ctx.port}: ${problem}`)
  }

  if (datasets.outcome !== 'ok' || datasets.value === null) moved.push('Cribl Lake’s dataset list could not be read again')
  else {
    const ids = liveIds(datasets.value)
    const watched = [PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, ...(ctx.sample ? [PACK_SAMPLE_DATASET_ID] : [])]
    for (const id of watched) {
      const was = ctx.datasets.includes(id)
      if (ids.includes(id) !== was) moved.push(`${id} ${was ? 'no longer exists' : 'exists now'}`)
    }
    const json = datasets.value.find((d) => d.id === PACK_LAKE_DATASET_ID && d.deletionStartedAt === null)
    if (json && ctx.datasets.includes(PACK_LAKE_DATASET_ID) && (json.retentionPeriodInDays ?? null) !== ctx.jsonRetentionDays) {
      moved.push(`${PACK_LAKE_DATASET_ID}’s retention is now ${json.retentionPeriodInDays ?? 'unknown'} days`)
    }
  }
  return moved
}

// ── The run ─────────────────────────────────────────────────────────────────

function datasetStep(key: string, r: LakeDatasetStep): RunStep {
  if (r.action === 'exists' && r.differs?.length) {
    return {
      key, label: labelOf(key), action: 'exists', warning: true,
      detail: `left as it is: ${r.differs.join('; ')} (format and partitions are fixed at creation)`,
    }
  }
  return { key, label: labelOf(key), action: r.action, ...(r.detail ? { detail: r.detail } : {}) }
}

const fromPack = (p: PackStep, extra = ''): RunStep => ({
  key: p.key, label: labelOf(p.key), action: p.action, ...(p.detail || extra ? { detail: `${p.detail ?? ''}${extra}` } : {}),
})

const fromCommit = (r: StepResult): RunStep => ({
  key: r.key, label: labelOf(r.key), action: r.action, ...(r.detail ? { detail: r.detail } : {}),
})

/** The commit message, which names the pack, its version and the group. */
export const onboardMessage = (group: string): string => `Gigamon AMI: onboard pack ${PACK_ID} ${PACK_VERSION} in ${group}`
export const removeMessage = (group: string): string => `Gigamon AMI: remove pack ${PACK_ID} from ${group}`

/** The saved-search steps as the log shows them: every problem on its own
 *  line, everything else counted. */
function accelSteps(res: readonly AccelStep[], ctx: OnboardingDialogContext, mode: 'running' | 'paused'): RunStep[] {
  const out: RunStep[] = []
  const unresolvedAtDialog = new Set(ctx.accel.rows.filter((r) => r.windowUnresolved).map((r) => r.id as string))
  const counts: Record<string, number> = {}
  for (const s of res) {
    // A Lake entry the dialog said would NOT be created (its window was
    // unresolved then) and that this run therefore did not create — whatever
    // the fresh read now says about its window.
    if ((s.action === 'refused' || s.action === 'skipped') && unresolvedAtDialog.has(s.id)) {
      out.push({ key: 'acceleration', label: `Scheduled search ${s.id}`, action: 'skipped', detail: 'not created in this run; Apply creates it in Acceleration once the dataset’s retention can be read' })
      continue
    }
    if (s.action === 'error' || s.action === 'refused' || s.action === 'skipped') {
      out.push({ key: 'acceleration', label: `Scheduled search ${s.id}`, action: s.action, ...(s.detail ? { detail: s.detail } : {}) })
      continue
    }
    counts[s.action] = (counts[s.action] ?? 0) + 1
  }
  const parts = Object.entries(counts).map(([a, n]) => `${n} ${a === 'exists' ? 'already in place' : a}`)
  if (parts.length) {
    out.unshift({
      key: 'acceleration', label: labelOf('acceleration'), action: counts.created ? 'created' : counts.updated ? 'updated' : 'exists',
      detail: `${parts.join(', ')}${counts.created ? ` — the new ones ${mode === 'running' ? 'running' : 'installed paused'}` : ''}`,
    })
  }
  return out
}

/**
 * The onboarding run, strictly in order. `ctx` is what the dialog was built
 * from and `dialog` is what it showed; the run writes nothing the dialog did
 * not name, and nothing at all when step 0 finds that something moved.
 */
export async function runOnboarding(ctx: OnboardingDialogContext, dialog: OnboardingDialog, io: OnboardingIO): Promise<RunOutcome> {
  const steps: RunStep[] = []
  const step = (s: RunStep): RunStep => {
    steps.push(s)
    io.onStep(s)
    return s
  }
  const finish = (stopped: RunStep | null, pack: PackState | null = null): RunOutcome => {
    void appendLog('gigamon', {
      action: 'onboarding_pack.applied',
      group: ctx.group,
      outcome: steps.some((s) => s.action === 'error') ? 'error' : 'ok',
      steps: steps.map((s) => `${s.key}:${s.action}`),
    })
    return { steps, stopped, pack }
  }
  const g = ctx.group
  let wrote = false

  // 0. Re-read what the dialog's claims rest on. Anything moved: nothing written.
  const moved = await whatMoved(ctx)
  if (moved.length) {
    const s = step({
      key: 'precheck', label: labelOf('precheck'), action: 'error',
      detail: `Nothing was written, because this changed after the confirmation was shown: ${moved.join('; ')}. Look again, and confirm again.`,
    })
    return finish(s)
  }
  step({ key: 'precheck', label: labelOf('precheck'), action: 'exists', detail: 'what the confirmation showed still holds' })

  // 1. The datasets — gigamon_ami stops the run; the Parquet copy and the
  // sample's are reported, and a sample dataset that failed skips step 4.
  const keys = ['dataset_json', 'dataset_parquet', 'dataset_sample']
  const specs = onboardingDatasets({ sample: ctx.sample, jsonRetentionDays: jsonRetentionFor(ctx.datasets, ctx.jsonRetentionDays) })
  let sampleDatasetReady = true
  for (const [i, spec] of specs.entries()) {
    const r = await ensureLakeDataset(spec)
    const s = step(datasetStep(keys[i], r))
    if (r.action !== 'error' && r.action !== 'skipped') continue
    if (i === 0) return finish(s)
    if (i === 2) sampleDatasetReady = false
  }

  // 2. The pack, when it is not installed. A copy already current is `exists`;
  // an older or foreign one never reaches here (prepare and step 0 refuse it).
  if (!ctx.packInstalled) {
    const got = await installPack(g)
    let failed: RunStep | null = null
    for (const p of got) {
      const s = step(fromPack(p, p.action === 'error' && p.key === 'pack'
        ? '. A copy of the pack’s file may remain staged on the Leader; nothing else was changed by this step.'
        : ''))
      if (p.action === 'error' || p.action === 'skipped') failed = failed ?? s
      if (p.action === 'created') wrote = true
    }
    // A failed read-back stops here too, before any token is written.
    if (failed) return finish(failed)
  } else {
    step({ key: 'pack', label: labelOf('pack'), action: 'exists', detail: `${PACK_ID} ${PACK_VERSION} is installed` })
  }

  // 3. The Raw HTTP source.
  const action: HttpAction = ctx.httpAction ?? 'configure'
  if (action === 'configure') {
    const token = (io.token ?? generateToken)()
    const r = await configureHttpInput(g, { port: ctx.port, token, hosting: ctx.hosting }, dialog.approvedHttp)
    if (r.action === 'updated') {
      wrote = true
      step(fromPack(r))
      io.onToken(token, false)
    } else if (r.action === 'exists') {
      step(fromPack(r))
    } else {
      const s = step(fromPack(r))
      if (r.sent) {
        // The write answered an error. Whether the token landed anyway is read,
        // not assumed: a source that now has a token has this one (it had none).
        const after = await readPackState(g)
        if (after.http?.tokenSet) {
          io.onToken(token, true)
          step({ key: 'http_input', label: labelOf('http_input'), action: 'error', warning: true, detail: 'the source now has a token although the change reported an error; it is shown once above' })
        }
      }
      return finish(s)
    }
  } else if (action === 'enable') {
    const r = await enableHttpInput(g, ctx.hosting, dialog.approvedHttp)
    const s = step(fromPack(r))
    if (r.action === 'updated') wrote = true
    if (r.action === 'error' || r.action === 'skipped') return finish(s)
  } else {
    step({ key: 'http_input', label: labelOf('http_input'), action: 'exists', detail: 'already has a token and is running' })
  }

  // 4. The sample source, when ticked — refused (by packClient) until its
  // dataset is listed, and skipped when step 1c could not create it.
  if (ctx.sample) {
    if (!sampleDatasetReady) {
      step({ key: 'sample_input', label: labelOf('sample_input'), action: 'skipped', detail: `not started, because ${PACK_SAMPLE_DATASET_ID} could not be created` })
    } else {
      const r = await setSampleEnabled(g, true, dialog.approvedSample ?? undefined)
      if (r.action === 'updated') wrote = true
      step(r.action === 'error' ? { ...fromPack(r), detail: `sample not started: ${r.detail ?? 'failed'}` } : fromPack(r))
    }
  }

  // 5. Commit and deploy. A commit that fails or is incomplete deploys
  // nothing; either failure means no scheduled searches.
  const committed = await commitAndDeployPack(g, onboardMessage(g), { wrote, record: io.record }, (r) => { step(fromCommit(r)) })
  const broken = committed.find((r) => r.action === 'error')
  if (broken) {
    step({ key: 'acceleration', label: labelOf('acceleration'), action: 'skipped', detail: 'not installed, because the commit or deploy did not complete' })
    return finish(steps.find((s) => s.key === broken.key && s.action === 'error') ?? null)
  }

  // 6. Acceleration, always — in the mode the dialog stated, or not at all.
  const mode = accelMode(ctx.sample, io.target())
  if (mode !== dialog.accelMode) {
    step({
      key: 'acceleration', label: labelOf('acceleration'), action: 'refused',
      detail: `not installed: the confirmation said the scheduled searches would be ${dialog.accelMode === 'running' ? 'running' : 'installed paused'}, ` +
        `and what this app knows about ${PACK_LAKE_DATASET_ID}'s data has changed since. Install them from Acceleration.`,
    })
  } else {
    // gigamon_ami may have been created a moment ago; its retention decides the
    // Lake entry's window, so the cached read is dropped first.
    forgetLakeFacts()
    const mark = denialMark()
    const res = await applyAcceleration(() => {}, dialog.approvedAccel, { enabled: mode === 'running' })
    const refused = denialSince(mark)
    if (refused) latchDenial('accel.apply', refused)
    for (const s of accelSteps(res.steps, ctx, mode)) step(s)
    publishAccelServing(res.state)
    if (mode === 'paused') warnRunning(res.state, res.steps, step)
  }

  // 7. Reads only.
  await reconsiderDatasetTarget().catch(() => null)
  const pack = await readPackState(g)
  step({ key: 'recheck', label: labelOf('recheck'), action: 'exists', detail: 'the pack, the datasets verdict and the scheduled searches were read again' })
  return finish(null, pack)
}

/** Created paused, read back running: said, never silently believed. */
function warnRunning(state: AccelState, res: readonly AccelStep[], step: (s: RunStep) => RunStep): void {
  const created = new Set(res.filter((s) => s.action === 'created').map((s) => s.id as string))
  const running = state.rows.filter((r) => created.has(r.id) && r.enabled === true).map((r) => r.id)
  if (running.length === 0) return
  step({
    key: 'acceleration', label: labelOf('acceleration'), action: 'error', warning: true,
    detail: `created paused, but Cribl reports ${running.join(', ')} running. Switch them off in Acceleration.`,
  })
}

// ── Remove pack ─────────────────────────────────────────────────────────────

export interface RemovalIO {
  onStep: (s: RunStep) => void
  record: (hash: string, message: string) => Promise<unknown>
  /** The pack's sources are gone (deleted, or already not there): the token
   *  they held opens nothing, and the screen drops it. */
  onSourcesGone: () => void
}

/**
 * Uninstall the pack — only a copy this app owns by both signals — then commit
 * and deploy. After a DELETE that succeeded, "nothing committed" is an error.
 * No Lake dataset is touched.
 */
export async function runPackRemoval(group: string, io: RemovalIO): Promise<RunOutcome> {
  const steps: RunStep[] = []
  const step = (s: RunStep): RunStep => {
    steps.push(s)
    io.onStep(s)
    return s
  }
  const finish = (stopped: RunStep | null): RunOutcome => {
    void appendLog('gigamon', {
      action: 'onboarding_pack.removed',
      group,
      outcome: steps.some((s) => s.action === 'error') ? 'error' : 'ok',
      steps: steps.map((s) => `${s.key}:${s.action}`),
    })
    return { steps, stopped, pack: null }
  }
  const r = await removePack(group)
  if (r.action === 'error') return finish(step(fromPack(r)))
  if (r.detail === 'not present') {
    io.onSourcesGone()
    step({ key: 'pack', label: labelOf('pack'), action: 'exists', detail: 'not present' })
    return finish(null)
  }
  io.onSourcesGone()
  step({ key: 'pack', label: labelOf('pack'), action: 'deleted' })
  const committed = await commitAndDeployPack(group, removeMessage(group), { wrote: true, record: io.record }, (c) => { step(fromCommit(c)) })
  const broken = committed.find((c) => c.action === 'error')
  return finish(broken ? steps.find((s) => s.key === broken.key && s.action === 'error') ?? null : null)
}
