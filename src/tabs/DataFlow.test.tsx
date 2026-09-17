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
import { accelEntry } from '../cribl/accel/manifest'
import type { Row } from '../cribl/search'
import { DataFlow, LAKE_CADENCE, lakeComputed, lakeHeldLabel } from './DataFlow'

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
const lakeLiveSubmits = () => submits.filter((s) => s.query.includes('total_bytes=sum(') && !s.query.includes('$vt_results'))
const storedSubmits = () => submits.filter((s) => s.query.includes('$vt_results'))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
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

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <DashboardProvider>
        <DataFlow />
      </DashboardProvider>,
    )
  })
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve() })
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
    expect(storedSubmits()).toHaveLength(1)
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

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That the dated label FITS on the card. happy-dom reports every rectangle
//     as 0×0, so the one-line constraint is arithmetic in the comment and in
//     DopDiagram's own geometry, not something asserted here.
//   * That the figure is right. It is the same query string it always was; what
//     changed is when it ran, which is what these tests read.
