// The mode a whole page shares, and the four ways it has to not lie.
//
// Every assertion here is about one of:
//
//   * A CHOICE THAT REVERTS ITSELF. The stored preference is read
//     asynchronously and a person can press a segment before it lands. Without a
//     guard the late read silently puts the mode back — a control that works and
//     then un-works, which is worse than one that never worked.
//   * A WRITE ON LOAD. An expired `liveReads` is read as Snapshot and the
//     document is left exactly as it is. CLAUDE.md forbids repairing a stale KV
//     value on load, so these count PUTs, not just return values.
//   * A FORGOTTEN `Live` BILLING FOREVER. The expiry is the whole cap, so the
//     two fields that carry it have to reach the store TOGETHER — a document
//     holding `liveReads: true` with no expiry beside it is the state the expiry
//     exists to prevent, and two sequential writes create it.
//   * A CHOICE PRESENTED AS SAVED WHEN IT WAS NOT. No signed-in user, or a store
//     that refused, and the control has to say so.
//
// Stubbed at `fetch` and loaded fresh per test, the way accel/store.test.ts is:
// the write chain, the signed-in-user memo and this module's own published state
// are all module state, and a test that inherited any of them would be testing
// the one before it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Call {
  method: string
  path: string
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

/** A stand-in app-scoped store. `hold` keeps every GET pending until it is
 *  released, which is how a press can be made to beat the preference read. */
function stubStore(seed: Record<string, unknown> = {}, opts: { refuse?: boolean; hold?: boolean } = {}) {
  const store = new Map<string, string>(
    Object.entries(seed).map(([key, doc]) => [key, JSON.stringify({ version: 1, updatedAt: 1, doc })]),
  )
  const calls: Call[] = []
  let release: () => void = () => {}
  const gate = opts.hold ? new Promise<void>((r) => (release = r)) : Promise.resolve()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).slice('/capi'.length)
    calls.push({ method, path, body: init.body == null ? null : String(init.body) })
    const key = path.slice('/kvstore/'.length).split('/').map(decodeURIComponent).join('/')
    if (method === 'PUT') {
      if (opts.refuse) return response(403, '')
      store.set(key, String(init.body ?? ''))
      return response(200, '')
    }
    await gate
    const held = store.get(key)
    return held === undefined ? response(404, '') : response(200, held)
  })
  return { store, calls, release: () => release() }
}

/** A fresh copy of BOTH halves of the feature: accel/mode.ts owns the stored
 *  preference, cribl/dataMode.ts owns the value every panel re-renders on, and
 *  both are module state no test should inherit from the one before it. */
async function load() {
  vi.resetModules()
  const [mode, data] = await Promise.all([import('./mode'), import('../dataMode')])
  return { ...mode, dataMode: data.dataMode, dataModeSave: data.dataModeSave, setDataMode: data.setDataMode }
}

const asUser = (id = 'u-42') => vi.stubGlobal('getCriblUser', async () => ({ id, username: 'jpederson' }))

/** The prefs document a PUT carried, unwrapped from kv.ts's envelope. */
function writtenPrefs(calls: readonly Call[]): Record<string, unknown> | undefined {
  const put = calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/kvstore/accel/prefs/')).pop()
  return put ? (JSON.parse(put.body as string) as { doc: Record<string, unknown> }).doc : undefined
}

const puts = (calls: readonly Call[]) => calls.filter((c) => c.method === 'PUT')

const HOUR = 3_600_000

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('reading the stored choice', () => {
  it('starts on Snapshot and says it has not read anything yet', async () => {
    asUser()
    stubStore({}, { hold: true })
    const mode = await load()
    void mode.hydrateAccelMode()
    // `hydrated: false` is what holds the first submit of a panel the mode can
    // change — without it that panel fires a stored read and then re-fires live.
    expect(mode.dataMode()).toBe('snapshot')
    expect(mode.accelModeHydrated()).toBe(false)
  })

  it('hydrates Live from a choice made earlier today', async () => {
    asUser()
    stubStore({ 'accel/prefs/u-42': { liveReads: true, liveReadsUntil: Date.now() + HOUR } })
    const mode = await load()
    await mode.hydrateAccelMode()
    expect(mode.dataMode()).toBe('live')
    expect(mode.accelModeHydrated()).toBe(true)
  })

  it('reads an expired choice as Snapshot and repairs nothing', async () => {
    // A write on load is forbidden outright (CLAUDE.md), and the next press
    // rewrites the document anyway. Counting PUTs is the only way to assert it:
    // the return value is the same either way.
    asUser()
    const { calls } = stubStore({ 'accel/prefs/u-42': { liveReads: true, liveReadsUntil: Date.now() - HOUR } })
    const mode = await load()
    await mode.hydrateAccelMode()
    expect(mode.dataMode()).toBe('snapshot')
    expect(puts(calls)).toEqual([])
  })

  it('reads `liveReads` with no expiry as expired', async () => {
    // Hand-written, or from the release that shipped the field with no writer.
    // That IS the forgotten-forever case, so it is the one the expiry must cap.
    const mode = await load()
    expect(mode.accelModeFromPrefs({ liveReads: true }, Date.now())).toBe('snapshot')
    expect(mode.accelModeFromPrefs({ liveReads: true, liveReadsUntil: Number.NaN }, Date.now())).toBe('snapshot')
    expect(mode.accelModeFromPrefs({ liveReads: true, liveReadsUntil: 'tonight' as unknown as number }, Date.now())).toBe(
      'snapshot',
    )
  })

  it('reads every kind of nothing as Snapshot', async () => {
    const mode = await load()
    const now = Date.now()
    expect(mode.accelModeFromPrefs({}, now)).toBe('snapshot')
    expect(mode.accelModeFromPrefs({ liveReads: false, liveReadsUntil: now + HOUR }, now)).toBe('snapshot')
  })

  it('reads the store once however many panels ask', async () => {
    asUser()
    const { calls } = stubStore()
    const mode = await load()
    await Promise.all([mode.hydrateAccelMode(), mode.hydrateAccelMode(), mode.hydrateAccelMode()])
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  it('gives up on a store that never answers, so the held panels still run', async () => {
    // Holding the first submit is what kills the double submit; a hold with no
    // floor is a tile that stays blank for as long as the store stays silent.
    vi.useFakeTimers()
    asUser()
    const { release } = stubStore({ 'accel/prefs/u-42': { liveReads: true, liveReadsUntil: Date.now() + HOUR } }, { hold: true })
    const mode = await load()
    void mode.hydrateAccelMode()
    await vi.advanceTimersByTimeAsync(mode.HYDRATE_DEADLINE_MS - 1)
    expect(mode.accelModeHydrated()).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    // Released on the DEFAULT, not on a mode: a store that has not answered says
    // nothing about this viewer, and asserting Live here would be inventing it.
    expect(mode.accelModeHydrated()).toBe(true)
    expect(mode.dataMode()).toBe('snapshot')
    // The late answer still lands, and the panel re-submits once — the old
    // behaviour, now confined to a store that stopped answering.
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(mode.dataMode()).toBe('live')
  })

  it('does not put back a choice the viewer made while it was reading', async () => {
    // THE REGRESSION THIS GUARD EXISTS FOR. The read is started by the first
    // subscriber and can land at any time after it — comfortably after somebody
    // has pressed a segment on a slow store. Without the guard the late answer
    // silently reverts them: a control that works, and then un-works.
    asUser()
    const { release } = stubStore({ 'accel/prefs/u-42': { liveReads: true, liveReadsUntil: Date.now() + HOUR } }, { hold: true })
    const mode = await load()
    void mode.hydrateAccelMode()
    mode.setDataMode('snapshot')
    expect(mode.dataMode()).toBe('snapshot')
    release()
    await vi.waitFor(() => expect(mode.accelModeHydrated()).toBe(true))
    expect(mode.dataMode(), 'the late read put back a choice the viewer had already made').toBe('snapshot')
  })
})

describe('the next local midnight', () => {
  it('is midnight, and is within a day', async () => {
    const mode = await load()
    for (const at of [Date.now(), Date.parse('2026-12-31T23:59:59'), Date.parse('2026-03-01T00:00:00')]) {
      const until = mode.nextLocalMidnight(at)
      const d = new Date(until)
      expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0])
      expect(until).toBeGreaterThan(at)
      expect(until - at).toBeLessThanOrEqual(24 * HOUR)
    }
  })
})

describe('pressing a segment', () => {
  it('stores Live and its expiry in ONE document write', async () => {
    // Two writes would leave an interval holding `liveReads: true` with no
    // expiry — the forgotten-forever state this cap exists to prevent, written
    // by the mechanism meant to prevent it.
    asUser()
    const { calls } = stubStore()
    const mode = await load()
    expect(await mode.writeAccelMode('live')).toBe(true)
    expect(puts(calls)).toHaveLength(1)
    const doc = writtenPrefs(calls)
    expect(doc?.liveReads).toBe(true)
    expect(new Date(doc?.liveReadsUntil as number).getHours()).toBe(0)
    expect(doc?.liveReadsUntil as number).toBeGreaterThan(Date.now())
  })

  it('leaves no stale expiry behind when it goes back to Snapshot', async () => {
    asUser()
    const { calls } = stubStore({ 'accel/prefs/u-42': { liveReads: true, liveReadsUntil: Date.now() + HOUR } })
    const mode = await load()
    await mode.writeAccelMode('snapshot')
    const doc = writtenPrefs(calls)
    expect(doc).toEqual({ liveReads: false })
    expect('liveReadsUntil' in (doc ?? {})).toBe(false)
  })

  it('keeps a field written by a later release', async () => {
    asUser()
    const { calls } = stubStore({ 'accel/prefs/u-42': { fromALaterRelease: 'keep me' } })
    const mode = await load()
    await mode.writeAccelMode('live')
    expect(writtenPrefs(calls)?.fromALaterRelease).toBe('keep me')
  })

  it('says the choice is not remembered when the platform names nobody', async () => {
    // The localhost dev page, and an older platform build. There is no id to key
    // a document on, so no navigation will bring the choice back — the control
    // must say so rather than showing it as saved.
    const { calls } = stubStore()
    const mode = await load()
    expect(await mode.writeAccelMode('live')).toBe(false)
    expect(puts(calls)).toEqual([])
    // Still switched, for this page: the control works, it just cannot promise
    // the choice survives a navigation. cribl/dataMode.ts turns the false into
    // `save: 'refused'`, which is what the header renders.
    mode.setDataMode('live')
    expect(mode.dataMode()).toBe('live')
    await vi.waitFor(() => expect(mode.dataModeSave()).toBe('refused'))
  })

  it('says the choice is not remembered when the store refused', async () => {
    asUser()
    stubStore({}, { refuse: true })
    const mode = await load()
    expect(await mode.writeAccelMode('live')).toBe(false)
    await mode.hydrateAccelMode()
    mode.setDataMode('live')
    expect(mode.dataMode()).toBe('live')
    await vi.waitFor(() => expect(mode.dataModeSave()).toBe('refused'))
  })

  it('reports a stored choice as remembered again after a refused one', async () => {
    // `remembered` is a fact about the LAST press, not a latch. A viewer who
    // pressed while the store was down and pressed again when it came back must
    // not be left reading "this page only" about a choice that is stored.
    asUser()
    const { store } = stubStore()
    const mode = await load()
    await mode.hydrateAccelMode()
    mode.setDataMode('live')
    await vi.waitFor(() => expect(mode.dataModeSave()).toBe('saved'))
    expect([...store.keys()]).toEqual(['accel/prefs/u-42'])
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//  • That the app-scoped store exists where the app runs. It does not on the
//    localhost dev page — that proxy drops the `/a/{appId}/` scope, so every KV
//    call 404s and every press reports "this page only". Durability is visible
//    installed, or in the in-UI Live Preview.
//  • Anything about the control's markup, focus order or hit area. The segments
//    live in src/App.tsx and happy-dom implements neither sequential focus
//    navigation nor layout, so a test pressing Tab here would pass against an
//    empty document.
//  • That a page open across local midnight flips itself. It does not, by
//    decision: expiry is evaluated on READ, so it lands on the next load rather
//    than being yanked out from under a night-shift analyst mid-investigation.
