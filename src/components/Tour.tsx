import { Modal } from '@capra/core'
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
    /* Plain `.btn`, not `.btn-icon`: this one has a label as well as a glyph, so
       it wants the label padding and the 6px gap the base already sets — which is
       all `.btn-tour` and `.btn-tour-txt` ever added. */
    <button type="button" className="btn" onClick={openPicker} title="Guided tour by role" aria-label="Start a guided tour">
      <CompassIcon /> <span>Guided tour</span>
    </button>
  )
}

/* The one-time nudge for first-time users used to live here as `TourNudge`,
   with its own `.tour-nudge` box. It is now one of the page-level banners
   `AppBanners` draws — same three-state read of `offerNudge`, same two actions,
   one banner treatment for the whole app. See components/AppBanners.tsx. */

/**
 * The persona picker, on Capra's `Modal` — the same dialog `ConfirmDialog` uses,
 * for the reasons that file documents at length: it portals out of `#root`,
 * marks the app `inert` behind it, closes on Escape and on its own ✕, locks page
 * scroll, and labels itself by the `<h2>` it builds from `title`.
 *
 * Four of those five were missing here, and the fifth was hand-rolled. This
 * picker was a `<div role="dialog">` with no `aria-modal`, no focus trap, no
 * Escape, no scroll lock and an `aria-label` duplicating a heading that was an
 * `<h3>` nothing pointed at — Tab walked straight out of it into the page
 * underneath. Only the ✕ was there, and it is Capra's now too.
 *
 * `footer={null}` because there is no action to take here that is not one of the
 * persona cards: a Cancel button beside eight choices is a ninth choice that
 * does nothing the ✕ does not already do.
 */
export function TourPicker() {
  const { pickerOpen, closePicker, start } = useTour()
  return (
    <Modal
      isOpen={pickerOpen}
      title="Guided tour — pick your role"
      onClose={closePicker}
      footer={null}
      // The picker is a two-column grid of cards; `sm` (544px) would leave each
      // persona's question in a 240px column.
      size="md"
    >
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
    </Modal>
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
          <button type="button" className="btn" onClick={exit}>Exit</button>
          <button type="button" className="btn" onClick={back} disabled={index === 0}>← Back</button>
          <button type="button" className="btn btn-primary" onClick={next}>{last ? 'Finish' : 'Next →'}</button>
        </div>
      </div>
    </aside>
  )
}
