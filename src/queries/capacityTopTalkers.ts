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
 * Exported so the hourly snapshot body (src/queries/snapshots.ts) can hold the
 * SAME characters rather than a retyped copy of them. The ⓘ over these tiles
 * claims this computation produced the number; if the scheduled body restated it
 * the two would drift the first time somebody edited one, silently, because both
 * would still return six numbers.
 */
export const KPI_AGGS = 'total=sum(total_bytes), tin=sum(dst_bytes), tout=sum(src_bytes), pkts=sum(total_packets), rtt=avg(tcp_rtt), retrans=sum(tcp_dup_ack)'

/** Window totals behind the six KPI tiles. */
export function buildKpiQuery(pivot: Pivot, applied: string) {
  const scope = scopeFor(pivot, applied)
  return q(`${scope}| summarize ${KPI_AGGS}`)
}

/** Busiest entities by bytes, for the pivot in force. */
export function buildTalkersQuery(pivot: Pivot, applied: string) {
  const p = pivotFor(pivot)
  const scope = scopeFor(pivot, applied)
  return q(`${scope}${p.field}=* | summarize bytes=sum(total_bytes) by ${p.field} | sort by bytes desc | limit 12`)
}

/** App protocol mix (donut + ranked list). */
export function buildAppmixQuery(pivot: Pivot, applied: string) {
  const scope = scopeFor(pivot, applied)
  return q(`${scope}| summarize bytes=sum(total_bytes) by app_name | sort by bytes desc | limit 8`)
}

/** Byte split across transport protocols. */
export function buildL4Query(pivot: Pivot, applied: string) {
  const scope = scopeFor(pivot, applied)
  return q(`${scope}| summarize bytes=sum(total_bytes) by l4_proto | sort by bytes desc`)
}
