// Post-Quantum Cryptography (PQC) classification for TLS handshake metadata.
//
// A cryptographically-relevant quantum computer running Shor's algorithm breaks
// the classical key-exchange behind virtually all TLS today (ECDHE over x25519 /
// secp256r1, finite-field DH). The mitigation is hybrid key exchange that adds a
// quantum-safe KEM (ML-KEM / Kyber) alongside the classical curve — NIST FIPS 203,
// CNSA 2.0, US EO 14144 (TLS 1.3 required by 2030).
//
// The AMI signal we have is `ssl_ext_ec_supported_groups_type`: the IANA numeric
// code(s) a session's ClientHello OFFERS. This tells us CAPABILITY (did the client
// offer a PQC group), NOT the negotiated outcome — the AMI export carries no clean
// server-selected-group field, so "capable-but-downgraded" is not derivable here.

export type KexClass = 'pqc' | 'classical' | 'grease' | 'other'

interface GroupInfo {
  name: string
  cls: KexClass
}

// IANA TLS Supported Groups (subset that appears on the wire in practice).
const GROUPS: Record<number, GroupInfo> = {
  23: { name: 'secp256r1', cls: 'classical' },
  24: { name: 'secp384r1', cls: 'classical' },
  25: { name: 'secp521r1', cls: 'classical' },
  29: { name: 'x25519', cls: 'classical' },
  30: { name: 'x448', cls: 'classical' },
  256: { name: 'ffdhe2048', cls: 'classical' },
  257: { name: 'ffdhe3072', cls: 'classical' },
  258: { name: 'ffdhe4096', cls: 'classical' },
  // Hybrid post-quantum key exchange (classical curve + ML-KEM / Kyber):
  25497: { name: 'X25519Kyber768', cls: 'pqc' }, // 0x6399 draft codepoint (Chrome/Cloudflare)
  4587: { name: 'SecP256r1MLKEM768', cls: 'pqc' }, // 0x11EB
  4588: { name: 'X25519MLKEM768', cls: 'pqc' }, // 0x11EC (final)
  4589: { name: 'SecP384r1MLKEM1024', cls: 'pqc' }, // 0x11ED
}

/** GREASE placeholders (RFC 8701): high byte == low byte and low nibble == 0xA. */
function isGrease(code: number): boolean {
  const hi = (code >> 8) & 0xff
  const lo = code & 0xff
  return hi === lo && (hi & 0x0f) === 0x0a
}

/** Human-readable IANA code strings (as stored) that mean "offered PQC". */
export const PQC_GROUP_CODES = Object.entries(GROUPS)
  .filter(([, g]) => g.cls === 'pqc')
  .map(([code]) => code)

export function classifyGroup(codeStr: string): GroupInfo {
  const code = Number(codeStr)
  if (!Number.isFinite(code)) return { name: codeStr, cls: 'other' }
  if (GROUPS[code]) return GROUPS[code]
  if (isGrease(code)) return { name: `GREASE 0x${code.toString(16)}`, cls: 'grease' }
  return { name: `group ${code}`, cls: 'other' }
}

// TLS version codes (ssl_*_supported_version / ssl_protocol_version).
const TLS_VERSIONS: Record<string, string> = {
  '772': 'TLS 1.3',
  '771': 'TLS 1.2',
  '770': 'TLS 1.1',
  '769': 'TLS 1.0',
  '768': 'SSL 3.0',
}
export function tlsVersionLabel(code: string): string {
  return TLS_VERSIONS[code] ?? (code ? `0x${Number(code).toString(16)}` : '—')
}
/** TLS 1.3 is the floor for negotiating PQC key exchange. */
export const TLS13_CODE = '772'

// ---------------------------------------------------------------------------
// Data-sensitivity heuristic. The reference dashboard tags each destination
// (PCI / credential / financial / PHI / business / public); real feeds have no
// such field, so we infer a coarse class from the SNI. This is a HEURISTIC for
// prioritisation, clearly labelled as such in the UI — not ground truth.
// ---------------------------------------------------------------------------
export type Sensitivity = 'credential' | 'pci' | 'financial' | 'phi' | 'business' | 'public'

const SENSITIVITY_RULES: Array<{ re: RegExp; s: Sensitivity }> = [
  { re: /(auth|identity|login|sso|oauth|token|cred|account)/i, s: 'credential' },
  { re: /(pay|payment|checkout|card|pci|billing)/i, s: 'pci' },
  { re: /(bank|finance|financial|invoice|ledger|trading)/i, s: 'financial' },
  { re: /(health|patient|clinic|medical|phi|ehr)/i, s: 'phi' },
  { re: /(cdn|assets|static|images|public|www\.|media)/i, s: 'public' },
]
export function sensitivityOf(sni: string): Sensitivity {
  for (const r of SENSITIVITY_RULES) if (r.re.test(sni)) return r.s
  return 'business'
}
/** Sensitivity classes that make classical KEX a harvest-now-decrypt-later priority. */
export const SENSITIVE: Sensitivity[] = ['credential', 'pci', 'financial', 'phi']
export const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  credential: 0, pci: 1, financial: 2, phi: 3, business: 4, public: 5,
}
