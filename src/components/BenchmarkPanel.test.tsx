// Guided Setup's store benchmark, rendered against a stubbed Cribl.
//
// The five things it must hold still:
//   (1) nothing is submitted on mount — the one request is the free Lake listing;
//   (2) the one-minute stage comes first: no 15-minute control exists until a
//       one-minute stage's work is on screen, and a stage whose work was not
//       reported keeps it refused, with the reason visible;
//   (3) a fastest store is refused when the row counts disagree;
//   (4) the Parquet choice is not rendered when gigamon_ami_pq is absent or
//       holds no data;
//   (5) each confirmation states its cost line before anything is submitted;
//   (6) the 15-minute stage checks when each store last landed data before it
//       picks its window: it moves the window back when a store is behind,
//       and refuses — running nothing else, with the reason on screen — when a
//       store is too far behind or holds nothing.
//
// WHAT THIS FILE CANNOT ESTABLISH: happy-dom has no layout, so nothing here is
// evidence about how the panel looks, and no focus navigation, so nothing here
// shows the dialog's focus handling (ConfirmDialog.test.tsx asserts its
// mechanism). The timings in these tests are whatever the stub says; they are
// not measurements of anything.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { BenchmarkPanel } from './BenchmarkPanel'
import * as copy from './benchmarkCopy'
import { BENCH_LEAD, BENCH_LEAD_TIP, FIFTEEN_LABEL, ONE_LABEL, PARQUET_CHOICE, STOPPED_NOTE, STOPPED_VERDICT, windowWords } from './benchmarkCopy'
import { BENCH_QUERIES } from '../queries/benchmark'
import { resetDenials } from '../cribl/authz'
import { PARQUET_DATASET } from '../cribl/benchmarkPlan'

/** Spike, phase, decision and section ids, and ISO dates: project history. */
const HISTORY = /\b(P-S\d+|A-SP\d+|A-D\d+|I-D\d+|D-\d+|Phase \d)|§|\d{4}-\d\d-\d\d/

interface Call { method: string; url: string; body?: string }
let calls: Call[] = []

interface Workspace {
  /** gigamon_ami_pq in the Lake listing, and its size. Absent when undefined. */
  pqSize?: number | null
  /** Rows the Parquet copy produces for every search (JSON produces 5). */
  pqRows?: number
  /** Added to every value the Parquet copy returns: same rows, other values. */
  pqShift?: number
  /** What the work meter says. */
  work?: number
  /** While `on`, every job reports `running`: a stage caught mid-run. */
  hold?: { readonly on: boolean }
  /** The status a job submit answers with (403: Cribl refuses it). */
  submitStatus?: number
  /**
   * What the landing check finds, per store: seconds between now and its
   * newest record (default 60), or null for an empty window (no row at all).
   */
  landedAgo?: { json?: number | null; pq?: number | null }
}

/** Server time the stub reports: the Parquet copy twice as fast as JSON. */
const JSON_MS = 800
const PQ_MS = 400

function res(status: number, body: unknown, text?: string) {
  const t = text ?? JSON.stringify(body)
  return { ok: status < 400, status, statusText: '', headers: new Headers(), text: async () => t, json: async () => JSON.parse(t) as unknown }
}

function stub(ws: Workspace = {}) {
  calls = []
  const submitted: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, url: u, body: init.body ? String(init.body) : undefined })
    if (u.includes('/lakes/default/datasets')) {
      const items: unknown[] = [{ id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: { currentSizeBytes: 1e11, metricsDate: '2026-09-25' } }]
      if (ws.pqSize !== undefined) {
        items.push({ id: PARQUET_DATASET, retentionPeriodInDays: 30, metrics: ws.pqSize === null ? {} : { currentSizeBytes: ws.pqSize, metricsDate: '2026-09-25' } })
      }
      return res(200, { items })
    }
    if (method === 'POST' && /\/search\/jobs$/.test(u)) {
      const { query } = JSON.parse(String(init.body)) as { query: string }
      submitted.push(query)
      if (ws.submitStatus) return res(ws.submitStatus, { message: 'Forbidden' })
      return res(200, { items: [{ id: `job-${submitted.length}` }] })
    }
    const m = /\/search\/jobs\/([^/?]+)(?:\/([a-z-]+))?/.exec(u)
    if (m) {
      const [, id, kind] = m
      const q = submitted[Number(id.split('-')[1]) - 1] ?? ''
      const pq = q.includes(PARQUET_DATASET)
      if (kind === 'status') return res(200, { items: [{ status: ws.hold?.on ? 'running' : 'completed' }] })
      // Stop cancels the job in flight on the server.
      if (kind === 'cancel') return res(200, { items: [{ id, status: 'canceled' }] })
      if (kind === 'results') {
        if (q.includes('newest=max(_time)')) {
          const ago = pq ? ws.landedAgo?.pq : ws.landedAgo?.json
          if (ago === null) return res(200, {}, JSON.stringify({ totalEventCount: 0, job: id }))
          const newest = Math.floor(Date.now() / 1000) - (ago ?? 60)
          return res(200, {}, [JSON.stringify({ totalEventCount: 1, job: id }), JSON.stringify({ newest, n: 1000, lag_s: ago ?? 60 })].join('\n'))
        }
        const n = pq ? (ws.pqRows ?? 5) : 5
        // Every row read back in full, so a search checked on values has one.
        const rows = Array.from({ length: n }, (_, i) => JSON.stringify({ v: i + (pq ? (ws.pqShift ?? 0) : 0) }))
        return res(200, {}, [JSON.stringify({ totalEventCount: n, job: id }), ...rows].join('\n'))
      }
      if (kind === 'metrics') return res(200, { items: [{ metrics: { cpuMetrics: { billableCPUSeconds: ws.work ?? 2.5 } } }] })
      if (kind === undefined) {
        return res(200, { items: [{ id, status: 'completed', timeStarted: 10_000, timeCompleted: 10_000 + (pq ? PQ_MS : JSON_MS) }] })
      }
    }
    return res(404, { message: 'not stubbed' })
  })
}

const submits = () => calls.filter((c) => c.method === 'POST' && /\/search\/jobs$/.test(c.url))

interface Sent { query: string; earliest: number; latest: number }
const sentBodies = (): Sent[] => submits().map((c) => JSON.parse(c.body!) as Sent)
const isLanding = (s: Sent) => s.query.includes('newest=max(_time)')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  resetDenials()
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

async function mount() {
  await act(async () => {
    root.render(
      <DashboardProvider>
        <BenchmarkPanel />
      </DashboardProvider>,
    )
  })
  await flush()
}

/** Until the stub-driven run has finished: no Stop button left. */
async function settle() {
  for (let i = 0; i < 400 && buttonNamed('Stop'); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
  await flush()
}

const bodyText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').trim() === name)

const dialog = () => document.body.querySelector('[role="dialog"]')

/** The dialog's own confirm button — "Run N searches". */
const confirmButton = () =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => /^Run \d+ searches$/.test((b.textContent ?? '').trim()))

async function press(b: HTMLButtonElement | undefined) {
  expect(b, 'button').toBeTruthy()
  await act(async () => { b!.click() })
  await flush()
}

/** Open a stage's confirmation and say yes. */
async function confirmStage(opener: string) {
  await press(buttonNamed(opener))
  expect(dialog()).toBeTruthy()
  await press(confirmButton())
  await settle()
}

describe('on mount', () => {
  it('submits no search, and reads only the Lake dataset listing', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    expect(submits()).toEqual([])
    expect(calls.every((c) => c.method === 'GET' && c.url.includes('/lakes/default/datasets'))).toBe(true)
    expect(calls.length).toBe(1)
    // …and nothing more arrives by itself.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(submits()).toEqual([])
  })

  it('says one short lead line, the rest behind its ⓘ, and no project history anywhere', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    expect(bodyText()).toContain(BENCH_LEAD)
    const tips = [...document.body.querySelectorAll('.infotip')].map((t) => t.getAttribute('aria-label') ?? '')
    expect(tips).toContain(BENCH_LEAD_TIP)
    for (const tip of tips) expect(tip).not.toMatch(HISTORY)
    expect(bodyText()).not.toMatch(/\b(P-S\d+|A-SP\d+|I-D\d+|Phase \d)\b/)
  })

  it('carries no project history in the words its ⓘ popovers and results show either', () => {
    // The .infotip scan above cannot see these: PanelInfo renders `about` only
    // inside its popover, and its icon's accessible name is the label. So the
    // strings themselves are checked — every search's reason, and every string
    // and sentence-builder the copy module exports.
    const words: string[] = [...BENCH_QUERIES.map((q) => q.why), ...BENCH_QUERIES.map((q) => q.label)]
    for (const v of Object.values(copy)) {
      if (typeof v === 'string') words.push(v)
      else if (typeof v === 'function') words.push(String((v as (...a: unknown[]) => unknown)('X', 'Y', 'Z', 'W', false)))
      else if (v && typeof v === 'object') words.push(...Object.values(v as Record<string, string>))
    }
    for (const w of words) expect(w).not.toMatch(HISTORY)
  })
})

describe('the Parquet choice', () => {
  it('is offered when gigamon_ami_pq exists and holds data', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    expect(bodyText()).toContain(PARQUET_CHOICE)
  })

  it('is not rendered when gigamon_ami_pq is absent — the page names only the JSON store', async () => {
    stub()
    await mount()
    expect(bodyText()).not.toContain(PARQUET_CHOICE)
    expect(bodyText()).toContain('Store: Cribl Lake · JSON (gigamon_ami)')
    const tips = [...document.body.querySelectorAll('.infotip')].map((t) => t.getAttribute('aria-label') ?? '')
    expect(tips.some((t) => t.includes(`no ${PARQUET_DATASET} dataset`))).toBe(true)
  })

  it('is not rendered while Lake reports no data in gigamon_ami_pq', async () => {
    stub({ pqSize: 0 })
    await mount()
    expect(bodyText()).not.toContain(PARQUET_CHOICE)
  })
})

describe('the one-minute stage', () => {
  it('states its cost line in the confirmation, and submits nothing until Run is pressed', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    await press(buttonNamed(ONE_LABEL))
    const d = dialog()
    expect(d).toBeTruthy()
    const text = (d!.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('6 searches, each run once over one minute')
    expect(text).toContain('Cribl puts no limit on the work a search does')
    expect(text).toContain('Row count — gigamon_ami_pq')
    expect(submits()).toEqual([])
    // Cancel sends nothing either.
    await press(buttonNamed('Cancel'))
    expect(dialog()).toBeNull()
    expect(submits()).toEqual([])
  })

  it('runs one search per store, one minute, reuse off, and shows the work each did', async () => {
    stub({ pqSize: 5e8, work: 2.5 })
    await mount()
    await confirmStage(ONE_LABEL)
    const sent = submits().map((c) => JSON.parse(c.body!) as { query: string; earliest: number; latest: number })
    expect(sent).toHaveLength(6)
    for (const s of sent) {
      expect(s.query).not.toContain('allow_previous_results')
      expect(s.latest - s.earliest).toBe(60)
    }
    expect(sent.filter((s) => s.query.includes(`dataset="${PARQUET_DATASET}"`))).toHaveLength(3)
    expect(bodyText()).toContain('One-minute stage')
    expect(bodyText()).toContain('Work done by this stage: 15 CPU-seconds.')
    // A single cold run is not a timing result: no verdict here.
    expect(bodyText()).not.toMatch(/Verdict:/)
  })
})

describe('the stage gate', () => {
  it('offers no 15-minute control before a one-minute stage has run', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    expect(buttonNamed(FIFTEEN_LABEL)).toBeUndefined()
  })

  it('offers it once the one-minute work is on screen, and its confirmation quotes that work multiplied out', async () => {
    stub({ pqSize: 5e8, work: 2.5 })
    await mount()
    await confirmStage(ONE_LABEL)
    const fifteen = buttonNamed(FIFTEEN_LABEL)
    expect(fifteen).toBeTruthy()
    expect(fifteen!.getAttribute('aria-disabled')).toBeNull()
    const before = submits().length
    await press(fifteen)
    const text = (dialog()!.textContent ?? '').replace(/\s+/g, ' ')
    // 6 pairs × 2.5 = 15 measured; × 15 × 4 = 900.
    expect(text).toContain('The one-minute stage did 15 CPU-seconds of work')
    expect(text).toContain('about 900 CPU-seconds')
    // The landing check is named and priced before anything runs: one per
    // store, from the row count's one-minute work × 25 minutes (2.5 × 25 each).
    expect(text).toContain('Landing check — gigamon_ami')
    expect(text).toContain(`Landing check — ${PARQUET_DATASET}`)
    expect(text).toContain('2 landing checks — one per store — read the last 25 minutes')
    expect(text).toContain('Expect about 125 CPU-seconds')
    expect(confirmButton()!.textContent).toBe('Run 26 searches')
    expect(text).toMatch(/assumption, not a measurement/)
    expect(submits().length).toBe(before)
  })

  it('keeps it refused, with the reason on screen, when the one-minute work was not reported', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub({ pqSize: 5e8, work: 0 })
    await mount()
    await press(buttonNamed(ONE_LABEL))
    await press(confirmButton())
    for (let i = 0; i < 40 && buttonNamed('Stop'); i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })
    }
    await flush()
    const fifteen = buttonNamed(FIFTEEN_LABEL)
    expect(fifteen).toBeTruthy()
    expect(fifteen!.getAttribute('aria-disabled')).toBe('true')
    expect(bodyText()).toContain('did not report the work done by')
    // …and the stage's total does not count that unreported work as zero.
    expect(bodyText()).toContain('Work done by this stage: not reported')
    expect(bodyText()).not.toContain('Work done by this stage: under 0.1')
    await press(fifteen)
    expect(dialog()).toBeNull()
  })

  it('closes again when the selection changes after the one-minute stage', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    await confirmStage(ONE_LABEL)
    expect(buttonNamed(FIFTEEN_LABEL)).toBeTruthy()
    const parquet = [...document.body.querySelectorAll<HTMLElement>('.bm-choice')]
      .find((el) => (el.textContent ?? '').includes(PARQUET_CHOICE))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(parquet).toBeTruthy()
    await act(async () => { parquet!.click() })
    await flush()
    expect(buttonNamed(FIFTEEN_LABEL)).toBeUndefined()
  })
})

describe('the 15-minute verdict', () => {
  /** Each search's verdict row, by the search's label. */
  const verdictOf = (label: string) => {
    const section = document.body.querySelector('section[aria-label="15-minute benchmark"]')
    const body = [...(section?.querySelectorAll('tbody') ?? [])].find((b) => (b.querySelector('th')?.textContent ?? '') === label)
    return (body?.querySelector('.bm-verdict')?.textContent ?? '').replace(/\s+/g, ' ')
  }

  it('names the store that was faster, and by how much, when both gave the same answer', async () => {
    stub({ pqSize: 5e8, pqRows: 5 })
    await mount()
    await confirmStage(ONE_LABEL)
    await confirmStage(FIFTEEN_LABEL)
    // 3 searches × 2 stores × (1 warm-up + 3 measured), after the 6 one-minute
    // runs and one landing check per store.
    expect(submits()).toHaveLength(6 + 2 + 24)
    expect(bodyText()).toContain('15-minute benchmark')
    // The stub times Parquet at 400 ms and JSON at 800: the winner and the
    // multiplier are both specific, so a reversed ordering fails here.
    expect(verdictOf('Row count')).toBe('Verdict: Cribl Lake · Parquet answered fastest, 2× faster than the slowest by server time. Every store returned the same rows, value for value.')
    expect(verdictOf('Flows by application and source')).toMatch(/^Verdict: Cribl Lake · Parquet answered fastest, 2× faster.*values are not compared/)
  })

  it('REFUSES a verdict when the stores return different row counts', async () => {
    stub({ pqSize: 5e8, pqRows: 12 })
    await mount()
    await confirmStage(ONE_LABEL)
    // The one-minute stage says so as well, without a winner.
    expect(bodyText()).toContain('the stores returned different numbers of rows over this minute')
    await confirmStage(FIFTEEN_LABEL)
    expect(bodyText()).not.toMatch(/Verdict:/)
    expect(bodyText()).toContain('No verdict: The stores did not return the same number of rows')
  })

  // A count returns one row from any store, and a per-minute trend one row per
  // minute, so equal row counts say nothing about them. Before 2026-09-25 this
  // named Parquet fastest for the row count whatever count it returned.
  it('REFUSES a verdict for a search whose rows match in number but not in value', async () => {
    stub({ pqSize: 5e8, pqRows: 5, pqShift: 1 })
    await mount()
    await confirmStage(ONE_LABEL)
    expect(bodyText()).toContain('Row count: the stores returned the same number of rows but different values over this minute')
    await confirmStage(FIFTEEN_LABEL)
    expect(verdictOf('Row count')).toMatch(/^No verdict: The stores returned the same number of rows but different values/)
    expect(verdictOf('Duplicate-ACK trend')).toMatch(/^No verdict: The stores returned the same number of rows but different values/)
    // A search checked on its row count alone still gets one, and says what it did not check.
    expect(verdictOf('Flows by application and source')).toMatch(/^Verdict: .*values are not compared/)
  })
})

describe('a stage in progress', () => {
  it('does not say "stopped" while the one-minute stage is running, and does once Stop is pressed', async () => {
    const hold = { on: true }
    stub({ pqSize: 5e8, hold })
    await mount()
    await press(buttonNamed(ONE_LABEL))
    await press(confirmButton())
    // A job is in flight: the progress line is up, the Stop button is there.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(buttonNamed('Stop')).toBeTruthy()
    expect(bodyText()).toMatch(/Running 1 of 6/)
    expect(bodyText()).not.toContain(STOPPED_NOTE)
    expect(bodyText()).not.toContain(STOPPED_VERDICT)
    await press(buttonNamed('Stop'))
    await settle()
    expect(bodyText()).toContain(STOPPED_NOTE)
  })

  it('shows no verdict, and no "stopped", in the 15-minute table while that stage runs', async () => {
    const hold = { on: false }
    stub({ pqSize: 5e8, hold })
    await mount()
    await confirmStage(ONE_LABEL)
    hold.on = true
    await press(buttonNamed(FIFTEEN_LABEL))
    await press(confirmButton())
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(buttonNamed('Stop')).toBeTruthy()
    expect(bodyText()).toContain('15-minute benchmark')
    expect(bodyText()).not.toContain(STOPPED_VERDICT)
    expect(bodyText()).not.toMatch(/No verdict:|Verdict:/)
    expect(bodyText()).toContain(copy.RUNNING_VERDICT)
    // Let it finish: the verdicts arrive, and still nothing says stopped.
    hold.on = false
    await settle()
    expect(bodyText()).not.toContain(STOPPED_VERDICT)
    expect(bodyText()).toMatch(/Verdict: Cribl Lake · Parquet answered fastest/)
  })
})

describe('when Cribl refuses the search submit', () => {
  it('stops the stage at the first refusal and closes the gate, naming the call', async () => {
    stub({ pqSize: 5e8, submitStatus: 403 })
    await mount()
    await confirmStage(ONE_LABEL)
    // Only the one refused submit went out: the others would be refused too.
    expect(submits()).toHaveLength(1)
    expect(bodyText()).toContain('Cribl refused POST /m/default_search/search/jobs (HTTP 403), so running the store benchmark did not complete')
    // The trigger stays reachable, is announced as unavailable, and opens nothing.
    const one = buttonNamed(ONE_LABEL)
    expect(one!.getAttribute('aria-disabled')).toBe('true')
    await press(one)
    expect(dialog()).toBeNull()
    // Try again opens it.
    await press(buttonNamed('Try again'))
    expect(buttonNamed(ONE_LABEL)!.getAttribute('aria-disabled')).toBeNull()
  })
})

describe('the landing check before the 15-minute stage', () => {
  const fifteenRuns = () => sentBodies().filter((b) => !isLanding(b) && b.latest - b.earliest === 900)
  const section = () => (document.body.querySelector('section[aria-label="15-minute benchmark"]')?.textContent ?? '').replace(/\s+/g, ' ')
  /** The 15-minute section's heading window, or null when the heading shows none. */
  const headingWindow = () => document.body.querySelector('section[aria-label="15-minute benchmark"] .bm-window')?.firstChild?.textContent ?? null

  it('reads each store before the stage, as written, reuse off, and keeps the usual window when both cover it', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    await confirmStage(ONE_LABEL)
    const t0 = Date.now()
    await confirmStage(FIFTEEN_LABEL)
    const sent = sentBodies()
    const landing = sent.filter(isLanding)
    expect(landing.map((b) => b.query)).toEqual([
      expect.stringContaining('dataset="gigamon_ami" | summarize newest=max(_time)'),
      expect.stringContaining(`dataset="${PARQUET_DATASET}" | summarize newest=max(_time)`),
    ])
    for (const b of landing) expect(b.query).not.toContain('allow_previous_results')
    // Both checks go out before the first 15-minute run.
    const firstRun = sent.findIndex((b) => !isLanding(b) && b.latest - b.earliest === 900)
    expect(sent.findIndex(isLanding)).toBeLessThan(firstRun)
    expect(sent.map(isLanding).lastIndexOf(true)).toBeLessThan(firstRun)
    // The usual window: whole minutes, ending ten minutes ago.
    const usualEnd = Math.floor(t0 / 60_000) * 60 - 600
    for (const b of fifteenRuns()) expect(Math.abs(b.latest - usualEnd)).toBeLessThanOrEqual(60)
    expect(section()).toContain('Every store’s newest record is late enough that the window was not moved.')
    expect(section()).toMatch(/Verdict:/)
    const [end] = fifteenRuns().map((b) => b.latest)
    expect(headingWindow()).toBe(windowWords({ earliest: end - 900, latest: end }))
  })

  it('moves the window back, in whole minutes, when the Parquet copy is behind', async () => {
    // The Parquet copy's newest record is 18 minutes old: less 5 for open
    // files, it holds everything up to about 23 minutes ago.
    stub({ pqSize: 5e8, landedAgo: { pq: 18 * 60 } })
    await mount()
    await confirmStage(ONE_LABEL)
    const t0 = Math.floor(Date.now() / 1000)
    await confirmStage(FIFTEEN_LABEL)
    // The stub dates the newest record when it reads results, between t0 and
    // t1: the upper bound is taken after the stage, or a minute boundary
    // crossed in between would fail a correct window.
    const t1 = Math.floor(Date.now() / 1000)
    const runs = fifteenRuns()
    expect(runs).toHaveLength(24)
    const ends = new Set(runs.map((b) => b.latest))
    expect(ends.size).toBe(1)
    const [end] = [...ends]
    expect(end % 60).toBe(0)
    expect(end).toBeLessThanOrEqual(t1 - 18 * 60 - 300)
    expect(end).toBeGreaterThan(t0 - 18 * 60 - 300 - 120)
    expect(section()).toMatch(/The window was moved back \d+ minutes, to end where every store’s newest record, less 5 minutes, allows\./)
    // The heading shows the window the runs read, not the usual one.
    expect(headingWindow()).toBe(windowWords({ earliest: end - 900, latest: end }))
    expect(section()).toContain(`${PARQUET_DATASET}’s newest record is from`)
  })

  it('refuses the stage, running nothing else, when a store is more than 15 minutes too far behind', async () => {
    stub({ pqSize: 5e8, landedAgo: { pq: 40 * 60 } })
    await mount()
    await confirmStage(ONE_LABEL)
    const before = submits().length
    await confirmStage(FIFTEEN_LABEL)
    // Only the two landing checks went out.
    expect(submits().length - before).toBe(2)
    expect(fifteenRuns()).toEqual([])
    expect(section()).toContain(`${PARQUET_DATASET}’s newest record is from`)
    expect(section()).toContain('more than 15 minutes before the window’s usual end')
    expect(section()).toContain('The 15-minute stage ran nothing else')
    // No window was measured, so the heading names none.
    expect(headingWindow()).toBeNull()
    // A refusal is not a stop, and names no verdict.
    expect(bodyText()).not.toContain(STOPPED_VERDICT)
    expect(bodyText()).not.toMatch(/Verdict:/)
  })

  it('refuses the stage when a store has landed nothing in the window it reads', async () => {
    stub({ pqSize: 5e8, landedAgo: { pq: null } })
    await mount()
    await confirmStage(ONE_LABEL)
    await confirmStage(FIFTEEN_LABEL)
    expect(fifteenRuns()).toEqual([])
    expect(section()).toContain(`Nothing has landed in ${PARQUET_DATASET} since`)
  })

  it('reads no further store once one already refuses the stage — each check is billed', async () => {
    stub({ pqSize: 5e8, landedAgo: { json: null } })
    await mount()
    await confirmStage(ONE_LABEL)
    const before = submits().length
    await confirmStage(FIFTEEN_LABEL)
    // Only the JSON check went out: nothing the Parquet copy says could change the outcome.
    expect(submits().length - before).toBe(1)
    expect(sentBodies().filter(isLanding).map((b) => b.query)).toEqual([expect.stringContaining('dataset="gigamon_ami" |')])
    expect(fifteenRuns()).toEqual([])
    expect(section()).toContain('Nothing has landed in gigamon_ami since')
    expect(section()).toContain(`${PARQUET_DATASET} was not checked`)
    expect(bodyText()).not.toContain(STOPPED_VERDICT)
  })

  it('stops at a refused landing-check submit and closes the gate, naming the call', async () => {
    const ws: Workspace = { pqSize: 5e8 }
    stub(ws)
    await mount()
    await confirmStage(ONE_LABEL)
    ws.submitStatus = 403
    const before = submits().length
    await confirmStage(FIFTEEN_LABEL)
    // Exactly one landing submit: the next store's would be refused the same way.
    expect(submits().length - before).toBe(1)
    expect(sentBodies().filter(isLanding)).toHaveLength(1)
    expect(fifteenRuns()).toEqual([])
    expect(bodyText()).not.toContain(STOPPED_VERDICT)
    // Both outer triggers are closed, announced as unavailable, and point at the refusal.
    const why = 'Cribl refused POST /m/default_search/search/jobs (HTTP 403)'
    expect(bodyText()).toContain(why)
    for (const label of [ONE_LABEL, FIFTEEN_LABEL]) {
      const b = buttonNamed(label)
      expect(b, label).toBeTruthy()
      expect(b!.getAttribute('aria-disabled')).toBe('true')
      const ids = (b!.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      const described = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      expect(described).toContain(why)
      await press(b)
      expect(dialog()).toBeNull()
    }
  })

  it('checks the JSON dataset alone when the Parquet copy is not offered', async () => {
    stub({ landedAgo: { json: 30 } })
    await mount()
    await confirmStage(ONE_LABEL)
    await press(buttonNamed(FIFTEEN_LABEL))
    const text = (dialog()!.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('one landing check reads the last 25 minutes')
    expect(text).not.toContain(`Landing check — ${PARQUET_DATASET}`)
    await press(confirmButton())
    await settle()
    expect(sentBodies().filter(isLanding).map((b) => b.query)).toEqual([expect.stringContaining('dataset="gigamon_ami" |')])
  })

  it('says what it is checking while it checks, and Stop during the check is a stop, not a failure', async () => {
    const hold = { on: false }
    stub({ pqSize: 5e8, hold })
    await mount()
    await confirmStage(ONE_LABEL)
    hold.on = true
    await press(buttonNamed(FIFTEEN_LABEL))
    await press(confirmButton())
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(bodyText()).toContain('Checking when the newest record landed in gigamon_ami…')
    await press(buttonNamed('Stop'))
    await settle()
    expect(fifteenRuns()).toEqual([])
    expect(bodyText()).toContain(STOPPED_VERDICT)
    expect(document.body.querySelector('.sl-note-warn[role="status"]')).toBeNull()
  })

  it('Stop part way through the check claims no window: it says the check was stopped', async () => {
    // The JSON check completes; every job after the Parquet check's submit stays running.
    const hold = { get on() { return sentBodies().filter(isLanding).length >= 2 } }
    stub({ pqSize: 5e8, hold })
    await mount()
    await confirmStage(ONE_LABEL)
    await press(buttonNamed(FIFTEEN_LABEL))
    await press(confirmButton())
    const checkingPq = `Checking when the newest record landed in ${PARQUET_DATASET}…`
    for (let i = 0; i < 200 && !bodyText().includes(checkingPq); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
    }
    expect(bodyText()).toContain(checkingPq)
    await press(buttonNamed('Stop'))
    await settle()
    expect(fifteenRuns()).toEqual([])
    expect(section()).toContain('gigamon_ami’s newest record is from')
    expect(section()).toContain('The landing check was stopped before every store was checked, so no window was chosen.')
    expect(section()).not.toMatch(/window was (not )?moved|moved back/)
    expect(headingWindow()).toBeNull()
    expect(bodyText()).toContain(STOPPED_VERDICT)
  })

  it('sends nothing for the landing check until the 15-minute stage is confirmed', async () => {
    stub({ pqSize: 5e8 })
    await mount()
    await confirmStage(ONE_LABEL)
    expect(sentBodies().filter(isLanding)).toEqual([])
    await press(buttonNamed(FIFTEEN_LABEL))
    expect(sentBodies().filter(isLanding)).toEqual([])
    await press(buttonNamed('Cancel'))
    expect(sentBodies().filter(isLanding)).toEqual([])
  })
})
