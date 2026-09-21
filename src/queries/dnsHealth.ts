// The Cribl Search (KQL) the DNS health tab runs.
//
// Every string here is customer-visible: each KPI tile and panel shows the query
// that produced its number in the ⓘ popover, and the row drill-down opens
// resolverDrillQuery in the real Cribl Search UI. A committed snapshot of this
// module is regenerated from src/ and diffed by a test, so a change to one
// character is a change to what the app tells a customer — never a tidy-up.
//
// Nothing under src/queries may import a .tsx, or anything that reaches one: the
// snapshot is read by plain Node, which cannot load JSX. That rules out
// ../cribl/useSearch and everything in ../components.

import { q } from '../cribl/search'

/**
 * The reply-code breakdown both queries below carry, character for character.
 *
 * Exported as a fragment for the same reason VOLUME_AGGS and KPI_AGGS are: the
 * hourly snapshot body in ./snapshots.ts has to compute THESE aggregates, not a
 * retyped copy of them that agrees on the day it was written. Reading a stored
 * run under an ⓘ showing one of the strings below is only honest while the two
 * are the same characters, and a copy-paste here is a wrong number rather than a
 * lint complaint — nothing on screen would change if one of them drifted.
 *
 * Extracting it does not move either query's text: both resolve to exactly what
 * they resolved to before, which the display freeze checks by value.
 */
export const REPLY_CODE_AGGS =
  'noerr=sum(iif(dns_reply_code=="0",1,0)), sf=sum(iif(dns_reply_code=="2",1,0)), ' +
  'nx=sum(iif(dns_reply_code=="3",1,0))'

export const OVERALL = q('app_name="dns" | summarize total=count(), ' + REPLY_CODE_AGGS + ', resolvers=dcount(dns_host)')

export const PER_RESOLVER = q(
  'app_name="dns" dns_host=* | summarize p50=percentile(dns_response_time,50), ' +
    REPLY_CODE_AGGS +
    ', total=count() by dns_host | sort by total desc | limit 500',
)

/** The reply-code / query breakdown a clicked resolver row opens in Cribl Search. */
export function resolverDrillQuery(host: string) {
  return q(`app_name="dns" dns_host="${host}" | summarize count() by dns_reply_code, dns_query | sort by dns_query desc | limit 200`)
}
