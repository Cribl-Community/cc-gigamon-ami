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
import { REPLY_CODE_AGGS } from './dnsHealth'
import { HOSTS_HEAD, HOST_ERR_AGG, SERVER_P95_AGG } from './webApiHealth'
import { SUBNET24_HEAD } from './tcpHealth'

/**
 * Graph nodes: the twelve busiest destination IPs, each labelled with an
 * `http_host` seen on its flows where there is one, and coloured by p95
 * `tcp_rtt` and the share of its flows carrying duplicate ACKs. The map used
 * to name nodes by the AWS Name tag (`dst_aws_flat_tags_name`) and colour them
 * by `tcp_rtt_app` and `tcp_reset`; the live feed carries none of the three
 * (measured 2026-11-02 over one hour: 0 of 70,197 events).
 */
export const nodesQuery = q('| summarize net=percentile(tcp_rtt,95), net_n=count(tcp_rtt), dupack_flows=countif(toreal(tcp_dup_ack)>0), dupack_n=count(tcp_dup_ack), host=max(http_host), flows=count() by dst_ip | sort by flows desc | limit 12')

/**
 * Edges: the busiest source IP → destination IP pairs. The tab draws the pairs
 * whose both ends are drawn, adds the busiest sources that are not drawn
 * destinations as "client only" nodes, and sums each drawn source's flows to
 * every other destination into the "Other destinations" hub. All of it is over
 * these 1,000 pairs, not over every pair in the window.
 */
export const pairsQuery = q('| summarize flows=count() by src_ip, dst_ip | sort by flows desc | limit 1000')

/**
 * DNS dependency view: which clients lean on which resolvers. One row per
 * client IP → resolver (`dns_host`) pair, with the reply-code counts the DNS
 * tab uses (`REPLY_CODE_AGGS`) and p95 `dns_response_time` (seconds). The tab
 * sums the pairs into resolver nodes; failure share is SERVFAIL + NXDOMAIN.
 */
export const DNS_DEPS_QUERY = q('app_name="dns" dns_host=* | summarize total=count(), ' + REPLY_CODE_AGGS + ', p95=percentile(dns_response_time,95) by src_ip, dns_host | sort by total desc | limit 500')

/**
 * Web/API dependency view: which clients call which HTTP hosts. One row per
 * client IP → `http_host` pair, with the Web tab's own error count
 * (`HOST_ERR_AGG`, http_code ≥ 400) and p95 `http_rtt` in ms (`SERVER_P95_AGG`).
 */
export const WEB_DEPS_QUERY = q(HOSTS_HEAD + ' | summarize n=count(), ' + HOST_ERR_AGG + ', ' + SERVER_P95_AGG + ' by src_ip, http_host | sort by n desc | limit 500')

/**
 * Subnet view: /24 → /24 TCP dependencies, built on the TCP tab's own subnet
 * derivation (`SUBNET24_HEAD`), with p95 `tcp_rtt` and the duplicate-ACK share
 * the destinations graph colours by.
 */
export const SUBNET_DEPS_QUERY = q(SUBNET24_HEAD + ' | summarize flows=count(), net=percentile(tcp_rtt,95), net_n=count(tcp_rtt), dupack_flows=countif(toreal(tcp_dup_ack)>0), dupack_n=count(tcp_dup_ack) by src_subnet, dst_subnet | sort by flows desc | limit 500')

/** Everything below the map is scoped to the destination IP selected on it. */
const serviceFilter = (service: string) => `dst_ip="${service}"`

/** p95 per latency domain plus the packet evidence, for one service. */
export function buildDomainsQuery(service: string): string {
  const filter = serviceFilter(service)
  return q(`${filter} | summarize net=percentile(tcp_rtt,95), app=percentile(tcp_rtt_app,95), srv=percentile(toreal(http_rtt),95)*1000, srvn=countif(isnotnull(toreal(http_rtt))), dns=percentile(dns_response_time,95), dupack=sum(tcp_dup_ack), crc=sum(tcp_wrong_crc), reset=sum(tcp_reset), flows=count()`)
}

/** The same domains per 1-minute bin, for the decomposition chart. */
export function buildTrendQuery(service: string): string {
  const filter = serviceFilter(service)
  return q(`${filter} | summarize net=percentile(tcp_rtt,95), app=percentile(tcp_rtt_app,95), srv=percentile(toreal(http_rtt),95)*1000, dns=percentile(dns_response_time,95) by bin(_time,1m) | sort by _time asc`)
}
