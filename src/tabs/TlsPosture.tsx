import { useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { str, toNum, fmtCount } from '../lib/format'
import { PQC_GROUP_CODES } from '../data/pqc'

const WEAK = new Set(['TLS_1_0', 'TLS_1_1', 'SSL_3_0', 'SSL_2_0'])
const KNOWN_CA = ['digicert', 'let', 'globalsign', 'sectigo', 'comodo', 'geotrust', 'amazon', 'google trust',
  'gts', 'entrust', 'isrg', 'cloudflare', 'baltimore', 'microsoft', 'apple', 'godaddy', 'thawte', 'rapidssl']

const PQC_IN = `(${PQC_GROUP_CODES.map((c) => `"${c}"`).join(', ')})`

const SERVERS = q(
  'ssl_server_name=* | summarize flows=count(), ver=max(ssl_protocol_version), ' +
    'issuer=max(ssl_issuer), notafter=max(ssl_validity_not_after), cn=max(ssl_common_name) ' +
    'by ssl_server_name | sort by flows desc | limit 60',
)

// PQC capability is a separate, cheap query — it only touches the sparse set of
// records that offered a hybrid ML-KEM group, so it stays fast. Folding it into
// the SERVERS query (5 max() aggregations) timed the search out.
const PQC_BY_SERVER = q(`ssl_ext_ec_supported_groups_type in ${PQC_IN} | summarize pqc=count() by ssl_server_name | limit 200`)

interface Posture { badge: string; accent: 'success' | 'warning' | 'danger'; daysLeft: number | null }

function assess(ver: string, notafter: string, issuer: string, cn: string, server: string): Posture {
  const weak = WEAK.has(ver)
  let daysLeft: number | null = null
  if (notafter) {
    const ms = Date.parse(notafter.replace(' ', 'T'))
    if (!Number.isNaN(ms)) daysLeft = Math.round((ms - Date.now()) / 86400000)
  }
  const iss = issuer.toLowerCase()
  const selfSigned = issuer !== '' && (issuer === cn || issuer === server)
  const knownCA = issuer !== '' && KNOWN_CA.some((k) => iss.includes(k))
  const unknownCA = issuer !== '' && !knownCA

  if (daysLeft != null && daysLeft < 0) return { badge: weak ? 'EXPIRED · weak' : 'EXPIRED', accent: 'danger', daysLeft }
  if (weak && daysLeft != null && daysLeft < 30) return { badge: 'WEAK + EXPIRING', accent: 'danger', daysLeft }
  if (weak) return { badge: 'WEAK PROTOCOL', accent: 'danger', daysLeft }
  if (selfSigned) return { badge: 'SELF-SIGNED', accent: 'danger', daysLeft }
  if (unknownCA) return { badge: 'UNKNOWN CA', accent: 'danger', daysLeft }
  if (daysLeft != null && daysLeft < 30) return { badge: 'RENEW', accent: 'warning', daysLeft }
  return { badge: 'OK', accent: 'success', daysLeft }
}

const tlsLabel = (v: string) => (v ? v.replace('TLS_', 'TLS ').replace('SSL_', 'SSL ').replace('_', '.') : '—')

export function TlsPosture() {
  const { range } = useDashboard()
  const servers = useSearch(SERVERS)
  const pqcServers = useSearch(PQC_BY_SERVER)
  // Filter to servers whose sessions only ever offered classical key exchange —
  // quantum-vulnerable (harvest-now-decrypt-later). See the PQC Readiness tab.
  const [pqcUnsafeOnly, setPqcUnsafeOnly] = useState(false)
  const pqcMap = new Map(pqcServers.rows.map((r) => [str(r, 'ssl_server_name'), toNum(r.pqc)]))

  const drillServer = (server: string) => {
    const dq = q(`ssl_server_name="${server}" | summarize flows=count(), ver=max(ssl_protocol_version), issuer=max(ssl_issuer), notafter=max(ssl_validity_not_after), notbefore=max(ssl_validity_not_before), subject=max(ssl_common_name), cipher=max(ssl_cipher_suite_id) by ssl_server_name`)
    window.open(searchUiUrl(dq, range.earliest), '_blank', 'noopener')
  }

  const assessed = servers.rows.map((r) => {
    const ver = str(r, 'ver'), notafter = str(r, 'notafter'), issuer = str(r, 'issuer'), cn = str(r, 'cn')
    return { r, ver, notafter, issuer, pqc: pqcMap.get(str(r, 'ssl_server_name')) ?? 0, p: assess(ver, notafter, issuer, cn, str(r, 'ssl_server_name')) }
  })
  const rank = { danger: 0, warning: 1, success: 2 } as const
  assessed.sort((a, b) => rank[a.p.accent] - rank[b.p.accent] || toNum(b.r.flows) - toNum(a.r.flows))

  const withCert = assessed.filter((a) => a.notafter).length
  const atRisk = assessed.filter((a) => a.p.accent !== 'success').length
  const weakCount = assessed.filter((a) => WEAK.has(a.ver)).length
  const classicalKex = assessed.filter((a) => a.pqc === 0).length
  const shown = pqcUnsafeOnly ? assessed.filter((a) => a.pqc === 0) : assessed

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">TLS posture</h2>
        <p className="tab-sub">
          Certificate and protocol posture per server name (<code>ssl_server_name</code>). Ranked worst-first:
          expired &gt; weak protocol &gt; self-signed / unknown CA &gt; expiring (RENEW). Full cert chains are
          sparse in AMI, so most rows show the negotiated TLS version; rows with <code>ssl_validity_not_after</code>
          add expiry, issuer &amp; CA-trust checks.
        </p>
      </div>

      <div className="kpi-row kpi-row-4">
        <KpiTile label="Distinct servers" value={servers.loading ? '…' : String(assessed.length)} accent="info" sub="unique ssl_server_name"
          info="Count of distinct TLS server names seen in the window. Posture is assessed client-side from each server's issuer, TLS version, and validity date." query={SERVERS} />
        <KpiTile label="At-risk certs / protocols" value={servers.loading ? '…' : String(atRisk)}
          accent={atRisk > 0 ? 'warning' : 'success'} sub="expired, weak, untrusted, or expiring"
          info="Rows that aren't OK: expired, weak protocol, self-signed / unknown CA, or expiring within 30 days." query={SERVERS} />
        <KpiTile label="Weak protocol" value={servers.loading ? '…' : String(weakCount)}
          accent={weakCount > 0 ? 'danger' : 'success'} sub={`TLS < 1.2 · ${withCert} rows have full certs`}
          info="Servers negotiating TLS 1.1/1.0 or SSL — deprecated and insecure." query={SERVERS} />
        <KpiTile label="Classical KEX (quantum-unsafe)" value={servers.loading ? '…' : String(classicalKex)}
          accent={classicalKex > 0 ? 'warning' : 'success'} sub="no hybrid ML-KEM offered"
          info="Servers whose sessions only ever offered classical key exchange (x25519 / secp256r1) — vulnerable to harvest-now-decrypt-later. See the PQC Readiness tab for the full migration view." query={SERVERS} />
      </div>

      <Panel tourId="tls-servers" title="Servers" info="Each row: server name, issuer (when a cert chain is present), negotiated TLS version, days to expiry, a posture badge, and a key-exchange tag (PQC = offered hybrid ML-KEM; classical = quantum-vulnerable). CA trust is checked against a list of well-known public CAs; anything else is flagged Unknown CA / Self-signed." query={SERVERS} onRefresh={() => { servers.refetch(); pqcServers.refetch() }} refreshing={servers.loading || pqcServers.loading} note={`${shown.length} of ${assessed.length} shown · worst first`}>
        <div className="resolver-toolbar">
          <button type="button" className={`seg ${pqcUnsafeOnly ? 'seg-active' : ''}`} onClick={() => setPqcUnsafeOnly((v) => !v)}
            title="Show only servers with classical (quantum-vulnerable) key exchange">
            Quantum-unsafe KEX only
          </button>
        </div>
        <QueryBoundary state={servers} emptyLabel="No TLS handshakes in this window">
          {shown.length === 0 ? (
            <div className="qb-center qb-empty"><span className="qb-msg">No servers match — every server offered PQC key exchange.</span></div>
          ) : (
          <ul className="resolver-list">
            {shown.map(({ r, ver, notafter, issuer, pqc, p }, i) => {
              const name = str(r, 'ssl_server_name', '(unknown)')
              const expires = p.daysLeft != null ? `expires ${p.daysLeft}d` : ''
              return (
                <li className="resolver-row resolver-row-tls resolver-row-click" key={`${name}-${i}`}
                  onClick={() => name !== '(unknown)' && drillServer(name)}
                  title="Open this server's TLS / cert records in Cribl Search">
                  <span className={`dot dot-${p.accent}`} />
                  <span className="resolver-name">
                    {name} <span className="row-drill">↗</span>
                    {issuer && <span className="tls-issuer"> ssl_issuer: {issuer}</span>}
                    {!notafter && <span className="tls-issuer tls-nocert"> · TLS session (no cert in feed)</span>}
                  </span>
                  <span className="resolver-stats">
                    {tlsLabel(ver)}{expires ? ` · ${expires}` : ''} · {fmtCount(r.flows)} flows
                  </span>
                  <span className={`pill pill-kex ${pqc > 0 ? 'pill-kex-pqc' : 'pill-kex-classical'}`}
                    title={pqc > 0 ? `${pqc} sessions offered hybrid ML-KEM` : 'Only classical key exchange — quantum-vulnerable'}>
                    {pqc > 0 ? 'PQC' : 'classical'}
                  </span>
                  <span className={`pill pill-${p.accent}`}>{p.badge}</span>
                </li>
              )
            })}
          </ul>
          )}
        </QueryBoundary>
      </Panel>
    </div>
  )
}
