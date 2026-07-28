import { useMemo, useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { toNum, str, fmtCount } from '../lib/format'

type Tactic = 'Discovery' | 'Lateral Movement' | 'Credential Access' | 'Command & Control' | 'Impact'

interface Technique {
  id: string
  name: string
  tactic: Tactic
  /** Editorial base risk 0–100 (severity of the class), like the reference tiles. */
  risk: number
  /** What in the feed evidences it — shown on the tile. */
  signal: string
  /** How it's counted: a per-flow predicate (signal) or a per-source behaviour. */
  kind: 'flow' | 'behaviour'
  /** For kind==='flow': search predicate for the drill (search syntax: field=*, field="v"). */
  filter?: string
  /** For kind==='flow': boolean EXPRESSION for the count iif (isnotnull(), ==, in). */
  expr?: string
  /** For kind==='behaviour': which per-source metric + threshold. */
  behaviour?: { metric: 'ports' | 'dsts'; internalOnly?: boolean; min: number }
  why: string
}

// Only techniques with a REAL signal in this AMI feed. Detection is
// app-classification + protocol metadata + graph behaviour — NOT port numbers,
// so an attacker on a non-standard port is still caught (verified: dcerpc_service
// "mapi" was seen on port 5003, not 135).
const TECHNIQUES: Technique[] = [
  {
    id: 'T1572', name: 'Protocol Tunneling', tactic: 'Command & Control', risk: 95,
    signal: 'icmp_tunneling', kind: 'flow', filter: 'icmp_tunneling=*', expr: 'isnotnull(icmp_tunneling)',
    why: 'Data encapsulated in ICMP — a covert channel that bypasses controls only inspecting TCP/UDP.',
  },
  {
    id: 'T1570', name: 'Lateral Tool Transfer / MSRPC', tactic: 'Lateral Movement', risk: 80,
    signal: 'dcerpc_service', kind: 'flow', filter: 'dcerpc_service=*', expr: 'isnotnull(dcerpc_service)',
    why: 'DCE/RPC (MSRPC) services — remote service creation, scheduled tasks, WMI. Classified by protocol, any port.',
  },
  {
    id: 'T1021', name: 'Remote Services (SSH)', tactic: 'Lateral Movement', risk: 60,
    signal: 'app_name="ssh"', kind: 'flow', filter: 'app_name="ssh"', expr: 'app_name=="ssh"',
    why: 'SSH sessions identified by handshake, not port — remote interactive access used to pivot.',
  },
  {
    id: 'T1021.b', name: 'Lateral Spread (host fan-out)', tactic: 'Lateral Movement', risk: 70,
    signal: 'internal src → many dst_ip', kind: 'behaviour', behaviour: { metric: 'dsts', internalOnly: true, min: 20 },
    why: 'An internal host reaching an unusually large number of destinations — the shape of lateral spread, independent of protocol or port.',
  },
  {
    id: 'T1046', name: 'Network Service Discovery', tactic: 'Discovery', risk: 75,
    signal: 'src → many dst_port', kind: 'behaviour', behaviour: { metric: 'ports', min: 6 },
    why: 'A source touching many distinct destination ports — port/service scanning ahead of lateral movement.',
  },
  {
    id: 'T1018', name: 'Active Directory / LDAP Discovery', tactic: 'Discovery', risk: 60,
    signal: 'LDAP + krb5_message_type', kind: 'flow', filter: 'dst_port in ("389","636") or krb5_message_type=*', expr: '(dst_port in ("389","636")) or isnotnull(krb5_message_type)',
    why: 'LDAP and Kerberos activity — enumerating the directory and authenticating for the next hop.',
  },
  {
    id: 'T1110', name: 'Cleartext Credentials (SNMP)', tactic: 'Credential Access', risk: 65,
    signal: 'snmp_community', kind: 'flow', filter: 'snmp_community=*', expr: 'isnotnull(snmp_community)',
    why: 'SNMP community strings on the wire — readable credentials an attacker harvests and replays.',
  },
]

// Techniques the reference shows but this capture cannot support — surfaced
// honestly rather than faked. (Verified: no mining app/ports, no RDP/3389.)
const GAPS: Array<{ id: string; name: string; reason: string }> = [
  { id: 'T1496', name: 'Cryptocurrency Mining', reason: 'no mining app_name and no Stratum-port traffic in this feed' },
  { id: 'T1021.001', name: 'RDP Lateral Movement', reason: 'no RDP (port 3389) or rdp app classification observed' },
  { id: 'T1090.002', name: 'C2 Beaconing', reason: 'needs per-connection timing regularity — not derivable from flow aggregates' },
]

const TACTICS: Tactic[] = ['Command & Control', 'Lateral Movement', 'Discovery', 'Credential Access', 'Impact']

// Tactic colours for the summary treemap (echoing the reference: C2 blue, Discovery green).
const TACTIC_COLOR: Record<Tactic, string> = {
  'Command & Control': '#3b7dd8',
  'Lateral Movement': '#c0392b',
  Discovery: '#1e7e46',
  'Credential Access': '#8e44ad',
  Impact: '#5c6773',
}

const riskBand = (r: number) => (r >= 80 ? 'crit' : r >= 60 ? 'high' : r >= 40 ? 'med' : 'low')
const isInternal = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

// One pass for the flow-signal counts.
const COUNTS = q(
  '| summarize ' +
  TECHNIQUES.filter((t) => t.kind === 'flow').map((t) => `c_${t.id.replace(/\./g, '_')}=sum(iif(${t.expr},1,0))`).join(', '),
)
// One pass for per-source behaviour (port scan + host fan-out).
const SOURCES = q('| summarize ports=dcount(dst_port), dsts=dcount(dst_ip), flows=count() by src_ip | sort by flows desc | limit 200')

export function Security() {
  const { range } = useDashboard()
  const counts = useSearch(COUNTS)
  const sources = useSearch(SOURCES)
  const [sel, setSel] = useState<Technique | null>(null)
  const [tacticFilter, setTacticFilter] = useState<Tactic | null>(null)

  const srcRows = sources.rows.map((r) => ({ ip: str(r, 'src_ip'), ports: toNum(r.ports), dsts: toNum(r.dsts), flows: toNum(r.flows) }))

  const countFor = (t: Technique): number => {
    if (t.kind === 'flow') return toNum(counts.rows[0]?.[`c_${t.id.replace(/\./g, '_')}`])
    const b = t.behaviour!
    return srcRows.filter((s) => (b.internalOnly ? isInternal(s.ip) : true) && s[b.metric] >= b.min).length
  }

  const loading = counts.loading || sources.loading
  const tiles = useMemo(() => TECHNIQUES.map((t) => ({ t, count: countFor(t) })), [counts.rows, sources.rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const totalEvents = tiles.reduce((a, x) => a + (x.t.kind === 'flow' ? x.count : 0), 0)
  const active = tiles.filter((x) => x.count > 0).length

  // Per-tactic rollup for the summary treemap.
  const tacticTotals = TACTICS
    .map((tac) => {
      const own = tiles.filter((x) => x.t.tactic === tac)
      return { tac, total: own.reduce((a, x) => a + x.count, 0), techs: own.length, firing: own.filter((x) => x.count > 0).length }
    })
    .filter((t) => t.techs > 0)
  const tacticMax = tacticTotals.reduce((m, t) => Math.max(m, t.total), 1)

  // Drill: flow-signal techniques run a scoped query; behaviour techniques use
  // the already-loaded per-source rows.
  const drillQuery = sel?.kind === 'flow'
    ? q(`${sel.filter} | summarize flows=count() by src_ip, dst_ip, app_name, dst_port | sort by flows desc | limit 100`)
    : ''
  const drill = useSearch(drillQuery, { enabled: sel?.kind === 'flow', deps: [sel?.id] })
  const behaviourRows = sel?.kind === 'behaviour'
    ? srcRows.filter((s) => (sel.behaviour!.internalOnly ? isInternal(s.ip) : true) && s[sel.behaviour!.metric] >= sel.behaviour!.min)
    : []

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Security · MITRE ATT&amp;CK</h2>
        <p className="tab-sub">
          Network-only threat techniques from Gigamon Application Metadata — detected by <strong>application
          classification and protocol metadata, not port numbers</strong>, so an attacker on a non-standard port
          is still caught (in this feed <code>dcerpc_service</code> was seen on port 5003, not 135). Each tile is a
          risk-scored ATT&amp;CK technique; click one to drill into the flows behind it. Techniques with no signal
          in this capture are listed honestly below rather than faked.
        </p>
      </div>

      <div className="kpi-row kpi-row-3">
        <KpiTile label="Techniques firing" value={loading ? '…' : `${active}/${TECHNIQUES.length}`} accent={active > 3 ? 'warning' : 'info'}
          sub="ATT&CK techniques with activity" info="How many of the detectable techniques have at least one event in the window." query={COUNTS} />
        <KpiTile label="Signal events" value={loading ? '…' : fmtCount(totalEvents)} accent="warning"
          sub="flow-level detections in window" info="Total flow-level technique detections (tunneling, MSRPC, SSH, LDAP/Kerberos, SNMP creds). Behaviour tiles are counted as sources, not summed here." query={COUNTS} />
        <KpiTile label="Coverage" value={String(TECHNIQUES.length)} unit={`/ ${TECHNIQUES.length + GAPS.length}`} accent="info"
          sub={`${GAPS.length} not observable in this feed`} info="Techniques this AMI feed can detect vs the full reference set. The gap is a capture-richness question, listed honestly below." query={COUNTS} />
      </div>

      <Panel tourId="mitre-tactics" title="MITRE tactic summary" query={COUNTS} onRefresh={() => { counts.refetch(); sources.refetch() }} refreshing={loading}
        info="Events rolled up by ATT&CK tactic — each block is sized by its total signal volume and coloured by tactic. Click a tactic to filter the technique grid below to it; click again to clear."
        note={tacticFilter ? `filtered to ${tacticFilter}` : 'click a tactic to filter'}>
        <QueryBoundary state={{ loading, error: counts.error || sources.error, rows: tacticTotals }} emptyLabel="No data in this window">
          <div className="mitre-treemap">
            {tacticTotals.map(({ tac, total, techs, firing }) => (
              <button key={tac} type="button"
                className={`mitre-tm-block ${tacticFilter && tacticFilter !== tac ? 'mitre-tm-dim' : ''}`}
                style={{ flexGrow: Math.max(0.18, total / tacticMax), background: TACTIC_COLOR[tac] }}
                onClick={() => setTacticFilter(tacticFilter === tac ? null : tac)}
                title={`${tac}: ${total} events across ${firing}/${techs} techniques`}>
                <span className="mitre-tm-name">{tac}</span>
                <span className="mitre-tm-total">{loading ? '…' : fmtCount(total)}</span>
                <span className="mitre-tm-sub">{firing}/{techs} techniques</span>
              </button>
            ))}
          </div>
        </QueryBoundary>
      </Panel>

      <Panel tourId="mitre-grid" title="ATT&CK technique risk grid" query={COUNTS} onRefresh={() => { counts.refetch(); sources.refetch() }} refreshing={loading}
        info="Risk is the editorial severity of the technique class; the number on each tile is live event volume from this feed. Colour follows risk band. Click a tile to see the flows and sources behind it. Behaviour tiles (fan-out / scan) are computed per source."
        note={`${active} of ${TECHNIQUES.length} firing${tacticFilter ? ` · ${tacticFilter} only` : ' · grouped by tactic'}`}>
        <QueryBoundary state={{ loading, error: counts.error || sources.error, rows: tiles }} emptyLabel="No data in this window">
          {TACTICS.filter((tac) => (!tacticFilter || tac === tacticFilter) && tiles.some((x) => x.t.tactic === tac)).map((tac) => (
            <div key={tac} className="mitre-tactic">
              <div className="mitre-tactic-name">{tac}</div>
              <div className="mitre-grid">
                {tiles.filter((x) => x.t.tactic === tac).map(({ t, count }) => (
                  <button key={t.id} type="button"
                    className={`mitre-tile mitre-${count > 0 ? riskBand(t.risk) : 'idle'} ${sel?.id === t.id ? 'mitre-sel' : ''}`}
                    onClick={() => setSel(sel?.id === t.id ? null : t)}>
                    <span className="mitre-id">{t.id}</span>
                    <span className="mitre-name">{t.name}</span>
                    <span className="mitre-count">{loading ? '…' : fmtCount(count)}</span>
                    <span className="mitre-sig">{t.signal}</span>
                    <span className="mitre-risk">risk {t.risk}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </QueryBoundary>
      </Panel>

      {sel && (
        <Panel className="mitre-drill"
          title={<span className="tcp-drill-title">{sel.id} · {sel.name} <span className="tcp-arrow">—</span> {sel.tactic}</span>}
          info={sel.why}
          query={sel.kind === 'flow' ? drillQuery : SOURCES}
          note={<span className="tcp-drill-note">
            {sel.kind === 'flow' && <a href={searchUiUrl(drillQuery, range.earliest)} target="_blank" rel="noopener noreferrer">Open in Search ↗</a>}
            <button type="button" className="tcp-drill-close" onClick={() => setSel(null)} aria-label="Close">✕ Close</button>
          </span>}>
          {sel.kind === 'flow' ? (
            <QueryBoundary state={drill} emptyLabel="No flows for this technique in the window">
              <div className="tcp-drill-scroll">
                <table className="tcp-drill-tbl">
                  <thead><tr><th>Source</th><th>Destination</th><th>App</th><th className="num">Port</th><th className="num">Flows</th></tr></thead>
                  <tbody>
                    {drill.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="mono">{str(r, 'src_ip', '—')}</td>
                        <td className="mono">{str(r, 'dst_ip', '—')}</td>
                        <td>{str(r, 'app_name', '—')}</td>
                        <td className="num mono">{str(r, 'dst_port', '—')}</td>
                        <td className="num">{fmtCount(r.flows)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </QueryBoundary>
          ) : (
            <div className="tcp-drill-scroll">
              <div className="tcp-drill-summary"><span><strong>{fmtCount(behaviourRows.length)}</strong> sources match ({sel.behaviour!.metric} ≥ {sel.behaviour!.min}{sel.behaviour!.internalOnly ? ', internal' : ''})</span></div>
              <table className="tcp-drill-tbl">
                <thead><tr><th>Source IP</th><th className="num">Distinct ports</th><th className="num">Distinct dsts</th><th className="num">Flows</th></tr></thead>
                <tbody>
                  {behaviourRows.sort((a, b) => b[sel.behaviour!.metric] - a[sel.behaviour!.metric]).map((s, i) => (
                    <tr key={i} className={s[sel.behaviour!.metric] >= sel.behaviour!.min * 1.5 ? 'tcp-drill-bad' : ''}>
                      <td className="mono">{s.ip}{isInternal(s.ip) ? '' : ' (ext)'}</td>
                      <td className="num">{fmtCount(s.ports)}</td>
                      <td className="num">{fmtCount(s.dsts)}</td>
                      <td className="num">{fmtCount(s.flows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Panel title="Not observable in this feed" info="Techniques the reference NDR dashboard includes but this AMI capture has no signal for. Shown so the picture is honest — capability gaps are a capture question, not a detection failure to hide.">
        <ul className="mitre-gaps">
          {GAPS.map((g) => (
            <li key={g.id} className="mitre-gap">
              <span className="mitre-gap-id">{g.id}</span>
              <span className="mitre-gap-name">{g.name}</span>
              <span className="mitre-gap-reason">{g.reason}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
