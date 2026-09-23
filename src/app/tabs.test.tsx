// Route-level code splitting (src/app/tabs.tsx, src/app/lazyTab.ts).
//
// Three things are held still: the landing tab is not lazy (a chunk round trip
// in front of first paint is the regression this would otherwise invite), a
// lazy tab renders once its import resolves, and a rejected import lands on the
// Reload message rather than a generic error or a blank page.
//
// WHAT THIS CANNOT ASSERT: that a chunk actually loads in an INSTALLED tenant.
// Chunks resolve against `import.meta.url` under `base: './'`, and whether the
// platform serves them from inside its sandboxed iframe is a property of the
// host, not of this code. That is verified in Live Preview / installed, by
// opening a non-landing tab and watching its chunk arrive in the network panel.

import { Suspense, act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANDING_ROUTE, TABS } from './tabs'
import { ChunkLoadError, lazyTab } from './lazyTab'
import { TabLoading } from '../components/TabLoading'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { FlowMap } from '../tabs/FlowMap'

const REACT_LAZY = Symbol.for('react.lazy')
const isLazy = (type: unknown) => (type as { $$typeof?: symbol } | null)?.$$typeof === REACT_LAZY

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mount(Tab: ComponentType) {
  act(() => {
    root.render(
      <ErrorBoundary>
        <Suspense fallback={<TabLoading />}>
          <Tab />
        </Suspense>
      </ErrorBoundary>,
    )
  })
}

describe('the tab list', () => {
  it('keeps the landing tab eager — it is the static FlowMap, not a lazy wrapper', () => {
    const landing = TABS.find((t) => t.to === LANDING_ROUTE)
    expect(landing, 'no tab is mounted at the landing route').toBeDefined()
    expect(isLazy(landing!.el.type)).toBe(false)
    expect(landing!.el.type).toBe(FlowMap)
  })

  it('splits every other tab', () => {
    for (const t of TABS.filter((x) => x.to !== LANDING_ROUTE)) {
      expect(isLazy(t.el.type), `${t.label} is in the initial chunk`).toBe(true)
    }
  })
})

describe('lazyTab', () => {
  it('shows the loading fallback, then the tab once its import resolves', async () => {
    const load = deferred<{ Probe: ComponentType }>()
    const Tab = lazyTab(() => load.promise, 'Probe')
    mount(Tab)
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading tab')

    await act(async () => { load.resolve({ Probe: () => <p id="probe">probe tab</p> }) })
    expect(container.querySelector('#probe')?.textContent).toBe('probe tab')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('shows the Reload message, and no in-place retry, when the import rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = deferred<{ Probe: ComponentType }>()
    const Tab = lazyTab(() => load.promise, 'Probe')
    mount(Tab)

    await act(async () => { load.reject(new TypeError('Failed to fetch dynamically imported module')) })
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('This tab could not be loaded')
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent)
    // "Try again" would re-throw the cached rejection: only a reload refetches.
    expect(buttons).toEqual(['Reload'])
  })

  it('reloads only when Reload is clicked, never on its own', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    const realLocation = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } })
    try {
      const load = deferred<{ Probe: ComponentType }>()
      mount(lazyTab(() => load.promise, 'Probe'))
      await act(async () => { load.reject(new Error('chunk 404')) })
      expect(reload).not.toHaveBeenCalled()

      act(() => { container.querySelector('button')!.click() })
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
    }
  })

  it('tags the rejection as a ChunkLoadError carrying the original cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('net::ERR_FAILED')
    const load = deferred<{ Probe: ComponentType }>()
    mount(lazyTab(() => load.promise, 'Probe'))
    await act(async () => { load.reject(cause) })
    // ErrorBoundary.componentDidCatch logs what it caught; that is the error the
    // boundary branched on.
    const caught = logged.mock.calls.map((c) => c[1]).find((e) => e instanceof ChunkLoadError)
    expect(caught).toBeInstanceOf(ChunkLoadError)
    expect((caught as ChunkLoadError).cause).toBe(cause)
  })
})
