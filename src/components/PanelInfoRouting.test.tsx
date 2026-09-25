// The ⓘ names the dataset that actually answered (Phase 8 design §4.1).
//
// A routed query's job runs on gigamon_ami_pq; its ⓘ must then show — and copy
// — `dataset="gigamon_ami_pq"`, while "Open in Search" stays on the JSON
// archive (a drill-down is evidence). With the shipped table nothing routes and
// the ⓘ is exactly what it was. The sample seam still wins, and a figure a
// stored run served names JSON, because schedules never route (S1).
//
// The route is recorded by a real submit through runSearch (fetch stubbed) —
// the ⓘ reads what ran, never a prediction.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { settleDatasetTarget } from '../cribl/datasetTarget'
import { runSearch, setQueryRouter } from '../cribl/search'
import { forgetRanOn } from '../cribl/routing/ranOn'
import { installQueryRouter, overrideRouting } from '../cribl/routing/route'
import type { RouteEntry } from '../cribl/routing/table'
import { buildTrendQuery } from '../queries/tcpHealth'
import { PanelInfo, type ComputedFrom } from './PanelInfo'

const T0 = 1_790_157_600
const TREND = buildTrendQuery('dupacks')
const MOVED: RouteEntry = {
  id: 'tcp.trend',
  from: 'test',
  queries: [TREND],
  pin: null,
  target: 'parquet',
  evidence: { report: 'test', date: '2026-10-01', windows: [0, 5, 11].map((h) => ({ earliest: T0 + h * 3600, latest: T0 + h * 3600 + 900 })) },
}

let container: HTMLDivElement
let root: Root

async function runOnce(query: string): Promise<void> {
  const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) })
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).endsWith('/search/jobs')) return json({ items: [{ id: 'job-test' }] })
    if (String(url).includes('/status')) return json({ items: [{ status: 'completed' }] })
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"totalEventCount":0}', json: async () => ({}) }
  })
  await runSearch(query, { earliest: T0, latest: T0 + 900 })
  vi.unstubAllGlobals()
}

function open(query: string, computed?: ComputedFrom) {
  act(() => {
    root.render(
      <DashboardProvider>
        <PanelInfo about="x" query={query} computed={computed} />
      </DashboardProvider>,
    )
  })
  act(() => container.querySelector<HTMLButtonElement>('.pinfo-btn')!.click())
  const link = container.querySelector<HTMLAnchorElement>('.pinfo-code-link')!
  return {
    code: container.querySelector('.pinfo-code')!.textContent!.split('\n')[0],
    linkQ: new URL(link.getAttribute('href')!, 'https://cribl.example').searchParams.get('q'),
    text: container.textContent ?? '',
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  installQueryRouter()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setQueryRouter(null)
  overrideRouting(null)
  forgetRanOn()
  vi.unstubAllGlobals()
})

describe('the ⓘ of a routed query', () => {
  it('with the shipped table, names gigamon_ami exactly as before', async () => {
    await runOnce(TREND)
    const r = open(TREND)
    expect(r.code).toBe('dataset="gigamon_ami" protocol=6')
    expect(r.text).not.toContain('Parquet copy')
  })

  it('names gigamon_ami_pq once a job of it ran there, and says the link opens the archive', async () => {
    overrideRouting({ entries: [MOVED], types: { protocol: 'number', tcp_dup_ack: 'number' }, complete: () => ({ complete: true, why: null }) })
    await runOnce(TREND)
    const r = open(TREND)
    expect(r.code).toBe('dataset="gigamon_ami_pq" protocol=6')
    expect(r.linkQ, 'a drill-down is evidence and stays on the JSON archive').toBe(TREND)
    expect(r.text).toContain('This figure was read from gigamon_ami_pq, the Parquet copy.')
  })

  it('names JSON for a figure a stored run served — schedules never route', async () => {
    overrideRouting({ entries: [MOVED], types: { protocol: 'number', tcp_dup_ack: 'number' }, complete: () => ({ complete: true, why: null }) })
    await runOnce(TREND)
    const r = open(TREND, { source: 'schedule', at: Date.now(), cadence: 'hourly', window: 'the last 15 minutes' })
    expect(r.code).toBe('dataset="gigamon_ami" protocol=6')
  })

  it('names the sample while the app reads it — the sample seam comes first', async () => {
    overrideRouting({ entries: [MOVED], types: { protocol: 'number', tcp_dup_ack: 'number' }, complete: () => ({ complete: true, why: null }) })
    await runOnce(TREND)
    act(() => settleDatasetTarget(true))
    const r = open(TREND)
    expect(r.code).toBe('dataset="gigamon_ami_sample" protocol=6')
  })
})
