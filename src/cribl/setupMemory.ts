// What Guided Setup remembers between visits — and where it remembers it.
//
// Two things, kept apart on purpose:
//
//   guided_setup_memory/commits            the last Git commit that touched
//     each provisioned artifact, per worker group. Install-wide, because it
//     describes configuration that is deployed: everyone looking at that group
//     is looking at the same commit. Shown on each resource row until a newer
//     commit for that artifact supersedes it.
//   guided_setup_memory/prefs/<userId>     the worker group this viewer last
//     picked. Per-user, because which group I am working in is mine — one admin
//     moving their own picker must not move everybody else's.
//
// The per-user document is under this feature's own namespace rather than in
// the `app/prefs/<userId>` document cribl/prefs.ts keeps, and that is not
// duplication for its own sake: prefs.ts holds the whole document in module
// state and writes it back wholesale on every flag change, so a second writer's
// field would be dropped by the next dismissal. One writer per document. The
// cost is one extra GET, on this tab only; the alternative is a preference that
// disappears when somebody closes a banner.
//
// Both go to the app-scoped Cribl KV store through cribl/kv.ts. Never browser
// storage: the app runs in a sandboxed iframe where localStorage can be
// partitioned, cleared or blocked, and where nothing it holds follows a user to
// a second browser or a second seat (AGENTS.md, CLAUDE.md).
//
// The hard-won part of this file now lives in kv.ts rather than here, and is
// worth knowing before changing either: a document is PUT as `text/plain`,
// because given a JSON content type the store parses the body, persists the
// literal `[object Object]`, and still answers 200 — which is how this very key
// was lost once already. That corrupt value reads back as an absent key and is
// deliberately NOT repaired, because a repair is a write and reads run on load,
// which AGENTS.md forbids; the next real user-triggered write overwrites it.
//
// One thing this file used to do is gone rather than moved: it unwrapped a
// `{ value: … }` envelope that "some KV backends" return. That was a guess.
// Spike K-S10 measured this store — a text/plain document round-trips verbatim
// — and found it empty, so there is no wrapped document anywhere to unwrap.
//
// WHERE THIS WORKS: anywhere the app runs inside Cribl, the in-UI Live Preview
// included, because there `window.CRIBL_API_URL` is set and the platform proxy
// adds the `/a/{appId}/` scope. The one inert place is the localhost
// `npm run dev` page (:5173): that Vite proxy rewrites `/capi` → `/api/v1`
// without the app scope, against a `__dev__<name>` app id that is not a
// registered app, so every call 404s. Guided Setup still shows this session's
// commits there, because they are also in React state — but nothing is durable,
// and nothing on that page can prove otherwise. Live Preview is where
// durability is visible, and the worker-group preference below is the cheapest
// way to look: pick a group, reload the tab, see whether it came back.

import { getDoc, putDoc } from './kv'
import { currentUserId } from './user'

export interface CommitInfo {
  hash: string
  message: string
}

/** group id → resource key → last commit that touched it. */
export type CommitMemory = Record<string, Record<string, CommitInfo>>

const COMMITS_KEY = 'guided_setup_memory/commits'

/** Load the persisted commit memory. `{}` covers every kind of nothing-yet:
 *  never written, an unreachable store, and the corrupt value this app's first
 *  attempt at the key left behind — kv.ts reads all three as absent. */
export async function loadCommitMemory(): Promise<CommitMemory> {
  const mem = await getDoc<CommitMemory>(COMMITS_KEY)
  // The store is writable by hand, and a document that is not an object at all
  // is not commit memory. Treated as first run rather than handed to the UI.
  return mem && typeof mem === 'object' ? mem : {}
}

/** Persist the whole commit memory, and say whether the store took it. False
 *  means this page is the only thing holding it, which the caller has to say
 *  out loud rather than show a commit ref that the next reload deletes. */
export async function saveCommitMemory(mem: CommitMemory): Promise<boolean> {
  return putDoc(COMMITS_KEY, mem)
}

/** What Guided Setup remembers about one viewer. A document rather than a bare
 *  string, so a second preference on this screen is a field rather than another
 *  key and another round trip. */
interface SetupPrefs {
  /** Worker group last picked in Guided Setup. */
  setupGroup?: string
}

const prefsKey = (userId: string) => `guided_setup_memory/prefs/${userId}`

/** The worker group this viewer last picked, or null when there is nothing to
 *  restore: no stored choice, no store, or no signed-in user to key it on. */
export async function loadSetupGroup(): Promise<string | null> {
  const id = await currentUserId()
  if (!id) return null
  const prefs = await getDoc<SetupPrefs>(prefsKey(id))
  const group = prefs?.setupGroup
  return typeof group === 'string' && group ? group : null
}

/**
 * Remember the worker group. Answers false when nothing was stored, and the
 * picker says so — a preference that quietly did not save is worse than one
 * that admits it, because the user finds out by losing it.
 *
 * Only ever called from the picker's own change event: a deliberate user
 * action, writing this app's own document rather than any customer
 * configuration, and reached from nothing on load, render or a timer
 * (AGENTS.md).
 *
 * No signed-in user means no write at all. A shared stand-in id would file
 * every unidentified viewer into one document, and the first person to pick a
 * group would have picked it for all of them (user.ts).
 */
export async function saveSetupGroup(group: string): Promise<boolean> {
  const id = await currentUserId()
  if (!id) return false
  const key = prefsKey(id)
  // Read, merge, write — rather than writing the one field and calling it the
  // document. Nothing else writes this key today, but the next preference on
  // this screen will, and a wholesale write is the bug that costs somebody
  // else's setting.
  const stored = await getDoc<SetupPrefs>(key)
  const prefs = stored && typeof stored === 'object' ? stored : {}
  return putDoc<SetupPrefs>(key, { ...prefs, setupGroup: group })
}
