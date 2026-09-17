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

export const KPI = q(
  '| summarize txns=count(http_code), errors=sum(iif(http_code>=400,1,0)), ' +
  'server_p95=percentile(http_server_ms,95), hosts=dcount(http_host), h2=count(http2_code)',
)
export const CODES = q('http_code=* | summarize n=count() by http_code | sort by n desc | limit 12')
export const HOSTS = q('http_host=* | summarize n=count(), err=sum(iif(http_code>=400,1,0)) by http_host | sort by n desc | limit 12')
export const SLOW = q('http_server_ms=* http_host=* | summarize p95=percentile(http_server_ms,95), n=count() by http_host | sort by p95 desc | limit 10')
export const TREND = q('http_code=* | summarize errors=sum(iif(http_code>=400,1,0)), total=count() by bin(_time,1m) | sort by _time asc')
export const H2 = q('http2_host=* | summarize n=count() by http2_host | sort by n desc | limit 10')

// The "open all 4xx/5xx responses" deep link at the foot of the tab — it lands
// in the Cribl Search UI, so it is as customer-visible as the panels above.
export const ERRORS_DRILL = q('http_code>=400 | limit 200')
