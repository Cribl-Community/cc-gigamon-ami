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
  HOLD_DEADLINE_MS: 4_000,
  recheckDatasetTarget: (then?: () => void) => recheck(then),
  recheckDatasetTargetOnTick: (then?: () => void) => onTick(then),
  // vitest.setup.ts settles the verdict before every test.
  settleDatasetTarget: () => {},
}))
vi.mock('../cribl/accel/status', () => ({ forgetRunHistory: () => {} }))

const { DashboardProvider, useDashboard } = await import('./DashboardContext')

let refresh: () => void = () => {}
let nonces = { refresh: 0, manual: 0 }
function Auto({ seconds }: { seconds: number }) {
  const d = useDashboard()
  refresh = d.refresh
  nonces = { refresh: d.refreshNonce, manual: d.manualRefreshNonce }
  const { setAutoSeconds } = d
  useEffect(() => setAutoSeconds(seconds), [seconds, setAutoSeconds])
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  recheck.mockReset()
  onTick.mockReset()
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

// The known gap this closes (CLAUDE.md, "Sample data"): a Refresh that found
// real data re-ran every panel on the sample while the re-check was out, then
// again on gigamon_ami when its verdict landed. The re-run now waits for the
// verdict — only while a look is out, and never past HOLD_DEADLINE_MS.
describe('a re-run waits for the re-check it started', () => {
  it('on real data (no look out) the Refresh re-runs at once', () => {
    recheck.mockReturnValue(false)
    act(() => root.render(<DashboardProvider><Auto seconds={0} /></DashboardProvider>))
    act(() => refresh())
    expect(nonces).toEqual({ refresh: 1, manual: 1 })
  })

  it('on the sample it re-runs when the verdict lands, once', () => {
    let then: (() => void) | undefined
    recheck.mockImplementation((t?: () => void) => { then = t; return true })
    act(() => root.render(<DashboardProvider><Auto seconds={0} /></DashboardProvider>))
    act(() => refresh())
    expect(nonces, 'nothing re-runs while the look is out').toEqual({ refresh: 0, manual: 0 })
    act(() => then?.())
    expect(nonces).toEqual({ refresh: 1, manual: 1 })
    // The deadline that was armed does not bump a second time.
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(nonces).toEqual({ refresh: 1, manual: 1 })
    act(() => then?.())
    expect(nonces, 'a waiter runs once').toEqual({ refresh: 1, manual: 1 })
  })

  it('a look that never answers holds the re-run no longer than HOLD_DEADLINE_MS', () => {
    recheck.mockReturnValue(true)
    act(() => root.render(<DashboardProvider><Auto seconds={0} /></DashboardProvider>))
    act(() => refresh())
    act(() => { vi.advanceTimersByTime(3_999) })
    expect(nonces).toEqual({ refresh: 0, manual: 0 })
    act(() => { vi.advanceTimersByTime(1) })
    expect(nonces).toEqual({ refresh: 1, manual: 1 })
  })

  it('a tick that starts a look waits for it too, and a tick that does not re-runs at once', async () => {
    let then: (() => void) | undefined
    onTick.mockImplementationOnce(() => false).mockImplementationOnce((t?: () => void) => { then = t; return true })
    act(() => root.render(<DashboardProvider><Auto seconds={60} /></DashboardProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(nonces).toEqual({ refresh: 1, manual: 0 })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(nonces, 'held while the look a tick started is out').toEqual({ refresh: 1, manual: 0 })
    act(() => then?.())
    expect(nonces).toEqual({ refresh: 2, manual: 0 })
  })
})
