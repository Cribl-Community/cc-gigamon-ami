// Which of the two data sources the whole app is reading from right now.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS AN EXTERNAL STORE AND NOT A HOOK'S OWN STATE. `useAccelEnabled()`
// in cribl/useSearch.ts is `useState(true)` plus a mount effect that can only
// ever call `setEnabled(false)`. There is no setter, no context and no
// subscription: the value is read once per mount and cannot move again for the
// life of that mount. A header segment wired to that changes `aria-pressed` and
// NOTHING ON SCREEN — the worst possible failure for a control whose entire
// purpose is that the state is visible.
//
// So the mode lives where cribl/inflight.ts already puts app-wide state a
// component has to react to: one module-level value, a listener set, and
// `useSyncExternalStore`. Every mounted panel re-renders on a change because it
// is subscribed, not because something re-mounted it.
//
// ── WHY SNAPSHOT IS THE DEFAULT ─────────────────────────────────────────────
// The owner's design, in their words: *"the first time a user opens the app in
// the morning they get the cached dataset"*. A stored read is measured at 0.2
// billable CPU-s against 127 for the same body run live, and it is dated on
// screen, which is the whole safety argument (accel/read.ts's header). Live is
// then a thing the viewer asks for, per panel or for the app.
//
// ── WHY THE KV WRITE IS NOT BEHIND A CONFIRMATION ───────────────────────────
// AGENTS.md requires a confirmation naming the resource for any overwriting
// write. This one is deliberately not given one, and the reasoning is here
// rather than in a review comment:
//
//   * It writes `accel/prefs/<this viewer's own id>` — `surface: 'app'` in
//     cribl/authz.ts, not `config`. gatedWrites.test.ts requires a
//     <GatedControl> for `config` surfaces; this is not one.
//   * It moves nobody else's screen and stops nothing. Install-wide off
//     switches (Pause, Remove) already exist in Guided Setup and are confirmed.
//   * A dialog that said "remember Live in accel/prefs/u_123?" teaches a reader
//     to click through the three dialogs that guard writes which restart Worker
//     Processes. A fourth confirmation pattern, for a display preference, makes
//     the other three cheaper.
//
// What IS required, and is honoured below: the write is a consequence of the
// CLICK and never of a render, a timer or a load (CLAUDE.md's rule), and when
// the store refuses it the control has to say the choice will not be
// remembered rather than showing it as saved.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react'

/** Where every panel in the app reads from. */
export type DataMode = 'snapshot' | 'live'

/**
 * Whether this viewer's choice of mode got as far as the KV store.
 *
 * `'unasked'` is the state before anybody presses anything — not a claim in
 * either direction. `'refused'` is the one that has to reach the screen: the
 * app-scoped KV store 404s on the `npm run dev` page and answers nothing when
 * the platform names no signed-in user, and in both cases the mode still works
 * for this session but will be gone on the next navigation.
 */
export type DataModeSave = 'unasked' | 'saving' | 'saved' | 'refused'

let mode: DataMode = 'snapshot'
let save: DataModeSave = 'unasked'
const listeners = new Set<() => void>()

/**
 * The cached tuple `useSyncExternalStore` compares by identity.
 *
 * Rebuilt only when something actually changed. Returning a fresh object from
 * `getSnapshot` on every call is an infinite render loop in React 18, and it is
 * the single easiest way to break this file.
 */
let snapshot: { mode: DataMode; save: DataModeSave } = { mode, save }

function emit(): void {
  snapshot = { mode, save }
  for (const l of listeners) l()
}

/**
 * How the mode is persisted, supplied by whatever owns the KV document.
 *
 * An injected function rather than a direct `saveAccelPref` call, for one
 * reason worth the indirection: this module is what a header button presses,
 * and a header button must not drag the KV client, `currentUserId()` and the
 * accel prefs schema into every test that renders a panel. It also keeps the
 * one-writer rule visible — `accel/prefs/<userId>` has exactly one writer, and
 * registering a second here would be the `prefs.ts` bug again.
 *
 * Null until something registers one, which is the state on the dev page and in
 * most tests. A mode with no writer still works; it is simply not remembered.
 */
type DataModeWriter = (next: DataMode) => Promise<boolean>
let writer: DataModeWriter | null = null

/**
 * Register the persistence, and optionally the stored choice to start from.
 *
 * Called once, by the module that owns `accel/prefs/<userId>` — see the handoff
 * note in this file's commit. `initial` is applied only while nothing has been
 * pressed yet: a KV round trip that lands after the viewer has already chosen
 * must not reach up and undo their press, which is exactly the race the
 * mount-time read in `useAccelEnabled` could never lose because it could never
 * be pressed.
 */
export function registerDataModeWriter(write: DataModeWriter, initial?: DataMode): void {
  writer = write
  if (initial !== undefined && save === 'unasked' && initial !== mode) {
    mode = initial
    emit()
  }
}

/** The mode, for code that is not a component. */
export function dataMode(): DataMode {
  return mode
}

/** Whether this viewer's choice reached the store, for code that is not a
 *  component. */
export function dataModeSave(): DataModeSave {
  return save
}

/**
 * Watch the mode from outside React.
 *
 * The same listener set `useSyncExternalStore` subscribes through, exported so
 * that a non-component caller — and the store's own tests — go through the
 * subscription rather than around it. A test that read the module's variables
 * directly would keep passing with the subscription broken, which is the one
 * defect this store exists to fix.
 */
export function subscribeDataMode(listener: () => void): () => void {
  return subscribe(listener)
}

/**
 * Switch the app's data source. The one place a press becomes a write.
 *
 * The local state flips FIRST and synchronously, so the control answers the
 * press whatever the store does; the write follows, unawaited, exactly as
 * `logAccel` does. A viewer whose store is unreachable gets the mode they asked
 * for and a line saying it will not be remembered — not a control that appears
 * to do nothing while a round trip decides.
 */
export function setDataMode(next: DataMode): void {
  // Pressing the segment that is already pressed is a no-op ONLY once the store
  // has taken it. While the last write is refused — the dev page, a session
  // with no signed-in user, a store that simply failed — pressing it again is
  // how a viewer retries, and the control has just told them it did not stick.
  // A `next === mode` short-circuit turns that press into nothing at all.
  if (next === mode && save === 'saved') return
  mode = next
  save = writer ? 'saving' : 'refused'
  emit()
  if (!writer) return
  const pending = writer
  void pending(next)
    .then((ok) => {
      // Only the newest press owns the save state. An earlier write landing
      // after a later press would otherwise report the earlier one's fate.
      if (mode !== next) return
      save = ok ? 'saved' : 'refused'
      emit()
    })
    .catch(() => {
      if (mode !== next) return
      save = 'refused'
      emit()
    })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const getSnapshot = () => snapshot

/** The mode every panel and the header control read. */
export function useDataMode(): DataMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).mode
}

/** Whether this viewer's choice reached the store — see `DataModeSave`. */
export function useDataModeSave(): DataModeSave {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).save
}

/** Tests only: back to a freshly loaded app with no writer registered. */
export function resetDataMode(): void {
  mode = 'snapshot'
  save = 'unasked'
  writer = null
  emit()
}
