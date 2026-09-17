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
  commitScope, deployAll, pendingDeploy, removeSyslogStack,
  ROUTE_SPEC, PIPELINE_SPEC, SOURCE_SPEC, DATASET_SPEC, DESTINATION_SPEC, destinationSpecFor,
  SYSLOG_ROUTE_ID, SYSLOG_PIPELINE_ID, SYSLOG_SOURCE_ID, DEFAULT_STREAM_GROUP,
  type PendingChange, type ResourceKey, type StepResult,
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
  /** The live pipeline object, as `GET /m/<g>/pipelines/<id>` returns it.
   *  Defaults to `STALE_PIPELINE` — present, and one spec field out of date, so a
   *  re-apply writes. `null` means a 200 whose `items` this file cannot read,
   *  which since the full-replacement fix must NOT write. */
  pipeline?: Record<string, unknown> | null
  /** The live syslog source, likewise. */
  source?: Record<string, unknown> | null
  /**
   * What the pipeline / source / routing-table GET answers FROM THE SECOND READ
   * ONWARD — i.e. the other admin.
   *
   * Every ensure* reads once to compose the diff its confirmation shows, and
   * again after the answer to compose the body it sends. Everything between
   * those two reads is time somebody spent in front of a Modal, so this is the
   * only way to stage the window the write used to be composed across: a body
   * built on the first read is a FULL REPLACEMENT of an object that has moved,
   * which does not lose the race, it reverts the other writer. `undefined`
   * means nothing moved and both reads answer the same thing.
   */
  pipelineBetweenReads?: Record<string, unknown> | null
  sourceBetweenReads?: Record<string, unknown> | null
  routesBetweenReads?: Array<Record<string, unknown>> | null
}

/**
 * A live pipeline and source that EXIST and are stale in exactly one spec field.
 *
 * This is the stub default, and it used to be `null` — a 200 whose `items` this
 * app could not read, which the old code treated as "needs writing" and patched
 * with the bare spec. That is the maximal form of the full-replacement defect,
 * so an unreadable body is now an error and writes nothing; every test that only
 * wants the run to REACH the commit and the deploy needs a readable body that
 * drifted instead. These are it.
 */
const STALE_PIPELINE = { ...PIPELINE_SPEC, conf: { ...PIPELINE_SPEC.conf, functions: [] } }
const STALE_SOURCE = { ...SOURCE_SPEC, tcpPort: 1514 }

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
    pipeline = STALE_PIPELINE, source = STALE_SOURCE,
    pipelineBetweenReads, sourceBetweenReads, routesBetweenReads,
  } = opts
  const calls: Call[] = []
  let pipeReads = 0
  let sourceReads = 0
  let routeReads = 0

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
    if (at('GET', `/m/${GROUP}/routes`)) {
      routeReads += 1
      const now = routeReads >= 2 && routesBetweenReads !== undefined ? routesBetweenReads : routes
      return reply(200, now === null ? { items: [] } : { items: [{ id: 'default', ...table, routes: now }] })
    }
    if (at('PATCH', ROUTES_PATCH)) return reply(200, { items: [] })
    if (at('GET', '/products/lake/lakes/default/datasets')) return reply(200, { items: [{ id: 'gigamon_ami' }] })

    // The two objects whose no-op check Phase 3 added, and whose PATCH is now a
    // merge onto this body. Answering with a real body is what lets a test say
    // "already correct" at all — and, since the merge, what lets it say anything
    // about the request body, which is composed from exactly this.
    if (at('GET', `/m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`)) {
      pipeReads += 1
      const now = pipeReads >= 2 && pipelineBetweenReads !== undefined ? pipelineBetweenReads : pipeline
      return reply(200, { items: now ? [now] : [] })
    }
    if (at('GET', `/m/${GROUP}/system/inputs/${SYSLOG_SOURCE_ID}`)) {
      sourceReads += 1
      const now = sourceReads >= 2 && sourceBetweenReads !== undefined ? sourceBetweenReads : source
      return reply(200, { items: now ? [now] : [] })
    }
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

  it('sends no PATCH when the live object cannot be read, because the body is composed from it', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the assertion it made was the
    // defect at its worst. A 200 whose `items` this file cannot read used to
    // mean "every spec key is missing, so write" — and the write was the bare
    // spec against an endpoint that removes every omitted field, i.e. a live
    // source reduced to eight keys and a live pipeline to two. "I could not see
    // it" is still not "it is already right"; it is now "I cannot compose a
    // complete representation", and the only safe answer to that is not to send
    // one. It is an `error`, not `exists`, so the run stops and nothing is
    // committed or deployed on top of it.
    const calls = stubLeader({ ...settled, pipeline: null })
    const steps = await run()
    expect(writes(calls)).not.toContain(`PATCH /m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`)
    expect(step(steps, 'pipeline')?.action).toBe('error')
    expect(step(steps, 'pipeline')?.detail).toContain('could not read the live')
    expect(steps.some((s) => s.key === 'commit'), 'committed on top of an object it could not read').toBe(false)
  })

  it('sends no PATCH for an unreadable source either', async () => {
    const calls = stubLeader({ ...settled, source: null })
    const steps = await run()
    expect(writes(calls)).not.toContain(`PATCH /m/${GROUP}/system/inputs/${SYSLOG_SOURCE_ID}`)
    expect(step(steps, 'source')?.action).toBe('error')
  })
})

// ── The full-replacement defect (found 2026-09-17, shipped in 1.0.20) ────────
//
// `PATCH /pipelines/{id}` and `PATCH /system/inputs/{id}` are documented in
// openapi.json as full replacements — "Cribl removes any omitted fields". Both
// sites sent the SPEC, so a Re-apply that found one field drifted deleted every
// field the spec does not name. `ensureRoute` never did this. These tests assert
// on the BODY, because the path and the status say nothing about what was lost.
describe('a PATCH is a full replacement', () => {
  const bodySent = (calls: Call[], path: string) =>
    calls.find((c) => c.method === 'PATCH' && c.path === path)?.body as Record<string, unknown> | undefined
  const SOURCE_PATH = `/m/${GROUP}/system/inputs/${SYSLOG_SOURCE_ID}`
  const PIPELINE_PATH = `/m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`

  /** A syslog source a customer has actually configured: TLS terminated at the
   *  Source, a persistent queue, a connection cap, a renamed description, and a
   *  QuickConnect connection. None of it is anything this app names. */
  const customised = {
    ...SOURCE_SPEC,
    tcpPort: 9999, // the one spec field that drifted, so the write happens at all
    description: 'Gigamon AMX — DC1 collector',
    maxActiveCxn: 200,
    ipWhitelistRegex: '^10\\.',
    pqEnabled: true,
    pq: { mode: 'always', maxBufferSizeBytes: '1MB', compress: 'none', onBackpressure: 'drop' },
    tls: { disabled: false, certificateName: 'dc1-collector', requestCert: true },
    connections: [{ output: 'gigamon_lake', pipeline: 'gigamon_syslog' }],
    criblSourceProvenance: { originDataSource: 'discovered' },
  }

  it('carries the fields the live source had and the spec never mentions', async () => {
    const calls = stubLeader({ routes: [{ ...ROUTE_SPEC }, catchAll], source: customised })
    await run()
    const body = bodySent(calls, SOURCE_PATH)
    expect(body, 'the source should have been patched — tcpPort drifted').toBeDefined()
    // Every one of these was deleted by the shipped version, silently.
    expect(body!.tls).toEqual(customised.tls)
    expect(body!.pq).toEqual(customised.pq)
    expect(body!.pqEnabled).toBe(true)
    expect(body!.maxActiveCxn).toBe(200)
    expect(body!.ipWhitelistRegex).toBe('^10\\.')
    expect(body!.description).toBe('Gigamon AMX — DC1 collector')
    expect(body!.connections).toEqual(customised.connections)
    // And the app still asserts what the app owns.
    expect(body!.tcpPort).toBe(SOURCE_SPEC.tcpPort)
    expect(body!.sendToRoutes).toBe(true)
  })

  it('omits criblSourceProvenance, which the spec says Cribl preserves and will not let us overwrite', async () => {
    const calls = stubLeader({ routes: [{ ...ROUTE_SPEC }, catchAll], source: customised })
    await run()
    expect(Object.hasOwn(bodySent(calls, SOURCE_PATH)!, 'criblSourceProvenance')).toBe(false)
  })

  it('keeps the conf keys outside `functions` that a one-level merge would delete', async () => {
    // A-SP23 measured this class on a sibling endpoint: a `schedule` sub-object
    // replaced wholesale, dropping `tz` and `keepLastN` with no error.
    // PIPELINE_SPEC.conf is `{ functions }`; a live conf holds four more keys.
    const live = {
      ...PIPELINE_SPEC,
      description: 'renamed in the Cribl UI',
      conf: {
        asyncFuncTimeout: 3000,
        output: 'gigamon_lake',
        streamtags: ['gigamon'],
        description: 'parse Gigamon AMI JSON',
        groups: { grp1: { name: 'Normalize' } },
        functions: [], // drifted, so the write happens
      },
    }
    const calls = stubLeader({ routes: [{ ...ROUTE_SPEC }, catchAll], pipeline: live })
    await run()
    const conf = bodySent(calls, PIPELINE_PATH)!.conf as Record<string, unknown>
    expect(conf.asyncFuncTimeout).toBe(3000)
    expect(conf.output).toBe('gigamon_lake')
    expect(conf.streamtags).toEqual(['gigamon'])
    expect(conf.description).toBe('parse Gigamon AMI JSON')
    expect(conf.groups).toEqual({ grp1: { name: 'Normalize' } })
    // The app owns `functions` and asserts them.
    expect(conf.functions).toEqual(PIPELINE_SPEC.conf.functions)
    // And the pipeline's own top-level `description` survives too.
    expect(bodySent(calls, PIPELINE_PATH)!.description).toBe('renamed in the Cribl UI')
  })

  it('shows the customer the body it is about to send, not the spec', async () => {
    // The second half of the defect. `covered` compared only the spec's own keys,
    // so the dialog said "conf changed" while the write deleted fields nobody was
    // shown. Every row's `after` is now literally the value in the request.
    const asked: PendingChange[] = []
    const calls = stubLeader({ routes: [{ ...ROUTE_SPEC }, catchAll], source: customised })
    await runWith({ confirm: (c) => { asked.push(c); return true } })

    const body = bodySent(calls, SOURCE_PATH)!
    const shown = asked.find((c) => c.key === 'source')!
    expect(shown.diff.map((d) => d.key)).toEqual(['tcpPort'])
    for (const row of shown.diff) expect(row.after).toEqual(body[row.key])
    // Nothing else in the body differs from what Cribl already held — which is
    // what makes a one-row diff an honest description of this request.
    const undisclosed = Object.keys(body).filter(
      (k) => !shown.diff.some((d) => d.key === k) && JSON.stringify(body[k]) !== JSON.stringify((customised as Record<string, unknown>)[k]),
    )
    expect(undisclosed, 'these fields were written without appearing in the diff').toEqual([])
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

  // ── The window the seam opened, and what closes it ────────────────────────
  //
  // Every ensure* composed its PATCH body from a read taken BEFORE `agreed(...)`.
  // That was not exploitable while the only caller passed no `confirm` —
  // `preConfirmed` returns true synchronously, with no await boundary a racer
  // can use — and the seam exists precisely so that a caller CAN pass a real
  // dialog. The first one to do it would have made a stale FULL REPLACEMENT
  // live: not a lost race, a revert of whatever the other admin wrote.
  //
  // So these tests pass a `confirm` that behaves like a dialog somebody is
  // sitting in front of, and the stub answers differently from the second read
  // onward. Every one of them fails against the pre-2026-09-17 code.

  const PIPE_PATH = `/m/${GROUP}/pipelines/${SYSLOG_PIPELINE_ID}`
  const SRC_PATH = `/m/${GROUP}/system/inputs/${SYSLOG_SOURCE_ID}`
  const sent = (calls: Call[], path: string) =>
    calls.find((c) => c.method === 'PATCH' && c.path === path)?.body as Record<string, unknown> | undefined

  it('composes the source PATCH from a read taken after the answer, not before it', async () => {
    // Somebody adds a TLS block to the customer's syslog source while the dialog
    // is open. The body sent is built on the second read, so it carries it.
    const calls = stubLeader({
      ...settled,
      source: { ...SOURCE_SPEC, tcpPort: 9999 },
      sourceBetweenReads: { ...SOURCE_SPEC, tcpPort: 9999, tls: { disabled: false, certificateName: 'theirs' } },
    })
    const steps = await runWith({ confirm: () => true })
    expect(step(steps, 'source')?.action).toBe('updated')
    expect(sent(calls, SRC_PATH)?.tls, 'a field added while the dialog was open was deleted by the write').toEqual({
      disabled: false, certificateName: 'theirs',
    })
  })

  it('refuses the source write when the change it was asked about has moved', async () => {
    // The dialog said "tcpPort 9999 → 5514". By the time Yes came back the live
    // port was something else, so that is no longer the change, and a
    // confirmation describes ONE before → after.
    const calls = stubLeader({
      ...settled,
      source: { ...SOURCE_SPEC, tcpPort: 9999 },
      sourceBetweenReads: { ...SOURCE_SPEC, tcpPort: 7777 },
    })
    const steps = await runWith({ confirm: () => true })
    expect(calls.some((c) => c.method === 'PATCH' && c.path === SRC_PATH)).toBe(false)
    expect(step(steps, 'source')?.action).toBe('error')
    expect(step(steps, 'source')?.detail).toContain('changed while that confirmation was open')
  })

  it('writes nothing when the read after the answer cannot be read', async () => {
    // No fallback to the first read. That fallback IS the stale merge, arriving
    // as a convenience on the workspace least able to tolerate it.
    const calls = stubLeader({
      ...settled,
      pipeline: { ...PIPELINE_SPEC, conf: { ...PIPELINE_SPEC.conf, functions: [] } },
      pipelineBetweenReads: null,
    })
    const steps = await runWith({ confirm: () => true })
    expect(calls.some((c) => c.method === 'PATCH' && c.path === PIPE_PATH)).toBe(false)
    expect(step(steps, 'pipeline')?.action).toBe('error')
    expect(step(steps, 'pipeline')?.detail).toContain('could not be read again after that confirmation')
  })

  it('calls it a no-op when somebody applied the same change while the dialog was open', async () => {
    // Not a conflict — there is simply nothing left to send.
    const calls = stubLeader({
      ...settled,
      pipeline: { ...PIPELINE_SPEC, conf: { ...PIPELINE_SPEC.conf, functions: [] } },
      pipelineBetweenReads: { ...PIPELINE_SPEC },
    })
    const steps = await runWith({ confirm: () => true })
    expect(calls.some((c) => c.method === 'PATCH' && c.path === PIPE_PATH)).toBe(false)
    expect(step(steps, 'pipeline')?.action).toBe('exists')
  })

  it('sends the routing table read after the answer, so another admin’s new route survives', async () => {
    // THE WORST OF THE THREE. This PATCH replaces the group's entire routing
    // table, so a table read before the dialog reverts every route somebody
    // else added, reordered or deleted while it was open.
    const stale = { ...ROUTE_SPEC, description: 'from an older version of this app' }
    const theirs = { id: 'their_route', name: 'their_route', filter: 'true', pipeline: 'theirs' }
    const calls = stubLeader({
      ...settled,
      routes: [stale, catchAll],
      routesBetweenReads: [stale, theirs, catchAll],
    })
    const steps = await runWith({ confirm: () => true })
    expect(step(steps, 'route')?.action).toBe('updated')
    expect(routesSent(calls)?.map((r) => r.id), 'a route added while the dialog was open was deleted by this write')
      .toEqual([SYSLOG_ROUTE_ID, 'their_route', 'default'])
  })

  it('refuses when our route was removed from the table while the dialog was open', async () => {
    // The approved ACTION moved, not just its diff: "correct it where it sits"
    // and "add it above the catch-all" are not the same press.
    const stale = { ...ROUTE_SPEC, description: 'stale' }
    const calls = stubLeader({ ...settled, routes: [stale, catchAll], routesBetweenReads: [catchAll] })
    const steps = await runWith({ confirm: () => true })
    expect(calls.some((c) => c.method === 'PATCH' && c.path === ROUTES_PATCH)).toBe(false)
    expect(step(steps, 'route')?.action).toBe('error')
    expect(step(steps, 'route')?.detail).toContain('removed from the routing table while that confirmation was open')
  })

  it('writes nothing when the routing table cannot be read again', async () => {
    const stale = { ...ROUTE_SPEC, description: 'stale' }
    const calls = stubLeader({ ...settled, routes: [stale, catchAll], routesBetweenReads: null })
    const steps = await runWith({ confirm: () => true })
    expect(calls.some((c) => c.method === 'PATCH' && c.path === ROUTES_PATCH)).toBe(false)
    expect(step(steps, 'route')?.detail).toContain('could not be read again after that confirmation')
  })

  it('still re-reads when no confirm was passed, so the guard is structural rather than conditional', async () => {
    // `preConfirmed` is the only caller today, and the fix must not be something
    // a future caller has to remember to opt into. One extra GET per written
    // object per run is the price of the seam being safe to wire.
    const calls = stubLeader({ ...settled, source: { ...SOURCE_SPEC, tcpPort: 9999 } })
    await run()
    expect(calls.filter((c) => c.method === 'GET' && c.path === SRC_PATH)).toHaveLength(2)
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

  it('reads as "none" rather than guessing when /version/files is unavailable', async () => {
    // This used to `return head` — a repo-wide HEAD presented to the user as a
    // commit "committed to <group> but never deployed", on no group evidence at
    // all, feeding an offer to deploy that restarts that group's Worker
    // Processes. The function's own rule is at the top of it: "Could not tell"
    // answers null, exactly like "nothing pending".
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/capi/, '')
      const method = (init.method ?? 'GET').toUpperCase()
      const reply = (status: number, value: unknown) => ({
        ok: status < 300, status, statusText: 'OK',
        text: async () => JSON.stringify(value), json: async () => value,
      })
      if (path.startsWith('/version/files')) return reply(403, { message: 'not granted' })
      if (path.startsWith('/version?')) return reply(200, { items: [{ hash: HEAD, refs: 'HEAD -> main' }] })
      if (method === 'GET' && path === `/products/stream/groups/${GROUP}`) return reply(200, { items: [{ id: GROUP, configVersion: DEPLOYED }] })
      return reply(200, { items: [] })
    })
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

describe('commitScope', () => {
  // What Guided Setup's confirmation needs in order to stop saying "Nothing else
  // in <group> is touched, including the demo DataGen source" — a sentence that
  // shipped, and that is true of what this app WRITES and false of what its
  // commit CARRIES. `pendingFiles()` has been in the module since Phase 1 and
  // nothing ever put it in front of a person.
  const FILES = [
    `groups/${GROUP}/local/cribl/inputs.yml`,
    `groups/${GROUP}/local/cribl/pipelines/${SYSLOG_PIPELINE_ID}/conf.yml`,
    `groups/${GROUP}/local/cribl/routes.yml`,
    `groups/${GROUP}/local/cribl/outputs.yml`,
  ]
  const ALL: ResourceKey[] = ['source', 'pipeline', 'route', 'destination']

  it('names every whole file a deploy can commit, including the one holding the demo DataGen source', () => {
    expect(commitScope(GROUP, ALL, []).carries).toEqual(FILES)
  })

  it('names three for a teardown, because the destination is never touched by one', () => {
    // The over-naming half of the same class: a dialog that names a file it does
    // not touch is as untrue as one that hides a file it does.
    expect(commitScope(GROUP, ['source', 'pipeline', 'route'], []).carries).not.toContain(FILES[3])
  })

  it('separates somebody else\u2019s work IN those files from work elsewhere', () => {
    const scope = commitScope(GROUP, ALL, [
      `groups/${GROUP}/local/cribl/inputs.yml`,
      'groups/other/local/cribl/routes.yml',
    ])
    // In our files: this press commits and deploys it.
    expect(scope.alreadyDirty).toEqual([`groups/${GROUP}/local/cribl/inputs.yml`])
    // Elsewhere: the commit names its own paths, so it is left alone.
    expect(scope.elsewhere).toEqual(['groups/other/local/cribl/routes.yml'])
    expect(scope.unknown).toBe(false)
  })

  it('says "could not tell" rather than "nothing is pending" when Git reported nothing', () => {
    // An empty repo-wide status and an unavailable endpoint look identical from
    // here — the same ambiguity filesToCommit resolves by falling back to
    // constructed paths — and a dialog that renders the second as the first is
    // asserting a clean tree it never saw.
    expect(commitScope(GROUP, ALL, null).unknown).toBe(true)
    expect(commitScope(GROUP, ALL, null).alreadyDirty).toEqual([])
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
