// The onboarding pack client, against a fake Leader.
//
// Stubbed at `fetch`, as provision.test.ts is, so what is asserted is the
// request a Leader would receive: the method, the path and the exact body.
// Four things are pinned here because each is expensive to get wrong:
//
//   THE RELEASE GATE. Today no 0.2.1 release exists, so install and upgrade must
//   refuse without sending a single request. The same functions with the
//   release recorded (`withRelease`, which swaps pack.ts's two constants) must
//   install from the pinned URL with custom functions refused, and read the
//   version and a known object back.
//
//   OWNERSHIP ON REMOVE AND UPGRADE. A DELETE or an upgrade goes out only for
//   this pack id at a version this app published AND installed from that
//   version's release (the pack list's `source`); anything else is kept, and an
//   unreadable pack list is "kept", never "not installed".
//
//   WHOLE-BODY PATCHES OF A PACK SOURCE. The endpoint deletes what a PATCH
//   omits, so the body must be the live source with only the named keys
//   changed — a customer's `pq` or `description` survives.
//
//   THE TOKEN. It reaches the PATCH body and nothing else: not a step, not a
//   refusal, not an error Cribl echoes back, not the state read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PACK_HTTP_INPUT_ID, PACK_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID, PACK_URL, PACK_VERSION, packReleaseUrl,
} from './pack'

// The client, with the in-place upgrade beside it (packUpgrade.ts, split out
// so its PATCH is not granted before a screen offers it).
type Client = typeof import('./packClient') & typeof import('./packUpgrade')
const loadClient = async (): Promise<Client> => ({ ...(await import('./packClient')), ...(await import('./packUpgrade')) })

const GROUP = 'default'
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OLD_TOKEN = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'
const HASH = 'dddd000011112222dddd000011112222dddd0000'

const PACKS = `/m/${GROUP}/packs`
const PACK = `/m/${GROUP}/packs/${PACK_ID}`
const P = `/m/${GROUP}/p/${PACK_ID}`
const HTTP_INPUT = `${P}/system/inputs/${PACK_HTTP_INPUT_ID}`
const SAMPLE_INPUT = `${P}/system/inputs/${PACK_SAMPLE_INPUT_ID}`

interface Call { method: string; path: string; body: unknown }

interface Listed { id: string; version?: string; source?: string }

/** This pack as the pack list reports a copy installed from this app's release of `version`. */
const ours = (version: string): Listed => ({ id: PACK_ID, version, source: packReleaseUrl(version) })

interface Leader {
  /** Installed packs as `/packs` lists them. */
  packs?: Listed[]
  packsStatus?: number
  /** What `/packs` lists after a POST or PATCH of our pack. */
  packsAfterWrite?: Listed[]
  /** The pack's sources, as `/p/<pack>/system/inputs` lists them and the item
   *  GETs return them. */
  packInputs?: Array<Record<string, unknown>>
  packInputsStatus?: number
  /** The group's own sources. */
  inputs?: Array<Record<string, unknown>>
  inputsStatus?: number
  /** Other installed packs' sources, by pack id (they must also appear in `packs`). */
  otherPackInputs?: Record<string, Array<Record<string, unknown>>>
  /** Status of the pack-object list reads. */
  objectsStatus?: number
  /** Status and body of the source PATCH. */
  patchStatus?: number
  patchBody?: (sent: Record<string, unknown>) => unknown
  /** Status of POST/PATCH/DELETE on the pack. */
  packWriteStatus?: number
  /** Lake datasets. */
  datasets?: string[]
  /** `/version/status` before and after the commit. */
  pending?: string[]
  pendingAfterCommit?: string[]
  /** `POST /version/commit` answers with no hash ("nothing to commit"). */
  commitNothing?: boolean
  /** The group's deployed configVersion, and the Leader's HEAD. */
  deployed?: string
  head?: string
  deployStatus?: number
}

let calls: Call[] = []

function leader(o: Leader = {}): void {
  calls = []
  let packs = o.packs ?? []
  let committed = false
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '')
    const body = init.body == null ? undefined : (JSON.parse(String(init.body)) as unknown)
    calls.push({ method, path, body })
    const bare = path.split('?')[0]
    const at = (m: string, p: string) => method === m && bare === p
    const reply = (status: number, value?: unknown) => {
      const text = value === undefined ? '' : JSON.stringify(value)
      return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text } as unknown as Response
    }
    const inputs = o.packInputs ?? []

    if (at('GET', PACKS)) return reply(o.packsStatus ?? 200, { items: packs, count: packs.length })
    if (at('POST', PACKS) || at('PATCH', PACK)) {
      const s = o.packWriteStatus ?? 200
      if (s === 200 && o.packsAfterWrite) packs = o.packsAfterWrite
      return reply(s, s === 200 ? { items: [{ id: PACK_ID }] } : { message: 'refused' })
    }
    if (at('DELETE', PACK)) return reply(o.packWriteStatus ?? 200, { items: [] })

    if (at('GET', `${P}/system/inputs`)) return reply(o.packInputsStatus ?? 200, { items: inputs })
    for (const id of [PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID]) {
      const item = `${P}/system/inputs/${id}`
      if (at('GET', item)) {
        const found = inputs.find((i) => i.id === id)
        return found ? reply(200, { items: [found] }) : reply(404, { message: 'not found' })
      }
      if (at('PATCH', item)) {
        const s = o.patchStatus ?? 200
        return reply(s, s === 200 ? { items: [body] } : (o.patchBody?.(body as Record<string, unknown>) ?? { message: 'refused' }))
      }
    }
    if (at('GET', `${P}/lib/breakers/gigamon_ami_http_json_array`)) return reply(o.objectsStatus ?? 200, { items: [{ id: 'gigamon_ami_http_json_array' }] })
    if (at('GET', `${P}/pipelines`)) return reply(o.objectsStatus ?? 200, { items: [{ id: 'gigamon_ami_normalize' }] })
    if (at('GET', `${P}/routes`)) {
      return reply(o.objectsStatus ?? 200, { items: [{ id: 'default', routes: [{ id: 'gigamon_ami_http_to_json' }, { id: 'gigamon_ami_sample' }] }] })
    }
    if (at('GET', `${P}/system/outputs`)) return reply(o.objectsStatus ?? 200, { items: [{ id: 'gigamon_ami_json_lake' }, { id: 'gigamon_ami_parquet_lake' }, { id: 'gigamon_ami_sample_lake' }] })

    if (at('GET', `/m/${GROUP}/system/inputs`)) return reply(o.inputsStatus ?? 200, { items: o.inputs ?? [] })
    for (const [pack, list] of Object.entries(o.otherPackInputs ?? {})) {
      if (at('GET', `/m/${GROUP}/p/${pack}/system/inputs`)) return reply(200, { items: list })
    }
    if (at('GET', '/products/lake/lakes/default/datasets')) return reply(200, { items: (o.datasets ?? []).map((id) => ({ id })) })

    if (at('GET', '/version/status')) {
      const files = committed ? (o.pendingAfterCommit ?? []) : (o.pending ?? [])
      return reply(200, { items: [{ files: files.map((p) => ({ path: p })) }] })
    }
    if (at('POST', '/version/commit')) {
      committed = true
      return reply(200, { items: [o.commitNothing ? {} : { commit: HASH }] })
    }
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(o.deployStatus ?? 200, { items: [] })
    if (at('GET', `/products/stream/groups/${GROUP}`) && o.deployed) return reply(200, { items: [{ id: GROUP, configVersion: o.deployed }] })
    if (at('GET', '/version') && o.head) return reply(200, { items: [{ hash: o.head, refs: 'HEAD -> main' }] })
    return reply(599, { message: `fake Leader has no route for ${method} ${path}` })
  })
}

const writes = () => calls.filter((c) => c.method !== 'GET')
const sent = (method: string, path: string) => calls.find((c) => c.method === method && c.path.split('?')[0] === path)

/** A live pack Raw HTTP source as a fresh install leaves it, plus customer
 *  fields a whole-body PATCH must carry forward. */
const liveHttp = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: PACK_HTTP_INPUT_ID,
  type: 'http_raw',
  disabled: true,
  host: '0.0.0.0',
  port: 20005,
  tls: { disabled: false, minVersion: 'TLSv1.2', certPath: '$CRIBL_CLOUD_CRT', privKeyPath: '$CRIBL_CLOUD_KEY' },
  sendToRoutes: true,
  breakerRulesets: ['gigamon_ami_http_json_array'],
  pq: { mode: 'always' },
  description: 'customer note',
  criblSourceProvenance: { by: 'pack' },
  ...extra,
})
const liveSample = (extra: Record<string, unknown> = {}) => ({ id: PACK_SAMPLE_INPUT_ID, type: 'datagen', disabled: true, samples: [], ...extra })

/** The client with pack.ts as it is today: 0.1.0, 0.2.0 and 0.2.1 released,
 *  and 0.2.1 pinned with its sha256 (since 2026-09-25). */
async function today(): Promise<Client> {
  vi.resetModules()
  vi.doUnmock('./pack')
  return loadClient()
}

/** The client with PACK_VERSION's release recorded: pack.ts's three release
 *  constants moved as a release moves them (the version appended), nothing else. */
async function withRelease(): Promise<Client> {
  vi.resetModules()
  vi.doMock('./pack', async (orig) => {
    // Appended to every version already published, as the flip appends it.
    // *(Until 2026-09-25, `feat/pack-022-parquet-pipeline`, this list was
    // written out as ['0.1.0', '0.2.0', PACK_VERSION], which dropped 0.2.1
    // once the pin moved past it.)*
    const real = await orig<typeof import('./pack')>()
    return {
      ...real,
      PACK_PUBLISHED: true, PACK_SHA256: 'ab'.repeat(32),
      PACK_PUBLISHED_VERSIONS: Object.freeze([...real.PACK_PUBLISHED_VERSIONS.filter((v) => v !== real.PACK_VERSION), real.PACK_VERSION]),
    }
  })
  return loadClient()
}

/**
 * The client in a build that pins a version before its release exists — THIS
 * build, which pins 0.2.2 before its release (as it pinned 0.2.1 until
 * 2026-09-25). The constants a release moves, moved back: not published, no
 * sha256, the pinned version off the list; today that changes nothing, and it
 * keeps these tests about an unreleased pin after the flip.
 */
async function unreleased(): Promise<Client> {
  vi.resetModules()
  vi.doMock('./pack', async (orig) => {
    const real = await orig<typeof import('./pack')>()
    return {
      ...real,
      PACK_PUBLISHED: false, PACK_SHA256: null,
      PACK_PUBLISHED_VERSIONS: Object.freeze(real.PACK_PUBLISHED_VERSIONS.filter((v) => v !== real.PACK_VERSION)),
    }
  })
  return loadClient()
}

/** The client with pack.ts's constants overridden. */
async function withPack(over: Record<string, unknown>): Promise<Client> {
  vi.resetModules()
  vi.doMock('./pack', async (orig) => ({ ...(await orig<typeof import('./pack')>()), ...over }))
  return loadClient()
}

beforeEach(() => { calls = [] })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('./pack')
  vi.doUnmock('./setupMemory')
})

describe('packPath', () => {
  it('addresses this pack inside the group — the reading policyCoverage.test.ts resolves a call site to', async () => {
    const c = await today()
    expect(c.packPath('g1', '/system/inputs/x')).toBe(`/m/g1/p/${PACK_ID}/system/inputs/x`)
  })
})

describe('the release gate', () => {
  it('counts 0.1.0, 0.2.0, 0.2.1 and 0.2.2 as published, and installs 0.2.2 today: it is released', async () => {
    const c = await today()
    expect(PACK_VERSION).toBe('0.2.2')
    expect(c.PUBLISHED_PACK_VERSIONS).toEqual(['0.1.0', '0.2.0', '0.2.1', '0.2.2'])
    expect(c.installRefusal()).toBeNull()
  })

  it('in a build whose pinned version has no release: counts only the earlier ones, and refuses', async () => {
    const c = await unreleased()
    expect(c.PUBLISHED_PACK_VERSIONS).toEqual(['0.1.0', '0.2.0', '0.2.1'])
    expect(c.installRefusal()).toMatch(/has not been released/)
  })

  it('once 0.2.2 is released, counts it after every earlier version and installs it', async () => {
    const c = await withRelease()
    expect(c.PUBLISHED_PACK_VERSIONS).toEqual(['0.1.0', '0.2.0', '0.2.1', '0.2.2'])
    expect(c.installRefusal()).toBeNull()
  })

  it('refuses to install in a build with no release, and sends nothing at all', async () => {
    const c = await unreleased()
    leader()
    const steps = await c.installPack(GROUP)
    expect(steps).toEqual([{ key: 'pack', action: 'skipped', detail: expect.stringMatching(/not been released/) }])
    expect(calls).toEqual([])
  })

  it('refuses to upgrade in a build with no release, and sends nothing at all', async () => {
    const c = await unreleased()
    leader({ packs: [ours('0.1.0')] })
    expect((await c.upgradePack(GROUP))[0].action).toBe('skipped')
    expect(calls).toEqual([])
  })

  it('with the release recorded, installs from the pinned URL with custom functions refused, and reads it back', async () => {
    const c = await withRelease()
    expect(c.installRefusal()).toBeNull()
    expect(c.PUBLISHED_PACK_VERSIONS).toEqual(['0.1.0', '0.2.0', '0.2.1', PACK_VERSION])
    leader({ packsAfterWrite: [ours(PACK_VERSION)], packInputs: [liveHttp(), liveSample()] })
    const steps = await c.installPack(GROUP)
    expect(sent('POST', PACKS)?.body).toEqual({ id: PACK_ID, source: PACK_URL, allowCustomFunctions: false })
    expect(steps.map((s) => [s.key, s.action])).toEqual([['pack', 'created'], ['verify', 'exists']])
    expect(sent('GET', HTTP_INPUT)).toBeDefined()
  })

  it('refuses the release gate on the sha256 alone, too', async () => {
    vi.resetModules()
    vi.doMock('./pack', async (orig) => ({ ...(await orig<typeof import('./pack')>()), PACK_PUBLISHED: true, PACK_SHA256: null }))
    const c: Client = await loadClient()
    leader()
    expect((await c.installPack(GROUP))[0]).toMatchObject({ action: 'skipped', detail: expect.stringMatching(/sha256/) })
    expect(calls).toEqual([])
  })

  it('reports an install whose read-back shows another version as failed', async () => {
    const c = await withRelease()
    leader({ packsAfterWrite: [ours('0.1.0')], packInputs: [liveHttp()] })
    const steps = await c.installPack(GROUP)
    expect(steps[1]).toMatchObject({ key: 'verify', action: 'error', detail: `${PACK_ID} reports version 0.1.0, not ${PACK_VERSION}` })
  })

  it('reports an install whose known object is missing as failed', async () => {
    const c = await withRelease()
    leader({ packsAfterWrite: [ours(PACK_VERSION)], packInputs: [] })
    expect((await c.installPack(GROUP))[1]).toMatchObject({ key: 'verify', action: 'error' })
  })

  it('will not install over an installed copy', async () => {
    const c = await withRelease()
    leader({ packs: [ours('0.1.0')] })
    expect((await c.installPack(GROUP))[0]).toMatchObject({ action: 'error', detail: expect.stringMatching(/upgrade it instead/) })
    expect(writes()).toEqual([])
  })

  it('upgrades a published 0.1.0 in place, and leaves an unpublished or current version alone', async () => {
    const c = await withRelease()
    leader({ packs: [ours('0.1.0')], packsAfterWrite: [ours(PACK_VERSION)], packInputs: [liveHttp()] })
    const steps = await c.upgradePack(GROUP)
    expect(sent('PATCH', PACK)?.body).toEqual({ source: PACK_URL, allowCustomFunctions: false })
    expect(steps.map((s) => s.action)).toEqual(['updated', 'exists'])

    leader({ packs: [ours('0.1.5')] })
    expect((await c.upgradePack(GROUP))[0]).toMatchObject({ action: 'error', detail: expect.stringMatching(/did not publish/) })
    expect(writes()).toEqual([])

    leader({ packs: [ours(PACK_VERSION)] })
    expect((await c.upgradePack(GROUP))[0].action).toBe('exists')
    expect(writes()).toEqual([])
  })

  it('upgrades a published 0.2.0, whose route filters never matched, in place', async () => {
    const c = await withRelease()
    leader({ packs: [ours('0.2.0')], packsAfterWrite: [ours(PACK_VERSION)], packInputs: [liveHttp()] })
    const steps = await c.upgradePack(GROUP)
    expect(sent('PATCH', PACK)?.body).toEqual({ source: PACK_URL, allowCustomFunctions: false })
    expect(steps.map((s) => s.action)).toEqual(['updated', 'exists'])
  })

  it('upgrades a published 0.2.1 in place to 0.2.2, once 0.2.2 is released', async () => {
    const c = await withRelease()
    expect(PACK_VERSION).toBe('0.2.2')
    leader({ packs: [ours('0.2.1')], packsAfterWrite: [ours(PACK_VERSION)], packInputs: [liveHttp()] })
    const steps = await c.upgradePack(GROUP)
    expect(sent('PATCH', PACK)?.body).toEqual({ source: packReleaseUrl('0.2.2'), allowCustomFunctions: false })
    expect(steps.map((s) => s.action)).toEqual(['updated', 'exists'])
  })

  it('upgrades an installed 0.2.1 to 0.2.2 in this build, which records 0.2.2 as released', async () => {
    const c = await today()
    leader({ packs: [ours('0.2.1')], packsAfterWrite: [ours(PACK_VERSION)], packInputs: [liveHttp()] })
    const steps = await c.upgradePack(GROUP)
    expect(sent('PATCH', PACK)?.body).toEqual({ source: packReleaseUrl('0.2.2'), allowCustomFunctions: false })
    expect(steps.map((s) => s.action)).toEqual(['updated', 'exists'])
  })
})

describe('removePack', () => {
  it('deletes an installed 0.2.1 in this build, while 0.2.2 is not released: it is still this app’s', async () => {
    const c = await today()
    leader({ packs: [ours('0.2.1')] })
    expect(await c.removePack(GROUP)).toEqual({ key: 'pack', action: 'updated', detail: 'deleted' })
    expect(writes()).toEqual([{ method: 'DELETE', path: PACK, body: undefined }])
  })

  it('deletes a copy this app published, by its own id', async () => {
    const c = await today()
    leader({ packs: [{ id: 'other-pack', version: '1.0.0' }, ours('0.1.0')] })
    expect(await c.removePack(GROUP)).toEqual({ key: 'pack', action: 'updated', detail: 'deleted' })
    expect(writes()).toEqual([{ method: 'DELETE', path: PACK, body: undefined }])
  })

  it('keeps a version this app did not publish — including PACK_VERSION before its release', async () => {
    const c = await unreleased()
    for (const version of [PACK_VERSION, '9.9.9', undefined]) {
      leader({ packs: [{ id: PACK_ID, version, source: version ? packReleaseUrl(version) : undefined }] })
      expect(await c.removePack(GROUP)).toMatchObject({ action: 'error', detail: expect.stringMatching(/^kept/) })
      expect(writes()).toEqual([])
    }
  })

  it('says "not present" when it is not installed, and "kept" when the list cannot be read', async () => {
    const c = await today()
    leader({ packs: [{ id: 'other-pack', version: '0.1.0' }] })
    expect(await c.removePack(GROUP)).toEqual({ key: 'pack', action: 'exists', detail: 'not present' })
    leader({ packsStatus: 500 })
    expect(await c.removePack(GROUP)).toMatchObject({ action: 'error', detail: expect.stringMatching(/^kept/) })
    expect(writes()).toEqual([])
  })

  it('deletes an installed 0.2.0: released 2026-09-25, and installed from its own release', async () => {
    const c = await today()
    leader({ packs: [ours('0.2.0')] })
    expect(await c.removePack(GROUP)).toEqual({ key: 'pack', action: 'updated', detail: 'deleted' })
    expect(writes()).toEqual([{ method: 'DELETE', path: PACK, body: undefined }])
  })

  it('keeps a 0.2.0 that was not installed from 0.2.0\'s release: both ownership signals are needed', async () => {
    const c = await today()
    for (const source of [packReleaseUrl('0.1.0'), 'https://example.com/cc-network-gigamon-ami-0.2.0.crbl', undefined]) {
      leader({ packs: [{ id: PACK_ID, version: '0.2.0', source }] })
      expect(await c.removePack(GROUP)).toMatchObject({ action: 'error', detail: expect.stringMatching(/^kept/) })
      expect(writes()).toEqual([])
    }
  })

  it('with PACK_VERSION released, removes it too', async () => {
    const c = await withRelease()
    leader({ packs: [ours(PACK_VERSION)] })
    expect((await c.removePack(GROUP)).detail).toBe('deleted')
  })
})

describe('readPackState', () => {
  it('reads an unreadable pack list as an error, never as "not installed"', async () => {
    const c = await today()
    leader({ packsStatus: 403 })
    const s = await c.readPackState(GROUP)
    expect(s.error).toMatch(/could not be read/)
    expect(s.installed).toBe(false)
  })

  it('reads nothing inside the pack when it is not installed', async () => {
    const c = await today()
    leader()
    const s = await c.readPackState(GROUP)
    expect(s).toMatchObject({ error: null, installed: false, version: null })
    expect(calls.map((x) => x.path)).toEqual([PACKS])
  })

  it('reports version, objects and sources — whether a token is set, never the token', async () => {
    const c = await today()
    leader({
      packs: [ours('0.1.0')],
      packInputs: [liveHttp({ disabled: false, port: '20003', authTokensExt: [{ token: TOKEN, authType: 'manual' }] }), liveSample()],
    })
    const s = await c.readPackState(GROUP)
    expect(s).toMatchObject({ installed: true, version: '0.1.0', published: true, current: false })
    expect(s.http).toEqual({ disabled: false, port: 20003, tokenSet: true, tls: true, tlsCert: '$CRIBL_CLOUD_CRT $CRIBL_CLOUD_KEY' })
    expect(s.sample).toEqual({ disabled: true })
    expect(s.objects.inputs).toEqual({ [PACK_HTTP_INPUT_ID]: 'present', [PACK_SAMPLE_INPUT_ID]: 'present' })
    expect(s.objects.routes).toEqual({ gigamon_ami_http_to_json: 'present', gigamon_ami_http_to_parquet: 'absent', gigamon_ami_sample: 'present' })
    expect(s.objects.outputs).toEqual({ gigamon_ami_json_lake: 'present', gigamon_ami_parquet_lake: 'present', gigamon_ami_sample_lake: 'present' })
    expect(s.objects.breakers).toEqual({ gigamon_ami_http_json_array: 'present' })
    expect(JSON.stringify(s)).not.toContain(TOKEN.slice(0, 12))
    // The pack's own lists, by id, and its route table as read — what the
    // clean-up finds leftovers and a kept table in.
    expect(s.listed?.inputs).toEqual([PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID])
    expect(s.listed?.pipelines).toEqual(['gigamon_ami_normalize'])
    expect(s.listed?.outputs).toEqual(['gigamon_ami_json_lake', 'gigamon_ami_parquet_lake', 'gigamon_ami_sample_lake'])
    expect(s.listed?.routes).toMatchObject({ tables: 1, id: 'default', routes: [{ id: 'gigamon_ami_http_to_json' }, { id: 'gigamon_ami_sample' }] })
  })

  it('reads a list it could not fetch as unreadable, not absent', async () => {
    const c = await today()
    leader({ packs: [ours('0.1.0')], packInputsStatus: 500, objectsStatus: 403 })
    const s = await c.readPackState(GROUP)
    // Eleven since 0.2.2 added gigamon_ami_normalize_parquet.
    expect(Object.values(s.objects).flatMap((o) => Object.values(o))).toEqual(Array(11).fill('unreadable'))
    expect(s.http).toBeNull()
    // Never an empty list: "nothing is left over" is not what a refused read says.
    expect(s.listed).toEqual({ inputs: 'unreadable', pipelines: 'unreadable', outputs: 'unreadable', routes: 'unreadable' })
  })

  it('names no listing for a pack that is not installed', async () => {
    const c = await today()
    leader({ packs: [] })
    expect((await c.readPackState(GROUP)).listed).toBeNull()
  })
})

describe('the pack Raw HTTP source', () => {
  const others = { inputs: [{ id: 'in_other', type: 'http', port: 20000 }] }

  it('configures it in ONE whole-body PATCH: live fields kept, server-owned dropped, port/token/enabled set, TLS kept', async () => {
    const c = await today()
    leader({ ...others, packInputs: [liveHttp()] })
    const step = await c.configureHttpInput(GROUP, { port: 20001, token: TOKEN, hosting: 'managed' })
    // The detail names what CHANGED: a managed group's source already has the
    // pack's Cribl.Cloud TLS, which is sent back as it is.
    expect(step).toEqual({ key: 'http_input', action: 'updated', detail: 'authTokensExt, disabled, port' })
    expect(writes()).toHaveLength(1)
    const { criblSourceProvenance: _drop, ...kept } = liveHttp()
    expect(sent('PATCH', HTTP_INPUT)?.body).toEqual({
      ...kept,
      port: 20001,
      disabled: false,
      tls: { disabled: false, minVersion: 'TLSv1.2', certPath: '$CRIBL_CLOUD_CRT', privKeyPath: '$CRIBL_CLOUD_KEY' },
      authTokensExt: [{ token: TOKEN, authType: 'manual' }],
    })
    expect(JSON.stringify(step)).not.toContain(TOKEN.slice(0, 12))
  })

  it('turns TLS off on a hybrid group', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp()] })
    await c.configureHttpInput(GROUP, { port: 10080, token: TOKEN, hosting: 'hybrid' })
    expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ tls: { disabled: true } })
  })

  it('refuses, sending nothing, when hosting is unknown, the token is weak, or the port is not usable', async () => {
    const c = await today()
    leader({ ...others, packInputs: [liveHttp()] })
    const weak = 'abc123'
    const refusals = [
      await c.configureHttpInput(GROUP, { port: 20001, token: TOKEN, hosting: null }),
      await c.configureHttpInput(GROUP, { port: 20001, token: weak, hosting: 'managed' }),
      await c.configureHttpInput(GROUP, { port: 20000, token: TOKEN, hosting: 'managed' }), // taken
      await c.configureHttpInput(GROUP, { port: 20011, token: TOKEN, hosting: 'managed' }), // outside the Cloud range
      await c.configureHttpInput(GROUP, { port: 80, token: TOKEN, hosting: 'hybrid' }),
    ]
    for (const r of refusals) expect(r.action).toBe('error')
    expect(refusals[1].detail).not.toContain(weak)
    expect(writes()).toEqual([])
  })

  it('refuses a port it cannot check — the group’s sources could not be read', async () => {
    const c = await today()
    leader({ inputsStatus: 500, packInputs: [liveHttp()] })
    expect((await c.setSourcePort(GROUP, 20001, 'managed')).action).toBe('error')
    expect(writes()).toEqual([])
  })

  it('does not count the pack source’s own port as taken, but does count other packs’', async () => {
    const c = await today()
    leader({
      packs: [ours('0.1.0'), { id: 'other', version: '1.0.0' }],
      otherPackInputs: { other: [{ id: 'in_x', port: 20002 }] },
      packInputs: [liveHttp({ port: 20004 })],
    })
    expect((await c.setSourcePort(GROUP, 20002, 'managed')).action).toBe('error')
    expect((await c.setSourcePort(GROUP, 20004, 'managed'))).toEqual({ key: 'http_input', action: 'exists', detail: 'already set' })
    expect(writes()).toEqual([])
    expect((await c.setSourcePort(GROUP, 20003, 'managed')).action).toBe('updated')
    expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ port: 20003 })
  })

  it('scrubs the new token and the old one from an error Cribl echoes back', async () => {
    const c = await today()
    leader({
      packInputs: [liveHttp({ authTokensExt: [{ token: OLD_TOKEN, authType: 'manual' }] })],
      patchStatus: 400,
      patchBody: (b) => ({ status: 'bad', echo: JSON.stringify(b).repeat(3) }),
    })
    const step = await c.setHttpToken(GROUP, TOKEN)
    expect(step.action).toBe('error')
    for (const secret of [TOKEN, OLD_TOKEN]) {
      for (let i = 0; i + 12 <= secret.length; i += 4) expect(step.detail).not.toContain(secret.slice(i, i + 12))
    }
  })

  it('scrubs the live token from an error about a PATCH that did not touch it', async () => {
    // A port change sends the whole live source back, token included, so a
    // refusal that quotes its body quotes a token this call never named.
    const c = await today()
    leader({
      packInputs: [liveHttp({ authTokensExt: [{ token: OLD_TOKEN, authType: 'manual' }] })],
      patchStatus: 400,
      patchBody: (b) => ({ message: `rejected ${JSON.stringify(b)}` }),
    })
    const step = await c.setSourcePort(GROUP, 20003, 'managed')
    expect(step.action).toBe('error')
    expect(step.detail).toContain('<token>')
    for (let i = 0; i + 12 <= OLD_TOKEN.length; i += 4) expect(step.detail).not.toContain(OLD_TOKEN.slice(i, i + 12))
  })

  it('replaces only the token on a rotation', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp({ authTokensExt: [{ token: OLD_TOKEN, authType: 'manual' }] })] })
    await c.setHttpToken(GROUP, TOKEN)
    const { criblSourceProvenance: _drop, ...kept } = liveHttp()
    expect(sent('PATCH', HTTP_INPUT)?.body).toEqual({ ...kept, authTokensExt: [{ token: TOKEN, authType: 'manual' }] })
  })

  it('will not enable a source with no token, or on a port it cannot use', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp()] })
    expect(await c.enableHttpInput(GROUP, 'managed')).toMatchObject({ action: 'error', detail: expect.stringMatching(/no auth token/) })
    leader({ packInputs: [liveHttp({ port: 9999, authTokensExt: [{ token: TOKEN }] })] })
    expect(await c.enableHttpInput(GROUP, 'managed')).toMatchObject({ action: 'error', detail: expect.stringMatching(/port 9999/) })
    expect(writes()).toEqual([])
  })

  // A certificate somebody added after the install is theirs. Enabling (or
  // configuring again) must not put a hybrid group back on plaintext, or swap
  // a managed group's own certificate for Cribl.Cloud's.
  const CUSTOM_TLS = { disabled: false, minVersion: 'TLSv1.2', certPath: '/opt/cribl/certs/gigamon.crt', privKeyPath: '/opt/cribl/certs/gigamon.key' }

  it('enables by changing only `disabled` when the source already has its own TLS', async () => {
    const c = await today()
    for (const hosting of ['hybrid', 'managed'] as const) {
      leader({ packInputs: [liveHttp({ port: 20003, tls: CUSTOM_TLS, authTokensExt: [{ token: TOKEN }] })] })
      expect(await c.enableHttpInput(GROUP, hosting)).toEqual({ key: 'http_input', action: 'updated', detail: 'disabled' })
      expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ disabled: false, tls: CUSTOM_TLS })
    }
  })

  it('enables with TLS for the hosting only when the source has no TLS block', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp({ tls: undefined, authTokensExt: [{ token: TOKEN }] })] })
    await c.enableHttpInput(GROUP, 'hybrid')
    expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ disabled: false, tls: { disabled: true } })
    leader({ packInputs: [liveHttp({ tls: undefined, authTokensExt: [{ token: TOKEN }] })] })
    await c.enableHttpInput(GROUP, 'managed')
    expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ tls: { certPath: '$CRIBL_CLOUD_CRT' } })
  })

  it('on a hybrid group, replaces the pack’s shipped Cribl.Cloud certificate, which does not exist there', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp({ authTokensExt: [{ token: TOKEN }] })] })
    expect((await c.enableHttpInput(GROUP, 'hybrid')).action).toBe('updated')
    expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ disabled: false, tls: { disabled: true } })
  })

  it('configuring again keeps a certificate added since', async () => {
    const c = await today()
    for (const hosting of ['hybrid', 'managed'] as const) {
      leader({ packInputs: [liveHttp({ tls: CUSTOM_TLS })] })
      await c.configureHttpInput(GROUP, { port: hosting === 'managed' ? 20001 : 10080, token: TOKEN, hosting })
      expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ tls: CUSTOM_TLS })
    }
  })

  it('writes nothing when the pack source is not there, or its body cannot be read', async () => {
    const c = await today()
    leader({ packInputs: [] })
    expect(await c.setHttpToken(GROUP, TOKEN)).toMatchObject({ action: 'error', detail: expect.stringMatching(/is the pack installed/) })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ method: (init.method ?? 'GET').toUpperCase(), path: String(url).replace(/^\/capi/, ''), body: init.body })
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: 'no' }) }
    })
    expect(await c.setHttpToken(GROUP, TOKEN)).toMatchObject({ action: 'error', detail: expect.stringMatching(/replaces the whole object/) })
    expect(writes()).toEqual([])
  })
})

describe('the sample DataGen', () => {
  it('will not start before its own dataset exists', async () => {
    const c = await today()
    leader({ packInputs: [liveSample()], datasets: ['gigamon_ami'] })
    expect(await c.setSampleEnabled(GROUP, true)).toMatchObject({ action: 'error', detail: expect.stringMatching(PACK_SAMPLE_DATASET_ID) })
    expect(writes()).toEqual([])
  })

  it('starts by flipping only `disabled`, and stops without reading Lake', async () => {
    const c = await today()
    leader({ packInputs: [liveSample({ description: 'keep me' })], datasets: [PACK_SAMPLE_DATASET_ID] })
    expect((await c.setSampleEnabled(GROUP, true)).action).toBe('updated')
    expect(sent('PATCH', SAMPLE_INPUT)?.body).toEqual(liveSample({ description: 'keep me', disabled: false }))
    leader({ packInputs: [liveSample({ disabled: false })] })
    expect((await c.setSampleEnabled(GROUP, false)).action).toBe('updated')
    expect(calls.some((x) => x.path.startsWith('/products/lake'))).toBe(false)
  })
})

describe('committing the pack', () => {
  const pending = [
    `groups/${GROUP}/default/${PACK_ID}/local/inputs.yml`,
    `groups/${GROUP}/data/packs/${PACK_ID}/package.json`,
    `groups/${GROUP}/default/${PACK_ID}-fork/default/inputs.yml`,
    `groups/other/default/${PACK_ID}/local/inputs.yml`,
    `groups/${GROUP}/local/cribl/inputs.yml`,
  ]

  it('scopes to this pack’s directories in this group — not a sibling pack, another group, or the group’s own files', async () => {
    const c = await today()
    const scope = c.packCommitScope(GROUP, pending)
    expect(scope.alreadyDirty).toEqual(pending.slice(0, 2))
    expect(scope.elsewhere).toEqual(pending.slice(2))
    expect(scope.carries).toEqual([`groups/${GROUP}/default/${PACK_ID}`, `groups/${GROUP}/data/packs/${PACK_ID}`])
    expect(c.packCommitScope(GROUP, null).unknown).toBe(true)
  })

  const record = () => vi.fn(async (_hash: string, _message: string) => true)

  it('commits exactly those files, then deploys that commit', async () => {
    const c = await today()
    leader({ pending })
    const steps = await c.commitAndDeployPack(GROUP, 'Gigamon AMI pack', { wrote: true, record: record() })
    expect(sent('POST', '/version/commit')?.body).toEqual({ message: 'Gigamon AMI pack', files: pending.slice(0, 2) })
    expect(steps.map((s) => [s.key, s.action])).toEqual([['commit', 'created'], ['deploy', 'created']])
  })

  it('does not deploy a commit that left one of the pack’s files behind', async () => {
    const c = await today()
    leader({ pending, pendingAfterCommit: [pending[0]] })
    const steps = await c.commitAndDeployPack(GROUP, 'm', { wrote: true, record: record() })
    expect(steps.map((s) => s.action)).toEqual(['error'])
    expect(sent('PATCH', `/products/stream/groups/${GROUP}/deploy`)).toBeUndefined()
  })

  it('hands every pack commit’s hash to `record` — also when the deploy after it failed', async () => {
    // deployStrandedCommit deploys only a hash in commit memory. Unrecorded, a
    // pack commit whose deploy failed is "a commit this app did not make" on
    // every later run, and the app can never deploy it.
    const c = await today()
    leader({ pending, deployStatus: 500 })
    const rec = record()
    const steps = await c.commitAndDeployPack(GROUP, 'm', { wrote: true, record: rec })
    expect(steps.map((s) => [s.key, s.action])).toEqual([['commit', 'created'], ['deploy', 'error']])
    expect(rec).toHaveBeenCalledTimes(1)
    expect(rec).toHaveBeenCalledWith(HASH, 'm')
  })

  it('deploys that recorded commit on the next run, found under PACK_COMMIT_KEY', async () => {
    vi.resetModules()
    vi.doMock('./setupMemory', async (orig) => ({
      ...(await orig<typeof import('./setupMemory')>()),
      loadCommitMemory: async () => ({ [GROUP]: { onboarding_pack: { hash: HASH, message: 'm' } } }),
    }))
    const c: Client = await loadClient()
    expect(c.PACK_COMMIT_KEY).toBe('onboarding_pack')
    leader({ pending: [], commitNothing: true, deployed: 'cccc0000', head: HASH })
    const rec = record()
    const steps = await c.commitAndDeployPack(GROUP, 'm', { wrote: false, record: rec })
    expect(steps.map((s) => [s.key, s.action])).toEqual([['commit', 'exists'], ['deploy', 'created']])
    expect(sent('PATCH', `/products/stream/groups/${GROUP}/deploy`)?.body).toMatchObject({ version: HASH })
    expect(rec).not.toHaveBeenCalled()
  })

  it('after a pack write, finds none of the pack’s files pending: an error, not "up to date" — nothing committed or deployed', async () => {
    const c = await today()
    leader({ pending: [`groups/${GROUP}/local/cribl/inputs.yml`], deployed: 'cccc0000', head: HASH })
    const steps = await c.commitAndDeployPack(GROUP, 'm', { wrote: true, record: record() })
    expect(steps).toEqual([{ key: 'commit', action: 'error', detail: expect.stringMatching(/none of its files/) }])
    expect(writes()).toEqual([])
  })

  it('after a pack write, a commit that answers with no hash is an error, and nothing is deployed', async () => {
    const c = await today()
    leader({ pending: [], commitNothing: true, deployed: 'cccc0000', head: HASH })
    const steps = await c.commitAndDeployPack(GROUP, 'm', { wrote: true, record: record() })
    expect(steps.map((s) => [s.key, s.action])).toEqual([['commit', 'error']])
    expect(sent('PATCH', `/products/stream/groups/${GROUP}/deploy`)).toBeUndefined()
  })

  it('with nothing written, nothing to commit is still "no changes"', async () => {
    const c = await today()
    leader({ pending: [`groups/${GROUP}/local/cribl/inputs.yml`] })
    const steps = await c.commitAndDeployPack(GROUP, 'm', { wrote: false, record: record() })
    expect(steps).toEqual([{ key: 'commit', action: 'exists', detail: 'no changes to commit' }])
  })
})

describe('compareVersions', () => {
  it('compares dotted numbers numerically', async () => {
    const c = await today()
    expect(c.compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(c.compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(c.compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
  })
})

describe('the published-versions list', () => {
  it('is pack.ts’s hand-kept list, so moving PACK_VERSION on does not drop the release before it', async () => {
    const c = await withPack({ PACK_VERSION: '0.3.0', PACK_PUBLISHED: false, PACK_SHA256: null, PACK_PUBLISHED_VERSIONS: Object.freeze(['0.1.0', '0.2.0']) })
    expect(c.PUBLISHED_PACK_VERSIONS).toEqual(['0.1.0', '0.2.0'])
    leader({ packs: [ours('0.2.0')] })
    expect(await c.removePack(GROUP)).toEqual({ key: 'pack', action: 'updated', detail: 'deleted' })
  })
})

describe('ownership: the id, a published version, AND this app’s release as the install source', () => {
  const impostors: Listed[] = [
    { id: PACK_ID, version: '0.1.0', source: 'https://github.com/someone/fork/releases/download/gigamon-pack-v0.1.0/cc-network-gigamon-ami-0.1.0.crbl' },
    { id: PACK_ID, version: '0.1.0', source: 'cc-network-gigamon-ami-0.1.0.AbCdEfG.crbl' },
    { id: PACK_ID, version: '0.1.0' },
    { id: PACK_ID, version: '0.1.0', source: packReleaseUrl('0.2.0') },
  ]

  it('keeps a same-id copy at a published version that was not installed from that version’s release', async () => {
    const c = await today()
    for (const p of impostors) {
      leader({ packs: [p] })
      expect(await c.removePack(GROUP)).toMatchObject({ action: 'error', detail: expect.stringMatching(/^kept — .*release/) })
      expect(writes()).toEqual([])
    }
  })

  it('will not upgrade one either', async () => {
    const c = await withRelease()
    for (const p of impostors) {
      leader({ packs: [p] })
      expect((await c.upgradePack(GROUP))[0]).toMatchObject({ action: 'error', detail: expect.stringMatching(/^kept/) })
      expect(writes()).toEqual([])
    }
  })

  it('reports an install the pack list does not attribute to the release it was installed from', async () => {
    const c = await withRelease()
    leader({ packsAfterWrite: [{ id: PACK_ID, version: PACK_VERSION, source: 'somewhere-else.crbl' }], packInputs: [liveHttp()] })
    expect((await c.installPack(GROUP))[1]).toMatchObject({ key: 'verify', action: 'error', detail: expect.stringMatching(/source/) })
  })
})

describe('readPackState.current', () => {
  it('is false for an installed copy of this build’s version that was never released — a dev build is not "up to date"', async () => {
    const c = await unreleased()
    leader({ packs: [ours(PACK_VERSION)] })
    expect(await c.readPackState(GROUP)).toMatchObject({ installed: true, version: PACK_VERSION, published: false, current: false })
  })

  it('is true only for the released copy, installed from its release', async () => {
    const c = await withRelease()
    leader({ packs: [ours(PACK_VERSION)] })
    expect(await c.readPackState(GROUP)).toMatchObject({ published: true, fromRelease: true, current: true })
    leader({ packs: [{ id: PACK_ID, version: PACK_VERSION, source: 'fork.crbl' }] })
    expect(await c.readPackState(GROUP)).toMatchObject({ published: true, fromRelease: false, current: false })
  })
})

describe('the sha256 gate', () => {
  it('opens only on 64 lowercase hex characters', async () => {
    for (const sha of ['x', 'ab'.repeat(31), 'AB'.repeat(32), `${'ab'.repeat(32)} `]) {
      const c = await withPack({ PACK_PUBLISHED: true, PACK_SHA256: sha })
      expect(c.installRefusal(), sha).toMatch(/sha256/)
      leader()
      expect((await c.installPack(GROUP))[0].action).toBe('skipped')
      expect(calls).toEqual([])
    }
    const ok = await withPack({ PACK_PUBLISHED: true, PACK_SHA256: 'ab'.repeat(32) })
    expect(ok.installRefusal()).toBeNull()
  })
})

describe('previewing a change to a pack source before it is sent', () => {
  it('returns the before→after a confirmation shows, with GETs only, and never the token', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp({ authTokensExt: [{ token: OLD_TOKEN, authType: 'manual' }] })] })
    const preview = await c.previewPackInput(GROUP, { kind: 'configure', port: 10080, token: TOKEN, hosting: 'hybrid' })
    expect(writes()).toEqual([])
    if (!preview.ok) throw new Error(preview.step.detail)
    expect(preview.key).toBe('http_input')
    expect(Object.fromEntries(preview.diff.map((d) => [d.key, [d.kind, d.before, d.after]]))).toEqual({
      authTokensExt: ['changed', 'a token is set (not shown)', 'a new token (not shown)'],
      disabled: ['changed', true, false],
      port: ['changed', 20005, 10080],
      tls: ['changed', liveHttp().tls, { disabled: true }],
    })
    for (const secret of [TOKEN, OLD_TOKEN]) expect(JSON.stringify(preview)).not.toContain(secret.slice(0, 12))
  })

  it('previews "nothing changes" as an empty diff, and a refusal as the step the write would return', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp({ port: 20004 })] })
    expect(await c.previewPackInput(GROUP, { kind: 'port', port: 20004, hosting: 'managed' })).toEqual({ ok: true, key: 'http_input', diff: [] })
    const refused = await c.previewPackInput(GROUP, { kind: 'port', port: 20004, hosting: null })
    expect(refused).toMatchObject({ ok: false, step: { key: 'http_input', action: 'error' } })
    expect(writes()).toEqual([])
  })

  it('applies an approved diff, and refuses — sending nothing — when the source moved after it was shown', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp()] })
    const preview = await c.previewPackInput(GROUP, { kind: 'port', port: 20003, hosting: 'managed' })
    if (!preview.ok) throw new Error('refused')
    expect(await c.applyPackInput(GROUP, { kind: 'port', port: 20003, hosting: 'managed' }, preview.diff)).toMatchObject({ action: 'updated' })

    leader({ packInputs: [liveHttp({ port: 20007 })] })
    const moved = await c.applyPackInput(GROUP, { kind: 'port', port: 20003, hosting: 'managed' }, preview.diff)
    expect(moved).toMatchObject({ action: 'error', detail: expect.stringMatching(/changed after/) })
    expect(writes()).toEqual([])
  })
})
