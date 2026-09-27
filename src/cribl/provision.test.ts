// The things about Guided Setup's worker-group writes that are expensive to get
// wrong.
//
// This module writes customer configuration and has no dry run: the way to find
// out whether a change is right is to point it at somebody's Leader. So the
// parts that have already been wrong once are pinned here instead.
//
//   THE ROUTING TABLE. `PATCH /m/<group>/routes/<id>` replaces the table
//   wholesale — the array in the body BECOMES the customer's routing order, and
//   the object around it carries their Route Groups and route comments. The
//   teardown takes its entries out and nothing else; these tests assert on
//   indexes, not on membership.
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
// *(Until 2026-09-25 this file also pinned the global Raw HTTP stack's create
// path — `deployAll`'s no-op re-apply, its full-replacement merges, its
// confirmation seam and re-read after the answer, the source's port, TLS and
// token, and the breaker's create-before-source order. That path was withdrawn
// when Guided Setup's onboarding collapsed into the pack's, and those tests went
// with it; the commit-and-deploy tests that drove it through `deployAll` now
// drive the same machinery through `commitMatchingAndDeploy`, the pack client's
// way in. The token-scrub tests are unit tests of `scrubbedErrText`, which the
// pack's source writes still use.)*
//
// *(Until 2026-09-26 it also pinned the teardown of the global Raw HTTP and
// Syslog stacks earlier releases created — `removeOnboardingStack`'s one
// routing-table edit, its breaker-ruleset guards, `removeDirtyRefusal` and the
// KV record of an uncommitted removal. The owner decided the app no longer
// shows or removes those stacks, and those tests went with the code.)*
//
// Stubbed at `fetch` rather than at `capi`, so what these assertions read is the
// request the platform would have received — the method, the path, and the exact
// body. The fake Leader below answers; anything it does that a real Leader does
// not is a bug in this file. There is a list at the bottom of what that means
// these tests cannot tell you.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, FLUSH_PRESETS, datasetSpec, destinationSpec } from './landing'
import {
  commitMatchingAndDeploy, commitScopeFor, pendingConfigPaths, pendingDeploy, scrubbedErrText, tokensOf,
  undeployedHead, versionFilePaths, deployState, sameCommit,
  FILES_READ_CONCURRENCY, HISTORY_PAGE, HISTORY_PAGES,
  portProblem, portsInUse, postUrl, suggestPort, hostingOf, isCriblCloudHost,
  DATASET_SPEC, DEFAULT_STREAM_GROUP,
  type StepResult,
} from './provision'
import * as provisionModule from './provision'
import { DESTINATION_SPEC, destinationSpecFor } from './packSpecs'

const GROUP = DEFAULT_STREAM_GROUP
const HEAD = 'aaaa111122223333aaaa111122223333aaaa1111'
const DEPLOYED = 'bbbb444455556666bbbb444455556666bbbb4444'
const NEW_COMMIT = 'cccc777788889999cccc777788889999cccc7777'

const PRODUCTS_DEPLOY = `/products/stream/groups/${GROUP}/deploy`
const MASTER_DEPLOY = `/master/groups/${GROUP}/deploy`

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
  /** Files the commits AFTER `configVersion` touched, folded into HEAD's own
   *  commit when no `history` is given. `/version/files?commit=X` answers the
   *  files commit X ITSELF changed (measured 2026-09-24, see `filesInCommit`),
   *  so this is what HEAD's `/version/files` answers — and `configVersion`'s own
   *  read answers nothing. */
  changedSince?: string[]
  /** The commit history, NEWEST FIRST, each with the files that commit itself
   *  touched. Overrides the `head`/`configVersion`/`changedSince` default. */
  history?: Array<{ hash: string; refs?: string; files: string[] }>
  /** Which body `/version/files` answers with: the flat list the app was written
   *  against, or the nested tree a 4.20.x Cribl.Cloud Leader answered with on
   *  2026-09-24. The tree is the default because it is what was measured. */
  filesShape?: 'flat' | 'tree'
  /** The status `/version/files` answers with. 403 is the half-working Leader a
   *  run gets interrupted on, which is where a commit gets stranded. */
  filesStatus?: number
  /** The status `/version/status` answers with. `capi` does not throw on a
   *  non-2xx, so this is the only thing that tells a caller the read failed. */
  pendingStatus?: number
  /** Paths `/version/status` STILL reports after a successful commit — a file
   *  this run changed and its commit did not carry. */
  commitLeaves?: string[]
}

/** A route of the group's that a commit-and-deploy test carries. Which one
 *  does not matter: these tests are about the commit and the deploy. */
const SOME_ROUTE = { id: 'gigamon_route', name: 'gigamon_route', filter: 'true', final: true }

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

/**
 * A `/version/files` body for one commit, in either shape a Leader has answered
 * with. The tree is built the way the 2026-09-24 Leader built it: one node per
 * path segment, `children` on directories, `state` on files.
 */
function filesBody(files: string[], shape: 'flat' | 'tree'): unknown {
  if (shape === 'flat') return { items: [{ count: files.length, items: files.map((name) => ({ name, state: 'M' })) }], count: 1 }
  type Node = { name: string; state?: string; children?: Node[] }
  const roots: Node[] = []
  for (const f of files) {
    let level = roots
    const segs = f.split('/')
    segs.forEach((seg, i) => {
      const leaf = i === segs.length - 1
      let node = level.find((n) => n.name === seg)
      if (!node) { node = leaf ? { name: seg, state: 'M' } : { name: seg, children: [] }; level.push(node) }
      if (!leaf) level = node.children as Node[]
    })
  }
  return { items: [{ count: 1, items: roots, commitMessage: 'm' }], count: 1 }
}

function stubLeader(opts: LeaderOpts = {}): Call[] {
  const {
    routes = [catchAll], table = {}, pending = [], commit = NEW_COMMIT, deploy = {},
    configVersion = HEAD, head = HEAD, changedSince = [], filesStatus = 200, pendingStatus = 200,
    filesShape = 'tree', commitLeaves = [],
  } = opts
  const history = opts.history ?? (head === configVersion
    ? [{ hash: head, refs: 'HEAD -> main', files: [] as string[] }]
    : [{ hash: head, refs: 'HEAD -> main', files: changedSince }, { hash: configVersion, files: [] as string[] }])
  const calls: Call[] = []
  // What Git reports uncommitted. A successful commit takes its files out, as a
  // real Leader's status does, except the ones `commitLeaves` names.
  let pendingNow = [...pending]

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
    if (under('GET', '/version/files')) {
      if (filesStatus !== 200) return reply(filesStatus, { message: 'not granted' })
      const commit = new URLSearchParams(path.split('?')[1] ?? '').get('commit')
      const files = history.find((c) => c.hash === commit)?.files ?? []
      return reply(200, filesBody(files, filesShape))
    }
    if (under('GET', '/version?')) {
      // As the live endpoint answers (4.20.1, measured 2026-09-23): `limit`
      // without `offset` is a 400, "missing 'offset' parameter". The stub used
      // to accept it, which is how the history read (then `headCommit`) shipped always returning null.
      const q = new URLSearchParams(path.split('?')[1] ?? '')
      if (q.has('limit') && !q.has('offset')) return reply(400, { message: "missing 'offset' parameter" })
      return reply(200, { items: history.map(({ hash, refs = '' }) => ({ hash, refs })) })
    }
    if (at('GET', '/version/status')) {
      return pendingStatus === 200
        ? reply(200, { items: [{ files: pendingNow.map((p) => ({ path: p })) }] })
        : reply(pendingStatus, { message: 'not granted' })
    }
    if (at('POST', '/version/commit')) {
      if (commit !== null) {
        const carried = new Set((body as { files?: string[] } | undefined)?.files ?? [])
        const rest = pendingNow.filter((p) => !carried.has(p))
        pendingNow = [...rest, ...commitLeaves.filter((p) => !rest.includes(p))]
      }
      return reply(200, commit === null ? { items: [{}] } : { items: [{ commit }] })
    }

    // The routing table.
    if (at('GET', `/m/${GROUP}/routes`)) return reply(200, { items: [{ id: 'default', ...table, routes }] })
    if (at('GET', '/products/lake/lakes/default/datasets')) return reply(200, { items: [{ id: 'gigamon_ami' }] })

    // Everything else in the group already exists and takes whatever is sent.
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

/**
 * One commit-and-deploy of the group's routing table, through the machinery
 * every Guided Setup write ends in (`commitMatchingAndDeploy` → `commitAndDeploy`,
 * with the stranded-commit repair). It used to be driven through `deployAll`,
 * which was withdrawn on 2026-09-25 with the global Raw HTTP create path; the
 * machinery under test is the same.
 */
const ROUTE_FILE = `groups/${GROUP}/local/cribl/pipelines/route.yml`
const run = (markers: readonly string[] = ['local/cribl/pipelines/route.yml'], constructed: readonly string[] = [ROUTE_FILE]) =>
  new Promise<StepResult[]>((resolve) => { void commitMatchingAndDeploy('Gigamon test commit', GROUP, markers, constructed).then(resolve) })

/** Everything the run sent to Cribl that was not a read. The app's own KV store
 *  is dropped: the audit trail is a write, it is not a write to the customer's
 *  configuration, and these assertions are about the latter. */
const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore/')).map((c) => `${c.method} ${c.path}`)
const step = (steps: StepResult[], key: string) => steps.find((s) => s.key === key)

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the two Lake specs', () => {
  // These used to be two hand-written copies of the same numbers — one here and
  // one in landing.ts's `nearLive` preset — with a comment between them naming a
  // line number. This is the pin that replaced the comment.

  it('are the landing profile this release ships, not a second set of literals', () => {
    expect(DATASET_SPEC).toEqual(datasetSpec(DEFAULT_PROFILE))
    expect(DESTINATION_SPEC).toEqual({ id: 'gigamon_lake', type: 'cribl_lake', ...destinationSpec(DEFAULT_PROFILE).set })
  })

  it('still lands a customer on JSON, 30 days — the part Phase 3 may not change', () => {
    // WHAT THIS GUARDS, and it is narrower than it was. `format` and
    // `retentionPeriodInDays` decide a customer's LANDING, and `format` is
    // creation-only — get it wrong and the tenant is locked into it for the life
    // of the dataset. Those two stay pinned.
    //
    // The READER is a different kind of setting and it was deliberately changed
    // on 2026-09-22: `searchConfig` now says v2, because P-S7 measured v2 at
    // 3.7-12.7x on identical rows and the app was still creating v1 datasets
    // while this workspace ran v2. It is not creation-only, so it is reversible;
    // the default was wrong, not the mechanism.
    expect(DATASET_SPEC).toMatchObject({
      id: 'gigamon_ami',
      description: 'Gigamon Application Metadata Intelligence (AMI) flow records',
      retentionPeriodInDays: 30,
      format: 'json',
    })
    // The reader is v2 and reads BOTH object kinds — a dataset created today
    // holds only JSON, but the filter that would drop Parquet later is the one
    // that makes a format change unreadable, so it is never written narrow.
    expect((DATASET_SPEC as { searchConfig?: { searchVersion?: string } }).searchConfig?.searchVersion).toBe('v2')
    // Still creation-only and still empty: partitions are Phase 4's, and an
    // empty acceleratedFields is omitted rather than sent as [].
    expect(DATASET_SPEC).not.toHaveProperty('acceleratedFields')
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
  const upToDate = { routes: [{ ...SOME_ROUTE }, catchAll] }

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
  const settled = { routes: [{ ...SOME_ROUTE }, catchAll] }
  const noNetChange = { ...settled, commit: null }
  const nothingOfOurs = { ...settled, pending: ['groups/other_group/local/cribl/outputs.yml'] }
  const stranded = { configVersion: DEPLOYED, head: HEAD, changedSince: [`groups/${GROUP}/local/cribl/pipelines/route.yml`] }

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
      changedSince: ['groups/other_group/local/cribl/pipelines/route.yml'],
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

  // ── THE TWO CONSUMERS, WHICH ARE NOT ASKING THE SAME QUESTION ─────────────
  //
  // One structural change served one of them and broke the other, in both
  // directions, so both are asserted here against the SAME Leader.
  //
  //   THE SCREEN (`pendingDeploy`) claims "commit #X touches <group> and has not
  //   been deployed to it" and offers a deploy that restarts that group's Worker
  //   Processes. Without group evidence there is no claim.
  //   THE REPAIR (`undeployedHead`, via deployStrandedCommit) recovers a run
  //   interrupted between commit and deploy. Its safety is the commit memory,
  //   not the file list — and a Leader that will not answer `/version/files` is
  //   exactly the kind that strands a commit in the first place.
  it('asks two different questions of the same Leader when /version/files is unavailable', async () => {
    stubLeader({ ...settled, ...stranded, filesStatus: 403 })
    expect(await pendingDeploy(GROUP), 'the screen claimed a group commit on no group evidence').toBe(null)
    expect(await undeployedHead(GROUP), 'the repair went blind in the failure mode it exists for').toBe(HEAD)
  })

  it('is still deployed when /version/files is unavailable, because that is the interrupted run', async () => {
    weCommitted(HEAD)
    const calls = stubLeader({ ...noNetChange, ...stranded, filesStatus: 403 })
    const steps = await run()

    expect(calls.find((c) => c.path === PRODUCTS_DEPLOY)?.body).toEqual({ version: HEAD })
    expect(step(steps, 'deploy')?.action).toBe('created')
  })

  it('still refuses a hash the commit memory cannot vouch for, with /version/files unavailable', async () => {
    // The repair asking a weaker question does not make it a weaker gate: the
    // ownership check is the gate, and it is on the hash.
    weCommitted('dddd000011112222dddd000011112222dddd0000')
    const calls = stubLeader({ ...noNetChange, ...stranded, filesStatus: 403 })
    const steps = await run()

    expect(calls.some((c) => c.path === PRODUCTS_DEPLOY), 'deployed a commit this app never made').toBe(false)
    expect(step(steps, 'deploy')?.detail).toContain('this app did not make')
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
      if (path.startsWith('/version/files')) return reply({ items: [{ items: [{ name: `groups/${GROUP}/local/cribl/pipelines/route.yml` }] }] })
      if (path.startsWith('/version?')) {
        // Oldest first, and the deployed commit in the page so the range can be
        // bounded: taking the first-listed commit as HEAD names 'oldest0000'.
        return reply({ items: [{ hash: 'oldest0000', refs: '' }, { hash: DEPLOYED, refs: '' }, { hash: HEAD, refs: 'HEAD -> main' }] })
      }
      if (method === 'GET' && path === `/products/stream/groups/${GROUP}`) return reply({ items: [{ id: GROUP, configVersion: DEPLOYED }] })
      return reply({ items: [] })
    })
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
  })
})

// ── /version/files: WHAT IT ANSWERS, AND IN WHAT SHAPE ───────────────────────
//
// Measured read-only against a 4.20.x Cribl.Cloud Leader on 2026-09-24:
//
//   * THE SHAPE. `GET /version/files?commit=<hash>` answered a NESTED TREE — one
//     node per path segment, `children` on directories, `state` on files — not
//     the flat `{ name: 'groups/…/route.yml' }` list this file was written
//     against. The flat reader yielded the single path `groups`, and
//     `pathInGroup('groups', g)` is TRUE for every g (it contains no
//     `groups/`), so the screen claimed EVERY group had a commit to deploy.
//   * THE MEANING. It answers the files that ONE commit changed, not the files
//     changed since it: for 506d36a it listed only inputs.yml, the same file
//     `/version/show` diffs for that commit, although later commits changed
//     outputs.yml; and each answer carries that commit's own `commitMessage`.
//     Asked of the deployed commit, it describes what is already running.
//
// The literal body below is the one that Leader answered with.
const LITERAL_TREE = {
  items: [{
    count: 1,
    items: [{ name: 'groups', children: [{ name: 'default', children: [{ name: 'local', children: [{ name: 'cribl', children: [
      { name: 'outputs.yml', state: 'M' },
      { name: 'pipelines', children: [{ name: 'route.yml', state: 'M' }] },
    ] }] }] }] }],
    commitMessage: '...',
  }],
  count: 1,
}

describe('versionFilePaths', () => {
  it('walks the nested tree a 4.20.x Leader answers with to full paths', () => {
    expect(versionFilePaths(LITERAL_TREE)).toEqual([
      'groups/default/local/cribl/outputs.yml',
      'groups/default/local/cribl/pipelines/route.yml',
    ])
  })

  it('still reads the flat list, by `name` or by `path`', () => {
    expect(versionFilePaths({ items: [{ items: [{ name: 'groups/default/local/cribl/outputs.yml' }, { path: 'cribl.yml' }] }] }))
      .toEqual(['groups/default/local/cribl/outputs.yml', 'cribl.yml'])
  })

  it('answers null for a body it cannot read, which is not "no files"', () => {
    expect(versionFilePaths({})).toBe(null)
    expect(versionFilePaths(null)).toBe(null)
    expect(versionFilePaths({ items: [] })).toEqual([])
  })

  it('answers null when an entry says it holds files and the walk found none', () => {
    // The next shape change: a count of three, and the files somewhere this
    // walk does not look. That is "cannot read", not "no files".
    expect(versionFilePaths({ items: [{ count: 3, children: [{ name: 'groups', children: [] }] }] })).toBe(null)
    expect(versionFilePaths({ items: [{ count: 2, items: [{ file: 'groups/default/x.yml' }] }] })).toBe(null)
    // A count of zero with nothing in it is an honest empty commit.
    expect(versionFilePaths({ items: [{ count: 0, items: [] }], count: 1 })).toEqual([])
  })
})

describe('a short configVersion names the same commit as the full hash', () => {
  // Measured 2026-09-26 on a Cribl.Cloud Leader: the group record said
  // configVersion "e4396f3" while /version named HEAD by its full 40-character
  // hash, and the exact comparison read the group as behind its own commit.
  const SHORT_HEAD = HEAD.slice(0, 7)
  const SHORT_DEPLOYED = DEPLOYED.slice(0, 7)
  const OURS = `groups/${GROUP}/local/cribl/pipelines/route.yml`

  it('matches a prefix of 7 or more characters, either way round, and nothing shorter', () => {
    expect(sameCommit(SHORT_HEAD, HEAD)).toBe(true)
    expect(sameCommit(HEAD, SHORT_HEAD)).toBe(true)
    expect(sameCommit(HEAD, HEAD)).toBe(true)
    expect(sameCommit(HEAD.slice(0, 6), HEAD)).toBe(false)
    expect(sameCommit('aaa111', 'aaa111')).toBe(true)
    expect(sameCommit(SHORT_DEPLOYED, HEAD)).toBe(false)
    expect(sameCommit(SHORT_HEAD.toUpperCase(), HEAD)).toBe(true)
    expect(sameCommit('', HEAD)).toBe(false)
    expect(sameCommit(null, HEAD)).toBe(false)
  })

  it('reads a group running HEAD, named short, as current — no pending deploy, no stranded commit', async () => {
    stubLeader({ configVersion: SHORT_HEAD, history: [{ hash: HEAD, refs: 'HEAD -> main', files: [] }] })
    expect(await deployState(GROUP)).toEqual({ state: 'current', head: HEAD })
    expect(await undeployedHead(GROUP)).toBeNull()
    expect(await pendingDeploy(GROUP)).toBeNull()
  })

  it('still finds the range behind a short configVersion, and proves a commit that touches the group', async () => {
    stubLeader({
      configVersion: SHORT_DEPLOYED,
      history: [{ hash: HEAD, refs: 'HEAD -> main', files: [OURS] }, { hash: DEPLOYED, files: [] }],
    })
    expect(await deployState(GROUP)).toMatchObject({ state: 'behind', head: HEAD, proof: 'touches' })
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
  })
})

describe('pendingDeploy — one /version/files read per undeployed commit', () => {
  const OURS = `groups/${GROUP}/local/cribl/pipelines/route.yml`
  const THEIRS = 'groups/other_group/local/cribl/pipelines/route.yml'
  const MID = 'dddd000011112222dddd000011112222dddd0000'
  const settled = { routes: [{ ...SOME_ROUTE }, catchAll], configVersion: DEPLOYED }

  it('claims the literal tree for the group it names', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/capi/, '')
      const method = (init.method ?? 'GET').toUpperCase()
      const reply = (value: unknown) => ({
        ok: true, status: 200, statusText: 'OK',
        text: async () => JSON.stringify(value), json: async () => value,
      })
      if (path === `/version/files?commit=${HEAD}`) return reply(LITERAL_TREE)
      if (path.startsWith('/version/files')) return reply({ items: [{ count: 0, items: [] }], count: 1 })
      if (path.startsWith('/version?')) return reply({ items: [{ hash: HEAD, refs: 'HEAD -> master' }, { hash: DEPLOYED, refs: '' }] })
      if (method === 'GET' && path === `/products/stream/groups/${GROUP}`) return reply({ items: [{ id: GROUP, configVersion: DEPLOYED }] })
      return reply({ items: [] })
    })
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
  })

  it('does not claim a tree whose files all belong to another group', async () => {
    // The defect: the flat reader turned this into the one path `groups`, which
    // pathInGroup reads as a repo-wide file — so every group lit up.
    // DEPLOYED carries the same tree so that the read the old code made (of the
    // deployed commit) sees it too: this pins the shape, not the range.
    stubLeader({ ...settled, history: [{ hash: HEAD, refs: 'HEAD -> main', files: [THEIRS] }, { hash: DEPLOYED, files: [THEIRS] }] })
    expect(await pendingDeploy(GROUP)).toBe(null)
  })

  it('does not describe the commit the group is already running as pending', async () => {
    // The deployed commit touched this group; nothing after it did. Asking
    // `/version/files` about the deployed commit answers THAT commit's files.
    stubLeader({ ...settled, filesShape: 'flat', history: [{ hash: HEAD, refs: 'HEAD -> main', files: [THEIRS] }, { hash: DEPLOYED, files: [OURS] }] })
    expect(await pendingDeploy(GROUP)).toBe(null)
  })

  it('finds a commit to this group that is not the newest one', async () => {
    const calls = stubLeader({ ...settled, filesShape: 'flat', history: [
      { hash: HEAD, refs: 'HEAD -> main', files: [THEIRS] },
      { hash: MID, files: [OURS] },
      { hash: DEPLOYED, files: [] },
    ] })
    // The deploy moves the group to HEAD, which carries MID with it — so HEAD is
    // the commit named, as it always was.
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
    const asked = calls.filter((c) => c.path.startsWith('/version/files')).map((c) => c.path)
    expect(asked, 'read the deployed commit, which is already running').not.toContain(`/version/files?commit=${DEPLOYED}`)
  })

  it('reads the tree shape the same way', async () => {
    stubLeader({ ...settled, filesShape: 'tree', history: [
      { hash: HEAD, refs: 'HEAD -> main', files: [THEIRS] },
      { hash: MID, files: [OURS] },
      { hash: DEPLOYED, files: [] },
    ] })
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
  })

  it('answers null when the deployed commit is not in the history it read', async () => {
    // The range cannot be bounded, so no claim — "could not tell" is null.
    stubLeader({ ...settled, history: [{ hash: HEAD, refs: 'HEAD -> main', files: [OURS] }, { hash: MID, files: [] }] })
    expect(await pendingDeploy(GROUP)).toBe(null)
  })

  it('walks the range from the deployed commit to HEAD even when the page lists oldest first', async () => {
    stubLeader({ ...settled, history: [
      { hash: DEPLOYED, files: [] },
      { hash: MID, files: [OURS] },
      { hash: HEAD, refs: 'HEAD -> main', files: [THEIRS] },
    ] })
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
  })

  it('claims on proof from one commit when another cannot be read, and not otherwise', async () => {
    // A failed read removes evidence; it cannot remove what another read found.
    // With no proof anywhere, a failure is "could not tell".
    // HEAD is the unreadable one, and it is read first: the proof is behind it.
    const history = [
      { hash: HEAD, refs: 'HEAD -> main', files: [] as string[] },
      { hash: MID, files: [OURS] },
      { hash: DEPLOYED, files: [] as string[] },
    ]
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/capi/, '')
      const method = (init.method ?? 'GET').toUpperCase()
      const reply = (status: number, value: unknown) => ({
        ok: status < 300, status, statusText: 'OK',
        text: async () => JSON.stringify(value), json: async () => value,
      })
      if (path === `/version/files?commit=${HEAD}`) return reply(500, { message: 'boom' })
      if (path.startsWith('/version/files?commit=')) {
        const h = path.split('=')[1]
        return reply(200, filesBody(history.find((c) => c.hash === h)?.files ?? [], 'tree'))
      }
      if (path.startsWith('/version?')) return reply(200, { items: history.map(({ hash, refs = '' }) => ({ hash, refs })) })
      if (method === 'GET' && path === `/products/stream/groups/${GROUP}`) return reply(200, { items: [{ id: GROUP, configVersion: DEPLOYED }] })
      return reply(200, { items: [] })
    })
    expect(await pendingDeploy(GROUP)).toBe(HEAD)
    history[1].files = [THEIRS]
    expect(await pendingDeploy(GROUP), 'claimed a group commit when the unread commit could have been anybody’s').toBe(null)
  })
})

// ── THE COST AND THE REACH OF WALKING THE RANGE (review of 411cd1b) ──────────
//
// One `/version/files` read per commit is right about meaning and was wrong
// about cost: read one after another, a group forty commits behind — none of
// them its own, the usual "nothing pending" answer — waited for forty GETs in a
// row before `refresh()` let the status rows appear. And a group further behind
// than one history page got no answer at all, which is the group most likely to
// have something undeployed.
describe('pendingDeploy — how the range is read', () => {
  const OURS = `groups/${GROUP}/local/cribl/pipelines/route.yml`
  const THEIRS = 'groups/other_group/local/cribl/pipelines/route.yml'
  const hashOf = (i: number) => `c${String(i).padStart(39, '0')}`

  /**
   * A Leader with `n` commits, NEWEST FIRST unless `refsAt` says otherwise, that
   * pages `/version` by `offset`/`limit` the way the live endpoint does, and
   * whose `/version/files` reads each take a timer turn so overlapping reads
   * can be counted.
   */
  function stubPaged(n: number, deployedAt: number, oursAt: number[] = [], refsAt: Record<number, string> = { 0: 'HEAD -> main' }) {
    const history = Array.from({ length: n }, (_, i) => ({
      hash: hashOf(i), refs: refsAt[i] ?? '', files: oursAt.includes(i) ? [OURS] : [THEIRS],
    }))
    const seen = { inFlight: 0, maxInFlight: 0, filesReads: 0, historyReads: [] as string[] }
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/capi/, '')
      const method = (init.method ?? 'GET').toUpperCase()
      const reply = (status: number, value: unknown) => ({
        ok: status < 300, status, statusText: 'OK',
        text: async () => JSON.stringify(value), json: async () => value,
      })
      if (path.startsWith('/version/files?commit=')) {
        seen.filesReads += 1
        seen.inFlight += 1
        seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight)
        await new Promise((r) => setTimeout(r, 1))
        seen.inFlight -= 1
        const h = decodeURIComponent(path.split('=')[1])
        return reply(200, filesBody(history.find((c) => c.hash === h)?.files ?? [], 'tree'))
      }
      if (path.startsWith('/version?')) {
        seen.historyReads.push(path)
        const q = new URLSearchParams(path.split('?')[1])
        if (!q.has('offset')) return reply(400, { message: "missing 'offset' parameter" })
        const off = Number(q.get('offset')), lim = Number(q.get('limit'))
        return reply(200, { items: history.slice(off, off + lim).map(({ hash, refs }) => ({ hash, refs })) })
      }
      if (method === 'GET' && path === `/products/stream/groups/${GROUP}`) {
        return reply(200, { items: [{ id: GROUP, configVersion: hashOf(deployedAt) }] })
      }
      return reply(200, { items: [] })
    })
    return seen
  }
  const offsetOf = (p: string) => new URLSearchParams(p.split('?')[1]).get('offset')

  it('reads the commits it has not deployed several at a time, and never more than the cap', async () => {
    const seen = stubPaged(41, 40)
    expect(await pendingDeploy(GROUP)).toBe(null)
    expect(seen.filesReads, 'every commit in the range must still be read to say "nothing pending"').toBe(40)
    expect(seen.maxInFlight, 'read one commit at a time: forty GETs in a row before the rows appear').toBeGreaterThan(1)
    expect(seen.maxInFlight).toBeLessThanOrEqual(FILES_READ_CONCURRENCY)
  })

  it('stops asking once one commit has proved the claim', async () => {
    const seen = stubPaged(41, 40, [0])
    expect(await pendingDeploy(GROUP)).toBe(hashOf(0))
    expect(seen.filesReads, 'kept reading after HEAD itself proved it').toBeLessThanOrEqual(FILES_READ_CONCURRENCY)
  })

  it('asks for the page size it pages by', async () => {
    const seen = stubPaged(3, 2)
    await pendingDeploy(GROUP)
    expect(new URLSearchParams(seen.historyReads[0].split('?')[1]).get('limit')).toBe(String(HISTORY_PAGE))
  })

  it('pages back through the history to find a deployed commit older than one page', async () => {
    const deployedAt = HISTORY_PAGE + 20
    const seen = stubPaged(deployedAt + 10, deployedAt, [HISTORY_PAGE + 5])
    expect(await pendingDeploy(GROUP), 'a group more than one page behind got no warning at all').toBe(hashOf(0))
    expect(seen.historyReads.map(offsetOf)).toEqual(['0', String(HISTORY_PAGE)])
  })

  it('stops paging at a bound, and answers "could not tell" beyond it', async () => {
    const deployedAt = HISTORY_PAGE * HISTORY_PAGES + 5
    const seen = stubPaged(deployedAt + 1, deployedAt, [0])
    expect(await pendingDeploy(GROUP)).toBe(null)
    expect(seen.historyReads.map(offsetOf)).toEqual(Array.from({ length: HISTORY_PAGES }, (_, i) => String(i * HISTORY_PAGE)))
    expect(seen.filesReads, 'read files for a range it could not bound').toBe(0)
  })

  it('stops paging when the history runs out', async () => {
    // The deployed commit is not in the repo's history at all (a rewritten
    // branch, a group record naming a hash from elsewhere): a short page is the
    // end of it, and asking for the next is a wasted request.
    const seen = stubPaged(HISTORY_PAGE + 3, 0)
    const stubbedGroup = `/products/stream/groups/${GROUP}`
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      String(url).endsWith(stubbedGroup)
        ? { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ items: [{ id: GROUP, configVersion: 'f'.repeat(40) }] }), json: async () => ({}) }
        : inner(url, init))
    expect(await pendingDeploy(GROUP)).toBe(null)
    expect(seen.historyReads.map(offsetOf)).toEqual(['0', String(HISTORY_PAGE)])
  })

  it('does not page for the stranded-commit repair, which needs only HEAD', async () => {
    const seen = stubPaged(HISTORY_PAGE * 2, HISTORY_PAGE + 5)
    expect(await undeployedHead(GROUP)).toBe(hashOf(0))
    expect(seen.historyReads.length).toBe(1)
  })

  it.each([
    ['a remote HEAD on an older commit', 'origin/HEAD, origin/main'],
    ['a tag that merely contains the word', 'tag: HEADLINE'],
  ])('takes only the local HEAD, not %s', async (_what, decoy) => {
    // Oldest first, with the decoy on the deployed commit: matching any ref
    // that contains "HEAD" takes the deployed commit as HEAD, and says nothing
    // is pending while a commit to this group sits undeployed.
    stubPaged(3, 0, [1], { 0: decoy, 2: 'HEAD -> main' })
    expect(await pendingDeploy(GROUP)).toBe(hashOf(2))
    expect(await undeployedHead(GROUP)).toBe(hashOf(2))
  })

  it('still takes a detached HEAD, which carries no branch arrow', async () => {
    // Listed last, so the first-listed fallback cannot answer for the match.
    stubPaged(3, 0, [1], { 2: 'HEAD, origin/main' })
    expect(await pendingDeploy(GROUP)).toBe(hashOf(2))
  })
})

describe('pendingConfigPaths', () => {
  // THE WARNING THAT ALWAYS FIRES. This answered `null` for an empty list as
  // well as for a failed read, and `null` is what the Guided Setup dialogs
  // render as "Cribl did not report what is already uncommitted in <group>…
  // Assume it may be." So on a healthy workspace — the common case, and the one
  // every reader sees most — both confirmations carried a standing warning, and
  // the two states that mean something went down with it.
  const OURS = `groups/${GROUP}/local/cribl/pipelines/route.yml`

  it('answers an empty list for a clean tree, which is an answer and not a shrug', async () => {
    stubLeader({ pending: [] })
    expect(await pendingConfigPaths()).toEqual([])
  })

  it('answers what Git reported when there is something', async () => {
    stubLeader({ pending: [OURS] })
    expect(await pendingConfigPaths()).toEqual([OURS])
  })

  it('answers null ONLY when the read itself failed', async () => {
    // `capi` does not throw on a non-2xx — it answers {status, body} — so
    // nothing but the status can tell these apart.
    stubLeader({ pending: [], pendingStatus: 403 })
    expect(await pendingConfigPaths()).toBe(null)
  })

  // What each of the three becomes on screen is provisionPanelCopy.test.ts's —
  // the three sentences are asserted there, against the same three values.
})

describe('commitScopeFor', () => {
  // What a Guided Setup confirmation needs in order to stop saying "Nothing
  // else in <group> is touched, including the demo DataGen source" — a sentence
  // that shipped, and that is true of what this app WRITES and false of what
  // its commit CARRIES.
  const INPUTS = `groups/${GROUP}/local/cribl/inputs.yml`
  const ROUTE = `groups/${GROUP}/local/cribl/pipelines/route.yml`
  const MARKERS = ['local/cribl/inputs.yml', 'local/cribl/pipelines/route.yml']

  it('names the whole files it was given, and separates somebody else’s work IN them from work elsewhere', () => {
    const scope = commitScopeFor(GROUP, [INPUTS, ROUTE], MARKERS, [INPUTS, 'groups/other/local/cribl/pipelines/route.yml'])
    expect(scope.carries).toEqual([INPUTS, ROUTE])
    // In these files: this press commits and deploys it.
    expect(scope.alreadyDirty).toEqual([INPUTS])
    // Elsewhere: the commit names its own paths, so it is left alone.
    expect(scope.elsewhere).toEqual(['groups/other/local/cribl/pipelines/route.yml'])
    expect(scope.unknown).toBe(false)
  })

  it('says "could not tell" rather than "nothing is pending" when Git reported nothing', () => {
    // An empty repo-wide status and an unavailable endpoint look identical from
    // here, and a dialog that renders the second as the first is asserting a
    // clean tree it never saw.
    expect(commitScopeFor(GROUP, [INPUTS], MARKERS, null).unknown).toBe(true)
    expect(commitScopeFor(GROUP, [INPUTS], MARKERS, null).alreadyDirty).toEqual([])
  })
})

// ── The global stacks earlier releases created are gone ─────────────────────

describe('the global Raw HTTP and Syslog stacks are neither created nor removed', () => {
  it('exports no create path and no teardown', () => {
    // The owner collapsed Guided Setup's onboarding into the pack's
    // (2026-09-25), and decided the app no longer shows or removes the global
    // stacks earlier releases created (2026-09-26). A `deployAll` or a
    // `removeOnboardingStack` still exported here is a write a screen could
    // reach again.
    const names = Object.keys(provisionModule)
    expect(names).not.toContain('deployAll')
    expect(names.filter((n) => n.startsWith('ensure'))).toEqual(['ensureLakeDataset'])
    expect(names).not.toContain('readHttpEndpoint')
    for (const gone of [
      'removeOnboardingStack', 'removeDirtyRefusal', 'removeDirtyVerdict', 'checkStatus', 'checkLegacyStatus', 'commitScope',
      'legacyOnly', 'HTTP_KEYS', 'LEGACY_KEYS', 'HTTP_SOURCE_ID', 'HTTP_PIPELINE_ID', 'HTTP_ROUTE_ID', 'HTTP_BREAKER_ID',
      'HTTP_BREAKER_DESCRIPTION', 'LEGACY_SYSLOG_SOURCE_ID', 'LEGACY_SYSLOG_PIPELINE_ID', 'LEGACY_SYSLOG_ROUTE_ID', 'STEP_LABELS',
    ]) expect(names, gone).not.toContain(gone)
  })
})

// ── Keeping a token out of an error message ─────────────────────────────────
//
// `scrubbedErrText` is how an error about a source reaches the screen — the
// pack's Raw HTTP source's writes, today. Until 2026-09-25 these were asserted
// through the global source's create; they are asserted on the function now.

describe('scrubbedErrText', () => {
  const TOKEN = '3fa9c1d2e4b5a6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f'
  const refusal = (body: unknown) => ({ status: 400, body })
  /** Every 12-character slice of the token: none may survive into the detail. */
  const noSliceOf = (detail: string, token: string) => {
    for (let i = 0; i + 12 <= token.length; i++) expect(detail, `a piece of the token survived: ${token.slice(i, i + 12)}`).not.toContain(token.slice(i, i + 12))
  }

  it('scrubs the token out of a refusal with no message field, even one longer than 200 characters', () => {
    // No `message` / `error`: errText stringifies and cuts this at 200
    // characters, and the cut falls inside the token.
    const detail = scrubbedErrText(refusal({ status: 'error', field: 'authTokensExt', pad: 'x'.repeat(110), value: TOKEN }), [TOKEN])
    noSliceOf(detail, TOKEN)
  })

  it('scrubs it from the body before the 200-character cut, so not even a short head of it is left', () => {
    // Placed so the cut leaves ten characters of the token: too short for the
    // slice mask to recognise afterwards, so only scrubbing the body first
    // keeps them out.
    const body = { status: 'error', field: 'authTokensExt', pad: 'x'.repeat(130), value: TOKEN }
    expect(200 - JSON.stringify(body).indexOf(TOKEN), 'the cut does not fall where this test means it to').toBe(10)
    expect(scrubbedErrText(refusal(body), [TOKEN])).not.toContain(TOKEN.slice(0, 10))
  })

  it('scrubs a piece of the token that Cribl itself cut short', () => {
    noSliceOf(scrubbedErrText(refusal({ message: `token ${TOKEN.slice(0, 30)}… is not accepted` }), [TOKEN]), TOKEN)
  })

  it('scrubs a source’s existing tokens, from either field, out of an error that quotes the body', () => {
    const EXT = 'lab-secret-0123456789abcdef-ext'
    const OLD = 'lab-secret-legacy-token-9876543210'
    const source = { id: 'in_x', authTokensExt: [{ token: EXT, authType: 'manual' }], authTokens: [OLD] }
    expect(tokensOf(source)).toEqual([EXT, OLD])
    const detail = scrubbedErrText(refusal({ message: `invalid source: ${JSON.stringify(source)}` }), tokensOf(source))
    noSliceOf(detail, EXT)
    noSliceOf(detail, OLD)
  })

  it('masks a whole token it finds, and leaves the rest of the sentence', () => {
    const detail = scrubbedErrText(refusal({ message: `invalid input: ${JSON.stringify({ authTokensExt: [{ token: TOKEN }] })}` }), [TOKEN])
    expect(detail).toContain('<token>')
    expect(detail).toContain('invalid input')
    expect(detail).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe('a commit that did not carry every file this run changed', () => {
  const BREAKERS = `groups/${GROUP}/local/cribl/breakers.yml`
  const commitBreakers = () => run(['local/cribl/breakers.yml'], [BREAKERS])

  it('is not deployed, and says which file was left out', async () => {
    // Git reports the file; the commit answers with a hash but the file is
    // still uncommitted after it.
    const calls = stubLeader({ pending: [BREAKERS], commitLeaves: [BREAKERS] })
    const steps = await commitBreakers()
    expect(writes(calls)).not.toContain(`PATCH ${PRODUCTS_DEPLOY}`)
    expect(step(steps, 'commit')?.action).toBe('error')
    expect(step(steps, 'commit')?.detail).toContain(BREAKERS)
  })

  it('is deployed when Git reports nothing of this run left behind', async () => {
    const calls = stubLeader({ pending: [BREAKERS] })
    await commitBreakers()
    expect(writes(calls)).toContain(`PATCH ${PRODUCTS_DEPLOY}`)
  })
})

describe('the port picker’s rules', () => {
  it('holds a Cribl-managed group to 20000–20010 and a hybrid one to any valid port', () => {
    expect(portProblem(20000, true, [])).toBeNull()
    expect(portProblem(20010, true, [])).toBeNull()
    expect(portProblem(19999, true, [])).toContain('20000–20010')
    expect(portProblem(20011, true, [])).toContain('20000–20010')
    expect(portProblem(9999, false, [])).toBeNull()
    for (const bad of [0, 65536, 1.5, Number.NaN]) expect(portProblem(bad, false, []), String(bad)).not.toBeNull()
  })

  it('refuses a port below 1024 on a hybrid group, whose workers do not run as root', () => {
    expect(portProblem(514, false, [])).toContain('1024')
    expect(portProblem(1023, false, [])).toContain('1024')
    expect(portProblem(1024, false, [])).toBeNull()
  })

  it('refuses a port another source uses, and refuses to guess when it cannot read them', () => {
    expect(portProblem(20001, true, [20001])).toContain('already listens')
    expect(portProblem(20001, true, null)).toContain('could not read')
  })

  it('offers the lowest free port, and none when the managed range is full', () => {
    expect(suggestPort(true, [20000, 20001])).toBe(20002)
    expect(suggestPort(true, Array.from({ length: 11 }, (_, i) => 20000 + i))).toBeNull()
    expect(suggestPort(false, [10080])).toBe(10081)
  })

  it('counts every port a source listens on, Syslog’s two included', () => {
    expect(portsInUse([
      { id: 'a', type: 'syslog', connectedOutputs: [], ports: [5514, 5515], portUnknown: false, breakerRulesets: [] },
      { id: 'b', type: 'http_raw', connectedOutputs: [], ports: [20001], portUnknown: false, breakerRulesets: [] },
    ])).toEqual([5514, 5515, 20001])
  })

  it('answers "cannot tell" when any source’s port could not be read', () => {
    expect(portsInUse([
      { id: 'a', type: 'http', connectedOutputs: [], ports: [20001], portUnknown: false, breakerRulesets: [] },
      { id: 'b', type: 'http', connectedOutputs: [], ports: [], portUnknown: true, breakerRulesets: [] },
    ])).toBeNull()
  })

  it('calls a group Cribl-managed only when its record says onPrem false AND the Leader is Cribl.Cloud', () => {
    expect(hostingOf(false, 'main-acme.cribl.cloud')).toBe('managed')
    expect(hostingOf(true, 'main-acme.cribl.cloud')).toBe('hybrid')
    expect(hostingOf(true, 'leader.example.com')).toBe('hybrid')
    // A self-hosted Leader: no Cloud certificate and no 20000–20010 limit, so
    // neither rule may be applied to it by default.
    expect(hostingOf(false, 'leader.example.com')).toBeNull()
    expect(hostingOf(null, 'main-acme.cribl.cloud')).toBeNull()
    expect(hostingOf(undefined, 'leader.example.com')).toBeNull()
    expect(hostingOf(false, null)).toBeNull()
    expect(isCriblCloudHost('evilcribl.cloud')).toBe(false)
    expect(isCriblCloudHost('cribl.cloud.example.com')).toBe(false)
  })

  it('builds https only for a source that terminates TLS', () => {
    expect(postUrl('default.main.x.cribl.cloud', 20001, true)).toBe('https://default.main.x.cribl.cloud:20001/')
    expect(postUrl('worker', 10080, false)).toBe('http://worker:10080/')
  })
})

// ── What these tests could not assert, and why ──────────────────────────────
//
// Read this before reporting a green run as a result. The fake Leader above is
// transcribed from the API spec and from one measured workspace; every status in
// it is a decision this file made.
//
//   * ANY REFUSAL. Every 401/403 in this suite is fabricated. The gate is
//     retrospective and this workspace's callers are all admins, so no
//     permission has ever actually been enforced against this code (V-S11).
