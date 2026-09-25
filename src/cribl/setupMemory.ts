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
import { currentUserId, userKeySegment } from './user'

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

/** One change to one group's commit notes: the keys to set, and the keys to drop. */
export interface CommitMemoryChange {
  group: string
  set?: Readonly<Record<string, CommitInfo>>
  drop?: readonly string[]
}

/** The chain every `updateCommitMemory` call waits its turn on. */
let commitQueue: Promise<unknown> = Promise.resolve()

/**
 * Change one group's commit notes by READ, MERGE, WRITE — in turn, never two at
 * once — and answer the document as written and whether the store took it.
 *
 * TWO PANELS WRITE THIS DOCUMENT. The onboarding panel records the pack's
 * commit under `onboarding_pack` (packClient.ts `PACK_COMMIT_KEY`); the global
 * stacks' Remove-only ProvisionPanel only drops the keys of what it removed.
 * *(Corrected 2026-09-25, `chore/release-fetch-and-doc-drift`: this said the
 * Raw HTTP panel recorded the stack's keys, which went with its deploy.)* A
 * panel that wrote back
 * the whole document it loaded on mount would drop the other panel's key — the
 * prefs.ts bug — and a dropped pack hash is one the stranded-commit repair then
 * refuses to deploy as "not made by this app". So every write reads the
 * document again inside its own turn and changes only its own keys.
 */
export function updateCommitMemory(change: CommitMemoryChange): Promise<{ memory: CommitMemory; saved: boolean }> {
  const turn = commitQueue.then(async () => {
    const mem = await loadCommitMemory()
    const forGroup = { ...(mem[change.group] ?? {}) }
    for (const [k, v] of Object.entries(change.set ?? {})) forGroup[k] = v
    for (const k of change.drop ?? []) delete forGroup[k]
    const memory: CommitMemory = { ...mem, [change.group]: forGroup }
    const saved = await saveCommitMemory(memory)
    return { memory, saved }
  })
  // The next turn waits for this one whether it wrote or threw.
  commitQueue = turn.catch(() => undefined)
  return turn
}

/**
 * This app's own removals that were never committed, per worker group — the
 * evidence `removeDirtyRefusal` (provision.ts) needs to let a Remove through a
 * file that is already uncommitted because of this app's OWN earlier Remove.
 *
 * WHY IT EXISTS. A Remove whose DELETE landed and whose commit failed leaves
 * this app's deletion pending in `inputs.yml`, `pipelines/route.yml` and the
 * rest. The next Remove refuses on any pending file of its own scope, so
 * without this record it would refuse every retry in the group, and this panel
 * has no "finish removal" of its own. Git's status names files, never hunks,
 * so a pending file cannot be read for WHOSE change it holds; this record is
 * the app saying "that one was me", with the Leader's HEAD at the time, so a
 * record that a later commit may have made stale is never believed.
 *
 * `keys` are provision.ts `CommitKey`s this app deleted in the group and whose
 * commit did not land; `head` is the Leader's HEAD when that happened, or null
 * when it could not be read — a record that then vouches for nothing.
 *
 * ONE WRITER: `removeOnboardingStack`, at the end of a confirmed run — never on
 * load, render or a timer. A stale record is left where it is rather than
 * cleared on a read (that would be a write on load); its HEAD no longer
 * matching is what retires it.
 */
export interface UncommittedRemoval {
  keys: string[]
  head: string | null
}

/** group id → this app's uncommitted removal there. */
export type UncommittedRemovals = Record<string, UncommittedRemoval>

const REMOVALS_KEY = 'guided_setup_memory/uncommitted_removals'

/** The record, or null when the store answered nothing usable — which a caller
 *  must read as "no evidence", never as "nothing was left uncommitted". */
export async function loadUncommittedRemovals(): Promise<UncommittedRemovals | null> {
  const doc = await getDoc<UncommittedRemovals>(REMOVALS_KEY)
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null
}

/** One change to one group's record: keys left uncommitted at `head`, and keys
 *  a commit has since carried. */
export interface UncommittedRemovalChange {
  group: string
  add?: { keys: readonly string[]; head: string | null }
  drop?: readonly string[]
}

let removalsQueue: Promise<unknown> = Promise.resolve()

/**
 * Change one group's record by read, merge, write, in turn. Keys added at the
 * HEAD the record already holds join it; keys added at another HEAD replace it,
 * because a commit in between may have carried the older ones. A group left
 * with no keys is dropped, and a change that leaves nothing to say about a
 * group the record never held writes nothing. Answers whether the store took it.
 */
export function updateUncommittedRemovals(change: UncommittedRemovalChange): Promise<boolean> {
  const turn = removalsQueue.then(async () => {
    const doc: UncommittedRemovals = { ...((await loadUncommittedRemovals()) ?? {}) }
    const cur = doc[change.group]
    let keys = cur ? [...cur.keys] : []
    let head = cur ? cur.head : null
    if (change.add && change.add.keys.length) {
      if (!cur || cur.head === null || cur.head !== change.add.head) keys = []
      head = change.add.head
      for (const k of change.add.keys) if (!keys.includes(k)) keys.push(k)
    }
    const drop = change.drop ?? []
    keys = keys.filter((k) => !drop.includes(k))
    if (!cur && keys.length === 0) return true
    if (keys.length) doc[change.group] = { keys, head }
    else delete doc[change.group]
    return putDoc(REMOVALS_KEY, doc)
  })
  removalsQueue = turn.catch(() => undefined)
  return turn
}

/** What Guided Setup remembers about one viewer. A document rather than a bare
 *  string, so a second preference on this screen is a field rather than another
 *  key and another round trip. */
interface SetupPrefs {
  /** Worker group last picked in Guided Setup. */
  setupGroup?: string
}

const prefsKey = (userId: string) => `guided_setup_memory/prefs/${userKeySegment(userId)}`

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
