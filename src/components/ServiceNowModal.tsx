import { useState } from 'react'
import { Modal } from '@capra/core'

interface Props {
  /** Controlled by the caller. See the note in tabs/ServiceMap.tsx on why this
   *  is a prop rather than the component being mounted only when it is open. */
  isOpen: boolean
  service: string
  onClose: () => void
}

/** Mock ServiceNow incident form, pre-filled from the triage verdict.
 *  This is a UI demo — it does not call ServiceNow or create anything.
 *
 *  It is on Capra's `Modal`, the same dialog `ConfirmDialog` and `TourPicker`
 *  use. It used to be the app's second modal implementation — a `.modal-scrim`
 *  div with `role="dialog" aria-modal="true"` and none of what those two
 *  attributes promise: no focus trap, no Escape, no scroll lock, no focus
 *  restore, and a title in a `<span>` that nothing was labelled by. Capra draws
 *  the header, the ✕, the footer and the scrim; what is left in this file is the
 *  form, which is the only part that was ever about ServiceNow.
 */
export function ServiceNowModal({ isOpen, service, onClose }: Props) {
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
    <Modal
      isOpen={isOpen}
      // A STRING, and that is load-bearing. `ModalProps.title` is typed
      // `ReactNode`, but Capra only builds the `<h2>` it points `aria-labelledby`
      // at when the title is text: pass an element — the brand-green status dot
      // this header used to carry beside the words — and the dialog renders with
      // NO aria-labelledby and therefore no accessible name at all. Measured, and
      // pinned in ServiceNowModal.test.tsx. The dot was decoration on a mock
      // dialog; the name is what a screen-reader user is told they are in.
      title="ServiceNow · Incident"
      onClose={onClose}
      // 544px. The hand-built box was 560px, and the form inside it is a single
      // column of fields either way.
      size="sm"
      footer={
        <Modal.FooterActions>
          {submitted ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!group} onClick={() => setSubmitted(true)}>
                Submit incident
              </button>
            </>
          )}
        </Modal.FooterActions>
      }
    >
      {submitted ? (
        <div className="sn-done">
          <div className="done-check">✓</div>
          <p>Incident drafted for <strong>{service}</strong>.</p>
          <p className="sn-note">This is a UI demo — no incident was actually created in ServiceNow.</p>
        </div>
      ) : (
        <div className="sn-form">
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
            <input className="fld-in" defaultValue="Gigamon Network Observability (automated)" />
          </label>
          <label className="fld">
            <span>Description *</span>
            <textarea className="fld-in fld-area" defaultValue={description} rows={7} />
          </label>
        </div>
      )}
    </Modal>
  )
}
