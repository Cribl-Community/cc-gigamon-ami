import { useState } from 'react'
import { useSearch, type UseSearchState } from '../cribl/useSearch'
import { useNearViewport } from '../components/nearViewport'
import { PIVOTS, pivotFor, buildKpiQuery, buildTalkersQuery, buildAppmixQuery, buildL4Query, type Pivot } from '../queries/capacityTopTalkers'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { Donut } from '../components/Donut'
import { InfoTip } from '../components/InfoTip'
import { SnapshotCaption } from '../components/SnapshotCaption'
import { type PanelSnapshotState } from '../components/snapshotCensus'
import { type ComputedFrom } from '../components/PanelInfo'
import { OVERVIEW_CADENCE, OVERVIEW_WINDOW, SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { type AccelId } from '../cribl/accel/manifest'
import { toNum, str, fmtBytes, fmtCount, fmtMs, windowSeconds } from '../lib/format'

const LINK_SPEEDS = [1, 10, 100]
const MIX_COLORS = ['#4dabf7', '#38d9a9', '#ffa94d', '#b197fc', '#ff6b9d', '#63e6be', '#ffd43b', '#74c0fc']

/**
 * The scheduled search behind the three byte panels on this tab.
 *
 * One hourly rollup of bytes by (app_name, l4_proto): the mix donut sums it
 * along the application key, the L4 split sums it along the protocol key, and
 * the top-talkers bar list sums it along the application key while that is the
 * pivot in force. Summing an additive two-key rollup along one key is the same
 * number a one-key scan returns, which is what makes all three exact rather
 * than approximate — see src/queries/snapshots.ts.
 */
const MIX_ACCEL: AccelId = 'gno_app_l4_c1h'
/** The default view's own run: top talkers by source IP. */
const TALKERS_SRC_ACCEL: AccelId = 'gno_talkers_src_c1h'
/** The schedule in words, for the ⓘ. CapacityTopTalkers.test.tsx holds these
 *  against the manifest's own cron and window, so moving one forces the other. */
export const MIX_CADENCE = 'once an hour, at 47 minutes past, in UTC'
export const MIX_WINDOW = SNAPSHOT_WINDOW

/**
 * A group key as this tab renders it, with the snapshot body's empty-string
 * sentinel reading the way a missing value already read.
 *
 * The scan turns a null `app_name` or `l4_proto` into `""` before grouping, so
 * that the panel summing along the OTHER key still counts those bytes. That
 * sentinel then arrives here as a label, and `str`'s fallback only fires on
 * null — so without this the snapshot path would print a blank row where the
 * live path printed "(none)". Same rows, same bytes, a different word: exactly
 * the kind of difference a reader reports as the app disagreeing with itself.
 */
const label = (row: Record<string, unknown>, key: string, fallback: string): string => str(row, key, fallback) || fallback

export function CapacityTopTalkers() {
  const { range } = useDashboard()
  const [pivot, setPivot] = useState<Pivot>('src_ip')
  const [filterInput, setFilterInput] = useState('')
  const [applied, setApplied] = useState('')
  const [linkGbps, setLinkGbps] = useState(100)
  const [customGbps, setCustomGbps] = useState('')

  const p = pivotFor(pivot)
  const winSec = windowSeconds(range.earliest)
  const linkBits = linkGbps * 1e9 * winSec
  const pctOfLink = (bytes: number) => (linkBits > 0 ? (bytes * 8 * 100) / linkBits : 0)

  const kpiQuery = buildKpiQuery(pivot, applied)
  // Only the UNFILTERED row is snapshot-served. A filter a viewer types becomes
  // part of the query text, and no stored run holds an answer for a filter
  // nobody had typed when the scan fired — so the moment somebody applies one,
  // this hook goes back to being an ordinary live query and its caption says so.
  const kpis = useSearch(kpiQuery, {
    deps: [applied, pivot],
    accel: 'gno_overview_c1h',
    accelPanel: 'capacity-kpi',
    accelEnabled: applied === '',
  })
  // One state object, read by the row's caption and by every tile's ⓘ, so a
  // tile can never date itself differently from the line above it.
  const kpiSnapshot = { source: kpis.source, outcome: kpis.outcome, at: kpis.at, stale: kpis.stale, nearestAt: kpis.nearestAt }
  const kpiComputed = { ...kpiSnapshot, cadence: OVERVIEW_CADENCE, window: OVERVIEW_WINDOW, fallback: kpis.note }

  // ── THE OTHER THREE PANELS, FROM ONE HOURLY ROLLUP ───────────────────────
  // Every hook below repeats the gate above verbatim, and that repetition is
  // the whole safety of this tab: `applied` is free text spliced into the query
  // head, so the argument domain is unbounded and no stored run can hold an
  // answer for it. A served panel that ignored the filter would show
  // unfiltered numbers under a filtered heading — worse than being slow,
  // because nothing on screen would say so.
  const unfiltered = applied === ''

  const talkersQuery = buildTalkersQuery(pivot, applied)
  // TWO OF THE THREE PIVOT STATES. `app_name` is read out of the app/L4
  // rollup; `src_ip` — the tab's DEFAULT view, and so the one every open waits
  // on — has its own run storing exactly that query (gno_talkers_src_c1h,
  // 2026-09-23). `dst_aws_flat_tags_name` stays live: neither scan can express
  // it, and a tail returning a different top-12 from the live query would not
  // be honest.
  const talkersServed = pivot === 'app_name' ? { accel: MIX_ACCEL, accelPanel: 'capacity-talkers-app' } : { accel: TALKERS_SRC_ACCEL, accelPanel: 'capacity-talkers-src' }
  const talkers = useSearch(talkersQuery, {
    deps: [pivot, applied],
    ...talkersServed,
    accelEnabled: unfiltered && (pivot === 'app_name' || pivot === 'src_ip'),
  })
  // The KPI row and the talkers table are what this tab is opened for; the two
  // mix charts sit under them and can wait for the scroll. Deferral and
  // acceleration answer different questions — WHEN a query is submitted, and
  // WHETHER it scans the Lake — so a deferred panel still reads the schedule
  // when it finally runs.
  const appmixNear = useNearViewport()
  const l4Near = useNearViewport()
  // `deps: [applied]` and not `[applied, pivot]` on these two, deliberately:
  // `scopeFor` puts the pivot field into the text ONLY when a filter is
  // applied, so with nothing applied all three pivots build the identical
  // string and re-running on a pivot click would be a scan that returns what is
  // already on screen. The pivot buttons also clear `applied`, which is what
  // moves the text when it needs to move.
  const appmixQuery = buildAppmixQuery(pivot, applied)
  const appmix = useSearch(appmixQuery, {
    deps: [applied],
    deferred: !appmixNear.near,
    accel: MIX_ACCEL,
    accelPanel: 'capacity-app-mix',
    accelEnabled: unfiltered,
  })
  const l4Query = buildL4Query(pivot, applied)
  const l4 = useSearch(l4Query, {
    deps: [applied],
    deferred: !l4Near.near,
    accel: MIX_ACCEL,
    accelPanel: 'capacity-l4',
    accelEnabled: unfiltered,
  })

  // Where each of the three figures came from, for block 4 of its ⓘ and for the
  // caption under its title. THREE, not one: they share a schedule but they are
  // three reads, and one can fall back to live while the others answer from the
  // run — a panel dated from its neighbour's read would be the false claim the
  // dating exists to prevent.
  const computedFrom = (state: UseSearchState): ComputedFrom => ({
    source: state.source,
    at: state.at,
    stale: state.stale,
    cadence: MIX_CADENCE,
    window: MIX_WINDOW,
    fallback: state.note,
  })
  const snapshotOf = (state: UseSearchState): PanelSnapshotState => ({
    source: state.source,
    outcome: state.outcome,
    at: state.at,
    stale: state.stale,
    nearestAt: state.nearestAt,
  })
  const talkersComputed = computedFrom(talkers)
  const appmixComputed = computedFrom(appmix)
  const l4Computed = computedFrom(l4)

  const k = kpis.rows[0] ?? {}
  const appTotal = appmix.rows.reduce((s, r) => s + toNum(r.bytes), 0) || 1

  const talkerItems: BarItem[] = talkers.rows.map((r) => ({
    label: label(r, p.field, '(none)'),
    value: toNum(r.bytes),
    display: fmtBytes(r.bytes),
    note: `${pctOfLink(toNum(r.bytes)).toFixed(2)}% of ${linkGbps}G`,
  }))
  const l4Items: BarItem[] = l4.rows.map((r) => ({ label: label(r, 'l4_proto', '?'), value: toNum(r.bytes), display: fmtBytes(r.bytes) }))
  const donutSlices = appmix.rows.map((r, i) => ({ label: label(r, 'app_name', '(none)'), value: toNum(r.bytes), color: MIX_COLORS[i % MIX_COLORS.length] }))

  const applyFilter = () => setApplied(filterInput.trim())

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Capacity &amp; top talkers</h2>
        <p className="tab-sub">Pivot the whole view by source IP, application, or AWS service. Bytes summed from <code>total_bytes</code> (src+dst).</p>
        <div className="cap-controls">
          <div className="pivot-toggle">
            {PIVOTS.map((x) => (
              <button key={x.key} type="button" className={`seg ${pivot === x.key ? 'seg-active' : ''}`} onClick={() => { setPivot(x.key); setApplied(''); setFilterInput('') }}>{x.label}</button>
            ))}
          </div>
          <input className="cap-filter" placeholder={p.ph} value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyFilter()} />
          <button type="button" className="btn btn-primary" onClick={applyFilter}>Apply</button>
          {applied && <button type="button" className="btn" onClick={() => { setApplied(''); setFilterInput('') }}>Clear</button>}
          <InfoTip text="Scope every panel below to one entity — type a value (substring match) and Apply. Clears with Clear." side="left" />
        </div>
      </div>

      <div className="kpi-row-head">
        <SnapshotCaption state={kpiSnapshot} />
      </div>
      <div className="kpi-row kpi-row-6">
        <KpiTile label="Total traffic" value={fmtBytes(k.total)} sub="total_bytes · observed window" info="Sum of src+dst bytes across all flows in the current time range and filter." query={kpiQuery} computed={kpiComputed} />
        <KpiTile label="Traffic in" value={fmtBytes(k.tin)} sub="dst_bytes" accent="info" info="Bytes received by destinations (dst_bytes)." query={kpiQuery} computed={kpiComputed} />
        <KpiTile label="Traffic out" value={fmtBytes(k.tout)} sub="src_bytes" accent="info" info="Bytes sent by sources (src_bytes)." query={kpiQuery} computed={kpiComputed} />
        <KpiTile label="Avg RTT" value={fmtMs(toNum(k.rtt) * 1000)} sub="tcp_rtt" info="Mean network round-trip time (tcp_rtt) over TCP flows." query={kpiQuery} computed={kpiComputed} />
        <KpiTile label="Packets" value={fmtCount(k.pkts)} sub="src+dst" info="Total packet count (src_packets + dst_packets)." query={kpiQuery} computed={kpiComputed} />
        <KpiTile label="Retransmits" value={fmtCount(k.retrans)} accent="warning" sub="tcp_dup_ack" info="Duplicate-ACK count — a retransmission proxy (tcp_retransmission_bytes isn't in this AMI feed)." query={kpiQuery} computed={kpiComputed} />
      </div>

      <Panel
        tourId="cap-talkers"
        snapshot={snapshotOf(talkers)} computed={talkersComputed}
        onRefresh={() => { talkers.refetch(); kpis.refetch() }} refreshing={talkers.loading}
        title={`Top ${p.noun} — by total bytes`}
        info="Busiest entities by bytes. The right-hand % recomputes each row's traffic as a share of the selected link speed over the window — a quick capacity-utilization read. Click a row to scope the whole view to it."
        query={talkersQuery}
        note={
          <span className="linkspeed">
            Link speed
            {LINK_SPEEDS.map((s) => (
              <button key={s} type="button" className={`seg-sm ${linkGbps === s && !customGbps ? 'seg-active' : ''}`} onClick={() => { setLinkGbps(s); setCustomGbps('') }}>{s}G</button>
            ))}
            <input className="linkspeed-in" placeholder="Gbps" value={customGbps}
              onChange={(e) => setCustomGbps(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && Number(customGbps) > 0) setLinkGbps(Number(customGbps)) }} />
            <button type="button" className="seg-sm" onClick={() => Number(customGbps) > 0 && setLinkGbps(Number(customGbps))}>Set</button>
          </span>
        }
      >
        <QueryBoundary state={talkers} emptyLabel="No traffic in this window">
          <BarList items={talkerItems} accent="success" onSelect={(it) => {
            if (!it.label || it.label === '(none)') return
            setApplied(it.label); setFilterInput(it.label)
          }} />
        </QueryBoundary>
      </Panel>

      <div className="grid-2">
        <Panel anchorRef={appmixNear.ref} snapshot={snapshotOf(appmix)} computed={appmixComputed} title="App protocol mix" info="Share of bytes by application (app_name). Donut + ranked list." query={appmixQuery} onRefresh={appmix.refetch} refreshing={appmix.loading} note="app_name · by bytes">
          <QueryBoundary state={appmix} emptyLabel="No data">
            <div className="mix-wrap">
              <Donut slices={donutSlices} />
              <ul className="mixlist">
                {appmix.rows.map((r, i) => {
                  const name = label(r, 'app_name', '(none)')
                  const pct = (toNum(r.bytes) / appTotal) * 100
                  return (
                    <li className="mixrow" key={`${name}-${i}`}>
                      <span className="swatch" style={{ background: MIX_COLORS[i % MIX_COLORS.length] }} />
                      <span className="mixname" title={name}>{name}</span>
                      <span className="mixpct">{pct.toFixed(1)}%</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </QueryBoundary>
        </Panel>

        <Panel anchorRef={l4Near.ref} snapshot={snapshotOf(l4)} computed={l4Computed} title="Traffic by L4 protocol" info="Byte split across transport protocols (l4_proto derived from the IP protocol number)." query={l4Query} onRefresh={l4.refetch} refreshing={l4.loading} note="protocol 6=TCP 17=UDP 1=ICMP">
          <QueryBoundary state={l4} emptyLabel="No data">
            <BarList items={l4Items} accent="info" />
          </QueryBoundary>
        </Panel>
      </div>
    </div>
  )
}
