// Guided Setup's worker-group client: the reads, and the commit-and-deploy
// machinery every Guided Setup write shares.
//
// ── WHAT THIS FILE NO LONGER DOES ───────────────────────────────────────────
//
// It used to CREATE the global Raw HTTP onboarding stack (`deployAll`, until
// 2026-09-25, when the owner collapsed that onboarding into the pack's), and
// then — until 2026-09-26 — to read and REMOVE it, and the Syslog stack before
// it, from a Guided Setup panel of their own. Owner decision 2026-09-26: new
// installs never have those global stacks, so the app no longer shows them or
// removes them. A tenant that ran an earlier release keeps whatever of them is
// still in its worker group, orphaned; Cribl Stream is where to delete it. The
// onboarding pack (cribl/packClient.ts, cribl/onboarding/run.ts) is the only
// way this app onboards. The specs the global stack was created from live on
// in cribl/packSpecs.ts, where pack.test.ts holds the pack's YAML equal to them.
//
// ── WHAT IT DOES ────────────────────────────────────────────────────────────
//
//   * `ensureLakeDataset` — the one Lake dataset POST in the app: created when
//     absent, never edited. Its only caller is the onboarding run.
//   * `commitMatchingAndDeploy` — commit exactly the files a run touched,
//     re-read Git to refuse a commit that left one behind, and deploy; with the
//     stranded-commit repair that deploys only a hash this app recorded. The
//     pack client ends here.
//   * `pendingDeploy`, `undeployedHead`, `deployState`, `pendingConfigPaths`,
//     `commitScopeFor` — reads that let every confirmation say what its commit
//     carries, and the cutover preflight refuse on doubt.
//   * `portProblem`, `suggestPort`, `hostingOf`, `groupInputs`, `generateToken`,
//     `scrubbedErrText` — used by the pack's source settings.
//
// Every write here is behind a confirmation in a component (the pack's, in
// components/OnboardingPanel.tsx). Nothing here runs on load, render or a timer.
//
// Calls go through cribl/capi.ts, which is where the auth story lives: the
// platform proxy (installed) and the Vite `/capi` proxy (`npm run dev`) both
// inject it, so nothing here handles a token.

import { capi, errText, type ApiResp } from './capi'
import { STREAM_GROUP } from './config'
import { DEFAULT_PROFILE, datasetSpec, pathFilterRows } from './landing'
import { listInputs, listPackInputs, type StreamInput } from './lake'
import { PACK_PARQUET_DATASET_ID } from './pack'
import { loadCommitMemory } from './setupMemory'

/** The global Cribl Lake destination the Lake landing panel edits, where a
 *  group has one. Nothing in this release creates it. */
export const LAKE_DESTINATION_ID = 'gigamon_lake'
export const LAKE_DATASET_ID = 'gigamon_ami'

/** The only ports a Cribl-managed (Cribl.Cloud) worker group exposes for a
 *  source. A hybrid group's workers are the customer's, so any port works there. */
export const CLOUD_PORT_RANGE = Object.freeze({ min: 20000, max: 20010 })
/** Where a hybrid group's picker starts: Cribl's own default for a Raw HTTP
 *  source. A suggestion, checked against the group's other sources like any
 *  other port. */
export const HYBRID_DEFAULT_PORT = 10080
const LAKE_ID = 'default'


/**
 * A fresh auth token for the source: 32 random bytes from the platform CSPRNG
 * (256 bits), hex-encoded. It exists in exactly two places afterwards — the
 * source's own `authTokensExt`, and the endpoint card that shows it once. It is
 * never written to the KV store, a log, a toast, a step result or the audit
 * trail; provision.test.ts holds each of those still.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Keeping a secret out of an error message ────────────────────────────────
//
// An error detail reaches the step log on screen and the error toast. Cribl's
// refusal can quote the body it refused, and two things made a plain
// `errText(r).split(token)` miss the token:
//
//   * `errText` CUTS a body with no `message`/`error` to 200 characters. The cut
//     can fall inside the token, and the half that is left no longer matches the
//     whole token, so nothing was replaced. Hence: scrub the BODY, before
//     anything shortens it.
//   * Cribl can cut the token itself ("token 3fa9…c1 is not accepted"). Hence:
//     any run of MIN_SECRET_SLICE or more characters of a secret is masked, not
//     only the whole secret.

/** The shortest piece of a secret that is masked on its own. Twelve hex
 *  characters is 48 bits: long enough that an accidental match in ordinary
 *  error text is not a concern, short enough that a useful fragment is not left. */
const MIN_SECRET_SLICE = 12
const MASK = '<token>'

/** `text` with every run of MIN_SECRET_SLICE+ characters of `secret` masked,
 *  longest first, so the longest leak is the one replaced. */
function maskSecret(text: string, secret: string): string {
  if (!secret) return text
  if (secret.length < MIN_SECRET_SLICE) return secret.length >= 4 ? text.split(secret).join(MASK) : text
  let out = text
  for (let len = secret.length; len >= MIN_SECRET_SLICE; len--) {
    for (let i = 0; i + len <= secret.length; i++) {
      const slice = secret.slice(i, i + len)
      if (out.includes(slice)) out = out.split(slice).join(MASK)
    }
  }
  return out
}

/** Every string anywhere in `v` with the secrets masked. */
function scrubValue(v: unknown, secrets: readonly string[]): unknown {
  if (typeof v === 'string') return secrets.reduce(maskSecret, v)
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, secrets))
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubValue(x, secrets)]))
  }
  return v
}

/** `errText`, with `secrets` taken out of the body BEFORE it is shortened, and
 *  out of the sentence it makes. The one way an error about a source reaches
 *  the screen. */
export function scrubbedErrText(r: ApiResp, secrets: readonly string[]): string {
  const live = secrets.filter((x) => typeof x === 'string' && x.length > 0)
  return scrubValue(errText({ ...r, body: scrubValue(r.body, live) }), live) as string
}

/** The auth tokens a live source body holds — `authTokensExt[].token` and the
 *  older `authTokens[]` — so an error about that source can be scrubbed of them. */
export function tokensOf(source: Record<string, unknown> | null | undefined): string[] {
  if (!source) return []
  const ext = Array.isArray(source.authTokensExt) ? source.authTokensExt : []
  const old = Array.isArray(source.authTokens) ? source.authTokens : []
  return [
    ...ext.map((t) => (t && typeof t === 'object' ? (t as { token?: unknown }).token : undefined)),
    ...old.map((t) => (t && typeof t === 'object' ? (t as { token?: unknown }).token : t)),
  ].filter((t): t is string => typeof t === 'string' && t.length > 0)
}


/**
 * Why a port cannot be used for the new source, or null when it can.
 *
 * `used` is every port another source in the group already listens on; null
 * means that list could not be read, which is refused rather than guessed —
 * two sources on one port is a bind failure on every worker in the group.
 */
export function portProblem(port: number, managed: boolean, used: readonly number[] | null): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter a whole number between 1 and 65535.'
  if (managed && (port < CLOUD_PORT_RANGE.min || port > CLOUD_PORT_RANGE.max)) {
    return `A Cribl-managed worker group only exposes ports ${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max}.`
  }
  // A port below 1024 needs root to bind, and Cribl's workers normally run as
  // a non-root user: the source would be created, committed and deployed, and
  // then never start.
  if (!managed && port < 1024) return 'Pick 1024 or above: a port below 1024 needs root, and a worker running as a normal user cannot open it.'
  if (used === null) {
    return 'This app could not read every port this group’s sources listen on (including sources inside packs, and ports set from a variable), so it cannot check that this port is free.'
  }
  if (used.includes(port)) return `Another source in this group already listens on ${port}.`
  return null
}

/** The port the picker offers first: the lowest free one in the managed range,
 *  or the first free one from the hybrid default up. Null when none is free. */
export function suggestPort(managed: boolean, used: readonly number[] | null): number | null {
  const taken = used ?? []
  const [from, to] = managed ? [CLOUD_PORT_RANGE.min, CLOUD_PORT_RANGE.max] : [HYBRID_DEFAULT_PORT, 65535]
  for (let p = from; p <= to; p++) if (!taken.includes(p)) return p
  return null
}

// --- The Lake datasets the onboarding run creates ---------------------------

/**
 * The `gigamon_ami` Cribl Lake dataset, as its create body. Built from
 * landing.ts's `datasetSpec(DEFAULT_PROFILE)`, the pure module, so the numbers
 * exist once. `datasetSpec` already carries `id`, so for this object the spec
 * IS the create body. The onboarding run (onboarding/plan.ts
 * `onboardingDatasets`) creates it through `ensureLakeDataset`.
 */
export const DATASET_SPEC = datasetSpec(DEFAULT_PROFILE)

/**
 * The Cribl Lake dataset the onboarding pack's Parquet destination writes to
 * (pack.ts `PACK_PARQUET_DATASET_ID`), as its create body.
 *
 * CREATED BY THE ONBOARDING RUN (onboarding/run.ts, step 1b), through
 * `ensureLakeDataset` — created when absent and never edited — with the
 * retention onboarding/plan.ts `parquetDatasetSpec` gives it. A pack cannot hold
 * a dataset, so the app must. The run does NOT refuse to start the HTTP source
 * when this step fails (design, owner-approved: "continue, with a warning"):
 * the pack's routes ship enabled, so the Parquet destination then drops
 * (`onBackpressure: drop`) every copy with no signal, and gigamon_ami keeps
 * flowing — which is what the drop exists to protect. The step log says the
 * dataset was not created.
 *
 * NO PARTITIONS, AND THE KEY IS ABSENT rather than `[]`: `acceleratedFields` is
 * honoured only when a dataset is created, so this body is the whole of that
 * decision (pack.ts `PACK_DECISIONS.parquet_partitions`). The other settings
 * are gigamon_ami's own defaults: its retention, and the v2 reader. The reader
 * gets the Parquet row alone, since this dataset has never held a JSON object.
 * Not built with `datasetSpec`: that is gigamon_ami's body, whose Parquet case
 * keeps a JSON row for the history written before a conversion.
 */
export const PARQUET_DATASET_SPEC = Object.freeze({
  id: PACK_PARQUET_DATASET_ID,
  description: 'Gigamon Application Metadata Intelligence (AMI) flow records, Parquet copy',
  retentionPeriodInDays: DEFAULT_PROFILE.retentionDays,
  format: 'parquet' as const,
  searchConfig: Object.freeze({
    searchVersion: 'v2' as const,
    pathFilters: Object.freeze(pathFilterRows(['parquet']).map((r) => Object.freeze(r))),
  }),
})

// --- Addressing -----------------------------------------------------------

// Cribl Lake is group-independent, so its datasets are not under a group.
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

/**
 * What a status check can honestly say about one object.
 *
 * `unreadable` is the state a boolean has nowhere to put. A GET the platform
 * refuses answers neither "there" nor "not there"; read as `false`, the screen
 * would positively tell somebody who could not SEE an object that it did not
 * exist. The pack client's reads and the cutover preflight use it.
 */
export type ResourceState = 'present' | 'absent' | 'unreadable'

// --- What a step reports ---------------------------------------------------

export type StepAction = 'created' | 'updated' | 'exists' | 'error' | 'skipped'
export type StepKey = 'commit' | 'deploy'
export interface StepResult {
  key: StepKey
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

/** The pending paths that belong to `group` and match one of `markers` — the
 *  one test every commit in this module scopes by, whatever made the change. */
function matching(pending: readonly string[], group: string, markers: readonly string[]): string[] {
  return pending.filter((p) => pathInGroup(p, group) && markers.some((m) => p.includes(m)))
}

/** True when a pending path belongs to the target group. Named groups carry a
 *  `groups/<group>/` segment; a group-rooted layout has no `groups/<x>/` at all.
 *  Exported for the cutover preflight (cribl/cutoverPreflight.ts), which lists
 *  every pending file of the group rather than one run's. */
export function pathInGroup(path: string, group: string): boolean {
  if (path.includes(`groups/${group}/`)) return true
  return !path.includes('groups/')
}

/**
 * The files a commit names: the pending paths in `group` that match one of
 * `markers`, or — only when Git reported nothing at all — `constructed`, the
 * paths a known layout says the change landed in. The onboarding pack client
 * (cribl/packClient.ts) passes its pack directory's markers.
 */
async function filesToCommitFor(group: string, markers: readonly string[], constructed: readonly string[]): Promise<string[]> {
  if (markers.length === 0) return []
  let pending: string[] = []
  // A failed read and a clean tree both fall back to constructed paths here, as
  // they always have: this decides what to SEND, and the commit itself answers
  // "nothing to commit" when the guess was wrong. The caller that has to tell a
  // person keeps the two apart — see `pendingConfigPaths`.
  try { pending = (await pendingFiles()) ?? [] } catch { pending = [] }
  const selected = matching(pending, group, markers)
  if (selected.length) return selected
  // Status unavailable/empty: best-effort constructed paths (matches the
  // `groups/<gid>/local/cribl/...` layout documented in the API examples).
  if (pending.length === 0) return [...constructed]
  return selected
}

/**
 * The Git paths a Guided Setup commit in this group can carry, and what else is
 * uncommitted beside them — the two things its confirmation has to say.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `pendingFiles()` has been in this module since Phase 1 and the Guided Setup
 * dialog never surfaced it. So that dialog said "Nothing else in ${group} is
 * touched, including the demo DataGen source" — true of what this app WROTE
 * (the retired Raw HTTP deploy PATCHed one source and spliced one route entry)
 * and false of what the commit CARRIED. `POST /version/commit` takes FILE PATHS
 * (openapi.json, GitCommitBody.files: "Array of file paths to include in the
 * commit"), and `inputs.yml` holds every source in the group INCLUDING the demo
 * DataGen one. Those are different sentences and the copy collapsed them into
 * one. This returns what the honest version needs.
 *
 * `carries` IS CONSTRUCTED, NOT READ, and deliberately: at the moment the
 * dialog opens nothing has been written, so no Git status can report the files
 * this run is about to dirty. It is the full set the run MAY commit — which
 * files it actually names is decided by `filesToCommitFor` afterwards, from the
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
 *  "nothing is pending", and `commitScopeFor` keeps the two apart. Read once per
 *  status check and split per dialog by `commitScopeFor`, which is pure. */
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

/** What a commit over `markers` carries in `group`, and what else is pending
 *  beside it (`CommitScope`) — the onboarding pack's scope is its directories
 *  (cribl/packClient.ts `packCommitScope`). */
export function commitScopeFor(
  group: string,
  carries: readonly string[],
  markers: readonly string[],
  pending: readonly string[] | null,
): CommitScope {
  if (pending === null) return { carries: [...carries], alreadyDirty: [], elsewhere: [], unknown: true }
  const mine = new Set(matching(pending, group, markers))
  return { carries: [...carries], alreadyDirty: [...mine], elsewhere: pending.filter((p) => !mine.has(p)), unknown: false }
}

/** A JSON object as opposed to an array or `null` — the only shape worth merging
 *  INTO rather than replacing. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Deep equality over the JSON these bodies are made of. Key order is not a
 *  difference; array order is. */
export function sameValue(a: unknown, b: unknown): boolean {
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
 * Keys read off a live object that must not be sent back.
 *
 * Reasoned the way cribl/landing.ts's `DATASET_READONLY_KEYS` comment reasons,
 * and the reasoning is the whole reason the list is this short: UNDER
 * FULL-REPLACEMENT SEMANTICS A STRIPPED KEY IS A DELETED KEY. So the only thing
 * that may go on this list is a key the spec states the server owns — never
 * "anything we don't recognise": a whole-body PATCH that drops a key deletes
 * it. Used by the pack client's source writes (cribl/packClient.ts).
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
 *     of them, and exactly what a whole-body PATCH has to carry forward.
 *   * The `__template_*` keys. They bind a field to a variable, so they are
 *     configuration, not derived state, and dropping one would unbind it.
 */
export const SOURCE_SERVER_OWNED: readonly string[] = ['criblSourceProvenance']

/** The one object a Cribl GET of a named resource answers with, or null when the
 *  body is not the `{ items: [ … ] }` this app knows how to read. */
export function firstItem(r: ApiResp): Record<string, unknown> | null {
  const items = (r.body as { items?: unknown[] })?.items
  const first = Array.isArray(items) ? items[0] : undefined
  return first !== null && typeof first === 'object' ? (first as Record<string, unknown>) : null
}

/** A Lake dataset's create body: `id` plus whatever else Cribl Lake takes. */
export interface LakeDatasetSpec {
  readonly id: string
  readonly format?: string
  readonly acceleratedFields?: readonly string[]
  readonly [key: string]: unknown
}

/** What `ensureLakeDataset` did. Never carries a PATCH: it has none. */
export interface LakeDatasetStep {
  id: string
  action: 'created' | 'exists' | 'skipped' | 'error'
  detail?: string
  /**
   * On `exists`: how the live dataset differs from the spec in the two
   * settings that are FIXED AT CREATION (format and partitions), one phrase
   * each. Absent when nothing does. Reported, never corrected — a PATCH of
   * either answers 200 and changes nothing (measured 2026-09-21).
   */
  differs?: string[]
}

const partitionWords = (v: unknown): string =>
  Array.isArray(v) && v.length > 0 ? v.map(String).join(', ') : 'none'

/**
 * A Cribl Lake dataset: CREATED WHEN ABSENT, AND NEVER EDITED. The onboarding
 * run calls it with `gigamon_ami`'s spec, the Parquet copy's and — when sample
 * data is ticked — the sample dataset's. *(Until 2026-09-25 Guided Setup's Raw
 * HTTP deploy was a second caller, for `gigamon_ami`.)*
 *
 * NO PATCH, ON PURPOSE. Retention and description on a live dataset are the
 * Lake landing panel's to change (cribl/lakeLanding.ts), each behind a
 * confirmation that can state what a retention DECREASE deletes; a re-run that
 * quietly reset them to a spec would be that irreversible write with no dialog.
 * Format and partitions are fixed at creation, so a live dataset whose format
 * or partitions differ from the spec is reported (`differs`) and left alone.
 *
 * A LISTING IT COULD NOT READ WRITES NOTHING. The function this generalises
 * read a refused listing as an empty one and POSTed; "could not tell" is never
 * "absent".
 *
 * `confirm`, when given, is asked after the read and before the POST, and a no
 * is `skipped` with nothing sent.
 */
export async function ensureLakeDataset(
  spec: LakeDatasetSpec,
  opts: { confirm?: () => Promise<boolean> } = {},
): Promise<LakeDatasetStep> {
  const list = await capi('GET', datasetsPath)
  const items = list.status === 200 ? (list.body as { items?: unknown })?.items : undefined
  if (!Array.isArray(items)) {
    return { id: spec.id, action: 'error', detail: `the Cribl Lake dataset list could not be read (HTTP ${list.status}), so nothing was created` }
  }
  const live = items.find((d) => d && typeof d === 'object' && (d as { id?: unknown }).id === spec.id) as Record<string, unknown> | undefined
  if (live) {
    const differs: string[] = []
    const want = spec.format ?? 'json'
    if (typeof live.format === 'string' && live.format !== want) differs.push(`format ${live.format}, not ${want}`)
    const has = partitionWords(live.acceleratedFields)
    const wants = partitionWords(spec.acceleratedFields)
    if (has !== wants) differs.push(`partitions ${has}, not ${wants}`)
    return differs.length ? { id: spec.id, action: 'exists', differs } : { id: spec.id, action: 'exists' }
  }
  if (opts.confirm && !(await opts.confirm())) return { id: spec.id, action: 'skipped' }
  const r = await capi('POST', datasetsPath, spec)
  return r.status >= 200 && r.status < 300 ? { id: spec.id, action: 'created' } : { id: spec.id, action: 'error', detail: errText(r) }
}

/** Every port the group's sources already listen on, or null when one of them
 *  has a port this app cannot read — "cannot tell", which is never "free". */
export function portsInUse(inputs: readonly StreamInput[]): number[] | null {
  if (inputs.some((i) => i.portUnknown)) return null
  return [...new Set(inputs.flatMap((i) => i.ports))]
}

/** One of the group's sources, and the pack it is in (null for the group's own). */
export type GroupInput = StreamInput & { pack: string | null }

/**
 * Every source in the group: its own, and those inside each installed pack.
 * Null when any part could not be read — the free-port check (packClient.ts
 * `portsOfOthers`) would otherwise answer "free" about a port it never saw.
 */
export async function groupInputs(group: string): Promise<GroupInput[] | null> {
  const [own, packed] = await Promise.all([listInputs(group), listPackInputs(group)])
  if (own.outcome !== 'ok' || packed.outcome !== 'ok') return null
  return [...(own.value ?? []).map((i) => ({ ...i, pack: null })), ...(packed.value ?? [])]
}

// ── How the picked group is hosted ──────────────────────────────────────────

/** Where this Leader answers, or null when this page cannot tell. Installed,
 *  `CRIBL_API_URL` is absolute (AGENTS.md); in `npm run dev` the Vite proxy
 *  injects the Cribl origin as `__CRIBL_SEARCH_ORIGIN`. */
export function leaderHostname(): string | null {
  if (typeof window === 'undefined') return null
  for (const candidate of [window.CRIBL_API_URL, window.__CRIBL_SEARCH_ORIGIN]) {
    if (typeof candidate !== 'string' || !candidate) continue
    try {
      return new URL(candidate).hostname || null
    } catch {
      // A relative base names no host; try the next.
    }
  }
  return null
}

/** True for a Cribl.Cloud Leader. */
export const isCriblCloudHost = (host: string | null): boolean =>
  !!host && /(^|\.)cribl(-[a-z0-9]+)?\.cloud$/i.test(host)

/**
 * Managed, hybrid, or "cannot tell" — which decides TLS and the port range.
 *
 * MANAGED ONLY WHEN BOTH SAY SO: the group record's `onPrem` is explicitly
 * false AND this Leader is Cribl.Cloud. A self-hosted Leader's group records
 * carry no `onPrem`; reading that absence as "Cribl-managed" held its source
 * to 20000–20010 and pointed it at `$CRIBL_CLOUD_CRT`, a certificate that does
 * not exist there, so the source never started. Hybrid is `onPrem === true`.
 * Anything else is null, and the screen blocks creating a source until it can
 * tell.
 */
export function hostingOf(onPrem: boolean | null | undefined, host: string | null): 'managed' | 'hybrid' | null {
  if (onPrem === true) return 'hybrid'
  if (onPrem === false && isCriblCloudHost(host)) return 'managed'
  return null
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

/**
 * Whether two commit hashes name the same commit. The group record's
 * `configVersion` is Git's ABBREVIATED hash — measured 2026-09-26 on a
 * Cribl.Cloud Leader: `default` ran `e4396f3` while `/version` named HEAD
 * `e4396f3c8d3bd766c54d04ee944d02b10c05c83f` — so an exact comparison read a
 * group that runs HEAD as behind it. A prefix of at least 7 hex characters
 * (Git's shortest default abbreviation) matches; a shorter one matches only an
 * identical hash.
 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a.toLowerCase() === b.toLowerCase()) return true
  const [short, long] = a.length <= b.length ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()]
  return short.length >= 7 && long.startsWith(short)
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

/**
 * How many commits one `/version` read asks for. The query string is not part
 * of the grant (`policyCoverage.test.ts` compares the path before the `?`), so
 * the request is built from this constant rather than spelling it again.
 */
export const HISTORY_PAGE = 50

/**
 * How many pages `pendingDeploy` will read looking for the commit a group is
 * running — two hundred commits. Past that it answers "could not tell", which
 * is null: a status check that pages through a whole repo's history to decorate
 * a row is not a status check.
 */
export const HISTORY_PAGES = 4

/**
 * How many `/version/files` reads `pendingDeploy` keeps in flight. One at a time
 * held the status rows behind forty GETs in a row for a group forty commits
 * behind; all at once is fifty requests at a Leader from one status check.
 */
export const FILES_READ_CONCURRENCY = 6

interface CommitRef { hash: string; refs: string }

/** One page of the leader's config-repo history, or null when unreadable. */
async function commitHistory(offset = 0): Promise<CommitRef[] | null> {
  // `offset` is not optional, whatever the spec says: `limit` without it is a
  // 400 on 4.20.1 ("missing 'offset' parameter", measured 2026-09-23). Without
  // it this always answered null, which silently disabled `undeployedHead`,
  // `pendingDeploy` and the stranded-commit recovery built on them.
  const r = await capi('GET', `/version?offset=${offset}&limit=${HISTORY_PAGE}`)
  if (r.status !== 200) return null
  const items = (r.body as { items?: Array<{ hash?: unknown; refs?: unknown }> })?.items
  if (!Array.isArray(items)) return null
  return items
    .filter((c) => typeof c?.hash === 'string' && c.hash !== '')
    .map((c) => ({ hash: c.hash as string, refs: typeof c.refs === 'string' ? c.refs : '' }))
}

/**
 * The local HEAD in a `git log --decorate` refs string: `HEAD -> main`, or a
 * bare `HEAD` when detached. Not any ref that CONTAINS the word — a Leader with
 * a Git remote decorates an older commit with `origin/HEAD`, and a tag may be
 * called anything; either one, taken as HEAD, names the wrong commit.
 */
const LOCAL_HEAD = /(?:^|,\s*)HEAD(?:\s*->|\s*,|\s*$)/

/** Where the Leader's HEAD sits in a history page, or -1 for an empty page. */
function headIndex(items: CommitRef[]): number {
  // The history comes back newest-first, but a deploy is not something to bet on
  // an undocumented ordering: the newest commit is the one carrying
  // `HEAD -> <branch>` in its refs. Take that one, and fall back to the first
  // only when nothing says so. Getting this backwards would deploy an old commit
  // to a live group, which is a rollback nobody asked for.
  const i = items.findIndex((c) => LOCAL_HEAD.test(c.refs))
  return i >= 0 ? i : items.length ? 0 : -1
}

/**
 * The paths a `GET /version/files` body names, or null when it cannot be read —
 * which is not the same as "no files".
 *
 * TWO SHAPES. The app was written against a flat list — `{ items: [{ items:
 * [{ name: 'groups/…/route.yml' }] }] }` — and on 2026-09-24 a 4.20.x
 * Cribl.Cloud Leader answered with a NESTED TREE instead: one node per path
 * segment, `children` on directories, `state` on files. Read flat, that tree is
 * the single path `groups`, which `pathInGroup` counts as a repo-wide file and
 * so as belonging to EVERY group. Both are walked here; a node's `name` (or
 * `path`, which is what `/version/status` calls it) is joined onto its parent's.
 */
export function versionFilePaths(body: unknown): string[] | null {
  const entries = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(entries)) return null
  type Node = { name?: unknown; path?: unknown; children?: unknown }
  const out: string[] = []
  const walk = (node: Node, prefix: string) => {
    const seg = typeof node?.name === 'string' ? node.name : typeof node?.path === 'string' ? node.path : ''
    if (seg === '') return
    const full = prefix ? `${prefix}/${seg}` : seg
    // A directory: its files are its children's. An empty one names nothing —
    // Git does not track directories.
    if (Array.isArray(node.children)) {
      for (const c of node.children as Node[]) walk(c, full)
      return
    }
    out.push(full)
  }
  // One entry per answer — it carries `count` and, on the tree shape, the
  // commit's own `commitMessage` — each holding the top-level nodes. An entry
  // that says it holds files and yields none is a shape this walk does not
  // know, and "cannot read" is null, not an empty commit.
  for (const entry of entries as Array<{ items?: unknown; count?: unknown }>) {
    const before = out.length
    if (Array.isArray(entry?.items)) for (const n of entry.items as Node[]) walk(n, '')
    if (typeof entry?.count === 'number' && entry.count > 0 && out.length === before) return null
  }
  return out
}

/**
 * The config file paths ONE commit changed, or null when unavailable.
 *
 * NOT "changed since". The spec calls this endpoint "files that changed since a
 * commit", and this file used to believe it. Measured read-only on 2026-09-24:
 * `/version/files?commit=506d36a` answered only `groups/default/local/cribl/
 * inputs.yml` — exactly the one file `/version/show` diffs for that commit —
 * although later commits changed `outputs.yml`; every answer carries that
 * commit's own `commitMessage`; and asked of the deployed commit, it described
 * what the group was already running. The range is the caller's to walk.
 */
async function filesInCommit(commit: string): Promise<string[] | null> {
  const r = await capi('GET', `/version/files?commit=${encodeURIComponent(commit)}`)
  if (r.status !== 200) return null
  return versionFilePaths(r.body)
}

/**
 * The commits a group is running behind: everything after `deployed` up to and
 * including `head`, from the history read so far. Null when it does not hold
 * both — the range cannot be bounded, and a guess at it is exactly the claim
 * `pendingDeploy` must not make.
 */
function commitsAfter(items: CommitRef[], deployed: string, head: string): string[] | null {
  const d = items.findIndex((c) => sameCommit(c.hash, deployed))
  const h = items.findIndex((c) => c.hash === head)
  if (d < 0 || h < 0 || d === h) return null
  // Either order the page comes in: the range is what lies between the two,
  // HEAD included and the deployed commit — already running — excluded.
  return h < d
    ? items.slice(h, d).map((c) => c.hash)
    : items.slice(d + 1, h + 1).map((c) => c.hash)
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
async function undeployedRange(
  group: string,
): Promise<{ deployed: string; head: string; history: CommitRef[] } | null> {
  const r = await readDeployRange(group)
  return r.kind === 'behind' ? r : null
}

type DeployRange =
  | { kind: 'unreadable'; detail: string }
  | { kind: 'current'; head: string }
  | { kind: 'behind'; deployed: string; head: string; history: CommitRef[] }

/** `undeployedRange`'s reads, without collapsing "unreadable" into "current". */
async function readDeployRange(group: string): Promise<DeployRange> {
  const [deployed, history] = await Promise.all([deployedVersion(group), commitHistory()])
  const head = history?.[headIndex(history)]?.hash
  if (!deployed) return { kind: 'unreadable', detail: `the commit ${group} is running (its group record’s configVersion) could not be read` }
  if (!history || !head) return { kind: 'unreadable', detail: 'the Leader’s commit history could not be read' }
  if (sameCommit(deployed, head)) return { kind: 'current', head }
  return { kind: 'behind', deployed, head, history }
}

/**
 * Whether a group runs what the Leader holds, WITHOUT the null that
 * `pendingDeploy` and `undeployedHead` share between "nothing pending" and
 * "could not tell". For a caller that must refuse on doubt (the cutover
 * preflight): `unreadable` — the group's commit or the history could not be
 * read; `current` — the group runs HEAD; `behind` with `touches` — a commit
 * after the group's own moved one of its files (proved, as `pendingDeploy`);
 * `behind` with `clear` — every commit in between was read and none touches
 * the group; `behind` with `unknown` — the range could not be bounded (past
 * `HISTORY_PAGES`) or a `/version/files` read failed and nothing proved it.
 * Read-only: the same GETs as `pendingDeploy`.
 */
export type DeployState =
  | { state: 'unreadable'; detail: string }
  | { state: 'current'; head: string }
  | { state: 'behind'; head: string; deployed: string; proof: 'touches' | 'clear' | 'unknown'; detail: string | null }

export async function deployState(group: string = DEFAULT_STREAM_GROUP): Promise<DeployState> {
  const range = await readDeployRange(group)
  if (range.kind === 'unreadable') return { state: 'unreadable', detail: range.detail }
  if (range.kind === 'current') return { state: 'current', head: range.head }
  const base = { state: 'behind' as const, head: range.head, deployed: range.deployed }
  const history = await historyReaching(range.history, range.deployed)
  const behind = history && commitsAfter(history, range.deployed, range.head)
  if (!behind) {
    return { ...base, proof: 'unknown', detail: `the commits between ${range.deployed} and ${range.head} could not be listed (not within ${HISTORY_PAGES * HISTORY_PAGE} commits, or a history page could not be read)` }
  }
  let proved = false
  let unread = 0
  let next = 0
  const worker = async () => {
    while (!proved && next < behind.length) {
      const changed = await filesInCommit(behind[next++])
      if (changed === null) unread++
      else if (changed.some((p) => pathInGroup(p, group))) proved = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(FILES_READ_CONCURRENCY, behind.length) }, worker))
  if (proved) return { ...base, proof: 'touches', detail: null }
  if (unread) return { ...base, proof: 'unknown', detail: `the files of ${unread} of ${behind.length} commit(s) in between could not be read` }
  return { ...base, proof: 'clear', detail: null }
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
 * This is what the screen needs. Every Guided Setup confirmation says
 * that its deploy — which restarts that group's Worker Processes — carries that
 * commit live, so a claim derived from a signal that
 * cannot distinguish this group from any other is not good enough. "Could not
 * tell" answers null, exactly like "nothing pending".
 *
 * Read-only: two GETs, up to `HISTORY_PAGES - 1` more history pages when the
 * group's commit is further back than one, then one `/version/files` per commit
 * the group is behind, `FILES_READ_CONCURRENCY` at a time, until one proves the
 * claim — no writes, so it is safe to ask on a status check.
 */
export async function pendingDeploy(group: string = DEFAULT_STREAM_GROUP): Promise<string | null> {
  const range = await undeployedRange(group)
  if (!range) return null
  // The config repo is shared by every group, so a newer HEAD on its own only
  // says that SOMEBODY committed something. Ask which files each commit this
  // group has not deployed moved, and claim a pending deploy only when one of
  // them belongs to this group — otherwise every commit anywhere on the leader
  // would light this up. One read per commit, because `/version/files` answers
  // for ONE commit (see `filesInCommit`): asked only about the deployed commit,
  // as this used to, it described what the group was already running.
  const history = await historyReaching(range.history, range.deployed)
  const behind = history && commitsAfter(history, range.deployed, range.head)
  // The deployed commit is not in the history this will read: no bounded
  // range, so no claim.
  if (!behind) return null
  // The deploy moves the group to HEAD, carrying every commit in between, so
  // proof from any of them is a pending deploy of HEAD. A few reads at a time,
  // and none started once one has proved it. An unavailable read is no
  // evidence from that commit, but another read can still prove the claim; if
  // none does, the unread one might have been this group's, so the answer is
  // "could not tell" — null.
  let proved = false
  let next = 0
  const worker = async () => {
    while (!proved && next < behind.length) {
      const changed = await filesInCommit(behind[next++])
      if (changed?.some((p) => pathInGroup(p, group))) proved = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(FILES_READ_CONCURRENCY, behind.length) }, worker))
  return proved ? range.head : null
}

/**
 * `first` extended page by page until it holds `deployed`, or null when it
 * does not within `HISTORY_PAGES` pages, the history ends first, or a page
 * cannot be read. Only `pendingDeploy` needs the range; `undeployedHead` needs
 * HEAD, which is on the first page, and does not come here.
 */
async function historyReaching(first: CommitRef[], deployed: string): Promise<CommitRef[] | null> {
  let history = first
  let page = first
  for (let n = 1; !history.some((c) => sameCommit(c.hash, deployed)); n++) {
    if (n >= HISTORY_PAGES || page.length < HISTORY_PAGE) return null
    const more = await commitHistory(n * HISTORY_PAGE)
    if (!more) return null
    page = more
    history = history.concat(more)
  }
  return history
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
  markers: readonly string[],
  onStep: (r: StepResult) => void,
  onPhase: OnPhase,
  nothingCommitted: string | null = null,
): Promise<StepResult[]> {
  const out: StepResult[] = []

  // A caller that KNOWS it just changed something passes `nothingCommitted`:
  // for it, finding nothing to commit is not "up to date", it is a change that
  // will never be committed or deployed, and it is reported as the error it is.
  // No stranded-commit repair either — this run's own change is what is missing.
  const nothing = (r: StepResult): StepResult[] => {
    out.push(r); onStep(r); onPhase({ kind: 'error', text: `Commit failed — ${r.detail}` })
    return out
  }

  if (files.length === 0) {
    if (nothingCommitted !== null) return nothing({ key: 'commit', action: 'error', detail: nothingCommitted })
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
    if (nothingCommitted !== null) {
      return nothing({ key: 'commit', action: 'error', detail: `Cribl committed nothing — ${nothingCommitted}` })
    }
    const r: StepResult = { key: 'commit', action: 'exists', detail: 'nothing to commit' }
    out.push(r); onStep(r)
    return deployStrandedCommit(group, out, onStep, onPhase, 'No net changes — nothing to deploy')
  }
  // ── DID THE COMMIT CARRY EVERYTHING THIS RUN CHANGED? ────────────────────
  // `files` is matched against Git's own list by a marker per resource, or
  // guessed from a layout when Git reported nothing. Either can miss a file, and
  // a deploy of a commit that holds the source but not the ruleset it names
  // ships a source that breaks nothing into events. So ask Git again: anything
  // of this run's still uncommitted means the commit is incomplete, and it is
  // not deployed. A status read that fails answers nothing either way, and the
  // deploy goes ahead as it always has.
  const after = await pendingFiles().catch(() => null)
  const leftBehind = matching(after ?? [], group, markers)
  if (leftBehind.length) {
    const r: StepResult = {
      key: 'commit', action: 'error',
      detail:
        `committed ${hash.slice(0, 10)}, but Git still reports ${leftBehind.join(', ')} uncommitted, so that commit does not hold ` +
        'everything this run changed. Not deployed — commit the rest in Cribl, then deploy.',
      message, hash,
    }
    out.push(r); onStep(r); onPhase({ kind: 'error', text: `Commit incomplete — ${r.detail}` })
    return out
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
 * Commit the pending files in `group` that match `markers` — or `constructed`
 * when Git reports nothing — and deploy that commit: `filesToCommitFor` then
 * `commitAndDeploy`, with every guard those carry (an explicit file list, the
 * re-read that refuses to deploy an incomplete commit, the stranded-commit
 * repair that deploys only a hash this app recorded).
 *
 * `nothingCommitted`: the error to report when nothing gets committed, from a
 * caller whose own write just succeeded. Null keeps Guided Setup's reading —
 * nothing to commit is "up to date", and the stranded-commit repair runs.
 *
 * THE ONE EXPORTED WAY IN, for a caller whose change is not one of Guided
 * Setup's resource files: the onboarding pack client (cribl/packClient.ts).
 * It exists so that client does not carry a second copy of this machinery.
 */
export async function commitMatchingAndDeploy(
  message: string,
  group: string,
  markers: readonly string[],
  constructed: readonly string[],
  onStep: (r: StepResult) => void = () => {},
  onPhase: OnPhase = noopPhase,
  nothingCommitted: string | null = null,
): Promise<StepResult[]> {
  const files = await filesToCommitFor(group, markers, constructed)
  return commitAndDeploy(message, group, files, markers, onStep, onPhase, nothingCommitted)
}

/**
 * Best-effort ingress host to point Gigamon AMX at, or null when it cannot be
 * derived. On Cribl.Cloud the `default` group's workers answer at
 * `default.main.<org>.cribl.cloud`; for any other group, or a hybrid group
 * (whose workers are the customer's own machines), the card prints a
 * placeholder rather than a guess.
 */
export function suggestedIngressHost(group: string, managed: boolean): string | null {
  if (!managed || group !== DEFAULT_STREAM_GROUP || typeof window === 'undefined') return null
  const origin = window.__CRIBL_SEARCH_ORIGIN || window.location.origin
  try {
    const host = new URL(origin).hostname // e.g. main-<org>.cribl.cloud
    return host.startsWith('main-') ? `default.main.${host.slice('main-'.length)}` : null
  } catch {
    return null
  }
}

/** The URL Gigamon AMX POSTs to: https when the source terminates TLS. */
export function postUrl(host: string, port: number, tls: boolean): string {
  return `${tls ? 'https' : 'http'}://${host}:${port}/`
}
