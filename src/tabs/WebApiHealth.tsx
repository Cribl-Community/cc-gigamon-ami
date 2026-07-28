import { useMemo } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { TimeChart, type Series } from '../components/TimeChart'
import { toNum, str, fmtCount, fmtMs, fmtPct } from '../lib/format'

const KPI = q(
  '| summarize txns=count(http_code), errors=sum(iif(http_code>=400,1,0)), ' +
  'server_p95=percentile(http_server_ms,95), hosts=dcount(http_host), h2=count(http2_code)',
)
const CODES = q('http_code=* | summarize n=count() by http_code | sort by n desc | limit 12')
const HOSTS = q('http_host=* | summarize n=count(), err=sum(iif(http_code>=400,1,0)) by http_host | sort by n desc | limit 12')
const SLOW = q('http_server_ms=* http_host=* | summarize p95=percentile(http_server_ms,95), n=count() by http_host | sort by p95 desc | limit 10')
const TREND = q('http_code=* | summarize errors=sum(iif(http_code>=400,1,0)), total=count() by bin(_time,1m) | sort by _time asc')
const H2 = q('http2_host=* | summarize n=count() by http2_host | sort by n desc | limit 10')

export function WebApiHealth() {
  const { range } = useDashboard()
  const kpi = useSearch(KPI)
  const codes = useSearch(CODES)
  const hosts = useSearch(HOSTS)
  const slow = useSearch(SLOW)
  const trend = useSearch(TREND)
  const h2 = useSearch(H2)

  const k = kpi.rows[0] ?? {}
  const txns = toNum(k.txns)
  const errors = toNum(k.errors)
  const errRate = txns > 0 ? (errors / txns) * 100 : 0

  const codeItems: BarItem[] = codes.rows.map((r) => {
    const code = str(r, 'http_code', '?')
    return { label: code, value: toNum(r.n), display: fmtCount(r.n) }
  })
  // Errors first when they exist — a 502 buried under 200s is the thing you miss.
  const worstCode = codeItems.find((c) => c.label.startsWith('5')) ?? codeItems.find((c) => c.label.startsWith('4'))

  const hostItems: BarItem[] = hosts.rows.map((r) => {
    const n = toNum(r.n), err = toNum(r.err)
    return {
      label: str(r, 'http_host', '(none)'),
      value: n,
      display: fmtCount(n),
      note: err > 0 ? `${fmtPct((err / n) * 100, 1)} errors` : undefined,
    }
  })

  const slowItems: BarItem[] = slow.rows.map((r) => ({
    label: str(r, 'http_host', '(none)'),
    value: toNum(r.p95),
    display: fmtMs(toNum(r.p95)),
    note: `${fmtCount(r.n)} txns`,
  }))

  const h2Items: BarItem[] = h2.rows.map((r) => ({
    label: str(r, 'http2_host', '(none)'),
    value: toNum(r.n),
    display: fmtCount(r.n),
  }))

  const series: Series[] = useMemo(() => [
    { name: 'errors / min', color: '#f03e3e', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.errors) })) },
    { name: 'requests / min', color: '#4dabf7', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.total) })) },
  ], [trend.rows])

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Web &amp; API health</h2>
        <p className="tab-sub">
          The application layer, straight off the wire — status codes, per-host error rates and server think-time,
          with no agent in the app. Server latency is <code>http_server_ms</code>, derived in the pipeline from{' '}
          <code>http_response_ts − http_request_ts</code>. HTTP/2 is reported separately because Gigamon emits it
          under its own <code>http2_*</code> fields, which the <code>http_*</code> panels here do not see.
        </p>
      </div>

      <div className="kpi-row kpi-row-4">
        <KpiTile label="HTTP transactions" value={kpi.loading ? '…' : fmtCount(txns)} accent="info"
          sub="http_code present" info="Flows carrying an HTTP response code in this window (HTTP/1.x only — HTTP/2 is counted separately)." query={KPI} />
        <KpiTile label="Error rate" value={kpi.loading ? '…' : fmtPct(errRate, 2)}
          accent={errRate > 5 ? 'danger' : errRate > 1 ? 'warning' : 'success'}
          sub={`${fmtCount(errors)} × 4xx/5xx`} info="Share of HTTP transactions returning 4xx or 5xx. 5xx implicates the server; 4xx is usually the caller." query={KPI} />
        <KpiTile label="Server think-time p95" value={kpi.loading ? '…' : fmtMs(toNum(k.server_p95))} accent="warning"
          sub="http_server_ms" info="95th-percentile server processing time — request timestamp to response timestamp, measured on the wire." query={KPI} />
        <KpiTile label="HTTP/2 transactions" value={kpi.loading ? '…' : fmtCount(toNum(k.h2))} accent="neutral"
          sub="http2_code · separate field set" info="HTTP/2 flows. Gigamon reports these under http2_* fields, so they are invisible to the http_* panels on this page." query={H2} />
      </div>

      <div className="grid-2">
        <Panel tourId="web-codes" title="Status codes" query={CODES} onRefresh={codes.refetch} refreshing={codes.loading} note="http_code · by volume"
          info="Distribution of HTTP response codes. Bars are coloured by class so 4xx/5xx stand out against 2xx/3xx volume.">
          <QueryBoundary state={codes} emptyLabel="No HTTP responses in this window">
            <BarList items={codeItems} accent={worstCode ? 'accent' : 'success'} />
          </QueryBoundary>
        </Panel>

        <Panel tourId="web-slow" title="Slowest hosts — server think-time p95" query={SLOW} onRefresh={slow.refetch} refreshing={slow.loading} note="http_server_ms · p95"
          info="Hosts ranked by 95th-percentile server processing time. This is the server's own latency, isolated from network RTT — the 'is it the app or the network' split.">
          <QueryBoundary state={slow} emptyLabel="No server-timing data in this window">
            <BarList items={slowItems} accent="accent" />
          </QueryBoundary>
        </Panel>
      </div>

      <Panel tourId="web-hosts" title="Top endpoints by requests" query={HOSTS} onRefresh={hosts.refetch} refreshing={hosts.loading} note="http_host · error rate per host"
        info="Busiest HTTP hosts with the share of their responses that were 4xx/5xx. A high-volume host with a high error rate is the first thing to chase.">
        <QueryBoundary state={hosts} emptyLabel="No HTTP hosts in this window">
          <BarList items={hostItems} accent="info" />
        </QueryBoundary>
      </Panel>

      <div className="grid-2">
        <Panel tourId="web-trend" title="Requests and errors over time" query={TREND} onRefresh={trend.refetch} refreshing={trend.loading} note="per 1m"
          info="Request volume against 4xx/5xx count per minute. A spike in errors that does not track request volume is a server-side event, not load.">
          <QueryBoundary state={trend} emptyLabel="No data" compact>
            <TimeChart series={series} height={170} />
          </QueryBoundary>
        </Panel>

        <Panel tourId="web-h2" title="HTTP/2 hosts" query={H2} onRefresh={h2.refetch} refreshing={h2.loading} note="http2_host · by volume"
          info="HTTP/2 traffic, reported by Gigamon under a separate field set (http2_host / http2_code / http2_method). Shown here so modern traffic is not silently missing from the page.">
          <QueryBoundary state={h2} emptyLabel="No HTTP/2 traffic in this window">
            <BarList items={h2Items} accent="info" />
          </QueryBoundary>
        </Panel>
      </div>

      <p className="tab-sub">
        Chasing a specific status code?{' '}
        <a href={searchUiUrl(q('http_code>=400 | limit 200'), range.earliest)} target="_blank" rel="noopener noreferrer">
          Open all 4xx/5xx responses in Cribl Search ↗
        </a>
      </p>
    </div>
  )
}
