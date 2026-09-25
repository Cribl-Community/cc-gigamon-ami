// The theme survives a reload inside Cribl (owner report 2026-09-25).
//
// Inside Cribl's sandboxed app frame localStorage throws or is not kept, so the
// old toggle — localStorage only — came back on the OS preference after every
// reload. These tests stand in for that frame with a localStorage whose every
// call throws and an OS that prefers light, which is the owner's case exactly,
// and hold the fix to what it claims: the stored choice is applied once the
// per-viewer document lands; the click writes the whole document once; mount
// writes nothing; no user means no KV traffic at all; and where localStorage
// does work the very first frame is already right.
//
// Like prefs.test.ts: each test loads its own copy of the modules (prefs keeps
// one document per page), stubs `fetch` so what is asserted is the request the
// platform would receive, and uses no JSX, so React is imported in the same
// generation as the component.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Call {
  url: string
  method: string
  body: string | null
}

function fakeResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  }
}

/** A stand-in app-scoped store. `refusePut` answers every PUT 500. */
function stubStore(seed: Record<string, string> = {}, opts: { refusePut?: boolean } = {}) {
  const store = new Map(Object.entries(seed))
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method, body: init.body == null ? null : String(init.body) })
    const key = u
      .slice(u.indexOf('/kvstore/') + '/kvstore/'.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/')
    if (method === 'PUT') {
      if (opts.refusePut) return fakeResponse(500, 'refused')
      store.set(key, String(init.body ?? ''))
      return fakeResponse(200, '')
    }
    const held = store.get(key)
    return held === undefined ? fakeResponse(404, '') : fakeResponse(200, held)
  })
  return { store, calls }
}

const envelope = (doc: unknown) => JSON.stringify({ version: 1, updatedAt: 1, doc })
const docOf = (raw: string | undefined) => (JSON.parse(raw!) as { doc: unknown }).doc

/** Cribl's sandboxed frame: every localStorage call throws. */
function localStorageThrows() {
  const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError') }
  vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 })
}

/** A working localStorage, seeded. */
function localStorageWith(seed: Record<string, string>) {
  const m = new Map(Object.entries(seed))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size },
  })
  return m
}

/** The owner's OS: light. */
function osPrefersLight() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('light'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))
}

/** A signed-in user whose lookup resolves only when `release` is called, so a
 *  test can look at the frames before the document lands. */
function gatedUser(id: string) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  vi.stubGlobal('getCriblUser', async () => {
    await gate
    return { id, username: id }
  })
  return () => release()
}

const isDark = () => document.documentElement.classList.contains('dark')

async function mountToggle() {
  vi.resetModules()
  const react = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ThemeToggle } = await import('./ThemeToggle')
  const { applyTheme, readStoredTheme } = await import('./theme')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  // What main.tsx does before React mounts.
  applyTheme(readStoredTheme())
  const beforeMount = isDark()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const button = () => container.querySelector('button')!
  const settle = () => react.act(async () => { await new Promise((r) => setTimeout(r, 0)) })

  await react.act(async () => { root.render(react.createElement(ThemeToggle)) })
  const firstFrame = { dark: isDark(), label: button().getAttribute('aria-label') }

  return {
    beforeMount,
    firstFrame,
    button,
    settle,
    click: async () => {
      await react.act(async () => { button().click() })
      await settle()
    },
    unmount: async () => {
      await react.act(async () => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const el = document.documentElement
  el.classList.remove('dark')
  delete el.dataset.theme
  el.style.colorScheme = ''
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ThemeToggle', () => {
  it('comes back dark after a reload in the Cribl frame, once the viewer\'s document lands', async () => {
    // The reported bug: localStorage unusable, OS light, the viewer chose dark.
    localStorageThrows()
    osPrefersLight()
    const release = gatedUser('u-7')
    const { calls } = stubStore({ 'app/prefs/u-7': envelope({ tourSeen: true, theme: 'dark' }) })

    const t = await mountToggle()
    // The first guess can only be the OS's; nothing else is readable yet.
    expect(t.firstFrame.dark).toBe(false)
    release()
    await t.settle()
    expect(isDark(), 'the stored dark choice was not applied when the document landed').toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(t.button().getAttribute('aria-label')).toBe('Switch to light mode')
    expect(calls.every((c) => c.method === 'GET'), 'loading the theme wrote to the store').toBe(true)
    await t.unmount()
  })

  it('writes exactly one PUT on the click, of the whole document, keeping the other flags', async () => {
    localStorageThrows()
    osPrefersLight()
    const release = gatedUser('u-7')
    const { store, calls } = stubStore({
      'app/prefs/u-7': envelope({ tourSeen: true, intelPromptDismissed: true }),
    })

    const t = await mountToggle()
    release()
    await t.settle()
    expect(calls.filter((c) => c.method === 'PUT'), 'mount wrote to the store').toHaveLength(0)

    await t.click()
    expect(isDark()).toBe(true)
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe('/capi/kvstore/app/prefs/u-7')
    expect(docOf(store.get('app/prefs/u-7')), 'the theme write dropped a flag another feature had stored').toEqual({
      tourSeen: true,
      intelPromptDismissed: true,
      theme: 'dark',
    })
    await t.unmount()
  })

  it('writes nothing on mount, and does not migrate a localStorage choice into the store', async () => {
    // A write on load is the rule that matters (AGENTS.md). localStorage says
    // dark, the store holds nothing: the page is dark, and the store stays empty.
    localStorageWith({ 'gigamon-npm-theme': 'dark' })
    osPrefersLight()
    const release = gatedUser('u-7')
    const { store, calls } = stubStore()

    const t = await mountToggle()
    release()
    await t.settle()
    expect(isDark()).toBe(true)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(store.size).toBe(0)
    await t.unmount()
  })

  it('touches the store not at all when the platform names no user, and the toggle still works', async () => {
    // The localhost dev page. No `getCriblUser`, so no per-user key exists —
    // and never a shared one in its place.
    const ls = localStorageWith({})
    osPrefersLight()
    const { calls } = stubStore()

    const t = await mountToggle()
    await t.settle()
    expect(isDark()).toBe(false)
    await t.click()
    expect(isDark()).toBe(true)
    expect(ls.get('gigamon-npm-theme'), 'the local cache was not kept').toBe('dark')
    expect(calls, `the store was called with no user: ${calls.map((c) => `${c.method} ${c.url}`).join(', ')}`).toHaveLength(0)
    await t.unmount()
  })

  it('paints the right theme from the first frame when localStorage works — no flash', async () => {
    localStorageWith({ 'gigamon-npm-theme': 'dark' })
    osPrefersLight()
    const release = gatedUser('u-7')
    stubStore({ 'app/prefs/u-7': envelope({ theme: 'dark' }) })

    const t = await mountToggle()
    expect(t.beforeMount, 'main.tsx\'s pre-mount guess was not the cached choice').toBe(true)
    expect(t.firstFrame).toEqual({ dark: true, label: 'Switch to light mode' })
    release()
    await t.settle()
    expect(isDark()).toBe(true)
    await t.unmount()
  })

  it('lets the stored choice win over a stale local cache, and refreshes the cache', async () => {
    // Chose light on another device; this browser's cache still says dark.
    const ls = localStorageWith({ 'gigamon-npm-theme': 'dark' })
    osPrefersLight()
    const release = gatedUser('u-7')
    stubStore({ 'app/prefs/u-7': envelope({ theme: 'light' }) })

    const t = await mountToggle()
    expect(t.firstFrame.dark).toBe(true)
    release()
    await t.settle()
    expect(isDark()).toBe(false)
    expect(ls.get('gigamon-npm-theme')).toBe('light')
    await t.unmount()
  })

  it('degrades to the old behaviour when the store refuses the PUT: the click holds for this page', async () => {
    localStorageThrows()
    osPrefersLight()
    const release = gatedUser('u-7')
    const { calls } = stubStore({}, { refusePut: true })

    const t = await mountToggle()
    release()
    await t.settle()
    await t.click()
    expect(isDark(), 'a refused write undid the click').toBe(true)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    await t.unmount()
  })

  it('reads a stored value that is not a theme as no choice, and repairs nothing', async () => {
    localStorageThrows()
    osPrefersLight()
    const release = gatedUser('u-7')
    const { calls } = stubStore({ 'app/prefs/u-7': envelope({ theme: 'purple' }) })

    const t = await mountToggle()
    release()
    await t.settle()
    expect(isDark()).toBe(false)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    await t.unmount()
  })
})
