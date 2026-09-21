import { useMemo } from 'react'
import { useSearch, type UseSearchState } from '../cribl/useSearch'
import { useNearViewport } from '../components/nearViewport'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { TimeChart, type Series } from '../components/TimeChart'
import { type ComputedFrom } from '../components/PanelInfo'
import { type PanelSnapshotState } from '../components/snapshotCensus'
import { toNum, str, fmtCount, fmtMs, fmtPct } from '../lib/format'
import { SnapshotCaption } from '../components/SnapshotCaption'
import { accelEntry } from '../cribl/accel/manifest'
import { OVERVIEW_CADENCE, OVERVIEW_WINDOW, SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { KPI, CODES, HOSTS, SLOW, TREND, H2, ERRORS_DRILL } from '../queries/webApiHealth'

/**
 * The four schedules behind this tab's five panels, in the words block 4 of an ⓘ
 * needs.
 *
 * FOUR SENTENCES AND NOT ONE, because they are four schedules on four different
 * minutes and a panel may not quote its neighbour's. Nothing derives these from
 * the cron — turning `45 * * * *` into English is a cron formatter, which this
 * codebase deliberately does not have — so WebApiHealth.test.tsx pins each one
 * against the manifest entry it describes. Move a schedule without moving its
 * sentence and the suite fails.
 *
 * `WEB_HOST_CADENCE` is quoted by two panels, because one scan answers both.
 */
export const WEB_HOST_CADENCE = 'once an hour, at 45 minutes past, in UTC'
export const WEB_CODE_CADENCE = 'once an hour, at 48 minutes past, in UTC'
export const WEB_TREND_CADENCE = 'once an hour, at 51 minutes past, in UTC'
export const WEB_H2_CADENCE = 'once an hour, at 54 minutes past, in UTC'
/** All four read the same window, which is also the overview scan's. */
export const WEB_WINDOW = SNAPSHOT_WINDOW

/** The status-code entry, for the window its deep link should open. */
const CODE_ENTRY = accelEntry('gno_web_code_c1h')

/** Where a figure came from, for the ⓘ's fourth block. */
const computedFrom = (s: UseSearchState, cadence: string): ComputedFrom => ({
  source: s.source,
  at: s.at,
  stale: s.stale,
  cadence,
  window: WEB_WINDOW,
  fallback: s.note,
})

/** The same read, as the caption a `<Panel>` puts in its header. */
const snapshotOf = (s: UseSearchState): PanelSnapshotState => ({
  source: s.source,
  outcome: s.outcome,
  at: s.at,
  stale: s.stale,
  nearestAt: s.nearestAt,
})

export function WebApiHealth() {
  const { range } = useDashboard()
  // Six queries on one mount, admitted ~1.6 s apart, means the last one does not
  // begin for ~8 s. The three panels below the fold wait for the reader instead
  // of queueing behind each other; the KPI row and the first pair do not.
  //
  // THE DEFERRAL STAYS EVEN THOUGH ALL SIX ARE NOW SERVED. A stored read is
  // ~0.3 s and does not need it — but on a fresh install, before anybody has
  // applied the schedules, every hook below falls back to exactly the live query
  // it ran before, and the stagger argument above is again the whole story.
  const hostsNear = useNearViewport()
  const trendNear = useNearViewport()
  const h2Near = useNearViewport()

  // SIX OF SIX SERVED, from five scheduled searches. The KPI row has read the
  // shared overview scan since Phase 2; the five panels below were the last live
  // queries on this tab, and the three deferred ones were the worst of them —
  // deferral moves a four-to-eight-second wait to the moment the reader scrolls
  // to the panel they went looking for, rather than removing it.
  //
  // `gno_web_host_c1h` carries TWO of them from one grouping by http_host, and
  // the two panels mean different populations by the alias `n`. The body defines
  // no `n` at all and each tail renames the count it means — see the alias trap
  // in src/queries/snapshots.ts before merging anything here.
  const kpi = useSearch(KPI, { accel: 'gno_overview_c1h', accelPanel: 'web-kpi' })
  const codes = useSearch(CODES, { accel: 'gno_web_code_c1h', accelPanel: 'web-codes' })
  const hosts = useSearch(HOSTS, { accel: 'gno_web_host_c1h', accelPanel: 'web-hosts', deferred: !hostsNear.near })
  const slow = useSearch(SLOW, { accel: 'gno_web_host_c1h', accelPanel: 'web-slow' })
  const trend = useSearch(TREND, { accel: 'gno_web_trend_c1h', accelPanel: 'web-trend', deferred: !trendNear.near })
  const h2 = useSearch(H2, { accel: 'gno_web_h2_c1h', accelPanel: 'web-h2', deferred: !h2Near.near })

  const codesComputed = computedFrom(codes, WEB_CODE_CADENCE)
  const hostsComputed = computedFrom(hosts, WEB_HOST_CADENCE)
  const slowComputed = computedFrom(slow, WEB_HOST_CADENCE)
  const trendComputed = computedFrom(trend, WEB_TREND_CADENCE)
  const h2Computed = computedFrom(h2, WEB_H2_CADENCE)

  // The "open all 4xx/5xx responses" link at the foot opens the window the CODES
  // panel above it answered for, which is not always the picker's. In Snapshot
  // mode the range select is gone entirely (App.tsx), so a deep link built from
  // `range.earliest` would open a window the reader can neither see nor change,
  // and the two counts would disagree with nothing on screen to explain it.
  // DnsHealth.tsx's `drillEarliest` is the same decision for the same reason.
  const drillEarliest = codes.source === 'schedule' ? CODE_ENTRY.earliest : range.earliest

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

  // One state for the row's caption and every tile's ⓘ, so a tile can never date
  // itself differently from the line above it.
  const kpiSnapshot = { source: kpi.source, outcome: kpi.outcome, at: kpi.at, stale: kpi.stale, nearestAt: kpi.nearestAt }
  const kpiComputed = { ...kpiSnapshot, cadence: OVERVIEW_CADENCE, window: OVERVIEW_WINDOW, fallback: kpi.note }

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

      <div className="kpi-row-head">
        <SnapshotCaption state={kpiSnapshot} />
      </div>
      <div className="kpi-row kpi-row-4">
        <KpiTile label="HTTP transactions" value={kpi.loading ? '…' : fmtCount(txns)} accent="info"
          sub="http_code present" info="Flows carrying an HTTP response code in this window (HTTP/1.x only — HTTP/2 is counted separately)." query={KPI} computed={kpiComputed} />
        <KpiTile label="Error rate" value={kpi.loading ? '…' : fmtPct(errRate, 2)}
          accent={errRate > 5 ? 'danger' : errRate > 1 ? 'warning' : 'success'}
          sub={`${fmtCount(errors)} × 4xx/5xx`} info="Share of HTTP transactions returning 4xx or 5xx. 5xx implicates the server; 4xx is usually the caller." query={KPI} computed={kpiComputed} />
        <KpiTile label="Server think-time p95" value={kpi.loading ? '…' : fmtMs(toNum(k.server_p95))} accent="warning"
          sub="http_server_ms" info="95th-percentile server processing time — request timestamp to response timestamp, measured on the wire." query={KPI} computed={kpiComputed} />
        <KpiTile label="HTTP/2 transactions" value={kpi.loading ? '…' : fmtCount(toNum(k.h2))} accent="neutral"
          sub="http2_code · separate field set" info="HTTP/2 flows. Gigamon reports these under http2_* fields, so they are invisible to the http_* panels on this page." query={KPI} computed={kpiComputed} />
      </div>

      <div className="grid-2">
        <Panel tourId="web-codes" title="Status codes" query={CODES} computed={codesComputed} snapshot={snapshotOf(codes)} onRefresh={codes.refetch} refreshing={codes.loading} note="http_code · by volume"
          info="Distribution of HTTP response codes. Bars are coloured by class so 4xx/5xx stand out against 2xx/3xx volume.">
          <QueryBoundary state={codes} emptyLabel="No HTTP responses in this window">
            <BarList items={codeItems} accent={worstCode ? 'accent' : 'success'} />
          </QueryBoundary>
        </Panel>

        {/* The bar note on each row is `<n> txns`, and `n` here is the count of
            transactions THAT CARRIED A SERVER TIME — not the host's whole
            traffic, which is what the panel below means by the same letter. The
            shared body defines `srv_n` and this panel's tail renames it; see
            src/queries/snapshots.ts. */}
        <Panel tourId="web-slow" title="Slowest hosts — server think-time p95" query={SLOW} computed={slowComputed} snapshot={snapshotOf(slow)} onRefresh={slow.refetch} refreshing={slow.loading} note="http_server_ms · p95"
          info="Hosts ranked by 95th-percentile server processing time. This is the server's own latency, isolated from network RTT — the 'is it the app or the network' split.">
          <QueryBoundary state={slow} emptyLabel="No server-timing data in this window">
            <BarList items={slowItems} accent="accent" />
          </QueryBoundary>
        </Panel>
      </div>

      <Panel anchorRef={hostsNear.ref} tourId="web-hosts" title="Top endpoints by requests" query={HOSTS} computed={hostsComputed} snapshot={snapshotOf(hosts)} onRefresh={hosts.refetch} refreshing={hosts.loading} note="http_host · error rate per host"
        info="Busiest HTTP hosts with the share of their responses that were 4xx/5xx. A high-volume host with a high error rate is the first thing to chase.">
        <QueryBoundary state={hosts} emptyLabel="No HTTP hosts in this window">
          <BarList items={hostItems} accent="info" />
        </QueryBoundary>
      </Panel>

      <div className="grid-2">
        <Panel anchorRef={trendNear.ref} tourId="web-trend" title="Requests and errors over time" query={TREND} computed={trendComputed} snapshot={snapshotOf(trend)} onRefresh={trend.refetch} refreshing={trend.loading} note="per 1m"
          info="Request volume against 4xx/5xx count per minute. A spike in errors that does not track request volume is a server-side event, not load.">
          <QueryBoundary state={trend} emptyLabel="No data" compact>
            <TimeChart series={series} height={170} />
          </QueryBoundary>
        </Panel>

        <Panel anchorRef={h2Near.ref} tourId="web-h2" title="HTTP/2 hosts" query={H2} computed={h2Computed} snapshot={snapshotOf(h2)} onRefresh={h2.refetch} refreshing={h2.loading} note="http2_host · by volume"
          info="HTTP/2 traffic, reported by Gigamon under a separate field set (http2_host / http2_code / http2_method). Shown here so modern traffic is not silently missing from the page.">
          <QueryBoundary state={h2} emptyLabel="No HTTP/2 traffic in this window">
            <BarList items={h2Items} accent="info" />
          </QueryBoundary>
        </Panel>
      </div>

      <p className="tab-sub">
        Chasing a specific status code?{' '}
        <a href={searchUiUrl(ERRORS_DRILL, drillEarliest)} target="_blank" rel="noopener noreferrer">
          Open all 4xx/5xx responses in Cribl Search ↗
        </a>
      </p>
    </div>
  )
}
