// The detection catalog the Findings tab evaluates in one pass.
//
// It lives here, in a plain data module with no React imports, so the query
// freeze can load it under Node: FINDINGS_QUERY names its output columns
// f0..fN from this array's ORDER, so reordering entries or editing an `agg`
// silently rewrites the query. The tab imports it back to render the rows.

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type Category = 'Security' | 'Wire health' | 'Service health'

export interface Finding {
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
export const FINDINGS: Finding[] = [
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
