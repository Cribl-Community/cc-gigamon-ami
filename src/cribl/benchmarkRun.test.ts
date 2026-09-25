// The store benchmark's network half, against a stubbed Cribl: what one run
// submits, what it reads back, and that a plan never has two searches in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runOne, runPlan, WORK_RETRY_MS } from './benchmarkRun'
import { benchPlan, benchTargets, PARQUET_DATASET, probePlan, stageWindow } from './benchmarkPlan'
import { setQueryRouter } from './search'
import type { LakeDataset, ReadResult } from './lake'

const ds = (id: string): LakeDataset => ({
  id,
  description: null,
  format: null,
  retentionPeriodInDays: 30,
  acceleratedFields: null,
  searchConfig: null,
  deletionStartedAt: null,
  metrics: { currentSizeBytes: 1e9, metricsDate: '2026-09-25' },
  raw: {},
})
const LISTING: ReadResult<LakeDataset[]> = { outcome: 'ok', value: [ds('gigamon_ami'), ds(PARQUET_DATASET)], object: '', status: 200, detail: null }
const TARGETS = benchTargets(LISTING, { sampleOnly: false, includeParquet: true })
const WINDOW = stageWindow('one', Date.UTC(2026, 8, 25, 14, 0))

interface Submit { query: string; earliest: unknown; latest: unknown }

let submits: Submit[] = []
let inFlight = 0
let maxInFlight = 0
let meter: (jobId: string, read: number) => number
let failNext = false

function res(status: number, body: unknown, text?: string) {
  const t = text ?? JSON.stringify(body)
  return { ok: status < 400, status, statusText: '', headers: new Headers(), text: async () => t, json: async () => JSON.parse(t) as unknown }
}

beforeEach(() => {
  submits = []
  inFlight = 0
  maxInFlight = 0
  failNext = false
  const reads = new Map<string, number>()
  meter = () => 3.5
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    if (method === 'POST' && /\/search\/jobs$/.test(u)) {
      const body = JSON.parse(String(init.body)) as Submit
      submits.push(body)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return res(200, { items: [{ id: `job-${submits.length}` }] })
    }
    const m = /\/search\/jobs\/([^/?]+)(?:\/([a-z-]+))?/.exec(u)
    if (m) {
      const [, id, kind] = m
      if (kind === 'status') {
        if (failNext) {
          failNext = false
          inFlight--
          return res(200, { items: [{ status: 'failed' }] })
        }
        return res(200, { items: [{ status: 'completed' }] })
      }
      if (kind === 'results') {
        inFlight--
        const q = submits[Number(id.split('-')[1]) - 1].query
        const rows = q.includes(PARQUET_DATASET) ? 7 : 5
        return res(200, {}, [JSON.stringify({ totalEventCount: rows, job: id }), '{"c":1}'].join('\n'))
      }
      if (kind === 'metrics') {
        const n = (reads.get(id) ?? 0) + 1
        reads.set(id, n)
        return res(200, { items: [{ metrics: { cpuMetrics: { billableCPUSeconds: meter(id, n) } } }] })
      }
      if (kind === undefined) {
        return res(200, { items: [{ id, status: 'completed', timeCreated: 1_000, timeStarted: 2_000, timeCompleted: 2_750 }] })
      }
    }
    return res(404, { message: 'not stubbed' })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setQueryRouter(null)
})

describe('one run', () => {
  it('submits the app’s own text on the store named, over the absolute window, with reuse off', async () => {
    const [plan] = probePlan(['count'], TARGETS.slice(1))
    const r = await runOne(plan, WINDOW)
    expect(submits).toHaveLength(1)
    const sent = submits[0]
    expect(sent.query).toContain(`dataset="${PARQUET_DATASET}" | summarize c=count()`)
    expect(sent.query).not.toContain('allow_previous_results')
    expect(sent.earliest).toBe(WINDOW.earliest)
    expect(sent.latest).toBe(WINDOW.latest)
    expect(r.query).toBe(`dataset="${PARQUET_DATASET}" | summarize c=count()`)
  })

  it('is never moved by the query router: it measures the store it names', async () => {
    setQueryRouter((q) => q.replace('dataset="gigamon_ami"', `dataset="${PARQUET_DATASET}"`))
    const [plan] = probePlan(['count'], TARGETS.slice(0, 1))
    await runOne(plan, WINDOW)
    expect(submits[0].query).toContain('dataset="gigamon_ami" |')
  })

  it('reports the job’s own server time, client wall, work and the rows it PRODUCED', async () => {
    const [plan] = probePlan(['count'], TARGETS.slice(0, 1))
    const r = await runOne(plan, WINDOW)
    expect(r.serverMs).toBe(750)
    expect(r.clientMs).toBeGreaterThanOrEqual(0)
    expect(r.cpuSeconds).toBe(3.5)
    // totalEventCount, not the one row read back.
    expect(r.rows).toBe(5)
    expect(r.error).toBeUndefined()
  })

  it('reads the work meter again when it first says 0, and reports "not reported" rather than 0 if it still does', async () => {
    vi.useFakeTimers()
    meter = (_id, n) => (n === 1 ? 0 : 8.25)
    const [plan] = probePlan(['count'], TARGETS.slice(0, 1))
    const pending = runOne(plan, WINDOW)
    await vi.advanceTimersByTimeAsync(WORK_RETRY_MS + 10)
    expect((await pending).cpuSeconds).toBe(8.25)

    meter = () => 0
    const pending2 = runOne(plan, WINDOW)
    await vi.advanceTimersByTimeAsync(WORK_RETRY_MS + 10)
    expect((await pending2).cpuSeconds).toBeNull()
  })

  it('returns a failed search as a result carrying Cribl’s outcome, not as a thrown error', async () => {
    failNext = true
    const [plan] = probePlan(['count'], TARGETS.slice(0, 1))
    const r = await runOne(plan, WINDOW)
    expect(r.error).toMatch(/failed/)
    expect(r.cpuSeconds).toBeNull()
    expect(r.rows).toBeNull()
  })
})

describe('a plan', () => {
  it('runs strictly one search at a time, in plan order', async () => {
    const plan = benchPlan(['count'], TARGETS)
    const seen: string[] = []
    const out = await runPlan(plan, WINDOW, (r) => seen.push(r.targetId), () => undefined)
    expect(out.stopped).toBe(false)
    expect(maxInFlight).toBe(1)
    expect(submits).toHaveLength(plan.length)
    expect(seen).toEqual(plan.map((p) => p.target.id))
  })

  it('stops at an abort and submits nothing after it', async () => {
    const plan = benchPlan(['count'], TARGETS)
    const ctl = new AbortController()
    const out = await runPlan(plan, WINDOW, (_r, done) => { if (done === 2) ctl.abort() }, () => undefined, ctl.signal)
    expect(out.stopped).toBe(true)
    expect(submits).toHaveLength(2)
  })
})
