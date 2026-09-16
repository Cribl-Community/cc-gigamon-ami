// The frame-by-frame behaviour, because that is the whole difficulty here.
//
// Swapping localStorage for the KV store turned a synchronous read into a round
// trip. The bug that swap invites is not a wrong value but a wrong FIRST FRAME:
// default the flag to false and every returning viewer sees the banner they
// already dismissed, for as long as the GET takes, on every single load. That
// is worse than the storage bug being fixed, and no assertion on the final
// value would catch it — the final value is right either way.
//
// So these tests record what every render saw, in order, and assert on the
// sequence. `[undefined, true]` is the contract; `[false, true]` is the flash.
//
// The module keeps one document for the page, so each test loads its own copy
// of it. React and react-dom are imported in the same generation as prefs, or
// the hook and the renderer would be talking to two different Reacts. That is
// also why there is no JSX in this file: the JSX transform's import of
// react/jsx-runtime is static and would not move with the reset.
//
// Stubbed at `fetch`, like kv.test.ts, so what these tests see is the request
// the platform would have received — transport, key path and content type
// included, rather than a mock of the module in between.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
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

/** A stand-in app-scoped store, keeping the exact bytes it is handed. */
function stubStore(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({
      url: u,
      method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body == null ? null : String(init.body),
    })
    const key = u
      .slice(u.indexOf('/kvstore/') + '/kvstore/'.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/')
    if (method === 'PUT') {
      store.set(key, String(init.body ?? ''))
      return fakeResponse(200, '')
    }
    const held = store.get(key)
    return held === undefined ? fakeResponse(404, '') : fakeResponse(200, held)
  })
  return { store, calls }
}

/** What the store holds for a viewer who has dismissed both banners. */
const stored = (doc: unknown) => JSON.stringify({ version: 1, updatedAt: 1, doc })

type Frame = [boolean | undefined, boolean | undefined]

/**
 * Mount one component that reads both flags, and record what each render saw.
 * Returns once the document has landed and React has settled.
 */
async function mountProbe() {
  vi.resetModules()
  const react = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { usePref } = await import('./prefs')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  const frames: Frame[] = []
  let setTour: (v: boolean) => void = () => {}
  let setIntel: (v: boolean) => void = () => {}

  function Probe() {
    const [tour, a] = usePref('tourSeen')
    const [intel, b] = usePref('intelPromptDismissed')
    frames.push([tour, intel])
    setTour = a
    setIntel = b
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  // A macrotask boundary, so everything the load queued (the user lookup, the
  // GET, the publish, React's re-render) has definitely run by the time an
  // assertion looks.
  const settle = () => react.act(async () => { await new Promise((r) => setTimeout(r, 0)) })

  await react.act(async () => { root.render(react.createElement(Probe)) })
  await settle()

  return {
    frames,
    latest: () => frames[frames.length - 1],
    set: async (which: 'tour' | 'intel', value: boolean) => {
      await react.act(async () => {
        if (which === 'tour') setTour(value)
        else setIntel(value)
      })
      await settle()
    },
    unmount: async () => {
      await react.act(async () => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('usePref', () => {
  it('answers "not yet" before the document lands, never a false that flashes the banner back', async () => {
    // The whole point of the third state. A viewer who dismissed both banners
    // must never see either of them again, not even for one frame.
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-7', username: 'jpederson' }))
    stubStore({ 'app/prefs/u-7': stored({ tourSeen: true, intelPromptDismissed: true }) })

    const probe = await mountProbe()
    expect(probe.frames[0], 'the first frame claimed to know a preference it had not read yet').toEqual([undefined, undefined])
    expect(
      probe.frames.some(([tour, intel]) => tour === false || intel === false),
      'a frame rendered false for a dismissed banner — that is the flash this design exists to prevent',
    ).toBe(false)
    expect(probe.latest()).toEqual([true, true])
    await probe.unmount()
  })

  it('reads an absent document as "not dismissed", so a genuinely new viewer is still offered the tour', async () => {
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-new', username: 'new' }))
    const { calls } = stubStore()

    const probe = await mountProbe()
    expect(probe.frames[0]).toEqual([undefined, undefined])
    expect(probe.latest()).toEqual([false, false])
    // 404 is the store saying "nothing here", and nothing here repairs it: a
    // load that writes is the thing AGENTS.md forbids.
    expect(calls.every((c) => c.method === 'GET'), 'loading preferences wrote to the store').toBe(true)
    await probe.unmount()
  })

  it('writes one document per viewer, as text/plain, carrying every flag set so far', async () => {
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-7', username: 'jpederson' }))
    const { store, calls } = stubStore()

    const probe = await mountProbe()
    await probe.set('tour', true)
    expect(probe.latest(), 'the click did not take effect until the write came back').toEqual([true, false])
    await probe.set('intel', true)

    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts[0].url).toBe('/capi/kvstore/app/prefs/u-7')
    // application/json is the content type that stores "[object Object]"
    // (K-S10) — kv.ts is the one place that knows it, and this is prefs.ts
    // going through kv.ts rather than around it.
    expect(puts[0].headers['Content-Type']).toBe('text/plain')
    expect([...store.keys()], 'one document per viewer, not one key per flag').toEqual(['app/prefs/u-7'])

    const doc = (JSON.parse(store.get('app/prefs/u-7')!) as { doc: unknown }).doc
    expect(doc, 'the second write dropped the flag the first one set').toEqual({
      tourSeen: true,
      intelPromptDismissed: true,
    })
    await probe.unmount()
  })

  it('touches the store not at all when the platform names no user, and still honours the click', async () => {
    // The localhost dev page, and any Cribl build that does not answer with a
    // user. There is no per-user key to read or write: `app/prefs/null` would
    // be a shared document under another name, and one viewer's dismissal
    // would become everybody's.
    const { calls } = stubStore()

    const probe = await mountProbe()
    expect(probe.latest(), 'an unidentified viewer was left waiting for a document that is never coming').toEqual([false, false])
    await probe.set('tour', true)
    expect(probe.latest(), 'the banner did not go away for a viewer the platform cannot name').toEqual([true, false])
    expect(calls, `the store was called with no user signed in: ${calls.map((c) => `${c.method} ${c.url}`).join(', ')}`).toHaveLength(0)
    await probe.unmount()
  })

  it('reads the "[object Object]" corruption as absent, and leaves it where it is', async () => {
    // A value some earlier application/json write left behind. Repairing it on
    // load would be a write on load; the next genuine click overwrites it.
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-7', username: 'jpederson' }))
    const { store, calls } = stubStore({ 'app/prefs/u-7': '[object Object]' })

    const probe = await mountProbe()
    expect(probe.latest()).toEqual([false, false])
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(store.get('app/prefs/u-7')).toBe('[object Object]')
    await probe.unmount()
  })

  it('survives an unreachable store rather than taking the page down with it', async () => {
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-7', username: 'jpederson' }))
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })

    const probe = await mountProbe()
    expect(probe.latest()).toEqual([false, false])
    await probe.set('intel', true)
    expect(probe.latest()).toEqual([false, true])
    await probe.unmount()
  })
})
