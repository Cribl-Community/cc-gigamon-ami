// The REAL App shell around a lazy tab: src/App.tsx's wiring of
// ErrorBoundary > Suspense > Routes, and the tab bar's preload and pending
// indicator. src/app/tabs.test.tsx holds lazyTab and ErrorBoundary still in
// isolation; nothing there would notice the boundary moving outside the
// header, the Suspense boundary being dropped, or `resetKey` being unwired.
//
// The tab list is replaced with probes (vi.mock of ./tabs) so each test owns
// when a chunk resolves or rejects. Everything else — Header, TabBar,
// AppBanners, the boundary, the routes — is the shipped App. `fetch` never
// settles, so the header's own reads stay pending and quiet.
//
// Navigation runs under MemoryRouter, which wraps a navigation in
// `startTransition` exactly as BrowserRouter does — that is the behaviour the
// pending indicator exists for, so a router without it would test nothing.
//
// Every probe route is used by ONE test: React.lazy caches a module for the
// life of the component, and these components live at module scope.
//
// WHAT THIS CANNOT ASSERT: that the indicator is visible to a sighted user in
// a browser (happy-dom has no layout), or that a real hover fires
// pointerenter before a click lands. The mechanism is asserted instead.

import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from './DashboardContext'
import App from '../App'

type Mod = Record<string, ComponentType>

const h = vi.hoisted(() => {
  const deferreds = new Map<string, { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const get = (name: string) => {
    let d = deferreds.get(name)
    if (!d) {
      let resolve!: (v: unknown) => void
      let reject!: (e: unknown) => void
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      d = { promise, resolve, reject }
      deferreds.set(name, d)
    }
    return d
  }
  return { get, loads: new Map<string, number>(), preloads: new Map<string, number>() }
})

vi.mock('./tabs', async () => {
  // No JSX in here: the factory is hoisted above the file's imports, including
  // the JSX runtime's, so elements are built with a dynamically imported React.
  const { createElement } = await import('react')
  const { lazyTab } = await import('./lazyTab')
  const probe = (name: string) => {
    const Tab = lazyTab(() => {
      h.loads.set(name, (h.loads.get(name) ?? 0) + 1)
      return h.get(name).promise as Promise<Mod>
    }, name)
    const preload = () => {
      h.preloads.set(name, (h.preloads.get(name) ?? 0) + 1)
      return Tab.preload()
    }
    return { to: `/${name.toLowerCase()}`, label: name, el: createElement(Tab), preload }
  }
  const Home = () => createElement('p', { id: 'home' }, 'home tab')
  return {
    LANDING_ROUTE: '/home',
    TABS: [
      { to: '/home', label: 'Home', el: createElement(Home) },
      probe('Broken'),
      probe('Slow'),
      probe('Pending'),
      probe('Hover'),
      probe('Focus'),
    ],
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', () => new Promise(() => {}))
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountAt(path: string) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <DashboardProvider>
          <App />
        </DashboardProvider>
      </MemoryRouter>,
    )
  })
}

const link = (label: string) =>
  [...container.querySelectorAll<HTMLAnchorElement>('nav.tab-bar a')].find((a) => a.textContent?.startsWith(label))!
const main = () => container.querySelector('main.app-main')!
const shellIntact = () => {
  expect(container.querySelector('header.app-header h1')?.textContent).toContain('Gigamon Network Observability')
  expect(container.querySelectorAll('nav.tab-bar a').length).toBe(6)
}

describe('the App shell around a lazy tab', () => {
  it('shows the Suspense fallback inside <main> on a deep link, with the shell around it', async () => {
    mountAt('/slow')
    expect(main().querySelector('[role="status"]')?.textContent).toContain('Loading tab')
    shellIntact()

    await act(async () => { h.get('Slow').resolve({ Slow: () => <p id="slow">slow tab</p> }) })
    expect(main().querySelector('#slow')?.textContent).toBe('slow tab')
    expect(main().querySelector('[role="status"]')).toBeNull()
  })

  it('keeps the header and tab bar when a chunk fails, and clears the error on a route change', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mountAt('/broken')
    await act(async () => { h.get('Broken').reject(new TypeError('Failed to fetch dynamically imported module')) })

    // The boundary is INSIDE the shell: the alert is in <main>, the chrome survives.
    const alert = main().querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('This tab could not be loaded')
    shellIntact()

    // resetKey={location.pathname}: leaving the route clears the boundary.
    await act(async () => { link('Home').click() })
    expect(main().querySelector('[role="alert"]')).toBeNull()
    expect(main().querySelector('#home')?.textContent).toBe('home tab')
  })
})

describe('the tab bar', () => {
  it('preloads a tab’s chunk on pointerenter', () => {
    mountAt('/home')
    expect(h.loads.get('Hover')).toBeUndefined()
    act(() => { link('Hover').dispatchEvent(new Event('pointerover', { bubbles: true })) })
    expect(h.preloads.get('Hover')).toBe(1)
    expect(h.loads.get('Hover')).toBe(1)
  })

  it('preloads a tab’s chunk on focus', () => {
    mountAt('/home')
    act(() => { link('Focus').focus() })
    expect(h.preloads.get('Focus')).toBe(1)
    expect(h.loads.get('Focus')).toBe(1)
  })

  it('shows a pending indicator on the clicked tab while its chunk loads, then clears it', async () => {
    mountAt('/home')
    await act(async () => { link('Pending').click() })

    // The transition keeps the old tab up and the fallback never shows —
    // which is why the link itself has to say something.
    expect(main().querySelector('#home')).not.toBeNull()
    expect(main().querySelector('[role="status"]')).toBeNull()
    expect(link('Pending').getAttribute('aria-busy')).toBe('true')
    expect(link('Pending').querySelector('.spinner')).not.toBeNull()
    expect(container.querySelector('nav.tab-bar [role="status"]')?.textContent).toBe('Loading Pending…')
    // The click reuses the one import; it does not start a second.
    expect(h.loads.get('Pending')).toBe(1)

    await act(async () => { h.get('Pending').resolve({ Pending: () => <p id="pending">pending tab</p> }) })
    expect(main().querySelector('#pending')?.textContent).toBe('pending tab')
    expect(link('Pending').getAttribute('aria-busy')).toBeNull()
    expect(link('Pending').querySelector('.spinner')).toBeNull()
    expect(container.querySelector('nav.tab-bar [role="status"]')?.textContent).toBe('')
  })
})
