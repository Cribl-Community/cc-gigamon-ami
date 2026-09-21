// DNS health, once both of its mount queries come from one scheduled run.
//
// This tab was the longest wait in the app: two whole-window scans fire on
// mount and the reader waits for both. `gno_dns_resolver_c1h` replaces them
// with a single hourly grouping by resolver, and the two things that can go
// wrong are not "the tab is slow":
//
//   * THE TILES UNDER-REPORT. The table's live query has a `dns_host=*` head
//     and the tiles' does not, so DNS responses that name no resolver are in
//     one and not the other. Group naively `by dns_host` and those rows vanish
//     from the tiles' total and from the failure rate computed over it —
//     smaller, plausible, and in the one direction a viewer cannot check. The
//     body's `extend`/`iif` sentinel is what stops that, and it is asserted
//     here as a mechanism, because removing it would leave both tails parsing.
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
import { DnsHealth, DNS_CADENCE, DNS_WINDOW } from './DnsHealth'

const DNS = 'gno_dns_resolver_c1h'
const HOUR = 3_600_000
const NOW = Date.now()

const entry = accelEntry(DNS)
const table = entry.panels.find((p) => p.queryId === 'dns-resolver-table')!
const tiles = entry.panels.find((p) => p.queryId === 'dns-overall')!

/** The virtual columns `$vt_results` stamps on every stored row. */
const virt = { jobId: 'run-1', jobName: DNS, dataset: '$vt_results' }

/** One resolver, as the table's tail projects it. */
const TABLE_ROWS: Row[] = [
  { dns_host: '10.0.0.53', p50: 0.012, noerr: 900, sf: 2, nx: 1, total: 903, ...virt },
  { dns_host: '10.0.0.54', p50: 0.004, noerr: 80, sf: 0, nx: 0, total: 80, ...virt },
]
/**
 * The tiles' row, and the numbers matter: `total` is 1,000 while the two
 * resolvers above add up to 983. The missing 17 are DNS responses that name no
 * resolver — the sentinel group — and the whole point of the body's `extend` is
 * that they are still in this total. A test whose totals reconciled would pass
 * just as happily against the broken version.
 */
const TILE_ROWS: Row[] = [{ total: 1000, noerr: 980, sf: 12, nx: 8, resolvers: 2, ...virt }]

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
 * Two stored reads, told apart by their TAIL.
 *
 * Both panels read the same schedule, so `jobName=` cannot distinguish them and
 * a stub that answered both with the same rows would pass whichever way the
 * tails were wired. The job id is chosen from the tail the app actually sent,
 * which is the thing being asserted.
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
        : body.query.includes('summarize total=sum(total)')
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

describe('the tab, served from one scheduled run', () => {
  it('answers both mount queries from the schedule and scans nothing', async () => {
    stub()
    await render()

    expect(liveScans(), 'the tab ran a live scan anyway').toEqual([])
    expect(storedReads()).toHaveLength(2)
  })

  it('sends each panel its own tail, so one scan answers two different questions', async () => {
    stub()
    await render()

    const queries = storedReads().map((s) => s.query)
    expect(queries.every((q) => q.includes(`jobName="${DNS}"`))).toBe(true)
    expect(queries.some((q) => q.includes('where dns_h != ""')), 'the table did not filter the sentinel group out').toBe(true)
    expect(queries.some((q) => q.includes('resolvers=sum(iif(')), 'the tiles did not count resolver groups').toBe(true)
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

describe('the entry this tab reads', () => {
  it('keeps the responses that name no resolver as a group of their own', () => {
    // The mechanism, not the number: both tails still parse without the
    // `extend`, and the tiles simply come back short. Service map's edges body
    // does this for the same reason and the same way.
    expect(entry.body).toContain('extend dns_h=iif(isnotnull(dns_host)')
    expect(tiles.tail, 'the tiles must sum across every group, sentinel included').toContain('total=sum(total)')
    expect(tiles.tail, 'filtering the sentinel out of the tiles is the bug this entry exists to avoid').not.toContain('where dns_h')
    expect(table.tail, 'the table must exclude the sentinel, which is what its `dns_host=*` head did').toContain('where dns_h != ""')
  })

  it('counts resolver groups rather than composing a dcount', () => {
    // `dcount` does not compose: summing per-group distinct counts counts
    // anything in two groups twice. Nothing is summed here — the body emits one
    // row per distinct resolver, so counting the non-sentinel rows IS the
    // distinct count, exactly, whether or not the platform's dcount is a sketch.
    expect(tiles.tail).toContain('resolvers=sum(iif(dns_h != "", 1, 0))')
    expect(tiles.tail, 'a dcount reached the read path').not.toContain('dcount(')
    expect(entry.body, 'a dcount reached the scheduled body').not.toContain('dcount(')
  })

  it('caps the list in the tail and not in the scan', () => {
    // `limit 500` is the panel's view of the grouping. Left in the body it
    // would cap the tiles at the top 500 resolvers' worth of DNS as well, which
    // is a different number from the one their ⓘ claims.
    expect(table.tail).toContain('limit 500')
    expect(entry.body).not.toContain('limit')
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
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That the platform's `summarize … by` really drops a null group key. That
//     is the assumption the sentinel makes unnecessary; nobody has measured it,
//     and the entry is written so that the answer does not matter.
//   * That the stored p50 equals the live p50. Percentiles do not compose, which
//     is why no panel on this entry re-aggregates one — the table reads it at
//     the grouping it was computed at. Nothing here checks the platform's
//     percentile against itself.
//   * That the tab is faster. happy-dom has no network and no clock worth
//     reading; what is asserted is that the AMI scans did not run.
