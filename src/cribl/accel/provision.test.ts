// The four things about the scheduled searches that are expensive to get wrong.
//
// Like cribl/provision.test.ts, this has no dry run: the way to find out whether
// a write is right is to point it at somebody's workspace. So the parts that are
// already known to fail silently are pinned here instead.
//
//   THE PATCH BODY. A-SP23, measured 2026-09-17: a PATCH removes every field it
//   omits, and the `schedule` sub-object is REPLACED rather than merged. A
//   request carrying `{enabled, cronSchedule}` answered 200 and silently dropped
//   `tz` and `keepLastN` — the field that decides which hour a job fires, and
//   the one the read path's entire margin rests on. One carrying only the three
//   schema-required fields deleted `schedule`, `earliest`, `latest` and
//   `description` and unscheduled the search forever. Nothing about either shows
//   up as an error, so "pause sends the whole body" is the single most important
//   assertion in this file.
//
//   THE DELETE. `/search/saved` is a flat, shared namespace with no owning-app
//   field, so an id is not proof of authorship. A saved search called
//   `gno_lake_30d_c1d` that this app did not create is somebody else's, and
//   deleting it is the stranded-commit mistake from slice 1.3 run again. Both
//   directions are here: it refuses one it cannot prove is its own, and it
//   accepts one this install's own record claims.
//
//   THE STATUS READ. A 403 answers no rows, and so does a quiet workspace. A
//   read that laundered the first into the second would offer to create searches
//   that already exist — or, worse, let a write proceed from a state nothing had
//   actually looked at.
//
//   THE RE-READ. "Cribl accepted the DELETE" and "the search is gone" are two
//   claims, and only the second is the one a customer cares about.
//
// Stubbed at `fetch`, not at `capi`, so what these assertions read is the
// request the platform would have received — the method, the path and the exact
// body. The fake workspace below answers; anything it does that a real one does
// not is a bug in this file.
//
// NOTHING HERE CREATES A REAL SAVED SEARCH. The first real Apply is a human's
// click in Preview.

import { LAKE_HELD_QUERY, LAKE_TOTAL_QUERY } from '../../queries/dataFlow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { denialMark, denialSince, resetDenials } from '../authz'
import { SEARCH_GROUP } from '../config'
import { MANIFEST, accelEntry, accelSavedSearch, type AccelId } from './manifest'
import {
  LIST_LIMIT,
  SAVED_PATH,
  applyAcceleration,
  applyPlan,
  carriesOwnerMark,
  parseStamp,
  pauseAcceleration,
  readAccelState,
  removeAcceleration,
  removalPlan,
  resumeAcceleration,
} from './provision'
import { accelWritesSettled } from './store'

const BASE = '/capi'
const SAVED = '/m/default_search/search/saved'

/**
 * The same answer once per manifest entry.
 *
 * Written this way rather than as a literal pair because the literal pair was
 * the reason adding three entries turned into twenty-four red assertions that
 * said nothing about the change. What these cases are actually about is "every
 * entry ends in this state", and that sentence does not have a length in it.
 */
const each = <T,>(value: T): T[] => MANIFEST.map(() => value)

/** Every manifest entry present and exactly as this release would write it. */
async function allCorrect(
  overrides: Record<string, Record<string, unknown>> = {},
): Promise<Record<string, Record<string, unknown>>> {
  const saved: Record<string, Record<string, unknown>> = {}
  for (const e of MANIFEST) saved[e.id] = await correct(e.id)
  return { ...saved, ...overrides }
}

/** The same, with named exceptions: `per({ gno_sample_2m_c1h: 'paused' }, 'enabled')`. */
const per = <T,>(exceptions: Partial<Record<AccelId, T>>, rest: T): T[] =>
  MANIFEST.map((e) => exceptions[e.id] ?? rest)

/** Every id but these, in manifest order. */
const idsExcept = (...ids: AccelId[]): AccelId[] => MANIFEST.map((e) => e.id).filter((id) => !ids.includes(id))
const LAKE = 'gno_lake_30d_c1d'
const SAMPLE = 'gno_sample_2m_c1h'

interface Call {
  method: string
  path: string
  query: string
  body: Record<string, unknown> | undefined
}

interface WorkspaceOpts {
  /** Saved searches the workspace already holds, by id. */
  saved?: Record<string, Record<string, unknown>>
  /** Ids the LIST leaves out although they exist — i.e. they are on page two.
   *  With `totalCount` above the page, this is how a truncated list is faked. */
  listOmits?: readonly string[]
  /** What the list reports as the workspace's total. Defaults to what it sent. */
  totalCount?: number
  /** `${METHOD} ${path}` (no query) → answer this status instead. */
  status?: Record<string, number>
  /** Documents already in the app-scoped KV store, by key. */
  kv?: Record<string, unknown>
  /** A second writer, firing the moment our PATCH lands. */
  afterPatch?: (saved: Map<string, Record<string, unknown>>) => void
  /** DELETE answers 200 and the object stays — a Leader that agreed and did not
   *  do it, which is exactly what the re-read exists to catch. */
  deleteIsALie?: boolean
  /** The Lake API's dataset list — the retention the Lake total's window is
   *  resolved against. Absent means the list answers 404, which leaves the
   *  manifest's default. */
  lake?: unknown
}

function response(status: number, body: unknown) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}

const DENIED = { message: 'Not authorized or licensed to perform this action.' }

function stubWorkspace(opts: WorkspaceOpts = {}) {
  const saved = new Map<string, Record<string, unknown>>(
    Object.entries(opts.saved ?? {}).map(([id, obj]) => [id, { ...obj }]),
  )
  // Documents are held the way kv.ts writes them: the envelope, as text.
  const kv = new Map<string, string>(
    Object.entries(opts.kv ?? {}).map(([key, doc]) => [key, JSON.stringify({ version: 1, updatedAt: 1, doc })]),
  )
  const calls: Call[] = []

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const rest = String(url).slice(BASE.length)
    const [path, query = ''] = rest.split('?')
    const body = init.body == null ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ method, path, query, body })

    const override = opts.status?.[`${method} ${path}`]
    if (override !== undefined) return response(override, override >= 400 ? DENIED : {})

    if (path.startsWith('/kvstore')) {
      if (path === '/kvstore/keys') return response(200, [...kv.keys()])
      const key = path.slice('/kvstore/'.length).split('/').map(decodeURIComponent).join('/')
      if (method === 'PUT') {
        kv.set(key, String(init.body ?? ''))
        return response(200, '')
      }
      if (method === 'DELETE') return response(kv.delete(key) ? 200 : 404, '')
      const held = kv.get(key)
      return held === undefined ? response(404, '') : response(200, held)
    }

    if (path.endsWith('/lakes/default/datasets') && method === 'GET') {
      return opts.lake ? response(200, opts.lake) : response(404, { message: 'no lake' })
    }

    if (path === SAVED) {
      if (method === 'GET') {
        const items = [...saved.entries()]
          .filter(([id]) => !(opts.listOmits ?? []).includes(id))
          .map(([, obj]) => obj)
        return response(200, { items, count: items.length, totalCount: opts.totalCount ?? items.length })
      }
      if (method === 'POST') {
        const id = String(body?.id ?? '')
        saved.set(id, body as Record<string, unknown>)
        return response(200, { items: [body], count: 1 })
      }
    }

    if (path.startsWith(`${SAVED}/`)) {
      const id = decodeURIComponent(path.slice(SAVED.length + 1))
      if (method === 'GET') {
        const obj = saved.get(id)
        return obj ? response(200, { items: [obj], count: 1 }) : response(404, { message: 'not found' })
      }
      if (method === 'PATCH') {
        saved.set(id, body as Record<string, unknown>)
        opts.afterPatch?.(saved)
        return response(200, { items: [saved.get(id)], count: 1 })
      }
      if (method === 'DELETE') {
        if (!saved.has(id)) return response(404, { message: 'not found' })
        if (!opts.deleteIsALie) saved.delete(id)
        return response(200, { items: [], count: 0 })
      }
    }
    return response(404, { message: `the stub has no route for ${method} ${path}` })
  })

  return { calls, saved }
}

/** The calls that went to `/search/saved`, i.e. everything except the app's own
 *  KV reads and writes. */
const savedCalls = (calls: readonly Call[]) => calls.filter((c) => c.path.startsWith(SAVED))
const writes = (calls: readonly Call[]) =>
  savedCalls(calls).filter((c) => c.method === 'POST' || c.method === 'PATCH' || c.method === 'DELETE')

/** The body of a call this test expected to find. It fails on the missing call
 *  rather than reading a field off `undefined`, which reports as a TypeError
 *  three lines away from the assertion that actually matters. */
function bodyOf(call: Call | undefined): Record<string, unknown> {
  expect(call, 'this test expected a request that was never made').toBeDefined()
  return (call as Call).body as Record<string, unknown>
}

/** A correct object for an entry, as this release would write it. */
const correct = async (id: AccelId) =>
  (await accelSavedSearch(accelEntry(id))) as unknown as Record<string, unknown>

/** …with the fields a customer's own edits and a future Cribl release would add,
 *  none of which this app knows about and all of which a PATCH must carry back. */
async function correctPlusExtras(id: AccelId): Promise<Record<string, unknown>> {
  return {
    ...(await correct(id)),
    user: 'auth0|somebody',
    displayUsername: 'somebody@example.com',
    chartConfig: { type: 'bar' },
    timezone: 'Europe/London',
  }
}

beforeEach(() => {
  resetDenials()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  // Drain the store's serialised write chain before the next test swaps the
  // stub out from under it.
  await accelWritesSettled()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('addressing', () => {
  it('addresses the group search actually runs in', () => {
    // The path is a literal in provision.ts so policyCoverage.test.ts can read
    // it off the source; this is the line that stops the literal drifting away
    // from SEARCH_GROUP, which would grant these writes in the wrong group.
    expect(SAVED_PATH).toBe(`/m/${SEARCH_GROUP}/search/saved`)
  })

  it('asks for a page of saved searches, with the offset the API insists on', async () => {
    const { calls } = stubWorkspace()
    await readAccelState()
    const list = savedCalls(calls).find((c) => c.method === 'GET' && c.path === SAVED)
    expect(list?.query).toContain(`limit=${LIST_LIMIT}`)
    expect(list?.query).toContain('offset=0')
  })
})

describe('the ownership stamp', () => {
  it('recognises what this app writes', async () => {
    const description = String((await correct(LAKE)).description)
    expect(carriesOwnerMark(description)).toBe(true)
    expect(parseStamp(description)?.serves).toBe(LAKE)
  })

  it('claims nothing it did not write', () => {
    expect(carriesOwnerMark('Daily rollup for the NOC')).toBe(false)
    expect(carriesOwnerMark(null)).toBe(false)
    // A description in a shape an older release used still counts as ours — the
    // marker is loose on purpose, so a teardown can still remove what an earlier
    // version created. Only the drift comparison needs the strict parse.
    expect(carriesOwnerMark('GNO 0.9.0 · serves gno_lake_30d_c1d')).toBe(true)
    expect(parseStamp('GNO 0.9.0 · serves gno_lake_30d_c1d')).toBe(null)
  })
})

describe('reading the workspace', () => {
  it('reports both entries absent on a workspace that has none', async () => {
    stubWorkspace()
    const state = await readAccelState()
    expect(state.rows.map((r) => r.state)).toEqual(each('absent'))
    expect(state.error).toBe(null)
    expect(state.denied).toBe(false)
  })

  it('tells enabled from paused', async () => {
    const paused = await correct(SAMPLE)
    paused.schedule = { ...(paused.schedule as Record<string, unknown>), enabled: false }
    stubWorkspace({ saved: { [LAKE]: await correct(LAKE), [SAMPLE]: paused } })
    const state = await readAccelState()
    expect(state.rows.map((r) => r.state)).toEqual(per({ [LAKE]: 'enabled', [SAMPLE]: 'paused' }, 'absent'))
    expect(state.rows[1].enabled).toBe(false)
  })

  it('names what has drifted, in words somebody can act on', async () => {
    const drifted = await correct(LAKE)
    drifted.schedule = { ...(drifted.schedule as Record<string, unknown>), cronSchedule: '0 3 * * *', keepLastN: 1 }
    stubWorkspace({ saved: { [LAKE]: drifted } })
    const state = await readAccelState()
    expect(state.rows[0].state).toBe('differs')
    expect(state.rows[0].differences).toContain('when it runs')
    expect(state.rows[0].differences).toContain('how many past runs it keeps readable')
  })

  it('does not call an older release’s app version drift', async () => {
    // The description names the app version, which moves on every release — a CSS
    // fix included. If that counted, every upgrade would report both searches as
    // drifted and the check would become something people click past.
    const older = await correct(LAKE)
    older.description = String(older.description).replace(/^GNO \S+/, 'GNO 0.9.0')
    stubWorkspace({ saved: { [LAKE]: older } })
    const state = await readAccelState()
    expect(state.rows[0].state).toBe('enabled')
    expect(state.rows[0].stamp?.appVersion).toBe('0.9.0')
  })

  it('calls an object with our id but no stamp somebody else’s', async () => {
    stubWorkspace({
      saved: { [LAKE]: { id: LAKE, name: 'Daily rollup', query: 'dataset="x"', description: 'mine, not yours' } },
    })
    const state = await readAccelState()
    expect(state.rows[0].state).toBe('foreign')
    expect(state.rows[0].ours).toBe(false)
  })

  it('reads the app’s own record as the second proof of ownership', async () => {
    // Somebody edited the description in Cribl's UI. The object is still ours,
    // and this install's own record is what says so — see accel/store.ts on why
    // there are two signals rather than one.
    const stripped = await correct(LAKE)
    stripped.description = 'renamed by an admin'
    stubWorkspace({
      saved: { [LAKE]: stripped },
      kv: { 'accel/state': { version: 1, created: { [LAKE]: { at: 1, appVersion: 'dev', manifestVersion: 1, bodySha: 'a'.repeat(12), displaySha: 'b'.repeat(12), by: null } } } },
    })
    const state = await readAccelState()
    expect(state.rows[0].ours).toBe(false)
    expect(state.rows[0].recorded).toBe(true)
    expect(state.rows[0].state).toBe('differs')
  })

  it('settles an id the first page did not contain, instead of calling it absent', async () => {
    // A workspace with more saved searches than one page is not a workspace
    // without ours. Reporting "absent" here would offer to create a search that
    // already exists.
    const { calls } = stubWorkspace({
      saved: { [LAKE]: await correct(LAKE) },
      listOmits: [LAKE],
      totalCount: 500,
    })
    const state = await readAccelState()
    expect(state.truncated).toBe(true)
    expect(state.rows[0].state).toBe('enabled')
    expect(savedCalls(calls).filter((c) => c.method === 'GET' && c.path === `${SAVED}/${LAKE}`)).toHaveLength(1)
  })

  it('reports a `gno_` search this release does not know, because it is still billing', async () => {
    stubWorkspace({
      saved: {
        gno_old_rollup_c1h: { id: 'gno_old_rollup_c1h', name: 'GNO · old', description: 'GNO 0.8.0 · serves gno_old_rollup_c1h' },
      },
    })
    const state = await readAccelState()
    expect(state.orphans.map((o) => o.id)).toEqual(['gno_old_rollup_c1h'])
    expect(state.orphans[0].ours).toBe(true)
  })
})

describe('a refusal is a state, not a crash', () => {
  it('says nothing about the workspace when the list is refused', async () => {
    stubWorkspace({ status: { [`GET ${SAVED}`]: 403 } })
    const state = await readAccelState()
    expect(state.denied).toBe(true)
    expect(state.error).toContain('cannot list')
    // Not "absent". The whole point: a refusal must never render as "nothing is
    // there" with an offer to create it.
    expect(state.rows.map((r) => r.state)).toEqual(each('unreadable'))
  })

  it('does not blame a button for a status read that nobody clicked', async () => {
    // <GatedControl> treats any refusal recorded while its write ran as ITS
    // refusal. A status read on mount must not latch an unrelated control.
    stubWorkspace({ status: { [`GET ${SAVED}`]: 403 } })
    const mark = denialMark()
    await readAccelState()
    expect(denialSince(mark)).toBe(null)
  })

  it('does blame the click when the click is what read', async () => {
    stubWorkspace({ status: { [`GET ${SAVED}`]: 403 } })
    const mark = denialMark()
    await applyAcceleration()
    const denial = denialSince(mark)
    expect(denial?.status).toBe(403)
    expect(denial?.path).toBe(SAVED)
  })

  it('writes nothing at all from a state it could not read', async () => {
    const { calls } = stubWorkspace({ status: { [`GET ${SAVED}`]: 403 } })
    const result = await applyAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('skipped'))
    expect(result.unchanged).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('deletes nothing at all from a state it could not read', async () => {
    const { calls } = stubWorkspace({
      saved: { [LAKE]: await correct(LAKE) },
      status: { [`GET ${SAVED}`]: 403 },
    })
    const result = await removeAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('skipped'))
    expect(writes(calls)).toEqual([])
  })

  it('does not let one id this app could not settle block the other', async () => {
    // The list came back and was truncated, so each missing id needs a direct
    // GET. One of those being refused says nothing about the other entry — a
    // whole-state error here would stop a perfectly readable search being
    // created because of its neighbour.
    const { calls } = stubWorkspace({
      totalCount: 500,
      status: { [`GET ${SAVED}/${LAKE}`]: 403 },
    })
    const state = await readAccelState({ background: false })
    expect(state.error).toBe(null)
    expect(state.denied).toBe(true)
    expect(state.rows.map((r) => r.state)).toEqual(per({ [LAKE]: 'unreadable' }, 'absent'))

    const result = await applyAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(per({ [LAKE]: 'skipped' }, 'created'))
    expect(writes(calls).map((c) => c.method)).toEqual(idsExcept(LAKE).map(() => 'POST'))
  })

  it('reports a refused pause rather than throwing at its caller', async () => {
    stubWorkspace({ saved: { [LAKE]: await correct(LAKE) }, status: { [`GET ${SAVED}/${LAKE}`]: 403 } })
    const result = await pauseAcceleration(LAKE)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('refused')
  })
})

describe('apply', () => {
  it('creates both, with exactly the body the manifest defines', async () => {
    const { calls } = stubWorkspace()
    const result = await applyAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('created'))
    expect(result.unchanged).toBe(false)
    const posts = savedCalls(calls).filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.path)).toEqual(each(SAVED))
    for (const [i, entry] of MANIFEST.entries()) {
      expect(posts[i].body, `${entry.id} was not posted as the manifest defines it`).toEqual(await accelSavedSearch(entry))
    }
  })

  it('records what it wrote, so a later teardown can prove it is ours', async () => {
    const { calls } = stubWorkspace()
    await applyAcceleration()
    await accelWritesSettled()
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/kvstore/accel/state')
    const doc = (put?.body as { doc?: { created?: Record<string, unknown> } })?.doc
    expect(Object.keys(doc?.created ?? {})).toEqual(MANIFEST.map((e) => e.id))
  })

  it('writes nothing on a workspace that is already correct, and says so', async () => {
    const { calls } = stubWorkspace({ saved: await allCorrect() })
    const result = await applyAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('exists'))
    expect(result.unchanged).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  it('brings a drifted entry back into line, and keeps the fields it knows nothing about', async () => {
    const drifted = await correctPlusExtras(LAKE)
    drifted.schedule = { ...(drifted.schedule as Record<string, unknown>), cronSchedule: '0 3 * * *', tz: 'America/New_York' }
    drifted.latest = '-1d'
    const { calls } = stubWorkspace({ saved: { [LAKE]: drifted, [SAMPLE]: await correct(SAMPLE) } })
    const result = await applyAcceleration()
    expect(result.steps[0].action).toBe('updated')
    const body = bodyOf(savedCalls(calls).find((c) => c.method === 'PATCH'))
    const schedule = body.schedule as Record<string, unknown>
    expect(schedule.cronSchedule).toBe('10 0 * * *')
    expect(schedule.tz).toBe('UTC')
    expect(schedule.keepLastN).toBe(2)
    expect(body.latest).toBe('now')
    // A PATCH deletes what it omits (A-SP23), so everything the app does not
    // understand has to ride back out with it.
    expect(body.chartConfig).toEqual({ type: 'bar' })
    expect(body.timezone).toBe('Europe/London')
  })

  it('does not resume a search somebody paused', async () => {
    // Pausing is a decision. A re-apply that quietly undid it would be the
    // opposite of what the person who paused it asked for.
    const paused = await correct(LAKE)
    paused.schedule = { ...(paused.schedule as Record<string, unknown>), enabled: false, cronSchedule: '0 3 * * *' }
    const { calls } = stubWorkspace({ saved: { [LAKE]: paused, [SAMPLE]: await correct(SAMPLE) } })
    await applyAcceleration()
    const schedule = bodyOf(savedCalls(calls).find((c) => c.method === 'PATCH')).schedule as { enabled: boolean }
    expect(schedule.enabled).toBe(false)
  })

  it('leaves a paused-and-correct entry completely alone', async () => {
    const paused = await correct(LAKE)
    paused.schedule = { ...(paused.schedule as Record<string, unknown>), enabled: false }
    const { calls } = stubWorkspace({ saved: await allCorrect({ [LAKE]: paused }) })
    const result = await applyAcceleration()
    expect(result.steps[0]).toEqual({ id: LAKE, action: 'exists', detail: 'already there, and paused' })
    expect(writes(calls)).toEqual([])
  })

  it('refuses to overwrite a saved search it did not create', async () => {
    const { calls } = stubWorkspace({
      saved: { [LAKE]: { id: LAKE, name: 'Daily rollup', query: 'dataset="x"', description: 'mine' } },
    })
    const result = await applyAcceleration()
    expect(result.steps[0].action).toBe('refused')
    expect(result.steps[0].detail).toContain('somebody else')
    // The sample is still created — one foreign object does not block the rest.
    expect(result.steps[1].action).toBe('created')
    expect(writes(calls).filter((c) => c.path.endsWith(LAKE))).toEqual([])
  })

  it('reports a rejected create as an error rather than claiming success', async () => {
    const { calls } = stubWorkspace({ status: { [`POST ${SAVED}`]: 500 } })
    const result = await applyAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('error'))
    expect(result.unchanged).toBe(true)
    // Nothing was created, so nothing may be recorded as created.
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/kvstore/accel/state')).toBeUndefined()
  })
})

describe('the set the confirmation named', () => {
  // `applyAcceleration` re-reads after the confirmation — correct, and always
  // was. What was missing is the other half: nothing compared the fresh read
  // against the set the dialog named. So a saved search that was `exists` when
  // the dialog opened and `differs` when Apply ran was overwritten although the
  // dialog never mentioned it — the "the dialog described a different write"
  // failure `destinationDiffMovedNote` exists to prevent for the destination.

  it('refuses a row that drifted between the dialog and the press', async () => {
    const drifted = await correctPlusExtras(LAKE)
    drifted.latest = '-1d'
    const { calls } = stubWorkspace({ saved: { [LAKE]: drifted, [SAMPLE]: await correct(SAMPLE) } })
    // The dialog was rendered when LAKE still matched, so it named nothing.
    const result = await applyAcceleration(() => {}, {})
    expect(result.steps[0].action).toBe('refused')
    expect(result.steps[0].detail).toContain('not named in that confirmation at all')
    expect(writes(calls)).toEqual([])
  })

  it('refuses a row the dialog named as a create when it now exists and differs', async () => {
    const drifted = await correctPlusExtras(LAKE)
    drifted.latest = '-1d'
    const { calls } = stubWorkspace({ saved: { [LAKE]: drifted, [SAMPLE]: await correct(SAMPLE) } })
    const result = await applyAcceleration(() => {}, { [LAKE]: 'absent' })
    expect(result.steps[0].action).toBe('refused')
    expect(result.steps[0].detail).toContain("named as 'absent'")
    expect(writes(calls)).toEqual([])
  })

  it('writes the row the dialog did name, in the state it named it', async () => {
    const drifted = await correctPlusExtras(LAKE)
    drifted.latest = '-1d'
    const { calls } = stubWorkspace({ saved: { [LAKE]: drifted, [SAMPLE]: await correct(SAMPLE) } })
    const result = await applyAcceleration(() => {}, { [LAKE]: 'differs' })
    expect(result.steps[0].action).toBe('updated')
    expect(savedCalls(calls).some((c) => c.method === 'PATCH')).toBe(true)
  })

  it('behaves exactly as before when no set is passed', async () => {
    // Callers with no dialog to name a set — the tests above, and any future
    // unattended path — must not change behaviour, or the guard becomes a
    // second way for this function to mean two things.
    const drifted = await correctPlusExtras(LAKE)
    drifted.latest = '-1d'
    stubWorkspace({ saved: { [LAKE]: drifted, [SAMPLE]: await correct(SAMPLE) } })
    const result = await applyAcceleration()
    expect(result.steps[0].action).toBe('updated')
  })
})

describe('pause and resume', () => {
  it('sends the WHOLE body, so tz and keepLastN survive the PATCH', async () => {
    // THE REGRESSION TEST FOR A-SP23. A PATCH carrying `{enabled, cronSchedule}`
    // answered 200 and dropped `tz` and `keepLastN` — the field that decides
    // which hour the job fires, and the one the read path's whole margin rests
    // on. A PATCH carrying only `{id, name, query}` deleted `schedule`,
    // `earliest`, `latest` and `description` outright and unscheduled the search
    // forever. Neither says anything on the way past.
    const { calls } = stubWorkspace({ saved: { [LAKE]: await correctPlusExtras(LAKE) } })
    const result = await pauseAcceleration(LAKE)
    expect(result.ok).toBe(true)
    expect(result.enabled).toBe(false)

    const body = bodyOf(savedCalls(calls).find((c) => c.method === 'PATCH'))
    const schedule = body.schedule as Record<string, unknown>
    expect(schedule).toEqual({
      enabled: false,
      cronSchedule: '10 0 * * *',
      tz: 'UTC',
      keepLastN: 2,
      jitterPercent: 0,
      resumeMissed: false,
      resumeOnBoot: true,
      notifications: { disabled: true, items: [] },
    })
    // …and every top-level field too, for the same reason.
    expect(body.query).toBe(accelEntry(LAKE).body)
    expect(body.earliest).toBe('-30d')
    expect(body.latest).toBe('now')
    expect(body.description).toBeTruthy()
    expect(body.chartConfig).toEqual({ type: 'bar' })
  })

  it('reads the object first rather than composing one', async () => {
    const { calls } = stubWorkspace({ saved: { [LAKE]: await correct(LAKE) } })
    await pauseAcceleration(LAKE)
    const order = savedCalls(calls).map((c) => `${c.method} ${c.path === SAVED ? 'list' : 'one'}`)
    expect(order[order.length - 3]).toBe('GET one')
    expect(order[order.length - 2]).toBe('PATCH one')
    // …and re-reads afterwards, because there is no ETag to make the write
    // conditional on.
    expect(order[order.length - 1]).toBe('GET one')
  })

  it('keeps a cron the customer edited, and only fills in what is missing', async () => {
    // Pause changes the pause flag. It is not a chance to re-impose the
    // manifest's schedule on somebody who deliberately moved it — but a field a
    // previous partial PATCH deleted has to come back, or the search stays
    // broken one confirmed click at a time.
    const theirs = await correct(LAKE)
    theirs.schedule = { enabled: true, cronSchedule: '0 3 * * *' }
    const { calls } = stubWorkspace({ saved: { [LAKE]: theirs } })
    await pauseAcceleration(LAKE)
    const schedule = bodyOf(savedCalls(calls).find((c) => c.method === 'PATCH')).schedule as Record<string, unknown>
    expect(schedule.cronSchedule).toBe('0 3 * * *')
    expect(schedule.tz).toBe('UTC')
    expect(schedule.keepLastN).toBe(2)
  })

  it('turns it back on', async () => {
    const paused = await correct(LAKE)
    paused.schedule = { ...(paused.schedule as Record<string, unknown>), enabled: false }
    stubWorkspace({ saved: { [LAKE]: paused } })
    const result = await resumeAcceleration(LAKE)
    expect(result.ok).toBe(true)
    expect(result.enabled).toBe(true)
    expect(result.raced).toBe(false)
  })

  it('notices that somebody else wrote the object while we were writing it', async () => {
    // There is no ETag, no version and no createdAt on this endpoint, so a
    // conditional write is not available and a lost update cannot be prevented.
    // Re-reading is the only check there is, and saying so is the only honest
    // thing to do with the answer.
    stubWorkspace({
      saved: { [LAKE]: await correct(LAKE) },
      afterPatch: (saved) => {
        const obj = saved.get(LAKE) as Record<string, unknown>
        obj.schedule = { ...(obj.schedule as Record<string, unknown>), enabled: true }
      },
    })
    const result = await pauseAcceleration(LAKE)
    expect(result.ok).toBe(true)
    expect(result.raced).toBe(true)
    expect(result.enabled).toBe(true)
    expect(result.detail).toContain('at the same time')
  })

  it('says so when there is nothing there to pause', async () => {
    stubWorkspace()
    const result = await pauseAcceleration(LAKE)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(LAKE)
  })
})

describe('remove', () => {
  it('deletes both and confirms they are gone', async () => {
    const { calls } = stubWorkspace({ saved: await allCorrect() })
    const result = await removeAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('deleted'))
    expect(result.stillPresent).toEqual([])
    expect(savedCalls(calls).filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(
      MANIFEST.map((e) => `${SAVED}/${e.id}`),
    )
  })

  it('refuses a saved search it cannot prove is its own, and says what it left', async () => {
    const { calls } = stubWorkspace({
      saved: {
        [LAKE]: { id: LAKE, name: 'Daily rollup', query: 'dataset="x"', description: 'the NOC’s, not the app’s' },
        [SAMPLE]: await correct(SAMPLE),
      },
    })
    const result = await removeAcceleration()
    expect(result.steps[0].action).toBe('refused')
    expect(result.left.map((l) => l.id)).toEqual([LAKE])
    expect(result.left[0].why).toContain('belongs to somebody else')
    // Nothing was sent for it. This is the assertion that matters.
    expect(savedCalls(calls).filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`${SAVED}/${SAMPLE}`])
  })

  it('deletes one whose description was edited, when its own record claims it', async () => {
    const stripped = await correct(LAKE)
    stripped.description = 'renamed by an admin'
    const { calls } = stubWorkspace({
      saved: { [LAKE]: stripped },
      kv: { 'accel/state': { version: 1, created: { [LAKE]: { at: 1, appVersion: 'dev', manifestVersion: 1, bodySha: 'a'.repeat(12), displaySha: 'b'.repeat(12), by: null } } } },
    })
    const result = await removeAcceleration()
    expect(result.steps[0].action).toBe('deleted')
    expect(savedCalls(calls).some((c) => c.method === 'DELETE' && c.path === `${SAVED}/${LAKE}`)).toBe(true)
  })

  it('re-reads, and reports anything Cribl agreed to delete and did not', async () => {
    const { calls } = stubWorkspace({ saved: await allCorrect(), deleteIsALie: true })
    const result = await removeAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('deleted'))
    // The 200s claimed it worked. The re-read is the only thing that checks.
    expect(result.stillPresent).toEqual(MANIFEST.map((e) => e.id))
    expect(savedCalls(calls).filter((c) => c.method === 'GET' && c.path === SAVED)).toHaveLength(2)
  })

  it('keeps its record of anything still standing, and forgets only what is gone', async () => {
    const seeded = {
      version: 1,
      created: {
        [LAKE]: { at: 1, appVersion: 'dev', manifestVersion: 1, bodySha: 'a'.repeat(12), displaySha: 'b'.repeat(12), by: null },
        [SAMPLE]: { at: 1, appVersion: 'dev', manifestVersion: 1, bodySha: 'c'.repeat(12), displaySha: 'd'.repeat(12), by: null },
      },
    }
    const { calls } = stubWorkspace({
      saved: { [LAKE]: await correct(LAKE), [SAMPLE]: await correct(SAMPLE) },
      kv: { 'accel/state': seeded },
      status: { [`DELETE ${SAVED}/${SAMPLE}`]: 500 },
    })
    await removeAcceleration()
    await accelWritesSettled()
    const put = calls.filter((c) => c.method === 'PUT' && c.path === '/kvstore/accel/state').pop()
    const doc = bodyOf(put).doc as { created: Record<string, unknown> }
    expect(Object.keys(doc.created)).toEqual([SAMPLE])
  })

  it('treats an already-absent search as removed rather than as a failure', async () => {
    stubWorkspace()
    const result = await removeAcceleration()
    expect(result.steps.map((s) => s.action)).toEqual(each('exists'))
    expect(result.steps[0].detail).toBe('not present')
  })

  it('never deletes a `gno_` search this release does not list', async () => {
    // An older release's entry is still ours and still billing, but this release
    // cannot say what it was for — so it is reported, loudly, and left to a
    // person. The DELETE guard would refuse it anyway; this asserts the caller
    // never gets that far.
    const { calls } = stubWorkspace({
      saved: {
        gno_old_rollup_c1h: { id: 'gno_old_rollup_c1h', name: 'GNO · old', description: 'GNO 0.8.0 · serves gno_old_rollup_c1h' },
      },
    })
    const result = await removeAcceleration()
    expect(savedCalls(calls).filter((c) => c.method === 'DELETE')).toEqual([])
    expect(result.left.map((l) => l.id)).toEqual(['gno_old_rollup_c1h'])
    expect(result.left[0].why).toContain('still billing')
  })
})

describe('what a confirmation is given to say', () => {
  it('names every search Apply will write, and what it will leave', async () => {
    const drifted = await correct(SAMPLE)
    drifted.latest = '-1m'
    stubWorkspace({ saved: { [SAMPLE]: drifted } })
    const plan = applyPlan(await readAccelState())
    expect(plan.willWrite).toEqual([
      'GNO Lake total 30 days (gno_lake_30d_c1d) — create, running 10 0 * * * UTC',
      'GNO Feed sample 2 minutes (gno_sample_2m_c1h) — overwrite, because the window it reads differs from what this release writes',
      'GNO Overview hourly (gno_overview_c1h) — create, running 20 * * * * UTC',
      'GNO Flow map nodes (gno_svc_nodes_c1h) — create, running 21 * * * * UTC',
      'GNO Flow map edges (gno_svc_edges_c1h) — create, running 22 * * * * UTC',
      'GNO Field presence 15 minutes (gno_presence_c1h) — create, running 23 * * * * UTC',
      'GNO App by source 15 minutes (gno_app_src_c1h) — create, running 36 * * * * UTC',
      'GNO DNS resolvers (gno_dns_resolver_c1h) — create, running 33 * * * * UTC',
      'GNO DNS totals (gno_dns_overall_c1h) — create, running 34 * * * * UTC',
      'GNO Pipeline telemetry (gno_pipeline_c1h) — create, running 24 * * * * UTC',
      'GNO Web hosts (gno_web_host_c1h) — create, running 45 * * * * UTC',
      'GNO Web status codes (gno_web_code_c1h) — create, running 48 * * * * UTC',
      'GNO Web requests and errors per minute (gno_web_trend_c1h) — create, running 51 * * * * UTC',
      'GNO Web HTTP2 hosts (gno_web_h2_c1h) — create, running 54 * * * * UTC',
      'GNO TCP subnet pairs 24 (gno_tcp_subnet24_c1h) — create, running 40 * * * * UTC',
      'GNO TCP subnet pairs 16 (gno_tcp_subnet16_c1h) — create, running 41 * * * * UTC',
      'GNO App and L4 bytes (gno_app_l4_c1h) — create, running 47 * * * * UTC',
      'GNO Top talkers by source (gno_talkers_src_c1h) — create, running 49 * * * * UTC',
    ])
    expect(plan.willDelete).toEqual([])
  })

  it('names every search Remove will delete, by name and by id', async () => {
    stubWorkspace({ saved: await allCorrect() })
    const plan = removalPlan(await readAccelState())
    expect(plan.willDelete).toEqual(MANIFEST.map((e) => `${e.name} (${e.id})`))
    expect(plan.willWrite).toEqual([])
  })

  it('says what Remove will NOT touch, which is the half nobody gets told', async () => {
    stubWorkspace({
      saved: { [LAKE]: { id: LAKE, name: 'Daily rollup', query: 'dataset="x"', description: 'mine' } },
    })
    const plan = removalPlan(await readAccelState())
    expect(plan.willDelete).toEqual([])
    expect(plan.willLeave[0].why).toContain('nothing says this app created it')
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
// Read this before treating a green run as evidence about a customer's Cribl.
//
//  • That Cribl accepts the POST body. The stub takes whatever it is handed. The
//    shape is checked against components.schemas.SavedQuery in openapi.json by a
//    human reading it; the first real POST is the owner's Apply in Preview.
//  • That a PATCH really does delete the fields it omits. That is A-SP23, a
//    measurement against a live workspace, and this file is built ON it rather
//    than re-proving it — the stub replaces the object wholesale because that is
//    what was measured, so it cannot independently confirm it.
//  • That the cron fires when the comments say. Nothing here parses a cron
//    expression; the Leader does, in a zone this app only declares.
//  • That `keepLastN: 2` is enough margin for the 30-day run. It depends on how
//    long that run takes wall-clock, which was not measured.
//  • Anything about `$vt_results` or what a panel does with a stored result.
//    That is the read path, a different module and a different set of failure
//    modes.
//  • That the buttons a customer presses are the gated ones. src/cribl/authz.ts
//    and src/components/gatedWrites.test.ts own that chain, and the controls for
//    these writes are not in this file's reach.

describe('the Lake total follows the dataset’s retention', () => {
  // Owner's rule, 2026-09-23: the card reports what the dataset holds, so the
  // scheduled search's window is the dataset's retention, and past what
  // cribl_metrics keeps it counts the dataset directly.
  const lakeList = (gigamonDays: number, metricsDays: number) => ({
    items: [
      { id: 'gigamon_ami', retentionPeriodInDays: gigamonDays },
      { id: 'cribl_metrics', retentionPeriodInDays: metricsDays },
    ],
  })

  it('reports an applied 30-day schedule as drifted once the retention is 365 days', async () => {
    stubWorkspace({ saved: { [LAKE]: await correct(LAKE) }, lake: lakeList(365, 30) })
    const state = await readAccelState()
    const row = state.rows.find((r) => r.id === LAKE)!
    expect(row.state).toBe('differs')
    expect(row.differences).toContain('the window it reads')
    expect(row.differences).toContain('the query it runs')
  })

  it('writes the 365-day window and the direct count on Apply', async () => {
    const { calls } = stubWorkspace({ lake: lakeList(365, 30) })
    await applyAcceleration()
    const post = savedCalls(calls).find((c) => c.method === 'POST' && c.body?.id === LAKE)
    const body = bodyOf(post)
    expect(body.earliest).toBe('-365d')
    expect(body.query).toBe(LAKE_HELD_QUERY)
    expect(body.name).toBe('GNO Lake total 365 days')
  })

  // The Lake total's write-counter query as it was before the counters were
  // built from src/queries/stackIds.ts: it named today's destination only, so
  // once the onboarding pack carries the data it reads short. A schedule
  // applied by that release still runs this string, and has to read as drift.
  const PRE_STACK_LIST_LAKE_TOTAL =
    'dataset="cribl_metrics" | summarize ' +
    'total_events=sum(iif(metric=="total.out_events" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0)), ' +
    'total_bytes=sum(iif(metric=="total.out_bytes" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0))'
  const appliedBeforeTheStackList = async () => {
    const base = accelEntry(LAKE)
    return (await accelSavedSearch({
      ...base,
      body: PRE_STACK_LIST_LAKE_TOTAL,
      panels: base.panels.map((p) => ({ ...p, display: PRE_STACK_LIST_LAKE_TOTAL })),
    })) as unknown as Record<string, unknown>
  }

  it('reports a schedule still running the pre-pack write-counter query as drifted', async () => {
    expect(LAKE_TOTAL_QUERY).not.toBe(PRE_STACK_LIST_LAKE_TOTAL)
    stubWorkspace({ saved: { [LAKE]: await appliedBeforeTheStackList() }, lake: lakeList(30, 30) })
    const row = (await readAccelState()).rows.find((r) => r.id === LAKE)!
    expect(row.state).toBe('differs')
    expect(row.differences).toContain('the query it runs')
    expect(row.differences).toContain('the query the panel shows for it')
    // Same retention, same window: only the body moved.
    expect(row.differences).not.toContain('the window it reads')
  })

  it('writes the stack-list query over it on Re-apply', async () => {
    const { calls } = stubWorkspace({
      saved: { [LAKE]: await appliedBeforeTheStackList(), [SAMPLE]: await correct(SAMPLE) },
      lake: lakeList(30, 30),
    })
    await applyAcceleration()
    const body = bodyOf(savedCalls(calls).find((c) => c.method === 'PATCH' && c.body?.id === LAKE))
    expect(body.query).toBe(LAKE_TOTAL_QUERY)
  })

  it('sees no drift on a 30-day tenant whose schedule matches the default', async () => {
    stubWorkspace({ saved: { [LAKE]: await correct(LAKE) }, lake: lakeList(30, 30) })
    const state = await readAccelState()
    expect(state.rows.find((r) => r.id === LAKE)!.state).toBe('enabled')
  })
})
