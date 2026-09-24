// Every Cribl Search (KQL) query the TCP health tab runs.
//
// These strings are customer-visible: each panel shows its query verbatim in
// the ⓘ popover as the provenance of the numbers on screen, and a committed
// snapshot of this module is regenerated and diffed by a test. So a "tidy-up"
// of spacing, quoting or ordering inside a template IS a change.
//
// Nothing here may import from a .tsx — the snapshot loads this module under
// plain Node, which cannot parse JSX. Plain data and `q` only.

import { q } from '../cribl/search'

// The wire-error metric the heatmap and trend measure. `field` is the AMI
// column summed in two queries; the tab imports this back for the toggle.
export const METRICS = [
  { key: 'dupacks', field: 'tcp_dup_ack', label: 'Dup ACKs', info: 'tcp_dup_ack — duplicate ACKs per flow, a retransmission signal.' },
  { key: 'resets', field: 'tcp_reset', label: 'Resets', info: 'tcp_reset — fraction of flows where the RST bit was seen (abrupt close), derived from tcp_flags.' },
  { key: 'crc', field: 'tcp_wrong_crc', label: 'Wrong CRC', info: 'tcp_wrong_crc — checksum errors per flow (corruption on the wire).' },
  { key: 'loss', field: 'tcp_loss_count', label: 'Loss', info: 'tcp_loss_count — detected lost segments per flow.' },
] as const
export type MetricKey = (typeof METRICS)[number]['key']

/** Subnet aggregation: /24 (first 3 octets) or /16 (first 2). */
export type Mask = '24' | '16'

export function metricFor(metric: MetricKey) {
  return METRICS.find((x) => x.key === metric)!
}

/** The subnet columns the mask selects — grouped by, and read back, as a pair. */
export function subnetFields(mask: Mask) {
  const sf = mask === '24' ? 'src_subnet' : 'src_subnet16'
  const df = mask === '24' ? 'dst_subnet' : 'dst_subnet16'
  return { sf, df }
}

/** src subnet × dst subnet matrix; the tab derives the per-flow rate from it. */
export function buildHeatQuery(metric: MetricKey, mask: Mask) {
  const field = metricFor(metric).field
  const { sf, df } = subnetFields(mask)
  return q(`protocol=6 ${sf}=* ${df}=* | summarize v=sum(${field}), flows=count() by ${sf}, ${df} | sort by flows desc | limit 120`)
}

// Endpoint-level breakdown for the selected subnet pair. Only runs while a
// cell is selected; re-runs when the pair (or subnet mask) changes.
export function buildDrillQuery(sel: { row: string; col: string } | null, mask: Mask) {
  const { sf, df } = subnetFields(mask)
  return sel
    ? q(`protocol=6 ${sf}="${sel.row}" ${df}="${sel.col}" | summarize flows=count(), retrans=sum(tcp_dup_ack), resets=sum(tcp_reset), crc=sum(tcp_wrong_crc), loss=sum(tcp_loss_count), net=percentile(tcp_rtt,95), app=percentile(tcp_rtt_app,95) by src_ip, dst_ip | sort by flows desc | limit 100`)
    : ''
}

/** Per-1m trend of the selected wire-error metric. */
export function buildTrendQuery(metric: MetricKey) {
  const field = metricFor(metric).field
  return q(`protocol=6 | summarize v=sum(${field}), flows=count() by bin(_time, 1m) | sort by _time asc`)
}

/** p95 network vs application RTT, with the min–max band. */
/**
 * The six latency aggregates the "Network vs app latency" panel draws, as a
 * fragment — so the Lake landing parity check (src/queries/lakeLanding.ts)
 * computes THESE characters over its window rather than a retyped copy.
 * Percentile and min are the aggregates an absent-reads-as-zero column drags
 * toward 0, and no rewrite of the KQL can undo that (an absent number and a
 * real 0 are the same bytes). `latencyQuery` resolves to what it did before.
 */
export const LATENCY_AGGS =
  'net=percentile(tcp_rtt,95), net_lo=min(tcp_rtt), net_hi=max(tcp_rtt), ' +
  'app=percentile(tcp_rtt_app,95), app_lo=min(tcp_rtt_app), app_hi=max(tcp_rtt_app)'

export const latencyQuery = q('| summarize ' + LATENCY_AGGS + ' by bin(_time, 1m) | sort by _time asc')

// ── The fragment the hourly subnet snapshots are built from ─────────────────
//
// `buildHeatQuery` sums ONE metric because the panel shows one at a time. The
// scheduled body sums ALL FOUR, and each of the four panel states projects its
// own out of the stored rows — which is exact rather than approximate for a
// reason worth stating here, beside the strings it is about:
//
//   the live query's own `sort by flows desc | limit 120` sorts on `flows`,
//   which is `count()` and carries NO METRIC IN IT.
//
// So the 120 rows kept are the same 120 rows whichever metric is selected, and
// a tail that projects one of four stored sums off those rows returns the rows
// the live query would have returned, column for column. Change that sort to
// anything metric-dependent — `sort by v desc` — and this stops being true and
// the entries in accel/manifest.ts have to go.
//
// Aliased by METRIC KEY rather than by field name, because the manifest's tails
// are generated from the same METRICS list: `v=${m.key}`. Retyped in either
// place the two agree today and drift the first time a metric is added.
export const HEAT_METRIC_AGGS = METRICS.map((m) => `${m.key}=sum(${m.field})`).join(', ')
