import { useCallback, useEffect, useState } from 'react'
import { Panel } from '../components/Panel'
import { IS_INSTALLED, STREAM_GROUP } from '../cribl/config'
import {
  checkStatus, deployAll, removeSyslogStack, suggestedSyslogHost,
  type SetupStatus, type StepResult, type ResourceKey,
  SYSLOG_SOURCE_ID, SYSLOG_PIPELINE_ID, SYSLOG_ROUTE_ID,
  LAKE_DESTINATION_ID, LAKE_DATASET_ID, SYSLOG_PORT,
} from '../cribl/provision'

interface ResourceMeta { key: ResourceKey; label: string; detail: string }
const RESOURCES: ResourceMeta[] = [
  { key: 'dataset', label: 'Cribl Lake dataset', detail: `${LAKE_DATASET_ID} · 30-day retention · JSON` },
  { key: 'destination', label: 'Cribl Lake destination', detail: `${LAKE_DESTINATION_ID} → dataset ${LAKE_DATASET_ID}` },
  { key: 'pipeline', label: 'Pipeline', detail: `${SYSLOG_PIPELINE_ID} · parse JSON + normalize` },
  { key: 'source', label: 'Syslog source', detail: `${SYSLOG_SOURCE_ID} · TCP + UDP :${SYSLOG_PORT}` },
  { key: 'route', label: 'Route', detail: `${SYSLOG_ROUTE_ID} · scoped to the source → Lake` },
]

const STEP_LABEL: Record<string, string> = {
  dataset: 'Lake dataset', destination: 'Lake destination', pipeline: 'Pipeline',
  source: 'Syslog source', route: 'Route', deploy: 'Commit & deploy',
}
const ACTION_TXT: Record<string, string> = {
  created: 'created', updated: 'updated', exists: 'already present', error: 'failed',
}

export function GuidedSetup() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [steps, setSteps] = useState<StepResult[]>([])
  const [running, setRunning] = useState<'deploy' | 'remove' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      setStatus(await checkStatus())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const allPresent = status
    ? RESOURCES.every((r) => status[r.key])
    : false

  const onDeploy = async () => {
    setRunning('deploy')
    setSteps([])
    setErr(null)
    try {
      await deployAll((r) => setSteps((prev) => [...prev, r]))
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  const onRemove = async () => {
    setRunning('remove')
    setSteps([])
    setErr(null)
    setConfirmRemove(false)
    try {
      await removeSyslogStack((r) => setSteps((prev) => [...prev, r]))
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
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
          This provisions the <strong>real-world onboarding path</strong> into the Cribl Stream{' '}
          <code>{STREAM_GROUP}</code> group: a <strong>Syslog source</strong> your Gigamon Application
          Metadata Exporter (AMX) points at, a <strong>pipeline</strong> that parses and normalizes the
          AMI records, a <strong>route</strong>, and the <strong>Cribl Lake</strong> dataset{' '}
          <code>{LAKE_DATASET_ID}</code> these dashboards already read. Everything is{' '}
          <strong>additive and idempotent</strong> — it does not touch the demo DataGen feed, and real
          flows land in the same dataset, so the existing dashboards light up automatically.
        </p>

        <div className="gs-grid">
          <div className="gs-checklist">
            <div className="gs-checklist-head">
              <span>Resources</span>
              <button type="button" className="gs-btn gs-btn-ghost" onClick={() => void refresh()} disabled={loading || running !== null}>
                {loading ? 'Checking…' : 'Re-check'}
              </button>
            </div>
            {RESOURCES.map((r) => {
              const present = status?.[r.key]
              return (
                <div key={r.key} className="gs-res-row">
                  <span className={`gs-pill ${present ? 'gs-ok' : loading ? 'gs-unknown' : 'gs-missing'}`}>
                    {present ? '✓ present' : loading ? '…' : '— absent'}
                  </span>
                  <div className="gs-res-text">
                    <span className="gs-res-label">{r.label}</span>
                    <span className="gs-res-detail"><code>{r.detail}</code></span>
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
              Creates any missing resources, then commits &amp; deploys to the <code>{STREAM_GROUP}</code> group.
            </p>
            {allPresent && (
              confirmRemove ? (
                <div className="gs-confirm">
                  <span>Remove the syslog source, pipeline &amp; route? (dataset is kept)</span>
                  <div>
                    <button type="button" className="gs-btn gs-btn-danger" onClick={() => void onRemove()}>Yes, remove</button>
                    <button type="button" className="gs-btn gs-btn-ghost" onClick={() => setConfirmRemove(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="gs-btn gs-btn-ghost gs-btn-danger-text" onClick={() => setConfirmRemove(true)} disabled={running !== null}>
                  Remove onboarding stack
                </button>
              )
            )}
          </div>
        </div>

        {(steps.length > 0 || err) && (
          <div className="gs-steps">
            {steps.map((s, i) => (
              <div key={i} className={`gs-step gs-step-${s.action === 'error' ? 'err' : 'ok'}`}>
                <span className="gs-step-icon">{s.action === 'error' ? '✕' : '✓'}</span>
                <span className="gs-step-label">{STEP_LABEL[s.key] || s.key}</span>
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
    </div>
  )
}
