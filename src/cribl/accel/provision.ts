// Creating, correcting, pausing and removing the two scheduled searches.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS WRITES, AND WHY IT IS ALLOWED TO.
//
// The dashboards are read-only against Search data. This module is one of the
// few places the app writes Cribl CONFIGURATION, and everything it writes is a
// saved search this app owns: `POST /search/saved` to create one, `PATCH` to
// bring one back into line or to flip its schedule off and on, `DELETE` to take
// it away again. Nothing here touches a customer's own saved searches, their
// pipelines, their routes or their data.
//
// Every one of these is reached from a confirmed click and from nowhere else.
// Nothing in this file may be called on load, on render or on a timer
// (AGENTS.md; CLAUDE.md, "nothing writes on load"). The module cannot enforce
// that — it cannot tell a deliberate click from an accidental one — so the
// confirmation lives in front of `applyAcceleration`, `pauseAcceleration`,
// `resumeAcceleration`, `setAccelSchedules` (the per-tab and master switches)
// and `removeAcceleration`, which are the only five entry points that write
// anything. `readAccelState` is a GET and needs none.
//
// So that the confirmation can NAME what it is about to change without
// re-deriving it, `applyPlan()` and `removalPlan()` below turn a state into the
// exact sentences a dialog needs — including the objects the app will
// deliberately leave alone, which is the half a customer never gets told.
//
// ── A-SP23: THE MEASUREMENT THIS WHOLE FILE IS SHAPED BY ────────────────────
// Measured against this workspace on 2026-09-17, because none of it is in the
// spec and all of it is silent:
//
//   * A PATCH REMOVES ANY FIELD IT OMITS. A PATCH carrying only the three
//     schema-required fields (`id`, `name`, `query`) answered 200 and deleted
//     `schedule`, `earliest`, `latest` and `description` — unscheduling the
//     search forever, with no error and nothing on screen to say so.
//   * THE `schedule` SUB-OBJECT IS REPLACED WHOLESALE, NOT MERGED. Sending
//     `{enabled, cronSchedule}` silently dropped `tz` and `keepLastN`. `tz`
//     decides which hour it fires; `keepLastN` is the read path's entire margin
//     — at 1, a panel reading while the next run is in progress gets nothing,
//     because a running job's results are not readable.
//   * `user` and `displayUsername` are SERVER-CONTROLLED. POST stamps them,
//     omitting them does not blank them, and supplying a different value is
//     silently discarded. Ownership belongs to whoever pressed Apply and cannot
//     be moved by this app.
//
// Therefore every PATCH in this file is a READ-MODIFY-WRITE OF THE WHOLE BODY:
// GET the object, spread it, spread its schedule, change the one field, send it
// all back. A helper that "just patches the schedule" is the bug, not the
// refactor.
//
// ── THERE IS NO ETag, NO VERSION AND NO createdAt ───────────────────────────
// So there is no optimistic-concurrency token, and two writers racing clobber
// each other silently: whoever PATCHes second wins, and neither is told. That is
// a property of the endpoint and this app cannot fix it. What it can do — and
// does — is re-read after every write and report a mismatch (`raced` below),
// and keep the writes to one confirmed click at a time. Anything here that grew
// a retry, a timer or a background reconciler would turn a race nobody can
// detect into one nobody can even reproduce.
//
// ── THE TEARDOWN'S SAFETY RULE, WHICH IS THE POINT OF THE MODULE ────────────
// `/search/saved` is a flat, shared namespace. Nothing in it says which app
// created a row. A saved search called `gno_lake_30d_c1d` that this app did not
// create is SOMEBODY ELSE'S, and deleting it is the same class of mistake as
// the stranded commit slice 1.3 shipped. So a DELETE needs all three of:
//
//   1. the id matches `isAccelId` — the `gno_` prefix, checked FIRST, so a bug
//      in the manifest still cannot reach another admin's saved search;
//   2. the id is in MANIFEST — this release knows what it is for;
//   3. the stored record is recognisably ours — its `description` carries the
//      `GNO … · serves …` stamp accel/manifest.ts writes, OR this install's own
//      `accel/state` document says it wrote it (accel/store.ts, which explains
//      why it takes two signals and not one).
//
// Anything that fails (3) is reported as `foreign` and left exactly where it is,
// named in the result so the customer can be told what was NOT removed.
// ─────────────────────────────────────────────────────────────────────────────

import { isDenial } from '../authz'
import { capi, errText, type ApiResp } from '../capi'
import { APP_VERSION } from '../config'
import { currentUserId } from '../user'
import { readLakeWindow } from '../lakeWindowRead'
import {
  MANIFEST,
  resolvedManifest,
  accelEntry,
  accelPostBody,
  accelSavedSearch,
  isAccelId,
  type AccelEntry,
  type AccelId,
  type AccelSavedSearch,
} from './manifest'
import {
  forgetAccelWrites,
  loadAccelState,
  logAccel,
  recordAccelWrites,
  wasWrittenHere,
  type AccelCreation,
} from './store'

// ── Addressing ──────────────────────────────────────────────────────────────

/**
 * The saved-search collection, as a policy object.
 *
 * Written as a literal rather than interpolated from `SEARCH_GROUP`, for the
 * same reason jobWatchdog.ts writes `JOBS_PATH` out: policyCoverage.test.ts
 * resolves call-site paths from the source text and can only read a string
 * constant here. An interpolated group resolves to a placeholder, which would
 * declare — and ask an admin to approve — these writes in EVERY worker group
 * rather than the one search runs in. provision.test.ts pins it back to
 * `SEARCH_GROUP`, so the two cannot drift.
 */
export const SAVED_PATH = '/m/default_search/search/saved'

const savedPath = (id: string) => `${SAVED_PATH}/${encodeURIComponent(id)}`

/**
 * How many saved searches one status read asks for.
 *
 * The list is the whole workspace's, not ours, so a busy install can legitimately
 * hold more than this. `truncated` says when the page was cut off, and the read
 * settles any id it did not see with a direct GET rather than reporting "absent"
 * — which would offer to create a search that already exists and collect a 409,
 * or worse, overwrite it.
 */
export const LIST_LIMIT = 100

const listQuery = () => new URLSearchParams({ offset: '0', limit: String(LIST_LIMIT) }).toString()

// ── What comes back ─────────────────────────────────────────────────────────

/**
 * A saved search as Cribl returns it.
 *
 * Every field optional and an index signature on both levels, and neither is
 * defensive padding: this is somebody else's JSON, and — because a PATCH deletes
 * what it omits — the fields this app does not know about (`chartConfig`,
 * `tableConfig`, `timezone`, `lib`, `sampleRate`, and whatever a later release
 * adds) have to ride back out in the body it sends. Narrowing this type to the
 * fields the app reads would silently delete the rest.
 */
export interface StoredSchedule {
  enabled?: unknown
  cronSchedule?: unknown
  tz?: unknown
  keepLastN?: unknown
  [field: string]: unknown
}

export interface StoredSavedSearch {
  id?: unknown
  name?: unknown
  query?: unknown
  description?: unknown
  earliest?: unknown
  latest?: unknown
  isPrivate?: unknown
  schedule?: StoredSchedule
  [field: string]: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const accepted = (r: ApiResp): boolean => r.status >= 200 && r.status < 300

/** The `items` array of a Cribl collection response, or null when the body was
 *  not one. Null is not an empty list: "Cribl answered something this app could
 *  not read" must not render as "there is nothing there". */
function itemsOf(body: unknown): StoredSavedSearch[] | null {
  const items = (body as { items?: unknown } | null)?.items
  return Array.isArray(items) ? (items as StoredSavedSearch[]) : null
}

// ── The ownership stamp ─────────────────────────────────────────────────────

/** What every description this app writes begins with. */
const OWNER_PREFIX = 'GNO '

/** …and the clause that makes it this app's, rather than a description that
 *  happens to start with three letters somebody else also liked. */
const OWNER_MARK = ' · serves '

/**
 * The full stamp, as accel/manifest.ts writes it. Kept as a regex separate from
 * the loose marker above because the two answer different questions, and
 * conflating them breaks in the direction that matters: a description written by
 * an OLDER release in a shape this regex does not match is still ours, and must
 * still be deletable by a teardown. So ownership uses the marker, and only the
 * drift comparison uses the parse.
 */
const STAMP_RE =
  /^GNO (\S+) · manifest v(\d+) · serves (\S+) · body-sha256:([0-9a-f]{12}) · display-sha256:([0-9a-f]{12})$/

export interface AccelStamp {
  appVersion: string
  manifestVersion: number
  serves: string
  bodySha: string
  displaySha: string
}

export function parseStamp(description: string | null): AccelStamp | null {
  const m = description === null ? null : STAMP_RE.exec(description)
  if (!m) return null
  return { appVersion: m[1], manifestVersion: Number(m[2]), serves: m[3], bodySha: m[4], displaySha: m[5] }
}

/** Whether a stored description claims this app wrote the object. */
export function carriesOwnerMark(description: string | null): boolean {
  return description !== null && description.startsWith(OWNER_PREFIX) && description.includes(OWNER_MARK)
}

// ── Drift ───────────────────────────────────────────────────────────────────

/**
 * What the stored object has that this release would not have written.
 *
 * DIGEST FIRST, FIELDS SECOND, and both, because each catches what the other
 * misses. The digest in the description is the exact, cheap answer and it is
 * what an operator reading Cribl's own UI compares by eye — but it is free text
 * anybody can edit, so a description that still says the right hash proves
 * nothing about the query beside it. The field comparison is authoritative and
 * says nothing about intent. Run both, report the union.
 *
 * TWO THINGS ARE DELIBERATELY NOT DRIFT.
 *
 * `schedule.enabled` — that is the pause state, and pausing is a choice the
 * customer made. If a paused search counted as drifted, a re-apply would quietly
 * resume it, which is the opposite of what the person who paused it asked for.
 * `applyAcceleration` preserves it; `pauseAcceleration`/`resumeAcceleration` are
 * the only things that move it.
 *
 * The APP VERSION in the stamp — it changes on every release, including one that
 * only touched CSS. Treating it as drift would report both searches as drifted
 * after every upgrade, which is how a drift check becomes a thing people click
 * past. What is compared is the MANIFEST version, which moves only when the
 * shape of what gets written changes.
 */
function differences(want: AccelSavedSearch, raw: StoredSavedSearch): string[] {
  const out = new Set<string>()
  // Ours always parses — it is the string accel/manifest.ts just built.
  const mine = parseStamp(want.description) as AccelStamp
  const theirs = parseStamp(str(raw.description))
  if (!theirs) out.add('the app stamp in its description')
  else {
    if (theirs.bodySha !== mine.bodySha) out.add('the query it runs')
    if (theirs.displaySha !== mine.displaySha) out.add('the query the panel shows for it')
    if (theirs.serves !== mine.serves) out.add('which panel it serves')
    if (theirs.manifestVersion !== mine.manifestVersion) {
      out.add(`the manifest version it was written to (v${theirs.manifestVersion})`)
    }
  }
  if (str(raw.query) !== want.query) out.add('the query it runs')
  if (str(raw.name) !== want.name) out.add('its name')
  if (str(raw.earliest) !== want.earliest || str(raw.latest) !== want.latest) out.add('the window it reads')
  // A private saved search serves only the person who owns it; every other
  // viewer's panel would silently read nothing at all.
  if (raw.isPrivate === true) out.add('its visibility — private, so other viewers would see nothing')
  const schedule = raw.schedule
  if (str(schedule?.cronSchedule) !== want.schedule.cronSchedule) out.add('when it runs')
  if (str(schedule?.tz) !== want.schedule.tz) out.add('the time zone it runs in')
  if (num(schedule?.keepLastN) !== want.schedule.keepLastN) out.add('how many past runs it keeps readable')
  return [...out]
}

// ── State ───────────────────────────────────────────────────────────────────

/**
 * What a status read can honestly say about one manifest entry.
 *
 * `unreadable` is the state a boolean has nowhere to put, and Guided Setup
 * shipped without its equivalent once: a refused GET became `false`, the row
 * said "absent", and the screen positively told somebody who could not SEE the
 * object that it did not exist — and offered to create it.
 *
 * `foreign` is the one the teardown turns on. It means an object with our id
 * exists and nothing about it says this app made it.
 */
export type AccelEntryState = 'absent' | 'enabled' | 'paused' | 'differs' | 'foreign' | 'unreadable'

export interface AccelRow {
  id: AccelId
  entry: AccelEntry
  state: AccelEntryState
  /** The schedule's `enabled` flag as stored, or null when there is no readable
   *  schedule at all — which is what a PATCH that omitted it leaves behind. */
  enabled: boolean | null
  /** What `differs` means, in words a person can act on. Empty otherwise. */
  differences: readonly string[]
  /** The description's stamp, when it had a parseable one. */
  stamp: AccelStamp | null
  /** The stored description carries this app's ownership marker. */
  ours: boolean
  /** …and/or this install's own `accel/state` record says it wrote it. */
  recorded: boolean
  /** Exactly what this release would write for this entry — so a caller can
   *  show the intended query beside the stored one without recomputing two
   *  SHA-256 digests to get the description. */
  intended: AccelSavedSearch
  /** The object as read. A writer must re-read before PATCHing it; this is for
   *  showing, not for sending. */
  stored: StoredSavedSearch | null
}

/** A `gno_` saved search in the workspace that this release's manifest does not
 *  know about — an entry an older release created and a newer one dropped. It
 *  is still running, and still billing. */
export interface AccelOrphan {
  id: string
  name: string
  description: string | null
  /** It carries this app's stamp, so it is provably ours even though this
   *  release cannot say what it was for. */
  ours: boolean
}

export interface AccelState {
  rows: readonly AccelRow[]
  orphans: readonly AccelOrphan[]
  /** Something in this read was refused (401/403). Read this before `rows`. */
  denied: boolean
  /**
   * Why the LIST told us nothing, or null when it worked. While it is set, no
   * row's state is a claim about the workspace and nothing may be written.
   *
   * Scoped to the list on purpose. A failure settling ONE id (the direct GET a
   * truncated page forces) says nothing about the other entry, so it shows up as
   * `unreadable` on that row and leaves the rest of the run usable. Putting it
   * here instead would block a perfectly readable entry on its neighbour's
   * refusal.
   */
  error: string | null
  /** The workspace holds more saved searches than one page. Rows are still
   *  correct — a missing id is settled with a direct GET — but `orphans` is
   *  only what this page happened to contain. */
  truncated: boolean
  readAt: number
}

export interface ReadOpts {
  /**
   * Whether this read was caused by a click.
   *
   * Defaults to TRUE — i.e. not a click — which is the safe default for the
   * caller who does not think about it. `<GatedControl>` treats any refusal
   * recorded while its write ran as ITS refusal (cribl/authz.ts, `denialSince`),
   * so a status read firing on mount could latch an unrelated button as denied.
   * `applyAcceleration` and `removeAcceleration` pass `false` for their own
   * reads, because those genuinely are the click.
   */
  background?: boolean
  signal?: AbortSignal
}

/** One saved search, read directly. `raw` is null for a 404, which is the
 *  store's normal answer for "nobody created this", not a failure. */
async function readSaved(
  id: string,
  background: boolean,
  signal?: AbortSignal,
): Promise<{ raw: StoredSavedSearch | null; denied: boolean; error: string | null }> {
  const r = await capi('GET', savedPath(id), undefined, { background, signal })
  if (isDenial(r.status)) return { raw: null, denied: true, error: 'Cribl refused this read.' }
  if (r.status === 404) return { raw: null, denied: false, error: null }
  if (!accepted(r)) return { raw: null, denied: false, error: `Cribl answered ${r.status} — ${errText(r)}` }
  const items = itemsOf(r.body)
  if (!items) return { raw: null, denied: false, error: 'Cribl returned a saved search this app could not read.' }
  // A 200 with no items is the same fact as a 404 on some builds.
  return { raw: items[0] ?? null, denied: false, error: null }
}

/** Every row `unreadable`, for the two cases where nothing about the workspace
 *  is known: a refused list, and a list this app could not parse. */
function blindState(
  entries: readonly AccelEntry[],
  intended: AccelSavedSearch[],
  denied: boolean,
  error: string,
): AccelState {
  return {
    rows: entries.map((entry, i) => ({
      id: entry.id,
      entry,
      state: 'unreadable' as const,
      enabled: null,
      differences: [],
      stamp: null,
      ours: false,
      recorded: false,
      intended: intended[i],
      stored: null,
    })),
    orphans: [],
    denied,
    error,
    truncated: false,
    readAt: Date.now(),
  }
}

/**
 * What is in the workspace, per manifest entry.
 *
 * One list GET, plus a direct GET for any manifest id the page did not contain
 * AND could not rule out — see LIST_LIMIT. Reads only; nothing here writes, so
 * it is safe on a mount (and `background` defaults accordingly).
 */
export async function readAccelState(opts: ReadOpts = {}): Promise<AccelState> {
  const background = opts.background ?? true
  // THE MANIFEST AS THIS TENANT NEEDS IT WRITTEN. The Lake total's window is
  // the dataset's retention and its query the method that covers it
  // (src/queries/lakeWindow.ts), so what is intended — and so what counts as drift,
  // and what Apply writes — is resolved against the tenant, not the constant.
  // An unreadable retention leaves the manifest's default: nothing is written
  // on a window nobody chose.
  const entries = resolvedManifest(await readLakeWindow())
  const [intended, recorded] = await Promise.all([
    Promise.all(entries.map((e) => accelSavedSearch(e))),
    loadAccelState(),
  ])

  const list = await capi('GET', `${SAVED_PATH}?${listQuery()}`, undefined, { background, signal: opts.signal })
  if (isDenial(list.status)) {
    return blindState(entries, intended, true, 'This account cannot list Cribl Search saved searches, so the scheduled searches this app owns cannot be checked.')
  }
  if (!accepted(list)) {
    return blindState(entries, intended, false, `Cribl answered ${list.status} — ${errText(list)}`)
  }
  const items = itemsOf(list.body)
  if (!items) {
    return blindState(entries, intended, false, 'Cribl returned a saved-search list this app could not read.')
  }

  const total = num((list.body as { totalCount?: unknown }).totalCount)
  const truncated = total !== null ? total > items.length : items.length >= LIST_LIMIT
  const byId = new Map<string, StoredSavedSearch>()
  for (const item of items) {
    const id = str(item.id)
    if (id) byId.set(id, item)
  }

  const rows: AccelRow[] = []
  let denied = false

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const want = intended[i]
    let raw = byId.get(entry.id) ?? null
    let unreadable = false
    // Not on the page is not "absent" when the page was cut off. One direct GET
    // settles it, and only for the ids that need settling.
    if (!raw && truncated) {
      const direct = await readSaved(entry.id, background, opts.signal)
      raw = direct.raw
      if (direct.denied) denied = true
      // Only this row. See the note on `error` above: one id this app could not
      // settle says nothing about the other one.
      if (direct.error) unreadable = true
    }
    const description = raw ? str(raw.description) : null
    const ours = carriesOwnerMark(description)
    const wasRecorded = wasWrittenHere(recorded, entry.id)
    const diffs = raw && (ours || wasRecorded) ? differences(want, raw) : []
    rows.push({
      id: entry.id,
      entry,
      state: rowState(raw, unreadable, ours || wasRecorded, diffs),
      enabled: raw ? bool(raw.schedule?.enabled) : null,
      differences: diffs,
      stamp: parseStamp(description),
      ours,
      recorded: wasRecorded,
      intended: want,
      stored: raw,
    })
  }

  const known = new Set<string>(MANIFEST.map((e) => e.id))
  const orphans: AccelOrphan[] = items
    .filter((item) => {
      const id = str(item.id)
      return id !== null && isAccelId(id) && !known.has(id)
    })
    .map((item) => {
      const id = str(item.id) as string
      const description = str(item.description)
      return { id, name: str(item.name) ?? id, description, ours: carriesOwnerMark(description) || wasWrittenHere(recorded, id) }
    })

  return { rows, orphans, denied, error: null, truncated, readAt: Date.now() }
}

function rowState(
  raw: StoredSavedSearch | null,
  unreadable: boolean,
  ours: boolean,
  diffs: readonly string[],
): AccelEntryState {
  if (unreadable) return 'unreadable'
  if (!raw) return 'absent'
  if (!ours) return 'foreign'
  if (diffs.length) return 'differs'
  // A schedule with no readable `enabled` is reported `differs` above, because
  // the field comparison already failed on cron/tz/keepLastN — so by here the
  // only two answers left are the two a customer chose between.
  return raw.schedule?.enabled === false ? 'paused' : 'enabled'
}

// ── The writes ──────────────────────────────────────────────────────────────

async function createSaved(body: AccelSavedSearch): Promise<ApiResp> {
  return capi('POST', SAVED_PATH, body)
}

/**
 * Replace a saved search wholesale.
 *
 * `body` must be the WHOLE object — see A-SP23 in the header. There is no
 * partial PATCH on this endpoint and a helper that offered one would unschedule
 * the search it was asked to adjust. Both callers build their body by spreading
 * an object they read seconds earlier, which is the only shape that is safe.
 */
async function patchSaved(id: string, body: StoredSavedSearch): Promise<ApiResp> {
  return capi('PATCH', savedPath(id), body)
}

/**
 * Delete one, with the prefix guard in front of it.
 *
 * Throws rather than returning a status, because reaching it with an id that is
 * not ours is a programming error and the only safe thing to do with a
 * programming error at a DELETE is not to send it. The callers catch and report
 * it as a refusal; the check is duplicated from the caller on purpose, so a bug
 * in the caller cannot reach another admin's saved search.
 */
async function deleteSaved(id: string): Promise<ApiResp> {
  if (!isAccelId(id)) throw new Error(`refusing to delete '${id}': not one of this app's scheduled searches`)
  if (!MANIFEST.some((e) => e.id === id)) throw new Error(`refusing to delete '${id}': not in this release's manifest`)
  return capi('DELETE', savedPath(id))
}

/**
 * The schedule to write, as a merge of what is stored onto what this release
 * intends, with `enabled` set.
 *
 * NOT a way to "fix" a schedule: a stored value that is present and of the right
 * type always wins, so pausing a search whose cron the customer edited leaves
 * their cron exactly where they put it. What this covers is the field that is
 * ABSENT — the state A-SP23 measured a partial PATCH leaving behind. Writing
 * `{...cur.schedule, enabled}` back when `cur.schedule` is missing `tz` would
 * keep the search broken forever, one confirmed click at a time.
 */
function mergeSchedule(entry: AccelEntry, stored: StoredSchedule | undefined, enabled: boolean): StoredSchedule {
  // Only the schedule is taken from this; the description is irrelevant here.
  const ours = accelPostBody(entry, '').schedule
  const keep: StoredSchedule = stored ?? {}
  const notifications = keep.notifications
  return {
    ...keep,
    cronSchedule: str(keep.cronSchedule) ?? ours.cronSchedule,
    tz: str(keep.tz) ?? ours.tz,
    keepLastN: num(keep.keepLastN) ?? ours.keepLastN,
    jitterPercent: num(keep.jitterPercent) ?? ours.jitterPercent,
    resumeMissed: bool(keep.resumeMissed) ?? ours.resumeMissed,
    resumeOnBoot: bool(keep.resumeOnBoot) ?? ours.resumeOnBoot,
    notifications:
      notifications && typeof notifications === 'object' && 'disabled' in notifications
        ? notifications
        : ours.notifications,
    enabled,
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────

export type AccelAction = 'created' | 'updated' | 'deleted' | 'exists' | 'refused' | 'skipped' | 'error'

export interface AccelStep {
  id: AccelId
  action: AccelAction
  detail?: string
}

export interface ApplyResult {
  steps: readonly AccelStep[]
  /** Nothing was written. The honest answer to "is it already on?", and what a
   *  re-run of a correct install must say. */
  unchanged: boolean
  /** The workspace as re-read afterwards — or, when the run wrote nothing
   *  because it could not read, the state it refused to act on. */
  state: AccelState
}

/**
 * The writes a confirmation named, by id — the set `applyAcceleration` refuses
 * to depart from. Built from the same rows `applyResources()` renders, so the
 * dialog and the run cannot describe different sets.
 */
export type ApprovedWrites = Readonly<Record<string, 'absent' | 'differs'>>

export function approvedWrites(state: AccelState): ApprovedWrites {
  const out: Record<string, 'absent' | 'differs'> = {}
  for (const row of state.rows) {
    if (row.state === 'absent' || row.state === 'differs') out[row.id] = row.state
  }
  return out
}

/**
 * Create what is missing and bring what has drifted back into line.
 *
 * IDEMPOTENT AND ADDITIVE, the way cribl/provision.ts is: run it on a correct
 * workspace and it issues no write at all and says so (`unchanged`). It creates
 * only the ids in MANIFEST, corrects only objects it recognises as its own, and
 * touches nothing else in `/search/saved`.
 *
 * IT DOES NOT RESUME A PAUSED SEARCH. A paused entry that is otherwise correct
 * is reported `exists` and left paused; a paused entry that has drifted is
 * corrected and left paused. Somebody paused it on purpose, and Apply is not
 * the control that undoes that — `resumeAcceleration` is.
 *
 * IT REFUSES TO WRITE FROM A STATE IT COULD NOT READ. A POST issued blind
 * against an object that already exists is a 409 at best; a PATCH issued blind
 * is an overwrite of something this app has not looked at.
 *
 * Called only from a confirmed click. `applyPlan()` gives that confirmation the
 * exact list of what will be written.
 *
 * ── AND `approved` IS WHAT THAT CONFIRMATION NAMED ──────────────────────────
 * The re-read below is correct and was always here: the panel's state can be
 * minutes old, and writing from it would send a body somebody has changed
 * since. What was missing is the other half. Nothing compared the fresh state
 * against the set the dialog named, so a row that was `exists` when the dialog
 * opened and `differs` when Apply ran was overwritten although the dialog never
 * mentioned it — the "the dialog described a different write" failure that
 * lakeLanding.ts's `destinationDiffMovedNote` exists to prevent for the
 * destination, arriving here instead.
 *
 * Passing nothing keeps the old behaviour on purpose, for callers with no
 * dialog to name a set (the tests, and any future unattended path); the panel
 * passes `approvedWrites(state)` built from the same rows `applyResources`
 * rendered, so the two cannot drift.
 */
export async function applyAcceleration(
  onStep: (s: AccelStep) => void = () => {},
  approved?: ApprovedWrites,
): Promise<ApplyResult> {
  const before = await readAccelState({ background: false })
  if (before.error !== null) {
    const steps = MANIFEST.map<AccelStep>((e) => ({ id: e.id, action: 'skipped', detail: before.error as string }))
    for (const s of steps) onStep(s)
    return { steps, unchanged: true, state: before }
  }

  const steps: AccelStep[] = []
  const written: Record<string, AccelCreation> = {}
  // Who pressed Apply, for the record this install keeps of its own writes.
  // Null when the platform names nobody (always so on the localhost dev page);
  // an invented id would be evidence of something that never happened.
  const by = await currentUserId()

  const step = (s: AccelStep) => {
    steps.push(s)
    onStep(s)
  }

  for (const row of before.rows) {
    const { entry, intended } = row
    // The approved-set check, before any of the state branches: a row that
    // moved between the dialog and this read is a row the dialog described
    // wrongly, whichever direction it moved in. Refused rather than re-asked —
    // a confirmation describes one set of writes, and nothing here re-opens a
    // dialog the user has already dismissed.
    if (approved !== undefined && (row.state === 'absent' || row.state === 'differs') && approved[row.id] !== row.state) {
      step({
        id: row.id,
        action: 'refused',
        detail:
          `it was ${approved[row.id] === undefined ? 'not named in that confirmation at all' : `named as '${approved[row.id]}' in that confirmation`} and reads as ` +
          `'${row.state}' now, so it changed while the dialog was open and was left alone. Re-check and apply again.`,
      })
      continue
    }
    if (row.state === 'unreadable') {
      step({ id: row.id, action: 'skipped', detail: 'this app could not read what is there, so it wrote nothing' })
      continue
    }
    if (row.state === 'foreign') {
      step({
        id: row.id,
        action: 'refused',
        detail: `a saved search called '${row.id}' already exists and carries no stamp from this app, so it belongs to somebody else and was left untouched`,
      })
      continue
    }
    if (row.state === 'absent') {
      const r = await createSaved(intended)
      if (accepted(r)) {
        step({ id: row.id, action: 'created' })
        written[row.id] = creationRecord(intended, by)
      } else {
        step({ id: row.id, action: 'error', detail: errText(r) })
      }
      continue
    }
    if (row.state === 'differs') {
      // Read-modify-write, and re-read rather than reusing the list's copy: the
      // list is already seconds old, and a PATCH built on a stale body writes
      // back fields somebody has changed since. See A-SP23 in the header.
      const cur = await readSaved(row.id, false)
      if (cur.error || !cur.raw) {
        step({ id: row.id, action: 'error', detail: cur.error ?? 'it disappeared between the status read and the write' })
        continue
      }
      const enabled = bool(cur.raw.schedule?.enabled) ?? true
      const body: StoredSavedSearch = {
        ...cur.raw,
        ...intended,
        schedule: mergeScheduleFromIntended(entry, cur.raw.schedule, enabled),
      }
      const r = await patchSaved(row.id, body)
      if (accepted(r)) {
        step({ id: row.id, action: 'updated', detail: row.differences.join('; ') })
        written[row.id] = creationRecord(intended, by)
      } else {
        step({ id: row.id, action: 'error', detail: errText(r) })
      }
      continue
    }
    step({ id: row.id, action: 'exists', detail: row.state === 'paused' ? 'already there, and paused' : 'already there' })
  }

  const unchanged = !steps.some((s) => s.action === 'created' || s.action === 'updated')
  // Only after Cribl accepted the write: a record of a POST that failed would
  // tell a later teardown it owns something it never created.
  if (Object.keys(written).length) void recordAccelWrites(written)
  if (!unchanged || steps.some((s) => s.action === 'error' || s.action === 'refused')) {
    void logAccel({
      action: 'accel.applied',
      outcome: steps.some((s) => s.action === 'error') ? 'error' : 'ok',
      steps: steps.map((s) => `${s.id}:${s.action}`),
    })
  }
  // Re-read, so what a screen shows afterwards is the workspace and not this
  // run's own optimism — and so a write that answered 200 and did nothing (see
  // A-SP23) is visible rather than reported as success.
  const state = unchanged ? before : await readAccelState({ background: false })
  return { steps, unchanged, state }
}

/**
 * The corrective PATCH's schedule.
 *
 * Unlike `mergeSchedule`, this one takes THIS RELEASE'S values for every field
 * except `enabled`, because that is what "bring it back into line" means — the
 * cron, the zone and `keepLastN` are the things that drifted. Fields the app
 * does not know about still ride along from the stored object.
 */
function mergeScheduleFromIntended(
  entry: AccelEntry,
  stored: StoredSchedule | undefined,
  enabled: boolean,
): StoredSchedule {
  return { ...(stored ?? {}), ...accelPostBody(entry, '').schedule, enabled }
}

function creationRecord(intended: AccelSavedSearch, by: string | null): AccelCreation {
  const stamp = parseStamp(intended.description) as AccelStamp
  return {
    at: Date.now(),
    appVersion: APP_VERSION,
    manifestVersion: stamp.manifestVersion,
    bodySha: stamp.bodySha,
    displaySha: stamp.displaySha,
    by,
  }
}

// ── Pause and resume ────────────────────────────────────────────────────────

export interface ScheduleWriteResult {
  id: AccelId
  ok: boolean
  /** The schedule's `enabled` flag as Cribl reports it AFTER the write, or null
   *  when the re-read could not say. */
  enabled: boolean | null
  /**
   * The write was accepted and the re-read disagrees with it.
   *
   * This endpoint carries no ETag, no version and no createdAt, so there is no
   * way to make a write conditional and no way to detect a lost update at the
   * moment it happens. Re-reading afterwards is the only check available, and
   * this flag is what it produces: somebody else wrote this object between our
   * PATCH and our GET, and their value is the one in force.
   */
  raced: boolean
  detail: string | null
  /** Cribl refused the read or the PATCH as not permitted (401/403). */
  denied?: boolean
  /** Set by `setAccelSchedules`: false for a change it did not send (outside
   *  the manifest, or after a permission refusal), true for one it attempted. */
  sent?: boolean
}

/** Stop the schedule. The saved search stays, with its stored results; it simply
 *  stops running, and the panel it feeds falls back to whatever the read path
 *  does with a result that is no longer being refreshed. */
export async function pauseAcceleration(id: AccelId): Promise<ScheduleWriteResult> {
  return setScheduleEnabled(id, false)
}

/** Start it again. */
export async function resumeAcceleration(id: AccelId): Promise<ScheduleWriteResult> {
  return setScheduleEnabled(id, true)
}

/**
 * Read-modify-write of the WHOLE body, per A-SP23.
 *
 * The three lines that matter are the GET, the two spreads and the PATCH, and
 * the reason each is there is in this file's header: a PATCH removes any field
 * it omits, and the `schedule` sub-object is replaced rather than merged, so a
 * request carrying `{enabled, cronSchedule}` silently drops `tz` and
 * `keepLastN`. `mergeSchedule` fills only what is genuinely missing and never
 * overwrites a value the customer set.
 */
async function setScheduleEnabled(id: AccelId, enabled: boolean, expectFrom?: boolean): Promise<ScheduleWriteResult> {
  const entry = accelEntry(id)
  const cur = await readSaved(id, false)
  if (cur.denied) return { id, ok: false, enabled: null, raced: false, denied: true, detail: 'Cribl refused to read this saved search.' }
  if (cur.error) return { id, ok: false, enabled: null, raced: false, detail: cur.error }
  if (!cur.raw) {
    return { id, ok: false, enabled: null, raced: false, detail: `There is no saved search called '${id}' to ${enabled ? 'resume' : 'pause'}.` }
  }
  // The switches' guard: the confirmation named this row as running (or
  // paused). If Cribl now says otherwise, somebody changed it while the dialog
  // was open, and the click approved a state that no longer exists.
  if (expectFrom !== undefined && bool(cur.raw.schedule?.enabled) !== expectFrom) {
    return {
      id,
      ok: false,
      enabled: bool(cur.raw.schedule?.enabled),
      raced: false,
      detail: `It changed after the confirmation was opened (it was ${expectFrom ? 'running' : 'paused'}), so it was left as it is. Re-check and try again.`,
    }
  }
  const body: StoredSavedSearch = { ...cur.raw, schedule: mergeSchedule(entry, cur.raw.schedule, enabled) }
  const r = await patchSaved(id, body)
  if (!accepted(r)) {
    return { id, ok: false, enabled: bool(cur.raw.schedule?.enabled), raced: false, denied: isDenial(r.status), detail: errText(r) }
  }

  // The only concurrency check this endpoint permits. It cannot prevent a lost
  // update; it can tell the customer one happened, which is more than the API
  // offers.
  const after = await readSaved(id, false)
  const now = after.raw ? bool(after.raw.schedule?.enabled) : null
  const raced = now !== null && now !== enabled
  void logAccel({ action: enabled ? 'accel.resumed' : 'accel.paused', id, ok: true, raced })
  return {
    id,
    ok: true,
    enabled: now,
    raced,
    detail: raced
      ? `Cribl accepted the change and then reported this search as ${now ? 'running' : 'paused'}. Somebody else wrote it at the same time — this endpoint has no version to make a write conditional on, so theirs is the one in force.`
      : null,
  }
}

/** One flip a switch confirmed: the id, the state the dialog saw, the state it asked for. */
export interface ScheduleChange {
  id: AccelId
  from: boolean
  to: boolean
}

/**
 * Pause and resume a SUBSET of the schedules, one read-modify-write each.
 *
 * The per-tab and master switches (components/AccelPanel.tsx) end here, and
 * only from a confirmed click. Each change is the same whole-body PATCH as
 * Pause and Resume above — A-SP23 does not care how many objects a click
 * touches — and each is refused if Cribl no longer reports the `from` the
 * dialog showed. Sequential, not parallel: one PATCH at a time keeps the order
 * of the results the order the dialog listed them in, and lets a PERMISSION
 * refusal (401/403, on the read or the PATCH) stop the run — the rest would be
 * refused the same way, so they are reported as not sent rather than sent to be
 * refused. Any other failure (the row changed since the dialog, a 404, a 5xx)
 * is about that row, and the run carries on. Review 2026-09-24, defect 7: this
 * comment used to promise the stop while the loop sent every change regardless.
 */
export async function setAccelSchedules(
  changes: readonly ScheduleChange[],
  onResult: (r: ScheduleWriteResult) => void = () => {},
): Promise<ScheduleWriteResult[]> {
  const out: ScheduleWriteResult[] = []
  for (const c of changes) {
    if (!MANIFEST.some((e) => e.id === c.id)) {
      const r: ScheduleWriteResult = { id: c.id, ok: false, enabled: null, raced: false, sent: false, detail: 'not in this release’s manifest' }
      out.push(r)
      onResult(r)
      continue
    }
    const r: ScheduleWriteResult = { ...(await setScheduleEnabled(c.id, c.to, c.from)), sent: true }
    out.push(r)
    onResult(r)
    if (r.denied) {
      for (const rest of changes.slice(changes.indexOf(c) + 1)) {
        const skipped: ScheduleWriteResult = {
          id: rest.id,
          ok: false,
          enabled: null,
          raced: false,
          sent: false,
          detail: `not sent — Cribl refused ${c.id} as not permitted, and would refuse this the same way.`,
        }
        out.push(skipped)
        onResult(skipped)
      }
      break
    }
  }
  return out
}

// ── Remove ──────────────────────────────────────────────────────────────────

export interface RemoveResult {
  steps: readonly AccelStep[]
  /** Saved searches this app deliberately did not delete, and why — so the
   *  customer is told what is still there rather than left to find out. */
  left: readonly { id: string; why: string }[]
  /** Ids Cribl accepted a DELETE for that the re-read still finds. */
  stillPresent: readonly string[]
  state: AccelState
}

/**
 * Delete this app's scheduled searches, and confirm they are gone.
 *
 * THE THREE CONDITIONS FOR A DELETE are in this file's header and are checked in
 * that order: the `gno_` prefix, membership in MANIFEST, then ownership. The
 * first two are checked again inside `deleteSaved`, which throws rather than
 * sending a request it cannot justify.
 *
 * It re-reads afterwards rather than trusting the 200s, because "Cribl accepted
 * the DELETE" and "the search is gone" are two claims and only the second is the
 * one a customer cares about. Anything still standing is named in
 * `stillPresent`.
 *
 * It does NOT delete an orphan — a `gno_` search this release's manifest does
 * not list. See the note under `AccelOrphan`: the app cannot say what an older
 * release's entry was for, so it reports them and leaves the decision to a
 * person. `removalPlan()` names them for the confirmation.
 */
export async function removeAcceleration(onStep: (s: AccelStep) => void = () => {}): Promise<RemoveResult> {
  const before = await readAccelState({ background: false })
  const left: { id: string; why: string }[] = []
  if (before.error !== null) {
    const steps = MANIFEST.map<AccelStep>((e) => ({ id: e.id, action: 'skipped', detail: before.error as string }))
    for (const s of steps) onStep(s)
    return { steps, left, stillPresent: [], state: before }
  }

  const steps: AccelStep[] = []
  const deleted: string[] = []
  const step = (s: AccelStep) => {
    steps.push(s)
    onStep(s)
  }

  for (const row of before.rows) {
    if (row.state === 'absent') {
      step({ id: row.id, action: 'exists', detail: 'not present' })
      continue
    }
    if (row.state === 'unreadable') {
      step({ id: row.id, action: 'skipped', detail: 'this app could not read what is there, so it deleted nothing' })
      left.push({ id: row.id, why: 'Cribl would not say whether it is there, so this app did not delete it.' })
      continue
    }
    if (!row.ours && !row.recorded) {
      const why = `A saved search called '${row.id}' exists, but nothing says this app created it: its description carries no stamp from this app and this install has no record of writing it. It belongs to somebody else and was left exactly as it is.`
      step({ id: row.id, action: 'refused', detail: why })
      left.push({ id: row.id, why })
      continue
    }
    try {
      const r = await deleteSaved(row.id)
      if (r.status === 404) {
        step({ id: row.id, action: 'exists', detail: 'not present' })
        deleted.push(row.id)
      } else if (accepted(r)) {
        step({ id: row.id, action: 'deleted' })
        deleted.push(row.id)
      } else {
        step({ id: row.id, action: 'error', detail: errText(r) })
      }
    } catch (err) {
      // The guard inside deleteSaved fired, which means a bug upstream of it.
      step({ id: row.id, action: 'refused', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  for (const orphan of before.orphans) {
    left.push({
      id: orphan.id,
      why: orphan.ours
        ? `'${orphan.id}' carries this app's stamp but is not in this release's list of scheduled searches, so this release cannot say what it was for. It is still scheduled, and still billing — remove it in Cribl Search, or install the release that created it and remove it from there.`
        : `'${orphan.id}' looks like one of this app's ids but carries no stamp from it. It was left untouched.`,
    })
  }

  const state = await readAccelState({ background: false })
  const stillPresent: string[] = state.rows
    .filter((row) => deleted.includes(row.id) && row.state !== 'absent' && row.state !== 'unreadable')
    .map((row) => row.id)
  // Forget only what is really gone. An id Cribl 200'd and the re-read still
  // finds must stay in the record, or the next teardown has lost its second
  // ownership signal for the thing it still has to remove.
  const gone = deleted.filter((id) => !stillPresent.includes(id))
  if (gone.length) void forgetAccelWrites(gone)
  void logAccel({
    action: 'accel.removed',
    outcome: steps.some((s) => s.action === 'error') ? 'error' : 'ok',
    steps: steps.map((s) => `${s.id}:${s.action}`),
    left: left.map((l) => l.id),
    stillPresent,
  })
  return { steps, left, stillPresent, state }
}

// ── What a confirmation has to be able to say ───────────────────────────────

/**
 * The sentences a `<ConfirmDialog>` needs, derived from a state it already has.
 *
 * Exported because AGENTS.md requires a confirmation to NAME the affected
 * resources, and a dialog that re-derives which searches are about to be written
 * will eventually name a different set from the one the run actually touches.
 * `willLeave` is the half that usually goes missing: what the app is
 * deliberately NOT going to change, and why.
 */
export interface AccelPlan {
  willWrite: readonly string[]
  willDelete: readonly string[]
  willLeave: readonly { label: string; why: string }[]
}

const label = (entry: AccelEntry) => `${entry.name} (${entry.id})`

export function applyPlan(state: AccelState): AccelPlan {
  const willWrite: string[] = []
  const willLeave: { label: string; why: string }[] = []
  for (const row of state.rows) {
    switch (row.state) {
      case 'absent':
        willWrite.push(`${label(row.entry)} — create, running ${row.entry.cron} ${row.entry.tz}`)
        break
      case 'differs':
        willWrite.push(`${label(row.entry)} — overwrite, because ${row.differences.join(' and ')} differ${row.differences.length === 1 ? 's' : ''} from what this release writes`)
        break
      case 'foreign':
        willLeave.push({ label: label(row.entry), why: 'a saved search with this id already exists and was not created by this app' })
        break
      case 'unreadable':
        willLeave.push({ label: label(row.entry), why: 'Cribl would not say whether it is there' })
        break
      case 'paused':
        willLeave.push({ label: label(row.entry), why: 'already there, and paused — Apply does not resume it' })
        break
      default:
        willLeave.push({ label: label(row.entry), why: 'already exactly as this release would write it' })
    }
  }
  return { willWrite, willDelete: [], willLeave }
}

export function removalPlan(state: AccelState): AccelPlan {
  const willDelete: string[] = []
  const willLeave: { label: string; why: string }[] = []
  for (const row of state.rows) {
    if (row.state === 'absent') continue
    if (row.state === 'unreadable') {
      willLeave.push({ label: label(row.entry), why: 'Cribl would not say whether it is there' })
      continue
    }
    if (!row.ours && !row.recorded) {
      willLeave.push({ label: label(row.entry), why: 'it exists but nothing says this app created it' })
      continue
    }
    willDelete.push(label(row.entry))
  }
  for (const orphan of state.orphans) {
    willLeave.push({
      label: `${orphan.name} (${orphan.id})`,
      why: orphan.ours
        ? 'written by an older release of this app and not in this one’s list — remove it in Cribl Search'
        : 'its id looks like one of this app’s but it carries no stamp from it',
    })
  }
  return { willWrite: [], willDelete, willLeave }
}
