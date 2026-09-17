// What the store actually receives, and what it gives back.
//
// Spike K-S10 found a write that answers 200 and stores nothing usable: with
// `Content-Type: application/json` the KV store persists the literal
// `[object Object]`. Nothing about that failure is visible from the app — the
// PUT succeeds, the GET succeeds, and the value is gone. The app's first KV key
// was written that way and the store is empty because of it.
//
// So these tests pin the two ends of that trip: the exact request putDoc sends
// (the content type is the fix, and a plausible-looking "fix" back to JSON would
// silently lose every setting), and what getDoc does with each thing the store
// can answer — a document, a 404, a corrupt value, a document written before the
// envelope existed. The prefix listing is pinned because its shape is measured
// rather than documented: it is absent from the 4.19.0 OpenAPI spec.
//
// The fake store below keeps the exact bytes it is handed. Anything it does that
// the real store does not is a bug in this file, not in kv.ts. It is stubbed at
// `fetch` rather than at `capi`, so the request these assertions see is the one
// the platform would have received, transport included.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendLog, deleteDoc, getDoc, listKeys, putDoc } from './kv'

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
    statusText: status === 404 ? 'Not Found' : status >= 500 ? 'Internal Server Error' : 'OK',
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  }
}

/** A stand-in app-scoped store: PUT keeps the bytes verbatim, GET hands them
 *  back, DELETE drops them, an absent key 404s, and `POST /kvstore/keys`
 *  answers the bare array of names K-S10 measured. */
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
    if (u.endsWith('/kvstore/keys') && method === 'POST') {
      const prefix = (JSON.parse(String(init.body ?? '{}')) as { prefix?: string }).prefix ?? ''
      return fakeResponse(200, JSON.stringify([...store.keys()].filter((k) => k.startsWith(prefix))))
    }
    const key = u
      .slice(u.indexOf('/kvstore/') + '/kvstore/'.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/')
    if (method === 'PUT') {
      store.set(key, String(init.body ?? ''))
      return fakeResponse(200, '')
    }
    if (method === 'DELETE') return fakeResponse(store.delete(key) ? 200 : 404, '')
    const held = store.get(key)
    return held === undefined ? fakeResponse(404, '') : fakeResponse(200, held)
  })
  return { store, calls }
}

// The module warns once per session when the store refuses it; that is console
// noise here, and asserting on it would make these tests depend on their own
// order.
beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const CAPS = { tiers: [{ upToSeconds: 3600, capSeconds: 240 }] }

describe('putDoc', () => {
  it('sends text/plain — the content type is the difference between a value and "[object Object]"', async () => {
    const { store, calls } = stubStore()
    expect(await putDoc('app/settings/search_caps', CAPS)).toBe(true)

    const put = calls.find((c) => c.method === 'PUT')
    expect(put, 'putDoc did not PUT anything').toBeDefined()
    expect(put!.url).toBe('/capi/kvstore/app/settings/search_caps')
    expect(put!.headers['Content-Type']).toBe('text/plain')
    // Spelled out as its own assertion: JSON is the content type a reader
    // reaches for, and it is the one that loses the document.
    expect(Object.values(put!.headers)).not.toContain('application/json')

    const stored = JSON.parse(store.get('app/settings/search_caps')!) as { version: number; doc: unknown }
    expect(stored.version).toBe(1)
    expect(stored.doc).toEqual(CAPS)
  })

  it('round-trips a document through the envelope', async () => {
    stubStore()
    await putDoc('gigamon/prefs/u-7', { intelPromptDismissed: true, tourSeen: true })
    expect(await getDoc('gigamon/prefs/u-7')).toEqual({ intelPromptDismissed: true, tourSeen: true })
  })

  it('answers false — not "saved" — when the store refuses the write, and still shows the session its own value', async () => {
    // This is the localhost dev page: no app-scoped store, every call 404s. The
    // value has to survive the session (or a developer re-dismisses every banner
    // on every navigation) without anyone being told it was persisted.
    vi.stubGlobal('fetch', async () => fakeResponse(500, ''))
    expect(await putDoc('gigamon/prefs/u-refused', { tourSeen: true })).toBe(false)
    expect(await getDoc('gigamon/prefs/u-refused')).toEqual({ tourSeen: true })
  })
})

describe('getDoc', () => {
  it('reads an absent key as null, because 404 is the store saying "nothing here"', async () => {
    const { calls } = stubStore()
    expect(await getDoc('app/settings/never_written')).toBe(null)
    expect(calls.every((c) => c.method === 'GET'), 'a read touched the store').toBe(true)
  })

  it('reads a corrupt "[object Object]" as absent, and does not repair it', async () => {
    // The value an application/json write leaves behind. Rewriting it here would
    // be a write on load, which AGENTS.md forbids; the next user-triggered write
    // is what fixes it.
    const { store, calls } = stubStore({ 'guided_setup_memory/commits': '[object Object]' })
    expect(await getDoc('guided_setup_memory/commits')).toBe(null)
    expect(calls.some((c) => c.method !== 'GET'), 'reading a corrupt key wrote to the store').toBe(false)
    expect(store.get('guided_setup_memory/commits')).toBe('[object Object]')
  })

  it('reads a value that is not JSON at all as absent, rather than throwing at the caller', async () => {
    stubStore({ 'app/settings/junk': 'not json' })
    expect(await getDoc('app/settings/junk')).toBe(null)
  })

  it('hands back a bare document written before the envelope existed', async () => {
    // Guided Setup's commit memory is stored unwrapped. A caller moving onto
    // this module must not lose what it already wrote.
    stubStore({ 'guided_setup_memory/commits': '{"default":{"pipeline":{"hash":"abc","message":"add"}}}' })
    expect(await getDoc('guided_setup_memory/commits')).toEqual({
      default: { pipeline: { hash: 'abc', message: 'add' } },
    })
  })

  it('survives an unreachable store', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await getDoc('app/settings/search_caps')).toBe(null)
  })
})

describe('listKeys', () => {
  it('parses the bare array the store answers with', async () => {
    stubStore({ 'audit/log/1': '{}', 'audit/log/2': '{}', 'gigamon/prefs/u-1': '{}' })
    expect(await listKeys('audit/log/')).toEqual(['audit/log/1', 'audit/log/2'])
  })

  it('also reads an envelope, because the endpoint is undocumented and may grow one', async () => {
    // Absent from the 4.19.0 OpenAPI spec: the bare array is an observation, not
    // a contract. A wrapped answer must not read as an empty store.
    vi.stubGlobal('fetch', async () => fakeResponse(200, JSON.stringify({ items: ['audit/log/1', { key: 'audit/log/2' }] })))
    expect(await listKeys('audit/log/')).toEqual(['audit/log/1', 'audit/log/2'])
  })

  it('answers an empty list, not an exception, when the shape is unrecognisable', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse(200, '{"unexpected":true}'))
    expect(await listKeys('audit/log/')).toEqual([])
  })
})

describe('deleteDoc', () => {
  it('sends a DELETE, and counts an already-absent key as gone', async () => {
    const { calls } = stubStore({ 'audit/log/1': '{"version":1,"doc":{}}' })
    expect(await deleteDoc('audit/log/1')).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/kvstore/audit/log/1'))).toBe(true)
    expect(await deleteDoc('audit/log/1')).toBe(true)
  })
})

describe('appendLog', () => {
  it('files one document per entry, keyed by the millisecond it happened', async () => {
    const { store, calls } = stubStore()
    await appendLog('gigamon', { action: 'syslog_stack.applied', group: 'default' })
    await appendLog('gigamon', { action: 'syslog_stack.removed', group: 'default' })

    const keys = [...store.keys()]
    expect(keys).toHaveLength(2)
    expect(keys.every((k) => /^gigamon\/log\/\d+$/.test(k)), `unexpected log keys: ${keys.join(', ')}`).toBe(true)
    // Two entries inside one millisecond must not become one entry.
    expect(new Set(keys).size).toBe(2)
    expect(calls.filter((c) => c.method === 'PUT').every((c) => c.headers['Content-Type'] === 'text/plain')).toBe(true)

    const first = (JSON.parse(store.get(keys[0])!) as { doc: { action: string; at: number; by: string | null } }).doc
    expect(first.action).toBe('syslog_stack.applied')
    expect(typeof first.at).toBe('number')
    // No platform user in this environment — an entry nobody can be attributed
    // to says so, rather than naming an id that does not exist.
    expect(first.by).toBe(null)
  })

  it('stamps who and when itself, over whatever the caller claimed', async () => {
    const { store } = stubStore()
    await appendLog('gigamon', { action: 'settings.saved', by: 'somebody-else', at: 0 })
    const key = [...store.keys()][0]
    const doc = (JSON.parse(store.get(key)!) as { doc: { at: number; by: string | null } }).doc
    expect(doc.by).toBe(null)
    expect(doc.at).toBeGreaterThan(0)
  })
})
