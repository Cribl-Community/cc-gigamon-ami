// TLS posture — and the one thing on this tab that two searches have to agree
// about.
//
// THE DEFECT THIS FILE NOW ANSWERS. Certificates come from SERVERS; key exchange
// comes from PQC_BY_SERVER, a second, cheaper search that deliberately touches
// only the sparse records carrying a hybrid ML-KEM group (the two were folded
// into one query once and it timed out). They start together and need not finish
// together, and `useSearch` keeps the previous rows on a failure. So every
// expression here that reads `pqcMap` had a silent third answer: not "PQC" and
// not "classical" but "the search that would have told us did not return".
// `pqcMap.get(name) ?? 0` collapsed that answer into 0 — the numeric spelling of
// "offered nothing post-quantum" — and the tile, the per-row tag and the filter
// all read it as fact. A failed PQC search therefore printed a confident count
// of quantum-unsafe servers, tagged all sixty rows `classical`, and surfaced the
// failure nowhere: this tab's QueryBoundary is bound to `servers` alone, and a
// boundary only speaks for the query it was handed.
//
// WHAT CHANGED. `pqc` is now `number | null`, null meaning "not a fact", and
// nothing downstream is allowed to treat null as a count:
//
//   • the tile prints an em dash, drops its colour claim, and says in its
//     caption that the search failed — a number computed from a failed query is
//     worse than no number, because there is nothing on screen to distrust;
//   • each row carries `<StatusPill>` instead of a key exchange it cannot know:
//     `unreadable`, the same word Guided Setup uses when Cribl refuses a read,
//     for the same reason — the app tried to find out and cannot say — rather
//     than a fourteenth way to spell one state;
//   • the "Quantum-unsafe KEX only" filter is not applied and not interactive.
//     Applied, it would have shown zero rows under the message "every server
//     offered PQC key exchange", which is the strongest false claim on the tab.
//
// THE SAME GAP HAS A SECOND CAUSE, and it is not a failure. On the very first
// load, SERVERS can come back while PQC_BY_SERVER is still running: `pqcMap` is
// empty for the same few hundred milliseconds, and empty reads as "offered
// nothing post-quantum" exactly the way a failure does. Slice 1.3 made the TILE
// wait for both loading states; the rows were never covered. They now say
// `checking` — the word the app already had for "still finding out" — and the
// filter waits with them. Only the first load: on a re-run the previous rows are
// still in hand, so the table keeps the last answer under QueryBoundary's
// updating overlay instead of flickering sixty rows to `checking` on every
// range change.
//
// WHY UNAVAILABLE BEATS STALE. On a failed re-run the previous rows are still in
// `pqcServers.rows`, so `pqcMap` would still answer — with counts measured over
// a window that may no longer be the one on screen, since a range change is one
// of the things that re-runs the query. There is no marking that distinguishes
// the two, so the error decides, whatever rows survive behind it.
//
// THE ALERT IS NOT A PAGE BANNER. `AppBanners` owns the page-level slot and says
// so; this is a notice about one panel, rendered inside it, which is the shape
// the design system calls an inline section notice. `warning`, not `danger`,
// matches `unreadable`: nothing is broken, something is unknown, and the panel
// below it still has good certificate and protocol data.

import { useState } from 'react'
import { Alert } from '@capra/core'
import { useSearch } from '../cribl/useSearch'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { StatusPill } from '../components/StatusPill'
import { str, toNum, fmtCount } from '../lib/format'
import { SERVERS, PQC_BY_SERVER, serverDrill } from '../queries/tlsPosture'

const WEAK = new Set(['TLS_1_0', 'TLS_1_1', 'SSL_3_0', 'SSL_2_0'])
const KNOWN_CA = ['digicert', 'let', 'globalsign', 'sectigo', 'comodo', 'geotrust', 'amazon', 'google trust',
  'gts', 'entrust', 'isrg', 'cloudflare', 'baltimore', 'microsoft', 'apple', 'godaddy', 'thawte', 'rapidssl']

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

/** The sentence the disabled filter points at with `aria-describedby`, so the
 *  reason is announced rather than only drawn. */
const PQC_FAILED_ID = 'tls-pqc-unavailable'

export function TlsPosture() {
  const { range } = useDashboard()
  const servers = useSearch(SERVERS)
  const pqcServers = useSearch(PQC_BY_SERVER)
  // Filter to servers whose sessions only ever offered classical key exchange —
  // quantum-vulnerable (harvest-now-decrypt-later). See the PQC Readiness tab.
  const [pqcUnsafeOnly, setPqcUnsafeOnly] = useState(false)
  /** No key-exchange answer for this window. See the header: error beats rows. */
  const pqcUnavailable = pqcServers.error !== null
  /**
   * The same gap, before anything has failed: the first load, after SERVERS has
   * come back and while PQC_BY_SERVER is still running. `pqcMap` is empty, and
   * empty reads as "offered nothing post-quantum" exactly the way a failure
   * does. Only the FIRST load — on a re-run the previous rows are still here, so
   * this is false and the table shows the last answer under QueryBoundary's
   * updating overlay rather than flickering every row to `checking`.
   */
  const pqcPending = !pqcUnavailable && pqcServers.loading && pqcServers.rows.length === 0
  /** Key exchange is a fact about these servers, rather than a gap or a guess. */
  const pqcKnown = !pqcUnavailable && !pqcPending
  const pqcMap = new Map(pqcServers.rows.map((r) => [str(r, 'ssl_server_name'), toNum(r.pqc)]))

  const drillServer = (server: string) => {
    window.open(searchUiUrl(serverDrill(server), range.earliest), '_blank', 'noopener')
  }

  const assessed = servers.rows.map((r) => {
    const ver = str(r, 'ver'), notafter = str(r, 'notafter'), issuer = str(r, 'issuer'), cn = str(r, 'cn')
    // null, not 0: a server the PQC query never reported and a server the PQC
    // query has not answered for are different facts, and 0 is one of them.
    const pqc = pqcKnown ? (pqcMap.get(str(r, 'ssl_server_name')) ?? 0) : null
    return { r, ver, notafter, issuer, pqc, p: assess(ver, notafter, issuer, cn, str(r, 'ssl_server_name')) }
  })
  const rank = { danger: 0, warning: 1, success: 2 } as const
  assessed.sort((a, b) => rank[a.p.accent] - rank[b.p.accent] || toNum(b.r.flows) - toNum(a.r.flows))

  const withCert = assessed.filter((a) => a.notafter).length
  const atRisk = assessed.filter((a) => a.p.accent !== 'success').length
  const weakCount = assessed.filter((a) => WEAK.has(a.ver)).length
  // `=== 0` and not `!== null && === 0` on purpose — null never equals 0, so an
  // unavailable key exchange counts as neither classical nor PQC here. The tile
  // below still refuses to print the total, because 0 of 60 would read as good
  // news rather than as no news.
  const classicalKex = assessed.filter((a) => a.pqc === 0).length
  // An unknown key exchange suspends the filter rather than emptying the list:
  // filtered on nothing, this renders "every server offered PQC key exchange"
  // over an empty table — the one sentence on this tab that must never be
  // guessed. The choice is kept, not cleared, so it applies again on recovery.
  const shown = pqcUnsafeOnly && pqcKnown ? assessed.filter((a) => a.pqc === 0) : assessed

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
        <KpiTile label="Classical KEX (quantum-unsafe)" value={pqcUnavailable ? '—' : servers.loading || pqcServers.loading ? '…' : String(classicalKex)}
          accent={pqcUnavailable ? 'neutral' : classicalKex > 0 ? 'warning' : 'success'}
          sub={pqcUnavailable ? 'key-exchange search failed — see the panel below' : 'no hybrid ML-KEM offered'}
          info="Servers exposed to harvest-now-decrypt-later: none of their sessions offered a post-quantum group in ssl_ext_ec_supported_groups_type. Counts the busiest 60 servers by flows that are missing from the query below. See the PQC Readiness tab." query={PQC_BY_SERVER} />
      </div>

      <Panel tourId="tls-servers" title="Servers" info="Each row: server name, issuer (when a cert chain is present), negotiated TLS version, days to expiry, a posture badge, and a key-exchange tag (PQC = offered hybrid ML-KEM; classical = quantum-vulnerable). CA trust is checked against a list of well-known public CAs; anything else is flagged Unknown CA / Self-signed." query={SERVERS} onRefresh={() => { servers.refetch(); pqcServers.refetch() }} refreshing={servers.loading || pqcServers.loading} note={`${shown.length} of ${assessed.length} shown · worst first`}>
        {pqcUnavailable && (
          // `.resolver-toolbar` is reused purely as the spacing wrapper this
          // panel already has — Capra components take their spacing from a
          // wrapper, never from a class on the component itself.
          <div className="resolver-toolbar">
            <Alert
              layout="section"
              appearance="warning"
              title="Key exchange could not be read"
              action={<button type="button" className="btn" onClick={pqcServers.refetch}>Try again</button>}
            >
              <span id={PQC_FAILED_ID}>
                The key-exchange search failed, so no server below can be called PQC or classical in this window,
                and the filter is unavailable. Certificates and TLS versions are unaffected.
                {' '}{pqcServers.errorTitle ? `${pqcServers.errorTitle}: ` : ''}{pqcServers.error}
              </span>
            </Alert>
          </div>
        )}
        <div className="resolver-toolbar">
          {/* aria-disabled, never disabled: a `disabled` button leaves the
              keyboard order and announces nothing, so the reason above it would
              exist only for people who can see it. Same rule as GatedControl. */}
          {/* `pqcKnown`, not `pqcUnsafeOnly`, decides the lit state: the button
              is lit exactly when the filter is being applied, so it never shows
              as on while the list behind it is unfiltered. */}
          <button type="button" className={`seg ${pqcUnsafeOnly && pqcKnown ? 'seg-active' : ''}`}
            aria-disabled={pqcUnavailable || undefined}
            aria-describedby={pqcUnavailable ? PQC_FAILED_ID : undefined}
            onClick={() => { if (!pqcUnavailable) setPqcUnsafeOnly((v) => !v) }}
            title={pqcUnavailable
              ? 'Unavailable — the key-exchange search failed'
              : 'Show only servers with classical (quantum-vulnerable) key exchange'}>
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
                  {pqc === null ? (
                    // One grid child, like the tag it stands in for, so the
                    // posture badge keeps its column. `checking` and
                    // `unreadable` are the app's existing words for "still
                    // finding out" and "tried, cannot say".
                    <StatusPill state={pqcUnavailable ? 'unreadable' : 'checking'} />
                  ) : (
                    <span className={`pill pill-kex ${pqc > 0 ? 'pill-kex-pqc' : 'pill-kex-classical'}`}
                      title={pqc > 0 ? `${pqc} sessions offered hybrid ML-KEM` : 'Only classical key exchange — quantum-vulnerable'}>
                      {pqc > 0 ? 'PQC' : 'classical'}
                    </span>
                  )}
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
