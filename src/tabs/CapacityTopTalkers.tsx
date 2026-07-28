import { useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { Donut } from '../components/Donut'
import { InfoTip } from '../components/InfoTip'
import { toNum, str, fmtBytes, fmtCount, fmtMs, windowSeconds } from '../lib/format'

const PIVOTS = [
  { key: 'src_ip', field: 'src_ip', label: 'Source IP', ph: 'e.g. 10.0.0.168', noun: 'talkers' },
  { key: 'app_name', field: 'app_name', label: 'App', ph: 'e.g. https / dns / openai', noun: 'apps' },
  { key: 'dst_aws_flat_tags_name', field: 'dst_aws_flat_tags_name', label: 'AWS service', ph: 'e.g. Postgres_Sql_GEM', noun: 'services' },
] as const
type Pivot = (typeof PIVOTS)[number]['key']

const LINK_SPEEDS = [1, 10, 100]
const MIX_COLORS = ['#4dabf7', '#38d9a9', '#ffa94d', '#b197fc', '#ff6b9d', '#63e6be', '#ffd43b', '#74c0fc']

export function CapacityTopTalkers() {
  const { range } = useDashboard()
  const [pivot, setPivot] = useState<Pivot>('src_ip')
  const [filterInput, setFilterInput] = useState('')
  const [applied, setApplied] = useState('')
  const [linkGbps, setLinkGbps] = useState(100)
  const [customGbps, setCustomGbps] = useState('')

  const p = PIVOTS.find((x) => x.key === pivot)!
  const scope = applied ? `${p.field}="*${applied}*" ` : ''
  const winSec = windowSeconds(range.earliest)
  const linkBits = linkGbps * 1e9 * winSec
  const pctOfLink = (bytes: number) => (linkBits > 0 ? (bytes * 8 * 100) / linkBits : 0)

  const kpiQuery = q(`${scope}| summarize total=sum(total_bytes), tin=sum(dst_bytes), tout=sum(src_bytes), pkts=sum(total_packets), rtt=avg(tcp_rtt), retrans=sum(tcp_dup_ack)`)
  const kpis = useSearch(kpiQuery, { deps: [applied, pivot] })
  const talkersQuery = q(`${scope}${p.field}=* | summarize bytes=sum(total_bytes) by ${p.field} | sort by bytes desc | limit 12`)
  const talkers = useSearch(talkersQuery, { deps: [pivot, applied] })
  const appmixQuery = q(`${scope}| summarize bytes=sum(total_bytes) by app_name | sort by bytes desc | limit 8`)
  const appmix = useSearch(appmixQuery, { deps: [applied] })
  const l4Query = q(`${scope}| summarize bytes=sum(total_bytes) by l4_proto | sort by bytes desc`)
  const l4 = useSearch(l4Query, { deps: [applied] })

  const k = kpis.rows[0] ?? {}
  const appTotal = appmix.rows.reduce((s, r) => s + toNum(r.bytes), 0) || 1

  const talkerItems: BarItem[] = talkers.rows.map((r) => ({
    label: str(r, p.field, '(none)'),
    value: toNum(r.bytes),
    display: fmtBytes(r.bytes),
    note: `${pctOfLink(toNum(r.bytes)).toFixed(2)}% of ${linkGbps}G`,
  }))
  const l4Items: BarItem[] = l4.rows.map((r) => ({ label: str(r, 'l4_proto', '?'), value: toNum(r.bytes), display: fmtBytes(r.bytes) }))
  const donutSlices = appmix.rows.map((r, i) => ({ label: str(r, 'app_name', '(none)'), value: toNum(r.bytes), color: MIX_COLORS[i % MIX_COLORS.length] }))

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
          <button type="button" className="btn-incident" onClick={applyFilter}>Apply</button>
          {applied && <button type="button" className="btn-refresh" onClick={() => { setApplied(''); setFilterInput('') }}>Clear</button>}
          <InfoTip text="Scope every panel below to one entity — type a value (substring match) and Apply. Clears with Clear." side="left" />
        </div>
      </div>

      <div className="kpi-row kpi-row-6">
        <KpiTile label="Total traffic" value={fmtBytes(k.total)} sub="total_bytes · observed window" info="Sum of src+dst bytes across all flows in the current time range and filter." query={kpiQuery} />
        <KpiTile label="Traffic in" value={fmtBytes(k.tin)} sub="dst_bytes" accent="info" info="Bytes received by destinations (dst_bytes)." query={kpiQuery} />
        <KpiTile label="Traffic out" value={fmtBytes(k.tout)} sub="src_bytes" accent="info" info="Bytes sent by sources (src_bytes)." query={kpiQuery} />
        <KpiTile label="Avg RTT" value={fmtMs(toNum(k.rtt) * 1000)} sub="tcp_rtt" info="Mean network round-trip time (tcp_rtt) over TCP flows." query={kpiQuery} />
        <KpiTile label="Packets" value={fmtCount(k.pkts)} sub="src+dst" info="Total packet count (src_packets + dst_packets)." query={kpiQuery} />
        <KpiTile label="Retransmits" value={fmtCount(k.retrans)} accent="warning" sub="tcp_dup_ack" info="Duplicate-ACK count — a retransmission proxy (tcp_retransmission_bytes isn't in this AMI feed)." query={kpiQuery} />
      </div>

      <Panel
        tourId="cap-talkers"
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
        <Panel title="App protocol mix" info="Share of bytes by application (app_name). Donut + ranked list." query={appmixQuery} onRefresh={appmix.refetch} refreshing={appmix.loading} note="app_name · by bytes">
          <QueryBoundary state={appmix} emptyLabel="No data">
            <div className="mix-wrap">
              <Donut slices={donutSlices} />
              <ul className="mixlist">
                {appmix.rows.map((r, i) => {
                  const name = str(r, 'app_name', '(none)')
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

        <Panel title="Traffic by L4 protocol" info="Byte split across transport protocols (l4_proto derived from the IP protocol number)." query={l4Query} onRefresh={l4.refetch} refreshing={l4.loading} note="protocol 6=TCP 17=UDP 1=ICMP">
          <QueryBoundary state={l4} emptyLabel="No data">
            <BarList items={l4Items} accent="info" />
          </QueryBoundary>
        </Panel>
      </div>
    </div>
  )
}
