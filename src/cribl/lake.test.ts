// What each of the nine reads does when Cribl does not answer the way the happy
// path assumes.
//
// The happy path is one assertion per function and is here once. Everything else
// is the four other things that can come back, because a panel row's whole job
// is to say WHICH of them happened:
//
//   404  is data on three of these endpoints and a failure on none of them. A
//        tenant with no Cribl Lake, a workspace with no Search local engines,
//        and a dataset nobody has created yet are all ordinary states, and a
//        client that raised them as errors would make most tenants look broken.
//   403  means the object exists and this account may not read it. The object
//        has to survive into the result, because it is exactly what an admin
//        would grant and "unavailable" names nothing anyone can act on.
//   5xx  and a body that is not the envelope are `failed`, with Cribl's own
//        sentence and never an invented one.
//   throw is the network going away mid-read, which must not take the other
//        eight rows with it.
//
// Stubbed at `fetch`, like provision.test.ts, so the assertions read the request
// the platform would actually have received — including the query string, which
// is where `excludeDeleted=false` lives and is the difference between "not
// created yet" and "being deleted right now".

import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAKE_DATASET } from './config'
import { LAKE_DATASET_ID, LAKE_DESTINATION_ID } from './provision'
import {
  getDataset,
  getDestination,
  getLakeConfig,
  getLocalSearch,
  getSearchDataset,
  LAKE_ADDRESSING,
  listDatasets,
  listInputs,
  listLocalEngines,
  engineState,
  servesDataset,
  listRoutes,
  listStreamGroupsCurrent,
} from './lake'

const GROUP = 'default'

interface Call { method: string; path: string }

/** Answer whatever the test says for a path prefix, and 200 `{items:[]}` for
 *  anything else — so a test only has to describe the case it is about. */
function stub(answers: Record<string, [number, unknown]>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/capi/, '')
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), path })
    const key = Object.keys(answers).find((k) => path === k || path.startsWith(`${k}?`))
    const [status, body] = key ? answers[key] : [200, { items: [] }]
    const text = body === undefined ? '' : JSON.stringify(body)
    return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => text, json: async () => JSON.parse(text) as unknown }
  })
  return calls
}

/** A fetch that never answers, for the case where the network goes away. */
function stubThrowing(): void {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch')
  })
}

afterEach(() => { vi.unstubAllGlobals() })

// ── The addressing this module spells out ───────────────────────────────────

describe('addressing', () => {
  it('spells out the same ids the rest of the app holds as constants', () => {
    // These literals exist because policyCoverage.test.ts resolves a call's
    // endpoint from this module's own top-level string constants: an imported id
    // resolves to a placeholder, and config/policies.yml would then have to
    // declare a placeholder too — widening the grant from this app's own
    // destination to any output in any worker group. This is the pin that keeps
    // the duplication honest.
    expect(LAKE_ADDRESSING.datasetId).toBe(LAKE_DATASET)
    expect(LAKE_ADDRESSING.datasetId).toBe(LAKE_DATASET_ID)
    expect(LAKE_ADDRESSING.destinationId).toBe(LAKE_DESTINATION_ID)
  })
})

// ── 1. Lake configuration ───────────────────────────────────────────────────

describe('getLakeConfig', () => {
  const PATH = '/products/lake/lakes/default/config'

  it('reads the limits out of the id/value list', async () => {
    stub({ [PATH]: [200, { items: [{ id: 'maxAcceleratedFieldsCount', value: 3 }, { id: 'other', value: 'x' }] }] })
    const r = await getLakeConfig()
    expect(r.outcome).toBe('ok')
    expect(r.value?.maxAcceleratedFieldsCount).toBe(3)
    expect(r.value?.raw.other).toBe('x')
  })

  it('reports a limit it did not find as null, never as a default', async () => {
    // A tenant that names no limit is not a tenant that allows three. The
    // fallback is applied one level up, by partitionLimitsFrom, which also says
    // it was a fallback.
    stub({ [PATH]: [200, { items: [] }] })
    expect((await getLakeConfig()).value?.maxAcceleratedFieldsCount).toBeNull()
  })

  it('calls a 404 absent, because that is how an on-prem Leader says Cribl Lake is Cloud-only', async () => {
    stub({ [PATH]: [404, { message: 'not found' }] })
    expect((await getLakeConfig()).outcome).toBe('absent')
  })

  it('names the object when the account may not read it', async () => {
    stub({ [PATH]: [403, { message: 'Not authorized or licensed to perform this action.' }] })
    const r = await getLakeConfig()
    expect(r.outcome).toBe('not-readable')
    expect(r.object).toBe(PATH)
    expect(r.detail).toContain('Not authorized')
  })

  it('reports a 500 as failed, with Cribl’s own sentence', async () => {
    stub({ [PATH]: [500, { message: 'leader unavailable' }] })
    const r = await getLakeConfig()
    expect(r.outcome).toBe('failed')
    expect(r.detail).toBe('leader unavailable')
  })

  it('survives the network going away', async () => {
    stubThrowing()
    const r = await getLakeConfig()
    expect(r.outcome).toBe('failed')
    expect(r.status).toBeNull()
    expect(r.detail).toContain('Failed to fetch')
  })
})

// ── 2 & 3. The dataset ──────────────────────────────────────────────────────

describe('listDatasets', () => {
  it('asks for deleted datasets too', async () => {
    // A dataset whose deletion has started still holds its id for a day or two.
    // Filtering it out would report "not created yet" about an id nothing can
    // create.
    const calls = stub({})
    await listDatasets()
    expect(calls[0].path).toContain('excludeDeleted=false')
    expect(calls[0].path).toContain('includeMetrics=true')
  })

  it('reads a deletion in progress rather than hiding it', async () => {
    stub({ '/products/lake/lakes/default/datasets': [200, { items: [{ id: 'gigamon_ami', deletionStartedAt: '2026-09-17T00:00:00Z' }] }] })
    expect((await listDatasets()).value?.[0].deletionStartedAt).toBe('2026-09-17T00:00:00Z')
  })
})

describe('getDataset', () => {
  const PATH = '/products/lake/lakes/default/datasets/gigamon_ami'

  it('reads retention, format, partitions and the size with the day it was computed', async () => {
    stub({
      [PATH]: [200, { items: [{ id: 'gigamon_ami', format: 'json', retentionPeriodInDays: 30, acceleratedFields: ['protocol'], metrics: { currentSizeBytes: 111184359155, metricsDate: '2026-09-13' } }] }],
    })
    const r = await getDataset()
    expect(r.value).toMatchObject({ format: 'json', retentionPeriodInDays: 30, acceleratedFields: ['protocol'] })
    // The size is never rendered without this date: Lake metrics are not live.
    expect(r.value?.metrics).toEqual({ currentSizeBytes: 111184359155, metricsDate: '2026-09-13' })
  })

  it('distinguishes a dataset with no acceleratedFields from one with an empty list', async () => {
    // Absent is the only evidence the retention no-op probe (Preview 3.1.3) can
    // give about whether a PATCH would drop the field once it exists.
    stub({ [PATH]: [200, { items: [{ id: 'gigamon_ami' }] }] })
    expect((await getDataset()).value?.acceleratedFields).toBeNull()
    stub({ [PATH]: [200, { items: [{ id: 'gigamon_ami', acceleratedFields: [] }] }] })
    expect((await getDataset()).value?.acceleratedFields).toEqual([])
  })

  it('keeps the whole body, because it is the only record of what a value was before', async () => {
    stub({ [PATH]: [200, { items: [{ id: 'gigamon_ami', searchConfig: { searchVersion: 'v1' }, somethingNew: 42 }] }] })
    expect((await getDataset()).value?.raw.somethingNew).toBe(42)
  })

  it('calls a 404 absent — the dataset has not been created yet', async () => {
    stub({ [PATH]: [404, {}] })
    expect((await getDataset()).outcome).toBe('absent')
  })

  it('does not call a 200 with no dataset in it a success', async () => {
    // Answering `ok` with a null value would put an empty row on the panel that
    // claims to have read something.
    stub({ [PATH]: [200, { items: [] }] })
    const r = await getDataset()
    expect(r.outcome).toBe('failed')
    expect(r.value).toBeNull()
  })

  it('does not crash on a body that is not the envelope', async () => {
    stub({ [PATH]: [200, 'a string'] })
    expect((await getDataset()).outcome).toBe('failed')
  })
})

// ── 4. The Search-side dataset ──────────────────────────────────────────────

describe('getSearchDataset', () => {
  const PATH = '/m/default_search/search/datasets/gigamon_ami'

  it('reads the reader version Cribl Search is actually using', async () => {
    stub({ [PATH]: [200, { items: [{ id: 'gigamon_ami', searchVersion: 'v1', lakeStorageFormat: 'json' }] }] })
    expect((await getSearchDataset()).value).toMatchObject({ searchVersion: 'v1', lakeStorageFormat: 'json' })
  })

  it('is asked separately from the Lake object, so the two can be seen to disagree', async () => {
    const calls = stub({})
    await getSearchDataset()
    expect(calls.map((c) => c.path)).toEqual([PATH])
  })

  it('treats an empty answer as absent rather than as a reader version of null', async () => {
    stub({ [PATH]: [200, { items: [] }] })
    expect((await getSearchDataset()).outcome).toBe('absent')
  })

  it('names the object on a refusal', async () => {
    stub({ [PATH]: [401, {}] })
    const r = await getSearchDataset()
    expect(r.outcome).toBe('not-readable')
    expect(r.object).toBe(PATH)
  })
})

// ── 5. The destination ──────────────────────────────────────────────────────

describe('getDestination', () => {
  const PATH = `/m/${GROUP}/system/outputs/gigamon_lake`

  it('keeps the whole body, because every edit to it is a read-modify-write', async () => {
    stub({ [PATH]: [200, { items: [{ id: 'gigamon_lake', environment: 'prod', maxFileSizeMB: 5, status: { health: 'green' } }] }] })
    const r = await getDestination(GROUP)
    expect(r.value?.raw.environment).toBe('prod')
    expect(r.value?.health).toBe('green')
  })

  it('reports the object under the :gid placeholder, which is what an admin grants', async () => {
    stub({ [PATH]: [403, {}] })
    expect((await getDestination(GROUP)).object).toBe('/m/:gid/system/outputs/gigamon_lake')
  })

  it('addresses the group it was given, not a default', async () => {
    const calls = stub({})
    await getDestination('other_group')
    expect(calls[0].path).toBe('/m/other_group/system/outputs/gigamon_lake')
  })
})

// ── 6 & 7. What writes through it ───────────────────────────────────────────

describe('listInputs', () => {
  it('reads the QuickConnect bindings off each source', async () => {
    stub({
      [`/m/${GROUP}/system/inputs`]: [200, { items: [{ id: 'in_gigamon_datagen', type: 'datagen', connections: [{ output: 'gigamon_lake' }, { pipeline: 'x' }] }] }],
    })
    expect((await listInputs(GROUP)).value?.[0].connectedOutputs).toEqual(['gigamon_lake'])
  })

  it('reads a source with no connections as connected to nothing', async () => {
    stub({ [`/m/${GROUP}/system/inputs`]: [200, { items: [{ id: 'in_syslog' }] }] })
    expect((await listInputs(GROUP)).value?.[0].connectedOutputs).toEqual([])
  })
})

describe('listRoutes', () => {
  it('reads the routes out of the group’s one routing table', async () => {
    stub({ [`/m/${GROUP}/routes`]: [200, { items: [{ id: 'default', routes: [{ id: 'gigamon_ami_syslog', name: 'gigamon_ami_syslog', output: 'gigamon_lake' }, { id: 'default', output: 'devnull' }] }] }] })
    const r = await listRoutes(GROUP)
    expect(r.value?.map((x) => x.output)).toEqual(['gigamon_lake', 'devnull'])
  })

  it('answers an empty list for a table with no routes, not a failure', async () => {
    stub({ [`/m/${GROUP}/routes`]: [200, { items: [{ id: 'default' }] }] })
    expect(await listRoutes(GROUP)).toMatchObject({ outcome: 'ok', value: [] })
  })

  it('carries the disabled flag, because a switched-off route is still a feed', async () => {
    stub({ [`/m/${GROUP}/routes`]: [200, { items: [{ routes: [{ id: 'r', output: 'gigamon_lake', disabled: true }] }] }] })
    expect((await listRoutes(GROUP)).value?.[0].disabled).toBe(true)
  })
})

// ── 8. The acceleration tier ────────────────────────────────────────────────

describe('getLocalSearch', () => {
  const PATH = '/m/default_search/search/local_search'

  it('reports a 404 as a VALUE — not provisioned is the normal state of most tenants', async () => {
    stub({ [PATH]: [404, { message: 'LocalSearch is not enabled' }] })
    const r = await getLocalSearch()
    expect(r.outcome).toBe('ok')
    expect(r.value).toEqual({ enabled: false, engines: 0, records: [], enginesStatus: 200, raw: null })
  })

  it('counts the engines once local search says it exists', async () => {
    stub({ [PATH]: [200, { items: [{ id: 'ls' }] }], [`${PATH}/engines`]: [200, { items: [{ id: 'e1' }, { id: 'e2' }] }] })
    expect((await getLocalSearch()).value).toMatchObject({ enabled: true, engines: 2 })
  })

  it('asks for engines even when local search 404s, because that answer is not a 404', async () => {
    // THIS TEST USED TO PIN THE OPPOSITE, and the reasoning was wrong rather
    // than the code. It skipped the engine list on a 404 to avoid "a second row
    // of noise" — but the engine list does not 404 in that state. Measured
    // 2026-09-22: it answers 200 with an empty list. So the skipped call was the
    // only thing that separates "local search is on and nothing is sized" from
    // "local search is not on this tenant", and skipping it threw that away.
    const calls = stub({ [PATH]: [404, {}] })
    await getLocalSearch()
    expect(calls.map((c) => c.path).sort()).toEqual([PATH, `${PATH}/engines`])
  })

  it('carries the engine records, because a COUNT cannot tell provisioning from ready', async () => {
    // The defect this widening exists for. On 2026-09-22 a provisioning engine
    // and a ready one both reported "enabled, 1 engine" — the same two fields,
    // the same values, two different facts about the workspace.
    const provisioning = { id: 'e1', status: 'provisioning', effectiveStatus: 'provisioning', datasets: [] }
    const ready = { id: 'e1', status: 'ready', effectiveStatus: 'ready', datasets: ['main', 'metrics'] }

    stub({ [PATH]: [200, { items: [{}] }], [`${PATH}/engines`]: [200, { items: [provisioning] }] })
    const mid = (await getLocalSearch()).value!
    stub({ [PATH]: [200, { items: [{}] }], [`${PATH}/engines`]: [200, { items: [ready] }] })
    const done = (await getLocalSearch()).value!

    expect(mid.engines, 'the count is the same in both states — that is the bug').toBe(done.engines)
    expect(engineState(mid.records)).toBe('provisioning')
    expect(engineState(done.records)).toBe('ready')
  })

  it('reports whether an engine serves a given dataset, which "1 engine" cannot', async () => {
    // A Search local engine serves the local_search ingest datasets; a Lakehouse
    // is what accelerates a Lake dataset. Measured: this engine serves
    // ['main','metrics'] and a gigamon_ami query still reports cacheStatus
    // "miss", reason "No Lakehouse Configured".
    const ready = { id: 'e1', status: 'ready', effectiveStatus: 'ready', datasets: ['main', 'metrics'] }
    stub({ [PATH]: [200, { items: [{}] }], [`${PATH}/engines`]: [200, { items: [ready] }] })
    const v = (await getLocalSearch()).value!

    expect(servesDataset(v.records, 'main')).toBe(true)
    expect(servesDataset(v.records, 'gigamon_ami')).toBe(false)
  })

  it('separates an unreadable engine list from an empty one', async () => {
    // engines:null and records:[] is "this app does not know"; engines:0 with
    // records:[] is "it looked, and there are none". A single count conflates them.
    stub({ [PATH]: [200, { items: [{}] }], [`${PATH}/engines`]: [403, {}] })
    const denied = (await getLocalSearch()).value!
    expect(denied.engines).toBeNull()
    expect(denied.records).toEqual([])
    expect(denied.enginesStatus).toBe(403)

    stub({ [PATH]: [200, { items: [{}] }], [`${PATH}/engines`]: [200, { items: [] }] })
    const empty = (await getLocalSearch()).value!
    expect(empty.engines).toBe(0)
    expect(empty.enginesStatus).toBe(200)
  })

  it('answers null engines, not zero, when the engine list could not be read', async () => {
    // Zero because a second call was refused would be a number this app made up.
    stub({ [PATH]: [200, { items: [{}] }], [`${PATH}/engines`]: [403, {}] })
    expect((await getLocalSearch()).value).toMatchObject({ enabled: true, engines: null })
  })

  it('reports enabled with zero engines as its own state', async () => {
    stub({ [PATH]: [200, { items: [{}] }], [`${PATH}/engines`]: [200, { items: [] }] })
    expect((await getLocalSearch()).value).toMatchObject({ enabled: true, engines: 0 })
  })

  it('reports a refusal of local_search itself as not-readable, which is not the same as absent', async () => {
    stub({ [PATH]: [403, {}] })
    expect((await getLocalSearch()).outcome).toBe('not-readable')
  })
})

describe('listLocalEngines', () => {
  it('treats its own 404 as an empty list', async () => {
    stub({ '/m/default_search/search/local_search/engines': [404, {}] })
    expect(await listLocalEngines()).toMatchObject({ outcome: 'ok', value: [] })
  })
})

// ── 9. The Stream groups ────────────────────────────────────────────────────

describe('listStreamGroupsCurrent', () => {
  it('reads the commit each group is running — the target a rollback needs a name for', async () => {
    stub({ '/products/stream/groups': [200, { items: [{ id: 'default', name: 'default', configVersion: 'abc123', onPrem: false }] }] })
    expect((await listStreamGroupsCurrent()).value?.[0]).toEqual({ id: 'default', name: 'default', configVersion: 'abc123', onPrem: false })
  })

  it('falls back to the id when a group has no name, and reports no configVersion as null', async () => {
    stub({ '/products/stream/groups': [200, { items: [{ id: 'g2' }] }] })
    expect((await listStreamGroupsCurrent()).value?.[0]).toMatchObject({ name: 'g2', configVersion: null })
  })

  it('does not fall back to the deprecated path — that is Guided Setup’s picker, not this read', async () => {
    const calls = stub({ '/products/stream/groups': [404, {}] })
    expect((await listStreamGroupsCurrent()).outcome).toBe('absent')
    expect(calls.map((c) => c.path)).toEqual(['/products/stream/groups'])
  })
})

// ── Every read, once, against the same three failures ───────────────────────

describe('every read handles a refusal the same way', () => {
  const reads: Array<[string, () => Promise<{ outcome: string; object: string; detail: string | null }>]> = [
    ['getLakeConfig', () => getLakeConfig()],
    ['listDatasets', () => listDatasets()],
    ['getDataset', () => getDataset()],
    ['getSearchDataset', () => getSearchDataset()],
    ['getDestination', () => getDestination(GROUP)],
    ['listInputs', () => listInputs(GROUP)],
    ['listRoutes', () => listRoutes(GROUP)],
    ['listLocalEngines', () => listLocalEngines()],
    ['listStreamGroupsCurrent', () => listStreamGroupsCurrent()],
  ]

  it('names the object it could not read, on every one of them', async () => {
    for (const [name, run] of reads) {
      vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, statusText: '', text: async () => '{}', json: async () => ({}) }))
      const r = await run()
      expect(r.outcome, name).toBe('not-readable')
      expect(r.object.length, name).toBeGreaterThan(0)
    }
  })

  it('never throws, on any of them', async () => {
    for (const [name, run] of reads) {
      stubThrowing()
      await expect(run(), name).resolves.toMatchObject({ outcome: 'failed' })
    }
  })
})

// ── What these tests could not assert, and why ──────────────────────────────
//
//   * THAT ANY OF THESE ENDPOINTS ANSWERS THIS SHAPE. Every body above is
//     transcribed from the spec and from one measured workspace. A real tenant
//     on a different Cribl version can answer a shape none of this anticipates,
//     and the only thing that would catch it is opening the panel installed.
//   * THAT 404 MEANS WHAT THIS FILE SAYS IT MEANS on `local_search`. The
//     "LocalSearch is not enabled" body was read once, on one workspace. A
//     tenant that 404s that path for a different reason is reported here as
//     "not provisioned", confidently and wrongly.
//   * THAT THE :gid PLACEHOLDER IS MATCHED the way `getDestination` assumes when
//     the platform evaluates config/policies.yml. Every caller on the measured
//     workspace was an admin, and an admin never exercises the matcher (V-S11).
