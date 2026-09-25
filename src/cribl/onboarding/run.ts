// The onboarding run: the reads that build its one confirmation, the steps it
// takes once that confirmation is accepted, Remove pack, Upgrade, and the pack
// sources' own settings (Rotate token, Move port, Start and Stop sample data).
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
// `runOnboarding`, `runPackRemoval`, `finishPackRemoval`, `runPackUpgrade` and
// `runSourceChange` are reached from a confirmed click in
// components/OnboardingPanel.tsx and from nowhere else; the panel holds the
// page's run lock (../setupRunLock.ts) around each.

import { appendLog } from '../kv'
import { denialMark, denialSince, latchDenial } from '../authz'
import { SAVED_PATH, applyAcceleration, readAccelState, type AccelState, type AccelStep } from '../accel/provision'
import { publishAccelServing } from '../accel/serving'
import { reconsiderDatasetTarget, type DatasetTarget } from '../datasetTarget'
import { listDatasets, listStreamGroupsCurrent, type LakeDataset } from '../lake'
import { forgetLakeFacts } from '../lakeWindowRead'
import {
  PACK_HTTP_INPUT_ID, PACK_ID, PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID,
  PACK_VERSION,
} from '../pack'
import {
  commitAndDeployPack, compareVersions, configureHttpInput, enableHttpInput, installPack, packCommitScope, portsOfOthers,
  previewPackInput, readPackState, removePack, setHttpToken, setSampleEnabled, setSourcePort, thisPackRelease,
  type PackInputChange, type PackState, type PackStep,
} from '../packClient'
import { upgradePack } from '../packUpgrade'
import {
  HTTP_SOURCE_ID, LEGACY_SYSLOG_SOURCE_ID, ensureLakeDataset, generateToken, groupInputs, hostingOf, leaderHostname,
  pendingConfigPaths, portProblem, sameValue, type LakeDatasetStep, type StepResult,
} from '../provision'
import { ROTATE_FAILED, installedRefusal, upgradeHeldSentence, upgradeResetSentence } from '../../components/onboardingCopy'
import {
  SAMPLE_START_DIFF, accelMode, httpActionOf, jsonRetentionFor, onboardingDatasets, sameWrites, upgradeReadBack, type HttpAction,
  type OnboardingDialog, type OnboardingDialogContext, type SourceChange, type SourceChangeContext, type SourceChangeDialog,
  type SourceSnapshot, type UpgradeDialog, type UpgradeDialogContext,
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
  readback: `Raw HTTP source ${PACK_HTTP_INPUT_ID} read back`,
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
    const token = generateToken()
    const change = { port: ctx.port, token, hosting: ctx.hosting }
    // On a fresh install the dialog's diff was predicted from the shipped file,
    // and the source is now the Leader's installed copy of it. The write is
    // held to what the dialog said it would SET (`sameWrites`); when that
    // holds, the diff read now is the one approved, so packClient still sends
    // nothing if the source moves between this read and its own.
    let approved = dialog.approvedHttp
    if (!ctx.packInstalled) {
      const now = await previewPackInput(g, { kind: 'configure', ...change })
      if (now.ok && sameWrites(now.diff, dialog.approvedHttp)) approved = now.diff
    }
    const r = await configureHttpInput(g, change, approved)
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
  // nothing; either failure means no scheduled searches. A dialog that named
  // no deploy (the run changes nothing in the group) gets none, unless a write
  // happened after all, which is never left uncommitted.
  if (!dialog.deploys && !wrote) {
    step({ key: 'commit', label: labelOf('commit'), action: 'skipped', detail: `nothing in ${g} changed, so nothing was committed or deployed` })
  } else {
    const committed = await commitAndDeployPack(g, onboardMessage(g), { wrote, record: io.record }, (r) => { step(fromCommit(r)) })
    const broken = committed.find((r) => r.action === 'error')
    if (broken) {
      step({ key: 'acceleration', label: labelOf('acceleration'), action: 'skipped', detail: 'not installed, because the commit or deploy did not complete' })
      return finish(steps.find((s) => s.key === broken.key && s.action === 'error') ?? null)
    }
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
    // The Lake entry's window comes from the Lake API's retentions, read once
    // and cached for the session. Step 0 re-checked gigamon_ami's, but not
    // cribl_metrics' (which picks the counting method), and the cache can be
    // older than the dialog. Dropped first, so the entry is built from now.
    // (A gigamon_ami this run created had no window in the dialog, so its
    // entry is not approved at all.)
    forgetLakeFacts()
    const mark = denialMark()
    const res = await applyAcceleration(() => {}, dialog.approvedAccel, { enabled: mode === 'running' })
    // Only a refused saved-search WRITE closes Apply, which is that write. A
    // refused read inside the step (the saved-search list) or another panel's
    // request in the same moment is not the thing Apply would be refused.
    const refused = denialSince(mark, (d) => d.method !== 'GET' && (d.path === SAVED_PATH || d.path.startsWith(`${SAVED_PATH}/`)))
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

/**
 * Commit and deploy a removal whose DELETE landed and whose commit did not — the
 * pack is gone from the group, and the Workers still run it. Re-reads first:
 * a pack that is installed again (or a list that cannot be read) writes
 * nothing. The commit takes the pack's files Git still reports, and when
 * somebody has committed them since, the step says so rather than failing.
 */
export async function finishPackRemoval(group: string, io: Pick<RemovalIO, 'onStep' | 'record'>): Promise<RunOutcome> {
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
  const now = await readPackState(group)
  if (now.error) return finish(step({ key: 'pack', label: labelOf('pack'), action: 'error', detail: `nothing was written: ${now.error}` }))
  if (now.installed) {
    return finish(step({ key: 'pack', label: labelOf('pack'), action: 'error', detail: `nothing was written: ${PACK_ID} is installed in ${group} again` }))
  }
  step({ key: 'pack', label: labelOf('pack'), action: 'exists', detail: 'not installed' })
  const committed = await commitAndDeployPack(group, removeMessage(group), { wrote: false, record: io.record }, (c) => { step(fromCommit(c)) })
  const broken = committed.find((c) => c.action === 'error')
  return finish(broken ? steps.find((s) => s.key === broken.key && s.action === 'error') ?? null : null)
}

// ── Upgrade ─────────────────────────────────────────────────────────────────
//
// The in-place upgrade (packUpgrade.ts `upgradePack`), and the one thing the
// design asks of it that nothing else checks: settings made after install —
// the Raw HTTP source's port, token, TLS and on state — are not known to
// survive a `PATCH /packs/<id>` (unknown d). So the source is read back after
// the upgrade, and a reset commits and deploys NOTHING: a commit would put the
// reset on the Workers, and the step says so, and who else could.

/** What the read-back compares, off `readPackState`. Never a token. */
const snapshotOf = (p: PackState): SourceSnapshot => ({ http: p.http, sample: p.sample })

/** Why this copy is not one this app will upgrade to `to`, or null. */
function upgradeRefusal(pack: PackState, group: string, to: string): string | null {
  if (pack.error) return pack.error
  if (!pack.installed) return `${PACK_ID} is not installed in ${group}`
  if (!pack.published || !pack.fromRelease || pack.version === null) {
    return installedRefusal({ version: pack.version, published: pack.published, fromRelease: pack.fromRelease, group })
  }
  const d = compareVersions(pack.version, to)
  if (d === 0) return `${PACK_ID} ${to} is already installed in ${group}`
  if (d > 0) return `the installed ${PACK_ID} ${pack.version} is newer than the ${to} this app installs, and this app does not downgrade`
  return null
}

export type UpgradePrepareResult = { ok: true; ctx: UpgradeDialogContext } | { ok: false; why: string }

/**
 * The reads the Upgrade confirmation is built from — GETs only. Refused while
 * this build records no release, for a copy this app did not install from its
 * own release, and for one already current or newer (no downgrade).
 */
export async function prepareUpgrade(
  group: string,
  opts: { undeployed: string | null; undeployedChecking: boolean },
): Promise<UpgradePrepareResult> {
  const release = thisPackRelease()
  if (!release.installable) return { ok: false, why: release.refusal ?? 'the pack’s release cannot be installed' }
  const [pack, pending] = await Promise.all([readPackState(group), pendingConfigPaths().catch(() => null)])
  const why = upgradeRefusal(pack, group, release.version)
  if (why) return { ok: false, why }
  return {
    ok: true,
    ctx: {
      group, from: pack.version as string, release, before: snapshotOf(pack), scope: packCommitScope(group, pending),
      undeployed: opts.undeployed, undeployedChecking: opts.undeployedChecking,
    },
  }
}

export const upgradeMessage = (group: string, from: string): string =>
  `Gigamon AMI: upgrade pack ${PACK_ID} ${from} → ${PACK_VERSION} in ${group}`

/**
 * The upgrade, strictly in order: re-read (anything moved, nothing written),
 * `upgradePack`, read the sources back, and only then commit the pack's files
 * and deploy. A reset source, a read-back that fails and a failed install check
 * each stop the run with nothing committed or deployed.
 */
export async function runPackUpgrade(ctx: UpgradeDialogContext, _dialog: UpgradeDialog, io: Pick<RemovalIO, 'onStep' | 'record'>): Promise<RunOutcome> {
  const steps: RunStep[] = []
  const step = (s: RunStep): RunStep => {
    steps.push(s)
    io.onStep(s)
    return s
  }
  const finish = (stopped: RunStep | null, pack: PackState | null = null): RunOutcome => {
    void appendLog('gigamon', {
      action: 'onboarding_pack.upgraded',
      group: ctx.group,
      from: ctx.from,
      outcome: steps.some((s) => s.action === 'error') ? 'error' : 'ok',
      steps: steps.map((s) => `${s.key}:${s.action}`),
    })
    return { steps, stopped, pack }
  }
  const g = ctx.group

  // 0. Nothing moved since the confirmation.
  const moved: string[] = []
  const release = thisPackRelease()
  if (!release.installable) moved.push(release.refusal ?? 'the pack’s release can no longer be installed')
  else if (release.version !== ctx.release.version) moved.push(`this app now installs ${release.version}, not ${ctx.release.version}`)
  const now = await readPackState(g)
  if (now.error) moved.push(`the group’s pack list could not be read again (${now.error})`)
  else {
    const why = upgradeRefusal(now, g, ctx.release.version)
    if (why) moved.push(why)
    else if (now.version !== ctx.from) moved.push(`${PACK_ID} is ${now.version ?? 'of an unknown version'} now, not ${ctx.from}`)
    if (!sameValue(snapshotOf(now), ctx.before)) moved.push(`${PACK_HTTP_INPUT_ID} or ${PACK_SAMPLE_INPUT_ID} changed`)
  }
  if (moved.length) {
    return finish(step({
      key: 'precheck', label: labelOf('precheck'), action: 'error',
      detail: `Nothing was written, because this changed after the confirmation was shown: ${moved.join('; ')}. Look again, and confirm again.`,
    }))
  }
  step({ key: 'precheck', label: labelOf('precheck'), action: 'exists', detail: 'what the confirmation showed still holds' })

  // 1. The upgrade, and its own read-back of the version and the source.
  let upgraded = false
  let failed: RunStep | null = null
  for (const p of await upgradePack(g)) {
    const s = step(fromPack(p))
    if (p.key === 'pack' && p.action === 'updated') upgraded = true
    if (p.action === 'error' || p.action === 'skipped' || (p.key === 'pack' && p.action === 'exists')) failed = failed ?? s
  }
  if (failed) {
    if (upgraded) step({ key: 'readback', label: labelOf('readback'), action: 'error', detail: upgradeHeldSentence(g, 'the upgrade could not be checked') })
    return finish(failed)
  }

  // 2. What was set after install, read back.
  const after = await readPackState(g)
  if (after.error || !after.installed) {
    return finish(step({
      key: 'readback', label: labelOf('readback'), action: 'error',
      detail: upgradeHeldSentence(g, `${PACK_HTTP_INPUT_ID} could not be read back after it`),
    }))
  }
  const rb = upgradeReadBack(ctx.before, snapshotOf(after))
  if (rb.reset.length) {
    return finish(step({ key: 'readback', label: labelOf('readback'), action: 'error', detail: upgradeResetSentence(g, rb.reset) }), after)
  }
  step({
    key: 'readback', label: labelOf('readback'), action: 'exists',
    detail: ctx.before.http
      ? `${PACK_HTTP_INPUT_ID} kept its port, auth token, TLS and state`
      : `${PACK_HTTP_INPUT_ID} arrived switched off and without an auth token; Finish onboarding configures it`,
  })
  for (const note of rb.notes) step({ key: 'readback', label: labelOf('readback'), action: 'exists', warning: true, detail: note })

  // 3. Commit the pack's files, then deploy.
  const committed = await commitAndDeployPack(g, upgradeMessage(g, ctx.from), { wrote: true, record: io.record }, (r) => { step(fromCommit(r)) })
  const broken = committed.find((r) => r.action === 'error')
  if (broken) return finish(steps.find((s) => s.key === broken.key && s.action === 'error') ?? null, after)
  return finish(null, await readPackState(g))
}

// ── The pack sources' own settings, outside a run ───────────────────────────

/** What a source change needs from the screen. */
export interface SourceChangeIO {
  onStep: (s: RunStep) => void
  /** A rotation's new token, handed over once, after the PATCH that set it
   *  answered `updated`. Kept nowhere else. */
  onToken: (token: string) => void
  record: (hash: string, message: string) => Promise<unknown>
}

export type SourceChangePrepareResult = { ok: true; ctx: SourceChangeContext } | { ok: false; why: string }

/** The change as packClient.ts takes it. A rotation's token here is the
 *  preview's, which is thrown away: the diff says "a new token (not shown)"
 *  whatever its value, and the run generates its own. */
function packChange(change: SourceChange, hosting: 'managed' | 'hybrid' | null, token: string): PackInputChange {
  if (change.kind === 'token') return { kind: 'token', token }
  if (change.kind === 'port') return { kind: 'port', port: change.port, hosting }
  return { kind: 'sample', enabled: change.enabled }
}

const ownedCopy = (p: PackState): boolean => !p.error && p.installed && p.published && p.fromRelease

/**
 * The reads a source change's confirmation is built from — GETs only:
 * the pack (it must be this app's), the group's hosting for a port move, the
 * change's own preview (packClient.ts `previewPackInput`, which checks a port is
 * free and in range, and refuses to start the sample until its dataset
 * exists), and what the commit would carry. A change that would change
 * nothing opens no dialog.
 */
export async function prepareSourceChange(
  group: string,
  change: SourceChange,
  opts: { undeployed: string | null; undeployedChecking: boolean },
): Promise<SourceChangePrepareResult> {
  const [pack, pending, groups] = await Promise.all([
    readPackState(group),
    pendingConfigPaths().catch(() => null),
    change.kind === 'port' ? listStreamGroupsCurrent() : Promise.resolve(null),
  ])
  if (pack.error) return { ok: false, why: pack.error }
  if (!ownedCopy(pack)) return { ok: false, why: `the pack in ${group} is not one this app installed from its own release` }
  let hosting: 'managed' | 'hybrid' | null = null
  if (groups) {
    const rec = groups.outcome === 'ok' ? groups.value?.find((x) => x.id === group) : undefined
    hosting = rec ? hostingOf(rec.onPrem, leaderHostname()) : null
    if (hosting === null) return { ok: false, why: `this app could not tell whether ${group} is Cribl-managed or hybrid, which decides the port range` }
  }
  const preview = await previewPackInput(group, packChange(change, hosting, generateToken()))
  if (!preview.ok) return { ok: false, why: preview.step.detail ?? 'the source could not be read' }
  if (preview.diff.length === 0) return { ok: false, why: 'nothing would change: the source is already that way' }
  return {
    ok: true,
    ctx: {
      group, change, diff: preview.diff, fromPort: pack.http?.port ?? null, hosting, scope: packCommitScope(group, pending),
      undeployed: opts.undeployed, undeployedChecking: opts.undeployedChecking,
    },
  }
}

const changeMessage = (group: string, change: SourceChange): string =>
  change.kind === 'token'
    ? `Gigamon AMI: rotate the auth token of ${PACK_HTTP_INPUT_ID} in ${group}`
    : change.kind === 'port'
      ? `Gigamon AMI: move ${PACK_HTTP_INPUT_ID} to port ${change.port} in ${group}`
      : `Gigamon AMI: ${change.enabled ? 'start' : 'stop'} ${PACK_SAMPLE_INPUT_ID} in ${group}`

/**
 * One source change: re-read that the pack is still this app's, ONE whole-body
 * PATCH held to the diff the dialog showed (packClient.ts sends nothing when
 * the live source no longer gives it), then commit the pack's files and
 * deploy — only after a write that answered `updated`. A rotation's token is
 * generated here and handed to `onToken` only then; it is in no step, log
 * entry or error text, and a failed rotation shows none.
 */
export async function runSourceChange(ctx: SourceChangeContext, dialog: SourceChangeDialog, io: SourceChangeIO): Promise<RunOutcome> {
  const steps: RunStep[] = []
  const step = (s: RunStep): RunStep => {
    steps.push(s)
    io.onStep(s)
    return s
  }
  const finish = (stopped: RunStep | null): RunOutcome => {
    void appendLog('gigamon', {
      action: 'onboarding_pack.configured',
      group: ctx.group,
      change: ctx.change.kind,
      outcome: steps.some((s) => s.action === 'error') ? 'error' : 'ok',
      steps: steps.map((s) => `${s.key}:${s.action}`),
    })
    return { steps, stopped, pack: null }
  }
  const g = ctx.group
  const now = await readPackState(g)
  if (!ownedCopy(now)) {
    return finish(step({
      key: 'precheck', label: labelOf('precheck'), action: 'error',
      detail: `Nothing was written: ${now.error ?? `the pack in ${g} is no longer one this app installed from its own release`}.`,
    }))
  }

  const change = ctx.change
  const token = change.kind === 'token' ? generateToken() : null
  const r: PackStep = change.kind === 'token'
    ? await setHttpToken(g, token as string, dialog.approved)
    : change.kind === 'port'
      ? await setSourcePort(g, change.port, ctx.hosting, dialog.approved)
      : await setSampleEnabled(g, change.enabled, dialog.approved)
  if (r.action === 'exists') {
    step(fromPack(r))
    step({ key: 'commit', label: labelOf('commit'), action: 'skipped', detail: `nothing changed in ${g}, so nothing was committed or deployed` })
    return finish(null)
  }
  if (r.action !== 'updated') return finish(step(fromPack(r, token !== null && r.sent ? `. ${ROTATE_FAILED}` : '')))
  step(fromPack(r))
  if (token !== null) io.onToken(token)

  const committed = await commitAndDeployPack(g, changeMessage(g, change), { wrote: true, record: io.record }, (c) => { step(fromCommit(c)) })
  const broken = committed.find((c) => c.action === 'error')
  return finish(broken ? steps.find((s) => s.key === broken.key && s.action === 'error') ?? null : null)
}
