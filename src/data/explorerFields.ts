import { AMI_CATALOG, AMI_FAMILIES, type AmiField, type UseCase } from './amiFields'

// Input attributes in analytics queries, scheduled bodies and drill-downs.
// explorerFields.test.ts compares this list with the frozen query texts,
// excluding Explorer's own presence scans and offline/installation diagnostics.
export const APP_QUERY_FIELDS = [
  '_time', 'app_name', 'protocol', 'src_ip', 'dst_ip', 'dst_port',
  'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets',
  'tcp_rtt', 'tcp_rtt_app', 'tcp_dup_ack', 'tcp_loss_count', 'tcp_wrong_crc', 'tcp_flags', 'tcp_reset',
  'udp_wrong_crc', 'ip_wrong_crc',
  'http_host', 'http_code', 'http_rtt', 'http_cookie',
  'dns_query', 'dns_host', 'dns_reply_code', 'dns_response_time',
  'ssl_server_name', 'ssl_issuer', 'ssl_common_name', 'ssl_protocol_version',
  'ssl_validity_not_after', 'ssl_validity_not_before', 'ssl_cipher_suite_id', 'ssl_mitm_score',
  'ssl_ext_ec_supported_groups_type', 'ssl_server_supported_version',
  'snmp_community', 'snmp_processing_anomaly_type', 'krb5_message_type',
  'dcerpc_service', 'icmp_tunneling', 'sip_from', 'ftp_data_content',
] as const

const ADDITIONAL_FIELDS: AmiField[] = [
  { name: '_time', family: 'Core / 5-tuple', desc: 'Event timestamp used for time-window and trend queries.', useCase: 'Time-series analytics.' },
  { name: 'tcp_reset', family: 'TCP / network performance', desc: 'Persisted TCP reset indicator derived from the RST flag.', useCase: 'Reset findings, wire-health heatmaps and service triage.' },
  { name: 'udp_wrong_crc', family: 'TCP / network performance', desc: 'UDP checksum errors on the flow.', useCase: 'Wire-health findings.' },
  { name: 'ip_wrong_crc', family: 'TCP / network performance', desc: 'IP header checksum errors on the flow.', useCase: 'Wire-health findings.' },
  { name: 'ftp_data_content', family: 'Other protocols', desc: 'FTP data content attribute.', useCase: 'Cleartext FTP transfer findings.' },
]

export const EXPLORER_CATALOG: AmiField[] = APP_QUERY_FIELDS.map((name) => {
  const field = [...AMI_CATALOG, ...ADDITIONAL_FIELDS].find((f) => f.name === name)
  if (!field) throw new Error(`Missing Field Explorer definition for ${name}`)
  if (name !== 'http_rtt') return field
  // Queries read http_rtt itself; its derived http_server_ms is read by none.
  const { derivedField: _unused, ...rest } = field
  return { ...rest, family: 'HTTP', useCase: 'Web & API Health response RTT and the Flow Map HTTP RTT domain.' }
})

export const EXPLORER_FAMILIES = AMI_FAMILIES.filter((family) => EXPLORER_CATALOG.some((f) => f.family === family))

export const EXPLORER_USE_CASES: UseCase[] = [
  {
    name: 'AI App governance',
    desc: 'Application classification, source users and reported byte volumes used by the Shadow AI dashboard.',
    fields: ['app_name', 'src_ip', 'src_bytes', 'dst_bytes'],
  },
  {
    name: 'Security',
    desc: 'Flow-signal detections, source fan-out, service discovery and cleartext-protocol findings.',
    fields: ['app_name', 'src_ip', 'dst_ip', 'dst_port', 'ssl_mitm_score', 'snmp_community', 'snmp_processing_anomaly_type', 'icmp_tunneling', 'dcerpc_service', 'krb5_message_type', 'http_cookie', 'sip_from', 'ftp_data_content'],
  },
  {
    name: 'NetOps — Performance',
    desc: 'Latency decomposition, resets, duplicate ACKs, checksum errors and loss used by Flow Map and TCP Health.',
    fields: ['_time', 'tcp_rtt', 'tcp_rtt_app', 'http_rtt', 'dns_response_time', 'tcp_flags', 'tcp_reset', 'tcp_dup_ack', 'tcp_loss_count', 'tcp_wrong_crc', 'udp_wrong_crc', 'ip_wrong_crc'],
  },
  {
    name: 'Compliance',
    desc: 'Protocol versions, certificate validity and trust, cipher selection and cleartext credentials used by the app.',
    fields: ['ssl_protocol_version', 'ssl_cipher_suite_id', 'ssl_validity_not_after', 'ssl_validity_not_before', 'ssl_issuer', 'snmp_community', 'http_cookie'],
  },
  {
    name: 'Post-quantum (PQC) readiness',
    desc: 'Offered key-exchange groups and TLS 1.3 capability grouped by server and issuer.',
    fields: ['ssl_ext_ec_supported_groups_type', 'ssl_server_supported_version', 'ssl_server_name', 'ssl_issuer'],
  },
  {
    name: 'DNS health',
    desc: 'Per-resolver latency, reply-code health and queried names.',
    fields: ['app_name', 'dns_query', 'dns_host', 'dns_reply_code', 'dns_response_time'],
  },
  {
    name: 'TLS / certificate posture',
    desc: 'Server identity, certificate validity and issuer, protocol/cipher selection and interception findings.',
    fields: ['ssl_server_name', 'ssl_issuer', 'ssl_common_name', 'ssl_protocol_version', 'ssl_validity_not_after', 'ssl_validity_not_before', 'ssl_cipher_suite_id', 'ssl_mitm_score'],
  },
  {
    name: 'Capacity & top talkers',
    desc: 'Reported directional bytes and packets, application mix and transport protocol.',
    fields: ['_time', 'app_name', 'src_ip', 'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets', 'protocol', 'tcp_rtt', 'tcp_dup_ack'],
  },
  {
    name: 'Web & API health',
    desc: 'Host identity, response codes, HTTP timing and HTTP/2 application classification.',
    fields: ['_time', 'app_name', 'http_host', 'http_code', 'http_rtt'],
  },
  {
    name: 'Data Flow volume',
    desc: 'Bytes and packets in both directions, summed for the Data Flow Network Traffic figure.',
    fields: ['src_bytes', 'dst_bytes', 'src_packets', 'dst_packets'],
  },
]
