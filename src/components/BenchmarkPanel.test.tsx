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
//   (5) each confirmation states its cost line before anything is submitted.
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
import { BENCH_LEAD, BENCH_LEAD_TIP, FIFTEEN_LABEL, ONE_LABEL, PARQUET_CHOICE } from './benchmarkCopy'
import { PARQUET_DATASET } from '../cribl/benchmarkPlan'

interface Call { method: string; url: string; body?: string }
let calls: Call[] = []

interface Workspace {
  /** gigamon_ami_pq in the Lake listing, and its size. Absent when undefined. */
  pqSize?: number | null
  /** Rows the Parquet copy produces for every search (JSON produces 5). */
  pqRows?: number
  /** What the work meter says. */
  work?: number
}

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
      return res(200, { items: [{ id: `job-${submitted.length}` }] })
    }
    const m = /\/search\/jobs\/([^/?]+)(?:\/([a-z-]+))?/.exec(u)
    if (m) {
      const [, id, kind] = m
      if (kind === 'status') return res(200, { items: [{ status: 'completed' }] })
      if (kind === 'results') {
        const q = submitted[Number(id.split('-')[1]) - 1] ?? ''
        const rows = q.includes(PARQUET_DATASET) ? (ws.pqRows ?? 5) : 5
        return res(200, {}, JSON.stringify({ totalEventCount: rows, job: id }))
      }
      if (kind === 'metrics') return res(200, { items: [{ metrics: { cpuMetrics: { billableCPUSeconds: ws.work ?? 2.5 } } }] })
      if (kind === undefined) return res(200, { items: [{ id, status: 'completed', timeStarted: 10_000, timeCompleted: 10_400 }] })
    }
    return res(404, { message: 'not stubbed' })
  })
}

const submits = () => calls.filter((c) => c.method === 'POST' && /\/search\/jobs$/.test(c.url))

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
    for (const tip of tips) expect(tip).not.toMatch(/\b(P-S\d+|A-SP\d+|A-D\d+|I-D\d+|D-\d+|Phase \d|§)|\d{4}-\d\d-\d\d/)
    expect(bodyText()).not.toMatch(/\b(P-S\d+|A-SP\d+|I-D\d+|Phase \d)\b/)
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
  it('names the fastest store when both stores return the same rows', async () => {
    stub({ pqSize: 5e8, pqRows: 5 })
    await mount()
    await confirmStage(ONE_LABEL)
    await confirmStage(FIFTEEN_LABEL)
    // 3 searches × 2 stores × (1 warm-up + 3 measured), after the 6 one-minute runs.
    expect(submits()).toHaveLength(6 + 24)
    expect(bodyText()).toContain('15-minute benchmark')
    expect(bodyText()).toMatch(/Verdict: Cribl Lake · (JSON|Parquet) answered fastest/)
  })

  it('REFUSES a verdict when the stores return different row counts', async () => {
    stub({ pqSize: 5e8, pqRows: 43_338 })
    await mount()
    await confirmStage(ONE_LABEL)
    // The one-minute stage says so as well, without a winner.
    expect(bodyText()).toContain('the stores returned different numbers of rows over this minute')
    await confirmStage(FIFTEEN_LABEL)
    expect(bodyText()).not.toMatch(/Verdict:/)
    expect(bodyText()).toContain('No verdict: The stores did not return the same number of rows')
  })
})
