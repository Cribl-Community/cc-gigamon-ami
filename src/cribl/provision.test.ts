// The five things about provisioning that are expensive to get wrong.
//
// This is the only module in the app that writes customer configuration, and it
// has no dry run: the way to find out whether a change is right is to point it
// at somebody's Leader. So the parts that have already been wrong once are
// pinned here instead.
//
//   THE ROUTING TABLE. `PATCH /m/<group>/routes/<id>` replaces the table
//   wholesale — the array in the body BECOMES the customer's routing order, and
//   the object around it carries their Route Groups and route comments. An
//   earlier version rebuilt it as `[ours, ...theirs]` on every run, so
//   re-applying an already-installed stack moved our route to the top of a live
//   table. These tests assert on indexes, not on membership.
//
//   THE DEPLOY FALLBACK. Two paths do the same thing, one deprecated, and the
//   difference between "fall back on 404" and "fall back on failure" is whether
//   a 5xx that already started a deploy gets deployed twice. 403 and 5xx are
//   asserted separately from 404 for that reason.
//
//   THE STRANDED COMMIT. A commit that succeeded followed by a deploy that
//   failed used to be unreachable: the next run found nothing pending and
//   returned before it got as far as deploying. The fix is only worth anything
//   if it does NOT also fire when the group is genuinely up to date, so both
//   directions are here.
//
//   THE NO-OP RE-APPLY (added in Phase 3). `ensurePipeline` and `ensureSource`
//   used to PATCH whenever the object existed, so pressing Re-apply on a settled
//   stack wrote twice, reported both `updated`, committed, and deployed — and a
//   deploy restarts that group's Worker Processes. `ensureRoute` never did this.
//   The tests below assert the ABSENCE of a request, which is the only way to
//   assert a no-op: a green "it still works" says nothing about what it sent.
//
//   THE CONFIRMATION SEAM (Phase 3). Every ensure* now asks before it writes, and
//   must not ask about an object that already matches. Both halves are here,
//   because a confirmation that fires for a change that is not happening trains
//   people to click through the ones that are.
//
// Stubbed at `fetch` rather than at `capi`, so what these assertions read is the
// request the platform would have received — the method, the path, and the exact
// body. The fake Leader below answers; anything it does that a real Leader does
// not is a bug in this file. There is a list at the bottom of what that means
// these tests cannot tell you.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, FLUSH_PRESETS, datasetSpec, destinationSpec } from './landing'
import {
  deployAll, pendingDeploy, removeSyslogStack,
  ROUTE_SPEC, PIPELINE_SPEC, SOURCE_SPEC, DATASET_SPEC, DESTINATION_SPEC, destinationSpecFor,
  SYSLOG_ROUTE_ID, SYSLOG_PIPELINE_ID, SYSLOG_SOURCE_ID, DEFAULT_STREAM_GROUP,
  type PendingChange, type StepResult,
} from './provision'

const GROUP = DEFAULT_STREAM_GROUP
const HEAD = 'aaaa111122223333aaaa111122223333aaaa1111'
const DEPLOYED = 'bbbb444455556666bbbb444455556666bbbb4444'
const NEW_COMMIT = 'cccc777788889999cccc777788889999cccc7777'

const PRODUCTS_DEPLOY = `/products/stream/groups/${GROUP}/deploy`
const MASTER_DEPLOY = `/master/groups/${GROUP}/deploy`
const ROUTES_PATCH = `/m/${GROUP}/routes/default`

interface Call { method: string; path: string; body: unknown }

interface LeaderOpts {
  /** The routing table's `routes` array, in the order the Leader holds it. */
  routes?: Array<Record<string, unknown>>
  /** Extra fields on the routing-table object itself (comments, Route Groups). */
  table?: Record<string, unknown>
  /** Paths `/version/status` reports as uncommitted. */
  pending?: string[]
  /** Commit hash `/version/commit` answers with; null = "nothing to commit". */
  commit?: string | null
  /** Status per deploy path, so a test can 404 / 403 / 500 one of them. */
  deploy?: Record<string, number>
  /** The commit the group's Workers are running. */
  configVersion?: string
  /** Newest commit in the config repo. */
  head?: string
  /** Files `/version/files` reports as changed since `configVersion`. */
  changedSince?: string[]
  /** The live pipeline object, as `GET /m/<g>/pipelines/<id>` returns it. `null`
   *  keeps the old default: a 200 whose `items` this file cannot read, which is
   *  deliberately still treated as "needs writing". */
  pipeline?: Record<string, unknown> | null
  /** The live syslog source, likewise. */
  source?: Record<string, unknown> | null
}

const catchAll = { id: 'default', name: 'default', filter: 'true', final: false, pipeline: 'main' }

/** A Leader with the whole stack already present, so a test only has to say what
 *  is different about its own case. */
/**
 * The Guided Setup commit memory the stubbed KV store answers with — i.e. which
 * commits this app is willing to claim as its own. A stranded commit is only
 * ever deployed when it is in here, so a test that wants the deploy to happen
 * must say so, and the default (empty) is the safe one.
 */
let ourCommits: Record<string, Record<string, { hash: string; message: string }>> = {}
const weCommitted = (hash: string) => { ourCommits = { [GROUP]: { route: { hash, message: 'ours' } } } }

beforeEach(() => { ourCommits = {} })

function stubLeader(opts: LeaderOpts = {}): Call[] {
  const {
    routes = [catchAll], table = {}, pending = [], commit = NEW_COMMIT, deploy = {},
    configVersion = HEAD, head = HEAD, changedSince = [],
    pipeline = null, source = null,
  } = opts
  const calls: Call[] = []

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '')
    const body = init.body == null ? undefined : (JSON.parse(String(init.body)) as unknown)
    calls.push({ method, path, body })

    const at = (m: string, p: string) => method === m && path === p
    const under = (m: string, p: string) => method === m && path.startsWith(p)
    const reply = (status: number, value?: unknown) => {
      const text = value === undefined ? '' : JSON.stringify(value)
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 404 ? 'Not Found' : 'OK',
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      }
    }

    // Deploy — the two paths, each answerable independently.
    if (at('PATCH', PRODUCTS_DEPLOY)) return reply(deploy[PRODUCTS_DEPLOY] ?? 200, { items: [] })
    if (at('PATCH', MASTER_DEPLOY)) return reply(deploy[MASTER_DEPLOY] ?? 200, { items: [] })

    // The group record, for the commit its Workers are running.
    if (at('GET', `/products/stream/groups/${GROUP}`)) return reply(200, { items: [{ id: GROUP, configVersion }] })

    // Git.
    if (under('GET', '/version/files')) return reply(200, { items: [{ count: changedSince.length, items: changedSince.map((name) => ({ name, state: 'M' })) }] })
    if (under('GET', '/version?')) return reply(200, { items: [{ hash: head, refs: 'HEAD -> main' }] })
    if (at('GET', '/version/status')) return reply(200, { items: [{ files: pending.map((p) => ({ path: p })) }] })
    if (at('POST', '/version/commit')) return reply(200, commit === null ? { items: [{}] } : { items: [{ commit }] })

    // The routing table, and everything else already provisioned.
    if (at('GET', `/m/${GROUP}/routes`)) return reply(200, { items: [{ id: 'default', ...table, routes }] })
    if (at('PATCH', ROUTES_PATCH)) return reply(200, { items: [] })
    if (at('GET', '/products/lake/lakes/default/datasets')) return reply(200, { items: [{ id: 'gigamon_ami' }] })

    // The two objects whose no-op check Phase 3 added. Answering with a real
    // body is what lets a test say "already correct" at all — the catch-all
    // below answers `{ items: [] }`, which reads as unreadable and still writes.
    if (at('GET', `/m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`)) return reply(200, { items: pipeline ? [pipeline] : [] })
    if (at('GET', `/m/${GROUP}/system/inputs/${SYSLOG_SOURCE_ID}`)) return reply(200, { items: source ? [source] : [] })
    // Everything else in the group already exists and takes whatever is sent.
    // A re-apply therefore PATCHes the pipeline and the source every time and
    // reports them `updated` — which is exactly what a real Leader does, and why
    // the "nothing to commit" case below is reached through the commit rather
    // than before it.
    if (under('GET', `/m/${GROUP}/`) || under('PATCH', `/m/${GROUP}/`) || under('POST', `/m/${GROUP}/`) || under('DELETE', `/m/${GROUP}/`)) {
      return reply(200, { items: [] })
    }

    // The app's own audit trail (cribl/kv.ts) — not what these tests are about,
    // but it must not 404 its way into a console full of warnings.
    if (under('PUT', '/kvstore/')) return reply(200, '')

    // The commit memory decides whether a stranded commit is OURS to deploy.
    // `ourCommits` is what Guided Setup would have recorded; an empty object
    // means the app has never committed anything here, and nothing is deployed.
    if (under('GET', '/kvstore/guided_setup_memory/commits')) {
      return reply(200, { version: 1, updatedAt: 0, doc: ourCommits })
    }

    return reply(404, { message: `no stub for ${method} ${path}` })
  })
  return calls
}

const run = () => new Promise<StepResult[]>((resolve) => { void deployAll(() => {}, GROUP).then(resolve) })
const runWith = (opts: Parameters<typeof deployAll>[3]) =>
  new Promise<StepResult[]>((resolve) => { void deployAll(() => {}, GROUP, undefined, opts).then(resolve) })

/** Everything the run sent to Cribl that was not a read. The app's own KV store
 *  is dropped: the audit trail is a write, it is not a write to the customer's
 *  configuration, and these assertions are about the latter. */
const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore/')).map((c) => `${c.method} ${c.path}`)
const patched = (calls: Call[]) => calls.find((c) => c.method === 'PATCH' && c.path === ROUTES_PATCH)
const routesSent = (calls: Call[]) => (patched(calls)?.body as { routes: Array<Record<string, unknown>> } | undefined)?.routes
const step = (steps: StepResult[], key: string) => steps.find((s) => s.key === key)

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ensureRoute', () => {
  it('leaves an existing route at its own index instead of promoting it to the top', async () => {
    const stale = { ...ROUTE_SPEC, description: 'from an older version of this app' }
    const calls = stubLeader({
      routes: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, stale, catchAll],
      table: { comments: [{ text: 'do not reorder' }], groups: { grp1: { name: 'Team A' } } },
    })
    const steps = await run()

    const sent = routesSent(calls)
    expect(sent, 'the stale route should have been patched').toBeDefined()
    expect(sent!.map((r) => r.id)).toEqual(['a', 'b', SYSLOG_ROUTE_ID, 'default'])
    expect(step(steps, 'route')?.action).toBe('updated')
    // The table object carries more than `routes`. Sending back `{ id, routes }`
    // would delete a customer's Route Groups and route comments outright.
    const table = patched(calls)!.body as Record<string, unknown>
    expect(table.comments).toEqual([{ text: 'do not reorder' }])
    expect(table.groups).toEqual({ grp1: { name: 'Team A' } })
  })

  it('keeps fields the Leader put on the live route that our spec never mentions', async () => {
    // `groupId` is how somebody files a route into a Route Group. Replacing the
    // entry rather than merging onto it quietly takes it back out.
    const filed = { ...ROUTE_SPEC, groupId: 'grp1', description: 'stale' }
    const calls = stubLeader({ routes: [filed, catchAll] })
    await run()
    expect(routesSent(calls)![0].groupId).toBe('grp1')
  })

  it('does not PATCH at all when the route is already exactly right', async () => {
    // A no-op write still rewrites the table and dirties the group's Git status,
    // and this runs every time somebody presses Re-apply.
    const calls = stubLeader({ routes: [{ ...ROUTE_SPEC }, catchAll] })
    const steps = await run()
    expect(patched(calls), 'an identical route was PATCHed anyway').toBeUndefined()
    expect(step(steps, 'route')?.action).toBe('exists')
  })

  it('inserts a missing route directly above the catch-all, not at the top', async () => {
    const calls = stubLeader({ routes: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, catchAll] })
    const steps = await run()
    expect(routesSent(calls)!.map((r) => r.id)).toEqual(['a', 'b', SYSLOG_ROUTE_ID, 'default'])
    expect(step(steps, 'route')?.action).toBe('created')
  })

  it('treats the first unconditional route as the catch-all when nothing is called default', async () => {
    const calls = stubLeader({ routes: [{ id: 'a', name: 'a', filter: "host=='x'" }, { id: 'everything', name: 'everything', filter: 'true' }] })
    await run()
    expect(routesSent(calls)!.map((r) => r.id)).toEqual(['a', SYSLOG_ROUTE_ID, 'everything'])
  })

  it('removes only our entry on teardown, leaving every other index where it was', async () => {
    const calls = stubLeader({
      routes: [{ id: 'a', name: 'a' }, { ...ROUTE_SPEC }, { id: 'b', name: 'b' }, catchAll],
      table: { comments: [{ text: 'keep me' }] },
      pending: [`groups/${GROUP}/local/cribl/routes.yml`],
    })
    await new Promise<void>((resolve) => { void removeSyslogStack(() => {}, GROUP, undefined, { route: 'present', source: 'absent', pipeline: 'absent' }).then(() => resolve()) })

    expect(routesSent(calls)!.map((r) => r.id)).toEqual(['a', 'b', 'default'])
    expect((patched(calls)!.body as { comments?: unknown }).comments).toEqual([{ text: 'keep me' }])
  })
})

describe('a re-apply that has nothing to apply', () => {
  // The whole stack present and already saying what the spec says — the state a
  // customer's workspace is in every time after the first, and the one the
  // Re-apply button is pressed from.
  const settled = {
    routes: [{ ...ROUTE_SPEC }, catchAll],
    // Both live objects carry fields this app never set, which is the normal
    // case and the reason the comparison is a subset test: a live source has
    // thirty fields, and somebody may have renamed the pipeline in the UI.
    pipeline: { ...PIPELINE_SPEC, description: 'renamed in the Cribl UI' },
    source: { ...SOURCE_SPEC, environment: 'prod', pqEnabled: false },
  }

  it('sends no write at all — not even the PATCH that used to dirty Git and deploy', async () => {
    // The defect this closes: two unconditional PATCHes reported `updated`, both
    // entered touchedKeys, and the run carried on into commit and deploy — and a
    // deploy restarts that worker group's Worker Processes.
    const calls = stubLeader(settled)
    const steps = await run()

    expect(writes(calls), 'a settled stack was written to anyway').toEqual([])
    expect(['dataset', 'destination', 'pipeline', 'source', 'route'].map((k) => step(steps, k)?.action))
      .toEqual(['exists', 'exists', 'exists', 'exists', 'exists'])
    expect(step(steps, 'commit')?.detail).toBe('no changes to commit')
    expect(step(steps, 'deploy'), 'a zero-change re-apply restarted the group’s Worker Processes').toBeUndefined()
  })

  it('still writes when one field has drifted, and says which one', async () => {
    const calls = stubLeader({ ...settled, source: { ...SOURCE_SPEC, tcpPort: 9999 } })
    const steps = await run()

    expect(writes(calls)).toContain(`PATCH /m/${GROUP}/system/inputs/${SYSLOG_SOURCE_ID}`)
    expect(step(steps, 'source')?.action).toBe('updated')
    expect(step(steps, 'source')?.detail, 'the step named no field, so the log says a write happened and not what it was').toContain('tcpPort')
    // And the pipeline, which did not drift, is still left alone.
    expect(writes(calls)).not.toContain(`PATCH /m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`)
  })

  it('counts an extra function somebody added as a change, because sending ours would delete it', async () => {
    const extra = { id: 'eval', filter: 'true', disabled: false, description: 'theirs', conf: { add: [] } }
    const calls = stubLeader({
      ...settled,
      pipeline: { ...PIPELINE_SPEC, conf: { functions: [...PIPELINE_SPEC.conf.functions, extra] } },
    })
    const steps = await run()

    expect(writes(calls)).toContain(`PATCH /m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`)
    expect(step(steps, 'pipeline')?.detail).toContain('conf')
  })

  it('writes when the live object cannot be read, because "I could not see it" is not "it is right"', async () => {
    // A 200 whose body this file does not understand. The old behaviour — PATCH
    // regardless — is the correct one here and is deliberately kept.
    const calls = stubLeader({ ...settled, pipeline: null, source: null })
    await run()
    expect(writes(calls)).toContain(`PATCH /m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`)
    expect(writes(calls)).toContain(`PATCH /m/${GROUP}/system/inputs/${SYSLOG_SOURCE_ID}`)
  })
})

describe('the confirmation seam', () => {
  const settled = {
    routes: [{ ...ROUTE_SPEC }, catchAll],
    pipeline: { ...PIPELINE_SPEC },
    source: { ...SOURCE_SPEC },
  }

  it('is never asked about an object that already matches', async () => {
    // A confirmation that fires for a change that is not happening is how people
    // learn to click through the ones that are.
    const asked: PendingChange[] = []
    stubLeader(settled)
    await runWith({ confirm: (c) => { asked.push(c); return true } })
    expect(asked, 'the dialog was offered a change nothing was going to make').toEqual([])
  })

  it('is asked once, with the diff, for the one object that drifted', async () => {
    const asked: PendingChange[] = []
    stubLeader({ ...settled, source: { ...SOURCE_SPEC, tcpPort: 9999 } })
    await runWith({ confirm: (c) => { asked.push(c); return true } })

    expect(asked.map((c) => `${c.key}:${c.action}`)).toEqual(['source:overwrite'])
    expect(asked[0].object, 'the change did not name the Cribl object').toContain(SYSLOG_SOURCE_ID)
    expect(asked[0].diff.map((d) => [d.key, d.before, d.after])).toEqual([['tcpPort', 9999, SOURCE_SPEC.tcpPort]])
  })

  it('writes nothing when the answer is no, and commits nothing either', async () => {
    const calls = stubLeader({ ...settled, source: { ...SOURCE_SPEC, tcpPort: 9999 } })
    const steps = await runWith({ confirm: () => false })

    expect(writes(calls), 'the write went out after the confirmation said no').toEqual([])
    expect(step(steps, 'source')?.action).toBe('skipped')
    expect(step(steps, 'source')?.detail).toContain('not confirmed')
    // The steps below it depend on it, so they are reported as not reached —
    // named, rather than left looking absent.
    expect(step(steps, 'route')?.detail).toContain('not confirmed')
    expect(steps.some((s) => s.key === 'commit'), 'a refused run went on to commit').toBe(false)
  })

  it('treats a confirmation that throws as a no, not as a yes', async () => {
    // A dialog that unmounted, a rejected promise, a caller that threw: all of
    // them are "this was not agreed to", and the only dangerous reading is the
    // optimistic one.
    const calls = stubLeader({ ...settled, source: { ...SOURCE_SPEC, tcpPort: 9999 } })
    const steps = await runWith({ confirm: () => { throw new Error('the dialog went away') } })
    expect(writes(calls)).toEqual([])
    expect(step(steps, 'source')?.action).toBe('skipped')
  })

  it('reports a refusal as a refusal rather than as a failure', async () => {
    // `error` means Cribl said no; `skipped` means the person did. Rendering the
    // second as the first sends somebody to look for a fault they caused.
    stubLeader({ ...settled, source: { ...SOURCE_SPEC, tcpPort: 9999 } })
    const steps = await runWith({ confirm: () => false })
    expect(steps.some((s) => s.action === 'error')).toBe(false)
  })
})

describe('the two Lake specs', () => {
  // These used to be two hand-written copies of the same numbers — one here and
  // one in landing.ts's `nearLive` preset — with a comment between them naming a
  // line number. This is the pin that replaced the comment.

  it('are the landing profile this release ships, not a second set of literals', () => {
    expect(DATASET_SPEC).toEqual(datasetSpec(DEFAULT_PROFILE))
    expect(DESTINATION_SPEC).toEqual({ id: 'gigamon_lake', type: 'cribl_lake', ...destinationSpec(DEFAULT_PROFILE).set })
  })

  it('still describes exactly what this app has always provisioned', () => {
    // The point of parameterising is that the DEFAULT is unchanged. If this
    // fails, Phase 3 changed a customer's landing, which it is explicitly not
    // allowed to do — the format migration is Phase 4's, behind P-S1 and P-S5.
    expect(DATASET_SPEC).toEqual({
      id: 'gigamon_ami',
      description: 'Gigamon Application Metadata Intelligence (AMI) flow records',
      retentionPeriodInDays: 30,
      format: 'json',
    })
    expect(DESTINATION_SPEC).toEqual({
      id: 'gigamon_lake',
      type: 'cribl_lake',
      destPath: 'gigamon_ami',
      format: 'json',
      storageLocationId: 'cribl_lake',
      maxFileSizeMB: 5,
      maxFileOpenTimeSec: 60,
      maxFileIdleTimeSec: 15,
      compress: 'gzip',
      onBackpressure: 'block',
    })
  })

  it('is the preset landing.ts calls "near-live" — the two cannot drift now', () => {
    const { maxFileSizeMB, maxFileOpenTimeSec, maxFileIdleTimeSec } = FLUSH_PRESETS.nearLive
    expect(DESTINATION_SPEC).toMatchObject({ maxFileSizeMB, maxFileOpenTimeSec, maxFileIdleTimeSec })
  })

  it('takes a different profile without touching the identity keys', () => {
    // The seam §2.4 asks for. `id` and `type` are what the object IS; everything
    // else is what it was asked to be.
    const balanced = { ...DEFAULT_PROFILE, flush: FLUSH_PRESETS.balanced }
    const spec = destinationSpecFor(balanced)
    expect(spec).toMatchObject({ id: 'gigamon_lake', type: 'cribl_lake', maxFileSizeMB: 32, maxFileOpenTimeSec: 120 })
  })
})

describe('deployGroup', () => {
  const upToDate = { routes: [{ ...ROUTE_SPEC }, catchAll] }

  it('uses the current products path, and never touches the deprecated one when it answers', async () => {
    const calls = stubLeader(upToDate)
    const steps = await run()
    expect(calls.find((c) => c.path === PRODUCTS_DEPLOY)?.body).toEqual({ version: NEW_COMMIT })
    expect(calls.some((c) => c.path === MASTER_DEPLOY), 'the deprecated path was called even though the current one worked').toBe(false)
    expect(step(steps, 'deploy')?.action).toBe('created')
  })

  it('falls back to the deprecated path on 404 — the one status that means "this Leader has no such route"', async () => {
    const calls = stubLeader({ ...upToDate, deploy: { [PRODUCTS_DEPLOY]: 404 } })
    const steps = await run()
    expect(calls.filter((c) => c.path === MASTER_DEPLOY)).toHaveLength(1)
    expect(step(steps, 'deploy')?.action).toBe('created')
  })

  for (const status of [403, 500]) {
    it(`surfaces ${status} instead of retrying it against the other path`, async () => {
      // 403 says this user may not deploy this group, and a second path cannot
      // grant permission. 500 is worse: the deploy may already have started, so
      // a blind second attempt is a second deploy.
      const calls = stubLeader({ ...upToDate, deploy: { [PRODUCTS_DEPLOY]: status } })
      const steps = await run()
      expect(calls.some((c) => c.path === MASTER_DEPLOY), `a ${status} was retried against the deprecated path`).toBe(false)
      expect(step(steps, 'deploy')?.action).toBe('error')
    })
  }
})

describe('an undeployed commit', () => {
  // The stack is entirely present, so a re-apply changes nothing that Git can
  // see. That reaches the "nothing to commit" exit two different ways, and both
  // used to return before the deploy:
  //
  //   NO NET CHANGE  the re-apply PATCHes the pipeline and source with what they
  //     already say, so files are offered but the commit answers no hash.
  //   NOTHING TO OFFER  Git has pending changes, but none of them ours, so there
  //     is no file list to commit at all.
  const settled = { routes: [{ ...ROUTE_SPEC }, catchAll] }
  const noNetChange = { ...settled, commit: null }
  const nothingOfOurs = { ...settled, pending: ['groups/other_group/local/cribl/outputs.yml'] }
  const stranded = { configVersion: DEPLOYED, head: HEAD, changedSince: [`groups/${GROUP}/local/cribl/routes.yml`] }

  it('is deployed rather than reported as up to date when the commit is a no-op', async () => {
    weCommitted(HEAD)
    const calls = stubLeader({ ...noNetChange, ...stranded })
    const steps = await run()

    const deploy = calls.find((c) => c.path === PRODUCTS_DEPLOY)
    expect(deploy, 'the stranded commit was never deployed').toBeDefined()
    expect(deploy!.body).toEqual({ version: HEAD })
    expect(step(steps, 'deploy')?.action).toBe('created')
    expect(step(steps, 'commit')?.detail).toBe('nothing to commit')
  })

  it('is deployed rather than reported as up to date when there is no file list at all', async () => {
    weCommitted(HEAD)
    const calls = stubLeader({ ...nothingOfOurs, ...stranded })
    const steps = await run()

    expect(calls.find((c) => c.path === PRODUCTS_DEPLOY)?.body).toEqual({ version: HEAD })
    expect(step(steps, 'commit')?.detail).toBe('no changes to commit')
    // No commit was invented to justify the deploy — the whole point is that it
    // already exists.
    expect(calls.some((c) => c.path === '/version/commit')).toBe(false)
  })

  it('is left alone when this app did not make it', async () => {
    // The config repo is shared. An undeployed commit on this group can be
    // another admin's half-finished work, and deploying it would restart the
    // group's Worker Processes and put their change live — something nobody
    // asked for and no confirmation named. The commit memory is what tells us
    // whose it is; here it holds a different hash.
    weCommitted('cccc777788889999cccc777788889999cccc7777')
    const calls = stubLeader({ ...noNetChange, ...stranded })
    const steps = await run()

    expect(calls.some((c) => c.path === PRODUCTS_DEPLOY), 'deployed a commit this app never made').toBe(false)
    expect(step(steps, 'deploy')?.detail).toContain('this app did not make')
  })

  it('is left alone when the app has never committed anything here', async () => {
    // Nothing recorded — a fresh install, or a KV store that has never been
    // written. Nothing is ours, so nothing is deployed. Silence is not consent.
    const calls = stubLeader({ ...noNetChange, ...stranded })
    const steps = await run()

    expect(calls.some((c) => c.path === PRODUCTS_DEPLOY), 'deployed on an empty commit memory').toBe(false)
    expect(step(steps, 'deploy')?.action).toBe('exists')
  })

  it('is not claimed when the group is already running the newest commit', async () => {
    const calls = stubLeader({ ...nothingOfOurs, configVersion: HEAD, head: HEAD })
    const steps = await run()
    expect(calls.some((c) => c.path === PRODUCTS_DEPLOY), 'deployed a group that was already up to date').toBe(false)
    expect(step(steps, 'commit')?.detail).toBe('no changes to commit')
    expect(step(steps, 'deploy')).toBeUndefined()
  })

  it('is not claimed when the only files that moved belong to another group', async () => {
    // The config repo is shared, so a newer HEAD on its own only says that
    // somebody committed something somewhere.
    const calls = stubLeader({
      ...nothingOfOurs, configVersion: DEPLOYED, head: HEAD,
      changedSince: ['groups/other_group/local/cribl/routes.yml'],
    })
    await run()
    expect(calls.some((c) => c.path === PRODUCTS_DEPLOY)).toBe(false)
  })

  it('reads as "none" rather than guessing when the group record is unavailable', async () => {
    stubLeader({ ...settled, configVersion: '' })
    expect(await pendingDeploy(GROUP)).toBe(null)
  })

  it('takes the commit that carries the HEAD ref, not whichever the history listed first', async () => {
    // Getting this backwards deploys an old commit to a live group, which is a
    // rollback nobody asked for.
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/capi/, '')
      const method = (init.method ?? 'GET').toUpperCase()
      const reply = (value: unknown) => ({
        ok: true, status: 200, statusText: 'OK',
        text: async () => JSON.stringify(value), json: async () => value,
      })
      if (path.startsWith('/version/files')) return reply({ items: [{ items: [{ name: `groups/${GROUP}/local/cribl/routes.yml` }] }] })
      if (path.startsWith('/version?')) {
        return reply({ items: [{ hash: 'oldest0000', refs: '' }, { hash: HEAD, refs: 'HEAD -> main' }] })
      }
      if (method === 'GET' && path === `/products/stream/groups/${GROUP}`) return reply({ items: [{ id: GROUP, configVersion: DEPLOYED }] })
      return reply({ items: [] })
    })
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
  })
})

// ── What these tests could not assert, and why ──────────────────────────────
//
// Read this before reporting a green run as a result. The fake Leader above is
// transcribed from the API spec and from one measured workspace; every status in
// it is a decision this file made.
//
//   * WHETHER A REAL LEADER DIRTIES A CONFIG FILE FOR AN IDENTICAL-BODY PATCH.
//     This is the question that decides how bad the defect fixed here actually
//     was: if Cribl reports no pending file for a no-change PATCH, the old code
//     stopped at "no changes to commit"; if it does report one, a zero-change
//     re-apply committed and restarted that group's Worker Processes. The stub
//     answers `/version/status` from `pending`, which is to say this file decides
//     the answer. It needs a live Leader, and it is a Preview check.
//
//   * WHETHER A LIVE OBJECT LOOKS LIKE THE ONE STUBBED HERE. `covered` is a
//     subset test precisely because a live source carries fields this app never
//     names — but which fields, and whether Cribl normalises a value on the way
//     in (a port as a string, a `filter` it rewrote), is unmeasured. If it does,
//     the spec will never look satisfied and the PATCH goes out on every
//     re-apply again — the old behaviour, safely, but the fix would be doing
//     nothing. The way to find out is one re-apply on a settled stack with the
//     network tab open.
//
//   * THAT THE CONFIRMATION A CUSTOMER SEES IS THE ONE THESE TESTS PASS. They
//     assert that the writers ASK and obey the answer. What components/
//     ProvisionPanel.tsx does with a `PendingChange` — whether it renders the
//     diff at all — is that file's, and nothing here can see it.
//
//   * ANY REFUSAL. Every 401/403 in this suite is fabricated. The gate is
//     retrospective and this workspace's callers are all admins, so no
//     permission has ever actually been enforced against this code (V-S11).
