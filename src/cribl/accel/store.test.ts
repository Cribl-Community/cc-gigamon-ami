// The state that makes a teardown safe, and the write pattern that keeps it.
//
// Two things here have already gone wrong once in this codebase, in other files,
// and both would be silent if they went wrong again:
//
//   THE LOST WRITE. cribl/prefs.ts held its document in module state and
//   rewrote the whole thing on every change, so a click that landed while the
//   first read was still in flight wrote a document containing only that click's
//   flag — destroying every stored preference the reader had not yet received.
//   The shape here is meant to make that impossible: nothing is cached between
//   calls, and every write does its own read INSIDE the serialised turn that
//   performs it. The two "at the same time" tests below are what say so.
//
//   THE CONTENT TYPE. Spike K-S10: a document PUT as `application/json` answers
//   200 and stores the literal `[object Object]`. The write succeeds, the read
//   succeeds, and the value is gone. cribl/kv.test.ts pins that for the store as
//   a whole; what is pinned here is that this module's documents go through it
//   and come back, because a teardown that has lost its record of what it
//   created falls back to a description anybody can edit.
//
// And one thing that is a decision rather than a bug: a value this module cannot
// read is treated as ABSENT and never repaired. A repair is a write, reads run
// on load, and AGENTS.md forbids writing on load. Reading it as absent is also
// the safe answer for the only caller that matters — "we have no record" makes
// the teardown fall back to the description stamp instead of deleting on trust.
//
// Stubbed at `fetch`, so what these assertions read is the request the platform
// would have received. Each test loads its own copy of the module: the write
// chain and the signed-in-user memo are both module state, and a test that
// inherited either would be testing the one before it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccelCreation, AccelPrefs } from './store'

interface Call {
  method: string
  path: string
  contentType: string | undefined
  body: string | null
}

function response(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  }
}

/** A stand-in app-scoped store that keeps the exact bytes it is handed — the
 *  one behaviour kv.ts is built around. `refuse` makes every write fail the way
 *  the localhost dev page does. */
function stubStore(seed: Record<string, unknown> = {}, refuse = false) {
  const store = new Map<string, string>(
    Object.entries(seed).map(([key, doc]) => [key, JSON.stringify({ version: 1, updatedAt: 1, doc })]),
  )
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).slice('/capi'.length)
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ method, path, contentType: headers['Content-Type'], body: init.body == null ? null : String(init.body) })
    if (path === '/kvstore/keys') return response(200, JSON.stringify([...store.keys()]))
    const key = path.slice('/kvstore/'.length).split('/').map(decodeURIComponent).join('/')
    if (method === 'PUT') {
      if (refuse) return response(403, '')
      store.set(key, String(init.body ?? ''))
      return response(200, '')
    }
    const held = store.get(key)
    return held === undefined ? response(404, '') : response(200, held)
  })
  return { store, calls }
}

/** A fresh copy of the module — the write chain and the user memo are module
 *  state, and no test should inherit another's. */
async function load() {
  vi.resetModules()
  return import('./store')
}

const record = (sha: string): AccelCreation => ({
  at: 1_700_000_000_000,
  appVersion: 'dev',
  manifestVersion: 1,
  bodySha: sha.repeat(12).slice(0, 12),
  displaySha: sha.repeat(12).slice(0, 12),
  by: null,
})

/** The document a PUT carried, unwrapped from kv.ts's envelope. */
function written(calls: readonly Call[], key: string): unknown {
  const put = calls.filter((c) => c.method === 'PUT' && c.path === `/kvstore/${key}`).pop()
  return put ? (JSON.parse(put.body as string) as { doc: unknown }).doc : undefined
}

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the record of what this install wrote', () => {
  it('reads an empty record on a store that has never been written', async () => {
    stubStore()
    const { loadAccelState } = await load()
    expect(await loadAccelState()).toEqual({ version: 1, created: {} })
  })

  it('reads a corrupt value as absent, and does not repair it', async () => {
    // `[object Object]` is what a JSON content type stores (K-S10). Absent is
    // the honest reading; repairing it would be a write on load, which AGENTS.md
    // forbids — and the next real Apply overwrites it anyway.
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      calls.push({ method, path: String(url).slice('/capi'.length), contentType: undefined, body: null })
      return method === 'GET' ? response(200, '[object Object]') : response(200, '')
    })
    const { loadAccelState } = await load()
    expect(await loadAccelState()).toEqual({ version: 1, created: {} })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('reads a document of the wrong shape as absent', async () => {
    stubStore({ 'accel/state': ['gno_lake_30d_c1d'] })
    const { loadAccelState } = await load()
    expect(await loadAccelState().then((s) => s.created)).toEqual({})
  })

  it('keeps the records it can read and drops the ones it cannot', async () => {
    // The store is writable by hand. A half-readable document must not throw
    // away the half that is fine — that half is an ownership proof.
    stubStore({
      'accel/state': { version: 1, created: { good: record('a'), bad: { at: 1 }, alsoBad: 'nonsense' } },
    })
    const { loadAccelState, wasWrittenHere } = await load()
    const state = await loadAccelState()
    expect(Object.keys(state.created)).toEqual(['good'])
    expect(wasWrittenHere(state, 'good')).toBe(true)
    expect(wasWrittenHere(state, 'bad')).toBe(false)
  })

  it('fills in what a partial record is missing rather than discarding it', async () => {
    stubStore({ 'accel/state': { version: 1, created: { x: { bodySha: 'a'.repeat(12), displaySha: 'b'.repeat(12) } } } })
    const { loadAccelState } = await load()
    expect((await loadAccelState()).created.x).toEqual({
      at: 0,
      appVersion: 'unknown',
      manifestVersion: 0,
      bodySha: 'a'.repeat(12),
      displaySha: 'b'.repeat(12),
      by: null,
    })
  })
})

describe('writing the record', () => {
  it('merges onto what is stored instead of replacing it', async () => {
    const { calls } = stubStore({ 'accel/state': { version: 1, created: { first: record('a') } } })
    const { recordAccelWrites } = await load()
    expect(await recordAccelWrites({ second: record('b') })).toBe(true)
    expect(Object.keys((written(calls, 'accel/state') as { created: object }).created).sort()).toEqual([
      'first',
      'second',
    ])
  })

  it('sends the document as text/plain, because JSON stores `[object Object]`', async () => {
    const { calls } = stubStore()
    const { recordAccelWrites } = await load()
    await recordAccelWrites({ x: record('a') })
    expect(calls.find((c) => c.method === 'PUT')?.contentType).toBe('text/plain')
  })

  it('does not lose the first write when two land at once', async () => {
    // THE cribl/prefs.ts REGRESSION. Both writes carry the whole document, so
    // two in flight that each read the store BEFORE either landed would both
    // write a document holding only their own id — and the second would win. The
    // fix is that each write's read happens inside its own serialised turn, so
    // the second reads what the first stored.
    const { calls } = stubStore()
    const { recordAccelWrites } = await load()
    await Promise.all([recordAccelWrites({ a: record('a') }), recordAccelWrites({ b: record('b') })])
    expect(Object.keys((written(calls, 'accel/state') as { created: object }).created).sort()).toEqual(['a', 'b'])
  })

  it('says false when the store refused, so a caller cannot report it as saved', async () => {
    stubStore({}, true)
    const { recordAccelWrites } = await load()
    expect(await recordAccelWrites({ x: record('a') })).toBe(false)
  })

  it('writes nothing at all when asked to record nothing', async () => {
    const { calls } = stubStore()
    const { recordAccelWrites } = await load()
    expect(await recordAccelWrites({})).toBe(true)
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([])
  })
})

describe('forgetting what has been removed', () => {
  it('drops the ids it is given and keeps the rest', async () => {
    // A partial teardown — one search deleted, one refused because it is
    // somebody else's — must keep the record for the one still standing, or the
    // next attempt has lost its second ownership signal.
    const { calls } = stubStore({ 'accel/state': { version: 1, created: { gone: record('a'), stays: record('b') } } })
    const { forgetAccelWrites } = await load()
    await forgetAccelWrites(['gone'])
    expect(Object.keys((written(calls, 'accel/state') as { created: object }).created)).toEqual(['stays'])
  })

  it('leaves an empty record rather than deleting the key', async () => {
    // "This app wrote things here once and owns none of them now" is a true
    // statement and a useful one; an absent key is indistinguishable from an app
    // that has never run.
    const { calls } = stubStore({ 'accel/state': { version: 1, created: { gone: record('a') } } })
    const { forgetAccelWrites } = await load()
    await forgetAccelWrites(['gone'])
    expect(written(calls, 'accel/state')).toEqual({ version: 1, created: {} })
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
  })

  it('writes nothing when there is nothing to forget', async () => {
    const { calls } = stubStore()
    const { forgetAccelWrites } = await load()
    expect(await forgetAccelWrites([])).toBe(true)
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([])
  })
})

describe('per-viewer preferences', () => {
  it('reads the defaults and writes nothing when the platform names nobody', async () => {
    // The localhost dev page, and an older platform build. A shared stand-in id
    // would file every unidentified viewer into one document, so one person's
    // choice would become everybody's — see cribl/user.ts.
    const { calls } = stubStore()
    const { loadAccelPrefs, saveAccelPref } = await load()
    expect(await loadAccelPrefs()).toEqual({})
    expect(await saveAccelPref('liveReads', true)).toBe(false)
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([])
  })

  it('keys the document on the signed-in user', async () => {
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-42', username: 'jpederson' }))
    const { calls } = stubStore()
    const { saveAccelPref } = await load()
    expect(await saveAccelPref('liveReads', true)).toBe(true)
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/kvstore/accel/prefs/u-42')
  })

  it('keeps a field it does not know about when one is set', async () => {
    // Forward compatibility, and the reason the write is read-merge-write rather
    // than a write of the one field. A NEWER release of this app writes a
    // preference this one has never heard of; an older tab left open must not
    // delete it on the next toggle. Same bug as cribl/prefs.ts's, arriving from
    // the future instead of from a second writer.
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-42', username: 'jpederson' }))
    const { calls } = stubStore({ 'accel/prefs/u-42': { fromALaterRelease: 'keep me' } })
    const { saveAccelPref, loadAccelPrefs } = await load()
    await saveAccelPref('liveReads', true)
    expect(written(calls, 'accel/prefs/u-42')).toEqual({ fromALaterRelease: 'keep me', liveReads: true })
    expect(await loadAccelPrefs()).toEqual({ fromALaterRelease: 'keep me', liveReads: true })
  })

  it('does not lose one preference when two different ones are set at once', async () => {
    // THE cribl/prefs.ts BUG, at this document. Two writes land in the same tick.
    // Serialised, the second re-reads and merges onto the first, so both fields
    // survive; interleaved, both read `{}` and the second PUT overwrites the
    // first's field with a document that never contained it.
    //
    // It takes TWO DISTINCT KEYS to tell those apart — with one key both
    // orderings end at the same document, and the test proves nothing. AccelPrefs
    // currently declares one field, so the second key here is an invented future
    // one, cast at the call. That is deliberate: the alternative was keeping a
    // product field nobody reads just to give this test something to write, and a
    // preference that exists only to be tested is how `applyPromptDismissed` got
    // here. The cast stays inside this file.
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-42', username: 'jpederson' }))
    const later = 'fromALaterRelease' as unknown as keyof AccelPrefs
    const { calls } = stubStore()
    const { saveAccelPref } = await load()
    await Promise.all([
      saveAccelPref('liveReads', true),
      saveAccelPref(later, 'keep me' as unknown as AccelPrefs[keyof AccelPrefs]),
    ])
    expect(written(calls, 'accel/prefs/u-42')).toEqual({ liveReads: true, fromALaterRelease: 'keep me' })
  })
})

describe('the audit trail', () => {
  it('writes one document per entry, keyed by the millisecond', async () => {
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-42', username: 'jpederson' }))
    const { calls } = stubStore()
    const { logAccel } = await load()
    await logAccel({ action: 'accel.applied', outcome: 'ok' })
    await logAccel({ action: 'accel.removed', outcome: 'ok' })
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => c.path)
    expect(puts).toHaveLength(2)
    expect(new Set(puts).size).toBe(2)
    for (const path of puts) expect(path).toMatch(/^\/kvstore\/accel\/log\/\d+$/)
  })

  it('stamps who and when, rather than trusting what the caller said', async () => {
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-42', username: 'jpederson' }))
    const { calls } = stubStore()
    const { logAccel } = await load()
    await logAccel({ action: 'accel.paused', id: 'gno_lake_30d_c1d', at: 0, by: 'somebody else' })
    const put = calls.find((c) => c.method === 'PUT')
    const doc = (JSON.parse(put?.body as string) as { doc: { at: number; by: string } }).doc
    expect(doc.by).toBe('u-42')
    expect(doc.at).toBeGreaterThan(0)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//  • That the app-scoped store exists where the app runs. It does not on the
//    localhost dev page (`npm run dev`): that proxy rewrites `/capi` → `/api/v1`
//    without the `/a/{appId}/` scope, so every call 404s. Durability is only
//    visible installed, or in the in-UI Live Preview.
//  • That an uninstall cleans any of this up. It does not — the platform gives
//    an app no uninstall hook (I-D28), which is the whole reason the teardown is
//    a button somebody has to press while the app is still there.
//  • That the record is ever RIGHT about the workspace. It records what this
//    install wrote; somebody deleting a saved search in Cribl's own UI leaves it
//    stale, which is why accel/provision.ts reads the workspace and treats this
//    as corroboration rather than as truth.
