import { useMemo, useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { METRICS, metricFor, subnetFields, buildHeatQuery, buildDrillQuery, buildTrendQuery, latencyQuery, type MetricKey, type Mask } from '../queries/tcpHealth'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { Heatmap, type HeatCell } from '../components/Heatmap'
import { TimeChart, type Series } from '../components/TimeChart'
import { InfoTip } from '../components/InfoTip'
import { toNum, str, fmtMs, fmtCount } from '../lib/format'

const TOP = 8

export function TcpHealth() {
  const { range } = useDashboard()
  const [metric, setMetric] = useState<MetricKey>('resets')
  const [mask, setMask] = useState<Mask>('24')
  // Selected heatmap cell → in-app endpoint drill (was: open in Search).
  const [sel, setSel] = useState<{ row: string; col: string } | null>(null)
  const m = metricFor(metric)
  // Result columns to read back — the same pair the queries group by.
  const { sf, df } = subnetFields(mask)

  const drillTile = (rowSub: string, colSub: string) => setSel({ row: rowSub, col: colSub })
  const changeMask = (mk: Mask) => { setMask(mk); setSel(null) } // subnet format changes

  const heatQuery = buildHeatQuery(metric, mask)
  const heat = useSearch(heatQuery, { deps: [metric, mask] })

  const drillQuery = buildDrillQuery(sel, mask)
  const drill = useSearch(drillQuery, { enabled: !!sel, deps: [sel?.row, sel?.col, mask] })
  const trendQuery = buildTrendQuery(metric)
  const trend = useSearch(trendQuery, { deps: [metric] })
  const latency = useSearch(latencyQuery)

  // Build top-N × top-N matrix; cell = per-flow rate (metric / flows).
  const matrix = useMemo(() => {
    const srcFlows: Record<string, number> = {}
    const dstFlows: Record<string, number> = {}
    const rate = new Map<string, number>()
    for (const p of heat.rows) {
      const s = str(p, sf)
      const d = str(p, df)
      const flows = toNum(p.flows)
      if (!s || !d || flows === 0) continue
      srcFlows[s] = (srcFlows[s] ?? 0) + flows
      dstFlows[d] = (dstFlows[d] ?? 0) + flows
      rate.set(`${s}|${d}`, toNum(p.v) / flows)
    }
    const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, TOP).map((e) => e[0])
    const rows = top(srcFlows)
    const cols = top(dstFlows)
    let max = 0
    for (const r of rows) for (const c of cols) { const v = rate.get(`${r}|${c}`); if (v != null) max = Math.max(max, v) }
    const fmtRate = (v: number) => (v === 0 ? '0' : v >= 100 ? Math.round(v).toString() : v >= 1 ? v.toFixed(1) : v.toFixed(2))
    const cell = (r: string, c: string): HeatCell | null => {
      const v = rate.get(`${r}|${c}`)
      return v == null ? null : { value: v, display: fmtRate(v) }
    }
    return { rows, cols, cell, max }
  }, [heat.rows, sf, df])

  const trendSeries: Series[] = [
    { name: `${m.label} per flow`, color: '#ff6b6b', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.flows) ? toNum(r.v) / toNum(r.flows) : 0 })) },
  ]
  const latSeries: Series[] = [
    {
      name: 'network (tcp_rtt)', color: '#4dabf7',
      points: latency.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.net) * 1000 })),
      band: latency.rows.map((r) => ({ t: toNum(r.bin_time_1m), lo: toNum(r.net_lo) * 1000, hi: toNum(r.net_hi) * 1000 })),
    },
    {
      name: 'application (tcp_rtt_app)', color: '#ffa94d',
      points: latency.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.app) * 1000 })),
      band: latency.rows.map((r) => ({ t: toNum(r.bin_time_1m), lo: toNum(r.app_lo) * 1000, hi: toNum(r.app_hi) * 1000 })),
    },
  ]

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">TCP health</h2>
        <p className="tab-sub">
          Wire-error rate per subnet pair, plus network-vs-application latency separation
          (<code>tcp_rtt</code> vs <code>tcp_rtt_app</code>, p95). Cells show the selected metric <strong>per flow</strong>.
          Only TCP flows (<code>protocol=6</code>).
        </p>
        <div className="toggle-row">
          <div className="toggle-grp">
            <span className="toggle-lbl">Metric<InfoTip text="Wire-error signal to map. Each cell is the metric summed over the subnet pair, divided by its flow count (per-flow rate)." /></span>
            <div className="pivot-toggle">
              {METRICS.map((x) => (
                <button key={x.key} type="button" className={`seg ${metric === x.key ? 'seg-active' : ''}`} onClick={() => setMetric(x.key)} title={x.info}>{x.label}</button>
              ))}
            </div>
          </div>
          <div className="toggle-grp">
            <span className="toggle-lbl">Subnet<InfoTip text="Aggregate endpoints at /24 (first 3 octets) or /16 (first 2) to widen or tighten the grouping." /></span>
            <div className="pivot-toggle">
              {(['24', '16'] as const).map((mk) => (
                <button key={mk} type="button" className={`seg ${mask === mk ? 'seg-active' : ''}`} onClick={() => changeMask(mk)}>/{mk}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Panel
        tourId="tcp-heatmap"
        onRefresh={heat.refetch} refreshing={heat.loading}
        title={`${m.label} heatmap · src subnet × dst subnet`}
        info={`Per-flow ${m.label} for the top ${TOP} busiest /${mask} subnets on each axis. ${m.info} Color is relative to the hottest cell in view. Click a tile to drill into its real src→dst endpoints below.`}
        query={heatQuery}
        note={`/${mask} · top ${TOP} busiest each axis · click a tile → endpoint drill below`}
      >
        <QueryBoundary state={heat} emptyLabel="No TCP flows with subnet data in this window">
          <Heatmap rows={matrix.rows} cols={matrix.cols} cell={matrix.cell} max={matrix.max} onSelect={drillTile} selected={sel} />
          <div className="heat-scale">
            <span className="heat-scale-lbl">{m.label} / flow (relative)</span>
            <span className="heat-scale-bar" />
            <span className="heat-scale-ends">cool → hot</span>
          </div>
        </QueryBoundary>
      </Panel>

      {sel && (
        <Panel
          className="tcp-drill"
          onRefresh={drill.refetch} refreshing={drill.loading}
          title={
            <span className="tcp-drill-title">
              Endpoint drill · <code>{sel.row}</code> <span className="tcp-arrow">→</span> <code>{sel.col}</code>
            </span>
          }
          info="Every src→dst endpoint pair inside the selected subnet cell, with flows and per-pair wire-error counts plus p95 network (tcp_rtt) and application (tcp_rtt_app) latency. This resolves which specific hosts are driving the heatmap cell."
          query={drillQuery}
          note={
            <span className="tcp-drill-note">
              <a href={searchUiUrl(drillQuery, range.earliest)} target="_blank" rel="noopener noreferrer" title="Open this subnet pair in Cribl Search">Open in Search ↗</a>
              <button type="button" className="tcp-drill-close" onClick={() => setSel(null)} aria-label="Close drill">✕ Close</button>
            </span>
          }
        >
          <QueryBoundary state={drill} emptyLabel="No TCP flows for this subnet pair in the window">
            {(() => {
              const rows = drill.rows
              const sum = (k: string) => rows.reduce((a, r) => a + toNum(r[k]), 0)
              const totFlows = sum('flows')
              return (
                <>
                  <div className="tcp-drill-summary">
                    <span><strong>{fmtCount(totFlows)}</strong> flows</span>
                    <span><strong>{fmtCount(rows.length)}</strong> endpoint pairs</span>
                    <span className={sum('retrans') ? 'd-warn' : ''}>{fmtCount(sum('retrans'))} retrans</span>
                    <span className={sum('resets') ? 'd-danger' : ''}>{fmtCount(sum('resets'))} resets</span>
                    <span className={sum('crc') ? 'd-danger' : ''}>{fmtCount(sum('crc'))} CRC</span>
                    <span className={sum('loss') ? 'd-warn' : ''}>{fmtCount(sum('loss'))} loss</span>
                  </div>
                  <div className="tcp-drill-scroll">
                    <table className="dtable dtable-sticky">
                      <caption className="sr-only">
                        Endpoint pairs behind this heatmap cell, one row per source and destination, with the
                        packet-health counters and the network and application p95 latencies for each.
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Source</th><th scope="col">Destination</th>
                          <th scope="col" className="dtable-num">Flows</th>
                          <th scope="col" className="dtable-num">Retrans</th>
                          <th scope="col" className="dtable-num">Resets</th>
                          <th scope="col" className="dtable-num">CRC</th>
                          <th scope="col" className="dtable-num">Loss</th>
                          <th scope="col" className="dtable-num">Net p95</th>
                          <th scope="col" className="dtable-num">App p95</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => {
                          const retrans = toNum(r.retrans), resets = toNum(r.resets), crc = toNum(r.crc), loss = toNum(r.loss)
                          return (
                            <tr key={i} className={resets || crc ? 'tcp-drill-bad' : ''}>
                              <th scope="row" className="dtable-id dtable-mono">{str(r, 'src_ip', '—')}</th>
                              <td className="dtable-mono">{str(r, 'dst_ip', '—')}</td>
                              <td className="dtable-num">{fmtCount(r.flows)}</td>
                              <td className={`dtable-num ${retrans ? 'd-warn' : 'tcp-zero'}`}>{fmtCount(retrans)}</td>
                              <td className={`dtable-num ${resets ? 'd-danger' : 'tcp-zero'}`}>{fmtCount(resets)}</td>
                              <td className={`dtable-num ${crc ? 'd-danger' : 'tcp-zero'}`}>{fmtCount(crc)}</td>
                              <td className={`dtable-num ${loss ? 'd-warn' : 'tcp-zero'}`}>{fmtCount(loss)}</td>
                              <td className="dtable-num">{toNum(r.net) ? fmtMs(toNum(r.net) * 1000) : '—'}</td>
                              <td className="dtable-num">{toNum(r.app) ? fmtMs(toNum(r.app) * 1000) : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )
            })()}
          </QueryBoundary>
        </Panel>
      )}

      <div className="grid-2">
        <Panel onRefresh={trend.refetch} refreshing={trend.loading} title={`${m.label} over time`} info="Per-flow rate of the selected wire-error metric, per 1-minute bin." query={trendQuery} note="per 1m · wire-error trend">
          <QueryBoundary state={trend} emptyLabel="No data" compact>
            <TimeChart series={trendSeries} />
          </QueryBoundary>
        </Panel>
        <Panel tourId="tcp-latency" onRefresh={latency.refetch} refreshing={latency.loading} title="Network vs app latency" info="p95 tcp_rtt (network path) vs tcp_rtt_app (application response), with a shaded min–max band. Log axis so both scales are visible." query={latencyQuery} note="tcp_rtt vs tcp_rtt_app · p95 · min–max band · log ms">
          <QueryBoundary state={latency} emptyLabel="No RTT records in this window" compact>
            <TimeChart series={latSeries} fmt={fmtMs} log />
          </QueryBoundary>
        </Panel>
      </div>
    </div>
  )
}
