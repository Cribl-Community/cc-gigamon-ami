// Whether each scheduled search is still one a panel may read — as the saved
// searches say, not as a preference says.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE READ PATH NEEDS THIS. read.ts answers "is there a readable, dated run"
// and nothing else. That was enough while the only way to stop a schedule was
// Remove. It stopped being enough when Pause and the per-tab and master switches
// arrived (review 2026-09-24, defect 1): a PAUSED schedule still has its last
// runs in `$vt_results` for Cribl's seven-day result retention, so every panel
// it fed kept reading the newest one, went `stale` after two cadences, and then
// told the reader "older than its schedule promises — check the schedule in
// Guided Setup" about a schedule somebody had switched off on purpose. The
// confirmation they pressed said those panels go back to their live queries,
// and priced exactly that. So a paused entry now sends its panels live.
//
// THE SECOND CASE IS DRIFT, AND THE RULE IS THE ⓘ (defect 5). When a release
// changes an entry's body — the Data Flow stack-id change rewrote both
// `gno_pipeline_c1h` and `gno_lake_30d_c1d` — the saved search keeps running the
// OLD query until somebody presses Re-apply. Its stored run is then a number
// from one query shown beside an ⓘ quoting another, which is the one thing the
// whole acceleration design promised could not happen. Two ways out were on the
// table: caption it ("stored run used an older query") and keep reading it, or
// run live. Live, because:
//   * a caption does not make the ⓘ true. The ⓘ would still show a query the
//     number did not come from; the caption would only confess it. Showing the
//     stored query in the ⓘ instead would mean an ⓘ built from Cribl's response
//     rather than from src/queries, which display-freeze.test.ts cannot see.
//   * the price is bounded and visible: the panel's own caption says why it ran
//     live and names the fix, and Guided Setup already shows the row as
//     `differs` with Re-apply beside it. It is the price the panel paid every
//     day before Phase 2.
// What counts as drift HERE is narrower than provision.ts's `differences`: only
// what changes the NUMBER — the query the saved search runs and the window it
// reads. A changed cron, time zone, name or keepLastN changes when or how often
// the number is computed, which staleness already reports; a changed display
// digest with the same body changes the words beside the number, and the tails
// that cut a panel's share out of the scan are applied at read time by THIS
// release, so the stored rows are still the right rows.
//
// ── WHERE THE ANSWER COMES FROM, AND WHEN IT IS READ ────────────────────────
// `readAccelState()` — the same reads Guided Setup's table makes: one
// config-plane `GET /search/saved` list (plus a direct GET only for an id a
// truncated page could not settle), the Lake API's retention (cached for the
// session, lakeWindowRead.ts) and this install's `accel/state` KV record. No
// search is submitted, nothing is billed, NOTHING IS WRITTEN — a verdict that
// looks wrong is reported to the panel, never repaired.
//
// It is read ONCE per page (main.tsx starts it beside the run history) and
// again only when a person asks: the page's Refresh (DashboardContext), Guided
// Setup's Re-check, and after any acceleration write — AccelPanel hands its own
// fresh state to `publishAccelServing` rather than reading it twice. Never on a
// timer: a schedule paused from another browser shows up on the next Refresh,
// and until then the panel reads its stored run exactly as it did before this
// module existed.
//
// ── WHAT IS NOT KNOWN IS NOT GUESSED ────────────────────────────────────────
// Every kind of nothing — the list refused or unreadable, a row this account
// could not settle, a read that has not been started (every unit test that does
// not ask for one) — is `unknown`, and `unknown` reads the stored run as before.
// A refusal must not send every accelerated panel live on an account that simply
// cannot list saved searches: that would turn a permission gap into the
// workspace's full live bill, silently.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react'
import type { AccelId } from './manifest'
import { readAccelState, type AccelState } from './provision'
import { HYDRATE_DEADLINE_MS } from './mode'

/**
 * What the saved search says about one entry, for the read path.
 *
 *  * `scheduled`   — it exists, runs the query this release shows, and its
 *                    schedule is on. Read the stored run.
 *  * `paused`      — its schedule is off (Pause, or a tab or master switch).
 *                    Run live: what the confirmation said and priced.
 *  * `drifted`     — it runs a different query or window than this release
 *                    shows. Run live, and say Re-apply.
 *  * `unscheduled` — no saved search with this id, or one with no schedule at
 *                    all. Nothing will refresh a stored run; run live.
 *  * `unknown`     — not read, or not readable. Read the stored run, as before.
 */
export type ServingVerdict = 'scheduled' | 'paused' | 'drifted' | 'unscheduled' | 'unknown'

/** The verdicts that send a panel to its live query. */
export const SERVES_LIVE: ReadonlySet<ServingVerdict> = new Set(['paused', 'drifted', 'unscheduled'])

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** One verdict per manifest entry, from a state read. Pure; exported for tests. */
export function servingVerdicts(state: AccelState): ReadonlyMap<AccelId, ServingVerdict> {
  const out = new Map<AccelId, ServingVerdict>()
  for (const row of state.rows) out.set(row.id, state.error !== null ? 'unknown' : verdictOf(row))
  return out
}

function verdictOf(row: AccelState['rows'][number]): ServingVerdict {
  if (row.state === 'unreadable') return 'unknown'
  const raw = row.stored
  if (raw === null) return 'unscheduled'
  // PAUSED BEFORE DRIFTED: both run live, and "paused" is the one a person chose
  // — the caption should name their choice, not a Re-apply they may not want.
  if (raw.schedule?.enabled === false) return 'paused'
  // No schedule object at all is what A-SP23's partial PATCH leaves behind: a
  // saved search that will never fire again. `enabled` merely ABSENT inside a
  // schedule is not read as off — nothing measured says what Cribl does with it.
  if (!raw.schedule || typeof raw.schedule !== 'object') return 'unscheduled'
  // Compared against the object itself, whoever wrote it: a `foreign` search
  // under our id that happens to run our query still answers our panel
  // correctly, and one that runs anything else must not.
  const want = row.intended
  if (str(raw.query) !== want.query || str(raw.earliest) !== want.earliest || str(raw.latest) !== want.latest) {
    return 'drifted'
  }
  return 'scheduled'
}

// ── The store ───────────────────────────────────────────────────────────────

let verdicts: ReadonlyMap<AccelId, ServingVerdict> | null = null
/** True from the first load until it lands or its deadline passes. Only the
 *  FIRST load holds panels back; a re-read keeps answering with the verdicts it
 *  is replacing, and a panel whose verdict changes re-runs when it lands. */
let pending = false
let inFlight: Promise<void> | null = null
/** Bumped by `forget`, so a read started before it cannot publish after it. */
let generation = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/**
 * Adopt a state somebody else already read — AccelPanel after its mount read,
 * its Re-check, and every write it confirms (each of which re-reads). One read,
 * two consumers, and the panels hear about a Pause the moment the table does.
 */
export function publishAccelServing(state: AccelState): void {
  generation++
  inFlight = null
  verdicts = servingVerdicts(state)
  if (pending) pending = false
  emit()
}

/**
 * Read the saved searches now. Called once from main.tsx at boot; idempotent
 * while a read is in flight. A config-plane GET, never a write.
 */
export function loadAccelServing(): Promise<void> {
  if (inFlight) return inFlight
  const mine = generation
  const first = verdicts === null
  if (first) {
    pending = true
    emit()
  }
  // The panels waiting on this are released at the deadline whatever happens,
  // on `unknown` — the behaviour they had before this module existed.
  const deadline = first
    ? setTimeout(() => {
        if (pending && mine === generation) {
          pending = false
          emit()
        }
      }, HYDRATE_DEADLINE_MS)
    : null
  const p = readAccelState()
    .then(
      (state) => {
        if (mine !== generation) return
        verdicts = servingVerdicts(state)
      },
      () => {
        // A read that threw says nothing about the schedules. Keep what was
        // known; if nothing was, every entry stays `unknown`.
      },
    )
    .finally(() => {
      if (deadline) clearTimeout(deadline)
      if (mine !== generation) return
      inFlight = null
      pending = false
      emit()
    })
  inFlight = p
  return p
}

/**
 * Re-read, but only on a page that read at all. The page's Refresh calls this;
 * a unit test that never loaded the store must not see its Refresh button start
 * reading saved searches behind its fetch stub.
 */
export function refreshAccelServing(): void {
  if (verdicts === null && !pending && !inFlight) return
  inFlight = null
  generation++
  void loadAccelServing()
}

/** Drop everything. Tests. */
export function forgetAccelServing(): void {
  generation++
  verdicts = null
  pending = false
  inFlight = null
  emit()
}

/** The verdict for one entry right now, or `pending` while the first read may
 *  still answer. */
export function accelServing(id: AccelId): ServingVerdict | 'pending' {
  if (pending && verdicts === null) return 'pending'
  return verdicts?.get(id) ?? 'unknown'
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/**
 * One entry's verdict, reactively. Null in, `unknown` out — a hook with no
 * schedule has nothing to wait for. Returns a string, so a re-read that changes
 * another entry's verdict re-renders this panel without re-running it.
 */
export function useAccelServing(id: AccelId | null): ServingVerdict | 'pending' {
  return useSyncExternalStore(
    subscribe,
    () => (id === null ? 'unknown' : accelServing(id)),
    () => 'unknown',
  )
}
