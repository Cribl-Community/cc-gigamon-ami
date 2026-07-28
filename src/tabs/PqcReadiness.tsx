import { useMemo } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { toNum, str, fmtCount, fmtPct } from '../lib/format'
import {
  classifyGroup, PQC_GROUP_CODES, sensitivityOf, SENSITIVE, SENSITIVITY_RANK, type Sensitivity,
} from '../data/pqc'

const PQC_IN = `(${PQC_GROUP_CODES.map((c) => `"${c}"`).join(', ')})`

// Per-server capability: sessions, how many were TLS 1.3, how many OFFERED a
// hybrid ML-KEM group. Grouped with issuer (near-1:1 with SNI; merged in JS).
const SERVERS_Q = q(
  'ssl_server_name=* | summarize sessions=count(), ' +
  'tls13=sum(iif(ssl_server_supported_version=="772",1,0)), ' +
  `pqc=sum(iif(ssl_ext_ec_supported_groups_type in ${PQC_IN},1,0)) ` +
  'by ssl_server_name, ssl_issuer | sort by sessions desc | limit 300',
)

// Which named key-exchange groups appear, and on how many servers.
const GROUPS_Q = q(
  'ssl_ext_ec_supported_groups_type=* | summarize sessions=count(), servers=dcount(ssl_server_name) ' +
  'by ssl_ext_ec_supported_groups_type | sort by sessions desc | limit 40',
)

const SENS_LABEL: Record<Sensitivity, string> = {
  credential: 'credential', pci: 'pci', financial: 'financial', phi: 'phi', business: 'business', public: 'public',
}

interface ServerRow {
  sni: string
  issuer: string
  sessions: number
  tls13: number
  pqc: number
  sensitivity: Sensitivity
}

export function PqcReadiness() {
  const { range } = useDashboard()
  const serversQ = useSearch(SERVERS_Q)
  const groupsQ = useSearch(GROUPS_Q)

  // Merge (sni, issuer) rows → one per SNI; classify sensitivity from the name.
  const servers = useMemo<ServerRow[]>(() => {
    const bySni = new Map<string, ServerRow>()
    for (const r of serversQ.rows) {
      const sni = str(r, 'ssl_server_name')
      if (!sni) continue
      const cur = bySni.get(sni)
      const sessions = toNum(r.sessions)
      if (!cur) {
        bySni.set(sni, { sni, issuer: str(r, 'ssl_issuer', '—'), sessions, tls13: toNum(r.tls13), pqc: toNum(r.pqc), sensitivity: sensitivityOf(sni) })
      } else {
        cur.sessions += sessions
        cur.tls13 += toNum(r.tls13)
        cur.pqc += toNum(r.pqc)
        if (sessions > 0 && cur.issuer === '—') cur.issuer = str(r, 'ssl_issuer', '—')
      }
    }
    return [...bySni.values()].sort((a, b) => b.sessions - a.sessions)
  }, [serversQ.rows])

  const totals = useMemo(() => {
    let sessions = 0, tls13 = 0, pqc = 0, harvest = 0
    let pqcServers = 0
    for (const s of servers) {
      sessions += s.sessions; tls13 += s.tls13; pqc += s.pqc
      if (s.pqc > 0) pqcServers += 1
      if (SENSITIVE.includes(s.sensitivity)) harvest += s.sessions - s.pqc // classical → sensitive
    }
    const tls13Pct = sessions ? (tls13 / sessions) * 100 : 0
    const pqcPct = tls13 ? (pqc / tls13) * 100 : 0 // PQC as share of the TLS 1.3 floor
    const coverage = servers.length ? (pqcServers / servers.length) * 100 : 0
    // Same weighting the reference cites (ours; inputs are the standards' metrics).
    const score = Math.round(100 * (0.55 * (pqcPct / 100) + 0.25 * (tls13Pct / 100) + 0.20 * (coverage / 100)))
    const stage = score >= 80 ? 'Quantum-safe majority' : score >= 45 ? 'Early migration' : 'Pre-migration'
    return { sessions, tls13, pqc, harvest, pqcServers, tls13Pct, pqcPct, coverage, score, stage }
  }, [servers])

  const groupItems = useMemo<BarItem[]>(() => {
    return groupsQ.rows
      .map((r) => {
        const g = classifyGroup(str(r, 'ssl_ext_ec_supported_groups_type'))
        return { g, sessions: toNum(r.sessions) }
      })
      .filter((x) => x.g.cls !== 'grease')
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 10)
      .map((x) => ({
        label: `${x.g.name}${x.g.cls === 'pqc' ? ' · PQC' : x.g.cls === 'classical' ? ' · classical' : ''}`,
        value: x.sessions,
        display: fmtCount(x.sessions),
      }))
  }, [groupsQ.rows])

  const classical = servers.filter((s) => s.pqc === 0).sort(
    (a, b) => SENSITIVITY_RANK[a.sensitivity] - SENSITIVITY_RANK[b.sensitivity] || b.sessions - a.sessions,
  )
  const capable = servers.filter((s) => s.pqc > 0).sort((a, b) => b.pqc / b.sessions - a.pqc / a.sessions)

  const drill = (filter: string) => searchUiUrl(q(`${filter} | limit 200`), range.earliest)

  const worklistRow = (s: ServerRow) => {
    const pct = s.sessions ? (s.pqc / s.sessions) * 100 : 0
    return (
      <li key={s.sni} className={`pqc-row pqc-row-${s.pqc > 0 ? 'ok' : 'bad'}`}>
        <span className="pqc-svc">
          <a href={drill(`ssl_server_name="${s.sni}"`)} target="_blank" rel="noopener noreferrer" className="pqc-sni">{s.sni} ↗</a>
          <span className="pqc-issuer">{s.issuer}</span>
        </span>
        <span className="pqc-num">{fmtCount(s.sessions)}</span>
        <span className={`pqc-tls ${s.tls13 > 0 ? '' : 'pqc-pre13'}`}>{s.tls13 > 0 ? 'TLS 1.3' : 'pre-1.3'}</span>
        <span className={`pqc-qs ${s.pqc > 0 ? (pct > 40 ? 'd-ok' : 'd-warn') : 'd-danger'}`}>{fmtPct(pct, 1)}</span>
        <span className={`pqc-sens pqc-sens-${s.sensitivity}`}>{SENS_LABEL[s.sensitivity]}</span>
      </li>
    )
  }

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">PQC readiness</h2>
        <p className="tab-sub">
          Post-quantum migration posture from TLS handshake metadata — which sessions still rely on classical
          key exchange (<code>x25519</code>, <code>secp256r1</code>) that a future quantum computer breaks, versus
          hybrid ML-KEM (<code>X25519Kyber768</code>). Signal is <code>ssl_ext_ec_supported_groups_type</code> in
          the ClientHello, so this measures <strong>capability offered</strong> — the AMI feed carries no
          server-selected-group field, so a capable-but-downgraded (“turned away”) count is not derivable here.
        </p>
      </div>

      <div className="kpi-row kpi-row-4">
        <KpiTile label="PQC readiness score" value={serversQ.loading ? '…' : `${totals.score}`} unit="/100"
          accent={totals.score >= 80 ? 'success' : totals.score >= 45 ? 'warning' : 'danger'}
          sub={totals.stage} query={SERVERS_Q}
          info="Composite: 0.55·(PQC share of TLS 1.3) + 0.25·(TLS 1.3 adoption) + 0.20·(servers offering ≥1 PQC session). Weighting is ours; the inputs track NIST FIPS 203 / CNSA 2.0 / EO 14144 (TLS 1.3 by 2030)." />
        <KpiTile label="TLS 1.3 adoption" value={serversQ.loading ? '…' : fmtPct(totals.tls13Pct, 1)} accent="info"
          sub={`${fmtCount(totals.tls13)} of ${fmtCount(totals.sessions)} · the PQC-capable floor`}
          info="Share of TLS sessions negotiating TLS 1.3 (ssl_server_supported_version=772). PQC key exchange requires TLS 1.3." query={SERVERS_Q} />
        <KpiTile label="PQC key exchange offered" value={serversQ.loading ? '…' : fmtPct(totals.pqcPct, 1)} accent="warning"
          sub={`${fmtCount(totals.pqc)} sessions offered hybrid ML-KEM`}
          info="Share of TLS 1.3 sessions whose ClientHello offered a hybrid ML-KEM group (X25519Kyber768 / X25519MLKEM768). Offered, not necessarily negotiated." query={GROUPS_Q} />
        <KpiTile label="Harvest-now exposure" value={serversQ.loading ? '…' : fmtCount(totals.harvest)} accent="danger"
          sub="classical → sensitive destinations"
          info="Classical (non-PQC) sessions reaching a sensitivity-tagged destination (credential / pci / financial / phi). Recordable today, decryptable once a quantum computer exists. Sensitivity is a heuristic on the SNI." query={SERVERS_Q} />
      </div>

      <Panel tourId="pqc-groups" title="Key-exchange groups on the wire" query={GROUPS_Q} onRefresh={groupsQ.refetch} refreshing={groupsQ.loading}
        info="Named TLS supported-groups actually seen (GREASE placeholders removed). Hybrid ML-KEM groups are quantum-safe; x25519 / secp256r1 and finite-field DH are classical and quantum-vulnerable."
        note={`${totals.pqcServers} of ${servers.length} servers saw ≥1 PQC-offering session`}>
        <QueryBoundary state={groupsQ} emptyLabel="No TLS supported-groups data in this window">
          <BarList items={groupItems} accent="info" />
        </QueryBoundary>
      </Panel>

      <Panel tourId="pqc-worklist" title="Server readiness worklist" onRefresh={serversQ.refetch} refreshing={serversQ.loading}
        info="Every TLS server split by whether any session to it offered a hybrid ML-KEM group. Classical-only servers are the remediation worklist. % quantum-safe is PQC-offering sessions ÷ all sessions to that server. Data-sensitivity is a heuristic classification of the SNI, not a feed field."
        query={SERVERS_Q} note={`${classical.length} classical-only · ${capable.length} PQC-capable`}>
        <QueryBoundary state={serversQ} emptyLabel="No TLS servers in this window">
          <div className="pqc-worklist">
            <div className="pqc-group-head pqc-head-bad">
              <span>Classical-only <span className="pqc-count">{classical.length}</span></span>
              <span className="pqc-head-note">no PQC key exchange offered — remediation worklist</span>
            </div>
            <ul className="pqc-list">
              <li className="pqc-row pqc-colhead">
                <span>Service / SNI</span><span className="pqc-num">Sessions</span><span>Max TLS</span>
                <span>% quantum-safe</span><span>Sensitivity</span>
              </li>
              {classical.length ? classical.map(worklistRow)
                : <li className="pqc-row"><span className="qb-msg">None — every server saw a PQC-capable session.</span></li>}
            </ul>

            <div className="pqc-group-head pqc-head-ok">
              <span>PQC-capable <span className="pqc-count">{capable.length}</span></span>
              <span className="pqc-head-note">≥1 hybrid ML-KEM session offered</span>
            </div>
            <ul className="pqc-list">
              {capable.length ? capable.map(worklistRow)
                : <li className="pqc-row"><span className="qb-msg">None yet — no server saw a hybrid ML-KEM offer.</span></li>}
            </ul>
          </div>
        </QueryBoundary>
      </Panel>
    </div>
  )
}
