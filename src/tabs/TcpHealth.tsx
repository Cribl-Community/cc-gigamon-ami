import { useMemo, useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { useNearViewport } from '../components/nearViewport'
import { METRICS, metricFor, subnetFields, buildHeatQuery, buildDrillQuery, buildTrendQuery, latencyQuery, type MetricKey, type Mask } from '../queries/tcpHealth'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { Heatmap, type HeatCell } from '../components/Heatmap'
import { TimeChart, type Series } from '../components/TimeChart'
import { InfoTip } from '../components/InfoTip'
import { type ComputedFrom } from '../components/PanelInfo'
import { type AccelId } from '../cribl/accel/manifest'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { toNum, str, fmtMs, fmtCount } from '../lib/format'

const TOP = 8

/**
 * The two scheduled searches behind the heatmap — one per subnet mask.
 *
 * WHY THE HEATMAP CAN BE SERVED AT ALL, when its query is built from two
 * arguments a reader chooses at runtime. Both arguments are drawn from a closed,
 * compile-time set, and each is handled by the mechanism that fits it:
 *
 *   `metric` — four constants in METRICS. One scan carries all four sums and
 *   each panel state projects its own with a `| project … v=<metric>` tail, so
 *   pressing a metric button costs a stored read instead of a whole-window scan.
 *   The rows are IDENTICAL to the live query's, not close to them: the panel
 *   sorts on `flows`, which has no metric in it.
 *
 *   `mask` — two constants, but it changes the GROUP KEY rather than the
 *   aggregate, and a /24 top-120 cannot be rolled up to /16 without losing
 *   exactly the pairs the coarser view exists to gather. So it picks between two
 *   entries rather than between two tails.
 *
 * The endpoint drill below the heatmap stays live on purpose and cannot be
 * served: its argument is a clicked subnet PAIR, so precomputing it means
 * grouping by (src_ip, dst_ip) across every pair — the highest-cardinality
 * grouping in the app — carrying a percentile that cannot be re-aggregated. It
 * costs the tab nothing on open, because it only runs once a cell is selected.
 */
const TCP_ACCEL: Readonly<Record<Mask, AccelId>> = { '24': 'gno_tcp_subnet24_c1h', '16': 'gno_tcp_subnet16_c1h' }
/** The schedules in words, for block 4 of the ⓘ. TcpHealth.test.tsx holds these
 *  against the manifest's own crons and windows, so moving one forces the other.
 *
 *  Two string constants rather than the `Record<Mask, string>` this is a lookup
 *  for, because react-refresh reads an exported OBJECT out of a component file
 *  as a non-component export and warns, while an exported string literal is a
 *  constant it allows. WebApiHealth.tsx exports its four the same way. The
 *  ternary at the one call site is the whole cost of not adding a warning. */
export const TCP_CADENCE_24 = 'once an hour, at 40 minutes past, in UTC'
export const TCP_CADENCE_16 = 'once an hour, at 41 minutes past, in UTC'
export const TCP_WINDOW = SNAPSHOT_WINDOW

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
  // One entry per mask, one served panel per metric. `accelPanel` is not
  // optional here: these entries serve four panels each, and a hook naming the
  // entry without naming its panel would be handed the un-tailed row — every
  // metric's sum at once, under whichever column name it happened to read.
  const heat = useSearch(heatQuery, {
    deps: [metric, mask],
    accel: TCP_ACCEL[mask],
    accelPanel: `tcp-heatmap-${mask}-${metric}`,
  })

  const drillQuery = buildDrillQuery(sel, mask)
  const drill = useSearch(drillQuery, { enabled: !!sel, deps: [sel?.row, sel?.col, mask] })
  // The drill runs live over whatever window the drill itself read, and the
  // heatmap above it may have come from a scheduled run. Its "Open in Search"
  // link therefore follows the DRILL, not the cell — the two can legitimately
  // describe different windows, and the link has to match the table under it or
  // it is a false claim about where those rows came from.
  const heatComputed: ComputedFrom = {
    source: heat.source, at: heat.at, stale: heat.stale,
    cadence: mask === '24' ? TCP_CADENCE_24 : TCP_CADENCE_16, window: TCP_WINDOW, fallback: heat.note,
  }
  // The heatmap is the tab, and it is above the fold; the two charts under it
  // are not. Held back, they stop taking the two admission slots after the
  // heatmap's — which is what decides when the heatmap itself finishes.
  const trendNear = useNearViewport()
  const latencyNear = useNearViewport()
  const trendQuery = buildTrendQuery(metric)
  const trend = useSearch(trendQuery, { deps: [metric], deferred: !trendNear.near })
  const latency = useSearch(latencyQuery, { deferred: !latencyNear.near })

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
        computed={heatComputed}
        snapshot={{ source: heat.source, outcome: heat.outcome, at: heat.at, stale: heat.stale, nearestAt: heat.nearestAt }}
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
          info="Every src→dst endpoint pair inside the selected subnet cell, with flows and per-pair wire-error counts plus p95 network (tcp_rtt) and application (tcp_rtt_app) latency. This resolves which specific hosts are driving the heatmap cell. This table always runs live — a clicked subnet pair is not something a schedule can precompute — so when the heatmap above is showing a snapshot, these rows cover a different window and need not add up to the cell."
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
        <Panel anchorRef={trendNear.ref} onRefresh={trend.refetch} refreshing={trend.loading} title={`${m.label} over time`} info="Per-flow rate of the selected wire-error metric, per 1-minute bin." query={trendQuery} note="per 1m · wire-error trend">
          <QueryBoundary state={trend} emptyLabel="No data" compact>
            <TimeChart series={trendSeries} />
          </QueryBoundary>
        </Panel>
        <Panel anchorRef={latencyNear.ref} tourId="tcp-latency" onRefresh={latency.refetch} refreshing={latency.loading} title="Network vs app latency" info="p95 tcp_rtt (network path) vs tcp_rtt_app (application response), with a shaded min–max band. Log axis so both scales are visible." query={latencyQuery} note="tcp_rtt vs tcp_rtt_app · p95 · min–max band · log ms">
          <QueryBoundary state={latency} emptyLabel="No RTT records in this window" compact>
            <TimeChart series={latSeries} fmt={fmtMs} log />
          </QueryBoundary>
        </Panel>
      </div>
    </div>
  )
}
