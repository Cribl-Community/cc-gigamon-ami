import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { setDataMode } from '../cribl/dataMode'
import { DATASET_RECORDS_QUERY } from '../queries/dataFlow'
import type { MetricsRequest } from '../cribl/streamMetrics'
import { settleDatasetTarget } from '../cribl/datasetTarget'
import { DataFlow } from './DataFlow'

const CONNECTED = {
  type: 'http_raw', sendToRoutes: false,
  connections: [{ pipeline: 'gigamon', output: 'gigamon_lake' }],
}
const path = { group: 'default', sourceId: 'in_gigamon_ami_http', pipeline: 'gigamon', destination: 'gigamon_lake' }
const COUNTERS = {
  src_samples: 2, src_events: 123, pipe_samples: 2, pipe_events: 100,
  dst_samples: 2, dst_events: 90, dst_byte_samples: 2, dst_bytes: 4096,
}
let sources: Record<string, unknown>[]
let row: Record<string, number>
let recordRow: Record<string, unknown>
let inputStatus: number
let failSearch: boolean
let failRecords: boolean
let submits: { query: string; earliest: string }[]
let metricRequests: MetricsRequest[]
let inputReads: number
let container: HTMLDivElement
let root: Root

const response = (status: number, body: unknown, text?: string) => ({
  ok: status < 400, status, statusText: status === 200 ? 'OK' : 'Forbidden',
  json: async () => body, text: async () => text ?? JSON.stringify(body),
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  sources = [{ id: path.sourceId, ...CONNECTED }]
  row = { ...COUNTERS }
  recordRow = { events: 75, byte_records: 75, bytes: 8192, packet_records: 75, packets: 150 }
  inputStatus = 200
  failSearch = false
  failRecords = false
  submits = []
  metricRequests = []
  inputReads = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if (/\/m\/default\/system\/inputs$/.test(u)) {
      inputReads++
      return response(inputStatus, { items: sources })
    }
    if (u.endsWith('/system/metrics/query')) {
      const body = JSON.parse(String(init.body)) as MetricsRequest
      metricRequests.push(body)
      if (failSearch) return response(403, { message: 'denied' })
      const dim = body.aggs.splitBys[0]
      const stage = dim === 'input' ? 'src' : dim === 'id' ? 'pipe' : 'dst'
      const value = JSON.parse(body.where.match(/^\w+ == ("(?:[^"\\]|\\.)*")/)![1])
      return response(200, {
        results: row[`${stage}_samples`] ? [{ [dim]: value, events: row[`${stage}_events`], bytes: row.dst_bytes }] : [],
        metrics: {}, info: {},
      })
    }
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body))
      submits.push(body)
      const isRecords = body.query.includes('byte_records=')
      return (isRecords ? failRecords : failSearch)
        ? response(403, { message: 'denied' })
        : response(200, { items: [{ id: isRecords ? 'records-job' : 'counter-job' }] })
    }
    if (u.endsWith('/counter-job/status')) return response(200, { items: [{ status: 'completed' }] })
    if (u.includes('/counter-job/results')) return response(200, {}, `${JSON.stringify({ totalEventCount: 1, job: 'counter-job' })}\n${JSON.stringify(row)}`)
    if (u.endsWith('/records-job/status')) return response(200, { items: [{ status: 'completed' }] })
    if (u.includes('/records-job/results')) return response(200, {}, `${JSON.stringify({ totalEventCount: 1, job: 'records-job' })}\n${JSON.stringify(recordRow)}`)
    if (u.includes('/kvstore/')) return response(404, {})
    return response(200, { items: [] })
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function render() {
  await act(async () => { root.render(<DashboardProvider><DataFlow /></DashboardProvider>) })
  await settle()
}
async function refresh() {
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Refresh data-flow volumes"]')!.click() })
  await settle()
}

describe('Data Flow follows the Onboard connection', () => {
  it('uses named-object telemetry and one gigamon_ami record scan for all four remaining figures', async () => {
    await render()
    expect(submits).toHaveLength(1)
    expect(metricRequests).toHaveLength(3)
    expect(submits.some((s) => s.query.includes(DATASET_RECORDS_QUERY))).toBe(true)
    expect(container.textContent).toContain(path.sourceId)
    expect(container.textContent).toContain('pipeline · gigamon')
    expect(container.textContent).toContain('gigamon_lake')
    expect(container.textContent).not.toContain('in_gigamon_datagen')
    expect(container.textContent).not.toContain('319 fields')
    const cards = [...container.querySelectorAll('[role="button"]')].map((c) => c.getAttribute('aria-label') ?? '')
    expect(cards.some((c) => c.startsWith('Sources ') && c.includes('— 123 '))).toBe(true)
    expect(cards.some((c) => c.startsWith('Processing ') && c.includes('— 100 '))).toBe(true)
    expect(cards.some((c) => c.startsWith('Destinations ') && c.includes('90 events written'))).toBe(true)
    expect(cards.some((c) => c.startsWith('Cribl Lake ') && c.includes('— 75 ') && c.includes('events in dataset'))).toBe(true)
    expect(cards.some((c) => c.startsWith('Cribl Search ') && c.includes('— 75 ') && c.includes('same events as Lake'))).toBe(true)
    expect(container.textContent).toContain('8.0 KB')
    expect(container.textContent).toContain('150 packets · from AMI')
    expect(container.textContent).toContain('AMI records · gigamon_ami')
    expect(container.textContent).toContain('count all of gigamon_ami')
    expect(container.textContent).toContain('include other traffic sharing those objects')
    expect(container.textContent).toContain('events out · whole pipeline')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(submits.every((s) => !s.query.includes('$vt_results'))).toBe(true)
  })

  it('uses the same first matching source as Onboard, not a preferred hardcoded id', async () => {
    sources = [{ id: 'picked_by_onboard', ...CONNECTED }, ...sources]
    await render()
    const counters = metricRequests.find((s) => s.aggs.splitBys[0] === 'input')!
    expect(counters.where).toContain('input == "http_raw:picked_by_onboard"')
    expect(counters.where).not.toContain('http_raw:in_gigamon_ami_http')
    expect(container.textContent).toContain('picked_by_onboard')
  })

  it('shows the actual Stream API request as provenance, with no bogus Search link', async () => {
    await render()
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Cribl Stream · Source"]')!.click() })
    const pop = container.querySelector('.pinfo-pop')!
    const code = pop.querySelector('.pinfo-code')!.textContent!
    expect(code).toBe(`POST /system/metrics/query\n${JSON.stringify(metricRequests[0], null, 2)}`)
    expect(pop.textContent).toContain('Stream Monitoring · API read')
    expect(pop.textContent).not.toContain('Open in Search')
    expect(code).not.toContain('default_metrics')
    expect(code).not.toContain('dataset=')
  })

  it('does not replace a missing onboarded connection with demo or pack totals', async () => {
    sources = [{ id: 'unconnected', type: 'http_raw' }]
    await render()
    expect(submits.map((s) => s.query)).toEqual([expect.stringContaining(DATASET_RECORDS_QUERY)])
    expect(container.textContent).toContain('No onboarded Raw HTTP connection found')
    expect(container.textContent).not.toContain('in_gigamon_datagen')
  })

  it('reports an unreadable source list and offers a working retry', async () => {
    inputStatus = 403
    await render()
    expect(submits.every((s) => s.query.includes(DATASET_RECORDS_QUERY))).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not read the Raw HTTP sources')
    inputStatus = 200
    await refresh()
    expect(metricRequests).toHaveLength(3)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('refreshes the connection before querying, and discards the old source’s figures', async () => {
    await render()
    sources = [{ id: 'replacement', ...CONNECTED }]
    await refresh()
    expect(inputReads).toBe(2)
    expect(submits).toHaveLength(2)
    expect(metricRequests).toHaveLength(6)
    expect(metricRequests.slice(3).some((s) => s.where.includes('http_raw:replacement'))).toBe(true)
    expect(submits[1].query).toContain(DATASET_RECORDS_QUERY)
    expect(container.textContent).not.toContain(path.sourceId)
  })

  it('shows missing series as unavailable, but an observed zero as zero', async () => {
    row = { ...COUNTERS, src_events: 0, pipe_samples: 0, pipe_events: 0, dst_samples: 0, dst_events: 0 }
    await render()
    expect(container.querySelector('[aria-label^="Sources "]')?.getAttribute('aria-label')).toContain('— 0 ')
    expect(container.textContent).toContain('processing unavailable')
    expect(container.textContent).toContain('writes unavailable')
    expect(container.textContent).toContain('Unavailable does not mean zero')
  })

  it('surfaces Stream API failures instead of rendering zero counts', async () => {
    failSearch = true
    await render()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain('processing unavailable')
    expect(container.textContent).not.toContain('events in · avg 0/s')
    expect(container.textContent).toContain('150 packets · from AMI')
  })

  it('keeps working Stream counters when the dataset record Search is refused', async () => {
    failRecords = true
    await render()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="Sources "]')?.getAttribute('aria-label')).toContain('— 123 ')
    expect(container.textContent).not.toContain('8.0 KB')
    expect(container.textContent).not.toContain('150 packets · from AMI')
  })

  it.each([null, 0])('shows an empty dataset window as observed zero (sum=%s)', async (sum) => {
    recordRow = { events: 0, byte_records: 0, bytes: sum, packet_records: 0, packets: sum }
    await render()
    expect(container.textContent).toContain('0 packets · from AMI')
    expect(container.textContent).toContain('0 B')
    expect(container.textContent).not.toContain('incomplete or invalid summary')
    expect(container.textContent).not.toContain('Network Traffic coverage')
    const cards = [...container.querySelectorAll('[role="button"]')].map((c) => c.getAttribute('aria-label') ?? '')
    expect(cards.some((c) => c.startsWith('Cribl Lake ') && c.includes('— 0 '))).toBe(true)
    expect(cards.some((c) => c.startsWith('Cribl Search ') && c.includes('— 0 '))).toBe(true)
    expect(submits).toHaveLength(1)
  })

  it.each([undefined, '0', 1, -1])('rejects malformed empty-window sums (%s)', async (sum) => {
    recordRow = { events: 0, byte_records: 0, bytes: sum, packet_records: 0, packets: null }
    await render()
    expect(container.textContent).toContain('incomplete or invalid summary')
  })

  it('sums partial byte coverage over the measured records and says how many', async () => {
    recordRow.byte_records = 74
    await render()
    expect(container.textContent).toContain('Network Traffic coverage: 74 of 75 records carry bytes')
    expect(container.textContent).toContain('8.0 KB')
    expect(container.textContent).toContain('150 packets · from AMI')
    expect(container.textContent).toContain('75 events in gigamon_ami')
  })

  it('does not turn missing packet directions into a zero packet total', async () => {
    recordRow.packet_records = 0
    recordRow.packets = 0
    await render()
    expect(container.textContent).toContain('8.0 KB')
    expect(container.textContent).toContain('packets unavailable · from AMI')
    expect(container.textContent).not.toContain('0 packets · from AMI')
  })

  it('shows observed zero traffic when all records carry valid zeros', async () => {
    recordRow.bytes = 0
    recordRow.packets = 0
    await render()
    expect(container.textContent).toContain('0 B')
    expect(container.textContent).toContain('0 packets · from AMI')
    expect(container.textContent).not.toContain('Network Traffic coverage')
  })

  it.each([
    { events: '75' },
    { byte_records: undefined },
    { packet_records: 76 },
    { events: -1 },
    { bytes: null },
    { packets: '150' },
  ])('reports an invalid record summary without success-shaped figures: %j', async (invalid) => {
    Object.assign(recordRow, invalid)
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('incomplete or invalid summary')
    expect(container.textContent).not.toContain('150 packets · from AMI')
  })

  it('never retargets the dataset record query onto synthetic sample data', async () => {
    settleDatasetTarget(true)
    await render()
    expect(submits).toHaveLength(1)
    expect(submits.some((s) => s.query.includes(DATASET_RECORDS_QUERY))).toBe(true)
    expect(submits.every((s) => !s.query.includes('gigamon_ami_sample'))).toBe(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Cribl Lake · gigamon_ami"]')!.click() })
    const pop = container.querySelector('.pinfo-pop')!
    expect(pop.querySelector('.pinfo-code')?.textContent).toContain('dataset="gigamon_ami"')
    expect(pop.textContent).not.toContain('gigamon_ami_sample')
    const searchLinks = pop.querySelectorAll<HTMLAnchorElement>('.pinfo-code-link, .pinfo-actions .pinfo-open')
    expect(searchLinks).toHaveLength(2)
    for (const link of searchLinks) {
      expect(new URL(link.href, 'http://x').searchParams.get('q')).toBe(DATASET_RECORDS_QUERY)
    }
  })

  it('uses the selected range in both Snapshot and Live modes', async () => {
    await render()
    const select = container.querySelector<HTMLSelectElement>('.range-select')!
    const option = [...select.options].find((o) => o.value !== select.value)!
    await act(async () => {
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await settle()
    expect(submits).toHaveLength(2)
    expect(submits[1].earliest).not.toBe(submits[0].earliest)
    expect(metricRequests).toHaveLength(6)
    expect(metricRequests.slice(3).every((s) => s.latest - s.earliest === 300_000)).toBe(true)
    await act(async () => { setDataMode('live') })
    await settle()
    expect(submits.every((s) => !s.query.includes('$vt_results'))).toBe(true)
  })

  it('does not imply a window-average rate without certified coverage', async () => {
    await render()
    expect(container.textContent).not.toContain('avg')
    expect(container.textContent).toContain('complete window coverage is not certified')
  })

  it('does not silently truncate longer ranges to the metrics store window', async () => {
    await render()
    const select = container.querySelector<HTMLSelectElement>('.range-select')!
    await act(async () => {
      select.value = 'Last 4 hours'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(metricRequests).toHaveLength(3)
    expect(submits).toHaveLength(2)
    expect(submits[1].earliest).toBe('-4h')
    expect(container.textContent).toContain('longer metrics coverage has not been verified')
    expect(container.textContent).toContain('intake unavailable')
    expect(container.textContent).toContain('150 packets · from AMI')
  })
})

// happy-dom cannot verify diagram layout, text overflow, or visual contrast.
