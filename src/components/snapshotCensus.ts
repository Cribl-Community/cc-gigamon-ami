// How many panels on this tab are actually showing a snapshot, and how old the
// oldest of them is.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NUMBER THIS EXISTS TO STOP BEING FALSE. Two manifest entries exist today
// and thirty-nine panels do not have one. A control labelled "Snapshot" with
// nothing else beside it claims the whole screen came from a stored run, and on
// every tab but two that is wrong. So the header says `3 of 6 panels`, counted
// from what is mounted right now, and it climbs visibly as entries land instead
// of over-claiming from the first day.
//
// ── IT COUNTS PANELS, AND THAT IS THE WHOLE REASON IT IS HERE AND NOT IN
// cribl/jobCost.ts ──────────────────────────────────────────────────────────
// The census could have been built on the search hooks, which is where the
// acceleration state comes from. It would then have counted Flow Map's graph
// as three (Q1 + Q2 + Q3 are one visual) and Data Flow's toolbar as three, and
// `3 of 6` would have been a sentence about a unit the reader cannot see.
// `<Panel>` IS the customer's unit — one card, one title, one ⓘ — so the
// registration goes there, and the header's headline number means what it says.
//
// What it therefore does not count: the KPI tile rows above the panels, and
// anything a tab renders outside a `<Panel>`. Both are stated in the ⓘ's words
// rather than silently folded in.
//
// ── MODELLED ON cribl/jobCost.ts, DELIBERATELY ──────────────────────────────
// Same shape: a map of mounted slots, one recompute, and a cached snapshot
// object so `useSyncExternalStore` has a stable identity to compare. The two
// registries are separate because they answer different questions — jobCost
// answers "what does a refresh cost", this answers "what am I looking at" — and
// folding them together would make every panel that wants one take the other.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AccelOutcome, AccelSource } from '../cribl/accel/read'

/**
 * What a panel knows about where its own numbers came from.
 *
 * Every field is what `useSearch` already answers with, passed through
 * unchanged. Nothing here is built from an API response: `outcome` is one of
 * accel/read.ts's own closed set of values, and the words for each of them are
 * written in snapshotNote.ts.
 */
export interface PanelSnapshotState {
  /** Which read answered on this page load. */
  source: AccelSource
  /** Why it ended up there. Null means this panel never had a schedule at all,
   *  which must not be renderable as "its schedule has not run". */
  outcome: AccelOutcome | null
  /** Epoch ms the answering run finished; null on every live read. */
  at: number | null
  /** The stored result is older than its schedule promises. */
  stale: boolean
  /** The viewer pressed this panel's own Live control for this visit. */
  liveOnly?: boolean
  /** When `source` is `'none'`: the nearest stored run this panel does have, so
   *  the caption can offer it instead of only reporting a gap. */
  nearestAt?: number | null
}

export interface SnapshotCensus {
  /** Mounted `<Panel>`s, snapshot-served or not. The denominator. */
  panels: number
  /** Those of them showing a dated stored run right now. */
  snapshotted: number
  /** Epoch ms of the OLDEST of those — the one that decides whether the reader
   *  should trust the screen, which a mean or a newest would hide. */
  oldest: number | null
}

interface Slot {
  id: number
  state: PanelSnapshotState | null
}

let nextId = 1
const slots = new Map<number, Slot>()
const listeners = new Set<() => void>()

const EMPTY: SnapshotCensus = Object.freeze({ panels: 0, snapshotted: 0, oldest: null })
let snapshot: SnapshotCensus = EMPTY

/**
 * Whether this panel is showing a stored run right now.
 *
 * Three conditions, and each one was a way of over-claiming:
 *
 *   * A stored run answered. Obvious.
 *   * This app can DATE it. An undated result never reaches here — read.ts
 *     falls back to live rather than return a number it cannot label — but a
 *     slot counted without an `at` would raise the numerator and contribute
 *     nothing to `oldest`, which is the shape of a count that is quietly high.
 *   * The viewer has not run this panel live. `3 of 6` means "three of these
 *     panels are showing you a stored run", and a panel the reader has just put
 *     back on its own query is not one of them — including for the second or
 *     two before the live read returns and rewrites the rest of the state.
 *
 * It is also what decides whether a panel is offered its own Live control, so
 * the header's count and the control's presence can never disagree.
 */
export function snapshotServed(s: PanelSnapshotState | null | undefined): boolean {
  return !!s && !s.liveOnly && s.source === 'schedule' && s.at !== null
}

function recompute(): void {
  let panels = 0
  let snapshotted = 0
  let oldest: number | null = null
  for (const slot of slots.values()) {
    panels += 1
    if (!snapshotServed(slot.state)) continue
    snapshotted += 1
    const at = slot.state!.at!
    if (oldest === null || at < oldest) oldest = at
  }
  if (panels === snapshot.panels && snapshotted === snapshot.snapshotted && oldest === snapshot.oldest) return
  snapshot = Object.freeze({ panels, snapshotted, oldest })
  for (const l of listeners) l()
}

/**
 * Register this panel in the census for as long as it is mounted.
 *
 * Called unconditionally by `<Panel>`, including for the panels that have no
 * schedule — they are the denominator, and a census that counted only the
 * snapshot-served ones would report `3 of 3` on a tab of six.
 *
 * The state is written into a stable slot object and the recompute is driven by
 * an effect, so a parent re-rendering with an equal state does no work and
 * emits nothing.
 */
export function useSnapshotSlot(state: PanelSnapshotState | null | undefined): void {
  const ref = useRef<Slot | null>(null)
  if (ref.current === null) ref.current = { id: nextId++, state: state ?? null }
  const slot = ref.current

  useEffect(() => {
    slots.set(slot.id, slot)
    recompute()
    return () => {
      slots.delete(slot.id)
      recompute()
    }
  }, [slot])

  // Each field separately in the key rather than the object: a call site that
  // builds the state inline — which is every one of them — hands a new object
  // every render, and keying on it would recompute the whole census on each.
  const { source = null, outcome = null, at = null, stale = false, liveOnly = false } = state ?? {}
  useEffect(() => {
    slot.state = source === null ? null : { source, outcome, at, stale, liveOnly }
    recompute()
  }, [slot, source, outcome, at, stale, liveOnly])
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const getSnapshot = () => snapshot

/** What the header control says it is showing. */
export function useSnapshotCensus(): SnapshotCensus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Tests only: an app with nothing mounted. */
export function resetSnapshotCensus(): void {
  slots.clear()
  snapshot = EMPTY
  for (const l of listeners) l()
}

/**
 * One caption for a panel several hooks feed.
 *
 * Flow map's graph is three searches in one card, and Data Flow's toolbar is
 * three. `<Panel>` takes one state because the reader sees one card, so the
 * three have to be reduced to one — and the reduction is not an average, it is
 * the worst case:
 *
 *   * ANY hook with nothing stored from the moment that was picked makes the
 *     whole card `none`. Half a graph drawn from 04:20 with the other half from
 *     now is the one outcome a timeline must never produce, and it would look
 *     completely normal.
 *   * ANY hook that ran live makes the card live. A card labelled "snapshot
 *     08:20" while one of its three searches ran a moment ago is a false claim
 *     about the picture as a whole.
 *   * Otherwise the card is a snapshot dated by its OLDEST part, because that is
 *     the age of the least current thing on it.
 *
 * Undefined in, undefined out: a panel none of whose hooks has a schedule is not
 * in the census's numerator and has no caption.
 */
export function mergeSnapshotStates(
  states: ReadonlyArray<PanelSnapshotState | undefined>,
): PanelSnapshotState | undefined {
  const present = states.filter((s): s is PanelSnapshotState => s !== undefined)
  if (present.length === 0) return undefined

  const absent = present.filter((s) => s.source === 'none')
  if (absent.length > 0) {
    const nearest = absent.map((s) => s.nearestAt).filter((n): n is number => typeof n === 'number')
    return {
      source: 'none',
      outcome: absent[0].outcome,
      at: null,
      stale: false,
      // The nearest run any of the missing parts has — the closest whole picture
      // is no earlier than that.
      nearestAt: nearest.length > 0 ? Math.max(...nearest) : null,
    }
  }

  const live = present.find((s) => s.source !== 'schedule' || s.at === null)
  if (live) return live

  const oldest = present.reduce((a, b) => ((a.at as number) <= (b.at as number) ? a : b))
  return { ...oldest, stale: present.some((s) => s.stale) }
}
