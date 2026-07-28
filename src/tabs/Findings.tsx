import { useMemo } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { searchUiUrl, criblInvestigateUrl, LAKE_DATASET } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { DatasetIntelPrompt } from '../components/DatasetIntelPrompt'
import { toNum, fmtCount, fmtPct } from '../lib/format'

type Severity = 'critical' | 'high' | 'medium' | 'low'
type Category = 'Security' | 'Wire health' | 'Service health'

interface Finding {
  id: string
  severity: Severity
  category: Category
  title: string
  /** Why this matters — the analyst-facing "so what". */
  why: string
  /** AMI field(s) that evidence it. */
  field: string
  /** KQL aggregation producing the match count. */
  agg: string
  /** KQL predicate to drill into the matching flows. */
  filter: string
}

/**
 * Detections evaluated in one pass over the window.
 *
 * Each entry is a ROW, not a distribution — several of these fields carry only
 * one distinct value in this feed, which is irrelevant for "is this happening
 * and how often". Findings that match 0 flows are hidden rather than shown as
 * zeros, so the list only ever contains things that are actually true.
 */
const FINDINGS: Finding[] = [
  {
    id: 'mitm', severity: 'critical', category: 'Security',
    title: 'TLS interception / man-in-the-middle indicators',
    why: 'Gigamon scores handshakes that look intercepted. Legitimate inspection proxies score here too — but so does an attacker in path.',
    field: 'ssl_mitm_score', agg: 'sum(iif(ssl_mitm_score>0,1,0))', filter: 'ssl_mitm_score>0',
  },
  {
    id: 'snmp', severity: 'critical', category: 'Security',
    title: 'Cleartext SNMP community strings on the wire',
    why: 'SNMP v1/v2c community strings are readable credentials. Anyone with a tap can harvest and reuse them against network gear.',
    field: 'snmp_community', agg: 'count(snmp_community)', filter: 'snmp_community=*',
  },
  {
    id: 'icmptun', severity: 'high', category: 'Security',
    title: 'ICMP tunneling detected',
    why: 'Data encapsulated in ICMP is a classic covert channel for exfiltration and C2 — it bypasses controls that only inspect TCP/UDP.',
    field: 'icmp_tunneling', agg: 'count(icmp_tunneling)', filter: 'icmp_tunneling=*',
  },
  {
    id: 'sip', severity: 'high', category: 'Security',
    title: 'VoIP reconnaissance (SIPVicious scanner)',
    why: 'SIP scanning enumerates extensions ahead of toll fraud or call interception. The scanner identifies itself in the From header.',
    field: 'sip_from', agg: 'count(sip_from)', filter: 'sip_from=*',
  },
  {
    id: 'dcerpc', severity: 'high', category: 'Security',
    title: 'DCE/RPC (MSRPC) service activity',
    why: 'MSRPC is the workhorse of Windows lateral movement — remote service creation, scheduled tasks and WMI all ride it.',
    field: 'dcerpc_service', agg: 'count(dcerpc_service)', filter: 'dcerpc_service=*',
  },
  {
    id: 'krb', severity: 'medium', category: 'Security',
    title: 'Kerberos ticket activity',
    why: 'AS/TGS request patterns are where Kerberoasting and golden-ticket abuse show up. Worth baselining even when benign.',
    field: 'krb5_message_type', agg: 'count(krb5_message_type)', filter: 'krb5_message_type=*',
  },
  {
    id: 'cookie', severity: 'high', category: 'Security',
    title: 'Session cookies sent in cleartext',
    why: 'A cookie visible on the wire is a session that can be stolen and replayed without ever cracking a password.',
    field: 'http_cookie', agg: 'count(http_cookie)', filter: 'http_cookie=*',
  },
  {
    id: 'ftp', severity: 'medium', category: 'Security',
    title: 'Cleartext FTP data transfer',
    why: 'FTP carries both credentials and file contents unencrypted. Usually a forgotten legacy job nobody owns.',
    field: 'ftp_data_content', agg: 'count(ftp_data_content)', filter: 'ftp_data_content=*',
  },
  {
    id: 'snmpanom', severity: 'medium', category: 'Security',
    title: 'SNMP protocol-processing anomalies',
    why: 'Malformed SNMP is either a broken agent or someone probing/fuzzing the management plane.',
    field: 'snmp_processing_anomaly_type', agg: 'count(snmp_processing_anomaly_type)', filter: 'snmp_processing_anomaly_type=*',
  },
  {
    id: 'tcpcrc', severity: 'high', category: 'Wire health',
    title: 'TCP checksum errors',
    why: 'Corruption on the wire. Points at a failing NIC, cable, or optic — not at the application everyone is blaming.',
    field: 'tcp_wrong_crc', agg: 'sum(iif(tcp_wrong_crc>0,1,0))', filter: 'tcp_wrong_crc>0',
  },
  {
    id: 'reset', severity: 'high', category: 'Service health',
    title: 'TCP connection resets',
    why: 'Abrupt closes. At high rates this is a service refusing or dropping connections, not a network fault.',
    field: 'tcp_reset', agg: 'sum(tcp_reset)', filter: 'tcp_reset>0',
  },
  {
    id: 'loss', severity: 'medium', category: 'Wire health',
    title: 'Detected packet loss',
    why: 'Lost segments force retransmission and stall throughput — the usual cause of "it feels slow" with healthy servers.',
    field: 'tcp_loss_count', agg: 'sum(iif(tcp_loss_count>0,1,0))', filter: 'tcp_loss_count>0',
  },
  {
    id: 'httperr', severity: 'medium', category: 'Service health',
    title: 'HTTP 4xx / 5xx responses',
    why: 'Application-layer failures visible without instrumenting the app — 5xx is the server, 4xx is usually the caller.',
    field: 'http_code', agg: 'sum(iif(http_code>=400,1,0))', filter: 'http_code>=400',
  },
  {
    id: 'nxdomain', severity: 'low', category: 'Service health',
    title: 'DNS NXDOMAIN responses',
    why: 'Sustained NXDOMAIN means broken config or, in bulk from one host, malware cycling through generated domains.',
    field: 'dns_reply_code', agg: 'sum(iif(dns_reply_code==3,1,0))', filter: 'dns_reply_code==3',
  },
  {
    id: 'servfail', severity: 'high', category: 'Service health',
    title: 'DNS SERVFAIL responses',
    why: 'The resolver failed outright. Users experience this as a total outage of whatever they were trying to reach.',
    field: 'dns_reply_code', agg: 'sum(iif(dns_reply_code==2,1,0))', filter: 'dns_reply_code==2',
  },
  {
    id: 'udpcrc', severity: 'low', category: 'Wire health',
    title: 'UDP checksum errors',
    why: 'Corrupted datagrams. UDP will not retransmit, so this is silent data loss for whatever rides on it.',
    field: 'udp_wrong_crc', agg: 'sum(iif(udp_wrong_crc>0,1,0))', filter: 'udp_wrong_crc>0',
  },
  {
    id: 'ipcrc', severity: 'low', category: 'Wire health',
    title: 'IP header checksum errors',
    why: 'Corruption at the IP layer, typically the same underlying physical fault as TCP CRC errors.',
    field: 'ip_wrong_crc', agg: 'sum(iif(ip_wrong_crc>0,1,0))', filter: 'ip_wrong_crc>0',
  },
]

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * Brief for the Copilot investigation. We already know what fired, how often
 * and by which field — handing all of it over means the agent spends its first
 * step investigating rather than rediscovering the finding.
 */
function investigationPrompt(f: Finding & { count: number }, total: number, window: string): string {
  const rate = total > 0 ? `${((f.count / total) * 100).toFixed(2)}% of ${total.toLocaleString()} flows` : 'unknown share of flows'
  return [
    `Investigate a "${f.title}" finding in the Cribl Lake dataset "${LAKE_DATASET}" over the ${window}.`,
    `Detection: ${f.count.toLocaleString()} matching flows (${rate}).`,
    `Evidence field: ${f.field}. Matching filter: dataset="${LAKE_DATASET}" ${f.filter}`,
    `Why it matters: ${f.why}`,
    'This is Gigamon Application Metadata Intelligence (AMI) network-flow metadata — one record per flow, no payload.',
    'Please determine: which src_ip, dst_ip, ssl_server_name and app_name values are involved; whether the activity is concentrated on a few hosts or spread widely; whether it is steady or bursty over the window; and whether this looks expected or genuinely suspicious. Finish with a short recommendation.',
  ].join(' ')
}

const FINDINGS_QUERY = q(
  '| summarize total=count(), ' + FINDINGS.map((f, i) => `f${i}=${f.agg}`).join(', '),
)

export function Findings() {
  const { range } = useDashboard()
  const res = useSearch(FINDINGS_QUERY)
  const row = res.rows[0]

  const { hits, total, bySev } = useMemo(() => {
    const total = toNum(row?.total)
    const hits = FINDINGS
      .map((f, i) => ({ ...f, count: toNum(row?.[`f${i}`]) }))
      .filter((f) => f.count > 0)
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count)
    const bySev = (s: Severity) => hits.filter((h) => h.severity === s).length
    return { hits, total, bySev }
  }, [row])

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Findings</h2>
        <p className="tab-sub">
          Everything the feed says is wrong right now, ranked by severity — security exposures, wire faults and
          service failures in one pass. Each row names the AMI field that evidences it and drills straight into
          the matching flows in Cribl Search. Findings that match nothing are hidden, so this list is only ever
          things that are actually happening.
        </p>
      </div>

      <DatasetIntelPrompt />

      <div className="kpi-row kpi-row-4">
        <KpiTile label="Critical" value={res.loading ? '…' : String(bySev('critical'))} accent="danger"
          sub="immediate exposure" info="Findings judged to warrant immediate action — cleartext credentials or possible interception." query={FINDINGS_QUERY} />
        <KpiTile label="High" value={res.loading ? '…' : String(bySev('high'))} accent="warning"
          sub="investigate today" info="Covert channels, lateral-movement protocols, session theft risk and wire corruption." query={FINDINGS_QUERY} />
        <KpiTile label="Medium / low" value={res.loading ? '…' : String(bySev('medium') + bySev('low'))} accent="info"
          sub="baseline & monitor" info="Worth baselining — benign in many environments but the signal you need when it changes." query={FINDINGS_QUERY} />
        <KpiTile label="Flows analysed" value={res.loading ? '…' : fmtCount(total)} accent="neutral"
          sub="in the selected window" info="Total AMI flow records evaluated for every detection on this page." query={FINDINGS_QUERY} />
      </div>

      <Panel tourId="findings-list" title="Detections" query={FINDINGS_QUERY} onRefresh={res.refetch} refreshing={res.loading}
        info="Each detection is one aggregation over the window. Counts are flows matching the condition (for resets, the summed reset count). Severity is a fixed judgement about the class of issue, not a function of volume — a single cleartext-credential flow still matters."
        note={`${hits.length} of ${FINDINGS.length} detections firing`}>
        <QueryBoundary state={res} emptyLabel="No findings in this window">
          <ul className="find-list">
            {hits.map((f) => (
              <li key={f.id} className={`find-row find-${f.severity}`}>
                <span className={`find-sev find-sev-${f.severity}`}>{f.severity}</span>
                <span className="find-main">
                  <span className="find-title">{f.title}</span>
                  <span className="find-why">{f.why}</span>
                  <span className="find-meta">
                    <code>{f.field}</code>
                    <span className="find-cat">{f.category}</span>
                  </span>
                </span>
                <span className="find-right">
                  <span className="find-count">{fmtCount(f.count)}</span>
                  <span className="find-rate">{total > 0 ? `${fmtPct((f.count / total) * 100, 2)} of flows` : ''}</span>
                  <span className="find-actions">
                    <a className="find-ai" href={criblInvestigateUrl(investigationPrompt(f, total, range.label.toLowerCase()))}
                      target="_blank" rel="noopener noreferrer"
                      title="Open Cribl Search Copilot with this finding already briefed">✦ AI investigate</a>
                    <a className="find-open" href={searchUiUrl(q(`${f.filter} | limit 200`), range.earliest)}
                      target="_blank" rel="noopener noreferrer" title="Open the matching flows in Cribl Search">Flows ↗</a>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </Panel>
    </div>
  )
}
