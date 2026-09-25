// Guided Setup's panel for the global stacks earlier releases created: what is
// still in the picked worker group, and its confirmed removal.
//
// ── REMOVE ONLY (owner decision, 2026-09-25) ────────────────────────────────
//
// This panel used to be the Raw HTTP onboarding: a worker-group picker, a port
// picker, "Deploy onboarding stack" (cribl/provision.ts `deployAll`, which
// created the source, breaker ruleset, pipeline and route and committed and
// deployed them), and the "Point Gigamon AMX here" card with the token that
// run generated. It was THE onboarding whenever the pinned pack release could
// not be installed, and Remove-only once it could. The owner collapsed that
// onboarding into the pack's: the pack panel above (components/
// OnboardingPanel.tsx) is the only onboarding, and holds the page's picker; this
// one offers Remove and nothing else, whatever the release says.
//
// It renders only while an object of the global Raw HTTP stack
// (`in_gigamon_http`, `gigamon_ami_json_array`, `gigamon_http_normalize`,
// `gigamon_ami_http`) or of the Syslog stack before it (`in_gigamon_syslog`,
// `gigamon_syslog`, `gigamon_ami_syslog`) is in the group — or may be: a read
// not answered yet, or refused, counts as present, so a stack that exists is
// never hidden by a failed read (onboarding/plan.ts `provisionPanelMode`).
//
// WHAT IT DOES. It reads (GETs only; nothing on mount, render, a group change
// or a timer writes) the four Raw HTTP objects, the three Syslog ones, what Git
// reports uncommitted, and whether the group is behind a commit that touches
// it. "Remove …" opens a <ConfirmDialog> naming exactly the objects the status
// check found present, behind type-to-confirm on the group; its "Yes" runs
// `removeOnboardingStack`, which deletes only those, commits exactly their
// files and deploys. "Remove old Syslog objects" does the same for the Syslog
// stack alone, leaving the Raw HTTP source (and whatever exporter points at it)
// alone. Neither ever deletes the Lake dataset or the `gigamon_lake`
// destination. Both take the page's run lock (cribl/setupRunLock.ts).
//
// Every write is two-stage — an outer button that only opens a confirmation,
// and the "Yes, …" inside it that writes, which is a <GatedControl>. The outer
// buttons read the same gate, so a refusal closes them too.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog, type ConfirmResource } from './ConfirmDialog'
import { GateNote, GatedControl } from './GatedControl'
import { Panel } from './Panel'
import { StatusPill, type StatusState } from './StatusPill'
import { pushToast } from './Toast'
import { useWriteGate } from '../cribl/authz'
import { IS_INSTALLED } from '../cribl/config'
import {
  checkStatus, checkLegacyStatus, removeOnboardingStack, pendingDeploy, STEP_LABELS,
  commitScope, pendingConfigPaths, legacyOnly, HTTP_KEYS, LEGACY_KEYS,
  type SetupStatus, type LegacyStatus, type StepResult, type HttpKey, type CommitKey,
  type RemovalPresence,
  HTTP_SOURCE_ID, HTTP_PIPELINE_ID, HTTP_ROUTE_ID, HTTP_BREAKER_ID,
  LEGACY_SYSLOG_SOURCE_ID, LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID,
  LAKE_DESTINATION_ID, LAKE_DATASET_ID,
} from '../cribl/provision'
import {
  LEGACY_ONLY_LEAD, LEGACY_ONLY_TIP, LEGACY_TIP, REMOVE_UNDO, behindNote, behindTip, leftAloneSentence, legacyNote, removeConsequences,
} from './provisionPanelCopy'
import { InfoTip } from './InfoTip'
import { useSetupGroup } from './useSetupGroup'
import { provisionPanelMode } from '../cribl/onboarding/plan'
import { SETUP_RUN_BUSY, acquireSetupRun, useSetupRunHolder } from '../cribl/setupRunLock'
import { REMOVE_ONLY_LEAD, REMOVE_ONLY_TIP } from './onboardingCopy'
import { loadCommitMemory, updateCommitMemory, type CommitMemory, type CommitMemoryChange } from '../cribl/setupMemory'

interface ResourceMeta { key: HttpKey; label: string; detail: string }
/** The global Raw HTTP stack's four objects, one status row each. */
const RESOURCES: ResourceMeta[] = [
  { key: 'breaker', label: 'Event breaker', detail: `${HTTP_BREAKER_ID} · one event per JSON array record` },
  { key: 'pipeline', label: 'Pipeline', detail: `${HTTP_PIPELINE_ID} · normalize fields` },
  { key: 'source', label: 'Raw HTTP source', detail: `${HTTP_SOURCE_ID} · token auth` },
  { key: 'route', label: 'Route', detail: `${HTTP_ROUTE_ID} · scoped to the source → Lake` },
]

/** The undeployed-commit answer as a dialog saw it: `known` false while the
 *  check was still out. */
interface UndeployedAtOpen { known: boolean; hash: string | null }
const NOT_KNOWN: UndeployedAtOpen = { known: false, hash: null }

/** The two confirmations this screen can open, one at a time. */
type Confirming = 'remove' | 'remove-legacy'

/** How each old Syslog object is named when the teardown has to say it could
 *  not see it. */
const LEGACY_NAMES: Record<(typeof LEGACY_KEYS)[number], string> = {
  legacy_source: `Syslog source ${LEGACY_SYSLOG_SOURCE_ID}`,
  legacy_pipeline: `pipeline ${LEGACY_SYSLOG_PIPELINE_ID}`,
  legacy_route: `route ${LEGACY_SYSLOG_ROUTE_ID}`,
}
const HTTP_NAMES: Record<HttpKey, string> = {
  source: `Raw HTTP source ${HTTP_SOURCE_ID}`,
  pipeline: `pipeline ${HTTP_PIPELINE_ID}`,
  route: `route ${HTTP_ROUTE_ID}`,
  breaker: `event breaker ruleset ${HTTP_BREAKER_ID}`,
}

const ACTION_TXT: Record<string, string> = {
  created: 'created', updated: 'updated', exists: 'already present', error: 'failed', skipped: 'skipped',
}

export function ProvisionPanel() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<'remove' | null>(null)
  // Both writes on this screen are behind one of these, and only a button sets
  // them (AGENTS.md, "Confirming Destructive Operations"). One slot, so two
  // prompts about the same group can never be open at once.
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  // HEAD, when a commit this group has not deployed moves one of its files.
  // Read-only, and null when there is none or when it could not be determined.
  const [pending, setPending] = useState<string | null>(null)
  // What the open dialog says about it: the answer as it stood when the dialog
  // opened, so a late answer cannot change the dialog under its reader.
  const [pendingAtOpen, setPendingAtOpen] = useState<UndeployedAtOpen>(NOT_KNOWN)
  // What Git already reports uncommitted, so the confirmations can say what
  // rides along in the whole files the commit names. Null is "could not tell".
  const [pendingPaths, setPendingPaths] = useState<string[] | null>(null)
  // The Syslog stack an earlier release left in this group, if any. Null until
  // the first check lands, and when it failed.
  const [legacy, setLegacy] = useState<LegacyStatus | null>(null)
  // The page's one worker group, shared with every other Guided Setup panel
  // (./useSetupGroup.ts). The picker is the onboarding panel's; this panel
  // follows it.
  const { group, groupReady } = useSetupGroup()
  const removeGate = useWriteGate('onboarding_stack.remove')
  // The page's one run lock (cribl/setupRunLock.ts).
  const lockHolder = useSetupRunHolder()

  // Step logs and fatal errors, kept per worker group so switching groups shows
  // each group's last outcome.
  const [outcomes, setOutcomes] = useState<Record<string, { steps: StepResult[]; err: string | null }>>({})
  const steps = outcomes[group]?.steps ?? []
  const err = outcomes[group]?.err ?? null
  const appendStep = useCallback((gid: string, r: StepResult) => {
    setOutcomes((prev) => {
      const cur = prev[gid] ?? { steps: [], err: null }
      return { ...prev, [gid]: { ...cur, steps: [...cur.steps, r] } }
    })
  }, [])
  const resetOutcome = useCallback((gid: string) => {
    setOutcomes((prev) => ({ ...prev, [gid]: { steps: [], err: null } }))
  }, [])
  const setGroupErr = useCallback((gid: string, message: string | null) => {
    setOutcomes((prev) => {
      const cur = prev[gid] ?? { steps: [], err: null }
      return { ...prev, [gid]: { ...cur, err: message } }
    })
  }, [])

  // The last commit that touched each object, per group, from the app-scoped KV
  // store (setupMemory.ts). A removal drops the notes of what it deleted.
  const [commits, setCommits] = useState<CommitMemory>({})
  const commitByKey = commits[group] ?? {}
  /** Which `refresh()` may still set state; see there. */
  const refreshSeq = useRef(0)
  /** The undeployed-commit answer for the current refresh, read by openConfirm. */
  const pendingNow = useRef<UndeployedAtOpen>(NOT_KNOWN)
  // Every change is a read-merge-write of the stored document, in turn
  // (setupMemory.ts `updateCommitMemory`): the onboarding panel writes the same
  // document under its own key.
  const applyChange = useCallback(async (change: CommitMemoryChange) => {
    const { memory, saved } = await updateCommitMemory(change)
    setCommits(memory)
    if (!saved) {
      pushToast({ kind: 'error', text: 'Could not save the commit note to the app store — it will be gone after a reload.' })
    }
  }, [])
  const clearCommits = useCallback((gid: string, keys: CommitKey[]) => {
    if (!keys.length) return Promise.resolve()
    return applyChange({ group: gid, drop: keys })
  }, [applyChange])

  // ONE SEQUENCE FOR THE WHOLE REFRESH. Every answer below arrives after an
  // await, and by then the viewer may have picked another group — or pressed
  // Re-check again. Only the latest refresh sets anything, `loading` included.
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current
    const current = () => seq === refreshSeq.current
    pendingNow.current = NOT_KNOWN
    setLoading(true)
    try {
      // A side question, which the rows do not wait for; its own failure must
      // not blank them either.
      void pendingDeploy(group).catch(() => null).then((h) => {
        if (!current()) return
        pendingNow.current = { known: true, hash: h }
        setPending(h)
      })
      const [live, paths, old] = await Promise.all([
        checkStatus(group),
        pendingConfigPaths().catch(() => null),
        checkLegacyStatus(group).catch(() => null),
      ])
      if (!current()) return
      setStatus(live)
      setPendingPaths(paths)
      setLegacy(old)
    } catch (e) {
      if (current()) setGroupErr(group, (e as Error).message)
    } finally {
      if (current()) setLoading(false)
    }
  }, [group, setGroupErr])

  /**
   * Open one of the two confirmations, having first re-read what Git reports
   * uncommitted — the dialog says the list was read when it opened, and a list
   * from whenever the page last refreshed would make that untrue. The
   * undeployed-commit answer is captured as it stands, never awaited. A refresh
   * that starts while the Git read is out means the press was about a screen
   * that is gone, so nothing opens.
   */
  const openConfirm = useCallback(async (which: Confirming) => {
    const seq = refreshSeq.current
    const paths = await pendingConfigPaths().catch(() => null)
    if (seq !== refreshSeq.current) return
    setPendingPaths(paths)
    setPendingAtOpen(pendingNow.current)
    setConfirming(which)
  }, [])

  const populate = useCallback(async () => {
    setCommits(await loadCommitMemory())
    await refresh()
  }, [refresh])

  useEffect(() => {
    if (!groupReady) return
    // A confirmation names one group's objects, so a group change closes it.
    setConfirming(null)
    setPending(null)
    refreshSeq.current++
    pendingNow.current = NOT_KNOWN
    setStatus(null)
    setPendingPaths(null)
    setLegacy(null)
    void populate()
  }, [groupReady, populate])

  // A resource the platform refused to show us. Not "absent" — see
  // ResourceState in cribl/provision.ts.
  const unreadable = status ? RESOURCES.filter((r) => status[r.key] === 'unreadable') : []

  const errorByKey: Partial<Record<HttpKey, string>> = {}
  for (const s of steps) {
    if (RESOURCES.some((r) => r.key === s.key) && s.action === 'error') errorByKey[s.key as HttpKey] = s.detail || 'failed'
  }

  const httpPresent = status ? HTTP_KEYS.filter((k) => status[k] === 'present') : []
  const legacyPresent = legacy ? LEGACY_KEYS.filter((k) => legacy[k] === 'present') : []
  const onlyLegacy = httpPresent.length === 0 && legacyPresent.length > 0
  const removeBlocked = running !== null || lockHolder !== null || removeGate.denied !== null
  const busy = running !== null || lockHolder !== null ? SETUP_RUN_BUSY : null

  const removeKeys: CommitKey[] = [...httpPresent, ...legacyPresent]
  // WHAT THE TEARDOWN IS TOLD IS THERE — the same status the dialog is built
  // from, and it deletes only the keys that say `present`. An object this screen
  // could not read is neither listed nor deleted, and `leftAloneSentence` is
  // where the dialog says so.
  const presence: RemovalPresence = {
    ...Object.fromEntries(HTTP_KEYS.map((k) => [k, status?.[k] ?? 'unreadable'])),
    ...(legacy ?? {}),
  }
  const httpUnseen = HTTP_KEYS.filter((k) => status?.[k] === 'unreadable').map((k) => HTTP_NAMES[k])
  const legacyUnseen = LEGACY_KEYS.filter((k) => !legacy || legacy[k] === 'unreadable').map((k) => LEGACY_NAMES[k])
  const removeScope = commitScope(group, removeKeys, pendingPaths)
  const legacyScope = commitScope(group, legacyPresent, pendingPaths)
  const undeployedCtx = { undeployed: pendingAtOpen.hash, undeployedChecking: !pendingAtOpen.known }
  const withLeftAlone = (lines: string[], unseen: readonly string[]) => {
    const note = leftAloneSentence(group, unseen)
    return note ? [note, ...lines] : lines
  }
  const removeSentences = withLeftAlone(
    removeConsequences({ group, scope: removeScope, ...undeployedCtx }, LAKE_DESTINATION_ID, LAKE_DATASET_ID),
    [...httpUnseen, ...legacyUnseen],
  )
  const legacySentences = withLeftAlone(
    removeConsequences({ group, scope: legacyScope, ...undeployedCtx }, LAKE_DESTINATION_ID, LAKE_DATASET_ID),
    legacyUnseen,
  )

  // Only what is actually there.
  const routeDetail = `Removed from the routing table of ${group}. Every other route keeps its order.`
  const oldDetail = 'Created by an earlier release of this app, over Syslog.'
  const removeResources: ConfirmResource[] = [
    ...(status?.source === 'present'
      ? [{ action: 'delete' as const, kind: 'Raw HTTP source', id: HTTP_SOURCE_ID, group, detail: 'Gigamon AMX can no longer send to it, and its auth token goes with it.' }]
      : []),
    ...(status?.pipeline === 'present'
      ? [{ action: 'delete' as const, kind: 'Pipeline', id: HTTP_PIPELINE_ID, group }]
      : []),
    ...(status?.route === 'present'
      ? [{ action: 'delete' as const, kind: 'Route', id: HTTP_ROUTE_ID, group, detail: routeDetail }]
      : []),
    ...(status?.breaker === 'present'
      ? [{
          action: 'delete' as const, kind: 'Event breaker ruleset', id: HTTP_BREAKER_ID, group,
          detail: 'Only once its source is gone, only if it carries this app’s description, and only if no other source names it.',
        }]
      : []),
  ]
  const legacyResources: ConfirmResource[] = [
    ...(legacy?.legacy_source === 'present'
      ? [{ action: 'delete' as const, kind: 'Syslog source', id: LEGACY_SYSLOG_SOURCE_ID, group, detail: oldDetail }]
      : []),
    ...(legacy?.legacy_pipeline === 'present'
      ? [{ action: 'delete' as const, kind: 'Pipeline', id: LEGACY_SYSLOG_PIPELINE_ID, group, detail: oldDetail }]
      : []),
    ...(legacy?.legacy_route === 'present'
      ? [{ action: 'delete' as const, kind: 'Route', id: LEGACY_SYSLOG_ROUTE_ID, group, detail: `${oldDetail} ${routeDetail}` }]
      : []),
  ]

  // `scope` is which confirmation this came from: the whole teardown, or the
  // old Syslog objects alone, which must not take the Raw HTTP source with them.
  const onRemove = async (scope: 'all' | 'legacy') => {
    const gid = group
    const release = acquireSetupRun('onboarding_stack')
    if (!release) {
      setConfirming(null)
      setGroupErr(gid, `Nothing was written: ${SETUP_RUN_BUSY}`)
      return
    }
    setRunning('remove')
    resetOutcome(gid)
    setConfirming(null)
    try {
      const results = await removeOnboardingStack(
        (r) => appendStep(gid, r), gid, pushToast, scope === 'legacy' ? legacyOnly(presence) : presence,
      )
      // Removed objects no longer have a live config — drop their commit note.
      const removed = results
        .filter((s) => s.detail === 'deleted' && RESOURCES.some((x) => x.key === s.key))
        .map((s) => s.key as CommitKey)
      await clearCommits(gid, removed)
      await refresh()
    } catch (e) {
      setGroupErr(gid, (e as Error).message)
    } finally {
      setRunning(null)
      release()
    }
  }

  const globalPresence = status && legacy
    ? { http: HTTP_KEYS.some((k) => status[k] !== 'absent'), legacySyslog: LEGACY_KEYS.some((k) => legacy[k] !== 'absent') }
    : null
  // A run's step log stays on screen for the group it ran in, even when the run
  // removed the last object — otherwise the outcome of the press would vanish
  // with the panel.
  if (provisionPanelMode(globalPresence) === 'hidden' && steps.length === 0 && !err) return null

  return (
    <Panel
      title={onlyLegacy ? 'Syslog stack from an earlier release' : 'Raw HTTP stack created outside the pack'}
      note={<span className={`env-chip ${IS_INSTALLED ? 'env-installed' : 'env-dev'}`}>{IS_INSTALLED ? 'Cribl' : 'dev preview'}</span>}
    >
      {/* One lead line; the rest is behind the ⓘ. */}
      <p className="gs-intro">
        {onlyLegacy ? LEGACY_ONLY_LEAD : REMOVE_ONLY_LEAD}
        <InfoTip text={onlyLegacy ? LEGACY_ONLY_TIP : REMOVE_ONLY_TIP} />
      </p>

      <div className="gs-grid">
        <div className="gs-checklist">
          <div className="gs-checklist-head">
            <span>Objects in {group}</span>
            <button type="button" className="btn btn-ghost" onClick={() => void populate()} disabled={loading || running !== null}>
              {loading ? 'Checking…' : 'Re-check'}
            </button>
          </div>
          {RESOURCES.map((r) => {
            const present = status?.[r.key] === 'present'
            const unread = status?.[r.key] === 'unreadable'
            const rowErr = present ? errorByKey[r.key] : undefined
            const rc = commitByKey[r.key]
            const state: StatusState =
              rowErr ? 'failed'
                : present ? 'present'
                  : unread ? 'unreadable'
                    : loading ? 'checking'
                      : 'absent'
            return (
              <div key={r.key} className="gs-res-row">
                <StatusPill state={state} />
                <div className="gs-res-text">
                  <span className="gs-res-label">{r.label}</span>
                  <span className="gs-res-detail"><code>{r.detail}</code></span>
                  {rowErr && <span className="gs-res-error">{rowErr}</span>}
                  {unread && !rowErr && (
                    <span className="gs-res-skip">
                      Cribl refused the read, so this app cannot tell whether it exists — usually a permission.
                    </span>
                  )}
                  {rc && (
                    <span className="gs-res-commit" title={rc.message}>
                      last commit <code>#{rc.hash.slice(0, 10)}</code>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Two-stage: the outer buttons only open a confirmation; the "Yes, …"
            inside it writes. The outer buttons stay mounted while a dialog is
            open, which is what Escape and Cancel give focus back to. */}
        <div className="gs-actions">
          {unreadable.length > 0 && (
            <p className="gs-action-note gs-action-warn">
              Cribl refused to let this app read part of <code>{group}</code>{' '}
              ({unreadable.map((r) => r.label).join(', ')}), so the rows above are an incomplete
              picture. Remove deletes only what it could see; check the group in Cribl for the rest.
            </p>
          )}
          {pending && (
            <p className="gs-action-note gs-action-warn">
              {behindNote(group)}
              <InfoTip text={behindTip(group, pending)} />
            </p>
          )}
          {legacyPresent.length > 0 && !onlyLegacy && (
            <p className="gs-action-note">
              {legacyNote(group)}
              <InfoTip text={LEGACY_TIP} />
            </p>
          )}
          {removeKeys.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-danger-text"
                onClick={() => { if (removeBlocked) return; void openConfirm('remove') }}
                aria-disabled={removeBlocked || undefined}
                title={removeGate.reason ?? undefined}
              >
                {onlyLegacy ? 'Remove old Syslog stack' : 'Remove Raw HTTP stack'}
              </button>
              {/* Retiring the old feed on its own. Removing the whole stack to
                  get rid of it would also delete the Raw HTTP source — the token
                  and port an exporter may still be using. */}
              {!onlyLegacy && legacyPresent.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => { if (removeBlocked) return; void openConfirm('remove-legacy') }}
                  aria-disabled={removeBlocked || undefined}
                  title={removeGate.reason ?? undefined}
                >
                  Remove old Syslog objects
                </button>
              )}
            </>
          )}
          <GateNote write="onboarding_stack.remove" />
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirming === 'remove'}
        title={`Delete the Gigamon AMI objects an earlier release created in Cribl Stream worker group ${group}`}
        resources={[...removeResources, ...legacyResources]}
        irreversible={{
          why:
            `Deleting a source, a pipeline and a breaker ruleset cannot be undone from this app; the configuration is ` +
            `recoverable only from ${group}'s Git history.`,
        }}
        consequences={removeSentences}
        undo={REMOVE_UNDO}
        typeToConfirm={{ value: group, label: `To confirm, type the worker group name ${group}` }}
        onCancel={() => setConfirming(null)}
        confirm={
          <GatedControl
            write="onboarding_stack.remove"
            label={`Yes, delete from ${group}`}
            busyLabel="Removing…"
            className="btn btn-danger"
            unavailable={busy}
            run={() => onRemove('all')}
          />
        }
      />

      <ConfirmDialog
        isOpen={confirming === 'remove-legacy'}
        title={`Delete the old Syslog objects from Cribl Stream worker group ${group}`}
        resources={legacyResources}
        irreversible={{
          why: `Deleting a source and a pipeline cannot be undone from this app; they are recoverable only from ${group}'s Git history.`,
        }}
        consequences={legacySentences}
        undo="This app no longer creates the Syslog stack, so nothing here rebuilds it. The Raw HTTP source, its token and its port are not touched."
        typeToConfirm={{ value: group, label: `To confirm, type the worker group name ${group}` }}
        onCancel={() => setConfirming(null)}
        confirm={
          <GatedControl
            write="onboarding_stack.remove"
            label={`Yes, delete from ${group}`}
            busyLabel="Removing…"
            className="btn btn-danger"
            unavailable={busy}
            run={() => onRemove('legacy')}
          />
        }
      />

      {(steps.length > 0 || err) && (
        <div className="gs-steps">
          {steps.map((s, i) => (
            <div key={i} className={`gs-step gs-step-${s.action === 'error' ? 'err' : s.action === 'skipped' ? 'skip' : 'ok'}`}>
              <span className="gs-step-icon">{s.action === 'error' ? '✕' : s.action === 'skipped' ? '⤼' : '✓'}</span>
              <span className="gs-step-label">{STEP_LABELS[s.key] || s.key}</span>
              <span className="gs-step-action">{ACTION_TXT[s.action] || s.action}{s.detail ? ` — ${s.detail}` : ''}</span>
            </div>
          ))}
          {running && <div className="gs-step gs-step-run"><span className="gs-step-icon">…</span> working…</div>}
          {err && <div className="gs-step gs-step-err"><span className="gs-step-icon">✕</span> {err}</div>}
        </div>
      )}
    </Panel>
  )
}
