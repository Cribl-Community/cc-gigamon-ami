// Guided Setup's onboarding panel: the Gigamon AMI pack, installed and set up
// by one confirmed run, and removed by another.
//
// WHAT IT DOES, in the order a person meets it. It reads the picked group — the
// pack's state, the Lake datasets, the group's hosting and the ports other
// sources hold, and the scheduled searches — and shows one status row for each
// (GETs only; nothing on mount, render, a group change or a timer writes).
// Onboard reads everything the confirmation will claim (onboarding/run.ts
// `prepareOnboarding`, GETs only) and opens ONE <ConfirmDialog> built by
// onboarding/plan.ts `onboardingDialog`; the dialog's own "Yes" runs
// `runOnboarding` with exactly what it showed. Remove pack does the same with
// `packRemovalDialog` and `runPackRemoval`, behind type-to-confirm. Upgrade
// (an owned copy that is behind) opens `packUpgradeDialog` and runs
// `runPackUpgrade`, which reads the Raw HTTP source back and commits and
// deploys nothing when the upgrade reset it. The pack sources' own settings —
// Rotate token, Move port, Start and Stop sample data — each open
// `sourceChangeDialog` and run `runSourceChange`: one whole-body PATCH, then
// the commit and deploy. Every one of these takes the page's run lock. A Remove
// whose DELETE landed and whose commit did not leaves the pack gone and its
// removal in no commit; "Finish removing the pack" commits and deploys it
// (`finishRemovalDialog`, `finishPackRemoval`), from Git's own pending list.
//
// THIS BUILD INSTALLS 0.2.1 (released 2026-09-25; pack.ts `PACK_PUBLISHED`),
// so the panel always renders, holds the page's one worker-group picker, and
// is THE onboarding (onboarding/plan.ts `onboardingPath`); the Raw HTTP
// stack's panel below shows only while a global object of its stack is (or may
// be) in the group, and then offers Remove alone.
//
// IN A BUILD WHOSE PACK CANNOT BE INSTALLED (one that pins a version before its
// release, as this one pinned 0.2.1 until 2026-09-25), the panel still mounts, so its controls are in the
// source the gate scans read, but it renders only where there is something to
// show: in dev preview (the localhost page, and Cribl's Live Preview of the
// dev server — `IS_DEV_SERVER`), where the pack is already installed in the
// group, or where its removal is waiting to be committed. A panel that renders nothing
// reads nothing but the group's pack list and Git's pending files.
// Onboard is then refused with the release's own sentence, visibly, and
// nothing can send `POST /packs`: this control refuses, and packClient.ts
// `installPack` refuses again inside. An installed build with nothing
// installed shows no pack panel at all, and the Raw HTTP stack's panel below is
// the onboarding, as it always was.
//
// THE TOKEN is held in this component's state and nowhere else: set only by the
// onboarding run's or a rotation's `onToken`, shown once on the endpoint card, and dropped on a group
// change, a Remove that took the source, a remount and a reload. It never
// reaches a step, a toast, the diff, an error or the KV store.
//
// ONE PICKER PER PAGE. While the Raw HTTP stack is the onboarding (the pack is
// unavailable), that panel holds the picker and this one names the group; once
// the pack onboards, this panel holds it. Both read useSetupGroup(), so they
// can never disagree.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { GateNote, GatedControl } from './GatedControl'
import { InfoTip } from './InfoTip'
import { Panel } from './Panel'
import { StatusPill, type StatusState } from './StatusPill'
import { pushToast } from './Toast'
import { useSetupGroup } from './useSetupGroup'
import {
  NOT_SEEN_TIP, NOT_SEEN_YET, ONBOARDING_GROUP_TIP, ONBOARDING_LEAD, ONBOARDING_LEAD_TIP, ONBOARDING_PORT_TIP, PACK_ENDPOINT_TIP,
  PACK_TOKEN_ELSEWHERE, SAMPLE_LABEL, SAMPLE_START_REFUSAL, SAMPLE_TIP, SOURCE_SETTINGS_TIP, STATUS_LABELS, TOKEN_AFTER_ERROR,
  TOKEN_UNDEPLOYED,
  UPGRADE_TIP, accelStatusWords, datasetWords, finishRemovalNote, groupElsewhereNote, httpStatusWords, installedRefusal, onboardLabel,
  onboardNote, packStatusWords, removeTypeLabel,
} from './onboardingCopy'
import { AUTH_HEADER, ENDPOINT_LEAD, TOKEN_ONCE, UNENCRYPTED_WARNING } from './provisionPanelCopy'
import { MANIFEST } from '../cribl/accel/manifest'
import { readAccelState, type AccelState } from '../cribl/accel/provision'
import { useWriteGate } from '../cribl/authz'
import { IS_DEV_SERVER, IS_INSTALLED } from '../cribl/config'
import { datasetTarget } from '../cribl/datasetTarget'
import { listDatasets, listStreamGroupsCurrent, type LakeDataset } from '../cribl/lake'
import {
  finishRemovalDialog, httpActionOf, onboardingDialog, onboardingPath, packRemovalDialog, packUpgradeDialog, sourceChangeDialog,
  type FinishRemovalDialog, type OnboardingDialog, type OnboardingDialogContext, type RemovalDialog, type SourceChange,
  type SourceChangeContext, type SourceChangeDialog, type UpgradeDialog, type UpgradeDialogContext,
} from '../cribl/onboarding/plan'
import {
  finishPackRemoval, prepareOnboarding, prepareSourceChange, prepareUpgrade, runOnboarding, runPackRemoval, runPackUpgrade,
  runSourceChange, type RunStep,
} from '../cribl/onboarding/run'
import { PACK_HTTP_INPUT_ID, PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_VERSION } from '../cribl/pack'
import {
  PACK_COMMIT_KEY, compareVersions, packCommitScope, portsOfOthers, readPackState, thisPackRelease, type PackState,
} from '../cribl/packClient'
import {
  hostingOf, leaderHostname, pendingConfigPaths, pendingDeploy, portProblem, postUrl, suggestPort, suggestedIngressHost,
} from '../cribl/provision'
import { SETUP_RUN_BUSY, acquireSetupRun, useSetupRunHolder } from '../cribl/setupRunLock'
import { updateCommitMemory } from '../cribl/setupMemory'

type Hosting = 'managed' | 'hybrid' | null

/** What one refresh read for the picked group. */
interface PanelRead {
  pack: PackState
  /** Null when Cribl Lake's list could not be read. */
  datasets: LakeDataset[] | null
  hosting: Hosting
  /** Ports every other source in the group listens on; null = unreadable. */
  usedPorts: number[] | null
  accel: AccelState | null
  /** The pack's files Git reports uncommitted while the pack is NOT installed:
   *  a removal whose commit failed. Empty otherwise. */
  stranded: string[]
}

interface UndeployedAtOpen { known: boolean; hash: string | null }
const NOT_KNOWN: UndeployedAtOpen = { known: false, hash: null }

const ACTION_TXT: Record<string, string> = {
  created: 'created', updated: 'updated', deleted: 'deleted', exists: 'already in place', error: 'failed', skipped: 'skipped',
  refused: 'refused',
}

/** Counted over the rows this app would call its own schedules. */
function accelCounts(a: AccelState | null): { total: number; installed: number; running: number; error: string | null } {
  if (!a) return { total: MANIFEST.length, installed: 0, running: 0, error: 'not read' }
  const installed = a.rows.filter((r) => r.state === 'enabled' || r.state === 'paused' || r.state === 'differs')
  const running = installed.filter((r) => r.state === 'enabled' || (r.state === 'differs' && r.enabled !== false))
  return { total: MANIFEST.length, installed: installed.length, running: running.length, error: a.error }
}

/** The Raw HTTP source as read, or null. */
const http0 = (p: PackState | null): PackState['http'] => p?.http ?? null

/** The "Yes" inside a source change's confirmation. */
function confirmLabel(change: SourceChange): string {
  if (change.kind === 'token') return 'Yes, rotate the token'
  if (change.kind === 'port') return `Yes, move to port ${change.port}`
  return change.enabled ? 'Yes, start the sample data' : 'Yes, stop the sample data'
}

/** Whether the panel has anything to show (see the header): the pack can be
 *  installed, this is dev preview, the pack is in the group, or its removal is
 *  waiting to be committed. */
const hasSomethingToShow = (installable: boolean, pack: PackState, stranded: readonly string[]): boolean =>
  installable || !IS_INSTALLED || IS_DEV_SERVER || pack.installed || stranded.length > 0

export function OnboardingPanel() {
  const { group, groups, groupReady, pickGroup } = useSetupGroup()
  const release = thisPackRelease()
  const lockHolder = useSetupRunHolder()
  const installGate = useWriteGate('onboarding_pack.install')
  const removeGate = useWriteGate('onboarding_pack.remove')
  const upgradeGate = useWriteGate('onboarding_pack.upgrade')
  const configureGate = useWriteGate('onboarding_pack.configure')
  const refusalId = useId()
  const upgradeRefusalId = useId()
  const startRefusalId = useId()

  const [read, setRead] = useState<PanelRead | null>(null)
  const [loading, setLoading] = useState(true)
  const [readErr, setReadErr] = useState<string | null>(null)
  const [portText, setPortText] = useState('')
  // "Also send sample data": UNTICKED by default, and never remembered.
  const [sample, setSample] = useState(false)
  const [confirming, setConfirming] = useState<'onboard' | 'remove' | 'finish' | 'upgrade' | 'source' | null>(null)
  const [onboard, setOnboard] = useState<{ ctx: OnboardingDialogContext; dialog: OnboardingDialog } | null>(null)
  const [removal, setRemoval] = useState<RemovalDialog | null>(null)
  const [finishing, setFinishing] = useState<FinishRemovalDialog | null>(null)
  const [upgrading, setUpgrading] = useState<{ ctx: UpgradeDialogContext; dialog: UpgradeDialog } | null>(null)
  const [sourceChange, setSourceChange] = useState<{ ctx: SourceChangeContext; dialog: SourceChangeDialog } | null>(null)
  // The Raw HTTP source's next port, for Move port: offered free, never
  // overwritten while somebody types.
  const [movePortText, setMovePortText] = useState('')
  const [openErr, setOpenErr] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [running, setRunning] = useState<'onboard' | 'remove' | 'finish' | 'upgrade' | 'source' | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, RunStep[]>>({})
  const [token, setToken] = useState<{ group: string; value: string; afterError: boolean; undeployed?: boolean } | null>(null)
  const [copied, setCopied] = useState<'url' | 'token' | null>(null)
  const seq = useRef(0)
  const pendingNow = useRef<UndeployedAtOpen>(NOT_KNOWN)

  // Reads only. Only the latest refresh may set anything.
  //
  // In two rounds. The first — the pack list and Git's pending files — says
  // whether the panel has anything to show; a panel that renders nothing reads
  // nothing else (the Raw HTTP stack's and Acceleration's panels already read
  // the group's ports, the datasets and the saved searches).
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    const current = () => mine === seq.current
    pendingNow.current = NOT_KNOWN
    setLoading(true)
    setReadErr(null)
    try {
      const [pack, pending] = await Promise.all([readPackState(group), pendingConfigPaths().catch(() => null)])
      if (!current()) return
      const stranded = pack.installed || pack.error ? [] : packCommitScope(group, pending).alreadyDirty
      if (!hasSomethingToShow(thisPackRelease().installable, pack, stranded)) {
        setRead({ pack, datasets: null, hosting: null, usedPorts: null, accel: null, stranded })
        return
      }
      // Captured for the dialogs, never awaited by them (see ProvisionPanel).
      void pendingDeploy(group).catch(() => null).then((h) => {
        if (current()) pendingNow.current = { known: true, hash: h }
      })
      const [datasets, groupsNow, usedPorts, accel] = await Promise.all([
        listDatasets(),
        listStreamGroupsCurrent(),
        portsOfOthers(group).catch(() => null),
        readAccelState().catch(() => null),
      ])
      if (!current()) return
      const rec = groupsNow.outcome === 'ok' ? groupsNow.value?.find((x) => x.id === group) : undefined
      const hosting: Hosting = rec ? hostingOf(rec.onPrem, leaderHostname()) : null
      setRead({ pack, datasets: datasets.outcome === 'ok' ? datasets.value : null, hosting, usedPorts, accel, stranded })
      // Offer a free port, but never overwrite one somebody is typing.
      setPortText((cur) => cur || String(suggestPort(hosting !== 'hybrid', usedPorts) ?? ''))
      setMovePortText((cur) => cur || String(suggestPort(hosting !== 'hybrid', usedPorts) ?? ''))
    } catch (e) {
      if (current()) setReadErr((e as Error).message)
    } finally {
      if (current()) setLoading(false)
    }
  }, [group])

  useEffect(() => {
    if (!groupReady) return
    // A confirmation, a token and a half-typed port all belong to one group.
    setConfirming(null)
    setToken(null)
    setRead(null)
    setOpenErr(null)
    setPortText('')
    setMovePortText('')
    seq.current++
    void refresh()
  }, [groupReady, refresh])

  const pack = read?.pack ?? null
  const installed = pack?.installed === true
  const owned = installed && pack.published && pack.fromRelease
  const behind = owned && pack.version !== null && compareVersions(pack.version, PACK_VERSION) < 0
  const httpAction = installed ? httpActionOf(pack.http) : 'configure'
  const needsPort = httpAction === 'configure'
  const port = Number(portText)
  const portIssue = !needsPort || !read
    ? null
    : read.hosting === null
      ? `This app could not tell whether ${group} is Cribl-managed or hybrid, which decides the port range and TLS.`
      : portProblem(port, read.hosting === 'managed', read.usedPorts)

  // Why Onboard will not open, as the sentence the button points at.
  const onboardRefusal: string | null =
    !release.installable ? `Onboard is not available: ${release.refusal}.`
      : pack?.error ? `Onboard is not available: the group’s pack list could not be read (${pack.error}).`
        : installed && !pack.current ? installedRefusal({ version: pack.version, published: pack.published, fromRelease: pack.fromRelease, group })
          : null
  const busy = running !== null || lockHolder !== null ? SETUP_RUN_BUSY : null
  const onboardBlocked = onboardRefusal !== null || busy !== null || loading || opening || installGate.denied !== null ||
    (release.installable && portIssue !== null)
  const removeBlocked = busy !== null || removeGate.denied !== null || opening
  const stranded = !installed ? read?.stranded ?? [] : []

  // Upgrade: offered for an owned copy that is behind, and refused — visibly —
  // while this build records no release.
  const upgradeRefusal = !release.installable ? `Upgrade to ${PACK_VERSION} is not available: ${release.refusal}.` : null
  const upgradeBlocked = upgradeRefusal !== null || busy !== null || upgradeGate.denied !== null || opening || loading

  // The pack sources' own settings: only on this app's copy, and only on a
  // source there is to change (a Raw HTTP source that onboarding has not given
  // a token yet is Finish onboarding's, not these controls').
  const canRotate = owned && http0(pack) !== null && http0(pack)!.tokenSet
  const sampleNow = owned ? pack.sample : null
  const sourceBlocked = busy !== null || configureGate.denied !== null || opening || loading
  const movePort = Number(movePortText)
  const movePortIssue = !canRotate || !read
    ? null
    : read.hosting === null
      ? `This app could not tell whether ${group} is Cribl-managed or hybrid, which decides the port range.`
      : movePort === http0(pack)?.port
        ? `${PACK_HTTP_INPUT_ID} already listens on ${movePort}.`
        : portProblem(movePort, read.hosting === 'managed', read.usedPorts)
  const sampleDatasetKnownAbsent = read !== null && read.datasets !== null &&
    !read.datasets.some((d) => d.id === PACK_SAMPLE_DATASET_ID && d.deletionStartedAt === null)
  const startRefusal = sampleNow?.disabled && sampleDatasetKnownAbsent ? SAMPLE_START_REFUSAL : null

  // Rendered only where there is something to show — see the header.
  const visible = release.installable || !IS_INSTALLED || IS_DEV_SERVER || installed || stranded.length > 0
  const holdsPicker = onboardingPath(release, null).mode === 'pack'

  const openOnboard = async () => {
    if (onboardBlocked) return
    const mine = seq.current
    setOpening(true)
    setOpenErr(null)
    try {
      const r = await prepareOnboarding(group, {
        sample, port, target: datasetTarget(),
        undeployed: pendingNow.current.hash, undeployedChecking: !pendingNow.current.known,
      })
      if (mine !== seq.current) return
      if (!r.ok) {
        setOpenErr(`The confirmation did not open: ${r.why}.`)
        return
      }
      setOnboard({ ctx: r.ctx, dialog: onboardingDialog(r.ctx) })
      setConfirming('onboard')
    } finally {
      setOpening(false)
    }
  }

  const appendStep = (gid: string, s: RunStep) => setOutcomes((prev) => ({ ...prev, [gid]: [...(prev[gid] ?? []), s] }))
  const record = (gid: string) => (hash: string, message: string) =>
    updateCommitMemory({ group: gid, set: { [PACK_COMMIT_KEY]: { hash, message } } })

  // Reached only from the "Yes" inside the Onboard confirmation.
  const onOnboard = async () => {
    const shown = onboard
    if (!shown) return
    const gid = shown.ctx.group
    const unlock = acquireSetupRun('onboarding_pack')
    setConfirming(null)
    if (!unlock) {
      setOpenErr(`Nothing was written: ${SETUP_RUN_BUSY}`)
      return
    }
    setRunning('onboard')
    setOutcomes((prev) => ({ ...prev, [gid]: [] }))
    try {
      const out = await runOnboarding(shown.ctx, shown.dialog, {
        onStep: (s) => appendStep(gid, s),
        onToken: (value, afterError) => setToken({ group: gid, value, afterError }),
        record: record(gid),
        target: () => datasetTarget(),
      })
      pushToast(out.stopped
        ? { kind: 'error', text: `Onboarding stopped at “${out.stopped.label}”. The step list says what was done.` }
        : { kind: 'done', text: `Onboarded Gigamon AMI in ${gid}.` })
      await refresh()
    } catch (e) {
      appendStep(gid, { key: 'run', label: 'Onboarding', action: 'error', detail: (e as Error).message })
    } finally {
      setRunning(null)
      unlock()
    }
  }

  const openRemove = async () => {
    if (removeBlocked) return
    const mine = seq.current
    setOpening(true)
    setOpenErr(null)
    try {
      const [fresh, paths] = await Promise.all([readPackState(group), pendingConfigPaths().catch(() => null)])
      if (mine !== seq.current) return
      if (!fresh.installed || !fresh.published || !fresh.fromRelease) {
        setOpenErr('The confirmation did not open: the pack in this group is no longer one this app installed.')
        void refresh()
        return
      }
      setRemoval(packRemovalDialog({
        group, version: fresh.version, scope: packCommitScope(group, paths),
        undeployed: pendingNow.current.hash, undeployedChecking: !pendingNow.current.known,
      }))
      setConfirming('remove')
    } finally {
      setOpening(false)
    }
  }

  // A removal whose commit failed: the files, as Git reports them now.
  const openFinish = async () => {
    if (removeBlocked) return
    const mine = seq.current
    setOpening(true)
    setOpenErr(null)
    try {
      const [fresh, paths] = await Promise.all([readPackState(group), pendingConfigPaths().catch(() => null)])
      if (mine !== seq.current) return
      const scope = packCommitScope(group, paths)
      if (fresh.error || fresh.installed || scope.alreadyDirty.length === 0) {
        setOpenErr('The confirmation did not open: the pack’s removal is no longer waiting to be committed here.')
        void refresh()
        return
      }
      setFinishing(finishRemovalDialog({
        group, files: scope.alreadyDirty, scope,
        undeployed: pendingNow.current.hash, undeployedChecking: !pendingNow.current.known,
      }))
      setConfirming('finish')
    } finally {
      setOpening(false)
    }
  }

  // Reached only from the "Yes" inside the Finish confirmation.
  const onFinish = async () => {
    const gid = group
    const unlock = acquireSetupRun('onboarding_pack')
    setConfirming(null)
    if (!unlock) {
      setOpenErr(`Nothing was written: ${SETUP_RUN_BUSY}`)
      return
    }
    setRunning('finish')
    setOutcomes((prev) => ({ ...prev, [gid]: [] }))
    try {
      const out = await finishPackRemoval(gid, { onStep: (s) => appendStep(gid, s), record: record(gid) })
      pushToast(out.stopped
        ? { kind: 'error', text: `Finishing the removal stopped at “${out.stopped.label}”. The step list says what was done.` }
        : { kind: 'done', text: `The pack’s removal from ${gid} is committed and deployed.` })
      await refresh()
    } catch (e) {
      appendStep(gid, { key: 'run', label: 'Finish removing the pack', action: 'error', detail: (e as Error).message })
    } finally {
      setRunning(null)
      unlock()
    }
  }

  // Reached only from the "Yes" inside the Remove confirmation.
  const onRemove = async () => {
    const gid = group
    const unlock = acquireSetupRun('onboarding_pack')
    setConfirming(null)
    if (!unlock) {
      setOpenErr(`Nothing was written: ${SETUP_RUN_BUSY}`)
      return
    }
    setRunning('remove')
    setOutcomes((prev) => ({ ...prev, [gid]: [] }))
    try {
      const out = await runPackRemoval(gid, {
        onStep: (s) => appendStep(gid, s),
        record: record(gid),
        onSourcesGone: () => setToken((t) => (t?.group === gid ? null : t)),
      })
      pushToast(out.stopped
        ? { kind: 'error', text: `Removing the pack stopped at “${out.stopped.label}”. The step list says what was done.` }
        : { kind: 'done', text: `Removed the Gigamon AMI pack from ${gid}.` })
      await refresh()
    } catch (e) {
      appendStep(gid, { key: 'run', label: 'Remove pack', action: 'error', detail: (e as Error).message })
    } finally {
      setRunning(null)
      unlock()
    }
  }

  const openUpgrade = async () => {
    if (upgradeBlocked) return
    const mine = seq.current
    setOpening(true)
    setOpenErr(null)
    try {
      const r = await prepareUpgrade(group, { undeployed: pendingNow.current.hash, undeployedChecking: !pendingNow.current.known })
      if (mine !== seq.current) return
      if (!r.ok) {
        setOpenErr(`The confirmation did not open: ${r.why}.`)
        return
      }
      setUpgrading({ ctx: r.ctx, dialog: packUpgradeDialog(r.ctx) })
      setConfirming('upgrade')
    } finally {
      setOpening(false)
    }
  }

  // Reached only from the "Yes" inside the Upgrade confirmation.
  const onUpgrade = async () => {
    const shown = upgrading
    if (!shown) return
    const gid = shown.ctx.group
    const unlock = acquireSetupRun('onboarding_pack')
    setConfirming(null)
    if (!unlock) {
      setOpenErr(`Nothing was written: ${SETUP_RUN_BUSY}`)
      return
    }
    setRunning('upgrade')
    setOutcomes((prev) => ({ ...prev, [gid]: [] }))
    try {
      const out = await runPackUpgrade(shown.ctx, shown.dialog, { onStep: (s) => appendStep(gid, s), record: record(gid) })
      pushToast(out.stopped
        ? { kind: 'error', text: `The upgrade stopped at “${out.stopped.label}”. The step list says what was done.` }
        : { kind: 'done', text: `Upgraded the Gigamon AMI pack in ${gid} to ${shown.ctx.release.version}.` })
      await refresh()
    } catch (e) {
      appendStep(gid, { key: 'run', label: 'Upgrade', action: 'error', detail: (e as Error).message })
    } finally {
      setRunning(null)
      unlock()
    }
  }

  const openSource = async (change: SourceChange) => {
    if (sourceBlocked) return
    if (change.kind === 'port' && movePortIssue !== null) return
    if (change.kind === 'sample' && change.enabled && startRefusal !== null) return
    const mine = seq.current
    setOpening(true)
    setOpenErr(null)
    try {
      const r = await prepareSourceChange(group, change, { undeployed: pendingNow.current.hash, undeployedChecking: !pendingNow.current.known })
      if (mine !== seq.current) return
      if (!r.ok) {
        setOpenErr(`The confirmation did not open: ${r.why}.`)
        return
      }
      setSourceChange({ ctx: r.ctx, dialog: sourceChangeDialog(r.ctx) })
      setConfirming('source')
    } finally {
      setOpening(false)
    }
  }

  // Reached only from the "Yes" inside a source change's confirmation.
  const onSource = async () => {
    const shown = sourceChange
    if (!shown) return
    const gid = shown.ctx.group
    const unlock = acquireSetupRun('onboarding_pack')
    setConfirming(null)
    if (!unlock) {
      setOpenErr(`Nothing was written: ${SETUP_RUN_BUSY}`)
      return
    }
    setRunning('source')
    setOutcomes((prev) => ({ ...prev, [gid]: [] }))
    try {
      const out = await runSourceChange(shown.ctx, shown.dialog, {
        onStep: (s) => appendStep(gid, s),
        onToken: (value, undeployed) => setToken({ group: gid, value, afterError: false, undeployed }),
        record: record(gid),
      })
      pushToast(out.stopped
        ? { kind: 'error', text: `“${shown.dialog.title}” stopped at “${out.stopped.label}”. The step list says what was done.` }
        : { kind: 'done', text: `${shown.dialog.title}: done.` })
      await refresh()
    } catch (e) {
      appendStep(gid, { key: 'run', label: shown.dialog.title, action: 'error', detail: (e as Error).message })
    } finally {
      setRunning(null)
      unlock()
    }
  }

  if (!visible) return null

  const steps = outcomes[group] ?? []
  const shownToken = token?.group === group ? token : null
  const http = pack?.http ?? null
  const host = suggestedIngressHost(group, read?.hosting !== 'hybrid')
  const url = http?.port == null ? null : postUrl(host ?? '<worker-ingress-host>', http.port, http.tls)
  // The card shows for a running source, OR for a token this panel still holds:
  // the token is shown once, so whatever should hide it (a group change, a
  // Remove that took the source) has to drop the token itself — the card
  // disappearing with the pack is not the same as the secret being gone.
  const showCard = shownToken !== null || (installed && http !== null && !http.disabled)
  const copy = (what: 'url' | 'token', text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const listed = (id: string) => read?.datasets?.find((d) => d.id === id && d.deletionStartedAt === null) ?? null
  const datasetIds = [PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, ...(sample || listed(PACK_SAMPLE_DATASET_ID) ? [PACK_SAMPLE_DATASET_ID] : [])]
  const pending: StatusState = 'checking'
  const packState: StatusState = loading && !pack ? pending
    : !pack || pack.error ? 'unreadable' : !installed ? 'absent' : pack.current ? 'present' : 'differs'
  const httpState: StatusState = loading && !pack ? pending
    : !http ? 'absent' : http.disabled || !http.tokenSet ? 'paused' : 'enabled'
  const sampleState: StatusState = loading && !pack ? pending
    : !pack?.sample ? 'absent' : pack.sample.disabled ? 'paused' : 'enabled'
  const counts = accelCounts(read?.accel ?? null)
  const accelState: StatusState = loading && !read ? pending
    : counts.error ? 'unreadable' : counts.installed === 0 ? 'absent' : counts.running === 0 ? 'paused' : 'enabled'

  const row = (key: string, state: StatusState, label: string, detail: string) => (
    <div key={key} className="gs-res-row">
      <StatusPill state={state} />
      <div className="gs-res-text">
        <span className="gs-res-label">{label}</span>
        <span className="gs-res-detail"><code>{detail}</code></span>
      </div>
    </div>
  )

  return (
    <>
      <Panel
        title="Onboard Gigamon AMI with the pack"
        note={<span className={`env-chip ${IS_INSTALLED ? 'env-installed' : 'env-dev'}`}>{IS_INSTALLED ? 'Cribl' : 'dev preview'}</span>}
      >
        <p className="gs-intro">
          {ONBOARDING_LEAD}
          <InfoTip text={ONBOARDING_LEAD_TIP} />
        </p>

        {holdsPicker ? (
          <div className="gs-group-picker">
            <label htmlFor="gs-onb-group-select" className="gs-group-label">Worker group</label>
            <InfoTip text={ONBOARDING_GROUP_TIP} />
            <select
              id="gs-onb-group-select"
              className="gs-group-select"
              value={group}
              disabled={running !== null}
              onChange={(e) => void pickGroup(e.target.value)}
            >
              {!groups.some((gr) => gr.id === group) && <option value={group}>{group}</option>}
              {groups.map((gr) => (
                <option key={gr.id} value={gr.id}>{gr.name === gr.id ? gr.id : `${gr.name} (${gr.id})`}</option>
              ))}
            </select>
          </div>
        ) : (
          <p className="gs-note">{groupElsewhereNote(group)}</p>
        )}

        {needsPort && release.installable && (
          <div className="gs-port-picker">
            <label htmlFor="gs-onb-port" className="gs-group-label">Source port</label>
            <InfoTip text={ONBOARDING_PORT_TIP} />
            <input
              id="gs-onb-port"
              className="gs-group-select gs-port-input"
              inputMode="numeric"
              value={portText}
              disabled={running !== null}
              aria-invalid={portIssue !== null || undefined}
              aria-describedby={portIssue ? 'gs-onb-port-issue' : undefined}
              onChange={(e) => setPortText(e.target.value.trim())}
            />
            {portIssue && <span id="gs-onb-port-issue" className="gs-res-error">{portIssue}</span>}
          </div>
        )}

        <div className="gs-port-picker">
          <input
            id="gs-onb-sample"
            type="checkbox"
            checked={sample}
            disabled={running !== null}
            onChange={(e) => setSample(e.target.checked)}
          />
          <label htmlFor="gs-onb-sample" className="gs-group-label">{SAMPLE_LABEL}</label>
          <InfoTip text={SAMPLE_TIP} />
        </div>

        <div className="gs-grid">
          <div className="gs-checklist">
            <div className="gs-checklist-head">
              <span>Status</span>
              <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={loading || running !== null}>
                {loading ? 'Checking…' : 'Re-check'}
              </button>
            </div>
            {row('pack', packState, STATUS_LABELS.pack, pack ? packStatusWords(pack) : 'checking')}
            {datasetIds.map((id) => row(
              `ds-${id}`,
              loading && !read ? pending : read?.datasets === null ? 'unreadable' : listed(id) ? 'present' : 'absent',
              STATUS_LABELS.datasets,
              read?.datasets === null ? `${id} · could not be read` : datasetWords(id, listed(id)),
            ))}
            {row('http', httpState, STATUS_LABELS.http, httpStatusWords(http))}
            {row('sample', sampleState, STATUS_LABELS.sample, !pack?.sample ? 'not installed' : pack.sample.disabled ? 'off' : 'on')}
            {row('accel', accelState, STATUS_LABELS.accel, accelStatusWords(counts))}
            {readErr && <span className="gs-res-error">{readErr}</span>}
          </div>

          <div className="gs-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void openOnboard()}
              aria-disabled={onboardBlocked || undefined}
              aria-describedby={onboardRefusal ? refusalId : undefined}
            >
              {running === 'onboard' ? 'Onboarding…' : opening ? 'Reading…' : onboardLabel({ installed, httpNeedsWork: httpAction !== 'none' })}
            </button>
            {onboardRefusal && <p id={refusalId} className="gs-action-note">{onboardRefusal}</p>}
            <GateNote write="onboarding_pack.install" />
            {openErr && <p className="gs-action-note gs-action-warn">{openErr}</p>}
            {!onboardRefusal && <p className="gs-action-note">{onboardNote(group)}</p>}
            {behind && (
              <>
                <span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void openUpgrade()}
                    aria-disabled={upgradeBlocked || undefined}
                    aria-describedby={upgradeRefusal ? upgradeRefusalId : undefined}
                  >
                    {running === 'upgrade' ? 'Upgrading…' : `Upgrade to ${PACK_VERSION}`}
                  </button>
                  <InfoTip text={UPGRADE_TIP} />
                </span>
                {upgradeRefusal && <p id={upgradeRefusalId} className="gs-action-note">{upgradeRefusal}</p>}
                <GateNote write="onboarding_pack.upgrade" />
              </>
            )}
            {(canRotate || sampleNow !== null) && (
              <div role="group" aria-labelledby="gs-onb-source-head">
                <div className="gs-checklist-head">
                  <span id="gs-onb-source-head">Source settings</span>
                  <InfoTip text={SOURCE_SETTINGS_TIP} />
                </div>
                {canRotate && (
                  <>
                    <button type="button" className="btn btn-ghost" onClick={() => void openSource({ kind: 'token' })} aria-disabled={sourceBlocked || undefined}>
                      Rotate token
                    </button>
                    <div className="gs-port-picker">
                      <label htmlFor="gs-onb-move-port" className="gs-group-label">New port</label>
                      <input
                        id="gs-onb-move-port"
                        className="gs-group-select gs-port-input"
                        inputMode="numeric"
                        value={movePortText}
                        disabled={running !== null}
                        aria-invalid={movePortIssue !== null || undefined}
                        aria-describedby={movePortIssue ? 'gs-onb-move-port-issue' : undefined}
                        onChange={(e) => setMovePortText(e.target.value.trim())}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void openSource({ kind: 'port', port: movePort })}
                        aria-disabled={sourceBlocked || movePortIssue !== null || undefined}
                      >
                        Move port
                      </button>
                      {movePortIssue && <span id="gs-onb-move-port-issue" className="gs-res-error">{movePortIssue}</span>}
                    </div>
                  </>
                )}
                {sampleNow !== null && (sampleNow.disabled ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void openSource({ kind: 'sample', enabled: true })}
                      aria-disabled={sourceBlocked || startRefusal !== null || undefined}
                      aria-describedby={startRefusal ? startRefusalId : undefined}
                    >
                      Start sample data
                    </button>
                    {startRefusal && <p id={startRefusalId} className="gs-action-note">{startRefusal}</p>}
                  </>
                ) : (
                  <button type="button" className="btn btn-ghost" onClick={() => void openSource({ kind: 'sample', enabled: false })} aria-disabled={sourceBlocked || undefined}>
                    Stop sample data
                  </button>
                ))}
                <GateNote write="onboarding_pack.configure" />
              </div>
            )}
            {owned && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => void openRemove()}
                  aria-disabled={removeBlocked || undefined}
                >
                  Remove pack
                </button>
                <GateNote write="onboarding_pack.remove" />
              </>
            )}
            {stranded.length > 0 && (
              <>
                <p className="gs-action-note gs-action-warn">{finishRemovalNote(group)}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void openFinish()}
                  aria-disabled={removeBlocked || undefined}
                >
                  {running === 'finish' ? 'Committing…' : 'Finish removing the pack'}
                </button>
                <GateNote write="onboarding_pack.remove" />
              </>
            )}
          </div>
        </div>

        <ConfirmDialog
          isOpen={confirming === 'onboard' && onboard !== null}
          title={onboard?.dialog.title ?? ''}
          resources={onboard?.dialog.resources ?? []}
          diff={onboard?.dialog.diff ?? []}
          costLine={onboard?.dialog.costLine}
          consequences={onboard?.dialog.consequences}
          undo={onboard?.dialog.undo}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="onboarding_pack.install"
              label={`Yes, onboard in ${onboard?.ctx.group ?? group}`}
              busyLabel="Onboarding…"
              unavailable={busy}
              run={onOnboard}
            />
          }
        />

        <ConfirmDialog
          isOpen={confirming === 'remove' && removal !== null}
          title={removal?.title ?? ''}
          resources={removal?.resources ?? []}
          irreversible={removal?.irreversible}
          consequences={removal?.consequences}
          undo={removal?.undo}
          typeToConfirm={{ value: group, label: removeTypeLabel(group) }}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="onboarding_pack.remove"
              label={`Yes, remove from ${group}`}
              busyLabel="Removing…"
              className="btn btn-danger"
              unavailable={busy}
              run={onRemove}
            />
          }
        />

        <ConfirmDialog
          isOpen={confirming === 'finish' && finishing !== null}
          title={finishing?.title ?? ''}
          resources={finishing?.resources ?? []}
          consequences={finishing?.consequences}
          undo={finishing?.undo}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="onboarding_pack.remove"
              label={`Yes, commit and deploy ${group}`}
              busyLabel="Committing…"
              unavailable={busy}
              run={onFinish}
            />
          }
        />

        <ConfirmDialog
          isOpen={confirming === 'upgrade' && upgrading !== null}
          title={upgrading?.dialog.title ?? ''}
          resources={upgrading?.dialog.resources ?? []}
          consequences={upgrading?.dialog.consequences}
          undo={upgrading?.dialog.undo}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="onboarding_pack.upgrade"
              label={`Yes, upgrade in ${upgrading?.ctx.group ?? group}`}
              busyLabel="Upgrading…"
              unavailable={busy}
              run={onUpgrade}
            />
          }
        />

        <ConfirmDialog
          isOpen={confirming === 'source' && sourceChange !== null}
          title={sourceChange?.dialog.title ?? ''}
          resources={sourceChange?.dialog.resources ?? []}
          diff={sourceChange?.dialog.diff ?? []}
          costLine={sourceChange?.dialog.costLine}
          consequences={sourceChange?.dialog.consequences}
          undo={sourceChange?.dialog.undo}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="onboarding_pack.configure"
              label={sourceChange ? confirmLabel(sourceChange.ctx.change) : ''}
              busyLabel="Working…"
              unavailable={busy}
              run={onSource}
            />
          }
        />

        {steps.length > 0 && (
          <div className="gs-steps">
            {steps.map((s, i) => (
              <div key={i} className={`gs-step gs-step-${s.action === 'error' || s.action === 'refused' ? 'err' : s.action === 'skipped' ? 'skip' : 'ok'}`}>
                <span className="gs-step-icon">{s.action === 'error' || s.action === 'refused' ? '✕' : s.action === 'skipped' ? '⤼' : s.warning ? '!' : '✓'}</span>
                <span className="gs-step-label">{s.label}</span>
                <span className="gs-step-action">{ACTION_TXT[s.action] ?? s.action}{s.detail ? ` — ${s.detail}` : ''}</span>
              </div>
            ))}
            {running && <div className="gs-step gs-step-run"><span className="gs-step-icon">…</span> working…</div>}
          </div>
        )}
      </Panel>

      {showCard && (
        <Panel title="Point Gigamon AMX here" tourId="gs-pack-endpoint">
          <p className="gs-intro">
            {ENDPOINT_LEAD}
            <InfoTip text={PACK_ENDPOINT_TIP} />
          </p>
          <div className="gs-endpoint">
            <div className="gs-endpoint-main">
              <code className="gs-endpoint-addr">{url ?? 'This app could not read the source’s port.'}</code>
              {url && (
                <button type="button" className="btn btn-ghost" onClick={() => copy('url', url)}>
                  {copied === 'url' ? 'Copied ✓' : 'Copy'}
                </button>
              )}
            </div>
            {shownToken ? (
              <div className="gs-endpoint-main">
                <code className="gs-endpoint-addr" aria-label="Auth token">{shownToken.value}</code>
                <button type="button" className="btn btn-ghost" onClick={() => copy('token', shownToken.value)}>
                  {copied === 'token' ? 'Copied ✓' : 'Copy token'}
                </button>
              </div>
            ) : null}
            {shownToken?.afterError && <p className="gs-action-note gs-action-warn">{TOKEN_AFTER_ERROR}</p>}
            {shownToken?.undeployed && <p className="gs-action-note gs-action-warn">{TOKEN_UNDEPLOYED}</p>}
            <p className="gs-note">{shownToken ? TOKEN_ONCE : PACK_TOKEN_ELSEWHERE}</p>
            <div className="gs-endpoint-meta">
              <span><strong>Method</strong> POST</span>
              <span><strong>Header</strong> <code>{AUTH_HEADER}</code></span>
              <span><strong>Port</strong> {http?.port ?? 'unknown'}</span>
              <span><strong>Format</strong> JSON array</span>
              <span><strong>Lands in</strong> Cribl Lake · <code>{PACK_LAKE_DATASET_ID}</code></span>
            </div>
          </div>
          {http && !http.tls && <p className="gs-action-note gs-action-warn">{UNENCRYPTED_WARNING}</p>}
          {http && !http.disabled && (
            <p className="gs-note">
              {NOT_SEEN_YET}
              <InfoTip text={NOT_SEEN_TIP} />
            </p>
          )}
          {!host && (
            <p className="gs-note">
              Replace <code>&lt;worker-ingress-host&gt;</code> with the address of {group}’s workers.
            </p>
          )}
        </Panel>
      )}
    </>
  )
}
