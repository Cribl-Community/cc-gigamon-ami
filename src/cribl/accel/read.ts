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
//     `jobId` predicate errors.
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

import { runFieldSummaries, runSearch, type FieldSummariesResult, type Row } from '../search'
import type { CostSlot } from '../jobCost'
import { accelEntry, isAccelId, type AccelEntry, type AccelId } from './manifest'
import { cronIntervalMs, listRuns, runMeta, type AccelRun } from './status'

/** The virtual table a stored result is read from. Named in query text only. */
export const VT_RESULTS = '$vt_results'

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
export type AccelSource = 'schedule' | 'live'

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
  /** KQL appended after the `jobName` predicate. */
  tail?: string
  signal?: AbortSignal
  costSlot?: CostSlot
  limit?: number
  /** Override the staleness window. Tests, and a caller that knows better. */
  staleAfterMs?: number
  /** Epoch ms to age the run against. Tests only. */
  now?: number
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
  const head = `dataset="${VT_RESULTS}" jobName="${selector}"`
  const t = tail?.trim()
  return t ? `${head} ${t}` : head
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
  if (opts.enabled === false) return fallback(entry, 'off', live, opts)

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
  return dated(entry, stripVirtualColumns(result.rows), sourceJobId, key, live, opts)
}

/**
 * Read per-field summaries from a scheduled run's stored rows.
 *
 * The summaries are computed over the fast read's own job — Cribl summarises
 * whatever that job returned, which is the stored sample — so the figures are the
 * ones the scheduled body produced, one hour old at most rather than 754.9 CPU-s
 * ago.
 */
export async function readAccelFieldSummaries(
  id: AccelId,
  opts: AccelReadOptions<FieldSummariesResult> = {},
): Promise<AccelRead<FieldSummariesResult>> {
  const entry = accelEntry(id)
  const live = opts.live ?? (() => liveFieldSummaries(entry, opts))
  if (opts.enabled === false) return fallback(entry, 'off', live, opts)

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
  return dated(entry, data, sourceJobId, key, live, opts)
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
  const listed = await listRuns(id, { signal: opts.signal })
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
  }
}

/** The live query, as the manifest describes it: same body, same window. */
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
