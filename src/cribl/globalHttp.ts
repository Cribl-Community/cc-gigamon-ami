// Guided Setup's Onboard, outside the pack: connect a Raw HTTP source of the
// picked worker group to Cribl Lake `gigamon_ami` — one the group already has,
// or `in_gigamon_ami_http`, created — and create what that connection needs.
//
// ── THE FLOW (owner decision 2026-10-24) ────────────────────────────────────
// Onboard → pick a worker group → pick one of its Raw HTTP sources (or "create
// a new one") → the run connects it to the Cribl Lake destination writing
// `gigamon_ami` through the pipeline `gigamon`, creating the pipeline and the
// destination when the group lacks them. This reverses, for the Raw HTTP
// source, the 2026-09-25/26 decisions that made the pack the only onboarding;
// the pack still carries the sample DataGen and the Parquet copy.
//
// ── WHAT IT CREATES WHEN ABSENT, AND NEVER EDITS ────────────────────────────
//   * `GLOBAL_HTTP_BREAKER_ID` — packSpecs.ts's `HTTP_BREAKER_SPEC` under this
//     id: one event per record of a POSTed JSON array, fields extracted.
//   * `GLOBAL_HTTP_PIPELINE_ID` (`gigamon`) — `PIPELINE_SPEC`'s cast and
//     derive. One of that id already in the group is used as it is.
//   * `LAKE_DESTINATION_ID` (`gigamon_lake`, writing `gigamon_ami`) —
//     `DESTINATION_SPEC`; the demo feed and the Lake landing panel use it too.
//   * `GLOBAL_HTTP_INPUT_ID` — only when the person picks "create a new
//     source": their port, a token the run generates, TLS for the hosting.
//
// ── WHAT IT CHANGES ON A SOURCE THE PERSON PICKED ───────────────────────────
// One whole-body PATCH, held to the diff the confirmation showed
// (`connectPlan`): a QuickConnect connection `gigamon` → `gigamon_lake` ADDED
// beside the ones it has (replacing any other connection into `gigamon_lake`,
// which would write every record twice), and the JSON-array breaker put FIRST in its breaker
// list. Its port, token, TLS and other connections are kept, so a source
// shared with another project goes on feeding it. A source on Send to Routes
// is refused: switching it to QuickConnect would cut off its routes. The
// onboarded source is the one that carries that connection
// (`isConnected`) — read, never stored.
//
// ── NOT REMOVED BY THIS APP ─────────────────────────────────────────────────
// There is no DELETE here: paths.ts `LEFT_BEHIND` says why. Remove pack does
// not touch these objects.

import { capi, groupPath, type ApiResp } from './capi'
import { DESTINATION_SPEC, HTTP_BREAKER_SPEC, PIPELINE_SPEC, sourceCreateBody } from './packSpecs'
import type { DiffRow } from './landing'
import { sameDiff } from './landing'
import { PACK_COMMIT_MARKERS, packCommitPaths, tlsCertOf, type HttpInputState } from './packClient'
import {
  GLOBAL_HTTP_BREAKER_ID, GLOBAL_HTTP_INPUT_ID, GLOBAL_HTTP_PIPELINE_ID, GLOBAL_OBJECTS, GLOBAL_OBJECT_ID, type GlobalObject,
} from './globalHttpIds'
import {
  LAKE_DESTINATION_ID, SOURCE_SERVER_OWNED, commitMatchingAndDeploy, commitScopeFor, firstItem, groupInputs, portProblem,
  portsInUse, sameValue, scrubbedErrText, tokensOf, type CommitScope, type ResourceState, type StepResult,
} from './provision'

export {
  GLOBAL_HTTP_BREAKER_ID, GLOBAL_HTTP_INPUT_ID, GLOBAL_HTTP_PIPELINE_ID, GLOBAL_OBJECTS, GLOBAL_OBJECT_ID, GLOBAL_OBJECT_KIND,
  type GlobalObject,
} from './globalHttpIds'

// ── The bodies ──────────────────────────────────────────────────────────────

export const GLOBAL_BREAKER_BODY = Object.freeze({ ...HTTP_BREAKER_SPEC, id: GLOBAL_HTTP_BREAKER_ID })
export const GLOBAL_PIPELINE_BODY = Object.freeze({ ...PIPELINE_SPEC, id: GLOBAL_HTTP_PIPELINE_ID })
export const GLOBAL_DESTINATION_BODY = DESTINATION_SPEC

/** The source as created: the spec's port, TLS and token, under this id, with
 *  its own breaker, and wired to Cribl Lake by QuickConnect rather than routes. */
export function globalSourceBody(opts: { port: number; token: string; managed: boolean }): Record<string, unknown> {
  return {
    ...sourceCreateBody({ managed: opts.managed, port: opts.port }, opts.token),
    id: GLOBAL_HTTP_INPUT_ID,
    breakerRulesets: [GLOBAL_HTTP_BREAKER_ID],
    sendToRoutes: false,
    connections: [{ pipeline: GLOBAL_HTTP_PIPELINE_ID, output: LAKE_DESTINATION_ID }],
    description: 'Gigamon AMX POSTs AMI records here (JSON arrays). Created by the Gigamon Network Observability app.',
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** One of the group's Raw HTTP sources, as the picker lists it. Never a token. */
export interface RawHttpSource {
  id: string
  port: number | null
  tls: boolean
  disabled: boolean
  tokenSet: boolean
  /** Sent by QuickConnect (`sendToRoutes: false`) rather than through routes. */
  quickConnect: boolean
  /** Its QuickConnect connections' destinations. */
  outputs: string[]
  /** It already carries the `gigamon` → `gigamon_lake` connection. */
  connected: boolean
  /** Why it cannot be onboarded, or null. */
  refusal: string | null
}

export interface GlobalHttpState {
  /** Each object: present, absent (404), or unreadable (anything else).
   *  `source` is the onboarded source: one that carries the connection. */
  objects: Record<GlobalObject, ResourceState>
  /** The onboarded source's id and settings; never its token. */
  sourceId: string | null
  http: HttpInputState | null
  /** The group's Raw HTTP sources, or null when the list could not be read. */
  sources: RawHttpSource[] | null
}

const stateOf = (r: ApiResp): ResourceState => (r.status === 200 ? 'present' : r.status === 404 ? 'absent' : 'unreadable')

/** One GET per object, each by its own literal path — GETs only. */
async function readObject(group: string, which: GlobalObject): Promise<ApiResp> {
  switch (which) {
    case 'breaker': return capi('GET', groupPath(group, `/lib/breakers/${GLOBAL_HTTP_BREAKER_ID}`))
    case 'pipeline': return capi('GET', groupPath(group, `/pipelines/${GLOBAL_HTTP_PIPELINE_ID}`))
    case 'destination': return capi('GET', groupPath(group, `/system/outputs/${LAKE_DESTINATION_ID}`))
    case 'source': return readSource(group, GLOBAL_HTTP_INPUT_ID)
  }
}

/** Any one of the group's own sources, by id. */
function readSource(group: string, id: string): Promise<ApiResp> {
  return capi('GET', groupPath(group, `/system/inputs/${encodeURIComponent(id)}`))
}

const numberOr = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** What the source says about itself, never its token. */
export function httpStateOf(live: Record<string, unknown>): HttpInputState {
  const tls = live.tls && typeof live.tls === 'object' ? (live.tls as Record<string, unknown>) : null
  const tlsOn = tls !== null && tls.disabled === false
  return {
    disabled: live.disabled === true,
    port: numberOr(live.port),
    tokenSet: tokensOf(live).length > 0,
    tls: tlsOn,
    tlsCert: tlsOn && tls ? tlsCertOf(tls) : null,
  }
}

type Connection = { pipeline?: unknown; output?: unknown }
const connectionsOf = (live: Record<string, unknown>): Connection[] =>
  Array.isArray(live.connections) ? (live.connections as unknown[]).filter((c): c is Connection => !!c && typeof c === 'object') : []

/** The connection onboarding adds. */
export const LAKE_CONNECTION = Object.freeze({ pipeline: GLOBAL_HTTP_PIPELINE_ID, output: LAKE_DESTINATION_ID })

/** Whether a source already carries the `gigamon` → `gigamon_lake` connection. */
export const isConnected = (live: Record<string, unknown>): boolean =>
  connectionsOf(live).some((c) => c.pipeline === LAKE_CONNECTION.pipeline && c.output === LAKE_CONNECTION.output)

/** Why a source cannot be connected, or null. */
export function connectRefusal(live: Record<string, unknown>): string | null {
  if (live.sendToRoutes !== false) {
    return 'it uses Send to Routes, and switching it to QuickConnect would cut off its routes. Switch it to QuickConnect in Cribl Stream, or pick another source'
  }
  return null
}

/** One source as the picker lists it. */
export function rawHttpSourceOf(live: Record<string, unknown>): RawHttpSource {
  const st = httpStateOf(live)
  return {
    id: String(live.id ?? ''),
    port: st.port,
    tls: st.tls,
    disabled: st.disabled,
    tokenSet: st.tokenSet,
    quickConnect: live.sendToRoutes === false,
    outputs: connectionsOf(live).map((c) => String(c.output ?? '')).filter(Boolean),
    connected: isConnected(live),
    refusal: isConnected(live) ? null : connectRefusal(live),
  }
}

/** The group's own Raw HTTP sources, whole; null when the list could not be read. */
async function rawHttpLive(group: string): Promise<Record<string, unknown>[] | null> {
  const r = await capi('GET', groupPath(group, '/system/inputs'))
  if (r.status !== 200) return null
  const list = (r.body as { items?: unknown })?.items
  if (!Array.isArray(list)) return null
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && (x as { type?: unknown }).type === 'http_raw')
}

/** The group's Raw HTTP sources, for the picker — GETs only. */
export async function listRawHttpSources(group: string): Promise<RawHttpSource[] | null> {
  const live = await rawHttpLive(group)
  return live ? live.map(rawHttpSourceOf) : null
}

/** The Lake objects' states, the group's Raw HTTP sources and which one is
 *  onboarded (it carries the connection) — GETs only. */
export async function readGlobalHttp(group: string): Promise<GlobalHttpState> {
  const lake: GlobalObject[] = ['breaker', 'pipeline', 'destination']
  const [reads, live] = await Promise.all([Promise.all(lake.map((w) => readObject(group, w))), rawHttpLive(group)])
  const onboarded = live?.find(isConnected) ?? null
  const objects = {
    ...Object.fromEntries(lake.map((w, i) => [w, stateOf(reads[i])])),
    source: live === null ? 'unreadable' : onboarded ? 'present' : 'absent',
  } as Record<GlobalObject, ResourceState>
  return {
    objects,
    sourceId: onboarded ? String(onboarded.id) : null,
    http: onboarded ? httpStateOf(onboarded) : null,
    sources: live ? live.map(rawHttpSourceOf) : null,
  }
}

/** Every port another source in the group listens on (`except` excluded),
 *  or null when any could not be read — "cannot tell" is never "free". */
export async function portsOfOtherSources(group: string, except: string = GLOBAL_HTTP_INPUT_ID): Promise<number[] | null> {
  const inputs = await groupInputs(group)
  if (!inputs) return null
  return portsInUse(inputs.filter((i) => !(i.pack === null && i.id === except)))
}

// ── Connecting a source the person picked ───────────────────────────────────

const words = (v: readonly unknown[]): string =>
  v.length === 0 ? 'none' : v.map((c) => (typeof c === 'string' ? c : `${String((c as Connection).pipeline ?? 'passthru')} → ${String((c as Connection).output ?? '?')}`)).join(', ')

/** What connecting `live` sets, and its before→after — or why not. Pure. */
export function connectPlan(
  live: Record<string, unknown>,
  opts: { token?: string; usedPorts?: readonly number[] | null } = {},
): { set: Record<string, unknown>; diff: DiffRow[]; newToken: boolean } | { refuse: string } {
  const refuse = connectRefusal(live)
  if (refuse) return { refuse }
  const set: Record<string, unknown> = {}
  const diff: DiffRow[] = []
  const conns = connectionsOf(live)
  // Ours is added beside the others — except a connection already sending to
  // the same Lake destination, which ours replaces: two into gigamon_lake
  // would write every record into gigamon_ami twice (an earlier build of this
  // app connected through `gigamon_ami_http_normalize`).
  const others = conns.filter((c) => c.output !== LAKE_CONNECTION.output)
  if (!isConnected(live) || others.length + 1 !== conns.length) {
    set.connections = [...others, { ...LAKE_CONNECTION }]
    diff.push({ key: 'connections', kind: Object.hasOwn(live, 'connections') ? 'changed' : 'added', before: words(conns), after: words(set.connections as Connection[]) })
  }
  const breakers = Array.isArray(live.breakerRulesets) ? (live.breakerRulesets as unknown[]).map(String) : []
  if (breakers[0] !== GLOBAL_HTTP_BREAKER_ID) {
    set.breakerRulesets = [GLOBAL_HTTP_BREAKER_ID, ...breakers.filter((b) => b !== GLOBAL_HTTP_BREAKER_ID)]
    diff.push({ key: 'breakerRulesets', kind: Object.hasOwn(live, 'breakerRulesets') ? 'changed' : 'added', before: words(breakers), after: words(set.breakerRulesets as string[]) })
  }
  // Switched on, so traffic flows as soon as Gigamon AMX sends (owner decision
  // 2026-10-26) — only on a port no other source holds, and never without an
  // auth token: one with none gets a new one, generated by the run and shown
  // once, or it would accept a POST from anyone who can reach the port.
  let newToken = false
  if (live.disabled === true) {
    const port = numberOr(live.port)
    if (opts.usedPorts === null) return { refuse: 'this app could not read the ports the group’s other sources use, so it cannot tell whether it can be switched on' }
    if (port === null) return { refuse: 'this app cannot read its port, so it cannot be switched on safely' }
    if ((opts.usedPorts ?? []).includes(port)) {
      return { refuse: `it is off, and its port ${port} is used by another source, so it cannot be switched on. Move it to a free port in Cribl Stream, or pick another source` }
    }
    set.disabled = false
    diff.push({ key: 'disabled', kind: 'changed', before: true, after: false })
    if (tokensOf(live).length === 0) {
      newToken = true
      set.authTokensExt = [{ token: opts.token ?? '', authType: 'manual' }]
      diff.push({ key: 'authTokensExt', kind: Object.hasOwn(live, 'authTokensExt') ? 'changed' : 'added', before: 'no token', after: 'a new token (not shown)' })
    }
  }
  return { set, diff, newToken }
}

export type ConnectPreview = { ok: true; diff: DiffRow[] } | { ok: false; why: string }

async function decideConnect(group: string, id: string, token: string):
Promise<{ live: Record<string, unknown>; set: Record<string, unknown>; diff: DiffRow[]; newToken: boolean } | { why: string }> {
  const got = await readSource(group, id)
  if (got.status === 404) return { why: `${id} is no longer in ${group}` }
  const live = got.status === 200 ? firstItem(got) : null
  if (!live) return { why: got.status === 200 ? `this app could not read ${id}, and this endpoint replaces the whole object` : scrubbedErrText(got, []) }
  if (live.type !== 'http_raw') return { why: `${id} is not a Raw HTTP source` }
  const usedPorts = live.disabled === true ? await portsOfOtherSources(group, id) : []
  const plan = connectPlan(live, { token, usedPorts })
  if ('refuse' in plan) return { why: `${id} cannot be connected: ${plan.refuse}` }
  return { live, ...plan }
}

/** What `connectSource` would change on `id` — GETs only. */
export async function previewConnect(group: string, id: string): Promise<ConnectPreview> {
  // A token the preview needs only to decide the plan; it is thrown away (the
  // diff reads "a new token (not shown)" whatever its value).
  const d = await decideConnect(group, id, '')
  return 'why' in d ? { ok: false, why: d.why } : { ok: true, diff: d.diff }
}

/**
 * Connect a source the person picked: GET → overlay → whole-body PATCH, sent
 * only when the live source still gives the diff the confirmation showed. Its
 * tokens are scrubbed from any error and never carried anywhere else.
 */
export async function connectSource(
  group: string, id: string, approved: readonly DiffRow[], token: string,
): Promise<GlobalStep & { newToken?: boolean }> {
  const d = await decideConnect(group, id, token)
  if ('why' in d) return { object: 'source', id, action: 'error', detail: `not changed — ${d.why}` }
  if (!sameDiff(approved, d.diff)) {
    return { object: 'source', id, action: 'error', detail: 'not changed — the source changed after the confirmation was shown. Look again, and confirm again.' }
  }
  if (d.diff.length === 0) return { object: 'source', id, action: 'exists', detail: 'already connected to Cribl Lake; left as it is' }
  const body: Record<string, unknown> = { ...d.live }
  for (const k of SOURCE_SERVER_OWNED) delete body[k]
  Object.assign(body, d.set)
  const r = await capi('PATCH', groupPath(group, `/system/inputs/${encodeURIComponent(id)}`), body)
  if (r.status < 200 || r.status >= 300) return { object: 'source', id, action: 'error', detail: scrubbedErrText(r, [...tokensOf(d.live), token]) }
  return {
    object: 'source', id, action: 'updated', newToken: d.newToken,
    detail: `connected${d.set.disabled === false ? ' and started' : ''}: ${d.diff.map((x) => x.key).join(', ')}`,
  }
}

// ── Creating ────────────────────────────────────────────────────────────────

/** One line of what the create did. Never carries a token. */
export interface GlobalStep {
  object: GlobalObject
  id: string
  action: 'created' | 'updated' | 'exists' | 'error'
  detail?: string
}

async function createObject(group: string, which: GlobalObject, source: Record<string, unknown> | null): Promise<ApiResp> {
  switch (which) {
    case 'breaker': return capi('POST', groupPath(group, '/lib/breakers'), GLOBAL_BREAKER_BODY)
    case 'pipeline': return capi('POST', groupPath(group, '/pipelines'), GLOBAL_PIPELINE_BODY)
    case 'destination': return capi('POST', groupPath(group, '/system/outputs'), GLOBAL_DESTINATION_BODY)
    case 'source': return capi('POST', groupPath(group, '/system/inputs'), source)
  }
}

/** The Lake objects alone — for a source the person picked. */
export const ensureLakeObjects = (group: string): Promise<GlobalStep[]> =>
  createGlobalHttpStack(group, { port: 0, token: '', managed: true }, ['breaker', 'pipeline', 'destination'])

/**
 * Create whatever of the four is absent, in order, re-reading each first:
 * present is left exactly as it is, unreadable or a failed create stops there
 * (the source is never created without what it names). The source is read
 * back after its create. The token is only in the source's POST body, and is
 * scrubbed from any error.
 */
export async function createGlobalHttpStack(
  group: string,
  opts: { port: number; token: string; managed: boolean },
  only: readonly GlobalObject[] = GLOBAL_OBJECTS,
): Promise<GlobalStep[]> {
  const out: GlobalStep[] = []
  for (const which of GLOBAL_OBJECTS.filter((o) => only.includes(o))) {
    const id = GLOBAL_OBJECT_ID[which]
    const now = stateOf(await readObject(group, which))
    if (now === 'present') {
      out.push({ object: which, id, action: 'exists', detail: 'already in the group; left as it is' })
      continue
    }
    if (now === 'unreadable') {
      out.push({ object: which, id, action: 'error', detail: 'not created — this app could not tell whether it already exists' })
      return out
    }
    if (which === 'source') {
      const problem = portProblem(opts.port, opts.managed, await portsOfOtherSources(group))
      if (problem) {
        out.push({ object: which, id, action: 'error', detail: `not created — port ${opts.port}: ${problem}` })
        return out
      }
    }
    const r = await createObject(group, which, which === 'source' ? globalSourceBody(opts) : null)
    if (r.status < 200 || r.status >= 300) {
      out.push({ object: which, id, action: 'error', detail: scrubbedErrText(r, [opts.token]) })
      return out
    }
    if (which === 'source') {
      const back = await readObject(group, 'source')
      const live = back.status === 200 ? firstItem(back) : null
      if (!live || tokensOf(live).length === 0) {
        out.push({ object: which, id, action: 'error', detail: 'the create was answered, but the source could not be read back with its auth token' })
        return out
      }
    }
    out.push({ object: which, id, action: 'created', ...(which === 'source' ? { detail: `port ${opts.port}, started` } : {}) })
  }
  return out
}

// ── Changing the source's own settings ──────────────────────────────────────

export type GlobalHttpChange =
  | { kind: 'token'; token: string }
  | { kind: 'port'; port: number; managed: boolean }

export type GlobalHttpPreview = { ok: true; diff: DiffRow[] } | { ok: false; why: string }

const TOKEN_SHAPE = /^[0-9a-f]{32,}$/i

async function decideChange(group: string, id: string, change: GlobalHttpChange):
Promise<{ live: Record<string, unknown>; set: Record<string, unknown>; diff: DiffRow[]; scrub: string[] } | { why: string }> {
  if (change.kind === 'token' && !TOKEN_SHAPE.test(change.token)) return { why: 'not applied — the token must be at least 128 bits of hex' }
  if (change.kind === 'port') {
    const problem = portProblem(change.port, change.managed, await portsOfOtherSources(group, id))
    if (problem) return { why: `not applied — port ${change.port}: ${problem}` }
  }
  const got = await readSource(group, id)
  if (got.status === 404) return { why: `${id} is not in ${group} — run Onboard to connect a source` }
  const live = got.status === 200 ? firstItem(got) : null
  if (!live) return { why: got.status === 200 ? `this app could not read the live ${id}, and this endpoint replaces the whole object` : scrubbedErrText(got, []) }
  const set: Record<string, unknown> = change.kind === 'token'
    ? { authTokensExt: [{ token: change.token, authType: 'manual' }] }
    : { port: change.port }
  const diff: DiffRow[] = []
  if (change.kind === 'token') {
    const had = tokensOf(live).length > 0
    diff.push({ key: 'authTokensExt', kind: had ? 'changed' : 'added', before: had ? 'a token is set (not shown)' : 'no token', after: 'a new token (not shown)' })
  } else if (!sameValue(live.port, change.port)) {
    diff.push({ key: 'port', kind: Object.hasOwn(live, 'port') ? 'changed' : 'added', before: live.port, after: change.port })
  }
  return { live, set, diff, scrub: [...tokensOf(live), ...(change.kind === 'token' ? [change.token] : [])] }
}

/** What `applyGlobalHttpChange` would change — GETs only. */
export async function previewGlobalHttpChange(group: string, id: string, change: GlobalHttpChange): Promise<GlobalHttpPreview> {
  const d = await decideChange(group, id, change)
  return 'why' in d ? { ok: false, why: d.why } : { ok: true, diff: d.diff }
}

/**
 * GET → overlay → whole-body PATCH of the source, sent only when the live
 * source still gives the diff the confirmation showed (`approved`).
 */
export async function applyGlobalHttpChange(
  group: string,
  id: string,
  change: GlobalHttpChange,
  approved: readonly DiffRow[],
): Promise<{ action: 'updated' | 'exists' | 'error'; detail?: string; sent?: boolean }> {
  const d = await decideChange(group, id, change)
  if ('why' in d) return { action: 'error', detail: d.why }
  if (!sameDiff(approved, d.diff)) {
    if (d.diff.length === 0) return { action: 'exists', detail: 'nothing left to change — it was applied after this change was shown' }
    return { action: 'error', detail: 'not applied — the source changed after this change was shown. Look again, and confirm again.' }
  }
  if (d.diff.length === 0) return { action: 'exists', detail: 'already set' }
  const body: Record<string, unknown> = { ...d.live }
  for (const k of SOURCE_SERVER_OWNED) delete body[k]
  Object.assign(body, d.set)
  const r = await capi('PATCH', groupPath(group, `/system/inputs/${encodeURIComponent(id)}`), body)
  if (r.status < 200 || r.status >= 300) return { action: 'error', detail: scrubbedErrText(r, d.scrub), sent: true }
  return { action: 'updated', detail: d.diff.map((row) => row.key).join(', ') }
}

// ── Committing ──────────────────────────────────────────────────────────────

/**
 * What selects these objects' files among the group's pending Git paths.
 * Cribl keeps a group's own sources, destinations and breaker rulesets each in
 * one file (`groups/<g>/local/cribl/inputs.yml`, `outputs.yml`,
 * `breakers.yml` — the breakers file measured 2026-09-17 from
 * `/version/show`), and a pipeline in a directory of its own. The unit of a
 * commit is the file, so a commit of `inputs.yml` carries anybody's pending
 * edit to another source too; the confirmation says what is already pending.
 */
export const GLOBAL_COMMIT_MARKERS: readonly string[] = Object.freeze([
  'local/cribl/inputs.yml',
  'local/cribl/outputs.yml',
  'local/cribl/breakers.yml',
  `local/cribl/pipelines/${GLOBAL_HTTP_PIPELINE_ID}/`,
])

/** The same files, as a commit names them when Git reports nothing at all. */
export const globalCommitPaths = (group: string): string[] => [
  `groups/${group}/local/cribl/inputs.yml`,
  `groups/${group}/local/cribl/outputs.yml`,
  `groups/${group}/local/cribl/breakers.yml`,
  `groups/${group}/local/cribl/pipelines/${GLOBAL_HTTP_PIPELINE_ID}`,
]

/** What a commit of a source change carries, and what else is pending. */
export function globalCommitScope(group: string, pending: readonly string[] | null): CommitScope {
  return commitScopeFor(group, globalCommitPaths(group), GLOBAL_COMMIT_MARKERS, pending)
}

/** Commit the source's file and deploy, after a change that answered
 *  `updated` (provision.ts `commitMatchingAndDeploy`). */
export async function commitAndDeployGlobal(
  group: string,
  message: string,
  record: (hash: string, message: string) => Promise<unknown>,
  onStep?: (r: StepResult) => void,
): Promise<StepResult[]> {
  let recorded: Promise<unknown> | null = null
  const step = (r: StepResult) => {
    const hash = r.key === 'commit' ? r.hash : undefined
    if (hash && !recorded) recorded = Promise.resolve().then(() => record(hash, r.message ?? message)).catch(() => false)
    onStep?.(r)
  }
  const nothing = `The Raw HTTP source was changed, but Git reports none of its files uncommitted in ${group}, so nothing was ` +
    `committed or deployed. Commit and deploy ${group} in Cribl.`
  const steps = await commitMatchingAndDeploy(message, group, GLOBAL_COMMIT_MARKERS, globalCommitPaths(group), step, undefined, nothing)
  await recorded
  return steps
}

/** The Onboard run's commit: the pack's files and these, in one. */
export const onboardingCommitAlso = (group: string) => ({ markers: GLOBAL_COMMIT_MARKERS, paths: globalCommitPaths(group) })

/** What the Onboard run's commit carries, and what else is pending. */
export function onboardingCommitScope(group: string, pending: readonly string[] | null): CommitScope {
  return commitScopeFor(
    group, [...packCommitPaths(group), ...globalCommitPaths(group)], [...PACK_COMMIT_MARKERS, ...GLOBAL_COMMIT_MARKERS], pending,
  )
}
