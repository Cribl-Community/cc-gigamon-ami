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
// ── HOW A PACK'S OBJECTS ARE NAMED (measured 2026-09-25) ────────────────────
//
// Inside a pack, cribl_metrics puts the pack id before the object's own id.
// Measured on a Cribl.Cloud Leader with a test pack `cc-network-gigamon-ami-dgtest`
// (throughput rows total.in_events / total.out_events / total.out_bytes,
// route.in_events / route.out_events, and health.inputs):
//
//   input  = <type>:<packId>.<inputId>      datagen:cc-network-gigamon-ami-dgtest.dg_asis
//   output = cribl_lake:<packId>.<outputId> cribl_lake:cc-network-gigamon-ami-dgtest.dg_sample_lake
//   route  = <packId>.<routeId>             cc-network-gigamon-ami-dgtest.dg_all_inputs
//
// The pack stacks below name their inputs, outputs and routes that way
// (../cribl/pack's `packInputLabel`, `packOutputLabel`, `packRouteLabel`, and
// PACK_0_1_0.paths, corrected the same day). Until then they used the bare
// global forms, which no pack row carries: every pack figure would have read 0.
//
// A PIPELINE INSIDE A PACK HAS NO MEASURED LABEL: no `pipe.*` row appeared for
// the test pack's one-function pipeline in a 30-minute window. So no counter
// here names a pack pipeline. Every path of a `scope: 'pack'` stack is counted
// for Processing by what its destination wrote (DESTINATION_COUNTED_PATHS),
// never by its pipeline, and its `pipeline` field is the id inside the pack,
// kept for the reader, not a label anything filters on.
//
// METRIC_ALIASES stays empty: the bare output form was seen once, on
// health/backpressure/blocked rows only, and the throughput rows the counters
// sum were measured directly with the pack id.
//
// PURE DATA, loaded by the query extractor under plain Node: nothing here may
// reach a .tsx or the network. ../cribl/pack is the one import, and it is pure
// data too: the pack's ids are its contract (pack.test.ts holds them to the
// pack YAML), so they are read from there rather than typed out again. Every export is frozen in __frozen__/display.json,
// so a change to which ids are counted is a visible diff.

import {
  PACK_0_1_0, PACK_HTTP_INPUT_ID, PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_JSON_OUTPUT_ID,
  PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_PARQUET_OUTPUT_ID, PACK_PIPELINE_ID, PACK_PUBLISHED_VERSIONS,
  PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID, PACK_SAMPLE_OUTPUT_ID, PACK_SAMPLE_ROUTE_ID,
  packInputLabel, packOutputLabel, packRouteLabel,
} from '../cribl/pack'

export interface StackPath {
  /** The route that carries this path, as cribl_metrics names it (`<packId>.<id>`
   *  inside a pack), or null for a QuickConnect connection. */
  route: string | null
  /** The source as cribl_metrics names it: `<type>:<id>`, or
   *  `<type>:<packId>.<id>` inside a pack (the `input` and `from_input`
   *  dimensions). */
  input: string
  /** The pipeline's id (the `id` dimension of `pipe.*` counters). For a
   *  pack's path, its id inside the pack: its label is unmeasured, and no
   *  counter filters on it (see the header). */
  pipeline: string
  /** The destination as cribl_metrics names it: `<type>:<id>`, or
   *  `<type>:<packId>.<id>` inside a pack (the `output` dimension). */
  output: string
  /** The Lake dataset that destination writes. */
  dataset: string
}

export interface Stack {
  key: string
  /** Where the objects live: the worker group's own config, or inside the pack. */
  scope: 'global' | 'pack'
  /** Whether anything can run it today, and how a tenant comes to have it.
   *  `running` is running in this workspace; `offered` is what this release
   *  offers to create; `retired` is what an earlier release of this app
   *  created and this one only offers to remove, which a tenant may still run.
   *  Those three are the ones the screen names. `released` is a published pack
   *  release a tenant may have installed — counted, but not named on screen
   *  until it is. `unreleased` is built but not published, `planned` is not
   *  built, and `pending` ids are not known yet. Every one of them is COUNTED:
   *  the status decides only what the screen names (SHOWN_PATHS below). */
  status: 'running' | 'offered' | 'retired' | 'released' | 'unreleased' | 'planned' | 'pending'
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
    // Earlier releases' Guided Setup wrote it; this one only offers to remove
    // it. A tenant that ran an earlier release can still have it running, so
    // it is still counted and still named.
    key: 'global-legacy-syslog',
    scope: 'global',
    status: 'retired',
    what: "The Syslog onboarding earlier releases of Guided Setup created (provision.ts's LEGACY_SYSLOG_*). It shares the demo's Lake destination.",
    paths: [
      { route: 'gigamon_ami_syslog', input: 'syslog:in_gigamon_syslog', pipeline: 'gigamon_syslog', output: 'cribl_lake:gigamon_lake', dataset: 'gigamon_ami' },
    ],
  },
  {
    // Written out, not imported: ../cribl/provision reaches the network, and
    // this file is loaded under plain Node. stackIds.test.ts holds these equal
    // to provision.ts's HTTP_* and LAKE_DESTINATION_ID, and the `http_raw:`
    // prefix to the route filter provision.ts writes.
    key: 'global-http',
    scope: 'global',
    status: 'offered',
    what: "Guided Setup's Raw HTTP onboarding (src/cribl/provision.ts). It shares the demo's Lake destination.",
    paths: [
      { route: 'gigamon_ami_http', input: 'http_raw:in_gigamon_http', pipeline: 'gigamon_http_normalize', output: 'cribl_lake:gigamon_lake', dataset: 'gigamon_ami' },
    ],
  },
  {
    // The published 0.1.0 release, from ../cribl/pack's PACK_0_1_0 — literals
    // read from that tag, never the 0.2.x constants, several of which kept
    // their names while their values changed. A tenant that installed 0.1.0
    // runs these ids until it upgrades. Its route filters never match inside a
    // pack (the same global-form assumption as 0.2.0), so its sources can
    // receive events that reach no destination; the plates show exactly that.
    key: 'pack-0.1.0',
    scope: 'pack',
    status: 'released',
    what: 'cc-network-gigamon-ami 0.1.0: Syslog and a sample DataGen, both shipped disabled.',
    paths: PACK_0_1_0.paths,
  },
  {
    // 0.2.0 (published 2026-09-25, whose route filters never match) and 0.2.1
    // (this build's pin, which fixes them) ship the same objects under the
    // same ids, so their metric labels are the same and one stack counts both.
    // The ids come from ../cribl/pack; the `<type>:` prefixes are the YAML's
    // `type:` fields, which stackIds.test.ts reads to hold them equal. The HTTP
    // source fans out: one route to the JSON dataset the dashboards read, one
    // to the Parquet copy, both through the same cast/derive pipeline.
    // (Keyed `pack-0.2.0`, and `unreleased`, until 2026-09-25.)
    key: 'pack-0.2',
    scope: 'pack',
    status: PACK_PUBLISHED_VERSIONS.includes('0.2.0') ? 'released' : 'unreleased',
    what: 'cc-network-gigamon-ami 0.2.0 and 0.2.1: Raw HTTP, dual-written as JSON and Parquet, plus a sample DataGen. 0.2.0 delivers nothing; 0.2.1 fixes its route filters.',
    paths: [
      { route: packRouteLabel(PACK_HTTP_JSON_ROUTE_ID), input: packInputLabel('http_raw', PACK_HTTP_INPUT_ID), pipeline: PACK_PIPELINE_ID, output: packOutputLabel('cribl_lake', PACK_JSON_OUTPUT_ID), dataset: PACK_LAKE_DATASET_ID },
      { route: packRouteLabel(PACK_HTTP_PARQUET_ROUTE_ID), input: packInputLabel('http_raw', PACK_HTTP_INPUT_ID), pipeline: PACK_PIPELINE_ID, output: packOutputLabel('cribl_lake', PACK_PARQUET_OUTPUT_ID), dataset: PACK_PARQUET_DATASET_ID },
      { route: packRouteLabel(PACK_SAMPLE_ROUTE_ID), input: packInputLabel('datagen', PACK_SAMPLE_INPUT_ID), pipeline: PACK_PIPELINE_ID, output: packOutputLabel('cribl_lake', PACK_SAMPLE_OUTPUT_ID), dataset: PACK_SAMPLE_DATASET_ID },
    ],
  },
]

/**
 * A second name a counter may report an object under — `[primary, alias]`.
 * EMPTY: the pack's labels are measured (see the header) and the paths name
 * them directly. Add a form here only once it has been seen on the throughput
 * rows the counters sum.
 */
export const METRIC_ALIASES: readonly (readonly [string, string])[] = []

const PATHS: readonly StackPath[] = STACKS.flatMap((s) => s.paths)

/** The paths whose objects live in the group's own config: the only ones a
 *  pipeline counter may name, since a pipeline's label inside a pack is
 *  unmeasured (see the header). */
const GLOBAL_PATHS: readonly StackPath[] = STACKS.filter((s) => s.scope === 'global').flatMap((s) => s.paths)

/** Every path into the counted dataset, in list order. */
export const COUNTED_PATHS: readonly StackPath[] = PATHS.filter((p) => p.dataset === COUNTED_DATASET)

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)]

/** Sources with a path into gigamon_ami — the Sources plate. */
export const COUNTED_INPUTS: readonly string[] = uniq(COUNTED_PATHS.map((p) => p.input))

/** Destinations that write gigamon_ami — the Destinations plate and the Lake
 *  card. Never the Parquet copy's or the sample dataset's. */
export const COUNTED_OUTPUTS: readonly string[] = uniq(COUNTED_PATHS.map((p) => p.output))

/**
 * The counted GLOBAL paths whose pipeline counter is theirs alone: no other
 * global path — into any dataset — runs the same source through the same
 * pipeline. For these `pipe.out_events` filtered by (pipeline, source) is one
 * count per event. A pack's path is never here: its pipeline's label is
 * unmeasured (2026-09-25), so it is counted by its destination instead.
 * (Pack paths are not compared either: a pack's pipeline is a different
 * object from a global one of the same id, and never shares a source label
 * with one.)
 */
export const PIPELINE_COUNTED_PATHS: readonly StackPath[] = COUNTED_PATHS.filter(
  (p) => GLOBAL_PATHS.includes(p) && GLOBAL_PATHS.filter((o) => o.input === p.input && o.pipeline === p.pipeline).length === 1,
)

/**
 * The counted paths no pipeline counter can answer for: every path inside a
 * pack, whose pipeline has no measured label (2026-09-25), and any path that
 * SHARES its (source, pipeline) pair with another path — the pack's JSON +
 * Parquet dual-write, where the pipeline runs once per path and its counter
 * has no dimension naming the path, so `pipe.out_events` would count each
 * event twice. The destination's own counter does name the path —
 * `total.out_events` by destination, plus the source only where that
 * destination is shared (SHARED_OUTPUTS) — so the Processing figure for these
 * is what reached the gigamon_ami destination.
 */
export const DESTINATION_COUNTED_PATHS: readonly StackPath[] = COUNTED_PATHS.filter(
  (p) => !PIPELINE_COUNTED_PATHS.includes(p),
)

const onePath = (key: (p: StackPath) => string) => (p: StackPath): boolean =>
  PATHS.filter((o) => key(o) === key(p)).length === 1

/**
 * Global pipelines more than one global path runs. Only for these does a
 * pipeline counter need `from_input` to say which path it counted; every other
 * pipeline is filtered by `id` alone. `from_input` on a ROUTED path's rows is
 * unmeasured (see the header), so it is used only where a pipeline is shared.
 * Pack pipelines are left out: no counter names them.
 */
export const SHARED_PIPELINES: readonly string[] = uniq(
  GLOBAL_PATHS.filter((p) => GLOBAL_PATHS.filter((o) => o.pipeline === p.pipeline).length > 1).map((p) => p.pipeline),
)

/** Destinations more than one path writes: the same rule, for `output`. */
export const SHARED_OUTPUTS: readonly string[] = uniq(PATHS.filter((p) => !onePath((o) => o.output)(p)).map((p) => p.output))

/** A counter-name as a person reads it: `datagen:in_gigamon_datagen` → `in_gigamon_datagen`. */
const bare = (v: string): string => v.slice(v.indexOf(':') + 1)

/** `a`, `a and b`, `a, b and c`. */
const listed = (xs: readonly string[]): string =>
  xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

// ── WHAT THE SCREEN NAMES ───────────────────────────────────────────────────
//
// The queries count every stack above, so they are right the day a pack is
// installed. The words on screen name only the stacks a tenant can have today
// (the demo feed, Guided Setup's onboarding and the Syslog onboarding earlier
// releases created), so a viewer is never told
// about an object no release has shipped, nor how a planned one will work.
// The query in the ⓘ still shows every id it counts; the sentence below
// accounts for the rest in one clause.

const SHOWN_PATHS: readonly StackPath[] = STACKS
  .filter((s) => s.status === 'running' || s.status === 'offered' || s.status === 'retired')
  .flatMap((s) => s.paths)
  .filter((p) => p.dataset === COUNTED_DATASET)

/** The sources, pipelines and destinations a tenant can have today, bare ids.
 *  The Data Flow stage headings and plates name these. */
export const SHOWN_INPUTS: readonly string[] = uniq(SHOWN_PATHS.map((p) => bare(p.input)))
export const SHOWN_PIPELINES: readonly string[] = uniq(SHOWN_PATHS.map((p) => p.pipeline))
export const SHOWN_OUTPUTS: readonly string[] = uniq(SHOWN_PATHS.map((p) => bare(p.output)))

/** The clause for counted paths the screen does not name, or nothing. */
const LATER = COUNTED_PATHS.some((p) => !SHOWN_PATHS.includes(p))
  ? ", plus the onboarding pack's once it is installed"
  : ''

/** The Processing plate's version of that clause: a pack path is counted by
 *  what its destination wrote, since a pipeline inside a pack has no measured
 *  counter name. Every counted path the screen does not name is a pack's. */
const LATER_PROCESSED = COUNTED_PATHS.some((p) => !SHOWN_PATHS.includes(p))
  ? `, plus the onboarding pack's once it is installed, counted as what its destination writes to ${COUNTED_DATASET}`
  : ''

/** The Sources plate's ⓘ line: which sources its figure adds up. */
export const COUNTED_SOURCES_PROSE = `The Sources figure adds up every source with a path into ${COUNTED_DATASET}: ${listed(SHOWN_INPUTS)}${LATER}. Each event is counted once, where it arrives.`

/** The Processing plate's ⓘ line. */
export const COUNTED_PIPELINES_PROSE = `The Processing figure adds up the pipelines on those paths: ${listed(SHOWN_PIPELINES)}${LATER_PROCESSED}. Each event is counted once.`

/** The Destinations plate's and the Cribl Lake card's ⓘ line. */
export const COUNTED_DESTINATIONS_PROSE = `The write counters add up only the destinations that write ${COUNTED_DATASET}: ${listed(SHOWN_OUTPUTS)}${LATER}. A copy written to any other dataset is not counted.`
