// The group's own Raw HTTP source for Gigamon AMX (./globalHttp.ts), against a
// fake Leader stubbed at `fetch`. What is held still:
//   * the bodies are packSpecs.ts's specs under this module's ids — the
//     source wired by QuickConnect (no route), on its own breaker;
//   * the create is in order, each object re-read first, and one already there
//     is never replaced; an unreadable one or a failed create stops the run,
//     and the source is never created without what it names;
//   * the token is only in the source's POST body, and scrubbed from errors;
//   * a source the person picked is connected by one whole-body PATCH that
//     ADDS the gigamon → gigamon_lake connection and puts the JSON-array
//     breaker first, keeping everything else; one on Send to Routes is refused;
//   * the onboarded source is whichever carries that connection.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GLOBAL_BREAKER_BODY, GLOBAL_HTTP_INPUT_ID, GLOBAL_PIPELINE_BODY, connectPlan, connectSource, createGlobalHttpStack, globalSourceBody,
  listRawHttpSources, previewConnect, readGlobalHttp,
} from './globalHttp'
import { GLOBAL_LAKE_DESTINATION_ID } from './globalHttpIds'
import { HTTP_BREAKER_SPEC, PIPELINE_SPEC } from './packSpecs'
import { LAKE_DESTINATION_ID } from './provision'

const G = 'default'
const TOKEN = 'ab'.repeat(32)
const NEW_TOKEN = 'cd'.repeat(32)
interface Call { method: string; path: string; body: unknown }
let calls: Call[] = []

function reply(status: number, value?: unknown) {
  const text = value === undefined ? '' : JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown } as unknown as Response
}

/** `have`: object path → body already there. `refuse`: a POST path → status. */
function leader(o: { have?: Record<string, Record<string, unknown>>; refuse?: Record<string, number>; unreadable?: string; inputs?: unknown[] } = {}) {
  calls = []
  const have = { ...(o.have ?? {}) }
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '').split('?')[0]
    const body = init.body == null ? undefined : JSON.parse(String(init.body))
    calls.push({ method, path, body })
    if (method === 'GET' && path === o.unreadable) return reply(500, { message: 'unavailable' })
    if (method === 'GET' && path === `/m/${G}/system/inputs`) return reply(200, { items: o.inputs ?? [] })
    if (method === 'GET' && path === `/m/${G}/packs`) return reply(200, { items: [] })
    if (method === 'GET') return have[path] ? reply(200, { items: [have[path]] }) : reply(404, { message: 'not found' })
    if (method === 'PATCH') {
      have[path] = body as Record<string, unknown>
      return reply(200, { items: [body] })
    }
    if (method === 'POST') {
      if (o.refuse?.[path]) return reply(o.refuse[path], { message: `refused ${JSON.stringify(body)}` })
      have[`${path}/${(body as { id: string }).id}`] = body as Record<string, unknown>
      return reply(200, { items: [body] })
    }
    return reply(599, { message: `no route for ${method} ${path}` })
  })
}

afterEach(() => vi.unstubAllGlobals())

const posts = () => calls.filter((c) => c.method === 'POST').map((c) => c.path)

describe('the bodies', () => {
  it('names the same Lake destination as provision.ts', () => {
    expect(GLOBAL_LAKE_DESTINATION_ID).toBe(LAKE_DESTINATION_ID)
  })

  it('breaker and pipeline are the specs under their own ids', () => {
    expect(GLOBAL_BREAKER_BODY).toEqual({ ...HTTP_BREAKER_SPEC, id: 'gigamon_ami_http_json_array' })
    expect(GLOBAL_PIPELINE_BODY).toEqual({ ...PIPELINE_SPEC, id: 'gigamon' })
  })

  it('the source: the port and token given, TLS for the hosting, started, on its breaker, wired by QuickConnect', () => {
    expect(globalSourceBody({ port: 20001, token: TOKEN, managed: true })).toMatchObject({
      id: GLOBAL_HTTP_INPUT_ID, type: 'http_raw', disabled: false, port: 20001, sendToRoutes: false,
      tls: { disabled: false, certPath: '$CRIBL_CLOUD_CRT' }, breakerRulesets: ['gigamon_ami_http_json_array'],
      connections: [{ pipeline: 'gigamon', output: 'gigamon_lake' }],
      authTokensExt: [{ token: TOKEN, authType: 'manual' }],
    })
    expect(globalSourceBody({ port: 10080, token: TOKEN, managed: false }).tls).toEqual({ disabled: true })
  })
})

describe('createGlobalHttpStack', () => {
  it('creates all four in order, the source last, and reads the source back', async () => {
    leader()
    const out = await createGlobalHttpStack(G, { port: 20001, token: TOKEN, managed: true })
    expect(out.map((s) => `${s.object}:${s.action}`)).toEqual(['breaker:created', 'pipeline:created', 'destination:created', 'source:created'])
    expect(posts()).toEqual([`/m/${G}/lib/breakers`, `/m/${G}/pipelines`, `/m/${G}/system/outputs`, `/m/${G}/system/inputs`])
    const carrying = calls.filter((c) => JSON.stringify(c.body ?? '').includes(TOKEN))
    expect(carrying.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /m/${G}/system/inputs`])
    expect(JSON.stringify(out)).not.toContain(TOKEN)
  })

  it('leaves what is there exactly as it is', async () => {
    leader({ have: { [`/m/${G}/system/outputs/gigamon_lake`]: { id: 'gigamon_lake', type: 'cribl_lake' } } })
    const out = await createGlobalHttpStack(G, { port: 20001, token: TOKEN, managed: true })
    expect(out.find((s) => s.object === 'destination')?.action).toBe('exists')
    expect(posts()).not.toContain(`/m/${G}/system/outputs`)
  })

  it('a failed create stops the run: no source without its pipeline, and the token is scrubbed', async () => {
    leader({ refuse: { [`/m/${G}/pipelines`]: 500 } })
    const out = await createGlobalHttpStack(G, { port: 20001, token: TOKEN, managed: true })
    expect(out.at(-1)).toMatchObject({ object: 'pipeline', action: 'error' })
    expect(posts()).not.toContain(`/m/${G}/system/inputs`)
  })

  it('an object it cannot read is never created over', async () => {
    leader({ unreadable: `/m/${G}/lib/breakers/gigamon_ami_http_json_array` })
    const out = await createGlobalHttpStack(G, { port: 20001, token: TOKEN, managed: true })
    expect(out).toEqual([{ object: 'breaker', id: 'gigamon_ami_http_json_array', action: 'error', detail: expect.stringMatching(/could not tell/) }])
    expect(posts()).toEqual([])
  })

  it('a port another source holds: the source is not created', async () => {
    leader({ inputs: [{ id: 'someone_else', type: 'http', port: 20001 }] })
    const out = await createGlobalHttpStack(G, { port: 20001, token: TOKEN, managed: true })
    expect(out.at(-1)).toMatchObject({ object: 'source', action: 'error', detail: expect.stringMatching(/port 20001/) })
    expect(posts()).not.toContain(`/m/${G}/system/inputs`)
  })
})

describe('readGlobalHttp', () => {
  it('the onboarded source is the one that carries the connection, whatever its id; never its token', async () => {
    const theirs = { id: 'gigamonraw', type: 'http_raw', port: 20003, sendToRoutes: false, authTokensExt: [{ token: TOKEN }], connections: [{ output: 'their_dest' }] }
    const ours = { ...globalSourceBody({ port: 20001, token: TOKEN, managed: true }), id: 'amx_feed' }
    leader({ inputs: [theirs, ours, { id: 'in_syslog', type: 'syslog', port: 514 }] })
    const st = await readGlobalHttp(G)
    expect(st.objects).toEqual({ breaker: 'absent', pipeline: 'absent', destination: 'absent', source: 'present' })
    expect(st.sourceId).toBe('amx_feed')
    expect(st.http).toMatchObject({ port: 20001, tokenSet: true, tls: true, disabled: false })
    expect(st.sources?.map((x) => x.id)).toEqual(['gigamonraw', 'amx_feed'])
    expect(JSON.stringify(st)).not.toContain(TOKEN)
  })

  it('none connected: the source reads absent', async () => {
    leader({ inputs: [{ id: 'gigamonraw', type: 'http_raw', sendToRoutes: false }] })
    const st = await readGlobalHttp(G)
    expect(st.objects.source).toBe('absent')
    expect(st.sourceId).toBeNull()
  })
})

describe('the chooser’s list', () => {
  it('lists Raw HTTP sources only, each with why it cannot be picked', async () => {
    leader({
      inputs: [
        { id: 'qc', type: 'http_raw', port: 20003, sendToRoutes: false, connections: [{ pipeline: 'p', output: 'other' }] },
        { id: 'routed', type: 'http_raw', port: 20004 },
        { id: 'in_syslog', type: 'syslog', port: 514 },
      ],
    })
    const list = await listRawHttpSources(G)
    expect(list?.map((x) => [x.id, x.refusal === null, x.outputs])).toEqual([['qc', true, ['other']], ['routed', false, []]])
    expect(list?.[1].refusal).toMatch(/Send to Routes/)
  })
})

describe('connecting a picked source', () => {
  const live = {
    id: 'gigamonraw', type: 'http_raw', port: 20003, sendToRoutes: false, authTokensExt: [{ token: TOKEN }],
    breakerRulesets: ['gigamon'], connections: [{ pipeline: 'theirs', output: 'their_dest' }], criblSourceProvenance: { by: 'server' },
  }

  it('adds the connection beside the others and the breaker first, nothing else', () => {
    const plan = connectPlan(live)
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(plan.set).toEqual({
      connections: [{ pipeline: 'theirs', output: 'their_dest' }, { pipeline: 'gigamon', output: 'gigamon_lake' }],
      breakerRulesets: ['gigamon_ami_http_json_array', 'gigamon'],
    })
    expect(plan.diff.map((d) => d.key)).toEqual(['connections', 'breakerRulesets'])
    expect(JSON.stringify(plan.diff)).not.toContain(TOKEN)
  })

  it('replaces a connection already sending to gigamon_lake (an earlier build’s pipeline), so no record is written twice', () => {
    const earlier = { ...live, breakerRulesets: ['gigamon_ami_http_json_array'], connections: [{ pipeline: 'gigamon_ami_http_normalize', output: 'gigamon_lake' }, { output: 'their_dest' }] }
    const plan = connectPlan(earlier)
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(plan.set).toEqual({ connections: [{ output: 'their_dest' }, { pipeline: 'gigamon', output: 'gigamon_lake' }] })
  })

  it('refuses a source on Send to Routes, and changes nothing on one already connected', () => {
    expect(connectPlan({ ...live, sendToRoutes: true })).toMatchObject({ refuse: expect.stringMatching(/Send to Routes/) })
    const done = connectPlan({ ...live, connections: [{ pipeline: 'gigamon', output: 'gigamon_lake' }], breakerRulesets: ['gigamon_ami_http_json_array'] })
    expect(done).toEqual({ set: {}, diff: [], newToken: false })
  })

  it('sends one whole-body PATCH held to the shown diff; the token goes back untouched and nowhere else', async () => {
    const path = `/m/${G}/system/inputs/gigamonraw`
    leader({ have: { [path]: live } })
    const shown = await previewConnect(G, 'gigamonraw')
    if (!shown.ok) throw new Error(shown.why)
    const out = await connectSource(G, 'gigamonraw', shown.diff, NEW_TOKEN)
    expect(out.action).toBe('updated')
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.path).toBe(path)
    const { criblSourceProvenance: _owned, ...rest } = live
    expect(patch.body).toEqual({ ...rest, ...(connectPlan(live) as { set: object }).set })
  })

  it('an off source is switched on, keeping its token; one with no token gets the run’s new one', () => {
    const off = { ...live, disabled: true }
    const plan = connectPlan(off, { token: NEW_TOKEN, usedPorts: [] })
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(plan.set.disabled).toBe(false)
    expect(plan.set.authTokensExt).toBeUndefined()
    expect(plan.newToken).toBe(false)
    const bare = connectPlan({ ...off, authTokensExt: [] }, { token: NEW_TOKEN, usedPorts: [] })
    if ('refuse' in bare) throw new Error(bare.refuse)
    expect(bare.set.authTokensExt).toEqual([{ token: NEW_TOKEN, authType: 'manual' }])
    expect(bare.newToken).toBe(true)
    expect(JSON.stringify(bare.diff)).not.toContain(NEW_TOKEN)
    expect(bare.diff.find((d) => d.key === 'authTokensExt')?.after).toBe('a new token (not shown)')
  })

  it('an off source whose port another source holds — or whose ports cannot be read — is refused', () => {
    const off = { ...live, disabled: true }
    expect(connectPlan(off, { usedPorts: [20003] })).toMatchObject({ refuse: expect.stringMatching(/port 20003 is used by another source/) })
    expect(connectPlan(off, { usedPorts: null })).toMatchObject({ refuse: expect.stringMatching(/could not read the ports/) })
  })

  it('a running source is not touched beyond the connection and the breaker', () => {
    const plan = connectPlan({ ...live, disabled: false }, { usedPorts: [20003] })
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(Object.keys(plan.set).sort()).toEqual(['breakerRulesets', 'connections'])
  })

  it('a source that moved after the confirmation is not written', async () => {
    const path = `/m/${G}/system/inputs/gigamonraw`
    leader({ have: { [path]: live } })
    const shown = await previewConnect(G, 'gigamonraw')
    if (!shown.ok) throw new Error(shown.why)
    leader({ have: { [path]: { ...live, breakerRulesets: ['something_else'] } } })
    const out = await connectSource(G, 'gigamonraw', shown.diff, NEW_TOKEN)
    expect(out.action).toBe('error')
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })
})
