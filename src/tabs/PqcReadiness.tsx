// PQC readiness — two hourly scheduled runs, one per query (2026-09-27,
// `feat/accel-tls-pqc`): `gno_pqc_servers_c1h` for the tiles and the worklist,
// `gno_pqc_groups_c1h` for the key-exchange groups.
//
// THE EQUIVALENT OF TLS POSTURE'S NULL-IS-NOT-ZERO RULE. Unlike that tab, a
// server's PQC count and its session count come from the SAME row here, so no
// join can read a missing answer as "classical". What can still happen is a
// tile computed from nothing: a failed search (`useSearch` keeps the previous
// rows, possibly for another window), or a picked past moment with no run of
// this entry (`source: 'none'`: no rows, no error, not loading). Summed over no
// servers, every tile is a confident 0 — a readiness score of 0, a harvest-now
// exposure of 0 — so `serversKnown` false prints `—` on all four instead. A
// STALE run is different: its rows are one internally consistent answer, dated
// by the panel's caption, so they are shown as the stale answer they are.

import { useMemo } from 'react'
import { useSearch, type UseSearchState } from '../cribl/useSearch'
import { searchUiUrl } from '../cribl/config'
import { accelEntry, type AccelId } from '../cribl/accel/manifest'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { type ComputedFrom } from '../components/PanelInfo'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { type PanelSnapshotState } from '../components/snapshotCensus'
import { toNum, str, fmtCount, fmtPct } from '../lib/format'
import {
  classifyGroup, sensitivityOf, SENSITIVE, SENSITIVITY_RANK, type Sensitivity,
} from '../data/pqc'
import { drillQuery, GROUPS_Q, serverFilter, SERVERS_Q } from '../queries/pqcReadiness'

const PQC_SERVERS_ACCEL: AccelId = 'gno_pqc_servers_c1h'
const PQC_GROUPS_ACCEL: AccelId = 'gno_pqc_groups_c1h'
const SERVERS_ENTRY = accelEntry(PQC_SERVERS_ACCEL)
/** The schedules in words, for the ⓘ. PqcReadiness.test.tsx holds these against
 *  the manifest's own crons, so moving one forces the other. */
export const PQC_SERVERS_CADENCE = 'once an hour, at 57 minutes past, in UTC'
export const PQC_GROUPS_CADENCE = 'once an hour, at 58 minutes past, in UTC'
export const PQC_WINDOW = SNAPSHOT_WINDOW

const computedFrom = (s: UseSearchState, cadence: string): ComputedFrom => ({
  source: s.source, at: s.at, stale: s.stale, cadence, window: PQC_WINDOW, fallback: s.note,
})
const snapshotOf = (s: UseSearchState): PanelSnapshotState => ({
  source: s.source, outcome: s.outcome, at: s.at, stale: s.stale, nearestAt: s.nearestAt,
})

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
  const serversQ = useSearch(SERVERS_Q, { accel: PQC_SERVERS_ACCEL, accelPanel: 'pqc-servers' })
  const groupsQ = useSearch(GROUPS_Q, { accel: PQC_GROUPS_ACCEL, accelPanel: 'pqc-groups' })
  /** The tiles have servers to be computed over. See the header. */
  const serversKnown = serversQ.error === null && serversQ.source !== 'none'
  const serversComputed = computedFrom(serversQ, PQC_SERVERS_CADENCE)
  const groupsComputed = computedFrom(groupsQ, PQC_GROUPS_CADENCE)
  /** A tile's value: loading, unknown, or the figure. */
  const tile = (figure: string) => (serversQ.loading ? '…' : serversKnown ? figure : '—')

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

  // A worklist row drills into the window it was read over — the run's fifteen
  // settled minutes when it came from the schedule (DnsHealth.tsx's rule).
  const drillEarliest = serversQ.source === 'schedule' ? SERVERS_ENTRY.earliest : range.earliest
  const drill = (filter: string) => searchUiUrl(drillQuery(filter), drillEarliest)

  const worklistRow = (s: ServerRow) => {
    const pct = s.sessions ? (s.pqc / s.sessions) * 100 : 0
    return (
      <li key={s.sni} className={`pqc-row pqc-row-${s.pqc > 0 ? 'ok' : 'bad'}`}>
        <span className="pqc-svc">
          <a href={drill(serverFilter(s.sni))} target="_blank" rel="noopener noreferrer" className="pqc-sni">{s.sni} ↗</a>
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
        <KpiTile label="PQC readiness score" value={tile(`${totals.score}`)} unit={serversKnown ? '/100' : undefined}
          accent={!serversKnown ? 'neutral' : totals.score >= 80 ? 'success' : totals.score >= 45 ? 'warning' : 'danger'}
          sub={serversKnown ? totals.stage : 'no server answer for this window'} query={SERVERS_Q} computed={serversComputed}
          info="Composite: 0.55·(PQC share of TLS 1.3) + 0.25·(TLS 1.3 adoption) + 0.20·(servers offering ≥1 PQC session). Weighting is ours; the inputs track NIST FIPS 203 / CNSA 2.0 / EO 14144 (TLS 1.3 by 2030)." />
        <KpiTile label="TLS 1.3 adoption" value={tile(fmtPct(totals.tls13Pct, 1))} accent="info"
          sub={`${fmtCount(totals.tls13)} of ${fmtCount(totals.sessions)} · the PQC-capable floor`}
          info="Share of TLS sessions negotiating TLS 1.3 (ssl_server_supported_version=772). PQC key exchange requires TLS 1.3." query={SERVERS_Q} computed={serversComputed} />
        <KpiTile label="PQC key exchange offered" value={tile(fmtPct(totals.pqcPct, 1))} accent="warning"
          sub={`${fmtCount(totals.pqc)} sessions offered hybrid ML-KEM`}
          info="Share of TLS 1.3 sessions whose ClientHello offered a hybrid ML-KEM group (X25519Kyber768 / X25519MLKEM768). Offered, not necessarily negotiated." query={SERVERS_Q} computed={serversComputed} />
        <KpiTile label="Harvest-now exposure" value={tile(fmtCount(totals.harvest))} accent={serversKnown ? 'danger' : 'neutral'}
          sub="classical → sensitive destinations"
          info="Classical (non-PQC) sessions reaching a sensitivity-tagged destination (credential / pci / financial / phi). Recordable today, decryptable once a quantum computer exists. Sensitivity is a heuristic on the SNI." query={SERVERS_Q} computed={serversComputed} />
      </div>

      <Panel tourId="pqc-groups" title="Key-exchange groups on the wire" query={GROUPS_Q} computed={groupsComputed} snapshot={snapshotOf(groupsQ)} onRefresh={groupsQ.refetch} refreshing={groupsQ.loading}
        info="Named TLS supported-groups actually seen (GREASE placeholders removed). Hybrid ML-KEM groups are quantum-safe; x25519 / secp256r1 and finite-field DH are classical and quantum-vulnerable."
        note={`${totals.pqcServers} of ${servers.length} servers saw ≥1 PQC-offering session`}>
        <QueryBoundary state={groupsQ} emptyLabel="No TLS supported-groups data in this window">
          <BarList items={groupItems} accent="info" />
        </QueryBoundary>
      </Panel>

      <Panel tourId="pqc-worklist" title="Server readiness worklist" onRefresh={serversQ.refetch} refreshing={serversQ.loading}
        info="Every TLS server split by whether any session to it offered a hybrid ML-KEM group. Classical-only servers are the remediation worklist. % quantum-safe is PQC-offering sessions ÷ all sessions to that server. Data-sensitivity is a heuristic classification of the SNI, not a feed field."
        query={SERVERS_Q} computed={serversComputed} snapshot={snapshotOf(serversQ)} note={`${classical.length} classical-only · ${capable.length} PQC-capable`}>
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
