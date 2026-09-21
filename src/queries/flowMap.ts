// Every Cribl Search (KQL) query the Flow map tab runs.
//
// These strings are customer-visible: a panel's ⓘ shows the exact query behind
// its numbers, so the text IS the provenance of the figure on screen. Nothing here
// may be reformatted, requoted or reordered to tidy it up — a committed snapshot is
// regenerated from this module and diffed, so any drift fails that check.
//
// That check loads this module under plain Node, so nothing here may import a .tsx,
// or anything that reaches one (../cribl/useSearch, ../app/*, ../components/*).

import { q } from '../cribl/search'

/** Graph nodes: one row per AWS name-tagged destination service. */
export const nodesQuery = q('dst_aws_flat_tags_name=* | summarize app=percentile(tcp_rtt_app,95), app_n=count(tcp_rtt_app), dns=percentile(dns_response_time,95), dns_n=count(dns_response_time), resets=sum(tcp_reset), flows=count() by dst_aws_flat_tags_name | sort by flows desc | limit 12')

// ── THE TWO THE TAB NO LONGER SUBMITS ───────────────────────────────────────
// `edgesQuery` and `srcQuery` are the two questions the service graph asks about
// the traffic between services, and they used to be two jobs. The tab now runs
// SERVICE_EDGES_SNAPSHOT_QUERY (./snapshots.ts) once and derives both from its
// rows — in Live mode as well as from the hourly snapshot — because read.ts
// submits a stored-result job per served panel, so two panels of one entry meant
// two reads of one result on the app's default route.
//
// They are kept, unedited, because they are the exact statements of what those
// two derivations compute, and because deleting a customer-visible query string
// is a change to the display freeze rather than a tidy-up. Anyone checking that
// the client-side arithmetic in FlowMap.tsx is right checks it against these.

/** Solid edges: src→dst pairs where both endpoints carry an AWS name tag. */
export const edgesQuery = q('src_aws_flat_tags_name=* dst_aws_flat_tags_name=* | summarize flows=count() by src_aws_flat_tags_name, dst_aws_flat_tags_name | sort by flows desc | limit 40')

// Total outbound per source service: surfaces client-only services the
// destination-grouped node query misses, and lets us derive how much of each
// service's traffic goes to peers carrying no AWS name tag.
export const srcQuery = q('src_aws_flat_tags_name=* | summarize out=count() by src_aws_flat_tags_name | sort by out desc | limit 20')

/** Everything below the map is scoped to the service selected on it. */
const serviceFilter = (service: string) => `dst_aws_flat_tags_name="${service}"`

/** p95 per latency domain plus the packet evidence, for one service. */
export function buildDomainsQuery(service: string): string {
  const filter = serviceFilter(service)
  return q(`${filter} | summarize net=percentile(tcp_rtt,95), app=percentile(tcp_rtt_app,95), srv=percentile(http_server_ms,95), srvn=count(http_server_ms), dns=percentile(dns_response_time,95), dupack=sum(tcp_dup_ack), crc=sum(tcp_wrong_crc), reset=sum(tcp_reset), flows=count()`)
}

/** The same domains per 1-minute bin, for the decomposition chart. */
export function buildTrendQuery(service: string): string {
  const filter = serviceFilter(service)
  return q(`${filter} | summarize net=percentile(tcp_rtt,95), app=percentile(tcp_rtt_app,95), srv=percentile(http_server_ms,95), dns=percentile(dns_response_time,95) by bin(_time,1m) | sort by _time asc`)
}
