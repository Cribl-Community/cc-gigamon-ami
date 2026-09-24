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
  commitScopeAfterConfirm,
  destinationCommitFiles,
  destinationCommitMessage,
  feedsThrough,
  LANDING_PROFILE_KEY,
  loadingLanding,
  partitionLimitsFrom,
  pendingConfigFiles,
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
  /**
   * What `/version/status` reports ONCE THE DESTINATION PATCH HAS LANDED.
   *
   * The whole point of the fix this stages: a Git status taken before the PATCH
   * cannot report `outputs.yml`, because the write that dirties it has not been
   * sent. Real Cribl answers differently on either side of that 200, and until
   * the commit list was moved after the write this app only ever asked on the
   * side that could not see its own change.
   */
  pendingAfterWrite?: string[]
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
  /** The same, for the DESTINATION GET: what it answers from the second read
   *  onward. `updateDestination` reads once to compute the diff the dialog shows
   *  and again after the answer, so this is the other admin on that object. */
  destBetweenReads?: [number, unknown]
}

/** A workspace with the stack already there, so a test only says what differs. */
function stubWorld(opts: WorldOpts = {}): Call[] {
  const { answers = {}, pending = [OUTPUTS_YML], pendingAfterWrite, commit = 'abcdef1234567890', dataset = LIVE_DATASET, afterWrite, betweenReads, destBetweenReads } = opts
  const calls: Call[] = []
  let datasetPatched = false
  let destPatched = false
  let datasetReads = 0
  let destReads = 0

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
        destReads += 1
        if (destReads >= 2 && destBetweenReads) return reply(destBetweenReads[0], destBetweenReads[1])
        return reply(200, { items: [LIVE_DESTINATION] })
      case `PATCH ${DEST_PATH}`:
        destPatched = true
        return reply(200, { items: [] })
      case `GET /m/${GROUP}/system/inputs`:
        return reply(200, { items: [{ id: 'in_gigamon_datagen', type: 'datagen', connections: [{ output: 'gigamon_lake' }] }] })
      case `GET /m/${GROUP}/routes`:
        return reply(200, { items: [{ id: 'default', routes: [{ id: 'gigamon_ami_syslog', name: 'gigamon_ami_syslog', output: 'gigamon_lake' }, { id: 'default', output: 'devnull' }] }] })
      case 'GET /m/default_search/search/local_search':
        return reply(404, { message: 'LocalSearch is not enabled' })
      case 'GET /products/stream/groups':
        return reply(200, { items: [{ id: GROUP, name: GROUP, configVersion: 'deadbeef' }] })
      case 'GET /version/status': {
        const now = destPatched && pendingAfterWrite ? pendingAfterWrite : pending
        return reply(200, { items: [{ files: now.map((p) => ({ path: p })) }] })
      }
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
  const quickconnect = [{ id: 'in_gigamon_datagen', type: 'datagen', connectedOutputs: ['gigamon_lake'], ports: [], portUnknown: false, breakerRulesets: [] }]
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
    expect(resolveFeeds([{ id: 'x', type: null, connectedOutputs: ['other'], ports: [], portUnknown: false, breakerRulesets: [] }], [{ id: 'r', name: null, output: 'other', disabled: false }], 'gigamon_lake')).toEqual([])
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
    // THE TEST THIS CHANGE EXISTS FOR, and it is no longer hypothetical. A Lake
    // PATCH was measured on 2026-09-21 (CAPABILITIES.datasetPatchIsPartial is
    // now false): a body carrying one field reset `retentionPeriodInDays` to 365
    // and dropped `format` outright, answering 200 both times. So sending the
    // whole live body back is what keeps the customer's settings — exactly as
    // A-SP23 found on `PATCH /search/saved/{id}` in this same product.
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
//
// ── AND THE SECOND HALF OF THESE TESTS IS A HOLE THE FIRST HALF LEFT OPEN ───
// That comparison was written to EXCLUDE the field being edited, on the
// reasoning that another admin setting retention to the value you are setting is
// a no-op and not a conflict. True of one move, applied to all of them: live 30,
// A approves a dialog reading "raise retention from 30 to 60 days — nothing is
// deleted" which carries no typed gate because an increase needs none, B sets
// 365, A clicks Yes, and 60 goes out and deletes 305 days of a customer's events.
// The tests from `DOES NOT SEND AN INCREASE THAT HAS BECOME A DECREASE` onward
// are for that, and the rule they pin is general: a confirmation describes one
// before → after, so if `before` moves the confirmation is VOID, and only a move
// TO THE TARGET is a genuine no-op.

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

  it('calls a move TO THE TARGET a no-op, sends nothing, and does not report it as a conflict', async () => {
    // B set retention to 90 while A was deciding to set it to 90. The change A
    // approved is already in force, so there is nothing left to send and nothing
    // to warn anybody about. This is the ONE move the blanket exclusion of the
    // edited key got right, and it is the only one kept.
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 90 }] }] })
    const r = await setRetention(90, { current: 30, confirm: yes })
    expect(writes(calls)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.noop).toBe(true)
    expect(r.steps[0]).toMatchObject({ key: 'retention', status: 'skipped' })
    expect(r.steps[0].detail).toContain('90 days')
  })

  // ── THE CONFIRMATION IS VOID WHEN ITS `before` MOVED ──────────────────────
  //
  // The window above was closed with a comparison that EXCLUDED the field being
  // edited, on the reasoning that another admin setting retention to the value
  // you are setting is a no-op. That covered one move and let every other move
  // of the same field through, which opened a hole worse than the one it closed.
  // These are the tests for it. The first one is the one that destroys data.

  it('DOES NOT SEND AN INCREASE THAT HAS BECOME A DECREASE — the case that deletes a customer’s events', async () => {
    // THE TEST THIS WHOLE COMMIT IS FOR, spelled out because a shorter name
    // would not carry it:
    //
    // Live retention is 30. Admin A presses Apply for 60 and reads a dialog
    // saying "Raise retention from 30 to 60 days — Reversible: nothing is
    // deleted by an increase." Because `change.direction` is `increase`, that
    // dialog renders NO irreversibility warning and demands NO typed dataset id.
    // While A is reading it, admin B sets retention to 365. A clicks Yes.
    //
    // If the 60 goes out, Cribl Lake deletes 305 days of the customer's ingested
    // events, irreversibly, under a sentence that promised nothing would be
    // deleted and past the one gate this app built for exactly this write. So
    // the assertion is on the REQUESTS MADE, not on the answer: a function that
    // PATCHed and then reported an error would pass a check of its own return
    // value and would have destroyed the data.
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 365 }] }] })
    const r = await setRetention(60, { current: 30, confirm: yes })
    expect(writes(calls)).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ key: 'retention', status: 'error' })
    // Both values, and the fact that nothing went out. "It changed" is not
    // actionable until you can see what you were asked about and what is there.
    expect(r.steps[0].detail).toContain('Nothing was sent')
    expect(r.steps[0].detail).toContain('30')
    expect(r.steps[0].detail).toContain('365')
  })

  it('refuses a decrease whose before moved too, not only the increase', async () => {
    // The rule is about the sentence, not about the direction. A decrease
    // approved against 30 is a different decrease against 7, and the number in
    // "the 23 days beyond the new window go" was computed from 30.
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 7 }] }] })
    const r = await setRetention(14, { current: 30, confirm: yes })
    expect(writes(calls)).toEqual([])
    expect(r.steps[0].detail).toContain('Nothing was sent')
  })

  it('proceeds when the before did not move', async () => {
    // `afterWrite` is the post-write re-read, a different check from this one —
    // without it the stub keeps answering 30 and the step reports a race.
    const calls = stubWorld({ afterWrite: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 60 }] }] })
    const r = await setRetention(60, { current: 30, confirm: yes })
    expect(writes(calls).map((c) => c.method)).toEqual(['PATCH'])
    expect(r.steps[0]).toMatchObject({ status: 'applied', detail: '30 → 60 days' })
  })

  it('applies the same rule to the description, which shows a before too', async () => {
    // Unchanged → proceeds. Moved to the target → no-op, nothing sent. Moved
    // anywhere else → refused, nothing sent, both sets of words named.
    const clean = stubWorld()
    expect((await setDescription('new words', { current: 'old', confirm: yes })).steps[0].status).toBe('applied')
    expect(writes(clean).map((c) => c.method)).toEqual(['PATCH'])

    const already = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, description: 'new words' }] }] })
    const noop = await setDescription('new words', { current: 'old', confirm: yes })
    expect(writes(already)).toEqual([])
    expect(noop.steps[0]).toMatchObject({ status: 'skipped' })
    expect(noop.noop).toBe(true)

    const moved = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, description: 'B was here' }] }] })
    const r = await setDescription('new words', { current: 'old', confirm: yes })
    expect(writes(moved)).toEqual([])
    expect(r.steps[0]).toMatchObject({ status: 'error' })
    expect(r.steps[0].detail).toContain('"old"')
    expect(r.steps[0].detail).toContain('"B was here"')
  })

  it('reports the field that moved rather than one that moved beside it', async () => {
    // Both checks fire. The retention one runs first on purpose: reporting "the
    // description changed" while retention silently went 30 → 365 would name the
    // harmless move and hide the dangerous one.
    const calls = stubWorld({
      betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 365, description: 'B was here' }] }],
    })
    const r = await setRetention(60, { current: 30, confirm: yes })
    expect(writes(calls)).toEqual([])
    expect(r.steps[0].detail).toContain('retention')
    expect(r.steps[0].detail).toContain('365')
  })

  it('never re-prompts — one dialog, one answer, and a refusal instead of a second question', async () => {
    // Silently re-deriving a confirmation from a dialog somebody has already
    // dismissed is the failure this whole sequence has been chasing. The writer
    // gets exactly one call and gets it before the second read.
    const asked: number[] = []
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 365 }] }] })
    await setRetention(60, {
      current: 30,
      confirm: () => {
        asked.push(calls.filter((c) => c.path.startsWith(DATASET_PATH)).length)
        return true
      },
    })
    expect(asked).toEqual([1])
  })

  it('CANNOT WRITE A STALE `before` INTO THE AUDIT TRAIL', async () => {
    // The step detail and the trail entry both carry `change.from`, computed
    // from the read that filled the dialog. An audit entry recording `before:
    // 30` for a write that actually cut 365 to 60 is a false record of a
    // destructive act, which is worse than no record — so the only paths that
    // reach either are ones where that value was re-confirmed.
    const calls = stubWorld({ betweenReads: [200, { items: [{ ...LIVE_DATASET, retentionPeriodInDays: 365 }] }] })
    const r = await setRetention(60, { current: 30, confirm: yes })
    // `audit` is fire-and-forget, so give it the microtask it would have had.
    await new Promise((done) => setTimeout(done, 0))
    // No PATCH to the dataset, and no trail entry claiming one happened.
    expect(writes(calls)).toEqual([])
    expect(calls.filter((c) => c.path.startsWith('/kvstore/') && c.method !== 'GET')).toEqual([])
    expect(r.steps[0].detail).not.toContain('30 → 60 days')

    // And on the path that does write one, the `before` it carries was read
    // again after the answer.
    const applied = stubWorld()
    await setRetention(60, { current: 30, confirm: yes })
    await new Promise((done) => setTimeout(done, 0))
    const entry = applied.find((c) => c.path.startsWith('/kvstore/') && c.method !== 'GET')
    expect(JSON.stringify(entry?.body)).toContain('"before":30')
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

  it('hands the confirmation the diff, both feeds, and the two file lists apart', async () => {
    stubWorld({ pending: [`groups/${GROUP}/local/cribl/inputs.yml`] })
    let ctx: { keys: string[]; feeds: string[]; complete: boolean; carries: string[]; other: string[] | null } | null = null
    await updateDestination(GROUP, destinationSpec(balanced), {
      confirm: (c) => {
        ctx = {
          keys: c.diff.map((d) => d.key), feeds: c.feeds.map((f) => f.kind), complete: c.feedsComplete,
          carries: c.commitFiles, other: c.otherPending,
        }
        return false
      },
    })
    expect(ctx!.keys).toContain('maxFileSizeMB')
    expect(ctx!.feeds).toEqual(['quickconnect', 'route'])
    expect(ctx!.complete).toBe(true)
    // ONE list became two, because one list could only ever be wrong in one of
    // two directions. This used to hand over the repo-wide pending list as
    // `pendingFiles`, and the dialog rendered it as what the commit carries —
    // so it named `inputs.yml`, which the commit never touches.
    expect(ctx!.carries).toEqual([OUTPUTS_YML])
    expect(ctx!.other).toEqual([`groups/${GROUP}/local/cribl/inputs.yml`])
  })

  // ── A READ THAT FAILED IS NOT A CLEAN TREE ────────────────────────────────
  //
  // `pendingConfigFiles` called `capi('GET', '/version/status')` and never
  // looked at `r.status`. `capi` answers {status, body} rather than throwing —
  // deliberately, because its callers read the status as data — so a 403 or a
  // 500 arrived with no `items`, fell out as [], and the dialog printed "Cribl
  // reports nothing else uncommitted on this Leader right now, so nothing else
  // rides along": a factual claim resting on a read Cribl refused.
  it('answers null for a refused status read and an empty list for a clean tree', async () => {
    stubWorld({ pending: [] })
    expect(await pendingConfigFiles()).toEqual([])
    stubWorld({ answers: { 'GET /version/status': [403, { message: 'not granted' }] } })
    expect(await pendingConfigFiles()).toBe(null)
  })

  it('hands the confirmation null, not an empty list, when the status read was refused', async () => {
    stubWorld({ answers: { 'GET /version/status': [500, { message: 'boom' }] } })
    let other: string[] | null | undefined
    await updateDestination(GROUP, destinationSpec(balanced), {
      confirm: (c) => { other = c.otherPending; return false },
    })
    expect(other, 'a failed read reached the dialog as "nothing else is pending"').toBe(null)
  })

  it('reads the commit scope AFTER the PATCH, so it can see the file the PATCH dirtied', async () => {
    // THE INSTANCE THIS TEST EXISTS FOR. Before the write, Git reports only
    // somebody else's work: `outputs.yml` is clean, because the change to it
    // has not been sent. That read was the one the commit list came from, so it
    // matched nothing, `destinationCommitFiles` answered [], the commit was
    // SKIPPED, and `outcome()` called the run ok — destination changed, Workers
    // left on the old configuration, no error anywhere.
    const calls = stubWorld({
      pending: ['groups/other/local/cribl/outputs.yml'],
      pendingAfterWrite: ['groups/other/local/cribl/outputs.yml', OUTPUTS_YML],
    })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    const commit = writes(calls).find((c) => c.path === '/version/commit')
    expect((commit!.body as { files: string[] }).files).toEqual([OUTPUTS_YML])
    expect(r.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['destination:applied', 'commit:applied', 'deploy:applied'])
    // The ordering itself, not only its result: a status read after the PATCH.
    const order = calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)
    expect(order.lastIndexOf('GET /version/status')).toBeGreaterThan(order.indexOf(`PATCH ${DEST_PATH}`))
  })

  it('reports an error, not a silent skip, when Git reports nothing after a successful PATCH', async () => {
    // Those two cannot both be true, so the app refuses to guess a path — and
    // says the workspace is half-applied rather than pushing a success toast.
    const calls = stubWorld({
      pending: ['groups/other/local/cribl/outputs.yml'],
      pendingAfterWrite: ['groups/other/local/cribl/outputs.yml'],
    })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    expect(writes(calls).some((c) => c.path === '/version/commit')).toBe(false)
    expect(r.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['destination:applied', 'commit:error'])
    expect(r.ok).toBe(false)
    expect(r.steps[1].detail).toContain('still running the old configuration')
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

  // ── The same window, closed on a comparison of DIFFS rather than of bodies ──
  //
  // This writer waited a commit longer than the two Lake ones, for a stated
  // reason: the Lake refusal compares whole bodies because DATASET_READONLY_KEYS
  // names the keys that move on their own, and nothing here knows the equivalent
  // for a Stream output beyond `status` — so a refusal built on a guessed list
  // fires on fields nobody touched, which teaches people to distrust it.
  //
  // Comparing `diffDestination` against both reads needs no such list, which is
  // what these tests are for: a field the edit does not touch moving must NOT
  // refuse, and a change to an approved row must.

  it('reads the destination again after the answer, and builds the body from that read', async () => {
    const calls = stubWorld()
    await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    // GET (fills the dialog) · GET (the merge source) · PATCH.
    expect(calls.filter((c) => c.path === DEST_PATH).map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH'])
  })

  it('spends no second read on a refusal', async () => {
    const calls = stubWorld()
    await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => false })
    expect(calls.filter((c) => c.path === DEST_PATH)).toHaveLength(1)
  })

  it('BLOCKS THE WRITE when the diff that would apply is not the diff that was approved', async () => {
    // B set maxFileSizeMB to 64 while A was reading a dialog whose row said
    // "5 → 32". The row that would now apply says "64 → 32", which is a
    // different change to a delivery point both feeds write through — and the
    // commit and deploy behind it would restart that group's Worker Processes
    // for it.
    const calls = stubWorld({ destBetweenReads: [200, { items: [{ ...LIVE_DESTINATION, maxFileSizeMB: 64 }] }] })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    expect(writes(calls)).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ key: 'destination', status: 'error' })
    expect(r.steps[0].detail).toContain('Nothing was sent')
    // Both diffs, named: the one approved and the one that would go out.
    expect(r.steps[0].detail).toContain('Approved')
    expect(r.steps[0].detail).toContain('Would now apply')
    expect(r.steps[0].detail).toContain('64')
  })

  it('DOES NOT refuse when a field the edit never touches moved — the false refusal the key list was needed to avoid', async () => {
    // `status` is server-computed and `environment` is a key this app has no
    // opinion about. Neither appears in the diff, so neither changes it, so
    // neither refuses. And the body is merged onto the SECOND read, so their
    // value is carried forward rather than reverted — which is what makes a
    // comparison this narrow safe.
    const moved = { ...LIVE_DESTINATION, status: { health: 'red' }, environment: 'staging' }
    const calls = stubWorld({ destBetweenReads: [200, { items: [moved] }] })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    const body = writes(calls).find((c) => c.path === DEST_PATH)?.body as Record<string, unknown>
    expect(r.steps[0].status).toBe('applied')
    expect(body.environment).toBe('staging')
    expect(body).not.toHaveProperty('status')
  })

  it('calls a destination somebody else already changed to these settings a no-op, and commits nothing', async () => {
    const applied = { ...LIVE_DESTINATION, ...destinationSpec(balanced).set }
    const calls = stubWorld({ destBetweenReads: [200, { items: [applied] }] })
    const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
    expect(writes(calls)).toEqual([])
    expect(r.noop).toBe(true)
    expect(r.steps[0]).toMatchObject({ key: 'destination', status: 'skipped' })
  })

  it('SENDS NOTHING when the second read fails, and never falls back to the first', async () => {
    // The first read's body is sitting right there. Merging onto it is the stale
    // merge this sequence exists to prevent, arriving as a convenience.
    for (const status of [403, 500]) {
      const calls = stubWorld({ destBetweenReads: [status, { message: 'leader unavailable' }] })
      const r = await updateDestination(GROUP, destinationSpec(balanced), { confirm: () => true })
      expect(writes(calls), String(status)).toEqual([])
      expect(r.ok, String(status)).toBe(false)
      expect(r.steps[0].detail, String(status)).toContain('Nothing was sent')
    }
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
  })

  it('answers [] for a status that names only another group — and that is now a caller’s problem', () => {
    // WHAT THIS USED TO CLAIM, AND WHY IT WAS A DEFECT. The assertion was the
    // same call, with the comment "Git reported changes and none of them is
    // ours: committing a constructed path here would commit somebody else's
    // work." The function's behaviour is right and unchanged. What was wrong
    // was that `updateDestination` fed it a status read taken BEFORE the PATCH,
    // where this is the NORMAL answer on any workspace with unrelated pending
    // work — so [] meant "we looked too early", the commit was skipped, and the
    // run still reported ok. Read after the PATCH, [] can only mean Git
    // genuinely reports nothing, which after a 200 is a contradiction and is
    // reported as an error. So this stays pinned, and the test above pins what
    // the caller must now do with it.
    expect(destinationCommitFiles(GROUP, ['groups/other/local/cribl/outputs.yml'])).toEqual([])
  })
})

describe('commitScopeAfterConfirm', () => {
  // The retry button computes its file list before its dialog opens and commits
  // it after — a file list crossing a user-paced confirmation, which is the same
  // hazard `destinationMergeSourceAfterConfirm` closes for the body. A commit is
  // a write like any other, so what is sent has to be what was read.

  it('answers the fresh list when nothing moved', async () => {
    stubWorld({ pending: [OUTPUTS_YML] })
    const r = await commitScopeAfterConfirm(GROUP, [OUTPUTS_YML])
    expect(r).toEqual({ files: [OUTPUTS_YML] })
  })

  it('refuses rather than substitutes when the scope moved under the open dialog', async () => {
    // Another admin committed while the dialog was open, so the approved path is
    // one Git no longer reports. Committing the newer set instead would be
    // committing something nobody read.
    stubWorld({ pending: ['groups/other/local/cribl/outputs.yml'] })
    const r = await commitScopeAfterConfirm(GROUP, [OUTPUTS_YML])
    expect('stop' in r).toBe(true)
    const stop = (r as { stop: { status: string; detail?: string } }).stop
    expect(stop.status).toBe('error')
    expect(stop.detail).toContain('changed while that confirmation was open')
    expect(stop.detail).toContain(OUTPUTS_YML)
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
  it('carries an answer only where something was actually measured', () => {
    // Setting one of these true because the spec implies it is how an inference
    // becomes a fact nothing can dislodge — and two of them, if wrong, cost a
    // customer data. So an answer is allowed ONLY with its provenance beside it.
    for (const [id, capability] of Object.entries(CAPABILITIES)) {
      expect(capability.question.length, id).toBeGreaterThan(60)
      expect(capability.meanwhile.length, id).toBeGreaterThan(60)
      if (capability.answer === null) {
        expect(capability.measured, `${id} is unmeasured and must not claim provenance`).toBeUndefined()
      } else {
        // The date is what makes it checkable later; the rest is the evidence.
        expect(capability.measured, `${id} answers ${capability.answer} with no provenance`).toMatch(
          /20\d\d-\d\d-\d\d/,
        )
        expect(capability.measured!.length, id).toBeGreaterThan(60)
      }
    }
  })

  it('has measured exactly one of them, and C6 came back false', () => {
    // 2026-09-21, on a throwaway dataset holding no data: a PATCH naming only
    // {description} reset retention to 365 and dropped `format`. This is the pin
    // that stops the value drifting back to null, or to true, without somebody
    // re-running the probe.
    expect(CAPABILITIES.datasetPatchIsPartial.answer).toBe(false)
    expect(CAPABILITIES.datasetPatchIsPartial.measured).toContain('365')

    const unmeasured = Object.entries(CAPABILITIES)
      .filter(([, c]) => c.answer === null)
      .map(([id]) => id)
      .sort()
    expect(unmeasured).toEqual([
      'datasetFormatPatchable',
      'destinationWritesParquetIntoJsonDataset',
      'gidPlaceholderHonoured',
      'lakeSearchConfigPropagates',
      'mixedReadWorks',
    ])
  })

  it('names who would have to measure each one', () => {
    expect(CAPABILITIES.datasetPatchIsPartial.spike).toBe('P-S5')
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
//   * WHICH KEYS A LIVE STREAM OUTPUT MOVES ON ITS OWN. `updateDestination`'s
//     stale-merge window is closed now, and it was closed WITHOUT that list:
//     it compares `diffDestination` against both reads rather than the bodies,
//     so a server-derived field moving changes no row and only a change to the
//     approved change refuses. That is why the pair of tests above — a moved
//     `status`/`environment` proceeding, a moved `maxFileSizeMB` refusing — is
//     the whole of the claim. What is still unmeasured is the list itself, which
//     `DESTINATION_READONLY_KEYS` needs for a different job: deciding what the
//     PATCH body may carry back. It holds only `status`, against a design that
//     also stripped `notifications`, and that question belongs to Preview 3.2.
//   * THAT THE DIFF COMPARISON CATCHES EVERY MEANINGFUL MOVE. It catches exactly
//     the moves `diffDestination` considers meaningful, which is the same set the
//     dialog rendered — deliberately, since a refusal about something nobody was
//     shown is one nobody can act on. A change to a key outside the edit is NOT
//     refused; it is carried forward by the merge onto the second read, which is
//     a different guarantee and is the one the `environment` test asserts.
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
