// DNS health, with each of its mount queries served by its own scheduled run.
//
// This tab was the longest wait in the app: two whole-window scans fire on
// mount and the reader waits for both. They were first served from ONE hourly
// grouping by resolver, cut into two panels by tails — and on this workspace
// that grouping stored 12,153 rows, 1.3 MB to download on every open, which
// cancelled what serving it saved (browser trace, 2026-09-23). Now each panel
// has a run storing exactly its own query:
//
//   gno_dns_resolver_c1h  PER_RESOLVER — the 500 busiest resolvers
//   gno_dns_overall_c1h   OVERALL      — one row of totals
//
// What can still go wrong is not "the tab is slow":
//
//   * THE TILES UNDER-REPORT. The table's query has a `dns_host=*` head and the
//     tiles' does not, so responses that name no resolver are in one and not
//     the other. With the tiles on their own body that is simply OVERALL's own
//     count, and it is asserted by number below.
//   * A STORED FIGURE APPEARS WITH NO DATE ON IT. Every number on this tab used
//     to answer for the range picker. Now it answers for whenever the schedule
//     last fired, and a schedule that has stopped leaves a plausible number on
//     screen indefinitely.
//
// The rendering of the resolver list is not under test here — it did not change.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { accelEntry } from '../cribl/accel/manifest'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import type { Row } from '../cribl/search'
import { OVERALL, PER_RESOLVER } from '../queries/dnsHealth'
import { DnsHealth, DNS_CADENCE, DNS_OVERALL_CADENCE, DNS_WINDOW } from './DnsHealth'

const DNS = 'gno_dns_resolver_c1h'
const DNS_TOTALS = 'gno_dns_overall_c1h'
const HOUR = 3_600_000
const NOW = Date.now()

const entry = accelEntry(DNS)
const totals = accelEntry(DNS_TOTALS)

/** The virtual columns `$vt_results` stamps on every stored row. */
const virt = { jobId: 'run-1', jobName: DNS, dataset: '$vt_results' }

/** Two resolvers, as the table's own query returns them. */
const TABLE_ROWS: Row[] = [
  { dns_host: '10.0.0.53', p50: 0.012, noerr: 900, sf: 2, nx: 1, total: 903, ...virt },
  { dns_host: '10.0.0.54', p50: 0.004, noerr: 80, sf: 0, nx: 0, total: 80, ...virt },
]
/**
 * The tiles' row, and the numbers matter: `total` is 1,000 while the two
 * resolvers above add up to 983. The missing 17 are DNS responses that name no
 * resolver, which OVERALL counts and the table's `dns_host=*` head does not. A
 * test whose totals reconciled would pass just as happily if the tiles were
 * wired to the table's run.
 */
// Stamped with the TILES' own run: the read path refuses rows naming another
// schedule, which is what would catch the tiles being wired to the table's run.
const TILE_ROWS: Row[] = [{ total: 1000, noerr: 980, sf: 12, nx: 8, resolvers: 2, ...virt, jobName: DNS_TOTALS }]

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

/**
 * Two stored reads, told apart by the RUN they name. Each panel has its own
 * schedule now, so the stub answers by `jobName=` — and a panel wired to the
 * other's run would get the other's rows, which the numbers below catch.
 */
function stub(cfg: { rows?: boolean; history?: unknown[] } = {}): void {
  submits = []
  const served = cfg.rows !== false
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const id = !body.query.includes('$vt_results')
        ? 'job-live'
        : body.query.includes(`jobName="${DNS_TOTALS}"`)
          ? 'job-tiles'
          : 'job-table'
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const rows = !served ? [] : u.includes('job-tiles') ? TILE_ROWS : u.includes('job-table') ? TABLE_ROWS : []
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

/** A scan of the AMI records — the thing this entry exists to stop running on
 *  mount. The stored reads name `$vt_results` instead. */
const liveScans = () => submits.filter((s) => s.query.includes('gigamon_ami') && !s.query.includes('$vt_results'))
const storedReads = () => submits.filter((s) => s.query.includes('$vt_results'))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
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
        <DnsHealth />
      </DashboardProvider>,
    )
  })
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve() })
}

describe('the tab, served from its two scheduled runs', () => {
  it('answers both mount queries from the schedule and scans nothing', async () => {
    stub()
    await render()

    expect(liveScans(), 'the tab ran a live scan anyway').toEqual([])
    expect(storedReads()).toHaveLength(2)
  })

  it('reads each panel from its own run', async () => {
    stub()
    await render()

    const queries = storedReads().map((s) => s.query)
    expect(queries.filter((q) => q.includes(`jobName="${DNS}"`)), 'the table did not read its run').toHaveLength(1)
    expect(queries.filter((q) => q.includes(`jobName="${DNS_TOTALS}"`)), 'the tiles did not read their run').toHaveLength(1)
    // No tails: each body IS its panel's query, so nothing is cut out of a
    // shared result any more.
    expect(queries.every((q) => /jobName="[^"]+"$/.test(q)), 'a tail was sent').toBe(true)
  })

  it('shows the stored numbers, including the responses that name no resolver', async () => {
    // 20 failures in 1,000 responses = 2.00%. The denominator is the body's
    // total across every group, sentinel included — 983 would be the number a
    // naive `by dns_host` body produced, and the rate would read 2.03%: right
    // shape, wrong figure, nothing on screen to say so.
    stub()
    await render()

    expect(container.textContent).toContain('2.00%')
    expect(container.textContent).toContain('20 of 1.0K responses')
  })

  it('dates every figure it took from a run', async () => {
    // The panel's own caption, in snapshotNote's words: `snapshot HH:MM · 1h
    // ago`. The ⓘ says it again in prose ("The run it read finished at…"), and
    // the tiles above are covered by that ⓘ — they have no caption line of
    // their own to carry a date on.
    stub()
    await render()

    expect(container.textContent, 'a stored figure appeared with no date on it').toMatch(/snapshot \d{2}:\d{2}/)
  })

  it('says in its ⓘ that the figure came from a schedule, and which one', async () => {
    stub()
    await render()

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.pinfo-btn')]
    let found = ''
    for (const btn of buttons) {
      act(() => btn.click())
      const text = document.querySelector('.pinfo-pop')?.textContent ?? ''
      if (text.includes('How this was computed')) found = text
      act(() => btn.click())
    }
    expect(found, 'no ⓘ on this tab says how its number was computed').not.toBe('')
    expect(found).toContain(DNS_CADENCE)
    expect(found).toContain(DNS_WINDOW)
  })

  it('falls back to the live queries when nothing has been scheduled yet', async () => {
    // A fresh install. The tab behaves exactly as it did before, and says so
    // instead of dating a number it did not take from a run.
    stub({ rows: false, history: [] })
    await render()

    expect(liveScans()).toHaveLength(2)
    expect(container.textContent, 'a live figure was dated as if it came from a run').not.toMatch(/snapshot \d{2}:\d{2}/)
  })
})

describe('the entries this tab reads', () => {
  it('stores each panel’s query exactly, by identity — no tails, no sentinel', () => {
    // A retyped copy agrees on the day it is written and drifts the first time
    // somebody edits one of them — silently, because both still render a number.
    expect(entry.body).toBe(PER_RESOLVER)
    expect(totals.body).toBe(OVERALL)
    for (const e of [entry, totals]) {
      expect(e.panels).toHaveLength(1)
      expect(e.panels[0].tail, `${e.id} carries a tail`).toBeUndefined()
    }
  })

  it('keeps the table’s run to the 500 resolvers it shows', () => {
    // The whole point of the split: the shared grouping stored all 12,153.
    expect(entry.body).toContain('limit 500')
  })

  it('counts resolvers the way the live tile does', () => {
    // The shared grouping counted resolver ROWS exactly, while the live tile's
    // OVERALL uses dcount — an estimate (about 0.5 % off at this workspace's
    // cardinality, measured 2026-09-23). Storing OVERALL itself makes snapshot
    // and live the same computation.
    expect(totals.body).toContain('resolvers=dcount(dns_host)')
  })
})

describe('the words about the schedule agree with the manifest', () => {
  it('quotes the cron and the window this app actually writes', () => {
    // The cadence is prose and the cron is data; nothing but this holds them
    // together.
    expect(entry.cron).toBe('33 * * * *')
    expect(entry.tz).toBe('UTC')
    expect(DNS_CADENCE).toContain('33 minutes past')
    expect(entry.earliest).toBe('-18m')
    expect(entry.latest).toBe('-3m')
    expect(DNS_WINDOW).toBe(SNAPSHOT_WINDOW)
    // The tiles' run, one minute later over the same fifteen minutes.
    expect(totals.cron).toBe('34 * * * *')
    expect(totals.tz).toBe('UTC')
    expect(DNS_OVERALL_CADENCE).toContain('34 minutes past')
    expect([totals.earliest, totals.latest]).toEqual([entry.earliest, entry.latest])
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That the stored p50 equals the live p50 beyond this: the stored run IS the
//     live query over a settled fifteen minutes. Nothing here checks the
//     platform's percentile against itself.
//   * That the tab is faster. happy-dom has no network and no clock worth
//     reading; what is asserted is that the AMI scans did not run.
