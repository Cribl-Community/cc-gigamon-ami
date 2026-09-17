// What the Lake landing panel reads, what it may change, and what it may not.
//
// This is the most write-heavy module in the app: it PATCHes a live Cribl Lake
// dataset every dashboard here reads, PATCHes the one destination BOTH feeds
// write through, writes a Git commit on the Leader, and deploys — which restarts
// that worker group's Worker Processes. Phase 2's worst outcome was a schedule
// that stopped saving. This one's are a destination that stops delivering and a
// dataset that is twenty-nine days lighter than it was this morning.
//
// Three rules hold that down, and none of them is a style preference.
//
//   1. EVERY WRITER TAKES A `confirm` AND WRITES NOTHING BEFORE IT ANSWERS TRUE.
//      Not "is called from a place that confirms" — takes one, awaits it, and
//      returns `cancelled` when it is refused. A writer that trusts its caller to
//      have asked is a writer that will one day be called from a retry.
//
//   2. NOTHING WRITES ON LOAD, ON RENDER OR ON A TIMER. That includes the
//      measurements, which are buttons; it includes the profile document, which
//      is written as a consequence of a press; and it includes the audit trail,
//      which records presses. A corrupt stored profile is read as absent and
//      deliberately NOT repaired, because the repair would be a write on load.
//
//   3. THE WRITE CALLS ARE TOP-LEVEL FUNCTIONS WITH LITERAL METHODS. That is
//      what lets src/components/gatedWrites.test.ts see them: it reads
//      `capi('PATCH'…)` out of the source and refuses to pass until each site is
//      named in cribl/authz.ts with the control that owns it. A generic
//      `write(method, path, body)` helper would be invisible to it, which is the
//      same as ungated. It is also why the two Lake PATCHes below are written out
//      twice instead of sharing one helper: the READ around them is shared, the
//      write is not.
//
//   4. EVERY WRITE IS A READ-MODIFY-WRITE, AND A FAILED READ CANCELS IT.
//      Not "falls back to sending just the edited field" — that is precisely the
//      destructive case. See below.
//
// ── WHY THE LAKE WRITERS GET THE DATASET FIRST ──────────────────────────────
// They used to send one field each — `{retentionPeriodInDays}`,
// `{description}` — on claim C6: that this endpoint updates only the fields it
// is given. C6 was inferred from the spec's example bodies and nothing else.
//
// The optimistic reading of a Cribl PATCH has already been disproved once in
// this workspace. A-SP23 measured `PATCH /search/saved/{id}` in this same
// product: a body carrying only the schema-required fields answered 200 and
// DELETED `schedule`, `earliest`, `latest` and `description`, unscheduling the
// search forever with nothing on screen to say so. If the Lake endpoint behaves
// the same way, a one-field PATCH here deletes retention, partitions,
// `searchConfig`, the storage binding and the description from a live dataset
// every dashboard in this app reads — and every test in this repo still passes,
// because a stub cannot know what a real server drops.
//
// So both writers now GET the dataset, overlay the one edited field onto what
// came back, and PATCH the whole body. That is correct under EITHER semantics:
// a partial endpoint sees the values it already holds, a replacing one gets
// everything back. It does not need C6 answered, which is the point —
// `CAPABILITIES.datasetPatchIsPartial` stays `null` because it is still
// unmeasured, and nothing here depends on it any more.
//
// WHAT IT COSTS: two extra GETs per applied edit — one to merge onto, one to
// re-read afterwards and report a value somebody else wrote. Against that: the
// alternative way to learn these semantics is to discover them on a customer's
// live dataset configuration, which cannot be undone, because Lake datasets are
// under no version control and there is no commit to revert.
//
// THIS DOES NOT RETIRE PREVIEW CHECK 3.1 (the 30 → 30 no-op, then a full re-read
// and diff). It changes what that check is FOR. It was the thing that decided
// whether this phase was safe to ship; it is now the measurement that confirms
// this app kept the dataset whole, and it still has to run. Whether a no-op
// PATCH with an identical body dirties the Leader's config is a separate open
// question and is not answered here either.
//
// ── WHAT THIS PHASE DELIBERATELY DOES NOT WRITE ─────────────────────────────
// There is no `setSearchVersion` and no `setPartitions`. Both were specified,
// both are gated on spikes that have not run (P-S5, P-S7, P-S9 — see
// `SPIKE_GATED` in cribl/landing.ts), and guessing at either against a live
// customer dataset is the one thing a Preview session cannot take back: a
// partition change applies to newly written objects only, so its effect appears
// over weeks, and a reader flip on a month of history is not a thing to try.
// The live values are READ and shown; the editors are absent, named, and
// attributed to the spike that has to report first. Phase 1 refused `<DiffTable>`
// and `<Unavailable>` the same way rather than build on an assumption.
//
// ── ADDRESSING, AGAIN ───────────────────────────────────────────────────────
// The path literals below duplicate the ones in cribl/lake.ts for the reason
// that module's header gives: policyCoverage.test.ts resolves a call's endpoint
// from the module's own top-level string constants, and an imported id resolves
// to a placeholder — which would widen the declared grant from this app's own
// objects to any dataset and any output in any group. lakeLanding.test.ts pins
// these against `LAKE_ADDRESSING` so the two copies cannot drift.

import { capi, errText, groupPath, type CapiInit } from './capi'
import { appendLog, getDoc, putDoc } from './kv'
import {
  applyDatasetEdit,
  applyDestinationEdit,
  diffDestination,
  retentionChange,
  DEFAULT_PARTITION_LIMITS,
  type DestinationEdit,
  type DiffRow,
  type LandingProfile,
  type PartitionLimits,
  type RetentionChange,
  type SpikeId,
} from './landing'
import {
  getDataset,
  getDestination,
  getLakeConfig,
  getLocalSearch,
  getSearchDataset,
  listDatasets,
  listInputs,
  listRoutes,
  listStreamGroupsCurrent,
  type LakeDataset,
  type LakeDestination,
  type LakeLimits,
  type LocalSearchTier,
  type ReadResult,
  type SearchDataset,
  type StreamGroupInfo,
  type StreamInput,
  type StreamRoute,
} from './lake'

const DATASET_ID = 'gigamon_ami'
const DESTINATION_ID = 'gigamon_lake'
const LAKE_ROOT = '/products/lake/lakes/default'

// ── One row of the panel ────────────────────────────────────────────────────

/**
 * What a single row can be.
 *
 * FOUR STATES PER ROW, AND THE ROW IS THE UNIT. The nine reads are independent
 * requests to three different products, and §2.4 requires that a slow or refused
 * one does not hide the eight that resolved. That is easy to get wrong in a way
 * that looks right: on a healthy admin's workspace every row resolves, and a
 * panel-level state machine is indistinguishable from a per-row one until the
 * day somebody is refused exactly one object.
 */
export type RowState = 'loading' | 'value' | 'absent' | 'unreadable' | 'failed'

export interface LandingRow<T> {
  state: RowState
  /** Non-null exactly when `state` is `value`. */
  value: T | null
  /** The endpoint this row came from, as an admin would grant it. Present in
   *  every state, because the read map on the panel's ⓘ claims one line per row
   *  and a row that cannot name its endpoint cannot appear on it. */
  object: string
  /** The sentence to render when `state` is not `value`. Never Cribl's echo of a
   *  query or a body — just what happened and what would fix it. */
  note: string | null
  status: number | null
}

/**
 * What each endpoint's 404 MEANS, in that endpoint's own terms.
 *
 * Written per row rather than shared, because "absent" is three different facts
 * here and two of them are completely normal: a tenant with no Cribl Lake, a
 * tenant with no Search local engines, and a dataset nobody has created yet. One
 * shared "not found" would report the ordinary state of most tenants as a
 * problem.
 */
const ABSENT_NOTES: Readonly<Record<RowKey, string>> = Object.freeze({
  lakeConfig: 'Cribl Lake is not available on this deployment. It is a Cribl.Cloud product; an on-prem Leader answers exactly this.',
  datasets: 'Cribl Lake returned no dataset list.',
  dataset: `The ${DATASET_ID} dataset does not exist yet. Create it from the onboarding panel above.`,
  searchDataset: `Cribl Search does not know about ${DATASET_ID} yet. That normally resolves itself once the dataset exists and has been written to.`,
  destination: `There is no ${DESTINATION_ID} destination in this worker group.`,
  inputs: 'This worker group has no sources.',
  routes: 'This worker group has no routing table.',
  localSearch: 'This workspace has no Cribl Search local engines. That is the normal state, and every search in this app runs the way it always has.',
  groups: 'This Leader returned no worker groups.',
})

export type RowKey = 'lakeConfig' | 'datasets' | 'dataset' | 'searchDataset' | 'destination' | 'inputs' | 'routes' | 'localSearch' | 'groups'

/** Every row, before anything has been asked. Exported so a component can paint
 *  the table's shape on first render rather than after the first response. */
export function loadingLanding(): LandingState {
  const row = <T>(object: string): LandingRow<T> => ({ state: 'loading', value: null, object, note: null, status: null })
  return {
    lakeConfig: row(`${LAKE_ROOT}/config`),
    datasets: row(`${LAKE_ROOT}/datasets`),
    dataset: row(`${LAKE_ROOT}/datasets/${DATASET_ID}`),
    searchDataset: row(`/m/default_search/search/datasets/${DATASET_ID}`),
    destination: row(`/m/:gid/system/outputs/${DESTINATION_ID}`),
    inputs: row('/m/:gid/system/inputs'),
    routes: row('/m/:gid/routes'),
    localSearch: row('/m/default_search/search/local_search'),
    groups: row('/products/stream/groups'),
  }
}

/** Turn a client result into the row a panel renders. */
export function toRow<T>(key: RowKey, r: ReadResult<T>): LandingRow<T> {
  if (r.outcome === 'ok') return { state: 'value', value: r.value, object: r.object, note: null, status: r.status }
  if (r.outcome === 'absent') return { state: 'absent', value: null, object: r.object, note: ABSENT_NOTES[key], status: r.status }
  if (r.outcome === 'not-readable') {
    return {
      state: 'unreadable',
      value: null,
      object: r.object,
      // NAMES THE OBJECT. "Unavailable" with nothing named is the state this
      // requirement exists to prevent: the object is precisely what an admin has
      // to grant, and a sentence without it sends somebody to a support ticket.
      note: `Not readable — this account needs GET on ${r.object}.`,
      status: r.status,
    }
  }
  return { state: 'failed', value: null, object: r.object, note: r.detail ?? 'This read failed.', status: r.status }
}

export interface LandingState {
  lakeConfig: LandingRow<LakeLimits>
  datasets: LandingRow<LakeDataset[]>
  dataset: LandingRow<LakeDataset>
  searchDataset: LandingRow<SearchDataset>
  destination: LandingRow<LakeDestination>
  inputs: LandingRow<StreamInput[]>
  routes: LandingRow<StreamRoute[]>
  localSearch: LandingRow<LocalSearchTier>
  groups: LandingRow<StreamGroupInfo[]>
}

export interface ReadLandingOptions extends CapiInit {
  /**
   * Called as each row resolves, before the others have.
   *
   * THIS IS WHAT MAKES THE PER-ROW REQUIREMENT REAL. A function that only
   * returns the finished state is a per-panel state machine wearing nine fields:
   * a caller awaiting it holds all nine rows behind the slowest one, which is
   * exactly the behaviour §2.4 forbids and Preview check 1.4 throttles an
   * endpoint to catch. The return value is still the whole state, for a caller
   * that genuinely wants all of it.
   */
  onRow?: <K extends RowKey>(key: K, row: LandingState[K]) => void
}

/**
 * Read all nine, independently.
 *
 * `allSettled` and not `all`: a rejected read is a row, not an outcome for the
 * panel. Each client function already turns a status into a result, so a
 * rejection here means something threw outside them, and the row says so
 * rather than the page going blank.
 *
 * NOTHING IS WRITTEN. Not a cache, not a profile, not an audit entry — this runs
 * on mount and on Retry, and rule 2 in the header is what makes that safe.
 */
export async function readLanding(group: string, opts: ReadLandingOptions = {}): Promise<LandingState> {
  const { onRow, ...init } = opts
  const state = loadingLanding()

  const fill = <K extends RowKey>(key: K, run: Promise<ReadResult<unknown>>) =>
    run.then(
      (r) => {
        const row = toRow(key, r) as LandingState[K]
        state[key] = row
        onRow?.(key, row)
      },
      (err: unknown) => {
        const row: LandingRow<never> = {
          state: 'failed',
          value: null,
          object: state[key].object,
          note: err instanceof Error ? err.message : String(err),
          status: null,
        }
        state[key] = row as LandingState[K]
        onRow?.(key, row as LandingState[K])
      },
    )

  await Promise.allSettled([
    fill('lakeConfig', getLakeConfig(init)),
    fill('datasets', listDatasets(init)),
    fill('dataset', getDataset(init)),
    fill('searchDataset', getSearchDataset(init)),
    fill('destination', getDestination(group, init)),
    fill('inputs', listInputs(group, init)),
    fill('routes', listRoutes(group, init)),
    fill('localSearch', getLocalSearch(init)),
    fill('groups', listStreamGroupsCurrent(init)),
  ])

  return state
}

/** The partition limit this tenant reports, or the fallback — and which it was,
 *  so a refused config read never reads as permission to use three. */
export function partitionLimitsFrom(state: LandingState): { limits: PartitionLimits; measured: boolean } {
  const max = state.lakeConfig.value?.maxAcceleratedFieldsCount
  return typeof max === 'number'
    ? { limits: { maxAcceleratedFieldsCount: max }, measured: true }
    : { limits: DEFAULT_PARTITION_LIMITS, measured: false }
}

// ── What writes through the destination ─────────────────────────────────────

export interface Feed {
  /** How it is wired. The distinction is the whole point of reading two
   *  endpoints instead of one. */
  kind: 'quickconnect' | 'route'
  id: string
  /** What a confirmation calls it. */
  label: string
}

/**
 * Which feeds reach a destination, from sources AND from the routing table.
 *
 * A ROUTES-ONLY ANSWER IS WRONG, and it is wrong on the only workspace anybody
 * has measured: the DataGen source reaches Cribl Lake through a QuickConnect
 * binding on the source itself — `connections[].output` — and appears in no
 * route at all. Every destination confirmation in this phase claims "both feeds
 * move together"; built on `routes` alone it would claim one, confidently, and
 * somebody would approve a change to a delivery path they were not shown.
 *
 * Disabled routes are included and marked in the label rather than filtered out:
 * a route somebody switched off last week is still a feed that will resume, and
 * a confirmation that omitted it would be describing today rather than the
 * object.
 */
export function resolveFeeds(inputs: readonly StreamInput[], routes: readonly StreamRoute[], outputId: string): Feed[] {
  const feeds: Feed[] = []
  for (const input of inputs) {
    if (input.connectedOutputs.includes(outputId)) {
      feeds.push({ kind: 'quickconnect', id: input.id, label: `QuickConnect from source ${input.id}` })
    }
  }
  for (const route of routes) {
    if (route.output === outputId) {
      feeds.push({ kind: 'route', id: route.id, label: `route ${route.name ?? route.id}${route.disabled ? ' (disabled)' : ''}` })
    }
  }
  return feeds
}

export interface FeedsResult {
  feeds: Feed[]
  inputs: ReadResult<StreamInput[]>
  routes: ReadResult<StreamRoute[]>
  /** True when BOTH reads answered. A feed list built from one of the two is not
   *  a feed list, and a confirmation must say so rather than under-report. */
  complete: boolean
}

/** Read both sides and resolve them. Never cached: a confirmation states what is
 *  wired right now, and a list from three minutes ago is a different claim. */
export async function feedsThrough(group: string, outputId: string = DESTINATION_ID, init: CapiInit = {}): Promise<FeedsResult> {
  const [inputs, routes] = await Promise.all([listInputs(group, init), listRoutes(group, init)])
  const ins = inputs.outcome === 'ok' ? (inputs.value ?? []) : []
  const rts = routes.outcome === 'ok' ? (routes.value ?? []) : []
  return { feeds: resolveFeeds(ins, rts, outputId), inputs, routes, complete: inputs.outcome === 'ok' && routes.outcome === 'ok' }
}

// ── What a writer answers ───────────────────────────────────────────────────

export type StepStatus = 'applied' | 'skipped' | 'cancelled' | 'error'

export interface WriteStep {
  key: string
  status: StepStatus
  detail?: string
  /**
   * Cribl accepted the write and the re-read afterwards disagreed with it.
   *
   * NOT an error, and `ok` stays true: the request succeeded. It means somebody
   * else wrote the same object in between, and their value is the one in force.
   * These endpoints carry no ETag and no version, so a write cannot be made
   * conditional on what was read — re-reading afterwards is the only check
   * available, and this flag is the whole of what it produces. Phase 2's
   * `accel/provision.ts` reports the same thing the same way; the alternative,
   * retrying, would turn a race nobody can detect into one nobody can reproduce.
   */
  raced?: boolean
}

export interface WriteOutcome {
  ok: boolean
  /** The person said no. NOT an error, and never reported as one — a cancelled
   *  write is the dialog working. */
  cancelled: boolean
  /** Nothing needed changing. Also not an error. */
  noop: boolean
  steps: WriteStep[]
}

const outcome = (steps: WriteStep[]): WriteOutcome => ({
  ok: steps.length > 0 && steps.every((s) => s.status === 'applied' || s.status === 'skipped'),
  cancelled: steps.some((s) => s.status === 'cancelled'),
  noop: steps.length > 0 && steps.every((s) => s.status === 'skipped'),
  steps,
})

const isOk = (status: number) => status >= 200 && status < 300

/** A confirmation, as a writer sees it: ask, and believe only `true`. Anything
 *  else — false, a rejected promise, a dialog that unmounted — is a no. */
export type Confirm<T> = (context: T) => boolean | Promise<boolean>

async function confirmed<T>(confirm: Confirm<T>, context: T): Promise<boolean> {
  try {
    return (await confirm(context)) === true
  } catch {
    return false
  }
}

// ── What both Lake writers do around their PATCH ────────────────────────────

/**
 * Read the dataset for a writer, or say why nothing may be sent.
 *
 * THE MOST IMPORTANT FUNCTION IN THIS FILE, and it is important for what it does
 * NOT do. There is no fallback. A caller that treated a refused read as
 * permission to send just the edited field would be performing exactly the write
 * this whole read-modify-write exists to prevent, on the workspace least likely
 * to tolerate it — one where this account is already being refused something.
 * The failure step says "Nothing was sent" first, because that is the fact the
 * person needs before any of the rest of the sentence.
 *
 * Always called fresh, never from a value the panel read on mount: the config
 * plane is shared, and a dataset read three minutes ago is another admin's
 * snapshot as far as this app can tell.
 */
async function readDatasetForWrite(key: string, init: CapiInit): Promise<{ dataset: LakeDataset } | { failure: WriteStep }> {
  const live = await getDataset(init)
  if (live.outcome === 'ok' && live.value) return { dataset: live.value }

  const why =
    live.outcome === 'not-readable'
      ? `this account needs GET on ${live.object}. Changing one field means sending the whole dataset back, so a write this app cannot read first is a write that would delete everything it could not see.`
      : live.outcome === 'absent'
        ? `there is no ${DATASET_ID} dataset to change. Create it from the onboarding panel above.`
        : `the ${DATASET_ID} dataset could not be read${live.detail ? ` — ${live.detail}` : '.'}`
  return { failure: { key, status: 'error', detail: `Nothing was sent: ${why}` } }
}

/**
 * Re-read the dataset after a write and report what it actually holds.
 *
 * `unconfirmed` and `raced` are different answers and neither is a failure of
 * the write: the first means this app could not look, the second means it looked
 * and somebody else's value was there. Reporting both as "applied" with no
 * detail would be this run's optimism rather than the workspace.
 */
async function reReadDataset<T>(
  read: (dataset: LakeDataset) => T,
  expected: T,
  init: CapiInit,
): Promise<{ unconfirmed: true } | { unconfirmed: false; raced: boolean; now: T }> {
  const after = await getDataset(init)
  if (after.outcome !== 'ok' || !after.value) return { unconfirmed: true }
  const now = read(after.value)
  return { unconfirmed: false, raced: now !== expected, now }
}

/** The sentence a raced step carries. Names both values, because "somebody else
 *  wrote this" is only actionable once you can see what they wrote. */
function racedNote(sent: string, now: unknown): string {
  return (
    `Cribl accepted ${sent} and then reported ${JSON.stringify(now)}. Somebody else wrote this dataset between the change and the re-read — ` +
    `this endpoint carries no ETag and no version, so a write cannot be made conditional on what was read, and their value is the one in force. ` +
    `Nothing here retries: read the row and decide.`
  )
}

/** What a step says when the write landed and the check could not run. Not a
 *  failure, and not success reported as if it had been verified. */
const UNCONFIRMED_NOTE = 'Cribl accepted it. This app could not re-read the dataset afterwards, so nothing here has confirmed what it now holds.'

// ── Writer 1: retention ─────────────────────────────────────────────────────

export interface RetentionConfirmContext {
  change: RetentionChange
  datasetId: string
  /** The dataset's current size and the day it was measured, so a decrease can
   *  name the loss in this tenant's own terms instead of a literal. */
  sizeBytes: number | null
  metricsDate: string | null
}

/**
 * Change how long Cribl Lake keeps this dataset.
 *
 * THE ONE IRREVERSIBLE EDIT IN THIS PHASE is a DECREASE, and the classification
 * comes back in `change` so the dialog can be harder for that case: Lake datasets
 * are under no version control at all, so unlike the destination edit there is no
 * commit to revert and no deployed hash to go back to. `retentionChange` in
 * cribl/landing.ts carries the sentence; this function refuses to send anything
 * it called a problem.
 *
 * READ-MODIFY-WRITE, per rule 4 and the header's A-SP23 note. The dataset is
 * read HERE, the edited field is overlaid onto what came back, and the whole
 * body goes out — which is right whether or not this endpoint is partial. If the
 * read is refused, nothing is sent at all; a one-field PATCH after a failed read
 * is the destructive case, not the degraded one.
 */
export async function setRetention(
  days: number,
  opts: { current: number; dataset?: LakeDataset | null; confirm: Confirm<RetentionConfirmContext>; init?: CapiInit },
): Promise<WriteOutcome> {
  const init = opts.init ?? {}
  // Refuse a value Cribl Lake would refuse BEFORE spending the read. This check
  // depends only on `days`, so the panel's `current` is good enough for it.
  const proposed = retentionChange(opts.current, days)
  if (proposed.problems.length > 0) return outcome([{ key: 'retention', status: 'error', detail: proposed.problems.join(' ') }])

  const live = await readDatasetForWrite('retention', init)
  if ('failure' in live) return outcome([live.failure])
  const dataset = live.dataset

  // Classified against the LIVE value, not the panel's. `opts.current` was read
  // when the panel last refreshed; if another admin has changed retention since,
  // a no-op decided on that number reports "already this value" about a dataset
  // that says something else, and a decrease would be measured from the wrong
  // starting point in the one confirmation that has to be exact.
  const change = retentionChange(dataset.retentionPeriodInDays ?? opts.current, days)
  if (change.direction === 'none') return outcome([{ key: 'retention', status: 'skipped', detail: 'Retention is already this value.' }])

  const proceed = await confirmed(opts.confirm, {
    change,
    datasetId: DATASET_ID,
    // From the read this function just made, falling back to whatever the panel
    // was given. Both carry the day the snapshot was computed, so neither can be
    // rendered as a claim about right now.
    sizeBytes: dataset.metrics?.currentSizeBytes ?? opts.dataset?.metrics?.currentSizeBytes ?? null,
    metricsDate: dataset.metrics?.metricsDate ?? opts.dataset?.metrics?.metricsDate ?? null,
  })
  if (!proceed) return outcome([{ key: 'retention', status: 'cancelled' }])

  const body = applyDatasetEdit({ ...dataset.raw }, { retentionPeriodInDays: days })
  const r = await capi('PATCH', `${LAKE_ROOT}/datasets/${DATASET_ID}`, body, init)
  const step: WriteStep = isOk(r.status)
    ? { key: 'retention', status: 'applied', detail: `${change.from} → ${change.to} days` }
    : { key: 'retention', status: 'error', detail: errText(r) }

  if (step.status === 'applied') {
    const check = await reReadDataset((d) => d.retentionPeriodInDays, days, init)
    if (check.unconfirmed) step.detail = `${step.detail} — ${UNCONFIRMED_NOTE}`
    else if (check.raced) {
      step.raced = true
      step.detail = racedNote(`${change.from} → ${change.to} days`, check.now)
    }
  }
  void audit('lake_landing.retention', { dataset: DATASET_ID, before: change.from, after: change.to, step })
  return outcome([step])
}

// ── Writer 2: description ───────────────────────────────────────────────────

export interface DescriptionConfirmContext {
  datasetId: string
  before: string | null
  after: string
}

/**
 * Change the dataset's description.
 *
 * The smallest write in the phase, and the reason it is here at all: it is the
 * only Lake field a customer can change whose worst outcome is cosmetic, which
 * makes it the one an admin can safely use to find out whether they are allowed
 * to write to Lake at all — before they try it on retention. It is confirmed like
 * everything else, because it still overwrites a field on a shared object.
 *
 * AND IT IS A READ-MODIFY-WRITE FOR THE SAME REASON THE RETENTION ONE IS. The
 * field being changed is cosmetic; the body it rides in is not. Under the
 * replacement reading of this endpoint, a one-field `{description}` PATCH is the
 * cheapest possible way to delete a dataset's retention and partitions — which
 * would make the "safe one to try first" the most dangerous button on the panel.
 */
export async function setDescription(
  description: string,
  opts: { current: string | null; confirm: Confirm<DescriptionConfirmContext>; init?: CapiInit },
): Promise<WriteOutcome> {
  const init = opts.init ?? {}
  const after = description.trim()
  if (!after) return outcome([{ key: 'description', status: 'error', detail: 'A description with no text in it.' }])

  const live = await readDatasetForWrite('description', init)
  if ('failure' in live) return outcome([live.failure])
  const dataset = live.dataset

  // Against the live description, for the reason `setRetention` gives: the
  // panel's copy may be somebody else's stale snapshot, and "already says this"
  // has to be a fact about the dataset rather than about this session.
  const before = dataset.description ?? opts.current
  if (after === (dataset.description ?? '')) {
    return outcome([{ key: 'description', status: 'skipped', detail: 'The description already says this.' }])
  }

  const proceed = await confirmed(opts.confirm, { datasetId: DATASET_ID, before, after })
  if (!proceed) return outcome([{ key: 'description', status: 'cancelled' }])

  const body = applyDatasetEdit({ ...dataset.raw }, { description: after })
  const r = await capi('PATCH', `${LAKE_ROOT}/datasets/${DATASET_ID}`, body, init)
  const step: WriteStep = isOk(r.status)
    ? { key: 'description', status: 'applied' }
    : { key: 'description', status: 'error', detail: errText(r) }

  if (step.status === 'applied') {
    const check = await reReadDataset((d) => d.description, after, init)
    if (check.unconfirmed) step.detail = UNCONFIRMED_NOTE
    else if (check.raced) {
      step.raced = true
      step.detail = racedNote('the new description', check.now)
    }
  }
  void audit('lake_landing.description', { dataset: DATASET_ID, before, after, step })
  return outcome([step])
}

// ── Writer 3: the destination, and the commit and deploy that ride with it ──

export interface DestinationConfirmContext {
  group: string
  destinationId: string
  /** Exactly what changes, key by key, computed from the GET this writer just
   *  made — not from the state the panel was rendered with. */
  diff: DiffRow[]
  /** Everything that writes through it, from sources AND routes. */
  feeds: Feed[]
  /** False when one of the two feed reads was refused, so the dialog can say the
   *  list may be short instead of presenting it as complete. */
  feedsComplete: boolean
  /** Every pending change to this group's config that the commit will carry —
   *  including somebody else's. */
  pendingFiles: string[]
}

/**
 * Apply a destination edit, then commit and deploy it.
 *
 * ONE INTENT, ONE CONFIRMATION (§1.5 rule 7). The PATCH is useless without the
 * commit and the commit is useless without the deploy, so chaining three dialogs
 * would only teach somebody to click through them. The single dialog therefore
 * has to carry everything: the diff, both feeds, the pending-file count, and the
 * fact that deploying restarts Worker Processes.
 *
 * READ-MODIFY-WRITE, and the read is inside this function on purpose. A Stream
 * destination PATCH is a full replacement, so the body sent is the live object
 * with the edit applied; computing the diff from a body the panel read a minute
 * ago would show somebody a diff against a destination that has since changed.
 */
export async function updateDestination(
  group: string,
  edit: DestinationEdit,
  opts: { confirm: Confirm<DestinationConfirmContext>; message?: string; init?: CapiInit },
): Promise<WriteOutcome> {
  const init = opts.init ?? {}
  const live = await getDestination(group, init)
  if (live.outcome !== 'ok' || !live.value) {
    return outcome([{ key: 'destination', status: 'error', detail: live.detail ?? `Could not read ${DESTINATION_ID} in group ${group}.` }])
  }

  const current = { ...live.value.raw } as Record<string, unknown>
  const diff = diffDestination(current, edit)
  if (diff.length === 0) {
    return outcome([{ key: 'destination', status: 'skipped', detail: 'These settings already match the live destination.' }])
  }

  const [feeds, pending] = await Promise.all([feedsThrough(group, DESTINATION_ID, init), pendingConfigFiles(init)])
  const files = destinationCommitFiles(group, pending)

  const proceed = await confirmed(opts.confirm, {
    group,
    destinationId: DESTINATION_ID,
    diff,
    feeds: feeds.feeds,
    feedsComplete: feeds.complete,
    pendingFiles: pending,
  })
  if (!proceed) return outcome([{ key: 'destination', status: 'cancelled' }])

  const body = applyDestinationEdit(current, edit)
  const r = await capi('PATCH', groupPath(group, `/system/outputs/${DESTINATION_ID}`), body, init)
  const patched: WriteStep = isOk(r.status)
    ? { key: 'destination', status: 'applied', detail: diff.map((d) => d.key).join(', ') }
    : { key: 'destination', status: 'error', detail: errText(r) }

  const steps = [patched]
  if (patched.status === 'applied') {
    steps.push(...(await commitAndDeployDestination(group, files, opts.message ?? destinationCommitMessage(group, diff), init)))
  }
  void audit('lake_landing.destination', { group, destination: DESTINATION_ID, diff, steps })
  return outcome(steps)
}

/**
 * Commit exactly this group's `outputs.yml` and deploy the result.
 *
 * SEPARATE FROM THE PATCH, and separately declared in cribl/authz.ts, because a
 * Member can be refused here having succeeded there — the gate in this app is
 * retrospective, so a multi-object intent can end half applied. That state is the
 * most likely real failure of this phase in a customer's hands, and the only
 * thing standing between the admin and a mystery is the step list this returns.
 *
 * ALWAYS AN EXPLICIT FILE LIST. Cribl's commit API commits every pending change
 * in the repository when given none, so an empty list would sweep up whatever
 * else anybody had left uncommitted, anywhere.
 *
 * `trail` IS OFF BY DEFAULT AND THE RETRY PATH TURNS IT ON. Called from
 * `updateDestination` this is one leg of an intent that writes its own entry
 * carrying these very steps, and a second entry would report one press twice.
 * Called on its own — the panel's "Retry failed only", which exists precisely
 * because the PATCH landed and the commit did not — nothing else is recording
 * anything, and that half-applied state is the one §1.5 rule 9 most wants a
 * trail of. It was missing until the Phase 3 settling pass: the recovery from
 * the phase's likeliest real failure left no record that it had been attempted.
 */
export async function commitAndDeployDestination(
  group: string,
  files: string[],
  message: string,
  init: CapiInit = {},
  trail = false,
): Promise<WriteStep[]> {
  const record = (steps: WriteStep[]): WriteStep[] => {
    if (trail) void audit('lake_landing.destination.retry', { group, destination: DESTINATION_ID, files, steps })
    return steps
  }
  if (files.length === 0) {
    return record([
      { key: 'commit', status: 'skipped', detail: 'Cribl reports no pending change to this group’s outputs.yml.' },
    ])
  }

  const commit = await capi('POST', '/version/commit', { message, files }, init)
  if (!isOk(commit.status)) return record([{ key: 'commit', status: 'error', detail: errText(commit) }])

  const body = commit.body as { items?: Array<{ commit?: string }>; commit?: string }
  const hash = body?.items?.[0]?.commit ?? body?.commit
  if (!hash) {
    return record([
      { key: 'commit', status: 'skipped', detail: 'Cribl committed nothing — there was no net change to write.' },
    ])
  }
  const steps: WriteStep[] = [{ key: 'commit', status: 'applied', detail: `${files.length} file${files.length === 1 ? '' : 's'} · ${hash.slice(0, 10)}` }]

  const deployed = await deployGroupConfig(group, hash, init)
  steps.push(
    isOk(deployed.status)
      ? { key: 'deploy', status: 'applied', detail: hash.slice(0, 10) }
      : { key: 'deploy', status: 'error', detail: errText(deployed) },
  )
  return record(steps)
}

/**
 * Push the committed configuration to the group's running Workers.
 *
 * THIS RESTARTS THAT GROUP'S WORKER PROCESSES. The 404 fallback to the
 * deprecated `/master/groups` path is copied from provision.ts and copied for
 * its reasoning too: ONLY on 404, which is the single status that means "this
 * Leader does not have that route". Never on 403 — a second path cannot grant a
 * permission — and never on 5xx, because a 5xx deploy may already have started
 * server-side and a blind retry is a second deploy.
 */
async function deployGroupConfig(group: string, hash: string, init: CapiInit) {
  const body = { version: hash }
  const r = await capi('PATCH', `/products/stream/groups/${group}/deploy`, body, init)
  if (r.status !== 404) return r
  return capi('PATCH', `/master/groups/${group}/deploy`, body, init)
}

/** Everything Cribl currently sees as uncommitted, anywhere in the repo. Read
 *  before the confirmation so the dialog can say how much rides along. */
export async function pendingConfigFiles(init: CapiInit = {}): Promise<string[]> {
  const r = await capi('GET', '/version/status', undefined, init)
  const entries = (r.body as { items?: Array<{ files?: Array<{ path?: string }>; created?: string[]; deleted?: string[]; modified?: string[]; not_added?: string[]; staged?: string[] }> })?.items ?? []
  const out = new Set<string>()
  for (const it of entries) {
    for (const f of it.files ?? []) if (f.path) out.add(f.path)
    for (const arr of [it.created, it.deleted, it.modified, it.not_added, it.staged]) for (const p of arr ?? []) out.add(p)
  }
  return [...out]
}

/**
 * The pending paths this edit is allowed to commit.
 *
 * Matched against what Git actually reports, so the list can never name a path
 * the commit call would reject — and scoped to this group's `outputs.yml`, so
 * another group's pending work is left where it is. When the status read gives
 * nothing at all, the constructed path is the best effort, and the caller finds
 * out it was a guess because the commit answers "nothing to commit".
 */
export function destinationCommitFiles(group: string, pending: readonly string[]): string[] {
  const marker = 'local/cribl/outputs.yml'
  const inGroup = (p: string) => p.includes(`groups/${group}/`) || !p.includes('groups/')
  const selected = pending.filter((p) => inGroup(p) && p.includes(marker))
  if (selected.length > 0) return selected
  return pending.length === 0 ? [`groups/${group}/local/cribl/outputs.yml`] : []
}

/** The message somebody reading `git log` on the Leader will see — who did what
 *  to which object, without having ever heard of this app. */
export function destinationCommitMessage(group: string, diff: readonly DiffRow[]): string {
  const keys = diff.map((d) => d.key).join(', ')
  return `Gigamon Network Observability: update Cribl Lake destination ${DESTINATION_ID} in group ${group} (${keys})`
}

// ── The profile document ────────────────────────────────────────────────────

/**
 * Where the chosen landing is stored.
 *
 * `app/settings/lake_landing`, NOT §2.4's `lake_landing/profile`. CLAUDE.md and
 * §1.4 document three key shapes — `app/settings/<name>` install-wide,
 * `<ns>/prefs/<userId>` per viewer, `<ns>/log/<epochMs>` append-only — and
 * `lake_landing/profile` is a fourth that nothing else in the app uses. A landing
 * profile is a property of the install and not of the viewer, so it takes the
 * install-wide shape, and `app/settings/search_caps` is the precedent it follows.
 *
 * ONE WRITER. `saveLandingProfile` rewrites the whole document every time, which
 * is only safe because nothing else writes it — cribl/prefs.ts already
 * demonstrates what a second writer's field costs on a whole-document rewrite.
 */
export const LANDING_PROFILE_KEY = 'app/settings/lake_landing'

/**
 * The stored profile, or null.
 *
 * Null covers absent, unreachable and corrupt, and all three get the same
 * answer on purpose: the live Cribl objects are authoritative, so a missing
 * profile costs nothing but a pre-filled form. A corrupt document is NOT
 * repaired here — the repair would be a write on load, which AGENTS.md forbids;
 * the next press overwrites it.
 */
export async function readLandingProfile(signal?: AbortSignal): Promise<LandingProfile | null> {
  return getDoc<LandingProfile>(LANDING_PROFILE_KEY, signal)
}

/**
 * Store it. Answers false when the store refused, which is what a panel has to
 * say instead of "saved".
 *
 * Only ever called as the consequence of a press — a chosen setting, or a
 * measurement somebody paid for. The measurement is the interesting caller:
 * persisting it is what stops a reload re-spending the credits, and writing it
 * anywhere automatic would be the spend-on-load this rule exists to prevent.
 */
export async function saveLandingProfile(profile: LandingProfile): Promise<boolean> {
  return putDoc(LANDING_PROFILE_KEY, profile)
}

// ── The capability flags, and why every one of them is `unknown` ────────────

export type CapabilityId =
  | 'destinationWritesParquetIntoJsonDataset'
  | 'mixedReadWorks'
  | 'datasetFormatPatchable'
  | 'lakeSearchConfigPropagates'
  | 'datasetPatchIsPartial'
  | 'gidPlaceholderHonoured'

/** What is known about one thing this app would like to do. */
export interface Capability {
  /** `null` means nobody has measured it. It is never inferred from a document. */
  answer: boolean | null
  /** Who would have to measure it. */
  spike: SpikeId | 'V-S0' | 'V-S11' | 'Preview 3.1'
  /** The question, in the terms the measurement would answer. */
  question: string
  /** What this app does while the answer is null. */
  meanwhile: string
}

/**
 * Everything this phase is built on that nobody has checked.
 *
 * THE VALUES ARE ALL `null` AND THAT IS THE DELIVERABLE. The design specified
 * these as "constants set from the spike results"; the spikes have not run, so
 * the honest constant is "unknown" and the code above is written to hold without
 * any of them. Setting one to `true` because the spec implies it is how an
 * inference becomes a fact that nothing can dislodge — and two of these
 * inferences, if wrong, cost a customer data.
 *
 * Whoever runs a spike changes ONE value here and reads the `meanwhile` line to
 * find what it unlocks. Nothing branches on these today; they are the written
 * form of what §2.4 could not settle, kept beside the code that would use them
 * rather than in a document the code cannot see.
 */
export const CAPABILITIES: Readonly<Record<CapabilityId, Capability>> = Object.freeze({
  datasetPatchIsPartial: {
    answer: null,
    spike: 'Preview 3.1',
    question:
      'Does PATCH on a Lake dataset update only the fields it is given, or does it replace the object and drop everything omitted? Claim C6 says partial, inferred from the spec’s example bodies and nothing else.',
    meanwhile:
      'NOTHING DEPENDS ON THE ANSWER ANY MORE, which is why this one is worth reading twice. setRetention and setDescription GET the dataset, overlay the one edited field and PATCH the whole body back, so they are correct under either semantics — a partial endpoint is handed values it already holds, a replacing one is handed everything. This flag is now evidence about the API, not a load-bearing assumption. It stays null because nobody has measured it, and Preview 3.1 (a 30 → 30 no-op, then a full re-read and diff) still has to run: it no longer decides whether the phase is safe, it confirms this app kept the dataset whole.',
  },
  lakeSearchConfigPropagates: {
    answer: null,
    spike: 'P-S5',
    question:
      'Does a searchConfig written on the Lake dataset reach Cribl Search, or does the reader have to be changed through a full replacement of the Search-side dataset instead? Two candidate request shapes exist and neither has been sent.',
    meanwhile:
      'No reader toggle is built. Both sides are read and shown separately so a person can see whether they agree; config/policies.yml declares GET on the Search-side dataset and no PATCH, because declaring a write before the spike says it is needed asks for trust the app cannot use.',
  },
  mixedReadWorks: {
    answer: null,
    spike: 'P-S5',
    question: 'Can Federated Search v2 read a dataset holding both .parquet and .json.gz objects, and does `source` survive on Parquet rows?',
    meanwhile: 'pathFilterRows() builds the two-row filter the answer would need, and nothing calls it against a live dataset.',
  },
  destinationWritesParquetIntoJsonDataset: {
    answer: null,
    spike: 'P-S5',
    question: 'Does a Cribl Lake destination set to Parquet write Parquet objects into a dataset still labelled format:json, and what are those objects called?',
    meanwhile: 'destinationSpec() can produce the Parquet body; this phase never sends one. The format change is Phase 4’s migration, not an editor here.',
  },
  datasetFormatPatchable: {
    answer: null,
    spike: 'P-S5',
    question: 'Does the Lake API accept a format change on an existing dataset, or is format fixed at creation as the memory file used to say?',
    meanwhile: 'Nothing in this phase sends `format`. datasetSpec() carries it for the creation path only.',
  },
  gidPlaceholderHonoured: {
    answer: null,
    spike: 'V-S11',
    question:
      'Does the app fetch-proxy match a `/m/:gid/…` policy object the way this app assumes? Every caller on the measured workspace was org_admin + ws_admin, and an admin never exercises the matcher at all.',
    meanwhile:
      'Every declared object names each segment it needs and the file contains no `*`, so the declaration means the same thing under either reading of a rule AGENTS.md does not state.',
  },
})

/** One audit entry per completed write, in the app's single trail. Never
 *  awaited: a lost trail entry must not turn a successful deploy into a reported
 *  failure, and the outcome the user is told about is in `steps` either way. */
function audit(action: string, fields: Record<string, unknown>): void {
  void appendLog('gigamon', { action, ...fields })
}
