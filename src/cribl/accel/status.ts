// Whether a scheduled search is really running, when it last ran, and what that
// run billed.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A WHOLE MODULE FOR "DID IT RUN".
//
// Phase 2 moves two numbers off a live query and onto a cron. The saving is real
// and so is the new failure mode: a schedule can stop firing and nothing about
// the panel changes. It keeps rendering the last stored run, which is a number,
// which looks like an answer. A-SP23 measured the specific way that happens —
// a PATCH that omits `schedule` returns 200 and deletes it, silently unscheduling
// the search forever — so "it was scheduled when we created it" is not evidence
// that it is scheduled now.
//
// This module is the evidence. It answers four questions from the job history,
// and the read path (accel/read.ts) and the Guided Setup status table both ask
// them: when did it last run, did that run succeed, what did it bill, and is it
// still running at the cadence the manifest asked for.
//
// ── IT NEVER THROWS ─────────────────────────────────────────────────────────
// Every caller renders the answer, including the failures: a status table that
// can throw is a status table that takes the tab down with it. `error` is part of
// the state, and — the jobWatchdog lesson, restated because it is the same trap —
// **`error` must be read before `runs.length`**. A refusal, a correlationId that
// matched nothing, and a schedule that has genuinely never fired all produce zero
// rows, and only `error` separates the first from the other two.
//
// ── WHAT IT COSTS ───────────────────────────────────────────────────────────
// `GET /search/jobs` is a config-plane read: it submits no search, bills no
// CPU-seconds, and consumes no slot in the workspace's 1,000-job history
// (measured for the watchdog: 0.27–0.47 s, 61 bytes when nothing matches). The
// metrics read is the same. So this module costs requests, not credits — which is
// what makes it affordable on the read path as well as in the status table.
//
// ── WHAT IS NOT PROVEN HERE ─────────────────────────────────────────────────
// That a scheduled run's `correlationId` IS the saved search's id. It is the
// documented way to ask for one search's runs and it is what the plan specifies,
// but constraint 8 forbids creating a real saved search to check, so no run of
// ours has ever been listed. **The failure direction is safe and deliberate**: a
// correlationId that matches nothing returns zero rows, which this module reports
// as "never run", which accel/read.ts turns into a live query. Wrong, that costs
// money and says so loudly in the status table. It can never show a stale number
// as a fresh one, because the number it would have dated is the one it refuses to
// use. Verify it on the first real Apply in Preview.
// ─────────────────────────────────────────────────────────────────────────────

import { capi, errText } from '../capi'
import { MANIFEST, accelEntry, type AccelId } from './manifest'

/**
 * The job list, as a policy object.
 *
 * A LITERAL, and copied rather than imported, for the same reason
 * cribl/jobWatchdog.ts spells it out: policyCoverage.test.ts resolves call-site
 * paths by reading the source text, and it can only read a string constant
 * declared in the file that uses it. Interpolating `SEARCH_GROUP` here would
 * resolve to a placeholder segment, which declares a grant in EVERY worker group
 * instead of the one search runs in. status.test.ts pins this back to both
 * `SEARCH_GROUP` and jobWatchdog's copy, so the three cannot drift.
 */
export const JOBS_PATH = '/m/default_search/search/jobs'

/**
 * How many past runs one history read asks for.
 *
 * It was twenty, and twenty was chosen when only the newest run fed a panel: it
 * was about having enough consecutive rows to measure a cadence against the cron
 * that was asked for. That is no longer the only reader. The snapshot picker
 * lists every RETAINED run so a viewer can move between past states, and the
 * hourly entries retain twenty-four — so a twenty-row page would have silently
 * hidden the oldest four, leaving a timeline that claims to be a day and is not,
 * with nothing on screen to say which end was cut.
 *
 * Thirty-two: the largest `keepLastN` in the manifest, with room for a schedule
 * that has been re-applied and has runs under an older retention still listed.
 * It is one request either way — this endpoint bills nothing.
 */
export const HISTORY_LIMIT = 200

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// ── What the cron asked for ─────────────────────────────────────────────────

/** A field that is a single number: `7`, `0`. A list or a range is not one. */
function isFixed(field: string): boolean {
  return field.length > 0 && field.length <= 2 && /^[0-9]+$/.test(field)
}

/** The `n` of a `*` `/n` step field, or null when the field is not one. */
function step(field: string): number | null {
  if (!field.startsWith('*/')) return null
  const n = Number(field.slice(2))
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * How often a five-field cron fires, in milliseconds — or null when this app
 * cannot say.
 *
 * DELIBERATELY NOT A CRON LIBRARY. It reads the handful of shapes the manifest
 * uses and answers null for everything else, because the two things that consume
 * this number both fail badly on a wrong one: staleness would call a healthy run
 * stale (and put a warning on a correct number), and the saving estimate would
 * multiply a per-run cost by a runs-per-day nobody measured. Null is a state both
 * callers already have to handle — "the app cannot say" — so there is no reason
 * to guess, and a real parser would make guessing the default.
 *
 * Anything narrower than every day (a day-of-month, a month, a weekday) answers
 * null rather than a number: those fire less often than daily by an amount that
 * depends on the calendar, and a cadence that is wrong in the "fires less often
 * than I thought" direction is exactly what produces a false stale warning.
 */
export function cronIntervalMs(cron: string): number | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null

  const minuteStep = step(minute)
  if (minuteStep !== null) return hour === '*' ? minuteStep * MINUTE_MS : null
  if (minute === '*') return hour === '*' ? MINUTE_MS : null
  if (!isFixed(minute)) return null

  if (hour === '*') return HOUR_MS
  const hourStep = step(hour)
  if (hourStep !== null) return hourStep * HOUR_MS
  return isFixed(hour) ? DAY_MS : null
}

// ── One run ─────────────────────────────────────────────────────────────────

/**
 * What Cribl said about a run, narrowed to the four outcomes a caller acts on.
 *
 * `canceled` is spelled with one `l` because that is the value the API returns
 * (cribl/search.ts matches the same string); `unknown` covers a status this
 * release has not seen, and is deliberately NOT folded into `failed` — a run in a
 * state we do not recognise has not been shown to have failed.
 */
export type RunOutcome = 'completed' | 'failed' | 'canceled' | 'running' | 'unknown'

const TERMINAL: readonly RunOutcome[] = ['completed', 'failed', 'canceled']

export interface AccelRun {
  id: string
  outcome: RunOutcome
  /** Still going: its results are not readable yet, and its cost reads 0. */
  running: boolean
  /** Epoch ms the run was created (the cron firing), or null. */
  createdAt: number | null
  /** Epoch ms it began executing, or null. */
  startedAt: number | null
  /** Epoch ms it finished, or null — including "it has not". */
  completedAt: number | null
  /**
   * The one timestamp a caller should date a result by: when this run's result
   * came into existence.
   *
   * Completion first, because that is when the stored rows became readable, then
   * start, then creation. They differ by however long the run took — minutes, on
   * the 30-day entry — which is more than a rounding error on a panel that says
   * "as of HH:MM".
   */
  at: number | null
}

/** A row of the `output=short` job list. Everything optional: this is somebody
 *  else's JSON, and a missing field must degrade one row rather than lose the
 *  poll. */
interface ShortJob {
  id?: unknown
  status?: unknown
  timeCreated?: unknown
  timeStarted?: unknown
  timeCompleted?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function toOutcome(status: string | null): RunOutcome {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'canceled'
    // `queued` and `new` are running as far as every caller here is concerned:
    // no result yet, no cost yet, and nothing to do but wait.
    case 'running':
    case 'queued':
    case 'new':
      return 'running'
    default:
      return 'unknown'
  }
}

function toRun(raw: ShortJob | undefined): AccelRun | null {
  // `items: []` is a normal answer — a job id that no longer exists, a filter
  // that matched nothing — so the row can be absent, not merely incomplete.
  if (!raw || typeof raw !== 'object') return null
  const id = str(raw.id)
  if (!id) return null
  const outcome = toOutcome(str(raw.status))
  const createdAt = num(raw.timeCreated)
  const startedAt = num(raw.timeStarted)
  const completedAt = num(raw.timeCompleted)
  return {
    id,
    outcome,
    running: !TERMINAL.includes(outcome),
    createdAt,
    startedAt,
    completedAt,
    at: completedAt ?? startedAt ?? createdAt,
  }
}

// ── Reading the history ─────────────────────────────────────────────────────

export interface StatusOptions {
  signal?: AbortSignal
}

/**
 * Why a run's billable CPU-seconds are not a number, when they are not.
 *
 * `not-reported` is the one worth knowing about: **`billableCPUSeconds` reads 0
 * on a job that has not been billed yet**, recorded twice in this plan's
 * evidence, and cribl/jobCost.ts re-reads once after three seconds for the same
 * reason. A zero from the meter is the absence of a measurement, not a free
 * query — this module refuses to pass it on as one, because "0 CPU-s" beside a
 * scheduled search is the single most misleading thing this table could say.
 */
export type CpuUnavailable = 'running' | 'not-reported' | 'unreadable'

export interface AccelStatus {
  id: AccelId
  /** Newest first, as the sort asks for. */
  runs: readonly AccelRun[]
  /** The newest run, or null when nothing has been listed. */
  last: AccelRun | null
  /** Billable CPU-seconds of `last`, or null — see CpuUnavailable. */
  lastCpuSeconds: number | null
  lastCpuUnavailable: CpuUnavailable | null
  /**
   * The median gap between consecutive runs, in ms, or null with fewer than two.
   *
   * MEDIAN, NOT MEAN, and the difference is the whole point: one missed firing
   * doubles a gap, and a mean over twenty runs would hide it while a mean over
   * three would be dominated by it. The median answers "what is this schedule
   * actually doing", which is the question an operator comparing it to
   * `expectedIntervalMs` is asking.
   */
  observedIntervalMs: number | null
  /** What the manifest's cron asks for, or null when cronIntervalMs cannot say. */
  expectedIntervalMs: number | null
  /** Cribl refused the read (401/403). `runs` is empty because we cannot see,
   *  not because nothing ran. */
  denied: boolean
  /** Why this status says nothing, or null when the read worked. Quoting Cribl
   *  is correct HERE — this is an admin-facing table, not a customer panel; the
   *  read path deliberately does not forward it (see accel/read.ts). */
  error: string | null
  /** Epoch ms this answer was assembled. */
  checkedAt: number
}

/**
 * One run history read.
 *
 * `offset` is not optional, whatever the spec says: `limit` without it is a live
 * 400, "missing 'offset' parameter" (measured for the watchdog).
 */
/**
 * `type=scheduled` IS THE WHOLE POINT OF THIS FUNCTION, and leaving it out cost
 * this app every credit Phase 2 was built to save.
 *
 * MEASURED 2026-09-21, live. `GET /m/default_search/search/jobs` defaults to
 * returning **only `type: "standard"` jobs** — ad-hoc searches. A scheduled
 * run is `type: "scheduled"` and does not appear at all unless it is asked for.
 * A thousand-row read of the default list spanning a full week contained
 * **zero** scheduled runs while sixteen saved searches were firing hourly.
 *
 * With `type=scheduled` the same endpoint returns them, and their ids are
 * exactly the shape `isRunOf` expects — `gno_app_src_c1h.1790026560373.a7ICjD`.
 *
 * `output=short` SILENTLY OVERRIDES `type`, SO THE FILTER IS `filterExp`.
 * Measured, same endpoint and limit:
 *
 *     type=scheduled&limit=200                          -> 106 rows, 106 scheduled, 2.64 MB
 *     output=short&type=scheduled&limit=200             -> 200 rows,   9 scheduled,  115 KB
 *     output=short&filterExp=type=='scheduled'&limit=200 -> 109 rows, 109 scheduled, 113 KB
 *
 * The middle row is the trap: the short form answers mostly ad-hoc searches
 * plus whatever scheduled runs fall in the window, which looks like a working
 * filter until you count.
 *
 * The first row is the trap I FELL INTO. Dropping `output=short` does filter
 * correctly — and multiplies the payload 22x, because a full job row carries
 * its `stages[].searchConfig` pipeline blob. `snapshotTimeline` issues one of
 * these per entry, so the header's picker alone went from ~1.8 MB to ~42 MB and
 * the Flow Map went from under 2 s to over 12. `filterExp` is honoured
 * alongside the short projection and gives both: the right rows and the small
 * body.
 *
 * THIS IS THE SECOND TIME THIS BUG HAS BEEN FIXED, which is why it is written
 * out at length. The first version filtered on `correlationId`, matched nothing,
 * and every panel read "the schedule has not produced a result yet" while the
 * schedules ran fine (see `isRunOf`). That was fixed and the symptom did not
 * change, because the list being filtered still never contained a scheduled run.
 *
 * What the symptom looks like, so the third occurrence is recognised faster: the
 * schedules run, `$vt_results` holds their results and answers a `jobName` read
 * in under a second — and the app is no faster, because `read.ts` cannot DATE a
 * result without a run record, and will not return one it cannot date. Every
 * accelerated panel silently falls back to the live query it was built to avoid.
 * The failure is in the safe direction every time, which is exactly why it
 * survives: nothing is wrong on screen except the bill.
 */
function historyQuery(): string {
  return new URLSearchParams({
    // Both, and neither is optional: `output=short` keeps the body small, and
    // `filterExp` is the filter that survives it. `type=scheduled` does NOT —
    // the short projection ignores it.
    output: 'short',
    filterExp: "type=='scheduled'",
    limit: String(HISTORY_LIMIT),
    offset: '0',
    sortExp: 'timeCreated',
    sortDir: 'desc',
  }).toString()
}

/**
 * Does this job row belong to that saved search?
 *
 * MEASURED 2026-09-18, live: a scheduled run's job id is
 * `<savedSearchId>.<epochMs>.<rand>` — `gno_sample_2m_c1h.1789758420524.nqMyit`.
 * The saved search's id is a PREFIX of its runs' job ids, and there is no
 * `correlationId` anywhere on the row carrying it.
 *
 * (This used to record the field list of a SHORT-form job row. `output=short`
 * is no longer sent — it overrides `type=scheduled`, see `historyQuery` — so
 * the rows are full job objects and carry more than that list, not less.)
 *
 * This replaces `correlationId=<id>` on the request, which the module's own
 * header carried as an ASSUMPTION and which is now measured false: it matched
 * nothing, so `listRuns` returned zero runs for a schedule that had run three
 * times, every panel read "the schedule has not produced a result yet", and the
 * fallback took the live query. The failure was in the safe direction — a slow
 * correct number rather than a fast wrong one — which is exactly why it survived
 * to be found by a human noticing the app was no lighter.
 *
 * The dot is required, not cosmetic: without it `gno_lake_30d` would claim
 * `gno_lake_30d_c1d`'s runs. Ids are constrained to `/^gno_[a-z0-9_]+$/`
 * (manifest.ts), so no id can be a prefix of another up to a dot boundary — but
 * the check does not lean on that.
 */
function isRunOf(id: AccelId, jobId: string): boolean {
  return jobId.startsWith(`${id}.`)
}

function emptyStatus(id: AccelId, patch: Partial<AccelStatus>): AccelStatus {
  return {
    id,
    runs: [],
    last: null,
    lastCpuSeconds: null,
    lastCpuUnavailable: null,
    observedIntervalMs: null,
    expectedIntervalMs: cronIntervalMs(accelEntry(id).cron),
    denied: false,
    error: null,
    checkedAt: Date.now(),
    ...patch,
  }
}

/** The runs of one scheduled search, newest first. Never throws. */
export async function accelStatus(id: AccelId, opts: StatusOptions = {}): Promise<AccelStatus> {
  const listed = await listRuns(id, opts)
  if (listed.error !== null) return emptyStatus(id, { error: listed.error, denied: listed.denied })

  const runs = listed.runs
  const last = runs[0] ?? null
  const cpu = last ? await lastRunCost(last, opts) : { cpuSeconds: null, unavailable: null }
  return emptyStatus(id, {
    runs,
    last,
    lastCpuSeconds: cpu.cpuSeconds,
    lastCpuUnavailable: cpu.unavailable,
    observedIntervalMs: medianGapMs(runs),
  })
}

/** Every entry's status, for the Guided Setup table. One list read each; they do
 *  not share a request because `correlationId` selects one search. Defaults to
 *  the whole manifest, so a third entry appears in the table the day it is
 *  added rather than the day somebody remembers to add it here too. */
export async function allAccelStatus(
  ids: readonly AccelId[] = MANIFEST.map((e) => e.id),
  opts: StatusOptions = {},
): Promise<AccelStatus[]> {
  return Promise.all(ids.map((id) => accelStatus(id, opts)))
}

interface ListedRuns {
  runs: AccelRun[]
  denied: boolean
  error: string | null
}

/**
 * The raw list, without the cost read.
 *
 * accel/read.ts uses this rather than `accelStatus` on its own path: dating a
 * result needs the newest run's timestamp and nothing else, and a metrics read
 * per panel paint would be a request per panel for a number the panel never
 * shows.
 *
 * `background: true` on every call here. These reads happen on a render and on a
 * poll, never because somebody pressed a write control, and capi.ts attributes a
 * refusal that lands inside a <GatedControl>'s window to that control — measured
 * once already, where a watchdog poll's 403 marked a provisioning POST that had
 * succeeded as denied.
 */
/**
 * The one history page, shared by every caller that needs it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `historyQuery()` takes no argument: every read of the run history is the
 * BYTE-IDENTICAL request, and which entry a row belongs to is decided here by
 * `isRunOf`. So the sixteen-entry fan-out in `snapshotTimeline` was sixteen
 * copies of one answer — measured at ~113 kB each, repeated on every refresh
 * tick, plus one per accelerated panel from `atMoment` and two more from
 * Guided Setup. The comment that used to justify the fan-out cited a
 * `correlationId` this module had already removed.
 *
 * ── THE ABORT HAZARD, WHICH IS WHY THE SIGNAL IS NOT PASSED ON ──────────────
 * A shared promise must not carry any one caller's `AbortSignal`. Sixteen
 * callers each hold their own, and the first to abort would reject the promise
 * the other fifteen are waiting on — turning one caller navigating away into
 * fifteen spurious "could not be read" rows. So the shared fetch runs with NO
 * signal, and each caller checks its own afterwards: an aborted caller stops
 * waiting, and everybody else still gets the answer.
 *
 * This is a config-plane GET that bills nothing, so letting one finish
 * unattended costs a request nobody reads, which is strictly cheaper than the
 * fifteen it replaces.
 */
const PAGE_TTL_MS = 15_000

interface HistoryPage {
  at: number
  result: ListedRunsRaw
}

/** The page before it is filtered to one entry. */
interface ListedRunsRaw {
  items: ShortJob[]
  denied: boolean
  error: string | null
}

let page: HistoryPage | null = null
let inFlight: Promise<ListedRunsRaw> | null = null

/**
 * Drop the cached page so the next read goes to the network.
 *
 * Called when a HUMAN asks for fresh data — the refresh control and Guided
 * Setup's Re-check. A TTL alone would let a deliberate refresh answer from
 * cache, which is the one case where the staleness is visible and unwelcome.
 */
export function forgetRunHistory(): void {
  page = null
  inFlight = null
}

async function fetchHistoryPage(): Promise<ListedRunsRaw> {
  let r
  try {
    // NO SIGNAL — see the block above. This request outlives any one caller.
    r = await capi('GET', `${JOBS_PATH}?${historyQuery()}`, undefined, { background: true })
  } catch (err) {
    return { items: [], denied: false, error: err instanceof Error ? err.message : 'The run history could not be read.' }
  }
  if (r.status === 401 || r.status === 403) {
    return {
      items: [],
      denied: true,
      error: 'This account cannot list Cribl Search jobs, so this schedule’s runs cannot be checked.',
    }
  }
  if (r.status !== 200) return { items: [], denied: false, error: `Cribl answered ${r.status} — ${errText(r)}` }
  const items = (r.body as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    return { items: [], denied: false, error: 'Cribl returned a run list this app could not read.' }
  }
  return { items: items as ShortJob[], denied: false, error: null }
}

/** The page, from cache, from a read already in flight, or from the network. */
async function historyPage(now: number = Date.now()): Promise<ListedRunsRaw> {
  if (page !== null && now - page.at < PAGE_TTL_MS) return page.result
  if (inFlight !== null) return inFlight
  // A FAILURE IS NOT CACHED. A refusal or a broken read must not be handed to
  // fifteen more callers for the next fifteen seconds, and the next caller
  // deserves a fresh attempt rather than a stored error.
  const p = fetchHistoryPage().then((result) => {
    if (result.error === null) page = { at: Date.now(), result }
    inFlight = null
    return result
  })
  inFlight = p
  return p
}

export async function listRuns(id: AccelId, opts: StatusOptions = {}): Promise<ListedRuns> {
  const raw = await historyPage()
  // The caller's own signal, checked here rather than passed to the shared
  // request. Aborting stops this caller waiting; it does not cancel the read
  // the other callers are sharing.
  if (opts.signal?.aborted) {
    return { runs: [], denied: false, error: 'The run history read was cancelled.' }
  }
  if (raw.denied) return { runs: [], denied: true, error: raw.error }
  if (raw.error !== null) return { runs: [], denied: false, error: raw.error }
  const items = raw.items
  // Filtered HERE rather than by the request, because no server-side parameter
  // selects a saved search's runs — see isRunOf. HISTORY_LIMIT rows of the
  // workspace's whole job history are read and most are discarded; on a busy
  // workspace that window may not reach back far enough to see every run a
  // schedule's keepLastN still holds, so a timeline can be shorter than the
  // stored results actually are. It is never WRONG, only short, and it is the
  // honest cost of the platform having no such filter.
  const runs = items
    .map((raw) => toRun(raw as ShortJob))
    .filter((run): run is AccelRun => run !== null && isRunOf(id, run.id))
  // Sorted here as well as in the query. `sortDir=desc` is a parameter that has
  // to survive a proxy this app has only exercised through the dev server, and
  // everything downstream reads `runs[0]` as "the newest": a dropped parameter
  // would silently date a panel by the oldest run in the page.
  runs.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return { runs, denied: false, error: null }
}

/**
 * One job's row, by job id rather than by schedule.
 *
 * This is how accel/read.ts dates a result it actually holds: the `$vt_results`
 * rows name the run that produced them, and that run — not the newest one — is
 * the one the number on screen came from. With `keepLastN` above 1 the two can
 * differ, and dating a result by a run it did not come from is the same class of
 * mistake as not dating it at all.
 */
export async function runMeta(jobId: string, opts: StatusOptions = {}): Promise<{ run: AccelRun | null; error: string | null }> {
  let r
  try {
    r = await capi('GET', `${JOBS_PATH}/${encodeURIComponent(jobId)}`, undefined, {
      signal: opts.signal,
      background: true,
    })
  } catch (err) {
    return { run: null, error: err instanceof Error ? err.message : 'The run could not be read.' }
  }
  if (r.status !== 200) return { run: null, error: `Cribl answered ${r.status} — ${errText(r)}` }
  const items = (r.body as { items?: unknown } | null)?.items
  const run = Array.isArray(items) ? toRun(items[0] as ShortJob) : null
  return { run, error: run ? null : 'Cribl returned no such run.' }
}

/**
 * What the newest run billed.
 *
 * Not read at all while the job is running: the meter answers 0 then, and a 0
 * that reaches a table is read as "this schedule is free". Skipping the request
 * is also the honest shape — there is no measurement to fetch yet.
 */
async function lastRunCost(
  last: AccelRun,
  opts: StatusOptions,
): Promise<{ cpuSeconds: number | null; unavailable: CpuUnavailable | null }> {
  if (last.running) return { cpuSeconds: null, unavailable: 'running' }
  let r
  try {
    r = await capi('GET', `${JOBS_PATH}/${encodeURIComponent(last.id)}/metrics`, undefined, {
      signal: opts.signal,
      background: true,
    })
  } catch {
    return { cpuSeconds: null, unavailable: 'unreadable' }
  }
  if (r.status !== 200) return { cpuSeconds: null, unavailable: 'unreadable' }
  const body = r.body as { items?: Array<{ metrics?: { cpuMetrics?: { billableCPUSeconds?: unknown } } }> } | null
  const v = num(body?.items?.[0]?.metrics?.cpuMetrics?.billableCPUSeconds)
  if (v === null) return { cpuSeconds: null, unavailable: 'unreadable' }
  // A finished search of this dataset has a measured floor near five CPU-seconds
  // before it has read anything worth reading, so an exact 0 from a completed run
  // is the meter not having caught up — the same lag jobCost.ts retries through.
  // Reported as "not yet", never as a cost.
  if (v === 0) return { cpuSeconds: null, unavailable: 'not-reported' }
  return { cpuSeconds: v, unavailable: null }
}

/** The median gap between consecutive runs. Runs with no usable timestamp are
 *  skipped rather than treated as time zero. */
function medianGapMs(runs: readonly AccelRun[]): number | null {
  const times = runs.map((r) => r.at).filter((t): t is number => t !== null)
  if (times.length < 2) return null
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(Math.abs(times[i - 1] - times[i]))
  gaps.sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  return gaps.length % 2 === 1 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2)
}

/**
 * Whether the schedule is firing roughly as often as it was asked to.
 *
 * `null` means "cannot say" — fewer than two runs, or a cron shape
 * `cronIntervalMs` does not read — and a caller must render that as unknown
 * rather than as healthy. The tolerance is generous (half again) because a
 * jittered or briefly delayed Leader is not a broken schedule, and a table that
 * cries drift at a two-minute slip is a table nobody reads.
 */
export function cadenceLooksRight(status: AccelStatus): boolean | null {
  if (status.observedIntervalMs === null || status.expectedIntervalMs === null) return null
  return status.observedIntervalMs <= status.expectedIntervalMs * 1.5
}

// ── The timeline: which past states are still readable ──────────────────────
//
// A live query only ever reads now, and the range picker only widens a window
// that still ends now — so "what did this look like at 04:00?" has no price in
// this app, at any cadence. `keepLastN` retained runs of a scheduled search are
// the answer: each one is a past state, already computed and already paid for.
// This section is what turns the job history into a list a viewer can pick from.
//
// TWO THINGS BOUND HOW FAR BACK IT GOES and they are not the same thing:
// `keepLastN × cadence` is what the app asked for, and Cribl's own retention of
// search results is what the platform gives. Whichever is SHORTER is the real
// horizon, and it has to be said on screen: a picker showing a time whose result
// has been reaped is a control that answers "nothing" and looks broken.

/**
 * How long Cribl keeps a completed search's results.
 *
 * Seven days, from Cribl's documented result retention. Stated here as a
 * constant rather than assumed at a call site because the whole honesty of the
 * horizon rests on it: the manifest's `keepLastN: 24` at an hourly cadence is a
 * day, comfortably inside this, which is exactly why 24 was chosen. Somebody
 * raising it to 250 would cross this line, and `timelineHorizon` would then say
 * the platform is what cuts the timeline short rather than letting a picker
 * offer eight days of times that answer nothing.
 */
export const RESULT_RETENTION_MS = 7 * DAY_MS

/** What bounds how far back an entry's snapshots go. */
export type HorizonBound =
  /** The schedule's own `keepLastN` — the app's choice, and adjustable. */
  | 'keepLastN'
  /** Cribl reaps the result before the schedule drops it. Not adjustable here. */
  | 'retention'
  /** The cadence could not be read, so neither can the horizon. */
  | 'unknown'

export interface TimelineHorizon {
  /** How far back this entry's retained runs reach, in ms, or null when the
   *  cadence cannot be read. */
  ms: number | null
  boundBy: HorizonBound
}

/** How far back one entry's snapshots reach, and which limit decides it. */
export function timelineHorizon(id: AccelId): TimelineHorizon {
  const entry = accelEntry(id)
  const cadence = cronIntervalMs(entry.cron)
  if (cadence === null) return { ms: null, boundBy: 'unknown' }
  const kept = cadence * entry.keepLastN
  return kept <= RESULT_RETENTION_MS ? { ms: kept, boundBy: 'keepLastN' } : { ms: RESULT_RETENTION_MS, boundBy: 'retention' }
}

/** One entry's readable past, newest first. */
export interface EntryTimeline {
  id: AccelId
  /**
   * The runs whose results can actually be read: finished, successful, and
   * carrying a time.
   *
   * A running job's results are not readable and a failed one's are partial —
   * read.ts refuses both, with its reasoning. Offering either as a point on a
   * timeline would put a time in the picker that answers nothing, so the filter
   * happens here rather than being repeated by every caller.
   */
  runs: readonly AccelRun[]
  horizon: TimelineHorizon
  denied: boolean
  error: string | null
}

export interface SnapshotTimeline {
  entries: readonly EntryTimeline[]
  /**
   * Every distinct time a run finished, across all the entries asked about,
   * newest first. These are the picker's options.
   *
   * The union, not one entry's — and that is deliberate even though it means the
   * daily Lake total contributes a time the hourly entries have nothing exactly
   * at. Picking 00:10 then gives each panel the newest run of ITS OWN entry at or
   * before 00:10, which is the honest answer to "show me the state at 00:10" and
   * is also the only one that does not require the schedules to be aligned. The
   * picker says which entries are answering from further back.
   */
  times: readonly number[]
  /** The oldest readable run anywhere, or null when nothing is readable. */
  oldestAt: number | null
  /** True when every entry's history read was refused. */
  denied: boolean
  /** The first read error, or null. `error` before `runs.length`, always. */
  error: string | null
  checkedAt: number
}

/** Runs that can be read: terminal, successful, dated. */
function readable(runs: readonly AccelRun[]): AccelRun[] {
  return runs.filter((r) => !r.running && r.outcome === 'completed' && r.at !== null)
}

/**
 * The readable past of several entries at once.
 *
 * One history read per entry, because `correlationId` selects one search. They
 * bill nothing (a config-plane read) and they are the only way to know what is
 * still there — `keepLastN` is what was ASKED for, not what survived a Leader
 * restart or a re-apply.
 */
/**
 * The moments the picker offers — ONE PER HOUR, not one per run.
 *
 * This used to be the union of every entry's run times, and that is a worse
 * list than it sounds. The fifteen `gigamon_ami` schedules are deliberately
 * staggered across the hour (:07, :20, :21, :22, :23, :24, :33, :36, :40, :41,
 * :45, :47, :48, :51, :54) so they do not collide, so the union offered a
 * moment every three or four minutes — around 360 a day.
 *
 * Worse than the count was what each one MEANT. An option was one entry's run
 * time, not a state of the dashboard: picking 16:54 asked for the world as it
 * looked then, and for fourteen of the fifteen entries the newest run at or
 * before that was from a different minute. The census line under the picker
 * spent most of its life saying how few panels could answer, which is a
 * symptom of the list, not a fact about the data.
 *
 * Bucketing by the hour matches what is actually there. Every hourly entry runs
 * once an hour, so an hour is the finest window in which the set is complete,
 * and `keepLastN: 24` means twenty-four hours is exactly how far back the
 * history goes — the bucket and the retention agree.
 *
 * The value offered for a bucket is the LATEST run inside it, so
 * `runAtOrBefore` gives every entry its own run from that hour rather than the
 * previous hour's. That is why this returns run instants and not round hours:
 * the number offered is a moment that really exists, and the picker labels it
 * with the time it really is.
 */
function momentsFrom(entries: readonly EntryTimeline[]): number[] {
  const latestInHour = new Map<number, number>()
  for (const e of entries) {
    for (const r of e.runs) {
      const at = r.at as number
      if (typeof at !== 'number') continue
      const hour = Math.floor(at / HOUR_MS)
      const best = latestInHour.get(hour)
      if (best === undefined || at > best) latestInHour.set(hour, at)
    }
  }
  return [...latestInHour.values()].sort((a, b) => b - a)
}

export async function snapshotTimeline(
  ids: readonly AccelId[] = MANIFEST.map((e) => e.id),
  opts: StatusOptions = {},
): Promise<SnapshotTimeline> {
  const listed = await Promise.all(ids.map(async (id) => ({ id, ...(await listRuns(id, opts)) })))
  const entries: EntryTimeline[] = listed.map((l) => ({
    id: l.id,
    runs: readable(l.runs),
    horizon: timelineHorizon(l.id),
    denied: l.denied,
    error: l.error,
  }))
  const times = momentsFrom(entries)
  return {
    entries,
    times,
    oldestAt: times.length > 0 ? times[times.length - 1] : null,
    // Every one refused, not any: one entry the account cannot see is a gap in
    // the timeline, and the picker still works for the rest.
    denied: entries.length > 0 && entries.every((e) => e.denied),
    error: entries.find((e) => e.error !== null)?.error ?? null,
    checkedAt: Date.now(),
  }
}

/**
 * The run of one entry that answers for a chosen moment: the newest one that had
 * finished by then.
 *
 * AT OR BEFORE, never the nearest. A run that finished at 09:20 did not exist at
 * 08:40, and handing it to a viewer who asked for 08:40 would answer a question
 * about the past with data from the future — the one mistake a timeline can make
 * that a reader cannot see. `nearestRun` is for saying what IS available.
 */
export function runAtOrBefore(timeline: EntryTimeline, at: number): AccelRun | null {
  return timeline.runs.find((r) => (r.at as number) <= at) ?? null
}

/** The readable run closest in time to a chosen moment, in either direction —
 *  what a panel with nothing at that moment offers instead. */
export function nearestRun(timeline: EntryTimeline, at: number): AccelRun | null {
  let best: AccelRun | null = null
  let bestGap = Infinity
  for (const r of timeline.runs) {
    const gap = Math.abs((r.at as number) - at)
    if (gap < bestGap) {
      best = r
      bestGap = gap
    }
  }
  return best
}
