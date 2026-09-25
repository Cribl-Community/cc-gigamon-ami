// The typed read client for everything the Lake landing panel shows.
//
// Ten paths across three product surfaces — Cribl Lake, Cribl Search and
// Cribl Stream — all over `capi`, none of them a write. Ten paths but NINE
// landing rows: `localSearch` is one row that reads two of them (see
// `getLocalSearch`), which is why a count of rows and a count of paths disagree
// here and the header says both. The writes are next door
// in cribl/lakeLanding.ts, and the split is deliberate rather than tidy: every
// write in this phase edits a live shared object behind a confirmation, so
// keeping them in one file means the "only after `confirm`" rule is checkable by
// reading one module instead of trusting two. A read function here can be called
// from anywhere; that is the difference.
//
// ── A 404 IS DATA ───────────────────────────────────────────────────────────
// `capi` answers `{status, body}` instead of throwing precisely so this file can
// treat a status as an answer, and every read below returns a `ReadResult`
// rather than a value or an exception. The three states that are NOT errors and
// get their own words:
//
//   * the dataset is not created yet;
//   * the AI schema summary has never been generated;
//   * a tenant has no Cribl Search local engines — `local_search` answers 404
//     with "LocalSearch is not enabled", which is the NORMAL state and not a
//     misconfiguration. A panel that rendered that as "failed" would send an
//     admin looking for a fault in a workspace that is working. (This tenant
//     HAS had an engine since 2026-09-22; the 404 branch is still the state
//     most tenants installing this app see on day one.)
//
// A 401/403 is a fourth thing again: the object exists and this account may not
// read it. It is reported with the object NAMED, because "unavailable" tells
// somebody nothing they can act on and the object is exactly what an admin has
// to grant.
//
// ── WHY THE PATHS ARE SPELLED OUT HERE ──────────────────────────────────────
// The literals below duplicate ids this app already holds in cribl/config.ts and
// cribl/provision.ts, and that is not an oversight.
// `src/cribl/policyCoverage.test.ts` works out which endpoint a call reaches by
// resolving the call site's path expression against the module's OWN top-level
// string constants; an imported id resolves to a placeholder, and the entry in
// config/policies.yml would then have to be written as a placeholder too —
// widening the grant from "this app's own destination" to "any output in any
// worker group". Spelling them out keeps the grant narrow, and lake.test.ts pins
// each one against the constant it duplicates so the two cannot drift.

import { capi, errText, groupPath, type ApiResp, type CapiInit } from './capi'
import { isDenial } from './authz'

// ── Addressing ──────────────────────────────────────────────────────────────
// Every path below is built from one of these single-quoted constants in a
// single template. Both halves of that sentence matter to the coverage scanner:
// it expands `${NAME}` only from a plain string literal in this file, so a
// constant built from another constant resolves to a placeholder.

/** The Cribl Lake dataset every dashboard in this app reads. Pinned to
 *  `LAKE_DATASET` (config.ts) and `LAKE_DATASET_ID` (provision.ts) in the test. */
const DATASET_ID = 'gigamon_ami'
/** The Cribl Lake destination both feeds write through. Pinned to
 *  `LAKE_DESTINATION_ID` (provision.ts) in the test. */
const DESTINATION_ID = 'gigamon_lake'
/** The onboarding pack, and the destination inside it that writes gigamon_ami.
 *  Pinned to `PACK_ID` and `PACK_JSON_OUTPUT_ID` (pack.ts) in the test. The
 *  Lake landing panel READS this destination and never writes it: the pack's
 *  releases govern it (see `getPackDestination`). */
const PACK_ID = 'cc-network-gigamon-ami'
const PACK_DESTINATION_ID = 'gigamon_ami_json_lake'
/** `default` is the lake itself, not a placeholder — Cribl Lake exposes one and
 *  this app never addresses another. */
const LAKE_ROOT = '/products/lake/lakes/default'
/** Search always runs in the dedicated search group, so this is a literal and
 *  the grant it needs covers no other group. */
const SEARCH_ROOT = '/m/default_search/search'

// ── What a read answers ─────────────────────────────────────────────────────

/**
 * How a read ended. Four states, because a panel row has four things to say and
 * collapsing any two of them loses the one a person can act on.
 */
export type ReadOutcome =
  /** The value is here. */
  | 'ok'
  /** Cribl says there is no such object — and for three of these endpoints that
   *  is a normal, expected answer with its own sentence. */
  | 'absent'
  /** 401/403: it exists and this account may not read it. `object` names what an
   *  admin would have to grant. */
  | 'not-readable'
  /** Anything else — a 5xx, a broken connection, a body that made no sense. */
  | 'failed'

export interface ReadResult<T> {
  outcome: ReadOutcome
  /** Non-null exactly when `outcome` is `ok`. */
  value: T | null
  /** The endpoint, as an admin would grant it. Present on every result, because
   *  a failure that does not name what failed is not actionable. */
  object: string
  /** The HTTP status, or null when the request never got one. */
  status: number | null
  /** Cribl's own sentence, when it sent one. Never invented here. */
  detail: string | null
}

const ok = <T>(object: string, value: T, status: number): ReadResult<T> => ({ outcome: 'ok', value, object, status, detail: null })

/**
 * Turn a response this read could not use into a result.
 *
 * The 404 branch is the caller's to decide, so it is a parameter: "not created
 * yet", "never generated" and "not enabled on this tenant" are three different
 * sentences about the same status, and a shared default would make two of them
 * wrong.
 */
function failed<T>(object: string, r: ApiResp): ReadResult<T> {
  const outcome: ReadOutcome = r.status === 404 ? 'absent' : isDenial(r.status) ? 'not-readable' : 'failed'
  return { outcome, value: null, object, status: r.status, detail: outcome === 'absent' ? null : errText(r) }
}

function threw<T>(object: string, err: unknown): ReadResult<T> {
  return { outcome: 'failed', value: null, object, status: null, detail: err instanceof Error ? err.message : String(err) }
}

/** `{items:[…]}` is Cribl's envelope everywhere. A body that is not one is read
 *  as no items rather than as a crash: this app cannot fix a shape it did not
 *  expect, and a panel row saying "failed" beats a white screen. */
function items(body: unknown): Record<string, unknown>[] {
  const list = (body as { items?: unknown })?.items
  return Array.isArray(list) ? (list.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : []
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// ── 1. Lake configuration: what this tenant allows ──────────────────────────

export interface LakeLimits {
  /** How many partition fields Cribl Lake accepts on a dataset here, or null
   *  when the config did not name it. Null is not 3 — see the caller. */
  maxAcceleratedFieldsCount: number | null
  /** Every limit as returned, so a future control can read one without a change
   *  here and without this module pretending to understand it. */
  raw: Readonly<Record<string, unknown>>
}

/**
 * The Cribl Lake limits for this tenant.
 *
 * A 404 here means Cribl Lake is not available — it is a Cloud-only product, and
 * an on-prem Leader answers exactly this. That is a PANEL-level state, not a row
 * one: nothing else on this panel means anything without it.
 */
export async function getLakeConfig(init: CapiInit = {}): Promise<ReadResult<LakeLimits>> {
  const object = `${LAKE_ROOT}/config`
  try {
    const r = await capi('GET', `${LAKE_ROOT}/config`, undefined, init)
    if (r.status !== 200) return failed(object, r)
    const raw: Record<string, unknown> = {}
    for (const it of items(r.body)) {
      const id = text(it.id)
      if (id) raw[id] = it.value
    }
    return ok(object, { maxAcceleratedFieldsCount: num(raw.maxAcceleratedFieldsCount), raw: Object.freeze(raw) }, r.status)
  } catch (err) {
    return threw(object, err)
  }
}

// ── 2 & 3. The Lake dataset ─────────────────────────────────────────────────

export interface LakeDatasetMetrics {
  currentSizeBytes: number | null
  /** The DAY the size was computed. Lake metrics are not live, and a size
   *  rendered without this date is a claim about right now that it cannot make. */
  metricsDate: string | null
}

export interface LakeDataset {
  id: string
  description: string | null
  format: string | null
  retentionPeriodInDays: number | null
  /** Absent and empty are different: absent means the object does not carry the
   *  field at all, which is what the retention no-op probe (Preview 3.1.3) is
   *  the only evidence about. */
  acceleratedFields: string[] | null
  searchConfig: Record<string, unknown> | null
  deletionStartedAt: string | null
  metrics: LakeDatasetMetrics | null
  /** The whole body. `updateDestination`'s Lake counterpart does not exist —
   *  Lake PATCH is believed partial — but the Preview capture that makes this
   *  phase reversible (P2) is this object, so it is kept whole. */
  raw: Readonly<Record<string, unknown>>
}

function asDataset(it: Record<string, unknown>): LakeDataset {
  const metrics = it.metrics && typeof it.metrics === 'object' ? (it.metrics as Record<string, unknown>) : null
  return {
    id: text(it.id) ?? '',
    description: text(it.description),
    format: text(it.format),
    retentionPeriodInDays: num(it.retentionPeriodInDays),
    acceleratedFields: Array.isArray(it.acceleratedFields) ? it.acceleratedFields.map(String) : null,
    searchConfig: it.searchConfig && typeof it.searchConfig === 'object' ? (it.searchConfig as Record<string, unknown>) : null,
    deletionStartedAt: text(it.deletionStartedAt),
    metrics: metrics ? { currentSizeBytes: num(metrics.currentSizeBytes), metricsDate: text(metrics.metricsDate) } : null,
    raw: Object.freeze({ ...it }),
  }
}

/**
 * Every dataset in the lake, deleted ones included.
 *
 * `excludeDeleted=false` is not curiosity: a dataset whose deletion has started
 * still holds its id for a day or two, and a panel that filtered it out would
 * report "not created yet" about an id nothing can create.
 */
export async function listDatasets(init: CapiInit = {}): Promise<ReadResult<LakeDataset[]>> {
  const object = `${LAKE_ROOT}/datasets`
  try {
    const r = await capi('GET', `${LAKE_ROOT}/datasets?excludeDeleted=false&includeMetrics=true`, undefined, init)
    if (r.status !== 200) return failed(object, r)
    return ok(object, items(r.body).map(asDataset), r.status)
  } catch (err) {
    return threw(object, err)
  }
}

/**
 * The one dataset this app reads, with its size.
 *
 * `absent` here is the dataset-absent panel state: Guided Setup's ingest panel
 * sits above this one on the same page and is where somebody goes next. There is
 * no `/setup/storage` route to send them to and there never will be (I-D2).
 */
export async function getDataset(init: CapiInit = {}): Promise<ReadResult<LakeDataset>> {
  const object = `${LAKE_ROOT}/datasets/${DATASET_ID}`
  try {
    const r = await capi('GET', `${LAKE_ROOT}/datasets/${DATASET_ID}?includeMetrics=true`, undefined, init)
    if (r.status !== 200) return failed(object, r)
    const first = items(r.body)[0]
    if (!first) return { outcome: 'failed', value: null, object, status: r.status, detail: 'Cribl Lake answered 200 with no dataset in it.' }
    return ok(object, asDataset(first), r.status)
  } catch (err) {
    return threw(object, err)
  }
}

// ── 4. The Search-side dataset ──────────────────────────────────────────────

export interface SearchDataset {
  id: string
  /** `v1` or `v2` — which reader Cribl Search uses for this dataset. READ-ONLY
   *  in this phase: P-S5 has not said which endpoint changes it. */
  searchVersion: string | null
  lakeStorageFormat: string | null
  raw: Readonly<Record<string, unknown>>
}

/**
 * How Cribl Search sees the dataset, as opposed to how Cribl Lake does.
 *
 * The two can disagree, and that disagreement is the reason this read exists
 * rather than deriving the reader from the Lake object: whether a
 * `searchConfig` written on the Lake side propagates to Search is unverified and
 * is the whole of P-S5. Until it reports, the honest thing a panel can do is
 * show both sides and let somebody see whether they match.
 */
export async function getSearchDataset(init: CapiInit = {}): Promise<ReadResult<SearchDataset>> {
  const object = `${SEARCH_ROOT}/datasets/${DATASET_ID}`
  try {
    const r = await capi('GET', `${SEARCH_ROOT}/datasets/${DATASET_ID}`, undefined, init)
    if (r.status !== 200) return failed(object, r)
    const first = items(r.body)[0]
    if (!first) return { outcome: 'absent', value: null, object, status: r.status, detail: null }
    return ok(
      object,
      {
        id: text(first.id) ?? '',
        searchVersion: text(first.searchVersion),
        lakeStorageFormat: text(first.lakeStorageFormat),
        raw: Object.freeze({ ...first }),
      },
      r.status,
    )
  } catch (err) {
    return threw(object, err)
  }
}

// ── 5. The destination ──────────────────────────────────────────────────────

export interface LakeDestination {
  id: string
  /** What Cribl says about delivery right now. Server-computed, never written
   *  back — see `DESTINATION_READONLY_KEYS` in cribl/landing.ts. */
  health: string | null
  raw: Readonly<Record<string, unknown>>
}

/**
 * The live `gigamon_lake` destination, whole.
 *
 * WHOLE IS THE POINT. Every edit to it is a read-modify-write, because a Stream
 * destination PATCH is a full replacement — so this body is both what the diff
 * is computed against and what the PATCH is built from. Anything this function
 * drops is a field the next Apply deletes from a customer's configuration.
 */
export async function getDestination(group: string, init: CapiInit = {}): Promise<ReadResult<LakeDestination>> {
  const object = `/m/:gid/system/outputs/${DESTINATION_ID}`
  try {
    const r = await capi('GET', groupPath(group, `/system/outputs/${DESTINATION_ID}`), undefined, init)
    if (r.status !== 200) return failed(object, r)
    const first = items(r.body)[0]
    if (!first) return { outcome: 'absent', value: null, object, status: r.status, detail: null }
    const status = first.status && typeof first.status === 'object' ? (first.status as Record<string, unknown>) : null
    return ok(object, { id: text(first.id) ?? '', health: status ? text(status.health) : null, raw: Object.freeze({ ...first }) }, r.status)
  } catch (err) {
    return threw(object, err)
  }
}

/** What the onboarding pack answers for the Lake landing panel. */
export type PackDestinationRead =
  /** The pack is not in this group's pack list. */
  | { installed: false; destination: null }
  /** The pack is installed. `destination` is null when this version of the pack
   *  has no `gigamon_ami_json_lake` (0.1.0 wrote through its own ids). */
  | { installed: true; destination: LakeDestination | null }

/**
 * The onboarding pack's `gigamon_ami_json_lake`, whole, for DISPLAY ONLY — in a
 * group where the pack is installed it is what writes gigamon_ami for Gigamon
 * AMX, and the panel shows its flush and backpressure settings beside the
 * global `gigamon_lake`'s.
 *
 * NEVER WRITTEN FROM HERE (owner decision 2026-09-25). A change to a pack
 * object is kept as a local setting of the pack, and an in-place upgrade keeps
 * local settings (measured 2026-09-25, 0.1.0 → 0.2.0 on a Leader), so an edit
 * would pin this destination against every later release of the pack. The
 * pack's releases govern it; this read has no PATCH beside it.
 *
 * The pack list is read FIRST rather than taking a failed read of the
 * destination for "not installed": what Cribl answers for a path inside a pack
 * that is not installed is unmeasured. A pack list that cannot be read is
 * `not-readable` / `failed`, never "not installed" — a 404 on the LIST says
 * nothing about packs.
 */
export async function getPackDestination(group: string, init: CapiInit = {}): Promise<ReadResult<PackDestinationRead>> {
  const object = `/m/:gid/p/${PACK_ID}/system/outputs/${PACK_DESTINATION_ID}`
  try {
    const packs = await capi('GET', groupPath(group, '/packs'), undefined, init)
    if (packs.status !== 200) {
      const r = failed<PackDestinationRead>('/m/:gid/packs', packs)
      return r.outcome === 'absent' ? { ...r, outcome: 'failed', detail: errText(packs) } : r
    }
    if (!items(packs.body).some((p) => text(p.id) === PACK_ID)) {
      return ok(object, { installed: false, destination: null }, packs.status)
    }
    const r = await capi('GET', groupPath(group, `/p/${PACK_ID}/system/outputs/${PACK_DESTINATION_ID}`), undefined, init)
    if (r.status === 404) return ok(object, { installed: true, destination: null }, r.status)
    if (r.status !== 200) return failed(object, r)
    const first = items(r.body)[0]
    if (!first) return ok(object, { installed: true, destination: null }, r.status)
    const status = first.status && typeof first.status === 'object' ? (first.status as Record<string, unknown>) : null
    return ok(
      object,
      {
        installed: true,
        destination: { id: text(first.id) ?? '', health: status ? text(status.health) : null, raw: Object.freeze({ ...first }) },
      },
      r.status,
    )
  } catch (err) {
    return threw(object, err)
  }
}

// ── 6 & 7. What writes through it ───────────────────────────────────────────

/** One source, reduced to the only thing this panel asks of it: where it sends
 *  data directly, which is what a QuickConnect binding looks like. */
export interface StreamInput {
  id: string
  type: string | null
  /** Output ids this source is wired straight to, bypassing the routing table. */
  connectedOutputs: string[]
  /** Every port this source listens on — `port`, or a Syslog source's
   *  `tcpPort` / `udpPort`. Guided Setup reads it to offer a free port. A port
   *  Cribl reports as a numeric string is counted as the number it spells. */
  ports: number[]
  /**
   * True when a port field is present and this app cannot say which port it
   * is: a non-numeric string, or a port bound to a variable
   * (`__template_port` and friends). A free-port check must read that as
   * "cannot tell", never as "free" — two sources on one port is a bind failure
   * on every worker in the group.
   */
  portUnknown: boolean
  /** The event breaker rulesets this source names. Guided Setup reads it before
   *  deleting its own ruleset, which another source may also name. */
  breakerRulesets: string[]
}

/** A source inside an installed pack, and which pack. */
export interface PackInput extends StreamInput {
  pack: string
}

const PORT_KEYS = ['port', 'tcpPort', 'udpPort'] as const

/** A port field as a number; `undefined` when the field is not set; null when it
 *  is set and is not a port this app can read. */
function portOf(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

/** One source record, reduced. Shared by the group's own list and each pack's. */
function streamInput(it: Record<string, unknown>): StreamInput {
  const read = PORT_KEYS.map((k) => portOf(it[k]))
  const templated = PORT_KEYS.some((k) => it[`__template_${k}`] !== undefined && it[`__template_${k}`] !== null && it[`__template_${k}`] !== '')
  return {
    id: text(it.id) ?? '',
    type: text(it.type),
    connectedOutputs: (Array.isArray(it.connections) ? it.connections : [])
      .map((c) => (c && typeof c === 'object' ? text((c as Record<string, unknown>).output) : null))
      .filter((o): o is string => o !== null),
    ports: read.filter((p): p is number => typeof p === 'number'),
    portUnknown: templated || read.some((p) => p === null),
    breakerRulesets: (Array.isArray(it.breakerRulesets) ? it.breakerRulesets : []).filter((b): b is string => typeof b === 'string'),
  }
}

/**
 * The group's sources.
 *
 * READ BECAUSE THE ROUTING TABLE IS NOT THE WHOLE ANSWER. On the workspace this
 * was measured against, the DataGen source reaches Cribl Lake through a
 * QuickConnect binding — `connections[].output` on the source itself — and
 * appears nowhere in `routes`. A confirmation that claimed "one feed writes
 * through this destination" because it only read the routing table would be
 * wrong on the one tenant anybody has checked.
 */
export async function listInputs(group: string, init: CapiInit = {}): Promise<ReadResult<StreamInput[]>> {
  const object = '/m/:gid/system/inputs'
  try {
    const r = await capi('GET', groupPath(group, '/system/inputs'), undefined, init)
    if (r.status !== 200) return failed(object, r)
    return ok(object, items(r.body).map(streamInput), r.status)
  } catch (err) {
    return threw(object, err)
  }
}

/**
 * The sources inside every pack installed in the group.
 *
 * READ BECAUSE THE GROUP'S OWN LIST DOES NOT HOLD THEM. A pack's sources are
 * addressed under `/m/<g>/p/<pack>/system/inputs` (openapi.json lists the
 * `/p/{pack}/system/inputs` family beside the global one), and the onboarding
 * pack's Raw HTTP source listens in the same 20000–20010 range a Cribl-managed
 * group allows Guided Setup's. NOT MEASURED on a Leader with a pack that holds
 * a source: none of this workspace's groups had a pack installed when this was
 * written (read 2026-09-24).
 *
 * One pack that cannot be read fails the whole read, which is the point: a
 * port check or an ownership check built on part of the answer says "free" or
 * "unused" about something it never saw.
 */
export async function listPackInputs(group: string, init: CapiInit = {}): Promise<ReadResult<PackInput[]>> {
  try {
    const packs = await capi('GET', groupPath(group, '/packs'), undefined, init)
    if (packs.status !== 200) return failed('/m/:gid/packs', packs)
    const ids = items(packs.body).map((p) => text(p.id)).filter((id): id is string => id !== null)
    const out: PackInput[] = []
    for (const pack of ids) {
      const r = await capi('GET', groupPath(group, `/p/${encodeURIComponent(pack)}/system/inputs`), undefined, init)
      if (r.status !== 200) return failed('/m/:gid/p/:pack/system/inputs', r)
      out.push(...items(r.body).map((it) => ({ ...streamInput(it), pack })))
    }
    return ok('/m/:gid/p/:pack/system/inputs', out, packs.status)
  } catch (err) {
    return threw('/m/:gid/packs', err)
  }
}

/** One route, reduced to what it sends and where. */
export interface StreamRoute {
  id: string
  name: string | null
  output: string | null
  disabled: boolean
}

/** The group's routing table. The other half of `feedsThrough`. */
export async function listRoutes(group: string, init: CapiInit = {}): Promise<ReadResult<StreamRoute[]>> {
  const object = '/m/:gid/routes'
  try {
    const r = await capi('GET', groupPath(group, '/routes'), undefined, init)
    if (r.status !== 200) return failed(object, r)
    // A group has ONE routing table, and its routes are inside it.
    const table = items(r.body)[0]
    const routes = Array.isArray(table?.routes) ? (table.routes as Record<string, unknown>[]) : []
    return ok(
      object,
      routes
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({
          id: text(x.id) ?? text(x.name) ?? '',
          name: text(x.name),
          output: text(x.output),
          disabled: x.disabled === true,
        })),
      r.status,
    )
  } catch (err) {
    return threw(object, err)
  }
}

// ── 8. The acceleration tier ────────────────────────────────────────────────

/** One engine, as the API returns it. Read with `engineState` / `servesDataset`
 *  in `landing.ts` — the derivations are words about values, not transport. */
export type EngineRecord = Readonly<Record<string, unknown>>

export interface LocalSearchTier {
  /** False when the tenant has no local search at all — the 404 answer. */
  enabled: boolean
  /**
   * How many engines are provisioned. Zero with `enabled` true is a real state —
   * local search is switched on and nothing has been sized for it yet — and null
   * is a different one again: the engine list could not be read, so this app does
   * not know. A sentinel number would have been a count nobody measured.
   */
  engines: number | null
  /**
   * The engine records themselves, not just how many.
   *
   * A COUNT CANNOT ANSWER THE QUESTIONS THIS ROW IS ASKED. Measured 2026-09-22:
   * while `Gigamon_LHE` was *provisioning* this tier reported "enabled, 1
   * engine" — byte-identical to what it reports now the engine is **ready**. An
   * engine that is still building and one that is serving are different facts
   * about a workspace, and `engines: 1` is both. The records carry `status`,
   * `effectiveStatus` and `datasets`, which is what `engineState` and
   * `servesDataset` below read.
   *
   * Empty is not the same as `engines: null`: empty means the list was read and
   * held nothing, null means it could not be read at all.
   */
  records: readonly EngineRecord[]
  /**
   * The HTTP status the engine list answered with, so a caller can tell "the
   * endpoint is there and nothing is configured" (200 + empty) from "the
   * endpoint is not there at all" (404) — a distinction the count erases.
   */
  enginesStatus: number | null
  raw: Readonly<Record<string, unknown>> | null
}

/**
 * Whether this workspace has Cribl Search local engines.
 *
 * 404 IS "NOT PROVISIONED", NOT A FAILURE. The endpoint answers
 * "LocalSearch is not enabled" on a tenant without it, which is the ordinary
 * state of most tenants; every search in this app runs exactly as it always has.
 *
 * BOTH CALLS RUN, ALWAYS, AND IN PARALLEL. This used to skip the engine list on
 * a 404, reasoning that "a second 404 for the same reason is a second row of
 * noise". Measured 2026-09-22: the engine list does **not** 404 in that state —
 * it answers `200 {"items":[],"count":0}`. So the skipped call was the one
 * response that distinguishes "local search exists and nothing is sized for it"
 * from "local search is not on this tenant at all", and the optimisation was
 * discarding the only evidence that told them apart. They are issued together
 * rather than in sequence because neither depends on the other's answer.
 */
export async function getLocalSearch(init: CapiInit = {}): Promise<ReadResult<LocalSearchTier>> {
  const object = `${SEARCH_ROOT}/local_search`
  try {
    const [r, engines] = await Promise.all([
      capi('GET', `${SEARCH_ROOT}/local_search`, undefined, init),
      listLocalEngines(init),
    ])
    // An unreadable engine list does not unmake the tier: local search IS
    // enabled, and reporting zero engines because a second call was refused
    // would be a number this app made up.
    const readable = engines.outcome === 'ok'
    const records: readonly EngineRecord[] = readable
      ? Object.freeze((engines.value ?? []).map((e) => Object.freeze({ ...e })))
      : Object.freeze([])
    const counted = readable ? records.length : null

    if (r.status === 404) {
      return ok(object, { enabled: false, engines: counted, records, enginesStatus: engines.status, raw: null }, r.status)
    }
    if (r.status !== 200) return failed(object, r)
    const first = items(r.body)[0] ?? {}
    return ok(
      object,
      { enabled: true, engines: counted, records, enginesStatus: engines.status, raw: Object.freeze({ ...first }) },
      r.status,
    )
  } catch (err) {
    return threw(object, err)
  }
}

/** The engines themselves, for the tier count. Separately exported because a
 *  later surface may want to name them rather than count them. */
export async function listLocalEngines(init: CapiInit = {}): Promise<ReadResult<Record<string, unknown>[]>> {
  const object = `${SEARCH_ROOT}/local_search/engines`
  try {
    const r = await capi('GET', `${SEARCH_ROOT}/local_search/engines`, undefined, init)
    if (r.status === 404) return ok(object, [], r.status)
    if (r.status !== 200) return failed(object, r)
    return ok(object, items(r.body), r.status)
  } catch (err) {
    return threw(object, err)
  }
}

// ── 9. The Stream groups ────────────────────────────────────────────────────

export interface StreamGroupInfo {
  id: string
  name: string
  /** The commit this group's Workers are running. What a rollback needs a name
   *  for: "redeploy the previous version" is not a plan until it has one. */
  configVersion: string | null
  /** True for a hybrid group, false for a Cribl-managed one, null when the
   *  record does not say — which a self-hosted Leader's does not, and which
   *  must not be read as "Cribl-managed". */
  onPrem: boolean | null
}

/**
 * The worker groups, from the current path family.
 *
 * `provision.ts` still lists groups from the deprecated `/master/groups` for its
 * picker, and that is left alone: this read is not the picker. It exists because
 * the deployed commit hash is what makes the destination edit reversible, and
 * because `PATCH /products/stream/groups/{gid}/deploy` answering with a
 * `configVersion` is V-S0 — the measurement that retires the old path for
 * everyone. Reading the new path here is how this phase starts collecting it.
 */
export async function listStreamGroupsCurrent(init: CapiInit = {}): Promise<ReadResult<StreamGroupInfo[]>> {
  const object = '/products/stream/groups'
  try {
    const r = await capi('GET', '/products/stream/groups', undefined, init)
    if (r.status !== 200) return failed(object, r)
    return ok(
      object,
      items(r.body).map((it) => ({
        id: text(it.id) ?? '',
        name: text(it.name) ?? text(it.id) ?? '',
        configVersion: text(it.configVersion),
        onPrem: typeof it.onPrem === 'boolean' ? it.onPrem : null,
      })),
      r.status,
    )
  } catch (err) {
    return threw(object, err)
  }
}

// ── For the tests, and for the writers next door ────────────────────────────

/**
 * The ids and roots this module spells out, exported so lake.test.ts can pin
 * them against the constants they duplicate and so cribl/lakeLanding.ts can
 * check its own copies against these. They are NOT for building a path with —
 * see the header: a path built from an imported constant is a path the coverage
 * test resolves to a placeholder.
 */
export const LAKE_ADDRESSING = Object.freeze({
  datasetId: DATASET_ID,
  destinationId: DESTINATION_ID,
  packId: PACK_ID,
  packDestinationId: PACK_DESTINATION_ID,
  lakeRoot: LAKE_ROOT,
  searchRoot: SEARCH_ROOT,
})
