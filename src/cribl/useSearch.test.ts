// What a panel receives from an accelerated hook, and what it costs to get it.
//
// The claims worth testing here are the ones a reader of the code cannot check
// by eye, and every one of them is about MONEY or HONESTY:
//
//   * THE EXPENSIVE QUERY DOES NOT RUN when a usable stored result exists. Data
//     Flow's 30-day total bills 9,297.7 CPU-s a run; the whole phase is one
//     assertion that no live job was submitted. So these tests count submits,
//     not calls.
//   * THE FALLBACK IS NORMAL. No run yet, a run still going, a run that failed —
//     every one of them has to answer with the right number at the old price,
//     because that is what a fresh install looks like before anybody presses
//     Apply.
//   * A STALE RESULT IS SHOWN AND DATED, NOT REPLACED. Falling back on staleness
//     would reinstate the expensive query at the exact moment the schedule broke.
//   * CRIBL'S WORDS NEVER REACH THE PANEL. `state.error` is rendered verbatim by
//     <QueryBoundary>, and a failed `$vt_results` read throws an error carrying
//     Cribl's echo of a query the customer never wrote.
//   * THE RANGE PICKER DOES NOT RE-RUN AN ACCELERATED HOOK. A `$vt_results` read
//     ignores the picker, so a re-run submits a job to receive identical rows.
//
// They run the REAL accel/read.ts and cribl/search.ts with `fetch` stubbed —
// the house pattern from search.test.ts and accel/read.test.ts — because "which
// job did this hook submit" is a claim about bytes, and a mocked read module
// would assert only the arguments this file passes.
//
// No JSX: this file is named .test.ts by the slice brief, so the probe component
// is built with createElement. Nothing about the hook depends on which.

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider, TIME_RANGES, useDashboard, type TimeRange } from '../app/DashboardContext'
import type { Row } from './search'
import { NOTES } from './accel/read'
import { useSearch, type UseSearchState } from './useSearch'

const LAKE = 'gno_lake_30d_c1d'
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Fixed, because a run's timestamp is asserted exactly: `Date.now()` evaluated
 *  twice is two different runs. */
const NOW = Date.now()

/** The stored row, as `$vt_results` hands it back: the body's own fields plus
 *  the three virtual columns the platform adds. */
const STORED: Row = {
  total_events: 18_240_113,
  total_bytes: 9_412_886_144,
  jobId: 'run-1',
  jobName: LAKE,
  dataset: '$vt_results',
}
/** What the same query returns when it is actually run. Deliberately a different
 *  number, so "which path answered" is visible in the rows themselves. */
const LIVE: Row = { total_events: 18_301_990, total_bytes: 9_444_001_280 }

const run = (over: Record<string, unknown> = {}) => ({
  // `<savedSearchId>.<suffix>` — the shape the platform emits, and what
  // listRuns selects a schedule’s runs by. Measured live 2026-09-18.
  id: `${LAKE}.run-1`,
  status: 'completed',
  timeCreated: NOW - HOUR,
  timeStarted: NOW - HOUR,
  timeCompleted: NOW - HOUR,
  ...over,
})

interface Cfg {
  /** Rows the `$vt_results` read returns. */
  stored?: Row[]
  /** Rows a live run of the panel's own query returns. */
  live?: Row[]
  /** Fail the `$vt_results` submit with this status and body. */
  storedFail?: { status: number; body: unknown }
  /** The schedule's run history, newest first. */
  history?: unknown[]
  /** Runs addressable by id, for the read that dates a result. */
  jobs?: Record<string, Record<string, unknown>>
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

/** Every job body this render submitted, in order. */
let submits: Submitted[] = []

function stub(cfg: Cfg): void {
  submits = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    if (method === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const isStored = body.query.includes('$vt_results')
      if (isStored && cfg.storedFail) return res(cfg.storedFail.status, cfg.storedFail.body)
      return res(200, { items: [{ id: isStored ? 'job-stored' : 'job-live' }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const rows = u.includes('job-stored') ? (cfg.stored ?? []) : (cfg.live ?? [])
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) {
      const job = cfg.jobs?.[byId[1]]
      return job ? res(200, { items: [job] }) : res(404, { message: 'gone' })
    }
    return res(404, { message: 'unrouted' })
  })
}

const stored = (s: Submitted[]) => s.filter((x) => x.query.includes('$vt_results'))
const liveSubmits = (s: Submitted[]) => s.filter((x) => !x.query.includes('$vt_results'))

/** A healthy schedule: one recent completed run, and rows to read from it. */
const healthy: Cfg = { stored: [STORED], live: [LIVE], history: [run()], jobs: { 'run-1': run() } }

let container: HTMLDivElement
let root: Root
/** The last state the probe rendered, and the page's range setter. */
let seen: UseSearchState | null = null
let setRange: ((r: TimeRange) => void) | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  seen = null
  setRange = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const QUERY = 'dataset="cribl_metrics" | summarize total_events=count()'

function Probe({ accel, accelEnabled }: { accel?: 'gno_lake_30d_c1d'; accelEnabled?: boolean }): ReactNode {
  const dash = useDashboard()
  setRange = dash.setRange
  seen = useSearch(QUERY, { earliest: accel ? '-30d' : undefined, accel, accelEnabled })
  return null
}

/** Render the probe and let every promise the read chain makes settle. */
async function render(props: { accel?: 'gno_lake_30d_c1d'; accelEnabled?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(DashboardProvider, null, createElement(Probe, props)))
  })
  await settle()
}

/** The read path is four awaits deep (submit, poll, results, date); a handful of
 *  microtask turns is what it takes for the last setState to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
}

describe('an accelerated panel', () => {
  it('reads the scheduled run and never submits the expensive query', async () => {
    stub(healthy)
    await render({ accel: LAKE })

    expect(seen!.source).toBe('schedule')
    expect(seen!.outcome).toBe('fresh')
    expect(seen!.rows).toEqual([{ total_events: 18_240_113, total_bytes: 9_412_886_144 }])
    expect(liveSubmits(submits), 'the 9,297.7 CPU-s query ran anyway').toEqual([])
    expect(stored(submits)).toHaveLength(1)
  })

  it('dates every figure it takes from a stored run', async () => {
    // The panel is required to print this; a stored number with no time on it is
    // the one failure mode acceleration introduces that a reader cannot see.
    stub(healthy)
    await render({ accel: LAKE })
    expect(seen!.at).toBe(run().timeCompleted)
    expect(seen!.note).toBe(NOTES.fresh)
  })

  it('strips the columns $vt_results adds, which the query never produced', async () => {
    stub(healthy)
    await render({ accel: LAKE })
    for (const col of ['jobId', 'jobName', 'dataset']) expect(seen!.rows[0]).not.toHaveProperty(col)
  })
})

describe('falling back to the live query', () => {
  it('runs it when the schedule has never produced a result', async () => {
    // A fresh install, before anybody presses Apply. Not an error state.
    stub({ ...healthy, stored: [], history: [] })
    await render({ accel: LAKE })

    expect(seen!.outcome).toBe('no-run')
    expect(seen!.source).toBe('live')
    expect(seen!.rows).toEqual([LIVE])
    expect(seen!.error).toBeNull()
    expect(liveSubmits(submits)).toHaveLength(1)
  })

  it('runs it when the last scheduled run failed, rather than reading a partial result', async () => {
    // A partial 30-day sum is a smaller Lake — indistinguishable on screen from
    // data having been deleted. One live run is the right price for that.
    stub({ ...healthy, stored: [], history: [run({ status: 'failed' })] })
    await render({ accel: LAKE })

    expect(seen!.outcome).toBe('run-failed')
    expect(seen!.rows).toEqual([LIVE])
  })

  it('runs it when the newest run is still going', async () => {
    stub({ ...healthy, stored: [], history: [run({ status: 'running', timeCompleted: 0 })] })
    await render({ accel: LAKE })
    expect(seen!.outcome).toBe('run-pending')
    expect(seen!.source).toBe('live')
  })

  it('carries the live query, at the panel’s own window, in the job body', async () => {
    stub({ ...healthy, stored: [], history: [] })
    await render({ accel: LAKE })
    const live = liveSubmits(submits)[0]
    expect(live.query.endsWith(QUERY), 'the fallback altered the panel’s query').toBe(true)
    expect([live.earliest, live.latest]).toEqual(['-30d', 'now'])
  })
})

describe('a stale scheduled run', () => {
  it('is shown and dated rather than replaced by a live query', async () => {
    // Falling back here sounds safer and is worse: it silently reinstates the
    // expensive query at the moment the schedule breaks — invisibly, on every
    // paint. The loud part belongs in the status table, not in the bill.
    const old = { ...run(), timeCompleted: NOW - 5 * DAY }
    stub({ ...healthy, history: [old], jobs: { 'run-1': old } })
    await render({ accel: LAKE })

    expect(seen!.source).toBe('schedule')
    expect(seen!.stale).toBe(true)
    expect(seen!.outcome).toBe('stale')
    expect(seen!.at).toBe(old.timeCompleted)
    expect(seen!.note).toBe(NOTES.stale)
    expect(liveSubmits(submits), 'a stale result cost a live 30-day scan').toEqual([])
  })
})

describe('what a failed fast read is allowed to say', () => {
  it('never hands the panel Cribl’s words', async () => {
    // search.ts throws `Cribl API 400 Bad Request — <body>` and <QueryBoundary>
    // renders state.error verbatim, so this body is one string away from a
    // customer's panel — a query they never wrote, about an object they may not
    // know exists, as the explanation for a missing chart.
    stub({
      ...healthy,
      storedFail: { status: 400, body: { message: 'Error in query: dataset="$vt_results" jobName="gno_lake_30d_c1d"' } },
    })
    await render({ accel: LAKE })

    expect(seen!.outcome).toBe('unreadable')
    expect(seen!.rows).toEqual([LIVE])
    expect(seen!.error).toBeNull()
    for (const text of [seen!.note ?? '', seen!.error ?? '', seen!.errorTitle ?? '']) {
      expect(text).not.toContain('$vt_results')
      expect(text).not.toContain('Cribl API')
      expect(text).not.toContain('400')
    }
  })

  it('still reports a failure of the LIVE query, which is a panel with no number', async () => {
    // The fallback is deliberately not caught: "Cribl is down" must not read as
    // an empty chart with a reassuring note beside it. A 400 rather than a 500,
    // so search.ts answers at once instead of spending its 429/5xx backoff.
    stub({ stored: [], history: [], live: undefined })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = String(url)
      if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
        const body = JSON.parse(String(init.body)) as Submitted
        submits.push(body)
        if (body.query.includes('$vt_results')) return res(200, { items: [{ id: 'job-stored' }] })
        return res(400, { message: 'engine unavailable' })
      }
      if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
      if (u.includes('/results')) return res(200, {}, JSON.stringify({ totalEventCount: 0, job: 'j' }))
      if (u.includes('/search/jobs?')) return res(200, { items: [] })
      return res(404, { message: 'unrouted' })
    })
    await render({ accel: LAKE })

    expect(seen!.error).toBeTruthy()
    expect(seen!.rows).toEqual([])
  })
})

describe('the range picker', () => {
  it('does not re-run an accelerated panel', async () => {
    // A $vt_results read ignores the picker, so a re-run would submit a job to
    // receive the identical stored rows — and a range change would also change
    // what the live FALLBACK means.
    stub(healthy)
    await render({ accel: LAKE })
    expect(stored(submits)).toHaveLength(1)

    await act(async () => { setRange!(TIME_RANGES[5]) })
    await settle()

    expect(stored(submits), 'the stored result was read again for a range that cannot affect it').toHaveLength(1)
    expect(liveSubmits(submits)).toEqual([])
  })

  it('still re-runs an ordinary panel, which is what it is for', async () => {
    stub({ live: [LIVE] })
    await render({})
    expect(liveSubmits(submits)).toHaveLength(1)

    await act(async () => { setRange!(TIME_RANGES[5]) })
    await settle()

    expect(liveSubmits(submits)).toHaveLength(2)
    expect(liveSubmits(submits)[1].earliest).toBe(TIME_RANGES[5].earliest)
  })
})

describe('turning acceleration off for this viewer', () => {
  it('sends the panel straight to its live query, and says so', async () => {
    // The escape hatch, and its price: this is the 9,297.7 CPU-s run, by choice.
    stub(healthy)
    await render({ accel: LAKE, accelEnabled: false })

    expect(seen!.source).toBe('live')
    expect(seen!.outcome).toBe('off')
    expect(seen!.note).toBe(NOTES.off)
    expect(seen!.rows).toEqual([LIVE])
    expect(stored(submits), 'a panel with acceleration off still read the stored result').toEqual([])
    expect(liveSubmits(submits)).toHaveLength(1)
  })

  it('re-runs when the viewer flips it back on', async () => {
    stub(healthy)
    await render({ accel: LAKE, accelEnabled: false })
    await act(async () => {
      root.render(createElement(DashboardProvider, null, createElement(Probe, { accel: LAKE, accelEnabled: true })))
    })
    await settle()

    expect(seen!.source).toBe('schedule')
    expect(stored(submits)).toHaveLength(1)
  })
})

describe('an unaccelerated panel', () => {
  it('reports itself as live and claims no provenance it does not have', async () => {
    // `outcome: null` and `outcome: 'no-run'` are different states: "this panel
    // has no schedule" must not read as "its schedule has never fired".
    stub({ live: [LIVE] })
    await render({})

    expect(seen!.source).toBe('live')
    expect(seen!.outcome).toBeNull()
    expect(seen!.at).toBeNull()
    expect(seen!.stale).toBe(false)
    expect(seen!.note).toBeNull()
    expect(seen!.totalEventCount).toBe(1)
  })

  it('still reports the live job’s totalEventCount, which a stored read has none of', async () => {
    stub({ live: [LIVE, LIVE, LIVE] })
    await render({})
    expect(seen!.totalEventCount).toBe(3)
  })
})

describe('a per-panel refresh', () => {
  it('re-reads the stored result — cheap, and the point of the button', async () => {
    stub(healthy)
    await render({ accel: LAKE })
    expect(stored(submits)).toHaveLength(1)

    await act(async () => { seen!.refetch() })
    await settle()

    expect(stored(submits)).toHaveLength(2)
    expect(liveSubmits(submits)).toEqual([])
  })
})

// ── What these tests do NOT establish ───────────────────────────────────────
//
//   * That Cribl returns the newest run for a `jobName=` selector when
//     keepLastN is above one. The stub answers with the run the rows name; on
//     Cribl 4.19.2 a multi-job selector picks ONE job and nothing says which.
//     If it picks the oldest, an accelerated panel sits a cadence behind — and
//     says so, correctly, because it dates whichever run answered.
//   * That a scheduled run's `correlationId` is the saved search's id. Every
//     history read here is stubbed; accel/status.ts rests on that and it is
//     unverifiable until the first real Apply (constraint 8). The failure
//     direction is safe: no rows → 'no-run' → the live query, loudly.
//   * Anything about layout. happy-dom has no layout, so "the panel renders its
//     date" is asserted in the tab tests by reading text, never by seeing it.
