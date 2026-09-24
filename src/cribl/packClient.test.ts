// The onboarding pack client, against a fake Leader.
//
// Stubbed at `fetch`, as provision.test.ts is, so what is asserted is the
// request a Leader would receive: the method, the path and the exact body.
// Four things are pinned here because each is expensive to get wrong:
//
//   THE RELEASE GATE. Today no 0.2.0 release exists, so install and upgrade must
//   refuse without sending a single request. The same functions with the
//   release recorded (`withRelease`, which swaps pack.ts's two constants) must
//   install from the pinned URL with custom functions refused, and read the
//   version and a known object back.
//
//   OWNERSHIP ON REMOVE. A DELETE goes out only for this pack id at a version
//   this app published; anything else is kept, and an unreadable pack list is
//   "kept", never "not installed".
//
//   WHOLE-BODY PATCHES OF A PACK SOURCE. The endpoint deletes what a PATCH
//   omits, so the body must be the live source with only the named keys
//   changed — a customer's `pq` or `description` survives.
//
//   THE TOKEN. It reaches the PATCH body and nothing else: not a step, not a
//   refusal, not an error Cribl echoes back, not the state read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PACK_HTTP_INPUT_ID, PACK_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID, PACK_URL, PACK_VERSION,
} from './pack'

type Client = typeof import('./packClient')

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

interface Leader {
  /** Installed packs as `/packs` lists them. */
  packs?: Array<{ id: string; version?: string }>
  packsStatus?: number
  /** What `/packs` lists after a POST or PATCH of our pack. */
  packsAfterWrite?: Array<{ id: string; version?: string }>
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
      return reply(200, { items: [{ commit: HASH }] })
    }
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(200, { items: [] })
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

/** The client with pack.ts as it is today (no 0.2.0 release). */
async function today(): Promise<Client> {
  vi.resetModules()
  vi.doUnmock('./pack')
  return import('./packClient')
}

/** The client with 0.2.0's release recorded: pack.ts's two constants swapped,
 *  nothing else. */
async function withRelease(): Promise<Client> {
  vi.resetModules()
  vi.doMock('./pack', async (orig) => ({ ...(await orig<typeof import('./pack')>()), PACK_PUBLISHED: true, PACK_SHA256: 'ab'.repeat(32) }))
  return import('./packClient')
}

beforeEach(() => { calls = [] })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('./pack')
})

describe('packPath', () => {
  it('addresses this pack inside the group — the reading policyCoverage.test.ts resolves a call site to', async () => {
    const c = await today()
    expect(c.packPath('g1', '/system/inputs/x')).toBe(`/m/g1/p/${PACK_ID}/system/inputs/x`)
  })
})

describe('the release gate', () => {
  it('counts only 0.1.0 as published while 0.2.0 has no release', async () => {
    const c = await today()
    expect(c.PUBLISHED_PACK_VERSIONS).toEqual(['0.1.0'])
    expect(c.installRefusal()).toMatch(/has not been released/)
  })

  it('refuses to install today, and sends nothing at all', async () => {
    const c = await today()
    leader()
    const steps = await c.installPack(GROUP)
    expect(steps).toEqual([{ key: 'pack', action: 'skipped', detail: expect.stringMatching(/not been released/) }])
    expect(calls).toEqual([])
  })

  it('refuses to upgrade today, and sends nothing at all', async () => {
    const c = await today()
    leader({ packs: [{ id: PACK_ID, version: '0.1.0' }] })
    expect((await c.upgradePack(GROUP))[0].action).toBe('skipped')
    expect(calls).toEqual([])
  })

  it('with the release recorded, installs from the pinned URL with custom functions refused, and reads it back', async () => {
    const c = await withRelease()
    expect(c.installRefusal()).toBeNull()
    expect(c.PUBLISHED_PACK_VERSIONS).toEqual(['0.1.0', PACK_VERSION])
    leader({ packsAfterWrite: [{ id: PACK_ID, version: PACK_VERSION }], packInputs: [liveHttp(), liveSample()] })
    const steps = await c.installPack(GROUP)
    expect(sent('POST', PACKS)?.body).toEqual({ id: PACK_ID, source: PACK_URL, allowCustomFunctions: false })
    expect(steps.map((s) => [s.key, s.action])).toEqual([['pack', 'created'], ['verify', 'exists']])
    expect(sent('GET', HTTP_INPUT)).toBeDefined()
  })

  it('refuses the release gate on the sha256 alone, too', async () => {
    vi.resetModules()
    vi.doMock('./pack', async (orig) => ({ ...(await orig<typeof import('./pack')>()), PACK_PUBLISHED: true, PACK_SHA256: null }))
    const c: Client = await import('./packClient')
    leader()
    expect((await c.installPack(GROUP))[0]).toMatchObject({ action: 'skipped', detail: expect.stringMatching(/sha256/) })
    expect(calls).toEqual([])
  })

  it('reports an install whose read-back shows another version as failed', async () => {
    const c = await withRelease()
    leader({ packsAfterWrite: [{ id: PACK_ID, version: '0.1.0' }], packInputs: [liveHttp()] })
    const steps = await c.installPack(GROUP)
    expect(steps[1]).toMatchObject({ key: 'verify', action: 'error', detail: expect.stringMatching(/0\.1\.0, not 0\.2\.0/) })
  })

  it('reports an install whose known object is missing as failed', async () => {
    const c = await withRelease()
    leader({ packsAfterWrite: [{ id: PACK_ID, version: PACK_VERSION }], packInputs: [] })
    expect((await c.installPack(GROUP))[1]).toMatchObject({ key: 'verify', action: 'error' })
  })

  it('will not install over an installed copy', async () => {
    const c = await withRelease()
    leader({ packs: [{ id: PACK_ID, version: '0.1.0' }] })
    expect((await c.installPack(GROUP))[0]).toMatchObject({ action: 'error', detail: expect.stringMatching(/upgrade it instead/) })
    expect(writes()).toEqual([])
  })

  it('upgrades a published 0.1.0 in place, and leaves an unpublished or current version alone', async () => {
    const c = await withRelease()
    leader({ packs: [{ id: PACK_ID, version: '0.1.0' }], packsAfterWrite: [{ id: PACK_ID, version: PACK_VERSION }], packInputs: [liveHttp()] })
    const steps = await c.upgradePack(GROUP)
    expect(sent('PATCH', PACK)?.body).toEqual({ source: PACK_URL, allowCustomFunctions: false })
    expect(steps.map((s) => s.action)).toEqual(['updated', 'exists'])

    leader({ packs: [{ id: PACK_ID, version: '0.1.5' }] })
    expect((await c.upgradePack(GROUP))[0]).toMatchObject({ action: 'error', detail: expect.stringMatching(/did not publish/) })
    expect(writes()).toEqual([])

    leader({ packs: [{ id: PACK_ID, version: PACK_VERSION }] })
    expect((await c.upgradePack(GROUP))[0].action).toBe('exists')
    expect(writes()).toEqual([])
  })
})

describe('removePack', () => {
  it('deletes a copy this app published, by its own id', async () => {
    const c = await today()
    leader({ packs: [{ id: 'other-pack', version: '1.0.0' }, { id: PACK_ID, version: '0.1.0' }] })
    expect(await c.removePack(GROUP)).toEqual({ key: 'pack', action: 'updated', detail: 'deleted' })
    expect(writes()).toEqual([{ method: 'DELETE', path: PACK, body: undefined }])
  })

  it('keeps a version this app did not publish — including 0.2.0 before its release', async () => {
    const c = await today()
    for (const version of ['0.2.0', '9.9.9', undefined]) {
      leader({ packs: [{ id: PACK_ID, version }] })
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

  it('with 0.2.0 released, removes 0.2.0 too', async () => {
    const c = await withRelease()
    leader({ packs: [{ id: PACK_ID, version: PACK_VERSION }] })
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
      packs: [{ id: PACK_ID, version: '0.1.0' }],
      packInputs: [liveHttp({ disabled: false, port: '20003', authTokensExt: [{ token: TOKEN, authType: 'manual' }] }), liveSample()],
    })
    const s = await c.readPackState(GROUP)
    expect(s).toMatchObject({ installed: true, version: '0.1.0', published: true, current: false })
    expect(s.http).toEqual({ disabled: false, port: 20003, tokenSet: true, tls: true })
    expect(s.sample).toEqual({ disabled: true })
    expect(s.objects.inputs).toEqual({ [PACK_HTTP_INPUT_ID]: 'present', [PACK_SAMPLE_INPUT_ID]: 'present' })
    expect(s.objects.routes).toEqual({ gigamon_ami_http_to_json: 'present', gigamon_ami_http_to_parquet: 'absent', gigamon_ami_sample: 'present' })
    expect(s.objects.outputs).toEqual({ gigamon_ami_json_lake: 'present', gigamon_ami_parquet_lake: 'present', gigamon_ami_sample_lake: 'present' })
    expect(s.objects.breakers).toEqual({ gigamon_ami_http_json_array: 'present' })
    expect(JSON.stringify(s)).not.toContain(TOKEN.slice(0, 12))
  })

  it('reads a list it could not fetch as unreadable, not absent', async () => {
    const c = await today()
    leader({ packs: [{ id: PACK_ID, version: '0.1.0' }], packInputsStatus: 500, objectsStatus: 403 })
    const s = await c.readPackState(GROUP)
    expect(Object.values(s.objects).flatMap((o) => Object.values(o))).toEqual(Array(10).fill('unreadable'))
    expect(s.http).toBeNull()
  })
})

describe('the pack Raw HTTP source', () => {
  const others = { inputs: [{ id: 'in_other', type: 'http', port: 20000 }] }

  it('configures it in ONE whole-body PATCH: live fields kept, server-owned dropped, port/token/TLS/enabled set', async () => {
    const c = await today()
    leader({ ...others, packInputs: [liveHttp()] })
    const step = await c.configureHttpInput(GROUP, { port: 20001, token: TOKEN, hosting: 'managed' })
    expect(step).toEqual({ key: 'http_input', action: 'updated', detail: 'authTokensExt, disabled, port, tls' })
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
      packs: [{ id: PACK_ID, version: '0.1.0' }, { id: 'other', version: '1.0.0' }],
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

  it('enables a source that has a token and a usable port, with TLS for the hosting', async () => {
    const c = await today()
    leader({ packInputs: [liveHttp({ authTokensExt: [{ token: TOKEN }] })] })
    expect((await c.enableHttpInput(GROUP, 'hybrid')).action).toBe('updated')
    expect(sent('PATCH', HTTP_INPUT)?.body).toMatchObject({ disabled: false, tls: { disabled: true } })
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

  it('commits exactly those files, then deploys that commit', async () => {
    const c = await today()
    leader({ pending })
    const steps = await c.commitAndDeployPack(GROUP, 'Gigamon AMI pack')
    expect(sent('POST', '/version/commit')?.body).toEqual({ message: 'Gigamon AMI pack', files: pending.slice(0, 2) })
    expect(steps.map((s) => [s.key, s.action])).toEqual([['commit', 'created'], ['deploy', 'created']])
  })

  it('does not deploy a commit that left one of the pack’s files behind', async () => {
    const c = await today()
    leader({ pending, pendingAfterCommit: [pending[0]] })
    const steps = await c.commitAndDeployPack(GROUP, 'm')
    expect(steps.map((s) => s.action)).toEqual(['error'])
    expect(sent('PATCH', `/products/stream/groups/${GROUP}/deploy`)).toBeUndefined()
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
