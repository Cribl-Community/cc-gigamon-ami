// Cribl Search (KQL) queries behind the Web & API health tab.
//
// The strings here are customer-visible — every tile and panel shows its query
// verbatim in the ⓘ popover, as the provenance of the number on screen, and a
// snapshot test fails when one drifts. Edit the text only when the number it
// produces is meant to change.
//
// Nothing in this directory may import from a .tsx: the snapshot is regenerated
// by plain Node, which cannot load JSX.

import { q } from '../cribl/search'

// Exported as a fragment so the hourly snapshot body (src/queries/snapshots.ts)
// holds these characters rather than a retyped copy — see KPI_AGGS in
// capacityTopTalkers.ts for why that matters to the ⓘ.
export const KPI_AGGS =
  'txns=count(http_code), errors=sum(iif(http_code>=400,1,0)), ' +
  'server_p95=percentile(http_server_ms,95), hosts=dcount(http_host), h2=count(http2_code)'
export const KPI = q('| summarize ' + KPI_AGGS)
/**
 * The presence filters at the head of three panels below, as fragments.
 *
 * Named so the Lake landing parity check (src/queries/lakeLanding.ts) runs the
 * filter these panels actually use rather than a retyped copy of it: under
 * automatic-schema Parquet an absent field reads back as `""` or `0`, and
 * whether `f=*` still excludes that row is exactly what the check is for. A
 * copy would go on passing after one of these heads changed. `CODES`, `TREND`
 * and `HOSTS` resolve to the same characters they did before.
 */
export const CODES_HEAD = 'http_code=*'
export const HOSTS_HEAD = 'http_host=*'

export const CODES = q(CODES_HEAD + ' | summarize n=count() by http_code | sort by n desc | limit 12')

/**
 * The per-host error count, and the per-host server-latency percentile, as
 * fragments — so `WEB_HOST_SNAPSHOT_QUERY` holds THESE characters rather than a
 * retyped copy of them.
 *
 * Both panels below are served by one hourly grouping by `http_host`, and the
 * whole honesty of that arrangement is that the stored body computes the same
 * aggregate the ⓘ beside the number advertises. Retyped they would agree the day
 * they were written and drift the first time somebody edited one — silently,
 * because both forms still return a number of the right shape. This is the same
 * move `REPLY_CODE_AGGS` makes in dnsHealth.ts, and it leaves `HOSTS` and `SLOW`
 * byte-identical to what they were.
 */
export const HOST_ERR_AGG = 'err=sum(iif(http_code>=400,1,0))'
export const SERVER_P95_AGG = 'p95=percentile(http_server_ms,95)'

export const HOSTS = q(HOSTS_HEAD + ' | summarize n=count(), ' + HOST_ERR_AGG + ' by http_host | sort by n desc | limit 12')
export const SLOW = q('http_server_ms=* http_host=* | summarize ' + SERVER_P95_AGG + ', n=count() by http_host | sort by p95 desc | limit 10')
export const TREND = q(CODES_HEAD + ' | summarize errors=sum(iif(http_code>=400,1,0)), total=count() by bin(_time,1m) | sort by _time asc')
export const H2 = q('http2_host=* | summarize n=count() by http2_host | sort by n desc | limit 10')

// The "open all 4xx/5xx responses" deep link at the foot of the tab — it lands
// in the Cribl Search UI, so it is as customer-visible as the panels above.
export const ERRORS_DRILL = q('http_code>=400 | limit 200')
