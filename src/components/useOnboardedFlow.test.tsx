import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlobalHttpState } from '../cribl/globalHttp'
import { ONBOARDED_FLOW_DEADLINE_MS, useOnboardedFlow } from './useOnboardedFlow'

const mocks = vi.hoisted(() => ({
  read: vi.fn<(group: string) => Promise<GlobalHttpState>>(),
  group: { group: 'default', groupReady: true },
}))
vi.mock('./useSetupGroup', () => ({ useSetupGroup: () => mocks.group }))
vi.mock('../cribl/globalHttp', () => ({
  LAKE_CONNECTION: { pipeline: 'gigamon', output: 'gigamon_lake' },
  readGlobalHttp: mocks.read,
}))

const connected = (id: string): GlobalHttpState => ({
  objects: { breaker: 'present', pipeline: 'present', destination: 'present', source: 'present' },
  sourceId: id, http: null, sources: [],
})
let root: Root
let container: HTMLDivElement
let state: ReturnType<typeof useOnboardedFlow>
function Harness({ nonce }: { nonce: number }) {
  state = useOnboardedFlow(nonce)
  return null
}
const render = async (nonce = 0) => {
  await act(async () => { root.render(<Harness nonce={nonce} />) })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  mocks.read.mockReset()
  mocks.group = { group: 'default', groupReady: true }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

it('reports timeout and ignores a late answer rather than silently switching sources', async () => {
  let resolve!: (value: GlobalHttpState) => void
  mocks.read.mockImplementation(() => new Promise((r) => { resolve = r }))
  await render()
  expect(state.loading).toBe(true)
  await act(async () => { vi.advanceTimersByTime(ONBOARDED_FLOW_DEADLINE_MS) })
  expect(state.error).toContain('timed out')
  await act(async () => { resolve(connected('late_source')) })
  expect(state.flow).toBeNull()
  expect(state.error).toContain('timed out')
})

it('never carries an old group’s source into the new group', async () => {
  let oldResolve!: (value: GlobalHttpState) => void
  mocks.read.mockImplementation((g) => g === 'default'
    ? new Promise((r) => { oldResolve = r })
    : Promise.resolve(connected('second_group_source')))
  await render()
  mocks.group = { group: 'second_group', groupReady: true }
  await render()
  await act(async () => { oldResolve(connected('old_source')) })
  expect(state.flow?.group).toBe('second_group')
  expect(state.flow?.sourceId).toBe('second_group_source')
})

it('re-reads after global Refresh and a local retry', async () => {
  mocks.read.mockResolvedValue(connected('first'))
  await render()
  mocks.read.mockResolvedValue(connected('second'))
  await render(1)
  expect(state.flow?.sourceId).toBe('second')
  mocks.read.mockResolvedValue(connected('third'))
  await act(async () => { state.refresh() })
  expect(state.flow?.sourceId).toBe('third')
  expect(mocks.read).toHaveBeenCalledTimes(3)
})

it('surfaces a rejected connection read', async () => {
  mocks.read.mockRejectedValue(new Error('network failed'))
  await render()
  expect(state.loading).toBe(false)
  expect(state.flow).toBeNull()
  expect(state.error).toContain('Could not read the onboarded connection')
})
