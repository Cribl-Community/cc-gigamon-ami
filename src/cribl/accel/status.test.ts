// What the status table is allowed to say about a schedule.
//
// Three of these assertions exist because the thing they catch is silent:
//
//   * ZERO RUNS IS NOT GOOD NEWS. A refusal, a correlationId that matched
//     nothing and a schedule that has genuinely never fired all return an empty
//     list. `error` is the only thing that separates them, and everything
//     downstream — including accel/read.ts deciding whether to spend a live
//     query — reads it first.
//   * `billableCPUSeconds` READS 0 ON A RUNNING JOB. A table that prints that
//     tells an admin their most expensive schedule is free. The cost is not read
//     at all until the run is terminal, and a 0 from a terminal run is reported
//     as "not yet", never as a cost.
//   * THE NEWEST RUN IS WHAT EVERYTHING KEYS ON. `sortDir=desc` is a query
//     parameter that has to survive a proxy this app has only exercised through
//     the dev server; if it were ever dropped, a panel would be dated by the
//     OLDEST run in the page. The rows are re-sorted here, and this proves it.
//
// The fixtures are the `output=short` shape cribl/jobWatchdog.ts already parses
// against this workspace, trimmed to the fields this module reads.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { denialMark, denialSince, resetDenials } from '../authz'
import { SEARCH_GROUP } from '../config'
import { JOBS_PATH as WATCHDOG_JOBS_PATH } from '../jobWatchdog'
import { MANIFEST, accelEntry } from './manifest'
import {
  HISTORY_LIMIT,
  JOBS_PATH,
  accelStatus,
  allAccelStatus,
  cadenceLooksRight,
  cronIntervalMs,
  listRuns,
  nearestRun,
  runAtOrBefore,
  runMeta,
  snapshotTimeline,
  timelineHorizon,
} from './status'

const LAKE = 'gno_lake_30d_c1d'
const SAMPLE = 'gno_sample_2m_c1h'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = 1_789_600_000_000

interface Sent {
  url: string
  init: RequestInit
}

/** Stub `fetch` for capi: a handler per URL substring, first match wins. */
function stub(routes: Array<{ match: string; status?: number; body?: unknown }>): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    sent.push({ url: u, init })
    const route = routes.find((r) => u.includes(r.match))
    if (!route) return { status: 404, text: async () => '{"message":"no stub"}' }
    return { status: route.status ?? 200, text: async () => JSON.stringify(route.body ?? {}) }
  })
  return sent
}

/** A run row, in the shape `GET /search/jobs?output=short` returns. */
function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // `<savedSearchId>.<epochMs>.<rand>` — the shape measured live on
    // 2026-09-18. listRuns selects a schedule's runs by this prefix, because no
    // request parameter does it: see status.ts's isRunOf.
    id: `${LAKE}.1789395843210.fxAzHG`,
    status: 'completed',
    timeCreated: T0 - HOUR,
    timeStarted: T0 - HOUR + 200,
    timeCompleted: T0 - HOUR + 9_000,
    ...over,
  }
}

const history = (items: unknown[]) => ({ match: '/search/jobs?', body: { items, totalCount: items.length } })
const metrics = (billableCPUSeconds: unknown) => ({
  match: '/metrics',
  body: { items: [{ metrics: { cpuMetrics: { billableCPUSeconds } } }] },
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetDenials()
})

describe('the path it calls', () => {
  it('names the one search group Cribl Search runs in, as a literal', () => {
    // A literal because policyCoverage.test.ts resolves call-site paths from the
    // source text: an interpolated group resolves to a placeholder, which would
    // declare a grant in EVERY worker group. Nothing but this test keeps the
    // literal in step.
    expect(JOBS_PATH).toBe(`/m/${SEARCH_GROUP}/search/jobs`)
    expect(JOBS_PATH, 'two copies of the same grant must not drift').toBe(WATCHDOG_JOBS_PATH)
  })

  it('asks for one schedule’s runs, newest first, with the offset the API insists on', async () => {
    const sent = stub([history([run()]), metrics(12.5)])
    await accelStatus(LAKE)
    const url = sent[0].url
    expect(url.startsWith(`/capi${JOBS_PATH}?`)).toBe(true)
    const qs = new URLSearchParams(url.split('?')[1])
    // No correlationId: measured 2026-09-18, a scheduled run carries none, and
    // asking for one matched nothing — every schedule read as "never ran" while
    // it was running hourly. The id lives in the job id's prefix instead.
    expect(qs.get('correlationId')).toBeNull()
    expect(url).not.toContain(LAKE)
    // MEASURED 2026-09-21: the jobs endpoint returns only `type: "standard"`
    // unless asked otherwise, so without this a schedule's runs are invisible
    // however correctly they are filtered afterwards — a 1,000-row read of the
    // default list spanning a week held zero scheduled runs while sixteen
    // saved searches fired hourly. This is the parameter, not the filter, and
    // it is the second time this class of bug has been fixed here.
    // BOTH, and the pairing is the point. `output=short` keeps the body small;
    // it also silently ignores `type=scheduled`, so the filter has to be
    // `filterExp`, which the short projection does honour. Measured 2026-09-21,
    // same endpoint and limit:
    //   type=scheduled                          106 rows, 106 scheduled, 2.64 MB
    //   output=short&type=scheduled             200 rows,   9 scheduled,  115 KB
    //   output=short&filterExp=type=='scheduled' 109 rows, 109 scheduled, 113 KB
    // Dropping `output=short` filters correctly and costs 22x the payload, once
    // PER ENTRY — that shipped for one commit and took the Flow Map from under
    // 2 s to over 12.
    expect(qs.get('filterExp')).toBe("type=='scheduled'")
    expect(qs.get('output')).toBe('short')
    expect(qs.get('type'), 'type is ignored by the short projection').toBeNull()
    expect(qs.get('sortExp')).toBe('timeCreated')
    expect(qs.get('sortDir')).toBe('desc')
    expect(qs.get('limit')).toBe(String(HISTORY_LIMIT))
    // `limit` without `offset` is a live 400, "missing 'offset' parameter",
    // although the spec marks it optional.
    expect(qs.get('offset')).toBe('0')
  })

  it('reads the cost of the newest run by its own job id', async () => {
    const sent = stub([history([run({ id: `${LAKE}.run-7` })]), metrics(9297.7)])
    const s = await accelStatus(LAKE)
    expect(sent.some((c) => c.url === `/capi${JOBS_PATH}/${LAKE}.run-7/metrics`)).toBe(true)
    expect(s.lastCpuSeconds).toBe(9297.7)
    expect(s.lastCpuUnavailable).toBeNull()
  })
})

describe('reading the runs', () => {
  it('puts the newest run first even if the list arrives the other way up', async () => {
    stub([
      history([run({ id: `${LAKE}.old`, timeCompleted: T0 - 3 * DAY }), run({ id: `${LAKE}.new`, timeCompleted: T0 - HOUR })]),
      metrics(5),
    ])
    const s = await accelStatus(LAKE)
    expect(s.runs.map((r) => r.id)).toEqual([`${LAKE}.new`, `${LAKE}.old`])
    expect(s.last?.id).toBe(`${LAKE}.new`)
  })

  it('dates a run by when its result came into existence, not when it fired', async () => {
    // They differ by however long the run took — minutes on the 30-day entry,
    // which is more than a rounding error on a panel that says "as of HH:MM".
    stub([history([run({ timeCreated: 1000, timeStarted: 2000, timeCompleted: 3000 })]), metrics(5)])
    expect((await accelStatus(LAKE)).last?.at).toBe(3000)
  })

  it('falls back through started and created when a run has not finished', async () => {
    stub([history([run({ status: 'running', timeCreated: 1000, timeStarted: 2000, timeCompleted: null })])])
    const s = await accelStatus(LAKE)
    expect(s.last?.at).toBe(2000)
    expect(s.last?.running).toBe(true)
  })

  it('does not call a status it has never seen a failure', async () => {
    // 'unknown' rather than 'failed': a run in a state this release does not
    // recognise has not been shown to have failed, and accel/read.ts branches on
    // the difference.
    stub([history([run({ status: 'sleeping' })]), metrics(1)])
    const s = await accelStatus(LAKE)
    expect(s.last?.outcome).toBe('unknown')
    expect(s.last?.running, 'an unrecognised status is not terminal').toBe(true)
  })

  it('treats queued and new as running, because neither has a result or a cost', async () => {
    for (const status of ['queued', 'new', 'running']) {
      stub([history([run({ status })])])
      const s = await accelStatus(LAKE)
      expect(s.last?.outcome, status).toBe('running')
      vi.unstubAllGlobals()
    }
  })

  it('drops a row with no id rather than losing the whole read', async () => {
    stub([history([{ status: 'completed' }, run({ id: `${LAKE}.good` })]), metrics(3)])
    expect((await accelStatus(LAKE)).runs.map((r) => r.id)).toEqual([`${LAKE}.good`])
  })
})

describe('what the last run cost', () => {
  it('does not ask while the job is still running, and never reports 0 as free', async () => {
    const sent = stub([history([run({ status: 'running', timeCompleted: null })]), metrics(0)])
    const s = await accelStatus(LAKE)
    expect(sent.some((c) => c.url.includes('/metrics')), 'asked the meter about a running job').toBe(false)
    expect(s.lastCpuSeconds).toBeNull()
    expect(s.lastCpuUnavailable).toBe('running')
  })

  it('reads a 0 from a finished run as "not reported yet", not as a cost', async () => {
    // A finished search of this dataset has a measured floor near five CPU-s, so
    // an exact zero is the meter lagging — the same lag jobCost.ts retries past.
    stub([history([run()]), metrics(0)])
    const s = await accelStatus(LAKE)
    expect(s.lastCpuSeconds).toBeNull()
    expect(s.lastCpuUnavailable).toBe('not-reported')
  })

  it('says so when the meter cannot be read at all', async () => {
    stub([history([run()]), { match: '/metrics', status: 403, body: { message: 'nope' } }])
    const s = await accelStatus(LAKE)
    expect(s.lastCpuSeconds).toBeNull()
    expect(s.lastCpuUnavailable).toBe('unreadable')
    // The runs still came back: a refused meter is not a refused history.
    expect(s.runs).toHaveLength(1)
    expect(s.error).toBeNull()
  })

  it('does not invent a number from a body it cannot read', async () => {
    stub([history([run()]), { match: '/metrics', body: { items: [{}] } }])
    expect((await accelStatus(LAKE)).lastCpuUnavailable).toBe('unreadable')
  })
})

describe('when it cannot see', () => {
  it('separates a refusal from a quiet schedule', async () => {
    stub([{ match: '/search/jobs?', status: 403, body: { message: 'forbidden' } }])
    const s = await accelStatus(LAKE)
    expect(s.denied).toBe(true)
    expect(s.error).toBeTruthy()
    expect(s.runs, 'empty because we cannot see, which is why error exists').toHaveLength(0)
    expect(s.last).toBeNull()
  })

  it('does not blame somebody’s click for a status read nobody clicked', async () => {
    // capi attributes a refusal that lands inside a <GatedControl>'s window to
    // that control. These reads happen on a render; `background: true` keeps a
    // provisioning POST that succeeded from being reported as denied.
    stub([{ match: '/search/jobs?', status: 403, body: { message: 'forbidden' } }])
    const mark = denialMark()
    await accelStatus(LAKE)
    expect(denialSince(mark), 'a background status read was attributed to a click').toBeNull()
  })

  it('quotes Cribl on any other failure, because this table is read by an admin', async () => {
    stub([{ match: '/search/jobs?', status: 500, body: { message: "Unexpected identifier 'is'" } }])
    const s = await accelStatus(LAKE)
    expect(s.error).toContain('Unexpected identifier')
    expect(s.denied).toBe(false)
  })

  it('says so when the body is not a list at all', async () => {
    stub([{ match: '/search/jobs?', body: { totalCount: 0 } }])
    expect((await accelStatus(LAKE)).error).toContain('could not read')
  })

  it('survives the request throwing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    const s = await accelStatus(LAKE)
    expect(s.error).toBeTruthy()
    expect(s.runs).toHaveLength(0)
  })

  it('reports a schedule that has never fired as empty and NOT as an error', async () => {
    stub([history([])])
    const s = await accelStatus(LAKE)
    expect(s.error).toBeNull()
    expect(s.runs).toHaveLength(0)
    expect(s.last).toBeNull()
    expect(s.lastCpuUnavailable).toBeNull()
  })
})

describe('cadence', () => {
  it('reads the shapes the manifest uses', () => {
    expect(cronIntervalMs(accelEntry(LAKE).cron)).toBe(DAY)
    expect(cronIntervalMs(accelEntry(SAMPLE).cron)).toBe(HOUR)
    expect(cronIntervalMs('* * * * *')).toBe(MIN)
    expect(cronIntervalMs('*/5 * * * *')).toBe(5 * MIN)
    expect(cronIntervalMs('0 */6 * * *')).toBe(6 * HOUR)
  })

  it('answers "cannot say" rather than guessing, and that is the safe answer', () => {
    // A wrong cadence is worse than none: staleness would flag a healthy run and
    // the estimate would multiply a per-run cost by a runs-per-day nobody
    // measured. Both callers already handle null.
    for (const cron of ['10 0 * * 1', '0 0 1 * *', '0,30 * * * *', '0 0 * JAN *', '10 0 * *', '', 'hourly']) {
      expect(cronIntervalMs(cron), cron).toBeNull()
    }
  })

  it('measures the median gap, so one missed firing does not rewrite the cadence', async () => {
    // Hourly, with the 09:00 run missed. The mean would say 72 minutes; the
    // median says 60, which is what the schedule is actually doing.
    const at = (h: number) => run({ id: `${SAMPLE}.r${h}`, timeCompleted: T0 - h * HOUR })
    stub([history([at(0), at(1), at(2), at(4), at(5)]), metrics(4)])
    const s = await accelStatus(SAMPLE)
    expect(s.observedIntervalMs).toBe(HOUR)
    expect(s.expectedIntervalMs).toBe(HOUR)
    expect(cadenceLooksRight(s)).toBe(true)
  })

  it('cannot judge a cadence from one run', async () => {
    stub([history([run()]), metrics(4)])
    const s = await accelStatus(SAMPLE)
    expect(s.observedIntervalMs).toBeNull()
    expect(cadenceLooksRight(s), 'unknown must not render as healthy').toBeNull()
  })

  it('calls a schedule that has fallen behind what it is', async () => {
    const at = (h: number) => run({ id: `${SAMPLE}.r${h}`, timeCompleted: T0 - h * HOUR })
    stub([history([at(0), at(6), at(12)]), metrics(4)])
    expect(cadenceLooksRight(await accelStatus(SAMPLE))).toBe(false)
  })

  it('tolerates a firing that is merely late', async () => {
    // A jittered or briefly delayed Leader is not a broken schedule, and a table
    // that cries drift at a two-minute slip is a table nobody reads.
    const at = (m: number) => run({ id: `${SAMPLE}.r${m}`, timeCompleted: T0 - m * MIN })
    stub([history([at(0), at(70), at(140)]), metrics(4)])
    expect(cadenceLooksRight(await accelStatus(SAMPLE))).toBe(true)
  })
})

describe('one run by id', () => {
  it('reads the run the stored rows named', async () => {
    const sent = stub([{ match: `/search/jobs/${LAKE}.run-7`, body: { items: [run({ id: `${LAKE}.run-7` })] } }])
    const r = await runMeta(`${LAKE}.run-7`)
    expect(sent[0].url).toBe(`/capi${JOBS_PATH}/${LAKE}.run-7`)
    expect(r.run?.id).toBe(`${LAKE}.run-7`)
    expect(r.error).toBeNull()
  })

  it('encodes an id it did not choose', async () => {
    const sent = stub([{ match: '/search/jobs/', body: { items: [] } }])
    await runMeta('a b/c')
    expect(sent[0].url).toBe(`/capi${JOBS_PATH}/a%20b%2Fc`)
  })

  it('answers with an error rather than a null run nobody checks', async () => {
    stub([{ match: '/search/jobs/', status: 404, body: { message: 'gone' } }])
    expect((await runMeta('missing')).error).toBeTruthy()
    vi.unstubAllGlobals()
    stub([{ match: '/search/jobs/', body: { items: [] } }])
    const r = await runMeta('missing')
    expect(r.run).toBeNull()
    expect(r.error).toBeTruthy()
  })
})

describe('the whole manifest', () => {
  it('reports every entry by default, so a third one appears the day it is added', async () => {
    stub([history([run()]), metrics(2)])
    const all = await allAccelStatus()
    expect(all.map((s) => s.id)).toEqual(MANIFEST.map((e) => e.id))
    expect(all.every((s) => s.error === null)).toBe(true)
  })

  it('carries the manifest’s own cron into every status', async () => {
    stub([history([])])
    const [lake, sample] = await allAccelStatus()
    expect(lake.expectedIntervalMs).toBe(DAY)
    expect(sample.expectedIntervalMs).toBe(HOUR)
  })
})

describe('listRuns, which the read path uses on its own', () => {
  it('lists without touching the meter, because the panel never shows that number', async () => {
    const sent = stub([history([run()]), metrics(1)])
    const listed = await listRuns(LAKE)
    expect(listed.runs).toHaveLength(1)
    expect(sent.some((c) => c.url.includes('/metrics')), 'a metrics read per panel paint').toBe(false)
  })
})


// ── The timeline ────────────────────────────────────────────────────────────
//
// What turns a job history into a list of past states a viewer can pick from,
// and the three ways that list could be a lie: it could offer a run whose result
// cannot be read, it could answer a question about the past with a later run, or
// it could claim a reach the platform does not give it.

describe('the readable past', () => {
  const at = (ms: number) => ({ timeCreated: ms, timeStarted: ms, timeCompleted: ms })
  const okRun = (id: string, ms: number, owner: string = LAKE) => ({
    id: `${owner}.${id}`,
    status: 'completed',
    ...at(ms),
  })
  const T = T0

  it('offers only runs whose results can actually be read', async () => {
    // A running job's results are not readable and a failed one's are partial —
    // read.ts refuses both, with its reasons. A time in the picker that answers
    // nothing is a control that looks broken.
    stub([
      history([
        { id: `${LAKE}.a`, status: 'running', ...at(T) },
        { id: `${LAKE}.b`, status: 'failed', ...at(T - HOUR) },
        { id: `${LAKE}.c`, status: 'canceled', ...at(T - 2 * HOUR) },
        okRun('d', T - 3 * HOUR),
      ]),
    ])
    const timeline = await snapshotTimeline([LAKE])
    expect(timeline.entries[0].runs.map((r) => r.id)).toEqual([`${LAKE}.d`])
    expect(timeline.times).toEqual([T - 3 * HOUR])
  })

  it('skips a run with no usable timestamp rather than dating it from zero', async () => {
    stub([history([{ id: `${LAKE}.undated`, status: 'completed' }, okRun('b', T - HOUR)])])
    const timeline = await snapshotTimeline([LAKE])
    expect(timeline.entries[0].runs.map((r) => r.id)).toEqual([`${LAKE}.b`])
  })

  it('answers a moment with the newest run that had finished by then', async () => {
    stub([history([okRun('newer', T), okRun('older', T - HOUR)])])
    const timeline = await snapshotTimeline([LAKE])
    const mine = timeline.entries[0]
    expect(runAtOrBefore(mine, T - 1)?.id).toBe(`${LAKE}.older`)
    expect(runAtOrBefore(mine, T)?.id).toBe(`${LAKE}.newer`)
    // The one that matters: a run that finished later did not exist then.
    expect(runAtOrBefore(mine, T - HOUR - 1)).toBe(null)
  })

  it('offers a nearest in either direction, which is a different question', async () => {
    // `runAtOrBefore` is what a panel READS; `nearestRun` is what it OFFERS when
    // it has nothing. Conflating them would put a later run on screen under an
    // earlier heading.
    stub([history([okRun('newer', T), okRun('older', T - 4 * HOUR)])])
    const mine = (await snapshotTimeline([LAKE])).entries[0]
    expect(nearestRun(mine, T - HOUR)?.id).toBe(`${LAKE}.newer`)
    expect(nearestRun(mine, T - 10 * HOUR)?.id).toBe(`${LAKE}.older`)
  })

  it('merges the times of schedules that do not align, newest first', async () => {
    // The hourly entries fire at :20, :21 and :22 and the Lake total once a day.
    // One list of times drawn from schedules that do not agree is the honest
    // shape: each panel then answers from its own entry's newest run at or
    // before the moment, and the picker says how many answered.
    // Both schedules' runs arrive in ONE unfiltered job list — that is what the
    // platform returns now that nothing filters server-side — and the prefix is
    // what tells them apart.
    stub([
      history([okRun('a', T - 5 * HOUR, LAKE), okRun('b', T - HOUR, SAMPLE)]),
    ])
    const timeline = await snapshotTimeline([LAKE, SAMPLE])
    expect(timeline.times).toEqual([T - HOUR, T - 5 * HOUR])
    expect(timeline.oldestAt).toBe(T - 5 * HOUR)
  })

  it('says which limit ends the timeline', () => {
    // Two things bound it and they are different limits. `keepLastN × cadence`
    // is what the app asked for; Cribl's seven-day result retention is what the
    // platform allows. Whichever is shorter is the real horizon, and an hourly
    // entry keeping 24 runs is well inside the platform's.
    expect(timelineHorizon('gno_overview_c1h')).toEqual({ ms: 24 * HOUR, boundBy: 'keepLastN' })
    expect(timelineHorizon(LAKE)).toEqual({ ms: 2 * 24 * HOUR, boundBy: 'keepLastN' })
  })

  it('reports a refusal as a refusal, never as an empty past', async () => {
    // The jobWatchdog lesson again: a 403 and a schedule that has never fired
    // both produce zero rows, and only `error` separates them. A picker that
    // laundered the first into the second would tell an operator their schedules
    // are dead.
    stub([{ match: '/search/jobs?', status: 403, body: { message: 'no' } }])
    const timeline = await snapshotTimeline([LAKE])
    expect(timeline.denied).toBe(true)
    expect(timeline.error).toBeTruthy()
    expect(timeline.times).toEqual([])
  })

  it('refuses the whole timeline when the one list read behind it is refused', async () => {
    // REWRITTEN 2026-09-18, and the old test is worth knowing about. It read
    // "does not call the whole timeline refused because one entry was", and it
    // was meaningful while each entry fetched its OWN filtered request
    // (`correlationId=<id>`): one entry could be refused and the others answer.
    //
    // That request does not exist. `correlationId` never carried the saved
    // search's id — measured live on 2026-09-18 — so every entry now reads the
    // same unfiltered job list and separates its own runs by the job-id prefix.
    // One 403 is therefore every entry's 403, and a partial denial is not a state
    // this code can reach. Asserting the old behaviour would be asserting an
    // architecture that is gone.
    //
    // What still matters, and is what the jobWatchdog lesson was about: a refusal
    // must not launder into "no runs". It is `denied`, with an error.
    stub([{ match: '/search/jobs?', status: 403, body: { message: 'no' } }])
    const timeline = await snapshotTimeline([LAKE, SAMPLE])
    expect(timeline.denied).toBe(true)
    expect(timeline.error).toBeTruthy()
    expect(timeline.times).toEqual([])
  })

  it('asks for more runs than the largest schedule retains', async () => {
    // The hourly entries keep 24. A 20-row page would have hidden the oldest
    // four, leaving a timeline that claims to be a day and is not, with nothing
    // on screen saying which end was cut.
    const sent = stub([history([])])
    await snapshotTimeline([LAKE])
    const url = sent[0].url
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(Math.max(...MANIFEST.map((e) => e.keepLastN)))
    expect(url).toContain(`limit=${HISTORY_LIMIT}`)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//   * That a scheduled run's `correlationId` IS the saved search's id. No run of
//     ours has ever existed — constraint 8 forbids creating one — so the query
//     shape is checked and its effect is not. The failure direction is safe: a
//     correlationId that matches nothing reports "never run", which makes
//     accel/read.ts spend a live query. It can never date a stale number.
//   * That `output=short` includes `timeCompleted`. The parse falls back through
//     started and created when it does not, and both paths are tested — but
//     which one the live API takes is unknown until Preview.
//   * That `sortDir=desc` survives the platform's fetch proxy. The re-sort above
//     is there precisely because that cannot be asserted from here.
//   * Anything about whether Cribl accepts the metrics path for a scheduled job
//     rather than an interactive one.
