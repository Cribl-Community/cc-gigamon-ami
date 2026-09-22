// The metrics card reports, and the three things it must never do.
//
// (1) It must not write, ever — not on mount, not on render, not on Refresh.
// (2) It must not run on a timer: `getLocalSearch` is two requests, so the 60 s
//     the plan proposed is ~2,880/day per open tab to answer a question that
//     changes when a human provisions an engine.
// (3) It must not claim the engine makes these dashboards faster. That is the
//     Acceleration-tier defect, and this is new copy written after it.
//
// WHAT THIS FILE CANNOT ESTABLISH: happy-dom has no layout, so nothing here is
// evidence about how the card looks. The class names are asserted to exist in
// App.css, which is a claim about a rule existing, not about a rendered pixel.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DashboardProvider } from '../app/DashboardContext'
import { MetricsStorePanel } from './MetricsStorePanel'
import { gateWords } from '../cribl/landing'

const LOCAL = '/m/default_search/search/local_search'

interface Call { method: string; path: string }
let calls: Call[] = []

/** Answer the two gate paths; 200 `{items:[]}` for anything else. */
function stub(answers: Record<string, [number, unknown]>) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/capi/, '')
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), path })
    const key = Object.keys(answers).find((k) => path === k || path.startsWith(`${k}?`))
    const [status, body] = key ? answers[key] : [200, { items: [] }]
    const text = JSON.stringify(body)
    return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => text, json: async () => JSON.parse(text) as unknown }
  })
}

const READY = { id: 'e1', status: 'ready', effectiveStatus: 'ready', datasets: ['main', 'metrics'] }

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

/** `<Panel>` renders `<PanelInfo>`, which reads the dashboard context. */
const tree = () => (
  <DashboardProvider>
    <MetricsStorePanel />
  </DashboardProvider>
)

async function render() {
  await act(async () => { root.render(tree()) })
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
}

const text = () => host.textContent ?? ''

describe('what the card reports', () => {
  it('says the engine is ready, and in the same words the derivation produces', async () => {
    // Byte-identical to gateWords, because 6.7 requires one function to own the
    // sentence so two surfaces cannot describe one workspace differently.
    stub({ [LOCAL]: [200, { items: [{}] }], [`${LOCAL}/engines`]: [200, { items: [READY] }] })
    await render()
    expect(text()).toContain(gateWords('ready'))
  })

  it('says what the engine serves, and that this dataset is not among it', async () => {
    stub({ [LOCAL]: [200, { items: [{}] }], [`${LOCAL}/engines`]: [200, { items: [READY] }] })
    await render()
    expect(text()).toContain('serves main, metrics — not gigamon_ami')
  })

  it('calls a tenant without local search normal, not broken', async () => {
    stub({ [LOCAL]: [404, { message: 'LocalSearch is not enabled' }] })
    await render()
    expect(text()).toContain(gateWords('not-available'))
    expect(text()).toContain('normal state')
  })

  it('never claims the engine makes these dashboards faster', async () => {
    // The Acceleration-tier defect, applied forward to new copy.
    stub({ [LOCAL]: [200, { items: [{}] }], [`${LOCAL}/engines`]: [200, { items: [READY] }] })
    await render()
    const body = text().toLowerCase()
    expect(body).not.toContain('faster')
    expect(body).not.toContain('speeds up')
    // The one mention of acceleration is a denial.
    if (body.includes('accelerat')) expect(body).toContain('does not accelerate')
  })

  it('always says nothing publishes metrics yet, in every state', async () => {
    for (const answer of [
      { [LOCAL]: [404, {}] } as Record<string, [number, unknown]>,
      { [LOCAL]: [200, { items: [{}] }], [`${LOCAL}/engines`]: [200, { items: [READY] }] } as Record<string, [number, unknown]>,
      { [LOCAL]: [403, {}] } as Record<string, [number, unknown]>,
    ]) {
      stub(answer)
      await render()
      expect(text(), JSON.stringify(Object.keys(answer))).toContain('Nothing publishes metrics yet')
      act(() => root.unmount())
      host.remove()
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    }
  })
})

describe('what the card must never do', () => {
  it('writes nothing — every request it makes is a GET', async () => {
    stub({ [LOCAL]: [200, { items: [{}] }], [`${LOCAL}/engines`]: [200, { items: [READY] }] })
    await render()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.method === 'GET'), JSON.stringify(calls)).toBe(true)
  })

  it('reads both gate paths once on mount and then STOPS', async () => {
    // No timer. If a poll were ever added, this count would climb with the
    // clock and this assertion is what would catch it.
    vi.useFakeTimers()
    stub({ [LOCAL]: [200, { items: [{}] }], [`${LOCAL}/engines`]: [200, { items: [READY] }] })
    await act(async () => { root.render(tree()) })
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
    const afterMount = calls.length

    await act(async () => { vi.advanceTimersByTime(10 * 60 * 1000) })
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })

    expect(calls.length, 'the card polled — it must only read on mount and on Refresh').toBe(afterMount)
  })

  it('reads exactly the two gate paths and nothing else', async () => {
    stub({ [LOCAL]: [200, { items: [{}] }], [`${LOCAL}/engines`]: [200, { items: [READY] }] })
    await render()
    expect([...new Set(calls.map((c) => c.path))].sort()).toEqual([LOCAL, `${LOCAL}/engines`])
  })
})

describe('the CSS it names', () => {
  it('every class it renders has a rule — an unstyled class is markup with nothing to say so', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.css'), 'utf8')
    for (const cls of ['ms-title', 'ms-body', 'ms-status', 'ms-serves', 'ms-footer']) {
      expect(css, `.${cls} is rendered but has no rule`).toContain(`.${cls}`)
    }
  })
})
