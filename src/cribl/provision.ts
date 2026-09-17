// Guided-setup provisioning client.
//
// Deploys the *real-world* Gigamon AMI onboarding path into the Cribl Stream
// `default` group — a Syslog source, a parse+normalize pipeline, a route, and
// the Cribl Lake dataset — so a user can point their Gigamon Application
// Metadata Exporter (AMX) at Cribl and have flows land in the same `gigamon_ami`
// dataset these dashboards already read.
//
// Every operation is idempotent and ADDITIVE: it never edits the demo DataGen
// source, the existing `gigamon_ami` pipeline, or the `gigamon_lake`
// destination. The route is prepended above the catch-all `default` route with
// a filter scoped to this source, so unrelated data is unaffected.
//
// Additive is not the same as harmless, though, and this is the only file in the
// app that writes customer configuration. Three of the calls below overwrite
// something that already exists — a PATCH of the pipeline, a PATCH of the source,
// and the PATCH of the routing table, which replaces the whole array — and the
// deploy pushes the result to running workers. AGENTS.md ("Confirming Destructive
// Operations") requires an explicit confirmation naming exactly those objects
// before any of it runs, and forbids reaching it from load, render or a timer.
// Nothing here enforces that, because nothing here can tell a deliberate click
// from an accidental one: the confirmation lives in components/ProvisionPanel.tsx
// (it moved out of tabs/GuidedSetup.tsx with the rest of the provisioning half),
// in front of `deployAll` and `removeSyslogStack`, which are the only two entry
// points that write anything. Every other export is a GET.
//
// Calls go through cribl/capi.ts, which is where the auth story lives: the
// platform proxy (installed) and the Vite `/capi` proxy (`npm run dev`) both
// inject it, so nothing here handles a token.

import { isDenial } from './authz'
import { capi, errText, groupPath, type ApiResp } from './capi'
import { STREAM_GROUP } from './config'
import { appendLog } from './kv'
import { loadCommitMemory } from './setupMemory'

export const SYSLOG_SOURCE_ID = 'in_gigamon_syslog'
export const SYSLOG_PIPELINE_ID = 'gigamon_syslog'
export const SYSLOG_ROUTE_ID = 'gigamon_ami_syslog'
export const LAKE_DESTINATION_ID = 'gigamon_lake'
export const LAKE_DATASET_ID = 'gigamon_ami'
export const SYSLOG_PORT = 5514
const LAKE_ID = 'default'

// --- Resource specs (exported so the UI can show exactly what gets created) ---

/** The two Evals below are copied verbatim from the existing `gigamon_ami`
 *  pipeline so syslog-delivered flows get identical field derivations. */
const NUMERIC_FIELDS = [
  'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets', 'src_port', 'dst_port',
  'protocol', 'app_id', 'ip_version', 'tcp_rtt', 'tcp_rtt_app', 'tcp_dup_ack',
  'tcp_loss_count', 'tcp_wrong_crc', 'tcp_unseq', 'dns_response_time', 'dns_ttl',
  'ssl_mitm_score', 'ssl_request_size', 'snmp_version', 'end_reason', 'seq_num',
  'http_request_ts', 'http_response_ts', 'tcp_flags',
]

const CAST_FN = {
  id: 'eval', filter: 'true', disabled: false, description: 'Cast numeric strings',
  conf: { add: NUMERIC_FIELDS.map((n) => ({ name: n, value: `${n}==null?${n}:Number(${n})` })) },
}

const DERIVE_FN = {
  id: 'eval', filter: 'true', disabled: false, description: 'Derive helper fields',
  conf: {
    add: [
      { name: 'src_subnet', value: "typeof src_ip==='string'?src_ip.split('.').slice(0,3).join('.'):undefined" },
      { name: 'dst_subnet', value: "typeof dst_ip==='string'?dst_ip.split('.').slice(0,3).join('.'):undefined" },
      { name: 'total_bytes', value: '(src_bytes||0)+(dst_bytes||0)' },
      { name: 'total_packets', value: '(src_packets||0)+(dst_packets||0)' },
      { name: 'l4_proto', value: "({'6':'TCP','17':'UDP','1':'ICMP'})[String(protocol)]||String(protocol)" },
      { name: 'http_server_ms', value: '(http_request_ts!=null&&http_response_ts!=null)?(http_response_ts-http_request_ts)*1000:undefined' },
      { name: 'tcp_reset', value: 'tcp_flags==null?undefined:((tcp_flags&4)?1:0)' },
      { name: 'src_subnet16', value: "typeof src_ip==='string'?src_ip.split('.').slice(0,2).join('.'):undefined" },
      { name: 'dst_subnet16', value: "typeof dst_ip==='string'?dst_ip.split('.').slice(0,2).join('.'):undefined" },
    ],
  },
}

// Syslog-specific pre-parse: Gigamon AMX exports AMI records as JSON in the
// syslog MSG. Fall back to _raw when the source delivers unframed JSON, then
// extract the JSON into top-level fields. (CEF export would need a different
// parse — see the note in the Guided Setup tab.)
const PREP_FN = {
  id: 'eval', filter: 'true', disabled: false, description: 'Fallback to _raw when no syslog MSG',
  conf: { add: [{ name: 'message', value: 'message==null?_raw:message' }] },
}
const PARSE_FN = {
  id: 'serde', filter: "typeof message==='string' && message.trim().charAt(0)==='{'", disabled: false,
  description: 'Parse Gigamon AMI JSON from the syslog message',
  conf: { mode: 'extract', type: 'json', srcField: 'message' },
}

export const PIPELINE_SPEC = {
  id: SYSLOG_PIPELINE_ID,
  conf: { functions: [PREP_FN, PARSE_FN, CAST_FN, DERIVE_FN] },
}

export const SOURCE_SPEC = {
  id: SYSLOG_SOURCE_ID,
  type: 'syslog',
  disabled: false,
  host: '0.0.0.0',
  tcpPort: SYSLOG_PORT,
  udpPort: SYSLOG_PORT,
  sendToRoutes: true,
  streamtags: ['gigamon', 'ami'],
}

export const ROUTE_SPEC = {
  id: SYSLOG_ROUTE_ID,
  name: SYSLOG_ROUTE_ID,
  final: true,
  disabled: false,
  filter: `__inputId=='syslog:${SYSLOG_SOURCE_ID}'`,
  pipeline: SYSLOG_PIPELINE_ID,
  output: LAKE_DESTINATION_ID,
  description: 'Gigamon AMI syslog → parse → Cribl Lake (gigamon_ami)',
  clones: [],
  enableOutputExpression: false,
}

export const DATASET_SPEC = {
  id: LAKE_DATASET_ID,
  description: 'Gigamon Application Metadata Intelligence (AMI) flow records',
  retentionPeriodInDays: 30,
  format: 'json',
}

// The Cribl Lake destination that writes into the `gigamon_ami` dataset. Only
// created if missing (it already exists in the demo tenant).
const DESTINATION_SPEC = {
  id: LAKE_DESTINATION_ID,
  type: 'cribl_lake',
  destPath: LAKE_DATASET_ID,
  format: 'json',
  storageLocationId: 'cribl_lake',
  maxFileSizeMB: 5,
  maxFileOpenTimeSec: 60,
  maxFileIdleTimeSec: 15,
  compress: 'gzip',
  onBackpressure: 'block',
}

// --- Addressing -----------------------------------------------------------

// Every source, pipeline, route and destination below is addressed inside a
// worker group; `g` is the short name this file has always used for that.
const g = groupPath
// The Lake dataset is the exception: Cribl Lake is group-independent.
const datasetsPath = `/products/lake/lakes/${LAKE_ID}/datasets`

// --- Worker groups --------------------------------------------------------

export interface StreamGroup {
  id: string
  name: string
}

/** The Stream worker group the onboarding stack targets by default. */
export const DEFAULT_STREAM_GROUP = STREAM_GROUP

interface RawGroup {
  id?: string
  name?: string
  type?: string // 'stream' | 'edge' | 'outpost' | 'search' | 'local_search' | 'lake_access'
  isFleet?: boolean
  isSearch?: boolean
}

// Groups we never onboard into: Search groups (search runs here, not ingest),
// Outpost groups, and Edge Fleets. Their well-known ids are excluded outright as
// a fallback for builds that don't return `type`.
const EXCLUDED_GROUP_IDS = new Set(['default_search', 'default_outpost'])

/** A Stream worker group is the only valid onboarding target. */
function isStreamGroup(it: RawGroup): boolean {
  if (typeof it.id !== 'string' || !it.id) return false
  if (EXCLUDED_GROUP_IDS.has(it.id)) return false
  // Prefer the explicit `type` when present; only Stream worker groups qualify.
  if (it.type) return it.type === 'stream'
  // Fallback for older leaders without `type`: drop Fleets / Search groups.
  if (it.isFleet || it.isSearch) return false
  return true
}

/**
 * List the Cribl worker groups the onboarding stack can be applied to. Only
 * Stream worker groups are relevant — the source/pipeline/route/destination all
 * live in a Stream group (the Lake dataset is separate and group-independent).
 * Edge Fleets, Outpost groups, and Search groups (e.g. default_search,
 * default_outpost) are intentionally excluded.
 */
export async function listStreamGroups(): Promise<StreamGroup[]> {
  const r = await capi('GET', '/master/groups')
  const items = (r.body as { items?: RawGroup[] })?.items || []
  const groups = items
    .filter(isStreamGroup)
    .map((it) => ({ id: it.id as string, name: it.name || (it.id as string) }))
  // Guarantee the default group is always selectable even if the list call is
  // restricted or returns an unexpected shape.
  if (!groups.some((x) => x.id === DEFAULT_STREAM_GROUP)) {
    groups.unshift({ id: DEFAULT_STREAM_GROUP, name: DEFAULT_STREAM_GROUP })
  }
  return groups
}

// --- Status ---------------------------------------------------------------

export type ResourceKey = 'dataset' | 'destination' | 'pipeline' | 'source' | 'route'

/**
 * What a status check can honestly say about one resource.
 *
 * `unreadable` is the state this used to lack, and its absence reached
 * customers. Every check below is a GET, and a GET the platform refuses answers
 * neither "there" nor "not there" — but a boolean has nowhere to put that, so a
 * refused read became `false`, the row rendered "— absent", and the screen
 * positively told somebody who could not SEE the stack that it did not exist and
 * offered to deploy it. A gate downstream reading that boolean would be reading
 * laundered data, which is worse than no gate at all.
 */
export type ResourceState = 'present' | 'absent' | 'unreadable'

export type SetupStatus = Record<ResourceKey, ResourceState>

/** What one status GET really told us. `present` is the caller's own reading of
 *  the body; a refusal overrides it, because the body of a refused call says
 *  nothing about the resource. */
function stateOf(r: ApiResp, present: boolean): ResourceState {
  if (isDenial(r.status)) return 'unreadable'
  return present ? 'present' : 'absent'
}

export async function checkStatus(group: string = DEFAULT_STREAM_GROUP): Promise<SetupStatus> {
  const [ds, dest, pipe, src, routes] = await Promise.all([
    capi('GET', datasetsPath),
    capi('GET', g(group, `/system/outputs/${LAKE_DESTINATION_ID}`)),
    capi('GET', g(group, `/pipelines/${SYSLOG_PIPELINE_ID}`)),
    capi('GET', g(group, `/system/inputs/${SYSLOG_SOURCE_ID}`)),
    capi('GET', g(group, '/routes')),
  ])
  const dsItems = (ds.body as { items?: Array<{ id?: string }> })?.items || []
  const routeList = ((routes.body as { items?: Array<{ routes?: Array<{ id?: string; name?: string }> }> })?.items?.[0]?.routes) || []
  return {
    dataset: stateOf(ds, dsItems.some((d) => d.id === LAKE_DATASET_ID)),
    destination: stateOf(dest, dest.status === 200),
    pipeline: stateOf(pipe, pipe.status === 200),
    source: stateOf(src, src.status === 200),
    route: stateOf(routes, routeList.some((r) => r.id === SYSLOG_ROUTE_ID || r.name === SYSLOG_ROUTE_ID)),
  }
}

// --- Ensure (idempotent create/update) -----------------------------------

export type StepAction = 'created' | 'updated' | 'exists' | 'error' | 'skipped'
export interface StepResult {
  key: ResourceKey | 'commit' | 'deploy'
  action: StepAction
  detail?: string
  /** On a successful `commit` step: the commit message and Git hash, so the UI
   *  can show the last commit below the resource pills (persists across refresh). */
  message?: string
  hash?: string
}

/** High-level progress phases surfaced as transient status pop-ups in the UI. */
export type Phase =
  | { kind: 'provision'; text: string }
  | { kind: 'commit'; text: string }
  | { kind: 'deploy'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string }

export type OnPhase = (p: Phase) => void
const noopPhase: OnPhase = () => {}

/** Human labels for each resource, used in step logs and phase pop-ups. */
export const STEP_LABELS: Record<ResourceKey | 'commit' | 'deploy', string> = {
  dataset: 'Lake dataset',
  destination: 'Lake destination',
  pipeline: 'Pipeline',
  source: 'Syslog source',
  route: 'Route',
  commit: 'Commit',
  deploy: 'Deploy',
}

// Rich, human-readable description of each resource — names the concrete Cribl
// object and what it does, so the Git commit history explains itself.
const RESOURCE_PHRASE: Record<ResourceKey, string> = {
  dataset: `Cribl Lake dataset '${LAKE_DATASET_ID}'`,
  destination: `Cribl Lake destination '${LAKE_DESTINATION_ID}' → dataset '${LAKE_DATASET_ID}'`,
  pipeline: `pipeline '${SYSLOG_PIPELINE_ID}' (parse Gigamon AMI JSON + normalize fields)`,
  source: `Syslog source '${SYSLOG_SOURCE_ID}' (TCP/UDP ${SYSLOG_PORT})`,
  route: `route '${SYSLOG_ROUTE_ID}' → Cribl Lake '${LAKE_DATASET_ID}'`,
}

/**
 * Compose a self-describing commit message from the resources actually
 * committed — grouped by created vs. updated — so the Git history says what the
 * Gigamon Network Observability app did and why, not just "guided setup".
 */
function deployCommitMessage(group: string, steps: StepResult[]): string {
  const committed = steps.filter((s) => groupFile(group, s.key as ResourceKey))
  const created = committed.filter((s) => s.action === 'created').map((s) => RESOURCE_PHRASE[s.key as ResourceKey])
  const updated = committed.filter((s) => s.action === 'updated').map((s) => RESOURCE_PHRASE[s.key as ResourceKey])
  const clauses: string[] = []
  if (created.length) clauses.push(`added ${created.join(', ')}`)
  if (updated.length) clauses.push(`updated ${updated.join(', ')}`)
  const what = clauses.length ? `: ${clauses.join('; ')}` : ''
  return (
    `Gigamon Network Observability — onboard Gigamon AMI over Syslog into worker group '${group}'${what}. ` +
    `Real AMX exports land in Cribl Lake dataset '${LAKE_DATASET_ID}', feeding the Gigamon Network Observability dashboards.`
  )
}

/** Commit message for teardown, naming exactly what was removed. */
function removeCommitMessage(group: string, keys: ResourceKey[]): string {
  const removed = keys.map((k) => RESOURCE_PHRASE[k]).join(', ')
  return (
    `Gigamon Network Observability — remove Gigamon AMI Syslog onboarding from worker group '${group}': deleted ${removed}. ` +
    `Cribl Lake dataset '${LAKE_DATASET_ID}' retained (shared, group-independent).`
  )
}

/**
 * Git file path for a resource inside a Stream group's local config. Scoping the
 * commit to exactly these files is what keeps us from committing unrelated
 * pending changes elsewhere in the group. Returns null for resources that are
 * not part of the group's Git config (the Lake dataset lives in Cribl Lake).
 */
function groupFile(group: string, key: ResourceKey): string | null {
  const root = `groups/${group}/local/cribl`
  switch (key) {
    case 'destination': return `${root}/outputs.yml`
    case 'source': return `${root}/inputs.yml`
    case 'route': return `${root}/routes.yml`
    case 'pipeline': return `${root}/pipelines/${SYSLOG_PIPELINE_ID}/conf.yml`
    case 'dataset': return null // Cribl Lake — not a Stream group Git file
    default: return null
  }
}

/**
 * Read the config file paths Git currently sees as changed (uncommitted),
 * relative to the versioning repo's config root. This is authoritative: paths
 * are reported exactly as `git` has them, so committing a subset of these can
 * never hit a "pathspec did not match any files" error, and we never touch
 * another group's pending changes. Returns [] if the status call is unavailable.
 */
async function pendingFiles(): Promise<string[]> {
  const r = await capi('GET', '/version/status')
  const items = (r.body as {
    items?: Array<{
      files?: Array<{ path?: string }>
      created?: string[]; deleted?: string[]; modified?: string[]; not_added?: string[]; staged?: string[]
    }>
  })?.items || []
  const out = new Set<string>()
  for (const it of items) {
    for (const f of it.files || []) if (f.path) out.add(f.path)
    for (const arr of [it.created, it.deleted, it.modified, it.not_added, it.staged]) {
      for (const p of arr || []) out.add(p)
    }
  }
  return [...out]
}

/**
 * Layout-independent substring identifying a resource's config file. Matches
 * whether the versioning root yields `groups/<gid>/local/cribl/routes.yml` or a
 * group-rooted `local/cribl/routes.yml` — we don't guess the prefix.
 */
function fileMarker(key: ResourceKey): string | null {
  switch (key) {
    case 'destination': return 'local/cribl/outputs.yml'
    case 'source': return 'local/cribl/inputs.yml'
    case 'route': return 'local/cribl/routes.yml'
    case 'pipeline': return `local/cribl/pipelines/${SYSLOG_PIPELINE_ID}/`
    case 'dataset': return null // Cribl Lake — not a Stream group Git file
    default: return null
  }
}

/** True when a pending path belongs to the target group. Named groups carry a
 *  `groups/<group>/` segment; a group-rooted layout has no `groups/<x>/` at all. */
function pathInGroup(path: string, group: string): boolean {
  if (path.includes(`groups/${group}/`)) return true
  return !path.includes('groups/')
}

/**
 * The exact set of pending paths to commit for the given resource keys in the
 * target group — matched against the real Git status so paths are valid and
 * scoped to just our resources. Falls back to constructed paths only when the
 * status call yields nothing (e.g. endpoint restricted), as a best effort.
 */
async function filesToCommit(group: string, keys: ResourceKey[]): Promise<string[]> {
  if (keys.length === 0) return []
  const markers = keys.map(fileMarker).filter((m): m is string => m !== null)
  let pending: string[] = []
  try { pending = await pendingFiles() } catch { pending = [] }
  const selected = pending.filter((p) => pathInGroup(p, group) && markers.some((m) => p.includes(m)))
  if (selected.length) return selected
  // Status unavailable/empty: best-effort constructed paths (matches the
  // `groups/<gid>/local/cribl/...` layout documented in the API examples).
  if (pending.length === 0) {
    return keys.map((k) => groupFile(group, k)).filter((f): f is string => f !== null)
  }
  return selected
}

async function ensureDataset(): Promise<StepResult> {
  const list = await capi('GET', datasetsPath)
  const items = (list.body as { items?: Array<{ id?: string }> })?.items || []
  if (items.some((d) => d.id === LAKE_DATASET_ID)) return { key: 'dataset', action: 'exists' }
  const r = await capi('POST', datasetsPath, DATASET_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'dataset', action: 'created' }
    : { key: 'dataset', action: 'error', detail: errText(r) }
}

async function ensureDestination(group: string): Promise<StepResult> {
  const cur = await capi('GET', g(group, `/system/outputs/${LAKE_DESTINATION_ID}`))
  if (cur.status === 200) return { key: 'destination', action: 'exists' }
  const r = await capi('POST', g(group, '/system/outputs'), DESTINATION_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'destination', action: 'created' }
    : { key: 'destination', action: 'error', detail: errText(r) }
}

async function ensurePipeline(group: string): Promise<StepResult> {
  const cur = await capi('GET', g(group, `/pipelines/${SYSLOG_PIPELINE_ID}`))
  if (cur.status === 200) {
    const r = await capi('PATCH', g(group, `/pipelines/${SYSLOG_PIPELINE_ID}`), PIPELINE_SPEC)
    return r.status === 200 ? { key: 'pipeline', action: 'updated' } : { key: 'pipeline', action: 'error', detail: errText(r) }
  }
  const r = await capi('POST', g(group, '/pipelines'), PIPELINE_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'pipeline', action: 'created' }
    : { key: 'pipeline', action: 'error', detail: errText(r) }
}

async function ensureSource(group: string): Promise<StepResult> {
  const cur = await capi('GET', g(group, `/system/inputs/${SYSLOG_SOURCE_ID}`))
  if (cur.status === 200) {
    const r = await capi('PATCH', g(group, `/system/inputs/${SYSLOG_SOURCE_ID}`), SOURCE_SPEC)
    return r.status === 200 ? { key: 'source', action: 'updated' } : { key: 'source', action: 'error', detail: errText(r) }
  }
  const r = await capi('POST', g(group, '/system/inputs'), SOURCE_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'source', action: 'created' }
    : { key: 'source', action: 'error', detail: errText(r) }
}

// --- The routing table ----------------------------------------------------
//
// A group has ONE routing table, and `PATCH /m/<group>/routes/<id>` replaces it
// wholesale — the array in the request body becomes the customer's routing
// order. That makes these the most dangerous few lines in the app, so they are
// written as an edit of the table that was just read, never as a table composed
// from our spec plus "everything else".

/** The routing table as the leader returns it. `comments` and `groups` (Route
 *  Groups) ride along in the same object, so the index signature is not
 *  defensive padding: sending back `{ id, routes }` alone would delete them. */
interface RoutingTable {
  id: string
  routes: Array<Record<string, unknown>>
  [field: string]: unknown
}

async function readRoutes(group: string): Promise<RoutingTable | null> {
  const cur = await capi('GET', g(group, '/routes'))
  const obj = (cur.body as { items?: RoutingTable[] })?.items?.[0]
  return obj && Array.isArray(obj.routes) ? obj : null
}

/** Our route, by either of the two fields it can be identified by. */
const isOurRoute = (r: Record<string, unknown>) => r.id === SYSLOG_ROUTE_ID || r.name === SYSLOG_ROUTE_ID

/**
 * Where a NEW route goes: directly above the catch-all. Cribl's table ends with
 * a `default` route that matches everything, and a route below a final
 * match-everything route never sees an event. This returns an insertion point
 * and nothing else — every existing route keeps the index the customer gave it.
 */
function insertionIndex(routes: Array<Record<string, unknown>>): number {
  const named = routes.findIndex((r) => r.id === 'default' || r.name === 'default')
  if (named !== -1) return named
  // No route called `default`: whatever matches unconditionally is the catch-all
  // in practice, whatever it is called. Failing that, the end of the table.
  const unconditional = routes.findIndex((r) => r.filter === 'true' || r.filter === true)
  return unconditional === -1 ? routes.length : unconditional
}

/** True when the live entry already says everything ROUTE_SPEC says. Compared
 *  field by field rather than wholesale, because a live route carries fields we
 *  never set — `groupId` when somebody filed it into a Route Group, say — and
 *  those are not ours to notice or to remove. */
function routeMatchesSpec(live: Record<string, unknown>): boolean {
  return Object.entries(ROUTE_SPEC).every(([k, v]) => JSON.stringify(live[k]) === JSON.stringify(v))
}

/**
 * Add our route when it is missing; leave it exactly where it is when it is not.
 *
 * Position is configuration. An earlier version of this rebuilt the table as
 * `[ours, ...theirs]` on every run, so re-applying an already-installed stack
 * silently moved our route to the top of somebody's table — and a re-apply is a
 * button this tab offers. Now: present and already correct is a no-op (not even
 * a PATCH, so the group's Git status stays clean); present and stale is patched
 * in place at its own index; absent is a single splice above the catch-all.
 */
async function ensureRoute(group: string): Promise<StepResult> {
  const obj = await readRoutes(group)
  if (!obj) return { key: 'route', action: 'error', detail: 'routing table not found' }
  const at = obj.routes.findIndex(isOurRoute)
  if (at !== -1 && routeMatchesSpec(obj.routes[at])) return { key: 'route', action: 'exists' }

  const routes = obj.routes.slice()
  // Merge onto the live entry rather than replacing it, for the same reason
  // routeMatchesSpec compares field by field.
  if (at !== -1) routes[at] = { ...routes[at], ...ROUTE_SPEC }
  else routes.splice(insertionIndex(routes), 0, ROUTE_SPEC)

  const r = await capi('PATCH', g(group, `/routes/${obj.id}`), { ...obj, routes })
  if (r.status !== 200) return { key: 'route', action: 'error', detail: errText(r) }
  return { key: 'route', action: at !== -1 ? 'updated' : 'created' }
}

// --- Deploy ---------------------------------------------------------------

/**
 * Push a commit to a worker group's running workers.
 *
 * `PATCH /products/stream/groups/{id}/deploy` is the current path.
 * `PATCH /master/groups/{id}/deploy` does the same thing and is marked
 * deprecated in the 4.19.0 spec, but it is still the only one an older leader
 * answers, so it stays as a fallback — and ONLY on 404, which is the single
 * status that means "this leader does not have that route".
 *
 * Not on 403, which means this user may not deploy this group: retrying that
 * against a second path cannot grant permission, and the second 403 is the one
 * the user would end up reading. Not on 5xx either, and that one matters more —
 * a 5xx deploy may have started server-side, so a blind second attempt is a
 * second deploy. Both surface as they are.
 */
async function deployGroup(group: string, hash: string): Promise<ApiResp> {
  const body = { version: hash }
  const r = await capi('PATCH', `/products/stream/groups/${group}/deploy`, body)
  if (r.status !== 404) return r
  // A 404 is ambiguous here — an old leader without the path, or a group id that
  // does not exist. The fallback answers both: a missing group 404s again, and
  // that is what the caller reports.
  return capi('PATCH', `/master/groups/${group}/deploy`, body)
}

/** The commit a group's workers are actually running, or null when it cannot be
 *  read — which is not the same as "none", and is never reported as one. */
async function deployedVersion(group: string): Promise<string | null> {
  let r = await capi('GET', `/products/stream/groups/${group}`)
  if (r.status === 404) r = await capi('GET', `/master/groups/${group}`)
  if (r.status !== 200) return null
  const items = (r.body as { items?: Array<{ id?: string; configVersion?: string }> })?.items || []
  const rec = items.find((it) => it.id === group) ?? items[0]
  const v = rec?.configVersion
  return typeof v === 'string' && v ? v : null
}

/** The newest commit in the leader's config repo, or null. */
async function headCommit(): Promise<string | null> {
  const r = await capi('GET', '/version?limit=5')
  if (r.status !== 200) return null
  const items = (r.body as { items?: Array<{ hash?: string; refs?: string }> })?.items || []
  // The history comes back newest-first, but a deploy is not something to bet on
  // an undocumented ordering: the newest commit is the one carrying
  // `HEAD -> <branch>` in its refs. Take that one, and fall back to the first
  // only when nothing says so. Getting this backwards would deploy an old commit
  // to a live group, which is a rollback nobody asked for.
  const head = items.find((c) => typeof c.refs === 'string' && c.refs.includes('HEAD')) ?? items[0]
  const hash = head?.hash
  return typeof hash === 'string' && hash ? hash : null
}

/** Config file paths that changed since `commit`, or null when the answer is
 *  unavailable — again, not the same as "none". */
async function filesChangedSince(commit: string): Promise<string[] | null> {
  const r = await capi('GET', `/version/files?commit=${encodeURIComponent(commit)}`)
  if (r.status !== 200) return null
  const groups = (r.body as { items?: Array<{ items?: Array<{ name?: string; path?: string }> }> })?.items
  if (!Array.isArray(groups)) return null
  const names: string[] = []
  // Two levels: one entry per commit range, each holding the files it touched.
  // `name` is what this endpoint calls the path; `/version/status` calls the same
  // thing `path`, so both are read rather than assumed.
  for (const entry of groups) {
    for (const f of entry.items || []) {
      const n = f.name ?? f.path
      if (typeof n === 'string') names.push(n)
    }
  }
  return names
}

/**
 * The hash of a commit this group has NOT deployed, or null when there is none.
 *
 * This exists because of a hole that used to be unrecoverable: a run whose
 * commit succeeded and whose deploy failed left config committed and never
 * running. The next run found no pending files, reported "already up to date"
 * and returned — so the app could never deploy that commit again, and the only
 * way out was the Cribl UI.
 *
 * Read-only: three GETs and no writes, so it is safe to ask on a status check.
 *
 * "Could not tell" answers null, exactly like "nothing pending". Offering to
 * deploy something that might not exist is worse than not offering, and the
 * whole point of the offer is that the user can trust it.
 */
export async function pendingDeploy(group: string = DEFAULT_STREAM_GROUP): Promise<string | null> {
  const [deployed, head] = await Promise.all([deployedVersion(group), headCommit()])
  if (!deployed || !head || deployed === head) return null
  // The config repo is shared by every group, so a newer HEAD on its own only
  // says that SOMEBODY committed something. Ask which files moved since the
  // commit this group is running, and claim a pending deploy only when one of
  // them belongs to this group — otherwise every commit anywhere on the leader
  // would light this up.
  const changed = await filesChangedSince(deployed)
  if (changed === null) return head // endpoint unavailable: fall back to the coarse signal
  if (!changed.some((p) => pathInGroup(p, group))) return null
  return head
}

/** Deploy one commit and report it as a step. Shared by the normal path and by
 *  the retry of a commit an earlier run stranded. */
async function deployHash(
  group: string,
  hash: string,
  out: StepResult[],
  onStep: (r: StepResult) => void,
  onPhase: OnPhase,
  note = '',
): Promise<void> {
  onPhase({ kind: 'deploy', text: `Deploying to ${group}…` })
  const dep = await deployGroup(group, hash)
  if (dep.status >= 200 && dep.status < 300) {
    const r: StepResult = { key: 'deploy', action: 'created', detail: `${group} · ${hash.slice(0, 10)}${note}` }
    out.push(r); onStep(r); onPhase({ kind: 'done', text: `Deployed to ${group} ✓ (${hash.slice(0, 10)})` })
  } else {
    const r: StepResult = { key: 'deploy', action: 'error', detail: errText(dep) }
    out.push(r); onStep(r); onPhase({ kind: 'error', text: `Deploy failed — ${r.detail}` })
  }
}

/**
 * Nothing new to commit is not the same as nothing to do. Before reporting the
 * group up to date, ask whether an earlier run left a commit undeployed, and
 * deploy that instead. The user has already asked for a deploy and confirmed it;
 * this is that deploy finally happening, not a new one.
 */
async function deployStrandedCommit(
  group: string,
  out: StepResult[],
  onStep: (r: StepResult) => void,
  onPhase: OnPhase,
  upToDate: string,
): Promise<StepResult[]> {
  const stranded = await pendingDeploy(group)
  if (!stranded) {
    onPhase({ kind: 'done', text: upToDate })
    return out
  }

  // Only ever deploy a commit this app made. The config repo is shared, so an
  // undeployed commit on this group can just as easily be another admin's
  // half-finished work — and deploying it restarts the group's Worker
  // Processes and puts their change live, which nobody asked for and the
  // confirmation did not name. We know our own commits because Guided Setup
  // records every hash it creates; a hash we cannot vouch for is reported and
  // left alone.
  //
  // When the commit memory is empty — a fresh install, or a store that has
  // never been written — nothing is ours, so nothing is deployed. That is the
  // right default: silence is not consent.
  const mem = await loadCommitMemory()
  const ours = new Set(Object.values(mem[group] ?? {}).map((c) => c.hash))
  if (!ours.has(stranded)) {
    const r: StepResult = {
      key: 'deploy',
      action: 'exists',
      detail: `${group} has an undeployed commit (${stranded.slice(0, 8)}) this app did not make — left alone`,
    }
    out.push(r); onStep(r)
    onPhase({ kind: 'done', text: upToDate })
    return out
  }

  await deployHash(group, stranded, out, onStep, onPhase, ' · committed earlier, not deployed')
  return out
}

/**
 * Commit ONLY the given config files, then deploy that commit to the group.
 *
 * The Cribl commit API commits *all* pending changes when no `files` array is
 * given — so we always pass the explicit file list for the resources we touched,
 * leaving any unrelated pending changes in the group uncommitted and undeployed.
 * Reports a `commit` step and a `deploy` step (plus phase pop-ups) as it goes.
 *
 * Both of the two "nothing to commit" exits fall through to the stranded-commit
 * check rather than returning. They are the exact states an interrupted run
 * leaves behind, which is why they were where the commit got stuck.
 */
async function commitAndDeploy(
  message: string,
  group: string,
  files: string[],
  onStep: (r: StepResult) => void,
  onPhase: OnPhase,
): Promise<StepResult[]> {
  const out: StepResult[] = []

  if (files.length === 0) {
    const r: StepResult = { key: 'commit', action: 'exists', detail: 'no changes to commit' }
    out.push(r); onStep(r)
    return deployStrandedCommit(group, out, onStep, onPhase, 'Already up to date — nothing to deploy')
  }

  onPhase({ kind: 'commit', text: `Committing ${files.length} changed file${files.length === 1 ? '' : 's'}…` })
  const commit = await capi('POST', '/version/commit', { message, files })
  if (commit.status < 200 || commit.status >= 300) {
    const r: StepResult = { key: 'commit', action: 'error', detail: errText(commit) }
    out.push(r); onStep(r); onPhase({ kind: 'error', text: `Commit failed — ${r.detail}` })
    return out
  }
  const body = commit.body as { items?: Array<{ commit?: string }>; commit?: string }
  const hash = body?.items?.[0]?.commit || body?.commit
  if (!hash) {
    const r: StepResult = { key: 'commit', action: 'exists', detail: 'nothing to commit' }
    out.push(r); onStep(r)
    return deployStrandedCommit(group, out, onStep, onPhase, 'No net changes — nothing to deploy')
  }
  const cRes: StepResult = {
    key: 'commit', action: 'created',
    detail: `${files.length} file${files.length === 1 ? '' : 's'} · ${hash.slice(0, 10)}`,
    message, hash,
  }
  out.push(cRes); onStep(cRes)

  await deployHash(group, hash, out, onStep, onPhase)
  return out
}

/**
 * One entry in this app's own audit trail per completed run.
 *
 * These two actions are the only things the app does to customer configuration,
 * and the only record of them otherwise is a toast that is gone in four seconds
 * and a Git commit that does not say who pressed the button. `appendLog` stamps
 * the user and the time itself (cribl/kv.ts).
 *
 * Deliberately best-effort and not awaited: the trail answers false when the
 * store refuses it, and a lost trail entry must not turn a successful deploy
 * into a reported failure. What the user is told about is the deploy's own
 * outcome, which is in `steps` either way.
 *
 * Called from the end of a user-triggered run and from nowhere else — a trail
 * written on load or on a timer records nothing anybody did.
 */
function logRun(action: string, group: string, steps: StepResult[]): void {
  void appendLog('gigamon', {
    action,
    group,
    outcome: steps.some((s) => s.action === 'error') ? 'error' : 'ok',
    steps: steps.map((s) => `${s.key}:${s.action}`),
  })
}

/** Provision the whole stack in dependency order, reporting each step. */
export async function deployAll(
  onStep: (r: StepResult) => void,
  group: string = DEFAULT_STREAM_GROUP,
  onPhase: OnPhase = noopPhase,
): Promise<StepResult[]> {
  const out: StepResult[] = []
  // Dataset lives in Cribl Lake and is group-independent; the rest target the
  // chosen Stream worker group.
  const steps: Array<[ResourceKey, () => Promise<StepResult>]> = [
    ['dataset', ensureDataset],
    ['destination', () => ensureDestination(group)],
    ['pipeline', () => ensurePipeline(group)],
    ['source', () => ensureSource(group)],
    ['route', () => ensureRoute(group)],
  ]
  for (let i = 0; i < steps.length; i++) {
    const [key, fn] = steps[i]
    onPhase({ kind: 'provision', text: `Applying ${STEP_LABELS[key]}…` })
    const r = await fn()
    out.push(r)
    onStep(r)
    if (r.action === 'error') {
      onPhase({ kind: 'error', text: `${STEP_LABELS[key]} failed — ${r.detail ?? ''}` })
      // The remaining steps depend on the one that just failed — mark them
      // skipped (with the blocking step named) rather than leaving them a bare
      // "absent", and commit nothing.
      for (const [k2] of steps.slice(i + 1)) {
        const sk: StepResult = { key: k2, action: 'skipped', detail: `blocked by ${STEP_LABELS[key]}` }
        out.push(sk); onStep(sk)
      }
      // A run that failed part-way still created whatever came before the
      // failure, so it is exactly as worth recording as one that finished.
      logRun('syslog_stack.applied', group, out)
      return out
    }
  }
  // Only the resources we actually created/updated get committed — nothing else.
  const touchedKeys = out
    .filter((s) => (s.action === 'created' || s.action === 'updated') && groupFile(group, s.key as ResourceKey))
    .map((s) => s.key as ResourceKey)
  const files = await filesToCommit(group, touchedKeys)
  const cd = await commitAndDeploy(deployCommitMessage(group, out), group, files, onStep, onPhase)
  const all = [...out, ...cd]
  logRun('syslog_stack.applied', group, all)
  return all
}

/** Tear down the syslog stack (source, pipeline, route). Leaves the shared
 *  dataset and destination in place. */
export async function removeSyslogStack(
  onStep: (r: StepResult) => void,
  group: string = DEFAULT_STREAM_GROUP,
  onPhase: OnPhase = noopPhase,
  present?: Partial<SetupStatus>,
): Promise<StepResult[]> {
  const out: StepResult[] = []
  const touched: ResourceKey[] = []
  // When cleaning up a partial stack, only touch resources that actually exist —
  // if `present` was supplied, skip anything KNOWN to be absent so we don't issue
  // pointless deletes or report spurious failures. Without it, attempt all
  // (still 404-tolerant below). A resource whose state could not be read is
  // attempted rather than skipped: "I could not see it" is not "it is not there",
  // and the DELETE answers the question for real.
  const exists = (k: ResourceKey) => present?.[k] !== 'absent'

  // Route: remove our entry, keep the rest.
  if (exists('route')) {
    onPhase({ kind: 'provision', text: `Removing ${STEP_LABELS.route}…` })
    const obj = await readRoutes(group)
    if (obj) {
      // Drop our entry and nothing else: every other route keeps its index, and
      // the table's own `comments` / Route Groups ride back out with `...obj`.
      const kept = obj.routes.filter((x) => !isOurRoute(x))
      const removed = kept.length !== obj.routes.length
      if (removed) {
        const r = await capi('PATCH', g(group, `/routes/${obj.id}`), { ...obj, routes: kept })
        const res: StepResult = { key: 'route', action: r.status === 200 ? 'updated' : 'error', detail: r.status === 200 ? 'deleted' : errText(r) }
        out.push(res); onStep(res)
        if (r.status === 200) touched.push('route')
      }
    }
  }
  if (exists('source')) {
    onPhase({ kind: 'provision', text: `Removing ${STEP_LABELS.source}…` })
    const src = await capi('DELETE', g(group, `/system/inputs/${SYSLOG_SOURCE_ID}`))
    // 404 = already gone (racy partial cleanup) — not an error.
    const sres: StepResult = src.status === 404
      ? { key: 'source', action: 'exists', detail: 'not present' }
      : { key: 'source', action: src.status < 300 ? 'updated' : 'error', detail: src.status < 300 ? 'deleted' : errText(src) }
    out.push(sres); onStep(sres)
    if (src.status < 300) touched.push('source')
  }
  if (exists('pipeline')) {
    onPhase({ kind: 'provision', text: `Removing ${STEP_LABELS.pipeline}…` })
    const pipe = await capi('DELETE', g(group, `/pipelines/${SYSLOG_PIPELINE_ID}`))
    const pres: StepResult = pipe.status === 404
      ? { key: 'pipeline', action: 'exists', detail: 'not present' }
      : { key: 'pipeline', action: pipe.status < 300 ? 'updated' : 'error', detail: pipe.status < 300 ? 'deleted' : errText(pipe) }
    out.push(pres); onStep(pres)
    if (pipe.status < 300) touched.push('pipeline')
  }
  // Commit only the files whose resources we actually removed — matched against
  // the real Git status (deletions/modifications show up there too).
  const files = await filesToCommit(group, touched)
  const cd = await commitAndDeploy(removeCommitMessage(group, touched), group, files, onStep, onPhase)
  const all = [...out, ...cd]
  logRun('syslog_stack.removed', group, all)
  return all
}

/** Best-effort Syslog ingress endpoint to point Gigamon AMX at. The worker
 *  ingress host differs from the UI origin; on Cribl.Cloud it is typically
 *  `default.main.<org>.cribl.cloud`. Returns null when it can't be derived. */
export function suggestedSyslogHost(): string | null {
  if (typeof window === 'undefined') return null
  const origin = window.__CRIBL_SEARCH_ORIGIN || window.location.origin
  try {
    const host = new URL(origin).hostname // e.g. main-<org>.cribl.cloud
    if (host.startsWith('main-')) return `default.main.${host.slice('main-'.length)}`
    return host
  } catch {
    return null
  }
}
