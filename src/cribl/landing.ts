// How data lands in Cribl Lake, as a computation: the profile, the two object
// specs it produces, the before→after a confirmation renders, and the sentences
// that belong beside each of those rather than in a component.
//
// PURE. Nothing here calls `capi`, `fetch` or the KV store, and nothing imports
// a component. That is not tidiness — it is what makes `diffDestination` and
// `validatePartitions` testable at the density they need, because both of them
// are load-bearing in a way a read is not: a wrong diff means a customer
// approves a change they did not read. cribl/lake.ts does the talking and
// cribl/lakeLanding.ts does the writing; this file only ever answers questions
// about values.
//
// ── WHERE THE KQL IS, AND WHY IT IS NOT HERE ────────────────────────────────
// §2.4 of the plan puts the measurement queries in this file. They are in
// `src/queries/lakeLanding.ts` instead, and that module's header has the
// argument: the freeze cannot resolve a query constant imported from
// `src/cribl/*` and throws rather than degrading, so a `<Panel query={…}>`
// pointing here would break `npm run queries:extract` and with it `npm test`.
// The parsing of what those queries return is here, next to the validation that
// consumes it, which is the half of §2.4's instruction that survives the gate.
//
// ── THE PROSE IS HERE, AND THAT HAS A COST WORTH KNOWING ────────────────────
// §2.4 asks for the explanatory strings to live beside the computation, so a tip
// cannot end up describing last quarter's formula. They do, below. The cost is
// that the query freeze does NOT see them: `display-freeze.test.ts` freezes ⓘ
// prose where it is WRITTEN INLINE in a component, and a sentence hoisted into a
// module constant moves outside it (the snapshot's own $limits say so). So these
// sentences are guarded by review and by the tests in landing.test.ts that pin
// the ones making a factual claim — not by the freeze. Moving them into the
// panel would reverse that trade, and would put a description of this file's
// arithmetic somewhere it cannot be checked against the arithmetic.

import { PARTITION_CANDIDATES } from '../queries/lakeLanding'

// ── The profile ─────────────────────────────────────────────────────────────

/** Bumped when a stored profile stops being readable by this code. Nothing
 *  migrates an old one: a profile is a set of choices, and the live Cribl
 *  objects — not this document — are what the panel reports. */
export const PROFILE_VERSION = 1

/** How objects are written into the Lake dataset. */
export type LandingFormat = 'json' | 'parquet'

/** Which Cribl Search reader the dataset is read with. */
export type SearchVersion = 'v1' | 'v2'

/** The three destination settings that decide how often an object is closed and
 *  therefore how big it is — the only thing on this panel that changes both the
 *  storage bill and every scan's cost at once. */
export interface FlushSettings {
  maxFileSizeMB: number
  maxFileOpenTimeSec: number
  maxFileIdleTimeSec: number
}

export type FlushPresetId = 'nearLive' | 'balanced' | 'criblDefault'

export interface FlushPreset extends FlushSettings {
  /** What a person picks it by. */
  label: string
  /** What they are choosing, in the terms the choice is actually about. */
  why: string
}

/**
 * The three flush settings offered, and what each one trades.
 *
 * `nearLive` IS WHAT THIS APP SHIPS TODAY. `DESTINATION_SPEC` in
 * cribl/provision.ts:131 writes 5 / 60 / 15, so an install that never opens this
 * panel is already on this preset — which is why it is named for its behaviour
 * rather than called "current", and why landing.test.ts pins those three numbers
 * against the sentence below rather than leaving them as a coincidence.
 *
 * The direction of the trade is the whole content of the choice: smaller, more
 * frequent objects mean data is searchable sooner and every scan reads more
 * objects; larger ones mean the opposite. The magnitudes are NOT here, because
 * nothing has measured them on a production feed — P-S8 records the Parquet:JSON
 * ratio at demo scale and is informational only (I-D24).
 */
export const FLUSH_PRESETS: Readonly<Record<FlushPresetId, FlushPreset>> = Object.freeze({
  nearLive: {
    label: 'Near-live',
    why: 'Objects close quickly, so new flows are searchable soonest. Every search then opens more, smaller objects. This is what the app provisions today.',
    maxFileSizeMB: 5,
    maxFileOpenTimeSec: 60,
    maxFileIdleTimeSec: 15,
  },
  balanced: {
    label: 'Balanced',
    why: 'Objects close at 32 MB or two minutes. Fewer, larger objects for every search to open, at the cost of up to two minutes before a flow is searchable.',
    maxFileSizeMB: 32,
    maxFileOpenTimeSec: 120,
    maxFileIdleTimeSec: 30,
  },
  criblDefault: {
    label: 'Cribl default',
    why: 'What Cribl Stream uses when nobody chooses: objects close at 32 MB or five minutes. The fewest objects per search, and the longest wait before a flow appears.',
    maxFileSizeMB: 32,
    maxFileOpenTimeSec: 300,
    maxFileIdleTimeSec: 30,
  },
})

/**
 * Which preset a live destination is on, or `custom`.
 *
 * `custom` is a real answer and not a failure: somebody may have tuned these by
 * hand in Stream, and a panel that rounded that to the nearest preset would
 * offer to "keep" a setting it had already misreported.
 */
export function flushPresetOf(settings: FlushSettings): FlushPresetId | 'custom' {
  for (const [id, preset] of Object.entries(FLUSH_PRESETS) as [FlushPresetId, FlushPreset][]) {
    if (
      preset.maxFileSizeMB === settings.maxFileSizeMB &&
      preset.maxFileOpenTimeSec === settings.maxFileOpenTimeSec &&
      preset.maxFileIdleTimeSec === settings.maxFileIdleTimeSec
    ) {
      return id
    }
  }
  return 'custom'
}

/**
 * The Parquet writer settings this app would use, held as data rather than
 * spread through a spec builder so Phase 4 can read them without running one.
 *
 * `fileNameSuffix` is the one that has to be explicit. Cribl's own `__format`
 * token is documented as yielding `json` or `raw` — never `parquet` — so a
 * destination relying on it writes `.json` objects full of Parquet. The worker
 * id component is what stops two Worker Processes colliding on an object name.
 *
 * `enablePageChecksum:false` because the object store already checksums, and
 * paying twice shows up in every write.
 */
export const PARQUET_DEFAULTS = Object.freeze({
  automaticSchema: true,
  parquetVersion: 'PARQUET_2_6',
  parquetDataPageVersion: 'DATA_PAGE_V2',
  parquetRowGroupLength: 10000,
  parquetPageSize: '1MB',
  enableStatistics: true,
  enableWritePageIndex: true,
  enablePageChecksum: false,
  shouldLogInvalidRows: true,
  maxOpenFiles: 250,
  baseFileName: '`CriblOut`',
  fileNameSuffix: '`.${C.env["CRIBL_WORKER_ID"]}.parquet`',
  systemFields: ['cribl_pipe'],
})

/** The post-processing pipeline `dropRaw` binds to the destination. */
export const PREP_PIPELINE_ID = 'gigamon_lake_prep'

/** One measurement, with the time it was taken. Never a bare number: I-D20 —
 *  a measured value rendered without its age is a claim about now. */
export interface Measurement<T> {
  value: T
  /** Epoch ms the measurement was taken, from the press that took it. */
  at: number
  /** The Cribl Search job that produced it, so a bill can be traced to a press. */
  jobId?: string
}

/**
 * What somebody chose, as opposed to what Cribl currently says.
 *
 * The live objects are always authoritative — this document pre-fills the
 * editors, carries the last measurement so a reload does not re-spend, and lets
 * the panel report drift between the two. It is never read as the truth about
 * the dataset.
 */
export interface LandingProfile {
  version: number
  datasetId: string
  group: string
  format: LandingFormat
  retentionDays: number
  /** 0..3, ordered broad → narrow. Empty is the shipped state and a valid one. */
  partitions: readonly string[]
  flush: FlushSettings
  dropRaw: boolean
  searchVersion: SearchVersion
  /** Last landing-lag reading, in seconds, with its age. */
  lastLagSeconds?: Measurement<number>
  /** Last partition-candidate reading. */
  lastPartitionStats?: Measurement<readonly PartitionStat[]>
}

/**
 * The profile of an install that has never opened this panel.
 *
 * JSON, not Parquet, and this is a deliberate departure from §2.4's
 * `DEFAULT_PROFILE_NEW_INSTALL`. Phase 3 is explicitly the phase that does NOT
 * change the format — Phase 4 is the migration, behind P-S1 and P-S5 — so a
 * default claiming Parquet would describe a landing this release cannot produce,
 * and `datasetSpec()` would hand Guided Setup a spec that disagrees with the
 * `DATASET_SPEC` it ships. The format parameter is here; only its default waits.
 */
export const DEFAULT_PROFILE: LandingProfile = Object.freeze({
  version: PROFILE_VERSION,
  datasetId: 'gigamon_ami',
  group: 'default',
  format: 'json' as LandingFormat,
  retentionDays: 30,
  partitions: Object.freeze([]) as readonly string[],
  flush: Object.freeze({ maxFileSizeMB: 5, maxFileOpenTimeSec: 60, maxFileIdleTimeSec: 15 }) as FlushSettings,
  dropRaw: false,
  searchVersion: 'v1' as SearchVersion,
})

// ── Retention ───────────────────────────────────────────────────────────────

/** What Cribl Lake accepts. A retention of zero is not "keep nothing"; it is a
 *  value the API rejects, and rejecting it here says so before the round trip. */
export const MIN_RETENTION_DAYS = 1
export const MAX_RETENTION_DAYS = 3650

export type RetentionDirection = 'increase' | 'decrease' | 'none'

export interface RetentionChange {
  from: number
  to: number
  direction: RetentionDirection
  /** THE one irreversible edit in this phase. */
  irreversible: boolean
  /** Why it cannot be undone — null when it can. */
  why: string | null
  /** How to reverse it — null when there is nothing to reverse. */
  undo: string | null
  /** Empty when the value is usable. */
  problems: readonly string[]
}

/**
 * Classify a retention edit before anything is sent.
 *
 * The asymmetry is the point and is the reason this is a function rather than a
 * comparison at the call site. An increase changes a policy; a decrease DELETES
 * DATA, immediately, with no history, no ETag and no undo — Lake objects are in
 * no version control at all, so unlike a destination edit there is no commit to
 * revert. A dialog that presented the two the same way would make the label on
 * the dangerous one decoration.
 *
 * The retention clock runs from UPLOAD date, not event time. That is in the
 * sentence because it is the part people get wrong: a 7-day retention on data
 * back-filled yesterday deletes a month of events tomorrow.
 */
export function retentionChange(from: number, to: number): RetentionChange {
  const problems: string[] = []
  if (!Number.isInteger(to)) problems.push('Retention is a whole number of days.')
  else if (to < MIN_RETENTION_DAYS || to > MAX_RETENTION_DAYS) {
    problems.push(`Cribl Lake accepts ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} days; ${to} is outside that.`)
  }
  const direction: RetentionDirection = to === from ? 'none' : to > from ? 'increase' : 'decrease'
  const irreversible = direction === 'decrease' && problems.length === 0
  return {
    from,
    to,
    direction,
    irreversible,
    why: irreversible ? retentionDecreaseWhy(from, to) : null,
    undo:
      direction === 'increase'
        ? `Reversible: set retention back to ${from} days in this same editor. Nothing is deleted by an increase.`
        : null,
    problems,
  }
}

/** The sentence a decrease's confirmation has to carry, built from the two
 *  numbers so it can never describe a different edit than the one in flight. */
export function retentionDecreaseWhy(from: number, to: number): string {
  return (
    `Cribl Lake deletes everything in this dataset older than ${to} days, and there is no way back: ` +
    `Lake datasets are not under version control, so unlike a destination change this cannot be reverted or redeployed. ` +
    `Retention counts from the date data was UPLOADED, not from the timestamp on the event — back-filled data ages by when it arrived. ` +
    `The ${from - to} days beyond the new window go, and they go for everyone reading this dataset, not only for this app.`
  )
}

// ── Partitions ──────────────────────────────────────────────────────────────

/** One candidate field as the measurement reports it. */
export interface PartitionStat {
  field: string
  /** Rows where the field is present. */
  present: number
  /** Distinct values seen. */
  distinct: number
  /** Rows in the measured window. */
  total: number
  /** `present / total`, 0..1, or null when `total` is zero. */
  fill: number | null
}

/**
 * Read a partition-candidate measurement row into stats.
 *
 * The row comes back as flat `n_<key>` / `d_<key>` columns, keyed by
 * PARTITION_CANDIDATES' short keys, because those become column names and
 * `n_dst_aws_flat_tags_name` is unreadable in a result table. A candidate whose
 * columns are absent is DROPPED rather than reported as zero: a missing column
 * means the query did not measure that field, and a zero fill is a claim that it
 * did and found nothing.
 */
export function partitionStats(row: Record<string, unknown> | null | undefined): PartitionStat[] {
  if (!row) return []
  const total = num(row.total)
  if (total === null) return []
  const out: PartitionStat[] = []
  for (const { field, key } of PARTITION_CANDIDATES) {
    const present = num(row[`n_${key}`])
    const distinct = num(row[`d_${key}`])
    if (present === null || distinct === null) continue
    out.push({ field, present, distinct, total, fill: total > 0 ? present / total : null })
  }
  return out
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** What `GET /products/lake/lakes/default/config` says the tenant allows. */
export interface PartitionLimits {
  maxAcceleratedFieldsCount: number
}

/** Used when the Lake config read is refused or absent. Three is what the
 *  measured workspace answered; it is a fallback, and `validatePartitions`
 *  says which limit it applied so a refusal is never silently permissive. */
export const DEFAULT_PARTITION_LIMITS: PartitionLimits = Object.freeze({ maxAcceleratedFieldsCount: 3 })

/**
 * Fields a partition may never be built on.
 *
 * `_raw` and `message` carry the whole event, so partitioning on them makes one
 * partition per event. `_time`, `source` and `dataset` are structural: Lake
 * already lays objects out by time and by dataset, and `source` names the object
 * the row came from, so a partition on it partitions by itself.
 */
export const NEVER_PARTITION: readonly string[] = Object.freeze(['_raw', 'message', '_time', 'source', 'dataset'])

/**
 * Below this fill, a partition is worse than none.
 *
 * A JUDGEMENT, not a measurement, and the reasoning rather than the number is
 * what to argue with: every row missing the field lands in one partition that no
 * filter can prune, so a field present on half the rows doubles the object count
 * and leaves half the dataset unpruned. Half is where that stops being a trade
 * and starts being a cost with no benefit. P-S9 is the spike that can replace
 * this with something measured.
 */
export const PARTITION_FILL_FLOOR = 0.5

/**
 * Above this many distinct values, a partition is flagged.
 *
 * ALSO A JUDGEMENT, and a weaker one. Partitions multiply objects by roughly
 * their cardinality, and nothing in this repo has measured how much Lake's
 * object count can grow before scans get slower rather than faster — that is
 * exactly what P-S9 exists to answer. 200 is chosen to let the plan's own
 * candidates through (`protocol`, `l4_proto`, `ip_version` are small; `app_name`
 * is the interesting one) and to stop an IP- or port-shaped field. It is a
 * WARNING and never an error, because Lake does not reject on cardinality and
 * this app must not invent a refusal the platform does not make.
 */
export const PARTITION_DISTINCT_CEILING = 200

export interface PartitionProblem {
  /** The field it is about, or null when it is about the set as a whole. */
  field: string | null
  reason: string
}

export interface PartitionVerdict {
  /** Things Cribl Lake itself will refuse. */
  errors: readonly PartitionProblem[]
  /** Things the measurement says are a bad idea. Lake will accept them. */
  warnings: readonly PartitionProblem[]
  /** No errors. Warnings do not block. */
  ok: boolean
}

/**
 * Check a proposed partition set against the tenant's limits and the
 * measurement.
 *
 * TWO LISTS, NOT ONE, and the split is the honest part. An `error` is something
 * the platform will reject, so surfacing it here saves a round trip and says the
 * same thing Cribl would. A `warning` is this app's opinion, formed from a
 * measurement the customer paid for — and collapsing the two would let an
 * opinion masquerade as a platform rule, which is how a tool ends up refusing
 * something a customer has a good reason to want.
 *
 * Note what is NOT checked: whether Lake prunes usefully by any of these at all,
 * how much a partition multiplies the object count, and whether existing objects
 * are re-partitioned. All three are P-S9's, all three are unknown, and the
 * partitions EDITOR is not built for exactly that reason (see SPIKE_GATED). This
 * function exists so that it can be, in an afternoon, once the spike reports.
 */
export function validatePartitions(
  fields: readonly string[],
  stats: readonly PartitionStat[] = [],
  limits: PartitionLimits = DEFAULT_PARTITION_LIMITS,
): PartitionVerdict {
  const errors: PartitionProblem[] = []
  const warnings: PartitionProblem[] = []
  const max = limits.maxAcceleratedFieldsCount

  if (fields.length > max) {
    errors.push({
      field: null,
      reason: `This tenant allows ${max} partition field${max === 1 ? '' : 's'}; ${fields.length} were chosen.`,
    })
  }

  const seen = new Set<string>()
  const byField = new Map(stats.map((s) => [s.field, s]))

  for (const raw of fields) {
    const field = raw.trim()
    if (!field) {
      errors.push({ field: null, reason: 'A partition field with no name.' })
      continue
    }
    if (seen.has(field)) {
      errors.push({ field, reason: `${field} is listed twice; a partition field can only appear once.` })
      continue
    }
    seen.add(field)
    if (NEVER_PARTITION.includes(field)) {
      errors.push({ field, reason: `${field} cannot be a partition field — it is structural, not a dimension of the data.` })
      continue
    }
    const stat = byField.get(field)
    if (!stat) {
      warnings.push({
        field,
        reason: `${field} has not been measured, so nothing here can say how much of the data carries it. Run the partition-candidate measurement first.`,
      })
      continue
    }
    if (stat.fill !== null && stat.fill < PARTITION_FILL_FLOOR) {
      warnings.push({
        field,
        reason: `${field} is present on ${pct(stat.fill)} of measured rows. Every row without it lands in one partition nothing can prune, so the object count grows and most of the data is not pruned at all.`,
      })
    }
    if (stat.distinct > PARTITION_DISTINCT_CEILING) {
      warnings.push({
        field,
        reason: `${field} had ${stat.distinct} distinct values in the measured window. Partitions multiply the number of objects roughly by that, and how far Lake stays faster under that is unmeasured (P-S9).`,
      })
    }
  }

  return { errors, warnings, ok: errors.length === 0 }
}

const pct = (fraction: number): string => `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`

// ── The two object specs ────────────────────────────────────────────────────

/** One row of `searchConfig.pathFilters`: which reader handles which objects. */
export interface PathFilterRow {
  filter: string
  dataTypeId: string
  dataPathFormat: string
  preprocessOuterJson?: boolean
}

export type LakeObjectKind = LandingFormat

/**
 * The `pathFilters` rows for a dataset holding these kinds of object.
 *
 * MORE SPECIFIC GLOB FIRST — Cribl's docs are explicit ("put more specific
 * patterns before broad globs") and the order is the whole correctness of the
 * two-row case: `**` first would claim the Parquet objects for the NDJSON
 * reader. A JSON-only dataset gets the single `**` row rather than a gzip-suffix
 * glob, because objects written before gzip was the default do not carry that
 * suffix and a filter that misses them makes them unreadable.
 */
export function pathFilterRows(kinds: readonly LakeObjectKind[]): PathFilterRow[] {
  const has = new Set(kinds)
  const rows: PathFilterRow[] = []
  if (has.has('parquet')) {
    rows.push({ filter: '**/*.parquet', dataTypeId: 'cribl_lake_parquet', dataPathFormat: 'parquet' })
  }
  if (has.has('json')) {
    rows.push(
      has.has('parquet')
        ? { filter: '**/*.json.gz', dataTypeId: 'generic_ndjson', dataPathFormat: 'ndjson', preprocessOuterJson: true }
        : { filter: '**', dataTypeId: 'generic_ndjson', dataPathFormat: 'ndjson', preprocessOuterJson: true },
    )
  }
  return rows
}

/**
 * The Cribl Lake dataset body for a profile — the POST that creates it, and the
 * fields a PATCH would set.
 *
 * `acceleratedFields` is OMITTED when empty rather than sent as `[]`, and
 * `searchConfig` is omitted on v1. Both for the same reason: `PATCH` on this
 * endpoint is only *likely* partial (claim C6, inferred from the spec's example
 * bodies and nothing else), so every key this app sends is a key it is betting
 * it understands. Sending nothing is the version of that bet with no downside.
 *
 * NOT THE BODY ANY LAKE PATCH SENDS. The two writers in cribl/lakeLanding.ts
 * build theirs with `applyDatasetEdit` from a live read, precisely so that the
 * bet above does not have to be won. This spec is the CREATION body.
 */
export function datasetSpec(profile: LandingProfile): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    id: profile.datasetId,
    description: DATASET_DESCRIPTION,
    retentionPeriodInDays: profile.retentionDays,
    format: profile.format,
  }
  if (profile.partitions.length > 0) spec.acceleratedFields = [...profile.partitions]
  if (profile.searchVersion === 'v2') {
    spec.searchConfig = {
      searchVersion: 'v2',
      // A dataset written as Parquet still holds every JSON object written
      // before the change until retention ages it out, so the reader has to be
      // told about both. Dropping the JSON row is how a month of history stops
      // being readable in one PATCH.
      pathFilters: pathFilterRows(profile.format === 'parquet' ? ['parquet', 'json'] : ['json']),
    }
  }
  return spec
}

/** Kept verbatim from cribl/provision.ts's `DATASET_SPEC`, so a spec built here
 *  and one built there describe the same dataset. landing.test.ts pins them. */
export const DATASET_DESCRIPTION = 'Gigamon Application Metadata Intelligence (AMI) flow records'

/**
 * A destination edit, expressed as what to set and what to take away.
 *
 * Two lists rather than one object, because "remove this key" cannot be said in
 * an overlay: `{ compress: undefined }` is a key that JSON.stringify drops, so
 * an overlay can add and change and can never delete — and deleting is exactly
 * what a Parquet destination needs, since `compress`/`compressionLevel` are not
 * available on Parquet and leaving them behind is what the API is being asked
 * about. Making removal explicit also makes it diffable, which is the point.
 */
export interface DestinationEdit {
  set: Record<string, unknown>
  remove: readonly string[]
}

/**
 * Keys the live GET carries that must never be PATCHed back.
 *
 * `status` is server-computed — it holds the destination's live health — and is
 * not configuration. Everything else the GET returns is sent back untouched.
 *
 * DELIBERATELY SHORTER THAN THE DESIGN'S LIST, which also stripped
 * `notifications`. Nothing in this repo knows whether this endpoint rejects
 * `notifications` on the way in, and the Preview check that closes this phase
 * (3.2.3) treats a re-read that lost `notifications` as a FAILURE — so stripping
 * it to be safe is the failure, performed on purpose. If a live PATCH turns out
 * to refuse it, this constant is the one line to change, and the Preview capture
 * P1 is what proves which way it went.
 */
export const DESTINATION_READONLY_KEYS: readonly string[] = Object.freeze(['status'])

/**
 * What a profile wants the `gigamon_lake` destination to say.
 *
 * Only the keys this app has an opinion about. Everything else on the live
 * object — a customer's own `environment`, `streamtags`, TLS settings, whatever
 * a future Cribl release adds — is not mentioned here and is preserved by
 * `applyDestinationEdit`, because this app did not create this destination on
 * most tenants and has no business rewriting fields it has never heard of.
 */
export function destinationSpec(profile: LandingProfile): DestinationEdit {
  const set: Record<string, unknown> = {
    destPath: profile.datasetId,
    format: profile.format,
    storageLocationId: 'cribl_lake',
    maxFileSizeMB: profile.flush.maxFileSizeMB,
    maxFileOpenTimeSec: profile.flush.maxFileOpenTimeSec,
    maxFileIdleTimeSec: profile.flush.maxFileIdleTimeSec,
    onBackpressure: 'block',
  }
  const remove: string[] = []

  if (profile.format === 'parquet') {
    Object.assign(set, PARQUET_DEFAULTS)
    // Not available when the data format is Parquet. Whether the API rejects
    // them or quietly ignores them is P-S1's to record; either way the app does
    // not leave a setting behind that it has stopped meaning.
    remove.push('compress', 'compressionLevel')
  } else {
    set.compress = 'gzip'
  }

  if (profile.dropRaw) set.pipeline = PREP_PIPELINE_ID
  else remove.push('pipeline')

  return { set, remove: Object.freeze(remove) }
}

// ── The diff a confirmation renders ─────────────────────────────────────────

export type DiffKind = 'added' | 'changed' | 'removed'

export interface DiffRow {
  key: string
  kind: DiffKind
  /** `undefined` exactly when `kind` is `added` — the key was not there. */
  before: unknown
  /** `undefined` exactly when `kind` is `removed`. */
  after: unknown
}

/**
 * What an edit will change about the live destination, key by key.
 *
 * THE LOAD-BEARING FUNCTION IN THIS FILE. Its output is what a customer reads
 * before approving a PATCH of a live delivery point that both feeds write
 * through, so a row this misses is a change somebody approved without seeing,
 * and a row it invents is a change they refuse for no reason.
 *
 * Three properties it has to have, each of which has a test:
 *
 *   * A NO-OP IS EMPTY. Re-applying the current settings produces `[]`, and the
 *     caller is expected to render that as "nothing to change" and not send
 *     anything. An edit that lists a key whose value is already correct trains
 *     people to approve diffs without reading them.
 *   * EQUAL BEATS IDENTICAL. `{a:1,b:2}` and `{b:2,a:1}` are the same setting.
 *     A reference comparison would report every nested object as changed on
 *     every open, which is the same failure as the one above with more noise.
 *   * REMOVAL IS A CHANGE. A key the edit takes away is a row, with `after`
 *     undefined — not a silent omission. Dropping `compress` from a destination
 *     is a real change to how objects are written.
 *
 * Keys are sorted so two diffs of the same edit read the same way.
 */
export function diffDestination(current: Record<string, unknown>, edit: DestinationEdit): DiffRow[] {
  const rows: DiffRow[] = []
  const removing = new Set(edit.remove)

  for (const key of Object.keys(edit.set).sort()) {
    // A key in both lists is a contradiction in the edit itself, not a diff to
    // draw. Removal wins, and the caller finds out by the key appearing once as
    // `removed` rather than twice saying two things.
    if (removing.has(key)) continue
    const after = edit.set[key]
    if (!Object.hasOwn(current, key)) {
      rows.push({ key, kind: 'added', before: undefined, after })
      continue
    }
    const before = current[key]
    if (!sameValue(before, after)) rows.push({ key, kind: 'changed', before, after })
  }

  for (const key of [...removing].sort()) {
    // A key that is not there cannot be removed, and saying so would be a diff
    // row for something that will not happen.
    if (!Object.hasOwn(current, key)) continue
    rows.push({ key, kind: 'removed', before: current[key], after: undefined })
  }

  return rows
}

/**
 * Structural equality, key order and array identity ignored.
 *
 * Not a general deep-equal: it handles what a Cribl destination body holds —
 * primitives, arrays, plain objects, null. Arrays compare IN ORDER, because
 * `systemFields` and `pathFilters` are ordered and a reordering is a change.
 * `NaN` is not equal to itself here either, because a NaN in a config body is a
 * corruption worth showing rather than a value worth matching.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) => Object.hasOwn(b as object, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/**
 * The full body to PATCH: the live object, with the edit applied and the
 * server-computed keys dropped.
 *
 * READ-MODIFY-WRITE, not a spec. A Stream destination PATCH is documented as a
 * full replacement, so anything absent from this body is a field the app has
 * just deleted from a customer's configuration — which is why `destinationSpec`
 * names so few keys and this function starts from what Cribl actually returned.
 */
export function applyDestinationEdit(current: Record<string, unknown>, edit: DestinationEdit): Record<string, unknown> {
  const body: Record<string, unknown> = { ...current }
  for (const key of DESTINATION_READONLY_KEYS) delete body[key]
  Object.assign(body, edit.set)
  // AFTER the assign, so that a key named in both lists ends up removed — the
  // same way `diffDestination` shows it. An edit that sets and removes the same
  // key is a contradiction in the caller, and the two functions have to resolve
  // it identically or the body sent stops matching the diff approved.
  for (const key of edit.remove) delete body[key]
  return body
}

// ── The Lake dataset's read-modify-write ────────────────────────────────────

/**
 * Keys the live Lake dataset GET carries that must NOT be PATCHed back.
 *
 * READ THE ASYMMETRY BEFORE ADDING TO THIS LIST, because it runs the opposite
 * way from every other "strip it to be safe" list. Nobody has measured whether
 * PATCH on this endpoint is partial or a full replacement — that is
 * `CAPABILITIES.datasetPatchIsPartial` in cribl/lakeLanding.ts, and it is still
 * `null` — and the two readings make a strip mean opposite things:
 *
 *   * partial     — a stripped key is simply not mentioned, and survives;
 *   * replacement — a stripped key is DELETED from the customer's dataset.
 *
 * So stripping is not the cautious option here; sending back what Cribl returned
 * is. This list holds only keys that are provably not stored configuration, and
 * anything merely suspicious rides along untouched — the same trade
 * `DESTINATION_READONLY_KEYS` makes with `notifications`, made here for a
 * stronger reason. Both keys come from the 4.19.0 spec's `CriblLakeDataset` plus
 * the live body measured on the one workspace anybody has read.
 *
 *   `metrics` — not configuration, and not part of the stored object at all: it
 *     is in the response only because cribl/lake.ts asks for
 *     `?includeMetrics=true`, and it is a daily server-computed snapshot
 *     (`currentSizeBytes`, `metricsDate`). Echoing yesterday's size back is
 *     either ignored or persisted as a claim about the dataset that is false.
 *   `deletionStartedAt` — the deletion marker, a server-stamped timestamp.
 *     Absent on a live dataset, so dropping it normally changes nothing; on one
 *     whose deletion has begun, neither echoing it back nor clearing it is a
 *     decision a retention edit gets to make, and nothing in this app deletes a
 *     dataset.
 *
 * KEPT ON PURPOSE — and the ones I am NOT sure about, named rather than quietly
 * included:
 *
 *   `id` — kept. The update schema calls it optional and the path parameter
 *     authoritative, but it is the ONE required property of the object, so a
 *     full replacement missing it is the body most likely to be rejected.
 *     Sending the value the path already names is safe under either reading.
 *   `bucketName` / `storageLocationId` — kept. This is which bucket backs the
 *     dataset. Under the replacement reading, dropping it unbinds the dataset
 *     from its own data, which is the worst outcome available here.
 *   `viewName` — kept, UNSURE. It looks derived (`gigamon_ami-read-view` on the
 *     measured workspace; the spec calls it the Dataset's ClickHouse view on the
 *     Lakehouse) but it is a writable property in the same schema. Being wrong
 *     by keeping it costs nothing observable; being wrong by stripping it costs
 *     a view binding.
 *   `httpDAUsed` — kept, UNSURE. Reads as a derived fact ("the Dataset IS used
 *     by Direct Access HTTP") and is writable in the same schema. Same trade.
 *   `cacheConnection` — kept VERBATIM, UNSURE. It carries a server-stamped
 *     `createdAt` and a transient `migrationQueryId`, and A-SP23 measured a
 *     sibling endpoint in this product replacing a sub-object WHOLESALE rather
 *     than merging it — so a hand-rebuilt one would drop fields. Sending back
 *     exactly what was read is the only version of this with no opinion in it.
 *
 * Preview check 3.1 is what turns any of the above from reasoning into a
 * measurement. Until it runs, this list is an argument, and it is written out so
 * that it can be argued with.
 */
export const DATASET_READONLY_KEYS: readonly string[] = Object.freeze(['metrics', 'deletionStartedAt'])

/**
 * The full body to PATCH on the Lake dataset: what Cribl just returned, with the
 * edited fields overlaid and the derived ones dropped.
 *
 * The counterpart of `applyDestinationEdit`, and deliberately simpler: a dataset
 * edit in this phase sets fields and never removes one, so there is no `remove`
 * list and no ordering question between setting and deleting a key. If a control
 * ever needs to take a key away, it takes a `DestinationEdit`-shaped argument and
 * this function grows the same "remove wins, after the assign" rule — it does not
 * get an overlay of `undefined`, which JSON.stringify drops.
 *
 * The caller must pass a body it read ITSELF, moments ago. That is not a style
 * note: a merge onto a stale read writes back the stale values of every field
 * somebody else has changed since, which is the same data loss this function
 * exists to prevent, arriving by a longer route.
 */
export function applyDatasetEdit(current: Record<string, unknown>, edit: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...current }
  for (const key of DATASET_READONLY_KEYS) delete body[key]
  return Object.assign(body, edit)
}

// ── The sentences ───────────────────────────────────────────────────────────

/** What the panel renders when a diff comes back empty. Said as a fact about
 *  the objects rather than as an apology for the button. */
export const NO_CHANGE_NOTE = 'These settings already match the live destination, so there is nothing to apply.'

/**
 * The three terms that need a definition on a row label, and nothing else.
 *
 * Three, because §2.4 rejected the alternative by name: eight ⓘ icons down the
 * left edge of a table is a column of punctuation, and the read map on the
 * panel's own title is where "where did this value come from" is answered.
 */
export const LANDING_TERMS: Readonly<Record<'landingLag' | 'accelerationTier' | 'searchV2', string>> = Object.freeze({
  landingLag:
    'How far behind the newest record in the dataset is, measured when you press the button: the gap between now and the most recent event timestamp in the last five minutes. It is a single sample at one instant, not an average, which is why it is shown with the time it was taken.',
  accelerationTier:
    'Whether this workspace has Cribl Search local engines provisioned. Engines answer some searches without fanning out across the object store; a tenant with none is not misconfigured, it is the normal state, and every search in this app runs the same way it always has.',
  searchV2:
    'Federated Search v2 is the newer Cribl Search reader for Lake datasets. It is what can read a dataset holding both Parquet and JSON objects, which is why the Parquet migration needs it. Switching a dataset between readers changes nothing about the data itself.',
})

/** The consequence sentences a deploy confirmation must carry, in the order a
 *  person needs them. Written here so the dialog cannot paraphrase them. */
export const DEPLOY_CONSEQUENCES: readonly string[] = Object.freeze([
  'Deploying restarts this worker group’s Worker Processes.',
  'The commit includes every pending change to this group’s outputs.yml — including anybody else’s unfinished work in the same file.',
  'A source with onBackpressure "block" can lose seconds of data across the restart. The syslog source in this stack is one.',
])

export const DESTINATION_UNDO =
  'Reversible: set the values back in this same editor, which commits and deploys again. The group’s Git history holds the previous body either way.'

// ── What this phase deliberately did not build ──────────────────────────────

export type SpikeId = 'P-S5' | 'P-S7' | 'P-S9'

export interface SpikeGate {
  /** The control that is not here. */
  control: string
  spikes: readonly SpikeId[]
  /** What nobody knows yet, in the terms the control would have needed. */
  unknown: string
  /** What the panel shows instead. */
  instead: string
}

/**
 * The two editors Phase 3 refused to build, and what each is waiting on.
 *
 * THIS IS A DELIVERABLE, not a TODO list. Phase 1 refused `<DiffTable>` and
 * `<Unavailable>` rather than guess, and §2.2 records those refusals as
 * deliverables for the same reason: a control built on an unmeasured assumption
 * about a live customer dataset is worse than no control, because it looks like
 * an answer. Both rows below render the LIVE value read-only, so the panel still
 * reports the truth; what is missing is the ability to change it from here.
 *
 * Reading these out loud is also what stops the next session quietly building
 * them: the sentences say what would have to be measured first, not "later".
 */
export const SPIKE_GATED: readonly SpikeGate[] = Object.freeze([
  {
    control: 'Federated Search v1 → v2 toggle',
    spikes: ['P-S5', 'P-S7'],
    unknown:
      'Which endpoint actually flips the reader — the Lake dataset’s searchConfig, or a full replacement of the Search-side dataset — and whether v2 on today’s JSON dataset returns identical rows without being slower. Two candidate request shapes exist and nobody has sent either.',
    instead: 'The live searchVersion, read from the Search-side dataset, shown as a value.',
  },
  {
    control: 'Partition (acceleratedFields) editor',
    spikes: ['P-S9'],
    unknown:
      'Whether Cribl Lake prunes usefully by a partition at this scale, how far a partition multiplies the object count, and whether objects already written are re-partitioned or only new ones are. A partition change on a 30-day dataset becomes visible over weeks, so it cannot be tried and undone.',
    instead: 'The live acceleratedFields, shown as a value, with the candidate measurement available as a button.',
  },
])

/** One sentence naming why a control is absent, for the row that would have held
 *  it. Built from the table so the two cannot drift. */
export function spikeGateNote(gate: SpikeGate): string {
  return `Not editable here yet: ${gate.spikes.join(' and ')} ${gate.spikes.length > 1 ? 'have' : 'has'} to report first. ${gate.unknown}`
}
