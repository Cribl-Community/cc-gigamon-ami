// What Phase 2 schedules, as data — one list, read by everything that touches a
// scheduled search.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A LIST AND NOT TWO LINES AT TWO CALL SITES.
//
// Phase 2 replaces two live queries with two saved searches that run on a cron,
// and then reads the stored result. That one sentence creates five places that
// have to agree about the same two objects:
//
//   • the apply path, which POSTs them;
//   • the teardown, which DELETEs them — and must delete ours and nobody else's;
//   • the status table, which says whether each one exists, is enabled, and
//     when it last ran;
//   • the read path, which asks `$vt_results` for a run BY NAME;
//   • config/policies.yml and src/cribl/paths.ts, which declare the grant.
//
// Written as literals at each of those sites, that is five hand-kept lists, and
// the failure mode is not a crash. A customer ends up with a scheduled search
// running every hour that nothing in the app can see, name, pause or remove —
// billing them, with the app's own id on it, for a panel that stopped reading it
// three releases ago. Nobody notices, because everything still renders.
//
// So the list is the object. A new entry is one record here; the apply, the
// teardown, the status table and the read path all iterate it.
//
// ── THE BODIES ARE IMPORTED, NEVER RESTATED ─────────────────────────────────
// `body` comes from src/queries/*, by import. That is the whole honesty of this
// phase in one line: a panel's ⓘ shows the query behind its number, and after
// Phase 2 that number comes from a scheduled run rather than a live one. The ⓘ
// stays truthful only while the thing that ran IS the string the ⓘ shows. Retype
// the query here and the two drift the first time somebody edits one of them —
// silently, because both still run and both still return a number.
//
// The dependency points this way and only this way: src/queries/* is loaded
// under plain Node by scripts/extract-queries.mjs, so nothing there may import
// anything that reaches a .tsx. This module imports FROM those modules, which is
// free. Do not make them import from this one.
//
// ── ON `body` AND `display` BEING TWO FIELDS ────────────────────────────────
// For both of today's entries they are the same string, and the test asserts it.
// They are still two fields, because they answer two different questions and the
// description string below carries a digest of each:
//
//   body     what the saved search actually runs.
//   display  what the panel's ⓘ tells the customer produced the number.
//
// A future entry may legitimately schedule a wider body than the one a panel
// shows — an aggregate several tiles slice locally, say. The moment that happens
// the two digests differ, and an operator reading the saved search in Cribl's own
// UI can see that the app is showing a narrower claim than it scheduled. Collapse
// these into one field and that difference becomes invisible rather than absent.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// No fetch, no capi, no KV. This module is a description of two objects; the
// modules that create, remove, read and report them own their own failure modes.
// It stays importable by a test, by the teardown and by a panel without any of
// them dragging a transport in.
// ─────────────────────────────────────────────────────────────────────────────

import { APP_VERSION } from '../config'
import { LAKE_TOTAL_QUERY } from '../../queries/dataFlow'
import { FEED_SAMPLE_QUERY } from '../../queries/fieldExplorer'

/**
 * The manifest's own version, stamped into every saved search's description.
 *
 * It is not the app version and does not move with it. It moves when the SHAPE
 * of what gets written changes — a new schedule field, a different id scheme —
 * so an operator looking at a search created by an older release can tell that
 * it was written to a different contract, rather than inferring it from an app
 * version that also changes for a CSS fix.
 */
export const MANIFEST_VERSION = 1

/**
 * Every id this app may own in a customer's `/search/saved`, as a type.
 *
 * A union rather than `string`, because the teardown, the status table and the
 * read path all key on these, and a typo in one of them should be a build error
 * rather than a saved search nothing reads.
 */
export type AccelId = 'gno_lake_30d_c1d' | 'gno_sample_2m_c1h'

/**
 * The shape ids take, and the ONLY thing that tells this app's scheduled
 * searches apart from every other saved search in the workspace.
 *
 * Saved searches at `/search/saved` are a flat, shared namespace: an admin's own
 * work, other apps' work, and ours, in one list. There is no owning-app field to
 * filter on. So the teardown's entire claim to be safe is that it only ever
 * DELETEs an id matching this pattern AND present in MANIFEST below — prefix
 * first, because a bug in the manifest must still not reach somebody else's
 * search. Widening this regex widens what an uninstall can destroy.
 */
const ACCEL_ID = /^gno_[a-z0-9_]+$/

/** Whether an id in the workspace's saved-search list is one this app writes. */
export function isAccelId(id: string): boolean {
  return ACCEL_ID.test(id)
}

/** One scheduled search: what it runs, when, and on whose behalf. */
export interface AccelEntry {
  readonly id: AccelId
  /** The title Cribl's Saved Searches list shows. Prefixed so an operator
   *  scanning that list sees ours grouped, the way the id does for the code. */
  readonly name: string
  /** Which panel's number this run feeds, in the words that panel uses. An admin
   *  deciding whether to pause it needs to know what goes dark. */
  readonly serves: string
  /** The query the schedule runs. Imported from src/queries — see the header. */
  readonly body: string
  /** The query the panel's ⓘ shows for the number this run feeds. */
  readonly display: string
  /** The job window. On the sample entry this is NOT the live panel's window,
   *  and that difference is deliberately here rather than in the query text:
   *  changing the text would change what the ⓘ claims. */
  readonly earliest: string
  readonly latest: string
  /** Unix cron, five fields, read in `tz`. */
  readonly cron: string
  /** IANA zone. UTC on every entry: a schedule read in a local zone moves twice
   *  a year, and a 30-day total that skips or repeats an hour is a number nobody
   *  can reconcile against the Lake. */
  readonly tz: string
  /** How many past runs stay readable. This is the read path's whole margin: at
   *  `keepLastN: 1` a run that starts while a panel is reading leaves the panel
   *  with nothing, because a running job's results are not readable. */
  readonly keepLastN: number
  /** Why this one exists, in the terms the admin approving it cares about —
   *  what it costs today and what it costs scheduled. */
  readonly why: string
}

/**
 * THE TWO ENTRIES.
 *
 * Both replace a live query that this workspace measured as expensive; neither
 * adds a number to the screen that was not already there. If a third is ever
 * added, the bar is the same: it must replace something, and the saving must be
 * measured rather than assumed.
 */
// NAME CHARACTER SET, measured 2026-09-18 against a live workspace, NOT documented.
// Cribl refuses a saved search whose `name` does not match /^[a-zA-Z0-9 _-]+$/ —
// letters, digits, space, underscore, hyphen. `openapi.json` (4.19.0) does not say
// so: `SavedQuery.name` is a bare { type: 'string', description: 'Display name…' }
// with no `pattern`. These two names originally carried a middle dot and
// parentheses, both POSTs were refused with a schema error naming the pattern, and
// nothing was created.
//
// So the rule the rest of this repo follows — check the spec before you send a body —
// was followed here and was not enough. The spec is not the contract; the server is.
// Keep the `GNO ` prefix (an operator scans the shared Saved Searches list by it, and
// manifest.test.ts pins it) and keep every other character inside that class.
export const MANIFEST: readonly AccelEntry[] = Object.freeze([
  Object.freeze({
    id: 'gno_lake_30d_c1d',
    name: 'GNO Lake total 30 days',
    serves: 'Data Flow — Lake total (1 tile)',
    body: LAKE_TOTAL_QUERY,
    display: LAKE_TOTAL_QUERY,
    earliest: '-30d',
    latest: 'now',
    // 00:10 UTC rather than 00:00: the minute-of-hour at submit is what the cost
    // model is a function of (A-SP0), and the top of the hour is also when every
    // other scheduled thing in a workspace fires.
    cron: '10 0 * * *',
    tz: 'UTC',
    // Two, so a reader arriving while today's run is still going still has
    // yesterday's to show. One would be a daily window of blankness.
    keepLastN: 2,
    why:
      "Data Flow's 30-day Lake total is the most expensive query this app runs: 9,297.7 billable CPU-s a run, 15–24 runs a day, because it sums thirty days of Stream write counters and every viewer's first paint asks for it again. The figure it produces changes once a day at most. Run once at 00:10 UTC, the tile reads that run's stored result for about 0.2 CPU-s.",
  }),
  Object.freeze({
    id: 'gno_sample_2m_c1h',
    name: 'GNO Feed sample 2 minutes',
    serves: 'Field Explorer — In feed (field summaries)',
    body: FEED_SAMPLE_QUERY,
    display: FEED_SAMPLE_QUERY,
    // -4m…-2m, not -2m…now. The current minute's prefix is still landing, so a
    // window that includes it samples a partial minute and under-reports which
    // fields are arriving — the one question this panel exists to answer.
    earliest: '-4m',
    latest: '-2m',
    cron: '7 * * * *',
    tz: 'UTC',
    // Three: hourly runs mean a reader can be up to an hour behind the newest
    // one, and two would leave no slack if a run fails.
    keepLastN: 3,
    why:
      "Field Explorer's 'In feed' browser costs 754.9 CPU-s every time somebody opens the tab, to answer which of the ~319 AMI fields are actually arriving. It is a 5,000-row sample, so it was never reading the whole window anyway. One run an hour over a settled two-minute window answers the same question, and the visit reads the stored rows.",
  }),
])

/** The entry for an id. Throws rather than returning undefined: every caller
 *  here is asking about a search this app claims to own, and "no such entry" is
 *  a programming error, not a state to render. */
export function accelEntry(id: AccelId): AccelEntry {
  const found = MANIFEST.find((e) => e.id === id)
  if (!found) throw new Error(`accel manifest has no entry '${id}'`)
  return found
}

// ── The description an operator reads in Cribl's own UI ─────────────────────

/**
 * Line endings normalised before hashing.
 *
 * This repo is checked out on Windows with `core.autocrlf=true`, so the same
 * query string can reach a hash as `\r\n` on one machine and `\n` on another.
 * A digest that disagrees with itself across checkouts would report every
 * scheduled search as drifted — which cost six CI runs in Phase 1 to learn once
 * already.
 */
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

/**
 * First 12 hex characters of the SHA-256 of `text`.
 *
 * Web Crypto, not node:crypto: app code is type-checked without Node types and
 * runs in the browser. `crypto.subtle` exists only in a secure context, which
 * covers everywhere this app runs — installed over https, and the localhost dev
 * page, which browsers treat as secure.
 *
 * Twelve characters because this is an identity check a human performs by eye
 * against a description field, not a signature. It is not a defence against
 * anyone constructing a collision; nothing here is a security control.
 */
export async function shortSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lf(text)))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

/**
 * The `description` field of the saved search:
 *
 *   `GNO <appVersion> · manifest v1 · serves <id> · body-sha256:… · display-sha256:…`
 *
 * This is the only thing about the object that says who wrote it. An operator
 * who finds a scheduled search in their workspace and wants to know whether the
 * installed app still owns it reads this line, in Cribl's own UI, without the
 * app in front of them. It answers three questions in order: which app and which
 * release created it, which entry of that app's list it is, and whether the
 * query it is running is still the one that app intends to run and to show.
 *
 * `serves <id>` restates the saved search's own id, and does so on purpose: the
 * description travels — into a support ticket, a screenshot, a diff — where the
 * id beside it does not, and a line that identifies itself is worth the eleven
 * duplicated characters.
 *
 * Two digests rather than one because the body and the ⓘ are two claims; see the
 * header. Async because Web Crypto is, which makes every caller that writes a
 * saved search async too — they already are, since they are HTTP.
 */
export async function accelDescription(entry: AccelEntry): Promise<string> {
  const [body, display] = await Promise.all([shortSha256(entry.body), shortSha256(entry.display)])
  return `GNO ${APP_VERSION} · manifest v${MANIFEST_VERSION} · serves ${entry.id} · body-sha256:${body} · display-sha256:${display}`
}

// ── The POST body ───────────────────────────────────────────────────────────

/**
 * The schedule sub-object, in full, every time.
 *
 * A-SP23, measured 2026-09-17 against this workspace: **the `schedule` object is
 * replaced wholesale, never merged.** A PATCH carrying `{enabled, cronSchedule}`
 * returned 200 and silently dropped `tz` and `keepLastN` — the one that decides
 * which hour it fires, and the one the read path's entire margin depends on.
 * The same PATCH carrying only the three schema-required fields (`id`, `name`,
 * `query`) returned 200 and deleted `schedule`, `earliest`, `latest` and
 * `description` outright, unscheduling the search forever with no error.
 *
 * So there is no such thing as a partial write here. Pause/Resume is
 * read-modify-write of the WHOLE body:
 *
 *   const cur = (await GET /search/saved/{id}).items[0]
 *   await PATCH /search/saved/{id} with { ...cur, schedule: { ...cur.schedule, enabled: false } }
 *
 * And there is nothing to make that safe with: the object carries no ETag, no
 * version and no createdAt, so two writers racing clobber each other silently
 * and neither can tell. That is a property of the endpoint, not something this
 * app can fix — the mitigation is that these writes only ever happen from a
 * confirmed click, one at a time.
 */
export interface AccelSchedule {
  enabled: boolean
  cronSchedule: string
  tz: string
  keepLastN: number
  /** 0, explicitly. Left unset the Leader applies its global jitter, which would
   *  move the submit minute — and the submit minute is the variable the cost
   *  model (A-SP0) is a function of. A fixed minute is a predictable bill. */
  jitterPercent: number
  /** False: a Leader that was down for six hours must not wake up and run six
   *  30-day Lake totals back to back. The panel wants the newest result, not
   *  every result it missed. */
  resumeMissed: boolean
  /** True: a run interrupted by a restart should finish, so the day's one
   *  expensive run is not simply lost until tomorrow. */
  resumeOnBoot: boolean
  /** Disabled. These runs feed a panel; nobody subscribed to them. */
  notifications: { disabled: boolean; items: unknown[] }
}

/**
 * Exactly the bytes this app POSTs to `/search/saved`.
 *
 * `user` and `displayUsername` are absent deliberately: A-SP23 found them
 * server-controlled — POST stamps them, and supplying a different value on a
 * later PATCH is silently discarded. Ownership of these searches belongs to
 * whoever pressed Apply and cannot be moved by the app.
 */
export interface AccelSavedSearch {
  id: string
  name: string
  query: string
  description: string
  earliest: string
  latest: string
  /** False: the searches are readable by the workspace, because the panel they
   *  feed is. A private saved search would serve only the admin who applied it,
   *  and every other viewer would silently get nothing. */
  isPrivate: boolean
  schedule: AccelSchedule
}

/**
 * Build the POST body. Pure and synchronous, taking the description it will
 * carry, so a test can assert the exact object without awaiting anything and a
 * caller that already computed a description does not compute it twice.
 *
 * Every field the saved search should have is named here, including the ones
 * whose values are the API's own defaults. That is the A-SP23 lesson written as
 * code: for this endpoint an omitted field is a deleted field, so "the default
 * is fine" and "the field is absent" are the same sentence, and the only way to
 * be sure what the object holds is to state all of it.
 */
export function accelPostBody(entry: AccelEntry, description: string): AccelSavedSearch {
  return {
    id: entry.id,
    name: entry.name,
    query: entry.body,
    description,
    earliest: entry.earliest,
    latest: entry.latest,
    isPrivate: false,
    schedule: {
      enabled: true,
      cronSchedule: entry.cron,
      tz: entry.tz,
      keepLastN: entry.keepLastN,
      jitterPercent: 0,
      resumeMissed: false,
      resumeOnBoot: true,
      notifications: { disabled: true, items: [] },
    },
  }
}

/** The same body with its description computed. What the apply path calls. */
export async function accelSavedSearch(entry: AccelEntry): Promise<AccelSavedSearch> {
  return accelPostBody(entry, await accelDescription(entry))
}
