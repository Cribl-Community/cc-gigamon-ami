import { useMemo, useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { useNearViewport } from '../components/nearViewport'
import { nodesQuery, buildDomainsQuery, buildTrendQuery } from '../queries/flowMap'
import { SERVICE_EDGES_SNAPSHOT_QUERY } from '../queries/snapshots'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { mergeSnapshotStates } from '../components/snapshotCensus'
import { TimeChart, type Series } from '../components/TimeChart'
import { InfoTip } from '../components/InfoTip'
import { ServiceNowModal } from '../components/ServiceNowModal'
import { toNum, str, fmtMs, fmtCount } from '../lib/format'

// Per-domain SLOs (ms) — the server path is allowed more headroom, like the reference.
const SLO = { network: 100, application: 100, server: 200, dns: 100 }

const cleanName = (n: string) =>
  n.replace(/^donot_delete_/i, '').replace(/_GEM$/i, '').replace(/_6_13$/i, '').replace(/_/g, ' ').trim() || n

type Health = 'success' | 'warning' | 'danger' | 'unknown'
function healthOf(appMs: number, appN: number, resets: number, flows: number, dnsMs: number, dnsN: number): Health {
  const resetRate = flows > 0 ? resets / flows : 0
  if (appN > 0 && appMs > SLO.application * 3) return 'danger'
  if (resetRate >= 0.9) return 'danger'
  if (appN > 0 && appMs > SLO.application) return 'warning'
  if (dnsN > 0 && dnsMs > SLO.dns) return 'warning' // DNS elevated
  if (resetRate >= 0.4) return 'warning'
  if (appN === 0 && dnsN === 0) return 'unknown'
  return 'success'
}
const HEALTH_COLOR: Record<Health, string> = { success: '#37b24d', warning: '#f59f00', danger: '#f03e3e', unknown: '#5c6773' }
/** Hub aggregating peers that carry no AWS name tag (external / untagged). */
const EXTERNAL_ID = '__external__'
const SEVERITY: Record<Health, number> = { unknown: 0, success: 1, warning: 2, danger: 3 }

interface Node { id: string; label: string; flows: number; appMs: number; appN: number; dnsMs: number; dnsN: number; resets: number; resetRate: number; health: Health; status: string; r: number; x: number; y: number; srcOnly?: boolean }

function statusOf(n: { appN: number; appMs: number; dnsN: number; dnsMs: number; resetRate: number }): string {
  if (n.appN > 0 && n.appMs > SLO.application * 3) return `app ${fmtMs(n.appMs)} · breaching`
  if (n.resetRate >= 0.9) return `${Math.round(n.resetRate * 100)}% resets`
  if (n.appN > 0 && n.appMs > SLO.application) return `app ${fmtMs(n.appMs)} · elevated`
  if (n.dnsN > 0 && n.dnsMs > SLO.dns) return 'DNS elevated'
  if (n.resetRate >= 0.4) return `${Math.round(n.resetRate * 100)}% resets`
  if (n.appN === 0 && n.dnsN === 0) return 'no latency data'
  return 'healthy'
}

export function FlowMap() {
  const [sel, setSel] = useState<string | null>(null)
  const [snOpen, setSnOpen] = useState(false)

  // TWO SCANS BEHIND THE GRAPH, AND IT USED TO BE THREE. This tab is the default
  // route, so these are what "opening the app in the morning" costs — and with
  // twenty-four retained runs they are also what lets the map show 04:20 rather
  // than only the last fifteen minutes.
  //
  // The edges and the per-source outbound totals were two hooks naming two
  // panels of the SAME entry, which meant two `$vt_results` jobs for one stored
  // result: read.ts submits one per served panel, and its memo caches the read
  // key rather than the rows. They are one hook now, over the un-tailed body,
  // and the two views are cut out of it below. Nothing new is scanned — in Live
  // mode this submits the union body once where it used to submit two narrower
  // queries, and in Snapshot mode it reads one stored result instead of two.
  const nodesQ = useSearch(nodesQuery, { accel: 'gno_svc_nodes_c1h', accelPanel: 'flow-map-nodes' })
  const graphQ = useSearch(SERVICE_EDGES_SNAPSHOT_QUERY, { accel: 'gno_svc_edges_c1h', accelPanel: 'flow-map-edges' })

  const { nodes, edges, extEdges, external, extTotal } = useMemo(() => {
    const raw = nodesQ.rows.map((r) => {
      const flows = toNum(r.flows), resets = toNum(r.resets)
      return { id: str(r, 'dst_aws_flat_tags_name'), flows, appMs: toNum(r.app) * 1000, appN: toNum(r.app_n), dnsMs: toNum(r.dns) * 1000, dnsN: toNum(r.dns_n), resets, resetRate: flows > 0 ? resets / flows : 0, srcOnly: false }
    }).filter((n) => n.id)

    // ONE READ, THREE DERIVATIONS. `graphQ` holds the un-tailed grouping: a row
    // per (source service, destination service), with flows to peers carrying no
    // AWS name tag kept as an empty-string sentinel group rather than dropped
    // (src/queries/snapshots.ts says why that sentinel has to exist). The drawn
    // edges, the per-source outbound totals and the external spokes are all
    // arithmetic over these rows.
    const pairs = graphQ.rows
      .map((r) => ({ s: str(r, 'src_aws_flat_tags_name'), d: str(r, 'dst_svc'), flows: toNum(r.flows) }))
      .filter((p) => p.s)

    // Outbound flow count per source service, summed across EVERY destination
    // group INCLUDING the sentinel — which is exactly what the `count() by src`
    // query this replaces did. Top 20, the limit that query carried, kept so the
    // set of client-only nodes below does not silently widen.
    const totalOut = new Map<string, number>()
    for (const p of pairs) totalOut.set(p.s, (totalOut.get(p.s) ?? 0) + p.flows)
    const outByService = new Map([...totalOut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))

    // A service that only ORIGINATES traffic never appears in the destination-
    // grouped node query — add it so client-only workloads aren't invisible.
    const dstIds = new Set(raw.map((n) => n.id))
    const srcOnly = [...outByService.entries()]
      .filter(([id]) => !dstIds.has(id))
      .map(([id, out]) => ({ id, flows: out, appMs: 0, appN: 0, dnsMs: 0, dnsN: 0, resets: 0, resetRate: 0, srcOnly: true }))

    const allRaw = [...raw, ...srcOnly]
    const maxFlows = allRaw.reduce((m, n) => Math.max(m, n.flows), 1)
    // Ellipse, not a circle: the panel is ~2.8:1, so spreading nodes wider than
    // tall uses the available width and keeps neighbouring labels from colliding.
    const cx = 500, cy = 180, RX = 380, RY = 130
    const nodes: Node[] = allRaw.map((n, i) => {
      const a = (2 * Math.PI * i) / allRaw.length - Math.PI / 2
      const health = healthOf(n.appMs, n.appN, n.resets, n.flows, n.dnsMs, n.dnsN)
      return { ...n, label: cleanName(n.id), health, status: n.srcOnly ? 'client only' : statusOf(n), r: 9 + 9 * Math.sqrt(n.flows / maxFlows), x: cx + RX * Math.cos(a), y: cy + RY * Math.sin(a) }
    })
    const pos = new Map(nodes.map((n) => [n.id, n]))
    // The drawn edges: tagged destinations only, top 40 by flows. That is the
    // `| where dst_svc != "" | sort by flows desc | limit 40` the manifest used
    // to apply server-side, moved here so one read feeds both views. The order
    // matters: the limit was always applied before the drawability filter below,
    // and narrowing it first would change which edges survive.
    const edges = pairs
      .filter((p) => p.d)
      .sort((a, b) => b.flows - a.flows)
      .slice(0, 40)
      .filter((e) => pos.has(e.s) && pos.has(e.d) && e.s !== e.d)
      .map((e) => { const a = pos.get(e.s)!, b = pos.get(e.d)!; return { ...e, a, b, health: SEVERITY[a.health] >= SEVERITY[b.health] ? a.health : b.health } })

    // Only ~12 hosts in this feed carry an AWS name tag, so most flows have a
    // peer we can't name. Aggregate each service's traffic to those unnamed
    // peers (total outbound − outbound to named services) into one hub.
    // Sum from the UNFILTERED rows: traffic to any named peer counts as named,
    // even if that edge was dropped from the drawing (self-loop / outside top-N).
    // Summed over EVERY tagged pair, not only the forty that get drawn — a
    // correction the merged read made possible. This hook used to receive the
    // already-limited top 40, so traffic to a named peer outside that cut
    // counted as unnamed and inflated the external spoke. The comment above has
    // always said that traffic to any named peer counts as named even if the
    // edge was dropped from the drawing; it is now true.
    const namedOut = new Map<string, number>()
    for (const p of pairs) if (p.d) namedOut.set(p.s, (namedOut.get(p.s) ?? 0) + p.flows)
    const external = { id: EXTERNAL_ID, label: 'External / unnamed', x: cx, y: cy, r: 13 }
    const extEdges = nodes
      .map((n) => ({ s: n.id, a: n, flows: Math.max(0, (outByService.get(n.id) ?? 0) - (namedOut.get(n.id) ?? 0)) }))
      .filter((e) => e.flows > 0)
    const extTotal = extEdges.reduce((t, e) => t + e.flows, 0)
    return { nodes, edges, extEdges, external, extTotal }
  }, [nodesQ.rows, graphQ.rows])

  const maxEdge = edges.reduce((m, e) => Math.max(m, e.flows), 1)
  const maxExt = extEdges.reduce((m, e) => Math.max(m, e.flows), 1)
  const breachingCount = nodes.filter((n) => n.health === 'danger').length
  const elevatedCount = nodes.filter((n) => n.health === 'warning').length

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
        <p className="tab-sub">
          Service-to-service dependencies from flow metadata — no sidecar, no eBPF.{' '}
          <strong className="d-danger">Pulsing red</strong> = breaching epicenter (&gt;90% resets or 3× SLO) →
          click to drill the four latency domains; <strong className="d-warn">amber</strong> = latency / reset
          elevated, <span className="d-grey">grey</span> = no latency measured. Sized by flow volume.{' '}
          <strong>{breachingCount} service{breachingCount === 1 ? '' : 's'} breaching</strong>
          {elevatedCount > 0 ? `, ${elevatedCount} elevated` : ''}. Dashed spokes aggregate traffic to peers
          that carry no AWS name tag (external or untagged), since only ~12 hosts in this feed are tagged.
        </p>
      </div>

      <Panel snapshot={graphSnapshot} tourId="service-graph" onRefresh={() => { nodesQ.refetch(); graphQ.refetch() }} refreshing={nodesQ.loading || graphQ.loading} title="Dependency graph" info="Solid edges are src→dst service pairs (both endpoints AWS name-tagged), width by flow count and color by the worse endpoint's health. Only ~12 hosts in this feed carry a name tag, so service↔service edges are limited to those — the dashed grey spokes aggregate each service's remaining traffic to peers we can't name (external or untagged hosts). Nodes include services that only originate traffic ('client only'), which a destination-grouped query alone would miss. Breaching (red) nodes pulse to mark critical epicenters. Note: the reference dashboard flagged TLS-outage epicenters via ssl_alert_level=2, but that field isn't in this AMI feed (0 records) — so red here means latency/reset breaching, not a TLS outage." query={nodesQuery} note={`${nodes.length} services · ${edges.length} edges${extEdges.length ? ` · ${extEdges.length} to unnamed` : ''}`}>
        <QueryBoundary state={nodesQ} emptyLabel="No AWS-enriched flows in this window">
          <div className="svc-graph-wrap">
            <svg viewBox="0 0 1000 360" className="svc-graph" role="img">
              {extEdges.map((e, i) => (
                <line key={`ext-${i}`} className="svc-ext-edge" x1={e.a.x} y1={e.a.y} x2={external.x} y2={external.y}
                  strokeWidth={1 + (e.flows / maxExt) * 3}>
                  <title>{`${e.a.label} → unnamed / external peers — ${fmtCount(e.flows)} flows`}</title>
                </line>
              ))}
              {extEdges.length > 0 && (
                <g className="svc-ext-node" transform={`translate(${external.x},${external.y})`}>
                  <title>{`Peers with no AWS name tag (external or untagged hosts) — ${fmtCount(extTotal)} flows aggregated`}</title>
                  <circle r={external.r} />
                  <text y={external.r + 15} textAnchor="middle" className="svc-ext-label">{external.label}</text>
                </g>
              )}
              {edges.map((e, i) => (
                <line key={i} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke={HEALTH_COLOR[e.health]}
                  opacity={e.health === 'success' || e.health === 'unknown' ? 0.28 : 0.7} strokeWidth={1 + (e.flows / maxEdge) * 4} />
              ))}
              {nodes.map((n) => (
                <g key={n.id} className="svc-node" onClick={() => setSel(n.id)} transform={`translate(${n.x},${n.y})`}
                  tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && setSel(n.id)}>
                  <title>{`${n.label} — app p95 ${n.appN > 0 ? fmtMs(n.appMs) : 'no data'} · resets ${(n.resetRate * 100).toFixed(0)}% of ${fmtCount(n.flows)} flows`}</title>
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
              ))}
            </svg>
            <div className="svc-legend">
              <span><span className="dot dot-success" /> healthy</span>
              <span><span className="dot dot-warning" /> elevated (latency or reset rate)</span>
              <span><span className="dot dot-danger dot-pulse" /> breaching · pulsing (&gt;90% resets or 3× SLO)</span>
              <span><span className="dot dot-unknown" /> no latency data / client only</span>
              <span><span className="dash-line" /> traffic to unnamed / external peers</span>
            </div>
          </div>
        </QueryBoundary>
      </Panel>

      {sel ? (
        <LatencyDomains service={sel} onIncident={() => setSnOpen(true)} onBack={() => setSel(null)} />
      ) : (
        <p className="svc-hint">Select a service above to see its four latency domains and packet-evidence triage.</p>
      )}

      {/* Mounted for as long as a service is selected, and opened by `isOpen`
          rather than by being mounted. Capra's Modal releases the page scroll
          lock and the `inert` it puts on #root when it CLOSES; unmounting it
          while it is still open would skip that and leave the app behind it
          unscrollable. Same shape as <ConfirmDialog> in ProvisionPanel. */}
      {sel && <ServiceNowModal isOpen={snOpen} service={cleanName(sel)} onClose={() => setSnOpen(false)} />}
    </div>
  )
}

function LatencyDomains({ service, onIncident, onBack }: { service: string; onIncident: () => void; onBack: () => void }) {
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
  const srvMs = toNum(d.srv) // already ms
  const srvN = toNum(d.srvn)
  const dupack = toNum(d.dupack)
  const crc = toNum(d.crc)
  const resets = toNum(d.reset)
  const label = cleanName(service)

  const netClean = dupack === 0 && crc === 0 && resets === 0

  // Which domain owns the time? (ratio vs its own SLO)
  const DOMAINS = [
    { key: 'APPLICATION', field: 'tcp_rtt_app', ms: appMs, slo: SLO.application, ratio: appMs / SLO.application, phrase: 'slow app response', owner: 'the app team' },
    { key: 'NETWORK', field: 'tcp_rtt', ms: netMs, slo: SLO.network, ratio: netMs / SLO.network, phrase: 'network latency', owner: 'NetOps' },
    { key: 'DNS', field: 'dns_response_time', ms: dnsMs, slo: SLO.dns, ratio: dnsMs / SLO.dns, phrase: 'slow name resolution', owner: 'the DNS / platform team' },
    ...(srvN > 0 ? [{ key: 'SERVER', field: 'http_server_ms', ms: srvMs, slo: SLO.server, ratio: srvMs / SLO.server, phrase: 'slow server response', owner: 'the service owner' }] : []),
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

  const identityReads = worst === 'APPLICATION' ? 'the breaching service' : 'the scoped service'
  interface TriRow { rec: string; field: string; value: string; domain: string; dcls: string; reads: string; rcls: string }
  const rows: TriRow[] = [
    { rec: 'identity', field: 'dst_aws_flat_tags_name', value: label, domain: '—', dcls: 'd-none', reads: identityReads, rcls: 'tri-dim' },
    { rec: 'domain', field: 'tcp_rtt_app', value: fmtMs(appMs), domain: 'application', dcls: 'd-app', reads: appMs > SLO.application ? 'breaching · this is the cause' : 'within SLO', rcls: appMs > SLO.application ? 'tri-bad' : 'tri-ok' },
    { rec: 'domain', field: 'tcp_rtt', value: fmtMs(netMs), domain: 'network', dcls: 'd-net', reads: netMs > SLO.network ? 'network slow' : 'within SLO', rcls: netMs > SLO.network ? 'tri-bad' : 'tri-ok' },
    { rec: 'domain', field: 'http_server_ms', value: srvN > 0 ? fmtMs(srvMs) : '—', domain: 'server', dcls: 'd-srv', reads: srvN === 0 ? 'no HTTP flows' : srvMs > SLO.server ? 'server slow' : 'server fine', rcls: srvN === 0 ? 'tri-warn' : srvMs > SLO.server ? 'tri-bad' : 'tri-ok' },
    { rec: 'domain', field: 'dns_response_time', value: fmtMs(dnsMs), domain: 'DNS', dcls: 'd-dns', reads: dnsMs > SLO.dns ? 'DNS slow' : 'DNS fine', rcls: dnsMs > SLO.dns ? 'tri-bad' : 'tri-ok' },
    { rec: 'evidence', field: 'tcp_dup_ack', value: fmtCount(dupack), domain: 'network health', dcls: 'd-net', reads: dupack === 0 ? 'clean' : 'retransmits', rcls: dupack === 0 ? 'tri-ok' : 'tri-warn' },
    { rec: 'evidence', field: 'tcp_reset', value: fmtCount(resets), domain: 'network health', dcls: 'd-net', reads: resets === 0 ? 'clean' : 'RST seen', rcls: resets === 0 ? 'tri-ok' : 'tri-warn' },
    { rec: 'evidence', field: 'tcp_wrong_crc', value: fmtCount(crc), domain: 'network health', dcls: 'd-net', reads: crc === 0 ? 'clean' : 'wire errors', rcls: crc === 0 ? 'tri-ok' : 'tri-warn' },
  ]

  const DomainCard = ({ name, ms, slo, field, na }: { name: string; ms: number; slo: number; field: string; na?: boolean }) => {
    if (na) {
      return (
        <div className="domain domain-na">
          <div className="kpi-label">{name}<InfoTip text="No HTTP request/response timestamps to this service in the window, so server latency can't be computed here." /></div>
          <div className="kpi-value">n/a</div>
          <span className="pill pill-neutral">no HTTP flows</span>
          <div className="kpi-sub">http_server_ms · SLO {slo}ms</div>
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
    { name: 'server', color: '#f783ac', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.srv) })) },
    { name: 'dns', color: '#63e6be', points: trend.rows.map((r) => ({ t: toNum(r.bin_time_1m), v: toNum(r.dns) * 1000 })) },
  ]

  return (
    <>
      <div className="domain-head">
        <button type="button" className="btn" onClick={onBack}>← flow map</button>
        <h3 className="panel-title">{label} — four latency domains<InfoTip text="Each domain is scored independently at p95 against its own SLO — never averaged — so you can see exactly where the time goes." /></h3>
        <button type="button" className="btn btn-primary" onClick={onIncident}>Create ServiceNow incident</button>
      </div>

      <QueryBoundary state={domains} emptyLabel="No flows to this service in the window">
        <div className="domain-row">
          <DomainCard name="NETWORK" ms={netMs} slo={SLO.network} field="tcp_rtt" />
          <DomainCard name="APPLICATION" ms={appMs} slo={SLO.application} field="tcp_rtt_app" />
          <DomainCard name="SERVER" ms={srvMs} slo={SLO.server} field="http_server_ms" na={srvN === 0} />
          <DomainCard name="DNS" ms={dnsMs} slo={SLO.dns} field="dns_response_time" />
        </div>

        <div className="grid-2">
          <Panel anchorRef={trendNear.ref} onRefresh={trend.refetch} refreshing={trend.loading} title="Latency decomposition over time" info="p95 of all four domains per minute on a log axis, so a 0.1ms and a 600ms domain are both visible." query={trendQuery} note="all four domains · p95 · per 1m · log ms">
            <QueryBoundary state={trend} emptyLabel="No data" compact>
              <TimeChart series={latSeries} fmt={fmtMs} log />
            </QueryBoundary>
          </Panel>

          <Panel onRefresh={domains.refetch} refreshing={domains.loading} title={`Triage · ${label} — where is the time, and is it the network?`} info="id-join + packet evidence: p95 across all flows to this service, joined per id and scored by domain (tcp_rtt_app vs tcp_rtt vs http_server_ms vs dns_response_time), plus packet-health counters that exonerate or implicate the network." query={domainsQuery} note="id-join + packet evidence">
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
