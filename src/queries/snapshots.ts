// The bodies the hourly snapshot searches run — one scan standing in for several
// panels' worth of live queries.
//
// ─────────────────────────────────────────────────────────────────────────────
// THESE ARE CUSTOMER-VISIBLE STRINGS, and they are visible in a way the other
// modules here are not. A panel's ⓘ shows the query the panel itself runs; what
// these bodies do is produce the NUMBER that ⓘ describes, on a schedule, once an
// hour. So there are two strings behind a snapshot-served figure, and they have
// to compute the same thing over the same rows or the ⓘ is a false claim.
//
// ── WHY EVERY AGGREGATE HERE IS AN IMPORT ───────────────────────────────────
// Not one aggregate below is typed out. `KPI_AGGS`, `COUNT_AGGS`, `FINDING_AGGS`
// and `VOLUME_AGGS` are the same characters the panels' own queries are built
// from, exported from their own modules for exactly this. Retyped, they would
// agree on the day they were written and drift the first time somebody edited
// one — silently, because both versions still return numbers of the right shape
// and nothing on screen would change. The union body is the ONE place in this
// app where a copy-paste is a wrong number rather than a lint complaint.
//
// ── THE ALIAS RULE, WHICH IS THE WHOLE CORRECTNESS ARGUMENT ─────────────────
// Five panels read one row. Each one reads the columns it already reads today,
// so the read path's tail is a plain `| project` of the panel's own alias names
// and nothing is renamed on the way out. That works because the five alias sets
// are disjoint — with one exception, and the exception is the dangerous shape:
//
//   Capacity's tiles call sum(total_bytes) `total`.
//   Findings' tiles call count()           `total`.
//
// A body defining `total` once would hand one of those panels the other's
// number: correctly formatted, plausible, and wrong by ten orders of magnitude
// with no error anywhere. So this body defines `total` with Capacity's meaning
// and `findings_total` with Findings', and Findings.tsx reads `total ?? findings_total`.
// The rule, stated so the next entry follows it: **the body never defines an
// alias that a served panel also defines with a different meaning.** manifest's
// own test enforces the mechanical half (every alias a tail projects exists in
// the body); this comment is the half a test cannot check.
//
// ── WHAT IS DELIBERATELY NOT IN THE OVERVIEW BODY ───────────────────────────
// DNS (Q14). Its panel reads five numbers together and four of them are trivial
// sums, but the fifth is a distinct count of resolvers restricted to DNS rows —
// `dcountif(dns_host, app_name=="dns")`, or a composed `dcount(iif(…))`. Neither
// form has been run against this platform, and the panel reads the five as one
// row: four right numbers and one guess is not a servable panel. So DNS stays
// live, and its four sums are not carried here either — an aggregate nothing
// reads is scan cost with no reader.
//
// THAT PARAGRAPH IS ABOUT THE OVERVIEW BODY AND NOTHING ELSE, and it was being
// read as if it struck DNS off the list altogether. What it rules out is folding
// DNS into a scan that has no `app_name="dns"` head and therefore needs a
// conditional distinct count nobody has run. Given a scan of its own — the head
// IS `app_name="dns"` — the distinct count stops being a `dcountif` question:
// group by resolver and every stored row IS one distinct resolver, so the tile
// counts rows rather than composing a `dcount`. DNS_RESOLVER_SNAPSHOT_QUERY
// below is that scan, and it serves both of the tab's mount queries.
//
// Nothing here may import a .tsx, or anything that reaches one: the freeze
// extractor loads this module under plain Node.
// ─────────────────────────────────────────────────────────────────────────────

import { q } from '../cribl/search'
import { KPI_AGGS as CAPACITY_KPI_AGGS } from './capacityTopTalkers'
import { KPI_AGGS as WEB_KPI_AGGS } from './webApiHealth'
import { COUNT_AGGS as SECURITY_COUNT_AGGS } from './security'
import { FINDING_AGGS } from './findings'
import { VOLUME_AGGS } from './dataFlow'
// The DNS reply-code aggregates, imported rather than retyped: the stored body
// and the ⓘ beside the number have to be the same characters. See dnsHealth.ts.
import { REPLY_CODE_AGGS } from './dnsHealth'

/**
 * One unfiltered scan of the window, carrying every whole-window aggregate five
 * panels on five tabs ask for separately today.
 *
 * Each contributing query has no head filter of its own, which is what makes the
 * union exact rather than approximate: the aggregates are computed over the same
 * rows they would have been computed over alone. A panel whose query carries a
 * filter — Capacity with free text typed in, every drill-down — is not served by
 * this and falls through to its live query, because the filter is not in here.
 */
export const OVERVIEW_SNAPSHOT_QUERY = q(
  '| summarize ' +
    [
      CAPACITY_KPI_AGGS,
      WEB_KPI_AGGS,
      SECURITY_COUNT_AGGS,
      // `findings_total`, not `total` — see the alias rule above.
      'findings_total=count(), ' + FINDING_AGGS,
      VOLUME_AGGS,
    ].join(', '),
)

/**
 * Service-map edges, with the untagged destination kept rather than dropped.
 *
 * The obvious body — `summarize flows=count() by src…, dst…` — serves the edge
 * panel and quietly breaks the one beside it. The client-only panel's number is
 * every flow OUT of a source service, including flows to peers carrying no AWS
 * name tag, and whether a `summarize` keeps a null group key is not something
 * this app has measured. If it drops them, that panel's totals come back short
 * by however much of the traffic leaves the tagged estate — a smaller number, in
 * the direction a viewer cannot detect.
 *
 * So the null is turned into a group of its own before the grouping happens.
 * `dst_svc` is empty for exactly those flows: the edge panel filters them out
 * (which is what its own `dst_aws_flat_tags_name=*` head does) and the
 * client-only panel sums across them (which is what its `count() by src` does).
 * Both are then exact by construction rather than by assumption.
 *
 * `extend` and `iif`/`isnotnull` are all shapes this app already runs live.
 */
export const SERVICE_EDGES_SNAPSHOT_QUERY = q(
  'src_aws_flat_tags_name=* | extend dst_svc=iif(isnotnull(dst_aws_flat_tags_name), dst_aws_flat_tags_name, "") | summarize flows=count() by src_aws_flat_tags_name, dst_svc',
)

/**
 * Every (application, source) pair seen in the window, with its flows and bytes.
 *
 * ONE SCAN FOR THE WHOLE SHADOW AI TAB. That tab fires three queries on mount —
 * apps by flows, the AI totals, and the top AI users — and none of them was
 * served, which is what made it the slowest tab in the app at roughly eight
 * seconds. All three are re-aggregations of this one grouping.
 *
 * ── WHY THE GROUPING IS (app_name, src_ip) AND NOT app_name ────────────────
 * This is the whole correctness argument and it is not tidiness. The obvious
 * body groups by `app_name` and stores `users=dcount(src_ip)` per app, which
 * serves the bar list directly. The "AI users" tile then has to add those
 * per-app counts up — and that DOUBLE-COUNTS anybody using two AI apps. The
 * tile reads high, plausibly, in the one direction a viewer cannot detect, on
 * the single number the tab exists to produce.
 *
 * Grouped on the pair, every distinct count is recomputed over stored rows
 * instead of summed: one row per (app, source) means `dcount(src_ip)` across the
 * AI rows is the true distinct-user count, and `dcount(app_name)` per source is
 * the true app-diversity badge. All three tails are then exact.
 *
 * ── THE ALIAS RULE, AND WHY `flows` IS SAFE HERE ───────────────────────────
 * The rule above says the body never defines an alias a served panel also
 * defines with a different meaning. `flows` looks like a breach — here it is
 * flows for one (app, source) pair, and the bar list's `flows` is flows for a
 * whole app. It is safe for a reason the overview body could not use: every
 * panel on this entry has a RE-AGGREGATING tail, so no panel ever reads the
 * body's row. `flows` is consumed by `sum(flows)` inside the tail and the alias
 * the panel reads is the one the tail defines. If a future panel is ever added
 * to this entry WITHOUT a tail, that panel must not read `flows`.
 *
 * ── THE ONE THING NOBODY HAS MEASURED (M-7) ────────────────────────────────
 * These tails recompute `dcount` over stored pairs rather than over raw records.
 * That is exact if the platform's `dcount` is exact. If it is an HLL estimate,
 * the live number and the stored-read number are estimates over DIFFERENT
 * inputs, so "AI users" may move by a little when the tab switches between
 * Snapshot and Live. It is written down here so that it is a known property
 * rather than a bug report.
 */
export const APP_SRC_SNAPSHOT_QUERY = q('| summarize flows=count(), bytes=sum(total_bytes) by app_name, src_ip')

/**
 * Every DNS response in the window, grouped by the resolver that answered —
 * including the ones that name no resolver at all.
 *
 * ONE SCAN FOR BOTH OF DNS HEALTH'S MOUNT QUERIES. The tab fires OVERALL and
 * PER_RESOLVER together and waits for both, which is what makes it the app's
 * longest wait on open (~7–12 s). They differ in exactly two ways: PER_RESOLVER
 * adds a `dns_host=*` head and a per-resolver grouping, and OVERALL adds a
 * distinct count of resolvers. Both fall out of this grouping.
 *
 * ── THE EMPTY-GROUP GUARD, WHICH IS THE CORRECTNESS ARGUMENT ────────────────
 * OVERALL's head is `app_name="dns"`; PER_RESOLVER's is `app_name="dns"
 * dns_host=*`. So OVERALL's `total` counts DNS responses that carry no resolver
 * name and PER_RESOLVER's rows do not. Group naively `by dns_host` and whether a
 * null key survives is not something this app has measured — if it does not,
 * OVERALL's total and its SERVFAIL rate come back short by exactly those rows:
 * a smaller number, correctly formatted, in the one direction a viewer cannot
 * detect, on the tile that says how much DNS is failing.
 *
 * So the null becomes a group of its own before the grouping happens, the same
 * trick SERVICE_EDGES_SNAPSHOT_QUERY above uses and for the same reason.
 * `dns_h` is empty for exactly those rows: the resolver table filters them out
 * (which is what its own `dns_host=*` head does) and the error-rate tile sums
 * across them (which is what OVERALL's unfiltered `count()` does). Both are
 * exact by construction rather than by assumption.
 *
 * ── WHY `dcount` LEAVES THE READ PATH ENTIRELY ──────────────────────────────
 * OVERALL's fifth number is `resolvers=dcount(dns_host)`, and a `dcount` does
 * not compose: summing per-group distinct counts counts anything in two groups
 * twice. Nothing is summed here. `summarize … by dns_h` emits ONE ROW PER
 * DISTINCT RESOLVER, so the tile counts rows — `sum(iif(dns_h != "", 1, 0))` —
 * and that is exact by definition rather than by estimate, whether or not the
 * platform's `dcount` is an HLL sketch.
 *
 * It may differ from the live tile BY ONE, and in the right direction: if
 * `dcount(dns_host)` counts the null as a value of its own, the live number
 * includes a "resolver" that is the absence of one. The tile's own words are
 * "unique resolver hosts (dns_host) answering queries", so the stored answer is
 * the one that matches them.
 *
 * ── `limit 500` IS NOT IN HERE, DELIBERATELY ───────────────────────────────
 * PER_RESOLVER carries `| sort by total desc | limit 500` and that belongs to
 * the panel's view, not to the scan: capped in the body, OVERALL's totals would
 * cover the top 500 resolvers rather than all of them. It moves into the
 * resolver table's tail, where it means what it always meant, and the stored row
 * set holds the whole grouping.
 *
 * ── THE ALIAS RULE ─────────────────────────────────────────────────────────
 * `total` is defined once, with PER_RESOLVER's meaning (responses in a group),
 * and OVERALL's `total` is `sum(total)` in its tail — the same number its live
 * `count()` produces, because every response is in exactly one group. `p50` is a
 * percentile and percentiles do not compose either, which is why no panel on
 * this entry re-aggregates one: the resolver table reads it per resolver, which
 * is the grouping it was computed at, and no tile asks for an overall p50.
 */
export const DNS_RESOLVER_SNAPSHOT_QUERY = q(
  'app_name="dns" | extend dns_h=iif(isnotnull(dns_host), dns_host, "") | summarize p50=percentile(dns_response_time,50), ' +
    REPLY_CODE_AGGS +
    ', total=count() by dns_h',
)
