import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useSearch } from '../cribl/useSearch'
import { useNearViewport } from '../components/nearViewport'
import { nodesQuery, pairsQuery, buildDomainsQuery, buildTrendQuery } from '../queries/flowMap'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { mergeSnapshotStates } from '../components/snapshotCensus'
import { TimeChart, type Series } from '../components/TimeChart'
import { InfoTip } from '../components/InfoTip'
import { ServiceNowModal } from '../components/ServiceNowModal'
import { toNum, str, fmtMs, fmtCount } from '../lib/format'
import { TabLoading } from '../components/TabLoading'
import type { DepView } from './FlowMapDeps'

// Flow Map is the eager landing tab; the dependency views mount only when chosen,
// so they load as their own chunk rather than growing the first page load.
const DependencyView = lazy(() => import('./FlowMapDeps').then((m) => ({ default: m.DependencyView })))

// Per-domain SLOs (ms) — the HTTP response path is allowed more headroom, like the reference.
const SLO = { network: 100, application: 100, server: 200, dns: 100 }

/** p95 tcp_rtt (ms) the graph colours against: amber above it, red above 3×. */
const GRAPH_RTT_SLO = 200
/** Share of a destination's flows with duplicate ACKs: amber at 5 %, red at 25 %. */
const DUPACK_WARN = 0.05
const DUPACK_DANGER = 0.25
/** How many busiest sources that are not drawn destinations join as "client only". */
const TOP_CLIENTS = 8
/** How many source → destination edges the map draws. */
const TOP_EDGES = 40

type Health = 'success' | 'warning' | 'danger' | 'unknown'
interface Figures { netMs: number; netN: number; dupRate: number; dupN: number }
function healthOf(f: Figures): Health {
  if (f.netN > 0 && f.netMs > GRAPH_RTT_SLO * 3) return 'danger'
  if (f.dupN > 0 && f.dupRate >= DUPACK_DANGER) return 'danger'
  if (f.netN > 0 && f.netMs > GRAPH_RTT_SLO) return 'warning'
  if (f.dupN > 0 && f.dupRate >= DUPACK_WARN) return 'warning'
  if (f.netN === 0 && f.dupN === 0) return 'unknown'
  return 'success'
}
const HEALTH_COLOR: Record<Health, string> = { success: '#37b24d', warning: '#f59f00', danger: '#f03e3e', unknown: '#5c6773' }
const SEVERITY: Record<Health, number> = { unknown: 0, success: 1, warning: 2, danger: 3 }
const worse = (a: Health, b: Health): Health => (SEVERITY[a] >= SEVERITY[b] ? a : b)

function statusOf(f: Figures): string {
  const pct = `${Math.round(f.dupRate * 100)}% dup-ACK`
  if (f.netN > 0 && f.netMs > GRAPH_RTT_SLO * 3) return `rtt ${fmtMs(f.netMs)} · breaching`
  if (f.dupN > 0 && f.dupRate >= DUPACK_DANGER) return `${pct} · breaching`
  if (f.netN > 0 && f.netMs > GRAPH_RTT_SLO) return `rtt ${fmtMs(f.netMs)} · elevated`
  if (f.dupN > 0 && f.dupRate >= DUPACK_WARN) return `${pct} · elevated`
  if (f.netN === 0 && f.dupN === 0) return 'no latency data'
  return f.netN > 0 ? `rtt ${fmtMs(f.netMs)}` : 'healthy'
}

interface Node extends Figures { id: string; label: string; flows: number; health: Health; status: string; r: number; x: number; y: number; client: boolean }

type FlowView = 'destinations' | DepView
const VIEWS: ReadonlyArray<{ key: FlowView; label: string }> = [
  { key: 'destinations', label: 'Destinations' },
  { key: 'dns', label: 'DNS' },
  { key: 'web', label: 'Web/API' },
  { key: 'subnets', label: 'Subnets' },
]
const DEP_INTRO: Record<DepView, string> = {
  dns: 'Which clients depend on which DNS resolvers, and which resolvers are failing them (SERVFAIL + NXDOMAIN share) or answering slowly. Hover a line or node for its figures.',
  web: 'Which clients call which HTTP hosts and APIs, and which hosts are returning errors (http_code ≥ 400) or responding slowly (p95 http_rtt). Hover a line or node for its figures.',
  subnets: 'Which /24 networks talk to which over TCP, coloured by p95 tcp_rtt and duplicate-ACK share — the segment-level view for spotting a congested path. Hover a line or node for its figures.',
}

/**
 * The tab: the destinations graph by default, and three alternative dependency
 * views. Only the view on screen is mounted, so only its searches run.
 */
export function FlowMap() {
  const [view, setView] = useState<FlowView>('destinations')
  const switcher = (
    <div className="pivot-toggle" role="group" aria-label="Flow map view">
      {VIEWS.map((v) => (
        <button key={v.key} type="button" aria-pressed={view === v.key} className={`seg ${view === v.key ? 'seg-active' : ''}`} onClick={() => setView(v.key)}>{v.label}</button>
      ))}
    </div>
  )
  if (view === 'destinations') return <DestinationsMap switcher={switcher} />
  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Flow map</h2>
        {switcher}
        <p className="tab-sub">{DEP_INTRO[view]}</p>
      </div>
      <Suspense fallback={<TabLoading />}>
        <DependencyView key={view} view={view} />
      </Suspense>
    </div>
  )
}

function DestinationsMap({ switcher }: { switcher: ReactNode }) {
  const [sel, setSel] = useState<string | null>(null)
  const [snOpen, setSnOpen] = useState(false)

  // Two scans behind the graph: the twelve busiest destination IPs with their
  // health figures, and the busiest source IP → destination IP pairs. This tab is the
  // default route, so both are hourly snapshots (gno_svc_nodes_c1h,
  // gno_svc_edges_c1h) as well as live queries.
  const nodesQ = useSearch(nodesQuery, { accel: 'gno_svc_nodes_c1h', accelPanel: 'flow-map-nodes' })
  const graphQ = useSearch(pairsQuery, { accel: 'gno_svc_edges_c1h', accelPanel: 'flow-map-edges' })

  const { nodes, edges, extEdges, extTotal, destCount, clientCount } = useMemo(() => {
    const dests = nodesQ.rows.map((r) => {
      const flows = toNum(r.flows), dupN = toNum(r.dupack_n)
      const ip = str(r, 'dst_ip'), host = str(r, 'host')
      return { id: ip, label: host || ip, flows, netMs: toNum(r.net) * 1000, netN: toNum(r.net_n), dupN, dupRate: dupN > 0 ? toNum(r.dupack_flows) / dupN : 0 }
    }).filter((n) => n.id)
    const destIds = new Set(dests.map((n) => n.id))

    const pairs = graphQ.rows
      .map((r) => ({ s: str(r, 'src_ip'), d: str(r, 'dst_ip'), flows: toNum(r.flows) }))
      .filter((p) => p.s && p.d)
    const outBySource = new Map<string, number>()
    for (const p of pairs) outBySource.set(p.s, (outBySource.get(p.s) ?? 0) + p.flows)
    // Sources that are not drawn destinations, which a destination-grouped
    // query alone would never show.
    const clients = [...outBySource.entries()]
      .filter(([id]) => !destIds.has(id))
      .sort((x, y) => y[1] - x[1])
      .slice(0, TOP_CLIENTS)

    const all = [
      ...dests.map((n) => ({ ...n, client: false })),
      ...clients.map(([id, flows]) => ({ id, label: id, flows, netMs: 0, netN: 0, dupN: 0, dupRate: 0, client: true })),
    ]
    const maxFlows = all.reduce((m, n) => Math.max(m, n.flows), 1)
    const cx = 500, cy = 180, RX = 380, RY = 130
    const placed: Node[] = all.map((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(all.length, 1) - Math.PI / 2
      const health: Health = n.client ? 'unknown' : healthOf(n)
      return {
        ...n, health, status: n.client ? 'client only' : statusOf(n),
        r: 9 + 9 * Math.sqrt(n.flows / maxFlows), x: cx + RX * Math.cos(angle), y: cy + RY * Math.sin(angle),
      }
    })
    const pos = new Map(placed.map((n) => [n.id, n]))

    const edges = pairs
      .filter((p) => p.s !== p.d && pos.has(p.s) && destIds.has(p.d))
      .sort((x, y) => y.flows - x.flows)
      .slice(0, TOP_EDGES)
      .map((e) => { const a = pos.get(e.s)!, b = pos.get(e.d)!; return { ...e, a, b, health: worse(a.health, b.health) } })

    // Each drawn source's flows to destinations the map does not draw.
    const toDrawn = new Map<string, number>()
    for (const p of pairs) if (pos.has(p.s) && destIds.has(p.d)) toDrawn.set(p.s, (toDrawn.get(p.s) ?? 0) + p.flows)
    const extEdges = placed
      .map((n) => ({ a: n, flows: (outBySource.get(n.id) ?? 0) - (toDrawn.get(n.id) ?? 0) }))
      .filter((e) => e.flows > 0)
    const extTotal = extEdges.reduce((t, e) => t + e.flows, 0)
    return { nodes: placed, edges, extEdges, extTotal, destCount: dests.length, clientCount: clients.length }
  }, [nodesQ.rows, graphQ.rows])

  const external = { x: 500, y: 180, r: 13, label: 'Other destinations' }
  const maxEdge = edges.reduce((m, e) => Math.max(m, e.flows), 1)
  const maxExt = extEdges.reduce((m, e) => Math.max(m, e.flows), 1)
  const breachingCount = nodes.filter((n) => !n.client && n.health === 'danger').length
  const elevatedCount = nodes.filter((n) => !n.client && n.health === 'warning').length
  const selNode = nodes.find((n) => n.id === sel)

  // Two searches, one card. Merged to the worse of the two: a graph drawn half
  // from 04:20 and half from now would look completely normal, and is the one
  // thing a timeline must never produce.
  const graphSnapshot = mergeSnapshotStates([
    { source: nodesQ.source, outcome: nodesQ.outcome, at: nodesQ.at, stale: nodesQ.stale, nearestAt: nodesQ.nearestAt },
    { source: graphQ.source, outcome: graphQ.outcome, at: graphQ.at, stale: graphQ.stale, nearestAt: graphQ.nearestAt },
  ])

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Flow map</h2>
        {switcher}
        <p className="tab-sub">
          Which hosts talk to which destinations, from flow metadata — no sidecar, no eBPF.{' '}
          <strong className="d-danger">Pulsing red</strong> = breaching destination (p95 tcp_rtt over {fmtMs(GRAPH_RTT_SLO * 3)}, or
          {' '}{Math.round(DUPACK_DANGER * 100)}%+ of flows with duplicate ACKs) → click it to drill the latency domains;{' '}
          <strong className="d-warn">amber</strong> = over {fmtMs(GRAPH_RTT_SLO)} or {Math.round(DUPACK_WARN * 100)}%+ dup-ACK,{' '}
          <span className="d-grey">grey</span> = no latency data. Sized by flow volume.{' '}
          <strong>{breachingCount} destination{breachingCount === 1 ? '' : 's'} breaching</strong>
          {elevatedCount > 0 ? `, ${elevatedCount} elevated` : ''}. Dashed spokes aggregate traffic to destinations the map does not draw.
        </p>
      </div>

      <Panel snapshot={graphSnapshot} tourId="service-graph" onRefresh={() => { nodesQ.refetch(); graphQ.refetch() }} refreshing={nodesQ.loading || graphQ.loading} title="Dependency graph" info={`Nodes are the twelve busiest destination IPs (dst_ip), named by an http_host seen on their flows where there is one, plus up to ${TOP_CLIENTS} busy source IPs that are not among them ('client only'). Each node is coloured by p95 tcp_rtt (amber over ${GRAPH_RTT_SLO} ms, red over ${GRAPH_RTT_SLO * 3} ms) and by the share of its flows carrying duplicate ACKs (amber at ${Math.round(DUPACK_WARN * 100)}%, red at ${Math.round(DUPACK_DANGER * 100)}%); a destination with no tcp_dup_ack values is judged on latency alone. Solid lines are the top ${TOP_EDGES} source → destination pairs between drawn nodes, width by flow count and coloured by the worse endpoint. Dashed spokes carry each drawn node's remaining flows to destinations not drawn. Pairs, totals and spokes are computed over the 1,000 busiest source → destination pairs. The ⓘ query is the node query; the pair query is shown in the Searches list.`} query={nodesQuery} note={`${destCount} destinations · ${clientCount} clients · ${edges.length} edges${extEdges.length ? ` · ${extEdges.length} to other` : ''}`}>
        <QueryBoundary state={nodesQ} emptyLabel="No flows in this window">
          <div className="svc-graph-wrap">
            <svg viewBox="0 0 1000 360" className="svc-graph" role="img">
              {extEdges.map((e, i) => (
                <line key={`ext-${i}`} className="svc-ext-edge" x1={e.a.x} y1={e.a.y} x2={external.x} y2={external.y}
                  strokeWidth={1 + (e.flows / maxExt) * 3}>
                  <title>{`${e.a.label} → other destinations — ${fmtCount(e.flows)} flows`}</title>
                </line>
              ))}
              {extEdges.length > 0 && (
                <g className="svc-ext-node" transform={`translate(${external.x},${external.y})`}>
                  <title>{`Destinations the map does not draw — ${fmtCount(extTotal)} flows aggregated`}</title>
                  <circle r={external.r} />
                  <text y={external.r + 15} textAnchor="middle" className="svc-ext-label">{external.label}</text>
                </g>
              )}
              {edges.map((e, i) => (
                <line key={i} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke={HEALTH_COLOR[e.health]}
                  opacity={e.health === 'success' || e.health === 'unknown' ? 0.28 : 0.7} strokeWidth={1 + (e.flows / maxEdge) * 4}>
                  <title>{`${e.a.label} → ${e.b.label} — ${fmtCount(e.flows)} flows`}</title>
                </line>
              ))}
              {nodes.map((n) => (
                n.client ? (
                  <g key={n.id} className="svc-node svc-node-source" transform={`translate(${n.x},${n.y})`}>
                    <title>{`${n.label} — client only · ${fmtCount(n.flows)} flows out`}</title>
                    <circle r={n.r} fill={HEALTH_COLOR.unknown} />
                    <text y={-(n.r + 8)} textAnchor="middle" className="svc-label">{n.label}</text>
                    <text y={n.r + 17} textAnchor="middle" className="svc-status svc-status-unknown">{n.status}</text>
                  </g>
                ) : (
                <g key={n.id} className="svc-node" onClick={() => setSel(n.id)} transform={`translate(${n.x},${n.y})`}
                  tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && setSel(n.id)}>
                  <title>{`${n.label}${n.label !== n.id ? ` (${n.id})` : ''} — tcp_rtt p95 ${n.netN > 0 ? fmtMs(n.netMs) : 'no data'} · dup-ACK ${n.dupN > 0 ? `${(n.dupRate * 100).toFixed(0)}% of ${fmtCount(n.dupN)}` : 'no data'} · ${fmtCount(n.flows)} flows`}</title>
                  {n.health === 'danger' && (
                    <>
                      <circle className="svc-pulse-ring" r={n.r} fill={HEALTH_COLOR.danger} />
                      <circle className="svc-pulse-ring svc-pulse-ring-2" r={n.r} fill={HEALTH_COLOR.danger} />
                    </>
                  )}
                  <circle r={n.r + (sel === n.id ? 4 : 0)} fill={HEALTH_COLOR[n.health]} stroke={sel === n.id ? '#fff' : 'transparent'} strokeWidth={2} />
                  <text y={-(n.r + 8)} textAnchor="middle" className="svc-label">{n.label}</text>
                  <text y={n.r + 17} textAnchor="middle" className={`svc-status svc-status-${n.health}`}>{n.status}</text>
                </g>
                )
              ))}
            </svg>
            <div className="svc-legend">
              <span><span className="dot dot-success" /> healthy</span>
              <span><span className="dot dot-warning" /> elevated (rtt &gt; {GRAPH_RTT_SLO} ms or dup-ACK ≥ {Math.round(DUPACK_WARN * 100)}%)</span>
              <span><span className="dot dot-danger dot-pulse" /> breaching · pulsing (rtt &gt; {GRAPH_RTT_SLO * 3} ms or dup-ACK ≥ {Math.round(DUPACK_DANGER * 100)}%)</span>
              <span><span className="dot dot-unknown" /> no latency data / client only</span>
              <span><span className="dash-line" /> traffic to destinations not drawn</span>
            </div>
          </div>
        </QueryBoundary>
      </Panel>

      {sel ? (
        <LatencyDomains service={sel} label={selNode?.label ?? sel} onIncident={() => setSnOpen(true)} onBack={() => setSel(null)} />
      ) : (
        <p className="svc-hint">Select a destination above to see its latency domains and packet-evidence triage.</p>
      )}

      {/* Mounted for as long as a service is selected, and opened by `isOpen`
          rather than by being mounted. Capra's Modal releases the page scroll
          lock and the `inert` it puts on #root when it CLOSES; unmounting it
          while it is still open would skip that and leave the app behind it
          unscrollable. Same shape as <ConfirmDialog> in OnboardingPanel. */}
      {sel && <ServiceNowModal isOpen={snOpen} service={sel} onClose={() => setSnOpen(false)} />}
    </div>
  )
}

function LatencyDomains({ service, label: name, onIncident, onBack }: { service: string; label: string; onIncident: () => void; onBack: () => void }) {
  const domainsQuery = buildDomainsQuery(service)
  const domains = useSearch(domainsQuery, { deps: [service] })
  // The four domain cards answer the question this view was opened to ask; the
  // decomposition chart under them is the follow-up, so it waits its turn
  // rather than sharing the admission queue with them.
  const trendNear = useNearViewport()
  const trendQuery = buildTrendQuery(service)
  const trend = useSearch(trendQuery, { deps: [service], deferred: !trendNear.near })

  const d = domains.rows[0] ?? {}
  const netMs = toNum(d.net) * 1000
  const appMs = toNum(d.app) * 1000
  const dnsMs = toNum(d.dns) * 1000
  const srvMs = toNum(d.srv) // http_rtt seconds × 1000 in the query
  const srvN = toNum(d.srvn)
  const dupack = toNum(d.dupack)
  const crc = toNum(d.crc)
  const resets = toNum(d.reset)
  const label = name !== service ? `${name} (${service})` : service

  const netClean = dupack === 0 && crc === 0 && resets === 0

  // Which domain owns the time? (ratio vs its own SLO)
  const DOMAINS = [
    { key: 'APPLICATION', field: 'tcp_rtt_app', ms: appMs, slo: SLO.application, ratio: appMs / SLO.application, phrase: 'slow app response', owner: 'the app team' },
    { key: 'NETWORK', field: 'tcp_rtt', ms: netMs, slo: SLO.network, ratio: netMs / SLO.network, phrase: 'network latency', owner: 'NetOps' },
    { key: 'DNS', field: 'dns_response_time', ms: dnsMs, slo: SLO.dns, ratio: dnsMs / SLO.dns, phrase: 'slow name resolution', owner: 'the DNS / platform team' },
    ...(srvN > 0 ? [{ key: 'HTTP RTT', field: 'http_rtt', ms: srvMs, slo: SLO.server, ratio: srvMs / SLO.server, phrase: 'slow HTTP response', owner: 'the service owner' }] : []),
  ]
  const worstD = DOMAINS.reduce((a, b) => (b.ratio > a.ratio ? b : a))
  const worst = worstD.key

  // Narrative verdict (mirrors the reference "NetOps is exonerated" storytelling).
  const evidenceSummary = `retransmits ${fmtCount(dupack)} · resets ${fmtCount(resets)} · wire-errors ${fmtCount(crc)}`
  const narrative = netClean && worst !== 'NETWORK'
    ? `NetOps is exonerated — in four clicks. tcp_rtt = ${fmtMs(netMs)}; retransmits, resets and dup-acks are all clean — the network delivered the packets. The ${fmtMs(worstD.ms)} lived in ${worstD.field} (${worst.toLowerCase()} latency) on ${label} — owned by ${worstD.owner}. No war room, no packet capture, no probe.`
    : worst === 'NETWORK'
      ? `Network is implicated: tcp_rtt p95 = ${fmtMs(netMs)} (${worstD.ratio.toFixed(1)}× SLO) with ${evidenceSummary}. Inspect the path before routing to the app team.`
      : `${worst} owns the time (${fmtMs(worstD.ms)}, ${worstD.ratio.toFixed(1)}× SLO), but packet health shows ${evidenceSummary} — clear the wire errors, then route to ${worstD.owner}.`

  const identityReads = 'the selected destination'
  interface TriRow { rec: string; field: string; value: string; domain: string; dcls: string; reads: string; rcls: string }
  const rows: TriRow[] = [
    { rec: 'identity', field: 'dst_ip', value: label, domain: '—', dcls: 'd-none', reads: identityReads, rcls: 'tri-dim' },
    { rec: 'domain', field: 'tcp_rtt_app', value: fmtMs(appMs), domain: 'application', dcls: 'd-app', reads: appMs > SLO.application ? 'breaching · this is the cause' : 'within SLO', rcls: appMs > SLO.application ? 'tri-bad' : 'tri-ok' },
    { rec: 'domain', field: 'tcp_rtt', value: fmtMs(netMs), domain: 'network', dcls: 'd-net', reads: netMs > SLO.network ? 'network slow' : 'within SLO', rcls: netMs > SLO.network ? 'tri-bad' : 'tri-ok' },
    { rec: 'domain', field: 'http_rtt', value: srvN > 0 ? fmtMs(srvMs) : '—', domain: 'http response', dcls: 'd-srv', reads: srvN === 0 ? 'no HTTP RTT' : srvMs > SLO.server ? 'HTTP slow' : 'HTTP fine', rcls: srvN === 0 ? 'tri-warn' : srvMs > SLO.server ? 'tri-bad' : 'tri-ok' },
    { rec: 'domain', field: 'dns_response_time', value: fmtMs(dnsMs), domain: 'DNS', dcls: 'd-dns', reads: dnsMs > SLO.dns ? 'DNS slow' : 'DNS fine', rcls: dnsMs > SLO.dns ? 'tri-bad' : 'tri-ok' },
    { rec: 'evidence', field: 'tcp_dup_ack', value: fmtCount(dupack), domain: 'network health', dcls: 'd-net', reads: dupack === 0 ? 'clean' : 'retransmits', rcls: dupack === 0 ? 'tri-ok' : 'tri-warn' },
    { rec: 'evidence', field: 'tcp_reset', value: fmtCount(resets), domain: 'network health', dcls: 'd-net', reads: resets === 0 ? 'clean' : 'RST seen', rcls: resets === 0 ? 'tri-ok' : 'tri-warn' },
    { rec: 'evidence', field: 'tcp_wrong_crc', value: fmtCount(crc), domain: 'network health', dcls: 'd-net', reads: crc === 0 ? 'clean' : 'wire errors', rcls: crc === 0 ? 'tri-ok' : 'tri-warn' },
  ]

  const DomainCard = ({ name, ms, slo, field, na }: { name: string; ms: number; slo: number; field: string; na?: boolean }) => {
    if (na) {
      return (
        <div className="domain domain-na">
          <div className="kpi-label">{name}<InfoTip text="No flow to this destination carries a numeric http_rtt in the window, so HTTP response RTT can't be computed here." /></div>
          <div className="kpi-value">n/a</div>
          <span className="pill pill-neutral">no HTTP RTT</span>
          <div className="kpi-sub">http_rtt · SLO {slo}ms</div>
        </div>
      )
    }
    const breaching = ms > slo
    const ratio = ms / slo
    return (
      <div className={`domain ${breaching ? 'domain-bad' : 'domain-ok'}`}>
        <div className="kpi-label">{name}</div>
        <div className="kpi-value">{fmtMs(ms)}</div>
        <span className={`pill pill-${breaching ? 'danger' : 'success'}`}>{breaching ? 'Breaching' : 'Healthy'}</span>
        <div className="kpi-sub">{field} · SLO {slo}ms · {breaching ? `${ratio.toFixed(1)}× over` : 'within normal'}</div>
      </div>
    )
  }

  const latSeries: Series[] = [
    { name: 'network', color: '#4dabf7', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.net) * 1000 })) },
    { name: 'application', color: '#ffa94d', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.app) * 1000 })) },
    { name: 'http rtt', color: '#f783ac', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.srv) })) },
    { name: 'dns', color: '#63e6be', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.dns) * 1000 })) },
  ]

  return (
    <>
      <div className="domain-head">
        <button type="button" className="btn" onClick={onBack}>← flow map</button>
        <h3 className="panel-title">{label} — four latency domains<InfoTip text="Each domain is scored independently at p95 against its own SLO — never averaged — so you can see exactly where the time goes." /></h3>
        <button type="button" className="btn btn-primary" onClick={onIncident}>Create ServiceNow incident</button>
      </div>

      <QueryBoundary state={domains} emptyLabel="No flows to this destination in the window">
        <div className="domain-row">
          <DomainCard name="NETWORK" ms={netMs} slo={SLO.network} field="tcp_rtt" />
          <DomainCard name="APPLICATION" ms={appMs} slo={SLO.application} field="tcp_rtt_app" />
          <DomainCard name="HTTP RTT" ms={srvMs} slo={SLO.server} field="http_rtt" na={srvN === 0} />
          <DomainCard name="DNS" ms={dnsMs} slo={SLO.dns} field="dns_response_time" />
        </div>

        <div className="grid-2">
          <Panel anchorRef={trendNear.ref} onRefresh={trend.refetch} refreshing={trend.loading} title="Latency decomposition over time" info="p95 of all four domains per minute on a log axis, so a 0.1ms and a 600ms domain are both visible." query={trendQuery} note="all four domains · p95 · per 1m · log ms">
            <QueryBoundary state={trend} emptyLabel="No data" compact>
              <TimeChart series={latSeries} fmt={fmtMs} log />
            </QueryBoundary>
          </Panel>

          <Panel onRefresh={domains.refetch} refreshing={domains.loading} title={`Triage · ${label} — where is the time, and is it the network?`} info="id-join + packet evidence: p95 across all flows to this destination IP, joined per id and scored by domain (tcp_rtt_app vs tcp_rtt vs http_rtt vs dns_response_time; http_rtt is converted from seconds to milliseconds and does not isolate server processing time from network latency), plus packet-health counters that exonerate or implicate the network." query={domainsQuery} note="id-join + packet evidence">
            <div className="triage-scope">SCOPE <code>{label}</code> · p95 across all flows · joined per id, scored by domain</div>
            <div className="triage-wrap">
              <table className="dtable dtable-mono">
                <caption className="sr-only">
                  Triage evidence for {label}: one row per AMI record, with the key field, its p95 value,
                  the domain it belongs to and what that reads as, followed by the verdict.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">AMI record</th>
                    <th scope="col">Key field</th>
                    <th scope="col">Value</th>
                    <th scope="col">Domain</th>
                    <th scope="col">Reads as</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={`tri-rec-${r.rec}`}>
                      {/* The record kind names the row for a reader moving cell
                          by cell — "evidence · Value · 12 ms" rather than a
                          measurement with nothing attached to it. */}
                      <th scope="row" className="dtable-id tri-rec">{r.rec}</th>
                      <td className="tri-field">{r.field}</td>
                      <td className="tri-val dtable-num">{r.value}</td>
                      <td className={`tri-domain ${r.dcls}`}>{r.domain}</td>
                      <td className={r.rcls}>{r.reads}</td>
                    </tr>
                  ))}
                  <tr className="tri-verdict-row">
                    <th scope="row" className="dtable-id tri-rec">verdict</th>
                    <td colSpan={4} className="tri-verdict-cell">{worst} — {worstD.phrase}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className={`exon ${netClean && worst !== 'NETWORK' ? 'exon-ok' : 'exon-warn'}`}>
              <span className="exon-icon">{netClean && worst !== 'NETWORK' ? '✓' : '!'}</span>
              <span className="exon-text">{narrative}</span>
            </div>
          </Panel>
        </div>
      </QueryBoundary>
    </>
  )
}
