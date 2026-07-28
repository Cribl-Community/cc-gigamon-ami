// Curated catalog of KEY Gigamon Application Metadata Intelligence (AMI) fields.
//
// Gigamon AMI can export up to ~6,000 attributes across 4,000+ apps; the full
// per-field spec lives in the gated GigaVUE-FM Application Protobook. This is a
// curated set of the fields that matter for NPM / SecOps dashboards, grounded in
// Gigamon's public docs + the reference "Gigamon NPM" dashboard. At runtime the
// Field Explorer compares this catalog to the fields actually present in the feed
// and flags what's MISSING (and what we derive as a workaround).
//
// Sources:
//   docs.gigamon.com/ami · Application Metadata Intelligence (GigaSMART)
//   gigamon.com · Application Metadata Intelligence datasheet
//   Reference "Gigamon NPM" Splunk dashboard (fields it consumes)

export interface AmiField {
  /** Canonical AMI field name (feed snake_case convention). */
  name: string
  family: string
  desc: string
  /** What this attribute enables (use case). */
  useCase: string
  /** If the raw AMI field isn't in the feed, the field we derive in the pipeline as an equivalent. */
  derivedField?: string
  /** DPI attribute only available on decrypted traffic. */
  requiresDecrypt?: boolean
}

export const AMI_FAMILIES = [
  'Core / 5-tuple',
  'TCP / network performance',
  'HTTP',
  'DNS',
  'SSL / TLS',
  'Cloud & k8s enrichment',
  'Other protocols',
] as const

export const AMI_CATALOG: AmiField[] = [
  // ---- Core / 5-tuple ----
  { name: 'app_name', family: 'Core / 5-tuple', desc: 'Classified application/service on the flow.', useCase: 'App discovery, shadow-AI/SaaS, per-app analytics.' },
  { name: 'app_id', family: 'Core / 5-tuple', desc: 'Numeric application id.', useCase: 'App classification.' },
  { name: 'protocol', family: 'Core / 5-tuple', desc: 'IP protocol number (6 TCP, 17 UDP, 1 ICMP).', useCase: 'L4 protocol mix.' },
  { name: 'src_ip', family: 'Core / 5-tuple', desc: 'Source IP address.', useCase: 'Top talkers, service identity.' },
  { name: 'dst_ip', family: 'Core / 5-tuple', desc: 'Destination IP address.', useCase: 'Top talkers, dependency edges.' },
  { name: 'src_port', family: 'Core / 5-tuple', desc: 'Source L4 port.', useCase: 'Flow identity.' },
  { name: 'dst_port', family: 'Core / 5-tuple', desc: 'Destination L4 port.', useCase: 'Service identity.' },
  { name: 'src_bytes', family: 'Core / 5-tuple', desc: 'Bytes sent by the source.', useCase: 'Traffic out, capacity.' },
  { name: 'dst_bytes', family: 'Core / 5-tuple', desc: 'Bytes received by the destination.', useCase: 'Traffic in, capacity.' },
  { name: 'src_packets', family: 'Core / 5-tuple', desc: 'Packets from the source.', useCase: 'Packet counts.' },
  { name: 'dst_packets', family: 'Core / 5-tuple', desc: 'Packets to the destination.', useCase: 'Packet counts.' },
  { name: 'vlan_id', family: 'Core / 5-tuple', desc: 'IEEE 802.1Q VLAN tag.', useCase: 'Per-VLAN segmentation & path attribution (the reference dashboard notes "no vlan in feed").' },

  // ---- TCP / network performance ----
  { name: 'tcp_rtt', family: 'TCP / network performance', desc: 'TCP round-trip time — user↔network latency.', useCase: 'Network latency domain; exonerate the network.' },
  { name: 'tcp_rtt_app', family: 'TCP / network performance', desc: 'Application response time (server think-time).', useCase: 'Application latency domain — the usual culprit.' },
  { name: 'http_rtt', family: 'TCP / network performance', desc: 'HTTP/server round-trip time.', useCase: 'Server latency domain in the four-domain triage.', derivedField: 'http_server_ms' },
  { name: 'tcp_retransmission_bytes', family: 'TCP / network performance', desc: 'Retransmitted bytes on the flow.', useCase: 'Retransmit % / wire-error heatmap; packet-loss evidence.', derivedField: 'tcp_dup_ack' },
  { name: 'tcp_flag_reset', family: 'TCP / network performance', desc: 'Count of TCP RST (connection reset) flags.', useCase: 'Reset heatmap; abrupt-close detection.', derivedField: 'tcp_reset' },
  { name: 'tcp_dup_ack', family: 'TCP / network performance', desc: 'Duplicate ACKs — a retransmission signal.', useCase: 'Packet-health evidence.' },
  { name: 'tcp_loss_count', family: 'TCP / network performance', desc: 'Detected lost segments.', useCase: 'Loss heatmap.' },
  { name: 'tcp_wrong_crc', family: 'TCP / network performance', desc: 'Checksum errors (corruption on the wire).', useCase: 'Wire-error evidence.' },
  { name: 'tcp_flags', family: 'TCP / network performance', desc: 'TCP flags bitmask.', useCase: 'Derive resets and other flag states.' },
  { name: 'tcp_window_size', family: 'TCP / network performance', desc: 'TCP receive window size.', useCase: 'Flow-control / throughput analysis.' },
  { name: 'tcp_zero_window', family: 'TCP / network performance', desc: 'Zero-window events (receiver stalled).', useCase: 'Receiver-side backpressure detection.' },

  // ---- HTTP ----
  { name: 'http_host', family: 'HTTP', desc: 'HTTP Host header.', useCase: 'App/endpoint identity.' },
  { name: 'http_uri', family: 'HTTP', desc: 'Requested URI/path.', useCase: 'Endpoint / API analytics.' },
  { name: 'http_method', family: 'HTTP', desc: 'HTTP method (GET/POST/…).', useCase: 'API usage.' },
  { name: 'http_code', family: 'HTTP', desc: 'HTTP response status code.', useCase: 'Error-rate (4xx/5xx) monitoring.' },
  { name: 'http_user_agent', family: 'HTTP', desc: 'Client user-agent string.', useCase: 'Client/device fingerprinting.' },
  { name: 'http_content_type', family: 'HTTP', desc: 'Response content type.', useCase: 'Payload classification.' },
  { name: 'http_request_ts', family: 'HTTP', desc: 'Request timestamp (server-timing source).', useCase: 'Derive server response time.' },
  { name: 'http_response_ts', family: 'HTTP', desc: 'Response timestamp (server-timing source).', useCase: 'Derive server response time.' },
  { name: 'http_referer', family: 'HTTP', desc: 'HTTP Referer header.', useCase: 'Traffic-source attribution, referrer-leak detection.' },
  { name: 'http_cookie', family: 'HTTP', desc: 'HTTP Cookie header.', useCase: 'Session tracking (cleartext-cookie risk).' },
  { name: 'http_server', family: 'HTTP', desc: 'Server response header (software/version).', useCase: 'Version-disclosure / vulnerable-server discovery.' },
  { name: 'http_version', family: 'HTTP', desc: 'HTTP protocol version.', useCase: 'Protocol-mix / legacy-HTTP analysis.' },

  // ---- DNS ----
  { name: 'dns_query', family: 'DNS', desc: 'Queried name.', useCase: 'Resolver analytics, exfil detection.' },
  { name: 'dns_host', family: 'DNS', desc: 'Resolver host / answering server.', useCase: 'Per-resolver health.' },
  { name: 'dns_reply_code', family: 'DNS', desc: 'Reply code (0 NoError, 2 SERVFAIL, 3 NXDOMAIN).', useCase: 'DNS error rate, rogue-resolver detection.' },
  { name: 'dns_response_time', family: 'DNS', desc: 'DNS response latency.', useCase: 'DNS latency domain.' },
  { name: 'dns_query_type', family: 'DNS', desc: 'Query type (A/AAAA/…).', useCase: 'Record-type analytics.' },
  { name: 'dns_ttl', family: 'DNS', desc: 'Answer TTL.', useCase: 'Cache-behavior analysis.' },
  { name: 'dns_host_addr', family: 'DNS', desc: 'Resolved address.', useCase: 'Name→IP mapping.' },
  { name: 'dns_ancount', family: 'DNS', desc: 'Answer record count.', useCase: 'DNS tunneling / data-exfil detection.' },
  { name: 'dns_arcount', family: 'DNS', desc: 'Additional record count.', useCase: 'Anomalous-response detection.' },
  { name: 'dns_reverse_addr', family: 'DNS', desc: 'PTR reverse-lookup address.', useCase: 'Reverse-DNS enrichment.' },

  // ---- SSL / TLS ----
  { name: 'ssl_server_name', family: 'SSL / TLS', desc: 'SNI server name.', useCase: 'Per-server TLS posture.' },
  { name: 'ssl_issuer', family: 'SSL / TLS', desc: 'Certificate issuer (CA).', useCase: 'Unknown-CA / self-signed detection.' },
  { name: 'ssl_common_name', family: 'SSL / TLS', desc: 'Certificate subject CN.', useCase: 'Cert identity.' },
  { name: 'ssl_protocol_version', family: 'SSL / TLS', desc: 'Negotiated TLS/SSL version.', useCase: 'Weak-protocol detection.' },
  { name: 'ssl_validity_not_after', family: 'SSL / TLS', desc: 'Certificate expiry date.', useCase: 'Expiry / renewal alerting.' },
  { name: 'ssl_validity_not_before', family: 'SSL / TLS', desc: 'Certificate start date.', useCase: 'Validity window.' },
  { name: 'ssl_serial_number', family: 'SSL / TLS', desc: 'Certificate serial number.', useCase: 'Cert fingerprinting.' },
  { name: 'ssl_cipher_suite_id', family: 'SSL / TLS', desc: 'Negotiated cipher suite.', useCase: 'Weak-cipher detection.' },
  { name: 'ssl_alert_level', family: 'SSL / TLS', desc: 'TLS alert level (2 = fatal / handshake failing).', useCase: 'TLS-outage epicenter on the service map.' },
  { name: 'ssl_alert_description', family: 'SSL / TLS', desc: 'TLS alert reason code.', useCase: 'Root-cause of handshake failures.' },
  { name: 'ssl_ja3', family: 'SSL / TLS', desc: 'JA3 TLS client fingerprint (hash of ClientHello params).', useCase: 'Threat hunting / malware C2 identification without decryption (JA4 is the modern successor).' },
  { name: 'ssl_ja3s', family: 'SSL / TLS', desc: 'JA3S TLS server fingerprint (hash of ServerHello params).', useCase: 'Pair with JA3 to fingerprint client↔server sessions.' },
  { name: 'ssl_mitm_score', family: 'SSL / TLS', desc: 'TLS interception / man-in-the-middle likelihood score.', useCase: 'Detect TLS interception / inspection proxies.' },
  { name: 'ssl_certif_sha1', family: 'SSL / TLS', desc: 'Certificate SHA-1 fingerprint.', useCase: 'Cert allow/deny-listing, known-bad cert detection.' },
  { name: 'ssl_subject_alt_name', family: 'SSL / TLS', desc: 'Certificate Subject Alternative Names.', useCase: 'Cert scope / mis-issuance detection.' },
  { name: 'ssl_certificate_subject_key_size', family: 'SSL / TLS', desc: 'Public-key size (bits).', useCase: 'Weak-key (<2048-bit RSA) detection.' },
  { name: 'ssl_cipher_suite_list', family: 'SSL / TLS', desc: 'Cipher suites offered in the ClientHello.', useCase: 'Weak-cipher offering / client capability.' },
  { name: 'ssl_ext_ec_supported_groups_type', family: 'SSL / TLS', desc: 'TLS supported-groups (key-exchange) code offered in the ClientHello.', useCase: 'Post-quantum readiness — classical (x25519/secp256r1) vs hybrid ML-KEM.' },
  { name: 'ssl_server_supported_version', family: 'SSL / TLS', desc: 'Negotiated TLS version code (772 = TLS 1.3).', useCase: 'TLS 1.3 adoption — the floor for PQC key exchange.' },
  { name: 'ssl_client_supported_version', family: 'SSL / TLS', desc: 'TLS versions the client offered (supported_versions extension).', useCase: 'Client capability / downgrade analysis.' },
  { name: 'ssl_certificate_subject_key_algo_oid', family: 'SSL / TLS', desc: 'Certificate public-key algorithm OID (RSA / ECDSA).', useCase: 'Signature/PKI track — classical signatures are a later PQC migration (ML-DSA).' },

  // ---- Cloud & k8s enrichment ----
  { name: 'dst_aws_instance_id', family: 'Cloud & k8s enrichment', desc: 'AWS instance id of the destination.', useCase: 'Cloud workload identity.' },
  { name: 'dst_aws_vpc_id', family: 'Cloud & k8s enrichment', desc: 'Destination AWS VPC.', useCase: 'Segmentation analytics.' },
  { name: 'dst_aws_flat_tags_name', family: 'Cloud & k8s enrichment', desc: 'Destination workload Name tag.', useCase: 'Service identity on the map.' },
  { name: 'dst_aws_flat_tags_service_type', family: 'Cloud & k8s enrichment', desc: 'Destination service-type tag.', useCase: 'Service classification.' },
  { name: 'dst_k8s_pod_name', family: 'Cloud & k8s enrichment', desc: 'Kubernetes pod name of the destination.', useCase: 'Pod-level service identity (reference triage).' },
  { name: 'src_k8s_pod_name', family: 'Cloud & k8s enrichment', desc: 'Kubernetes pod name of the source.', useCase: 'Pod-level caller identity.' },
  { name: 'k8s_namespace', family: 'Cloud & k8s enrichment', desc: 'Kubernetes namespace.', useCase: 'Namespace segmentation.' },
  { name: 'k8s_container_name', family: 'Cloud & k8s enrichment', desc: 'Kubernetes container name.', useCase: 'Container-level attribution.' },

  // ---- Other protocols ----
  { name: 'snmp_oid', family: 'Other protocols', desc: 'SNMP object identifier.', useCase: 'Management-plane visibility.' },
  { name: 'snmp_community', family: 'Other protocols', desc: 'SNMP community string (often cleartext).', useCase: 'Cleartext-credential / weak-community exposure.' },
  { name: 'snmp_processing_anomaly_type', family: 'Other protocols', desc: 'SNMP protocol-processing anomaly.', useCase: 'Malformed-SNMP / abuse detection.' },
  { name: 'ssh_version', family: 'Other protocols', desc: 'SSH protocol version.', useCase: 'Weak-SSH detection.' },
  { name: 'ssh_tsp_alg_encrypt_cts', family: 'Other protocols', desc: 'Negotiated SSH encryption algorithm (client→server).', useCase: 'Weak-cipher / deprecated-crypto detection.' },
  { name: 'ssh_server_agent', family: 'Other protocols', desc: 'SSH server banner/version.', useCase: 'Vulnerable-SSH-server discovery.' },
  { name: 'dhcp_message_type', family: 'Other protocols', desc: 'DHCP message type.', useCase: 'Rogue-DHCP detection.' },
  { name: 'dhcp_host_name', family: 'Other protocols', desc: 'DHCP client hostname.', useCase: 'Device inventory / asset identity.' },
  { name: 'dhcp_yiaddr', family: 'Other protocols', desc: 'DHCP assigned (your) IP address.', useCase: 'IP↔device attribution.' },
  { name: 'krb5_realm', family: 'Other protocols', desc: 'Kerberos realm.', useCase: 'AuthN visibility.' },
  { name: 'krb5_message_type', family: 'Other protocols', desc: 'Kerberos message type (AS/TGS/…).', useCase: 'Kerberoasting / auth-abuse detection.' },
  { name: 'dcerpc_service', family: 'Other protocols', desc: 'DCE/RPC (MSRPC) service.', useCase: 'Lateral-movement / remote-exec detection.' },
  { name: 'rtp_codec_name', family: 'Other protocols', desc: 'RTP audio/video codec.', useCase: 'VoIP/media session analytics.' },
  { name: 'rtp_lost', family: 'Other protocols', desc: 'RTP packets lost.', useCase: 'VoIP quality (MOS) / call-degradation.' },
  { name: 'rtp_service', family: 'Other protocols', desc: 'RTP media service/stream identifier.', useCase: 'Per-stream VoIP/media session tracking.' },
  { name: 'icmp_type', family: 'Other protocols', desc: 'ICMP message type.', useCase: 'Reachability / scanning.' },
  { name: 'icmp_tunneling', family: 'Other protocols', desc: 'ICMP-tunneling indicator.', useCase: 'Covert-channel / exfil detection.' },
  { name: 'sip_from', family: 'Other protocols', desc: 'SIP From header (caller identity).', useCase: 'VoIP call attribution; VoIP recon-tool signatures (e.g. SIPVicious scans).' },
  { name: 'sip_contact', family: 'Other protocols', desc: 'SIP Contact URI (signaling endpoint).', useCase: 'Call-signaling endpoint identity; toll-fraud / spoofing analysis.' },
  { name: 'sip_callee_domain', family: 'Other protocols', desc: 'SIP callee (destination) domain.', useCase: 'Call routing and toll-fraud analysis.' },
]

// ---------------------------------------------------------------------------
// Use-case catalog: groups the fields above by the analytics use case they
// serve (a field can serve several). Referenced by the Field Explorer's
// "By use case" view to show which use cases this feed can support.
// ---------------------------------------------------------------------------
export interface UseCase {
  name: string
  desc: string
  fields: string[]
}

export const AMI_USE_CASES: UseCase[] = [
  // ---- Primary use cases (the core analytics this feed powers) ----
  {
    name: 'AI App governance',
    desc: 'Discover and govern GenAI / SaaS usage on the wire — which AI apps, who is using them, and where the data flows — with no agents and no decryption.',
    fields: ['app_name', 'app_id', 'ssl_server_name', 'http_host', 'http_uri', 'http_user_agent', 'http_referer', 'dns_query', 'dns_host', 'src_ip'],
  },
  {
    name: 'Security',
    desc: 'Threat detection from encrypted-traffic fingerprints, weak crypto, cleartext credentials, tunneling, lateral movement and VoIP recon — no decryption required.',
    fields: ['ssl_ja3', 'ssl_ja3s', 'ssl_mitm_score', 'ssl_alert_level', 'ssl_issuer', 'ssl_cipher_suite_list', 'snmp_community', 'icmp_tunneling', 'dcerpc_service', 'krb5_message_type', 'ssh_tsp_alg_encrypt_cts', 'dns_ancount', 'http_server', 'sip_from'],
  },
  {
    name: 'NetOps — Performance',
    desc: 'Latency decomposition, retransmissions, loss and capacity — where the time goes and whether it is the network.',
    fields: ['tcp_rtt', 'tcp_rtt_app', 'http_rtt', 'dns_response_time', 'tcp_retransmission_bytes', 'tcp_flag_reset', 'tcp_dup_ack', 'tcp_loss_count', 'tcp_wrong_crc', 'tcp_window_size', 'tcp_zero_window', 'rtp_lost', 'src_bytes', 'dst_bytes'],
  },
  {
    name: 'Compliance',
    desc: 'Crypto & data-handling posture for PCI-DSS / HIPAA-style controls — deprecated TLS, weak ciphers & keys, expired / untrusted certs, cleartext credentials, and segmentation.',
    fields: ['ssl_protocol_version', 'ssl_cipher_suite_id', 'ssl_validity_not_after', 'ssl_certificate_subject_key_size', 'ssl_issuer', 'ssl_subject_alt_name', 'ssh_tsp_alg_encrypt_cts', 'snmp_community', 'http_cookie', 'vlan_id'],
  },

  // ---- Supporting / granular use cases ----
  {
    name: 'Post-quantum (PQC) readiness',
    desc: 'Which TLS sessions still rely on classical key exchange that a quantum computer breaks, vs hybrid ML-KEM — the harvest-now-decrypt-later exposure. Grounded in ClientHello handshake metadata (offered capability).',
    fields: ['ssl_ext_ec_supported_groups_type', 'ssl_server_supported_version', 'ssl_client_supported_version', 'ssl_protocol_version', 'ssl_cipher_suite_id', 'ssl_certificate_subject_key_algo_oid', 'ssl_server_name'],
  },
  {
    name: 'DNS health',
    desc: 'Per-resolver latency, reply codes and tunneling signals.',
    fields: ['dns_query', 'dns_host', 'dns_reply_code', 'dns_response_time', 'dns_query_type', 'dns_ttl', 'dns_ancount', 'dns_arcount', 'dns_reverse_addr'],
  },
  {
    name: 'TLS / certificate posture',
    desc: 'Certificate validity, issuer trust, protocol/cipher strength and interception.',
    fields: ['ssl_server_name', 'ssl_issuer', 'ssl_common_name', 'ssl_protocol_version', 'ssl_validity_not_after', 'ssl_validity_not_before', 'ssl_serial_number', 'ssl_cipher_suite_id', 'ssl_certif_sha1', 'ssl_subject_alt_name', 'ssl_certificate_subject_key_size', 'ssl_ja3', 'ssl_ja3s', 'ssl_mitm_score'],
  },
  {
    name: 'Capacity & top talkers',
    desc: 'Volume by entity for capacity planning and utilization.',
    fields: ['src_ip', 'dst_ip', 'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets', 'protocol', 'src_port', 'dst_port', 'vlan_id'],
  },
  {
    name: 'Cloud & container context',
    desc: 'Map flows to cloud workloads and Kubernetes identity for service-level views.',
    fields: ['dst_aws_instance_id', 'dst_aws_vpc_id', 'dst_aws_flat_tags_name', 'dst_aws_flat_tags_service_type', 'dst_k8s_pod_name', 'src_k8s_pod_name', 'k8s_namespace', 'k8s_container_name'],
  },
  {
    name: 'Media / VoIP quality',
    desc: 'Real-time media stream quality plus SIP call signaling — codec, packet loss, and caller/callee identity (video-quality monitoring is a documented AMI template).',
    fields: ['rtp_codec_name', 'rtp_lost', 'rtp_service', 'sip_from', 'sip_contact', 'sip_callee_domain'],
  },
  {
    name: 'Identity & asset inventory',
    desc: 'Device and user attribution from DHCP, Kerberos and management protocols.',
    fields: ['dhcp_host_name', 'dhcp_yiaddr', 'dhcp_message_type', 'krb5_realm', 'krb5_message_type', 'snmp_community', 'ssh_server_agent'],
  },
]
