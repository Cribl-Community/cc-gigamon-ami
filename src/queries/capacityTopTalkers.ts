// Every Cribl Search (KQL) query the Capacity & top talkers tab runs.
//
// These strings are customer-visible: each KPI tile and panel shows its query
// verbatim in the ⓘ popover as the provenance of the number on screen, and a
// committed snapshot of this module is regenerated and diffed by a test. So a
// "tidy-up" of spacing, quoting or ordering inside a template IS a change.
//
// Nothing here may import from a .tsx — the snapshot loads this module under
// plain Node, which cannot parse JSX. Plain data and `q` only.

import { q } from '../cribl/search'

// The pivot the whole tab scopes to. `field` is what lands in every query
// below, so editing one rewrites four queries; the tab imports this back to
// render the toggle and label its rows.
export const PIVOTS = [
  { key: 'src_ip', field: 'src_ip', label: 'Source IP', ph: 'e.g. 10.0.0.168', noun: 'talkers' },
  { key: 'app_name', field: 'app_name', label: 'App', ph: 'e.g. https / dns / openai', noun: 'apps' },
  { key: 'dst_aws_flat_tags_name', field: 'dst_aws_flat_tags_name', label: 'AWS service', ph: 'e.g. Postgres_Sql_GEM', noun: 'services' },
] as const
export type Pivot = (typeof PIVOTS)[number]['key']

export function pivotFor(pivot: Pivot) {
  return PIVOTS.find((x) => x.key === pivot)!
}

/** The filter prefix every query carries: substring match on the pivot field. */
function scopeFor(pivot: Pivot, applied: string) {
  const p = pivotFor(pivot)
  return applied ? `${p.field}="*${applied}*" ` : ''
}

/**
 * The six aggregates behind the KPI tiles, as a fragment.
 *
 * The byte expression and remaining aggregates are shared with the hourly
 * snapshot. It uses a separate byte column so Data Flow keeps its own meaning
 * of total_bytes while Capacity computes the same total on both read paths.
 */
export const KPI_TOTAL_BYTES = 'coalesce(src_bytes, 0) + coalesce(dst_bytes, 0)'
export const KPI_SOURCE_AGGS = 'tin=sum(dst_bytes), tout=sum(src_bytes), pkts=sum(total_packets), rtt=avg(tcp_rtt), retrans=sum(tcp_dup_ack)'
export const KPI_AGGS = `total=sum(total_bytes), ${KPI_SOURCE_AGGS}`

/**
 * The one aggregate the three byte panels below share: bytes, summed.
 *
 * Exported for the same reason KPI_AGGS is. The hourly snapshot body in
 * src/queries/snapshots.ts rolls this up by (app_name, l4_proto) and each of
 * those three panels sums the stored rows back along one key, so the scheduled
 * scan and the ⓘ over the number have to hold the SAME characters. Retyped,
 * they agree today and drift the first time somebody changes what "bytes"
 * means here — silently, because both still return a byte count.
 *
 * App Top Talkers, app mix and L4 split derive total_bytes from the two
 * directions first, as does their shared snapshot.
 */
export const BYTES_AGG = 'bytes=sum(total_bytes)'
export const L4_PROTOCOL = 'case(protocol == 6, "TCP", protocol == 17, "UDP", protocol == 1, "ICMP", protocol == 58, "ICMPv6", protocol == 132, "SCTP", "Other")'

/** Window totals behind the six KPI tiles. */
export function buildKpiQuery(pivot: Pivot, applied: string) {
  const scope = scopeFor(pivot, applied)
  return q(`${scope}| extend total_bytes = ${KPI_TOTAL_BYTES} | summarize ${KPI_AGGS}`)
}

/** Busiest entities by bytes, for the pivot in force. */
export function buildTalkersQuery(pivot: Pivot, applied: string) {
  const p = pivotFor(pivot)
  const scope = scopeFor(pivot, applied)
  return q(`${scope}${p.field}=* | extend total_bytes = ${KPI_TOTAL_BYTES} | summarize ${BYTES_AGG} by ${p.field} | sort by bytes desc | limit 12`)
}

/** App protocol mix (donut + ranked list). */
export function buildAppmixQuery(pivot: Pivot, applied: string) {
  const scope = scopeFor(pivot, applied)
  return q(`${scope}| extend total_bytes = ${KPI_TOTAL_BYTES} | summarize ${BYTES_AGG} by app_name | sort by bytes desc | limit 8`)
}

/** Byte split across transport protocols. */
export function buildL4Query(pivot: Pivot, applied: string) {
  const scope = scopeFor(pivot, applied)
  return q(`${scope}| extend l4_protocol = ${L4_PROTOCOL} | extend total_bytes = ${KPI_TOTAL_BYTES} | summarize ${BYTES_AGG} by l4_protocol | sort by bytes desc`)
}
