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
// ── AND WHY THEY GET IT TWICE: THE DIALOG IS THE WINDOW ─────────────────────
// The first version of that read-modify-write had a defect worse than the one
// it closed, and it is worth reading slowly, because it is invisible in every
// test that does not stage two admins.
//
// The sequence was GET → confirm → merge onto the GET → PATCH, and the
// confirmation in the middle is USER-PACED AND UNBOUNDED: it parks on a Modal
// until somebody answers, and a retention DECREASE additionally requires typing
// the dataset id. Minutes are ordinary. So the body merged onto was the dataset
// as it looked BEFORE the dialog opened. Admin A presses Apply; admin B — or A's
// own second tab, or anything else on this shared config plane — changes the
// description, the partitions, `searchConfig` or the storage binding; A clicks
// Yes; the PATCH writes A's pre-dialog values for all of those back over B's.
// B's change is gone, silently, under a success toast. That is loss under EITHER
// PATCH semantics, and under the partial reading it is strictly WORSE than the
// one-field PATCH it replaced, which could not touch those keys at all.
// `readDatasetForWrite` below states the rule the code then broke: a dataset
// read three minutes ago is another admin's snapshot as far as this app can tell.
//
// So the sequence is now GET → confirm → GET AGAIN → COMPARE → merge onto the
// SECOND read → PATCH. The second read is the merge source and nothing earlier
// may be merged from; a failed second read aborts exactly as a failed first one
// does. If anything moved between the two reads, NOTHING IS SENT and the step
// names what moved — not a silent re-merge, because the person approved a dialog
// describing a dataset that no longer exists, and re-merging would apply their
// approval to a different change than the one they read.
//
// ── AND THE FIELD BEING EDITED IS PART OF "ANYTHING" ────────────────────────
// The first version of that comparison EXCLUDED the edited key, reasoning that
// another admin setting retention to the value you are setting is a no-op rather
// than a conflict. That is true of exactly one move — the move TO THE TARGET —
// and the exclusion covered every other move with it, which opened a hole worse
// than the one the comparison closed.
//
// Live 30. Admin A presses Apply for 60 and reads a dialog saying "raise
// retention from 30 to 60 days — nothing is deleted by an increase", which
// carries no irreversibility warning and no typed confirmation, because an
// increase needs neither. Admin B sets 365. A clicks Yes. The PATCH sends 60 and
// CRIBL LAKE DELETES 305 DAYS of the customer's events — irreversibly, under a
// sentence that promised the opposite, past the one gate this app built for
// exactly this write. The step then reported "30 → 60 days" and the audit
// recorded `before: 30`; both were false records of a destructive act.
//
// THE RULE, which is general and is not about retention: A CONFIRMATION
// DESCRIBES A SPECIFIC before → after, AND IF `before` MOVES WHILE THE DIALOG IS
// OPEN THE CONFIRMATION IS VOID — because the sentence that was read, and the
// gates that sentence carried, were both derived from a value that is no longer
// true. Only a move TO THE TARGET is a genuine no-op. `confirmationStillHolds`
// in cribl/landing.ts is that rule; both Lake writers run it, and so does the
// destination writer, which shows a `before` in every row of its diff.
//
// AND THE ANSWER IS ALWAYS REFUSE, NEVER RE-PROMPT. Re-deriving a new
// confirmation from a dialog somebody has already dismissed spends their answer
// on a question they were not asked, which is the failure this whole sequence
// has been chasing. They are told what the value was when they were asked, what
// it is now, and that nothing was sent.
//
// WHAT IT COSTS: THREE GETs PER APPLIED EDIT — one to classify the change and
// fill the dialog, one to merge onto after the answer, one to re-read afterwards
// and report a value somebody else wrote. Against that: the alternative is
// silently reverting another admin's work, on a dataset under no version control
// with no commit to revert. A config-plane edit behind a typed confirmation is
// not a hot path, and the two extra GETs are not on any render or timer — they
// happen once, on a press somebody already sat through a dialog for.
//
// THE THIRD WRITER IS CLOSED THE SAME WAY, ON A DIFFERENT COMPARISON.
// `updateDestination` also reads twice, but it compares the DIFF rather than the
// body: `diffDestination` against the first read and against the second, and it
// refuses unless the change somebody approved is the change that would now be
// applied. That needs no equivalent of `DATASET_READONLY_KEYS` — which is what
// held it open, since nothing here knows which keys a Stream output moves on its
// own — because a server-derived field moving changes no diff row, and anything
// that changes a row is by construction something this app showed them. The
// merge is still onto the second read, so a key nobody recognises that moved in
// between is carried forward rather than reverted.
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
  confirmationStillHolds,
  datasetMergeDrift,
  diffDestination,
  retentionChange,
  sameDiff,
  DEFAULT_PARTITION_LIMITS,
  type ConfirmationCheck,
  type DestinationEdit,
  type DiffRow,
  type DriftRow,
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
 * The body to PATCH, read AFTER the confirmation answered true — or the reason
 * nothing may be sent.
 *
 * THIS IS THE FUNCTION THAT CLOSES THE STALE-MERGE WINDOW, and the ordering is
 * the whole of it: the caller's first read classified the change and filled the
 * dialog, and is now minutes old; this read is the merge source, and nothing
 * earlier is merged from anywhere in this module.
 *
 * THREE WAYS IT REFUSES, AND NONE OF THEM IS A FALLBACK:
 *
 *   * THE READ FAILED. Same answer as a failed first read, same sentence, for
 *     the same reason — sending the edited field on its own after a read this
 *     app was refused is the destructive case, not the degraded one.
 *   * THE FIELD BEING EDITED MOVED, to anything but the value being set. The
 *     confirmation is VOID: the sentence the person read, and the gates that
 *     sentence carried, were both derived from a `before` that is no longer
 *     true. See `confirmationStillHolds` in cribl/landing.ts — this is the check
 *     that stops an approved increase arriving as a deletion.
 *   * ANY OTHER KEY MOVED. The person approved a dialog describing a dataset
 *     that no longer exists. It is NOT re-merged and sent: their approval was
 *     for the change they read, and applying it to a different one is the
 *     consent this dialog exists to obtain being spent on something else. They
 *     are told what moved and can look and try again — which is a decision a
 *     person can make and this function cannot.
 *
 * AND ONE WAY IT STOPS WITHOUT REFUSING: the field moved to EXACTLY the value
 * this write would set. Somebody else already applied the approved change, so
 * there is nothing left to send and nothing to warn anybody about. `skipped`,
 * not `error`.
 *
 * THE ORDER OF THE TWO COMPARISONS IS DELIBERATE. `confirmationStillHolds` runs
 * first, because `datasetMergeDrift` cannot see the edited key at all and a
 * retention that went 30 → 365 would otherwise be reported as "the description
 * changed" — the least dangerous of the two moves named, and the other one
 * silent. `datasetMergeDrift` in cribl/landing.ts decides which keys the second
 * comparison covers and which are ignored as server-derived; the reasoning is
 * there, beside the `DATASET_READONLY_KEYS` list it is built out of, along with
 * why its exclusion of the edited key is only safe because of the check here.
 */
async function mergeSourceAfterConfirm(
  key: string,
  before: LakeDataset,
  edit: Record<string, unknown>,
  approved: ApprovedBefore,
  init: CapiInit,
): Promise<{ body: Record<string, unknown> } | { stop: WriteStep }> {
  const live = await readDatasetForWrite(key, init)
  if ('failure' in live) return { stop: live.failure }

  const still = confirmationStillHolds(approved.shown, approved.now(live.dataset), approved.target)
  if (still.verdict === 'noop') return { stop: { key, status: 'skipped', detail: approved.alreadyThere } }
  if (still.verdict === 'void') return { stop: { key, status: 'error', detail: voidNote(approved, still) } }

  const drift = datasetMergeDrift({ ...before.raw }, { ...live.dataset.raw }, edit)
  if (drift.length > 0) return { stop: { key, status: 'error', detail: driftNote(drift) } }

  return { body: applyDatasetEdit({ ...live.dataset.raw }, edit) }
}

/**
 * What the writer told the person, in the terms the second read can be checked
 * against.
 *
 * `shown` is not "the value at the time of the first read" — it is the value the
 * DIALOG NAMED, which is what the person's answer is an answer about. For
 * retention that is `change.from`, which is what the sentence and the gates were
 * built out of; for the description it is the `before` the dialog rendered and
 * the audit trail will record. Deriving it from anything else would check a
 * different claim than the one that was made.
 */
interface ApprovedBefore {
  /** The `before` the dialog named. */
  shown: unknown
  /** The same field, out of the read taken after the answer. */
  now: (live: LakeDataset) => unknown
  /** What this write would set it to. */
  target: unknown
  /** What the field is called in a sentence. */
  label: string
  /** What is at stake in this particular field having moved. */
  stakes: string
  /** The sentence for the one genuine no-op: somebody else set the target. */
  alreadyThere: string
}

/** The sentence a VOIDED confirmation carries. It has to say three things and
 *  they are all facts rather than advice: what the value was when they were
 *  asked, what it is now, and that nothing was sent. */
function voidNote(approved: ApprovedBefore, check: ConfirmationCheck): string {
  const was = JSON.stringify(check.shown) ?? 'absent'
  const now = JSON.stringify(check.now) ?? 'absent'
  return (
    `Nothing was sent: that confirmation said the ${DATASET_ID} dataset's ${approved.label} was ${was}, and it is ${now} now — somebody ` +
    `changed it while the dialog was open. A confirmation describes one before → after, so this one is void rather than stale: ${approved.stakes} ` +
    `Nothing here re-asks either, because the dialog that would be re-derived is one you have already dismissed. Look at the dataset and decide again.`
  )
}

/** The sentence a refused write carries. Names the keys AND both values: "it
 *  changed" is not actionable until you can see what it changed to, and the
 *  person is being asked to look and decide rather than to retry blindly. */
function driftNote(drift: readonly DriftRow[]): string {
  const moved = drift
    .map((d) => `${d.key} (${JSON.stringify(d.before) ?? 'absent'} → ${JSON.stringify(d.after) ?? 'absent'})`)
    .join(', ')
  return (
    `Nothing was sent: the ${DATASET_ID} dataset changed while that confirmation was open — ${moved}. ` +
    `Changing one field means sending the whole dataset back, so applying what you approved would write the values you were shown ` +
    `back over somebody else's. This endpoint carries no ETag and no version, so there is no way to make the write conditional and no ` +
    `way to merge the two safely. Nothing here retries: look at the dataset and try again.`
  )
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

  // THE MERGE SOURCE IS READ HERE, AFTER THE ANSWER — never `dataset`, which is
  // the body that filled the dialog and is as old as the dialog was open. A
  // typed-confirmation decrease can sit here for minutes.
  //
  // AND RETENTION ITSELF IS RE-CHECKED AGAINST THAT READ, which is the one thing
  // `datasetMergeDrift` structurally cannot do. `change` above decided both what
  // the dialog SAID and which gates it carried: an increase renders "Reversible
  // — nothing is deleted by an increase" and demands nothing typed. If the live
  // value moved past `days` while that dialog was open, the increase somebody
  // approved is now a DECREASE, and sending it deletes the difference under a
  // sentence that promised it would not and without the gate built for it.
  const edit = { retentionPeriodInDays: days }
  const merge = await mergeSourceAfterConfirm(
    'retention',
    dataset,
    edit,
    {
      // `change.from`, not the raw field: it is what the dialog put on screen,
      // it is what `change.direction` was computed from, and it is what the step
      // and the audit entry below report. Checking anything else would confirm a
      // claim nobody was shown.
      shown: change.from,
      now: (live) => live.retentionPeriodInDays ?? opts.current,
      target: days,
      label: 'retention',
      stakes:
        `the sentence you read and the gates it carried were both derived from ${change.from} days, so an increase approved against ` +
        `${change.from} can be a deletion against what is there now — arriving without the typed confirmation a decrease demands.`,
      alreadyThere: `Nothing was sent: somebody else set retention to ${days} days while that confirmation was open, which is the value you asked for.`,
    },
    init,
  )
  if ('stop' in merge) return outcome([merge.stop])

  const r = await capi('PATCH', `${LAKE_ROOT}/datasets/${DATASET_ID}`, merge.body, init)
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
  // `change.from` IS RE-CONFIRMED BY THE TIME EITHER OF THESE IS WRITTEN. Every
  // path that could reach here with a `from` the dataset had already stopped
  // moved past — `mergeSourceAfterConfirm` returns a `stop` and this function
  // returns above it. That matters twice over: the step detail is what the
  // person reads, and the audit entry is the only record that this press
  // happened at all, so a `before` that was true before the dialog and false
  // when the PATCH went out would be a false record of a destructive act, which
  // is worse than no record.
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

  // Same window, same close. The field is cosmetic; the body it rides in carries
  // retention, partitions and the storage binding, so merging onto a pre-dialog
  // read here reverts somebody else's retention change with a typo fix.
  //
  // AND THE SAME RULE ABOUT `before`. Nothing is deleted by a description, so
  // the stakes are smaller than retention's — but the dialog shows a `before`,
  // the audit trail records it, and a replacement approved against one set of
  // words is not an approval to overwrite a different set. The rule is general
  // and is applied generally rather than at the one field that can destroy data.
  const merge = await mergeSourceAfterConfirm(
    'description',
    dataset,
    { description: after },
    {
      shown: before,
      now: (live) => live.description ?? opts.current,
      target: after,
      label: 'description',
      stakes: 'the words you approved were approved as a replacement for what was on the dataset then, not for what somebody has put there since.',
      alreadyThere: 'Nothing was sent: somebody else set the description to these words while that confirmation was open.',
    },
    init,
  )
  if ('stop' in merge) return outcome([merge.stop])

  const r = await capi('PATCH', `${LAKE_ROOT}/datasets/${DATASET_ID}`, merge.body, init)
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
  // `before` is re-confirmed here for the reason `setRetention` spells out: the
  // only path that reaches this line is one where the second read agreed with it.
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
  /**
   * The paths this commit will carry, WHOLE.
   *
   * One entry, this group's `outputs.yml`, and it is constructed rather than
   * read: the file the PATCH is about to dirty cannot appear in a Git status
   * taken before the PATCH, which is the defect the doc comment this replaces
   * used to encode. It said "Every pending change to this group's config that
   * the commit will carry — including somebody else's", and it was wrong about
   * both halves: the value it described was repo-wide (no group filter), and
   * the commit's real list is `destinationCommitFiles`, filtered to one file.
   * So the dialog named `inputs.yml` as carried when it is not, and could not
   * name `outputs.yml` as carried when it is.
   *
   * `outputs.yml` holds EVERY destination in the group, so "carries this file"
   * means "carries anybody else's uncommitted destination work in it too".
   * That is a property of the file and of `POST /version/commit` taking paths,
   * not of any read, so no re-read makes it go away and the copy says it flat.
   */
  commitFiles: string[]
  /**
   * What Git reports uncommitted ELSEWHERE — repo-wide, minus `commitFiles`.
   * These are left where they are; the commit names its own paths and Cribl
   * commits only those. Separate from `commitFiles` because a dialog that
   * merges the two lists either over-names or under-names, and this app has
   * shipped both.
   *
   * As old as the dialog has been open, and it is only ever used to say what
   * is NOT being committed, so staleness here cannot mislead about the write.
   */
  otherPending: string[]
}

/**
 * The destination body to build the PATCH from, read AFTER the answer — or the
 * reason nothing may be sent.
 *
 * The counterpart of `mergeSourceAfterConfirm`, and it refuses on a different
 * comparison for the reason written at `updateDestination`: diffs rather than
 * bodies, so that no list of server-derived keys has to be guessed at.
 *
 * A FAILED SECOND READ SENDS NOTHING, exactly as a failed first one does. There
 * is no fallback to `current`, which is sitting right there — that fallback is
 * the stale merge this function exists to prevent, arriving as a convenience on
 * the workspace least likely to tolerate it.
 */
async function destinationMergeSourceAfterConfirm(
  group: string,
  edit: DestinationEdit,
  approved: readonly DiffRow[],
  init: CapiInit,
): Promise<{ current: Record<string, unknown> } | { stop: WriteStep }> {
  const live = await getDestination(group, init)
  if (live.outcome !== 'ok' || !live.value) {
    return {
      stop: {
        key: 'destination',
        status: 'error',
        detail:
          `Nothing was sent: ${DESTINATION_ID} in group ${group} could not be read again after that confirmation` +
          `${live.detail ? ` — ${live.detail}` : '.'} A destination PATCH is a full replacement, so a write this app cannot read first is a ` +
          `write that would delete everything it could not see.`,
      },
    }
  }

  const current = { ...live.value.raw } as Record<string, unknown>
  const now = diffDestination(current, edit)
  if (now.length === 0) {
    return {
      stop: {
        key: 'destination',
        status: 'skipped',
        detail: `Nothing was sent: somebody applied these settings to ${DESTINATION_ID} while that confirmation was open, so there is nothing left to change.`,
      },
    }
  }
  if (!sameDiff(approved, now)) {
    return { stop: { key: 'destination', status: 'error', detail: destinationDiffMovedNote(group, approved, now) } }
  }
  return { current }
}

/** The sentence a refused destination write carries. Both diffs, in the same
 *  words the dialog used, because "it changed" is not actionable until you can
 *  see the change you approved beside the one that would go out. */
function destinationDiffMovedNote(group: string, approved: readonly DiffRow[], now: readonly DiffRow[]): string {
  const say = (rows: readonly DiffRow[]) =>
    rows.map((d) => `${d.key} (${JSON.stringify(d.before) ?? 'absent'} → ${JSON.stringify(d.after) ?? 'absent'})`).join(', ')
  return (
    `Nothing was sent: ${DESTINATION_ID} in group ${group} changed while that confirmation was open, and the change you approved is not the ` +
    `change that would now be applied. Approved: ${say(approved)}. Would now apply: ${say(now)}. A confirmation describes one before → after, ` +
    `so this one is void rather than stale, and nothing here re-asks from a dialog you have already dismissed. This endpoint carries no ETag ` +
    `and no version, so the write cannot be made conditional. Look at the destination and try again.`
  )
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
 *
 * ── AND IT READS TWICE, FOR THE REASON THE LAKE WRITERS DO ──────────────────
 * The first read fills the dialog. It is NOT the merge source: by the time the
 * answer comes back it is as old as the dialog was open, and merging onto it
 * would revert whatever somebody else did to `environment`, `notifications`, a
 * TLS setting or anything else on this object — under a full-replacement
 * semantics that is DOCUMENTED here rather than merely suspected.
 *
 * WHAT IT COMPARES IS THE DIFF, NOT THE BODY, and that is the whole reason this
 * could be closed without the measurement it was waiting for. The Lake refusal
 * compares whole bodies because `DATASET_READONLY_KEYS` names the keys that move
 * on their own; nothing here knows the equivalent for a Stream output beyond
 * `status`, and a refusal built on a guessed list fires on fields nobody touched,
 * which teaches people to distrust the refusal that matters. But `diffDestination`
 * already encodes this app's notion of what is meaningful, and the diff is
 * literally what the person read. So: compute it against the first read, compute
 * it against the second, and refuse unless they are the same change. A
 * server-derived field moving changes no row; anything that changes a row is by
 * construction a change to the approved change. No key list, and the refusal can
 * only fire on something that was on screen.
 *
 * THE MERGE IS STILL ONTO THE SECOND READ, which is what makes the narrow
 * comparison safe: a key this app has never heard of that moved in between is
 * not reverted, it is carried forward, because the body sent is built from the
 * body that holds it.
 *
 * AN EMPTY SECOND DIFF IS A NO-OP, NOT A CONFLICT — somebody applied exactly
 * these settings while the dialog was open, so there is nothing left to send.
 * `skipped`, and no commit and no deploy ride along behind it.
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
  // What the commit will carry is NOT read here, and that is the fix rather
  // than an omission. This read happens before the PATCH at the bottom of this
  // function, so it is structurally incapable of seeing `outputs.yml` dirty —
  // the write that dirties it has not been sent. Asking it what the commit
  // carries returned `[]` on any workspace with unrelated pending work, and the
  // commit was then silently skipped with the destination already changed.
  // The commit list is built from the read AFTER the PATCH, below.
  //
  // This read is still worth making: what it can honestly answer is what is
  // pending ELSEWHERE, which the commit leaves alone. That is `otherPending`.
  const commitFiles = [destinationConfigFile(group)]
  const otherPending = pending.filter((p) => !isDestinationConfigFile(p, group))

  const proceed = await confirmed(opts.confirm, {
    group,
    destinationId: DESTINATION_ID,
    diff,
    feeds: feeds.feeds,
    feedsComplete: feeds.complete,
    commitFiles,
    otherPending,
  })
  if (!proceed) return outcome([{ key: 'destination', status: 'cancelled' }])

  const merge = await destinationMergeSourceAfterConfirm(group, edit, diff, init)
  if ('stop' in merge) return outcome([merge.stop])

  const body = applyDestinationEdit(merge.current, edit)
  const r = await capi('PATCH', groupPath(group, `/system/outputs/${DESTINATION_ID}`), body, init)
  const patched: WriteStep = isOk(r.status)
    ? { key: 'destination', status: 'applied', detail: diff.map((d) => d.key).join(', ') }
    : { key: 'destination', status: 'error', detail: errText(r) }

  const steps = [patched]
  if (patched.status === 'applied') {
    // ── THE COMMIT SCOPE IS READ HERE, AFTER THE WRITE ───────────────────────
    //
    // The 200 above is the proof this read cannot miss its file: `outputs.yml`
    // is dirty, because Cribl has just accepted a change to an object in it.
    // Read before the PATCH (where this used to be) the same call could only
    // ever see somebody else's work, so on a workspace with any unrelated
    // pending change `destinationCommitFiles` matched nothing, answered `[]`,
    // and the run reported `ok` having changed a live delivery point and
    // committed nothing. cribl/provision.ts has always had this ordering right
    // — `deployAll` calls `filesToCommit` after its five writes — and this is
    // that house rule applied to the writer that did not follow it.
    //
    // `afterWrite` tells the commit that an empty list is now a CONTRADICTION
    // rather than a quiet "nothing to do": see commitAndDeployDestination.
    const after = await pendingConfigFiles(init)
    const files = destinationCommitFiles(group, after)
    steps.push(...(await commitAndDeployDestination(group, files, opts.message ?? destinationCommitMessage(group, diff), init, false, true)))
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
 *
 * `afterWrite` SAYS WHAT AN EMPTY FILE LIST MEANS HERE. Called from
 * `updateDestination` the PATCH has just returned 200, so Git reporting nothing
 * pending in this group's `outputs.yml` is a contradiction — the destination is
 * changed and the Workers are running the old configuration — and a `skipped`
 * step for it reads as success, hides LakeLandingPanel's recovery button behind
 * its `error` test, and leaves the workspace half-applied with no sign of it.
 * Called from the retry button nothing was written in this run, so an empty
 * list may honestly mean somebody committed it in the Cribl UI already; that
 * stays `skipped`.
 */
export async function commitAndDeployDestination(
  group: string,
  files: string[],
  message: string,
  init: CapiInit = {},
  trail = false,
  afterWrite = false,
): Promise<WriteStep[]> {
  const record = (steps: WriteStep[]): WriteStep[] => {
    if (trail) void audit('lake_landing.destination.retry', { group, destination: DESTINATION_ID, files, steps })
    return steps
  }
  if (files.length === 0) {
    return record([
      afterWrite
        ? {
            key: 'commit',
            status: 'error',
            detail:
              `Nothing was committed: ${DESTINATION_ID} in group ${group} was changed and accepted, and Cribl then reported no pending change to ` +
              `that group’s outputs.yml. Those two cannot both be true, so this app will not guess a path to commit. The destination is changed ` +
              `and this group’s Workers are still running the old configuration — retry the commit and deploy, or commit ${destinationConfigFile(group)} in Cribl.`,
          }
        : { key: 'commit', status: 'skipped', detail: 'Cribl reports no pending change to this group’s outputs.yml.' },
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
 * out it was a guess because the commit answers "nothing to commit". That is
 * the same rule cribl/provision.ts's `filesToCommit` follows, deliberately:
 * fall back to a constructed path only when Git reported NOTHING, never when it
 * reported something that did not match.
 *
 * WHAT THE EMPTY ANSWER MEANS IS THE CALLER'S TO DECIDE, and the two callers
 * decide differently on purpose. After a successful PATCH it is a contradiction
 * (see `commitAndDeployDestination`'s `afterWrite`); before any write of this
 * run — the retry button — it can honestly mean somebody committed it in the
 * Cribl UI already.
 */
export function destinationCommitFiles(group: string, pending: readonly string[]): string[] {
  const selected = pending.filter((p) => isDestinationConfigFile(p, group))
  if (selected.length > 0) return selected
  return pending.length === 0 ? [destinationConfigFile(group)] : []
}

/** The one Git path a destination change in this group lands in. Constructed,
 *  not read — this is what the dialog names, because the PATCH has not been
 *  sent when the dialog opens and so no Git status can report it yet. */
export function destinationConfigFile(group: string): string {
  return `groups/${group}/local/cribl/outputs.yml`
}

/**
 * Whether a path Git reported IS this group's destinations file.
 *
 * Layout-independent, the same way provision.ts's `pathInGroup` is: a named
 * group carries a `groups/<group>/` segment, and a group-rooted versioning root
 * has no `groups/` segment at all. A path in ANOTHER group is neither, which is
 * the case that matters — committing it would commit somebody else's work.
 */
export function isDestinationConfigFile(path: string, group: string): boolean {
  const inGroup = path.includes(`groups/${group}/`) || !path.includes('groups/')
  return inGroup && path.includes('local/cribl/outputs.yml')
}

/**
 * The commit scope to send, re-read AFTER the answer — or the reason nothing
 * may be sent.
 *
 * THE SAME RULE AS `destinationMergeSourceAfterConfirm`, APPLIED TO THE FILE
 * LIST. A dialog is user-paced: whatever a caller computed before opening it is
 * as old as the dialog has been on screen, and a commit is a write like any
 * other. The retry button is the one place in this app where a file list
 * genuinely crosses a confirmation — it is computed from a status read taken
 * before the dialog opens and consumed after — and another admin committing in
 * that window leaves the approved list naming a path Git no longer reports.
 *
 * REFUSES RATHER THAN SUBSTITUTES. A confirmation describes one set of files;
 * if the set moved, this one is void, exactly as a moved destination diff is.
 * Silently committing the newer set would be committing something nobody read.
 */
export async function commitScopeAfterConfirm(
  group: string,
  approved: readonly string[],
  init: CapiInit = {},
): Promise<{ files: string[] } | { stop: WriteStep }> {
  const now = destinationCommitFiles(group, await pendingConfigFiles(init))
  const same = now.length === approved.length && now.every((p) => approved.includes(p))
  if (same) return { files: now }
  return {
    stop: {
      key: 'commit',
      status: 'error',
      detail:
        `Nothing was committed: what Cribl reports pending in group ${group} changed while that confirmation was open, so the commit you approved ` +
        `is not the commit that would now be made. Approved: ${approved.length ? approved.join(', ') : 'nothing'}. Would now carry: ` +
        `${now.length ? now.join(', ') : 'nothing'}. Look at the group and try again.`,
    },
  }
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
