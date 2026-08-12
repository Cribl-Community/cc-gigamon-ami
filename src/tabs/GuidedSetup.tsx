import { useCallback, useEffect, useRef, useState } from 'react'
import { Panel } from '../components/Panel'
import { IS_INSTALLED } from '../cribl/config'
import {
  checkStatus, deployAll, removeSyslogStack, suggestedSyslogHost,
  listStreamGroups, DEFAULT_STREAM_GROUP, STEP_LABELS,
  type SetupStatus, type StepResult, type ResourceKey, type StreamGroup, type Phase,
  SYSLOG_SOURCE_ID, SYSLOG_PIPELINE_ID, SYSLOG_ROUTE_ID,
  LAKE_DESTINATION_ID, LAKE_DATASET_ID, SYSLOG_PORT,
} from '../cribl/provision'
import { loadCommitMemory, saveCommitMemory, type CommitMemory } from '../cribl/setupMemory'

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

interface Toast { id: number; kind: Phase['kind']; text: string }

export function GuidedSetup() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<'deploy' | 'remove' | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [copied, setCopied] = useState(false)
  const [group, setGroup] = useState<string>(DEFAULT_STREAM_GROUP)
  const [groups, setGroups] = useState<StreamGroup[]>([{ id: DEFAULT_STREAM_GROUP, name: DEFAULT_STREAM_GROUP }])
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)

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
    await saveCommitMemory(next) // KV is authoritative; write before any re-read
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

  // Transient status pop-up. Errors linger longer so they can be read; the
  // terminal "done" toast and progress toasts auto-dismiss.
  const pushToast = useCallback((p: Phase) => {
    const id = ++toastId.current
    setToasts((prev) => [...prev, { id, kind: p.kind, text: p.text }])
    const ttl = p.kind === 'error' ? 6000 : p.kind === 'done' ? 4000 : 2600
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttl)
  }, [])

  // Load the selectable worker groups once. Best-effort: on failure we keep the
  // default group so the page still works.
  useEffect(() => {
    let alive = true
    void listStreamGroups()
      .then((gs) => { if (alive && gs.length) setGroups(gs) })
      .catch(() => { /* keep the default-only list */ })
    return () => { alive = false }
  }, [])

  // Re-check the live resource status for the current group. A successful
  // re-check leaves any lingering deploy/remove outcome for this group untouched
  // — it clears only when the user next deploys or removes.
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await checkStatus(group))
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

  // Populate whenever the target group changes (and on mount). The per-group step
  // log is NOT cleared here — switching groups shows that group's last outcome.
  useEffect(() => { setConfirmRemove(false); void populate() }, [populate])

  const allPresent = status
    ? RESOURCES.every((r) => status[r.key])
    : false

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
  const anyRemovable = status ? REMOVABLE_KEYS.some((k) => status[k]) : false
  const partial = anyRemovable && !allPresent

  const onDeploy = async () => {
    const gid = group
    setRunning('deploy')
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
    setConfirmRemove(false)
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
    <div className="tab">
      <Panel
        title="Guided setup — onboard live Gigamon AMI over Syslog"
        note={<span className={`env-chip ${IS_INSTALLED ? 'env-installed' : 'env-dev'}`}>{IS_INSTALLED ? 'Cribl' : 'dev preview'}</span>}
      >
        <p className="gs-intro">
          This provisions the <strong>real-world onboarding path</strong> into the selected Cribl Stream{' '}
          <code>{group}</code> worker group: a <strong>Syslog source</strong> your Gigamon Application
          Metadata Exporter (AMX) points at, a <strong>pipeline</strong> that parses and normalizes the
          AMI records, a <strong>route</strong>, and the <strong>Cribl Lake</strong> dataset{' '}
          <code>{LAKE_DATASET_ID}</code> these dashboards already read. Everything is{' '}
          <strong>additive and idempotent</strong> — it does not touch the demo DataGen feed, and real
          flows land in the same dataset, so the existing dashboards light up automatically.
        </p>

        <div className="gs-group-picker">
          <label htmlFor="gs-group-select" className="gs-group-label">Worker group</label>
          <select
            id="gs-group-select"
            className="gs-group-select"
            value={group}
            disabled={running !== null}
            onChange={(e) => setGroup(e.target.value)}
            title="The Stream worker group the onboarding stack reads, creates, or removes"
          >
            {groups.map((gr) => (
              <option key={gr.id} value={gr.id}>
                {gr.name === gr.id ? gr.id : `${gr.name} (${gr.id})`}
              </option>
            ))}
          </select>
          <span className="gs-group-hint">
            The source, pipeline, route &amp; destination are created here and committed/deployed to this
            group. The Lake dataset <code>{LAKE_DATASET_ID}</code> is shared and group-independent.
          </span>
        </div>

        <div className="gs-grid">
          <div className="gs-checklist">
            <div className="gs-checklist-head">
              <span>Resources</span>
              <button type="button" className="gs-btn gs-btn-ghost" onClick={() => void populate()} disabled={loading || running !== null}>
                {loading ? 'Checking…' : 'Re-check'}
              </button>
            </div>
            {RESOURCES.map((r) => {
              const present = status?.[r.key]
              const rowErr = !present ? errorByKey[r.key] : undefined
              const rowSkip = !present && !rowErr ? skippedByKey[r.key] : undefined
              const rc = commitByKey[r.key]
              return (
                <div key={r.key} className="gs-res-row">
                  <span className={`gs-pill ${present ? 'gs-ok' : rowErr ? 'gs-err' : rowSkip ? 'gs-skip' : loading ? 'gs-unknown' : 'gs-missing'}`}>
                    {present ? '✓ present' : rowErr ? '✕ failed' : rowSkip ? '⤼ skipped' : loading ? '…' : '— absent'}
                  </span>
                  <div className="gs-res-text">
                    <span className="gs-res-label">{r.label}</span>
                    <span className="gs-res-detail"><code>{r.detail}</code></span>
                    {rowErr && <span className="gs-res-error">{rowErr}</span>}
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

          <div className="gs-actions">
            <button type="button" className="gs-btn gs-btn-primary" onClick={() => void onDeploy()} disabled={running !== null || loading}>
              {running === 'deploy' ? 'Deploying…' : allPresent ? 'Re-apply onboarding stack' : 'Deploy onboarding stack'}
            </button>
            <p className="gs-action-note">
              Creates any missing resources, then commits &amp; deploys to the <code>{group}</code> group.
            </p>
            {(allPresent || partial) && (
              confirmRemove ? (
                <div className="gs-confirm">
                  <span>
                    {partial
                      ? <>Remove the partially-created syslog resources from <code>{group}</code>? (dataset is kept)</>
                      : <>Remove the syslog source, pipeline &amp; route from <code>{group}</code>? (dataset is kept)</>}
                  </span>
                  <div>
                    <button type="button" className="gs-btn gs-btn-danger" onClick={() => void onRemove()}>Yes, remove</button>
                    <button type="button" className="gs-btn gs-btn-ghost" onClick={() => setConfirmRemove(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="gs-btn gs-btn-ghost gs-btn-danger-text" onClick={() => setConfirmRemove(true)} disabled={running !== null}>
                  {partial ? 'Remove partial stack' : 'Remove onboarding stack'}
                </button>
              )
            )}
          </div>
        </div>

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
              <button type="button" className="gs-btn gs-btn-ghost" onClick={copyEndpoint}>{copied ? 'Copied ✓' : 'Copy'}</button>
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

      <Panel title="What gets created & things to know">
        <ul className="gs-facts">
          <li>
            <strong>Pipeline <code>{SYSLOG_PIPELINE_ID}</code></strong> — extracts the JSON payload from the
            syslog message, then applies the <em>same</em> numeric casts and derived fields
            (<code>http_server_ms</code>, <code>tcp_reset</code>, subnets, <code>l4_proto</code>, byte/packet
            totals) as the demo <code>gigamon_ami</code> pipeline, so field parity is guaranteed.
          </li>
          <li>
            <strong>Route <code>{SYSLOG_ROUTE_ID}</code></strong> is prepended above the catch-all{' '}
            <code>default</code> route, filtered to <code>__inputId=='syslog:{SYSLOG_SOURCE_ID}'</code> and
            marked <em>final</em> — so it only touches this source's data and nothing else changes.
          </li>
          <li>
            <strong>Ingress firewall.</strong> On Cribl.Cloud, native data ports are firewalled by default.
            Open TCP/UDP <code>{SYSLOG_PORT}</code> on the Worker Group's ingress (or run an on-prem/Edge
            worker Gigamon can reach on the LAN) before real data can arrive.
          </li>
          <li>
            <strong>JSON assumption.</strong> The parse step expects AMI records as JSON. If your AMX is
            configured for <em>CEF</em> export instead, swap the parse function for a CEF parser — the field
            names must match those the dashboards query.
          </li>
          <li>
            <strong>Lab note.</strong> No live data is connected in the lab, so the source sits idle (health
            green, 0 EPS) until Gigamon points at it. The DataGen demo keeps the dashboards populated
            meanwhile.
          </li>
        </ul>
      </Panel>

      {toasts.length > 0 && (
        <div className="gs-toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`gs-toast gs-toast-${t.kind}`}>
              <span className="gs-toast-icon">
                {t.kind === 'error' ? '✕' : t.kind === 'done' ? '✓' : '●'}
              </span>
              <span className="gs-toast-text">{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
