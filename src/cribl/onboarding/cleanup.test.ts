// "Restore the pack's routes and remove leftovers": what an in-place upgrade
// leaves behind in the onboarding pack, found (pure) and put right (the run),
// against a fake Leader stubbed at `fetch`, so what is asserted is what a
// Leader would receive, in order.
//
// The fake behaves as the workspace Leader was measured to on 2026-09-26, on a
// scratch copy of the pack upgraded in place from 0.1.0 to 0.2.2 (pack.ts's
// header, M1–M6): the edited table survives whole; a leftover source deletes;
// a destination a route still names answers 409; a pipeline is never deleted
// (and a DELETE of one would be answered while nothing happened); the table is
// put back by a PATCH of the whole table.
//
// What is held still:
//   * detection is pure and reads only the pack's own lists: a tenant's own id
//     and a shipped id are never leftovers, an unreadable list is never empty,
//     and routes-only and objects-only cases are each found;
//   * the ids this app can delete are exactly the leftovers the published
//     versions' records give, and each is granted by its own exact path;
//   * the run: routes first, then sources, then destinations, then the commit;
//     a 409 or a "still present" read-back is a failure, the other deletes run
//     where they can, and NOTHING is committed or deployed after one;
//   * anything moved since the confirmation — a route's filter or pipeline
//     included, not only its id — or the pack's own manifest uncommitted:
//     nothing written; a table under another id, or no table: refused before
//     the dialog, nothing written;
//   * the confirmation shows every routing field the PATCH rewrites, so a kept
//     table with the shipped ids shows as changing;
//   * a clean-up whose deletes touched no file (stale Leader state, M2) is up
//     to date, not an error.
//
// These fixes and their tests were added 2026-09-26 on
// `feat/pack-leftovers-routes`, after review.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PACK_0_1_0, PACK_ID, PACK_OBJECTS, PACK_PIPELINE_ID, PACK_PUBLISHED_VERSIONS, PACK_ROUTES, PACK_URL, PACK_VERSION, routeFingerprint,
  routeTableMatches, type PackListing, type PackRouteTableRead,
} from '../pack'
import { DELETABLE_LEFTOVERS, LEFTOVERS_FROM_0_1_0, restorePackRoutes } from '../packCleanup'
import { API_CALLS } from '../paths'
import { cleanupBlockedBy, cleanupDialog, cleanupFindings, cleanupOffered, leftoverCandidates } from './plan'
import { prepareCleanup, runPackCleanup } from './run'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GROUP = 'default'
const HASH = 'dddd000011112222dddd000011112222dddd0000'
const P = `/m/${GROUP}/p/${PACK_ID}`

const shippedTable = (): PackRouteTableRead => ({ tables: 1, id: 'default', routes: structuredClone(PACK_ROUTES) as unknown as Record<string, unknown>[], raw: {} })
const table010 = (): PackRouteTableRead => ({
  tables: 1, id: 'default', raw: {},
  routes: [
    { id: 'gno_syslog', final: true, filter: "__inputId=='syslog:in_gno_syslog'", pipeline: 'gno_syslog', output: 'out_gno_lake' },
    { id: 'gno_sample', final: true, filter: "__inputId=='datagen:in_gno_sample'", pipeline: 'gno_sample', output: 'out_gno_sample_lake' },
  ],
})
/** 0.2.1's table as it shipped, kept through an upgrade to 0.2.2: the same
 *  three ids, but the Parquet route still runs gigamon_ami_normalize. */
const table021 = (): PackRouteTableRead => {
  const t = shippedTable()
  return { ...t, routes: t.routes.map((r, i) => (i === 1 ? { ...r, pipeline: PACK_PIPELINE_ID } : r)) }
}
const listing = (over: Partial<PackListing> = {}): PackListing => ({
  inputs: [...PACK_OBJECTS.inputs], pipelines: [...PACK_OBJECTS.pipelines], outputs: [...PACK_OBJECTS.outputs], routes: shippedTable(), ...over,
})
const current = (listed: PackListing | null) => ({ current: true, version: PACK_VERSION, listed })

// ── Detection (pure) ────────────────────────────────────────────────────────

describe('what counts as left over', () => {
  it('the candidates are exactly what an earlier published version shipped and this one does not', () => {
    const c = leftoverCandidates(PACK_VERSION)
    expect(c.filter((o) => o.kind === 'inputs').map((o) => o.id)).toEqual([PACK_0_1_0.inputs.syslog, PACK_0_1_0.inputs.sample])
    expect(c.filter((o) => o.kind === 'outputs').map((o) => o.id)).toEqual([PACK_0_1_0.outputs.lake, PACK_0_1_0.outputs.sample])
    expect(c.filter((o) => o.kind === 'pipelines').map((o) => o.id)).toEqual([PACK_0_1_0.pipelines.syslog, PACK_0_1_0.pipelines.sample])
    for (const o of c) expect(o.shippedBy, o.id).toEqual(['0.1.0'])
    // Nothing the installed version ships is ever a leftover.
    for (const o of c) expect((PACK_OBJECTS[o.kind] as readonly string[]).includes(o.id), o.id).toBe(false)
    // A version this app did not publish has nothing earlier to leave.
    expect(leftoverCandidates('9.9.9')).toEqual([])
    expect(leftoverCandidates(null)).toEqual([])
    expect(leftoverCandidates(PACK_PUBLISHED_VERSIONS[0])).toEqual([])
  })

  it('what this app can delete is exactly those sources and destinations — a release that drops another object fails here until its call and grant are added', () => {
    const c = leftoverCandidates(PACK_VERSION)
    expect([...DELETABLE_LEFTOVERS.inputs]).toEqual(c.filter((o) => o.kind === 'inputs').map((o) => o.id))
    expect([...DELETABLE_LEFTOVERS.outputs]).toEqual(c.filter((o) => o.kind === 'outputs').map((o) => o.id))
    expect({ inputs: [...DELETABLE_LEFTOVERS.inputs], outputs: [...DELETABLE_LEFTOVERS.outputs] }).toEqual(LEFTOVERS_FROM_0_1_0)
  })

  it('each deletable leftover has its own exact DELETE and GET grant, and no other pack object has a DELETE', () => {
    const policies = readFileSync(join(ROOT, 'config', 'policies.yml'), 'utf8')
    const pathOf = (kind: 'inputs' | 'outputs', id: string) => `/m/:gid/p/${PACK_ID}/system/${kind}/${id}`
    const expected = [
      ...DELETABLE_LEFTOVERS.inputs.map((id) => pathOf('inputs', id)),
      ...DELETABLE_LEFTOVERS.outputs.map((id) => pathOf('outputs', id)),
    ].sort()
    const deletes = API_CALLS.filter((c) => c.method === 'DELETE' && c.path.startsWith(`/m/:gid/p/${PACK_ID}/`)).map((c) => c.path).sort()
    expect(deletes).toEqual(expected)
    for (const path of expected) {
      expect(API_CALLS.some((c) => c.method === 'GET' && c.path === path), path).toBe(true)
      expect(policies).toContain(`- object: '${path}'\n    actions: ['GET', 'DELETE']`)
    }
    // No pipeline DELETE, ever: inside a pack it answers and removes nothing.
    expect(API_CALLS.some((c) => c.method === 'DELETE' && c.path.startsWith(`/m/:gid/p/${PACK_ID}/pipelines`))).toBe(false)
    // The route table: one exact PATCH, by the measured id.
    expect(API_CALLS.filter((c) => c.method === 'PATCH' && c.path.startsWith(`/m/:gid/p/${PACK_ID}/routes`)).map((c) => c.path))
      .toEqual([`/m/:gid/p/${PACK_ID}/routes/default`])
  })
})

describe('cleanupFindings', () => {
  it('nothing, on a current copy with the shipped routes and nothing left over', () => {
    const f = cleanupFindings(current(listing()))
    expect(f).toMatchObject({ routes: { state: 'matches' }, sources: [], destinations: [], pipelines: [], unreadable: [] })
    expect(cleanupOffered(f)).toBe(false)
  })

  it('ignores a tenant’s own objects and anything the installed version ships', () => {
    const f = cleanupFindings(current(listing({
      inputs: [...PACK_OBJECTS.inputs, 'my_own_input'],
      outputs: [...PACK_OBJECTS.outputs, 'my_s3_output'],
      pipelines: [...PACK_OBJECTS.pipelines, 'my_pipeline'],
    })))
    expect(f).toMatchObject({ sources: [], destinations: [], pipelines: [] })
    expect(cleanupOffered(f)).toBe(false)
  })

  it('routes only: a kept 0.1.0 table, with no leftover object listed', () => {
    const f = cleanupFindings(current(listing({ routes: table010() })))
    expect(f?.routes.state).toBe('differs')
    if (f?.routes.state === 'differs') expect(f.routes.rows.map((r) => r.id)).toEqual(['gno_syslog', 'gno_sample'])
    expect(f).toMatchObject({ sources: [], destinations: [] })
    expect(cleanupOffered(f)).toBe(true)
  })

  it('objects only: the shipped routes, and 0.1.0’s source and destinations still listed', () => {
    const f = cleanupFindings(current(listing({
      inputs: [...PACK_OBJECTS.inputs, 'in_gno_syslog'],
      outputs: [...PACK_OBJECTS.outputs, 'out_gno_lake', 'out_gno_sample_lake'],
    })))
    expect(f?.routes).toEqual({ state: 'matches' })
    expect(f?.sources.map((o) => o.id)).toEqual(['in_gno_syslog'])
    expect(f?.destinations.map((o) => o.id)).toEqual(['out_gno_lake', 'out_gno_sample_lake'])
    expect(cleanupOffered(f)).toBe(true)
  })

  it('leftover pipelines alone are not offered: nothing removes them', () => {
    const f = cleanupFindings(current(listing({ pipelines: [...PACK_OBJECTS.pipelines, 'gno_syslog', 'gno_sample'] })))
    expect(f?.pipelines.map((o) => o.id)).toEqual(['gno_syslog', 'gno_sample'])
    expect(cleanupOffered(f)).toBe(false)
  })

  it('an unreadable list is named, never read as empty; an unreadable table is never "matches"', () => {
    const f = cleanupFindings(current(listing({ inputs: 'unreadable', routes: 'unreadable', outputs: [...PACK_OBJECTS.outputs, 'out_gno_lake'] })))
    expect(f?.unreadable).toEqual(['inputs', 'routes'])
    expect(f?.routes).toEqual({ state: 'unreadable' })
    expect(f?.sources).toEqual([])
    expect(f?.destinations.map((o) => o.id)).toEqual(['out_gno_lake'])
  })

  it('an unreadable table alone: shown, with the reason it may not open — never hidden without a word', () => {
    const f = cleanupFindings(current(listing({ routes: 'unreadable' })))!
    expect(cleanupOffered(f)).toBe(true)
    expect(cleanupBlockedBy(f)).toContain('routes could not be read')
  })

  it('a kept 0.2.1 table — the shipped ids, the Parquet route on the old pipeline — differs, and may open', () => {
    const f = cleanupFindings(current(listing({ routes: table021() })))!
    expect(f.routes.state).toBe('differs')
    expect(cleanupOffered(f)).toBe(true)
    expect(cleanupBlockedBy(f)).toBeNull()
  })

  it('a table this app never writes — none, two, or another id — is unrestorable: shown with its reason, never openable', () => {
    const cases: Array<[PackRouteTableRead, string]> = [
      [{ tables: 0, id: null, routes: [], raw: null }, 'the pack answered no route table'],
      [{ ...table010(), tables: 2 }, 'the pack answered 2 route tables'],
      [{ ...table010(), id: 'main' }, 'the pack’s route table is “main”'],
    ]
    for (const [t, words] of cases) {
      const f = cleanupFindings(current(listing({ routes: t })))!
      expect(f.routes.state, words).toBe('unrestorable')
      expect(cleanupOffered(f), words).toBe(true)
      expect(cleanupBlockedBy(f), words).toContain(words)
      expect(cleanupBlockedBy(f), words).toContain('only ever writes the one table “default”')
    }
  })

  it('only for a current copy this app owns', () => {
    expect(cleanupFindings({ current: false, version: '0.1.0', listed: listing({ routes: table010() }) })).toBeNull()
    expect(cleanupFindings({ current: true, version: PACK_VERSION, listed: null })).toBeNull()
  })
})

describe('routeTableMatches', () => {
  it('the shipped table matches; a description or name edit does not move it; routing edits do', () => {
    expect(routeTableMatches(shippedTable())).toBe(true)
    const t = shippedTable()
    expect(routeTableMatches({ ...t, routes: t.routes.map((r) => ({ ...r, description: 'mine', name: 'x' })) })).toBe(true)
    expect(routeTableMatches({ ...t, routes: t.routes.map((r, i) => (i === 1 ? { ...r, pipeline: 'gigamon_ami_normalize' } : r)) })).toBe(false)
    expect(routeTableMatches({ ...t, routes: [t.routes[1], t.routes[0], t.routes[2]] })).toBe(false)
    expect(routeTableMatches({ ...t, routes: [...t.routes, { id: 'extra', filter: 'true', output: 'x' }] })).toBe(false)
    expect(routeTableMatches({ ...t, id: 'other' })).toBe(false)
    expect(routeTableMatches({ ...t, tables: 2 })).toBe(false)
    expect(routeTableMatches({ tables: 0, id: null, routes: [], raw: null })).toBe(false)
    expect(routeTableMatches(table010())).toBe(false)
  })

  it('each routing field, changed alone on one route, is a different table', () => {
    const t = shippedTable()
    const one = (i: number, over: Record<string, unknown>) => ({ ...t, routes: t.routes.map((r, j) => (j === i ? { ...r, ...over } : r)) })
    const edits: Array<[string, Record<string, unknown>]> = [
      ['filter', { filter: 'true' }],
      ['pipeline', { pipeline: 'passthru' }],
      ['output', { output: 'devnull' }],
      ['disabled', { disabled: true }],
      ['enableOutputExpression', { enableOutputExpression: true, outputExpression: "'x'" }],
      ['clones', { clones: [{ foo: 'bar' }] }],
      ['id', { id: 'renamed', name: 'renamed' }],
    ]
    for (const [field, over] of edits) {
      for (let i = 0; i < t.routes.length; i++) expect(routeTableMatches(one(i, over)), `${field} on route ${i}`).toBe(false)
    }
    for (let i = 0; i < t.routes.length; i++) {
      expect(routeTableMatches(one(i, { final: !PACK_ROUTES[i].final })), `final on route ${i}`).toBe(false)
    }
  })

  it('a Leader’s plausible echoes of the shipped rows still match: explicit defaults, an empty expression, clones of {} (unmeasured — see pack.ts)', () => {
    const t = shippedTable()
    const echoed = {
      ...t,
      routes: t.routes.map((r) => ({ ...r, outputExpression: '', clones: [{}], groupId: 'x', description: 'as the UI saved it' })),
    }
    expect(routeTableMatches(echoed)).toBe(true)
    // An expression is not routing while it is switched off.
    expect(routeTableMatches({ ...t, routes: t.routes.map((r) => ({ ...r, outputExpression: "'somewhere'" })) })).toBe(true)
    // Absent keys read as Cribl's defaults, which is how route.yml ships them.
    const bare = {
      ...t,
      routes: t.routes.map((r) => {
        const rest: Record<string, unknown> = { ...r }
        delete rest.clones
        delete rest.enableOutputExpression
        delete rest.disabled
        return rest
      }),
    }
    expect(routeTableMatches(bare)).toBe(true)
  })
})

describe('the confirmation', () => {
  it('names the table’s before → after by route id, each delete by kind, id and version, the pipelines kept, and no Lake data touched', () => {
    const f = cleanupFindings(current(listing({
      routes: table010(),
      inputs: [...PACK_OBJECTS.inputs, 'in_gno_syslog'],
      outputs: [...PACK_OBJECTS.outputs, 'out_gno_lake', 'out_gno_sample_lake'],
      pipelines: [...PACK_OBJECTS.pipelines, 'gno_syslog', 'gno_sample'],
    })))!
    const d = cleanupDialog({ group: GROUP, findings: f, scope: null, undeployed: null })
    expect(d.resources.map((r) => `${r.action} ${r.kind} ${r.id}`)).toEqual([
      'replace Route table default',
      'delete Source in_gno_syslog',
      'delete Cribl Lake destination out_gno_lake',
      'delete Cribl Lake destination out_gno_sample_lake',
      `deploy Worker group ${GROUP}`,
    ])
    expect(d.resources[1].detail).toContain('left over from 0.1.0')
    // Per position: the id, then each routing field that moves; the third
    // route only the shipped table has is its id alone.
    expect(d.diff.filter((r) => r.key.endsWith('.id'))).toEqual([
      { resourceId: 'default', key: 'routes[0].id', before: 'gno_syslog', after: PACK_ROUTES[0].id },
      { resourceId: 'default', key: 'routes[1].id', before: 'gno_sample', after: PACK_ROUTES[1].id },
      { resourceId: 'default', key: 'routes[2].id', before: null, after: PACK_ROUTES[2].id },
    ])
    expect(d.diff.map((r) => r.key)).toEqual([
      'routes[0].id', 'routes[0].filter', 'routes[0].pipeline', 'routes[0].output', 'routes[0].final',
      'routes[1].id', 'routes[1].filter', 'routes[1].pipeline', 'routes[1].output',
      'routes[2].id',
    ])
    expect(d.diff.find((r) => r.key === 'routes[0].filter')).toMatchObject({ before: "__inputId=='syslog:in_gno_syslog'", after: PACK_ROUTES[0].filter })
    const said = d.consequences.join(' ')
    expect(said).toContain('gno_syslog, gno_sample stay listed by Cribl, unused by any route once the routes are restored')
    expect(said).toContain('No Cribl Lake dataset is touched')
    expect(said).toContain('nothing is committed or deployed')
    expect(said).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
    expect(d.approved).toEqual({ routesBefore: table010().routes.map(routeFingerprint), sources: ['in_gno_syslog'], destinations: ['out_gno_lake', 'out_gno_sample_lake'] })
    expect(d.resources.some((r) => r.id === 'gno_syslog' || r.id === 'gno_sample')).toBe(false)
  })

  it('a kept table with the shipped ids: the rows that move are shown as changing, never all "unchanged"', () => {
    const f = cleanupFindings(current(listing({ routes: table021() })))!
    const d = cleanupDialog({ group: GROUP, findings: f, scope: null, undeployed: null })
    // Every id row is unchanged…
    for (const row of d.diff.filter((r) => r.key.endsWith('.id'))) expect(row.before).toBe(row.after)
    // …and the pipeline the PATCH rewrites is named, before → after.
    expect(d.diff.filter((r) => !r.key.endsWith('.id'))).toEqual([
      { resourceId: 'default', key: 'routes[1].pipeline', before: PACK_PIPELINE_ID, after: PACK_ROUTES[1].pipeline },
    ])
    expect(d.approved.routesBefore).toEqual(table021().routes.map(routeFingerprint))
  })

  it('with the routes already right, it names no table and no diff', () => {
    const f = cleanupFindings(current(listing({ inputs: [...PACK_OBJECTS.inputs, 'in_gno_syslog'] })))!
    const d = cleanupDialog({ group: GROUP, findings: f, scope: null, undeployed: null })
    expect(d.resources.map((r) => r.action)).toEqual(['delete', 'deploy'])
    expect(d.diff).toEqual([])
    expect(d.approved.routesBefore).toBeNull()
  })
})

// ── The run, against a fake Leader ──────────────────────────────────────────

interface Call { method: string; path: string; body: unknown }
let calls: Call[] = []

interface World {
  table: Record<string, unknown>
  tableId: string
  inputs: string[]
  outputs: string[]
  pipelines: string[]
  pending: string[]
}
let world: World

interface Opts {
  /** A DELETE of this source answers 200 and leaves it there. */
  sticky?: string
  /** The route PATCH answers 500. */
  failPatch?: boolean
  /** The table answers under another id. */
  tableId?: string
  /** Leftovers listed with no file behind them (M2): a DELETE answers 200 and
   *  leaves Git with nothing pending. */
  stale?: string[]
}

function reply(status: number, value?: unknown) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown } as unknown as Response
}

function leader(o: Opts = {}): void {
  calls = []
  world = {
    table: { id: o.tableId ?? 'default', groups: {}, comments: [], routes: table010().routes },
    tableId: o.tableId ?? 'default',
    inputs: [...PACK_OBJECTS.inputs, 'in_gno_syslog'],
    outputs: [...PACK_OBJECTS.outputs, 'out_gno_lake', 'out_gno_sample_lake'],
    pipelines: [...PACK_OBJECTS.pipelines, 'gno_syslog', 'gno_sample'],
    pending: [],
  }
  const w = world
  window.__CRIBL_SEARCH_ORIGIN = 'https://main-acme.cribl.cloud'
  vi.stubGlobal('getCriblUser', async () => ({ id: 'auth0|me', username: 'me' }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '').split('?')[0]
    const raw = init.body == null ? undefined : String(init.body)
    let body: unknown = raw
    try { body = raw === undefined ? undefined : JSON.parse(raw) } catch { /* text */ }
    calls.push({ method, path, body })
    const at = (m: string, p: string) => method === m && path === p

    if (path.startsWith('/kvstore')) return method === 'GET' ? reply(404, '') : reply(200, '')
    if (at('GET', '/products/stream/groups')) return reply(200, { items: [{ id: GROUP, name: GROUP, onPrem: false, configVersion: 'aaaa1111' }] })
    if (at('GET', `/products/stream/groups/${GROUP}`)) return reply(200, { items: [{ id: GROUP, configVersion: 'aaaa1111' }] })
    if (at('GET', '/version')) return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }] })
    if (at('GET', `/m/${GROUP}/packs`)) return reply(200, { items: [{ id: PACK_ID, version: PACK_VERSION, source: PACK_URL }] })
    if (at('GET', `${P}/system/inputs`)) return reply(200, { items: w.inputs.map((id) => ({ id })) })
    if (at('GET', `${P}/pipelines`)) return reply(200, { items: w.pipelines.map((id) => ({ id })) })
    if (at('GET', `${P}/system/outputs`)) return reply(200, { items: w.outputs.map((id) => ({ id })) })
    if (at('GET', `${P}/routes`)) return reply(200, { items: [w.table] })
    if (at('PATCH', `${P}/routes/${w.tableId}`)) {
      if (o.failPatch) return reply(500, { message: 'could not save the routes' })
      w.table = body as Record<string, unknown>
      w.pending.push(`groups/${GROUP}/local/${PACK_ID}/pipelines/route.yml`)
      return reply(200, { items: [body] })
    }
    for (const id of ['in_gno_syslog', 'in_gno_sample']) {
      if (at('GET', `${P}/system/inputs/${id}`)) return w.inputs.includes(id) ? reply(200, { items: [{ id }] }) : reply(404, {})
      if (at('DELETE', `${P}/system/inputs/${id}`)) {
        if (!w.inputs.includes(id)) return reply(404, {})
        if (o.sticky !== id) w.inputs = w.inputs.filter((x) => x !== id)
        if (!o.stale?.includes(id)) w.pending.push(`groups/${GROUP}/local/${PACK_ID}/inputs.yml`)
        return reply(200, { items: [] })
      }
    }
    for (const id of ['out_gno_lake', 'out_gno_sample_lake']) {
      if (at('GET', `${P}/system/outputs/${id}`)) return w.outputs.includes(id) ? reply(200, { items: [{ id }] }) : reply(404, {})
      if (at('DELETE', `${P}/system/outputs/${id}`)) {
        const named = (w.table.routes as Array<{ id: string; output: string }>).find((r) => r.output === id)
        if (named) return reply(409, { message: `Cannot delete output since it is being referenced by the route '${named.id}'` })
        w.outputs = w.outputs.filter((x) => x !== id)
        if (!o.stale?.includes(id)) w.pending.push(`groups/${GROUP}/local/${PACK_ID}/outputs.yml`)
        return reply(200, { items: [] })
      }
    }
    if (method === 'GET' && path.startsWith(`${P}/`)) return reply(200, { items: [] })
    if (at('GET', '/version/status')) return reply(200, { items: [{ files: w.pending.map((f) => ({ path: f })) }] })
    if (at('POST', '/version/commit')) {
      // As a Leader answers a commit with nothing pending: no commit hash.
      if (w.pending.length === 0) return reply(200, { items: [{}] })
      const files = (body as { files: string[] }).files
      w.pending = w.pending.filter((f) => !files.includes(f))
      return reply(200, { items: [{ commit: HASH }] })
    }
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(200, { items: [] })
    return reply(599, { message: `no route for ${method} ${path}` })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.__CRIBL_SEARCH_ORIGIN
})

const writes = () => calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))
const writeWords = () => writes().map((c) =>
  c.path === '/version/commit' ? 'commit' : c.path.endsWith('/deploy') ? 'deploy' : `${c.method} ${c.path.replace(P, '')}`)

async function cleanup(o: { between?: () => void } = {}) {
  const prepared = await prepareCleanup(GROUP, { undeployed: null, undeployedChecking: false })
  if (!prepared.ok) return { prepared, out: null }
  const dialog = cleanupDialog(prepared.ctx)
  o.between?.()
  const records: string[] = []
  const out = await runPackCleanup(prepared.ctx, dialog, { onStep: () => {}, record: async (h) => { records.push(h) } })
  return { prepared, out, records }
}

describe('the run', () => {
  it('routes first, then the source, then each destination, then the commit and deploy — and no pipeline DELETE', async () => {
    leader()
    const r = await cleanup()
    expect(r.out?.stopped).toBeNull()
    expect(writeWords()).toEqual([
      'PATCH /routes/default',
      'DELETE /system/inputs/in_gno_syslog',
      'DELETE /system/outputs/out_gno_lake',
      'DELETE /system/outputs/out_gno_sample_lake',
      'commit', 'deploy',
    ])
    // The whole table, with only its routes replaced.
    expect(writes()[0].body).toEqual({ id: 'default', groups: {}, comments: [], routes: JSON.parse(JSON.stringify(PACK_ROUTES)) })
    expect(r.records).toEqual([HASH])
    // Each delete was read back.
    for (const id of ['in_gno_syslog']) expect(calls.some((c) => c.method === 'GET' && c.path === `${P}/system/inputs/${id}`)).toBe(true)
    for (const id of ['out_gno_lake', 'out_gno_sample_lake']) expect(calls.some((c) => c.method === 'GET' && c.path === `${P}/system/outputs/${id}`)).toBe(true)
  })

  it('a failed route PATCH: the source is still deleted, the destinations are not attempted, and nothing is committed', async () => {
    leader({ failPatch: true })
    const r = await cleanup()
    expect(writeWords()).toEqual(['PATCH /routes/default', 'DELETE /system/inputs/in_gno_syslog'])
    expect(r.out?.stopped?.key).toBe('routes')
    const held = r.out?.steps.find((s) => s.key === 'commit')
    expect(held?.action).toBe('skipped')
    expect(held?.detail).toContain('Nothing was committed or deployed, because a step failed')
    expect(r.out?.steps.filter((s) => s.key === 'output').map((s) => s.action)).toEqual(['skipped', 'skipped'])
  })

  it('a route PATCH answered, but the table read back is not the shipped one: a failure, no destination attempted, nothing committed', async () => {
    leader()
    // A Leader that answered the PATCH and kept an extra row naming
    // out_gno_lake: deleting that destination now would answer 409, so it is
    // not attempted.
    const r = await cleanup({
      between: () => {
        const real = globalThis.fetch
        vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
          const res = await real(url, init)
          if ((init.method ?? 'GET').toUpperCase() === 'PATCH' && String(url).includes('/routes/default')) {
            world.table = { ...world.table, routes: [...(world.table.routes as unknown[]), { id: 'mine', output: 'out_gno_lake' }] }
          }
          return res
        })
      },
    })
    // The route read-back found a table that is not the shipped one: failure.
    expect(r.out?.stopped?.key).toBe('routes')
    expect(writeWords()).toEqual(['PATCH /routes/default', 'DELETE /system/inputs/in_gno_syslog'])
    expect(writes().some((c) => c.path === '/version/commit')).toBe(false)
  })

  it('a destination DELETE answered 409 is reported in the Leader’s words, and nothing is committed', async () => {
    leader()
    const prepared = await prepareCleanup(GROUP, { undeployed: null, undeployedChecking: false })
    if (!prepared.ok) throw new Error(prepared.why)
    // The routes already right, so the run sends no PATCH; but a row still
    // names out_gno_lake on the Leader.
    const dialog = cleanupDialog(prepared.ctx)
    const noRoutes = { ...dialog, approved: { ...dialog.approved, routesBefore: null } }
    const out = await runPackCleanup(prepared.ctx, noRoutes, { onStep: () => {}, record: async () => {} })
    expect(writeWords()).toEqual([
      'DELETE /system/inputs/in_gno_syslog',
      'DELETE /system/outputs/out_gno_lake',
      'DELETE /system/outputs/out_gno_sample_lake',
    ])
    const failed = out.steps.filter((s) => s.action === 'error')
    expect(failed.map((s) => s.label)).toEqual(['Leftover destination out_gno_lake', 'Leftover destination out_gno_sample_lake'])
    expect(failed[0].detail).toContain('being referenced by the route')
    expect(out.steps.find((s) => s.key === 'commit')?.action).toBe('skipped')
    expect(writes().some((c) => c.path === '/version/commit')).toBe(false)
  })

  it('a source that reads back as still there after its DELETE answered: a failure, and nothing is committed', async () => {
    leader({ sticky: 'in_gno_syslog' })
    const r = await cleanup()
    const s = r.out?.steps.find((x) => x.label === 'Leftover source in_gno_syslog')
    expect(s?.action).toBe('error')
    expect(s?.detail).toContain('still present')
    // The destinations still ran: the routes were restored.
    expect(writeWords()).toEqual([
      'PATCH /routes/default', 'DELETE /system/inputs/in_gno_syslog',
      'DELETE /system/outputs/out_gno_lake', 'DELETE /system/outputs/out_gno_sample_lake',
    ])
  })

  it('anything moved since the confirmation: nothing written', async () => {
    leader()
    const r = await cleanup({ between: () => { world.outputs = world.outputs.filter((x) => x !== 'out_gno_sample_lake') } })
    expect(r.out?.stopped?.key).toBe('precheck')
    expect(writes()).toEqual([])
  })

  it('the pack’s manifest uncommitted: refused before the dialog, and again at Yes', async () => {
    leader()
    world.pending.push(`groups/${GROUP}/default/${PACK_ID}/package.json`)
    const refused = await prepareCleanup(GROUP, { undeployed: null, undeployedChecking: false })
    expect(refused.ok).toBe(false)
    world.pending = []
    const r = await cleanup({ between: () => { world.pending.push(`groups/${GROUP}/default/${PACK_ID}/package.json`) } })
    expect(r.out?.stopped?.key).toBe('precheck')
    expect(r.out?.stopped?.detail).toContain('package.json')
    expect(writes()).toEqual([])
  })

  it('a table under another id: refused before the dialog, and nothing at all is written', async () => {
    leader({ tableId: 'main' })
    const r = await cleanup()
    expect(r.prepared.ok).toBe(false)
    if (!r.prepared.ok) expect(r.prepared.why).toContain('only ever writes the one table “default”')
    expect(writes()).toEqual([])
  })

  it('a kept table with the shipped ids and an edited pipeline: restored, and the PATCH is what the dialog named', async () => {
    leader()
    world.table = { id: 'default', groups: {}, comments: [], routes: table021().routes }
    world.inputs = [...PACK_OBJECTS.inputs]
    world.outputs = [...PACK_OBJECTS.outputs]
    const r = await cleanup()
    expect(r.out?.stopped).toBeNull()
    expect(writeWords()).toEqual(['PATCH /routes/default', 'commit', 'deploy'])
  })

  it('a route’s filter edited after the dialog opened, its id unchanged: nothing written', async () => {
    leader()
    world.table = { id: 'default', groups: {}, comments: [], routes: table021().routes }
    const r = await cleanup({
      between: () => {
        const routes = structuredClone(world.table.routes) as Array<Record<string, unknown>>
        routes[0] = { ...routes[0], filter: "__inputId=='something:else'" }
        world.table = { ...world.table, routes }
      },
    })
    expect(r.out?.stopped?.key).toBe('precheck')
    expect(writes()).toEqual([])
  })

  it('restorePackRoutes itself refuses a table whose routing moved from what was shown, ids unchanged', async () => {
    leader()
    world.table = { id: 'default', groups: {}, comments: [], routes: table021().routes }
    const step = await restorePackRoutes(GROUP, shippedTable().routes.map(routeFingerprint))
    expect(step.action).toBe('error')
    expect(step.detail).toContain('changed after the confirmation was shown')
    expect(writes()).toEqual([])
  })

  it('deletes of leftovers with no file behind them (stale Leader state) leave nothing to commit: up to date, not an error', async () => {
    leader({ stale: ['in_gno_syslog', 'out_gno_lake', 'out_gno_sample_lake'] })
    world.table = { id: 'default', groups: {}, comments: [], routes: structuredClone(PACK_ROUTES) }
    const r = await cleanup()
    expect(writeWords().filter((w) => w.startsWith('DELETE'))).toHaveLength(3)
    expect(r.out?.stopped).toBeNull()
    expect(r.out?.steps.some((s) => s.action === 'error')).toBe(false)
    // Git had nothing of the pack's pending, so Cribl committed nothing: said
    // as "nothing to commit", never as a change that failed to commit.
    expect(r.out?.steps.find((s) => s.key === 'commit')).toMatchObject({ action: 'exists' })
  })

  it('nothing to put right: the confirmation does not open', async () => {
    leader()
    world.table = { id: 'default', groups: {}, comments: [], routes: structuredClone(PACK_ROUTES) }
    world.inputs = [...PACK_OBJECTS.inputs]
    world.outputs = [...PACK_OBJECTS.outputs]
    const prepared = await prepareCleanup(GROUP, { undeployed: null, undeployedChecking: false })
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.why).toContain('nothing to restore or remove')
    expect(writes()).toEqual([])
  })
})

// What this file could not assert: what a real Leader does beyond the six
// measurements it models — in particular whether a destination DELETE a route
// no longer names ever answers anything but 200, and how Git status names the
// pack's local route override; the commit selects every pending path with the
// pack's segment, as every other pack write does.
