// The one place this app remembers anything: the app-scoped Cribl KV store.
//
// Browser storage is not an option here, and not as a matter of taste — the app
// runs in a sandboxed iframe where localStorage can be partitioned, cleared or
// blocked by the browser or the platform, and where nothing it holds follows a
// user to a second browser or a second seat (AGENTS.md, CLAUDE.md). So every
// durable thing goes through this module, and nothing in it touches
// localStorage, sessionStorage, IndexedDB or cookies.
//
// The transport is cribl/capi.ts — one API module for the whole app. What lives
// here is what is true of the STORE rather than of the API: its envelope, its
// key shapes, what its 404 means, and the one corrupt value it can hand back.
//
// `/kvstore/<key>` is rewritten by the platform fetch proxy to
// `/api/v1/a/{appId}/kvstore/<key>`, which scopes the store to this app, carries
// the app's identity and auth, and needs no policies.yml entry — app-scoped
// paths are granted with the app itself (AGENTS.md).
//
// Key shapes, from the plan:
//   app/settings/<name>   install-wide setting — one value every viewer reads
//   <ns>/prefs/<userId>   one document per user per namespace
//   <ns>/log/<epochMs>    append-only audit trail, one document per entry
//
// WHAT SPIKE K-S10 MEASURED (2026-09-15, against the Live Preview app id
// `__dev__cc-gigamon-ami`). This module is built to these, so they are recorded
// here rather than re-derived by the next person:
//   * PUT with `Content-Type: application/json` answers 200 and stores the
//     literal string `[object Object]`. Only `text/plain` round-trips a JSON
//     document — see putDoc, where that content type is the fix, not an oversight.
//   * `POST /kvstore/keys` with a `{"prefix": …}` body answers 200 with a bare
//     JSON array of key names — no `items` envelope — and the endpoint is absent
//     from the 4.19.0 OpenAPI spec, so listKeys parses the answer defensively.
//   * The store was empty when this was written: the app had never successfully
//     written a key, so there is no legacy data to migrate, only legacy shapes.
//
// WHERE THIS WORKS. Anywhere the app runs inside Cribl, the in-UI Live Preview
// included, because there `window.CRIBL_API_URL` is set and the proxy adds the
// `/a/{appId}/` scope. The one place it does not is the bare localhost dev page
// (`npm run dev`, :5173): that proxy rewrites `/capi` → `/api/v1` without the app
// scope, and `__dev__<name>` is not a registered app, so every call 404s.
//
// Rather than guess at the environment, this module keeps a session-lifetime
// shadow of the writes the store REFUSED, and reads fall back to it. That is
// what stops a developer re-dismissing the same banner every time they navigate
// back to a tab, and it costs nothing when the store works, because a write the
// store accepted never enters the shadow. Its limits, stated plainly because a
// shadow is easy to mistake for persistence: it lives in one page's memory, so a
// full reload starts empty; it is not shared with another tab, another user or
// the server; and it holds only what this session tried to write, so it is not a
// cache of the store. A caller that has to tell a customer whether something was
// really saved reads putDoc's answer, which is false whenever only the shadow
// holds it.

import { capi } from './capi'
import { currentUserId } from './user'

/** The wrapper every document this module writes is stored inside. `version`
 *  exists so a later shape change can be recognised rather than guessed at. */
interface Envelope<T> {
  version: 1
  /** Epoch ms of the write — for a human reading the raw store. */
  updatedAt: number
  doc: T
}

/** What the store answers with for a document PUT as `application/json`:
 *  `String(obj)`. It is not data, so getDoc reads it as an absent key. */
const CORRUPT = '[object Object]'

/** Writes the store refused, by key, holding the envelope text that was offered. */
const shadow = new Map<string, string>()

let warned = false

/** One warning per session. A store that is unreachable is unreachable for every
 *  call, and a console full of the same line hides the first one. */
function unavailable(what: string, detail?: unknown): void {
  if (warned) return
  warned = true
  console.warn(
    `Cribl KV store unavailable (${what}) — anything this session saves stays in this page for now. On the localhost dev page that is expected; inside Cribl it is not.`,
    detail,
  )
}

function badKey(key: string): void {
  console.warn(`Cribl KV store: refusing an empty key (${JSON.stringify(key)})`)
}

/** API path for a key, or null when the key names nothing. Slashes stay slashes
 *  — they are the store's own path separators — but each segment is encoded,
 *  because a user id or a dataset name may contain characters a URL would
 *  otherwise read as structure. */
function keyPath(key: string): string | null {
  const path = key.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return path ? `/kvstore/${path}` : null
}

const isOk = (status: number) => status >= 200 && status < 300

function parseDoc<T>(text: string): T | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Something non-JSON is under this key. Same treatment as a corrupt value:
    // read as absent, and left exactly where it is.
    return null
  }
  if (value && typeof value === 'object' && (value as Envelope<T>).version === 1 && 'doc' in value) {
    return (value as Envelope<T>).doc
  }
  // A bare document — written by a caller that predates the envelope (Guided
  // Setup's commit memory is the one such key). Returned as it stands, so
  // moving a caller onto this module does not lose what it already stored.
  return value as T
}

/**
 * Read a document. Answers null for every kind of "nothing usable here": the key
 * is absent (the store's 404, which is a normal answer and not an error), the
 * store is unreachable, or the value is corrupt.
 *
 * The body is read as TEXT, never parsed by the transport, because a stored
 * document and the `[object Object]` corruption are only distinguishable as
 * bytes — once both have been through `JSON.parse` they are both just values.
 *
 * A corrupt value is read as absent and deliberately NOT repaired, even though
 * the repair would be one line: a repair is a write, and this runs on load,
 * which AGENTS.md forbids. The next genuine user-triggered write overwrites it.
 */
export async function getDoc<T>(key: string, signal?: AbortSignal): Promise<T | null> {
  const path = keyPath(key)
  if (!path) {
    badKey(key)
    return null
  }
  let text: string | null = null
  try {
    const res = await capi('GET', path, undefined, { signal, text: true })
    if (isOk(res.status)) text = String(res.body ?? '')
    else if (res.status !== 404) unavailable(`GET ${key} → ${res.status}`)
  } catch (err) {
    // An aborted read is the caller changing its mind, not a broken store.
    if (!signal?.aborted) unavailable(`GET ${key}`, err)
  }
  if (text === null || text === '' || text === CORRUPT) {
    const held = shadow.get(key)
    return held === undefined ? null : parseDoc<T>(held)
  }
  return parseDoc<T>(text)
}

/**
 * Write a document. Answers true only when the store took it; false means the
 * value is in this page's memory and nowhere else, which is what a settings
 * screen has to say rather than "saved".
 *
 * Creating or replacing this app's own document is not the volatile kind of
 * write AGENTS.md guards — no customer configuration is overwritten — but it is
 * still a write, so callers keep it on a user action rather than a timer.
 */
export async function putDoc<T>(key: string, doc: T): Promise<boolean> {
  const path = keyPath(key)
  if (!path) {
    badKey(key)
    return false
  }
  const envelope: Envelope<T> = { version: 1, updatedAt: Date.now(), doc }
  try {
    // text/plain, NOT application/json. Given a JSON content type the store
    // parses the body and persists String(parsed) — the literal
    // "[object Object]" — while still answering 200 (K-S10). The body is JSON
    // either way; only the content type decides whether it survives the trip.
    const res = await capi('PUT', path, envelope, { contentType: 'text/plain' })
    if (isOk(res.status)) {
      shadow.delete(key)
      return true
    }
    unavailable(`PUT ${key} → ${res.status}`)
  } catch (err) {
    unavailable(`PUT ${key}`, err)
  }
  shadow.set(key, JSON.stringify(envelope))
  return false
}

/**
 * Remove a key.
 *
 * This is a volatile operation. AGENTS.md requires an explicit user action and a
 * confirmation naming exactly what will be affected before one runs, and forbids
 * it on load, render or a timer. That confirmation belongs to the caller — this
 * module cannot tell a deliberate delete from an accidental one.
 *
 * A key that was already absent counts as deleted: the caller asked for it to be
 * gone, and it is.
 */
export async function deleteDoc(key: string): Promise<boolean> {
  const path = keyPath(key)
  if (!path) {
    badKey(key)
    return false
  }
  shadow.delete(key)
  try {
    const res = await capi('DELETE', path)
    if (isOk(res.status) || res.status === 404) return true
    unavailable(`DELETE ${key} → ${res.status}`)
  } catch (err) {
    unavailable(`DELETE ${key}`, err)
  }
  return false
}

/** Key names the store answered with, whatever shape it answered in. */
function parseKeys(body: unknown): string[] {
  // Measured: a bare JSON array of names. The endpoint is absent from the
  // 4.19.0 OpenAPI spec, so that is an observation, not a contract — if a later
  // release wraps it the way the rest of the API wraps collections, read that
  // too instead of reporting an empty store.
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as { items?: unknown }).items ?? (body as { keys?: unknown }).keys)
      : undefined
  if (!Array.isArray(list)) return []
  const names: string[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      names.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const o = item as { key?: unknown; name?: unknown; id?: unknown }
      const name = o.key ?? o.name ?? o.id
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

/**
 * Key names under `prefix` — every entry of one audit trail, say.
 *
 * A POST that reads and changes nothing: the store takes the prefix in a body
 * rather than in the URL. The method makes it look volatile; it is not. The body
 * goes as JSON, which is right here and wrong in putDoc — this one is an
 * argument the API parses, not a value it stores.
 */
export async function listKeys(prefix: string): Promise<string[]> {
  try {
    const res = await capi('POST', '/kvstore/keys', { prefix })
    if (isOk(res.status)) return parseKeys(res.body)
    unavailable(`POST keys ${prefix} → ${res.status}`)
  } catch (err) {
    unavailable(`POST keys ${prefix}`, err)
  }
  // Unreachable store: the session can at least still see its own writes.
  return [...shadow.keys()].filter((k) => k.startsWith(prefix)).sort()
}

/** One entry of an audit trail. `action` is this app's own vocabulary for what
 *  happened (e.g. `syslog_stack.applied`); anything else the caller adds rides
 *  along beside it. */
export interface LogEntry {
  action: string
  [field: string]: unknown
}

/** An entry as stored: what the caller said, plus when and who. */
export interface LoggedEntry extends LogEntry {
  at: number
  by: string | null
}

let lastLogMs = 0

/**
 * Append one entry to an append-only trail at `<ns>/log/<epochMs>`.
 *
 * One document per entry rather than one growing array: two actions completing
 * at once would read the same array and the second write would drop the first
 * entry, which is the one thing an audit trail may not do. Keys sort
 * chronologically as a side effect.
 *
 * Only ever called from a user-triggered action. A trail written on load or on a
 * timer records nothing anybody did, and fills the store doing it.
 *
 * `at` and `by` are stamped last, so the trail records when this ran and who the
 * platform says is signed in — not what the caller passed. `by` is null when the
 * platform names no user (see user.ts); an unattributed entry is honest, whereas
 * an invented id is evidence of something that never happened.
 */
export async function appendLog(ns: string, entry: LogEntry): Promise<boolean> {
  // Two entries inside one millisecond would collide on the key. The second
  // takes the next free millisecond: a timestamp nudged by 1 ms beats a lost
  // entry, and the order it implies is the real one.
  const at = Math.max(Date.now(), lastLogMs + 1)
  lastLogMs = at
  const by = await currentUserId()
  return putDoc<LoggedEntry>(`${ns}/log/${at}`, { ...entry, at, by })
}
