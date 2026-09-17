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
import { LAKE_ADDRESSING } from './lake'
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

interface WorldOpts {
  /** Status (and optional body) per exact path, so one endpoint can be broken. */
  answers?: Record<string, [number, unknown]>
  /** Paths `/version/status` reports as uncommitted. */
  pending?: string[]
  /** Commit hash `/version/commit` answers with; null = "nothing to commit". */
  commit?: string | null
}

/** A workspace with the stack already there, so a test only says what differs. */
function stubWorld(opts: WorldOpts = {}): Call[] {
  const { answers = {}, pending = [OUTPUTS_YML], commit = 'abcdef1234567890' } = opts
  const calls: Call[] = []

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
        return reply(200, { items: [{ id: 'gigamon_ami', format: 'json', retentionPeriodInDays: 30, description: 'old', metrics: { currentSizeBytes: 111184359155, metricsDate: '2026-09-13' } }] })
      case `PATCH ${DATASET_PATH}`:
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

  it('sends only the field it changes', async () => {
    const calls = stubWorld()
    await setRetention(90, { current: 30, confirm: yes })
    const patch = writes(calls).find((c) => c.path === DATASET_PATH)
    expect(patch?.method).toBe('PATCH')
    expect(patch?.body).toEqual({ retentionPeriodInDays: 90 })
  })

  it('reports Cribl’s refusal as an error step rather than as success', async () => {
    stubWorld({ answers: { [`PATCH ${DATASET_PATH}`]: [403, { message: 'Not authorized or licensed to perform this action.' }] } })
    const r = await setRetention(90, { current: 30, confirm: yes })
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ status: 'error' })
    expect(r.steps[0].detail).toContain('Not authorized')
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

  it('sends only the description', async () => {
    const calls = stubWorld()
    await setDescription('new words', { current: 'old', confirm: () => true })
    expect(writes(calls).find((c) => c.path === DATASET_PATH)?.body).toEqual({ description: 'new words' })
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
//   * THAT A LAKE PATCH IS PARTIAL. `setRetention` and `setDescription` each send
//     one field, on claim C6, which is inferred from the spec's example bodies.
//     If the endpoint is a full replacement, both of them DELETE every other
//     field on the dataset and every test above still passes. The cheapest probe
//     is a live 30 → 30 no-op followed by a full re-read (Preview 3.1).
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
