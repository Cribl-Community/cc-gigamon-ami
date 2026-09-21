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
// Nothing here may import a .tsx, or anything that reaches one: the freeze
// extractor loads this module under plain Node.
// ─────────────────────────────────────────────────────────────────────────────

import { q } from '../cribl/search'
import { KPI_AGGS as CAPACITY_KPI_AGGS } from './capacityTopTalkers'
import { KPI_AGGS as WEB_KPI_AGGS } from './webApiHealth'
import { COUNT_AGGS as SECURITY_COUNT_AGGS } from './security'
import { FINDING_AGGS } from './findings'
import { VOLUME_AGGS } from './dataFlow'

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
