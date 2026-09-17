// What this install remembers about the two scheduled searches it created.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS ANY STATE AT ALL, when the workspace already holds the objects.
//
// `/search/saved` is a flat, shared namespace with no owning-app field. Anyone
// can create a saved search called `gno_lake_30d_c1d`, and Cribl will not say
// who did. So the teardown's question — "is this one ours?" — cannot be answered
// from the workspace alone, and an app that guesses wrong deletes somebody
// else's work. accel/provision.ts answers it from two independent signals, and
// this module is the second of them:
//
//   1. the `GNO …` stamp accel/manifest.ts writes into the object's own
//      `description`. Travels with the object, survives losing this store, and
//      is the one an operator can read in Cribl's UI without the app in front of
//      them. It is also free text a person can edit away.
//   2. this document — which ids THIS install wrote, when, at what app version,
//      and with which digests. Survives somebody editing the description; does
//      not survive the store being unreachable.
//
// Neither alone is enough, and that is the whole argument for the pair: each
// covers exactly the case the other loses.
//
// ── AN UNINSTALL STRANDS EVERY BYTE OF THIS ─────────────────────────────────
// Decision I-D28: the platform gives an app no uninstall hook. Remove the app
// and these three documents stay in the app-scoped store, the two saved searches
// stay in `/search/saved`, and the cron keeps firing — billing a customer for a
// 30-day Lake total that nothing reads any more. That is not a limitation this
// module can fix; it is the reason a teardown BUTTON exists, in the app, while
// somebody can still press it. Anything that makes the button harder to find
// makes the stranded schedule more likely.
//
// ── THE THREE KEYS ──────────────────────────────────────────────────────────
//   accel/state             install-wide: what this app wrote, and when.
//   accel/prefs/<userId>    per viewer: two display choices, below.
//   accel/log/<epochMs>     append-only: one document per confirmed write.
//
// `accel/state` does not use the `app/settings/<name>` shape the other
// install-wide document (`app/settings/search_caps`) does, and the difference is
// meant: a setting is a value a human chose and may edit, while this is the
// app's own record of its own writes. Nobody should open it to change something.
// Keeping it under the same `accel/` prefix as the log and the prefs also means
// one `listKeys('accel/')` enumerates everything Phase 2 ever stored — which is
// what a teardown report needs, and what the next person needs when they go
// looking for what an uninstall left behind.
//
// The audit trail is `accel/…` rather than the `gigamon/…` namespace
// searchCaps.ts and Guided Setup use, for the same reason. One prefix per
// feature area, so the entries for the thing being removed can be listed and
// read without paging through every settings change the install ever made.
//
// ── ONE WRITER, AND THE BUG THAT SHAPED THESE FUNCTIONS ─────────────────────
// Read cribl/prefs.ts's header before changing anything here. That module holds
// its document in module state and rewrites the whole thing on every flag
// change, and a click that landed while the initial read was still in flight
// wrote a document containing only that click's flag — destroying every stored
// preference the reader had not yet received.
//
// Nothing in this file caches a document between calls, and every write does its
// own read INSIDE the serialised turn that performs it (`queue` below). So there
// is no in-flight read for a click to beat: the read a write merges onto is one
// this same write started, after every earlier write has already landed. The
// cost is one extra GET per write, on a screen where writes are confirmed
// clicks; the alternative is the bug above.
//
// Everything goes through cribl/kv.ts — never localStorage, sessionStorage,
// IndexedDB or cookies (AGENTS.md, CLAUDE.md). `putDoc` answers FALSE when the
// store refused, which is always so on the localhost `npm run dev` page: that
// proxy rewrites `/capi` → `/api/v1` without the `/a/{appId}/` scope, so every
// KV call 404s. Every function here hands that boolean back rather than
// swallowing it, because the difference between "recorded" and "in this page
// only" is the difference between a teardown that can prove ownership later and
// one that cannot.
// ─────────────────────────────────────────────────────────────────────────────

import { appendLog, getDoc, putDoc, type LogEntry } from '../kv'
import { currentUserId } from '../user'

/** Install-wide: the ids this app wrote, and what it wrote them as. */
export const ACCEL_STATE_KEY = 'accel/state'

/** Audit-trail namespace — `accel/log/<epochMs>`, one document per entry. */
export const ACCEL_LOG_NAMESPACE = 'accel'

/** Per-viewer preferences. */
export const accelPrefsKey = (userId: string) => `accel/prefs/${userId}`

/**
 * What this install knows about one saved search it wrote.
 *
 * The digests are the reason this is a record rather than a list of ids. They
 * are what the description carried at the moment of the write, so a later read
 * can tell "somebody edited the query in Cribl's UI" from "this app has been
 * upgraded and now intends a different query" — two states that look identical
 * if all you keep is the id.
 */
export interface AccelCreation {
  /** Epoch ms of the write. A corrective re-apply refreshes this, because the
   *  question it answers is "when did this app last write this object", not
   *  "when did it first appear". */
  at: number
  /** The app release that wrote it. Informational: a search created by an older
   *  release is not drifted, it is just older — see accel/provision.ts. */
  appVersion: string
  /** The manifest contract it was written to. This one IS a difference that
   *  matters: it says the SHAPE of the object came from a different list. */
  manifestVersion: number
  /** The `body-sha256:` and `display-sha256:` stamped into the description. */
  bodySha: string
  displaySha: string
  /** Who pressed Apply, or null when the platform named nobody (always so on
   *  the localhost dev page). An invented id would be evidence of something
   *  that never happened — see cribl/user.ts. */
  by: string | null
}

/** The `accel/state` document. `version` so a later shape change is recognised
 *  rather than guessed at; kv.ts's envelope has its own and they are not the
 *  same thing — that one versions the wrapper, this one the contents. */
export interface AccelStateDoc {
  version: 1
  /** Keyed by saved-search id. A plain string key rather than `AccelId`: the
   *  store can hold an id an older release wrote that this release's manifest
   *  no longer knows, and dropping it on read would lose the one record that
   *  proves the orphan is ours. */
  created: Record<string, AccelCreation>
}

const EMPTY_STATE: AccelStateDoc = { version: 1, created: {} }

/** One `AccelCreation`, or null when the stored value is not one. Hand-written
 *  documents and half-migrated shapes both land here; a record that cannot be
 *  read is treated as absent, never repaired (a repair is a write, and reads
 *  run on load — AGENTS.md). */
function asCreation(value: unknown): AccelCreation | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.bodySha !== 'string' || typeof v.displaySha !== 'string') return null
  return {
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
    appVersion: typeof v.appVersion === 'string' ? v.appVersion : 'unknown',
    manifestVersion: typeof v.manifestVersion === 'number' ? v.manifestVersion : 0,
    bodySha: v.bodySha,
    displaySha: v.displaySha,
    by: typeof v.by === 'string' ? v.by : null,
  }
}

/**
 * Read the record. Every kind of nothing — never written, unreachable store,
 * corrupt value, a document somebody hand-edited into a different shape — comes
 * back as the empty record, because the only thing a caller does with it is ask
 * "did this install write id X", and the honest answer to all four is no.
 *
 * That answer is deliberately the SAFE one for the teardown: "we have no record"
 * makes it fall back to the description stamp rather than deleting on trust.
 */
export async function loadAccelState(): Promise<AccelStateDoc> {
  const doc = await getDoc<unknown>(ACCEL_STATE_KEY)
  if (!doc || typeof doc !== 'object') return EMPTY_STATE
  const raw = (doc as { created?: unknown }).created
  if (!raw || typeof raw !== 'object') return EMPTY_STATE
  const created: Record<string, AccelCreation> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = asCreation(value)
    if (entry) created[id] = entry
  }
  return { version: 1, created }
}

/** Whether this install's own record claims it wrote that saved search. */
export function wasWrittenHere(state: AccelStateDoc, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.created, id)
}

/**
 * Writes are serialised, never raced.
 *
 * Each turn re-reads the document and merges onto what it finds, so two
 * confirmed clicks in quick succession compose instead of the second one
 * overwriting the first's ids. The chain never rejects: a failed write answers
 * `false` and the next turn still runs.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * Record that this install wrote these saved searches. Merges: an id already in
 * the document is refreshed, and one this call does not mention is left alone.
 *
 * Only ever called after a write that Cribl accepted. A record written for a
 * POST that failed would tell a later teardown it owns something it never
 * created, which is the one lie this document exists to prevent.
 */
export async function recordAccelWrites(records: Readonly<Record<string, AccelCreation>>): Promise<boolean> {
  if (!Object.keys(records).length) return true
  return serialise(async () => {
    const state = await loadAccelState()
    return putDoc<AccelStateDoc>(ACCEL_STATE_KEY, {
      version: 1,
      created: { ...state.created, ...records },
    })
  })
}

/**
 * Forget these ids — the teardown, after Cribl confirmed each one is gone.
 *
 * The whole document is rewritten with the ids removed rather than deleted, so
 * a partial teardown (one search removed, one refused because it is somebody
 * else's) keeps the record for the one still standing. A key with an empty
 * `created` is also a true statement: this app wrote things here once and does
 * not own any of them now.
 */
export async function forgetAccelWrites(ids: readonly string[]): Promise<boolean> {
  if (!ids.length) return true
  return serialise(async () => {
    const state = await loadAccelState()
    const created = { ...state.created }
    for (const id of ids) delete created[id]
    return putDoc<AccelStateDoc>(ACCEL_STATE_KEY, { version: 1, created })
  })
}

// ── Per-viewer preferences ──────────────────────────────────────────────────

/**
 * What one viewer has chosen about acceleration.
 *
 * PER VIEWER, NOT INSTALL-WIDE, and the distinction is the reason this is a
 * second document rather than two more fields on `accel/state`. Turning
 * acceleration off for everybody is `pauseAcceleration()` — it stops the cron
 * and stops the bill. Nothing here stops anything: these are display choices,
 * and one person making one must not move anybody else's screen.
 */
export interface AccelPrefs {
  /**
   * This viewer wants the two accelerated panels to run their live query
   * instead of reading the scheduled run's stored result.
   *
   * AN ESCAPE HATCH WITH A PRICE, and it is written here so that whoever puts
   * it on screen has to say so beside the control: the live 30-day Lake total
   * is the 9,297.7 billable CPU-s query this whole phase exists to stop running
   * 15–24 times a day. Switching it on for one viewer bills the install for
   * every one of that viewer's page loads. It exists because "the stored number
   * looks wrong" is a real thing to need to check, and the honest way to check
   * it is to run the same query live — not because anyone should leave it on.
   *
   * READ BUT NOT YET WRITTEN ANYWHERE. `useAccelEnabled()` in cribl/useSearch.ts
   * honours it; no control sets it, so today it is reachable only by writing the
   * KV document directly. That is deliberate rather than unfinished: the two
   * off-switches a customer actually needs already exist and are visible —
   * Pause/Remove in the Acceleration panel (install-wide, stops the bill) and
   * Field Explorer's per-panel "Run live" (one question, one query). A third,
   * invisible, per-viewer switch that silently bills the install for somebody
   * else's page loads wants a control that says the price beside it, and that
   * screen has not been designed. The field stays because the read path is
   * built and tested around it; if it is still unwritten when the next surface
   * lands, give it a control or take it out.
   */
  liveReads?: boolean
}

/**
 * This viewer's preferences. `{}` covers every kind of nothing, including "the
 * platform names no signed-in user", where there is no per-user document to read
 * and the defaults simply apply (cribl/user.ts: never invent a shared id, or one
 * viewer's choice becomes everybody's).
 */
export async function loadAccelPrefs(): Promise<AccelPrefs> {
  const id = await currentUserId()
  if (!id) return {}
  const prefs = await getDoc<AccelPrefs>(accelPrefsKey(id))
  return prefs && typeof prefs === 'object' ? prefs : {}
}

/**
 * Set one preference, and say whether the store took it.
 *
 * Read-merge-write rather than writing the one field, and inside the same
 * serialised chain as the state document: a second preference on this screen is
 * a field rather than another key, and a wholesale write is what costs somebody
 * else's setting (see the header, and cribl/prefs.ts).
 *
 * Answers false when nothing was stored — no signed-in user, or a store that
 * refused — and the caller must say so rather than showing the choice as saved.
 */
export async function saveAccelPref<K extends keyof AccelPrefs>(name: K, value: AccelPrefs[K]): Promise<boolean> {
  const id = await currentUserId()
  if (!id) return false
  const key = accelPrefsKey(id)
  return serialise(async () => {
    const stored = await getDoc<AccelPrefs>(key)
    const prefs = stored && typeof stored === 'object' ? stored : {}
    return putDoc<AccelPrefs>(key, { ...prefs, [name]: value })
  })
}

// ── The audit trail ─────────────────────────────────────────────────────────

/**
 * Append one entry to `accel/log/<epochMs>`.
 *
 * One document per entry, stamped by kv.ts with `at` and the signed-in user.
 * Only ever from a confirmed write — creating, correcting, pausing, resuming or
 * removing a scheduled search. Never on load, on render or on a timer: a trail
 * written by a poll records nothing anybody did and fills the store doing it.
 *
 * Not awaited by its callers on purpose. The customer is waiting on their
 * scheduled search, not on the audit copy, and kv.ts already warns once per
 * session when the store is unreachable.
 */
export async function logAccel(entry: LogEntry): Promise<boolean> {
  return appendLog(ACCEL_LOG_NAMESPACE, entry)
}

/** Only for tests: drain the write chain so an assertion reads a settled store. */
export async function accelWritesSettled(): Promise<void> {
  await queue
}
