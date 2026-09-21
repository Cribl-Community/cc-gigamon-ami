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
import {
  KPI_AGGS as WEB_KPI_AGGS,
  HOST_ERR_AGG as WEB_HOST_ERR_AGG,
  SERVER_P95_AGG as WEB_SERVER_P95_AGG,
} from './webApiHealth'
import { COUNT_AGGS as SECURITY_COUNT_AGGS } from './security'
import { FINDING_AGGS } from './findings'
import { VOLUME_AGGS } from './dataFlow'
// The DNS reply-code aggregates, imported rather than retyped: the stored body
// and the ⓘ beside the number have to be the same characters. See dnsHealth.ts.
import { REPLY_CODE_AGGS } from './dnsHealth'
// The byte aggregate Capacity's three byte panels are built from, imported for
// the same reason: one scan rolls it up by (app_name, l4_proto) and all three
// panels sum the stored rows back along one key. See capacityTopTalkers.ts.
import { BYTES_AGG } from './capacityTopTalkers'
// The four wire-error sums and the mask's column pair, imported for the same
// reason: the scheduled body and the panel's own query have to agree about
// which columns exist and what they are called. See tcpHealth.ts.
import { HEAT_METRIC_AGGS, subnetFields, type Mask } from './tcpHealth'

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

/**
 * Every HTTP host seen in the window, with its transaction count, its error
 * count, its server-latency p95 — and, separately, HOW MANY of its transactions
 * that percentile was computed over.
 *
 * ONE SCAN FOR THE TWO HOST PANELS. "Top endpoints by requests" and "Slowest
 * hosts — server think-time p95" both group by `http_host` and both run on
 * mount, so they are admitted ~1.6 s apart and the reader waits for the second
 * one to start. One grouping carries both.
 *
 * ── THE ALIAS TRAP, AND IT IS THE REASON THIS BODY DEFINES NO `n` ───────────
 * THE TWO PANELS USE THE SAME ALIAS FOR DIFFERENT POPULATIONS, and this is the
 * single thing to get right here:
 *
 *   HOSTS's `n` is `count()` over `http_host=*`            — ALL transactions.
 *   SLOW's  `n` is `count()` over `http_server_ms=* http_host=*`
 *                                                          — only the ones that
 *                                                            carry a server-time
 *                                                            measurement.
 *
 * SLOW renders its `n` as the bar note "<n> txns", right beside a latency
 * figure. A body defining `n` once and letting both panels read it would put a
 * number on screen that is correctly formatted, plausible, larger than the
 * truth, and attached to an ⓘ that describes the other query. Nothing would
 * error and nothing on screen would look wrong.
 *
 * So THIS BODY DEFINES NO ALIAS CALLED `n` AT ALL. It defines `all_n` and
 * `srv_n`, and each panel's tail renames the one that panel actually means into
 * `n` with an `extend` — the same move `gno_dns_resolver_c1h` makes to restore
 * `dns_host`. That is stronger than a comment: a panel cannot read the wrong `n`
 * from this body, because there is no `n` in it to read. DO NOT MERGE THE TWO
 * COUNTS back into one alias, whatever the row looks like.
 *
 * `| where srv_n > 0` in the slow panel's tail is what its `http_server_ms=*`
 * head did live: keep hosts with no server timing at all out of a ranking BY
 * server timing, where they would otherwise appear with a null p95.
 *
 * ── THE ONE UNVERIFIED BEHAVIOUR (M-8), STATED RATHER THAN HIDDEN ───────────
 * This body has no `http_server_ms=*` head — it cannot have one, because the
 * transaction counts the other panel reads are computed over every row. So `p95`
 * is computed over a group that includes rows carrying no server time, where
 * SLOW's live query computed it over only the rows that do. The two agree if and
 * only if `percentile()` ignores nulls rather than treating them as zero.
 *
 * Nobody has run that pair of queries against this platform. What IS established
 * here is the same behaviour one family over: `count(field)` counts non-null
 * occurrences on this platform — `txns=count(http_code)` in KPI_AGGS is the
 * transaction count the tile shows, and PRESENCE_QUERY's ninety-six
 * `count(field)` aggregates are a whole shipped panel built on it. An aggregate
 * that skipped nulls for `count` and folded them to zero for `percentile` would
 * be a very strange platform. `srv_n` is carried partly so the difference is at
 * least VISIBLE in the stored rows if anybody ever goes looking: a host whose
 * `srv_n` is far below its `all_n` is where a null-folding percentile would show
 * up first.
 */
export const WEB_HOST_SNAPSHOT_QUERY = q(
  'http_host=* | summarize all_n=count(), ' +
    WEB_HOST_ERR_AGG +
    ', ' +
    WEB_SERVER_P95_AGG +
    ', srv_n=count(http_server_ms) by http_host',
)

/**
 * Every busy TCP subnet pair in the window, with all four wire-error sums at
 * once — one body at /24, one at /16.
 *
 * ONE SCAN FOR FOUR PANEL STATES. TCP health's heatmap is a single panel whose
 * query is rebuilt every time the reader presses one of four metric buttons, and
 * each press is another whole-window scan of the AMI records. A body carrying all
 * four sums answers every one of those presses from one stored result, and the
 * fifth press — back to the first metric — costs nothing at all.
 *
 * ── WHY THIS IS EXACT AND NOT AN APPROXIMATION ──────────────────────────────
 * A stored top-N is normally only good for the ranking it was sorted by. This
 * one is good for all four because THE PANEL'S OWN SORT KEY HAS NO METRIC IN IT:
 * `sort by flows desc | limit 120`, and `flows` is `count()`. Whichever metric
 * the reader selects, the live query would keep the same 120 rows this body
 * keeps — so projecting one of the four stored sums off those rows gives the
 * live query's rows column for column, not a close approximation of them.
 *
 * That property is the whole entry. src/queries/tcpHealth.ts's HEAT_METRIC_AGGS
 * carries the same note beside the METRICS list, because either half moving
 * breaks it: a metric-dependent sort key, or a tail projecting a column the
 * panel did not ask for.
 *
 * ── WHY TWO BODIES AND NOT ONE ──────────────────────────────────────────────
 * The mask is the other argument, and unlike the metric it cannot be projected
 * out of one scan. Rolling the /24 top-120 up to /16 is lossy in exactly the
 * place a /16 view needs: a /24 pair that missed the top 120 still contributes
 * every one of its flows to its /16 pair's total, and those are precisely the
 * rows a coarser grouping exists to gather up. Two masks, two scans, two entries.
 *
 * ── THE HEAD IS THE PANEL'S OWN, CHARACTER FOR CHARACTER ────────────────────
 * `protocol=6 <src>=* <dst>=*`, the same filter `buildHeatQuery` writes. That is
 * what makes the empty-group question — the one SERVICE_EDGES_SNAPSHOT_QUERY and
 * DNS_RESOLVER_SNAPSHOT_QUERY each needed an `extend`/`iif` sentinel for — not
 * arise here: no panel on this entry sums across a group the live query filters
 * out, because the live query filters out exactly the same rows. A sentinel
 * would be a column nothing reads.
 *
 * ── THE ALIAS RULE ──────────────────────────────────────────────────────────
 * The four sums are aliased by metric KEY (`dupacks`, `resets`, `crc`, `loss`),
 * and every panel on this entry has a `| project` tail that renames the one it
 * wants to `v` — the name the panel reads today. So no panel ever reads a body
 * column directly, and a panel added to this entry WITHOUT a tail must not read
 * `crc` or `loss`: the endpoint drill beside this heatmap defines both, per
 * src→dst IP pair rather than per subnet pair, and they are different numbers.
 */
const tcpSubnetSnapshot = (mask: Mask): string => {
  const { sf, df } = subnetFields(mask)
  return q(`protocol=6 ${sf}=* ${df}=* | summarize ${HEAT_METRIC_AGGS}, flows=count() by ${sf}, ${df} | sort by flows desc | limit 120`)
}

export const TCP_SUBNET24_SNAPSHOT_QUERY = tcpSubnetSnapshot('24')
export const TCP_SUBNET16_SNAPSHOT_QUERY = tcpSubnetSnapshot('16')

/**
 * Every (application, transport protocol) pair seen in the window, with the
 * bytes on it.
 *
 * THREE OF CAPACITY'S FOUR PANELS FROM ONE SCAN — the app-protocol-mix donut,
 * the L4 split beside it, and the top-talkers bar list while that list is
 * pivoted to App. Each one is a `sum(total_bytes)` grouped by ONE of these two
 * keys today, and each fires its own whole-window scan.
 *
 * ── WHY SUMMING THE STORED ROWS IS EXACT AND NOT AN APPROXIMATION ──────────
 * `sum` is additive: summing a two-key rollup along one key gives precisely
 * what the one-key query gives, because every record lands in exactly one
 * (app, l4) cell and every cell is added into exactly one app — or into exactly
 * one protocol — on the way out. Nothing is estimated and nothing is capped in
 * here, so the derivation is not "close enough", it is the same arithmetic in a
 * different order.
 *
 * THAT ARGUMENT IS ABOUT `sum` AND NOTHING ELSE. An average, a percentile or a
 * distinct count does not compose this way, and a panel on this entry must
 * never be given one by re-aggregating stored rows: `avg` needs the weights,
 * percentiles need the distribution, and a summed `dcount` double-counts
 * anything appearing under two keys. If Capacity ever grows a mean-bytes or a
 * distinct-talkers figure, it needs a grouping of its own or it stays live.
 *
 * ── THE EMPTY-GROUP GUARD, WHICH IS THE CORRECTNESS OF THE CROSS PRODUCT ───
 * Neither live query has a head filter: `by app_name` counts every record in
 * the window including ones that name no protocol, and `by l4_proto` counts
 * every record including ones AMI could not classify into an application.
 * Group naively `by app_name, l4_proto` and whether a null key survives is
 * something this app has never measured — if it does not, EVERY panel here
 * loses those records. The L4 split would come back short by all the
 * unclassified traffic, which is exactly the traffic a capacity reader is
 * looking for; smaller, correctly formatted, and in the one direction nobody
 * can check.
 *
 * So both nulls become groups of their own before the grouping happens — the
 * same trick SERVICE_EDGES_SNAPSHOT_QUERY and DNS_RESOLVER_SNAPSHOT_QUERY use,
 * on both keys because both keys are nullable. `app` and `l4` are empty for
 * exactly those records: the two mix panels sum across the sentinel (which is
 * what their unfiltered `count`/`sum` does live) and the top-talkers tail
 * filters it out (which is what that query's own `app_name=*` head does).
 *
 * ── THE ALIAS RULE ─────────────────────────────────────────────────────────
 * `bytes` is defined once, and every panel here re-aggregates it — `bytes` on
 * a stored row is one (app, protocol) cell, and the alias each panel reads is
 * the one its own tail defines. A panel added to this entry WITHOUT a tail
 * would read the cell rather than the total, so there must not be one. The
 * group keys are renamed `app`/`l4` rather than shadowing `app_name`/`l4_proto`
 * so that a tail restoring the panel's own column name is doing something
 * visible, not relying on a redefinition nobody has run.
 *
 * ── WHAT THIS ENTRY CANNOT SERVE, AND MUST NOT PRETEND TO ──────────────────
 * Anything with Capacity's filter box applied. `scopeFor` splices the typed
 * text into the query head, so the argument domain is unbounded free text and
 * no stored run holds an answer for it. The tab gates every hook on
 * `applied === ''` for that reason — a served panel that ignored the filter
 * would show unfiltered numbers under a filtered heading, which is worse than
 * being slow. The same goes for the top-talkers list under its other two
 * pivots: `src_ip` and `dst_aws_flat_tags_name` are not in this grouping, so
 * those two states stay live rather than being answered from a key this scan
 * does not carry.
 */
export const APP_L4_SNAPSHOT_QUERY = q(
  '| extend app=iif(isnotnull(app_name), app_name, ""), l4=iif(isnotnull(l4_proto), l4_proto, "") | summarize ' +
    BYTES_AGG +
    ' by app, l4',
)
