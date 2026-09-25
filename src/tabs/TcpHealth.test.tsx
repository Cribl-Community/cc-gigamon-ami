// TCP health's heatmap, once its four metric states and two masks come from two
// scheduled runs.
//
// THIS IS THE FIRST ARGUMENT-DEPENDENT CALL SITE THE APP SERVES, and that is
// what this file is really about. Every entry before it served a panel whose
// query text was fixed. The heatmap's is built from two arguments a reader
// chooses at runtime, and the whole claim is that a closed, compile-time domain
// is not the same thing as a free argument:
//
//   * `metric` — four constants. One body carries all four sums and each panel
//     state projects its own. The rows are IDENTICAL to the live query's, not
//     close to them, and the reason is a single property of the panel's own
//     query: `sort by flows desc | limit 120` sorts on `count()`, which has no
//     metric in it. If that sort key ever becomes metric-dependent, the top 120
//     stops being the same 120 per metric, and these entries ship a subtly
//     different heatmap under a correct-looking ⓘ. So it is pinned here, as the
//     mechanism, rather than as a number somebody can tune.
//   * `mask` — two constants, and it is NOT the same mechanism: it changes the
//     group key, so it picks between two entries rather than two tails. A body
//     that tried to roll /24 up to /16 would be short by exactly the pairs that
//     missed the /24 top 120, which is the population a coarser mask exists to
//     gather up.
//
// What is deliberately NOT accelerated is asserted too: the endpoint drill stays
// live, because a clicked subnet pair is not a closed domain.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { accelEntry, MANIFEST } from '../cribl/accel/manifest'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import type { Row } from '../cribl/search'
import { HEAT_METRIC_AGGS, METRICS, buildHeatQuery, buildDrillQuery, type Mask } from '../queries/tcpHealth'
import { TCP_SUBNET16_SNAPSHOT_QUERY, TCP_SUBNET24_SNAPSHOT_QUERY } from '../queries/snapshots'
import { TcpHealth, TCP_CADENCE_16, TCP_CADENCE_24, TCP_WINDOW } from './TcpHealth'

const S24 = 'gno_tcp_subnet24_c1h'
const S16 = 'gno_tcp_subnet16_c1h'
const HOUR = 3_600_000
const NOW = Date.now()

const e24 = accelEntry(S24)
const e16 = accelEntry(S16)
const panel = (mask: Mask, metric: string) =>
  accelEntry(mask === '24' ? S24 : S16).panels.find((p) => p.queryId === `tcp-heatmap-${mask}-${metric}`)!

/** The virtual columns `$vt_results` stamps on every stored row. */
const virt = { jobId: 'run-1', jobName: S24, dataset: '$vt_results' }

/**
 * One subnet pair, projected by whichever metric's tail asked for it.
 *
 * The two values are chosen to render differently — 50/100 is "0.50" and 7/100
 * is "0.07" — because the thing under test is that pressing a metric button
 * sends a DIFFERENT TAIL and gets a different column back. A fixture answering
 * every tail with the same number would pass against a tab that ignored the
 * metric entirely.
 */
const storedRows = (v: number): Row[] => [
  { src_subnet: '10.0.0', dst_subnet: '10.1.1', v, flows: 100, ...virt },
  { src_subnet: '10.0.0', dst_subnet: '10.2.2', v: 1, flows: 80, ...virt },
]

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
const jobs = new Map<string, Row[]>()

/**
 * A stub that answers a stored read ACCORDING TO THE TAIL IT WAS SENT.
 *
 * Four panel states read one schedule, so `jobName=` cannot tell them apart. The
 * rows come back keyed on the `v=<metric>` the app actually asked for, which is
 * the wiring being asserted: a tab that named the entry and not the panel, or
 * named the wrong panel, would get the wrong column and the assertions on the
 * rendered numbers would fail rather than pass quietly.
 */
function stub(cfg: { rows?: boolean; history?: unknown[] } = {}): void {
  submits = []
  jobs.clear()
  const served = cfg.rows !== false
  let n = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const id = `job-${++n}`
      jobs.set(id, !served || !body.query.includes('$vt_results') ? [] : storedRows(body.query.includes('v=resets') ? 50 : 7))
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const id = /\/jobs\/([^/]+)\/results/.exec(u)?.[1] ?? ''
      const rows = jobs.get(id) ?? []
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

/** A scan of the AMI records — the thing these entries exist to stop the metric
 *  buttons running. The stored reads name `$vt_results` instead. */
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

async function settle(): Promise<void> {
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve() })
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <DashboardProvider>
        <TcpHealth />
      </DashboardProvider>,
    )
  })
  await settle()
}

const press = async (label: string): Promise<void> => {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!btn) throw new Error(`no button labelled "${label}"`)
  await act(async () => { btn.click() })
  await settle()
}

describe('the heatmap, served from a scheduled run', () => {
  it('reads the schedule on mount and never scans the records for the heatmap', async () => {
    stub()
    await render()

    expect(storedReads()).toHaveLength(1)
    // The two charts below the fold DO still scan: they are the audit's N8 and
    // are not in this tranche. Named rather than counted, so this assertion says
    // which queries are still live instead of pinning a total somebody can
    // "fix" by deleting a panel.
    const live = liveScans().map((s) => s.query)
    expect(live.some((q) => q.includes('by src_subnet')), 'the heatmap ran a live scan anyway').toBe(false)
    expect(live.filter((q) => q.includes('bin(_time, 1m)')), 'the two time charts are not the live queries this leaves behind').toHaveLength(2)
    expect(live, 'a third live query appeared on this tab').toHaveLength(2)
  })

  it('sends a different tail for each metric, so four states come out of one scan', async () => {
    // The tab opens on Resets. Pressing Dup ACKs must send a SECOND stored read
    // with a different projection — not a live scan, and not the same tail.
    stub()
    await render()
    expect(storedReads()[0].query).toContain('v=resets')
    expect(container.textContent, 'the resets column did not reach the cell').toContain('0.50')

    await press('Dup ACKs')

    const reads = storedReads()
    expect(reads).toHaveLength(2)
    expect(reads[1].query).toContain('v=dupacks')
    expect(reads[1].query).not.toContain('v=resets')
    expect(liveScans().some((s) => s.query.includes('by src_subnet')), 'pressing a metric button ran a whole-window scan').toBe(false)
    expect(container.textContent, 'the cell still shows the previous metric').toContain('0.07')
  })

  it('switches entry, not tail, when the mask changes', async () => {
    // /16 is a different group key and therefore a different schedule. A tab
    // that tried to serve it from the /24 entry would read a stored top-120 of
    // /24 pairs and render it as /16 — plausible, and short by every pair that
    // missed that cut.
    stub()
    await render()
    expect(storedReads()[0].query).toContain(`jobName="${S24}"`)

    await press('/16')

    const last = storedReads().at(-1)!
    expect(last.query).toContain(`jobName="${S16}"`)
    expect(last.query).toContain('src_subnet16')
  })

  it('dates the figure it took from a run, and says which schedule in its ⓘ', async () => {
    stub()
    await render()

    expect(container.textContent, 'a stored figure appeared with no date on it').toMatch(/snapshot (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2}/)

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.pinfo-btn')]
    let found = ''
    for (const btn of buttons) {
      act(() => btn.click())
      const text = document.querySelector('.pinfo-pop')?.textContent ?? ''
      if (text.includes('How this was computed')) found = text
      act(() => btn.click())
    }
    expect(found, 'no ⓘ on this tab says how its number was computed').not.toBe('')
    expect(found).toContain(TCP_CADENCE_24)
    expect(found).toContain(TCP_WINDOW)
  })

  it('falls back to the live heatmap when nothing has been scheduled yet', async () => {
    stub({ rows: false, history: [] })
    await render()

    // `includes` rather than equality: search.ts prefixes a running-time cap
    // onto what it submits, which is execution and never part of the ⓘ.
    expect(liveScans().some((s) => s.query.includes(buildHeatQuery('resets', '24'))), 'the live fallback did not run the panel’s own query').toBe(true)
    expect(container.textContent, 'a live figure was dated as if it came from a run').not.toMatch(/snapshot (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2}/)
  })
})

describe('the two entries', () => {
  it('stores every metric by carrying the live query with its aggregate widened, and nothing else', () => {
    // THE EXACTNESS ARGUMENT, AS AN EQUALITY RATHER THAN AS PROSE. The body is
    // the panel's own query with `v=sum(<one field>)` replaced by all four sums.
    // Same head, same group keys, same sort, same limit — so the rows the run
    // stores are the rows the live query would have returned for ANY of the four
    // metrics, and a tail that projects one of them is exact rather than close.
    //
    // A body that filtered differently, grouped differently, or capped at a
    // different depth fails here, whatever its aggregates say.
    for (const mask of ['24', '16'] as const) {
      const body = mask === '24' ? TCP_SUBNET24_SNAPSHOT_QUERY : TCP_SUBNET16_SNAPSHOT_QUERY
      for (const m of METRICS) {
        expect(
          buildHeatQuery(m.key, mask).replace(`v=sum(${m.field})`, HEAT_METRIC_AGGS),
          `the /${mask} body is not the ${m.label} query with its aggregate widened`,
        ).toBe(body)
      }
    }
  })

  it('keeps the top-120 cut on a key with no metric in it', () => {
    // The single property the four-panels-per-scan trick rests on. Sorting on
    // anything metric-dependent would make the stored 120 the top 120 FOR ONE
    // METRIC, and the other three panels would silently show a different
    // population of subnet pairs from the one their ⓘ claims.
    for (const mask of ['24', '16'] as const) {
      const cuts = METRICS.map((m) => buildHeatQuery(m.key, mask).slice(buildHeatQuery(m.key, mask).indexOf('| sort')))
      expect(new Set(cuts).size, `the /${mask} sort or limit differs between metrics`).toBe(1)
      expect(cuts[0]).toBe('| sort by flows desc | limit 120')
      for (const m of METRICS) {
        expect(cuts[0], 'the sort key names a metric field').not.toContain(m.field)
        expect(cuts[0], 'the sort key names the projected metric column').not.toMatch(/v/)
      }
    }
  })

  it('projects each panel’s own column and re-aggregates nothing', () => {
    // A `| summarize` in one of these tails would be re-aggregating a top-120,
    // which is a different number from the whole-window figure it looks like.
    // The tails are projections precisely because the body already did the cut
    // the panel wanted.
    for (const mask of ['24', '16'] as const) {
      const { sf, df } = { '24': { sf: 'src_subnet', df: 'dst_subnet' }, '16': { sf: 'src_subnet16', df: 'dst_subnet16' } }[mask]
      for (const m of METRICS) {
        const p = panel(mask, m.key)
        expect(p.display, 'the ⓘ shows a query other than the one the run widened').toBe(buildHeatQuery(m.key, mask))
        expect(p.tail).toBe(`| project ${sf}, ${df}, v=${m.key}, flows`)
        expect(p.tail, 'a tail re-aggregates a stored top-120').not.toContain('summarize')
        for (const other of METRICS) {
          if (other.key !== m.key) expect(p.tail, `the ${m.label} panel can read ${other.label}`).not.toContain(`v=${other.key}`)
        }
        expect(p.reads).toEqual([sf, df, 'v', 'flows'])
      }
    }
  })

  it('never rolls one mask up from the other', () => {
    // Two bodies, and each names only its own pair of columns. The /16 view
    // needs the /24 pairs that missed the top 120 — precisely the rows the /24
    // run did not keep — so a rollup is short in a direction no viewer can see.
    expect(e24.body).toContain('by src_subnet, dst_subnet')
    expect(e24.body, 'the /24 body mentions the /16 columns').not.toContain('src_subnet16')
    expect(e16.body).toContain('by src_subnet16, dst_subnet16')
    expect(e24.body).not.toBe(e16.body)
  })

  it('leaves the endpoint drill live, because a clicked pair is not a closed domain', () => {
    // The one permanently unservable call site in the app. It is asserted here
    // so that "every other argument-dependent site was servable" does not become
    // a reason to try: precomputing it means grouping by (src_ip, dst_ip) across
    // every subnet pair, carrying a percentile that cannot be re-aggregated.
    const served = MANIFEST.flatMap((e) => e.panels.map((p) => p.display))
    expect(served).not.toContain(buildDrillQuery({ row: '10.0.0', col: '10.1.1' }, '24'))
    for (const p of [...e24.panels, ...e16.panels]) {
      expect(p.display, 'a drill query reached a schedule').not.toContain('by src_ip, dst_ip')
    }
  })

  it('needs no empty-group sentinel, because it borrows the panel’s own head', () => {
    // Flow map's edges and DNS's resolvers each needed an `extend`/`iif`
    // sentinel, because a panel summing across a group the live query filtered
    // out would come back short. Nothing on these entries does: the body's head
    // IS the panel's head, character for character, and every tail is a
    // projection rather than a sum across groups.
    for (const e of [e24, e16]) {
      expect(e.body, 'a sentinel appeared with no panel that sums across it').not.toContain('isnotnull')
      for (const p of e.panels) expect(p.tail).not.toContain('sum(')
    }
  })
})

describe('the words about the schedules agree with the manifest', () => {
  it('quotes the crons and the windows this app actually writes', () => {
    expect(e24.cron).toBe('40 * * * *')
    expect(e16.cron).toBe('41 * * * *')
    expect(TCP_CADENCE_24).toContain('40 minutes past')
    expect(TCP_CADENCE_16).toContain('41 minutes past')
    for (const e of [e24, e16]) {
      expect(e.tz).toBe('UTC')
      expect(e.earliest).toBe('-18m')
      expect(e.latest).toBe('-3m')
      expect(e.keepLastN).toBe(24)
    }
    expect(TCP_WINDOW).toBe(SNAPSHOT_WINDOW)
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That the stored top-120 and a live top-120 agree on TIES. `sort by flows
//     desc` does not say what happens to two pairs with equal flow counts, and
//     neither does the platform. The claim asserted here is that the sort KEY is
//     metric-independent, so whatever the tie-break is, it is the same one for
//     all four metrics — which is what the four panels need.
//   * That `$vt_results` accepts a `| project` in the read tail. Nothing in this
//     repo has run one; the stub answers whatever is asked. If it turns out a
//     stored result can only be filtered, these entries need four tails that are
//     `| where`-shaped or four entries, and read.ts's live fallback is what the
//     reader sees in the meantime.
//   * That the tab is faster. happy-dom has no network and no clock worth
//     reading; what is asserted is which queries were submitted.
//   * Anything about the two time charts below the fold. They are the audit's
//     N8, they still run live, and the first test here names them so that a
//     reader does not take their absence for coverage.
