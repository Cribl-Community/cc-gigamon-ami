// The durable half of the Snapshot / Live mode: what the store remembers, for
// how long, and when the app may act on it.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO MODULES, ONE MODE, AND THE LINE BETWEEN THEM. cribl/dataMode.ts is the
// reactive value — one `useSyncExternalStore`, pressed by the header control,
// subscribed to by every mounted panel. It deliberately holds no KV client, no
// `currentUserId()` and no preference schema, and takes its persistence as an
// injected writer instead. This module is what registers that writer, because
// `accel/prefs/<userId>` has exactly ONE writer and this is it — a second would
// be cribl/prefs.ts's lost-write bug all over again.
//
// So: dataMode.ts answers "what is the mode right now"; this answers "what did
// this viewer choose, is it still valid, and has the app found out yet".
//
// WHAT WAS HERE BEFORE. `useAccelEnabled()` lived in cribl/useSearch.ts as
// `useState(true)` plus a mount effect that could only ever call
// `setEnabled(false)`: every panel read the preference once, privately, and no
// later event could move it. A header segment pressed against that shape changes
// nothing on screen, in any mounted panel, ever.
//
// ── THE TWO MODES, AND WHY NEITHER IS CALLED `Fast` ─────────────────────────
//   snapshot  a panel that names a schedule reads that schedule's stored result
//             (accel/read.ts): the same query text, computed earlier.
//   live      every panel runs its own query now.
//
// `Snapshot` is the plan's own word (§1.6b, "snapshot-served") and it is a claim
// about WHEN, which is the true one. `Fast` would be a claim about speed that
// nothing here can keep: at the polling floor this app now uses a stored read is
// not reliably quicker than a live query against a warm Parquet path. Naming a
// mode after a promise nobody measured is how a UI starts lying.
//
// ── SNAPSHOT IS THE DEFAULT, AND `Live` EXPIRES AT LOCAL MIDNIGHT ───────────
// The owner's design is that the morning open is instant. So the default is
// Snapshot, and a viewer's `Live` is a choice for TODAY: it is stored with the
// epoch of the next local midnight beside it and is read as absent afterwards.
//
// EVALUATED ON READ, NEVER REPAIRED ON LOAD. An expired `liveReads` is read as
// Snapshot and the document is left exactly as it is. Rewriting it here would be
// a write on load, which CLAUDE.md forbids outright; the next press of either
// segment rewrites it anyway, and until then the stored bytes are a true record
// of what somebody chose and when it lapsed.
//
// NO TIMER RE-EVALUATES IT. A page open across midnight keeps the mode it was
// opened with. Expiry is a property of the READ, so it lands on the next load —
// which is the event the owner actually described ("the first time a user opens
// the app in the morning"). Yanking the mode out from under a night-shift
// analyst mid-investigation would be a different feature, and a worse one.
//
// A `liveReads: true` WITH NO EXPIRY IS READ AS EXPIRED. Phase 2 shipped the
// field with no writer, so such a document is either hand-written or from a
// release that predates this control — which is precisely the "somebody turned
// it on and forgot" case the expiry exists to cap. The two errors are not
// symmetrical: honouring it forever is an invisible standing charge, ignoring it
// shows the viewer Snapshot and leaves the Live segment one press away.
//
// ── THE WRITE, AND WHY IT HAS NO CONFIRMATION DIALOG ────────────────────────
// `writeAccelMode` goes through accel/store.ts to cribl/kv.ts#putDoc, already
// declared in cribl/authz.ts's WRITE_SITES as `surface: 'app'` with `gates: []`,
// so it needs no new entry and gets none. It deliberately does NOT get a
// `WriteId` either: every id in GATED_WRITES must have a `<GatedControl>`
// rendered for it (gatedWrites.test.ts checks exactly that), and a permission
// affordance on a control that cannot be refused — it writes this viewer's own
// display preference, to a document keyed on their own id, and moves nobody
// else's screen — teaches people to click through the three dialogs that guard
// writes which restart Worker Processes. What the control owes the reader
// instead is the truth when the store did NOT take it, which is what
// dataMode.ts's `DataModeSave` carries.
//
// THE WRITE IS A CONSEQUENCE OF THE CLICK, NEVER OF A RENDER. Nothing here
// writes on load, on render or on a timer. Hydration is a READ.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react'
import { currentUserId } from '../user'
import { registerDataModeWriter, useDataMode, type DataMode } from '../dataMode'
import { loadAccelPrefs, saveAccelPrefs, type AccelPrefs } from './store'

/** Where a panel's numbers come from. dataMode.ts owns the value; this owns what
 *  is stored about it. */
export type AccelMode = DataMode

/** The owner's design: the morning open is instant. */
export const DEFAULT_ACCEL_MODE: AccelMode = 'snapshot'

/**
 * How long a snapshot-servable panel holds its first submit waiting on the
 * stored preference before running with the default.
 *
 * WHY THERE IS A DEADLINE AT ALL. Holding the first submit is what kills the
 * double submit (see cribl/useSearch.ts), and a hold with no floor is a panel
 * that stays blank for as long as one KV round trip takes to not answer. Two
 * seconds is far past a store that is working — the app-scoped store answers a
 * GET in tens of milliseconds installed, and 404s immediately on the localhost
 * dev page — and far short of a viewer deciding the tile is broken.
 *
 * If the preference lands after the deadline and disagrees, the panel re-submits
 * once: exactly the behaviour every panel had before this module existed, now
 * confined to a store that has stopped answering rather than being the rule on
 * every load.
 */
export const HYDRATE_DEADLINE_MS = 2_000

/**
 * Whether the stored preference has been read, or given up on.
 *
 * Its own tiny store rather than a field on dataMode.ts's, because it is not a
 * property of the mode — it is a property of this app's knowledge of it, and the
 * header control has no use for it at all. Only the panels the mode can change
 * read it, and only to decide whether to submit yet.
 */
let hydrated = false
const listeners = new Set<() => void>()

function publishHydrated(): void {
  if (hydrated) return
  hydrated = true
  for (const l of listeners) l()
}

/** Epoch ms of the next local midnight after `at`. `Date` normalises the day
 *  overflow, so month ends and DST shifts need no arithmetic here. */
export function nextLocalMidnight(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
}

/**
 * The mode a stored preference means right now.
 *
 * Every kind of nothing — never written, corrupt, `liveReads` without an expiry,
 * an expiry that has passed — answers `snapshot`. See the header: the default is
 * the cheap, instant one, and it is also the safe answer to an ambiguous
 * document.
 */
export function accelModeFromPrefs(prefs: AccelPrefs, now: number): AccelMode {
  if (prefs.liveReads !== true) return 'snapshot'
  const until = prefs.liveReadsUntil
  if (typeof until !== 'number' || !Number.isFinite(until)) return 'snapshot'
  return now < until ? 'live' : 'snapshot'
}

/**
 * Persist a mode, and say whether the store took it. dataMode.ts's injected
 * writer — nothing else calls this.
 *
 * `liveReads` and `liveReadsUntil` go in ONE document write. Two would leave a
 * real interval in which the store holds `liveReads: true` with no expiry beside
 * it, and a page that closed in that interval would have written precisely the
 * forgotten-forever state the expiry exists to cap — by the mechanism meant to
 * prevent it.
 *
 * Answers false when nothing was stored (no signed-in user, or a store that
 * refused), which dataMode.ts turns into `save: 'refused'` and the control turns
 * into a line saying the choice will not be remembered.
 */
export async function writeAccelMode(mode: AccelMode): Promise<boolean> {
  if ((await currentUserId()) === null) return false
  return mode === 'live'
    ? saveAccelPrefs({ liveReads: true, liveReadsUntil: nextLocalMidnight(Date.now()) })
    : // Undefined REMOVES the key (accel/store.ts), so Snapshot leaves no stale
      // expiry behind for the next reader to reason about.
      saveAccelPrefs({ liveReads: false, liveReadsUntil: undefined })
}

let hydration: Promise<void> | null = null

/**
 * Read the stored preference once per page and hand dataMode.ts both halves of
 * its persistence.
 *
 * Idempotent: every caller gets the same promise, so a page of forty panels
 * costs one GET.
 *
 * THE WRITER IS REGISTERED SYNCHRONOUSLY, BEFORE THE READ. A viewer who presses
 * a segment in the first few hundred milliseconds would otherwise press a store
 * with no writer, which dataMode.ts correctly reports as `refused` — a true
 * statement about a write that never happened, and a needless one. The stored
 * choice is handed over separately when it arrives, and dataMode.ts applies it
 * only while nothing has been pressed.
 */
export function hydrateAccelMode(): Promise<void> {
  if (!hydration) {
    registerDataModeWriter(writeAccelMode)
    hydration = readPreference()
  }
  return hydration
}

async function readPreference(): Promise<void> {
  // Releases the held submits on the DEFAULT, not on a mode: a store that has
  // not answered says nothing about this viewer.
  const deadline = setTimeout(publishHydrated, HYDRATE_DEADLINE_MS)
  try {
    const prefs = await loadAccelPrefs()
    // A press that beat the read wins — dataMode.ts ignores `initial` once
    // anything has been pressed. That race is the reason this is one call
    // rather than a `setDataMode` from here.
    registerDataModeWriter(writeAccelMode, accelModeFromPrefs(prefs, Date.now()))
  } catch {
    // kv.ts already warns once per session when the store is unreachable, and it
    // answers null rather than throwing; anything landing here is unexpected,
    // and the panels waiting on it must still run.
  } finally {
    clearTimeout(deadline)
    publishHydrated()
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  // The first mounted subscriber starts the read. A READ on mount, which
  // AGENTS.md allows; CLAUDE.md's rule is about writes.
  void hydrateAccelMode()
  return () => {
    listeners.delete(l)
  }
}

const getHydrated = () => hydrated

/**
 * Whether this app yet knows which mode this viewer chose.
 *
 * False only during the first KV round trip of the page's life. A panel the mode
 * can change holds its first submit on it; every other panel ignores it.
 */
export function useAccelModeHydrated(): boolean {
  return useSyncExternalStore(subscribe, getHydrated, getHydrated)
}

/** The same answer for code that is not a component, and for the tests. */
export function accelModeHydrated(): boolean {
  return hydrated
}

/**
 * Whether this viewer wants snapshot-served panels served from their schedule.
 *
 * The name and the boolean are kept from the mount-time hook this replaced, so
 * DataFlow's `accelEnabled` and Field Explorer's `accelOn && !liveOnly` keep
 * reading the way they did — except that they are now reactive, which is the
 * whole point.
 */
export function useAccelEnabled(): boolean {
  return useDataMode() === 'snapshot'
}

/**
 * Only for tests: forget the hydration and the published state.
 *
 * Subscribers are deliberately left alone. A test that resets while a component
 * is mounted still has a live `useSyncExternalStore` subscription, and dropping
 * it would leave that component wired to nothing — a passing test asserting a
 * render that can no longer happen. Reset cribl/dataMode.ts's own store beside
 * this one (`resetDataMode`); they are two halves of one feature.
 */
export function resetAccelMode(): void {
  hydrated = false
  hydration = null
}
