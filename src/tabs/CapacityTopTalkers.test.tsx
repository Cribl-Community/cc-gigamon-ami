// Capacity & top talkers, once its three byte panels come from one scheduled
// rollup — and, just as importantly, once they stop coming from it.
//
// This tab is the one place in the app where acceleration has to switch itself
// OFF, and the two failures it can produce are opposites:
//
//   * A SERVED PANEL IGNORES THE FILTER. `applied` is free text spliced into
//     the query head by `scopeFor`, so the argument domain is unbounded and no
//     stored run can hold an answer for it. A panel that kept reading the
//     schedule after somebody typed four characters would show unfiltered
//     numbers under a filtered heading — plausible, correctly formatted, and
//     nothing on screen to say so. Same for the bar list's other two pivots:
//     this scan groups by app_name and l4_proto, and `src_ip` is not a key it
//     carries, so serving that state would mean a different top-12 from the one
//     the live query returns.
//   * THE SENTINEL GROUP IS DROPPED. The body coalesces a null `app_name` and a
//     null `l4_proto` into `""` before grouping, so that the panel summing along
//     the OTHER key still counts those bytes. Lose it and the L4 split comes
//     back short by all the traffic AMI could not classify — which is exactly
//     the traffic a capacity reader is looking for, missing in the one
//     direction nobody can check.
//
// So what is asserted below is the MECHANISM in both directions: which hooks
// read the schedule in which state, and that the sentinel survives the round
// trip as far as the word on screen. Nothing here pins a total, because a total
// is a number somebody can tune until the test passes.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { accelEntry } from '../cribl/accel/manifest'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import type { Row } from '../cribl/search'
import { CapacityTopTalkers, MIX_CADENCE, MIX_WINDOW } from './CapacityTopTalkers'

const MIX = 'gno_app_l4_c1h'
const OVERVIEW = 'gno_overview_c1h'
const HOUR = 3_600_000
const NOW = Date.now()

const entry = accelEntry(MIX)
const talkers = entry.panels.find((p) => p.queryId === 'capacity-talkers-app')!
const appmix = entry.panels.find((p) => p.queryId === 'capacity-app-mix')!
const l4 = entry.panels.find((p) => p.queryId === 'capacity-l4')!

/** The virtual columns `$vt_results` stamps on every stored row. */
const virt = (job: string) => ({ jobId: 'run-1', jobName: job, dataset: '$vt_results' })

const KPI_ROWS: Row[] = [{ total: 9e9, tin: 5e9, tout: 4e9, pkts: 12345, rtt: 0.02, retrans: 7, ...virt(OVERVIEW) }]
const TALKER_ROWS: Row[] = [
  { app_name: 'https', bytes: 9e8, ...virt(MIX) },
  { app_name: 'dns', bytes: 1e8, ...virt(MIX) },
]
/**
 * The mix rows, and the SECOND ROW IS THE POINT. Its `app_name` is the body's
 * empty-string sentinel — the records AMI could not put an application name to
 * — and the live query, which has no head filter at all, counts them too. A
 * fixture of two named applications would pass just as happily against a body
 * that dropped them.
 */
const APPMIX_ROWS: Row[] = [
  { app_name: 'https', bytes: 9e8, ...virt(MIX) },
  { app_name: '', bytes: 1e8, ...virt(MIX) },
]
const L4_ROWS: Row[] = [
  { l4_proto: 'tcp', bytes: 9e8, ...virt(MIX) },
  { l4_proto: '', bytes: 1e8, ...virt(MIX) },
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

/**
 * Four stored reads, told apart by their TAIL.
 *
 * Three of them name the same schedule, so `jobName=` cannot distinguish them
 * and a stub answering all three with the same rows would pass whichever way
 * the tails were wired. The job id is chosen from the tail the app actually
 * sent, which is the thing under test.
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
        : q.includes(`jobName="${OVERVIEW}"`)
          ? 'job-kpi'
          : q.includes('where app != ""')
            ? 'job-talkers'
            : q.includes('by l4')
              ? 'job-l4'
              : 'job-appmix'
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const rows = !served
        ? []
        : u.includes('job-kpi')
          ? KPI_ROWS
          : u.includes('job-talkers')
            ? TALKER_ROWS
            : u.includes('job-l4')
              ? L4_ROWS
              : u.includes('job-appmix')
                ? APPMIX_ROWS
                : []
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

/** A scan of the AMI records — the thing a served panel does not do. The stored
 *  reads name `$vt_results` instead. */
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

/** Let every queued read settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve() })
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <DashboardProvider>
        <CapacityTopTalkers />
      </DashboardProvider>,
    )
  })
  await settle()
}

const button = (text: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!

/** Type into a controlled input the way a user does — React listens for the
 *  native `input` event, not for an assignment to `.value`. */
function type(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the default view', () => {
  it('scans the Lake for the bar list alone, because that pivot is not a key this scan holds', async () => {
    // Three of the four hooks are served on arrival: the KPI strip from the
    // overview scan, the mix donut and the L4 split from this entry. The bar
    // list opens on the src_ip pivot, which `by app_name, l4_proto` cannot
    // answer — so it stays live rather than returning a different top-12 under
    // a stored date. A partial is the honest scope for this tab.
    stub()
    await render()

    expect(storedReads()).toHaveLength(3)
    expect(liveScans()).toHaveLength(1)
    expect(liveScans()[0].query, 'the live scan was not the bar list').toContain('src_ip=*')
  })

  it('sends each panel its own tail, so one scan answers three different questions', async () => {
    stub()
    await render()

    const reads = storedReads().map((s) => s.query)
    expect(reads.filter((q) => q.includes(`jobName="${MIX}"`)), 'the mix panels did not read this entry').toHaveLength(2)
    expect(reads.some((q) => q.includes('by app | extend app_name=app')), 'the donut did not sum along the application key').toBe(true)
    expect(reads.some((q) => q.includes('by l4 | extend l4_proto=l4')), 'the L4 split did not sum along the protocol key').toBe(true)
  })

  it('keeps the unclassified traffic on screen, under the word the live path uses for it', async () => {
    // The sentinel arrives as `""`, and `str`'s fallback only fires on null —
    // so without the tab's own coalescing the snapshot path prints a blank row
    // where the live path printed "(none)". Same bytes, different word, and a
    // reader reports it as the app disagreeing with itself.
    stub()
    await render()

    expect(container.textContent, 'the unnamed application rendered as a blank label').toContain('(none)')
    expect(container.textContent, 'the unclassified protocol rendered as a blank label').toContain('?')
  })

  it('dates every figure it took from a run', async () => {
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
      if (text.includes(MIX_CADENCE)) found = text
      act(() => btn.click())
    }
    expect(found, 'no ⓘ on this tab quotes the mix schedule').not.toBe('')
    expect(found).toContain(MIX_WINDOW)
  })

  it('falls back to the live queries when nothing has been scheduled yet', async () => {
    stub({ rows: false, history: [] })
    await render()

    expect(liveScans()).toHaveLength(4)
    expect(container.textContent, 'a live figure was dated as if it came from a run').not.toMatch(/snapshot \d{2}:\d{2}/)
  })
})

describe('the states this entry must not serve', () => {
  it('takes every panel back to live the moment a filter is applied', async () => {
    // THE FAILURE THIS TAB CAN PRODUCE, ASSERTED. The typed text goes into the
    // query head, so the argument domain is unbounded free text and no stored
    // run holds it. All four hooks re-run live — including the KPI strip, whose
    // gate this entry copied.
    stub()
    await render()
    const before = submits.length

    type('.cap-filter', 'openai')
    act(() => button('Apply').click())
    await settle()

    const after = submits.slice(before)
    expect(after.filter((s) => s.query.includes('$vt_results')), 'a panel kept reading the schedule under a filter').toEqual([])
    expect(after.filter((s) => s.query.includes('src_ip="*openai*"')), 'the filter did not reach all four panels').toHaveLength(4)
  })

  it('serves the bar list only on the pivot this scan holds a key for', async () => {
    // src_ip on arrival is live (asserted above). Switching to App is the one
    // pivot `by app_name, l4_proto` can answer, and it is answered from the
    // stored rows with the sentinel group filtered out — which is precisely
    // what the live query's own `app_name=*` head does.
    stub()
    await render()
    const before = submits.length

    act(() => button('App').click())
    await settle()

    const after = submits.slice(before)
    expect(after.filter((s) => s.query.includes('gigamon_ami') && !s.query.includes('$vt_results')), 'switching pivot scanned the Lake').toEqual([])
    expect(after.some((s) => s.query.includes('where app != ""')), 'the bar list did not read the schedule on the App pivot').toBe(true)
  })
})

describe('the entry these panels read', () => {
  it('keeps both nullable group keys as groups of their own', () => {
    // The mechanism, not a number: every tail still parses without the
    // `extend`, and the totals simply come back short. Two sentinels because
    // both keys are nullable and each panel sums along the other one.
    expect(entry.body).toContain('extend app=iif(isnotnull(app_name), app_name, "")')
    expect(entry.body).toContain('l4=iif(isnotnull(l4_proto), l4_proto, "")')
    expect(appmix.tail, 'the donut must sum across every protocol, sentinel included').not.toContain('where l4')
    expect(l4.tail, 'the L4 split must sum across every application, sentinel included').not.toContain('where app')
    expect(talkers.tail, 'the bar list must exclude the sentinel, which is what its `app_name=*` head did').toContain('where app != ""')
  })

  it('derives every panel by summing, because nothing else re-aggregates exactly', () => {
    // THE WHOLE CORRECTNESS ARGUMENT OF THIS ENTRY. Summing an additive two-key
    // rollup along one key gives exactly what a one-key scan gives. An average,
    // a percentile or a distinct count does not compose that way — a summed
    // dcount double-counts anything under two keys, and an avg without its
    // weights is simply wrong. So a non-additive aggregate must never appear in
    // this body or any of its tails, and a future panel needing one needs a
    // grouping of its own or stays live.
    for (const text of [entry.body, ...entry.panels.map((p) => p.tail ?? '')]) {
      expect(text, 'a distinct count reached this entry').not.toContain('dcount(')
      expect(text, 'an average reached this entry').not.toContain('avg(')
      expect(text, 'a percentile reached this entry').not.toContain('percentile(')
    }
    for (const panel of entry.panels) expect(panel.tail).toContain('bytes=sum(bytes)')
  })

  it('caps each list in its tail and not in the scan', () => {
    // A `limit` in the body would cap the OTHER panels too: the top eight
    // applications' worth of bytes is not the L4 split, and the top twelve is
    // not the donut. The stored rows hold the whole grouping and each panel
    // takes its own view of it.
    expect(talkers.tail).toContain('limit 12')
    expect(appmix.tail).toContain('limit 8')
    expect(entry.body).not.toContain('limit')
    expect(entry.body).not.toContain('sort by')
  })
})

describe('the words about the schedule agree with the manifest', () => {
  it('quotes the cron and the window this app actually writes', () => {
    expect(entry.cron).toBe('47 * * * *')
    expect(entry.tz).toBe('UTC')
    expect(MIX_CADENCE).toContain('47 minutes past')
    expect(entry.earliest).toBe('-18m')
    expect(entry.latest).toBe('-3m')
    expect(MIX_WINDOW).toBe(SNAPSHOT_WINDOW)
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That the platform's `summarize … by` really drops a null group key. The
//     sentinel makes the answer not matter; nobody has measured it.
//   * That a stored two-key rollup summed along one key equals the live one-key
//     query on this workspace. That is arithmetic, not a platform behaviour —
//     but it rests on `$vt_results` accepting a `| summarize` in the read tail,
//     which the shipped DNS and Shadow AI entries also rest on and which this
//     suite stubs rather than runs.
//   * That the tab is faster. happy-dom has no network and no clock worth
//     reading; what is asserted is which queries were submitted, and against
//     what.
//   * Anything about the other two pivots. `src_ip` and
//     `dst_aws_flat_tags_name` are other entries' groupings (the audit's N10
//     and N11) and are not in this tranche; here they are only shown to stay
//     live.
