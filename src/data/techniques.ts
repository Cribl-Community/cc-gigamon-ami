// The ATT&CK techniques the Security tab evaluates.
//
// It lives here, in a plain data module with no React imports, so the query
// freeze can load it under Node: COUNTS names one `c_<id>` column per
// flow-signal entry and the tiles read those same names back, so editing an
// `id` or an `expr` — or reordering the array — silently rewrites the query.
// The tab imports it back to render the tiles.

export type Tactic = 'Discovery' | 'Lateral Movement' | 'Credential Access' | 'Command & Control' | 'Impact'

export interface Technique {
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
export const TECHNIQUES: Technique[] = [
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
