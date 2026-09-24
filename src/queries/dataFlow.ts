// Every Cribl Search (KQL) query the Deep Observability Pipeline tab runs.
//
// These strings are customer-visible: a panel's ⓘ shows the exact query behind
// its numbers, so the text IS the provenance of the figure on screen. Nothing here
// may be reformatted, requoted or reordered to tidy it up — a committed snapshot is
// regenerated from this module and diffed, so any drift fails that check.
//
// That check loads this module under plain Node, so nothing here may import a .tsx,
// or anything that reaches one (../cribl/useSearch, ../app/*, ../components/*).
//
// The two cribl_metrics queries name their own dataset, so they never go through q().

import { q } from '../cribl/search'
import {
  COUNTED_INPUTS, COUNTED_OUTPUTS, DESTINATION_COUNTED_PATHS, METRIC_ALIASES, PIPELINE_COUNTED_PATHS,
} from './stackIds'

// ── Which objects the counters name ─────────────────────────────────────────
//
// Not here: every Stream object id these queries name comes from ./stackIds.ts,
// so a new stack (the onboarding pack, the Raw HTTP onboarding) is one entry
// there. These helpers only spell the list out in KQL.

/** Every name a counter may report `v` under: itself, plus any measured alias. */
const forms = (v: string): string[] => [v, ...METRIC_ALIASES.filter(([b]) => b === v).map(([, a]) => a)]

/** `dim=="a"`, or `(dim=="a" or dim=="b")` for more than one. */
function anyOf(dim: string, values: readonly string[]): string {
  const terms = values.flatMap(forms).map((v) => `${dim}==${JSON.stringify(v)}`)
  return terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`
}

/** One or more conjunctions, OR-ed: `(a and b)`, or `((a and b) or (c and d))`. */
function anyOfAll(terms: readonly string[]): string {
  const each = terms.map((t) => `(${t})`)
  return each.length === 1 ? each[0] : `(${each.join(' or ')})`
}

/**
 * Written to a destination that writes gigamon_ami.
 *
 * NOTHING DOUBLE-COUNTED: a `total.out_*` row names one destination, and a
 * destination writes an event once per path that reaches it. Each source has at
 * most one path into gigamon_ami (stackIds.test.ts holds that), so each event
 * that lands is one write to one of these destinations. The demo and Syslog
 * stacks share `gigamon_lake`, but their events are different events. The
 * pack's Parquet copy and the sample dataset are other destinations, not listed,
 * so a dual-write lands once here — which is the whole point of the Lake card.
 * Not filtered by source: an event some other route writes into gigamon_ami
 * has landed there too.
 */
const WRITES_TO_DATASET = `namespace=="data_insights" and ${anyOf('output', COUNTED_OUTPUTS)}`

/**
 * Received by a source with a path into gigamon_ami.
 *
 * `total.in_events` by `input`, not `pipe.in_events` by `from_input`: the pipe
 * counter counts each PASS, and the pack's dual-write sends every event through
 * its pipeline twice. The source's own intake is one row per event however many
 * routes then take it. Measured 2026-09-24 on the demo feed: the two agree
 * exactly while there is one path (26,302 and 26,302 over three minutes).
 */
const RECEIVED = `metric=="total.in_events" and namespace=="data_insights" and ${anyOf('input', COUNTED_INPUTS)}`

/**
 * Passed on by a pipeline, one count per event.
 *
 * Where a source's (pipeline, source) pair is on only one path, the pipeline's
 * own `pipe.out_events` for that pair is one per event. Where the pair is on
 * two — the pack's JSON and Parquet routes both run gigamon_ami_normalize — the
 * pipeline counter is two per event and carries no dimension naming the route
 * (a routed path's `instance` is unmeasured), so that source is counted by what
 * the gigamon_ami destination received from it: `total.out_events` by
 * (source, destination), which names exactly one path.
 */
const PROCESSED = 'namespace=="data_insights" and ' + anyOfAll([
  ...(PIPELINE_COUNTED_PATHS.length
    ? [`metric=="pipe.out_events" and ${anyOfAll(PIPELINE_COUNTED_PATHS.map((p) => `${anyOf('id', [p.pipeline])} and ${anyOf('from_input', [p.input])}`))}`]
    : []),
  ...(DESTINATION_COUNTED_PATHS.length
    ? [`metric=="total.out_events" and ${anyOfAll(DESTINATION_COUNTED_PATHS.map((p) => `${anyOf('from_input', [p.input])} and ${anyOf('output', [p.output])}`))}`]
    : []),
])

// The fragment, exported so the hourly snapshot body holds the same characters
// rather than a retyped copy of them (see snapshots.ts).
export const VOLUME_AGGS = 'events=count(), bytes=sum(total_bytes), packets=sum(total_packets)'

/** Record-derived volume (what the AMI data itself says). */
export const VOLUME_QUERY = q('| summarize ' + VOLUME_AGGS)

/**
 * Real Cribl component telemetry, scoped to the paths into gigamon_ami
 * (./stackIds.ts — every stack that can carry the data, summed).
 *
 * cribl_metrics carries the same counter at several aggregation levels, so the
 * namespace/dimension filters matter: without `namespace=="data_insights"` plus
 * the id/from_input/input/output dimension you double-count (total.in_events with
 * a null namespace reports 2x). Verified against this workspace. Why each column
 * counts an event once is written beside RECEIVED, PROCESSED and
 * WRITES_TO_DATASET above; stackIds.test.ts checks it against a model of the rows.
 */
export const METRICS_QUERY =
  'dataset="cribl_metrics" | summarize ' +
  `src_events=sum(iif(${RECEIVED}, value, 0)), ` +
  `pipe_events=sum(iif(${PROCESSED}, value, 0)), ` +
  `dst_events=sum(iif(metric=="total.out_events" and ${WRITES_TO_DATASET}, value, 0)), ` +
  `dst_bytes=sum(iif(metric=="total.out_bytes" and ${WRITES_TO_DATASET}, value, 0)), ` +
  'blocked=sum(iif(metric=="blocked.outputs", value, 0)), ' +
  'backpressure=sum(iif(metric=="backpressure.outputs", value, 0))'

/**
 * What is actually held in the Lake dataset, independent of the page's range —
 * a storage stage should report what it stores, not just the window's inflow.
 *
 * Summing the write counters over the retention period is ~4x faster than
 * counting the dataset directly (17s vs 64s) and agrees within 0.3%
 * (18.24M vs 18.30M). They match only because nothing has aged out yet; once
 * data exceeds 30 days this becomes "written", not "retained".
 */
/**
 * What the Lake dataset holds, counted from the dataset itself.
 *
 * The write-counter sum above is exact only while the window it covers is one
 * `cribl_metrics` still holds: that dataset has its own retention (30 days,
 * measured 2026-09-23), so a `gigamon_ami` kept for 365 days cannot be totalled
 * from it. When the dataset's retention is the longer of the two this is the
 * query, over the whole retention period. It is the expensive one — measured at
 * 525 s for 30 days on 2026-09-23 — which is why it runs in the daily schedule
 * and only where the write counters cannot answer (src/queries/lakeWindow.ts).
 */
export const LAKE_HELD_QUERY = q('| summarize total_events=count()')

/**
 * Written to gigamon_ami, by the write counters. Only the destinations that
 * write gigamon_ami (WRITES_TO_DATASET above): the pack's Parquet copy and the
 * sample dataset are left out, so dual-writing does not double "events held".
 */
export const LAKE_TOTAL_QUERY =
  'dataset="cribl_metrics" | summarize ' +
  `total_events=sum(iif(metric=="total.out_events" and ${WRITES_TO_DATASET}, value, 0)), ` +
  `total_bytes=sum(iif(metric=="total.out_bytes" and ${WRITES_TO_DATASET}, value, 0))`
