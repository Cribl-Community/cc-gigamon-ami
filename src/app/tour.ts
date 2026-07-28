/**
 * Persona-based guided tours.
 *
 * Four personas matching the Cribl + Gigamon workshop pillars: NetOps
 * (Performance), Security, AI App governance and Compliance. Each is a short
 * itinerary through panels that already exist — including the honest gaps,
 * which are often the most instructive stops.
 *
 * `target` is a `data-tour` anchor (see Panel's tourId prop). A step with no
 * target just navigates; the strip text carries the instruction.
 */
export interface TourStep {
  route: string
  /** data-tour anchor to scroll to and outline. */
  target?: string
  title: string
  body: string
  /** Concrete thing to look at on screen. */
  look?: string
}

export interface Persona {
  id: string
  name: string
  role: string
  question: string
  steps: TourStep[]
}

export const PERSONAS: Persona[] = [
  {
    id: 'netops',
    name: 'Network Engineer',
    role: 'NetOps · Performance',
    question: 'Something is slow — is it the network?',
    steps: [
      {
        route: '/service-map',
        target: 'service-graph',
        title: 'Start at the epicenters',
        body: 'Service-to-service dependencies built purely from flow metadata — no agent, no sidecar, no eBPF. Node colour is health; size is flow volume.',
        look: 'Red nodes pulse: >90% resets or 3x the latency SLO. Dashed grey spokes are traffic to peers with no AWS name tag.',
      },
      {
        route: '/service-map',
        target: 'service-graph',
        title: 'Drill a breaching service',
        body: 'Click any red node. That opens the four latency domains — network, application, server and DNS — each scored independently at p95 against its own SLO, never averaged.',
        look: 'Compare tcp_rtt (network) against tcp_rtt_app (application). This is the split that settles the argument.',
      },
      {
        route: '/service-map',
        title: 'Read the verdict',
        body: 'Below the domains, the triage table joins packet evidence per flow id: retransmits, resets, dup-acks and wrong-CRC counts.',
        look: 'When the network counters are clean, the callout states that NetOps is exonerated and names which domain actually owns the time.',
      },
      {
        route: '/tcp-health',
        target: 'tcp-heatmap',
        title: 'Prove it on the wire',
        body: 'Per-flow retransmit, reset, loss and CRC rates across source x destination subnets. Rates, not raw counts, so a busy subnet is not automatically the worst.',
        look: 'Hot cells localise wire problems to a subnet pair. Click one to open those endpoints in Cribl Search.',
      },
      {
        route: '/tcp-health',
        target: 'tcp-latency',
        title: 'Network vs application latency',
        body: 'p95 tcp_rtt against tcp_rtt_app on a log axis with a min-max band, so both scales stay readable.',
        look: 'A flat network line under a climbing app line is the classic "not the network" signature.',
      },
      {
        route: '/dns-health',
        target: 'dns-resolvers',
        title: 'Do not forget DNS',
        body: 'DNS is the fourth latency domain and a frequent hidden cause. Per-resolver p50/p95 and reply-code mix across all 12,131 resolvers in this feed.',
        look: 'Slow or SERVFAIL-heavy resolvers surface here long before users describe it as "the network being slow".',
      },
    ],
  },
  {
    id: 'security',
    name: 'Security Analyst',
    role: 'SecOps · Threat detection',
    question: 'What is risky on the wire — without decrypting anything?',
    steps: [
      {
        route: '/security',
        target: 'mitre-tactics',
        title: 'Start at the ATT&CK board',
        body: 'Threat techniques mapped to MITRE ATT&CK, entirely from network metadata — no endpoint agent. The tactic summary rolls events up by tactic; the tiles below are individual techniques, risk-scored.',
        look: 'Detection is by application classification and protocol metadata, not port numbers — dcerpc_service was seen on port 5003, not 135. An attacker on a non-standard port is still caught.',
      },
      {
        route: '/security',
        target: 'mitre-grid',
        title: 'Drill a technique to its flows',
        body: 'Click any technique tile — SSH remote services, MSRPC lateral tooling, protocol tunneling, cleartext SNMP creds — to see the exact src→dst flows behind it, then pivot to Cribl Search.',
        look: 'The “Not observable in this feed” list under the grid is honest about what this capture cannot detect (crypto mining, RDP, C2 beaconing) rather than faking tiles.',
      },
      {
        route: '/tls-posture',
        target: 'tls-servers',
        title: 'Encrypted does not mean safe',
        body: 'Every TLS server seen on the wire, worst-first: negotiated version, issuer, days to expiry and a posture badge — all from handshake metadata, no decryption.',
        look: 'Unknown-CA and self-signed certs are flagged by checking issuers against a known public-CA list.',
      },
      {
        route: '/ai-saas',
        target: 'ai-apps',
        title: 'Find shadow AI',
        body: 'GenAI and SaaS applications classified from the wire, ranked by flows, with the number of distinct internal users reaching each.',
        look: 'Sanctioned and unsanctioned tools appear side by side — nobody had to install an agent for this to show up.',
      },
      {
        route: '/ai-saas',
        target: 'ai-users',
        title: 'Who is doing it',
        body: 'Internal source IPs driving the most AI traffic, and how many distinct AI apps each one reached.',
        look: 'High app-diversity from one host is the shadow-AI signal worth chasing.',
      },
      {
        route: '/dns-health',
        target: 'dns-resolvers',
        title: 'DNS as an exfil channel',
        body: 'Reply codes, answer counts and per-resolver behaviour. Rogue resolvers and tunneling patterns both surface here.',
        look: 'Unexpected resolvers and abnormal answer-count distributions are the tells.',
      },
      {
        route: '/pqc',
        target: 'pqc-worklist',
        title: 'Post-quantum exposure',
        body: 'The same TLS handshakes reveal which sessions still use classical key exchange (x25519 / secp256r1) a future quantum computer breaks, versus hybrid ML-KEM. Classical sessions to sensitive destinations are the harvest-now-decrypt-later backlog.',
        look: 'The worklist splits servers into classical-only (remediate) vs PQC-capable. This is capability offered — the feed carries no negotiated-group field, so "downgraded" is not derivable, and the tour says so.',
      },
      {
        route: '/fields?view=usecase',
        target: 'uc-security',
        title: 'The security field inventory — and an honest gap',
        body: 'The Security pillar, scored against this feed. Cleartext SNMP community strings, ICMP tunneling, DCE/RPC lateral movement and a SIPVicious VoIP recon signature are all present in this feed.',
        look: 'ssl_ja3 and ssl_ja3s show MISSING — this AMX export does not carry JA3/JA3S fingerprints. Gigamon can emit them; this capture did not. Knowing what you cannot do matters as much as what you can.',
      },
    ],
  },
  {
    id: 'ai-gov',
    name: 'AI Governance Lead',
    role: 'AI App governance',
    question: 'Which AI apps are in use, by whom, and where does the data go?',
    steps: [
      {
        route: '/ai-saas',
        target: 'ai-apps',
        title: 'Discover AI usage on the wire',
        body: 'GenAI/LLM applications identified from traffic metadata — no endpoint agent, no browser extension, no proxy required.',
        look: 'This is discovery without deployment: the packet broker already sees it.',
      },
      {
        route: '/ai-saas',
        target: 'ai-users',
        title: 'Attribute it to users',
        body: 'Which internal hosts are driving AI traffic, and how broadly each one is spreading across different AI services.',
        look: 'App-diversity per host tells you who is experimenting versus who has standardised.',
      },
      {
        route: '/capacity',
        target: 'cap-talkers',
        title: 'Quantify the exposure',
        body: 'Pivot to App to rank applications by bytes. Volume is a reasonable proxy for how much data is actually leaving via each tool.',
        look: 'Click a row to scope the whole view to that application.',
      },
      {
        route: '/tls-posture',
        target: 'tls-servers',
        title: 'Where the data is going',
        body: 'SNI server names reveal the destination of encrypted AI traffic even though the payload stays private.',
        look: 'Destination plus volume is usually enough for a governance conversation.',
      },
      {
        route: '/fields?view=usecase',
        target: 'uc-ai-app-governance',
        title: 'The fields behind it',
        body: 'The AI App governance pillar: app_name, ssl_server_name, http_host/uri, user-agent, referer and dns_query.',
        look: 'All present in this feed — this pillar is fully supported by the data.',
      },
    ],
  },
  {
    id: 'compliance',
    name: 'Compliance Auditor',
    role: 'Compliance · Crypto posture',
    question: 'Can I evidence crypto and data-handling controls from the network?',
    steps: [
      {
        route: '/tls-posture',
        target: 'tls-servers',
        title: 'Crypto posture, server by server',
        body: 'Negotiated protocol version, cipher suite, certificate issuer and expiry — the raw material for PCI-DSS/HIPAA-style crypto controls. Each row also carries a key-exchange tag: classical vs PQC.',
        look: 'Use “Quantum-unsafe KEX only” to isolate servers on classical key exchange — the post-quantum remediation list.',
      },
      {
        route: '/pqc',
        target: 'pqc-groups',
        title: 'Post-quantum migration mandate',
        body: 'NIST FIPS 203 / CNSA 2.0 and US EO 14144 (TLS 1.3 by 2030) make PQC migration a compliance item, not just security. The readiness score composites TLS 1.3 adoption, hybrid ML-KEM offered, and server coverage.',
        look: 'The key-exchange breakdown shows exactly which named groups are on the wire — classical x25519/secp256r1 vs hybrid X25519Kyber768.',
      },
      {
        route: '/fields?view=usecase',
        target: 'uc-compliance',
        title: 'The compliance field set',
        body: 'The Compliance pillar: ssl_protocol_version, ssl_cipher_suite_id, ssl_validity_not_after, certificate key size and subject-alt-name.',
        look: 'Key size and validity dates let you evidence weak-key and expired-cert controls directly from the wire.',
      },
      {
        route: '/fields?view=usecase',
        target: 'uc-compliance',
        title: 'Cleartext credential exposure',
        body: 'Still in Compliance: snmp_community appears in thousands of records, and http_cookie is carried in cleartext where TLS is not used.',
        look: 'These are findings, not just fields — cleartext community strings are a real audit item.',
      },
      {
        route: '/fields?view=usecase',
        target: 'uc-compliance',
        title: 'And the gap you must declare',
        body: 'vlan_id shows MISSING. Segmentation evidence by VLAN is not available from this export.',
        look: 'An honest control gap is far more useful to an auditor than a confident wrong answer.',
      },
      {
        route: '/data-flow',
        target: 'data-flow',
        title: 'Chain of custody',
        body: 'Where the evidence lives: source, pipeline, destination and Lake dataset, with volumes from Cribl component telemetry and a 30-day retention window.',
        look: 'Each stage has an ⓘ that links straight to that object in Cribl — useful when an auditor asks "show me".',
      },
    ],
  },
]
