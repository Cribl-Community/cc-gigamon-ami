// Web & API health, once all six of its queries come from scheduled runs.
//
// This tab fired SIX jobs — three on mount and three more the moment the reader
// scrolled — and only the KPI row was served. Four entries now carry the other
// five panels. What can go wrong here is not "the tab is slow":
//
//   * THE SLOWEST-HOSTS PANEL SHOWS THE WRONG TRANSACTION COUNT. Two panels
//     group by `http_host` and BOTH CALL THEIR COUNT `n` — but they count
//     different populations. "Top endpoints" counts every transaction a host
//     served; "Slowest hosts" counts only the ones that carried a server-time
//     measurement, and renders that number as the bar note "<n> txns" right
//     beside a latency figure. One shared `n` puts a larger, plausible,
//     correctly formatted number there with nothing on screen to notice. This
//     file asserts the mechanism that stops it — the body defines no `n` at all
//     — and then asserts the rendered consequence, with the two counts set far
//     enough apart that a merged body could not accidentally pass.
//   * A TIME CHART IS RE-GROUPED ON A STORED BIN COLUMN. The coverage audit's
//     merged N4 would re-summarize the status-code scan `by bin_time_1m` on
//     read. That entry is deliberately split in two; this file pins the split,
//     so the merge cannot come back without somebody deleting an assertion that
//     says why.
//   * A STORED FIGURE APPEARS WITH NO DATE ON IT. Every panel here used to
//     answer for the range picker. Now it answers for whenever its schedule last
//     fired — and in Snapshot mode the picker is not even on screen.
//
// The bar-list and chart rendering are not under test here; they did not change.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { accelEntry, columnsOf } from '../cribl/accel/manifest'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import type { Row } from '../cribl/search'
import {
  WebApiHealth,
  WEB_HOST_CADENCE,
  WEB_CODE_CADENCE,
  WEB_TREND_CADENCE,
  WEB_H2_CADENCE,
  WEB_WINDOW,
} from './WebApiHealth'

const HOSTS_ID = 'gno_web_host_c1h'
const CODE_ID = 'gno_web_code_c1h'
const TREND_ID = 'gno_web_trend_c1h'
const H2_ID = 'gno_web_h2_c1h'
const HOUR = 3_600_000
const NOW = Date.now()

const hostEntry = accelEntry(HOSTS_ID)
const codeEntry = accelEntry(CODE_ID)
const trendEntry = accelEntry(TREND_ID)
const h2Entry = accelEntry(H2_ID)
const topPanel = hostEntry.panels.find((p) => p.queryId === 'web-hosts')!
const slowPanel = hostEntry.panels.find((p) => p.queryId === 'web-slow')!

/** The virtual columns `$vt_results` stamps on every stored row. The `jobName`
 *  has to be the entry's own id: read.ts refuses rows stamped with some other
 *  schedule's name rather than dating them from a run they did not come from. */
const virt = (jobName: string) => ({ jobId: 'run-1', jobName, dataset: '$vt_results' })

/**
 * ONE HOST, TWO COUNTS, AND THEY ARE FAR APART ON PURPOSE.
 *
 * `api.example.com` served 1,000 transactions and only 12 of them carried a
 * server time. The two panels below both call their count `n`, so if one shared
 * alias ever fed both, the slow panel's note would read "1.0K txns" instead of
 * "12 txns" — same shape, same units, sixty times the truth, beside a latency
 * figure that is still correct. Numbers that reconciled would pass against the
 * broken version just as happily.
 */
const TOP_ROWS: Row[] = [{ http_host: 'api.example.com', n: 1000, err: 50, ...virt(HOSTS_ID) }]
const SLOW_ROWS: Row[] = [{ http_host: 'api.example.com', p95: 250, n: 12, ...virt(HOSTS_ID) }]
const CODE_ROWS: Row[] = [{ http_code: '502', n: 40, ...virt(CODE_ID) }]
const TREND_ROWS: Row[] = [{ bin_time_1m: NOW - HOUR, errors: 4, total: 90, ...virt(TREND_ID) }]
const H2_ROWS: Row[] = [{ http2_host: 'h2.example.com', n: 7, ...virt(H2_ID) }]
const KPI_ROWS: Row[] = [{ txns: 1000, errors: 50, server_p95: 250, h2: 7, ...virt('gno_overview_c1h') }]

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
 * Six stored reads, told apart by the SELECTOR or the TAIL the app sent.
 *
 * The two host panels share a schedule, so `jobName=` cannot tell them apart and
 * a stub answering both with the same rows would pass whichever way the tails
 * were wired. They are routed on the tail instead — which is the thing under
 * test.
 */
function stub(cfg: { rows?: boolean; history?: unknown[] } = {}): void {
  submits = []
  const served = cfg.rows !== false
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const q = body.query
      const id = !q.includes('$vt_results')
        ? 'job-live'
        : q.includes(`jobName="${CODE_ID}"`)
          ? 'job-codes'
          : q.includes(`jobName="${TREND_ID}"`)
            ? 'job-trend'
            : q.includes(`jobName="${H2_ID}"`)
              ? 'job-h2'
              : q.includes(`jobName="${HOSTS_ID}"`)
                ? q.includes('srv_n')
                  ? 'job-slow'
                  : 'job-top'
                : 'job-kpi'
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const rows = !served
        ? []
        : u.includes('job-slow')
          ? SLOW_ROWS
          : u.includes('job-top')
            ? TOP_ROWS
            : u.includes('job-codes')
              ? CODE_ROWS
              : u.includes('job-trend')
                ? TREND_ROWS
                : u.includes('job-h2')
                  ? H2_ROWS
                  : u.includes('job-kpi')
                    ? KPI_ROWS
                    : []
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

/** A scan of the AMI records — the thing these entries exist to stop running. */
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
        <WebApiHealth />
      </DashboardProvider>,
    )
  })
  for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve() })
}

describe('the tab, served from four scheduled runs and the overview scan', () => {
  it('answers all six of its queries from schedules and scans nothing', async () => {
    // happy-dom has no IntersectionObserver, so nearViewport fails open and the
    // three deferred panels submit on mount — which is what makes this a
    // six-of-six assertion rather than a three-of-three one.
    stub()
    await render()

    expect(liveScans(), 'the tab ran a live scan anyway').toEqual([])
    expect(storedReads()).toHaveLength(6)
  })

  it('sends the two host panels different tails, so one scan answers two questions', async () => {
    stub()
    await render()

    const shared = storedReads().filter((s) => s.query.includes(`jobName="${HOSTS_ID}"`))
    expect(shared, 'both host panels must read the one grouping').toHaveLength(2)
    expect(shared.some((s) => s.query.includes('extend n=all_n')), 'the endpoints panel did not take the all-transactions count').toBe(true)
    expect(shared.some((s) => s.query.includes('where srv_n > 0')), 'the slow panel did not reproduce its http_server_ms=* head').toBe(true)
  })

  it('puts the server-timed count beside the latency, not the host total', async () => {
    // THE ALIAS TRAP, as a rendered number. The host served 1,000 transactions
    // and 12 of them carried a server time. "1.0K txns" beside a p95 is what a
    // body defining one shared `n` produces: plausible, correctly formatted, and
    // sixty times the truth.
    stub()
    await render()

    expect(container.textContent).toContain('12 txns')
    expect(container.textContent, 'the slow panel took the other panel’s population').not.toContain('1.0K txns')
    // And the endpoints panel is still reading its own, larger count.
    expect(container.textContent).toContain('1.0K')
  })

  it('dates every figure it took from a run', async () => {
    stub()
    await render()

    expect(container.textContent, 'a stored figure appeared with no date on it').toMatch(/snapshot (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2}/)
  })

  it('says in an ⓘ which schedule produced the number', async () => {
    stub()
    await render()

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.pinfo-btn')]
    const seen: string[] = []
    for (const btn of buttons) {
      act(() => btn.click())
      const text = document.querySelector('.pinfo-pop')?.textContent ?? ''
      if (text.includes('How this was computed')) seen.push(text)
      act(() => btn.click())
    }
    expect(seen.length, 'no ⓘ on this tab says how its number was computed').toBeGreaterThan(0)
    const all = seen.join(' ')
    // Four schedules, four sentences. A panel quoting its neighbour's minute is
    // a false claim about which run produced the figure beside it.
    for (const cadence of [WEB_HOST_CADENCE, WEB_CODE_CADENCE, WEB_TREND_CADENCE, WEB_H2_CADENCE]) {
      expect(all, `no ⓘ quotes ${cadence}`).toContain(cadence)
    }
    expect(all).toContain(WEB_WINDOW)
  })

  it('falls back to the live queries when nothing has been scheduled yet', async () => {
    // A fresh install. The tab behaves exactly as it did before, and says so
    // rather than dating a number it did not take from a run.
    stub({ rows: false, history: [] })
    await render()

    expect(liveScans()).toHaveLength(6)
    expect(container.textContent, 'a live figure was dated as if it came from a run').not.toMatch(/snapshot (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2}/)
  })
})

describe('the host entry, and the alias it refuses to define', () => {
  it('defines two counts and calls neither of them n', () => {
    // THE MECHANISM, not the number. A body defining `n` once would leave both
    // tails parsing and both panels rendering — one of them wrong. There is no
    // `n` in this body to read, so the mistake is not available.
    const out = columnsOf(hostEntry.body).outputs as Set<string>
    expect(out, 'this test cannot read what the body emits').not.toBeNull()
    expect([...out].sort()).toEqual(['all_n', 'err', 'http_host', 'p95', 'srv_n'])
    expect(out.has('n'), 'the body defines the alias the two panels disagree about').toBe(false)
  })

  it('has each tail rename the count its own panel means', () => {
    expect(topPanel.tail).toContain('extend n=all_n')
    expect(topPanel.tail, 'the endpoints panel reached for the server-timed count').not.toContain('srv_n')
    expect(slowPanel.tail).toContain('extend n=srv_n')
    expect(slowPanel.tail, 'the slow panel reached for the host total').not.toContain('all_n')
    // The `http_server_ms=*` head, moved to where it belongs. In the body it
    // would have taken the other panel's transaction counts with it.
    expect(slowPanel.tail).toContain('where srv_n > 0')
    expect(hostEntry.body, 'a server-timing head in the body truncates the endpoints panel').not.toContain('http_server_ms=*')
  })

  it('caps each list in its own tail, not in the scan', () => {
    // 12 endpoints and 10 slow hosts are two different views of one grouping.
    // Either limit in the body would cap the other panel to the wrong rows.
    expect(topPanel.tail).toContain('limit 12')
    expect(slowPanel.tail).toContain('limit 10')
    expect(hostEntry.body).not.toContain('limit')
  })
})

describe('the status-code and trend entries, which are deliberately not one', () => {
  it('runs each body verbatim, with no tail to re-group', () => {
    // The coverage audit's N4 folds these into `by http_code, bin(_time,1m)` and
    // re-groups the stored rows on read. Two behaviours in that tail have never
    // been run against this platform: whether a `bin()` group key survives
    // $vt_results as a re-groupable `bin_time_1m` column, and whether a status
    // code that is now a GROUP KEY still compares as a number in
    // `sum(iif(http_code >= 400, n, 0))`. Both fail as a wrong chart — a flat
    // zero error series under a plausible snapshot timestamp — rather than as an
    // error that falls back to live.
    //
    // Split, both bodies run exactly as the panel's own ⓘ shows them.
    for (const e of [codeEntry, trendEntry, h2Entry]) {
      expect(e.panels, `${e.id} is no longer a single-panel entry`).toHaveLength(1)
      expect(e.panels[0].tail, `${e.id} grew a tail, which is the merge this split exists to avoid`).toBeUndefined()
      expect(e.panels[0].display, `${e.id} does not run the query its ⓘ shows`).toBe(e.body)
    }
  })

  it('never re-groups a stored bin column anywhere on this tab', () => {
    // Stated as a sweep rather than per-entry, so a later merge has to delete
    // this line rather than slip past it.
    for (const e of [hostEntry, codeEntry, trendEntry, h2Entry]) {
      for (const p of e.panels) {
        expect(p.tail ?? '', `${e.id}/${p.queryId} re-groups a stored bin column`).not.toContain('bin_time_1m')
      }
    }
    // The chart still reads `bin_time_1m` — off a row the SCHEDULED BODY
    // produced with its own `by bin(_time,1m)`, exactly as it does from a live
    // run. That is the half of M-1 nobody has to have measured.
    expect(trendEntry.body).toContain('by bin(_time,1m)')
    expect(trendEntry.panels[0].reads).toContain('bin_time_1m')
  })
})

describe('the words about these schedules agree with the manifest', () => {
  it('quotes the cron and the window this app actually writes', () => {
    // The cadence is prose and the cron is data; nothing but this holds them
    // together.
    expect(hostEntry.cron).toBe('45 * * * *')
    expect(codeEntry.cron).toBe('48 * * * *')
    expect(trendEntry.cron).toBe('51 * * * *')
    expect(h2Entry.cron).toBe('54 * * * *')
    expect(WEB_HOST_CADENCE).toContain('45 minutes past')
    expect(WEB_CODE_CADENCE).toContain('48 minutes past')
    expect(WEB_TREND_CADENCE).toContain('51 minutes past')
    expect(WEB_H2_CADENCE).toContain('54 minutes past')
    expect(WEB_WINDOW).toBe(SNAPSHOT_WINDOW)
    for (const e of [hostEntry, codeEntry, trendEntry, h2Entry]) {
      expect(e.tz).toBe('UTC')
      expect(e.earliest).toBe('-18m')
      expect(e.latest).toBe('-3m')
      expect(e.keepLastN).toBe(24)
    }
  })

  it('gives the four of them four different submit minutes', () => {
    // Concurrent jobs from one account are admitted about 1.6 s apart, so two
    // entries on one minute queue behind each other instead of running. Spaced
    // three apart here, with room left either side for the entries other tabs
    // are taking.
    const minutes = [hostEntry, codeEntry, trendEntry, h2Entry].map((e) => Number(e.cron.split(' ')[0]))
    expect(new Set(minutes).size).toBe(4)
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That `percentile(http_server_ms,95)` computed WITHOUT an
//     `http_server_ms=*` head returns the live panel's figure (M-8). The shared
//     body cannot carry that head — it would truncate the endpoints panel's
//     transaction counts — so the stored p95 is computed over a group that
//     includes rows with no server time. It agrees with the live number if and
//     only if `percentile()` ignores nulls, which nobody has run here.
//     `count(field)` demonstrably does, all over this app; the argument is
//     written out beside the body in src/queries/snapshots.ts.
//   * That a `bin()` group key survives $vt_results as `bin_time_1m` (M-1).
//     Nothing on this tab depends on it any more, which is the point of the
//     split above — the chart reads the column off a row the body itself
//     produced, never off one a tail re-grouped.
//   * That the tab is faster. happy-dom has no network and no clock worth
//     reading; what is asserted is that the AMI scans did not run.
//   * Anything about the deferred panels' deferral. With no IntersectionObserver
//     nearViewport fails open, so this file renders all five panels eagerly and
//     says nothing whatever about what a real browser does on scroll.
