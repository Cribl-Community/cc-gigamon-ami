import { useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { toNum, str, fmtMs, fmtPct, fmtCount } from '../lib/format'

// dns_response_time is in seconds → ms for display.
const S_TO_MS = 1000

const OVERALL = q(
  'app_name="dns" | summarize total=count(), ' +
    'noerr=sum(iif(dns_reply_code=="0",1,0)), sf=sum(iif(dns_reply_code=="2",1,0)), ' +
    'nx=sum(iif(dns_reply_code=="3",1,0)), resolvers=dcount(dns_host)',
)

const PER_RESOLVER = q(
  'app_name="dns" dns_host=* | summarize p50=percentile(dns_response_time,50), ' +
    'noerr=sum(iif(dns_reply_code=="0",1,0)), sf=sum(iif(dns_reply_code=="2",1,0)), ' +
    'nx=sum(iif(dns_reply_code=="3",1,0)), total=count() by dns_host | sort by total desc | limit 500',
)

export function DnsHealth() {
  const { range } = useDashboard()
  const overall = useSearch(OVERALL)
  const resolvers = useSearch(PER_RESOLVER)
  const [filter, setFilter] = useState('')
  // Default to failing-only: the point of this page is finding broken resolvers,
  // not scrolling 12k healthy ones. Toggle off to see the full list.
  const [failingOnly, setFailingOnly] = useState(true)

  const drillResolver = (host: string) => {
    const dq = q(`app_name="dns" dns_host="${host}" | summarize count() by dns_reply_code, dns_query | sort by dns_query desc | limit 200`)
    window.open(searchUiUrl(dq, range.earliest), '_blank', 'noopener')
  }

  const o = overall.rows[0] ?? {}
  const total = toNum(o.total)
  const errRate = total ? ((toNum(o.sf) + toNum(o.nx)) / total) * 100 : 0
  const slowestMs = resolvers.rows.reduce((m, r) => Math.max(m, toNum(r.p50) * S_TO_MS), 0)

  const term = filter.trim().toLowerCase()
  const shown = resolvers.rows.filter(
    (r) =>
      (!term || str(r, 'dns_host').toLowerCase().includes(term)) &&
      (!failingOnly || toNum(r.sf) > 0 || toNum(r.nx) > 0),
  )

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">DNS health</h2>
        <p className="tab-sub">
          Per-resolver response time and reply codes from <code>app_name="dns"</code> AMI records.
          Rows show p50 latency and NoError / SERVFAIL / NXDOMAIN breakdown. Defaults to{' '}
          <strong>failing resolvers only</strong> (SERVFAIL or NXDOMAIN) — toggle off to see all.
        </p>
      </div>

      <div className="kpi-row kpi-row-3">
        <KpiTile label="Slowest resolver (p50)" value={overall.loading ? '…' : fmtMs(slowestMs)}
          accent="neutral" sub="highest median response time"
          info="The worst median (p50) dns_response_time among all resolvers in the window." query={PER_RESOLVER} />
        <KpiTile label="SERVFAIL / error rate" value={overall.loading ? '…' : fmtPct(errRate, 2)}
          accent={errRate > 5 ? 'danger' : errRate > 1 ? 'warning' : 'success'}
          sub={`${fmtCount(toNum(o.sf) + toNum(o.nx))} of ${fmtCount(total)} responses`}
          info="Share of DNS responses that failed — SERVFAIL (reply code 2) + NXDOMAIN (3). Use 'Failing only' below to drill them." query={OVERALL} />
        <KpiTile label="Distinct resolvers" value={overall.loading ? '…' : String(toNum(o.resolvers))}
          accent="info" sub="unique dns_host values"
          info="Count of unique resolver hosts (dns_host) answering queries in the window." query={OVERALL} />
      </div>

      <Panel
        tourId="dns-resolvers"
        title="Resolvers"
        info="Per-resolver p50 latency and reply-code breakdown (NoError / SERVFAIL / NXDOMAIN). Filter by name or toggle Failing only."
        query={PER_RESOLVER}
        onRefresh={resolvers.refetch}
        refreshing={resolvers.loading}
        note={`${shown.length} of ${resolvers.rows.length} resolvers · top 500 by volume`}
      >
        <div className="resolver-toolbar">
          <input
            className="fe-search"
            placeholder="Filter resolvers…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button type="button" className={`seg ${failingOnly ? 'seg-active' : ''}`} onClick={() => setFailingOnly((v) => !v)}>
            Failing only
          </button>
        </div>
        <QueryBoundary state={resolvers} emptyLabel="No DNS records in this window">
          {shown.length === 0 ? (
            <div className="qb-center qb-empty">
              <span className="qb-msg">
                {failingOnly
                  ? 'No failing resolvers in this window — every resolver is answering NoError. Toggle “Failing only” off to see all resolvers.'
                  : 'No resolvers match the current filter.'}
              </span>
            </div>
          ) : (
          <div className="resolver-scroll">
          <ul className="resolver-list">
            {shown.map((r, i) => {
              const host = str(r, 'dns_host', '(unknown)')
              const sf = toNum(r.sf)
              const nx = toNum(r.nx)
              const status = sf > 0 ? 'danger' : nx > 0 ? 'warning' : 'success'
              const statusText = sf > 0 ? 'SERVFAIL' : nx > 0 ? 'NXDOMAIN' : 'OK'
              return (
                <li className="resolver-row resolver-row-click" key={`${host}-${i}`}
                  onClick={() => host !== '(unknown)' && drillResolver(host)}
                  title="Open this resolver's DNS records in Cribl Search">
                  <span className={`dot dot-${status}`} />
                  <span className="resolver-name">{host} <span className="row-drill">↗</span></span>
                  <span className="resolver-stats">
                    {fmtMs(toNum(r.p50) * S_TO_MS)} · NoErr {fmtCount(r.noerr)} · SF {fmtCount(sf)} · NX {fmtCount(nx)}
                  </span>
                  <span className={`pill pill-${status}`}>{statusText}</span>
                </li>
              )
            })}
          </ul>
          </div>
          )}
        </QueryBoundary>
      </Panel>
    </div>
  )
}
