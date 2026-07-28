import { useTour } from '../app/TourContext'
import { PERSONAS } from '../app/tour'

function CompassIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2.2 5-5 2.2 2.2-5z" />
    </svg>
  )
}

/** Header button — always available, so a finished tour can be restarted. */
export function TourLauncher() {
  const { openPicker } = useTour()
  return (
    <button type="button" className="btn-icon btn-tour" onClick={openPicker} title="Guided tour by role" aria-label="Start a guided tour">
      <CompassIcon /> <span className="btn-tour-txt">Guided tour</span>
    </button>
  )
}

/** One-time nudge for first-time users. Never returns once a tour is run or dismissed. */
export function TourNudge() {
  const { seen, persona, openPicker, markSeen } = useTour()
  if (seen || persona) return null
  return (
    <div className="tour-nudge" role="note">
      <span>
        <strong>First time here?</strong> Take a 5-minute guided tour tailored to your role — NetOps, Security,
        AI governance or Compliance.
      </span>
      <span className="tour-nudge-actions">
        <button type="button" className="tour-btn tour-btn-primary" onClick={openPicker}>Choose a role</button>
        <button type="button" className="tour-btn" onClick={markSeen}>Dismiss</button>
      </span>
    </div>
  )
}

export function TourPicker() {
  const { pickerOpen, closePicker, start } = useTour()
  if (!pickerOpen) return null
  return (
    <div className="modal-scrim" onClick={closePicker}>
      <div className="modal tour-modal" role="dialog" aria-label="Choose a guided tour" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3 className="modal-title">Guided tour — pick your role</h3>
          <button type="button" className="modal-x" onClick={closePicker} aria-label="Close">×</button>
        </header>
        <div className="tour-personas">
          {PERSONAS.map((p) => (
            <button key={p.id} type="button" className="tour-persona" onClick={() => start(p.id)}>
              <span className="tour-persona-role">{p.role}</span>
              <span className="tour-persona-name">{p.name}</span>
              <span className="tour-persona-q">“{p.question}”</span>
              <span className="tour-persona-steps">{p.steps.length} steps</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Docked strip shown only while a tour is running. */
export function TourStrip() {
  const { persona, index, step, next, back, exit } = useTour()
  if (!persona || !step) return null
  const last = index === persona.steps.length - 1
  return (
    <aside className="tour-strip" role="region" aria-label="Guided tour">
      <div className="tour-strip-inner">
        <div className="tour-strip-meta">
          <span className="tour-strip-role">{persona.role}</span>
          <span className="tour-strip-count">Step {index + 1} of {persona.steps.length}</span>
          <div className="tour-progress" aria-hidden>
            <div className="tour-progress-bar" style={{ width: `${((index + 1) / persona.steps.length) * 100}%` }} />
          </div>
        </div>
        <div className="tour-strip-body">
          <h4 className="tour-strip-title">{step.title}</h4>
          <p className="tour-strip-text">{step.body}</p>
          {step.look && <p className="tour-strip-look"><span className="tour-look-tag">Look for</span>{step.look}</p>}
        </div>
        <div className="tour-strip-actions">
          <button type="button" className="tour-btn" onClick={exit}>Exit</button>
          <button type="button" className="tour-btn" onClick={back} disabled={index === 0}>← Back</button>
          <button type="button" className="tour-btn tour-btn-primary" onClick={next}>{last ? 'Finish' : 'Next →'}</button>
        </div>
      </div>
    </aside>
  )
}
