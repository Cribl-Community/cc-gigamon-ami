// The two things Guided Setup remembers, and the two ways it loses them.
//
// This file used to hand-roll a fetch, an `[object Object]` check and an
// envelope unwrap of its own; all three now belong to kv.ts, and kv.test.ts
// pins them. What is left to pin here is the part a shared store cannot know:
// which key each thing goes under, that a commit note is install-wide while a
// picked worker group is one field of one viewer's own document, and that an
// unidentified viewer writes nothing at all rather than into a shared key.
//
// Stubbed at `fetch` rather than at kv.ts, like kv.test.ts, so these assertions
// see the request the platform would have received. A change to the store's
// contract breaks them instead of being papered over.

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

/** A stand-in app-scoped store: PUT keeps the bytes verbatim, GET hands them
 *  back, an absent key 404s. */
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

/** A document as kv.ts writes it. */
const envelope = (doc: unknown) => JSON.stringify({ version: 1, updatedAt: 0, doc })

const docIn = (raw: string) => (JSON.parse(raw) as { doc: unknown }).doc

// user.ts memoises the signed-in user for the life of the module, so each test
// loads its own copy of the chain rather than trying to unsay a previous answer.
async function loadSetupMemory() {
  vi.resetModules()
  return import('./setupMemory')
}

const signedInAs = (id: string) => vi.stubGlobal('getCriblUser', async () => ({ id, username: id }))

// kv.ts warns once a session when the store refuses it; that is console noise
// here, and asserting on it would make these tests depend on their own order.
beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const MEM = { default: { pipeline: { hash: 'abc1234', message: 'add gigamon syslog' } } }

describe('commit memory', () => {
  it('reads the bare document written before kv.ts existed', async () => {
    // The key predates the envelope. Moving Guided Setup onto the shared store
    // must not lose what is already under it.
    stubStore({ 'guided_setup_memory/commits': JSON.stringify(MEM) })
    const { loadCommitMemory } = await loadSetupMemory()
    expect(await loadCommitMemory()).toEqual(MEM)
  })

  it('writes the whole memory under its own key, as text/plain', async () => {
    const { store, calls } = stubStore()
    const { saveCommitMemory } = await loadSetupMemory()
    expect(await saveCommitMemory(MEM)).toBe(true)

    const put = calls.find((c) => c.method === 'PUT')
    expect(put, 'saveCommitMemory did not PUT anything').toBeDefined()
    expect(put!.url).toBe('/capi/kvstore/guided_setup_memory/commits')
    // The content type is the whole difference between a stored document and
    // the literal "[object Object]" this key was lost to once already.
    expect(put!.headers['Content-Type']).toBe('text/plain')
    expect(docIn(store.get('guided_setup_memory/commits')!)).toEqual(MEM)
  })

  it('reads the corrupt value that loss left behind as first run, and leaves it alone', async () => {
    const { store, calls } = stubStore({ 'guided_setup_memory/commits': '[object Object]' })
    const { loadCommitMemory } = await loadSetupMemory()
    expect(await loadCommitMemory()).toEqual({})
    // Repairing it here would be a write on load, which AGENTS.md forbids.
    expect(calls.every((c) => c.method === 'GET'), 'a read wrote to the store').toBe(true)
    expect(store.get('guided_setup_memory/commits')).toBe('[object Object]')
  })

  it('answers false when the store refuses the write, so the screen can stop saying "saved"', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse(500, ''))
    const { saveCommitMemory } = await loadSetupMemory()
    expect(await saveCommitMemory(MEM)).toBe(false)
  })
})

describe('worker-group preference', () => {
  it('keys the choice on the signed-in user, and reads it back', async () => {
    signedInAs('u-42')
    const { store } = stubStore()
    const { loadSetupGroup, saveSetupGroup } = await loadSetupMemory()

    expect(await saveSetupGroup('lakehouse')).toBe(true)
    // This key, and not `app/prefs/<id>`: cribl/prefs.ts rewrites that document
    // wholesale from its own cache, so a field written here would vanish the
    // next time somebody dismissed a banner.
    expect([...store.keys()]).toEqual(['guided_setup_memory/prefs/u-42'])
    expect(await loadSetupGroup()).toBe('lakehouse')
  })

  it('merges into the document instead of replacing it', async () => {
    // One document holds whatever this screen remembers about a viewer. A write
    // that carried only its own field would drop the rest.
    signedInAs('u-42')
    const { store } = stubStore({ 'guided_setup_memory/prefs/u-42': envelope({ askedAgain: false }) })
    const { saveSetupGroup } = await loadSetupMemory()

    await saveSetupGroup('lakehouse')
    expect(docIn(store.get('guided_setup_memory/prefs/u-42')!)).toEqual({ askedAgain: false, setupGroup: 'lakehouse' })
  })

  it('writes nothing at all when the platform names no user', async () => {
    // No id, no key. A shared stand-in would hand one viewer's choice to every
    // other viewer, which is the failure per-user documents exist to avoid.
    const { calls } = stubStore()
    const { loadSetupGroup, saveSetupGroup } = await loadSetupMemory()

    expect(await saveSetupGroup('lakehouse')).toBe(false)
    expect(await loadSetupGroup()).toBe(null)
    expect(calls, 'an unidentified viewer touched the store').toEqual([])
  })
})

describe('commit memory, written by two panels', () => {
  it('a change reads the stored document again and keeps the other panel’s key', async () => {
    // The Raw HTTP panel loaded {pipeline} on mount; the onboarding panel then
    // recorded the pack's commit. The Raw HTTP panel's next change must not
    // write back the document it loaded and drop `onboarding_pack`.
    const { store } = stubStore({ 'guided_setup_memory/commits': envelope(MEM) })
    const { updateCommitMemory } = await loadSetupMemory()
    await updateCommitMemory({ group: 'default', set: { onboarding_pack: { hash: 'pack111', message: 'onboard' } } })
    const { memory, saved } = await updateCommitMemory({ group: 'default', drop: ['pipeline'], set: { source: { hash: 'src222', message: 'x' } } })
    expect(saved).toBe(true)
    expect(memory).toEqual({ default: { onboarding_pack: { hash: 'pack111', message: 'onboard' }, source: { hash: 'src222', message: 'x' } } })
    expect(docIn(store.get('guided_setup_memory/commits')!)).toEqual(memory)
  })

  it('two changes started together run one after the other, and neither is lost', async () => {
    const { store } = stubStore()
    const { updateCommitMemory } = await loadSetupMemory()
    await Promise.all([
      updateCommitMemory({ group: 'default', set: { onboarding_pack: { hash: 'a', message: 'a' } } }),
      updateCommitMemory({ group: 'default', set: { route: { hash: 'b', message: 'b' } } }),
    ])
    expect(docIn(store.get('guided_setup_memory/commits')!)).toEqual({
      default: { onboarding_pack: { hash: 'a', message: 'a' }, route: { hash: 'b', message: 'b' } },
    })
  })
})
