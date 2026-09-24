// Every Cribl Stream object id the Data Flow counters name, in one list.
//
// The Sources, Processing and Destinations plates and the Lake card's write
// counters sum `cribl_metrics` rows, and a counter row names ONE object: the
// source that received an event, the pipeline that processed it, the
// destination that wrote it. Hard-coding today's objects made the counters read
// short the moment anything else carried the data — the onboarding pack, or a
// new Guided Setup source — while every figure still looked complete. So the
// queries in ./dataFlow.ts are BUILT from this list, and a new stack is a new
// entry here rather than an edit to three query strings.
//
// ── WHAT A PATH IS ──────────────────────────────────────────────────────────
//
// One route (or QuickConnect connection) carries events from one source through
// one pipeline to one destination, which writes one Lake dataset. A source can
// have several paths (the pack's JSON and Parquet dual-write); an event takes
// each of them once. The counters count the paths into `gigamon_ami` only —
// the Parquet copy (`gigamon_ami_pq`) and the sample dataset
// (`gigamon_ami_sample`) are listed so that exclusion is visible and tested,
// not so they are counted.
//
// ── HOW cribl_metrics NAMES THEM (measured 2026-09-24, this workspace) ──────
//
//   total.in_events   namespace=data_insights  input=<type>:<source id>
//   pipe.*_events     namespace=data_insights  id=<pipeline id>  from_input=<type>:<source id>
//                                              instance=dc:<type>:<source>:<dest>  (QuickConnect)
//   total.out_*       namespace=data_insights  output=<type>:<dest id>  from_input=<type>:<source id>
//
// Only the QuickConnect path (in_gigamon_datagen → gigamon_lake) was running,
// so every dimension above is measured on that path alone. What a ROUTED path's
// rows carry is inferred from it, not measured.
//
// ── UNVERIFIED: HOW A PACK'S OBJECTS ARE NAMED ──────────────────────────────
//
// Nobody has measured whether an object inside a pack reports under its bare id
// (`gigamon_ami_normalize`, `http_raw:in_gigamon_ami_http`) or a pack-qualified
// one. Neither the vendored openapi.json nor anything else in this repo says.
// The pack's paths below use the bare form, the same assumption the pack's route
// filters already make about `__inputId`. When the proof install measures a
// qualified form, add it to METRIC_ALIASES — one line per id — and every
// counter matches both. That is safe to leave in place for both forms: a counter
// row carries one value per dimension, so it matches one form or the other,
// never both, and is summed once. (If Cribl turned out to emit the SAME event
// under both forms as two rows, that would double — which is exactly what the
// measurement has to rule out before an alias goes in.)
//
// PURE DATA, loaded by the query extractor under plain Node: nothing here may
// reach a .tsx or the network. Every export is frozen in __frozen__/display.json,
// so a change to which ids are counted is a visible diff.

export interface StackPath {
  /** The route that carries this path, or null for a QuickConnect connection. */
  route: string | null
  /** The source as cribl_metrics names it: `<type>:<id>` (the `input` and
   *  `from_input` dimensions). */
  input: string
  /** The pipeline's id (the `id` dimension of `pipe.*` counters). */
  pipeline: string
  /** The destination as cribl_metrics names it: `<type>:<id>` (the `output`
   *  dimension). */
  output: string
  /** The Lake dataset that destination writes. */
  dataset: string
}

export interface Stack {
  key: string
  /** Where the objects live: the worker group's own config, or inside the pack. */
  scope: 'global' | 'pack'
  /** Whether anything can run it today. `pending` ids are not known yet. */
  status: 'running' | 'offered' | 'released' | 'planned' | 'pending'
  what: string
  paths: readonly StackPath[]
}

/** The dataset the counters report on. Written out rather than imported from
 *  ../cribl/config so this list stays readable on its own; stackIds.test.ts
 *  holds the two equal. */
export const COUNTED_DATASET = 'gigamon_ami'

export const STACKS: readonly Stack[] = [
  {
    key: 'global-demo',
    scope: 'global',
    status: 'running',
    what: "The demo feed: DataGen through QuickConnect into today's Lake destination.",
    paths: [
      { route: null, input: 'datagen:in_gigamon_datagen', pipeline: 'gigamon_ami', output: 'cribl_lake:gigamon_lake', dataset: 'gigamon_ami' },
    ],
  },
  {
    key: 'global-legacy-syslog',
    scope: 'global',
    status: 'offered',
    what: "Guided Setup's Syslog onboarding (src/cribl/provision.ts). It shares the demo's Lake destination.",
    paths: [
      { route: 'gigamon_ami_syslog', input: 'syslog:in_gigamon_syslog', pipeline: 'gigamon_syslog', output: 'cribl_lake:gigamon_lake', dataset: 'gigamon_ami' },
    ],
  },
  {
    // Guided Setup's onboarding is moving from Syslog to Raw HTTP on another
    // branch, with ids not decided yet. At that merge this is the one place
    // to add them: one path, the new source, its pipeline and its destination.
    key: 'global-http-PENDING',
    scope: 'global',
    status: 'pending',
    what: "Guided Setup's Raw HTTP onboarding — ids not known yet.",
    paths: [],
  },
  {
    key: 'pack-0.1.0',
    scope: 'pack',
    status: 'released',
    what: 'cc-network-gigamon-ami 0.1.0: Syslog and a sample DataGen, both shipped disabled.',
    paths: [
      { route: 'gno_syslog', input: 'syslog:in_gno_syslog', pipeline: 'gno_syslog', output: 'cribl_lake:out_gno_lake', dataset: 'gigamon_ami' },
      { route: 'gno_sample', input: 'datagen:in_gno_sample', pipeline: 'gno_sample', output: 'cribl_lake:out_gno_sample_lake', dataset: 'gigamon_ami_sample' },
    ],
  },
  {
    // Owner's ids, 2026-09-24. The HTTP source fans out: one route to the JSON
    // dataset the dashboards read, one to the Parquet copy, both through the
    // same cast/derive pipeline. The sample route's pipeline is not decided
    // in the design; it cannot reach these counters either way, because its
    // source and destination are not on a gigamon_ami path.
    key: 'pack-0.2.0',
    scope: 'pack',
    status: 'planned',
    what: 'cc-network-gigamon-ami 0.2.0: Raw HTTP, dual-written as JSON and Parquet, plus a sample DataGen.',
    paths: [
      { route: 'gigamon_ami_http_to_json', input: 'http_raw:in_gigamon_ami_http', pipeline: 'gigamon_ami_normalize', output: 'cribl_lake:gigamon_ami_json_lake', dataset: 'gigamon_ami' },
      { route: 'gigamon_ami_http_to_parquet', input: 'http_raw:in_gigamon_ami_http', pipeline: 'gigamon_ami_normalize', output: 'cribl_lake:gigamon_ami_parquet_lake', dataset: 'gigamon_ami_pq' },
      { route: 'gigamon_ami_sample', input: 'datagen:in_gigamon_ami_sample', pipeline: 'gigamon_ami_normalize', output: 'cribl_lake:gigamon_ami_sample_lake', dataset: 'gigamon_ami_sample' },
    ],
  },
]

/**
 * A second name a counter may report an object under — `[bare, alias]`.
 * EMPTY, and UNVERIFIED: see the header. Add a pack-qualified form here only
 * once it has been seen in cribl_metrics.
 */
export const METRIC_ALIASES: readonly (readonly [string, string])[] = []

const PATHS: readonly StackPath[] = STACKS.flatMap((s) => s.paths)

/** Every path into the counted dataset, in list order. */
export const COUNTED_PATHS: readonly StackPath[] = PATHS.filter((p) => p.dataset === COUNTED_DATASET)

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)]

/** Sources with a path into gigamon_ami — the Sources plate. */
export const COUNTED_INPUTS: readonly string[] = uniq(COUNTED_PATHS.map((p) => p.input))

/** Destinations that write gigamon_ami — the Destinations plate and the Lake
 *  card. Never the Parquet copy's or the sample dataset's. */
export const COUNTED_OUTPUTS: readonly string[] = uniq(COUNTED_PATHS.map((p) => p.output))

/**
 * The counted paths whose pipeline counter is theirs alone: no other path —
 * into any dataset — runs the same source through the same pipeline. For these
 * `pipe.out_events` filtered by (pipeline, source) is one count per event.
 */
export const PIPELINE_COUNTED_PATHS: readonly StackPath[] = COUNTED_PATHS.filter(
  (p) => PATHS.filter((o) => o.input === p.input && o.pipeline === p.pipeline).length === 1,
)

/**
 * The counted paths that SHARE their (source, pipeline) pair with another path —
 * the pack's JSON + Parquet dual-write. The pipeline runs once per path, and its
 * counter has no dimension naming the path (route instances are unmeasured), so
 * `pipe.out_events` would count each event twice. The destination's own counter
 * does name the path — `total.out_events` by (source, destination) — so the
 * Processing figure for these is what reached the gigamon_ami destination.
 */
export const DESTINATION_COUNTED_PATHS: readonly StackPath[] = COUNTED_PATHS.filter(
  (p) => !PIPELINE_COUNTED_PATHS.includes(p),
)

/** A counter-name as a person reads it: `datagen:in_gigamon_datagen` → `in_gigamon_datagen`. */
const bare = (v: string): string => v.slice(v.indexOf(':') + 1)

/** `a`, `a and b`, `a, b and c`. */
const listed = (xs: readonly string[]): string =>
  xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/** The Sources plate's ⓘ line: which sources its figure adds up. */
export const COUNTED_SOURCES_PROSE = `The Sources figure adds up every source with a path into ${COUNTED_DATASET}: ${listed(COUNTED_INPUTS.map(bare))}. Each event is counted once, where it arrives.`

/** The Processing plate's ⓘ line. */
export const COUNTED_PIPELINES_PROSE = `The Processing figure adds up the pipelines on those paths: ${listed(uniq(COUNTED_PATHS.map((p) => p.pipeline)))}. Where one source's events take two paths through the same pipeline (the pack's JSON and Parquet copies), the pipeline counts each event twice, so for that source the figure is what reached the ${COUNTED_DATASET} destination instead.`

/** The Destinations plate's and the Cribl Lake card's ⓘ line. */
export const COUNTED_DESTINATIONS_PROSE = `The write counters add up only the destinations that write ${COUNTED_DATASET}: ${listed(COUNTED_OUTPUTS.map(bare))}. The Parquet copy and the sample dataset are not counted, so writing both copies does not double the figure.`
