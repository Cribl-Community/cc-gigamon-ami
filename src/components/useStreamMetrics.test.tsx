import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamMetricPath } from '../cribl/streamMetrics'
import { STREAM_METRICS_DEADLINE_MS, useStreamMetrics } from './useStreamMetrics'

const mocks = vi.hoisted(() => ({
  dashboard: { range: { earliest: '-15m' }, refreshNonce: 0 },
}))
vi.mock('../app/DashboardContext', () => ({ useDashboard: () => mocks.dashboard }))
const path = { group: 'default', sourceId: 'first', pipeline: 'gigamon', destination: 'gigamon_lake' }
let container: HTMLDivElement
let root: Root
let state: ReturnType<typeof useStreamMetrics>
let calls: Array<{ request: { where: string; earliest: number; latest: number }; signal: AbortSignal; resolve: (value: unknown) => void }>
function Harness({ flow }: { flow: StreamMetricPath | null }) {
  state = useStreamMetrics(flow)
  return null
}
async function render(flow: StreamMetricPath | null = path) {
  await act(async () => { root.render(<Harness flow={flow} />) })
}
async function answer(start: number, events: number) {
  await act(async () => {
    for (const call of calls.slice(start, start + 3)) {
      const [, dim, value] = /^(\w+) == ("(?:[^"\\]|\\.)*")/.exec(call.request.where)!
      call.resolve({ status: 200, text: async () => JSON.stringify({ results: [{ [dim]: JSON.parse(value), events, bytes: 80 }] }) })
    }
  })
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-05T16:30:00Z'))
  mocks.dashboard = { range: { earliest: '-15m' }, refreshNonce: 0 }
  calls = []
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((resolve) => {
    calls.push({ request: JSON.parse(String(init.body)), signal: init.signal!, resolve })
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('gives all three object reads identical absolute bounds and cancels them on unmount', async () => {
  await render()
  expect(calls).toHaveLength(3)
  expect(new Set(calls.map((c) => c.request.latest)).size).toBe(1)
  expect(calls.every((c) => c.request.latest - c.request.earliest === 900000)).toBe(true)
  expect(state.loading).toBe(true)
  act(() => root.unmount())
  root = createRoot(container)
  expect(calls.every((c) => c.signal.aborted)).toBe(true)
})

it('discards late responses from an old group or connection and clears prior numbers while refreshing', async () => {
  await render()
  await answer(0, 100)
  expect(state.counters.source?.events).toBe(100)
  mocks.dashboard.refreshNonce++
  await render()
  expect(state.counters).toEqual({})
  expect(calls.slice(0, 3).every((c) => c.signal.aborted)).toBe(true)
  await render({ ...path, group: 'new_group', sourceId: 'second' })
  await answer(6, 200)
  await answer(3, 999)
  expect(state.counters.source?.events).toBe(200)
  expect(calls[6].request.where).toContain('__worker_group == "new_group"')
})

it('re-reads on global refresh and time-range changes, but never substitutes short metrics for a longer range', async () => {
  await render()
  await answer(0, 100)
  vi.setSystemTime(Date.now() + 60_000)
  mocks.dashboard.refreshNonce++
  await render()
  expect(calls[3].request.latest).toBe(calls[0].request.latest + 60_000)
  mocks.dashboard.range.earliest = '-5m'
  await render()
  expect(calls[6].request.latest - calls[6].request.earliest).toBe(300000)
  mocks.dashboard.range.earliest = '-24h'
  await render()
  expect(calls).toHaveLength(9)
  expect(state.supported).toBe(false)
  expect(state.counters).toEqual({})
  expect(state.loading).toBe(false)
})

it('aborts timed-out reads, surfaces the timeout and ignores late success', async () => {
  await render()
  await act(async () => { vi.advanceTimersByTime(STREAM_METRICS_DEADLINE_MS) })
  expect(state.error).toContain('timed out')
  expect(state.loading).toBe(false)
  expect(calls.every((c) => c.signal.aborted)).toBe(true)
  await answer(0, 999)
  expect(state.counters).toEqual({})
  expect(state.error).toContain('timed out')
})

it('stays idle without a connection and retries the same connection after a local re-check', async () => {
  await render(null)
  expect(calls).toHaveLength(0)
  await render()
  await answer(0, 100)
  await render(null)
  expect(state.counters).toEqual({})
  await render()
  expect(state.counters).toEqual({})
  expect(state.loading).toBe(true)
  await answer(3, 200)
  expect(state.counters.source?.events).toBe(200)
})

it('retains independently successful object counters when another request fails', async () => {
  await render()
  await act(async () => { calls[1].resolve({ status: 500, text: async () => '{}' }) })
  await answer(0, 123)
  expect(state.error).toContain('pipeline')
  expect(state.counters.source?.events).toBe(123)
  expect(state.counters.pipeline).toBeUndefined()
  expect(state.counters.destination?.events).toBe(123)
})

it('retains successful source and destination reads when the pipeline request times out', async () => {
  await render()
  await act(async () => {
    calls[0].resolve({ status: 200, text: async () => JSON.stringify({ results: [{ input: 'http_raw:first', events: 42 }] }) })
    calls[2].resolve({ status: 200, text: async () => JSON.stringify({ results: [{ output: 'cribl_lake:gigamon_lake', events: 40, bytes: 800 }] }) })
  })
  await act(async () => { vi.advanceTimersByTime(STREAM_METRICS_DEADLINE_MS) })
  expect(state.error).toContain('timed out')
  expect(state.counters.source?.events).toBe(42)
  expect(state.counters.destination?.events).toBe(40)
  expect(state.counters.pipeline).toBeUndefined()
})

// happy-dom verifies lifecycle, abort signals and state, not real API retention
// or the unverified live pipeline dimension/aggregation.
