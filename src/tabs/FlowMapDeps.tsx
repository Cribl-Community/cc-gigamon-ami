import { useMemo } from 'react'
import { useSearch } from '../cribl/useSearch'
import { DNS_DEPS_QUERY, WEB_DEPS_QUERY, SUBNET_DEPS_QUERY } from '../queries/flowMap'
import { Panel } from '../components/Panel'
import { QueryBoundary } from '../components/QueryBoundary'
import { toNum, str, fmtMs, fmtCount } from '../lib/format'

// The three alternative Flow Map views. Each is ONE live search of pairs
// (client → dependency) carrying their own figures; the dependency nodes are
// sums of those pairs, computed here. They run only while their view is on
// screen, and no schedule serves them.

export type DepView = 'dns' | 'web' | 'subnets'
type Health = 'success' | 'warning' | 'danger' | 'unknown'
type Row = Record<string, unknown>

/** Failure / error share bands — the same 1 % and 5 % the DNS and Web tabs' error tiles use. */
const ERR_WARN = 0.01
const ERR_DANGER = 0.05
/** p95 bands (ms): amber over the target, red over 3×. */
const DNS_P95_MS = 100
const HTTP_P95_MS = 200
const RTT_P95_MS = 200
/** Duplicate-ACK share of flows: amber at 5 %, red at 25 % (as on the destinations graph). */
const DUPACK_WARN = 0.05
const DUPACK_DANGER = 0.25

export const MAX_SOURCES = 10
export const MAX_TARGETS = 12
export const MAX_EDGES = 40

const SEVERITY: Record<Health, number> = { unknown: 0, success: 1, warning: 2, danger: 3 }
const worse = (a: Health, b: Health): Health => (SEVERITY[a] >= SEVERITY[b] ? a : b)
const COLOR: Record<Health, string> = { success: '#37b24d', warning: '#f59f00', danger: '#f03e3e', unknown: '#5c6773' }
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`
const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0)
const band = (v: number, warn: number, danger: number): Health => (v >= danger ? 'danger' : v >= warn ? 'warning' : 'success')

/** One pair, reduced to what the graph needs. `w` is the pair's count. */
interface Pair { s: string; d: string; w: number; row: Row }
/** Sums over every pair into one dependency. */
interface Acc { w: number; a: number; b: number; worstP95: number; p95Seen: boolean }

interface Spec {
  title: string
  unit: string
  sourceLabel: string
  targetLabel: string
  query: string
  info: string
}

/** Per-row arithmetic for a view, kept apart from SPECS so the query freeze reads SPECS as plain data. */
interface Logic {
  pair: (r: Row) => Pair
  /** One pair's health and words. */
  edge: (r: Row) => { health: Health; text: string }
  /** Adds one pair into its dependency's sums. */
  add: (acc: Acc, r: Row) => void
  /** A dependency's health and status line, from its sums. */
  node: (acc: Acc) => { health: Health; status: string; text: string }
}

function p95Health(ms: number, target: number): Health {
  return ms > target * 3 ? 'danger' : ms > target ? 'warning' : 'success'
}

export const SPECS: Record<DepView, Spec> = {
  dns: {
    title: 'DNS dependency map',
    unit: 'queries',
    sourceLabel: 'Clients',
    targetLabel: 'Resolvers',
    query: DNS_DEPS_QUERY,
    info: `Client IPs (left) and the DNS resolvers they query (dns_host, right), from the 500 busiest client → resolver pairs of app_name="dns". A resolver is coloured by its failure share — SERVFAIL (reply code 2) plus NXDOMAIN (3) over all its queries: amber at ${pct(ERR_WARN)}, red at ${pct(ERR_DANGER)}. A line is coloured by the worse of that pair's own failure share and its p95 dns_response_time (amber over ${DNS_P95_MS} ms, red over ${DNS_P95_MS * 3} ms); width is query count. p95 is per pair: a resolver shows the worst of its pairs, not a combined p95.`,
  },
  web: {
    title: 'Web/API dependency map',
    unit: 'requests',
    sourceLabel: 'Clients',
    targetLabel: 'HTTP hosts',
    query: WEB_DEPS_QUERY,
    info: `Client IPs (left) and the HTTP hosts they call (http_host, right), from the 500 busiest client → host pairs. A host is coloured by its error share — responses with http_code ≥ 400 over all its requests: amber at ${pct(ERR_WARN)}, red at ${pct(ERR_DANGER)}. A line is coloured by the worse of that pair's own error share and its p95 http_rtt (amber over ${HTTP_P95_MS} ms, red over ${HTTP_P95_MS * 3} ms); width is request count. p95 is per pair: a host shows the worst of its pairs, not a combined p95.`,
  },
  subnets: {
    title: 'Subnet dependency map',
    unit: 'flows',
    sourceLabel: 'Source /24',
    targetLabel: 'Destination /24',
    query: SUBNET_DEPS_QUERY,
    info: `Source /24 subnets (left) and the destination /24 subnets they reach over TCP (right), from the 500 busiest subnet pairs, derived from src_ip and dst_ip exactly as on the TCP health tab. A destination is coloured by the share of its flows carrying duplicate ACKs (amber at ${pct(DUPACK_WARN)}, red at ${pct(DUPACK_DANGER)}) and by the worst p95 tcp_rtt of its pairs (amber over ${RTT_P95_MS} ms, red over ${RTT_P95_MS * 3} ms). A line is coloured the same way from that pair alone; width is flow count. A pair with no tcp_rtt or tcp_dup_ack values is grey.`,
  },
}

const LOGIC: Record<DepView, Logic> = {
  dns: {
    pair: (r) => ({ s: str(r, 'src_ip'), d: str(r, 'dns_host'), w: toNum(r.total), row: r }),
    edge: (r) => {
      const total = toNum(r.total), fail = share(toNum(r.sf) + toNum(r.nx), total), ms = toNum(r.p95) * 1000
      return { health: worse(band(fail, ERR_WARN, ERR_DANGER), p95Health(ms, DNS_P95_MS)), text: `${pct(fail)} failed · p95 ${fmtMs(ms)}` }
    },
    add: (acc, r) => { acc.a += toNum(r.sf); acc.b += toNum(r.nx); acc.worstP95 = Math.max(acc.worstP95, toNum(r.p95) * 1000); acc.p95Seen = true },
    node: (acc) => {
      const fail = share(acc.a + acc.b, acc.w)
      return { health: band(fail, ERR_WARN, ERR_DANGER), status: `${pct(fail)} failed`, text: `SERVFAIL ${fmtCount(acc.a)} · NXDOMAIN ${fmtCount(acc.b)} of ${fmtCount(acc.w)} queries · worst pair p95 ${fmtMs(acc.worstP95)}` }
    },
  },
  web: {
    pair: (r) => ({ s: str(r, 'src_ip'), d: str(r, 'http_host'), w: toNum(r.n), row: r }),
    edge: (r) => {
      const err = share(toNum(r.err), toNum(r.n))
      const hasP95 = r.p95 !== undefined && r.p95 !== null && r.p95 !== ''
      const ms = toNum(r.p95)
      return { health: hasP95 ? worse(band(err, ERR_WARN, ERR_DANGER), p95Health(ms, HTTP_P95_MS)) : band(err, ERR_WARN, ERR_DANGER), text: `${pct(err)} errors · p95 ${hasP95 ? fmtMs(ms) : 'no http_rtt'}` }
    },
    add: (acc, r) => {
      acc.a += toNum(r.err)
      if (r.p95 !== undefined && r.p95 !== null && r.p95 !== '') { acc.worstP95 = Math.max(acc.worstP95, toNum(r.p95)); acc.p95Seen = true }
    },
    node: (acc) => {
      const err = share(acc.a, acc.w)
      return { health: band(err, ERR_WARN, ERR_DANGER), status: `${pct(err)} errors`, text: `${fmtCount(acc.a)} of ${fmtCount(acc.w)} requests ≥ 400 · worst pair p95 ${acc.p95Seen ? fmtMs(acc.worstP95) : 'no http_rtt'}` }
    },
  },
  subnets: {
    pair: (r) => ({ s: str(r, 'src_subnet'), d: str(r, 'dst_subnet'), w: toNum(r.flows), row: r }),
    edge: (r) => {
      const netN = toNum(r.net_n), dupN = toNum(r.dupack_n), ms = toNum(r.net) * 1000, dup = share(toNum(r.dupack_flows), dupN)
      const h = worse(netN > 0 ? p95Health(ms, RTT_P95_MS) : 'unknown', dupN > 0 ? band(dup, DUPACK_WARN, DUPACK_DANGER) : 'unknown')
      return { health: h, text: `rtt p95 ${netN > 0 ? fmtMs(ms) : 'no data'} · dup-ACK ${dupN > 0 ? pct(dup) : 'no data'}` }
    },
    add: (acc, r) => {
      acc.a += toNum(r.dupack_flows); acc.b += toNum(r.dupack_n)
      if (toNum(r.net_n) > 0) { acc.worstP95 = Math.max(acc.worstP95, toNum(r.net) * 1000); acc.p95Seen = true }
    },
    node: (acc) => {
      const dup = share(acc.a, acc.b)
      const health = worse(acc.p95Seen ? p95Health(acc.worstP95, RTT_P95_MS) : 'unknown', acc.b > 0 ? band(dup, DUPACK_WARN, DUPACK_DANGER) : 'unknown')
      const status = acc.p95Seen ? `rtt ${fmtMs(acc.worstP95)}` : acc.b > 0 ? `${pct(dup)} dup-ACK` : 'no data'
      return { health, status, text: `worst pair rtt p95 ${acc.p95Seen ? fmtMs(acc.worstP95) : 'no data'} · dup-ACK ${acc.b > 0 ? `${pct(dup)} of ${fmtCount(acc.b)}` : 'no data'}` }
    },
  },
}

export interface DepNode { id: string; w: number; health: Health; status: string; text: string; x: number; y: number; r: number }
export interface DepEdge { a: DepNode; b: DepNode; w: number; health: Health; text: string }
export interface DepGraph { sources: DepNode[]; targets: DepNode[]; edges: DepEdge[]; pairCount: number; sourceCount: number; targetCount: number; hiddenW: number; totalW: number }

/**
 * Pure: rows → a two-column graph. Dependency figures are sums over EVERY pair
 * read, not only the drawn ones, so a resolver's failure share is not short
 * because some of its clients are off screen.
 */
export function buildDepGraph(view: DepView, rows: readonly Row[]): DepGraph {
  const logic = LOGIC[view]
  const pairs = rows.map(logic.pair).filter((p) => p.s && p.d && p.w > 0)
  const bySource = new Map<string, number>()
  const byTarget = new Map<string, Acc>()
  for (const p of pairs) {
    bySource.set(p.s, (bySource.get(p.s) ?? 0) + p.w)
    const acc = byTarget.get(p.d) ?? { w: 0, a: 0, b: 0, worstP95: 0, p95Seen: false }
    acc.w += p.w
    logic.add(acc, p.row)
    byTarget.set(p.d, acc)
  }
  const top = <T,>(m: Map<string, T>, w: (v: T) => number, n: number) => [...m.entries()].sort((x, y) => w(y[1]) - w(x[1])).slice(0, n)
  const srcTop = top(bySource, (v) => v, MAX_SOURCES)
  const tgtTop = top(byTarget, (v) => v.w, MAX_TARGETS)
  const maxW = Math.max(1, ...srcTop.map(([, w]) => w), ...tgtTop.map(([, a]) => a.w))
  const radius = (w: number) => 6 + 9 * Math.sqrt(w / maxW)
  const yAt = (i: number, n: number) => 30 + (n <= 1 ? 160 : (i * 320) / (n - 1))

  const sources: DepNode[] = srcTop.map(([id, w], i) => ({ id, w, health: 'unknown', status: `${fmtCount(w)} ${SPECS[view].unit}`, text: '', x: 260, y: yAt(i, srcTop.length), r: radius(w) }))
  const targets: DepNode[] = tgtTop.map(([id, acc], i) => ({ id, w: acc.w, ...logic.node(acc), x: 740, y: yAt(i, tgtTop.length), r: radius(acc.w) }))
  const sPos = new Map(sources.map((n) => [n.id, n]))
  const tPos = new Map(targets.map((n) => [n.id, n]))
  const edges: DepEdge[] = pairs
    .filter((p) => sPos.has(p.s) && tPos.has(p.d))
    .sort((x, y) => y.w - x.w)
    .slice(0, MAX_EDGES)
    .map((p) => ({ a: sPos.get(p.s)!, b: tPos.get(p.d)!, w: p.w, ...logic.edge(p.row) }))
  const totalW = pairs.reduce((t, p) => t + p.w, 0)
  const drawnW = edges.reduce((t, e) => t + e.w, 0)
  return { sources, targets, edges, pairCount: pairs.length, sourceCount: bySource.size, targetCount: byTarget.size, hiddenW: totalW - drawnW, totalW }
}

export function DependencyView({ view }: { view: DepView }) {
  const spec = SPECS[view]
  const q = useSearch(spec.query)
  const g = useMemo(() => buildDepGraph(view, q.rows), [view, q.rows])
  const maxEdge = g.edges.reduce((m, e) => Math.max(m, e.w), 1)
  const breaching = g.targets.filter((n) => n.health === 'danger').length
  const elevated = g.targets.filter((n) => n.health === 'warning').length

  return (
    <Panel title={spec.title} info={spec.info} query={spec.query} onRefresh={q.refetch} refreshing={q.loading}
      note={`${g.sourceCount} ${spec.sourceLabel.toLowerCase()} · ${g.targetCount} ${spec.targetLabel.toLowerCase()} · ${breaching} breaching${elevated ? `, ${elevated} elevated` : ''} · showing top ${g.sources.length} × ${g.targets.length}, ${g.edges.length} lines`}>
      <QueryBoundary state={q} emptyLabel={`No ${spec.unit} in this window`}>
        <div className="svc-graph-wrap">
          <svg viewBox="0 0 1000 380" className="svc-graph" role="img" aria-label={`${spec.title}: ${spec.sourceLabel} to ${spec.targetLabel}`}>
            <text x={260} y={14} textAnchor="middle" className="svc-status svc-status-unknown">{spec.sourceLabel}</text>
            <text x={740} y={14} textAnchor="middle" className="svc-status svc-status-unknown">{spec.targetLabel}</text>
            {g.edges.map((e, i) => (
              <line key={i} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke={COLOR[e.health]}
                opacity={e.health === 'success' || e.health === 'unknown' ? 0.3 : 0.75} strokeWidth={1 + (e.w / maxEdge) * 5}>
                <title>{`${e.a.id} → ${e.b.id} — ${fmtCount(e.w)} ${spec.unit} · ${e.text}`}</title>
              </line>
            ))}
            {g.sources.map((n) => (
              <g key={`s-${n.id}`} className="svc-node svc-node-source" transform={`translate(${n.x},${n.y})`}>
                <title>{`${n.id} — ${n.status}`}</title>
                <circle r={n.r} fill={COLOR.unknown} />
                <text x={-(n.r + 8)} y={4} textAnchor="end" className="svc-label">{n.id}</text>
              </g>
            ))}
            {g.targets.map((n) => (
              <g key={`t-${n.id}`} className="svc-node" transform={`translate(${n.x},${n.y})`}>
                <title>{`${n.id} — ${n.text}`}</title>
                {n.health === 'danger' && <circle className="svc-pulse-ring" r={n.r} fill={COLOR.danger} />}
                <circle r={n.r} fill={COLOR[n.health]} />
                <text x={n.r + 8} y={0} className="svc-label">{n.id}</text>
                <text x={n.r + 8} y={13} className={`svc-status svc-status-${n.health}`}>{n.status}</text>
              </g>
            ))}
          </svg>
          <div className="svc-legend">
            <span><span className="dot dot-success" /> healthy</span>
            <span><span className="dot dot-warning" /> elevated</span>
            <span><span className="dot dot-danger dot-pulse" /> breaching</span>
            <span><span className="dot dot-unknown" /> client / no data</span>
            {g.hiddenW > 0 && <span>{fmtCount(g.hiddenW)} of {fmtCount(g.totalW)} {spec.unit} are in pairs not drawn</span>}
          </div>
        </div>
      </QueryBoundary>
    </Panel>
  )
}
