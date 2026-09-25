// Reading a scheduled run's stored result instead of running the query again.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TRADE, IN ONE PARAGRAPH. `dataset="$vt_results" jobName="<id>"` returns the
// rows a previous job already produced: measured at 0.3 s and 0.2 billable CPU-s,
// against 6 s and 127 CPU-s for the same body run live. Phase 2 points two panels
// at that. Nothing about the number changes — the same query text produced it —
// except WHEN it was produced, and that is the entire risk this module exists to
// manage.
//
// ── THE DANGEROUS CASE IS NOT AN ERROR ──────────────────────────────────────
// Every failure here is loud and cheap: no run yet, a failed run, an unreadable
// read — all of them fall back to the live query and the customer sees the right
// number at the old price. The case that is quiet is a STALE run. A schedule that
// stopped firing leaves a perfectly readable result behind, and a panel reading it
// shows a plausible number, correctly formatted, indefinitely. A-SP23 measured
// exactly how a schedule stops firing without anyone touching it: a PATCH that
// omits the `schedule` object returns 200 and deletes it.
//
// So a result from a schedule is NEVER returned undated. Every read that answers
// from a stored run carries the run and the time it finished, and the panel that
// renders it is required to say so ("as of HH:MM"). A read that cannot be dated
// falls back to live — not because an undated number is wrong, but because an
// undated number cannot be labelled, and the label is the whole safety argument.
//
// AND A STALE RESULT IS RETURNED, NOT REPLACED. Falling back to live on staleness
// sounds safer and is worse: it silently reinstates the 9,297 CPU-s query at the
// exact moment the schedule breaks — the cost blowup this phase exists to prevent,
// arriving invisibly. Stale comes back flagged and dated, and the loud part
// belongs in the status table (accel/status.ts), where somebody can fix the
// schedule.
//
// ── WHAT THIS MODULE MAY NOT PUT ON SCREEN ──────────────────────────────────
// Cribl's error text. cribl/search.ts throws
// `Cribl API <status> <statusText> — <body>`, and <QueryBoundary> renders
// `state.error` verbatim, so a 4xx on a fast read would print Cribl's echo of
// `dataset="$vt_results" jobName=…` into a customer's panel — a query they never
// wrote, about an object they may not know exists, as the explanation for a
// missing chart. Every failure here is therefore reported as an outcome plus one
// of this module's own sentences (NOTES below), and the detail goes to the
// console. Nothing built from an API response reaches the return value.
//
// ── THE THINGS THE PLATFORM DOES THAT A READER WILL OTHERWISE "FIX" ─────────
//   * THE TIME PICKER IS IGNORED on a `$vt_results` read. The submitted range is
//     `-7d … now` and it selects nothing; the result is whatever the named run
//     stored, over whatever window that run read. Narrowing this range does not
//     narrow the data, and widening it does not reach further back.
//   * `$vt_results` IS NOT AN OBJECT. It is a virtual table named in query text.
//     GET on it is a 404, and it needs no grant in config/policies.yml — do not
//     declare one.
//   * THE `jobName=` PREDICATE IS MANDATORY. A read without a `jobName` or
//     `jobId` predicate errors. `jobId` is the OTHER half of that sentence and
//     it is what makes a timeline possible: it addresses ONE run rather than
//     "whatever the newest run of this schedule is". Every stored row already
//     carries its `jobId` as a virtual column, and status.ts already lists a
//     schedule's runs, so reading a chosen past state needs no new mechanism —
//     only the decision to ask for one. See `asOf` below.
//   * WHAT `jobName=` BINDS TO IS NOT KNOWN (claim V-23). A saved search has an
//     id (`gno_lake_30d_c1d`) and a display name ('GNO Lake total 30 days'),
//     and nobody has measured which of the two that predicate selects on —
//     spike A-SP1 exists to settle it and has never been run. The plan's first
//     answer was to make them equal; Phase 2 withdrew that, because an operator
//     scanning a shared Saved Searches list has to be able to tell what a thing
//     is before deciding it is safe to delete, and `gno_sample_2m_c1h` does not
//     tell them.
//
//     So the read asks the id, and on ZERO ROWS asks the display name before it
//     concludes there is no run. Getting this wrong in the other direction is
//     the reason: keyed only on the id, a name-binding platform returns zero
//     rows to both panels forever, the app reads that as "not run yet", falls
//     back to live, renders the right number — and saves NOTHING, silently, for
//     the entire life of the phase. The fallback costs one more stored-result
//     read, 0.2 billable CPU-s, AND ONLY ON A MISS — a path that was already
//     about to spend a live query's 754.9 or 9,297.7 CPU-s. That is the price
//     anybody deleting this fallback is choosing to stop paying.
//
//     Which key answered is memoised per entry for the session (KEY_MEMO), so
//     the loser is paid for once, and it is reported on every read (`key`) and
//     summarised by `observedKeyBinding()` — which is the answer to V-23,
//     readable off a running app instead of off a spike nobody ran.
//   * NO `set allow_previous_results` PREFIX, EVER (decision A-D15). The result is
//     already stored; that prefix is for live queries. For the avoidance of
//     doubt about what search.ts adds on its own: `withExecPrefix` prefixes
//     `set max_running_time_per_search=<n>; ` onto every job this app submits,
//     including this one, and that is the only prefix it emits. It is a
//     running-time cap, not a results directive. Nothing in this app can produce
//     `allow_previous_results`, and read.test.ts asserts the submitted body.
//   * NO `allow_incomplete_results` EITHER, which is why a failed run falls back
//     instead of being read. The reasoning is on the branch in `diagnose`.
// ─────────────────────────────────────────────────────────────────────────────

import { readJobResults, runFieldSummaries, runSearch, summariseRows, type FieldSummariesResult, type Row } from '../search'
import type { CostSlot } from '../jobCost'
import { beginQuery, endQuery } from '../inflight'
import { accelEntry, isAccelId, type AccelEntry, type AccelId } from './manifest'
import { evaluateTail, parseTail } from './tail'
import type { ServingVerdict } from './serving'
import { cronIntervalMs, listRuns, nearestRun, runAtOrBefore, runMeta, snapshotTimeline, type AccelRun } from './status'

/** The virtual table a stored result is read from. Named in query text only. */
export const VT_RESULTS = '$vt_results'

/** How many rows of a stored artifact to read. The sample entry persists 5,000
 *  (`| limit 5000`), and reading fewer would silently narrow the field census
 *  a chosen moment reports against the one "newest" reports. */
export const ARTIFACT_LIMIT = 5000

/**
 * How many rows an artifact read asks for. Every artifact is read whole, once,
 * and shared (`readArtifact`), because a tail that re-aggregates needs every
 * row. Not a guess at "big enough": the read's own header says how many rows
 * the result holds (`totalEventCount`), and a read that got fewer is refused as
 * incomplete for any re-aggregating tail (`shapeRows`). This only decides how
 * large a result can be before that refusal sends the panel back to the query
 * path. The largest measured is 12,153 rows (DNS resolvers, 2026-09-23), so
 * 20,000 holds it with room and caps what an oversized result can waste — about
 * 2 MB — before that refusal. Two bodies have no row cap of their own (DNS by
 * resolver, Shadow AI by app and source), and on a large tenant either can
 * outgrow it; they then cost the job they cost before this path existed.
 */
export const FULL_ARTIFACT_LIMIT = 20_000

/**
 * The most fields Cribl's `/field-summaries` answers with — the cap Field
 * Explorer's In feed panel states beside its list. A summary computed in the
 * browser from a stored run is cut to it, so the newest run reads the same
 * whichever path served it.
 */
export const FIELD_SUMMARIES_CAP = 200

/**
 * The three columns `$vt_results` adds to every row, which the scheduled body
 * never produced.
 *
 * They are stripped before a row reaches a caller. A panel handed them would see
 * fields its own query cannot account for — and on the Field Explorer path, which
 * summarises whatever fields it is given, `jobId` would be listed to the customer
 * as a field arriving in their network telemetry.
 */
export const VIRTUAL_COLUMNS: readonly string[] = ['jobId', 'jobName', 'dataset']

/** The two of them this module reads before dropping them: which run answered,
 *  and which schedule it belonged to. */
const COL_JOB_ID = 'jobId'
const COL_JOB_NAME = 'jobName'

/**
 * The range every fast read is submitted at.
 *
 * INERT. It is not a filter on the stored rows — the picker is ignored on a
 * `$vt_results` read — but a job still has to be submitted with a range, so this
 * is one wide enough that nothing about it can be mistaken for a selection.
 * Changing it changes nothing about the data and only moves which running-time
 * cap tier search.ts applies.
 */
export const FAST_EARLIEST = '-7d'
export const FAST_LATEST = 'now'

/**
 * How long a fast read may take before it is abandoned for the live query.
 *
 * search.ts sizes its client timeout from the cap tier of the submitted window,
 * and `-7d` lands in the widest tier — 900 s, so 930 s before it gives up. That
 * is the correct number for a 30-day aggregate and an absurd one for a read of
 * something already computed: a panel blank for fifteen minutes has failed
 * whatever the job is doing. Twenty seconds is two orders of magnitude over the
 * measured 0.3 s read and still well past this workspace's ~5 s floor for any
 * query at all.
 */
export const FAST_TIMEOUT_MS = 20_000

/**
 * How many cadences old a run may be before it is called stale.
 *
 * Two, from the plan. One would flag every run that fires a minute late; three
 * would let a daily schedule be dead for most of a week without saying so.
 */
export const STALE_FACTOR = 2

/**
 * The staleness window used when the cron shape cannot be read.
 *
 * A day — the longest cadence in the manifest — because the two errors are not
 * symmetrical. Assume hourly and a healthy daily run is reported stale two hours
 * after it succeeds, putting a warning on a correct number every day. Assume
 * daily and an hourly schedule that has stopped goes unremarked for two days, in
 * a panel that is still dated and still says when its sample was taken.
 */
const UNKNOWN_CADENCE_MS = 24 * 60 * 60 * 1000

/** Where the data being returned came from. */
export type AccelSource =
  /** A stored run of the scheduled search. */
  | 'schedule'
  /** The panel's own query, run now. */
  | 'live'
  /**
   * Nowhere. The viewer asked for a past moment this entry has no run for, and
   * there is no honest substitute: the live query would answer about NOW under a
   * label saying 04:20. A panel handed this renders an empty state that says
   * which times it does have. See `asOf`.
   */
  | 'none'

/**
 * Which of a saved search's two identifiers the `jobName=` predicate answered
 * on. See V-23 in the header: this app does not know which one the platform
 * binds to, so it finds out by asking.
 */
export type AccelReadKey = 'id' | 'name'

/** Id first, always: it is what the plan specified and what the code everywhere
 *  else keys on, so a session that pays for the fallback pays once. */
const KEY_ORDER: readonly AccelReadKey[] = ['id', 'name']

/**
 * Which key answered, per entry, for this session.
 *
 * ONLY A SUCCESS IS REMEMBERED. Both keys coming back empty is not evidence
 * about the binding — it is a schedule that has not produced a readable run —
 * and memoising it as one would mean the panel never notices the first run when
 * it arrives, which is the state every newly applied schedule starts in. So a
 * miss teaches this map nothing and the next read asks both keys again; the map
 * only ever shortens the work after something has actually been read.
 *
 * Module-level and per session on purpose. The binding is a property of the
 * platform, not of an install, so it cannot go stale under a running tab; and
 * keeping it out of the KV store keeps a measurement the app made for itself
 * out of a document a customer's admin would have to reason about.
 */
const KEY_MEMO = new Map<AccelId, AccelReadKey>()

/** Tests, and anything that wants the next read to re-measure. */
export function resetAccelKeyMemo(): void {
  KEY_MEMO.clear()
}

/**
 * The answer to V-23 as far as this session has seen it, or null before any
 * stored result has been read.
 *
 * Disagreement between entries answers null rather than a guess: if the id
 * selected one entry's run and the display name selected the other's, the thing
 * this function exists to report — "the predicate binds to X" — is not true, and
 * the per-read `key` is the only honest answer left. Nobody has observed that;
 * it is null-on-disagreement precisely so a surface can never report it as a
 * measurement.
 */
export function observedKeyBinding(): AccelReadKey | null {
  const seen = new Set(KEY_MEMO.values())
  return seen.size === 1 ? [...seen][0] : null
}

/**
 * How a status surface may say what the binding turned out to be.
 *
 * Written here, beside the thing that measured it, and phrased for the admin
 * reading Guided Setup's acceleration table — the audience that can act on it.
 * A panel's ⓘ has no use for this: it changes nothing about where the number
 * came from or when it was produced.
 */
export const KEY_BINDING_NOTES: Readonly<Record<AccelReadKey, string>> = Object.freeze({
  id: 'Stored results are selected by each scheduled search’s id.',
  name: 'Stored results are selected by each scheduled search’s display name rather than its id.',
})

/**
 * Why the read ended up where it did. Everything except `fresh` and `stale`
 * means the live query ran.
 */
export type AccelOutcome =
  /** Read from the schedule, dated, and within STALE_FACTOR cadences. */
  | 'fresh'
  /** Read from the schedule and dated, but older than the schedule promises.
   *  Returned rather than replaced — see the header. */
  | 'stale'
  /** Rows came back and this app cannot say when they were produced. */
  | 'undated'
  /** The history lists no run: just created, or it has never fired. */
  | 'no-run'
  /** The newest run is still going. A running job's results are not readable. */
  | 'run-pending'
  /** The newest run failed or was cancelled. */
  | 'run-failed'
  /** Runs exist and none is readable: `keepLastN` has aged them out, or the run
   *  stored no rows. */
  | 'aged-out'
  /** The fast read itself failed. The detail is in the console, never here. */
  | 'unreadable'
  /** Acceleration is switched off for this entry. */
  | 'off'
  /** The saved search's schedule is off — Pause, or a tab or master switch in
   *  Guided Setup. Its old runs are still readable for days; they are not read,
   *  because the confirmation that paused it said these panels go live. */
  | 'paused'
  /** The saved search runs a different query or window than the one this
   *  panel's ⓘ shows (a release changed the body and nobody has re-applied).
   *  Its runs are not read: the ⓘ must describe the query the number came from. */
  | 'drifted'
  /** No saved search serves this entry any more, or one with no schedule. */
  | 'unscheduled'
  /** A past moment was asked for on a drifted entry. Every stored run there came
   *  from the older query, and a moment never falls back to live — so nothing. */
  | 'drifted-at'
  /** The newest run began before this install last rewrote the query the saved
   *  search runs (`appliedAt`): it answered the OLDER query, so it is not read
   *  and the live query runs until a run of the new one exists. */
  | 'reapplied'
  /** A past moment was asked for and the run from then began before that
   *  write. It answered the older query, and a moment never falls back to live. */
  | 'reapplied-at'
  /** A past moment was asked for and this entry has no run at or before it. The
   *  live query deliberately did NOT run — see AccelSource's `none`. */
  | 'no-run-at'
  /** A past moment was asked for, a run exists, and this panel's rows have to be
   *  cut out of a SHARED scan by a tail that cannot be evaluated here with
   *  certainty — outside tail.ts's grammar, or re-aggregating over a result
   *  that was not read whole. The panel is shown nothing rather than the whole
   *  scan's rows, or a total over part of them. */
  | 'unshaped'

/**
 * One sentence per outcome, for a caller to render.
 *
 * WRITTEN HERE, NOT BUILT FROM A RESPONSE. This is the whole of what a customer
 * may be told about a failed fast read; the API's own words go to the console.
 * They are phrased to be true whether or not the reader knows this feature
 * exists — "the live query ran" is a fact about their number, not an apology for
 * a mechanism they never asked about.
 */
export const NOTES: Readonly<Record<AccelOutcome, string>> = Object.freeze({
  fresh: 'From the scheduled run.',
  stale: 'From the scheduled run, which is older than its schedule promises — check the schedule in Guided Setup.',
  undated: 'The scheduled run could not be dated, so the live query ran instead.',
  'no-run': 'The schedule has not produced a result yet, so the live query ran.',
  'run-pending': 'The scheduled run is still going, so the live query ran.',
  'run-failed': 'The last scheduled run did not finish, so the live query ran.',
  'aged-out': 'No stored result is still available, so the live query ran.',
  unreadable: 'The stored result could not be read, so the live query ran.',
  off: 'Acceleration is off for this panel, so the live query ran.',
  paused: 'The scheduled search that serves this panel is paused, so the live query ran.',
  drifted:
    'The scheduled search that serves this panel still runs an older query than the one shown here, so the live query ran. Re-apply acceleration in Guided Setup to schedule this one.',
  unscheduled: 'No scheduled search serves this panel now, so the live query ran.',
  'drifted-at':
    'The stored runs for this panel came from an older query than the one shown here, so none is shown. Re-apply acceleration in Guided Setup, or switch to Live.',
  reapplied:
    'The scheduled search that serves this panel was changed to the query shown here and has not run it yet, so the live query ran.',
  'reapplied-at':
    'The stored run from that time came from the query this panel used before acceleration was re-applied, so it is not shown.',
  'no-run-at':
    'This panel has no stored run from the time you picked. Running its query now would answer about the present under a label saying otherwise, so it did not run.',
  unshaped:
    'This panel shares one scan with others, and its share could not be cut out of the stored result from that time with certainty. Pick the newest snapshot, or switch to Live, to see this number.',
})

export interface AccelRead<T> {
  data: T
  source: AccelSource
  outcome: AccelOutcome
  /** The run the data came from — null on every live fallback. */
  run: AccelRun | null
  /** Epoch ms the run's result came into existence. What a panel dates itself
   *  by; null on every live fallback. */
  at: number | null
  /** How old that result was when this read happened. */
  ageMs: number | null
  /** The age at which this entry's result is called stale. */
  staleAfterMs: number
  /** `outcome === 'stale'`, hoisted because it is the one a panel branches on. */
  stale: boolean
  /**
   * Which identifier the `jobName=` predicate answered on — null on every live
   * fallback, because nothing answered.
   *
   * `'name'` is not a degraded read: the rows are the same rows. It is EVIDENCE,
   * and the only kind this app can collect for V-23 without running A-SP1 —
   * which is why it is on the return value rather than in a log line.
   */
  key: AccelReadKey | null
  /** A sentence to render. Never contains Cribl's words — see NOTES. */
  note: string
  /**
   * The readable run closest to the moment that was asked for, when the answer
   * was `no-run-at`.
   *
   * What the panel offers instead — "nothing at 04:20; the nearest is 05:20".
   * Null everywhere else, including on a successful `asOf` read, because there
   * the run that answered IS the nearest and `at` already carries it.
   */
  nearestAt: number | null
}

export interface AccelReadOptions<T> {
  /**
   * Run the original query. Defaults to the manifest's own body over its own
   * window, which is exactly what the panel used to do on the Lake-total entry.
   *
   * Field Explorer passes its own, because the live panel reads the GLOBAL time
   * range while the scheduled entry deliberately reads a settled two minutes —
   * so falling back to the manifest's window there would quietly change what the
   * live panel means.
   */
  live?: () => Promise<T>
  /** False sends every read straight to the live query. The customer's off
   *  switch lives in accel/store.ts; this is where its answer is honoured. */
  enabled?: boolean
  /**
   * What the saved search itself says about this entry (accel/serving.ts).
   * `paused`, `drifted` and `unscheduled` send the newest-run read live, each
   * with its own sentence; a past moment on a `drifted` entry shows nothing.
   * Omitted, or `scheduled`/`unknown`, reads exactly as before — a verdict
   * nobody could read must not move a panel's bill.
   */
  serving?: ServingVerdict
  /**
   * When this install last wrote the query the saved search runs
   * (accel/store.ts `bodyAt`, via accel/serving.ts), or null/omitted when
   * nothing records it. A run that BEGAN before it answered the older query:
   * the newest-run read falls back to live (`reapplied`), a moment shows
   * nothing (`reapplied-at`). Verifier, 2026-09-24, defect 3.
   */
  appliedAt?: number | null
  /** KQL appended after the `jobName` predicate. */
  tail?: string
  signal?: AbortSignal
  costSlot?: CostSlot
  limit?: number
  /** Override the staleness window. Tests, and a caller that knows better. */
  staleAfterMs?: number
  /** Epoch ms to age the run against. Tests only. */
  now?: number
  /**
   * Read the state as it was at this moment, rather than the newest one.
   *
   * THE ONE RULE THAT MAKES THIS SAFE: **a read at a past moment never falls
   * back to the live query.** Every other failure in this module falls back,
   * because the live query answers the same question at the old price. That
   * stops being true the instant a moment is named. The live query answers about
   * NOW; the panel would be labelled 04:20; and a viewer comparing two tabs
   * would be comparing this afternoon against this morning with nothing on
   * screen to say so. A panel with no run from that moment shows an empty state
   * and `nearestAt`, and the reader decides.
   *
   * It also overrides the off switch — `enabled: false` and a chosen moment are
   * a contradiction, and the moment wins, because "run this one live" has no
   * meaning for a question about the past. The control that sets `enabled:
   * false` is hidden while a past moment is selected; this is the belt to that
   * braces, in the module that knows why.
   *
   * Undefined is the newest run, which is every read Phase 2 ever did and is
   * left byte-for-byte alone below — including the id-then-name fallback that
   * settles V-23.
   */
  asOf?: number
}

/**
 * The query a fast read submits.
 *
 * **NOT A CUSTOMER-VISIBLE STRING.** The panel's ⓘ keeps showing the manifest
 * entry's `display` body, because that body IS what produced the number — on a
 * schedule rather than on demand. This string is the plumbing that fetched it,
 * and putting it in an ⓘ would replace a claim about provenance with a claim
 * about transport. It is exported for tests and for a diagnostics view.
 *
 * The id is re-checked against `isAccelId` even though the type is a closed
 * union: this is the one place in the app where an identifier is interpolated
 * into query TEXT, and a predicate built from an unvalidated string is an
 * injection site regardless of what the types promise today.
 */
export function accelReadQuery(id: AccelId, tail?: string): string {
  if (!isAccelId(id)) throw new Error(`accel read: '${id}' is not an id this app owns`)
  return selectorQuery(id, tail)
}

/**
 * The same query keyed on whichever of the two selectors is being tried.
 *
 * The name is validated against the manifest's own entry rather than against a
 * pattern, and that is the deliberate difference from the id: an id has a shape
 * (`isAccelId`), a human title does not, so the only honest check is "this is
 * the exact string the manifest ships". The quote and backslash refusal is
 * belt-and-braces for the day somebody adds an entry whose title contains one —
 * a name is interpolated into query TEXT, so a title is an injection site the
 * moment it stops being a literal in this repo.
 */
export function accelReadQueryOn(entry: AccelEntry, key: AccelReadKey, tail?: string): string {
  if (key === 'id') return accelReadQuery(entry.id, tail)
  const name = entry.name
  const manifest = accelEntry(entry.id)
  if (!name || name !== manifest.name) {
    throw new Error(`accel read: '${name}' is not the manifest's name for '${entry.id}'`)
  }
  if (/["\\]/.test(name)) throw new Error(`accel read: the name for '${entry.id}' cannot be quoted safely`)
  return selectorQuery(name, tail)
}

function selectorQuery(selector: string, tail?: string): string {
  return withTail(`dataset="${VT_RESULTS}" jobName="${selector}"`, tail)
}

function withTail(head: string, tail?: string): string {
  const t = tail?.trim()
  return t ? `${head} ${t}` : head
}

/**
 * The query that reads ONE named run.
 *
 * `jobId` rather than `jobName`, which is the whole difference between "the
 * newest state" and "the state at 04:20". It takes no part in V-23: a job id is
 * a job id, so the id-then-name fallback above is neither needed nor used here.
 *
 * The id is checked against the shape Cribl's own job ids take before it is
 * interpolated. It arrives from a list read rather than from a literal in this
 * repo, which makes it the one identifier in this app that reaches query TEXT
 * without a human having typed it.
 */
export function accelRunQuery(jobId: string, tail?: string): string {
  assertAddressableJobId(jobId)
  return withTail(`dataset="${VT_RESULTS}" jobId="${jobId}"`, tail)
}

/**
 * NOT A QUERY ANY MORE, and `accelRunQuery` above is kept only for its shape.
 *
 * MEASURED 2026-09-21 against the live workspace: `$vt_results` answers on
 * `jobName="<savedSearchId>"` and returns the NEWEST run only. Every way of
 * naming a SPECIFIC run returns zero rows — `jobId=` or `jobName=`, the
 * `<id>.<epoch>.<rand>` form or the `…scheduled.scheduledSearch_…` form. That
 * settles claim V-23 ("what `jobName=` binds to is not known"): it binds to the
 * saved search, not to a run.
 *
 * So the snapshot picker could never work through `$vt_results`. `keepLastN: 24`
 * retains twenty-four artifacts and that virtual table exposes one of them;
 * choosing any earlier moment asked for a run by id and got nothing back, which
 * is why every panel went blank on a chosen snapshot while "newest" was fine.
 *
 * A stored run is read by its id through `readJobResults` instead, which reads
 * an artifact that already exists and therefore submits no job and bills
 * nothing — cheaper than the `$vt_results` read it replaces, not just able to
 * reach further back.
 */
/**
 * How long one shared artifact read may take. It carries no caller's signal
 * (below), so it carries its own clock — the same reasoning as the run-history
 * read's HISTORY_TIMEOUT_MS. Longer, because the largest artifact measured
 * (the DNS resolver scan, 12,153 rows) is 1.3 MB.
 */
export const ARTIFACT_TIMEOUT_MS = 20_000
/** Distinct runs held, least recently used evicted first. Sixteen entries, a
 *  newest run each, plus room for a viewer scrubbing the snapshot picker. */
export const ARTIFACT_CACHE_MAX = 40

type ArtifactRead = { rows: Row[]; totalEventCount: number }
const artifacts = new Map<string, Promise<ArtifactRead>>()

/** Drop every cached artifact. For tests; a run's artifact never changes. */
export function forgetArtifacts(): void {
  artifacts.clear()
}

/**
 * One run's stored rows, read ONCE however many panels it serves.
 *
 * SAFE TO KEEP BECAUSE IT CANNOT CHANGE. A completed run's artifact is
 * immutable; a newer run is a different id. So the overview run's five panels,
 * Shadow AI's three and DNS's two (1.3 MB each, measured) cost one GET per run,
 * and a refresh that finds the same newest run costs none. Keyed by run id alone
 * and always read whole (FULL_ARTIFACT_LIMIT); a caller's limit is applied after
 * its tail, in `shapeRows`, which is where Search applies it too.
 *
 * NOT CANCELLED BY ONE CALLER. The read is shared, so a panel leaving stops that
 * panel waiting and nothing else — the run-history read's rule. A failure is
 * not cached, so the next caller gets a fresh attempt.
 */
function readArtifact(runId: string, signal?: AbortSignal): Promise<ArtifactRead> {
  let p = artifacts.get(runId)
  if (p !== undefined) {
    // Re-inserted on a hit so Map order is recency order: eviction below then
    // drops the least recently USED run, not the oldest one read — scrubbing the
    // picker must not push out the newest runs every tab is reading.
    artifacts.delete(runId)
    artifacts.set(runId, p)
  } else {
    const clock = new AbortController()
    const timer = setTimeout(() => clock.abort(), ARTIFACT_TIMEOUT_MS)
    p = readJobResults(runId, { limit: FULL_ARTIFACT_LIMIT, signal: clock.signal })
      .catch((err: unknown) => {
        // THE CLOCK'S ABORT IS A FAILURE, NOT A DEPARTURE. It arrives as a
        // DOMException named AbortError, which `aborted()` — rightly, for a
        // caller's own signal — treats as "the panel left, stop". Left as it is,
        // a slow download would make every waiting panel stop with an error
        // instead of falling back. Renamed here, it is an ordinary failure: the
        // newest-run path falls back, a picked moment says `unreadable`.
        if (clock.signal.aborted) throw new Error('accel read: the stored result took too long to read')
        throw err
      })
      .finally(() => clearTimeout(timer))
    artifacts.set(runId, p)
    p.catch(() => {
      if (artifacts.get(runId) === p) artifacts.delete(runId)
    })
    // Oldest first: a Map iterates in insertion order.
    while (artifacts.size > ARTIFACT_CACHE_MAX) artifacts.delete(artifacts.keys().next().value as string)
  }
  return untilAborted(p, signal)
}

/** `p`, or an AbortError the moment `signal` fires — whichever comes first. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/**
 * A panel's rows, cut out of a stored artifact by its tail — or null when that
 * cannot be done with certainty, and the panel must not be shown a guess.
 *
 * COMPLETENESS IS PROVEN, NOT ASSUMED. A re-aggregating tail is evaluated only
 * when the rows read are every row the result holds, by the results header's
 * own count. A missing header parses as 0 (`readJobResults`), and an empty read
 * never reaches here, so a read with no header can never pass as complete.
 *
 * The caller's `limit` is applied AFTER the tail, where Search applies it.
 */
function shapeRows(
  tail: string | undefined,
  read: { rows: Row[]; totalEventCount: number },
  callerLimit: number | undefined,
): Row[] | null {
  const stripped = stripVirtualColumns(read.rows)
  const complete = read.rows.length === read.totalEventCount
  const shaped = tail === undefined ? stripped : evaluateTail(tail, stripped, { complete })
  if (shaped === null) return null
  return callerLimit === undefined ? shaped : shaped.slice(0, callerLimit)
}

function assertAddressableJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(jobId)) throw new Error('accel read: that is not a job id this app can address')
}

/** How old a run of this entry may be before it is stale. */
export function staleAfterMsFor(entry: AccelEntry): number {
  return (cronIntervalMs(entry.cron) ?? UNKNOWN_CADENCE_MS) * STALE_FACTOR
}

/** A row without the three columns `$vt_results` added. A fresh object: the
 *  caller may hold it, and deleting keys from the parsed response in place would
 *  mutate whatever else read the same rows. */
export function stripVirtualColumns(rows: readonly Row[]): Row[] {
  return rows.map((row) => {
    const out: Row = {}
    for (const [k, v] of Object.entries(row)) {
      if (!VIRTUAL_COLUMNS.includes(k)) out[k] = v
    }
    return out
  })
}

/** Read the stored rows of a scheduled run, falling back to the live query. */
export async function readAccelRows(id: AccelId, opts: AccelReadOptions<Row[]> = {}): Promise<AccelRead<Row[]>> {
  const entry = accelEntry(id)
  const live = opts.live ?? (async () => (await liveSearch(entry, opts)).rows)
  // A chosen moment is answered before anything else is considered, INCLUDING
  // the off switch — see `asOf`. Nothing below this line can reach the live
  // query with a moment selected.
  if (opts.asOf !== undefined) {
    // A DRIFTED ENTRY'S STORED RUNS ALL CAME FROM THE OLDER QUERY, and a moment
    // never falls back to live, so there is nothing true to show. A PAUSED
    // entry's past runs are still read: they are what that query answered at
    // that time, and the moment is the reader asking about exactly then.
    if (opts.serving === 'drifted') return absent(entry, 'drifted-at', [], opts, null)
    // A SHARED SCAN'S PANEL IS CUT OUT OF AN ARTIFACT BY ITS TAIL, evaluated
    // here (tail.ts) because an artifact cannot run KQL. A tail outside that
    // grammar would hand the panel the whole scan — another panel's columns
    // under its own label — so it is shown nothing, with a sentence, instead.
    const tail = opts.tail
    if (tail !== undefined && parseTail(tail) === null) {
      return absent(entry, 'unshaped', [], opts, null)
    }
    return atMoment(entry, opts, opts.asOf, [], {
      fromRun: (jobId) => readArtifact(jobId, opts.signal),
      isEmpty: (r) => r.rows.length === 0,
      // `stripVirtualColumns` is a no-op on an artifact, which carries none of
      // them. It stays so that both paths hand a panel the same shape.
      shape: (r) => {
        const data = shapeRows(tail, r, opts.limit)
        return data === null ? null : { data, named: String(r.rows[0]?.[COL_JOB_NAME] ?? '') }
      },
    })
  }
  if (opts.enabled === false) return fallback(entry, 'off', live, opts)
  const unserved = unservedOutcome(opts.serving)
  if (unserved !== null) return fallback(entry, unserved, live, opts)

  // THE FAST PATH: read the newest run's artifact by id, which submits no job.
  // Null means "not this way" — every such case falls through to the
  // `$vt_results` read below, unchanged. See `newestArtifact`.
  const artifact = await newestArtifact(entry, opts)
  if (artifact === 'reapplied') return fallback(entry, 'reapplied', live, opts)
  if (artifact !== null) return notBeforeApply(entry, artifact, live, opts)

  let answered
  try {
    answered = await onAnsweringKey(
      entry,
      opts.tail,
      (query) =>
        runSearch(query, {
          earliest: FAST_EARLIEST,
          latest: FAST_LATEST,
          limit: opts.limit,
          signal: opts.signal,
          timeoutMs: FAST_TIMEOUT_MS,
        }),
      (r) => r.rows.length === 0,
    )
  } catch (err) {
    if (aborted(err, opts.signal)) throw err
    warn(id, 'the stored-result read failed', err)
    return fallback(entry, 'unreadable', live, opts)
  }

  if (!answered) return fallback(entry, await diagnose(id, opts), live, opts)
  const { result, key } = answered

  const named = String(result.rows[0][COL_JOB_NAME] ?? '')
  if (named && !namesThisEntry(entry, named)) {
    // Never observed; asserted anyway. If the predicate were ever ignored, a
    // panel would render another schedule's numbers with this one's ⓘ beside
    // them, which is the one thing this phase promised could not happen.
    warn(id, `the stored result named a different schedule ('${named}')`, null)
    return fallback(entry, 'unreadable', live, opts)
  }

  const sourceJobId = str(result.rows[0][COL_JOB_ID])
  return notBeforeApply(entry, await dated(entry, stripVirtualColumns(result.rows), sourceJobId, key, live, opts), live, opts)
}

/**
 * Read per-field summaries from a scheduled run's stored rows.
 *
 * The newest run's artifact is summarised here, in the browser, with no job
 * submitted (`newestArtifactSummaries`). When that cannot answer, the
 * summaries are computed over the fast read's own job — Cribl summarises
 * whatever that job returned, which is the stored sample. Either way the
 * figures are the ones the scheduled body produced, one hour old at most rather
 * than 754.9 CPU-s ago.
 */
export async function readAccelFieldSummaries(
  id: AccelId,
  opts: AccelReadOptions<FieldSummariesResult> = {},
): Promise<AccelRead<FieldSummariesResult>> {
  const entry = accelEntry(id)
  const live = opts.live ?? (() => liveFieldSummaries(entry, opts))
  if (opts.asOf !== undefined) {
    if (opts.serving === 'drifted') return absent(entry, 'drifted-at', { fields: [], sampled: 0 }, opts, null)
    return atMoment(entry, opts, opts.asOf, { fields: [], sampled: 0 }, {
      // A scheduled run's artifact is ROWS, and no query names it, so
      // `/field-summaries` cannot be pointed at one. The summaries are computed
      // from the artifact instead, to the same shape the endpoint returns.
      fromRun: async (jobId) =>
        summariseRows((await readJobResults(jobId, { limit: ARTIFACT_LIMIT, signal: opts.signal })).rows),
      isEmpty: (r) => r.fields.length === 0,
      shape: (r) => ({
        data: { fields: r.fields.filter((f) => !VIRTUAL_COLUMNS.includes(f.name)), sampled: r.sampled },
        // A summarised read has no single row to name the schedule; the virtual
        // column's own summary carries it, and its one top value is the answer.
        named: String(r.fields.find((f) => f.name === COL_JOB_NAME)?.topValues?.[0]?.value ?? ''),
      }),
    })
  }
  if (opts.enabled === false) return fallback(entry, 'off', live, opts)
  const unserved = unservedOutcome(opts.serving)
  if (unserved !== null) return fallback(entry, unserved, live, opts)

  // THE FAST PATH, as on the rows path: summarise the newest run's artifact,
  // which submits no job. Null falls through to the job below, unchanged. See
  // `newestArtifactSummaries`.
  const artifact = await newestArtifactSummaries(entry, opts)
  if (artifact === 'reapplied') return fallback(entry, 'reapplied', live, opts)
  if (artifact !== null) return notBeforeApply(entry, artifact, live, opts)

  let answered
  try {
    answered = await onAnsweringKey(
      entry,
      opts.tail,
      (query) =>
        runFieldSummaries(query, {
          earliest: FAST_EARLIEST,
          latest: FAST_LATEST,
          signal: opts.signal,
          timeoutMs: FAST_TIMEOUT_MS,
        }),
      (r) => r.fields.length === 0,
    )
  } catch (err) {
    if (aborted(err, opts.signal)) throw err
    warn(id, 'the stored-result field summaries failed', err)
    return fallback(entry, 'unreadable', live, opts)
  }

  if (!answered) return fallback(entry, await diagnose(id, opts), live, opts)
  const { result, key } = answered

  // The run id, read off the virtual column's own summary before it is dropped.
  // Every row of a stored result carries the same `jobId`, so its one top value
  // names the run — which is a more precise answer than "the newest run", and it
  // is the run this data actually came from.
  const jobIdField = result.fields.find((f) => f.name === COL_JOB_ID)
  const sourceJobId = str(jobIdField?.topValues?.[0]?.value)

  const data: FieldSummariesResult = {
    fields: result.fields.filter((f) => !VIRTUAL_COLUMNS.includes(f.name)),
    // `sampled` is kept from the UNFILTERED result on purpose. search.ts derives
    // it as the widest field's count + nulls, and the virtual columns are the
    // only fields present on every single row — so recomputing it after the
    // filter would under-report the sample size by however many rows lack the
    // widest real field.
    sampled: result.sampled,
  }
  return notBeforeApply(entry, await dated(entry, data, sourceJobId, key, live, opts), live, opts)
}

// ── The newest run, read as an artifact ─────────────────────────────────────

/**
 * The newest stored result, read by run id — NO JOB SUBMITTED.
 *
 * WHY THIS IS THE LARGEST LATENCY WIN IN THE APP. The `$vt_results` read below
 * it is a submitted search job: a POST, a poll ladder, a results GET — and a
 * place in the per-user admission queue, where concurrent jobs are admitted
 * ~1.6 s apart. Acceleration cut that read to 0.2 billable CPU-s and removed no
 * queue position at all, which is why an accelerated tab still waited
 * (N-1) x 1.6 s before its last panel began. An artifact read is ONE plain GET
 * on a result that already exists. It takes no admission slot, polls nothing,
 * and bills nothing. The `asOf` path has read this way since 2026-09-21; this
 * extends the same read to the newest run.
 *
 * ONLY FOR PANELS AN ARTIFACT CAN SHAPE. No tail, or a tail inside tail.ts's
 * grammar. A tail that re-aggregates — `summarize`, `sort | limit` — is KQL over
 * the whole stored set, so it is evaluated only over a read the results header
 * proves complete (`shapeRows`); over a truncated one it would be a wrong total
 * or the wrong top N. Anything else keeps the query path, where Cribl evaluates
 * the tail over every stored row.
 *
 * AN OPTIMISATION, NEVER A NEW WAY TO FAIL. Every case this path does not handle
 * — no readable run in the history page (which is capped, so an old daily run
 * may not appear), the list unreadable, a run id that does not belong to this
 * entry, an empty artifact, a read error — returns null, and the caller carries
 * on down the `$vt_results` path exactly as it did before. Only an abort
 * escapes, because a departed panel should stop, not fall back.
 *
 * DATED BY THE RUN IT READ. The history row carries the run's own completion
 * time, so there is no `runMeta` round trip: the run that dates the result is
 * the run the result came from, by construction rather than by a second lookup.
 *
 * COUNTED IN THE HEADER SPINNER. `runSearch` increments the in-flight counter
 * itself; a plain GET does not, and without `beginQuery` here the spinner would
 * go quiet on the default path while panels were still loading.
 *
 * NEVER HIDES A FAILED RUN. When the newest run failed or was cancelled this
 * path steps aside, so the query path reports `run-failed` exactly as before.
 * When the newest is still running it serves the run before it — dated by that
 * run, so the label says how old it is.
 *
 * FRESH ON A HUMAN REFRESH. The history page is cached for 15 s; the refresh
 * control, a panel's own refresh and Re-check drop it (`forgetRunHistory`), so
 * the newest run is the newest one at the moment somebody asked.
 */
async function newestArtifact(entry: AccelEntry, opts: AccelReadOptions<Row[]>): Promise<AccelRead<Row[]> | 'reapplied' | null> {
  const tail = opts.tail
  if (tail !== undefined && parseTail(tail) === null) return null
  return spinning(async () => {
    const found = await newestRunArtifact(entry, opts)
    if (found === null || found === 'reapplied') return found
    const data = shapeRows(tail, found.read, opts.limit)
    return data === null ? null : servedBy(entry, data, found.run, opts)
  })
}

/**
 * Field Explorer's newest sample, summarised from the run's artifact — NO JOB.
 *
 * The same read as `newestArtifact`, and the same summary the picked-moment
 * path has always computed (`summariseRows`): `/field-summaries` can only be
 * pointed at a job, so the query path SUBMITS one over `$vt_results` only to be
 * handed back a summary of rows that already exist. That job was the last
 * queue position an accelerated panel still took when a tab opened
 * (src/tabs/tabJobBudget.test.tsx).
 *
 * ONE CONDITION THE ROWS PATH DOES NOT HAVE: the read must be WHOLE, whatever
 * the tail. A summary is an aggregate over every stored row — `sampled`, each
 * field's count and null count — so a truncated read would be a smaller sample
 * reported as the sample. The results header proves completeness, as it does
 * for a re-aggregating tail in `shapeRows`; anything less keeps the job.
 *
 * Every other case — no readable run, an unreadable artifact, an empty one —
 * returns null and the caller carries on down the job path, unchanged. Only an
 * abort escapes.
 */
async function newestArtifactSummaries(
  entry: AccelEntry,
  opts: AccelReadOptions<FieldSummariesResult>,
): Promise<AccelRead<FieldSummariesResult> | 'reapplied' | null> {
  const tail = opts.tail
  if (tail !== undefined && parseTail(tail) === null) return null
  return spinning(async () => {
    const found = await newestRunArtifact(entry, opts)
    if (found === null || found === 'reapplied') return found
    if (found.read.rows.length !== found.read.totalEventCount) return null
    const rows = shapeRows(tail, found.read, undefined)
    if (rows === null || rows.length === 0) return null
    // `shapeRows` has already dropped any virtual column, so the summary lists
    // only the body's own fields and `sampled` is the stored sample's size.
    const summary = summariseRows(rows)
    // Cut to what the endpoint would have answered: the panel says "top 200
    // (field-summaries cap)", and a browser-side summary has no cap of its own.
    // `summariseRows` sorts by fill, so the first 200 ARE the top 200.
    return servedBy(entry, { ...summary, fields: summary.fields.slice(0, FIELD_SUMMARIES_CAP) }, found.run, opts)
  })
}

/** One span of the header spinner over the whole read, the history wait
 *  included. `runSearch` counts itself; a plain GET does not, and without this
 *  the spinner would go quiet on the default path while panels were loading. */
async function spinning<T>(read: () => Promise<T>): Promise<T> {
  beginQuery()
  try {
    return await read()
  } finally {
    endQuery()
  }
}

/** A result served from `run`'s artifact, dated by that run. */
function servedBy<T>(entry: AccelEntry, data: T, run: AccelRun & { at: number }, opts: AccelReadOptions<T>): AccelRead<T> {
  const staleAfterMs = opts.staleAfterMs ?? staleAfterMsFor(entry)
  const ageMs = (opts.now ?? Date.now()) - run.at
  const outcome: AccelOutcome = ageMs > staleAfterMs ? 'stale' : 'fresh'
  return {
    data,
    source: 'schedule',
    outcome,
    run,
    at: run.at,
    ageMs,
    staleAfterMs,
    stale: outcome === 'stale',
    // A run id answered, which is not evidence about what `jobName=` binds to —
    // the same reason `atMoment` reports null here.
    key: null,
    note: NOTES[outcome],
    nearestAt: null,
  }
}

/**
 * The newest completed run of this entry and its whole artifact, or null when
 * that cannot be had with certainty. Shared by both newest-run artifact reads.
 */
async function newestRunArtifact(
  entry: AccelEntry,
  opts: { signal?: AbortSignal; appliedAt?: number | null },
): Promise<{ run: AccelRun & { at: number }; read: ArtifactRead } | 'reapplied' | null> {
  // The shared history page — one request per page for every entry, so this is
  // usually a cache hit rather than a round trip. UNFILTERED, on purpose: the
  // timeline's view drops failed runs, and the newest run failing is a fact
  // this path must not hide.
  // `newest`: the small head page when it can answer — the read every
  // accelerated panel waits on before its download can start.
  const listed = await listRuns(entry.id, { signal: opts.signal, newest: true })
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (listed.error !== null) return null

  // THE NEWEST RUN FAILED OR WAS CANCELLED: step aside. Serving the run before
  // it, labelled "From the scheduled run.", would bury the one outcome an
  // admin needs to see; the query path and `diagnose` report it as run-failed.
  // A newest run still GOING is different: the run before it is the latest
  // finished answer, dated as such, and serving it beats the live query the
  // query path would fall back to for the minutes the run takes.
  const newest = listed.runs[0]
  if (newest && !newest.running && (newest.outcome === 'failed' || newest.outcome === 'canceled')) return null
  const run = listed.runs.find((r) => !r.running && r.outcome === 'completed' && r.at !== null)
  if (!run || run.at === null) return null
  // A run of the OLDER query is not downloaded only to be refused, and the
  // `$vt_results` path is not asked either: its newest run is this same one.
  if (predatesApply(run, opts.appliedAt)) return 'reapplied'

  // The id is the address, so it is checked before it is used — the same two
  // guards `atMoment` applies. `isRunOf` has already filtered by this entry;
  // the prefix check is the second, independent signal.
  try {
    assertAddressableJobId(run.id)
  } catch {
    return null
  }
  if (!run.id.startsWith(`${entry.id}.`)) {
    warn(entry.id, `the run history offered a run belonging to another schedule ('${run.id}')`, null)
    return null
  }

  let read: ArtifactRead
  try {
    read = await readArtifact(run.id, opts.signal)
  } catch (err) {
    if (aborted(err, opts.signal)) throw err
    return null
  }
  const rows = read.rows
  if (rows.length === 0) return null
  // A row that names its own run and names a DIFFERENT one is a contradiction,
  // not a result: dating it by `run` would be the lie the query path's
  // `dated()` exists to prevent. Refuse it and let that path date by the rows.
  const named = str(rows[0]?.[COL_JOB_ID])
  if (named !== null && named !== run.id) return null

  return { run: { ...run, at: run.at }, read }
}

// ── Reading a chosen past state ─────────────────────────────────────────────

/** What the two entry points differ by, so `atMoment` can be written once. */
interface MomentIo<T, R> {
  /** Read one stored run BY ID. Not by query — see `assertAddressableJobId`. */
  fromRun: (jobId: string) => Promise<R>
  isEmpty: (result: R) => boolean
  /** Null when this panel's share cannot be cut out of the result with
   *  certainty — see `shapeRows`. The panel is then shown nothing: `unshaped`. */
  shape: (result: R) => { data: T; named: string } | null
}

/**
 * A read of one entry at a moment the viewer chose.
 *
 * It is a different shape from the newest-run path and deliberately so:
 *
 *   * IT LISTS FIRST. The newest-run path reads and then dates, because on the
 *     happy path the list is a cost it can avoid. Here the list IS the question
 *     — "which run had finished by 04:20" — so there is nothing to read until it
 *     has been answered, and the run that comes back is already dated.
 *   * IT ADDRESSES A JOB ID. `jobName=` selects a schedule, not a run; with
 *     `keepLastN: 24` that is twenty-four wrong answers and one right one.
 *   * IT NEVER RUNS THE LIVE QUERY. Every branch below ends in stored rows or in
 *     an empty panel that says why. See `asOf`.
 *
 * The `jobName` sanity check is kept, and it earns more here than it does on the
 * newest-run path: there the predicate names the entry, so a mismatch would be
 * the platform ignoring it; here the predicate is an id read out of a list, and
 * the check is what catches this app having listed one schedule and read another.
 */
async function atMoment<T, R>(
  entry: AccelEntry,
  opts: AccelReadOptions<T>,
  asOf: number,
  empty: T,
  io: MomentIo<T, R>,
): Promise<AccelRead<T>> {
  const timeline = await snapshotTimeline([entry.id], { signal: opts.signal })
  const mine = timeline.entries[0]
  if (!mine || mine.error !== null) {
    warn(entry.id, 'the run history could not be read for the moment that was picked', mine?.error ?? null)
    return absent(entry, 'unreadable', empty, opts, null)
  }
  const run = runAtOrBefore(mine, asOf)
  if (!run) return absent(entry, 'no-run-at', empty, opts, nearestRun(mine, asOf)?.at ?? null)
  // THE RUN FROM THEN ANSWERED THE OLDER QUERY (verifier, 2026-09-24, defect
  // 3). Its rows are real, but not rows of the query the ⓘ now shows; offered
  // instead is the first run of the new one, when there is one. Runs are
  // newest first, so that is the last one not predating the write.
  if (predatesApply(run, opts.appliedAt)) {
    const after = mine.runs.filter((r) => !predatesApply(r, opts.appliedAt))
    return absent(entry, 'reapplied-at', empty, opts, after.length ? (after[after.length - 1].at ?? null) : null)
  }

  // The id is the address now, so it is checked before it is used rather than
  // after. `listRuns` filters by this entry already; this is the second signal,
  // and it is stronger than the one it replaces (see the `named` check below).
  assertAddressableJobId(run.id)
  if (!run.id.startsWith(`${entry.id}.`)) {
    warn(entry.id, `the run history offered a run belonging to another schedule ('${run.id}')`, null)
    return absent(entry, 'unreadable', empty, opts, run.at)
  }

  let result
  try {
    result = await io.fromRun(run.id)
  } catch (err) {
    if (aborted(err, opts.signal)) throw err
    warn(entry.id, 'the stored result of the run that was picked could not be read', err)
    return absent(entry, 'unreadable', empty, opts, run.at)
  }
  // Empty is `aged-out` and not `no-run-at`: the run was listed, so it existed;
  // its rows are what has gone. Saying "no snapshot from then" about a run whose
  // result Cribl has reaped would send a reader looking for a schedule fault
  // that is not there.
  if (io.isEmpty(result)) return absent(entry, 'aged-out', empty, opts, run.at)

  // `named` comes from the virtual column `$vt_results` adds, and a raw
  // artifact does not carry it — so on this path it is empty and this check no
  // longer fires. It is KEPT rather than deleted because it costs nothing and
  // would catch a future reader that goes back through the virtual table; the
  // id guard above is what actually protects this path now.
  const shaped = io.shape(result)
  if (shaped === null) return absent(entry, 'unshaped', empty, opts, run.at)
  const { data, named } = shaped
  if (named && !namesThisEntry(entry, named)) {
    warn(entry.id, `the run that was picked stored another schedule's rows ('${named}')`, null)
    return absent(entry, 'unreadable', empty, opts, run.at)
  }

  const staleAfterMs = opts.staleAfterMs ?? staleAfterMsFor(entry)
  return {
    data,
    source: 'schedule',
    // Never `stale`. Staleness is "the newest run is older than the schedule
    // promises", and a viewer who asked for 04:20 is not being shown something
    // overdue — they are being shown what they asked for. Flagging it would put
    // a schedule warning on every panel the moment somebody looked at yesterday.
    outcome: 'fresh',
    run,
    at: run.at,
    ageMs: (opts.now ?? Date.now()) - (run.at as number),
    staleAfterMs,
    stale: false,
    // A job id answered, which is not evidence about what `jobName=` binds to.
    key: null,
    note: NOTES.fresh,
    nearestAt: null,
  }
}

/** No data, no live query, and a sentence saying which. */
function absent<T>(
  entry: AccelEntry,
  outcome: AccelOutcome,
  empty: T,
  opts: AccelReadOptions<T>,
  nearestAt: number | null,
): AccelRead<T> {
  return {
    data: empty,
    source: 'none',
    outcome,
    run: null,
    at: null,
    ageMs: null,
    staleAfterMs: opts.staleAfterMs ?? staleAfterMsFor(entry),
    stale: false,
    key: null,
    note: NOTES[outcome],
    nearestAt,
  }
}

// ── The shared half ─────────────────────────────────────────────────────────

/**
 * Run the stored-result read on each key in turn until one answers, and
 * remember the one that did.
 *
 * "Answers" means rows, not a 200: an empty result is what a wrong key looks
 * like, and it is also what a schedule that has never fired looks like, which is
 * the whole reason both keys have to be asked before `diagnose` is believed.
 *
 * THE SECOND READ IS NOT FREE, AND IT IS NOT EXPENSIVE. 0.2 billable CPU-s, on a
 * path that has already established it has nothing to show and is therefore
 * about to spend a live query — 754.9 CPU-s on the sample entry, 9,297.7 on the
 * Lake total. Once either key has answered for an entry, this asks one.
 *
 * Errors are thrown, not swallowed: a 4xx on the first key is a broken read, not
 * evidence that the key is wrong, and retrying the other one would turn one
 * unreadable read into two.
 */
async function onAnsweringKey<T>(
  entry: AccelEntry,
  tail: string | undefined,
  run: (query: string) => Promise<T>,
  isEmpty: (result: T) => boolean,
): Promise<{ result: T; key: AccelReadKey } | null> {
  const known = KEY_MEMO.get(entry.id)
  for (const key of known ? [known] : KEY_ORDER) {
    const result = await run(accelReadQueryOn(entry, key, tail))
    if (isEmpty(result)) continue
    if (!known) rememberKey(entry.id, key)
    return { result, key }
  }
  // Nothing on either key. Deliberately NOT memoised — see KEY_MEMO.
  return null
}

function rememberKey(id: AccelId, key: AccelReadKey): void {
  KEY_MEMO.set(id, key)
  if (key === 'name') {
    // Once per entry per session, because the memo is what stops it repeating.
    // Logged as well as returned so the answer to V-23 is in a support bundle's
    // console dump, where it will be read by whoever is asking why this app
    // reads a saved search by its title.
    console.info(
      `Gigamon acceleration (${id}): the stored result answered to the schedule’s display name, not its id — ${KEY_BINDING_NOTES.name}`,
    )
  }
}

/**
 * Whether a `jobName` column belongs to this entry — under either identifier.
 *
 * Both are accepted because the predicate that matched and the column that comes
 * back are two separate unknowns: a platform that SELECTS on the display name
 * may still STAMP the id (or the reverse), and treating that mismatch as a
 * corrupt result would fall back to live on every read of a perfectly good one.
 * The claim this check exists to defend is narrower and unchanged — that these
 * rows are not some OTHER schedule's.
 */
function namesThisEntry(entry: AccelEntry, named: string): boolean {
  return named === entry.id || named === entry.name
}

/**
 * Date a result, and decide whether it may be shown.
 *
 * Dating prefers the run the data names over the newest run in the history,
 * because with `keepLastN` above one they can differ — and a result dated by a
 * run it did not come from is the same lie as an undated one, told more
 * convincingly.
 */
async function dated<T>(
  entry: AccelEntry,
  data: T,
  sourceJobId: string | null,
  key: AccelReadKey,
  live: () => Promise<T>,
  opts: AccelReadOptions<T>,
): Promise<AccelRead<T>> {
  const run = await dateRun(entry.id, sourceJobId, opts)
  if (!run || run.at === null) {
    warn(entry.id, 'a stored result came back that this app could not date', null)
    return fallback(entry, 'undated', live, opts)
  }
  const staleAfterMs = opts.staleAfterMs ?? staleAfterMsFor(entry)
  const ageMs = (opts.now ?? Date.now()) - run.at
  const outcome: AccelOutcome = ageMs > staleAfterMs ? 'stale' : 'fresh'
  return {
    data,
    source: 'schedule',
    outcome,
    run,
    at: run.at,
    ageMs,
    staleAfterMs,
    stale: outcome === 'stale',
    key,
    note: NOTES[outcome],
    nearestAt: null,
  }
}

async function dateRun(id: AccelId, sourceJobId: string | null, opts: { signal?: AbortSignal }): Promise<AccelRun | null> {
  if (sourceJobId) {
    const meta = await runMeta(sourceJobId, { signal: opts.signal })
    if (meta.run) return meta.run
  }
  const listed = await listRuns(id, { signal: opts.signal })
  return listed.runs[0] ?? null
}

/**
 * Why an empty fast read was empty.
 *
 * Only ever reached when there is nothing to show, so the extra list read costs a
 * request on a path that is already going to spend a live query's worth of
 * CPU-seconds. Getting it wrong is not dangerous — every answer here falls back
 * to live — but getting it right is what puts "the schedule has never fired" in
 * front of the admin who can fix it instead of "something went wrong".
 */
async function diagnose(id: AccelId, opts: { signal?: AbortSignal }): Promise<AccelOutcome> {
  const listed = await listRuns(id, { signal: opts.signal, newest: true })
  if (listed.error !== null) {
    warn(id, 'the run history could not be read', listed.error)
    return 'no-run'
  }
  const last = listed.runs[0]
  if (!last) return 'no-run'
  if (last.running) return 'run-pending'
  // A FAILED OR CANCELLED RUN IS NOT READ, and the temptation to read it is the
  // reason this is spelled out. Its results ARE reachable, with an
  // `allow_incomplete_results` prefix, and that looks like free resilience. What
  // it actually offers is a PARTIAL result rendered as a whole one: the
  // Lake-total entry is a sum over thirty days of write counters, so a partial
  // sum is a smaller Lake, indistinguishable on screen from data having been
  // deleted; the sample entry answers which of ~319 AMI fields are arriving, so a
  // partial sample says fields are missing that are not. Both are wrong in the
  // one direction a viewer cannot detect. Falling back costs a single live run —
  // the price this panel paid every time before Phase 2 — and is right. It also
  // keeps A-D15 whole: a stored-result read carries no prefixes at all.
  if (last.outcome === 'failed' || last.outcome === 'canceled') return 'run-failed'
  return 'aged-out'
}

/** The outcome a saved-search verdict sends the newest-run read live with, or
 *  null when the stored run may be read. `unknown` is null on purpose: see
 *  accel/serving.ts on why an unreadable list must not move anybody's bill. */
function unservedOutcome(serving: ServingVerdict | undefined): AccelOutcome | null {
  if (serving === 'paused' || serving === 'drifted' || serving === 'unscheduled') return serving
  return null
}

/**
 * What a verdict makes a read DO — the only part of it a caller should re-run
 * on. Null means "read the stored run as if there were no verdict".
 *
 * Verifier, 2026-09-24, defect 1: `useSearch` and Field Explorer keyed their
 * effects on the raw verdict, so `unknown` → `scheduled` (a boot read that
 * missed the hold's deadline; Field Explorer, which does not hold; a Refresh
 * whose list read failed, the other way) re-ran every panel for a change that
 * altered nothing it does — and a re-run of a panel that had fallen back live
 * is a second billed live job. A moment only ever acts on `drifted`; the
 * newest-run read acts on the three `unservedOutcome` names, each of which is
 * its own caption, so a change between two of them still re-runs to say so.
 */
export function servingEffect(serving: ServingVerdict | undefined, atMoment: boolean): AccelOutcome | null {
  if (atMoment) return serving === 'drifted' ? 'drifted-at' : null
  return unservedOutcome(serving)
}

/**
 * When a run BEGAN — the moment the saved search's query was taken for it. A
 * run created before a PATCH ran the query from before it, however late it
 * finished, so creation comes first and completion (`at`) last.
 */
export function runBegan(run: AccelRun): number | null {
  return run.createdAt ?? run.startedAt ?? run.at
}

/** Whether a run answered a query this install has since rewritten. False when
 *  nothing records a write: an older record bounds nothing, as before. */
function predatesApply(run: AccelRun | null, appliedAt: number | null | undefined): boolean {
  if (run === null || appliedAt === null || appliedAt === undefined) return false
  const began = runBegan(run)
  return began !== null && began < appliedAt
}

/** A stored-run answer, unless its run predates the recorded write — then live. */
async function notBeforeApply<T>(
  entry: AccelEntry,
  read: AccelRead<T>,
  live: () => Promise<T>,
  opts: AccelReadOptions<T>,
): Promise<AccelRead<T>> {
  if (read.source !== 'schedule' || !predatesApply(read.run, opts.appliedAt)) return read
  return fallback(entry, 'reapplied', live, opts)
}

async function fallback<T>(
  entry: AccelEntry,
  outcome: AccelOutcome,
  live: () => Promise<T>,
  opts: AccelReadOptions<T>,
): Promise<AccelRead<T>> {
  return {
    // Deliberately NOT caught. A live query that fails is a panel that has no
    // number, which is <QueryBoundary>'s job to render — and swallowing it here
    // would turn "Cribl is down" into an empty chart with a reassuring note.
    data: await live(),
    source: 'live',
    outcome,
    run: null,
    at: null,
    ageMs: null,
    staleAfterMs: opts.staleAfterMs ?? staleAfterMsFor(entry),
    stale: false,
    // Nothing answered, so there is nothing to report a key for. A live read is
    // not evidence about the binding in either direction.
    key: null,
    note: NOTES[outcome],
    nearestAt: null,
  }
}

/**
 * The live query, as the manifest describes it: same body, same window.
 *
 * NO `reuse` HERE, AND IT IS A DECISION RATHER THAN AN OVERSIGHT — a handoff
 * from the speed work left it open ("worth a follow-up when the toggle lands"),
 * and this is the follow-up.
 *
 * `search.ts#REUSE_WINDOW` is opt-in for one reason: a caller that submits a job
 * to MEASURE something must get a real run, and defaulting it on would change
 * what such a call means without anybody editing it. This function is the
 * DEFAULT `live` — it answers only for callers that passed none. Every caller
 * today passes its own (`useSearch` builds a closure; FieldExplorer builds one
 * for field summaries), so turning reuse on here would change nothing that runs
 * and would sit waiting for the next caller, which is as likely to be a probe as
 * a panel. The opt-in belongs at the call site that knows which it is.
 *
 * A-D15 is not the reason: `withExecPrefix` refuses reuse on any query naming
 * `$vt_results` in the prefix builder itself, and `entry.body` is a real query.
 */
function liveSearch(entry: AccelEntry, opts: AccelReadOptions<Row[]>) {
  return runSearch(entry.body, {
    earliest: entry.earliest,
    latest: entry.latest,
    limit: opts.limit,
    signal: opts.signal,
    costSlot: opts.costSlot,
  })
}

function liveFieldSummaries(entry: AccelEntry, opts: AccelReadOptions<FieldSummariesResult>) {
  return runFieldSummaries(entry.body, {
    earliest: entry.earliest,
    latest: entry.latest,
    signal: opts.signal,
    costSlot: opts.costSlot,
  })
}

/** An abandoned search is not a failed one: re-throw so useSearch's request-id
 *  guard drops it, rather than spending a live query on a panel that has gone. */
function aborted(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === 'AbortError')
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The console is where the detail goes, and the only place. See the header. */
function warn(id: AccelId, what: string, detail: unknown): void {
  console.warn(`Gigamon acceleration (${id}): ${what} — falling back to the live query.`, detail ?? '')
}
