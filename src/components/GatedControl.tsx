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
//
// HOW "CLOSED" IS EXPRESSED, and the one rule this file exists to hold. The
// HTML `disabled` attribute takes a button out of the keyboard order and stops
// it being announced at all, so a reason carried by `disabled` — or by a `title`
// only a mouse pointer ever finds — is a reason nobody using a keyboard, a
// screen reader or a touch screen will ever be given. So: the reason a control
// will not act is always on screen next to it, always has an id the button
// points `aria-describedby` at, and the button is always still tabbable.
// `disabled` is used for exactly one state — `running`, this control's own write
// in flight, which is not a reason but a duration, says so in its own label, and
// ends by itself.
//
// This is a correction, made before Phase 3 put nine permission-aware rows on
// this component. Until 2026-09-17 the line below `disabled` read "never
// `disabled`" while the line above it set `disabled={running || blocked !== null}`
// and put the only copy of an `unavailable` reason in `title=`. Both are gone.

import { useId, useRef, useState, type RefObject } from 'react'
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
   *
   * Rendered as a plain sentence under the button, and pointed at by the
   * button's `aria-describedby`. It wears no class and no box on purpose: it
   * takes the type of whatever row or dialog it was dropped into, because the
   * one treatment this component already owns — `.gate-note`, outlined in
   * `--gm-st-danger` — means "the platform refused you", and "another run is
   * already in progress" is not that. A class with no rule in App.css would be
   * markup rendering unstyled with nothing to say so, which is the defect
   * src/app/retiredClasses.test.ts exists to catch.
   *
   * Suppressed while this control's own write is running: every caller computes
   * this string from the same state the click just set, so leaving it up would
   * print "Another run is already in progress." under a button reading
   * "Deploying…", about itself.
   */
  unavailable?: string | null
  /** Performs the write. Expected to report its own outcome; the gate only cares
   *  whether the platform refused something while it ran. */
  run: () => Promise<unknown>
  /**
   * A requirement the person has not met YET, stated somewhere on screen —
   * `<ConfirmDialog>`'s type-to-confirm field is the only caller. Distinct from
   * `unavailable`, which is the caller saying "not now" about its own state.
   * Both keep the button reachable and announced; what this one adds is
   * somewhere for a press to GO. The caller already has the sentence on screen
   * and owns the element the person has to satisfy, so it supplies the id rather
   * than having this component print a second copy of the requirement.
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

/**
 * One thing standing between the press and the write: the id of the sentence
 * saying so, and — if there is anywhere useful to send someone who presses
 * anyway — where that press goes.
 */
interface Stop {
  /** The on-screen sentence, for `aria-describedby`. */
  id: string
  /** What a press does instead of writing. Absent when there is nothing to do
   *  but read the sentence the button already points at. */
  go?: () => void
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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const refusalId = useId()
  const statedId = useId()

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

  // See `unavailable`: while this control is the run in flight, the caller's
  // sentence is about this button, and printing it under this button is a loop.
  const stated = running ? null : unavailable

  // Everything stopping the click, outermost first — and outermost is the one a
  // press should go to. A latched refusal outranks a form requirement because
  // meeting the requirement still cannot make the write land; the requirement
  // outranks the caller's "not right now" because it is the one with somewhere
  // to send focus. `aria-describedby` gets all of them: they are all true at
  // once, and a button that named only the first would leave somebody satisfying
  // it and finding nothing had changed.
  const stops: Stop[] = []
  if (gate.reason) stops.push({ id: refusalId, go: () => retryRef.current?.focus() })
  if (blockedUntil) stops.push({ id: blockedUntil.describedBy, go: blockedUntil.onActivate })
  if (stated !== null) stops.push({ id: statedId })

  return (
    <span className="gate">
      <button
        ref={buttonRef}
        type="button"
        className={className}
        // The ONE legitimate `disabled`: this control's own write is in flight.
        // Not a reason — a duration, already spelled out by `busyLabel`, and
        // over in a second or two without anybody doing anything about it. See
        // the header for why no other state may use this attribute.
        disabled={running}
        // Reachable, announced as unavailable, and pointed at every sentence on
        // screen that says why. No `title`: a tooltip is invisible to a keyboard
        // and to a finger, so it can only ever be a second copy of something
        // already readable.
        aria-disabled={stops.length > 0 ? true : undefined}
        aria-describedby={stops.length > 0 ? stops.map((s) => s.id).join(' ') : undefined}
        onClick={() => {
          // Reached on a real press, because the button is not `disabled`. The
          // write is refused HERE, not by the browser, so no caller has to
          // re-check what it already told us.
          if (stops.length > 0) { stops.find((s) => s.go)?.go?.(); return }
          void attempt()
        }}
      >
        {running ? (busyLabel ?? label) : label}
      </button>
      {stated !== null && <span id={statedId}>{stated}</span>}
      <GateNote
        write={write}
        textId={refusalId}
        retryRef={retryRef}
        // "Try again" removes the note it is standing in, so focus would land on
        // <body> — one press after the press that brought focus here. Put it
        // back on the button, which is now pressable and is what somebody
        // clearing a refusal is going to want next.
        onCleared={() => buttonRef.current?.focus()}
      />
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
 *
 * `role="status"` and not focus: the note appears as the result of a press the
 * person made, so it is announced where they are rather than dragging them to
 * it. The three optional props are how `<GatedControl>` wires its own button to
 * this note — a description to point at, a place for a blocked press to land,
 * and somewhere for focus to go when the note removes itself. A screen rendering
 * this on its own passes none of them and gets what it always got.
 */
export function GateNote({
  write,
  textId,
  retryRef,
  onCleared,
}: {
  write: WriteId
  /** Id for the sentence, so a button elsewhere can describe itself with it. */
  textId?: string
  /** The "Try again" button, so a press on a blocked control can land on it. */
  retryRef?: RefObject<HTMLButtonElement | null>
  /** Ran after the refusal is cleared and this note is about to unmount. */
  onCleared?: () => void
}) {
  const gate = useWriteGate(write)
  if (!gate.reason) return null
  return (
    <span className="gate-note" role="status">
      <span className="gate-note-text" id={textId}>{gate.reason}</span>
      <button
        ref={retryRef}
        type="button"
        className="btn btn-ghost gate-retry"
        onClick={() => { gate.clear(); onCleared?.() }}
      >
        Try again
      </button>
    </span>
  )
}
