import { useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { searchUiUrl } from '../cribl/config'
import { accelEntry, type AccelId } from '../cribl/accel/manifest'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { type ComputedFrom } from '../components/PanelInfo'
import { QueryBoundary } from '../components/QueryBoundary'
import { toNum, str, fmtMs, fmtPct, fmtCount } from '../lib/format'
import { OVERALL, PER_RESOLVER, resolverDrillQuery } from '../queries/dnsHealth'

// dns_response_time is in seconds → ms for display.
const S_TO_MS = 1000

/**
 * The scheduled search that serves BOTH of this tab's mount queries.
 *
 * This tab fires two whole-window scans on mount and the reader waits for both —
 * roughly 7–12 seconds, the longest open in the app. One hourly grouping by
 * resolver carries them: the table reads the grouping, the tiles re-aggregate
 * across it. The two `accelPanel` ids below are what pick each panel's row out
 * of that shared result; neither hook may go without one, because a hook naming
 * the entry and not the panel would read the other panel's columns.
 *
 * The bigger reason is not the seconds. A percentile over a high-cardinality
 * grouping is this app's most hang-prone query shape, and a job that hangs on
 * the interactive path is a viewer watching a spinner; on a schedule the same
 * job costs a retained result nobody reads.
 */
const DNS_ACCEL: AccelId = 'gno_dns_resolver_c1h'
const DNS_ENTRY = accelEntry(DNS_ACCEL)
/** The schedule in words, for the ⓘ. DnsHealth.test.tsx holds these against the
 *  manifest's own cron and window, so moving one forces the other. */
export const DNS_CADENCE = 'once an hour, at 33 minutes past, in UTC'
export const DNS_WINDOW = SNAPSHOT_WINDOW

export function DnsHealth() {
  const { range } = useDashboard()
  const overall = useSearch(OVERALL, { accel: DNS_ACCEL, accelPanel: 'dns-overall' })
  const resolvers = useSearch(PER_RESOLVER, { accel: DNS_ACCEL, accelPanel: 'dns-resolver-table' })
  const [filter, setFilter] = useState('')
  // Default to failing-only: the point of this page is finding broken resolvers,
  // not scrolling 12k healthy ones. Toggle off to see the full list.
  const [failingOnly, setFailingOnly] = useState(true)

  // The drill opens the clicked resolver in Cribl Search over the window the ROW
  // came from, which is not always the picker's. A row read from the hourly run
  // describes fifteen settled minutes; opening it over "last 24 hours" would
  // show a different population of responses under the same resolver name, and
  // the reader would reasonably read the difference as the app disagreeing with
  // itself.
  const drillEarliest = resolvers.source === 'schedule' ? DNS_ENTRY.earliest : range.earliest
  const drillResolver = (host: string) => {
    window.open(searchUiUrl(resolverDrillQuery(host), drillEarliest), '_blank', 'noopener')
  }

  const o = overall.rows[0] ?? {}
  const total = toNum(o.total)
  const errRate = total ? ((toNum(o.sf) + toNum(o.nx)) / total) * 100 : 0
  const slowestMs = resolvers.rows.reduce((m, r) => Math.max(m, toNum(r.p50) * S_TO_MS), 0)

  // Where each number came from, for block 4 of its ⓘ. TWO of them, not one:
  // the tiles and the table are served by the same schedule but they are two
  // reads, and one can fall back to live while the other answers from the run —
  // a tile dated from its neighbour's run would be the exact false claim the
  // dating exists to prevent.
  const overallComputed: ComputedFrom = {
    source: overall.source, at: overall.at, stale: overall.stale,
    cadence: DNS_CADENCE, window: DNS_WINDOW, fallback: overall.note,
  }
  const resolverComputed: ComputedFrom = {
    source: resolvers.source, at: resolvers.at, stale: resolvers.stale,
    cadence: DNS_CADENCE, window: DNS_WINDOW, fallback: resolvers.note,
  }

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
        {/* The slowest-resolver tile is computed over the TABLE's rows, so it
            carries the table's provenance and not the tiles' — see the two
            `computed` objects above. */}
        <KpiTile label="Slowest resolver (p50)" value={overall.loading ? '…' : fmtMs(slowestMs)}
          accent="neutral" sub="highest median response time"
          info="The worst median (p50) dns_response_time among all resolvers in the window." query={PER_RESOLVER} computed={resolverComputed} />
        <KpiTile label="SERVFAIL / error rate" value={overall.loading ? '…' : fmtPct(errRate, 2)}
          accent={errRate > 5 ? 'danger' : errRate > 1 ? 'warning' : 'success'}
          sub={`${fmtCount(toNum(o.sf) + toNum(o.nx))} of ${fmtCount(total)} responses`}
          info="Share of DNS responses that failed — SERVFAIL (reply code 2) + NXDOMAIN (3). Use 'Failing only' below to drill them." query={OVERALL} computed={overallComputed} />
        <KpiTile label="Distinct resolvers" value={overall.loading ? '…' : String(toNum(o.resolvers))}
          accent="info" sub="unique dns_host values"
          info="Count of unique resolver hosts (dns_host) answering queries in the window." query={OVERALL} computed={overallComputed} />
      </div>

      {/* "top 500" is still true and is still this panel's own cap — but it is
          now the panel's, not the scan's. The `limit 500` moved out of the body
          and into this panel's tail, so the stored run holds every resolver
          group and the tiles above count all of them rather than the top 500. */}
      <Panel
        tourId="dns-resolvers"
        title="Resolvers"
        info="Per-resolver p50 latency and reply-code breakdown (NoError / SERVFAIL / NXDOMAIN). Filter by name or toggle Failing only."
        query={PER_RESOLVER}
        computed={resolverComputed}
        snapshot={{ source: resolvers.source, outcome: resolvers.outcome, at: resolvers.at, stale: resolvers.stale, nearestAt: resolvers.nearestAt }}
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
