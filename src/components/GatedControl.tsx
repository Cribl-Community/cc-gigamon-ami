// The button that performs a write, and what it says when Cribl refuses.
//
// WHAT THIS IS NOT. It is not a control that renders itself disabled because the
// current user lacks a permission — the app cannot know that before the click,
// and cribl/authz.ts's header says why at length. A button greyed out with "you
// do not have permission" would be a sentence the app made up, and it would be
// wrong in the expensive direction: greyed out for the non-admins whom
// config/policies.yml was extended to serve, silently, producing no 403 for
// anyone to debug.
//
// WHAT IT IS. It owns the click. It runs the write, watches cribl/authz.ts's
// ledger for a refusal recorded while that write was running, and — if there was
// one — holds the control closed with a sentence naming the method and the path
// Cribl said no to, plus a "Try again" that opens it. The first attempt still
// fails; every attempt after it is stopped at the button with a reason, instead
// of being spent re-applying configuration that cannot land.
//
// The pairing with slice 1.3's confirmations is deliberate and the two are not
// the same thing. A confirmation asks "do you mean this?" before a write that
// WILL work. This answers "Cribl would not let you" after one that did not. A
// screen with an outer trigger that opens a confirmation — Guided Setup — should
// disable that trigger too, from the same gate (`useWriteGate`), so nobody is
// walked into a confirmation they cannot complete.

import { useState } from 'react'
import { denialMark, denialSince, latchDenial, useWriteGate, type WriteId } from '../cribl/authz'

export interface GatedControlProps {
  /** Which declared write this control performs (cribl/authz.ts). */
  write: WriteId
  /** The button's label. */
  label: string
  /** The label while the write is running. Defaults to the label itself. */
  busyLabel?: string
  /** The app's own button classes — this component brings no styling of its own
   *  beyond the wrapper, so a gated button looks exactly like the one it
   *  replaced. */
  className?: string
  /**
   * Why the control cannot run right now for a reason of the CALLER's — another
   * run in flight, a form that has not validated, nothing to save. Null when it
   * can. Kept separate from the gate's own reason because they are different
   * kinds of "no" and only one of them is about permission.
   */
  unavailable?: string | null
  /** Performs the write. Expected to report its own outcome; the gate only cares
   *  whether the platform refused something while it ran. */
  run: () => Promise<unknown>
  /**
   * A requirement the person has not met YET, stated somewhere on screen —
   * `<ConfirmDialog>`'s type-to-confirm field is the only caller. Distinct from
   * `unavailable`, which is the caller saying "not now" about its own state, and
   * the difference is the HTML: `unavailable` takes the button out of the
   * keyboard order, and this one must not.
   *
   * A `disabled` button is not reachable by keyboard and is not announced, so
   * somebody using a screen reader tabs to the end of the dialog, finds nothing
   * after Cancel, and never learns that a button exists or why it will not fire.
   * `aria-disabled` keeps it reachable, says it is unavailable, and `describedBy`
   * points at the sentence that says what to do about it; `onActivate` runs when
   * they press it anyway, which is where the focus moves to the thing they have
   * to satisfy first.
   */
  blockedUntil?: SoftBlock | null
}

/** @see GatedControlProps.blockedUntil */
export interface SoftBlock {
  /** The id of the on-screen element stating what has to happen first. */
  describedBy: string
  /** What to do when somebody activates the control regardless. */
  onActivate: () => void
}

export function GatedControl({
  write,
  label,
  busyLabel,
  className = 'btn btn-primary',
  unavailable = null,
  run,
  blockedUntil = null,
}: GatedControlProps) {
  const gate = useWriteGate(write)
  const [running, setRunning] = useState(false)

  const attempt = async () => {
    setRunning(true)
    // Take the mark BEFORE the write, so only refusals belonging to this attempt
    // are attributed to this control. Anything the page refused earlier — a
    // status check on load, say — is already behind the mark.
    const mark = denialMark()
    try {
      await run()
    } catch {
      // The caller reports its own failure in its own words; there is nowhere
      // for a rejection to go from a click handler. What matters here is only
      // whether the platform said no, which the ledger already knows.
    } finally {
      const refused = denialSince(mark)
      if (refused) latchDenial(write, refused)
      setRunning(false)
    }
  }

  const blocked = gate.reason ?? unavailable
  return (
    <span className="gate">
      <button
        type="button"
        className={className}
        disabled={running || blocked !== null}
        // Reachable, announced as unavailable, and pointed at the sentence that
        // says why — never `disabled`. See `blockedUntil` above.
        aria-disabled={blockedUntil ? true : undefined}
        aria-describedby={blockedUntil?.describedBy}
        title={blocked ?? undefined}
        onClick={() => {
          if (blockedUntil) { blockedUntil.onActivate(); return }
          void attempt()
        }}
      >
        {running ? (busyLabel ?? label) : label}
      </button>
      <GateNote write={write} />
    </span>
  )
}

/**
 * The refusal, wherever a screen needs to show it.
 *
 * Rendered by `GatedControl` under its own button, and separately by any screen
 * whose real trigger is somewhere else — Guided Setup's confirmation closes
 * itself before the write runs, so the button that was refused is gone by the
 * time there is anything to say, and the note belongs beside the outer trigger
 * the user is looking at instead.
 */
export function GateNote({ write }: { write: WriteId }) {
  const gate = useWriteGate(write)
  if (!gate.reason) return null
  return (
    <span className="gate-note" role="status">
      <span className="gate-note-text">{gate.reason}</span>
      <button type="button" className="btn btn-ghost gate-retry" onClick={gate.clear}>
        Try again
      </button>
    </span>
  )
}
