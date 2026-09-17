// The install-wide running-time limits, and the two rules they have to keep.
//
// RULE ONE: the load path writes nothing. AGENTS.md forbids a volatile call on
// load, render or a timer, and the tidy-up this file invites — find a corrupt or
// absurd stored value, replace it with something sensible — is exactly that. So
// the assertions below are as much about the requests that did NOT happen as
// about the caps that came out.
//
// RULE TWO: a refused write says so. `putDoc` answers false when the store would
// not keep the value, and a settings screen is the one caller that must not
// discard that boolean: the customer pressed Save and is owed the difference
// between "every viewer has this now" and "this page has this until you reload".
//
// Stubbed at `fetch`, like kv.test.ts and prefs.test.ts, so what these tests see
// is the request the platform would have received — key path, method and content
// type included — rather than a mock of kv.ts or capi.ts in between.
//
// Each test loads its own generation of the modules: both the cap table in
// search.ts and the once-per-page read in searchCaps.ts are module state, and a
// memoised read cannot be un-memoised.

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
    const key = u.slice(u.indexOf('/kvstore/') + '/kvstore/'.length).split('/').map(decodeURIComponent).join('/')
    if (method === 'PUT') {
      store.set(key, String(init.body ?? ''))
      return fakeResponse(200, '')
    }
    const held = store.get(key)
    return held === undefined ? fakeResponse(404, '') : fakeResponse(200, held)
  })
  return { store, calls }
}

/** A stored document, in the envelope kv.ts writes and reads. */
const enveloped = (doc: unknown) => JSON.stringify({ version: 1, updatedAt: 1, doc })

/** One generation of the two modules, so each test gets its own cap table. */
async function fresh() {
  vi.resetModules()
  const search = await import('./search')
  const caps = await import('./searchCaps')
  return { ...search, ...caps }
}

// kv.ts warns once per session when the store refuses it. That is console noise
// here, and asserting on it would make these tests depend on their own order.
beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('loadSearchCaps', () => {
  it('applies a stored table, and reads the widest tier back out of JSON null', async () => {
    // The document as saveSearchCaps writes it: the unbounded tier's bound is
    // null, because JSON has no Infinity. If that does not come back as Infinity
    // the widest band silently stops matching anything.
    const stored = [
      { upToSeconds: 3600, capSeconds: 300 },
      { upToSeconds: null, capSeconds: 1800 },
    ]
    stubStore({ 'app/settings/search_caps': enveloped(stored) })
    const m = await fresh()

    expect(await m.loadSearchCaps()).toBe('stored')
    expect(m.capSecondsFor('-15m')).toBe(300)
    expect(m.capSecondsFor('-30d')).toBe(1800)
    expect(m.capsSource()).toBe('stored')
  })

  it('reads once per page however many callers ask', async () => {
    const { calls } = stubStore()
    const m = await fresh()
    await Promise.all([m.loadSearchCaps(), m.loadSearchCaps()])
    await m.loadSearchCaps()
    expect(calls.filter((c) => c.url.includes('search_caps')).length).toBe(1)
  })

  it('leaves the defaults in force for an absent setting, and touches nothing', async () => {
    const { calls } = stubStore()
    const m = await fresh()

    expect(await m.loadSearchCaps()).toBe('default')
    expect(m.capTiersInForce()).toEqual(m.DEFAULT_CAP_TIERS)
    expect(calls.every((c) => c.method === 'GET'), 'the load path wrote to the store').toBe(true)
  })

  it('treats a corrupt value as absent and does NOT repair it', async () => {
    // What an application/json PUT used to leave behind (K-S10). Rewriting it
    // would be a write on load, which AGENTS.md forbids — and one nobody asked
    // for. The next real Save overwrites it.
    const { calls } = stubStore({ 'app/settings/search_caps': '[object Object]' })
    const m = await fresh()

    expect(await m.loadSearchCaps()).toBe('default')
    expect(m.capSecondsFor('-15m')).toBe(120)
    expect(calls.some((c) => c.method === 'PUT'), 'the corrupt value was repaired on load').toBe(false)
  })

  it('refuses a stored table that is well-formed and absurd', async () => {
    // A day is not a cap. `setCapTiers` alone would take this one happily: it is
    // a positive number in a properly shaped row.
    stubStore({ 'app/settings/search_caps': enveloped([{ upToSeconds: null, capSeconds: 86400 }]) })
    const m = await fresh()

    expect(await m.loadSearchCaps()).toBe('default')
    expect(m.capTiersInForce()).toEqual(m.DEFAULT_CAP_TIERS)
  })
})

describe('saveSearchCaps', () => {
  const TIERS = [
    { upToSeconds: 3600, capSeconds: 240 },
    { upToSeconds: Infinity, capSeconds: 1200 },
  ]

  it('writes the table with the unbounded tier as null, and logs the change', async () => {
    const { store, calls } = stubStore()
    const m = await fresh()
    await m.loadSearchCaps()

    const res = await m.saveSearchCaps(TIERS)
    expect(res.ok).toBe(true)
    expect(m.capSecondsFor('-30d')).toBe(1200)

    const doc = JSON.parse(store.get('app/settings/search_caps')!) as { doc: unknown }
    expect(doc.doc).toEqual([
      { upToSeconds: 3600, capSeconds: 240 },
      { upToSeconds: null, capSeconds: 1200 },
    ])
    // text/plain is the difference between a setting and "[object Object]".
    expect(calls.find((c) => c.method === 'PUT')!.headers['Content-Type']).toBe('text/plain')

    // A user-triggered write to install-wide state, so it belongs in the trail —
    // with what it replaced, which is what makes the change reversible. The trail
    // is deliberately not awaited (the customer waits on their setting, not on
    // the audit copy), so it has to be flushed before it can be read.
    await new Promise((r) => setTimeout(r, 0))
    const logKey = [...store.keys()].find((k) => k.startsWith('gigamon/log/'))
    expect(logKey, 'saving the caps wrote no audit entry').toBeDefined()
    const entry = (JSON.parse(store.get(logKey!)!) as { doc: { action: string; replaced: unknown } }).doc
    expect(entry.action).toBe('settings.search_caps.saved')
    expect(entry.replaced).toEqual([
      { upToSeconds: 3600, capSeconds: 120 },
      { upToSeconds: 4 * 3600, capSeconds: 300 },
      { upToSeconds: 86400, capSeconds: 600 },
      { upToSeconds: null, capSeconds: 900 },
    ])
  })

  it('answers false — not "saved" — when the store refuses, and still applies the caps here', async () => {
    // The localhost dev page, and any unreachable store. The panel prints the
    // difference; treating false as success is how a customer finds out by
    // losing the setting.
    vi.stubGlobal('fetch', async () => fakeResponse(500, ''))
    const m = await fresh()

    const res = await m.saveSearchCaps(TIERS)
    expect(res.ok).toBe(false)
    expect(m.capsSource()).toBe('page')
    expect(m.capSecondsFor('-30d')).toBe(1200)
  })

  it('refuses an absurd table outright, changes nothing, and says why', async () => {
    const { calls } = stubStore()
    const m = await fresh()

    const res = await m.saveSearchCaps([{ upToSeconds: Infinity, capSeconds: 5 }])
    expect(res.ok).toBe(false)
    expect(res.refused).toContain('from 30 up to 3600')
    expect(m.capTiersInForce()).toEqual(m.DEFAULT_CAP_TIERS)
    expect(calls.some((c) => c.method === 'PUT'), 'a refused table was written anyway').toBe(false)
  })
})
