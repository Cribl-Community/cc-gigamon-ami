// Which dataset the app reads, decided from reads alone.
//
// The states the owner named (2026-09-24): sample data only while the
// customer's dataset holds none; real wins when both exist; neither → today's
// app on `gigamon_ami`. Plus the two this file adds because they are what goes
// wrong in practice: Lake's size figure is daily and can be absent on a
// populated dataset, and a probe can fail — both must end on REAL, never on
// sample data shown over a customer's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeDataset, searchUiUrl } from './config'
import { dataMode, resetDataMode } from './dataMode'
import {
  HOLD_DEADLINE_MS,
  datasetTarget,
  judgeListing,
  judgeProbe,
  TICK_RECHECK_MS,
  realDataConfirmed,
  recheckDatasetTarget,
  recheckDatasetTargetOnTick,
  resetDatasetTarget,
  resolveDatasetTarget,
  settleDatasetTarget,
  type TargetReason,
} from './datasetTarget'
import type { LakeDataset, ReadResult } from './lake'
import { runSearch } from './search'
import { REAL_DATA_PROBE_QUERY } from '../queries/datasets'

const ds = (id: string, over: Partial<LakeDataset> = {}): LakeDataset => ({
  id,
  description: null,
  format: 'json',
  retentionPeriodInDays: 30,
  acceleratedFields: null,
  searchConfig: null,
  deletionStartedAt: null,
  metrics: null,
  raw: {},
  ...over,
})
const listed = (...items: LakeDataset[]): ReadResult<LakeDataset[]> => ({ outcome: 'ok', value: items, object: 'x', status: 200, detail: null })
const sized = (bytes: number | null) => ({ metrics: { currentSizeBytes: bytes, metricsDate: '2026-09-23' } })

describe('judgeListing — what one free GET decides', () => {
  it('reads the customer dataset, as before, when there is no sample dataset', () => {
    expect(judgeListing(listed(ds('gigamon_ami', sized(0))))).toEqual({ kind: 'real', reason: 'no-sample' })
    expect(judgeListing(listed())).toEqual({ kind: 'real', reason: 'no-sample' })
  })

  it('reads the sample when the customer dataset does not exist', () => {
    expect(judgeListing(listed(ds('gigamon_ami_sample')))).toEqual({ kind: 'sample', reason: 'real-absent' })
  })

  it('treats a dataset being deleted as absent', () => {
    const deleting = { deletionStartedAt: '2026-09-24T00:00:00Z' }
    expect(judgeListing(listed(ds('gigamon_ami', sized(5)), ds('gigamon_ami_sample', deleting)))).toEqual({ kind: 'real', reason: 'no-sample' })
    expect(judgeListing(listed(ds('gigamon_ami', deleting), ds('gigamon_ami_sample')))).toEqual({ kind: 'sample', reason: 'real-absent' })
  })

  it('lets real data win on Lake’s own size figure, with no search', () => {
    expect(judgeListing(listed(ds('gigamon_ami', sized(111_115_242_355)), ds('gigamon_ami_sample', sized(9))))).toEqual({ kind: 'real', reason: 'has-data' })
  })

  it('probes when the size is zero, because the figure is a day old', () => {
    expect(judgeListing(listed(ds('gigamon_ami', sized(0)), ds('gigamon_ami_sample')))).toEqual({ kind: 'probe', earliest: '-30d' })
  })

  it('probes when the size is absent, because a populated dataset can report none', () => {
    // Measured 2026-09-24: cribl_metrics answers `metrics: {}` with 30 days in it.
    expect(judgeListing(listed(ds('gigamon_ami'), ds('gigamon_ami_sample')))).toEqual({ kind: 'probe', earliest: '-30d' })
    expect(judgeListing(listed(ds('gigamon_ami', sized(null)), ds('gigamon_ami_sample')))).toEqual({ kind: 'probe', earliest: '-30d' })
  })

  it('probes the customer dataset’s whole retention', () => {
    expect(judgeListing(listed(ds('gigamon_ami', { retentionPeriodInDays: 365 }), ds('gigamon_ami_sample')))).toEqual({ kind: 'probe', earliest: '-365d' })
  })

  it('reads the customer dataset when the listing cannot be read', () => {
    expect(judgeListing({ outcome: 'not-readable', value: null, object: 'x', status: 403, detail: null })).toEqual({ kind: 'real', reason: 'unreadable' })
    expect(judgeListing({ outcome: 'failed', value: null, object: 'x', status: 500, detail: null })).toEqual({ kind: 'real', reason: 'unreadable' })
  })
})

describe('judgeProbe', () => {
  it('is real on a record, sample on none, and real on a failure', () => {
    expect(judgeProbe('found')).toEqual({ kind: 'real', reason: 'probe-found' })
    expect(judgeProbe('empty')).toEqual({ kind: 'sample', reason: 'real-empty' })
    expect(judgeProbe('failed')).toEqual({ kind: 'real', reason: 'probe-failed' })
  })
})

// ── The read path, end to end ───────────────────────────────────────────────

interface Call {
  method: string
  url: string
  body: string | null
}

function res(status: number, body: unknown, asText?: string) {
  return {
    ok: status < 400,
    status,
    statusText: 'x',
    headers: new Headers(),
    json: async () => body,
    text: async () => asText ?? JSON.stringify(body),
  }
}

let calls: Call[] = []
let listing: unknown[] = []
/** Rows the probe answers with. */
let probeRows: unknown[] = []
let probeFails = false

function stub(): void {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    calls.push({ method, url: u, body: init.body ? String(init.body) : null })
    if (u.includes('/lakes/default/datasets')) return res(200, { items: listing })
    if (method === 'POST' && /\/search\/jobs$/.test(u)) {
      if (probeFails) return res(400, { message: 'bad' })
      return res(200, { items: [{ id: 'probe-1' }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      return res(200, {}, [JSON.stringify({ totalEventCount: probeRows.length, job: 'j' }), ...probeRows.map((r) => JSON.stringify(r))].join('\n'))
    }
    return res(404, {})
  })
}

const submitted = () => calls.filter((c) => c.method === 'POST' && /\/search\/jobs$/.test(c.url)).map((c) => (JSON.parse(c.body ?? '{}') as { query: string }).query)
/** Anything but a GET, other than submitting the probe itself. */
const writes = () => calls.filter((c) => c.method !== 'GET' && !/\/search\/jobs$/.test(c.url))

beforeEach(() => {
  resetDataMode()
  resetDatasetTarget()
  listing = []
  probeRows = []
  probeFails = false
  stub()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetDataMode()
})

describe('resolveDatasetTarget', () => {
  it('starts not known, on the customer dataset', () => {
    expect(datasetTarget()).toMatchObject({ known: false, sample: false, dataset: 'gigamon_ami' })
  })

  it('an install with no sample dataset: one GET, no search, nothing written', async () => {
    listing = [{ id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: {} }]
    const t = await resolveDatasetTarget()
    expect(t).toMatchObject({ known: true, sample: false, dataset: 'gigamon_ami', reason: 'no-sample' })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
    expect(activeDataset()).toBe('gigamon_ami')
    expect(dataMode()).toBe('snapshot')
  })

  it('both exist and Lake counts real data: real, with no search', async () => {
    listing = [
      { id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: { currentSizeBytes: 10, metricsDate: '2026-09-23' } },
      { id: 'gigamon_ami_sample', retentionPeriodInDays: 7, metrics: { currentSizeBytes: 10, metricsDate: '2026-09-23' } },
    ]
    expect(await resolveDatasetTarget()).toMatchObject({ sample: false, reason: 'has-data' })
    expect(submitted()).toEqual([])
  })

  it('only sample data: one probe of the CUSTOMER dataset, then everything moves to the sample', async () => {
    listing = [
      { id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: { currentSizeBytes: 0, metricsDate: '2026-09-23' } },
      { id: 'gigamon_ami_sample', retentionPeriodInDays: 7, metrics: {} },
    ]
    const t = await resolveDatasetTarget()
    expect(t).toMatchObject({ known: true, sample: true, dataset: 'gigamon_ami_sample', reason: 'real-empty' })
    // The probe runs as written — it asks about gigamon_ami by definition.
    expect(submitted().map((q) => q.replace(/^(?:set [^;]+;\s*)+/, ''))).toEqual([REAL_DATA_PROBE_QUERY])
    expect(writes()).toEqual([])
    // What the verdict moved.
    expect(activeDataset()).toBe('gigamon_ami_sample')
    expect(dataMode(), 'Snapshot steps aside').toBe('live')
    expect(new URL(searchUiUrl('dataset="gigamon_ami" | limit 3', '-1h'), 'http://x').searchParams.get('q')).toBe('dataset="gigamon_ami_sample" | limit 3')
  })

  it('moves every other query onto the sample at submit', async () => {
    listing = [{ id: 'gigamon_ami_sample', retentionPeriodInDays: 7, metrics: {} }]
    await resolveDatasetTarget()
    calls = []
    await runSearch('dataset="gigamon_ami" | summarize c=count()', { pollMs: 0 })
    expect(submitted()[0]).toMatch(/dataset="gigamon_ami_sample" \| summarize c=count\(\)$/)
    // …except a caller that asks for the query as written.
    calls = []
    await runSearch('dataset="gigamon_ami" | summarize c=count()', { pollMs: 0, asWritten: true })
    expect(submitted()[0]).toMatch(/dataset="gigamon_ami" \| summarize c=count\(\)$/)
  })

  it('real data found by the probe wins over the sample', async () => {
    listing = [{ id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: {} }, { id: 'gigamon_ami_sample', metrics: {} }]
    probeRows = [{ src_ip: '10.0.0.1' }]
    expect(await resolveDatasetTarget()).toMatchObject({ sample: false, dataset: 'gigamon_ami', reason: 'probe-found' })
    expect(dataMode()).toBe('snapshot')
  })

  it('a failed probe is real — never sample data over a customer’s own', async () => {
    listing = [{ id: 'gigamon_ami', metrics: {} }, { id: 'gigamon_ami_sample', metrics: {} }]
    probeFails = true
    expect(await resolveDatasetTarget()).toMatchObject({ sample: false, reason: 'probe-failed' })
  })

  it('reads once per page load: a second caller gets the same answer with no request', async () => {
    listing = [{ id: 'gigamon_ami_sample', metrics: {} }]
    await Promise.all([resolveDatasetTarget(), resolveDatasetTarget()])
    await resolveDatasetTarget()
    expect(calls.filter((c) => c.url.includes('/lakes/default/datasets'))).toHaveLength(1)
  })

  it('a refresh looks again while on the sample, and moves back once real data lands', async () => {
    listing = [{ id: 'gigamon_ami', metrics: {} }, { id: 'gigamon_ami_sample', metrics: {} }]
    await resolveDatasetTarget()
    expect(datasetTarget().sample).toBe(true)
    probeRows = [{ src_ip: '10.0.0.1' }]
    recheckDatasetTarget()
    await vi.waitFor(() => expect(datasetTarget().sample).toBe(false))
    expect(datasetTarget()).toMatchObject({ reason: 'probe-found', dataset: 'gigamon_ami' })
    expect(activeDataset()).toBe('gigamon_ami')
    expect(dataMode(), 'Snapshot comes back').toBe('snapshot')
    expect(writes()).toEqual([])
  })

  it('a refresh on real data reads nothing — that verdict is final for the page', async () => {
    listing = [{ id: 'gigamon_ami', metrics: {} }]
    await resolveDatasetTarget()
    calls = []
    recheckDatasetTarget()
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('does not hold the panels forever: past the deadline it proceeds on the customer dataset, then moves', async () => {
    vi.useFakeTimers()
    let answer: (v: unknown) => void = () => {}
    vi.stubGlobal('fetch', (url: string) => {
      calls.push({ method: 'GET', url: String(url), body: null })
      return new Promise((r) => { answer = r })
    })
    const p = resolveDatasetTarget()
    expect(datasetTarget().known).toBe(false)
    await vi.advanceTimersByTimeAsync(HOLD_DEADLINE_MS)
    expect(datasetTarget()).toMatchObject({ known: true, sample: false, reason: 'deadline' })
    answer(res(200, { items: [{ id: 'gigamon_ami_sample', metrics: {} }] }))
    await p
    await vi.advanceTimersByTimeAsync(0)
    expect(datasetTarget()).toMatchObject({ known: true, sample: true, reason: 'real-absent' })
  })
})

// ── Review 2026-09-24 ────────────────────────────────────────────────────────

describe('a cost measured on the sample is not kept as the cost of real data', () => {
  it('measures again once the same panel text runs against the customer dataset', async () => {
    // A slot holds one measurement per query and range. The job body moves at
    // submit, so the key has to name the dataset that ran — or a 0.1 CPU-s
    // sample figure would price a real-data job forever.
    listing = [{ id: 'gigamon_ami_sample', metrics: {} }]
    await resolveDatasetTarget()
    let cpu = 0.1
    const base = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/metrics')) return res(200, { items: [{ metrics: { cpuMetrics: { billableCPUSeconds: cpu } } }] })
      return base(url, init)
    })
    const slot = { id: 9001, autoRefresh: true, willRun: true, key: null, cpuSeconds: null, liveHint: null }
    const text = 'dataset="gigamon_ami" | summarize c=count()'
    await runSearch(text, { pollMs: 0, costSlot: slot })
    await vi.waitFor(() => expect(slot.cpuSeconds).toBe(0.1))
    settleDatasetTarget(false, 'probe-found')
    cpu = 130
    await runSearch(text, { pollMs: 0, costSlot: slot })
    await vi.waitFor(() => expect(slot.cpuSeconds).toBe(130))
  })
})

describe('an auto-refresh tick looks again while on the sample, throttled', () => {
  it('does nothing on a tick soon after the last look, and looks once the throttle has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_790_000_000_000)
    listing = [{ id: 'gigamon_ami', metrics: {} }, { id: 'gigamon_ami_sample', metrics: {} }]
    await resolveDatasetTarget()
    expect(datasetTarget().sample).toBe(true)
    probeRows = [{ src_ip: '10.0.0.1' }]
    calls = []
    recheckDatasetTargetOnTick()
    await Promise.resolve()
    expect(calls, 'a tick inside the throttle reads nothing').toEqual([])
    vi.setSystemTime(1_790_000_000_000 + TICK_RECHECK_MS)
    recheckDatasetTargetOnTick()
    await vi.waitFor(() => expect(datasetTarget().sample).toBe(false))
    expect(datasetTarget()).toMatchObject({ reason: 'probe-found', dataset: 'gigamon_ami' })
    expect(writes()).toEqual([])
  })

  it('reads nothing on a tick once the verdict is real', async () => {
    listing = [{ id: 'gigamon_ami', metrics: {} }]
    await resolveDatasetTarget()
    calls = []
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 10 * TICK_RECHECK_MS)
    recheckDatasetTargetOnTick()
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('is at most every ten minutes', () => {
    expect(TICK_RECHECK_MS).toBe(10 * 60_000)
  })
})

describe('whether a schedule may be turned on', () => {
  it('only on a final verdict of real data', () => {
    const t = (known: boolean, sample: boolean, reason: TargetReason) => ({ known, sample, dataset: 'x', reason })
    expect(realDataConfirmed(t(false, false, 'reading'))).toBe(false)
    expect(realDataConfirmed(t(true, false, 'deadline')), 'the provisional answer is not an answer').toBe(false)
    expect(realDataConfirmed(t(true, true, 'real-empty'))).toBe(false)
    expect(realDataConfirmed(t(true, true, 'real-absent'))).toBe(false)
    for (const r of ['no-sample', 'has-data', 'probe-found', 'unreadable', 'probe-failed'] as const) {
      expect(realDataConfirmed(t(true, false, r)), r).toBe(true)
    }
  })
})
