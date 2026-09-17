// What one viewer has already seen.
//
// Two banners in this app offer themselves once and then stay out of the way:
// the first-run guided-tour nudge, and the note offering to generate dataset
// intelligence for the Lake dataset. Both used to remember their dismissal in
// localStorage, which in this sandbox can be partitioned, cleared or blocked,
// and which never follows a person to a second browser or a second seat
// (AGENTS.md, CLAUDE.md). So both now live in one per-user document in the
// app-scoped KV store, reached through cribl/kv.ts.
//
// ONE DOCUMENT, NOT ONE KEY PER FLAG. Both flags are read together on every
// load and written one at a time by a click, so a single `app/prefs/<userId>`
// document costs one GET for the whole app rather than one per banner. What
// that buys has a price: every write carries the whole document, which is why
// writes below are chained rather than fired off in parallel.
//
// WHY THERE IS A THIRD STATE. localStorage was synchronous — the old code read
// it during useState initialisation and the first frame was already correct.
// The KV store is a round trip, so between mount and the answer landing the
// preference is genuinely UNKNOWN, and that has to be a value the UI can see
// rather than a `false` standing in for it. Defaulting to `false` would render
// both banners for every returning viewer on every load and then snatch them
// away a moment later: a flash, shown to exactly the people who already said
// no, and one that reads as a broken app rather than as a slow one. So usePref
// answers `undefined` until the document lands and both callers render nothing
// while it does. The cost is the other way round and much smaller: a first-time
// viewer waits one round trip for an invitation they were not expecting. The
// alternative — show the banner immediately, hide it when the answer arrives —
// is defensible when the banner IS the page. Neither of these is the page.
//
// NO USER, NO KEY. currentUserId() answers null on the localhost dev page, and
// could answer null inside Cribl on an older platform build. There is then no
// per-user document to read and none to write: the defaults apply, a dismissal
// is honoured for as long as the page lives, and the store is never touched. It
// must never fall back to a shared id such as `anonymous` or to the string
// `null` — one viewer's dismissal would become everybody's, which is the whole
// reason these are per-user (see user.ts).
//
// WHAT IS NOT MIGRATED. The two localStorage keys this replaces
// (`gigamon-npm-tour-seen`, `gigamon-npm-intel-dismissed`) are dropped, not
// copied forward. Reading one and writing it into the store would be a write on
// load, which AGENTS.md forbids, and neither key is worth an exception to that:
// a viewer who already dismissed a banner sees it once more and dismisses it
// once more, this time somewhere it will survive a new browser.

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { getDoc, putDoc } from './kv'
import { currentUserId } from './user'

/** The flags the per-user document holds. Each records something this viewer
 *  has already seen, so absent means "not yet" — a viewer who has dismissed
 *  nothing has no document at all, and that is the normal state. */
export interface Prefs {
  /** The first-run guided-tour nudge has been taken or dismissed. */
  tourSeen?: boolean
  /** The "generate dataset intelligence" note has been dismissed. */
  intelPromptDismissed?: boolean
}

const key = (userId: string) => `app/prefs/${userId}`

/** The document, or null while it is still unknown. Replaced wholesale on every
 *  change, never mutated, so useSyncExternalStore can compare by identity. */
let prefs: Prefs | null = null
let started = false
const listeners = new Set<() => void>()

function publish(next: Prefs): void {
  prefs = next
  for (const l of listeners) l()
}

/**
 * Read the document, once per page.
 *
 * A GET needs no confirmation (AGENTS.md) and nothing here writes, which is the
 * rule that matters on a load path: an absent document, a corrupt one, or an
 * unreachable store all simply leave the defaults in force. kv.ts deliberately
 * does not repair a corrupt value either, for the same reason.
 */
/** Resolves when the stored document has landed (or failed to). `persist` waits
 *  on it — see the comment there; without it a click mid-read writes a document
 *  that has forgotten every flag the reader was still fetching. */
let loaded: Promise<void> = Promise.resolve()

function load(): void {
  if (started) return
  started = true
  loaded = (async () => {
    const userId = await currentUserId()
    const stored = userId ? await getDoc<Prefs>(key(userId)) : null
    // Resolved to {} rather than left pending when nobody is named, so an
    // unidentified viewer gets the defaults and a working app instead of two
    // banners that never arrive.
    //
    // Anything set while the read was in flight wins over what came back: that
    // is this viewer clicking, and the stored document is older than the click.
    publish({ ...(stored ?? {}), ...(prefs ?? {}) })
  })()
  void loaded
}

/** Writes are chained, not raced. Each one carries the whole document, so two
 *  in flight together could land in the other order and undo the flag the
 *  earlier click set. */
let writes: Promise<unknown> = Promise.resolve()

function persist(doc: Prefs): void {
  writes = writes.then(async () => {
    // Wait for the read before writing, and then write what is in memory rather
    // than the document captured at click time. A click that lands mid-read has
    // only its own flag in `doc` — every flag still in flight is missing from
    // it — so persisting `doc` would overwrite the stored document with a
    // narrower one and destroy the older dismissals for good. By the time this
    // resolves, `load` has merged stored under local, and `prefs` is the union.
    await loaded
    const userId = await currentUserId()
    if (!userId) return
    const merged = prefs ?? doc
    // putDoc answers false when the store refused the write — on the localhost
    // dev page it always does. Not surfaced to the viewer on purpose: nobody
    // asked to save anything, and the honest consequence of a refusal is that
    // the banner offers itself again next load and is dismissed again in one
    // click. A settings screen, where a customer pressed Save and is owed an
    // answer, must read that boolean instead of discarding it.
    await putDoc(key(userId), merged)
  })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

const getSnapshot = () => prefs

/**
 * One flag of this viewer's preferences, and a way to set it.
 *
 * The value is `undefined` until the document lands — see the header. Read that
 * as "not yet", never as false: it is the difference between a banner that
 * appears once and one that flashes on every load.
 *
 * Setting is optimistic. The flag changes for this page on the click and the
 * store catches up afterwards, because a dismissal that waits for a round trip
 * before taking effect feels broken, and because the write can legitimately
 * fail (no user named, dev page, store unreachable) without the click being
 * wrong.
 */
export function usePref(name: keyof Prefs): [boolean | undefined, (value: boolean) => void] {
  const doc = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // In an effect, not during render: the read is a side effect, and this way it
  // starts when something is actually on screen waiting for the answer.
  useEffect(load, [])
  const set = useCallback((value: boolean) => {
    // Read from module state rather than from `doc`, so two setters called in
    // one handler compose instead of the second dropping the first's flag.
    const next: Prefs = { ...(prefs ?? {}), [name]: value }
    publish(next)
    persist(next)
  }, [name])
  return [doc === null ? undefined : (doc[name] ?? false), set]
}
