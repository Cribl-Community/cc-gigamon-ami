// What the page-wide refresh asks of the sample-data verdict.
//
// An explicit Refresh looks again (cribl/datasetTarget.ts `recheckDatasetTarget`);
// so does an auto-refresh tick, through the throttled
// `recheckDatasetTargetOnTick` — otherwise a wall display left on sample data
// would never move back to the customer's own once it landed. Both are reads.
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recheck = vi.fn()
const onTick = vi.fn()
vi.mock('../cribl/datasetTarget', () => ({
  recheckDatasetTarget: () => recheck(),
  recheckDatasetTargetOnTick: () => onTick(),
  // vitest.setup.ts settles the verdict before every test.
  settleDatasetTarget: () => {},
}))
vi.mock('../cribl/accel/status', () => ({ forgetRunHistory: () => {} }))

const { DashboardProvider, useDashboard } = await import('./DashboardContext')

let refresh: () => void = () => {}
function Auto({ seconds }: { seconds: number }) {
  const d = useDashboard()
  refresh = d.refresh
  const { setAutoSeconds } = d
  useEffect(() => setAutoSeconds(seconds), [seconds, setAutoSeconds])
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  recheck.mockClear()
  onTick.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('the sample-data verdict and the page refresh', () => {
  it('an auto-refresh tick asks the throttled re-check, and nothing else', async () => {
    act(() => root.render(<DashboardProvider><Auto seconds={60} /></DashboardProvider>))
    expect(onTick).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(onTick).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(onTick).toHaveBeenCalledTimes(3)
    expect(recheck, 'a tick is not an explicit refresh').not.toHaveBeenCalled()
  })

  it('an explicit Refresh asks the unthrottled one', () => {
    act(() => root.render(<DashboardProvider><Auto seconds={0} /></DashboardProvider>))
    act(() => refresh())
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(onTick).not.toHaveBeenCalled()
  })
})
