import { useState } from 'react'

interface Props {
  service: string
  onClose: () => void
}

/** Mock ServiceNow incident form, pre-filled from the triage verdict.
 *  This is a UI demo — it does not call ServiceNow or create anything. */
export function ServiceNowModal({ service, onClose }: Props) {
  const [submitted, setSubmitted] = useState(false)
  const [group, setGroup] = useState('')

  const description =
    `Four latency domains (p95, scored separately, never averaged):\n` +
    `  Network      tcp_rtt        within SLO\n` +
    `  Application  tcp_rtt_app    the symptom to route\n` +
    `  Server       http_server_ms (from http resp−req ts)\n` +
    `  DNS          dns_resp       within SLO\n` +
    `Packet health: dup-acks / resets / wire-errors from tcp_dup_ack, tcp_reset, tcp_wrong_crc.\n` +
    `Action: route to the owning team; network exonerated by packet-health counters.`

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span className="modal-title"><span className="sn-dot" /> ServiceNow · Incident</span>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        {submitted ? (
          <div className="modal-body modal-done">
            <div className="done-check">✓</div>
            <p>Incident drafted for <strong>{service}</strong>.</p>
            <p className="modal-note">This is a UI demo — no incident was actually created in ServiceNow.</p>
            <button type="button" className="btn-incident" onClick={onClose}>Done</button>
          </div>
        ) : (
          <div className="modal-body">
            <label className="fld">
              <span>Short description *</span>
              <input className="fld-in" defaultValue={`${service} application latency breaching SLO`} />
            </label>
            <label className="fld">
              <span>Configuration Item (CI) *</span>
              <input className="fld-in" defaultValue={service} />
            </label>
            <div className="fld-2">
              <label className="fld">
                <span>Impact</span>
                <select className="fld-in" defaultValue="2 - Medium">
                  <option>1 - High</option><option>2 - Medium</option><option>3 - Low</option>
                </select>
              </label>
              <label className="fld">
                <span>Urgency</span>
                <select className="fld-in" defaultValue="1 - High">
                  <option>1 - High</option><option>2 - Medium</option><option>3 - Low</option>
                </select>
              </label>
            </div>
            <label className="fld">
              <span>Assignment group *</span>
              <select className="fld-in" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">— choose —</option>
                <option>App Platform</option>
                <option>Network Operations</option>
                <option>Database</option>
              </select>
            </label>
            <label className="fld">
              <span>Caller / reported by *</span>
              <input className="fld-in" defaultValue="Gigamon NPM (automated)" />
            </label>
            <label className="fld">
              <span>Description *</span>
              <textarea className="fld-in fld-area" defaultValue={description} rows={7} />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn-refresh" onClick={onClose}>Cancel</button>
              <button type="button" className="btn-incident" disabled={!group} onClick={() => setSubmitted(true)}>
                Submit incident
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
