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
//
// ── CHANGED IN PHASE 3 (2026-09-17), AND WHY IT IS TWO CHANGES ──────────────
//
// FIRST, A DEFECT. `ensurePipeline` and `ensureSource` used to PATCH
// unconditionally whenever their GET answered 200 — so pressing Re-apply on a
// stack that was already exactly right issued two writes, reported both as
// `updated`, put both into `touchedKeys`, and carried the run on into
// `commitAndDeploy`. `ensureRoute` never did that: it compares field by field
// and returns `exists` with no PATCH at all, "so the group's Git status stays
// clean". Whether the zero-change re-apply actually reached the deploy depends
// on whether Cribl dirties a config file for an identical-body PATCH, which this
// repo cannot settle and a live Leader can (see filesToCommit's fallback at
// `/version/status`) — but a deploy restarts that group's Worker Processes, so
// the answer only decides how bad it was. Both functions now get the
// `ensureRoute` treatment, through one shared comparison (`covered`) used by all
// four objects.
//
// SECOND, A SEAM. Every ensure* takes a `confirm` and writes nothing before it
// answers true. That is NOT because nothing confirmed before — components/
// ProvisionPanel.tsx has opened a <ConfirmDialog> in front of `deployAll` since
// slice 1.7. It is because that dialog can only name the objects; it cannot say
// what is about to change about them, since the only code holding both the live
// object and the spec is down here. `confirm` is where a caller can be handed
// that diff at the moment it is known. It is optional, and the default is named
// `preConfirmed` rather than left implicit, so "no confirm was passed" is a claim
// somebody wrote down instead of an absence — see that constant.
//
// The corollary is the reason the no-op fix and the seam arrived together: a
// confirmation that fires for a change that is not happening teaches people to
// click through confirmations.
//
// ── AND A THIRD CHANGE (2026-09-17): THE PATCHES WERE NOT MERGES ────────────
//
// The pipeline and source PATCHes sent the SPEC, and both endpoints are full
// replacements — "Cribl removes any omitted fields", in openapi.json's own
// words. A Re-apply that found one spec field drifted therefore deleted every
// field the spec does not name, and `covered` guaranteed the confirmation could
// not mention them. That is a SHIPPED defect: Phase 1 wrote it, 1.0.20 has it,
// Phase 3 only narrowed the window. Both now merge onto the object they just
// read, the way `ensureRoute` always did — see the long comment above
// `mergeSpec`.

import { isDenial } from './authz'
import { capi, errText, groupPath, type ApiResp } from './capi'
import { STREAM_GROUP } from './config'
import { appendLog } from './kv'
import {
  DEFAULT_PROFILE, datasetSpec, destinationSpec, sameDiff,
  type DiffRow, type LandingProfile,
} from './landing'
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

// --- The two Cribl Lake specs, from a profile rather than from literals ------
//
// §2.4 asks for `datasetSpec(profile)` and `destinationSpec(profile)`. Both are
// in cribl/landing.ts, not here, and the direction is forced rather than chosen:
// landing.ts is the pure module — no `capi`, no `kv`, testable under plain Node —
// so it cannot import this file, and this file can import it. What that buys is
// ONE copy of the numbers. Before it, the flush settings existed twice: once
// below and once in landing.ts's `nearLive` preset, and landing.test.ts could
// only assert them by naming this file's line number in a comment, because there
// was nothing exported to compare against. Two copies of a number with a comment
// between them is the shape of a drift that has already happened elsewhere.
//
// The cost, stated because it is real: this module now reaches the query layer
// transitively (landing.ts → queries/lakeLanding.ts → cribl/search.ts) for three
// values. That is weight on a provisioning client, and it was accepted over a
// second hand-written copy of the same two bodies.

/**
 * The Cribl Lake dataset Guided Setup creates. `datasetSpec` already carries
 * `id`, so for this object the spec IS the create body.
 */
export const DATASET_SPEC = datasetSpec(DEFAULT_PROFILE)

/**
 * The Cribl Lake destination body for a profile.
 *
 * `destinationSpec` answers an EDIT — `{ set, remove }` — because its other
 * caller is patching an object that already exists and needs to say which keys
 * to take away. A create has nothing to take away and needs two keys the edit
 * has no business carrying: `id`, which is the object's name, and `type`, which
 * is what kind of destination to make. Neither is a setting, which is why they
 * are added here rather than pushed into the shared spec.
 */
export function destinationSpecFor(profile: LandingProfile): Record<string, unknown> {
  return { id: LAKE_DESTINATION_ID, type: 'cribl_lake', ...destinationSpec(profile).set }
}

/**
 * The destination this release provisions. EXPORTED IN PHASE 3, where
 * `DATASET_SPEC` always was: an unexported spec is one nothing outside this file
 * can check, and the Lake landing panel's whole job is to report what a live
 * destination says against what this app would have written.
 *
 * `DEFAULT_PROFILE` is JSON / 30 days / 5 MB · 60 s · 15 s — byte for byte what
 * this file held as a literal before Phase 3. Phase 3 changes no landing; it
 * makes the landing nameable.
 */
export const DESTINATION_SPEC = destinationSpecFor(DEFAULT_PROFILE)

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

// --- What a caller is asked before anything is written --------------------

/** One object about to be written, described in the terms a confirmation needs. */
export interface PendingChange {
  key: ResourceKey
  /** `create` when Cribl does not have this object; `overwrite` when it does and
   *  it does not already say what the spec says. There is no third case — an
   *  object that already matches is never offered, because a confirmation for a
   *  change that is not happening is how people learn to click through them. */
  action: 'create' | 'overwrite'
  /** The Cribl object, phrased the way the commit message and the dialog phrase
   *  it, so one sentence describes it everywhere. */
  object: string
  /**
   * On an `overwrite`, the spec keys the live object does not already satisfy —
   * `before` is what Cribl holds, `after` is what this app will send. Empty on a
   * `create`, where there is no before.
   *
   * This is the thing the existing confirmation could not say. It is `DiffRow`,
   * the same shape components/DiffTable.tsx renders for the Lake landing panel,
   * so a caller that wants to show it does not need a second renderer.
   */
  diff: readonly DiffRow[]
}

/** Ask before writing. Anything but `true` — `false`, a rejection, a dialog that
 *  unmounted — is a no. */
export type ConfirmChange = (change: PendingChange) => boolean | Promise<boolean>

/**
 * The answer when a caller passes no `confirm`, named rather than inlined so
 * that what it stands for is written down.
 *
 * It stands for the <ConfirmDialog> in components/ProvisionPanel.tsx, which is in
 * front of every path that reaches `deployAll` and names all five objects with
 * `action: 'replace'`. That dialog is coarser than this seam — it cannot show a
 * diff, because at the moment it opens nothing has read the live objects — but it
 * is a real confirmation, and §1.5 rule 7 is explicit that one intent gets one
 * confirmation. Threading five dialogs through a single Deploy press would make
 * the fifth one furniture.
 *
 * So the default is "already asked", not "do not ask". If `deployAll` ever
 * acquires a caller that has NOT asked, this is the line that is wrong, and it
 * says so here rather than in a review comment.
 */
const preConfirmed: ConfirmChange = () => true

/** What an ensure* answers when the confirmation said no. The only way any of
 *  them returns `skipped`, which is what lets `deployAll` tell a refusal from a
 *  failure without a sixth `StepAction`. */
const NOT_CONFIRMED = 'not applied — this change was not confirmed'

async function agreed(confirm: ConfirmChange, change: PendingChange): Promise<boolean> {
  try {
    return (await confirm(change)) === true
  } catch {
    return false
  }
}

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
 * another group's pending changes.
 *
 * `null` means THE READ FAILED — `capi` answers `{status, body}` rather than
 * throwing, so a 403 or a 500 arrives here with an empty body and used to be
 * indistinguishable from a clean tree. An empty ARRAY is a clean tree. Every
 * caller decides which it wants, and one of them puts the answer in front of a
 * person.
 */
async function pendingFiles(): Promise<string[] | null> {
  const r = await capi('GET', '/version/status')
  if (r.status < 200 || r.status >= 300) return null
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
  // A failed read and a clean tree both fall back to constructed paths here, as
  // they always have: this decides what to SEND, and the commit itself answers
  // "nothing to commit" when the guess was wrong. The caller that has to tell a
  // person keeps the two apart — see `pendingConfigPaths`.
  try { pending = (await pendingFiles()) ?? [] } catch { pending = [] }
  const selected = pending.filter((p) => pathInGroup(p, group) && markers.some((m) => p.includes(m)))
  if (selected.length) return selected
  // Status unavailable/empty: best-effort constructed paths (matches the
  // `groups/<gid>/local/cribl/...` layout documented in the API examples).
  if (pending.length === 0) {
    return keys.map((k) => groupFile(group, k)).filter((f): f is string => f !== null)
  }
  return selected
}

/**
 * The Git paths a Guided Setup commit in this group can carry, and what else is
 * uncommitted beside them — the two things its confirmation has to say.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `pendingFiles()` has been in this module since Phase 1 and the Guided Setup
 * dialog never surfaced it. So that dialog said "Nothing else in ${group} is
 * touched, including the demo DataGen source" — true of what this app WRITES
 * (`ensureSource` PATCHes one object, `ensureRoute` splices one entry) and
 * false of what the commit CARRIES. `POST /version/commit` takes FILE PATHS
 * (openapi.json, GitCommitBody.files: "Array of file paths to include in the
 * commit"), and `inputs.yml` holds every source in the group INCLUDING the demo
 * DataGen one. Those are different sentences and the copy collapsed them into
 * one. This returns what the honest version needs.
 *
 * `carries` IS CONSTRUCTED, NOT READ, and deliberately: at the moment the
 * dialog opens nothing has been written, so no Git status can report the files
 * this run is about to dirty. It is the full set the run MAY commit — which
 * files it actually names is decided by `filesToCommit` afterwards, from the
 * status read taken after the writes.
 *
 * `alsoPending` IS READ, because it is the half the code can actually check,
 * and a warning that fires when nothing is pending is the one people learn to
 * click past. It is repo-wide minus `carries`, so it says what the commit
 * leaves alone. `null` means the status read gave nothing back — not "nothing
 * is pending" — and the copy has to say which.
 */
export interface CommitScope {
  /** Every file in this group a Guided Setup run can commit, whole. */
  carries: string[]
  /**
   * The paths Git ALREADY reports uncommitted among the files this run may
   * commit — somebody else's unfinished work, which this press commits and
   * deploys. The specific thing, checked, rather than a standing warning.
   */
  alreadyDirty: string[]
  /**
   * Uncommitted elsewhere on this Leader. The commit names its own paths, so
   * these are left where they are; worth saying only because the deploy that
   * follows moves the group to a commit rather than to a change.
   */
  elsewhere: string[]
  /** True when the Git status read answered nothing at all — "could not tell",
   *  not "nothing is pending", and the copy must not confuse the two. */
  unknown: boolean
}

/** Everything Cribl currently sees as uncommitted, anywhere in the repo, or
 *  null when the status read answered nothing — which is "could not tell", not
 *  "nothing is pending", and `commitScope` keeps the two apart. Read once per
 *  status check and split per dialog by `commitScope`, which is pure. */
export async function pendingConfigPaths(): Promise<string[] | null> {
  try {
    // An EMPTY LIST IS AN ANSWER: the read succeeded and the tree is clean.
    // This used to collapse `[]` into `null`, so on a healthy workspace — the
    // common case — both Guided Setup confirmations said "Cribl did not report
    // what is already uncommitted… Assume it may be", unconditionally. That is
    // the warning that always fires, which is the one people learn to click
    // past, and it made the dialog's one checkable claim uncheckable.
    return await pendingFiles()
  } catch {
    return null
  }
}

export function commitScope(group: string, keys: readonly ResourceKey[], pending: readonly string[] | null): CommitScope {
  const carries = keys.map((k) => groupFile(group, k)).filter((f): f is string => f !== null)
  if (pending === null) return { carries, alreadyDirty: [], elsewhere: [], unknown: true }
  const markers = keys.map(fileMarker).filter((m): m is string => m !== null)
  const mine = (p: string) => pathInGroup(p, group) && markers.some((m) => p.includes(m))
  return { carries, alreadyDirty: pending.filter(mine), elsewhere: pending.filter((p) => !mine(p)), unknown: false }
}

// --- What the write actually sends, and what it changes -------------------
//
// ── A SHIPPED DEFECT, FOUND 2026-09-17 ─────────────────────────────────────
//
// `PATCH /m/<group>/pipelines/<id>` and `PATCH /m/<group>/system/inputs/<id>`
// are FULL REPLACEMENTS. The 4.19.0 spec vendored in this repo (openapi.json)
// says so in as many words:
//
//   /pipelines/{id}       "Provide a complete representation of the Pipeline
//                          that you want to update in the request body. This
//                          endpoint does not support partial updates. Cribl
//                          removes any omitted fields when updating the
//                          Pipeline."
//
//   /system/inputs/{id}   "Provide a complete representation of the Source that
//                          you want to update in the request body. This endpoint
//                          does not support partial updates. Cribl removes any
//                          omitted fields when updating the Source."
//
// Until now both sites sent THE SPEC — two keys for the pipeline, eight for the
// source — so a Re-apply that found anything at all to change deleted every
// field nobody here had named: a customer's `tls` block, their `pq` /
// `pqEnabled` persistent queue, `maxActiveCxn`, `ipWhitelistRegex`, their
// QuickConnect `connections`, the source's and the pipeline's `description`, the
// pipeline's UI function `groups`. `ensureRoute` had this right from its first
// line — it PATCHes `{ ...obj, routes }`, an edit of the table it has just
// read, with a comment saying why — and these two did not. It shipped in
// Phase 1, it is in the installed app at 1.0.20, and Phase 3's no-op check only
// narrowed the window: the loss needs one spec field to differ AND the customer
// to have customised the object.
//
// So the write is now the live object with the spec asserted onto it, and the
// diff a confirmation shows is computed FROM THE BODY THAT WILL BE SENT rather
// than from the spec — because a dialog that names the spec's keys is describing
// a different request from the one that goes out.

/** A JSON object as opposed to an array or `null` — the only shape worth merging
 *  INTO rather than replacing. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Deep equality over the JSON these bodies are made of. Key order is not a
 *  difference; array order is. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => sameValue(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    return ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
  }
  return false
}

/**
 * `live` with `want` asserted onto it — the app's claims applied, everything
 * else carried forward.
 *
 * WHY IT RECURSES, i.e. why one level is not enough. `PIPELINE_SPEC.conf` is
 * `{ functions: [...] }`, but a live pipeline's `conf` also holds
 * `asyncFuncTimeout`, `output`, `streamtags`, `description` and the UI's
 * function `groups` (openapi.json, `Pipeline.conf`). A shallow `{ ...live,
 * ...spec }` replaces `conf` wholesale and deletes all five — the same shape
 * A-SP23 measured on a sibling endpoint, where a `schedule` sub-object was
 * replaced rather than merged and `tz` and `keepLastN` disappeared with no
 * error. The nesting is not special-cased to `conf`, because the next spec to
 * grow a sub-object would need the same treatment and would not get it.
 *
 * WHY EQUAL-LENGTH ARRAYS MERGE ELEMENT-WISE instead of being replaced. It keeps
 * this function exactly as strict as the subset test it replaces (`covered`,
 * Phase 3): `sameValue(live, mergeSpec(live, spec))` is true precisely when that
 * test said the spec was already satisfied, so the no-op Re-apply Phase 3 bought
 * is preserved to the letter. Replacing the array instead would count a key
 * Cribl normalised onto one of our functions as a difference and PATCH on every
 * Re-apply again. A LENGTH CHANGE still replaces: a function list with a fifth
 * function somebody added is a real change, and one this app is asserting away.
 *
 * KNOWN LIMIT, stated because nothing here can detect it: if somebody REORDERS
 * our functions, the positional merge overlays each spec function onto whichever
 * live function now sits at its index. Our four functions carry the same key
 * set, so the result is our function plus whatever extra keys the live entry at
 * that index had (`groupId`, say) — cosmetically wrong, not destructive, and it
 * shows up as a `conf` row in the diff the user approves.
 */
function mergeSpec(live: unknown, want: unknown): unknown {
  if (Array.isArray(want)) {
    if (!Array.isArray(live) || live.length !== want.length) return want
    return want.map((v, i) => mergeSpec(live[i], v))
  }
  if (isPlainObject(want)) {
    if (!isPlainObject(live)) return want
    const out: Record<string, unknown> = { ...live }
    for (const [k, v] of Object.entries(want)) out[k] = mergeSpec(live[k], v)
    return out
  }
  return want
}

/**
 * Keys read off a live object that must not be sent back.
 *
 * Reasoned the way cribl/landing.ts's `DATASET_READONLY_KEYS` comment reasons,
 * and the reasoning is the whole reason the list is this short: UNDER
 * FULL-REPLACEMENT SEMANTICS A STRIPPED KEY IS A DELETED KEY. So the only thing
 * that may go on this list is a key the spec states the server owns — never
 * "anything we don't recognise", which is how the defect above was written in
 * the first place.
 *
 * `criblSourceProvenance` is the single key openapi.json names outright, on
 * PATCH /system/inputs/{id}: "Cribl preserves `criblSourceProvenance` when you
 * omit it from the request body, and you cannot overwrite it through this
 * endpoint." Omitting it is therefore the only correct handling — it survives,
 * and sending it back is at best ignored.
 *
 * NOT ON THE LIST, and each is a judgement somebody may want to revisit:
 *   * `status` / `metrics`-shaped runtime fields. The `Input` schema declares
 *     none, and this repo has never seen one come back from this GET. If a
 *     leader does attach one, it will ride back out — noisy, and harmless,
 *     because a field the server computes it also recomputes.
 *   * `pq`, `connections`, `metadata`, `tls`. Customer configuration every one
 *     of them, and exactly what this change exists to carry forward.
 *   * The `__template_*` keys. They bind a field to a variable, so they are
 *     configuration, not derived state, and dropping one would unbind it.
 * The pipeline list is empty: `Pipeline` declares `id` and `conf` and nothing
 * the server owns.
 */
const SOURCE_SERVER_OWNED: readonly string[] = ['criblSourceProvenance']
const PIPELINE_SERVER_OWNED: readonly string[] = []

/** The complete representation a full-replacement PATCH has to carry: what Cribl
 *  just returned, minus the keys the server owns, with the spec asserted on. */
function patchBody(
  live: Record<string, unknown>,
  spec: Record<string, unknown>,
  serverOwned: readonly string[],
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...live }
  for (const k of serverOwned) delete base[k]
  return mergeSpec(base, spec) as Record<string, unknown>
}

/**
 * What the body about to be sent changes about the live object — the diff a
 * confirmation shows, and, when it is empty, the evidence that there is nothing
 * to write.
 *
 * COMPUTED FROM THE BODY, NOT FROM THE SPEC, which is the fix to the second half
 * of the defect above. The old version walked the spec's own keys and said so in
 * its doc comment, which meant the dialog was structurally incapable of
 * mentioning a customer's TLS block while the write deleted it. Now the two
 * cannot disagree: every key the request carries is compared against what Cribl
 * holds, so a row here is a change the request makes and a change the request
 * makes is a row here.
 *
 * Top-level keys only, still: `conf` reads as one row rather than as a walk of
 * every function's every field, and the object either side of the arrow is what
 * says which one. That is a presentation choice, not an omission — the `after`
 * side IS the sub-object being sent.
 *
 * THE ONE THING WRITTEN THAT DOES NOT APPEAR HERE: a key in `serverOwned` leaves
 * the body, and this walks the body, so it produces no row. That is deliberate
 * and it is honest — the spec says Cribl preserves `criblSourceProvenance` when
 * it is omitted, so nothing about the object changes and there is nothing to
 * show. If a key is ever added to those lists whose omission DOES change the
 * object, it belongs in the diff as a `removed` row and this function needs the
 * other half of the walk.
 */
function bodyDiff(live: Record<string, unknown>, body: Record<string, unknown>): DiffRow[] {
  const rows: DiffRow[] = []
  for (const [key, after] of Object.entries(body)) {
    if (!Object.hasOwn(live, key)) rows.push({ key, kind: 'added', before: undefined, after })
    else if (!sameValue(live[key], after)) rows.push({ key, kind: 'changed', before: live[key], after })
  }
  return rows
}

/** Why an update did not happen: Cribl answered 200 and this app could not find
 *  the object in the body. Under full-replacement semantics that is the one
 *  state in which writing is worse than not writing — a PATCH composed without
 *  the live object deletes everything it does not mention. Before Phase 3 this
 *  case sent the bare spec, which is the maximal version of the defect. */
const unreadable = (what: string) =>
  `not applied — Cribl answered 200 but this app could not read the live ${what}, ` +
  'and this endpoint replaces the whole object'

/** The one object a Cribl GET of a named resource answers with, or null when the
 *  body is not the `{ items: [ … ] }` this app knows how to read. */
function firstItem(r: ApiResp): Record<string, unknown> | null {
  const items = (r.body as { items?: unknown[] })?.items
  const first = Array.isArray(items) ? items[0] : undefined
  return first !== null && typeof first === 'object' ? (first as Record<string, unknown>) : null
}

/** What every ensure* below shares: the group, the landing to apply, and the
 *  question to ask before writing. */
interface EnsureCtx {
  group: string
  profile: LandingProfile
  confirm: ConfirmChange
}

const refused = (key: ResourceKey): StepResult => ({ key, action: 'skipped', detail: NOT_CONFIRMED })

// ── THE READ THAT COMPOSES A PATCH MUST BE TAKEN AFTER THE ANSWER ───────────
//
// READ THIS BEFORE WIRING `confirm` TO ANYTHING. Every ensure* below reads the
// live object, computes a body from it, asks `agreed(ctx.confirm, …)`, and then
// PATCHes. Until 2026-09-17 the body it sent was the one composed from the FIRST
// read — so the merge source was as old as the dialog had been on screen, and
// these endpoints are full replacements. A stale merge does not lose the race,
// it REVERTS whatever the other writer did; for `ensureRoute` that is the
// group's entire routing table.
//
// It was not exploitable, and the reason it was not is the hazard: the only
// caller (components/ProvisionPanel.tsx) passes no `confirm`, so `agreed` runs
// `preConfirmed`, which returns `true` synchronously with no await boundary a
// racer can use. The seam exists precisely so that a caller CAN pass a real
// dialog (see the header, and `preConfirmed`), and the first one to do it would
// have made this live — which is the stale-merge defect cribl/lakeLanding.ts
// spent two commits closing on the Lake writers.
//
// So it is closed by construction here instead: each ensure* re-reads after the
// answer and sends a body built on the SECOND read, refusing when the read fails
// and refusing when the change has moved. `preConfirmed` costs one extra GET per
// written object per run, which is the price of the seam being safe to wire.

/** Why nothing was sent when the read after the confirmation failed. There is
 *  NO fallback to the first read — that fallback IS the stale merge, arriving
 *  as a convenience on the workspace least able to tolerate it (the reasoning
 *  is written out at lakeLanding.ts's `destinationMergeSourceAfterConfirm`). */
const reReadFailed = (what: string) =>
  `not applied — ${what} could not be read again after that confirmation, and this endpoint replaces the whole object, ` +
  'so a write composed from the older read would delete whatever changed in between'

/** Why nothing was sent when the object moved under an open confirmation. A
 *  confirmation describes one before → after; if that is no longer the change,
 *  this one is void rather than stale, and nothing re-asks from a dialog the
 *  user has already dismissed. */
const diffMovedNote = (what: string, approved: readonly DiffRow[], now: readonly DiffRow[]) => {
  const say = (rows: readonly DiffRow[]) =>
    rows.length === 0 ? 'nothing' : rows.map((d) => `${d.key} (${JSON.stringify(d.before) ?? 'absent'} → ${JSON.stringify(d.after) ?? 'absent'})`).join(', ')
  return (
    `not applied — ${what} changed while that confirmation was open, and the change you approved is not the change that would now be ` +
    `applied. Approved: ${say(approved)}. Would now apply: ${say(now)}. Look at the object in Cribl and re-apply.`
  )
}

/**
 * The body to PATCH, composed from a read taken AFTER the answer — or the
 * reason nothing may be sent.
 *
 * The counterpart of lakeLanding.ts's `destinationMergeSourceAfterConfirm`, and
 * it refuses on the same three conditions for the same reasons: an unreadable
 * second read sends nothing, an empty second diff is a no-op rather than a
 * conflict (somebody applied exactly this while the dialog was open), and a diff
 * that moved voids the confirmation.
 *
 * ONLY THE DIFF IS COMPARED, not the body. A key this app has never heard of
 * that moved in between is carried forward rather than reverted, because the
 * body sent is built from the body that holds it — and nothing here has to guess
 * a list of server-derived keys whose movement is not a conflict.
 *
 * IT TAKES THE RESPONSE, NOT THE PATH. The second GET stays at each call site,
 * spelled exactly as the first one is, because cribl/policyCoverage.test.ts
 * resolves every `capi(...)` path statically and a path threaded through a
 * parameter is one it cannot read — an endpoint this app calls that no test can
 * check against config/policies.yml is how a 403 reaches a non-admin.
 */
function mergeSourceAfterConfirm(
  key: ResourceKey,
  again: ApiResp,
  what: string,
  spec: Record<string, unknown>,
  serverOwned: readonly string[],
  approved: readonly DiffRow[],
): { body: Record<string, unknown>; diff: DiffRow[] } | { stop: StepResult } {
  const live = again.status === 200 ? firstItem(again) : null
  if (!live) return { stop: { key, action: 'error', detail: reReadFailed(what) } }
  const body = patchBody(live, spec, serverOwned)
  const now = bodyDiff(live, body)
  if (now.length === 0) return { stop: { key, action: 'exists', detail: 'nothing left to change — it was applied while that confirmation was open' } }
  if (!sameDiff(approved, now)) return { stop: { key, action: 'error', detail: diffMovedNote(what, approved, now) } }
  return { body, diff: now }
}

/**
 * The Lake dataset: created when absent, and never edited from here.
 *
 * NOT PARAMETERISED INTO A PATCH, deliberately. Retention and description on a
 * live dataset are the Lake landing panel's to change (cribl/lakeLanding.ts), one
 * field at a time, each behind a confirmation that can state what a retention
 * DECREASE deletes. A provisioning re-apply that quietly reset retention to this
 * spec's 30 days would be that irreversible write with no dialog in front of it.
 */
async function ensureDataset(ctx: EnsureCtx): Promise<StepResult> {
  const list = await capi('GET', datasetsPath)
  const items = (list.body as { items?: Array<{ id?: string }> })?.items || []
  if (items.some((d) => d.id === LAKE_DATASET_ID)) return { key: 'dataset', action: 'exists' }

  const spec = datasetSpec(ctx.profile)
  if (!(await agreed(ctx.confirm, { key: 'dataset', action: 'create', object: RESOURCE_PHRASE.dataset, diff: [] }))) {
    return refused('dataset')
  }
  const r = await capi('POST', datasetsPath, spec)
  return r.status >= 200 && r.status < 300
    ? { key: 'dataset', action: 'created' }
    : { key: 'dataset', action: 'error', detail: errText(r) }
}

/**
 * The Lake destination: created when absent, and never edited from here either,
 * for a second reason on top of the dataset's.
 *
 * LEFT_BEHIND in cribl/paths.ts records that this app cannot prove it made this
 * object — it is named after the dataset rather than after this app, it already
 * exists on many tenants, and anything else in the customer's config may route
 * through it. Phase 3 does edit it, from the Lake landing panel, as a
 * read-modify-write behind a confirmation that shows the exact before→after,
 * names every feed writing through it and commits the result. A provisioning
 * re-apply cannot do any of that, so it does not write here at all.
 */
async function ensureDestination(ctx: EnsureCtx): Promise<StepResult> {
  const cur = await capi('GET', g(ctx.group, `/system/outputs/${LAKE_DESTINATION_ID}`))
  if (cur.status === 200) return { key: 'destination', action: 'exists' }

  const spec = destinationSpecFor(ctx.profile)
  if (!(await agreed(ctx.confirm, { key: 'destination', action: 'create', object: RESOURCE_PHRASE.destination, diff: [] }))) {
    return refused('destination')
  }
  const r = await capi('POST', g(ctx.group, '/system/outputs'), spec)
  return r.status >= 200 && r.status < 300
    ? { key: 'destination', action: 'created' }
    : { key: 'destination', action: 'error', detail: errText(r) }
}

async function ensurePipeline(ctx: EnsureCtx): Promise<StepResult> {
  const cur = await capi('GET', g(ctx.group, `/pipelines/${SYSLOG_PIPELINE_ID}`))
  if (cur.status === 200) {
    // openapi.json, PATCH /pipelines/{id} (Cribl 4.19.0, read 2026-09-17):
    // "Provide a complete representation of the Pipeline that you want to update
    //  in the request body. This endpoint does not support partial updates.
    //  Cribl removes any omitted fields when updating the Pipeline."
    // So this PATCHes the object it just read with PIPELINE_SPEC asserted onto
    // it, the way ensureRoute has always edited the table it just read. Sending
    // PIPELINE_SPEC itself — `{ id, conf }` — deleted the pipeline's
    // `description` and its UI function `groups`, and replaced the whole `conf`.
    const live = firstItem(cur)
    // No live body, no merge, no write. See `unreadable`.
    if (!live) return { key: 'pipeline', action: 'error', detail: unreadable('pipeline') }
    const body = patchBody(live, PIPELINE_SPEC, PIPELINE_SERVER_OWNED)
    // Present and already correct is a no-op — not even a PATCH, so the group's
    // Git status stays clean and a re-apply of a settled stack cannot reach the
    // deploy that restarts its Worker Processes.
    const diff = bodyDiff(live, body)
    if (diff.length === 0) return { key: 'pipeline', action: 'exists' }
    if (!(await agreed(ctx.confirm, { key: 'pipeline', action: 'overwrite', object: RESOURCE_PHRASE.pipeline, diff }))) {
      return refused('pipeline')
    }
    // `body` above filled the dialog and is NOT what is sent — see
    // `mergeSourceAfterConfirm`, and read its header before wiring `confirm`.
    const merge = mergeSourceAfterConfirm(
      'pipeline', await capi('GET', g(ctx.group, `/pipelines/${SYSLOG_PIPELINE_ID}`)), `pipeline ${SYSLOG_PIPELINE_ID}`,
      PIPELINE_SPEC, PIPELINE_SERVER_OWNED, diff,
    )
    if ('stop' in merge) return merge.stop
    const r = await capi('PATCH', g(ctx.group, `/pipelines/${SYSLOG_PIPELINE_ID}`), merge.body)
    return r.status === 200
      ? { key: 'pipeline', action: 'updated', detail: merge.diff.map((d) => d.key).join(', ') }
      : { key: 'pipeline', action: 'error', detail: errText(r) }
  }
  if (!(await agreed(ctx.confirm, { key: 'pipeline', action: 'create', object: RESOURCE_PHRASE.pipeline, diff: [] }))) {
    return refused('pipeline')
  }
  const r = await capi('POST', g(ctx.group, '/pipelines'), PIPELINE_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'pipeline', action: 'created' }
    : { key: 'pipeline', action: 'error', detail: errText(r) }
}

async function ensureSource(ctx: EnsureCtx): Promise<StepResult> {
  const cur = await capi('GET', g(ctx.group, `/system/inputs/${SYSLOG_SOURCE_ID}`))
  if (cur.status === 200) {
    // openapi.json, PATCH /system/inputs/{id} (Cribl 4.19.0, read 2026-09-17):
    // "Provide a complete representation of the Source that you want to update
    //  in the request body. This endpoint does not support partial updates.
    //  Cribl removes any omitted fields when updating the Source."
    // SOURCE_SPEC is eight keys and a live syslog source has forty (openapi.json
    // `InputSyslog`), so sending the spec deleted the customer's `tls`, their
    // persistent queue, `maxActiveCxn`, `connections` and `description` — and
    // `covered` guaranteed the confirmation could not name any of them. Merge
    // onto what we just read, exactly as ensureRoute does.
    const live = firstItem(cur)
    if (!live) return { key: 'source', action: 'error', detail: unreadable('Syslog source') }
    const body = patchBody(live, SOURCE_SPEC, SOURCE_SERVER_OWNED)
    const diff = bodyDiff(live, body)
    if (diff.length === 0) return { key: 'source', action: 'exists' }
    if (!(await agreed(ctx.confirm, { key: 'source', action: 'overwrite', object: RESOURCE_PHRASE.source, diff }))) {
      return refused('source')
    }
    // `body` above filled the dialog and is NOT what is sent — see
    // `mergeSourceAfterConfirm`, and read its header before wiring `confirm`.
    const merge = mergeSourceAfterConfirm(
      'source', await capi('GET', g(ctx.group, `/system/inputs/${SYSLOG_SOURCE_ID}`)), `Syslog source ${SYSLOG_SOURCE_ID}`,
      SOURCE_SPEC, SOURCE_SERVER_OWNED, diff,
    )
    if ('stop' in merge) return merge.stop
    const r = await capi('PATCH', g(ctx.group, `/system/inputs/${SYSLOG_SOURCE_ID}`), merge.body)
    return r.status === 200
      ? { key: 'source', action: 'updated', detail: merge.diff.map((d) => d.key).join(', ') }
      : { key: 'source', action: 'error', detail: errText(r) }
  }
  if (!(await agreed(ctx.confirm, { key: 'source', action: 'create', object: RESOURCE_PHRASE.source, diff: [] }))) {
    return refused('source')
  }
  const r = await capi('POST', g(ctx.group, '/system/inputs'), SOURCE_SPEC)
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
async function ensureRoute(ctx: EnsureCtx): Promise<StepResult> {
  const obj = await readRoutes(ctx.group)
  if (!obj) return { key: 'route', action: 'error', detail: 'routing table not found' }
  const at = obj.routes.findIndex(isOurRoute)
  // The entry this run would send: the live one with ROUTE_SPEC asserted onto
  // it, so fields we never set — `groupId`, when somebody filed the route into a
  // Route Group — carry forward. This is the merge the pipeline and the source
  // did not have until now; it is the same `mergeSpec` for all three, and the
  // diff below is read off it rather than off the spec.
  const merged = at !== -1 ? (mergeSpec(obj.routes[at], ROUTE_SPEC) as Record<string, unknown>) : null
  const diff = merged ? bodyDiff(obj.routes[at], merged) : []
  if (at !== -1 && diff.length === 0) return { key: 'route', action: 'exists' }

  if (!(await agreed(ctx.confirm, {
    key: 'route',
    action: at !== -1 ? 'overwrite' : 'create',
    object: RESOURCE_PHRASE.route,
    diff,
  }))) {
    return refused('route')
  }

  // ── THE TABLE THAT IS SENT IS THE TABLE READ AFTER THE ANSWER ─────────────
  //
  // `obj` above filled the dialog and is NOT what is sent. This PATCH replaces
  // the group's ENTIRE routing table, so a table read before a user-paced
  // confirmation reverts every route another admin added, reordered or deleted
  // while that dialog was open — the worst instance of the hazard written out
  // at `mergeSourceAfterConfirm`, because one request carries every route in
  // the group rather than one object. Read that header before wiring `confirm`.
  const what = `route ${SYSLOG_ROUTE_ID} in ${ctx.group}`
  const fresh = await readRoutes(ctx.group)
  if (!fresh) return { key: 'route', action: 'error', detail: reReadFailed(`the routing table of ${ctx.group}`) }
  const freshAt = fresh.routes.findIndex(isOurRoute)
  if ((freshAt !== -1) !== (at !== -1)) {
    // The approved ACTION moved, not just its diff: our route appeared or
    // disappeared while the dialog was open, so "add it above the catch-all"
    // and "correct it where it sits" are no longer the same press.
    return {
      key: 'route',
      action: 'error',
      detail:
        `not applied — ${what} was ${at !== -1 ? 'removed from' : 'added to'} the routing table while that confirmation was open, so the ` +
        'change you approved is not the change that would now be applied. Look at the routing table in Cribl and re-apply.',
    }
  }
  const freshMerged = freshAt !== -1 ? (mergeSpec(fresh.routes[freshAt], ROUTE_SPEC) as Record<string, unknown>) : null
  const freshDiff = freshMerged ? bodyDiff(fresh.routes[freshAt], freshMerged) : []
  if (freshAt !== -1) {
    if (freshDiff.length === 0) {
      return { key: 'route', action: 'exists', detail: 'nothing left to change — it was applied while that confirmation was open' }
    }
    if (!sameDiff(diff, freshDiff)) return { key: 'route', action: 'error', detail: diffMovedNote(what, diff, freshDiff) }
  }

  const routes = fresh.routes.slice()
  // The merged entry, which is what the diff above described — merged onto the
  // second read, so a field somebody else set on our route in the meantime is
  // carried forward rather than reverted.
  if (freshMerged) routes[freshAt] = freshMerged
  else routes.splice(insertionIndex(routes), 0, ROUTE_SPEC)

  const r = await capi('PATCH', g(ctx.group, `/routes/${fresh.id}`), { ...fresh, routes })
  if (r.status !== 200) return { key: 'route', action: 'error', detail: errText(r) }
  return { key: 'route', action: freshAt !== -1 ? 'updated' : 'created' }
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
 * ── TWO QUESTIONS, NOT ONE ─────────────────────────────────────────────────
 *
 * "Is there a commit this group has not deployed at all?" and "can we prove it
 * touches this group?" are different questions, and the two callers below need
 * different ones. Collapsing them broke one of the two, in both directions:
 * answering the first for both put a repo-wide HEAD in front of a user as a
 * commit "committed to ${group}"; answering the second for both left the
 * stranded-commit repair dead in exactly the failure mode it exists for.
 *
 * `undeployedRange` is the shared read — the group's running commit and the
 * Leader's HEAD, or null when they match or either is unreadable.
 */
async function undeployedRange(group: string): Promise<{ deployed: string; head: string } | null> {
  const [deployed, head] = await Promise.all([deployedVersion(group), headCommit()])
  if (!deployed || !head || deployed === head) return null
  return { deployed, head }
}

/**
 * IS THERE A COMMIT AT ALL that this group is not running — the Leader's HEAD,
 * or null.
 *
 * This is what `deployStrandedCommit` needs, and it deliberately asks for NO
 * group evidence. It exists because of a hole that used to be unrecoverable: a
 * run whose commit succeeded and whose deploy failed left config committed and
 * never running. The next run found no pending files, reported "already up to
 * date" and returned — so the app could never deploy that commit again, and the
 * only way out was the Cribl UI.
 *
 * The safety here is NOT the file list. It is the commit memory: the repair
 * deploys only a hash this app recorded making, and refuses everything else. A
 * `/version/files` read that answers 403 is exactly the kind of half-working
 * Leader a run gets interrupted on, so requiring it before repairing would turn
 * the recovery off in the case it was built for.
 */
export async function undeployedHead(group: string = DEFAULT_STREAM_GROUP): Promise<string | null> {
  return (await undeployedRange(group))?.head ?? null
}

/**
 * CAN WE PROVE IT TOUCHES THIS GROUP — the hash of a commit this group has not
 * deployed AND that moved a file belonging to it, or null.
 *
 * This is what the screen needs. `ProvisionPanel` renders it as "commit #X
 * touches ${group} and has not been deployed to it" and offers a deploy that
 * restarts that group's Worker Processes, so a claim derived from a signal that
 * cannot distinguish this group from any other is not good enough. "Could not
 * tell" answers null, exactly like "nothing pending".
 *
 * Read-only: three GETs and no writes, so it is safe to ask on a status check.
 */
export async function pendingDeploy(group: string = DEFAULT_STREAM_GROUP): Promise<string | null> {
  const range = await undeployedRange(group)
  if (!range) return null
  // The config repo is shared by every group, so a newer HEAD on its own only
  // says that SOMEBODY committed something. Ask which files moved since the
  // commit this group is running, and claim a pending deploy only when one of
  // them belongs to this group — otherwise every commit anywhere on the leader
  // would light this up.
  const changed = await filesChangedSince(range.deployed)
  // Endpoint unavailable: no group evidence, so no claim.
  if (changed === null) return null
  if (!changed.some((p) => pathInGroup(p, group))) return null
  return range.head
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
  // `undeployedHead`, not `pendingDeploy`: this asks "is there a commit at all",
  // because the ownership check below is the safety, not the file list. Asking
  // for group evidence here made the repair fail whenever `/version/files` was
  // unavailable — a half-working Leader being the very thing that strands a
  // commit in the first place.
  const stranded = await undeployedHead(group)
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
  //
  // AND THE OWNERSHIP CHECK IS ON THE HASH, NOT ON THE RANGE. `PATCH …/deploy`
  // takes a VERSION: it moves the group to this commit, so every commit anybody
  // made between the group's deployed `configVersion` and this hash goes live
  // with it. Knowing we made the LAST commit is not knowing what is in the
  // range, and no file list can narrow a deploy. There is nothing to fix in
  // code — the app cannot un-commit somebody else's work — so the dialog says
  // it instead: DEPLOY_CONSEQUENCES in cribl/landing.ts, third sentence, which
  // is on every deploy confirmation in the app.
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

/** What a caller may say about a run. Both have defaults that reproduce exactly
 *  what this function did before Phase 3. */
export interface DeployOptions {
  /** Asked once per object that is actually about to be written. See
   *  `preConfirmed` for what passing nothing means. */
  confirm?: ConfirmChange
  /**
   * The landing to provision. Nothing passes one today, and `DEFAULT_PROFILE` is
   * byte-for-byte the stack this app has always created.
   *
   * It is a parameter rather than a constant because §2.4's whole point is that
   * the landing is a choice somebody can make — but note what this release will
   * and will not do with it: a profile only reaches Cribl through a CREATE here,
   * so a profile naming Parquet or partitions describes a dataset this phase can
   * bring into existence and cannot migrate an existing one to. The format
   * migration is Phase 4's, behind P-S1 and P-S5, and the partitions editor is
   * behind P-S9.
   */
  profile?: LandingProfile
}

/** Provision the whole stack in dependency order, reporting each step. */
export async function deployAll(
  onStep: (r: StepResult) => void,
  group: string = DEFAULT_STREAM_GROUP,
  onPhase: OnPhase = noopPhase,
  opts: DeployOptions = {},
): Promise<StepResult[]> {
  const out: StepResult[] = []
  const ctx: EnsureCtx = { group, profile: opts.profile ?? DEFAULT_PROFILE, confirm: opts.confirm ?? preConfirmed }
  // Dataset lives in Cribl Lake and is group-independent; the rest target the
  // chosen Stream worker group.
  const steps: Array<[ResourceKey, () => Promise<StepResult>]> = [
    ['dataset', () => ensureDataset(ctx)],
    ['destination', () => ensureDestination(ctx)],
    ['pipeline', () => ensurePipeline(ctx)],
    ['source', () => ensureSource(ctx)],
    ['route', () => ensureRoute(ctx)],
  ]
  for (let i = 0; i < steps.length; i++) {
    const [key, fn] = steps[i]
    onPhase({ kind: 'provision', text: `Applying ${STEP_LABELS[key]}…` })
    const r = await fn()
    out.push(r)
    onStep(r)
    // A refusal and a failure stop the run the same way and for the same reason —
    // the four steps below each depend on the ones above — but they are not the
    // same event, and reporting "failed" for an answer somebody gave on purpose
    // is how a dialog stops being believed. `skipped` from an ensure* means the
    // confirmation said no and nothing else does (see NOT_CONFIRMED).
    if (r.action === 'error' || r.action === 'skipped') {
      const stopped = r.action === 'error'
      onPhase(
        stopped
          ? { kind: 'error', text: `${STEP_LABELS[key]} failed — ${r.detail ?? ''}` }
          : { kind: 'done', text: `${STEP_LABELS[key]} was not confirmed — stopped there.` },
      )
      // The remaining steps depend on the one that just stopped — mark them
      // skipped (with the blocking step named) rather than leaving them a bare
      // "absent", and commit nothing.
      const because = stopped ? `blocked by ${STEP_LABELS[key]}` : `not reached — ${STEP_LABELS[key]} was not confirmed`
      for (const [k2] of steps.slice(i + 1)) {
        const sk: StepResult = { key: k2, action: 'skipped', detail: because }
        out.push(sk); onStep(sk)
      }
      // A run that stopped part-way still created whatever came before, so it is
      // exactly as worth recording as one that finished.
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
