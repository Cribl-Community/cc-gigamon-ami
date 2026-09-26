// The cutover preflight (runbook 4c): read-only, built from Guided Setup's own
// readers, and plain about what blocks the cutover.
//
// The first block runs the REAL readers (LIVE_READERS → packClient.ts,
// provision.ts, lake.ts → capi.ts) over the runner's own guarded fetch and a
// fake transport, and holds every request that reached the transport to a GET
// that src/cribl/paths.ts (and so config/policies.yml) already grants, with no
// Search path among them. The rest drive the verdict with fake readers.
//
// What this cannot show: that a Leader answers in these shapes. The bodies are
// the shapes the readers' own tests use; the preflight has not been run
// against a Leader (see the module header).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { PreflightRefusal, readOnlyFetch, refusalOf, searchOriginFromDevPage } from '../../scripts/cutover-preflight-fetch.mjs'
import {
  LIVE_READERS,
  NON_DELIVERING_VERSIONS,
  OLDER_VERSION_GAPS,
  gatherPreflight,
  parquetRouteBlockers,
  preflightReport,
  preflightVerdict,
  shipsParquetPipeline,
  type PreflightFacts,
  type PreflightReaders,
} from './cutoverPreflight'
import type { LakeDataset } from './lake'
import {
  PACK_ID,
  PACK_OBJECTS,
  PACK_PARQUET_OUTPUT_ID,
  PACK_PARQUET_PIPELINE_ID,
  PACK_PIPELINE_ID,
  PACK_PUBLISHED_VERSIONS,
  PACK_ROUTES_FILE,
  PACK_VERSION,
  packReleaseUrl,
} from './pack'
import { compareVersions, packOutputsOf, packRoutesOf, thisPackRelease, type PackOutput, type PackRoute, type PackState } from './packClient'
import { API_CALLS } from './paths'

const ROOT = join(__dirname, '..', '..')
const TOKEN = 'SECRET-TOKEN-must-never-print'

/** The routing table the pack ships, exactly as its YAML has it. */
const shippedTable = () => parse(readFileSync(join(ROOT, 'packs', PACK_ID, PACK_ROUTES_FILE), 'utf8')) as { routes: Record<string, unknown>[] }
/** That table with its routes changed, as a Leader would return it. */
function routesBody(edit: (routes: Record<string, unknown>[]) => Record<string, unknown>[] = (r) => r, extra: Record<string, unknown> = {}) {
  const t = shippedTable()
  return { items: [{ ...t, ...extra, routes: edit(t.routes) }] }
}
/** The pack's destinations, exactly as its YAML has them, as a Leader lists them. */
function outputsBody(extra: Record<string, unknown>[] = []) {
  const o = (parse(readFileSync(join(ROOT, 'packs', PACK_ID, 'default/outputs.yml'), 'utf8')) as { outputs: Record<string, Record<string, unknown>> }).outputs
  return { items: [...Object.entries(o).map(([id, v]) => ({ id, ...v })), ...extra] }
}
const shippedOutputs = (): PackOutput[] => packOutputsOf(200, outputsBody()) as PackOutput[]
const toParquet = (r: Record<string, unknown>) => r.output === PACK_PARQUET_OUTPUT_ID
const shippedRoutes = (): PackRoute[] => packRoutesOf(200, routesBody()) as PackRoute[]

// ── A fake Leader, in the shapes the readers parse ─────────────────────────

const packPrefix = `/m/default/p/${PACK_ID}`
function leaderBodies(): Record<string, { status: number; body: unknown }> {
  const ok = (body: unknown) => ({ status: 200, body })
  const nf = { status: 404, body: { message: 'not found' } }
  return {
    '/m/default/packs': ok({ items: [{ id: PACK_ID, version: PACK_VERSION, source: packReleaseUrl(PACK_VERSION) }] }),
    [`${packPrefix}/system/inputs`]: ok({
      items: [
        { id: 'in_gigamon_ami_http', type: 'http_raw', disabled: false, port: 20005, authTokens: [{ token: TOKEN }], tls: { disabled: false, certificateName: 'cloud' } },
        { id: 'in_gigamon_ami_sample', type: 'datagen', disabled: true },
      ],
    }),
    [`${packPrefix}/lib/breakers/gigamon_ami_http_json_array`]: ok({ items: [{ id: 'gigamon_ami_http_json_array' }] }),
    [`${packPrefix}/pipelines`]: ok({ items: PACK_OBJECTS.pipelines.map((id) => ({ id })) }),
    [`${packPrefix}/routes`]: ok(routesBody()),
    [`${packPrefix}/system/outputs`]: ok(outputsBody()),
    '/m/default/system/inputs': ok({ items: [{ id: 'in_gigamon_http', type: 'http_raw', port: 20000 }, { id: 'datagen', type: 'datagen' }] }),
    '/m/default/system/inputs/in_gigamon_http': ok({ items: [{ id: 'in_gigamon_http', authTokens: [{ token: 'OLD-GLOBAL-TOKEN' }] }] }),
    '/m/default/system/inputs/in_gigamon_syslog': nf,
    '/m/default/pipelines/gigamon_http_normalize': ok({ items: [{ id: 'gigamon_http_normalize' }] }),
    '/m/default/pipelines/gigamon_syslog': nf,
    '/m/default/lib/breakers/gigamon_ami_json_array': ok({ items: [{ id: 'gigamon_ami_json_array' }] }),
    '/m/default/routes': ok({ items: [{ id: 'default', routes: [{ id: 'gigamon_ami_http' }, { id: 'default' }] }] }),
    '/products/lake/lakes/default/datasets': ok({
      items: [
        { id: 'gigamon_ami', format: 'json', metrics: { currentSizeBytes: 5 * 1024 ** 3, metricsDate: '2026-09-24' } },
        { id: 'gigamon_ami_pq', format: 'parquet', metrics: { currentSizeBytes: 0, metricsDate: '2026-09-24' } },
      ],
    }),
    '/products/stream/groups': ok({ items: [{ id: 'default', onPrem: false, configVersion: 'aaa111' }] }),
    '/products/stream/groups/default': ok({ items: [{ id: 'default', configVersion: 'aaa111' }] }),
    '/version': ok({ items: [{ hash: 'aaa111', refs: 'HEAD -> main' }] }),
    '/version/status': ok({ items: [{ files: [] }] }),
  }
}

function fakeTransport(bodies = leaderBodies()) {
  const seen: { method: string; url: string }[] = []
  const transport = vi.fn(async (url: string, init: { method: string }) => {
    seen.push({ method: init.method, url })
    const path = new URL(url).pathname.replace(/^\/capi/, '')
    const hit = bodies[path] ?? { status: 404, body: { message: 'no such path in the fake' } }
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'Content-Type': 'application/json' } })
  })
  return { seen, transport }
}

/** Does a request path match a declared GET in paths.ts? `:x` is one segment. */
function grantedGet(path: string): boolean {
  const segs = path.split('/')
  return API_CALLS.some((c) => {
    if (c.method !== 'GET') return false
    const want = c.path.split('/')
    return want.length === segs.length && want.every((w, i) => w.startsWith(':') || w === decodeURIComponent(segs[i]))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { __CRIBL_SEARCH_ORIGIN?: string }).__CRIBL_SEARCH_ORIGIN
})

describe('the real readers, over the runner’s guarded fetch', () => {
  it('sends only GETs, touches no Search path, reads only granted paths — and prints no token', async () => {
    const { seen, transport } = fakeTransport()
    vi.stubGlobal('fetch', readOnlyFetch({ base: 'http://localhost:5173/capi', fetch: transport }))
    window.__CRIBL_SEARCH_ORIGIN = 'https://main-acme.cribl.cloud'

    const facts = await gatherPreflight('default', LIVE_READERS)
    const verdict = preflightVerdict(facts)

    expect(seen.length).toBeGreaterThan(10)
    for (const r of seen) {
      expect(r.method).toBe('GET')
      const path = new URL(r.url).pathname.replace(/^\/capi/, '')
      expect(path, 'a Search path').not.toMatch(/(^|\/)search(\/|$)/)
      expect(grantedGet(path), `${path} is not a GET config/policies.yml grants`).toBe(true)
    }

    expect(verdict.blockers).toEqual([])
    expect(verdict.ready).toBe(true)
    expect(verdict.target).toBe('default.main.acme.cribl.cloud:20005')
    expect(verdict.url).toBe('https://default.main.acme.cribl.cloud:20005/')
    expect(facts.pack.http).toMatchObject({ disabled: false, port: 20005, tokenSet: true, tls: true })
    expect(facts.datasets.map((d) => `${d.id}:${d.state}`)).toEqual(['gigamon_ami:present', 'gigamon_ami_pq:present', 'gigamon_ami_sample:absent'])
    expect(facts.globalObjects.filter((o) => o.state === 'present').map((o) => o.id)).toEqual([
      'in_gigamon_http', 'gigamon_ami_json_array', 'gigamon_http_normalize', 'gigamon_ami_http',
    ])

    const text = [...preflightReport(facts, verdict), JSON.stringify(facts), JSON.stringify(verdict)].join('\n')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('OLD-GLOBAL-TOKEN')
    expect(text).toContain('Ready to point AMX at default.main.acme.cribl.cloud:20005')
  })

  // HEAD ahead of the group's commit, and the group record only on the
  // deprecated /master path: the history, /master/groups/:gid and
  // /version/files reads now go through the guard and the grant check too.
  const behindBodies = (files: { status: number; body: unknown }) => {
    const b = leaderBodies()
    b['/products/stream/groups/default'] = { status: 404, body: { message: 'not found' } }
    b['/master/groups/default'] = { status: 200, body: { items: [{ id: 'default', configVersion: 'aaa111' }] } }
    b['/version'] = { status: 200, body: { items: [{ hash: 'bbb222', refs: 'HEAD -> main' }, { hash: 'aaa111', refs: '' }] } }
    b['/version/files'] = files
    return b
  }

  it.each<[string, { status: number; body: unknown }, RegExp]>([
    ['a commit in between touches the group', { status: 200, body: { items: [{ count: 1, items: [{ name: `groups/default/default/${PACK_ID}/package.json` }] }] } }, /behind the Leader’s HEAD \(bbb222; it runs aaa111\), and a commit in between touches it/],
    ['the commit’s files cannot be read', { status: 403, body: { message: 'forbidden' } }, /whether a commit in between touches it could not be told/],
  ])('blocks, over the real readers, when HEAD is ahead and %s', async (_name, files, words) => {
    const { seen, transport } = fakeTransport(behindBodies(files))
    vi.stubGlobal('fetch', readOnlyFetch({ base: 'http://localhost:5173/capi', fetch: transport }))
    window.__CRIBL_SEARCH_ORIGIN = 'https://main-acme.cribl.cloud'

    const facts = await gatherPreflight('default', LIVE_READERS)
    const verdict = preflightVerdict(facts)

    const paths = seen.map((r) => new URL(r.url).pathname.replace(/^\/capi/, ''))
    expect(paths).toContain('/master/groups/default')
    expect(paths).toContain('/version/files')
    for (const r of seen) {
      expect(r.method).toBe('GET')
      const path = new URL(r.url).pathname.replace(/^\/capi/, '')
      expect(path, 'a Search path').not.toMatch(/(^|\/)search(\/|$)/)
      expect(grantedGet(path), `${path} is not a GET config/policies.yml grants`).toBe(true)
    }
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).toMatch(words)
    expect(preflightReport(facts, verdict).join('\n')).not.toContain('Ready to point AMX')
  })

  it('is ready, with a warning, over the real readers when every commit in between was read and none touches the group', async () => {
    const { transport } = fakeTransport(behindBodies({ status: 200, body: { items: [{ count: 1, items: [{ name: 'groups/other/local/cribl/inputs.yml' }] }] } }))
    vi.stubGlobal('fetch', readOnlyFetch({ base: 'http://localhost:5173/capi', fetch: transport }))
    window.__CRIBL_SEARCH_ORIGIN = 'https://main-acme.cribl.cloud'
    const facts = await gatherPreflight('default', LIVE_READERS)
    expect(facts.git.deploy).toEqual({ state: 'behind', head: 'bbb222', deployed: 'aaa111', proof: 'clear', detail: null })
    const verdict = preflightVerdict(facts)
    expect(verdict.ready).toBe(true)
    expect(verdict.warnings.join('\n')).toMatch(/none touches this group/)
  })

  it('blocks, over the real readers, when the group record cannot be read', async () => {
    const b = leaderBodies()
    b['/products/stream/groups/default'] = { status: 403, body: { message: 'forbidden' } }
    const { transport } = fakeTransport(b)
    vi.stubGlobal('fetch', readOnlyFetch({ base: 'http://localhost:5173/capi', fetch: transport }))
    const verdict = preflightVerdict(await gatherPreflight('default', LIVE_READERS))
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).toMatch(/could not be told: the commit default is running/)
  })

  // The Parquet route check (owner decision 2026-09-25, `fix/preflight-rules-route`)
  // over the real readers: the route table comes from the same GET readPackState
  // already made, so the request set — every one a granted GET — does not grow.
  it.each<[string, { status: number; body: unknown }, RegExp]>([
    ['its Parquet route edited to the JSON pipeline',
      { status: 200, body: routesBody((rs) => rs.map((r) => (toParquet(r) ? { ...r, pipeline: PACK_PIPELINE_ID } : r))) },
      new RegExp(`writes gigamon_ami_pq through ${PACK_PIPELINE_ID}, not ${PACK_PARQUET_PIPELINE_ID}, so the Parquet copy \\(gigamon_ami_pq\\) would keep _raw`)],
    ['its routing table unreadable', { status: 403, body: { message: 'forbidden' } }, /routing table in default could not be read/],
  ])('blocks, over the real readers, on %s — and still sends only granted GETs', async (_name, routes, words) => {
    const b = leaderBodies()
    b[`${packPrefix}/routes`] = routes
    const { seen, transport } = fakeTransport(b)
    vi.stubGlobal('fetch', readOnlyFetch({ base: 'http://localhost:5173/capi', fetch: transport }))
    window.__CRIBL_SEARCH_ORIGIN = 'https://main-acme.cribl.cloud'
    const facts = await gatherPreflight('default', LIVE_READERS)
    const verdict = preflightVerdict(facts)
    for (const r of seen) {
      expect(r.method).toBe('GET')
      const path = new URL(r.url).pathname.replace(/^\/capi/, '')
      expect(path, 'a Search path').not.toMatch(/(^|\/)search(\/|$)/)
      expect(grantedGet(path), `${path} is not a GET config/policies.yml grants`).toBe(true)
    }
    expect(seen.filter((r) => new URL(r.url).pathname.endsWith(`/p/${PACK_ID}/routes`))).toHaveLength(1)
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).toMatch(words)
  })

  it('reads the shipped route table off the pack, whole: output, pipeline and state per route', async () => {
    const { transport } = fakeTransport()
    vi.stubGlobal('fetch', readOnlyFetch({ base: 'http://localhost:5173/capi', fetch: transport }))
    const facts = await gatherPreflight('default', LIVE_READERS)
    expect(facts.pack.routeTable).toEqual(shippedRoutes())
    expect(facts.pack.outputTable).toEqual(shippedOutputs())
    expect(facts.pack.outputTable?.find((o) => o.id === PACK_PARQUET_OUTPUT_ID)).toEqual({ id: PACK_PARQUET_OUTPUT_ID, type: 'cribl_lake', dataset: 'gigamon_ami_pq' })
    expect(facts.pack.routeTable?.filter((r) => r.output === PACK_PARQUET_OUTPUT_ID)).toEqual([
      { id: 'gigamon_ami_http_to_parquet', output: PACK_PARQUET_OUTPUT_ID, pipeline: PACK_PARQUET_PIPELINE_ID, disabled: false, final: true, outputExpression: false },
    ])
    expect(preflightReport(facts, preflightVerdict(facts)).join('\n')).toContain(`routes into gigamon_ami_pq: gigamon_ami_http_to_parquet via ${PACK_PARQUET_PIPELINE_ID}`)
  })
})

describe('the guarded fetch', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('refuses %s before anything is sent', async (method) => {
    const { transport } = fakeTransport()
    const f = readOnlyFetch({ base: 'http://x/capi', fetch: transport })
    await expect(f('/capi/m/default/packs', { method })).rejects.toBeInstanceOf(PreflightRefusal)
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses any Search path, a job submit included, and anything outside /capi', async () => {
    const { transport } = fakeTransport()
    const f = readOnlyFetch({ base: 'http://x/capi', fetch: transport })
    await expect(f('/capi/m/default_search/search/jobs', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(PreflightRefusal)
    await expect(f('/capi/m/default_search/search/jobs')).rejects.toBeInstanceOf(PreflightRefusal)
    await expect(f('/capi/search/saved')).rejects.toBeInstanceOf(PreflightRefusal)
    await expect(f('https://evil.example/capi/m/default/packs')).rejects.toBeInstanceOf(PreflightRefusal)
    await expect(f('/api/v1/m/default/packs')).rejects.toBeInstanceOf(PreflightRefusal)
    expect(transport).not.toHaveBeenCalled()
    // A dataset id that merely CONTAINS the word is not a Search path.
    expect(refusalOf('GET', '/capi/products/lake/lakes/default/datasets/research_x')).toBeNull()
  })

  it('rewrites /capi onto the base and sends no body', async () => {
    const { seen, transport } = fakeTransport()
    const f = readOnlyFetch({ base: 'http://localhost:5173/capi/', fetch: transport })
    await f('/capi/version?offset=0&limit=50', { headers: { 'Content-Type': 'application/json' } })
    expect(seen).toEqual([{ method: 'GET', url: 'http://localhost:5173/capi/version?offset=0&limit=50' }])
    expect(transport.mock.calls[0][1]).toEqual({ method: 'GET', signal: undefined })
  })

  it('reads the Leader origin off the dev page, and nothing that is not an http(s) origin', () => {
    expect(searchOriginFromDevPage('<script>window.__CRIBL_SEARCH_ORIGIN = "https://main-acme.cribl.cloud";</script>')).toBe('https://main-acme.cribl.cloud')
    expect(searchOriginFromDevPage('<script>window.__CRIBL_SEARCH_ORIGIN = "javascript:alert(1)";</script>')).toBeNull()
    expect(searchOriginFromDevPage('<html></html>')).toBeNull()
    expect(searchOriginFromDevPage(null)).toBeNull()
  })
})

describe('the runner’s wiring', () => {
  it('is `npm run cutover:preflight`, and installs the guard before it imports a module that can reach Cribl', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['cutover:preflight']).toBe('node scripts/cutover-preflight.mjs')
    const src = readFileSync(join(ROOT, 'scripts', 'cutover-preflight.mjs'), 'utf8')
    const guard = src.indexOf('globalThis.fetch = G.readOnlyFetch(')
    const load = src.indexOf("'src/cribl/cutoverPreflight.ts'")
    expect(guard).toBeGreaterThan(0)
    expect(load).toBeGreaterThan(guard)
    // No other src/ import precedes the guard.
    expect(src.slice(0, guard)).not.toMatch(/import\([^)]*src\/cribl\//)
    expect(src.slice(0, guard)).not.toMatch(/from\s+['"][^'"]*src\//)
  })
})

// ── The verdict, over fake readers ──────────────────────────────────────────

function packState(over: Partial<PackState> = {}): PackState {
  const all = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 'present' as const]))
  return {
    error: null, installed: true, version: PACK_VERSION, published: true, fromRelease: true, current: true,
    objects: {
      inputs: all(PACK_OBJECTS.inputs), breakers: all(PACK_OBJECTS.breakers), pipelines: all(PACK_OBJECTS.pipelines),
      routes: all(PACK_OBJECTS.routes), outputs: all(PACK_OBJECTS.outputs),
    },
    http: { disabled: false, port: 20005, tokenSet: true, tls: true, tlsCert: 'cloud' },
    sample: { disabled: true },
    installedSample: { id: 'in_gigamon_ami_sample', disabled: true },
    routeTable: shippedRoutes(),
    outputTable: shippedOutputs(),
    listed: null,
    ...over,
  }
}

const dataset = (id: string, extra: Partial<LakeDataset> = {}): LakeDataset => ({
  id, description: null, format: 'json', retentionPeriodInDays: 30, acceleratedFields: null, searchConfig: null,
  deletionStartedAt: null, metrics: { currentSizeBytes: 1024, metricsDate: '2026-09-24' }, raw: {}, ...extra,
})

function readers(over: Partial<PreflightReaders> = {}): PreflightReaders {
  const absent = { breaker: 'absent', pipeline: 'absent', source: 'absent', route: 'absent' } as const
  return {
    readPackState: async () => packState(),
    checkStatus: async () => ({ ...absent }),
    checkLegacyStatus: async () => ({ legacy_source: 'absent', legacy_pipeline: 'absent', legacy_route: 'absent' }),
    listDatasets: async () => ({ outcome: 'ok', value: [dataset('gigamon_ami'), dataset('gigamon_ami_pq', { format: 'parquet' })], object: '/x', status: 200, detail: null }),
    listStreamGroupsCurrent: async () => ({ outcome: 'ok', value: [{ id: 'default', name: 'default', configVersion: 'a', onPrem: false }], object: '/x', status: 200, detail: null }),
    portsOfOthers: async () => [20000],
    pendingConfigPaths: async () => [],
    deployState: async () => ({ state: 'current', head: 'aaa111' }),
    leaderHostname: () => 'main-acme.cribl.cloud',
    suggestedIngressHost: () => 'default.main.acme.cribl.cloud',
    ...over,
  }
}

async function verdictWith(over: Partial<PreflightReaders> = {}) {
  const facts = await gatherPreflight('default', readers(over))
  return { facts, verdict: preflightVerdict(facts) }
}

describe('the verdict', () => {
  it('is ready on a current, owned, started pack with both datasets and nothing pending', async () => {
    const { verdict } = await verdictWith()
    expect(verdict).toMatchObject({ ready: true, blockers: [], target: 'default.main.acme.cribl.cloud:20005' })
  })

  it('names a placeholder, never a guess, when the ingress host cannot be derived', async () => {
    const { verdict } = await verdictWith({ suggestedIngressHost: () => null })
    expect(verdict.ready).toBe(true)
    expect(verdict.target).toBe('<this group’s worker ingress host>:20005')
    expect(verdict.url).toBeNull()
  })

  const cases: [string, Partial<PreflightReaders>, RegExp][] = [
    ['no pack', { readPackState: async () => packState({ installed: false, version: null, http: null }) }, /not installed .*Onboard/],
    ['an unreadable pack list', { readPackState: async () => packState({ error: 'HTTP 403', installed: false }) }, /could not be read/],
    ['a copy this app did not install', { readPackState: async () => packState({ fromRelease: false, current: false }) }, /is not this app’s/],
    ['0.2.0, whose routes never match', { readPackState: async () => packState({ version: '0.2.0', current: false }) }, /0\.2\.0 delivers nothing/],
    ['no token', { readPackState: async () => packState({ http: { disabled: false, port: 20005, tokenSet: false, tls: true, tlsCert: 'c' } }) }, /no auth token/],
    ['a stopped source', { readPackState: async () => packState({ http: { disabled: true, port: 20005, tokenSet: true, tls: true, tlsCert: 'c' } }) }, /stopped/],
    ['a port another source holds', { portsOfOthers: async () => [20005] }, /already listens on 20005/],
    ['ports that cannot be read', { portsOfOthers: async () => null }, /cannot check that this port is free/],
    ['a missing Parquet dataset', { listDatasets: async () => ({ outcome: 'ok', value: [dataset('gigamon_ami')], object: '/x', status: 200, detail: null }) }, /gigamon_ami_pq does not exist/],
    ['a dataset being deleted', { listDatasets: async () => ({ outcome: 'ok', value: [dataset('gigamon_ami', { deletionStartedAt: 'x' }), dataset('gigamon_ami_pq')], object: '/x', status: 200, detail: null }) }, /gigamon_ami is being deleted/],
    ['an unreadable Lake listing', { listDatasets: async () => ({ outcome: 'not-readable', value: null, object: '/products/lake/lakes/default/datasets', status: 403, detail: 'no' }) }, /datasets are unknown: .*could not be read \(HTTP 403\)/],
    ['uncommitted pack files', { pendingConfigPaths: async () => [`groups/default/default/${PACK_ID}/local/inputs.yml`] }, /pack has uncommitted changes/],
    ['a group behind a commit that touches it', { deployState: async () => ({ state: 'behind', head: 'bbb222', deployed: 'aaa111', proof: 'touches', detail: null }) }, /behind the Leader’s HEAD \(bbb222; it runs aaa111\), and a commit in between touches it/],
    ['a HEAD not deployed, with nothing proved either way', { deployState: async () => ({ state: 'behind', head: 'bbb222', deployed: 'aaa111', proof: 'unknown', detail: 'the files of 1 of 1 commit(s) in between could not be read' }) }, /not running the Leader’s HEAD \(bbb222; it runs aaa111\), and whether a commit in between touches it could not be told/],
    ['a deploy state that cannot be read', { deployState: async () => ({ state: 'unreadable', detail: 'the Leader’s commit history could not be read' }) }, /could not be told: the Leader’s commit history could not be read/],
    ['a version this app never published', { readPackState: async () => packState({ published: false, current: false }) }, /this app did not publish that version/],
    ['a source port it cannot read', { readPackState: async () => packState({ http: { disabled: false, port: null, tokenSet: true, tls: true, tlsCert: 'c' } }) }, /no port this preflight can read/],
    ['an unreadable Git status', { pendingConfigPaths: async () => null }, /Git’s status could not be read/],
    ['a missing pack route', { readPackState: async () => { const s = packState(); s.objects.routes.gigamon_ami_sample = 'absent'; return s } }, /route gigamon_ami_sample is missing/],
  ]
  it.each(cases)('blocks on %s, in plain words', async (_name, over, words) => {
    const { verdict } = await verdictWith(over)
    expect(verdict.ready).toBe(false)
    expect(verdict.target).toBeNull()
    expect(verdict.blockers.join('\n')).toMatch(words)
  })

  // Owner decisions 2026-09-25: an owned copy older than the pin blocks while
  // the pin can be installed (`fix/preflight-rules-route`), which it can in this
  // build — the real release constants, nothing moved. One case per published
  // version older than PACK_VERSION, read off the list itself, so a new pin
  // brings its predecessors in by itself. The pin that cannot be installed, and
  // an older version with no stated gap, are cutoverPreflight.unpublished.test.ts
  // and cutoverPreflight.nextPin.test.ts (the constants moved by a mock).
  const esc = (v: string) => v.replace(/\./g, '\\.')
  const older = PACK_PUBLISHED_VERSIONS.filter((v) => compareVersions(v, PACK_VERSION) < 0)
  it('has the older published versions to check (else the table below is empty), and a pin it can install', () => {
    expect(older).toEqual(expect.arrayContaining(['0.1.0', '0.2.0', '0.2.1']))
    expect(thisPackRelease().installable).toBe(true)
  })
  it.each(older)('blocks on an owned %s, which is older than the installable pin', async (version) => {
    const { verdict } = await verdictWith({ readPackState: async () => packState({ version, current: false }) })
    expect(verdict.ready).toBe(false)
    expect(verdict.target).toBeNull()
    const text = verdict.blockers.join('\n')
    if (NON_DELIVERING_VERSIONS.includes(version)) {
      // Their own sentence, and not the older-than-pin one as well.
      expect(text).toMatch(new RegExp(`${esc(version)} delivers nothing`))
      expect(text).not.toMatch(/this build pins/)
    } else {
      expect(text).toMatch(new RegExp(`${esc(version)} is installed; this build pins ${esc(PACK_VERSION)}`))
      expect(text).toMatch(new RegExp(`Upgrade it to ${esc(PACK_VERSION)} from Guided Setup’s onboarding panel \\(Upgrade\\)`))
    }
    expect(verdict.warnings.join('\n')).not.toMatch(/this build pins/)
  })

  it('says why an owned 0.2.1 blocks: its Parquet copy keeps _raw', async () => {
    const { verdict } = await verdictWith({ readPackState: async () => packState({ version: '0.2.1', current: false }) })
    expect(verdict.blockers.join('\n')).toMatch(/0\.2\.1 keeps _raw on every row of its Parquet copy \(gigamon_ami_pq\)/)
  })

  it('keeps 0.2.1 blocking when this build’s pin cannot be installed — a stated gap — and says why Upgrade is not offered', async () => {
    expect(OLDER_VERSION_GAPS['0.2.1']).toBeTruthy()
    const facts = await gatherPreflight('default', readers({ readPackState: async () => packState({ version: '0.2.1', current: false }) }))
    const verdict = preflightVerdict({ ...facts, pinned: { ...facts.pinned, refusal: 'no release yet' } })
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).toMatch(/0\.2\.1 keeps _raw on every row of its Parquet copy/)
    expect(verdict.blockers.join('\n')).toMatch(/Upgrade is not offered yet: no release yet/)
    expect(verdict.warnings.join('\n')).not.toMatch(/this build pins/)
  })

  it('does not tell a foreign copy of an older version to Upgrade: Guided Setup refuses that', async () => {
    const { verdict } = await verdictWith({ readPackState: async () => packState({ version: '0.2.1', current: false, fromRelease: false }) })
    expect(verdict.ready).toBe(false)
    const text = verdict.blockers.join('\n')
    expect(text).toMatch(/0\.2\.1 is not this app’s/)
    expect(text).not.toMatch(/Upgrade it to/)
    expect(text).not.toMatch(/this build pins/)
  })

  it('leaves a version newer than the pin as it was: the readers call it unpublished, which blocks as not this app’s', async () => {
    const { verdict } = await verdictWith({ readPackState: async () => packState({ version: '9.0.0', published: false, current: false }) })
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).toMatch(/9\.0\.0 is not this app’s: this app did not publish that version/)
    expect(verdict.blockers.join('\n')).not.toMatch(/Upgrade it to/)
  })

  it('leaves an owned version newer than the pin, which the real readers cannot report, as the warning it was', async () => {
    const { verdict } = await verdictWith({ readPackState: async () => packState({ version: '9.0.0', current: false }) })
    expect(verdict.ready).toBe(true)
    expect(verdict.warnings.join('\n')).toMatch(/9\.0\.0 is installed; this build pins/)
  })

  it('warns, and does not block, when HEAD is ahead and every commit in between was read and none touches the group', async () => {
    const { verdict } = await verdictWith({ deployState: async () => ({ state: 'behind', head: 'bbb222', deployed: 'aaa111', proof: 'clear', detail: null }) })
    expect(verdict.ready).toBe(true)
    expect(verdict.warnings.join('\n')).toMatch(/not running the Leader’s HEAD \(bbb222; it runs aaa111\); every commit in between was read and none touches/)
  })

  it.each<[string, Partial<PreflightReaders>, RegExp]>([
    ['a managed group whose source has no TLS', { readPackState: async () => packState({ http: { disabled: false, port: 20005, tokenSet: true, tls: false, tlsCert: null } }) }, /does not terminate TLS/],
    ['a running sample source', { readPackState: async () => packState({ sample: { disabled: false } }) }, /sample source is running/],
    ['a group record not found', { listStreamGroupsCurrent: async () => ({ outcome: 'ok', value: [], object: '/x', status: 200, detail: null }) }, /group record for default was not found/],
    ['an unreadable group record', { listStreamGroupsCurrent: async () => ({ outcome: 'not-readable', value: null, object: '/x', status: 403, detail: 'no' }) }, /group record for default was unreadable/],
    ['hosting it cannot tell', { leaderHostname: () => null }, /Hosting could not be told/],
  ])('warns, and does not block, on %s', async (_name, over, words) => {
    const { verdict } = await verdictWith(over)
    expect(verdict.ready).toBe(true)
    expect(verdict.warnings.join('\n')).toMatch(words)
  })

  it('says nothing of Remove refusing when no global object is present, whatever is uncommitted', async () => {
    const { facts, verdict } = await verdictWith({ pendingConfigPaths: async () => ['groups/default/local/cribl/inputs.yml'] })
    expect(facts.git.globalStackFiles).toEqual([])
    expect(verdict.afterCutover.join('\n')).toMatch(/nothing for Remove to take/)
    expect(verdict.afterCutover.join('\n')).not.toMatch(/Remove will refuse/)
  })

  it('does not name a Syslog pipeline file for a Remove that takes only the Raw HTTP stack', async () => {
    const { facts } = await verdictWith({
      checkStatus: async () => ({ breaker: 'absent', pipeline: 'present', source: 'absent', route: 'absent' }),
      pendingConfigPaths: async () => ['groups/default/local/cribl/pipelines/gigamon_syslog/conf.yml'],
    })
    expect(facts.git.globalStackFiles).toEqual([])
  })

  it('says what Remove will meet afterwards: the global objects, and files it would refuse over', async () => {
    const { verdict } = await verdictWith({
      checkStatus: async () => ({ breaker: 'present', pipeline: 'present', source: 'present', route: 'unreadable' }),
      pendingConfigPaths: async () => ['groups/default/local/cribl/inputs.yml'],
    })
    expect(verdict.ready).toBe(true)
    const after = verdict.afterCutover.join('\n')
    expect(after).toMatch(/Remove will find: in_gigamon_http/)
    expect(after).toMatch(/Could not be read: gigamon_ami_http/)
    expect(after).toMatch(/Remove will refuse .*groups\/default\/local\/cribl\/inputs\.yml/)
    expect(after).toMatch(/Re-point Gigamon AMX before removing in_gigamon_http/)
  })

  it('reports each fact the runbook asks for', async () => {
    const { facts, verdict } = await verdictWith()
    const text = preflightReport(facts as PreflightFacts, verdict).join('\n')
    for (const want of [
      `${PACK_ID} ${PACK_VERSION}`, 'owned: yes', 'current: yes', 'Raw HTTP source: enabled, port 20005, TLS on, token set',
      'sample source: stopped', 'gigamon_ami: present', 'gigamon_ami_pq: present', 'gigamon_ami_sample: absent',
      'in_gigamon_http (raw-http source): absent', 'in_gigamon_syslog (syslog source): absent', 'uncommitted in default: none',
      'managed',
    ]) expect(text).toContain(want)
  })
})

// ── The Parquet route (owner decision 2026-09-25, `fix/preflight-rules-route`) ─
// The route that writes gigamon_ami_pq is found by its OUTPUT, never by id, and
// must run the pipeline that removes _raw.

describe('the Parquet route', () => {
  const table = (edit: (routes: Record<string, unknown>[]) => Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    packRoutesOf(200, routesBody(edit, extra))
  const withTable = (routeTable: PackRoute[] | null, over: Partial<PackState> = {}) =>
    verdictWith({ readPackState: async () => packState({ routeTable, ...over }) })

  it('passes on the routes the pack ships', async () => {
    expect(parquetRouteBlockers('default', shippedRoutes(), shippedOutputs())).toEqual([])
    const { verdict } = await withTable(shippedRoutes())
    expect(verdict.ready).toBe(true)
  })

  it('finds the route by its output: a renamed route on the shipped pipeline passes, verdict and all', async () => {
    const t = table((rs) => rs.map((r) => (toParquet(r) ? { ...r, id: 'my_pq_route', name: 'my_pq_route' } : r)))
    expect(parquetRouteBlockers('default', t, shippedOutputs())).toEqual([])
    // The shipped route's id reads absent, as readPackState would read it; the
    // route check has found a correct route by its output, so that id's
    // absence is a fact in the report, not a blocker.
    const pack = packState({ routeTable: t })
    pack.objects.routes = { ...pack.objects.routes, gigamon_ami_http_to_parquet: 'absent' }
    const { facts, verdict } = await verdictWith({ readPackState: async () => pack })
    expect(verdict.blockers).toEqual([])
    expect(verdict.ready).toBe(true)
    expect(preflightReport(facts as PreflightFacts, verdict).join('\n')).toContain('objects not present: gigamon_ami_http_to_parquet (absent)')
  })

  it('still blocks on another shipped route missing by id', async () => {
    const pack = packState()
    pack.objects.routes = { ...pack.objects.routes, gigamon_ami_http_to_json: 'absent' }
    const { verdict } = await verdictWith({ readPackState: async () => pack })
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).toMatch(/route gigamon_ami_http_to_json is missing from default/)
  })

  it('blocks on the Parquet route missing by id when no route writes the Parquet copy', async () => {
    const pack = packState({ routeTable: table((rs) => rs.filter((r) => !toParquet(r))) })
    pack.objects.routes = { ...pack.objects.routes, gigamon_ami_http_to_parquet: 'absent' }
    const { verdict } = await verdictWith({ readPackState: async () => pack })
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).toMatch(/route gigamon_ami_http_to_parquet is missing from default/)
    expect(verdict.blockers.join('\n')).toMatch(/No enabled route in the pack writes gigamon_ami_pq/)
  })

  // A destination is a route into the Parquet copy by the DATASET it writes,
  // not only by the shipped destination's id.
  const extraPq = { id: 'my_pq_lake', type: 'cribl_lake', destPath: 'gigamon_ami_pq', format: 'parquet' }
  const withBoth = (routeTable: PackRoute[] | null, outputTable: PackOutput[] | null) =>
    verdictWith({ readPackState: async () => packState({ routeTable, outputTable }) })

  it.each<[string, PackRoute[] | null, PackOutput[] | null, RegExp[]]>([
    ['a second destination writing gigamon_ami_pq, routed through gigamon_ami_normalize',
      table((rs) => [{ id: 'mine', name: 'mine', disabled: false, final: false, pipeline: PACK_PIPELINE_ID, output: 'my_pq_lake' }, ...rs]),
      packOutputsOf(200, outputsBody([extraPq])),
      [/Route mine writes gigamon_ami_pq \(destination my_pq_lake\) through gigamon_ami_normalize, not gigamon_ami_normalize_parquet/, /would keep _raw/]],
    ['an enabled route into a router destination',
      table((rs) => [{ id: 'fan', name: 'fan', disabled: false, final: false, pipeline: PACK_PIPELINE_ID, output: 'my_router' }, ...rs]),
      packOutputsOf(200, outputsBody([{ id: 'my_router', type: 'router', rules: [{ output: PACK_PARQUET_OUTPUT_ID }] }])),
      [/Route fan sends to my_router, a router destination, which forwards to other destinations/, /_raw/]],
    ['an enabled route into the default destination',
      table((rs) => [{ id: 'dflt', name: 'dflt', disabled: false, final: false, pipeline: PACK_PIPELINE_ID, output: 'default' }, ...rs]),
      packOutputsOf(200, outputsBody([{ id: 'default', type: 'default', defaultId: PACK_PARQUET_OUTPUT_ID }])),
      [/Route dflt sends to default, a default destination/]],
    ['an enabled route into a destination the pack does not list',
      table((rs) => [{ id: 'ghost', name: 'ghost', disabled: false, final: false, pipeline: PACK_PIPELINE_ID, output: 'nowhere' }, ...rs]),
      shippedOutputs(),
      [/Route ghost sends to nowhere, which is not in the pack’s destination list/]],
    ['an enabled route that names no destination',
      table((rs) => [{ id: 'bare', name: 'bare', disabled: false, final: false, pipeline: PACK_PIPELINE_ID }, ...rs]),
      shippedOutputs(),
      [/Route bare names no destination/]],
    ['an unreadable destination list', shippedRoutes(), null,
      [/destinations in default could not be read/, /_raw/]],
  ])('blocks on %s', async (_name, routeTable, outputTable, words) => {
    const { verdict } = await withBoth(routeTable, outputTable)
    expect(verdict.ready).toBe(false)
    for (const w of words) expect(verdict.blockers.join('\n')).toMatch(w)
  })

  it('passes a second destination writing gigamon_ami_pq when its route runs the shipped pipeline, and ignores disabled routes elsewhere', async () => {
    const t = table((rs) => [
      { id: 'mine', name: 'mine', disabled: false, final: false, pipeline: PACK_PARQUET_PIPELINE_ID, output: 'my_pq_lake' },
      { id: 'off', name: 'off', disabled: true, final: false, pipeline: PACK_PIPELINE_ID, output: 'nowhere' },
      ...rs,
    ])
    const o = packOutputsOf(200, outputsBody([extraPq]))
    expect(parquetRouteBlockers('default', t, o)).toEqual([])
    const { verdict } = await withBoth(t, o)
    expect(verdict.ready).toBe(true)
  })

  it('reads a destination’s dataset from destPath, else datasetId, and a refused list as unreadable', () => {
    expect(packOutputsOf(403, {})).toBeNull()
    expect(packOutputsOf(200, { nope: 1 })).toBeNull()
    expect(packOutputsOf(200, { items: [{ id: 'a', type: 'cribl_lake', datasetId: 'gigamon_ami_pq' }, { type: 'x' }] })).toEqual([
      { id: 'a', type: 'cribl_lake', dataset: 'gigamon_ami_pq' },
    ])
  })

  it.each<[string, PackRoute[] | null, RegExp[]]>([
    ['the Parquet route edited to gigamon_ami_normalize',
      table((rs) => rs.map((r) => (toParquet(r) ? { ...r, pipeline: PACK_PIPELINE_ID } : r))),
      [/Route gigamon_ami_http_to_parquet writes gigamon_ami_pq through gigamon_ami_normalize, not gigamon_ami_normalize_parquet/, /would keep _raw/]],
    ['the Parquet route disabled',
      table((rs) => rs.map((r) => (toParquet(r) ? { ...r, disabled: true } : r))),
      [/No enabled route in the pack writes gigamon_ami_pq \(destination gigamon_ami_parquet_lake\); found only gigamon_ami_http_to_parquet, disabled/, /_raw/]],
    ['the Parquet route in a disabled route group',
      table((rs) => rs.map((r) => (toParquet(r) ? { ...r, groupId: 'g1' } : r)), { groups: { g1: { name: 'g1', disabled: true } } }),
      [/No enabled route in the pack writes gigamon_ami_pq/]],
    ['no route into the Parquet destination',
      table((rs) => rs.filter((r) => !toParquet(r))),
      [/No enabled route in the pack writes gigamon_ami_pq .*no route names that destination/]],
    ['a route with no pipeline',
      table((rs) => rs.map((r) => (toParquet(r) ? { ...r, pipeline: undefined } : r))),
      [/through no pipeline/, /would keep _raw/]],
    ['two routes into gigamon_ami_pq, one on another pipeline',
      table((rs) => [...rs, { ...rs.find(toParquet), id: 'extra_pq', name: 'extra_pq', pipeline: 'passthru' }]),
      [/Route extra_pq writes gigamon_ami_pq through passthru/, /2 enabled routes write it; every one must run gigamon_ami_normalize_parquet/, /would keep _raw/]],
    ['an enabled route that picks its destination by expression',
      table((rs) => [...rs, { id: 'expr', name: 'expr', disabled: false, enableOutputExpression: true, outputExpression: "'gigamon_ami_parquet_lake'", pipeline: 'passthru' }]),
      [/Route expr chooses its destination by expression/]],
    ['an unreadable routing table', null, [/routing table in default could not be read/, /keeps _raw/]],
  ])('blocks on %s, saying what it found', async (_name, routeTable, words) => {
    const { verdict } = await withTable(routeTable)
    expect(verdict.ready).toBe(false)
    expect(verdict.target).toBeNull()
    for (const w of words) expect(verdict.blockers.join('\n')).toMatch(w)
  })

  it('passes two routes into gigamon_ami_pq when both run the shipped pipeline', () => {
    const t = table((rs) => [...rs, { ...rs.find(toParquet), id: 'extra_pq', name: 'extra_pq' }])
    expect(parquetRouteBlockers('default', t, shippedOutputs())).toEqual([])
  })

  it('is checked only for a version that ships the Parquet pipeline; older ones are held by the version rule', async () => {
    expect(shipsParquetPipeline(PACK_VERSION)).toBe(true)
    for (const v of ['0.1.0', '0.2.0', '0.2.1']) expect(shipsParquetPipeline(v)).toBe(false)
    const { verdict } = await withTable(null, { version: '0.2.1', current: false })
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.join('\n')).not.toMatch(/routing table/)
    expect(verdict.blockers.join('\n')).toMatch(/0\.2\.1 is installed; this build pins/)
  })

  it('reads a route group’s state, an id or a name, and a refused table as unreadable', () => {
    expect(packRoutesOf(403, {})).toBeNull()
    expect(packRoutesOf(200, { nope: 1 })).toBeNull()
    // A 200 whose tables carry no routes array is a shape not understood, not an empty table.
    expect(packRoutesOf(200, { items: [{ id: 'default', routes: null }] })).toBeNull()
    expect(packRoutesOf(200, { items: [] })).toBeNull()
    expect(packRoutesOf(200, { items: [{ id: 'default', routes: [] }] })).toEqual([])
    expect(packRoutesOf(200, { items: [{ routes: [{ name: 'n', output: 'o', pipeline: 'p', groupId: 'g' }], groups: { g: { disabled: false } } }] })).toEqual([
      { id: 'n', output: 'o', pipeline: 'p', disabled: false, final: false, outputExpression: false },
    ])
  })
})
