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

/** Record-derived volume (what the AMI data itself says). */
export const VOLUME_QUERY = q('| summarize events=count(), bytes=sum(total_bytes), packets=sum(total_packets)')

/**
 * Real Cribl component telemetry, scoped to THIS data path.
 *
 * cribl_metrics carries the same counter at several aggregation levels, so the
 * namespace/dimension filters matter: without `namespace=="data_insights"` plus
 * the id/from_input/output dimension you double-count (total.in_events with a
 * null namespace reports 2x). Verified against this workspace.
 */
export const METRICS_QUERY =
  'dataset="cribl_metrics" | summarize ' +
  'src_events=sum(iif(metric=="pipe.in_events" and namespace=="data_insights" and from_input=="datagen:in_gigamon_datagen", value, 0)), ' +
  'pipe_events=sum(iif(metric=="pipe.out_events" and namespace=="data_insights" and id=="gigamon_ami", value, 0)), ' +
  'dst_events=sum(iif(metric=="total.out_events" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0)), ' +
  'dst_bytes=sum(iif(metric=="total.out_bytes" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0)), ' +
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
export const LAKE_TOTAL_QUERY =
  'dataset="cribl_metrics" | summarize ' +
  'total_events=sum(iif(metric=="total.out_events" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0)), ' +
  'total_bytes=sum(iif(metric=="total.out_bytes" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0))'
