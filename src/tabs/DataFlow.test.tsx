// The Cribl Lake card, once its figure can be a day old.
//
// This card carries the most expensive number in the app: 9,297.7 billable
// CPU-s a run, 15–24 times a day, to total thirty days of Stream write
// counters. Phase 2 points it at a daily scheduled run of the same query. The
// two things that can go wrong are not "the number is wrong" — it is the same
// query, over the same window — they are:
//
//   * THE EXPENSIVE QUERY RUNS ANYWAY, because something re-triggered the hook
//     or the read quietly fell back. That is a bill, and it is invisible on
//     screen, so it is asserted by counting submitted jobs.
//   * THE CARD SHOWS A STORED FIGURE WITH NO DATE ON IT. Every other figure on
//     this page answers for the range picker; this one answers for whenever the
//     schedule last fired, and a schedule that has stopped leaves a plausible
//     number on screen indefinitely.
//
// The diagram itself is not under test here — DopDiagram has its own file. What
// is under test is the one label line the card gets, and the ⓘ behind it.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetDataMode, setDataMode } from '../cribl/dataMode'
import { accelEntry } from '../cribl/accel/manifest'
import type { Row } from '../cribl/search'
import { resetSnapshotCensus, useSnapshotCensus, type SnapshotCensus } from '../components/snapshotCensus'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { LAKE_TOTAL_QUERY } from '../queries/dataFlow'
import { DataFlow, LAKE_CADENCE, PIPELINE_CADENCE, PIPELINE_WINDOW, lakeComputed, lakeHeldLabel } from './DataFlow'

const LAKE = 'gno_lake_30d_c1d'
const HOUR = 3_600_000
const NOW = Date.now()

/** The stored row as `$vt_results` hands it back, virtual columns and all. */
const STORED: Row = {
  total_events: 18_240_113,
  total_bytes: 9_412_886_144,
  jobId: 'run-1',
  jobName: LAKE,
  dataset: '$vt_results',
}
const LIVE: Row = { total_events: 18_301_990, total_bytes: 9_444_001_280 }

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  status: 'completed',
  timeCreated: NOW - HOUR,
  timeStarted: NOW - HOUR,
  timeCompleted: NOW - HOUR,
  ...over,
})

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

let submits: Submitted[] = []

function stub(cfg: { stored?: Row[]; history?: unknown[] } = {}): void {
  submits = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      return res(200, { items: [{ id: body.query.includes('$vt_results') ? 'job-stored' : 'job-live' }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const rows = u.includes('job-stored') ? (cfg.stored ?? [STORED]) : [LIVE]
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

/** The 30-day total as a live job — the query this phase exists to stop running. */
// The Lake total, matched on its own full text. `total_bytes=sum(` alone also
// matches the record-volume query, and the output filter the stage counters —
// both of which run live in Live mode by right.
const lakeLiveSubmits = () =>
  submits.filter((s) => s.query.includes(LAKE_TOTAL_QUERY) && !s.query.includes('$vt_results'))
const storedSubmits = () => submits.filter((s) => s.query.includes('$vt_results'))
// The Lake tile's own stored read. This tab now has two accelerated hooks — the
// volume figures read the hourly overview scan — so "a stored read happened" is
// no longer the same claim as "the Lake tile read its own run".
const lakeStoredSubmits = () => storedSubmits().filter((s) => s.query.includes('gno_lake_30d_c1d'))

let census: SnapshotCensus | null = null
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  census = null
  resetSnapshotCensus()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  resetSnapshotCensus()
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <DashboardProvider>
        <Census />
        <DataFlow />
      </DashboardProvider>,
    )
  })
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve() })
}

/** Reads the header's census without rendering the app header. */
function Census() {
  census = useSnapshotCensus()
  return null
}

const cardLabels = () => [...container.querySelectorAll('.dop-card-label')].map((t) => t.textContent ?? '')

describe('the Cribl Lake card', () => {
  it('reads the scheduled run and dates the figure on the card itself', async () => {
    stub()
    await render()

    const dated = cardLabels().find((l) => l.includes('as of'))
    expect(dated, `the card showed a stored figure with no date on it: ${cardLabels().join(' | ')}`).toBeDefined()
    expect(dated).toMatch(/events held · as of \d{2}:\d{2}/)
    expect(lakeLiveSubmits(), 'the 9,297.7 CPU-s query ran anyway').toEqual([])
    expect(lakeStoredSubmits()).toHaveLength(1)
  })

  it('reads the daily run in LIVE mode too — no 30-day scan on a Live page', async () => {
    // Measured 2026-09-23: live, this card re-scanned thirty days on every
    // Refresh (33.5 s) after every other number had rendered, to move a
    // monthly total by minutes of data.
    stub()
    act(() => setDataMode('live'))
    try {
      await render()
      expect(lakeLiveSubmits(), 'the 30-day scan ran in Live mode').toEqual([])
      expect(cardLabels().find((l) => l.includes('as of')), 'the Live card was not dated').toBeDefined()
      expect(container.textContent).toContain('from a scheduled daily run')
    } finally {
      resetDataMode()
    }
  })

  it('says on the page that the card is not reading the range picker', async () => {
    stub()
    await render()
    expect(container.textContent).toContain('from a scheduled daily run')
  })

  it('falls back to totalling thirty days when nothing has been scheduled yet', async () => {
    // A fresh install. The card behaves exactly as it did before Phase 2, and
    // says so instead of dating a number it did not take from a run.
    stub({ stored: [], history: [] })
    await render()

    expect(lakeLiveSubmits()).toHaveLength(1)
    expect(lakeLiveSubmits()[0].earliest).toBe('-30d')
    expect(cardLabels().some((l) => l.includes('as of')), 'a live figure was dated as if it came from a run').toBe(false)
    expect(cardLabels().some((l) => l.includes('30d retention'))).toBe(true)
  })

  it('explains in its ⓘ how the figure was computed, without changing the query', async () => {
    stub()
    await render()
    // The last ⓘ on the page belongs to the selected stage; the diagram's own
    // are in document order, and the Cribl Lake card's is the one carrying the
    // fourth block.
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.pinfo-btn')]
    let found = ''
    for (const btn of buttons) {
      act(() => btn.click())
      const text = document.querySelector('.pinfo-pop')?.textContent ?? ''
      if (text.includes('How this was computed')) found = text
      act(() => btn.click())
    }
    expect(found, 'no ⓘ on this tab says how the Lake total was computed').not.toBe('')
    expect(found).toContain(LAKE_CADENCE)
    expect(found).toContain('the last 30 days')
    expect(found, 'the ⓘ does not say how to get a live figure').toContain('Open in Search')
  })
})

describe('what the header says about this tab', () => {
  it('counts the two things on this tab that read a query, and the one served from a run', async () => {
    // THE SENTENCE THIS REPLACED. The census registers inside <Panel>, and this
    // tab renders none — it draws a diagram and a stage-detail card. So nothing
    // registered, `census.panels` was 0, and the header read
    // `Snapshot · nothing on this tab reads a query` on the tab that motivated
    // the whole phase: three searches run here and two are served by schedules.
    //
    // Two slots, matching the two provenances the tab's own toolbar names:
    //   * the diagram's volumes — record-derived (hourly) mixed with Cribl's own
    //     telemetry (never scheduled). Merged, so it reports LIVE. A picture half
    //     of which ran a moment ago may not carry a snapshot date.
    //   * the Cribl Lake card, served by its own daily run.
    stub()
    await render()

    expect(census!.panels, 'the tab that motivated the phase reports no panels at all').toBe(2)
    expect(census!.snapshotted, 'the Lake card is served from a run and is not counted as one').toBe(1)
    expect(census!.oldest, 'a counted snapshot contributed no time, so the header can date nothing').not.toBeNull()
  })

  it('claims no snapshot on a fresh install, where nothing has been scheduled yet', async () => {
    // The denominator still stands up and says two: the queries exist and run,
    // they are simply all live. `0 of 2` is the honest reading, and it is the
    // one that climbs visibly when an admin applies the schedules.
    stub({ stored: [], history: [] })
    await render()

    expect(census!.panels).toBe(2)
    expect(census!.snapshotted, 'a live 30-day total was counted as a snapshot').toBe(0)
    expect(census!.oldest).toBeNull()
  })
})

describe('lakeHeldLabel', () => {
  const held = { lakeTotalEvents: 18_240_113, lakeTotalAt: NOW - HOUR, lakeTotalStale: false }

  it('keeps the retention line when the figure was computed live', () => {
    expect(lakeHeldLabel({ ...held, lakeTotalAt: null }, NOW)).toBe('18.2M events held · 30d retention')
  })

  it('trades that line for the date when the figure came from a run', () => {
    // One line only: the card's label band is 12px per line and the provenance
    // chip sits directly under it, so a second line lands on top of the chip.
    expect(lakeHeldLabel(held, NOW)).toMatch(/^18\.2M events held · as of \d{2}:\d{2}$/)
  })

  it('marks an overdue schedule on the card, not only in the ⓘ', () => {
    expect(lakeHeldLabel({ ...held, lakeTotalStale: true }, NOW)).toContain('(overdue)')
  })
})

describe('lakeComputed', () => {
  const state = { source: 'schedule' as const, at: NOW - HOUR, stale: false, note: 'From the scheduled run.' }

  it('carries the cap in seconds for the window this query actually reads', () => {
    // -30d lands in the widest cap tier; block 4 turns it into words.
    expect(lakeComputed(state).capSeconds).toBe(900)
  })

  it('points at Cribl Search rather than offering the live run as a click', () => {
    // A live run of this query bills 9,297.7 CPU-s. Offering it as a button
    // beside the card would hand every viewer the cost this phase removes.
    expect(lakeComputed(state).live).toContain('Open in Search')
  })
})

describe('the words about the schedule agree with the manifest', () => {
  it('quotes the cron this app actually writes', () => {
    // The cadence is prose and the cron is data; nothing but this holds them
    // together. `10 0 * * *` in UTC is "once a day, at 00:10 UTC".
    const entry = accelEntry(LAKE)
    expect(entry.cron).toBe('10 0 * * *')
    expect(entry.tz).toBe('UTC')
    expect(LAKE_CADENCE).toBe('once a day, at 00:10 UTC')
    expect(entry.earliest).toBe('-30d')
  })
})

// ── The Cribl stage counters, once they come from a schedule too ────────────
//
// `gno_pipeline_c1h` was the last live query on this tab. The stub above cannot
// exercise it, and that is not an oversight: it stamps every stored row with the
// LAKE schedule's name, so read.ts rejects the rows for any other entry and both
// other hooks fall back to live. That is the right stub for the Lake card and
// the wrong one for this, so this block brings its own — one that answers each
// schedule with its own rows, the way a workspace with all three applied does.

const PIPELINE = 'gno_pipeline_c1h'
const OVERVIEW = 'gno_overview_c1h'

/** Events in the run's window, chosen so the rate below is a round 290/s. */
const WINDOW_EVENTS = 261_000

const ROWS_BY_SCHEDULE: Record<string, Row> = {
  [OVERVIEW]: { events: WINDOW_EVENTS, bytes: 1_200_000_000, packets: 2_000_000 },
  [PIPELINE]: {
    src_events: WINDOW_EVENTS, pipe_events: WINDOW_EVENTS, dst_events: WINDOW_EVENTS,
    dst_bytes: 1_200_000_000, blocked: 0, backpressure: 0,
  },
  [LAKE]: { total_events: 18_240_113, total_bytes: 9_412_886_144 },
}

/** Which schedule a stored read asked for. The predicate is mandatory, so it is
 *  always there to read. */
const scheduleOf = (query: string) => /jobName="([^"]+)"/.exec(query)?.[1] ?? ''

function stubAllApplied(): void {
  submits = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const id = body.query.includes('$vt_results') ? `job-${scheduleOf(body.query)}` : 'job-live'
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const name = Object.keys(ROWS_BY_SCHEDULE).find((n) => u.includes(`job-${n}`))
      const rows: Row[] = name
        ? [{ ...ROWS_BY_SCHEDULE[name], jobId: 'run-1', jobName: name, dataset: '$vt_results' }]
        : [LIVE]
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

/** A live run of the stage counters — the query this entry replaces. */
const metricsLiveSubmits = () =>
  submits.filter((s) => s.query.includes('pipe.in_events') && !s.query.includes('$vt_results'))

/** Sets the range picker, which is what the diagram's volumes follow when they
 *  are live — and deliberately do not when they are served. */
async function pickRange(label: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>('.range-select')!
  await act(async () => {
    select.value = label
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve() })
}

describe('the Cribl stage counters', () => {
  it('reads its own hourly run instead of the last live query on this tab', async () => {
    stubAllApplied()
    await render()

    expect(metricsLiveSubmits(), 'the stage counters ran live anyway').toEqual([])
    expect(submits.filter((s) => scheduleOf(s.query) === PIPELINE)).toHaveLength(1)
  })

  it('reports the whole diagram as a snapshot, because both of its sides are one', async () => {
    // THE SENTENCE THIS REPLACED: "Merged, so it reports LIVE". That was correct
    // while the counters were live — a picture half of which ran a moment ago
    // may not carry a snapshot date — and it stopped being correct the moment
    // this entry landed. The merge still reports the OLDER of the two runs, and
    // still drops to live if either falls back.
    stubAllApplied()
    await render()

    expect(census!.panels).toBe(2)
    expect(census!.snapshotted, 'the diagram is served on both sides and is not counted as one').toBe(2)
  })

  it('divides by the window the counters were counted over, not by the picker', async () => {
    // THE BUG THIS EXISTS TO CATCH, and it is a wrong number rather than a
    // missing one. The Sources plate reports events/second: a count over the
    // schedule's fifteen minutes divided by the picker's twenty-four hours
    // reads 3/s instead of 290/s — ninety-six times low, formatted exactly like
    // a correct figure, on a plate whose whole job is to say whether data is
    // flowing.
    stubAllApplied()
    await render()
    expect(cardLabels().some((l) => l.includes('290/s')), cardLabels().join(' | ')).toBe(true)

    await pickRange('Last 24 hours')
    expect(cardLabels().some((l) => l.includes('290/s')), `the rate followed the picker: ${cardLabels().join(' | ')}`).toBe(true)
  })

  it('labels the stage card with the window the figure came from', async () => {
    // Same mislabelling, in words rather than arithmetic: "events into Lake ·
    // last 24 hours" under a figure that counted fifteen minutes.
    stubAllApplied()
    await render()
    await pickRange('Last 24 hours')

    const note = container.querySelector('.panel-note')?.textContent ?? ''
    expect(note).toContain('hourly snapshot')
    expect(note, 'a fifteen-minute counter was labelled with the picker range').not.toContain('last 24 hours')
  })

  it('still follows the picker when nothing has been scheduled', async () => {
    // A fresh install: the counters run live, over the range on screen, exactly
    // as they did before this entry existed.
    stub({ stored: [], history: [] })
    await render()

    expect(metricsLiveSubmits()).toHaveLength(1)
    expect(container.querySelector('.panel-note')?.textContent ?? '').toContain('last 15 minutes')
  })
})

describe('the words about the telemetry schedule agree with the manifest', () => {
  it('quotes the cron and the window this app actually writes', () => {
    const entry = accelEntry(PIPELINE)
    expect(entry.cron).toBe('24 * * * *')
    expect(entry.tz).toBe('UTC')
    expect(PIPELINE_CADENCE).toContain('24 minutes past')
    // The window is not a preference here: it is the overview scan's window,
    // because the diagram's claim is that the two sides agree. Pin them
    // together so that moving one moves the other.
    expect(entry.earliest).toBe(accelEntry(OVERVIEW).earliest)
    expect(entry.latest).toBe(accelEntry(OVERVIEW).latest)
    expect(PIPELINE_WINDOW).toBe(SNAPSHOT_WINDOW)
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That the dated label FITS on the card. happy-dom reports every rectangle
//     as 0×0, so the one-line constraint is arithmetic in the comment and in
//     DopDiagram's own geometry, not something asserted here.
//   * That the figure is right. It is the same query string it always was; what
//     changed is when it ran, which is what these tests read.
