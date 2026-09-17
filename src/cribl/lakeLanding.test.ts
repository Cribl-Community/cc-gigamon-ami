// The writers, and the two things that have to be true of every one of them.
//
//   NOTHING IS SENT BEFORE `confirm` ANSWERS TRUE. Every writer test that
//   refuses asserts on the REQUESTS MADE, not on the return value: a function
//   that PATCHed and then reported `cancelled` would pass a check of its own
//   answer and would have changed a customer's configuration. The assertion is
//   always "no write appears in `calls`".
//
//   A REFUSAL IN THE MIDDLE LEAVES A READABLE TRAIL. The gate in this app is
//   retrospective, so a Member can be refused on the commit having succeeded on
//   the PATCH, and a destination changed but not deployed is the most likely
//   real failure of this phase in a customer's hands. The step list is the only
//   thing that says so, so the half-applied cases are asserted step by step.
//
// And one thing about the reads: `readLanding` has to degrade PER ROW. On a
// healthy workspace every row resolves and a per-panel state machine is
// indistinguishable from a per-row one, so the only way to see the difference is
// to break exactly one endpoint — which is what the partial-read tests do, and
// what Preview check 1.3 does by hand with request blocking.
//
// Stubbed at `fetch`, like provision.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { destinationSpec, DEFAULT_PROFILE, FLUSH_PRESETS, type LandingProfile } from './landing'
import { LAKE_ADDRESSING, type LakeDataset } from './lake'
import {
  CAPABILITIES,
  commitAndDeployDestination,
  destinationCommitFiles,
  destinationCommitMessage,
  feedsThrough,
  LANDING_PROFILE_KEY,
  loadingLanding,
  partitionLimitsFrom,
  readLanding,
  resolveFeeds,
  setDescription,
  setRetention,
  updateDestination,
  type RowKey,
} from './lakeLanding'

const GROUP = 'default'
const DATASET_PATH = '/products/lake/lakes/default/datasets/gigamon_ami'
const DEST_PATH = `/m/${GROUP}/system/outputs/gigamon_lake`
const DEPLOY_PATH = `/products/stream/groups/${GROUP}/deploy`
const MASTER_DEPLOY_PATH = `/master/groups/${GROUP}/deploy`
const OUTPUTS_YML = `groups/${GROUP}/local/cribl/outputs.yml`

interface Call { method: string; path: string; body: unknown }

const LIVE_DESTINATION = {
  id: 'gigamon_lake',
  type: 'cribl_lake',
  destPath: 'gigamon_ami',
  format: 'json',
  storageLocationId: 'cribl_lake',
  compress: 'gzip',
  maxFileSizeMB: 5,
  maxFileOpenTimeSec: 60,
  maxFileIdleTimeSec: 15,
  onBackpressure: 'block',
  // Two keys this app has no opinion about, which is the point of them being
  // here: the PATCH is a full replacement, so anything dropped is deleted.
  environment: 'prod',
  notifications: { enabled: true },
  status: { health: 'green' },
}

/**
 * The live Lake dataset, shaped like the one measured on the workspace.
 *
 * EVERY KEY HERE EXCEPT THE TWO BEING EDITED IS A KEY A ONE-FIELD PATCH WOULD
 * DELETE if this endpoint turns out to replace rather than merge — which is the
 * whole subject of the read-modify-write tests below. `bucketName` and
 * `viewName` are verbatim from the measured body; `acceleratedFields`,
 * `searchConfig` and `cacheConnection` are the fields Phase 4 needs and the ones
 * most expensive to lose; `metrics` and `deletionStartedAt` are the two the body
 * must NOT carry back.
 */
const LIVE_DATASET = {
  id: 'gigamon_ami',
  description: 'old',
  format: 'json',
  retentionPeriodInDays: 30,
  bucketName: 'lake-example-workspace',
  viewName: 'gigamon_ami-read-view',
  httpDAUsed: false,
  acceleratedFields: ['app_name'],
  searchConfig: { searchVersion: 'v1', datatypes: ['cribl_lake'] },
  cacheConnection: { cacheRef: 'lh-1', createdAt: 1789000000000, retentionInDays: 7 },
  metrics: { currentSizeBytes: 111184359155, metricsDate: '2026-09-13' },
}

interface WorldOpts {
  /** Status (and optional body) per exact path, so one endpoint can be broken. */
  answers?: Record<string, [number, unknown]>
  /** Paths `/version/status` reports as uncommitted. */
  pending?: string[]
  /** Commit hash `/version/commit` answers with; null = "nothing to commit". */
  commit?: string | null
  /** What the dataset GET answers, before anything has been written. */
  dataset?: Record<string, unknown>
  /** What the dataset GET answers ONCE A PATCH HAS LANDED — the only way to
   *  stage the two cases a writer's post-write re-read exists for: somebody
   *  else's value being there, and the re-read itself being refused. */
  afterWrite?: [number, unknown]
  /**
   * What the dataset GET answers from the SECOND read onward, before any PATCH.
   *
   * This is the other admin. A Lake writer reads once to fill the dialog and
   * again after the answer, and everything between those two reads is time
   * somebody sat in front of a Modal — so this is the only way to stage the
   * window that used to lose their write, and the only way to prove the
   * comparison that now closes it.
   */
  betweenReads?: [number, unknown]
}

/** A workspace with the stack already there, so a test only says what differs. */
function stubWorld(opts: WorldOpts = {}): Call[] {
  const { answers = {}, pending = [OUTPUTS_YML], commit = 'abcdef1234567890', dataset = LIVE_DATASET, afterWrite, betweenReads } = opts
  const calls: Call[] = []
  let datasetPatched = false
  let datasetReads = 0

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '')
    const body = init.body == null ? undefined : (JSON.parse(String(init.body)) as unknown)
    calls.push({ method, path, body })

    const reply = (status: number, value?: unknown) => {
      const text = value === undefined ? '' : JSON.stringify(value)
      return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => text, json: async () => JSON.parse(text) as unknown }
    }

    const forced = answers[`${method} ${path}`] ?? answers[path.split('?')[0]]
    if (forced) return reply(forced[0], forced[1])

    const bare = path.split('?')[0]
    switch (`${method} ${bare}`) {
      case 'GET /products/lake/lakes/default/config':
        return reply(200, { items: [{ id: 'maxAcceleratedFieldsCount', value: 3 }] })
      case 'GET /products/lake/lakes/default/datasets':
        return reply(200, { items: [{ id: 'gigamon_ami' }] })
      case `GET ${DATASET_PATH}`:
        datasetReads += 1
        if (datasetPatched && afterWrite) return reply(afterWrite[0], afterWrite[1])
        if (datasetReads >= 2 && betweenReads) return reply(betweenReads[0], betweenReads[1])
        return reply(200, { items: [dataset] })
      case `PATCH ${DATASET_PATH}`:
        datasetPatched = true
        return reply(200, { items: [] })
      case 'GET /m/default_search/search/datasets/gigamon_ami':
        return reply(200, { items: [{ id: 'gigamon_ami', searchVersion: 'v1', lakeStorageFormat: 'json' }] })
      case `GET ${DEST_PATH}`:
        return reply(200, { items: [LIVE_DESTINATION] })
      case `PATCH ${DEST_PATH}`:
        return reply(200, { items: [] })
      case `GET /m/${GROUP}/system/inputs`:
        return reply(200, { items: [{ id: 'in_gigamon_datagen', type: 'datagen', connections: [{ output: 'gigamon_lake' }] }] })
      case `GET /m/${GROUP}/routes`:
        return reply(200, { items: [{ id: 'default', routes: [{ id: 'gigamon_ami_syslog', name: 'gigamon_ami_syslog', output: 'gigamon_lake' }, { id: 'default', output: 'devnull' }] }] })
      case 'GET /m/default_search/search/local_search':
        return reply(404, { message: 'LocalSearch is not enabled' })
      case 'GET /products/stream/groups':
        return reply(200, { items: [{ id: GROUP, name: GROUP, configVersion: 'deadbeef' }] })
      case 'GET /version/status':
        return reply(200, { items: [{ files: pending.map((p) => ({ path: p })) }] })
      case 'POST /version/commit':
        return reply(200, commit === null ? { items: [{}] } : { items: [{ commit }] })
      case `PATCH ${DEPLOY_PATH}`:
      case `PATCH ${MASTER_DEPLOY_PATH}`:
        return reply(200, { items: [] })
      default:
        // The app's own store (the audit trail). Not what these tests are about,
        // but it must not 404 its way into a console full of warnings.
        if (bare.startsWith('/kvstore/')) return reply(200, '')
        return reply(200, { items: [] })
    }
  })
  return calls
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore/'))

afterEach(() => { vi.unstubAllGlobals() })

// ── readLanding ─────────────────────────────────────────────────────────────

const ROWS: RowKey[] = ['lakeConfig', 'datasets', 'dataset', 'searchDataset', 'destination', 'inputs', 'routes', 'localSearch', 'groups']

describe('readLanding', () => {
  it('starts with nine rows that each already know which endpoint they came from', () => {
    // The read map on the panel's ⓘ claims one line per row. A row that cannot
    // name its endpoint before the response arrives cannot appear on it.
    const initial = loadingLanding()
    for (const key of ROWS) {
      expect(initial[key].state, key).toBe('loading')
      expect(initial[key].object.length, key).toBeGreaterThan(0)
    }
  })

  it('writes nothing — it runs on mount and on Retry', async () => {
    const calls = stubWorld()
    await readLanding(GROUP)
    expect(writes(calls)).toEqual([])
    expect(calls.filter((c) => c.path.startsWith('/kvstore/'))).toEqual([])
  })

  it('resolves eight rows while exactly one fails', async () => {
    // THE per-row test. On a healthy workspace this is indistinguishable from a
    // panel-level state machine, which is why the endpoint has to be broken.
    stubWorld({ answers: { [DEST_PATH]: [500, { message: 'leader unavailable' }] } })
    const state = await readLanding(GROUP)
    expect(state.destination.state).toBe('failed')
    expect(state.destination.note).toBe('leader unavailable')
    for (const key of ROWS.filter((k) => k !== 'destination')) {
      expect(state[key].state, key).not.toBe('failed')
    }
  })

  it('names the object on the row the account may not read', async () => {
    stubWorld({ answers: { [DATASET_PATH]: [403, {}] } })
    const state = await readLanding(GROUP)
    expect(state.dataset.state).toBe('unreadable')
    // The OBJECT, not "unavailable": it is exactly what an admin has to grant.
    expect(state.dataset.note).toContain('GET on /products/lake/lakes/default/datasets/gigamon_ami')
  })

  it('gives a 404 that endpoint’s own words, not a shared "not found"', async () => {
    stubWorld()
    const state = await readLanding(GROUP)
    // Local search is 404 in the default world. It is the ordinary state of most
    // tenants and must not read as a fault.
    expect(state.localSearch.state).toBe('value')
    expect(state.localSearch.value?.enabled).toBe(false)

    stubWorld({ answers: { [DATASET_PATH]: [404, {}] } })
    const absent = await readLanding(GROUP)
    expect(absent.dataset.state).toBe('absent')
    expect(absent.dataset.note).toContain('does not exist yet')
  })

  it('hands each row to onRow as it resolves, not all nine at the end', async () => {
    stubWorld()
    const seen: RowKey[] = []
    await readLanding(GROUP, { onRow: (key) => seen.push(key) })
    expect(seen.sort()).toEqual([...ROWS].sort())
  })

  it('reports a row whose request threw, without taking the other eight with it', async () => {
    // A connection that dies mid-read is not a status, so it takes a different
    // path through the client than any of the HTTP cases above.
    stubWorld()
    const real = globalThis.fetch as typeof fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/system/outputs/')) throw new TypeError('Failed to fetch')
      return real(url as unknown as RequestInfo, init)
    })
    const state = await readLanding(GROUP)
    expect(state.destination.state).toBe('failed')
    expect(state.destination.note).toContain('Failed to fetch')
    expect(ROWS.filter((k) => state[k].state === 'failed')).toEqual(['destination'])
  })
})

describe('partitionLimitsFrom', () => {
  it('says when the limit is the tenant’s and when it is the fallback', async () => {
    stubWorld()
    expect(partitionLimitsFrom(await readLanding(GROUP))).toEqual({ limits: { maxAcceleratedFieldsCount: 3 }, measured: true })

    // A refused config read is not permission to assume three.
    stubWorld({ answers: { '/products/lake/lakes/default/config': [403, {}] } })
    const fallback = partitionLimitsFrom(await readLanding(GROUP))
    expect(fallback.measured).toBe(false)
    expect(fallback.limits.maxAcceleratedFieldsCount).toBe(3)
  })
})

// ── feedsThrough ────────────────────────────────────────────────────────────

describe('resolveFeeds', () => {
  const quickconnect = [{ id: 'in_gigamon_datagen', type: 'datagen', connectedOutputs: ['gigamon_lake'] }]
  const route = [{ id: 'gigamon_ami_syslog', name: 'gigamon_ami_syslog', output: 'gigamon_lake', disabled: false }]

  it('finds a feed that is wired straight to the destination and appears in no route', () => {
    // THE measured workspace fact. A routes-only answer would report zero feeds
    // for the source that is actually writing, and a destination confirmation
    // would claim a change affects nothing.
    expect(resolveFeeds(quickconnect, [], 'gigamon_lake')).toEqual([
      { kind: 'quickconnect', id: 'in_gigamon_datagen', label: 'QuickConnect from source in_gigamon_datagen' },
    ])
  })

  it('finds both kinds at once', () => {
    expect(resolveFeeds(quickconnect, route, 'gigamon_lake').map((f) => f.kind)).toEqual(['quickconnect', 'route'])
  })

  it('ignores sources and routes pointed somewhere else', () => {
    expect(resolveFeeds([{ id: 'x', type: null, connectedOutputs: ['other'] }], [{ id: 'r', name: null, output: 'other', disabled: false }], 'gigamon_lake')).toEqual([])
  })

  it('includes a disabled route and says so, rather than filtering it out', () => {
    // It is still a feed, and it will resume. A confirmation that omitted it
    // would describe today rather than the object.
    const [feed] = resolveFeeds([], [{ ...route[0], disabled: true }], 'gigamon_lake')
    expect(feed.label).toContain('(disabled)')
  })
})

describe('feedsThrough', () => {
  it('reads both sides live and says so when it got both', async () => {
    stubWorld()
    const r = await feedsThrough(GROUP)
    expect(r.complete).toBe(true)
    expect(r.feeds.map((f) => f.kind)).toEqual(['quickconnect', 'route'])
  })

  it('reports an incomplete list as incomplete instead of a short one as complete', async () => {
    stubWorld({ answers: { [`/m/${GROUP}/system/inputs`]: [403, {}] } })
    const r = await feedsThrough(GROUP)
    expect(r.complete).toBe(false)
    expect(r.feeds.map((f) => f.kind)).toEqual(['route'])
  })
})

// ── setRetention ────────────────────────────────────────────────────────────

describe('setRetention', () => {
  const yes = () => true
  const no = () => false

  it('sends nothing at all until confirm answers true', async () => {
    const calls = stubWorld()
    const r = await setRetention(7, { current: 30, confirm: no })
    expect(writes(calls)).toEqual([])
    expect(r).toMatchObject({ cancelled: true, ok: false })
  })

  it('treats a confirm that threw, or answered anything but true, as a no', async () => {
    for (const confirm of [() => { throw new Error('dialog unmounted') }, () => undefined as unknown as boolean, async () => 'yes' as unknown as boolean]) {
      const calls = stubWorld()
      await setRetention(7, { current: 30, confirm })
      expect(writes(calls)).toEqual([])
    }
  })

  it('does not write for a no-op, and does not report one as an error', async () => {
    const calls = stubWorld()
    const r = await setRetention(30, { current: 30, confirm: yes })
    expect(writes(calls)).toEqual([])
    expect(r).toMatchObject({ noop: true, ok: true, cancelled: false })
  })

  it('refuses a value Cribl Lake would refuse without asking anybody', async () => {
    const calls = stubWorld()
    let asked = false
    const r = await setRetention(0, { current: 30, confirm: () => { asked = true; return true } })
    expect(asked).toBe(false)
    expect(writes(calls)).toEqual([])
    expect(r.ok).toBe(false)
  })

  it('tells the confirmation that a decrease is irreversible, and hands it the live size', async () => {
    stubWorld()
    const state = await readLanding(GROUP)
    let seen: { irreversible: boolean; size: number | null; date: string | null } | null = null
    await setRetention(7, {
      current: 30,
      dataset: state.dataset.value,
      confirm: (ctx) => {
        seen = { irreversible: ctx.change.irreversible, size: ctx.sizeBytes, date: ctx.metricsDate }
        return false
      },
    })
    // The size and the day it was measured come from the live read, so the
    // dialog can name the loss in this tenant's terms rather than as a literal.
    expect(seen).toEqual({ irreversible: true, size: 111184359155, date: '2026-09-13' })
  })

  it('does not call an increase irreversible', async () => {
    stubWorld()
    let irreversible: boolean | null = null
    await setRetention(90, { current: 30, confirm: (ctx) => { irreversible = ctx.change.irreversible; return false } })
    expect(irreversible).toBe(false)
  })

  it('sends the whole live dataset back with only retention changed', async () => {
    // THE TEST THIS CHANGE EXISTS FOR. Nobody has measured whether a Lake PATCH
    // merges or replaces (CAPABILITIES.datasetPatchIsPartial is null), so a body
    // carrying one field is a body that deletes everything else on the dataset
    // under one of the two readings — and A-SP23 measured exactly that on
    // `PATCH /search/saved/{id}` in this same product.
    const calls = stubWorld()
    await setRetention(90, { current: 30, confirm: yes })
    const patch = writes(calls).find((c) => c.path === DATASET_PATH)
    expect(patch?.method).toBe('PATCH')
    const body = patch?.body as Record<string, unknown>
    expect(body.retentionPeriodInDays).toBe(90)
    // Every field the read returned, back untouched.
    expect(body.acceleratedFields).toEqual(['app_name'])
    expect(body.searchConfig).toEqual({ searchVersion: 'v1', datatypes: ['cribl_lake'] })
    expect(body.cacheConnection).toEqual({ cacheRef: 'lh-1', createdAt: 1789000000000, retentionInDays: 7 })
    expect(body.bucketName).toBe('lake-example-workspace')
    expect(body.viewName).toBe('gigamon_ami-read-view')
    expect(body.description).toBe('old')
    expect(body.format).toBe('json')
    expect(body.id).toBe('gigamon_ami')
  })

  it('drops the keys Cribl computes rather than stores, and nothing else', async () => {
    const calls = stubWorld({ dataset: { ...LIVE_DATASET, deletionStartedAt: 1789000000001 } })
    await setRetention(90, { current: 30, confirm: yes })
    const body = writes(calls).find((c) => c.path === DATASET_PATH)?.body as Record<string, unknown>
    // A daily snapshot the `?includeMetrics=true` read asks for, not a stored
    // field: echoing yesterday's size back is a claim about the dataset that is
    // false by the time it lands.
    expect(body).not.toHaveProperty('metrics')
    // The deletion marker. Neither re-asserting it nor clearing it is a decision
    // a retention edit gets to make.
    expect(body).not.toHaveProperty('deletionStartedAt')
    // `httpDAUsed` looks derived too and is DELIBERATELY still here: under the
    // replacement reading a stripped key is a deleted key, so this list holds
    // only what is provably not configuration (see DATASET_READONLY_KEYS).
    expect(body).toHaveProperty('httpDAUsed')
  })

  it('reads the dataset itself rather than trusting what the panel handed it', async () => {
    // The config plane is shared. A body merged onto a snapshot from the panel's
    // last refresh writes back the stale value of every field another admin has
    // changed since — the same data loss, arriving by a longer route.
    const stale: LakeDataset = {
      id: 'gigamon_ami',
      description: 'stale',
      format: 'json',
      retentionPeriodInDays: 365,
      acceleratedFields: [],
      searchConfig: null,
      deletionStartedAt: null,
      metrics: { currentSizeBytes: 1, metricsDate: '2020-01-01' },
      raw: Object.freeze({ id: 'gigamon_ami', retentionPeriodInDays: 365 }),
    }
    const calls = stubWorld()
    let size: number | null = null
    await setRetention(90, { current: 30, dataset: stale, confirm: (ctx) => { size = ctx.sizeBytes; return true } })

    // TWO GETs BEFORE THE PATCH, not one: the first fills the dialog, the second
    // is taken after the answer and is the only thing merged onto.
    const order = calls.filter((c) => c.path.startsWith(DATASET_PATH)).map((c) => c.method)
    expect(order.slice(0, 3)).toEqual(['GET', 'GET', 'PATCH'])
    const body = writes(calls).find((c) => c.path === DATASET_PATH)?.body as Record<string, unknown>
    expect(body.acceleratedFields).toEqual(['app_name'])
    // …and the confirmation is told the size from that same read, so a decrease
    // names the loss in the numbers the write is about to act on.
    expect(size).toBe(111184359155)
  })

  it('WRITES NOTHING AT ALL when the dataset could not be read', async () => {
    // The easy bug to introduce while fixing this one, and the destructive case
    // itself: a failed read followed by a one-field PATCH. There is no fallback
    // and there must not be one.
    for (const [status, expected] of [
      [403, 'GET on /products/lake/lakes/default/datasets/gigamon_ami'],
      [404, 'no gigamon_ami dataset'],
      [500, 'could not be read'],
    ] as const) {
      const calls = stubWorld({ answers: { [DATASET_PATH]: [status, { message: 'leader unavailable' }] } })
      const r = await setRetention(90, { current: 30, confirm: yes })
      expect(writes(calls), String(status)).toEqual([])
      expect(r.ok, String(status)).toBe(false)
      expect(r.steps[0].detail, String(status)).toContain('Nothing was sent')
      expect(r.steps[0].detail, String(status)).toContain(expected)
    }
  })

  it('classifies against the live retention, not the number the panel is holding', async () => {
    // The panel thinks it is 90; Cribl says 30. Asking for 30 is a no-op about
    // the dataset, and reporting it as a change would send a PATCH for nothing.
    const calls = stubWorld()
    const r = await setRetention(30, { current: 90, confirm: yes })
    expect(r).toMatchObject({ noop: true, ok: true })
    expect(writes(calls)).toEqual([])
  })

  it('reports Cribl’s refusal as an error step rather than as success', async () => {
    const calls = stubWorld({ answers: { [`PATCH ${DATASET_PATH}`]: [403, { message: 'Not authorized or licensed to perform this action.' }] } })
    const r = await setRetention(90, { current: 30, confirm: yes })
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ status: 'error' })
    expect(r.steps[0].detail).toContain('Not authorized')
    // Two reads — the dialog's and the merge source's — and no third: a write
    // that never landed has nothing to verify, so the check does not run.
    expect(calls.filter((c) => c.method === 'GET' && c.path.startsWith(DATASET_PATH))).toHaveLength(2)
  })

  it('re-reads afterwards and reports a value somebody else wrote', async () => {
    // There is no ETag and no version on this object, so a write cannot be made
    // conditional. Re-reading is the only check available, and saying nothing
    // would report this run's optimism as the state of the workspace.
    const calls = stubWorld({ afterWrite: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 7 }] }] })
    const r = await setRetention(90, { current: 30, confirm: yes })
    // Three: the dialog's, the merge source's, and this check.
    expect(calls.filter((c) => c.method === 'GET' && c.path.startsWith(DATASET_PATH))).toHaveLength(3)
    expect(r.steps[0]).toMatchObject({ status: 'applied', raced: true })
    expect(r.steps[0].detail).toContain('7')
    expect(r.steps[0].detail).toContain('no ETag')
    // Cribl accepted the request. A race is not a failed write, and calling it
    // one would send somebody looking for a refusal that never happened.
    expect(r.ok).toBe(true)
  })

  it('says it could not confirm, rather than reporting an unverified success', async () => {
    const r = await (async () => {
      stubWorld({ afterWrite: [500, { message: 'leader unavailable' }] })
      return setRetention(90, { current: 30, confirm: yes })
    })()
    expect(r.steps[0]).toMatchObject({ status: 'applied' })
    expect(r.steps[0].raced).toBeUndefined()
    expect(r.steps[0].detail).toContain('could not re-read')
  })

  it('agrees with itself when the re-read shows what was sent', async () => {
    const r = await (async () => {
      stubWorld({ afterWrite: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 90 }] }] })
      return setRetention(90, { current: 30, confirm: yes })
    })()
    expect(r.steps[0]).toEqual({ key: 'retention', status: 'applied', detail: '30 → 90 days' })
  })
})

// ── setDescription ──────────────────────────────────────────────────────────

describe('setDescription', () => {
  it('sends nothing until confirm answers true', async () => {
    const calls = stubWorld()
    await setDescription('new words', { current: 'old', confirm: () => false })
    expect(writes(calls)).toEqual([])
  })

  it('skips a description that already says this, including one that differs only in spaces', async () => {
    const calls = stubWorld()
    expect(await setDescription('  old  ', { current: 'old', confirm: () => true })).toMatchObject({ noop: true })
    expect(writes(calls)).toEqual([])
  })

  it('refuses an empty description', async () => {
    const calls = stubWorld()
    expect((await setDescription('   ', { current: 'old', confirm: () => true })).ok).toBe(false)
    expect(writes(calls)).toEqual([])
  })

  it('sends the whole live dataset back with only the description changed', async () => {
    // The field is cosmetic; the body it rides in is not. Under the replacement
    // reading of this endpoint a one-field `{description}` PATCH is the cheapest
    // way to delete a dataset's retention and partitions — which would make the
    // safest-looking button on the panel the most dangerous one.
    const calls = stubWorld()
    await setDescription('new words', { current: 'old', confirm: () => true })
    const body = writes(calls).find((c) => c.path === DATASET_PATH)?.body as Record<string, unknown>
    expect(body.description).toBe('new words')
    expect(body.retentionPeriodInDays).toBe(30)
    expect(body.acceleratedFields).toEqual(['app_name'])
    expect(body.searchConfig).toEqual({ searchVersion: 'v1', datatypes: ['cribl_lake'] })
    expect(body).not.toHaveProperty('metrics')
  })

  it('writes nothing when the dataset could not be read', async () => {
    const calls = stubWorld({ answers: { [DATASET_PATH]: [403, {}] } })
    const r = await setDescription('new words', { current: 'old', confirm: () => true })
    expect(writes(calls)).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.steps[0].detail).toContain('Nothing was sent')
  })

  it('skips against the LIVE description, not the one the panel is holding', async () => {
    const calls = stubWorld()
    // Cribl says 'old' and the panel thinks it says something else. "Already says
    // this" has to be a fact about the dataset rather than about this session.
    expect(await setDescription('old', { current: 'something else', confirm: () => true })).toMatchObject({ noop: true })
    expect(writes(calls)).toEqual([])
  })

  it('reports a description somebody else wrote between the change and the re-read', async () => {
    const r = await (async () => {
      stubWorld({ afterWrite: [200, { items: [{ ...LIVE_DATASET, description: 'theirs' }] }] })
      return setDescription('new words', { current: 'old', confirm: () => true })
    })()
    expect(r.steps[0]).toMatchObject({ status: 'applied', raced: true })
    expect(r.steps[0].detail).toContain('theirs')
    expect(r.ok).toBe(true)
  })
})

// ── The window between the dialog and the write ─────────────────────────────
//
// THE DEFECT THESE TESTS EXIST FOR was introduced by the commit that made these
// two writers read-modify-write, and it was worse than the one that change
// closed. The sequence was GET → confirm → merge onto the GET → PATCH, and the
// confirmation is a Modal a person answers at their own pace — minutes, for a
// retention decrease, which additionally requires typing the dataset id. So the
// body merged onto was the dataset as it looked before the dialog opened, and
// anybody else's edit to `description`, `acceleratedFields`, `searchConfig` or
// the storage binding in that interval was written back over, silently, with a
// success toast.
//
// Every test below stages the other admin with `betweenReads`, which is the only
// way to see any of this: with one admin, a stale merge and a fresh one produce
// identical bodies, which is exactly why the defect survived a green suite.
//
// AND ONE THING TO READ BEFORE LOOKING FOR A TEST THAT IS NOT HERE. When a write
// DOES proceed, "merged from the second read" and "merged from the first" are
// byte-identical by construction: the comparison covers precisely the keys the
// PATCH body carries — both go through `applyDatasetEdit`, so both drop the same
// server-derived keys and overlay the same edit — so any difference that could
// distinguish them is a difference that blocks the write. The observable
// guarantee is therefore the pair below: a second GET happens after the answer
// and before the PATCH, and ANY difference between the two reads stops it.

describe('the stale-merge window', () => {
  const yes = () => true

  it('reads again after the answer, and that read is what the PATCH is built from', async () => {
    const calls = stubWorld()
    await setRetention(90, { current: 30, confirm: yes })
    // GET (fills the dialog) · GET (the merge source) · PATCH · GET (the check).
    expect(calls.filter((c) => c.path.startsWith(DATASET_PATH)).map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH', 'GET'])
    const body = writes(calls).find((c) => c.path === DATASET_PATH)?.body as Record<string, unknown>
    expect(body.retentionPeriodInDays).toBe(90)
    expect(body.acceleratedFields).toEqual(['app_name'])
  })

  it('spends no second read on a refusal', async () => {
    // The re-read is the merge source, and a cancelled write has nothing to
    // merge. One GET, and it is the one that filled the dialog.
    const calls = stubWorld()
    await setRetention(90, { current: 30, confirm: () => false })
    expect(calls.filter((c) => c.path.startsWith(DATASET_PATH))).toHaveLength(1)
  })

  it('BLOCKS THE WRITE when anything else moved while the dialog was open, and says what moved', async () => {
    // Admin B changed the description while A was reading the retention dialog.
    // A's approval was for a dataset that no longer exists, so it is not applied
    // to this one — silently re-merging and proceeding would spend their consent
    // on a different change than the one they read.
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, description: 'B was here' }] }] })
    const r = await setRetention(90, { current: 30, confirm: yes })
    expect(writes(calls)).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ key: 'retention', status: 'error' })
    expect(r.steps[0].detail).toContain('Nothing was sent')
    // Named, with BOTH values: "it changed" is not actionable until you can see
    // what it changed to.
    expect(r.steps[0].detail).toContain('description')
    expect(r.steps[0].detail).toContain('"old"')
    expect(r.steps[0].detail).toContain('"B was here"')
  })

  it('blocks on a key it has never heard of, and on one that disappeared', async () => {
    // Under the replacement reading of this endpoint, a key this app does not
    // recognise is exactly the key a stale merge would delete.
    const { acceleratedFields: _dropped, ...withoutPartitions } = LIVE_DATASET
    for (const moved of [{ ...LIVE_DATASET, somethingCriblAddedLater: 42 }, withoutPartitions]) {
      const calls = stubWorld({ betweenReads: [200, { items: [moved] }] })
      const r = await setRetention(90, { current: 30, confirm: yes })
      expect(writes(calls)).toEqual([])
      expect(r.ok).toBe(false)
    }
  })

  it('does not call the edited field a conflict — the same value from somebody else is a no-op', async () => {
    // B set retention to 90 while A was deciding to set it to 90. There is
    // nothing to lose and nothing to refuse.
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 90 }] }] })
    const r = await setRetention(90, { current: 30, confirm: yes })
    const body = writes(calls).find((c) => c.path === DATASET_PATH)?.body as Record<string, unknown>
    expect(body?.retentionPeriodInDays).toBe(90)
    expect(r.ok).toBe(true)
  })

  it('does not block on a field Cribl recomputes on its own', async () => {
    // `metrics` is a daily server-computed snapshot the read asks for, not
    // stored configuration. Refusing on it would refuse every write on a busy
    // dataset, which trains people to distrust the refusal that matters.
    const calls = stubWorld({
      betweenReads: [200, { items: [{ ...LIVE_DATASET, metrics: { currentSizeBytes: 999, metricsDate: '2026-09-17' } }] }],
    })
    await setRetention(90, { current: 30, confirm: yes })
    const patch = writes(calls).find((c) => c.path === DATASET_PATH)
    expect(patch).toBeDefined()
    expect(patch!.body).not.toHaveProperty('metrics')
  })

  it('SENDS NOTHING when the second read fails, and never falls back to the first', async () => {
    // The first read succeeded, so the first read's body is sitting right there.
    // Merging onto it is the destructive case this whole sequence exists to
    // prevent, arriving as a convenience.
    for (const status of [403, 500]) {
      const calls = stubWorld({ betweenReads: [status, { message: 'leader unavailable' }] })
      const r = await setRetention(90, { current: 30, confirm: yes })
      expect(writes(calls), String(status)).toEqual([])
      expect(r.ok, String(status)).toBe(false)
      expect(r.steps[0].detail, String(status)).toContain('Nothing was sent')
    }
  })

  it('closes the same window on the description, which rides in the same body', async () => {
    // The field is cosmetic; the body carries retention, partitions and the
    // storage binding. A typo fix must not revert somebody's retention change.
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 7 }] }] })
    const r = await setDescription('new words', { current: 'old', confirm: yes })
    expect(writes(calls)).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.steps[0].detail).toContain('retentionPeriodInDays')

    const clean = stubWorld()
    await setDescription('new words', { current: 'old', confirm: yes })
    expect(clean.filter((c) => c.path.startsWith(DATASET_PATH)).map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH', 'GET'])
  })

  it('leaves the post-write race check doing its own, different job', async () => {
    // Two checks, two windows. This one is AFTER the PATCH, it never blocks
    // anything, and it reports rather than refuses — the write already landed.
    const calls = stubWorld({ afterWrite: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 7 }] }] })
    const r = await setRetention(90, { current: 30, confirm: yes })
    expect(writes(calls).some((c) => c.path === DATASET_PATH)).toBe(true)
    expect(r.steps[0]).toMatchObject({ status: 'applied', raced: true })
    expect(r.ok).toBe(true)
  })
})

// ── updateDestination ───────────────────────────────────────────────────────

const balanced: LandingProfile = { ...DEFAULT_PROFILE, flush: FLUSH_PRESETS.balanced }

describe('updateDestination', () => {
  it('sends nothing until confirm answers true — not even the commit', async () => {
    const calls = stubWorld()
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => false })
    expect(writes(calls)).toEqual([])
    expect(r.cancelled).toBe(true)
  })

  it('recognises a no-op and never opens the dialog for it', async () => {
    const calls = stubWorld()
    let asked = false
    // DEFAULT_PROFILE is the near-live preset, which is what the live
    // destination already says.
    const r = await updateDestination(GROUP, destinationSpec(DEFAULT_PROFILE), { confirm: () => { asked = true; return true } })
    expect(asked).toBe(false)
    expect(r).toMatchObject({ noop: true, ok: true })
    expect(writes(calls)).toEqual([])
  })

  it('computes the diff from a read it makes itself, not from what the panel had', async () => {
    const calls = stubWorld()
    await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => false })
    expect(calls.filter((c) => c.method === 'GET' && c.path === DEST_PATH)).toHaveLength(1)
  })

  it('hands the confirmation the diff, both feeds and the pending files', async () => {
    stubWorld({ pending: [OUTPUTS_YML, `groups/${GROUP}/local/cribl/inputs.yml`] })
    let ctx: { keys: string[]; feeds: string[]; complete: boolean; pending: string[] } | null = null
    await updateDestination(GROUP, destinationSpec(balanced), {
      confirm: (c) => {
        ctx = { keys: c.diff.map((d) => d.key), feeds: c.feeds.map((f) => f.kind), complete: c.feedsComplete, pending: c.pendingFiles }
        return false
      },
    })
    expect(ctx!.keys).toContain('maxFileSizeMB')
    expect(ctx!.feeds).toEqual(['quickconnect', 'route'])
    expect(ctx!.complete).toBe(true)
    // Every pending change, not only ours — the commit carries them.
    expect(ctx!.pending).toHaveLength(2)
  })

  it('sends the live body back with only the edited keys changed', async () => {
    const calls = stubWorld()
    await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    const body = writes(calls).find((c) => c.path === DEST_PATH)?.body as Record<string, unknown>
    // A destination PATCH is a full replacement, so anything missing here is a
    // field this app has just deleted from a customer's configuration.
    expect(body.environment).toBe('prod')
    expect(body.notifications).toEqual({ enabled: true })
    expect(body.maxFileSizeMB).toBe(32)
    expect(body.maxFileOpenTimeSec).toBe(120)
    // Server-computed, never written back.
    expect(body).not.toHaveProperty('status')
  })

  it('commits an explicit file list scoped to this group, then deploys the hash', async () => {
    const calls = stubWorld({ pending: [OUTPUTS_YML, 'groups/other/local/cribl/outputs.yml'] })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    const commit = writes(calls).find((c) => c.path === '/version/commit')
    // Never an empty list: the commit API commits every pending change in the
    // repository when given none.
    expect(commit).toBeDefined()
    expect((commit!.body as { files: string[] }).files).toEqual([OUTPUTS_YML])
    expect(writes(calls).some((c) => c.path === DEPLOY_PATH)).toBe(true)
    expect(r.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['destination:applied', 'commit:applied', 'deploy:applied'])
  })

  it('does not commit when the PATCH was refused', async () => {
    const calls = stubWorld({ answers: { [`PATCH ${DEST_PATH}`]: [403, { message: 'nope' }] } })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    expect(writes(calls).some((c) => c.path === '/version/commit')).toBe(false)
    expect(r.steps).toEqual([{ key: 'destination', status: 'error', detail: 'nope' }])
  })

  it('leaves a readable trail when the commit is refused after the PATCH landed', async () => {
    // The half-applied state: the destination is changed and the Workers are
    // still running the old configuration. Nothing else tells anybody that.
    const calls = stubWorld({ answers: { 'POST /version/commit': [403, { message: 'Not authorized or licensed to perform this action.' }] } })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    expect(r.ok).toBe(false)
    expect(r.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['destination:applied', 'commit:error'])
    expect(writes(calls).some((c) => c.path === DEPLOY_PATH)).toBe(false)
  })

  it('leaves a readable trail when the deploy is refused after the commit landed', async () => {
    const r = await (async () => {
      stubWorld({ answers: { [`PATCH ${DEPLOY_PATH}`]: [403, { message: 'nope' }], [`PATCH ${MASTER_DEPLOY_PATH}`]: [403, { message: 'nope' }] } })
      return updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    })()
    expect(r.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['destination:applied', 'commit:applied', 'deploy:error'])
  })

  it('reports a destination it could not read, instead of PATCHing a body it guessed', async () => {
    const calls = stubWorld({ answers: { [DEST_PATH]: [403, {}] } })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    expect(r.ok).toBe(false)
    expect(writes(calls)).toEqual([])
  })
})

describe('commitAndDeployDestination', () => {
  it('falls back to the deprecated deploy path on 404 and nowhere else', async () => {
    // Only on 404, which is the one status meaning "this Leader does not have
    // that route". A 403 cannot be granted by a second path, and a 5xx deploy
    // may already have started server-side — a blind retry is a second deploy.
    const on404 = stubWorld({ answers: { [`PATCH ${DEPLOY_PATH}`]: [404, {}] } })
    await commitAndDeployDestination(GROUP, [OUTPUTS_YML], 'm')
    expect(on404.some((c) => c.path === MASTER_DEPLOY_PATH)).toBe(true)

    for (const status of [403, 500]) {
      const calls = stubWorld({ answers: { [`PATCH ${DEPLOY_PATH}`]: [status, {}] } })
      await commitAndDeployDestination(GROUP, [OUTPUTS_YML], 'm')
      expect(calls.some((c) => c.path === MASTER_DEPLOY_PATH), String(status)).toBe(false)
    }
  })

  it('does not deploy when Cribl committed nothing', async () => {
    const calls = stubWorld({ commit: null })
    const steps = await commitAndDeployDestination(GROUP, [OUTPUTS_YML], 'm')
    expect(steps).toEqual([{ key: 'commit', status: 'skipped', detail: 'Cribl committed nothing — there was no net change to write.' }])
    expect(calls.some((c) => c.path === DEPLOY_PATH)).toBe(false)
  })

  it('refuses to commit with no file list at all', async () => {
    const calls = stubWorld()
    expect((await commitAndDeployDestination(GROUP, [], 'm'))[0].status).toBe('skipped')
    expect(writes(calls)).toEqual([])
  })

  // The panel's "Retry failed only" is its own intent — the PATCH landed, the
  // commit was refused, and nothing else is writing a trail entry for the
  // recovery. Silent by default so `updateDestination`, which records these same
  // steps inside its own entry, does not report one press twice.
  it('writes no trail entry of its own unless it is asked to', async () => {
    const calls = stubWorld()
    await commitAndDeployDestination(GROUP, [OUTPUTS_YML], 'm')
    await Promise.resolve()
    expect(calls.filter((c) => c.path.startsWith('/kvstore/') && c.method !== 'GET')).toEqual([])
  })

  it('records the retry in the audit trail when it is the whole intent', async () => {
    const calls = stubWorld()
    await commitAndDeployDestination(GROUP, [OUTPUTS_YML], 'm', {}, true)
    // `audit` is fire-and-forget on purpose — a lost trail entry must not turn a
    // successful deploy into a reported failure — so the write lands a microtask
    // or two after the steps come back.
    await new Promise((r) => setTimeout(r, 0))
    const logged = calls.filter((c) => c.path.startsWith('/kvstore/') && c.method !== 'GET')
    expect(logged.length).toBe(1)
    expect(logged[0].path).toMatch(/gigamon\/log\//)
  })

  // A refusal is the reason this button was pressed; an entry that only appears
  // when the retry WORKED is a trail of successes, which is the one thing an
  // audit trail is not for.
  it('records the retry even when the commit is refused again', async () => {
    const calls = stubWorld({ answers: { 'POST /version/commit': [403, {}] } })
    const steps = await commitAndDeployDestination(GROUP, [OUTPUTS_YML], 'm', {}, true)
    expect(steps[0].status).toBe('error')
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.filter((c) => c.path.startsWith('/kvstore/') && c.method !== 'GET').length).toBe(1)
  })
})

describe('destinationCommitFiles', () => {
  it('takes this group’s outputs.yml and leaves another group’s alone', () => {
    expect(destinationCommitFiles(GROUP, [OUTPUTS_YML, 'groups/other/local/cribl/outputs.yml', `groups/${GROUP}/local/cribl/inputs.yml`])).toEqual([OUTPUTS_YML])
  })

  it('accepts a group-rooted layout, where no path carries a groups/ segment', () => {
    expect(destinationCommitFiles(GROUP, ['local/cribl/outputs.yml'])).toEqual(['local/cribl/outputs.yml'])
  })

  it('constructs a path only when Git reported nothing at all', () => {
    expect(destinationCommitFiles(GROUP, [])).toEqual([OUTPUTS_YML])
    // Git reported changes and none of them is ours: committing a constructed
    // path here would commit somebody else's work.
    expect(destinationCommitFiles(GROUP, ['groups/other/local/cribl/outputs.yml'])).toEqual([])
  })
})

describe('destinationCommitMessage', () => {
  it('says what changed to somebody reading git log who never heard of this app', () => {
    const message = destinationCommitMessage(GROUP, [{ key: 'maxFileSizeMB', kind: 'changed', before: 5, after: 32 }])
    expect(message).toContain('gigamon_lake')
    expect(message).toContain(GROUP)
    expect(message).toContain('maxFileSizeMB')
  })
})

// ── The profile document, and the flags ─────────────────────────────────────

describe('the profile document', () => {
  it('uses one of the three documented key shapes, not a fourth', () => {
    // §2.4 called it `lake_landing/profile`. CLAUDE.md documents
    // `app/settings/<name>` install-wide, `<ns>/prefs/<userId>` per viewer and
    // `<ns>/log/<epochMs>` append-only. A landing profile is a property of the
    // install, so it takes the install-wide shape that search_caps already uses.
    expect(LANDING_PROFILE_KEY).toBe('app/settings/lake_landing')
  })
})

describe('the capability flags', () => {
  it('claims to know nothing, because nobody has measured any of it', () => {
    // Setting one of these true because the spec implies it is how an inference
    // becomes a fact nothing can dislodge — and two of them, if wrong, cost a
    // customer data.
    for (const [id, capability] of Object.entries(CAPABILITIES)) {
      expect(capability.answer, id).toBeNull()
      expect(capability.question.length, id).toBeGreaterThan(60)
      expect(capability.meanwhile.length, id).toBeGreaterThan(60)
    }
  })

  it('names who would have to measure each one', () => {
    expect(CAPABILITIES.datasetPatchIsPartial.spike).toBe('Preview 3.1')
    expect(CAPABILITIES.lakeSearchConfigPropagates.spike).toBe('P-S5')
    expect(CAPABILITIES.gidPlaceholderHonoured.spike).toBe('V-S11')
  })
})

describe('addressing', () => {
  it('spells the ids the same way lake.ts does', async () => {
    // The two modules duplicate these literals so policyCoverage.test.ts can
    // resolve each call's endpoint from the file the call is in. This is the pin
    // that keeps the two copies from drifting apart.
    const calls = stubWorld()
    await setRetention(90, { current: 30, confirm: () => true })
    expect(calls.some((c) => c.path === `/products/lake/lakes/default/datasets/${LAKE_ADDRESSING.datasetId}`)).toBe(true)

    const dest = stubWorld()
    await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    expect(dest.some((c) => c.path === `/m/${GROUP}/system/outputs/${LAKE_ADDRESSING.destinationId}`)).toBe(true)
  })
})

// ── What these tests could not assert, and why ──────────────────────────────
//
//   * WHETHER A LAKE PATCH IS PARTIAL. Still unmeasured, and the tests above are
//     written so that it no longer matters: both writers GET the dataset, overlay
//     the one edited field and send the whole body, which is correct under either
//     semantics. What these tests CAN prove is that the body carries every field
//     the read returned, and that a read this app was refused sends nothing at
//     all. What they cannot prove is what a real server does with that body —
//     whether it accepts `viewName` and `cacheConnection` echoed back, whether
//     stripping `metrics` was necessary or merely harmless, and whether a no-op
//     PATCH with an identical body dirties the Leader's config. Preview 3.1 (a
//     30 → 30 no-op, then a full re-read and diff) still has to run; it is now a
//     confirmation that this app kept the dataset whole rather than the thing
//     deciding whether the phase was safe to ship.
//   * THAT `updateDestination` HAS NO STALE-MERGE WINDOW. IT STILL DOES, and no
//     test here covers it, because nothing here fixes it. It reads the
//     destination, opens the same user-paced dialog, and merges onto the
//     PRE-DIALOG body — the defect the tests above exist for, on an endpoint
//     whose PATCH is documented as a full replacement rather than merely
//     suspected of being one. Two things make it less bad and neither makes it
//     fine: the write commits and deploys, so the previous body is in the
//     group's Git history, and the diff is recomputable. Closing it needs the
//     one thing the dataset had and a Stream output does not — a measured list
//     of which keys move on their own, so a refusal cannot fire on a field
//     nobody touched. The note on that function says the same thing at the site.
//   * THAT THE RACE REPORTING CATCHES A RACE. The re-read is stubbed, so what is
//     proved is that a disagreement is surfaced rather than swallowed. A real
//     lost update needs two admins and no ETag to make it conditional on, which
//     is exactly why this app reports one instead of preventing it.
//   * THAT THE PATCHED DESTINATION STILL DELIVERS. "The body went out with the
//     right keys" is not "data still lands". A Green health chip and a dead feed
//     look identical from here; the check is a landing-lag measurement after the
//     deploy settles (Preview 3.2.5).
//   * THAT THE DEPLOY LOSES NO DATA. It restarts Worker Processes, and a source
//     with `onBackpressure: "block"` can lose seconds across that. The syslog
//     source is idle on the measured workspace, so this is untested BY
//     CONSTRUCTION there and the confirmation has to say it anyway.
//   * ANYTHING A MEMBER SEES. The gate is retrospective and every account this
//     was built against is an admin, so every refusal above is a stubbed status
//     rather than a permission actually being enforced (V-S11).
//   * THAT THE CONFIRMATION A PERSON SEES IS THE ONE THESE WRITERS ASKED FOR.
//     These tests prove the writer refuses to write until `confirm` answers
//     true. Whether the dialog wired to it names the right objects is a
//     component question, and `gatedWrites.test.ts` explicitly cannot prove the
//     button a customer presses is the gated one. Read the panel.
