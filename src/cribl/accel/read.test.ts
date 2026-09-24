// What a panel is allowed to receive from a stored run.
//
// These go through the REAL cribl/search.ts with `fetch` stubbed, rather than
// mocking `runSearch`, because two of the claims worth testing are claims about
// the bytes Cribl receives: that the submitted range is the inert `-7d`, and that
// **no `allow_previous_results` prefix is on it** (A-D15). A mocked `runSearch`
// would assert the arguments this module passes and prove nothing about what
// search.ts then does with them — and search.ts does add a prefix of its own.
//
// The other three are about honesty rather than plumbing:
//
//   * A FAILED FAST READ MUST NOT PRINT CRIBL'S WORDS. search.ts throws
//     `Cribl API <status> <statusText> — <body>`, <QueryBoundary> renders
//     `state.error` verbatim, and the body is Cribl's echo of the query — so the
//     unhappy path here is one `$vt_results` string away from appearing in a
//     customer's panel. The fixture below returns exactly that echo and the test
//     reads every string this module hands back.
//   * A STALE RESULT IS RETURNED AND DATED, NOT REPLACED. Falling back to live on
//     staleness would silently reinstate the 9,297 CPU-s query at the moment the
//     schedule breaks, which is the cost blowup this phase exists to prevent.
//   * THE VIRTUAL COLUMNS NEVER REACH A PANEL. `jobId`, `jobName` and `dataset`
//     are not part of the scheduled body's output; on the Field Explorer path
//     they would be listed to a customer as fields arriving in their network
//     telemetry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENTRY_LIMIT, HISTORY_LIMIT, HISTORY_TIMEOUT_MS, forgetRunHistory } from './status'
import { evaluateTail } from './tail'

// The header spinner's counter, observed. `runSearch` counts itself; an
// artifact read is a plain GET and has to count itself, or the spinner goes
// quiet on the default path while panels are still loading.
const spinner = vi.hoisted(() => ({ begun: 0, ended: 0 }))
vi.mock('../inflight', async (importOriginal) => {
  const real = await importOriginal<typeof import('../inflight')>()
  return {
    ...real,
    beginQuery: () => { spinner.begun++; real.beginQuery() },
    endQuery: () => { spinner.ended++; real.endQuery() },
  }
})
import { LAKE_TOTAL_QUERY } from '../../queries/dataFlow'
import type { FieldSummary, Row } from '../search'
import { accelEntry } from './manifest'
import {
  FAST_EARLIEST,
  FIELD_SUMMARIES_CAP,
  FULL_ARTIFACT_LIMIT,
  ARTIFACT_CACHE_MAX,
  ARTIFACT_TIMEOUT_MS,
  FAST_LATEST,
  KEY_BINDING_NOTES,
  NOTES,
  STALE_FACTOR,
  VIRTUAL_COLUMNS,
  accelReadQuery,
  accelReadQueryOn,
  accelRunQuery,
  observedKeyBinding,
  readAccelFieldSummaries,
  readAccelRows,
  resetAccelKeyMemo,
  staleAfterMsFor,
  stripVirtualColumns,
} from './read'

const LAKE = 'gno_lake_30d_c1d'
const SAMPLE = 'gno_sample_2m_c1h'

/**
 * Job ids, in the shape the platform really emits: `<savedSearchId>.<suffix>`,
 * measured live on 2026-09-18 (`gno_sample_2m_c1h.1789758420524.nqMyit`). The
 * saved search's id is a PREFIX of its runs' job ids and there is no
 * `correlationId` carrying it, which is how `listRuns` selects a schedule’s runs.
 * These were bare strings until that was measured, so every fixture here
 * described a platform that does not exist and the reads fell back to live.
 */
const SRC = `${LAKE}.src-run-1`
const NEWER = `${LAKE}.newer-run`
const NEWEST = `${LAKE}.newest`
const R0920 = `${LAKE}.run-0920`
const R0820 = `${LAKE}.run-0820`
const R0720 = `${LAKE}.run-0720`
const ROLD = `${LAKE}.run-old`
const RNOW = `${LAKE}.run-now`
const RBAD = `${LAKE}.run-bad`
const ROK = `${LAKE}.run-ok`
/** A run of the OTHER entry — the sample, not the Lake total. */
const SMP = `${SAMPLE}.smp-run-1`

/** The human titles Phase 2 ships, which are NOT the ids — the whole reason the
 *  read path has two keys to try. Read from the manifest rather than retyped,
 *  so renaming an entry moves these tests with it. */
const LAKE_NAME = accelEntry(LAKE).name
const SAMPLE_NAME = accelEntry(SAMPLE).name

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_789_600_000_000

/** A stored row as `$vt_results` returns it: the body's own fields, plus the
 *  three virtual columns the platform adds. */
const STORED: Row = {
  total_events: 18_240_113,
  total_bytes: 9_412_886_144,
  jobId: SRC,
  jobName: LAKE,
  dataset: '$vt_results',
}

const LIVE: Row = { total_events: 18_301_990, total_bytes: 9_444_001_280 }

/** The run that produced STORED, as the job list returns it. */
const srcRun = (over: Record<string, unknown> = {}) => ({
  id: SRC,
  status: 'completed',
  timeCreated: NOW - HOUR,
  timeStarted: NOW - HOUR,
  timeCompleted: NOW - HOUR + 9_000,
  ...over,
})

interface Cfg {
  /** What a read keyed on the saved search's ID answers with. */
  vtRows?: Row[]
  /** What a read keyed on its DISPLAY NAME answers with. A platform binds
   *  `jobName=` to one or the other (V-23, unmeasured), so a fixture that sets
   *  only one of these is a workspace where that key is the one that works. */
  nameRows?: Row[]
  liveRows?: Row[]
  vtFields?: FieldSummary[]
  nameFields?: FieldSummary[]
  liveFields?: FieldSummary[]
  /** Fail the `$vt_results` job submit with this status and body. */
  vtFail?: { status: number; body: unknown }
  /** Rows the run-history list answers with. */
  history?: unknown[]
  historyStatus?: number
  /** Job rows addressable by id, for the dating read. */
  jobs?: Record<string, Record<string, unknown>>
  /** Throw an abort from every request. */
  abort?: boolean
  /** Abort `ctl` when a request's url contains this — the panel leaving
   *  mid-read, rather than before it. The abort is THROWN only for requests
   *  that carry the caller's signal; the shared history read carries none. */
  abortOn?: string
  ctl?: AbortController
  /** One run's artifact, by run id, when it must differ from `vtRows` — a
   *  completed older run whose artifact is readable while `$vt_results`,
   *  which answers for the newest run, has nothing. */
  runRows?: Record<string, Row[]>
  /** What an artifact's results header claims the result holds, when it must
   *  differ from the rows returned — a truncated read. */
  headerTotal?: number
  /** Fail every artifact GET with this status. */
  artifactStatus?: number
}

interface Submitted {
  query: string
  earliest: string
  latest: string
}

function res(status: number, body: unknown, asText?: string) {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => body,
    text: async () => asText ?? JSON.stringify(body),
  }
}

/** Stub the network for both transports: search.ts's own client and capi. */
function stub(cfg: Cfg): { submits: Submitted[]; urls: string[] } {
  const submits: Submitted[] = []
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    urls.push(u)
    if (cfg.abort) throw new DOMException('Aborted', 'AbortError')
    if (cfg.abortOn && cfg.ctl && u.includes(cfg.abortOn)) {
      cfg.ctl.abort()
      if (init.signal === cfg.ctl.signal) throw new DOMException('Aborted', 'AbortError')
    }
    const method = init.method ?? 'GET'

    if (method === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const isVt = body.query.includes('$vt_results')
      if (isVt && cfg.vtFail) return res(cfg.vtFail.status, cfg.vtFail.body)
      // Three job ids, so /results and /field-summaries can answer each key
      // differently. None is a prefix of another: `job-vt` is, deliberately, not
      // a substring of the name-keyed one.
      // A `jobId=` selector is the timeline's read of one named run. It is not
      // keyed on either identifier, so it answers from the same rows the
      // id-keyed read does — `vtRows`.
      const byRun = body.query.includes('jobId=')
      const id = !isVt ? 'job-live' : !byRun && keyOf(body.query) === 'name' ? 'job-nm' : 'job-vt'
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      // A STORED RUN IS READ BY ITS OWN JOB ID NOW. `$vt_results` cannot address
      // one (measured 2026-09-21), so `atMoment` GETs
      // `/search/jobs/<runId>/results` directly. Those urls carry neither
      // synthetic id, so without this they fell through to `liveRows` and every
      // chosen-moment case quietly read the present.
      const storedRun = !u.includes('job-nm') && !u.includes('job-vt') && !u.includes('job-live')
      const runId = /\/search\/jobs\/([^/?]+)\/results/.exec(u)?.[1] ?? ''
      if (storedRun && cfg.artifactStatus) return res(cfg.artifactStatus, { message: 'no' })
      const rows = storedRun
        ? (cfg.runRows?.[decodeURIComponent(runId)] ?? cfg.vtRows ?? [])
        : u.includes('job-nm') ? (cfg.nameRows ?? []) : u.includes('job-vt') ? (cfg.vtRows ?? []) : (cfg.liveRows ?? [])
      const total = storedRun && cfg.headerTotal !== undefined ? cfg.headerTotal : rows.length
      const ndjson = [JSON.stringify({ totalEventCount: total, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n')
      return res(200, {}, ndjson)
    }
    if (u.includes('/field-summaries')) {
      const fields = u.includes('job-nm') ? (cfg.nameFields ?? []) : u.includes('job-vt') ? (cfg.vtFields ?? []) : (cfg.liveFields ?? [])
      return res(200, { fields })
    }
    if (u.includes('/search/jobs?')) {
      if (cfg.historyStatus) return res(cfg.historyStatus, { message: 'no' })
      return res(200, { items: cfg.history ?? [] })
    }
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) {
      const row = cfg.jobs?.[byId[1]]
      return row ? res(200, { items: [row] }) : res(404, { message: 'gone' })
    }
    return res(404, { message: 'unrouted' })
  })
  return { submits, urls }
}

/** A read that finds a healthy, recent run. The baseline every failure varies. */
const healthy: Cfg = { vtRows: [STORED], liveRows: [LIVE], jobs: { [SRC]: srcRun() } }

/** Which identifier a submitted `$vt_results` query selected on. The ids are the
 *  only `jobName=` values matching the `gno_` shape; a title is anything else. */
const keyOf = (query: string): 'id' | 'name' =>
  /jobName="gno_[a-z0-9_]+"/.test(query) ? 'id' : 'name'

const vtSubmit = (s: Submitted[]) => s.find((x) => x.query.includes('$vt_results'))
const liveSubmit = (s: Submitted[]) => s.find((x) => !x.query.includes('$vt_results'))
const vtSubmits = (s: Submitted[]) => s.filter((x) => x.query.includes('$vt_results'))
const vtKeys = (s: Submitted[]) => vtSubmits(s).map((x) => keyOf(x.query))

beforeEach(() => {
  // The run-history page is cached module-wide so sixteen callers share one
  // request. A cache that outlived a test would hand the next one the previous
  // test's stubbed history, so it is dropped here — the same discipline as
  // resetAccelKeyMemo and resetSnapshotCensus.
  forgetRunHistory()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The name-binding notice, which fires once per entry per session precisely
  // because the memo below is what stops it repeating.
  vi.spyOn(console, 'info').mockImplementation(() => {})
  // The key memo is module-level and lives for a session. Cleared between tests
  // so that one test's measurement cannot make another test's first read cheap
  // — which would hide exactly the double-read this suite exists to pin.
  resetAccelKeyMemo()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the query a fast read submits', () => {
  it('names the schedule, because a read without that predicate errors', () => {
    expect(accelReadQuery(LAKE)).toBe(`dataset="$vt_results" jobName="${LAKE}"`)
    expect(accelReadQuery(LAKE, '| limit 10')).toBe(`dataset="$vt_results" jobName="${LAKE}" | limit 10`)
    expect(accelReadQuery(LAKE, '   ')).toBe(`dataset="$vt_results" jobName="${LAKE}"`)
  })

  it('refuses an id this app does not own, before it reaches query text', () => {
    // The one place in the app where an identifier is interpolated into a query
    // string. The types make it a closed union today; this is what keeps it safe
    // when somebody widens them.
    expect(() => accelReadQuery('my_gno_copy" or 1==1 //' as never)).toThrow()
    expect(() => accelReadQuery('' as never)).toThrow()
  })

  it('submits at the inert -7d range and carries no results directive', async () => {
    const { submits } = stub(healthy)
    await readAccelRows(LAKE, { now: NOW })
    const vt = vtSubmit(submits)
    expect(vt).toBeDefined()
    // The range selects NOTHING — the time picker is ignored on a $vt_results
    // read — but a job still has to be submitted with one.
    expect([vt!.earliest, vt!.latest]).toEqual([FAST_EARLIEST, FAST_LATEST])
    expect([FAST_EARLIEST, FAST_LATEST]).toEqual(['-7d', 'now'])
    // A-D15: the result is already stored, so no previous/incomplete-results
    // prefix may be on it. What search.ts DOES add is a running-time cap, which
    // is not a results directive — spelled out rather than rebuilt, because this
    // is the string Cribl receives.
    expect(vt!.query).toBe(`set max_running_time_per_search=900; dataset="$vt_results" jobName="${LAKE}"`)
    expect(vt!.query).not.toContain('allow_previous_results')
    expect(vt!.query).not.toContain('allow_incomplete_results')
  })

  it('carries no results directive on the field-summaries path either', async () => {
    const { submits } = stub({
      vtFields: [{ name: 'src_ip', type: 'string', count: 5000, countDistinct: 40, countNull: 0, topValues: [] }],
      jobs: { [SRC]: srcRun() },
      history: [srcRun()],
    })
    await readAccelFieldSummaries(SAMPLE, { now: NOW })
    const vt = vtSubmit(submits)
    expect(vt!.query).toContain(`dataset="$vt_results" jobName="${SAMPLE}"`)
    expect(vt!.query).not.toContain('allow_previous_results')
    expect(vt!.query).not.toContain('allow_incomplete_results')
  })
})

describe('the virtual columns', () => {
  it('drops exactly the three the platform adds, and nothing else', () => {
    expect(VIRTUAL_COLUMNS).toEqual(['jobId', 'jobName', 'dataset'])
    expect(stripVirtualColumns([STORED])).toEqual([{ total_events: 18_240_113, total_bytes: 9_412_886_144 }])
  })

  it('leaves the row it was given alone', () => {
    // The parsed response may be read by more than one caller; deleting keys in
    // place would empty somebody else's rows.
    const row = { ...STORED }
    stripVirtualColumns([row])
    expect(row.jobId).toBe(SRC)
  })

  it('keeps a field of the body’s own that merely looks like one', () => {
    const rows = stripVirtualColumns([{ dataset_name: 'x', jobIdentifier: 'y', jobId: 'drop' }])
    expect(rows[0]).toEqual({ dataset_name: 'x', jobIdentifier: 'y' })
  })

  it('never lets them reach a panel', async () => {
    stub(healthy)
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.data).toEqual([{ total_events: 18_240_113, total_bytes: 9_412_886_144 }])
    for (const row of read.data) for (const col of VIRTUAL_COLUMNS) expect(row).not.toHaveProperty(col)
  })
})

describe('a healthy read', () => {
  it('answers from the schedule, dated by the run that produced it', async () => {
    const { submits } = stub(healthy)
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.outcome).toBe('fresh')
    expect(read.stale).toBe(false)
    expect(read.run?.id).toBe(SRC)
    // Dated by completion — when the stored rows became readable.
    expect(read.at).toBe(NOW - HOUR + 9_000)
    expect(read.ageMs).toBe(HOUR - 9_000)
    expect(read.note).toBe(NOTES.fresh)
    expect(liveSubmit(submits), 'the expensive query ran anyway').toBeUndefined()
  })

  it('dates by the run the rows came from, not by the newest run', async () => {
    // With keepLastN above 1 the two differ, and dating a result by a run it did
    // not come from is the same lie as not dating it, told more convincingly.
    const { urls } = stub({
      ...healthy,
      history: [srcRun({ id: NEWER, timeCompleted: NOW - 60_000 })],
      jobs: { [SRC]: srcRun() },
    })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.run?.id).toBe(SRC)
    expect(urls.some((u) => u.endsWith(`/search/jobs/${SRC}`))).toBe(true)
  })

  it('reads the newest run as an artifact — one GET, no job submitted', async () => {
    // Phase 7 item 1.1. A `$vt_results` read is a submitted job and waits its
    // turn in the ~1.6 s admission queue; the run's own artifact is a plain GET.
    // A submit here means every accelerated panel is queueing again.
    const { submits, urls } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()] })
    spinner.begun = spinner.ended = 0
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(submits, 'a job was submitted to read a stored result').toEqual([])
    // Off the critical path: the small head page, not the full history.
    const pages = urls.filter((u) => u.includes('/search/jobs?')).map((u) => new URL(u, 'http://x').searchParams.get('limit'))
    // LAKE is the daily entry, which the head page never reaches, so it is asked
    // for alone (ENTRY_LIMIT). An hourly entry would use HEAD_LIMIT; either way,
    // never the full page.
    expect(pages, 'the newest read waited on the full history page').toEqual([String(ENTRY_LIMIT)])
    expect(spinner.begun, 'the header spinner never saw the read').toBe(1)
    expect(spinner.ended, 'the header spinner was left spinning').toBe(1)
    expect(urls.some((u) => u.includes(`/search/jobs/${SRC}/results`))).toBe(true)
    expect(read.source).toBe('schedule')
    expect(read.outcome).toBe('fresh')
    // Dated by the run it read, from the history row — no second lookup.
    expect(read.run?.id).toBe(SRC)
    expect(read.at).toBe(NOW - HOUR + 9_000)
    expect(read.data).toEqual([{ total_events: 18_240_113, total_bytes: 9_412_886_144 }])
  })

  it('refuses rows that name a different run than the one it read', async () => {
    // The artifact of NEWER answering with rows stamped SRC is a contradiction.
    // Dating them by NEWER would be the lie; the query path dates by the rows.
    const { submits } = stub({
      ...healthy,
      history: [srcRun({ id: NEWER, timeCompleted: NOW - 60_000 })],
      jobs: { [SRC]: srcRun() },
    })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(vtSubmits(submits)).toHaveLength(1)
    expect(read.run?.id).toBe(SRC)
  })

  it('evaluates a re-aggregating tail over a COMPLETE artifact — still no job', async () => {
    // Phase 7 item 1.3. The header proves every row was read, so the tail's
    // total is the total.
    const { submits, urls } = stub({ ...healthy, vtRows: [{ ...STORED }, { ...STORED, total_events: 10 }], history: [srcRun()] })
    const read = await readAccelRows(LAKE, { now: NOW, tail: '| summarize n=sum(total_events)' })
    expect(submits).toEqual([])
    expect(read.data).toEqual([{ n: 18_240_123 }])
    // Read whole: the caller's limit would cap the INPUT, which is the wrong total.
    expect(urls.some((u) => u.includes(`/results?limit=${FULL_ARTIFACT_LIMIT}`))).toBe(true)
  })

  it('keeps a re-aggregating tail on the query path when the artifact was TRUNCATED', async () => {
    // Two rows read of three held: a sum over them is a wrong total that looks
    // exactly like a right one. Cribl evaluates it over every stored row instead.
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }, { ...STORED }], headerTotal: 3, history: [srcRun()] })
    await readAccelRows(LAKE, { now: NOW, tail: '| summarize n=sum(total_events)' })
    expect(vtSubmits(submits), 'a truncated artifact was re-aggregated').toHaveLength(1)
  })

  it('does not take a MISSING results header as proof the read was whole', async () => {
    // No header parses as a total of 0, which must never equal a non-empty read.
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], headerTotal: 0, history: [srcRun()] })
    await readAccelRows(LAKE, { now: NOW, tail: '| summarize n=sum(total_events)' })
    expect(vtSubmits(submits)).toHaveLength(1)
  })

  it('applies the caller limit AFTER the tail, where Search applies it', async () => {
    const rows = [5, 9, 7].map((v) => ({ ...STORED, total_events: v }))
    stub({ ...healthy, vtRows: rows, history: [srcRun()] })
    const read = await readAccelRows(LAKE, { now: NOW, limit: 2, tail: '| sort by total_events desc | project v=total_events' })
    expect(read.data).toEqual([{ v: 9 }, { v: 7 }])
  })

  it('keeps a tail outside the grammar on the query path', async () => {
    const { submits } = stub({ ...healthy, history: [srcRun()] })
    await readAccelRows(LAKE, { now: NOW, tail: '| summarize n=avg(total_events)' })
    expect(vtSubmits(submits)).toHaveLength(1)
  })

  it('falls back to the query path when the artifact is empty or unreadable', async () => {
    const empty = stub({ ...healthy, history: [srcRun()], vtRows: [] })
    const a = await readAccelRows(LAKE, { now: NOW })
    expect(vtSubmits(empty.submits)).toHaveLength(2)
    expect(a.source).toBe('live')
  })

  it('does not hang when the shared history read hangs', async () => {
    // The shared read carries no caller's signal, so it must carry its own
    // clock: every accelerated panel waits on it first now. A request that
    // never answers settles when that clock fires, and the read carries on
    // down the $vt_results path instead of hanging with it.
    const base = { ...healthy, history: [srcRun()] }
    const { submits } = stub(base)
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      if (!String(url).includes('/search/jobs?')) return inner(url, init)
      return new Promise((_, reject) => {
        if (!init.signal) return // no clock: hangs forever, and so does the test
        init.signal.addEventListener('abort', () => reject(init.signal!.reason))
      })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const p = readAccelRows(LAKE, { now: NOW })
      await vi.advanceTimersByTimeAsync(HISTORY_TIMEOUT_MS + 1)
      vi.useRealTimers()
      const read = await p
      expect(read.source).toBe('schedule')
      expect(vtSubmits(submits), 'the read did not fall back to the query path').toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a projection tail through to the artifact rows', async () => {
    // The panel's own columns and nothing else — the column-leak class that
    // 5f9013c fixed on the picked-snapshot path, pinned on this one.
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()] })
    const read = await readAccelRows(LAKE, { now: NOW, tail: '| project a=total_events' })
    expect(vtSubmits(submits)).toEqual([])
    expect(read.data).toEqual([{ a: 18_240_113 }])
  })

  it('steps aside when the newest run FAILED, so run-failed is still reported', async () => {
    // The timeline drops failed runs. Serving the one before it as "From the
    // scheduled run." would bury the only signal an admin gets that the schedule
    // broke. A failed run's $vt_results read is empty (it needs
    // allow_incomplete_results, which this app never sends).
    const failed = srcRun({ id: NEWER, status: 'failed', timeCompleted: NOW - 60_000 })
    const { submits } = stub({
      ...healthy,
      vtRows: [],
      nameRows: [],
      // The older run's artifact is perfectly readable — which is exactly what
      // makes serving it tempting, and wrong.
      runRows: { [SRC]: [{ ...STORED }] },
      history: [failed, srcRun()],
    })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.outcome).toBe('run-failed')
    expect(vtSubmits(submits).length, 'the query path never ran').toBeGreaterThan(0)
  })

  it('serves the run before a newest run that is still GOING, dated by that run', async () => {
    const going = srcRun({ id: NEWER, status: 'running', timeCompleted: undefined, timeStarted: NOW - 60_000 })
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [going, srcRun()] })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(submits).toEqual([])
    expect(read.run?.id).toBe(SRC)
    expect(read.at).toBe(NOW - HOUR + 9_000)
  })

  it('stops, rather than falling back, when the panel goes during the artifact read', async () => {
    // Aborted mid-read, not before it: a fallback here would submit a job for a
    // panel nobody is looking at.
    const ctl = new AbortController()
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()], abortOn: `/search/jobs/${SRC}/results`, ctl })
    await expect(readAccelRows(LAKE, { now: NOW, signal: ctl.signal })).rejects.toThrow()
    expect(submits, 'a job was submitted for a panel that had gone').toEqual([])
  })

  it('stops, rather than falling back, when the panel goes during the history read', async () => {
    const ctl = new AbortController()
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()], abortOn: '/search/jobs?', ctl })
    await expect(readAccelRows(LAKE, { now: NOW, signal: ctl.signal })).rejects.toThrow()
    expect(submits, 'a job was submitted for a panel that had gone').toEqual([])
  })

  it('falls back to the newest run when the rows name no job', async () => {
    const { total_events, total_bytes } = STORED as { total_events: number; total_bytes: number }
    stub({
      vtRows: [{ total_events, total_bytes }],
      liveRows: [LIVE],
      history: [srcRun({ id: NEWEST, timeCompleted: NOW - 2 * HOUR })],
    })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.run?.id).toBe(NEWEST)
    expect(read.at).toBe(NOW - 2 * HOUR)
  })
})

describe('a stale run', () => {
  it('is returned and flagged, never silently replaced by the live query', async () => {
    // Falling back here would reinstate the 9,297 CPU-s query at the exact moment
    // the schedule breaks — invisibly, and every time the panel is painted.
    const { submits } = stub({ ...healthy, jobs: { [SRC]: srcRun({ timeCompleted: NOW - 3 * DAY }) } })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.outcome).toBe('stale')
    expect(read.stale).toBe(true)
    expect(read.at, 'a stale result that cannot be dated is the dangerous case').toBe(NOW - 3 * DAY)
    expect(read.ageMs).toBe(3 * DAY)
    expect(read.note).toContain('older than its schedule')
    expect(liveSubmit(submits)).toBeUndefined()
  })

  it('measures staleness against the schedule’s own cadence', () => {
    expect(staleAfterMsFor(accelEntry(LAKE))).toBe(STALE_FACTOR * DAY)
    expect(staleAfterMsFor(accelEntry(SAMPLE))).toBe(STALE_FACTOR * HOUR)
  })

  it('assumes daily when it cannot read the cron, because the other guess is worse', () => {
    // Assume hourly and a healthy daily run is called stale two hours after it
    // succeeds — a warning on a correct number, every day.
    expect(staleAfterMsFor({ ...accelEntry(LAKE), cron: '0 0 1 * *' })).toBe(STALE_FACTOR * DAY)
  })

  it('is not stale one tick under the threshold, and is one tick over', async () => {
    const at = (age: number) => ({ ...healthy, jobs: { [SRC]: srcRun({ timeCompleted: NOW - age }) } })
    stub(at(2 * DAY))
    expect((await readAccelRows(LAKE, { now: NOW })).outcome).toBe('fresh')
    vi.unstubAllGlobals()
    stub(at(2 * DAY + 1))
    expect((await readAccelRows(LAKE, { now: NOW })).outcome).toBe('stale')
  })
})

describe('nothing to read', () => {
  it('says the schedule has not produced a result yet, and runs the live query', async () => {
    const { submits } = stub({ vtRows: [], liveRows: [LIVE], history: [] })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.outcome).toBe('no-run')
    expect(read.source).toBe('live')
    expect(read.data).toEqual([LIVE])
    expect(read.at).toBeNull()
    expect(read.run).toBeNull()
    expect(liveSubmit(submits)).toBeDefined()
  })

  it('tells a failed run from a missing one', async () => {
    // A failed run's results ARE reachable with allow_incomplete_results, and are
    // deliberately not read: a partial sum is a smaller Lake, and a partial
    // sample says fields are missing that are not.
    for (const status of ['failed', 'canceled']) {
      forgetRunHistory()
      const { urls } = stub({ vtRows: [], liveRows: [LIVE], history: [srcRun({ status })] })
      const read = await readAccelRows(LAKE, { now: NOW })
      expect(read.outcome, status).toBe('run-failed')
      expect(read.source).toBe('live')
      // Diagnosed from the entry's own small page, never the full history: the
      // newest run's outcome is all `diagnose` needs.
      const pages = urls.filter((u) => u.includes('/search/jobs?')).map((u) => new URL(u, 'http://x').searchParams.get('limit'))
      expect(pages, 'diagnose waited on the full history page').not.toContain(String(HISTORY_LIMIT))
      vi.unstubAllGlobals()
    }
  })

  it('tells a run still in flight from a run that never happened', async () => {
    stub({ vtRows: [], liveRows: [LIVE], history: [srcRun({ status: 'running', timeCompleted: null })] })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.outcome).toBe('run-pending')
    expect(read.note).toContain('still going')
  })

  it('tells a result aged out by keepLastN from a schedule that never ran', async () => {
    stub({ vtRows: [], liveRows: [LIVE], history: [srcRun()] })
    expect((await readAccelRows(LAKE, { now: NOW })).outcome).toBe('aged-out')
  })

  it('treats an unreadable history as "no run", which spends a live query rather than risking a date', async () => {
    stub({ vtRows: [], liveRows: [LIVE], historyStatus: 403 })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.outcome).toBe('no-run')
    expect(read.source).toBe('live')
  })
})

describe('which identifier $vt_results answers to (V-23)', () => {
  // NOBODY HAS MEASURED whether `jobName=` selects a saved search's id or its
  // display name — A-SP1 was never run, and Phase 2 ships entries where the two
  // differ. Keyed only on the id against a name-binding platform, both panels
  // read zero rows forever, fall back to live, render the right number and save
  // NOTHING. It fails safe and it fails silent, which is why the read asks both.

  /** The same stored row as a name-binding platform would stamp it. */
  const NAMED: Row = { ...STORED, jobName: LAKE_NAME }
  /** A workspace where the id selects nothing and the title selects the run. */
  const nameBinding: Cfg = { vtRows: [], nameRows: [NAMED], liveRows: [LIVE], jobs: { [SRC]: srcRun() }, history: [] }

  it('asks the id first, and asks nothing else when it answers', async () => {
    const { submits } = stub(healthy)
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(vtKeys(submits)).toEqual(['id'])
    expect(read.key).toBe('id')
    expect(read.source).toBe('schedule')
  })

  it('retries on the display name before concluding there is no run', async () => {
    const { submits } = stub(nameBinding)
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(vtKeys(submits)).toEqual(['id', 'name'])
    expect(read.source, 'a name-binding platform sent the panel to the live query').toBe('schedule')
    expect(read.outcome).toBe('fresh')
    expect(read.data).toEqual([{ total_events: 18_240_113, total_bytes: 9_412_886_144 }])
    expect(liveSubmit(submits), 'the 9,297 CPU-s query ran anyway').toBeUndefined()
  })

  it('says which key answered, because that is the evidence V-23 wanted', async () => {
    // Reported on the read rather than logged, so a status surface can state the
    // binding as a fact somebody read off a running app.
    expect(observedKeyBinding(), 'before anything has been read there is nothing to claim').toBeNull()
    stub(nameBinding)
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.key).toBe('name')
    expect(observedKeyBinding()).toBe('name')
    expect(KEY_BINDING_NOTES.name).toContain('display name')
  })

  it('pays for the losing key once, then never again this session', async () => {
    // 0.2 billable CPU-s a miss. Cheap, and not free — the memo is what keeps it
    // from being charged on every paint of every accelerated panel.
    const { submits } = stub(nameBinding)
    await readAccelRows(LAKE, { now: NOW })
    const afterFirst = vtSubmits(submits).length
    const second = await readAccelRows(LAKE, { now: NOW })
    expect(vtKeys(submits).slice(afterFirst)).toEqual(['name'])
    expect(second.key).toBe('name')
  })

  it('does not memoise a genuine miss, so the first scheduled run is picked up when it arrives', async () => {
    // A schedule that has just been applied answers nothing on EITHER key, and
    // that is not a measurement. Remembered as one, the panel would be pinned to
    // whichever key it guessed and could never notice the run that eventually
    // lands.
    const { submits } = stub({ vtRows: [], nameRows: [], liveRows: [LIVE], history: [] })
    const first = await readAccelRows(LAKE, { now: NOW })
    expect(first.outcome).toBe('no-run')
    expect(first.source).toBe('live')
    expect(first.key, 'nothing answered, so no key may be reported').toBeNull()
    expect(vtKeys(submits)).toEqual(['id', 'name'])
    expect(observedKeyBinding()).toBeNull()

    vi.unstubAllGlobals()
    const later = stub(nameBinding)
    const next = await readAccelRows(LAKE, { now: NOW })
    expect(vtKeys(later.submits), 'a later read was stuck on the key that failed').toEqual(['id', 'name'])
    expect(next.source).toBe('schedule')
    expect(next.key).toBe('name')
  })

  it('keeps one entry’s measurement out of the other’s', async () => {
    // Per entry, not global: the memo shortens work for a search that has been
    // read, and a second entry has to establish its own key. A leak here would
    // send the sample entry straight to a key nothing had tested for it.
    stub(nameBinding)
    await readAccelRows(LAKE, { now: NOW })
    vi.unstubAllGlobals()
    // The history page is cached for its TTL; a second stub is a second
    // workspace, so the first one's page must not answer for it.
    forgetRunHistory()

    const { submits } = stub({
      vtFields: [{ name: 'src_ip', type: 'string', count: 5000, countDistinct: 40, countNull: 0, topValues: [] }],
      // The sample's own run, not the Lake total's: a run row now declares which
      // schedule it belongs to in its job id, so a LAKE-owned fixture would leave
      // SAMPLE with no runs and send this read to the live query instead.
      jobs: { [SMP]: srcRun({ id: SMP }) },
      history: [srcRun({ id: SMP })],
    })
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(vtKeys(submits)).toEqual(['id'])
    expect(read.key).toBe('id')
    expect(observedKeyBinding(), 'two entries disagreeing is not a binding to report').toBeNull()
  })

  it('submits the fallback at the same inert range, with no results directive', async () => {
    // Everything true of the first read is true of the second: A-D15 does not
    // get a pass because this one is a retry.
    const { submits } = stub(nameBinding)
    await readAccelRows(LAKE, { now: NOW })
    const name = vtSubmits(submits)[1]
    expect([name.earliest, name.latest]).toEqual([FAST_EARLIEST, FAST_LATEST])
    expect(name.query).toBe(`set max_running_time_per_search=900; dataset="$vt_results" jobName="${LAKE_NAME}"`)
    expect(name.query).not.toContain('allow_previous_results')
    expect(name.query).not.toContain('allow_incomplete_results')
  })

  it('carries a caller’s tail onto the fallback too', async () => {
    const { submits } = stub(nameBinding)
    await readAccelRows(LAKE, { tail: '| limit 10', now: NOW })
    for (const s of vtSubmits(submits)) expect(s.query.endsWith('| limit 10')).toBe(true)
  })

  it('falls back on the name on the field-summaries path as well', async () => {
    const f = (name: string): FieldSummary => ({ name, type: 'string', count: 5000, countDistinct: 40, countNull: 0, topValues: [] })
    const { submits } = stub({
      vtFields: [],
      nameFields: [f('src_ip'), { ...f('jobId'), countDistinct: 1, topValues: [{ value: SRC, count: 5000 }] }],
      liveFields: [f('src_ip')],
      jobs: { [SRC]: srcRun() },
      history: [],
    })
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(vtKeys(submits)).toEqual(['id', 'name'])
    expect(read.source).toBe('schedule')
    expect(read.key).toBe('name')
    expect(read.data.fields.map((x) => x.name), 'the virtual columns still never reach a panel').toEqual(['src_ip'])
  })

  it('does not retry the other key when the read itself failed', async () => {
    // An empty answer is evidence about the key; a 400 is evidence about the
    // read. Retrying here would turn one broken request into two.
    const { submits } = stub({ vtFail: { status: 400, body: { message: 'nope' } }, liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(vtSubmits(submits)).toHaveLength(1)
    expect(read.outcome).toBe('unreadable')
    expect(read.key).toBeNull()
  })

  it('accepts a stored row stamped with either identifier', async () => {
    // Which key SELECTS and which identifier the platform STAMPS in the jobName
    // column are two separate unknowns. Refusing a row because they disagree
    // would send a perfectly good stored result to the live query.
    stub({ vtRows: [NAMED], liveRows: [LIVE], jobs: { [SRC]: srcRun() } })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.key).toBe('id')
  })

  it('refuses to build a name query for anything but the manifest’s own title', async () => {
    // A title is interpolated into query TEXT and has no shape to validate
    // against, so the only check worth making is that it IS the shipped string.
    const entry = accelEntry(LAKE)
    expect(accelReadQueryOn(entry, 'name')).toBe(`dataset="$vt_results" jobName="${LAKE_NAME}"`)
    expect(accelReadQueryOn(entry, 'id')).toBe(`dataset="$vt_results" jobName="${LAKE}"`)
    expect(() => accelReadQueryOn({ ...entry, name: 'GNO" or 1==1 //' }, 'name')).toThrow()
    expect(() => accelReadQueryOn({ ...entry, name: '' }, 'name')).toThrow()
    expect(SAMPLE_NAME).not.toBe(SAMPLE)
  })
})

describe('when the fast read itself fails', () => {
  /** Exactly what Cribl answers a bad query with: its own echo of the text. */
  const echo = {
    status: 400,
    body: { message: 'Error in query: dataset="$vt_results" jobName="gno_lake_30d_c1d" — unknown virtual table' },
  }

  it('runs the live query and says so', async () => {
    const { submits } = stub({ vtFail: echo, liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.outcome).toBe('unreadable')
    expect(read.source).toBe('live')
    expect(read.data).toEqual([LIVE])
    expect(liveSubmit(submits)).toBeDefined()
  })

  it('puts none of Cribl’s words in anything a panel can render', async () => {
    // <QueryBoundary> renders `state.error` verbatim, so this is the assertion
    // that keeps `dataset="$vt_results"` out of a customer's panel.
    stub({ vtFail: echo, liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { now: NOW })
    const rendered = JSON.stringify({ outcome: read.outcome, note: read.note, source: read.source })
    for (const leak of ['$vt_results', 'Cribl API', '400', 'unknown virtual table', 'jobName']) {
      expect(rendered, `the fast read leaked "${leak}" into the UI`).not.toContain(leak)
    }
  })

  it('logs the detail, to the console and only to the console', async () => {
    stub({ vtFail: echo, liveRows: [LIVE] })
    await readAccelRows(LAKE, { now: NOW })
    expect(console.warn).toHaveBeenCalled()
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('gno_lake_30d_c1d')
  })

  it('refuses a result that names a different schedule', async () => {
    // Never observed. If the predicate were ever ignored, a panel would render
    // another schedule's numbers with this one's ⓘ beside them.
    stub({ vtRows: [{ ...STORED, jobName: 'gno_something_else' }], liveRows: [LIVE], jobs: { [SRC]: srcRun() } })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.outcome).toBe('unreadable')
    expect(read.source).toBe('live')
  })

  it('runs the live query when a result cannot be dated at all', async () => {
    // Not because an undated number is wrong, but because it cannot be labelled
    // — and the label is the whole safety argument for reading a stored run.
    const { total_events } = STORED as { total_events: number }
    stub({ vtRows: [{ total_events }], liveRows: [LIVE], history: [] })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(read.outcome).toBe('undated')
    expect(read.source).toBe('live')
    expect(read.at).toBeNull()
  })

  it('does not spend a live query on a search that was abandoned', async () => {
    // An abort is not a failure: the panel has gone. Re-thrown so useSearch's
    // request-id guard drops it.
    const ctrl = new AbortController()
    ctrl.abort()
    const { submits } = stub({ abort: true, liveRows: [LIVE] })
    await expect(readAccelRows(LAKE, { signal: ctrl.signal, now: NOW })).rejects.toThrow()
    expect(liveSubmit(submits)).toBeUndefined()
  })
})

describe('the live fallback', () => {
  it('runs the manifest’s own body over the manifest’s own window', async () => {
    const { submits } = stub({ vtRows: [], liveRows: [LIVE], history: [] })
    await readAccelRows(LAKE, { now: NOW })
    const live = liveSubmit(submits)
    // The query the ⓘ shows, unchanged — the whole point of the phase is that
    // the fallback and the schedule run the same string.
    expect(live!.query.endsWith(LAKE_TOTAL_QUERY)).toBe(true)
    expect([live!.earliest, live!.latest]).toEqual(['-30d', 'now'])
  })

  it('takes a caller’s own live query, for a panel whose window is not the manifest’s', async () => {
    // Field Explorer's live panel reads the GLOBAL range while the scheduled
    // entry reads a settled two minutes; falling back to the manifest's window
    // there would quietly change what the live panel means.
    stub({ vtRows: [], history: [] })
    const live = vi.fn(async () => [{ mine: true }] as Row[])
    const read = await readAccelRows(LAKE, { live, now: NOW })
    expect(live).toHaveBeenCalledOnce()
    expect(read.data).toEqual([{ mine: true }])
  })

  it('lets a failing live query through, because a panel with no number must say so', async () => {
    stub({ vtRows: [], history: [] })
    const live = vi.fn(async () => {
      throw new Error('Cribl Search failed')
    })
    await expect(readAccelRows(LAKE, { live, now: NOW })).rejects.toThrow('Cribl Search failed')
  })

  it('skips the fast read entirely when acceleration is switched off', async () => {
    const { submits } = stub({ vtRows: [STORED], liveRows: [LIVE], jobs: { [SRC]: srcRun() } })
    const read = await readAccelRows(LAKE, { enabled: false, now: NOW })
    expect(read.outcome).toBe('off')
    expect(read.source).toBe('live')
    expect(vtSubmit(submits), 'a switched-off panel still asked $vt_results').toBeUndefined()
    expect(read.data).toEqual([LIVE])
  })
})

// Review 2026-09-24, defects 1 and 5: what the saved search itself says
// (accel/serving.ts). A paused schedule's last runs stay readable for days; its
// panel must run live, as the switch's confirmation said and priced. A drifted
// one's runs answered an older query than the ⓘ shows.
describe('what the saved search says', () => {
  for (const serving of ['paused', 'drifted', 'unscheduled'] as const) {
    it(`sends a ${serving} entry live, reading no stored run and naming why`, async () => {
      const { submits, urls } = stub({ ...healthy, vtRows: [{ ...STORED }], liveRows: [LIVE], history: [srcRun()] })
      const read = await readAccelRows(LAKE, { serving, now: NOW })
      expect(read.source).toBe('live')
      expect(read.outcome).toBe(serving)
      expect(read.stale).toBe(false)
      expect(read.note).toBe(NOTES[serving])
      expect(read.data).toEqual([LIVE])
      expect(vtSubmit(submits)).toBeUndefined()
      expect(urls.some((u) => u.includes('/results') && !u.includes('job-')), 'an artifact was read').toBe(false)
    })
  }

  for (const serving of ['scheduled', 'unknown'] as const) {
    it(`reads the stored run as before when the verdict is ${serving}`, async () => {
      const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], liveRows: [LIVE], history: [srcRun()] })
      const read = await readAccelRows(LAKE, { serving, now: NOW })
      expect(read.source).toBe('schedule')
      expect(liveSubmit(submits)).toBeUndefined()
    })
  }

  it('does the same on the field-summaries path', async () => {
    stub({ ...healthy, vtRows: [{ ...STORED }], liveRows: [LIVE], history: [srcRun()] })
    const live = vi.fn(async () => ({ fields: [], sampled: 0 }))
    const read = await readAccelFieldSummaries(LAKE, { serving: 'paused', live, now: NOW })
    expect(read.outcome).toBe('paused')
    expect(live).toHaveBeenCalledOnce()
  })

  it('keeps the viewer’s own Live ahead of it: `off` is the sentence when both apply', async () => {
    stub({ ...healthy, vtRows: [{ ...STORED }], liveRows: [LIVE], history: [srcRun()] })
    const read = await readAccelRows(LAKE, { enabled: false, serving: 'paused', now: NOW })
    expect(read.outcome).toBe('off')
  })
})

describe('field summaries', () => {
  const field = (name: string, over: Partial<FieldSummary> = {}): FieldSummary => ({
    name,
    type: 'string',
    count: 5000,
    countDistinct: 40,
    countNull: 0,
    topValues: [],
    ...over,
  })

  const vtFields = [
    field('src_ip', { count: 4800, countNull: 200 }),
    field('jobId', { countDistinct: 1, topValues: [{ value: SRC, count: 5000 }] }),
    field('jobName', { countDistinct: 1, topValues: [{ value: SAMPLE, count: 5000 }] }),
    field('dataset', { countDistinct: 1, topValues: [{ value: '$vt_results', count: 5000 }] }),
  ]

  it('never offers a virtual column to the customer as an AMI field', async () => {
    stub({ vtFields, jobs: { [SRC]: srcRun() } })
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.data.fields.map((f) => f.name)).toEqual(['src_ip'])
  })

  it('keeps the sample size from before the filter', async () => {
    // search.ts derives `sampled` as the widest field's count + nulls, and the
    // virtual columns are the only fields present on EVERY row — recomputing it
    // after the filter would under-report the sample by however many rows lack
    // the widest real field.
    stub({ vtFields, jobs: { [SRC]: srcRun() } })
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(read.data.sampled).toBe(5000)
    expect(read.data.fields[0].count + read.data.fields[0].countNull, 'the real field is narrower').toBe(5000)
  })

  it('reads the run id off the virtual column’s own summary before dropping it', async () => {
    const { urls } = stub({ vtFields, jobs: { [SRC]: srcRun({ timeCompleted: NOW - 30 * 60_000 }) } })
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(urls.some((u) => u.endsWith(`/search/jobs/${SRC}`))).toBe(true)
    expect(read.run?.id).toBe(SRC)
    expect(read.at).toBe(NOW - 30 * 60_000)
    expect(read.outcome).toBe('fresh')
  })

  it('goes stale on the hourly cadence, not the daily one', async () => {
    stub({ vtFields, jobs: { [SRC]: srcRun({ timeCompleted: NOW - 3 * HOUR }) } })
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(read.outcome).toBe('stale')
    expect(read.staleAfterMs).toBe(2 * HOUR)
  })

  it('falls back to the live summaries when the schedule has produced nothing', async () => {
    const { submits } = stub({ vtFields: [], liveFields: [field('src_ip')], history: [] })
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(read.outcome).toBe('no-run')
    expect(read.source).toBe('live')
    expect(read.data.fields.map((f) => f.name)).toEqual(['src_ip'])
    expect(liveSubmit(submits)).toBeDefined()
  })
})

describe('field summaries of the newest run, from its artifact', () => {
  // The sample run's stored rows, as its artifact holds them: no virtual
  // columns (an artifact carries none), one row lacking a field.
  const SAMPLE_ROWS: Row[] = [
    { src_ip: '10.0.0.1', app_name: 'dns' },
    { src_ip: '10.0.0.2', app_name: 'dns' },
    { src_ip: '10.0.0.1' },
  ]
  const smpRun = (over: Record<string, unknown> = {}) => srcRun({ id: SMP, ...over })
  /** What the job path would answer, so a fallback is visible in the result. */
  const JOB_FIELDS: FieldSummary[] = [
    { name: 'from_the_job', type: 'string', count: 1, countDistinct: 1, countNull: 0, topValues: [] },
    { name: 'jobId', type: 'string', count: 1, countDistinct: 1, countNull: 0, topValues: [{ value: SMP, count: 1 }] },
  ]
  const artifactCfg = (over: Partial<Cfg> = {}): Cfg => ({
    runRows: { [SMP]: SAMPLE_ROWS },
    vtFields: JOB_FIELDS,
    history: [smpRun()],
    jobs: { [SMP]: smpRun() },
    ...over,
  })

  it('summarises the artifact in the browser — one GET, no job submitted', async () => {
    const { submits, urls } = stub(artifactCfg())
    spinner.begun = spinner.ended = 0
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(submits, 'a job was submitted to summarise a stored result').toEqual([])
    expect(urls.some((u) => u.includes(`/search/jobs/${SMP}/results`))).toBe(true)
    expect(urls.some((u) => u.includes('/field-summaries'))).toBe(false)
    expect(spinner.begun, 'the header spinner never saw the read').toBe(1)
    expect(spinner.ended, 'the header spinner was left spinning').toBe(1)
    expect(read.source).toBe('schedule')
    expect(read.outcome).toBe('fresh')
    expect(read.note).toBe(NOTES.fresh)
    expect(read.key).toBeNull()
    // Dated by the run it read, from the history row.
    expect(read.run?.id).toBe(SMP)
    expect(read.at).toBe(NOW - HOUR + 9_000)
    expect(read.data.sampled).toBe(3)
    const src = read.data.fields.find((f) => f.name === 'src_ip')
    const app = read.data.fields.find((f) => f.name === 'app_name')
    expect([src?.count, src?.countDistinct, src?.countNull]).toEqual([3, 2, 0])
    expect([app?.count, app?.countNull]).toEqual([2, 0])
    expect(read.data.fields.map((f) => f.name).filter((n) => VIRTUAL_COLUMNS.includes(n))).toEqual([])
  })

  it('lists at most the endpoint’s 200 fields, the fullest first — the cap the panel states', async () => {
    // 250 fields; f0 is on every row, the rest on one row each.
    const wide: Row = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`f${i}`, 'x']))
    stub(artifactCfg({ runRows: { [SMP]: [wide, { f0: 'y' }] } }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.data.fields).toHaveLength(FIELD_SUMMARIES_CAP)
    expect(read.data.fields[0].name).toBe('f0')
    expect(read.data.sampled, 'the sample is every stored row, whatever the cap').toBe(2)
  })

  it('never lists a virtual column, even when the stored rows carry one', async () => {
    stub(artifactCfg({ runRows: { [SMP]: SAMPLE_ROWS.map((r) => ({ ...r, jobId: SMP, jobName: SAMPLE, dataset: '$vt_results' })) } }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.data.fields.map((f) => f.name).sort()).toEqual(['app_name', 'src_ip'])
  })

  it('is stale on the hourly cadence, and still served rather than replaced', async () => {
    const old = smpRun({ timeCompleted: NOW - 3 * HOUR })
    const { submits } = stub(artifactCfg({ history: [old] }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(submits).toEqual([])
    expect(read.outcome).toBe('stale')
    expect(read.stale).toBe(true)
    expect(read.at).toBe(NOW - 3 * HOUR)
  })

  it('falls back to the job when the artifact cannot be read', async () => {
    const { submits } = stub(artifactCfg({ artifactStatus: 500 }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(vtSubmits(submits), 'the job path never ran').toHaveLength(1)
    expect(read.source).toBe('schedule')
    expect(read.data.fields.map((f) => f.name)).toEqual(['from_the_job'])
  })

  it('falls back to the job when the artifact was TRUNCATED — a smaller sample is not the sample', async () => {
    const { submits } = stub(artifactCfg({ headerTotal: SAMPLE_ROWS.length + 1 }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(vtSubmits(submits)).toHaveLength(1)
    expect(read.data.fields.map((f) => f.name)).toEqual(['from_the_job'])
  })

  it('falls back to the job when the history cannot be read', async () => {
    const { submits } = stub(artifactCfg({ historyStatus: 500 }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(vtSubmits(submits)).toHaveLength(1)
    expect(read.data.fields.map((f) => f.name)).toEqual(['from_the_job'])
  })

  it('steps aside when the newest run FAILED, so run-failed is still reported', async () => {
    const failed = smpRun({ id: `${SAMPLE}.smp-failed`, status: 'failed', timeCompleted: NOW - 60_000 })
    const { submits } = stub(artifactCfg({ vtFields: [], nameFields: [], history: [failed, smpRun()] }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW })
    expect(read.outcome).toBe('run-failed')
    expect(vtSubmits(submits).length, 'the query path never ran').toBeGreaterThan(0)
  })

  it('stops, rather than falling back, when the panel goes during the artifact read', async () => {
    const ctl = new AbortController()
    const { submits } = stub(artifactCfg({ abortOn: `/search/jobs/${SMP}/results`, ctl }))
    await expect(readAccelFieldSummaries(SAMPLE, { now: NOW, signal: ctl.signal })).rejects.toThrow()
    expect(submits, 'a job was submitted for a panel that had gone').toEqual([])
  })

  it('stops, rather than falling back, when the panel goes during the history read', async () => {
    const ctl = new AbortController()
    const { submits } = stub(artifactCfg({ abortOn: '/search/jobs?', ctl }))
    await expect(readAccelFieldSummaries(SAMPLE, { now: NOW, signal: ctl.signal })).rejects.toThrow()
    expect(submits, 'a job was submitted for a panel that had gone').toEqual([])
  })

  it('leaves the switched-off read alone: no artifact, straight to live', async () => {
    const { submits, urls } = stub(artifactCfg({ liveFields: [JOB_FIELDS[0]] }))
    const read = await readAccelFieldSummaries(SAMPLE, { now: NOW, enabled: false })
    expect(urls.some((u) => u.includes(`/search/jobs/${SMP}/results`))).toBe(false)
    expect(read.source).toBe('live')
    expect(liveSubmit(submits)).toBeDefined()
  })
})

describe('the sentences this module may say', () => {
  it('has one for every outcome, and none of them is Cribl’s', async () => {
    for (const [outcome, note] of Object.entries(NOTES)) {
      expect(note.length, outcome).toBeGreaterThan(15)
      for (const leak of ['Cribl', 'dataset=', 'HTTP', '$vt_results', 'jobName']) {
        expect(note, `${outcome} quotes the API at a customer`).not.toContain(leak)
      }
    }
  })
})


// ── Reading a chosen past state ─────────────────────────────────────────────
//
// THE CLAIM THIS WHOLE BLOCK EXISTS FOR: with a moment selected, **nothing here
// may run the live query**. Everywhere else in this module a failure falls back
// to live, because the live query answers the same question at the old price.
// That stops being true the instant a viewer names a time: the live query
// answers about NOW, the panel would be headed 04:20, and two tabs side by side
// would be showing this afternoon and this morning with nothing saying so. The
// `liveSubmit` assertion appears in every case below for that reason.

describe('one run, read once', () => {
  // A completed run's artifact is immutable, so every panel it serves shares
  // one GET: the overview run's five, Shadow AI's three, and DNS's two — 1.3 MB
  // each, measured 2026-09-23.
  const artifactGets = (urls: readonly string[]) => urls.filter((u) => u.includes(`/search/jobs/${SRC}/results`))

  it('serves several panels of one run from a single GET', async () => {
    const { urls, submits } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()] })
    await Promise.all([
      readAccelRows(LAKE, { now: NOW, tail: '| project total_events' }),
      readAccelRows(LAKE, { now: NOW, tail: '| summarize n=sum(total_events)' }),
      readAccelRows(LAKE, { now: NOW }),
    ])
    expect(artifactGets(urls)).toHaveLength(1)
    expect(submits).toEqual([])
  })

  it('does not cache a failure — the next panel gets a fresh attempt', async () => {
    const cfg = { ...healthy, vtRows: [{ ...STORED }], history: [srcRun()], artifactStatus: 500 }
    const { urls } = stub(cfg)
    await readAccelRows(LAKE, { now: NOW })
    const before = artifactGets(urls).length
    delete (cfg as { artifactStatus?: number }).artifactStatus
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(artifactGets(urls).length).toBeGreaterThan(before)
    expect(read.run?.id).toBe(SRC)
  })

  it('lets one panel leave without cancelling the read another is waiting on', async () => {
    const { urls } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()] })
    // A real fetch rejects when its signal fires. The leaving panel is the one
    // that STARTS the download (it asked first), and it leaves while the GET is
    // in flight — so were its signal on the shared request, the staying panel,
    // which joined that request, would die with it.
    const gone = new AbortController()
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (String(url).includes(`/search/jobs/${SRC}/results`)) {
        await new Promise((r) => setTimeout(r, 0))
        gone.abort()
        await new Promise((r) => setTimeout(r, 0))
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      }
      return inner(url, init)
    })
    const leaving = readAccelRows(LAKE, { now: NOW, signal: gone.signal })
    const staying = readAccelRows(LAKE, { now: NOW })
    await expect(leaving).rejects.toThrow()
    const read = await staying
    expect(read.source).toBe('schedule')
    expect(read.data).toEqual([{ total_events: 18_240_113, total_bytes: 9_412_886_144 }])
    expect(artifactGets(urls)).toHaveLength(1)
  })

  it('falls back, rather than failing, when the download times out', async () => {
    // The shared read's own clock aborts it. That abort must not reach a panel
    // as "you left" — the panel is still there and deserves its number.
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()] })
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      if (!String(url).includes(`/search/jobs/${SRC}/results`)) return inner(url, init)
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const p = readAccelRows(LAKE, { now: NOW })
      await vi.advanceTimersByTimeAsync(ARTIFACT_TIMEOUT_MS + 1)
      vi.useRealTimers()
      const read = await p
      expect(read.source).toBe('schedule')
      expect(vtSubmits(submits), 'the read did not fall back to the query path').toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says unreadable on a picked moment when the download times out', async () => {
    const hourly = [srcRun()]
    const { submits } = stub({ ...healthy, vtRows: [{ ...STORED }], history: hourly })
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      if (!String(url).includes(`/search/jobs/${SRC}/results`)) return inner(url, init)
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const p = readAccelRows(LAKE, { now: NOW, asOf: NOW })
      await vi.advanceTimersByTimeAsync(ARTIFACT_TIMEOUT_MS + 1)
      vi.useRealTimers()
      const read = await p
      expect(read.outcome).toBe('unreadable')
      expect(liveSubmit(submits), 'a picked moment ran the live query').toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts the least recently USED run, not the oldest read', async () => {
    // Each run id below is read once, except the first, which is re-read before
    // the cache fills. It must survive; the second-read run must be the one to go.
    const ids = Array.from({ length: ARTIFACT_CACHE_MAX + 1 }, (_, i) => `${LAKE}.r${i}`)
    const history = ids.map((id, i) => srcRun({ id, timeCompleted: NOW - (i + 1) * 60_000, timeCreated: NOW - (i + 1) * 60_000 }))
    const { urls } = stub({ ...healthy, vtRows: [{ ...STORED }], history })
    const gets = (id: string) => urls.filter((u) => u.includes(`/search/jobs/${id}/results`)).length
    const at = (id: string) => NOW - (ids.indexOf(id) + 1) * 60_000
    await readAccelRows(LAKE, { now: NOW, asOf: at(ids[0]) })
    for (const id of ids.slice(1, ARTIFACT_CACHE_MAX)) await readAccelRows(LAKE, { now: NOW, asOf: at(id) })
    await readAccelRows(LAKE, { now: NOW, asOf: at(ids[0]) }) // a hit: now the most recent
    await readAccelRows(LAKE, { now: NOW, asOf: at(ids[ARTIFACT_CACHE_MAX]) }) // the one that overflows
    await readAccelRows(LAKE, { now: NOW, asOf: at(ids[0]) })
    expect(gets(ids[0]), 'the run just used was evicted').toBe(1)
    // Checked before ids[1] is re-read, whose re-insertion would itself evict.
    await readAccelRows(LAKE, { now: NOW, asOf: at(ids[2]) })
    expect(gets(ids[2]), 'more than one run was evicted').toBe(1)
    await readAccelRows(LAKE, { now: NOW, asOf: at(ids[1]) })
    expect(gets(ids[1]), 'the least recently used run was kept').toBe(2)
  })

  it('hands every panel its own rows, so one cannot change another’s', async () => {
    stub({ ...healthy, vtRows: [{ ...STORED }], history: [srcRun()] })
    const a = await readAccelRows(LAKE, { now: NOW })
    ;(a.data[0] as Row).total_events = -1
    const b = await readAccelRows(LAKE, { now: NOW })
    expect(b.data[0].total_events).toBe(18_240_113)
  })
})

describe('reading the state at a chosen moment', () => {
  /** Three hourly runs, newest first, as the job list returns them. */
  const hourlyRuns = [
    { id: R0920, status: 'completed', timeCreated: NOW - HOUR, timeStarted: NOW - HOUR, timeCompleted: NOW - HOUR },
    { id: R0820, status: 'completed', timeCreated: NOW - 2 * HOUR, timeStarted: NOW - 2 * HOUR, timeCompleted: NOW - 2 * HOUR },
    { id: R0720, status: 'completed', timeCreated: NOW - 3 * HOUR, timeStarted: NOW - 3 * HOUR, timeCompleted: NOW - 3 * HOUR },
  ]

  const storedFrom = (jobId: string): Row => ({ ...STORED, jobId, jobName: LAKE })

  /** Did this run's stored artifact get read? Replaces the old assertion on a
   *  `$vt_results jobId=` query, which no longer exists — the run is addressed
   *  by URL now, so the URL is what carries the claim. */
  const fetchedRun = (urls: readonly string[], jobId: string): boolean =>
    urls.some((u) => u.includes(`/search/jobs/${encodeURIComponent(jobId)}/results`))

  it('cuts a re-aggregating panel out of a picked run — no longer blank', async () => {
    // Ten panels showed `unshaped` on every picked snapshot because their tail
    // re-aggregates and an artifact cannot run KQL. Evaluated here instead.
    const rows = [storedFrom(R0820), { ...storedFrom(R0820), total_events: 10 }]
    const { submits } = stub({ history: hourlyRuns, vtRows: rows, liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW, tail: '| summarize n=sum(total_events)' })
    expect(submits).toEqual([])
    expect(read.outcome).toBe('fresh')
    expect(read.data).toEqual([{ n: 18_240_123 }])
  })

  it('shows nothing, not a guess, when the picked run was truncated', async () => {
    stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], headerTotal: 2, liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW, tail: '| summarize n=sum(total_events)' })
    expect(read.outcome).toBe('unshaped')
    expect(read.data).toEqual([])
    expect(read.nearestAt, 'the run existed; its time is still worth saying').toBe(NOW - 2 * HOUR)
  })

  it('shows nothing when the picked panel’s tail is outside the grammar', async () => {
    const { submits } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW, tail: '| summarize n=avg(total_events)' })
    expect(read.outcome).toBe('unshaped')
    expect(liveSubmit(submits), 'a picked moment ran the live query').toBeUndefined()
  })

  it('lists a picked moment from the FULL history — the small pages hold only the newest runs', async () => {
    // A run a few hours back is not on the 48-row head page, and the daily
    // entry's own page holds four. A picked moment needs the whole retained set.
    const { urls } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW })
    const pages = urls.filter((u) => u.includes('/search/jobs?')).map((u) => new URL(u, 'http://x').searchParams.get('limit'))
    expect(pages).toEqual([String(HISTORY_LIMIT)])
  })

  it('addresses one run by its job id, not the schedule by name', async () => {
    // `jobName=` selects a schedule. With twenty-four retained runs that is
    // twenty-four wrong answers and one right one, and the app cannot tell which
    // it got — which is precisely why the timeline addresses a job id.
    const { submits, urls } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW })

    // The run is addressed by URL, and NO search is submitted for it at all:
    // reading an artifact that already exists bills nothing, where the
    // `$vt_results` read it replaced submitted a job every time.
    expect(fetchedRun(urls, R0820)).toBe(true)
    expect(vtSubmit(submits), 'a chosen moment should submit no search at all').toBeUndefined()
    expect(read.source).toBe('schedule')
    expect(read.at).toBe(NOW - 2 * HOUR)
    expect(liveSubmit(submits), 'the live query ran for a question about the past').toBeUndefined()
  })

  it('takes the newest run that had FINISHED by then, never a later one', async () => {
    // A run that finished at 09:20 did not exist at 08:40. Handing it to someone
    // who asked for 08:40 answers a question about the past with data from the
    // future — the one mistake a timeline can make that a reader cannot see.
    const { urls } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR + 40 * 60_000, now: NOW })
    expect(fetchedRun(urls, R0820)).toBe(true)
  })

  it('shows nothing, and offers its nearest, when the moment is before every run', async () => {
    const { submits } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0720)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 9 * HOUR, now: NOW })

    expect(read.outcome).toBe('no-run-at')
    expect(read.source).toBe('none')
    expect(read.data).toEqual([])
    expect(read.at).toBe(null)
    // The oldest run it does have — what the panel offers instead.
    expect(read.nearestAt).toBe(NOW - 3 * HOUR)
    expect(liveSubmit(submits), 'a gap in the timeline was filled with the present').toBeUndefined()
    expect(vtSubmit(submits), 'nothing should have been read at all').toBeUndefined()
  })

  it('reports an empty stored result as aged out rather than as a missing schedule', async () => {
    // The run WAS listed, so it fired. What has gone is its result — Cribl
    // reaped it, or keepLastN dropped it. Calling that "no snapshot from then"
    // would send a reader looking for a schedule fault that is not there.
    const { submits } = stub({ history: hourlyRuns, vtRows: [], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW })

    expect(read.outcome).toBe('aged-out')
    expect(read.source).toBe('none')
    expect(read.nearestAt).toBe(NOW - 2 * HOUR)
    expect(liveSubmit(submits)).toBeUndefined()
  })

  it('refuses rows stamped with another schedule, and still does not run live', async () => {
    const { submits } = stub({
      history: hourlyRuns,
      vtRows: [{ ...STORED, jobId: R0820, jobName: 'gno_somebody_else' }],
      liveRows: [LIVE],
    })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW })

    expect(read.outcome).toBe('unreadable')
    expect(read.source).toBe('none')
    expect(read.data).toEqual([])
    expect(liveSubmit(submits)).toBeUndefined()
  })

  it('answers the moment even when the panel asked to be live', async () => {
    // "Run this one now" has nothing to mean for a question about 04:20, so the
    // moment wins. The control that sets it is hidden while a moment is picked;
    // this is the belt to that braces.
    const { submits } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, enabled: false, now: NOW })

    expect(read.source).toBe('schedule')
    expect(read.outcome).toBe('fresh')
    expect(liveSubmit(submits)).toBeUndefined()
  })

  it('shows nothing at a moment on a DRIFTED entry — every run there answered the older query', async () => {
    const { submits, urls } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, serving: 'drifted', now: NOW })
    expect(read.source).toBe('none')
    expect(read.outcome).toBe('drifted-at')
    expect(read.data).toEqual([])
    expect(liveSubmit(submits), 'a picked moment ran the live query').toBeUndefined()
    expect(fetchedRun(urls, R0820)).toBe(false)
  })

  it('still reads a moment on a PAUSED entry — that run is what the query answered then', async () => {
    const { submits } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, serving: 'paused', now: NOW })
    expect(read.source).toBe('schedule')
    expect(read.at).toBe(NOW - 2 * HOUR)
    expect(liveSubmit(submits)).toBeUndefined()
  })

  it('never calls a chosen moment stale, however old it is', async () => {
    // Staleness means "the newest run is older than the schedule promises". A
    // viewer looking at yesterday is not being shown something overdue, and
    // flagging it would put a schedule warning on every panel of the timeline.
    const old = [{ id: ROLD, status: 'completed', timeCreated: NOW - 5 * DAY, timeStarted: NOW - 5 * DAY, timeCompleted: NOW - 5 * DAY }]
    const { submits } = stub({ history: old, vtRows: [storedFrom(ROLD)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 4 * DAY, now: NOW })

    expect(read.stale).toBe(false)
    expect(read.outcome).toBe('fresh')
    expect(read.ageMs).toBe(5 * DAY)
    expect(liveSubmit(submits)).toBeUndefined()
  })

  it('never offers a run that is still going or that failed', async () => {
    // A running job's results are not readable, and a failed one's are partial —
    // a partial sum is a smaller Lake and a partial sample says fields are
    // missing that are not. Both are excluded from the timeline rather than
    // offered and then refused.
    const mixed = [
      { id: RNOW, status: 'running', timeCreated: NOW - 60_000 },
      { id: RBAD, status: 'failed', timeCreated: NOW - HOUR, timeCompleted: NOW - HOUR },
      { id: ROK, status: 'completed', timeCreated: NOW - 2 * HOUR, timeCompleted: NOW - 2 * HOUR },
    ]
    const { urls } = stub({ history: mixed, vtRows: [storedFrom(ROK)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW, now: NOW })

    expect(fetchedRun(urls, ROK)).toBe(true)
    expect(read.at).toBe(NOW - 2 * HOUR)
  })

  it('strips the virtual columns from a chosen run exactly as it does from the newest', async () => {
    const { submits } = stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW })
    for (const column of VIRTUAL_COLUMNS) expect(Object.keys(read.data[0])).not.toContain(column)
    expect(read.data[0].total_events).toBe(STORED.total_events)
    expect(liveSubmit(submits)).toBeUndefined()
  })

  it('says nothing about which key the schedule binds to, because a job id answered', async () => {
    // V-23 is a question about `jobName=`. A read that never used it is not
    // evidence either way, and recording it as one would corrupt the only
    // measurement this app makes of the platform's behaviour.
    stub({ history: hourlyRuns, vtRows: [storedFrom(R0820)], liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - 2 * HOUR, now: NOW })
    expect(read.key).toBe(null)
    expect(observedKeyBinding()).toBe(null)
  })

  it('leaves the newest-run path completely alone', async () => {
    // The id-then-name fallback is what settles V-23, and it is the thing most
    // likely to be broken by accident while adding a second path beside it.
    const { submits } = stub({ ...healthy, nameRows: [STORED], vtRows: [] })
    const read = await readAccelRows(LAKE, { now: NOW })
    expect(vtKeys(submits)).toEqual(['id', 'name'])
    expect(read.key).toBe('name')
    expect(read.note).toBe(NOTES.fresh)
  })

  it('refuses a job id that is not one', async () => {
    // The only identifier in this app that reaches query TEXT without a human
    // having typed it: it arrives from a list read.
    expect(() => accelRunQuery('abc" or jobName="x')).toThrow()
    expect(() => accelRunQuery('')).toThrow()
    expect(accelRunQuery('1789395843210.fxAzHG')).toBe('dataset="$vt_results" jobId="1789395843210.fxAzHG"')
    expect(accelRunQuery('run-1', '| project a')).toBe('dataset="$vt_results" jobId="run-1" | project a')
  })

  it('reports a history it could not read without inventing a gap', async () => {
    const { submits } = stub({ historyStatus: 403, liveRows: [LIVE] })
    const read = await readAccelRows(LAKE, { asOf: NOW - HOUR, now: NOW })
    expect(read.outcome).toBe('unreadable')
    expect(read.source).toBe('none')
    expect(liveSubmit(submits)).toBeUndefined()
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//   * That `dataset="$vt_results" jobName=…` returns anything. No saved search
//     of ours has ever existed — constraint 8 — so every fixture here is a shape
//     taken from the measurements, not a recording of a live response. In
//     particular, that a `summarize` result carries the three virtual columns at
//     all is the plan's claim and not this suite's: the code reads them when
//     present and dates by the newest run when they are absent, and BOTH paths
//     are tested because only one of them can be right.
//   * That `keepLastN` really keeps a run readable for as long as the staleness
//     window allows. The margin was never measured.
//   * That a multi-run `jobName` selector picks the NEWEST run. On Cribl 4.19.2 it
//     selects one job; which one is unverified, which is exactly why the read
//     dates whichever run answered rather than assuming it was the latest.
//   * Anything about what a panel does with `stale`. This module returns the flag
//     and the timestamp; rendering "as of HH:MM" is the panel's obligation, and
//     no test here can hold it to that.

// ── The tail a stored artifact cannot run ───────────────────────────────────
//
// A chosen snapshot is answered by reading an ARTIFACT — `$vt_results` cannot
// address a past run. An artifact is rows, not a query, so a panel's tail
// cannot be evaluated against it by Cribl Search.
//
// Until 2026-09-22 the `asOf` branch silently dropped the tail and handed the
// panel the whole shared scan. That is not "less data" — it is ANOTHER PANEL'S
// COLUMNS under this panel's label, and the manifest has a test devoted to the
// hazard because Capacity calls `sum(total_bytes)` `total` while Findings calls
// `count()` `total`. Both are real columns with real values.
describe('the tail, over an artifact', () => {
  // Formerly `applyProjection`, which handled projections only. The evaluator
  // in tail.ts replaced it (Phase 7 item 1.3); these are the same claims about
  // projections, kept because the column-leak hazard above is theirs.
  const ALL = { complete: true }

  it('picks the named columns and drops the rest', () => {
    expect(evaluateTail('| project a, c', [{ a: 1, b: 2, c: 3 }], ALL)).toEqual([{ a: 1, c: 3 }])
  })

  it('renames with alias=source, which is how the manifest builds tails', () => {
    expect(evaluateTail('| project bin_time_1m, v=resets, flows', [{ bin_time_1m: 7, resets: 4, flows: 9 }], ALL))
      .toEqual([{ bin_time_1m: 7, v: 4, flows: 9 }])
  })

  it('leaves a missing column OUT rather than setting it undefined', () => {
    // The same nothing Search would hand back, so a caller cannot tell the two
    // apart and `toNum` behaves identically.
    const out = evaluateTail('| project a, missing', [{ a: 1 }], ALL)
    expect(out).toEqual([{ a: 1 }])
    expect(out && 'missing' in out[0]).toBe(false)
  })

  it('REFUSES what it cannot reproduce exactly', () => {
    for (const tail of ['| project total=sum(bytes)', '| project a, b(c)', '', '| sort by x']) {
      expect(evaluateTail(tail, [{ a: 1 }], ALL), tail).toBeNull()
    }
  })
})
