// The transient report of what a write did, and why the old one was not heard.
//
// WHAT IT REPLACES. Guided Setup carried its own toast stack: `Toast` state, an
// id counter, a `setTimeout` per toast, six `.gs-toast*` rules and a fixed
// container in that tab's JSX. It was the only toast surface in the app, and it
// is the only place a customer learns that a commit landed, that a deploy failed
// or that the KV write behind "remember this worker group" was refused.
//
// THE ACCESSIBILITY BUG IT FIXES, which is the reason this is not a pure
// refactor. The old markup was `<div className="gs-toasts" aria-live="polite">`
// rendered only `{toasts.length > 0 && …}`, with the text inside it. So the live
// region and its first message entered the DOM in the same commit — and a
// generic `aria-live` region that appears already populated is commonly not
// announced at all, because there was no region for the AT to be watching when
// the content "changed". "Deploy failed — …" is the outcome of a write the user
// deliberately confirmed, and it was reaching assistive technology by luck. It
// was `polite` besides, and it auto-dismissed after 6s with no close button, so
// anyone who missed it — sighted or not — had no way back to it.
//
// Capra's Toast fixes the part that matters. Each toast carries its own role on
// the node being inserted: `alert` + `aria-live="assertive"` for error and
// warning, `status` + `polite` for info and success, `aria-atomic="true"` on
// both. `role="alert"` inserted into the document is the one pattern assistive
// technology is specified to announce on insertion, which is exactly what the
// old container was not. Errors are pushed here with `duration: 0` — Capra's
// "never auto-dismiss" — and keep its default close button, so a failure stays
// until it is dismissed.
//
// WHAT IS STILL BEST-EFFORT, said out loud rather than claimed as fixed: Capra's
// container renders nothing while empty, so a `status` toast is also inserted
// with its text rather than into a region that was already being watched.
// `status` has weaker insertion support than `alert`. That falls on the info and
// success toasts — progress narration and "deployed ✓" — and not on the one
// message a customer has to act on. If it ever needs to be certain, the fix is a
// permanently mounted `role="status"` element here, not a change to the errors.
//
// PROGRESS IS ONE LINE, NOT A QUEUE. A deploy emits eight phases — five
// `provision`, then `commit`, `deploy`, `done`. The old stack showed each for
// 2.6s; Capra enforces a 5s floor (5s + 1s per 120 words), so keeping the old
// shape would have stacked most of a run on screen at once. Instead each progress
// phase replaces the previous one, which is what a progress line is, and the
// terminal phase clears it before saying how it ended.

import { Toast } from '@capra/core'
import type { Phase } from '../cribl/provision'

/**
 * The progress toast currently on screen, if any. Module scope rather than
 * component state because `pushToast` is handed to `deployAll`/`removeOnboardingStack`
 * as a plain callback and has no component to live in — the same reason the old
 * implementation needed a ref.
 */
let progressId: string | null = null
/** The last error still on screen. An error never auto-dismisses, so nothing
 *  else would ever take it away — and an error from a failed run that outlives
 *  a successful retry tells the customer the deploy failed moments after it
 *  succeeded. A new run clears it: the previous outcome is no longer the
 *  outcome. */
let errorId: string | null = null

function clearProgress() {
  if (progressId === null) return
  Toast.destroy(progressId)
  progressId = null
}

/** Retract the previous run's error, if one is still showing. */
export function clearToastError(): void {
  if (errorId === null) return
  Toast.destroy(errorId)
  errorId = null
}

/**
 * Report one phase of a provisioning run.
 *
 * The adapter the UX spec asks for: `Phase` is what `src/cribl/provision.ts`
 * emits, and this is the only place that decides what each kind looks and sounds
 * like. Callers pass a phase; they do not choose a severity, a duration or a
 * politeness.
 */
export function pushToast(p: Phase): void {
  switch (p.kind) {
    case 'provision':
    case 'commit':
    case 'deploy':
      // A run has started, so the last run's failure is history.
      clearToastError()
      clearProgress()
      progressId = Toast.info(p.text)
      return
    case 'done':
      clearProgress()
      clearToastError()
      Toast.success(p.text)
      return
    case 'error':
      clearProgress()
      // duration 0 is Capra's "never auto-dismiss". A failed deploy is the one
      // thing on this screen a customer has to act on, and it outlives the run.
      errorId = Toast.error(p.text, { duration: 0 })
      return
  }
}

/**
 * The root mount. Capra portals the toast container to `document.body`, so this
 * renders nothing where it sits and only needs to exist once — main.tsx, beside
 * `<App/>`.
 */
export function ToastProvider() {
  return <Toast.Provider />
}
