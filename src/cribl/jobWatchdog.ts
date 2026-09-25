// Searches that are still running long after anything should be, and what this
// app can honestly do about them.
//
// ── WHAT SLICE 0.5 ALREADY DOES, SO THAT THIS FILE CLAIMS ONLY THE REST ─────
// The plan (§1.8) reads as though hang control were unbuilt. Most of it shipped:
//
//   * every query this app submits carries `set max_running_time_per_search=`,
//     scaled by the window it reads — 120 s up to an hour, 300 s to four, 600 s
//     to a day, 900 s beyond (search.ts, DEFAULT_CAP_TIERS). A job that reaches
//     it ends `failed`, not `running`;
//   * the client gives up 30 s past that cap and cancels the job on the server;
//   * an abandoned search — range change, tab switch, unmount — is cancelled at
//     once rather than left to run to its cap (search.ts cancelJob).
//
// So a job this app started should already be dead. WHAT IS LEFT for a watchdog
// is narrower than §1.8 implies, and is exactly two populations:
//
//   1. jobs the cap did not stop. This is not hypothetical: the workspace's own
//      `maxSearchDuration: 420m` did not bound ten jobs found at 10.7–19.1 h,
//      and the app's cap is the same mechanism one level down. If it fails the
//      same way, nothing else in the app would ever say so.
//   2. jobs this app never submitted. Seventeen `searchUiUrl` deep links and the
//      Copilot brief hand a query to the Cribl Search UI, which runs it with no
//      cap of ours; ad-hoc investigations of this dataset are the same shape.
//      Thirteen `agentic` jobs in the last two days of history, every one of
//      them on this dataset, are that population showing up in the data.
//
// That is the whole job. This module does not re-implement the cap, does not
// cancel anything by itself, and never cancels on a timer.
//
// ── IT READS THE REST JOB LIST, NOT `dataset="$vt_jobs"` ────────────────────
// §1.8 specifies a `$vt_jobs` search every five minutes. That was measured at
// **2.534 billable CPU-s per poll** — about 730 CPU-s a day per open session, in
// an app whose entire purpose is reducing recurring spend. `GET /search/jobs` is
// a config-plane read: it bills nothing, and — the part that matters more than
// the credits — **it creates no job at all**. `searchHistoryMaxJobs` is 1,000
// here, and the 1,000 jobs in the list at the time of writing spanned 2.08 days,
// i.e. a turnover of ≈481 jobs/day. A five-minute polling SEARCH would add 288
// jobs/day per open session on top, shrinking everyone's ad-hoc search history
// from 2.08 days to 1.30 — and to under a day with two sessions open. A watchdog
// that evicts the history you would use to investigate the thing it found is not
// a watchdog.
//
// The REST route also disposes of the self-match problem §1.8's filter has. Its
// `where status=="running" and query contains "gigamon_ami"` matches the
// watchdog's own query text, and the research watched that happen to its own
// probe. A read creates no job, so it cannot see itself — and the text match is
// wrong anyway: of 1,000 jobs in the live history, 55 mention `gigamon_ami`
// somewhere in their text while reading a different dataset entirely (51 of them
// the app's own `cribl_metrics` total). `datasetIds` is what actually answers
// "is this a search of our data", and every row carries it.
//
// ── THREE THINGS §1.8 ASKS FOR THAT ARE NOT HERE, AND WHY ──────────────────
// Recorded so that the next reader does not take them for oversights.
//
// NO CIRCUIT BREAKER (`accel/breaker.ts`). It was justified by auto-refresh at
// 15 s spawning hung jobs faster than they could be noticed. A-D29 removed 15 s
// and 30 s from the menu entirely — `Off` and `1m` are all that remain. Its trip
// condition, "2 client timeouts in 10 minutes", also predates the server-side
// cap: post-0.5 the usual stop is the cap, which ends a job `failed` and
// surfaces as SearchTimeLimitError rather than as a client timeout, so a breaker
// counting timeouts would rarely trip at all. Both of its premises are gone.
//
// NO ESTIMATED-CREDITS COLUMN, and no spend-threshold escalation built on one.
// `billableCPUSeconds` reads **0 on a running job** — recorded twice in this
// plan's own evidence — so the column would have been a blank, or a number
// invented from elapsed time and labelled as a measurement. Elapsed time is
// readable, is honest, and is the thing that actually tells somebody a job is
// stuck; it is what a row leads with.
//
// NO KV WRITE. Dismissal is per job id, per session, in memory (below). A
// timer-driven write is forbidden by AGENTS.md and by §1.4, and an install-wide
// "dismissed" would outlive the job it was about.
//
// ── IT LISTS EVERY SEARCH IT CAN SEE. IT CANCELS ONLY YOUR OWN ─────────────
// The two halves are scoped differently, and that is the decision this module is
// built around rather than an accident of what was easy.
//
// THE LIST IS AS WIDE AS THE ACCOUNT ALLOWS. The ten hung jobs that opened this
// plan were not one person's — seven of them belonged to a single colleague — so
// a list filtered to "mine" would have shown an empty drawer during the very
// incident it exists for. Whatever Cribl returns for this account is what the
// drawer shows, with an owner on every row.
//
// CANCEL IS NARROWER THAN THE LIST, AND NARROWER THAN THE GRANT WOULD PERMIT:
// only a job the signed-in user owns (`mine === true`). Cancelling somebody
// else's search is destroying work in progress whose value you cannot see, with
// no way to resume it and nothing to tell them it happened but the result
// vanishing from their screen — and the grant an admin approves at install time
// should not include that. `mine === null` (the platform named nobody, which is
// always so under `npm run dev`) is not `true` and gets no button either: the
// app does not stop work it cannot show it started.
//
// WHAT WAS DELETED ALONG WITH THE WIDE CANCEL, so that nobody rebuilds a smaller
// version of it: a once-per-session probe that asked whether this account can
// see other people's jobs at all, and the three-state ('visible' | 'none-seen' |
// 'unknown') a drawer sentence was built on. Its whole purpose was deciding what
// a cross-user VIEW could promise — a toggle, a default scope, a claim about
// completeness. With Cancel scoped to own jobs there is nothing left to promise:
// the honest UI lists what the API returned, labels each row's owner, and offers
// Cancel where the row is yours. Two extra requests per session bought an answer
// no control asks for any more.
//
// The half of that honesty which survives is smaller and still true: a
// role-scoped job list is a **200 with zero rows, not a refusal**, so an account
// that can only see its own searches is indistinguishable here from a quiet
// workspace — `error` is null in both. The drawer therefore says in words what
// the list covers, and claims nothing about what it cannot see
// (components/jobWatchdogCopy.ts, COVERAGE_NOTE).
//
// And the other half of it: an empty list is not good news on its own. A
// refusal, a malformed filter and a genuinely quiet workspace all produce zero
// rows, so `error` is part of the state and must be READ BEFORE `jobs.length`.
// A surface that renders the count without it does not merely miss a refusal —
// it goes on asserting the LAST GOOD poll's count as current fact, with a live
// Cancel beside each row, which is worse than rendering nothing at all.

import { useSyncExternalStore } from 'react'
import { capi, errText } from './capi'
import { LAKE_DATASET, activeDataset } from './config'
import { PACK_PARQUET_DATASET_ID } from './pack'
import { DEFAULT_CAP_TIERS, capTiersInForce } from './search'
import { currentUser } from './user'

/**
 * The datasets whose long-running searches this watch lists, compared with a
 * job's `datasetIds` by EXACT id — never a prefix or a substring, so
 * `gigamon_ami` does not catch `gigamon_ami_pq` (or `gigamon_ami_sample`) by
 * accident, and the reverse cannot happen either.
 *
 *   * `gigamon_ami` always: the customer's dataset.
 *   * `gigamon_ami_pq` always: the onboarding pack's Parquet copy. Nothing in
 *     the app reads it by default, but the store benchmark times searches of it
 *     and the query router may one day send a panel there — and a Parquet
 *     group-by stopped by its running-time cap has been billed for thousands of
 *     CPU-seconds anyway (cribl/benchmarkPlan.ts's header), so a hung one is
 *     exactly what this watch is for. Ad-hoc searches of it from the Search UI
 *     are the same population as ad-hoc searches of `gigamon_ami`.
 *   * whichever dataset the panels are reading now: on a sample-only install
 *     every job this app submits reads the sample (cribl/datasetTarget.ts), and
 *     a hung one of those is this app's own.
 *
 * Cancel is unchanged by any of this: it stays the signed-in user's own jobs
 * only (`cancelHungJob`).
 */
export function watchedDatasets(): string[] {
  return [...new Set([LAKE_DATASET, PACK_PARQUET_DATASET_ID, activeDataset()])]
}

/**
 * The job list, as a policy object.
 *
 * Written as a literal rather than interpolated from `SEARCH_GROUP` because
 * policyCoverage.test.ts resolves call-site paths from the source text and can
 * only read a string constant here — an interpolated group resolves to a
 * placeholder, which would declare a grant in EVERY group instead of the one
 * search runs in. jobWatchdog.test.ts pins it back to `SEARCH_GROUP`, so the two
 * cannot drift.
 */
export const JOBS_PATH = '/m/default_search/search/jobs'

/**
 * How often a poll runs while the app is open and visible.
 *
 * THE COST, STATED RATHER THAN ASSUMED, because a read that costs no credits
 * still costs a request and runs per open tab forever. Measured against this
 * workspace through the dev proxy: one poll is a single GET whose response is
 * **61 bytes when nothing is running**, in 0.27–0.47 s. It submits no search
 * job, bills no CPU-seconds, and consumes no slot in the 1,000-job history. Over
 * a tab left open for a day that is 288 requests and ≈17 KB — against the 730
 * billable CPU-s/day the `$vt_jobs` design would have cost, and against the
 * ≈481 jobs/day the workspace already creates.
 *
 * WHY NOT FASTER, given it is nearly free: a hung job runs for hours, so finding
 * it two minutes sooner saves about 0.03 % of its bill. The cadence is set by
 * how long a problem may sit unnoticed in front of somebody watching the screen,
 * not by what the poll costs. Five minutes is §1.8's figure and there is no
 * evidence against it.
 *
 * WHY NOT SLOWER: the badge has to be plausibly current when somebody looks at
 * it, and `lastCheckedAt` is shown beside it.
 */
export const POLL_MS = 5 * 60 * 1000

/**
 * How far past the longest query this app permits itself a search has to run
 * before this module calls it hung: twice over.
 *
 * THE MARGIN IS THE WHOLE POINT, and it was missing. The threshold used to be
 * `max(900, widest cap)`, and 900 s IS the widest tier of DEFAULT_CAP_TIERS — so
 * the app's own longest-legitimate query, the pinned 30-day total, tripped the
 * loudest surface in the product at the exact second it became slow. A capped
 * query is not even dead at its cap: search.ts waits `cap + 30 s` before it
 * gives up and cancels, so there is a window in which a perfectly well-governed
 * job is still `running` past its limit. A threshold with no room over the limit
 * reports that window as a hang.
 *
 * WHY A MULTIPLIER RATHER THAN "cap + n seconds": an installer can raise the
 * caps to an hour (A-D30, SearchLimitsPanel, MAX_CAP_SECONDS = 3600), and a
 * fixed number of seconds that is generous against a 900 s cap is a rounding
 * error against a 3600 s one. The margin has to scale with the thing it is a
 * margin over.
 *
 * WHY TWO AND NOT TEN: doubling costs nothing in detection. Across 725 completed
 * `gigamon_ami` jobs in this workspace the median was 5.1 s, p95 9.1 s, p99
 * 15.4 s, and the slowest that ever finished took 51 s; the jobs this exists for
 * ran 10.7 to 19.1 HOURS. At the default caps the threshold moves from 15
 * minutes to 30 — still 35× the slowest search that ever completed here, and
 * still a twenty-first of the shortest hang ever seen. Anything larger would
 * only delay the badge on a job that is going to run all night anyway.
 */
export const HUNG_MARGIN = 2

/** The widest cap this app ships with: 900 s, for a pinned 30-day window. Read
 *  from the table rather than typed again, so a change to DEFAULT_CAP_TIERS
 *  moves the floor with it. */
const DEFAULT_WIDEST_CAP_SECONDS = Math.max(...DEFAULT_CAP_TIERS.map((t) => t.capSeconds))

/**
 * The floor under "long-running": half an hour, and not a round number — it is
 * the app's shipped widest cap with the margin above applied.
 *
 * Those seconds are demo-scale (I-D24) and a production tenant reads more data
 * in the same wall time, which is why `hungAfterSeconds()` tracks the caps
 * upward — and why the threshold is overridable for a Preview check, which
 * cannot wait half an hour for a real job.
 */
export const HUNG_FLOOR_SECONDS = DEFAULT_WIDEST_CAP_SECONDS * HUNG_MARGIN

let overrideSeconds: number | null = null

/**
 * The threshold in force: the margin over the app's own widest running-time cap,
 * but never below the floor.
 *
 * UPWARD ONLY, and the asymmetry is the point. If an installer raises the caps
 * for a tenant whose panels legitimately need longer, a query this app is now
 * allowed to run for 20 minutes must not be reported as hung at 15. But if they
 * LOWER the caps to 120 s, the threshold stays at the floor: other people's
 * ad-hoc searches are not governed by this app's caps, and calling a
 * four-minute investigation "long-running" is how a badge becomes wallpaper.
 */
export function hungAfterSeconds(): number {
  if (overrideSeconds !== null) return overrideSeconds
  const widest = Math.max(...capTiersInForce().map((t) => t.capSeconds))
  return Math.max(HUNG_FLOOR_SECONDS, Number.isFinite(widest) ? widest * HUNG_MARGIN : 0)
}

/**
 * Override the threshold — for tests, and for the Preview check, which has to
 * see a row without waiting half an hour for a real job to qualify. `null`
 * restores the derived value. Deliberately not persisted anywhere: a lowered
 * threshold that survived a reload would be a permanent change nobody could see
 * they had made.
 */
export function setHungAfterSeconds(seconds: number | null): void {
  overrideSeconds = seconds
  set({ thresholdSeconds: hungAfterSeconds() })
}

/** The prefix search.ts stamps on every query this app submits. Its presence
 *  says a job carried a running-time cap and outlived it anyway; its absence
 *  says the query came from somewhere that does not cap — the Search UI, a deep
 *  link, Copilot. It cannot prove authorship: anybody may type the same prefix. */
const CAP_PREFIX = 'set max_running_time_per_search='

/** One long-running search, as a row needs it. Owner and age lead; the query
 *  text is diagnostic and is somebody else's work. */
export interface HungJob {
  id: string
  /** The owner as Cribl names them for display. */
  owner: string
  /** The owner as the API keys them (`auth0|…`, `…@clients`). What a filter
   *  expression and an accessible name both need. */
  ownerId: string
  /**
   * Whether this is the signed-in user's own job — `null` when the platform
   * names nobody (always so under `npm run dev`), which is different from
   * `false` and must not be rendered as "someone else's".
   *
   * It is also the one thing that decides whether Cancel is offered at all, so
   * only `true` earns the button: both `false` and `null` mean this app cannot
   * show the work is the viewer's, and it does not stop work it did not start.
   */
  mine: boolean | null
  /** Epoch ms the job started running, or was created when Cribl recorded no
   *  start (a job cancelled out of the queue has no `timeStarted`). */
  startedAt: number
  /** True when `startedAt` is really the creation time, so a caller can say
   *  "created" rather than claiming a running time it does not have. */
  startedAtIsCreation: boolean
  /** How long it has been running, as of the poll this row came from. */
  elapsedMs: number
  query: string
  /** The window the query reads — a `-30d` ad-hoc search explains itself. */
  earliest: string | null
  latest: string | null
  /** The datasets Cribl resolved the query against. This, not the query text,
   *  is what says the job is reading our data. */
  datasetIds: string[]
  /** `standard`, `agentic`, `scheduled`, … — the Copilot jobs come back
   *  `agentic`, and they are not something a person started by hand. */
  type: string
  /** Whether the query carries this app's running-time cap. See CAP_PREFIX. */
  carriesRunningTimeCap: boolean
}

export interface WatchdogState {
  /** Long-running searches of this app's dataset, oldest first. */
  jobs: readonly HungJob[]
  /**
   * Running jobs past the threshold on OTHER datasets. Not listed — this app
   * cannot explain somebody's `cribl_internal_logs` search and should not try —
   * but counted, so a UI can say what the watch is scoped to instead of
   * implying it watches everything.
   */
  otherDatasetsOverThreshold: number
  /**
   * Epoch ms the last poll that actually came back with a job list finished, or
   * null before the first. This is the age of `jobs`, and it is what the drawer
   * prints as "Last checked": a refused poll checked nothing and must not move
   * it, or the screen timestamps rows it never re-read.
   */
  lastCheckedAt: number | null
  /**
   * Epoch ms the last poll ATTEMPT finished, whatever it answered — a 403, an
   * unreadable body and a network error all set it.
   *
   * Separate from `lastCheckedAt` because the two are asked different
   * questions. The minimum-gap guard asks "when did we last TALK to Cribl", and
   * gating it on success meant a refusing workspace had no gap at all: every
   * alt-tab back to the app fired another request, in the one state where
   * polling is most certainly useless.
   */
  lastAttemptAt: number | null
  /**
   * Why the last poll told us nothing, or null when it worked.
   *
   * READ THIS BEFORE `jobs.length`. A refused list, a rejected filter and a
   * quiet workspace all give zero rows, and only this distinguishes "nothing is
   * wrong" from "we cannot see". While it is set, `jobs` is whatever the last
   * good poll found and is no longer a claim about now — which is why nothing
   * built on it may offer Cancel.
   */
  error: string | null
  /** True when the last poll was refused (401/403) rather than failing. The
   *  drawer names the method and path an admin would need to grant. */
  denied: boolean
  /** A poll is in flight. */
  checking: boolean
  /** The poll is idle because the document is hidden. It resumes, with an
   *  immediate check, when the tab is looked at again. */
  paused: boolean
  /** The threshold these rows were selected against, in seconds. */
  thresholdSeconds: number
  /** Cribl returned as many rows as we asked for, so there may be more. */
  truncated: boolean
  /** Ids dismissed this session. Dismissal hides the escalation, never the
   *  badge — §1.8 is explicit that the badge stays while any job is hung. */
  dismissedIds: readonly string[]
  /**
   * Increments only when the SET of job ids changes, never on an unchanged
   * poll. A `role="status"` keyed on this speaks once when something new
   * appears; keyed on the poll it would interrupt somebody twelve times an hour
   * to repeat that a colleague's job is still running.
   */
  idSetSeq: number
}

const EMPTY: WatchdogState = {
  jobs: [],
  otherDatasetsOverThreshold: 0,
  lastCheckedAt: null,
  lastAttemptAt: null,
  error: null,
  denied: false,
  checking: false,
  paused: false,
  thresholdSeconds: HUNG_FLOOR_SECONDS,
  truncated: false,
  dismissedIds: [],
  idSetSeq: 0,
}

let state: WatchdogState = EMPTY
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function set(patch: Partial<WatchdogState>): void {
  state = { ...state, ...patch }
  emit()
}

/** How many rows one poll asks for. Well past anything sane: ten hung jobs was
 *  the worst this workspace has produced, and a workspace with 200 running
 *  searches of one dataset has a problem no list length changes. `truncated`
 *  says when the answer was cut off rather than pretending it was complete. */
const PAGE_LIMIT = 200

/**
 * The query string for one poll.
 *
 * `status=='running'` is done SERVER-SIDE and everything else client-side, on
 * purpose. `filterExp` is evaluated by Cribl and it fails silently in the worst
 * possible direction: a field name that does not exist returns `{"items":[],
 * "totalCount":0}` with a 200, which is indistinguishable from a quiet
 * workspace. A malformed expression at least answers 500. So exactly one field
 * goes into it — `status`, whose values are a documented enum — and it earns its
 * risk: it takes the response from 686 KB (the 1,000-row short list, measured)
 * to 61 bytes. The dataset match then happens here, where the rows are visible
 * and a mistake shows up as the wrong rows rather than as no rows.
 *
 * `offset` is not optional: `limit` without it is a live 400, "missing 'offset'
 * parameter", although the spec marks it optional.
 *
 * Oldest first, so that if there are ever more running jobs than PAGE_LIMIT the
 * page that comes back is the one holding the jobs most likely to be over the
 * threshold. Rows are re-sorted by elapsed time on the way out; this ordering is
 * about which rows arrive at all.
 */
function pollQuery(): string {
  return new URLSearchParams({
    output: 'short',
    offset: '0',
    limit: String(PAGE_LIMIT),
    sortExp: 'timeCreated',
    sortDir: 'asc',
    filterExp: "status=='running'",
  }).toString()
}

/** A job row as the `output=short` list returns it. Everything is optional
 *  because this is somebody else's JSON and a missing field must degrade a row,
 *  not throw away the poll. */
interface ShortJob {
  id?: unknown
  query?: unknown
  earliest?: unknown
  latest?: unknown
  timeCreated?: unknown
  timeStarted?: unknown
  status?: unknown
  user?: unknown
  displayUsername?: unknown
  datasetIds?: unknown
  type?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The signed-in user's ids, for the `mine` comparison. Empty when the platform
 *  names nobody. */
let meIds: string[] = []
let meResolved = false

async function resolveMe(): Promise<void> {
  if (meResolved) return
  meResolved = true
  const user = await currentUser()
  // Both `id` and `username`, because the list's `user` field is an identity
  // string (`auth0|…`) and nothing documents which of the two it equals. Getting
  // this wrong marks a person's own job as somebody else's, so it accepts
  // either rather than picking one on a guess.
  meIds = user ? [user.id, user.username].filter((s): s is string => typeof s === 'string' && s.length > 0) : []
}

function toHungJob(raw: ShortJob, now: number, thresholdMs: number): HungJob | null {
  const id = str(raw.id)
  if (!id) return null
  // Checked again here, although `filterExp` already asked for it. The whole
  // selection rests on one query parameter surviving a proxy this app has only
  // exercised through the dev server; if it were ever dropped, the list would
  // come back full of finished jobs and every one of them started hours ago.
  // With this line a dropped parameter costs 686 KB a poll instead of a badge
  // reporting a colleague's completed search as hung.
  if (str(raw.status) !== 'running') return null
  const started = num(raw.timeStarted)
  const created = num(raw.timeCreated)
  const startedAt = started ?? created
  if (startedAt === null) return null
  const elapsedMs = now - startedAt
  if (elapsedMs < thresholdMs) return null
  const ownerId = str(raw.user) ?? ''
  const query = str(raw.query) ?? ''
  return {
    id,
    owner: str(raw.displayUsername) ?? (ownerId || 'unknown'),
    ownerId,
    mine: meIds.length === 0 || !ownerId ? null : meIds.includes(ownerId),
    startedAt,
    startedAtIsCreation: started === null,
    elapsedMs,
    query,
    earliest: str(raw.earliest),
    latest: str(raw.latest),
    datasetIds: Array.isArray(raw.datasetIds) ? raw.datasetIds.filter((d): d is string => typeof d === 'string') : [],
    type: str(raw.type) ?? 'standard',
    carriesRunningTimeCap: query.includes(CAP_PREFIX),
  }
}

/** Two id lists holding the same ids, in any order. */
function sameIds(a: readonly HungJob[], b: readonly HungJob[]): boolean {
  if (a.length !== b.length) return false
  const seen = new Set(a.map((j) => j.id))
  return b.every((j) => seen.has(j.id))
}

let polling = false

/**
 * One poll. Never throws: a watchdog that can fail its caller is worse than no
 * watchdog, and every outcome it can have is a state a screen has to render
 * anyway.
 *
 * The outcome-specific half is `pollOnce`; what is here is the half that must
 * happen WHATEVER the outcome was, which is why it is a `finally` and not four
 * copies of the same two fields. `lastAttemptAt` in particular: the minimum-gap
 * guard reads it, and a version of it that only counted successes let a refused
 * workspace fire a request on every return to the tab.
 */
/** A request that never settles would latch `polling` and wedge the watch for
 *  the life of the page — and silently, because `checking` would stay true and
 *  no error would ever be written. A hung request is the exact condition this
 *  module exists to notice, so it does not get to be the thing that stops it
 *  noticing. Comfortably longer than the slowest observed list read (0.7 s). */
const POLL_TIMEOUT_MS = 20_000

export async function checkNow(): Promise<void> {
  if (polling) return
  polling = true
  set({ checking: true })
  try {
    set(await Promise.race([
      pollOnce(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('The job list did not answer in time.')), POLL_TIMEOUT_MS)
      }) as Promise<never>,
    ]))
  } catch (err) {
    set({ denied: false, error: err instanceof Error ? err.message : 'The job list could not be read.' })
  } finally {
    set({ checking: false, lastAttemptAt: Date.now() })
    polling = false
  }
}

/** One poll's worth of new state. Throws only what the network throws. */
async function pollOnce(): Promise<Partial<WatchdogState>> {
  await resolveMe()
  const thresholdSeconds = hungAfterSeconds()
  // `background: true` keeps this refusal out of the attribution capi.ts does
  // for <GatedControl>: see the note on CapiInit.background. A poll that fires
  // every five minutes must never be able to mark somebody's unrelated click as
  // denied.
  const r = await capi('GET', `${JOBS_PATH}?${pollQuery()}`, undefined, { background: true })
  if (r.status === 401 || r.status === 403) {
    // What must not happen is the screen reading zero rows as "all clear".
    return {
      denied: true,
      error: 'This account cannot list Cribl Search jobs, so long-running searches cannot be checked.',
    }
  }
  if (r.status !== 200) {
    return { denied: false, error: `Cribl answered ${r.status} — ${errText(r)}` }
  }
  const items = (r.body as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    return { denied: false, error: 'Cribl returned a job list this app could not read.' }
  }
  const now = Date.now()
  const thresholdMs = thresholdSeconds * 1000
  const over = items
    .map((raw) => toHungJob(raw as ShortJob, now, thresholdMs))
    .filter((j): j is HungJob => j !== null)
  const watched = new Set(watchedDatasets())
  const listed = over
    .filter((j) => j.datasetIds.some((d) => watched.has(d)))
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
  // Drop anything cancelled here that Cribl is still listing, and forget the
  // ones it has caught up on — see cancelledHere.
  for (const id of [...cancelledHere]) if (!listed.some((j) => j.id === id)) cancelledHere.delete(id)
  const jobs = listed.filter((j) => !cancelledHere.has(j.id))
  return {
    jobs,
    otherDatasetsOverThreshold: over.length - jobs.length,
    lastCheckedAt: now,
    error: null,
    denied: false,
    thresholdSeconds,
    truncated: items.length >= PAGE_LIMIT,
    // Ids that have gone are no longer dismissible; keeping them would let a
    // recycled id arrive pre-dismissed.
    dismissedIds: state.dismissedIds.filter((id) => jobs.some((j) => j.id === id)),
    idSetSeq: sameIds(state.jobs, jobs) ? state.idSetSeq : state.idSetSeq + 1,
  }
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/** Why this app refused to send a cancel at all. Nothing left the browser. */
export type CancelDeclined =
  /** The watch is not listing that job any more: it finished, or it was already
   *  cancelled. There is nothing running to stop, which is not a failure. */
  | 'gone'
  /** Not the signed-in user's job — or not provably theirs. The app does not
   *  stop work it did not start. */
  | 'not-yours'
  /** The last poll failed, so the list this decision would rest on is stale and
   *  "is it still running" is a question this app currently cannot answer. */
  | 'unverified'

export interface CancelResult {
  /** Cribl accepted the cancel. */
  ok: boolean
  /** Set when this app declined before asking Cribl; null when the request was
   *  actually sent. The sentence for each case is components/jobWatchdogCopy.ts's
   *  business, not this module's. */
  declined: CancelDeclined | null
  /** The HTTP status, so a caller can quote it. 0 when the request never
   *  reached Cribl — including every decline, where it was never made. */
  httpStatus: number
  /** The status Cribl reported for the job afterwards, when it reported one. */
  reportedStatus: string | null
  /** Cribl's own sentence when it refused. */
  detail: string | null
}

/**
 * Ask Cribl to stop one of the signed-in user's own long-running searches.
 *
 * **OWN JOBS ONLY.** The drawer lists every long-running search this account can
 * see; this stops only the ones `mine === true`. Both `false` and `null` are
 * refused here as well as hidden in the UI, because the two guards fail
 * differently: the UI can be wrong about a stale row, and this cannot be reached
 * without going through the store the row came from.
 *
 * It is still volatile enough to need everything §1.4 asks of a write: a
 * deliberate click, a confirmation naming the job id and its age, the outcome
 * reported afterwards, and never a render, a timer or a retry. A search of your
 * own that has been running for nineteen hours is still an investigation
 * somebody is waiting on, and cancelling it discards whatever it had done.
 *
 * It takes the whole row rather than an id so a caller cannot invoke it without
 * the age and the owner it is required to have put in front of somebody first,
 * and it re-reads the store at the moment of the click rather than trusting the
 * render: a job that finished in between is correctly declined, and this never
 * becomes a general-purpose "cancel any job in the workspace" primitive.
 */
/**
 * Jobs cancelled in this session, held only until Cribl stops listing them.
 *
 * A poll already in flight when the cancel lands answers from a list Cribl
 * built BEFORE it, so without this the cancelled row reappears — carrying a
 * Cancel button for a job that is already gone. An id leaves this set the first
 * time a poll comes back without it, so it can never hide a job that is really
 * still running; it only covers the gap between the cancel and Cribl agreeing.
 */
const cancelledHere = new Set<string>()

export async function cancelHungJob(job: HungJob): Promise<CancelResult> {
  const declined = whyNotCancellable(job)
  if (declined) return { ok: false, declined, httpStatus: 0, reportedStatus: null, detail: null }
  try {
    const r = await capi('POST', `${JOBS_PATH}/${encodeURIComponent(job.id)}/cancel`)
    const ok = r.status >= 200 && r.status < 300
    const reported = str((r.body as { items?: Array<{ status?: unknown }> } | null)?.items?.[0]?.status)
    if (ok) {
      // Drop the row now rather than leaving it on screen for up to five
      // minutes looking like the cancel did nothing, then confirm against Cribl.
      cancelledHere.add(job.id)
      const jobs = state.jobs.filter((j) => j.id !== job.id)
      set({
        jobs,
        dismissedIds: state.dismissedIds.filter((id) => id !== job.id),
        idSetSeq: state.idSetSeq + 1,
      })
      void checkNow()
    }
    return { ok, declined: null, httpStatus: r.status, reportedStatus: reported, detail: ok ? null : errText(r) }
  } catch (err) {
    return {
      ok: false,
      declined: null,
      httpStatus: 0,
      reportedStatus: null,
      detail: err instanceof Error ? err.message : 'The cancel request did not reach Cribl.',
    }
  }
}

/**
 * Whether this app will send a cancel for that row, and why not when it will
 * not.
 *
 * THE SAME RULE EXISTS TWICE, and deliberately: components/jobWatchdogCopy.ts's
 * `cancelUnavailable` decides at render time whether the row gets a button at
 * all, from the snapshot it is rendering. This one decides at the moment of the
 * click, from the store as it stands — which is a different question, because
 * the answer can change between the two. A row that was the viewer's own and
 * listed when it was painted may have finished since, and this is the guard that
 * catches it.
 *
 * ORDER MATTERS. `error` is read first: when the last poll failed, the list is
 * from an earlier one, so "it is no longer listed" is not something this app
 * knows — and saying so would be the same lie as a header that keeps counting
 * after it has gone blind.
 */
function whyNotCancellable(job: HungJob): CancelDeclined | null {
  if (state.error !== null) return 'unverified'
  const listed = state.jobs.find((j) => j.id === job.id)
  if (!listed) return 'gone'
  if (listed.mine !== true) return 'not-yours'
  return null
}

// ── Dismissal, per job id, per session ──────────────────────────────────────

/** Stop escalating about one job. In memory and for this page only: §1.4 forbids
 *  a KV write on a timer, and this is not a confirmed action. The badge stays
 *  while the job does — dismissal silences the banner, not the count. */
export function dismissJob(id: string): void {
  if (state.dismissedIds.includes(id)) return
  set({ dismissedIds: [...state.dismissedIds, id] })
}

/** "Show again" — dismissal is not a one-way door. */
export function restoreDismissed(): void {
  if (state.dismissedIds.length) set({ dismissedIds: [] })
}

// ── The poll loop ───────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null
let subscribers = 0

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function schedule(): void {
  if (timer !== null || subscribers === 0) return
  timer = setTimeout(() => {
    timer = null
    void tick()
  }, POLL_MS)
}

/**
 * The shortest gap the loop will leave between two polls of its own.
 *
 * Not an optimisation — it closes a real hole. `tick()` runs on the timer, on
 * every return to the tab, and on the first subscriber, and the last two are
 * things a person does repeatedly: alt-tabbing between this app and Cribl Search
 * a dozen times while investigating would otherwise be a dozen polls a minute,
 * and React's development double-mount is two more. An explicit `checkNow()` —
 * a Re-check button, the re-read after a cancel — deliberately bypasses this,
 * because that is somebody asking rather than something happening.
 */
const MIN_GAP_MS = POLL_MS / 2

async function tick(): Promise<void> {
  // A tab behind other windows should not talk to Cribl every five minutes. The
  // timer keeps running — it is one no-op — and `paused` says so, so the badge
  // can show a stale `lastCheckedAt` honestly instead of silently.
  if (hidden()) {
    if (!state.paused) set({ paused: true })
    schedule()
    return
  }
  if (state.paused) set({ paused: false })
  // Every ATTEMPT, not every success. A refused or failing workspace is exactly
  // the case where a burst of requests buys nothing at all.
  if (state.lastAttemptAt !== null && Date.now() - state.lastAttemptAt < MIN_GAP_MS) {
    schedule()
    return
  }
  await checkNow()
  schedule()
}

function onVisibility(): void {
  if (hidden()) {
    set({ paused: true })
    return
  }
  set({ paused: false })
  // Immediately, not on the next tick: somebody has just come back to the tab
  // and the first thing they look at is the badge.
  void tick()
}

/**
 * Watch the store, and keep the poll loop alive for as long as you do.
 *
 * `useJobWatchdog` is this through `useSyncExternalStore` and is what a
 * component should use. It is exported because the loop — the `document.hidden`
 * pause, the minimum gap, the teardown when the last consumer goes — is the part
 * of this module most worth testing and the part React makes hardest to reach.
 */
export function subscribeToWatchdog(l: () => void): () => void {
  listeners.add(l)
  subscribers += 1
  if (subscribers === 1) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    void tick()
  }
  return () => {
    listeners.delete(l)
    subscribers -= 1
    if (subscribers === 0) {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

/**
 * The watch as it stands, without a React render.
 *
 * `useJobWatchdog` below is the same value through `useSyncExternalStore`. This
 * exists for the two callers that are not components: the tests, and any handler
 * that has to answer "is this job still listed?" at the moment of a click rather
 * than at the moment of the last render.
 */
export function watchdogState(): WatchdogState {
  return state
}

const getSnapshot = watchdogState

/**
 * The watch, for the header badge and the drawer.
 *
 * The poll starts when the first consumer subscribes and stops when the last one
 * goes, so an app nobody is looking at asks Cribl nothing. Keep it mounted in
 * the header: that is what makes the badge ambient rather than something you
 * have to go and look for.
 */
export function useJobWatchdog(): WatchdogState {
  return useSyncExternalStore(subscribeToWatchdog, getSnapshot, getSnapshot)
}

/** Only for tests: forget everything this page has observed. */
export function resetJobWatchdog(): void {
  state = EMPTY
  overrideSeconds = null
  meIds = []
  meResolved = false
  polling = false
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  emit()
}
