// Which past state the whole app is showing.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS FOR. "What did the network look like at 04:00?" is a question
// this app could not answer at any price: a live query only ever reads now, and
// the range picker only widens a window that still ends now. Twenty-four
// retained runs of an hourly scheduled search are twenty-four past states, each
// already computed and already paid for. This module holds which one a viewer is
// looking at.
//
// ── IT IS A VIEWING MODE, SO IT IS APP-WIDE AND IT SURVIVES A TAB CHANGE ────
// A reader who picks 04:20 on Flow map and clicks through to Findings is
// asking the same question of both. Per-tab state would answer it on one tab and
// silently answer a different question on the next — two tabs side by side
// showing different times with nothing saying so. So it lives here, beside
// cribl/dataMode.ts, in the same `useSyncExternalStore` shape as
// cribl/inflight.ts.
//
// ── AND IT IS NOT PERSISTED, WHICH IS THE OPPOSITE CALL FROM THE MODE ───────
// The Snapshot/Live mode is written to `accel/prefs/<userId>` because it is a
// standing preference. A chosen MOMENT is not: it is a question somebody asked
// once. Stored, it would come back the next morning as a silent claim that
// yesterday's 04:20 is the state of the network — a stale screen that looks
// exactly like a fresh one, which is the failure mode accel/read.ts's whole
// header is about. A reload lands on the newest snapshot, always.
//
// It is also why there is no KV write here, and so no confirmation to argue
// about: nothing leaves the tab.
//
// ── CLEARED WHEN THE MODE GOES LIVE ─────────────────────────────────────────
// In Live mode the control in the header is the range picker, so a chosen moment
// is state nothing on screen mentions. Keeping it would mean pressing Live and
// then Snapshot silently reinstates a time the reader last chose some while ago.
// State that changes what the numbers mean and is visible nowhere is the bug
// this app keeps finding; it is dropped rather than hidden.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react'
import { subscribeDataMode, dataMode } from '../dataMode'

/**
 * Epoch ms of the moment being shown, or null for the newest run.
 *
 * NULL IS NOT "no selection", it is a selection: *follow the newest snapshot*,
 * which is what every panel did before this existed and what the app opens on.
 * Panels read it as "ask for the newest", which keeps accel/read.ts's original
 * path — the one that settles V-23 with its id-then-name fallback — exactly as
 * it was.
 */
let selected: number | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const getSnapshot = () => selected

/** The moment every panel is answering for, or null for the newest. */
export function useSelectedSnapshot(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** The same, for code that is not a component. */
export function selectedSnapshot(): number | null {
  return selected
}

/** Show the state as it was at `at`, or null to follow the newest run. */
export function setSelectedSnapshot(at: number | null): void {
  const next = at !== null && Number.isFinite(at) ? at : null
  if (next === selected) return
  selected = next
  emit()
}

/** Watch from outside React — the store's own tests go through this rather than
 *  around it, so a test cannot pass with the subscription broken. */
export function subscribeSelectedSnapshot(listener: () => void): () => void {
  return subscribe(listener)
}

/** Tests only: back to following the newest run. */
export function resetSelectedSnapshot(): void {
  selected = null
  emit()
}

// Dropping the moment when the mode leaves Snapshot. Registered once, at import,
// because it is a property of the pair and not of any component that happens to
// be mounted — a header that unmounted holding the subscription would leave the
// moment stranded.
subscribeDataMode(() => {
  if (dataMode() === 'live') setSelectedSnapshot(null)
})
