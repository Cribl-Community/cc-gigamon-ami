// Guided Setup's stateful half: the screen that reads a worker group's
// configuration and is the only place in this app that writes to one.
//
// WHERE THE SEAM ACTUALLY FALLS, which is not where the file's shape suggests.
// GuidedSetup.tsx was 661 lines doing five jobs — pick a worker group, check
// status, provision, tear down, report — and the tempting extraction is a
// presentational <ProvisionPanel> fed by a tab that keeps the state. That
// version was counted before it was written. It needs `group`, `groups`,
// `status`, `loading`, `running`, `confirming`, `pending`, `steps`, `err`,
// `commitByKey`, `allPresent`, `partial`, `unreadable`, `pickGroup`,
// `populate`, `setConfirming`, `onDeploy` and `onRemove`: eighteen props, which
// is the same function with a longer signature and a second file to keep in
// sync with it.
//
// So the state moved WITH the markup and the direction reversed — this
// component is the stateful one and the tab is the presentational one. What the
// tab kept is what genuinely reads nothing: the "What gets created" reference
// list, which is four ids and prose, and <SearchLimitsPanel>, which is an
// install-wide search setting that was never part of provisioning and only
// shares the page. Measured rather than asserted: no useState value and no
// derived local in this file is referenced by anything left behind.
//
// WHY THE ENDPOINT PANEL CAME WITH IT. "Point Gigamon AMX here" renders only
// when every resource is present, and that is `allPresent`, derived from
// `status`. Leaving it in the tab meant lifting one boolean back out through a
// callback and mirroring it in tab state — a second copy of a value this file
// already holds, arriving an effect later and able to disagree with it in
// between. Moving the panel instead makes the prop count zero in both
// directions. It is also the next step in the same flow: provision the stack,
// then point the exporter at the port it opened.
//
// WHAT THIS DOES NOT DO, said here rather than left to be discovered. It is one
// component doing four of the five jobs, and it is long. That is not half an
// extraction; it is the shape of the state. `group` is read by the status
// check, the commit memory, both confirmations and every label on the screen;
// `status` is read by the checklist, both confirmations and the endpoint panel;
// `running` is read by the picker, the re-check button, both outer buttons,
// both confirm buttons and the step log. There is no line through this render
// that does not cut one of them, so a second component here would be the
// eighteen-prop version again, one level down.
//
// The next honest seam is not a component at all but two hooks, neither of
// which touches the other: `useSetupGroup` (the picker, its KV memory and the
// `groupReady` gate) and `useGroupOutcomes` (the per-group step log, the fatal
// error and the commit ref mirror). Both are a follow-up, and neither is
// something to smuggle into a move.
//
// NOTHING BELOW CHANGED BEHAVIOUR. Every line is the line that was in
// GuidedSetup.tsx, comments included. The three the tab carried about per-group
// outcomes, the ref-mirrored commit memory and the deferred first status check
// are precisely why this had to be a verbatim move rather than a tidy-up.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog, type ConfirmResource } from './ConfirmDialog'
import { GateNote, GatedControl } from './GatedControl'
import { Panel } from './Panel'
import { StatusPill, type StatusState } from './StatusPill'
import { pushToast } from './Toast'
import { useWriteGate } from '../cribl/authz'
import { IS_INSTALLED } from '../cribl/config'
import {
  checkStatus, deployAll, removeSyslogStack, suggestedSyslogHost, pendingDeploy,
  listStreamGroups, DEFAULT_STREAM_GROUP, STEP_LABELS,
  commitScope, pendingConfigPaths,
  type SetupStatus, type StepResult, type ResourceKey, type StreamGroup,
  SYSLOG_SOURCE_ID, SYSLOG_PIPELINE_ID, SYSLOG_ROUTE_ID,
  LAKE_DESTINATION_ID, LAKE_DATASET_ID, SYSLOG_PORT,
} from '../cribl/provision'
import { deployConsequences, removeConsequences } from './provisionPanelCopy'
import {
  loadCommitMemory, saveCommitMemory, loadSetupGroup, saveSetupGroup, type CommitMemory,
} from '../cribl/setupMemory'

interface ResourceMeta { key: ResourceKey; label: string; detail: string }
const RESOURCES: ResourceMeta[] = [
  { key: 'dataset', label: 'Cribl Lake dataset', detail: `${LAKE_DATASET_ID} · 30-day retention · JSON` },
  { key: 'destination', label: 'Cribl Lake destination', detail: `${LAKE_DESTINATION_ID} → dataset ${LAKE_DATASET_ID}` },
  { key: 'pipeline', label: 'Pipeline', detail: `${SYSLOG_PIPELINE_ID} · parse JSON + normalize` },
  { key: 'source', label: 'Syslog source', detail: `${SYSLOG_SOURCE_ID} · TCP + UDP :${SYSLOG_PORT}` },
  { key: 'route', label: 'Route', detail: `${SYSLOG_ROUTE_ID} · scoped to the source → Lake` },
]

const ACTION_TXT: Record<string, string> = {
  created: 'created', updated: 'updated', exists: 'already present', error: 'failed', skipped: 'skipped',
}

export function ProvisionPanel() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<'deploy' | 'remove' | null>(null)
  // Both volatile actions on this screen are gated behind one of these. Deploy
  // creates and OVERWRITES configuration in a live worker group and then
  // restarts its workers; remove deletes. AGENTS.md ("Confirming Destructive
  // Operations") requires a deliberate click and a prompt naming exactly what is
  // affected before either runs, and forbids reaching them from load, render or
  // a timer — so nothing sets these except a button, and nothing calls deployAll
  // or removeSyslogStack except the confirm inside them.
  // One at a time, structurally: two prompts about the same group with opposite
  // answers is how the wrong button gets pressed, and one slot cannot hold both.
  const [confirming, setConfirming] = useState<'deploy' | 'remove' | null>(null)
  // A commit this group has not deployed — what an earlier run's failed deploy
  // left behind. Read-only, and null when there is none or when it could not be
  // determined.
  const [pending, setPending] = useState<string | null>(null)
  // What Git already reports uncommitted anywhere on the Leader, so the two
  // confirmations can say what rides along in the whole files this commit names
  // instead of asserting that nothing does. Null is "could not tell" and the
  // copy renders it as that — see provisionPanelCopy.ts.
  const [pendingPaths, setPendingPaths] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [group, setGroup] = useState<string>(DEFAULT_STREAM_GROUP)
  const [groups, setGroups] = useState<StreamGroup[]>([{ id: DEFAULT_STREAM_GROUP, name: DEFAULT_STREAM_GROUP }])
  // Whether the viewer's remembered group has been read yet. The first status
  // check waits on it, so the page checks the group the user actually works in
  // instead of checking `default` and then checking again.
  const [groupReady, setGroupReady] = useState(false)
  // Both writes on this screen are two-stage: an outer button that opens a
  // confirmation, and a "Yes, …" inside it that actually writes. `<GatedControl>`
  // owns the inner one. These read the same gate so the OUTER button closes too
  // after a refusal — walking somebody into a confirmation they cannot complete
  // is worse than telling them at the button they pressed.
  const applyGate = useWriteGate('syslog_stack.apply')
  const removeGate = useWriteGate('syslog_stack.remove')

  // Step logs and fatal errors are kept PER worker group so switching groups (or
  // re-checking) preserves the last outcome for each — a provisioning failure
  // (e.g. a syslog port conflict) lingers on that group's screen until the next
  // deploy/remove for it, instead of vanishing on the next render.
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

  // The last commit that touched each artifact, per group — persisted in the
  // app-scoped KV store so it survives reloads and is shown on each resource row
  // until a newer commit for that same artifact replaces it. A single commit
  // covers every file it included, so all those artifacts share its hash.
  const [commits, setCommits] = useState<CommitMemory>({})
  const commitByKey = commits[group] ?? {}
  // A ref mirror of `commits` so record/clear can merge onto the freshest value
  // synchronously (without a stale render closure) and AWAIT the KV write before
  // callers re-read the store — otherwise a re-check right after a commit could
  // race the PUT and read back stale data.
  const commitsRef = useRef<CommitMemory>({})
  const applyCommits = useCallback(async (next: CommitMemory) => {
    commitsRef.current = next
    setCommits(next)
    // KV is authoritative; write before any re-read. A refused write means this
    // page is the only place the note exists, so say so — otherwise the screen
    // shows a commit ref that the next reload quietly removes.
    if (!(await saveCommitMemory(next))) {
      pushToast({ kind: 'error', text: 'Could not save the commit note to the app store — it will be gone after a reload.' })
    }
  }, [])
  const recordCommit = useCallback((gid: string, keys: ResourceKey[], hash: string, message: string) => {
    if (!keys.length) return Promise.resolve()
    const forGroup = { ...(commitsRef.current[gid] ?? {}) }
    for (const k of keys) forGroup[k] = { hash, message }
    return applyCommits({ ...commitsRef.current, [gid]: forGroup })
  }, [applyCommits])
  const clearCommits = useCallback((gid: string, keys: ResourceKey[]) => {
    if (!keys.length) return Promise.resolve()
    const forGroup = { ...(commitsRef.current[gid] ?? {}) }
    for (const k of keys) delete forGroup[k]
    return applyCommits({ ...commitsRef.current, [gid]: forGroup })
  }, [applyCommits])

  // Load the selectable worker groups once. Best-effort: on failure we keep the
  // default group so the page still works.
  useEffect(() => {
    let alive = true
    void listStreamGroups()
      .then((gs) => { if (alive && gs.length) setGroups(gs) })
      .catch(() => { /* keep the default-only list */ })
    return () => { alive = false }
  }, [])

  // Read the group this viewer last picked, once, on mount. A READ only —
  // nothing here writes on load, render or a timer (AGENTS.md). Whatever comes
  // back, `groupReady` flips: a slow or absent KV store leaving the screen stuck
  // on "Checking…" would be a worse bug than a forgotten picker.
  useEffect(() => {
    let alive = true
    const apply = (saved: string | null) => {
      if (!alive) return
      if (saved) setGroup(saved)
      setGroupReady(true)
    }
    void loadSetupGroup().then(apply, () => apply(null))
    return () => { alive = false }
  }, [])

  // Picking a group is a deliberate user action, which is what makes it the
  // place this screen is allowed to write from. It stores one field of this
  // viewer's own preferences — no customer configuration is touched — and a
  // refused write is reported rather than swallowed, because the symptom
  // otherwise arrives a reload later with no explanation.
  const pickGroup = useCallback(async (gid: string) => {
    setGroup(gid)
    if (await saveSetupGroup(gid)) return
    pushToast({
      kind: 'error',
      text: `Could not remember ${gid} as your worker group — this tab will open on ${DEFAULT_STREAM_GROUP} next time.`,
    })
  }, [])

  // Re-check the live resource status for the current group. A successful
  // re-check leaves any lingering deploy/remove outcome for this group untouched
  // — it clears only when the user next deploys or removes.
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      // The undeployed-commit check is a side question — three GETs that answer
      // "is there something this group committed but never ran". It rides along
      // with the status check, and its own failure must not blank the resource
      // rows, so it swallows rather than rejects.
      const [live, undeployed, paths] = await Promise.all([
        checkStatus(group),
        pendingDeploy(group).catch(() => null),
        // Same shape and the same reason: a read whose only job is to make a
        // confirmation specific must not be able to blank the resource rows.
        pendingConfigPaths().catch(() => null),
      ])
      setStatus(live)
      setPending(undeployed)
      setPendingPaths(paths)
    } catch (e) {
      setGroupErr(group, (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [group, setGroupErr])

  // Populate the screen: ALWAYS read the persisted per-group / per-resource
  // commit status from the KV store first, then check the live status. Runs on
  // mount, on every worker-group change, and on the manual "Re-check" — so the
  // pills' commit refs reflect whatever is durably stored for this group before
  // anything renders. (Writes happen on every deploy/remove via applyCommits.)
  const populate = useCallback(async () => {
    const mem = await loadCommitMemory()
    commitsRef.current = mem
    setCommits(mem)
    await refresh()
  }, [refresh])

  // Populate whenever the target group changes, and once the remembered group
  // has landed. The per-group step log is NOT cleared here — switching groups
  // shows that group's last outcome.
  useEffect(() => {
    if (!groupReady) return
    // A confirmation names one group's objects. Switching groups makes it a
    // prompt about somewhere else, so it closes rather than re-labels — now by
    // dropping `isOpen`, which also hands focus back to the trigger it came from.
    setConfirming(null)
    setPending(null)
    setPendingPaths(null)
    void populate()
  }, [groupReady, populate])

  const allPresent = status
    ? RESOURCES.every((r) => status[r.key] === 'present')
    : false
  // A resource the platform refused to show us. Not "absent" — see ResourceState
  // in cribl/provision.ts. It is called out on the row and beside the actions,
  // because everything else on this screen (what is offered, what a confirmation
  // lists) is reasoning from a picture that has a hole in it.
  const unreadable = status ? RESOURCES.filter((r) => status[r.key] === 'unreadable') : []

  // Per-resource outcomes from this group's step log, surfaced inline on the
  // rows: a failure (e.g. the syslog port conflict) and any downstream steps
  // that were skipped because an earlier step failed.
  const errorByKey: Partial<Record<ResourceKey, string>> = {}
  const skippedByKey: Partial<Record<ResourceKey, string>> = {}
  for (const s of steps) {
    if (!RESOURCES.some((r) => r.key === s.key)) continue
    if (s.action === 'error') errorByKey[s.key as ResourceKey] = s.detail || 'failed'
    else if (s.action === 'skipped') skippedByKey[s.key as ResourceKey] = s.detail || 'skipped'
  }


  // The group-scoped resources the teardown removes. When some (but not all) of
  // these exist, the stack is "partial" and can be cleaned up.
  const REMOVABLE_KEYS: ResourceKey[] = ['source', 'pipeline', 'route']
  const anyRemovable = status ? REMOVABLE_KEYS.some((k) => status[k] === 'present') : false
  const partial = anyRemovable && !allPresent
  // One place each, so the click guard and the aria state cannot drift apart.
  const deployBlocked = running !== null || loading || applyGate.denied !== null
  const removeBlocked = running !== null || removeGate.denied !== null

  // What each confirmation names, as objects rather than as prose. AGENTS.md
  // wants "exactly what will be affected" before the call, and a list is the form
  // an operator can actually check against the group: the ids are the ids Cribl
  // uses, and the action is the word beside each one.
  //
  // Dependency order, which is also the order deployAll runs in — a dataset
  // before the destination that writes to it, a pipeline before the route that
  // references it. <ConfirmDialog> moves deletes last and otherwise leaves this
  // alone.
  const deployResources: ConfirmResource[] = [
    {
      action: 'create', kind: 'Cribl Lake dataset', id: LAKE_DATASET_ID,
      detail: 'Created only if missing, never edited. Shared, and group-independent — these dashboards read it.',
    },
    {
      action: 'create', kind: 'Cribl Lake destination', id: LAKE_DESTINATION_ID, group,
      // "by this button", not "never edited", because it is not a property of
      // the object: the Lake landing panel edits this same destination
      // (cribl/lakeLanding.ts), behind its own confirmation.
      detail: `Created by this button only if missing, and never edited by it. Writes to dataset ${LAKE_DATASET_ID}.`,
    },
    {
      action: 'replace', kind: 'Pipeline', id: SYSLOG_PIPELINE_ID, group,
      detail: 'Created, or its function list overwritten if it already exists.',
    },
    {
      action: 'replace', kind: 'Syslog source', id: SYSLOG_SOURCE_ID, group,
      detail: `TCP + UDP :${SYSLOG_PORT}. Created, or its settings overwritten if it already exists.`,
    },
    {
      // Named as the routing table and not as the route, because the call is a
      // PATCH of the whole table — the most consequential write in this app
      // (cribl/authz.ts, WRITE_SITES). What it does to the table is the detail.
      action: 'replace', kind: 'Routing table', id: group,
      detail: `Route ${SYSLOG_ROUTE_ID} added above the catch-all if it is missing. Existing routes keep their order and are not edited.`,
    },
  ]

  // What each confirmation says about reach lives in provisionPanelCopy.ts, and
  // its header says why: the sentence these replace — "Nothing else in ${group}
  // is touched, including the demo DataGen source" — was true about what this
  // app writes and false about what its commit carries, and it shipped.
  //
  // Deploy names all four files it may commit; the teardown names three,
  // because removeSyslogStack never touches the destination and naming
  // outputs.yml there would be the over-naming half of the same defect.
  const deployScope = commitScope(group, ['source', 'pipeline', 'route', 'destination'], pendingPaths)
  const removeScope = commitScope(group, ['source', 'pipeline', 'route'], pendingPaths)
  const deploySentences = deployConsequences({ group, scope: deployScope, undeployed: pending })
  const removeSentences = removeConsequences(
    { group, scope: removeScope, undeployed: pending }, LAKE_DESTINATION_ID, LAKE_DATASET_ID,
  )

  // Only what is actually there. A confirmation that offered to delete a route
  // this group does not have would be naming an object the operator cannot check.
  const removeResources: ConfirmResource[] = [
    ...(status?.source === 'present'
      ? [{ action: 'delete' as const, kind: 'Syslog source', id: SYSLOG_SOURCE_ID, group }]
      : []),
    ...(status?.pipeline === 'present'
      ? [{ action: 'delete' as const, kind: 'Pipeline', id: SYSLOG_PIPELINE_ID, group }]
      : []),
    ...(status?.route === 'present'
      ? [{
          action: 'delete' as const, kind: 'Route', id: SYSLOG_ROUTE_ID, group,
          detail: `Removed from the routing table of ${group}. Every other route keeps its order.`,
        }]
      : []),
  ]

  // Reached only from the "Yes, …" button inside the confirmation below. It
  // creates the missing resources, PATCHes the pipeline / source / routing table
  // that already exist, commits, and deploys to the group's running workers —
  // every one of which AGENTS.md calls volatile.
  const onDeploy = async () => {
    const gid = group
    setRunning('deploy')
    setConfirming(null)
    resetOutcome(gid)
    try {
      const results = await deployAll((r) => appendStep(gid, r), gid, pushToast)
      // A single commit covers every file it included — attribute its hash to
      // all artifacts created/updated in this run (the dataset lives in Cribl
      // Lake, not Git, so it never carries a commit).
      const commit = results.find((s) => s.key === 'commit' && s.action === 'created' && s.hash)
      if (commit?.hash) {
        const keys = results
          .filter((s) => (s.action === 'created' || s.action === 'updated')
            && s.key !== 'dataset' && RESOURCES.some((x) => x.key === s.key))
          .map((s) => s.key as ResourceKey)
        await recordCommit(gid, keys, commit.hash, commit.message ?? '')
      }
      await refresh()
    } catch (e) {
      setGroupErr(gid, (e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  const onRemove = async () => {
    const gid = group
    setRunning('remove')
    resetOutcome(gid)
    setConfirming(null)
    try {
      const results = await removeSyslogStack((r) => appendStep(gid, r), gid, pushToast, status ?? undefined)
      // Removed artifacts no longer have a live config — drop their commit note.
      const removed = results
        .filter((s) => s.detail === 'deleted' && RESOURCES.some((x) => x.key === s.key))
        .map((s) => s.key as ResourceKey)
      await clearCommits(gid, removed)
      await refresh()
    } catch (e) {
      setGroupErr(gid, (e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  const host = suggestedSyslogHost()
  const endpoint = host ? `${host}:${SYSLOG_PORT}` : `<worker-ingress-host>:${SYSLOG_PORT}`
  const copyEndpoint = () => {
    void navigator.clipboard?.writeText(endpoint).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <>
      <Panel
        title="Guided setup — onboard live Gigamon AMI over Syslog"
        note={<span className={`env-chip ${IS_INSTALLED ? 'env-installed' : 'env-dev'}`}>{IS_INSTALLED ? 'Cribl' : 'dev preview'}</span>}
      >
        <p className="gs-intro">
          This provisions the <strong>real-world onboarding path</strong> into the selected Cribl Stream{' '}
          <code>{group}</code> worker group: a <strong>Syslog source</strong> your Gigamon Application
          Metadata Exporter (AMX) points at, a <strong>pipeline</strong> that parses and normalizes the
          AMI records, a <strong>route</strong>, and the <strong>Cribl Lake</strong> dataset{' '}
          <code>{LAKE_DATASET_ID}</code> these dashboards already read. It writes{' '}
          <strong>only its own objects</strong> — creating what is missing, overwriting the pipeline,
          source and route entry where they have drifted from this release, and never editing the demo
          DataGen feed. Real flows land in the same dataset, so the existing dashboards light up
          automatically. The <strong>commit</strong> that follows is wider than the write: Git takes
          whole files, and <code>inputs.yml</code>, <code>routes.yml</code> and <code>outputs.yml</code>{' '}
          each hold every object of their kind in the group. The confirmation names them and says what
          Cribl reports already uncommitted in them.
        </p>

        <div className="gs-group-picker">
          <label htmlFor="gs-group-select" className="gs-group-label">Worker group</label>
          <select
            id="gs-group-select"
            className="gs-group-select"
            value={group}
            disabled={running !== null}
            onChange={(e) => void pickGroup(e.target.value)}
            title="The Stream worker group the onboarding stack reads, creates, or removes"
          >
            {/* The remembered group and the group list arrive independently, and
                a remembered group can outlive the group itself. Either way the
                picker shows what it is set to rather than going blank. */}
            {!groups.some((gr) => gr.id === group) && <option value={group}>{group}</option>}
            {groups.map((gr) => (
              <option key={gr.id} value={gr.id}>
                {gr.name === gr.id ? gr.id : `${gr.name} (${gr.id})`}
              </option>
            ))}
          </select>
          <span className="gs-group-hint">
            The source, pipeline, route &amp; destination are created here and committed/deployed to this
            group. The Lake dataset <code>{LAKE_DATASET_ID}</code> is shared and group-independent.
            The group you pick is remembered for you, so this tab opens on it next time.
          </span>
        </div>

        <div className="gs-grid">
          <div className="gs-checklist">
            <div className="gs-checklist-head">
              <span>Resources</span>
              <button type="button" className="btn btn-ghost" onClick={() => void populate()} disabled={loading || running !== null}>
                {loading ? 'Checking…' : 'Re-check'}
              </button>
            </div>
            {RESOURCES.map((r) => {
              const present = status?.[r.key] === 'present'
              // Cribl refused the read. The row must not claim the resource is
              // missing — that claim is what used to invite a user who cannot see
              // the stack to deploy a second one over the top of it.
              const unread = status?.[r.key] === 'unreadable'
              const rowErr = !present ? errorByKey[r.key] : undefined
              const rowSkip = !present && !rowErr ? skippedByKey[r.key] : undefined
              const rc = commitByKey[r.key]
              // The same ladder the class list used to encode, now naming the
              // state rather than the colour. Order matters: a resource that IS
              // present is present even if an earlier step for it errored.
              const state: StatusState =
                present ? 'present'
                  : rowErr ? 'failed'
                    : unread ? 'unreadable'
                      : rowSkip ? 'skipped'
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
                    {rowSkip && <span className="gs-res-skip">{rowSkip}</span>}
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

          {/* Both writes are two-stage: an outer button that only opens a
              confirmation, and the "Yes, …" inside it that actually writes. The
              outer buttons now stay MOUNTED while the dialog is open, where they
              used to be replaced by the confirmation block. That is not cosmetic:
              it is what Escape and Cancel give focus back to, and it is what
              keeps <GateNote> beside the trigger the person actually pressed
              after a refusal the dialog is no longer around to report.
              The words inside the dialogs are slice 1.3's, carried across rather
              than rewritten — they were written to satisfy AGENTS.md and they are
              right. What is new is `undo`: what puts this back. */}
          <div className="gs-actions">
            <button
              type="button"
              className="btn btn-primary"
              /* aria-disabled, never disabled: a disabled button leaves the tab
                 order, so when the user CONFIRMS the write this trigger vanishes
                 from under the returning focus and lands it on <body> — losing a
                 keyboard or screen-reader user their place at the exact moment
                 the app starts changing their configuration. Escape and Cancel
                 restored focus correctly; only the path that actually writes did
                 not. Staying focusable also lets someone who is refused by the
                 permission gate reach the button and read why. */
              onClick={() => { if (deployBlocked) return; setConfirming('deploy') }}
              aria-disabled={deployBlocked || undefined}
              title={applyGate.reason ?? undefined}
            >
              {running === 'deploy' ? 'Deploying…' : allPresent ? 'Re-apply onboarding stack' : 'Deploy onboarding stack'}
            </button>
            {/* The dialog closes itself before the write runs, so by the time
                there is a refusal to report, its "Yes" button is gone. The note
                belongs here, beside the trigger the user is now looking at. */}
            <GateNote write="syslog_stack.apply" />
            <p className="gs-action-note">
              Creates any missing resources, then commits &amp; deploys to the <code>{group}</code> group.
              You'll get to review exactly what changes first.
            </p>
            {unreadable.length > 0 && (
              <p className="gs-action-note gs-action-warn">
                Cribl refused to let this app read part of <code>{group}</code>{' '}
                ({unreadable.map((r) => r.label).join(', ')}), so the rows above are an incomplete
                picture — those resources may already exist. Deploying creates what is missing{' '}
                <em>and overwrites</em> this app's own pipeline, source and route entry where they differ
                from this release, so check the group in Cribl before you rely on what this screen says.
              </p>
            )}
            {pending && (
              <p className="gs-action-note gs-action-warn">
                Commit <code>#{pending.slice(0, 10)}</code> touches <code>{group}</code> and has not been
                deployed to it — an earlier deploy did not finish. Deploying moves the group to the
                commit this run creates, so that one goes live with it, and so does anything else
                committed on this Leader since.
              </p>
            )}
            {(allPresent || partial) && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  onClick={() => { if (removeBlocked) return; setConfirming('remove') }}
                  aria-disabled={removeBlocked || undefined}
                  title={removeGate.reason ?? undefined}
                >
                  {partial ? 'Remove partial stack' : 'Remove onboarding stack'}
                </button>
                <GateNote write="syslog_stack.remove" />
              </>
            )}
          </div>
        </div>

        <ConfirmDialog
          isOpen={confirming === 'deploy'}
          title={`${allPresent ? 'Re-apply' : 'Apply'} the Gigamon AMI onboarding stack to Cribl Stream worker group ${group}`}
          resources={deployResources}
          consequences={deploySentences}
          undo={
            `Remove onboarding stack, on this tab, deletes the source, pipeline and route again. ` +
            `A setting this run overwrites is recoverable only from ${group}'s Git history.`
          }
          onCancel={() => setConfirming(null)}
          confirm={
            /* The dialog can outlive the state it was opened in — a Re-check
               started underneath it, say — so the button that actually writes
               re-checks that nothing is already running. It is a GatedControl
               because this is the click that writes: if Cribl refuses one of the
               calls behind it, the refusal is caught here and named rather than
               reported as a generic failed step. */
            <GatedControl
              write="syslog_stack.apply"
              label={allPresent ? `Yes, re-apply to ${group}` : `Yes, deploy to ${group}`}
              busyLabel="Deploying…"
              unavailable={running !== null ? 'Another run is already in progress.' : null}
              run={onDeploy}
            />
          }
        />

        <ConfirmDialog
          isOpen={confirming === 'remove'}
          title={`Delete the ${partial ? 'partially-created ' : ''}Gigamon AMI syslog resources from Cribl Stream worker group ${group}`}
          resources={removeResources}
          irreversible={{
            why:
              `Deleting a source and a pipeline cannot be undone from this app; the configuration is ` +
              `recoverable only from ${group}'s Git history.`,
          }}
          consequences={removeSentences}
          // The thing the old teardown text never said: the delete is
          // reversible, by the button directly above it. "not as they are now"
          // is the caveat that keeps it honest — a rebuild is this app's
          // definition, not whatever the group has since been edited to.
          undo={
            removeResources.length === 3
              ? 'Deploy onboarding stack, on this tab, rebuilds all three — as this app defines them, not as they are now.'
              : 'Deploy onboarding stack, on this tab, rebuilds everything listed above — as this app defines it, not as it is now.'
          }
          typeToConfirm={{ value: group, label: `To confirm, type the worker group name ${group}` }}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="syslog_stack.remove"
              label={`Yes, delete from ${group}`}
              busyLabel="Removing…"
              className="btn btn-danger"
              unavailable={running !== null ? 'Another run is already in progress.' : null}
              run={onRemove}
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

      {allPresent && (
        <Panel title="Point Gigamon AMX here" tourId="gs-endpoint">
          <p className="gs-intro">
            Configure the Gigamon Application Metadata Exporter to send AMI metadata as{' '}
            <strong>JSON over Syslog</strong> to this endpoint:
          </p>
          <div className="gs-endpoint">
            <div className="gs-endpoint-main">
              <code className="gs-endpoint-addr">{endpoint}</code>
              <button type="button" className="btn btn-ghost" onClick={copyEndpoint}>{copied ? 'Copied ✓' : 'Copy'}</button>
            </div>
            <div className="gs-endpoint-meta">
              <span><strong>Protocol</strong> TCP &amp; UDP</span>
              <span><strong>Port</strong> {SYSLOG_PORT}</span>
              <span><strong>Format</strong> JSON</span>
              <span><strong>Lands in</strong> Cribl Lake · <code>{LAKE_DATASET_ID}</code></span>
            </div>
          </div>
          {!host && (
            <p className="gs-note">
              Replace <code>&lt;worker-ingress-host&gt;</code> with your Cribl Worker Group's ingress
              address (Cribl.Cloud: typically <code>default.main.&lt;org&gt;.cribl.cloud</code>).
            </p>
          )}
        </Panel>
      )}
    </>
  )
}
