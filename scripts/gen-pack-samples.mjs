// Generate the synthetic Gigamon AMI samples the pack's DataGen replays.
//
//   npm run pack:samples                          rewrite data/samples/*.json and default/samples.yml
//   node scripts/gen-pack-samples.mjs --check     regenerate in memory and byte-compare; exit 1 on any difference
//
// WHY GENERATED, AND NOT COPIED. The repository is public. The workspace's own
// demo samples have no recorded provenance or licence, so none of them are
// committed. Every event below is made up here, from a fixed seed, so the
// output is the same on every machine and CI can prove it (the --check mode,
// run by src/cribl/packSamples.test.ts).
//
// ADDRESSES AND NAMES. Internal hosts are in 10.20.0.0/16, which is private
// address space and identifies no one. It has to be private: Security's Lateral
// Spread tile counts only RFC 1918 sources. External peers use only the
// documentation ranges 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24, and
// every hostname is under example.com, example.net or example.org. `app_name`
// keeps the real classification label (openai, office365, ...), because the
// Shadow AI tab's queries match on it.
//
// WHAT AN EVENT LOOKS LIKE. A flat object of AMI fields, in one fixed key order
// (KEY_ORDER). A field that does not apply to a record is OMITTED, never null or
// "": the Findings and Field Explorer tabs count presence, and in Cribl KQL an
// empty string is not the same as an absent field. There is no `_time` (Cribl
// adds it on replay) and no template token of any kind. Every event carries
// gigamon_origin="sample", which the DataGen's metadata also sets. Fields the
// pack's pipeline derives (total_bytes, l4_proto, the subnets, http_server_ms,
// tcp_reset) are not written here; their inputs are.
//
// DETERMINISM. mulberry32 with a constant seed, one sub-seed per file (so a
// change to one scenario leaves the other files alone), no Math.random and no
// Date.now. Every real number is rounded to 6 decimals and every byte count to
// an integer. AS_OF anchors certificate dates and HTTP timestamps; change it
// deliberately, on a pack release. A TLS "RENEW" badge is 20 days from AS_OF, so
// about three weeks after AS_OF that server reads EXPIRED instead.
//
// This script keeps its own vocabulary (hosts, services, the address plan). It
// reads src/data/*.ts only to check that the app names it uses are still in the
// app's catalogues; it adds nothing there, because every export of src/data is
// part of the display-freeze digest.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACK_DIR = join(ROOT, 'packs', 'cc-network-gigamon-ami')
const SAMPLES_DIR = join(PACK_DIR, 'data', 'samples')
const SAMPLES_YML = join(PACK_DIR, 'default', 'samples.yml')

const SEED = 0x6a4d1e55
export const AS_OF = '2026-10-01T00:00:00Z'
const AS_OF_MS = Date.parse(AS_OF)
const AS_OF_EPOCH = AS_OF_MS / 1000
const DAY_MS = 86_400_000
/** Budget for all sample files together. The DataGen replays them all day. */
const TOTAL_BUDGET_BYTES = 400 * 1024
/** Each file loops in five minutes or less at one event per second. */
const MAX_EVENTS_PER_FILE = 300

const { AI_APPS } = await import(pathToFileURL(join(ROOT, 'src', 'data', 'aiApps.ts')).href)
const { SAAS_APPS } = await import(pathToFileURL(join(ROOT, 'src', 'data', 'saasApps.ts')).href)

// ── PRNG ────────────────────────────────────────────────────────────────────

function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function rng(label) {
  let a = (SEED ^ fnv1a(label)) >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    /** [[value, weight], ...] */
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0)
      let x = next() * total
      for (const [v, w] of pairs) {
        if ((x -= w) < 0) return v
      }
      return pairs[pairs.length - 1][0]
    },
    /** Lognormal with the given median, by Box-Muller over this generator. */
    lognormal: (median, sigma) => {
      const u1 = next() || 1e-12
      const u2 = next()
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      return median * Math.exp(sigma * z)
    },
    hex: (n) => {
      let s = ''
      for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(next() * 16)]
      return s
    },
    shuffle: (arr) => {
      const out = [...arr]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
  }
  return r
}

const r6 = (x) => Math.round(x * 1e6) / 1e6
/** A value that depends only on its label, never on draw order. */
const stableHex = (label, n) => rng(`stable:${label}`).hex(n)
const appId = (app) => 1 + (fnv1a(`app:${app}`) % 4000)
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const vlanOf = (ip) => (ip.startsWith('10.20.') ? 100 + Number(ip.split('.')[2]) * 10 : undefined)

// ── Event shape ─────────────────────────────────────────────────────────────

/** Every field an event may carry, in the order it is written. */
const KEY_ORDER = [
  'gigamon_origin', 'app_name', 'app_id', 'protocol', 'ip_version', 'src_ip', 'src_port', 'dst_ip', 'dst_port', 'vlan_id',
  'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets',
  'tcp_flags', 'tcp_flag_reset', 'tcp_rtt', 'tcp_rtt_app', 'tcp_dup_ack', 'tcp_retransmission_bytes', 'tcp_loss_count',
  'tcp_wrong_crc', 'tcp_window_size', 'tcp_zero_window', 'udp_wrong_crc', 'ip_wrong_crc',
  'src_aws_flat_tags_name', 'src_k8s_pod_name', 'dst_aws_instance_id', 'dst_aws_vpc_id', 'dst_aws_flat_tags_name',
  'dst_aws_flat_tags_service_type', 'k8s_namespace', 'dst_k8s_pod_name', 'k8s_container_name',
  'http_host', 'http_method', 'http_uri', 'http_version', 'http_code', 'http_user_agent', 'http_content_type',
  'http_referer', 'http_cookie', 'http_server', 'http_request_ts', 'http_response_ts', 'http_rtt',
  'http2_host', 'http2_method', 'http2_code',
  'dns_query', 'dns_query_type', 'dns_host', 'dns_reply_code', 'dns_response_time', 'dns_ttl', 'dns_host_addr',
  'dns_ancount', 'dns_arcount', 'dns_reverse_addr',
  'ssl_server_name', 'ssl_protocol_version', 'ssl_server_supported_version', 'ssl_client_supported_version',
  'ssl_cipher_suite_id', 'ssl_cipher_suite_list', 'ssl_ext_ec_supported_groups_type', 'ssl_ja3', 'ssl_ja3s',
  'ssl_mitm_score', 'ssl_issuer', 'ssl_common_name', 'ssl_subject_alt_name', 'ssl_serial_number', 'ssl_certif_sha1',
  'ssl_certificate_subject_key_size', 'ssl_certificate_subject_key_algo_oid', 'ssl_validity_not_before',
  'ssl_validity_not_after',
  'ssh_version', 'ssh_server_agent', 'ssh_tsp_alg_encrypt_cts', 'dcerpc_service', 'krb5_realm', 'krb5_message_type',
  'snmp_version', 'snmp_community', 'snmp_oid', 'snmp_processing_anomaly_type', 'icmp_type', 'icmp_tunneling',
  'sip_from', 'sip_contact', 'sip_callee_domain', 'ftp_data_content', 'rtp_codec_name', 'rtp_lost', 'rtp_service',
  'dhcp_message_type', 'dhcp_host_name', 'dhcp_yiaddr',
]
const KNOWN_KEYS = new Set(KEY_ORDER)

/** Rebuild an event in KEY_ORDER, dropping undefined, and refusing a key nobody listed. */
function finish(ev) {
  for (const k of Object.keys(ev)) {
    if (!KNOWN_KEYS.has(k)) throw new Error(`gen-pack-samples: field "${k}" is not in KEY_ORDER`)
  }
  const out = {}
  for (const k of KEY_ORDER) if (ev[k] !== undefined) out[k] = ev[k]
  return out
}

const TCP = 6
const UDP = 17
const ICMP = 1

/** The 5-tuple, sizes and app of one flow. */
function flow(r, { app, proto = TCP, src, dst, dport, sport, bytes, reqShare = 0.15 }) {
  const total = Math.max(80, Math.round(bytes))
  const srcB = Math.max(40, Math.round(total * reqShare))
  const dstB = Math.max(40, total - srcB)
  const ports = proto === ICMP ? {} : { src_port: sport ?? r.int(49152, 65535), dst_port: dport }
  return {
    gigamon_origin: 'sample',
    app_name: app,
    app_id: appId(app),
    protocol: proto,
    ip_version: 4,
    src_ip: src,
    ...ports,
    dst_ip: dst,
    vlan_id: vlanOf(src) ?? vlanOf(dst),
    src_bytes: srcB,
    dst_bytes: dstB,
    src_packets: Math.ceil(srcB / 900),
    dst_packets: Math.ceil(dstB / 900),
  }
}

/** TCP health fields. Latencies are SECONDS: every tab multiplies by 1000. */
function tcp(r, { rttMedian = 0.004, appMedian = 0.02, appSigma = 0.45, resetP = 0, dupAck, loss = 0, crc = 0, zeroWindow = 0 }) {
  const reset = r.chance(resetP)
  const dup = dupAck ?? (r.chance(0.85) ? 0 : r.int(1, 3))
  return {
    tcp_flags: reset ? 20 : r.pick([24, 17]),
    tcp_flag_reset: reset ? 1 : 0,
    tcp_rtt: r6(r.lognormal(rttMedian, 0.5)),
    tcp_rtt_app: r6(r.lognormal(appMedian, appSigma)),
    tcp_dup_ack: dup,
    tcp_retransmission_bytes: dup * 1400,
    tcp_loss_count: loss,
    tcp_wrong_crc: crc,
    tcp_window_size: r.pick([64240, 65535, 29200]),
    tcp_zero_window: zeroWindow,
  }
}

const WORKSTATIONS = Array.from({ length: 25 }, (_, i) => `10.20.4.${10 + i}`)
const UA_BROWSER = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
]
const UA_TOOL = ['curl/8.4.0', 'python-requests/2.31.0', 'okhttp/4.12.0']

const httpTimes = (r, i, serverSec) => {
  const req = r6(AS_OF_EPOCH + i * 1.5 + r.next())
  return { http_request_ts: req, http_response_ts: r6(req + serverSec) }
}

// ── gigamon_ami_services: Flow Map, TCP health, Capacity ─────────────────────────────

const VPCS = [`vpc-${stableHex('vpc:shop', 17)}`, `vpc-${stableHex('vpc:data', 17)}`]

const SERVICES = {
  'checkout-api': { ip: '10.20.2.10', port: 8443, app: 'https', type: 'api', ns: 'shop', vpc: 0, k8s: true, app_s: 0.02 },
  'cart-svc': { ip: '10.20.2.11', port: 50051, app: 'grpc', type: 'api', ns: 'shop', vpc: 0, k8s: true, app_s: 0.015 },
  'auth-svc': { ip: '10.20.2.12', port: 443, app: 'https', type: 'api', ns: 'platform', vpc: 0, k8s: true, app_s: 0.018 },
  'catalog-svc': { ip: '10.20.2.13', port: 8080, app: 'http', type: 'api', ns: 'shop', vpc: 0, k8s: true, app_s: 0.02, host: 'catalog.corp.example.com' },
  // Elevated: p95 ~150 ms against a 100 ms SLO — the map's "warning" node.
  'search-svc': { ip: '10.20.2.14', port: 443, app: 'https', type: 'api', ns: 'shop', vpc: 0, k8s: true, app_s: 0.08 },
  // Resets on ~95% of flows — a "danger" node by reset rate alone.
  'legacy-crm': { ip: '10.20.2.30', port: 80, app: 'http', type: 'api', ns: 'platform', vpc: 0, k8s: false, app_s: 0.03, resetP: 0.95, host: 'crm.corp.example.com' },
  // Breaching: p95 ~380 ms, over 3x the 100 ms SLO — the map's pulsing epicenter.
  'payments-db': { ip: '10.20.3.20', port: 5432, app: 'postgresql', type: 'database', vpc: 1, k8s: false, app_s: 0.2, app_sigma: 0.35 },
  'inventory-db': { ip: '10.20.3.21', port: 5432, app: 'postgresql', type: 'database', vpc: 1, k8s: false, app_s: 0.012 },
  'orders-queue': { ip: '10.20.3.22', port: 6379, app: 'redis', type: 'queue', vpc: 1, k8s: false, app_s: 0.004 },
}
/** Callers that are never a destination: the map's client-only nodes. */
const CLIENT_ONLY = {
  'web-frontend': { ip: '10.20.1.10', k8s: true, ns: 'shop' },
  'reporting-etl': { ip: '10.20.3.40', k8s: false },
}

const POD_CHARS = 'bcdfghjklmnpqrstvwxz2456789'
function pod(name, i) {
  const rs = stableHex(`rs:${name}`, 10)
  const s = rng(`pod:${name}:${i}`)
  let suffix = ''
  for (let k = 0; k < 5; k++) suffix += POD_CHARS[Math.floor(s.next() * POD_CHARS.length)]
  return `${name}-${rs}-${suffix}`
}

function ipOfCaller(name) {
  return (SERVICES[name] ?? CLIENT_ONLY[name]).ip
}

function genServices() {
  const r = rng('gno_services')
  const plan = [
    ['web-frontend', 'checkout-api', 12], ['web-frontend', 'cart-svc', 8], ['web-frontend', 'search-svc', 10],
    ['web-frontend', 'auth-svc', 6], ['checkout-api', 'payments-db', 14], ['checkout-api', 'inventory-db', 6],
    ['checkout-api', 'orders-queue', 5], ['cart-svc', 'catalog-svc', 6], ['search-svc', 'catalog-svc', 5],
    ['catalog-svc', 'inventory-db', 5], ['reporting-etl', 'inventory-db', 3], ['reporting-etl', 'orders-queue', 2],
    // Untagged workstations: callers the map shows only as the external hub.
    ['*ws', 'legacy-crm', 10], ['*ws', 'inventory-db', 8],
  ]
  const events = []
  for (const [from, to, n] of plan) {
    const svc = SERVICES[to]
    for (let i = 0; i < n; i++) {
      const src = from === '*ws' ? r.pick(WORKSTATIONS) : ipOfCaller(from)
      // The one slow network path: web tier -> app tier.
      const slowPath = src.startsWith('10.20.1.') && svc.ip.startsWith('10.20.2.')
      const backup = from === 'reporting-etl' && to === 'inventory-db'
      const bytes = backup ? r.int(5_000_000, 50_000_000) : Math.min(200_000, Math.max(2_000, r.lognormal(20_000, 1)))
      const dupAck = slowPath ? r.int(10, 40) : undefined
      const ev = {
        ...flow(r, { app: svc.app, src, dst: svc.ip, dport: svc.port, bytes, reqShare: backup ? 0.02 : 0.15 }),
        ...tcp(r, {
          rttMedian: slowPath ? 0.12 : 0.004,
          appMedian: svc.app_s,
          appSigma: svc.app_sigma ?? 0.45,
          resetP: svc.resetP ?? 0,
          dupAck,
          loss: slowPath && r.chance(0.7) ? r.int(1, 8) : 0,
          crc: src.startsWith('10.20.4.') && svc.ip.startsWith('10.20.3.') && r.chance(0.25) ? r.int(1, 3) : 0,
          zeroWindow: from === 'reporting-etl' ? r.int(1, 3) : 0,
        }),
        dst_aws_instance_id: `i-${stableHex(`i:${to}`, 17)}`,
        dst_aws_vpc_id: VPCS[svc.vpc],
        dst_aws_flat_tags_name: to,
        dst_aws_flat_tags_service_type: svc.type,
      }
      if (from !== '*ws') {
        ev.src_aws_flat_tags_name = from
        const caller = SERVICES[from] ?? CLIENT_ONLY[from]
        if (caller.k8s) ev.src_k8s_pod_name = pod(from, r.int(0, 2))
      }
      if (svc.k8s) {
        ev.k8s_namespace = svc.ns
        ev.dst_k8s_pod_name = pod(to, r.int(0, 2))
        ev.k8s_container_name = to
      }
      if (svc.host && ev.tcp_flag_reset === 0) {
        const server = r6(r.lognormal(svc.app_s, 0.5))
        Object.assign(ev, {
          http_host: svc.host,
          http_method: r.weighted([['GET', 80], ['POST', 20]]),
          http_uri: r.pick(to === 'legacy-crm' ? ['/crm/accounts', '/crm/search', '/crm/export'] : ['/v1/items', '/v1/items/sku', '/v1/categories']),
          http_version: '1.1',
          http_code: r.weighted([['200', 94], ['404', 4], ['500', 2]]),
          http_server: to === 'legacy-crm' ? 'Apache/2.4.29' : 'nginx/1.24.0',
          ...httpTimes(r, events.length, server),
          http_rtt: r6(server + ev.tcp_rtt),
        })
      }
      events.push(ev)
    }
  }
  // Dashed spokes: tagged callers reaching untagged / external peers.
  const spokes = [
    ['checkout-api', '203.0.113.40', 4], ['auth-svc', '192.0.2.30', 3], ['web-frontend', '192.0.2.80', 3],
  ]
  for (const [from, dst, n] of spokes) {
    for (let i = 0; i < n; i++) {
      const ev = {
        ...flow(r, { app: 'https', src: ipOfCaller(from), dst, dport: 443, bytes: r.lognormal(15_000, 0.8) }),
        ...tcp(r, { rttMedian: 0.035, appMedian: 0.05 }),
        src_aws_flat_tags_name: from,
      }
      events.push(ev)
    }
  }
  // UDP: time and metrics traffic from the app tier to infrastructure.
  for (let i = 0; i < 6; i++) {
    events.push(flow(r, { app: 'ntp', proto: UDP, src: r.pick(['10.20.2.10', '10.20.2.11', '10.20.3.20']), dst: '10.20.5.10', dport: 123, sport: 123, bytes: 180, reqShare: 0.5 }))
  }
  for (let i = 0; i < 8; i++) {
    events.push(flow(r, { app: 'statsd', proto: UDP, src: r.pick(['10.20.2.10', '10.20.2.13', '10.20.2.14']), dst: '10.20.5.20', dport: 8125, bytes: r.int(300, 1400), reqShare: 0.95 }))
  }
  for (let i = 0; i < 2; i++) {
    events.push({ ...flow(r, { app: 'icmp', proto: ICMP, src: '10.20.5.70', dst: r.pick(['10.20.2.10', '10.20.3.20']), bytes: 196, reqShare: 0.5 }), icmp_type: 8 })
  }
  return r.shuffle(events).map(finish)
}

// ── gigamon_ami_web_api: Web and API health, Findings ────────────────────────────────

const WEB_HOSTS = [
  { host: 'shop.example.com', ip: '10.20.1.20', port: 8080, w: 30, server: 'nginx/1.24.0', med: 0.04, uris: ['/', '/cart', '/product/1042', '/search?q=shoes'], ctype: 'text/html; charset=utf-8', ext: true },
  { host: 'api.example.com', ip: '10.20.1.21', port: 8080, w: 25, server: 'nginx/1.24.0', med: 0.05, uris: ['/api/v1/checkout', '/api/v1/cart', '/api/v1/items', '/api/v1/checkout'], ctype: 'application/json', tool: true },
  { host: 'status.example.net', ip: '10.20.1.22', port: 80, w: 8, server: 'nginx/1.24.0', med: 0.01, uris: ['/', '/health'], ctype: 'application/json', tool: true },
  { host: 'partner-portal.example.net', ip: '10.20.1.24', port: 8080, w: 10, server: 'nginx/1.24.0', med: 0.06, uris: ['/login', '/orders', '/invoices'], ctype: 'text/html; charset=utf-8', ext: true },
  { host: 'images.example.com', ip: '10.20.1.25', port: 80, w: 10, server: 'nginx/1.24.0', med: 0.008, uris: ['/img/hero', '/img/thumb/1042', '/img/logo'], ctype: 'image/png', ext: true },
  { host: 'intranet.example.com', ip: '10.20.1.26', port: 80, w: 8, server: 'nginx/1.24.0', med: 0.03, uris: ['/', '/wiki', '/people'], ctype: 'text/html; charset=utf-8' },
]
const LEGACY = { host: 'legacy.example.org', ip: '10.20.1.23', port: 80, server: 'Apache/2.4.29', med: 0.12, uris: ['/cgi-bin/report', '/index', '/admin'], ctype: 'text/html' }
const EXT_CLIENTS = Array.from({ length: 8 }, (_, i) => `198.51.100.${20 + i}`)

function webEvent(r, h, code, i, { forceCookie = false } = {}) {
  const src = h.ext && r.chance(0.4) ? r.pick(EXT_CLIENTS) : r.pick(WORKSTATIONS)
  const uri = r.pick(h.uris)
  const slow = h.host === 'api.example.com' && uri === '/api/v1/checkout'
  const server = r6(r.lognormal(slow ? 0.2 : h.med, slow ? 0.4 : 0.5))
  const browser = !h.tool || r.chance(0.3)
  const ua = browser ? r.pick(UA_BROWSER) : r.pick(UA_TOOL)
  const ev = {
    ...flow(r, { app: 'http', src, dst: h.ip, dport: h.port, bytes: h.ctype === 'image/png' ? r.lognormal(80_000, 0.8) : r.lognormal(8_000, 0.9) }),
    ...tcp(r, { rttMedian: src.startsWith('198.') ? 0.04 : 0.004, appMedian: server }),
    http_host: h.host,
    http_method: h.tool ? r.weighted([['GET', 55], ['POST', 30], ['PUT', 8], ['DELETE', 5], ['OPTIONS', 2]]) : r.weighted([['GET', 85], ['POST', 15]]),
    http_uri: uri,
    http_version: h === LEGACY ? '1.0' : '1.1',
    http_code: code,
    http_user_agent: ua,
    http_content_type: h.ctype,
    http_referer: browser ? `https://shop.example.com${r.pick(['/', '/cart', '/search'])}` : undefined,
    http_cookie: h.port === 80 && (forceCookie || r.chance(0.08)) ? `session=${r.hex(16)}` : undefined,
    http_server: h.server,
    ...httpTimes(r, i, server),
  }
  ev.http_rtt = r6(server + ev.tcp_rtt)
  return ev
}

function genWeb() {
  const r = rng('gno_web_api')
  // Every code at least once, so the codes panel fills; the rest weighted.
  const mandatory = ['201', '204', '301', '304', '401', '403', '404', '429']
  const weights = [['200', 72], ['201', 5], ['204', 3], ['301', 3], ['304', 5], ['401', 2], ['403', 1], ['404', 5], ['429', 1], ['500', 1]]
  const main = []
  for (let i = 0; i < 76; i++) {
    const h = r.weighted(WEB_HOSTS.map((x) => [x, x.w]))
    const code = i < mandatory.length ? mandatory[i] : r.weighted(weights)
    main.push(webEvent(r, h, code, i, { forceCookie: i === 10 && h.port === 80 }))
  }
  const cookieHost = WEB_HOSTS.find((h) => h.host === 'status.example.net')
  main.push(webEvent(r, cookieHost, '200', 76, { forceCookie: true }))
  const shuffled = r.shuffle(main)

  // legacy.example.org: 5xx on a quarter of its flows, in ONE contiguous block,
  // so a 1-minute trend shows a spike rather than a flat line.
  const legacyCodes = ['200', '200', '304', '200', '200', '200', '200', '500', '503', '502', '500', '503', '200', '200', '304', '200', '200', '200', '200', '200']
  const legacy = legacyCodes.map((c, i) => webEvent(r, LEGACY, c, 100 + i))

  // HTTP/2: http2_* in place of http_* (the H2 panel and the KPI's h2 count).
  const h2 = []
  for (let i = 0; i < 23; i++) {
    const h = r.pick([WEB_HOSTS[0], WEB_HOSTS[1]])
    h2.push({
      ...flow(r, { app: 'http2', src: r.pick(WORKSTATIONS), dst: h.ip, dport: 443, bytes: r.lognormal(12_000, 0.9) }),
      ...tcp(r, { appMedian: h.med }),
      http2_host: h.host,
      http2_method: r.weighted([['GET', 75], ['POST', 25]]),
      http2_code: r.weighted([['200', 88], ['204', 6], ['404', 6]]),
    })
  }
  const merged = r.shuffle([...shuffled, ...h2])
  const at = 45
  return [...merged.slice(0, at), ...legacy, ...merged.slice(at)].map(finish)
}

// ── gigamon_ami_dns: DNS health, Flow Map's DNS domain, Findings ─────────────────────

const RESOLVERS = [
  { ip: '10.20.5.53', tag: true, med: 0.004, w: 45 },
  { ip: '10.20.5.54', tag: true, med: 0.006, w: 30 },
  { ip: '192.0.2.53', tag: false, med: 0.025, w: 13 },
]
const ROGUE = { ip: '198.51.100.53', med: 0.18, clients: ['10.20.4.31', '10.20.4.32', '10.20.4.33'] }
const NAMES = [
  ['intranet.corp.example.com', '10.20.1.26'], ['mail.example.com', '192.0.2.25'], ['shop.example.com', '10.20.1.20'],
  ['api.example.com', '10.20.1.21'], ['chatgpt.ai.example.net', '203.0.113.11'], ['office365.saas.example.com', '203.0.113.40'],
  ['cdn.example.com', '192.0.2.80'], ['ldap.corp.example.com', '10.20.5.10'], ['files.example.org', '198.51.100.120'],
  ['status.example.net', '10.20.1.22'],
]
const DNS_CLIENTS = [...WORKSTATIONS, '10.20.2.10', '10.20.2.11', '10.20.2.13', '10.20.2.14']

function dnsEvent(r, { src, resolver, med, tag, code, qtype, query, addr, tunnel = false, slowTail = 0 }) {
  const time = r.chance(slowTail) ? r.int(150, 400) / 1000 : r6(r.lognormal(med, 0.5))
  const ok = code === '0'
  const ev = {
    ...flow(r, { app: 'dns', proto: UDP, src, dst: resolver, dport: 53, bytes: tunnel ? r.int(900, 1400) : r.int(90, 320), reqShare: 0.3 }),
    dns_query: query,
    dns_query_type: qtype,
    dns_host: resolver,
    dns_reply_code: code,
    dns_response_time: r6(time),
    dns_ttl: ok ? r.pick([30, 60, 300, 3600]) : undefined,
    dns_host_addr: ok && qtype === 'A' ? addr : undefined,
    dns_ancount: ok ? (tunnel ? r.int(8, 12) : r.int(1, 4)) : 0,
    dns_arcount: r.int(0, 2),
  }
  if (tag) {
    Object.assign(ev, {
      dst_aws_instance_id: `i-${stableHex(`i:core-dns:${resolver}`, 17)}`,
      dst_aws_vpc_id: VPCS[1],
      dst_aws_flat_tags_name: 'core-dns',
      dst_aws_flat_tags_service_type: 'dns',
    })
  }
  return ev
}

function reverseName(ip) {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`
}

function genDns() {
  const r = rng('gno_dns')
  const events = []
  for (let i = 0; i < 74; i++) {
    const res = r.weighted(RESOLVERS.map((x) => [x, x.w]))
    const qtype = r.weighted([['A', 65], ['AAAA', 20], ['PTR', 5], ['TXT', 4], ['SRV', 3], ['MX', 2], ['HTTPS', 1]])
    const [name, addr] = r.pick(NAMES)
    const code = r.weighted([['0', 96], ['3', 3], ['2', 1]])
    const query = qtype === 'PTR' ? reverseName(addr) : qtype === 'SRV' ? `_ldap._tcp.corp.example.com` : name
    const ev = dnsEvent(r, { src: r.pick(DNS_CLIENTS), resolver: res.ip, med: res.med, tag: res.tag, code, qtype, query, addr, slowTail: res.tag ? 0.1 : 0 })
    if (qtype === 'PTR') ev.dns_reverse_addr = addr
    events.push(ev)
  }
  // NXDOMAIN from one workstation cycling generated labels (DGA-shaped).
  for (let i = 0; i < 8; i++) {
    events.push(dnsEvent(r, { src: '10.20.4.23', resolver: '10.20.5.53', med: 0.004, tag: true, code: '3', qtype: 'A', query: `${r.hex(4)}${r.pick(['k', 'q', 'x', 'z'])}${r.hex(3)}.example.net` }))
  }
  // Long TXT answers from the same host: tunnelling-shaped.
  for (let i = 0; i < 3; i++) {
    events.push(dnsEvent(r, { src: '10.20.4.23', resolver: '192.0.2.53', med: 0.025, tag: false, code: '0', qtype: 'TXT', query: `${r.hex(32)}.t.example.org`, tunnel: true }))
  }
  // A rogue resolver reached by three workstations: slow, and SERVFAIL on ~30%.
  for (let i = 0; i < 12; i++) {
    const [name, addr] = r.pick(NAMES)
    const code = i % 3 === 0 ? '2' : '0'
    events.push(dnsEvent(r, { src: ROGUE.clients[i % 3], resolver: ROGUE.ip, med: ROGUE.med, tag: false, code, qtype: 'A', query: name, addr }))
  }
  return r.shuffle(events).map(finish)
}

// ── gigamon_ami_tls_apps: Shadow AI, TLS posture, PQC readiness ──────────────────────

/** Asserted against src/data/aiApps.ts: a rename there fails --check. */
const AI_USED = ['openai', 'chatgpt', 'claude', 'anthropic', 'perplexity-ai', 'ms-copilot', 'deepseek', 'mistral-ai', 'google-gen', 'poe']
/** Asserted against src/data/saasApps.ts. */
const SAAS_USED = ['office365', 'zoom', 'google', 'notion', 'datadog', 'splunk', 'docker', 'amazon-aws', 'gstatic', 'webex']
/** In neither list: the tab's "neither sanctioned nor AI" case. */
const OTHER_USED = ['dropbox', 'wetransfer', 'telegram']

const CA = {
  digicert: 'DigiCert Global G2 TLS RSA SHA256 2020 CA1',
  le: "Let's Encrypt R11",
  amazon: 'Amazon RSA 2048 M02',
  sectigo: 'Sectigo RSA Domain Validation Secure Server CA',
  internal: 'Example Corp Internal CA',
}
const RSA_OID = '1.2.840.113549.1.1.1'
const EC_OID = '1.2.840.10045.2.1'

function tlsServers() {
  const servers = []
  AI_USED.forEach((app, i) => servers.push({ sni: `${app}.ai.example.net`, app, ip: `203.0.113.${10 + i}`, ver: 'TLS_1_3', pqcHeavy: true, kind: 'ai' }))
  const tls12 = { zoom: [CA.digicert, 200, 2048], webex: [CA.amazon, 320, 2048], splunk: [CA.digicert, 150, 4096] }
  SAAS_USED.forEach((app, i) => {
    const c = tls12[app]
    servers.push({ sni: `${app}.saas.example.com`, app, ip: `203.0.113.${40 + i}`, ver: c ? 'TLS_1_2' : 'TLS_1_3', kind: 'saas', cert: c && { issuer: c[0], days: c[1], key: c[2] } })
  })
  OTHER_USED.forEach((app, i) => servers.push({ sni: `${app}.files.example.org`, app, ip: `203.0.113.${70 + i}`, ver: 'TLS_1_3', kind: 'other' }))
  // One server per TLS badge and per data-sensitivity class.
  servers.push(
    { sni: 'auth.example.com', app: 'https', ip: '192.0.2.40', ver: 'TLS_1_3', kind: 'site' },
    { sni: 'pay.example.com', app: 'https', ip: '192.0.2.41', ver: 'TLS_1_2', kind: 'site', cert: { issuer: CA.digicert, days: 200, key: 2048 } },
    { sni: 'bank-api.example.net', app: 'https', ip: '192.0.2.42', ver: 'TLS_1_2', kind: 'site', cert: { issuer: CA.sectigo, days: -10, key: 2048 } },
    { sni: 'patient-portal.example.org', app: 'https', ip: '192.0.2.43', ver: 'TLS_1_3', kind: 'site' },
    { sni: 'old-vpn.example.net', app: 'https', ip: '192.0.2.44', ver: 'TLS_1_1', kind: 'site', cert: { issuer: CA.digicert, days: 150, key: 2048 } },
    { sni: 'cdn.example.com', app: 'https', ip: '192.0.2.80', ver: 'TLS_1_3', pqcHeavy: true, kind: 'site' },
    { sni: 'status.example.net', app: 'https', ip: '10.20.1.22', ver: 'TLS_1_2', kind: 'site', cert: { issuer: CA.le, days: 20, key: 256 } },
    { sni: 'intranet.example.com', app: 'https', ip: '10.20.1.26', ver: 'TLS_1_2', kind: 'site', cert: { issuer: CA.internal, days: 200, key: 2048 } },
    { sni: 'legacy.example.org', app: 'https', ip: '10.20.1.23', ver: 'TLS_1_0', kind: 'site', cert: { issuer: CA.digicert, days: 200, key: 1024 } },
    { sni: 'printer.corp.example.com', app: 'https', ip: '10.20.5.60', ver: 'TLS_1_2', kind: 'site', cert: { issuer: 'printer.corp.example.com', days: 900, key: 2048 } },
  )
  return servers
}

const VERSION_CODE = { TLS_1_3: '772', TLS_1_2: '771', TLS_1_1: '770', TLS_1_0: '769' }
const CLIENT_VERSIONS = { TLS_1_3: '772,771', TLS_1_2: '771,770', TLS_1_1: '770,769', TLS_1_0: '769' }
const CIPHER_LIST = { TLS_1_3: '4865,4866,4867,49195,49199', TLS_1_2: '49195,49199,52393,49171', TLS_1_1: '10,47,53', TLS_1_0: '10,47,53' }
const JA3 = Array.from({ length: 5 }, (_, i) => stableHex(`ja3:${i}`, 32))
/** The one client whose sessions pass through a TLS-inspection path. */
const INSPECTED_CLIENT = '10.20.4.34'

function tlsEvent(r, s, src) {
  const ver = s.ver
  let group
  if (ver === 'TLS_1_3') {
    group = s.pqcHeavy
      ? r.weighted([['4588', 55], ['25497', 8], ['4587', 4], ['29', 23], ['23', 5], ['2570', 3], ['6682', 2]])
      : r.weighted([['4588', 25], ['25497', 3], ['29', 50], ['23', 15], ['2570', 4], ['6682', 3]])
  } else {
    group = r.pick(['23', '24'])
  }
  const bytes = s.app === 'zoom' || s.app === 'webex' ? r.lognormal(2_000_000, 0.6) : r.lognormal(s.kind === 'ai' ? 40_000 : 20_000, 1)
  const ev = {
    ...flow(r, { app: s.app, src, dst: s.ip, dport: 443, bytes, reqShare: s.kind === 'ai' ? 0.45 : 0.1 }),
    tcp_flags: r.pick([24, 17]),
    tcp_rtt: r6(r.lognormal(s.ip.startsWith('10.20.') ? 0.004 : 0.03, 0.5)),
    ssl_server_name: s.sni,
    ssl_protocol_version: ver,
    ssl_server_supported_version: VERSION_CODE[ver],
    ssl_client_supported_version: CLIENT_VERSIONS[ver],
    ssl_cipher_suite_id: ver === 'TLS_1_3' ? r.pick(['4865', '4866']) : ver === 'TLS_1_2' ? '49199' : '10',
    ssl_cipher_suite_list: CIPHER_LIST[ver],
    ssl_ext_ec_supported_groups_type: group,
    ssl_ja3: JA3[WORKSTATIONS.indexOf(src) % JA3.length],
    ssl_ja3s: stableHex(`ja3s:${s.sni}`, 32),
    ssl_mitm_score: src === INSPECTED_CLIENT ? r.int(60, 90) : 0,
  }
  // A TLS 1.3 handshake encrypts the certificate, so only older sessions carry it.
  if (ver !== 'TLS_1_3' && s.cert) {
    const c = s.cert
    Object.assign(ev, {
      ssl_issuer: c.issuer,
      ssl_common_name: s.sni,
      ssl_subject_alt_name: `DNS:${s.sni}, DNS:www.${s.sni}`,
      ssl_serial_number: stableHex(`serial:${s.sni}`, 32),
      ssl_certif_sha1: stableHex(`sha1:${s.sni}`, 40),
      ssl_certificate_subject_key_size: c.key,
      ssl_certificate_subject_key_algo_oid: c.key === 256 ? EC_OID : RSA_OID,
      ssl_validity_not_before: fmtDate(AS_OF_MS - 60 * DAY_MS),
      ssl_validity_not_after: fmtDate(AS_OF_MS + c.days * DAY_MS),
    })
  }
  return ev
}

function genTls() {
  for (const a of AI_USED) if (!AI_APPS.includes(a)) throw new Error(`gen-pack-samples: "${a}" is no longer in src/data/aiApps.ts`)
  for (const a of SAAS_USED) if (!SAAS_APPS.includes(a)) throw new Error(`gen-pack-samples: "${a}" is no longer in src/data/saasApps.ts`)
  for (const a of OTHER_USED) {
    if (AI_APPS.includes(a) || SAAS_APPS.includes(a)) throw new Error(`gen-pack-samples: "${a}" is now in an app catalogue; pick another "neither" app`)
  }
  const r = rng('gno_tls_apps')
  const servers = tlsServers()
  const ai = servers.filter((s) => s.kind === 'ai')
  const saas = servers.filter((s) => s.kind === 'saas')
  const other = servers.filter((s) => s.kind === 'other')
  const sites = servers.filter((s) => s.kind === 'site')
  const events = []
  // Six heavy AI users, each on 3-5 distinct AI apps.
  const heavy = ['10.20.4.11', '10.20.4.14', '10.20.4.18', '10.20.4.22', '10.20.4.27', '10.20.4.30']
  heavy.forEach((src, i) => {
    const apps = r.shuffle(ai).slice(0, 3 + (i % 3))
    for (const s of apps) events.push(tlsEvent(r, s, src))
    events.push(tlsEvent(r, r.pick(apps), src))
  })
  while (events.length < 48) events.push(tlsEvent(r, r.pick(ai), r.pick(WORKSTATIONS)))
  for (let i = 0; i < 56; i++) events.push(tlsEvent(r, saas[i % saas.length], r.pick(WORKSTATIONS)))
  for (let i = 0; i < 10; i++) events.push(tlsEvent(r, other[i % other.length], r.pick(WORKSTATIONS)))
  for (let i = 0; i < 26; i++) events.push(tlsEvent(r, sites[i % sites.length], r.pick(WORKSTATIONS)))
  // The inspected client, so the Findings MITM row has something to find.
  events.push(tlsEvent(r, saas[0], INSPECTED_CLIENT), tlsEvent(r, sites[0], INSPECTED_CLIENT))
  return r.shuffle(events).map(finish)
}

// ── gigamon_ami_security: Security techniques, Findings, Field Explorer coverage ─────

function genSecurity() {
  const r = rng('gno_security')
  const events = []
  // T1046: one external source on 12 distinct ports (threshold 6), mostly refused.
  const scanPorts = [21, 22, 23, 25, 80, 135, 139, 443, 445, 3306, 3389, 8080, 22, 443]
  scanPorts.forEach((p, i) => {
    events.push({
      ...flow(r, { app: 'unknown', src: '198.51.100.66', dst: '10.20.1.10', dport: p, bytes: r.int(60, 140), reqShare: 0.6 }),
      ...tcp(r, { rttMedian: 0.04, appMedian: 0.001, resetP: i < 12 ? 0.9 : 0 }),
    })
  })
  // T1021.b: one internal host reaching 30 destinations (threshold 20) on 445.
  const targets = [
    ...Array.from({ length: 10 }, (_, i) => `10.20.1.${30 + i}`),
    ...Array.from({ length: 10 }, (_, i) => `10.20.2.${40 + i}`),
    ...Array.from({ length: 10 }, (_, i) => `10.20.3.${60 + i}`),
  ]
  for (const dst of targets) {
    events.push({ ...flow(r, { app: 'smb', src: '10.20.4.77', dst, dport: 445, bytes: r.int(400, 6000) }), ...tcp(r, { resetP: 0.4 }) })
  }
  // T1021: SSH, including one on a non-standard port (classified by handshake).
  const ssh = [['10.20.4.12', '10.20.5.22', 22], ['10.20.4.12', '10.20.2.10', 22], ['10.20.4.15', '10.20.5.22', 22], ['10.20.4.19', '10.20.3.20', 22], ['10.20.4.12', '10.20.5.23', 2222]]
  ssh.forEach(([src, dst, port], i) => {
    events.push({
      ...flow(r, { app: 'ssh', src, dst, dport: port, bytes: r.lognormal(30_000, 1) }),
      ...tcp(r, {}),
      ssh_version: '2.0',
      ssh_server_agent: i === 3 ? 'OpenSSH_7.4' : 'OpenSSH_9.6',
      ssh_tsp_alg_encrypt_cts: i === 3 ? 'aes128-cbc' : 'aes256-ctr',
    })
  })
  // T1570: MSRPC services, including "mapi" on a non-standard port.
  for (const [svc, port] of [['svcctl', 135], ['atsvc', 135], ['mapi', 5003], ['mapi', 5003]]) {
    events.push({ ...flow(r, { app: 'dcerpc', src: r.pick(['10.20.4.77', '10.20.4.12']), dst: '10.20.5.25', dport: port, bytes: r.int(900, 9000) }), ...tcp(r, {}), dcerpc_service: svc })
  }
  // T1018: LDAP and Kerberos.
  for (const port of [389, 389, 636]) {
    events.push({ ...flow(r, { app: 'ldap', src: r.pick(WORKSTATIONS), dst: '10.20.5.10', dport: port, bytes: r.int(600, 4000) }), ...tcp(r, {}) })
  }
  for (const type of ['AS-REQ', 'AS-REP', 'TGS-REQ']) {
    events.push({ ...flow(r, { app: 'kerberos', src: r.pick(WORKSTATIONS), dst: '10.20.5.10', dport: 88, bytes: r.int(900, 3000) }), ...tcp(r, {}), krb5_realm: 'CORP.EXAMPLE.COM', krb5_message_type: type })
  }
  // T1110: SNMP community strings in cleartext, two malformed PDUs.
  for (let i = 0; i < 6; i++) {
    events.push({
      ...flow(r, { app: 'snmp', proto: UDP, src: '10.20.5.70', dst: `10.20.5.${1 + (i % 4)}`, dport: 161, bytes: r.int(150, 600), reqShare: 0.4 }),
      snmp_version: 2,
      snmp_community: i % 3 === 0 ? 'private' : 'public',
      snmp_oid: i % 2 === 0 ? '1.3.6.1.2.1.1.1.0' : '1.3.6.1.2.1.2.2.1.10.1',
      snmp_processing_anomaly_type: i < 2 ? 'malformed_pdu' : undefined,
    })
  }
  // T1572: ICMP, three of them tunnelling-shaped.
  for (let i = 0; i < 4; i++) {
    events.push({ ...flow(r, { app: 'icmp', proto: ICMP, src: '10.20.5.70', dst: `10.20.5.${1 + i}`, bytes: 196, reqShare: 0.5 }), icmp_type: i % 2 === 0 ? 8 : 0 })
  }
  for (let i = 0; i < 3; i++) {
    events.push({ ...flow(r, { app: 'icmp', proto: ICMP, src: '10.20.4.23', dst: '203.0.113.200', bytes: r.int(40_000, 90_000), reqShare: 0.7 }), icmp_type: 8, icmp_tunneling: 'detected' })
  }
  // SIP scanning that names itself.
  for (let i = 0; i < 3; i++) {
    events.push({
      ...flow(r, { app: 'sip', proto: UDP, src: '198.51.100.99', dst: '10.20.5.80', dport: 5060, sport: 5060, bytes: r.int(400, 900), reqShare: 0.7 }),
      sip_from: `"sipvicious"<sip:${100 + i}@198.51.100.99>`,
      sip_contact: `sip:${100 + i}@198.51.100.99:5060`,
      sip_callee_domain: 'voip.example.com',
    })
  }
  // Cleartext FTP to a partner.
  for (let i = 0; i < 2; i++) {
    events.push({ ...flow(r, { app: 'ftp', src: '10.20.3.40', dst: '198.51.100.120', dport: 21, bytes: r.int(2000, 60_000) }), ...tcp(r, { rttMedian: 0.03 }), ftp_data_content: 'RETR nightly_export.csv' })
  }
  // Wire faults on UDP syslog from network gear.
  for (let i = 0; i < 4; i++) {
    events.push({
      ...flow(r, { app: 'syslog', proto: UDP, src: `10.20.5.${1 + i}`, dst: '10.20.5.90', dport: 514, bytes: r.int(200, 900), reqShare: 0.98 }),
      udp_wrong_crc: i < 2 ? r.int(1, 2) : undefined,
      ip_wrong_crc: i >= 2 ? r.int(1, 2) : undefined,
    })
  }
  // RTP media.
  for (let i = 0; i < 4; i++) {
    events.push({
      ...flow(r, { app: 'rtp', proto: UDP, src: `10.20.4.${50 + i}`, dst: '10.20.5.80', dport: r.int(16384, 32767), bytes: r.int(200_000, 900_000), reqShare: 0.5 }),
      rtp_codec_name: i % 2 === 0 ? 'PCMU' : 'opus',
      rtp_lost: r.int(0, 40),
      rtp_service: i === 3 ? 'video' : 'voice',
    })
  }
  // DHCP through a relay.
  for (const type of ['DISCOVER', 'REQUEST', 'ACK']) {
    events.push({
      ...flow(r, { app: 'dhcp', proto: UDP, src: '10.20.4.1', dst: '10.20.5.67', dport: 67, sport: 67, bytes: r.int(600, 700), reqShare: 0.5 }),
      dhcp_message_type: type,
      dhcp_host_name: 'ws-0412.corp.example.com',
      dhcp_yiaddr: '10.20.4.112',
    })
  }
  return events.map(finish)
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * Sample id -> generator. The order is the order samples.yml lists them.
 *
 * The ids are object ids in the pack, so they carry no `gno_` prefix (reserved
 * for acceleration schedules). The `rng('gno_…')` labels inside each generator
 * are NOT ids: they are the frozen seeds 0.1.0's samples were drawn from, kept
 * so the 0.2.0 events are the same draws. Changing a label re-rolls that file.
 */
const SAMPLES = [
  ['gigamon_ami_services', genServices],
  ['gigamon_ami_web_api', genWeb],
  ['gigamon_ami_dns', genDns],
  ['gigamon_ami_tls_apps', genTls],
  ['gigamon_ami_security', genSecurity],
]

/** One JSON document per file (a DataGen sample must be an array), one event per line. */
const render = (events) => `[\n${events.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`

function renderSamplesYml(files) {
  const lines = [
    '# Generated by scripts/gen-pack-samples.mjs. Do not edit: size and numEvents',
    '# must equal the bytes and event count of data/samples/<id>.json exactly, and',
    '# `npm run pack:check` fails the build when they do not.',
  ]
  for (const f of files) {
    // NOT VERIFIED, a proof-slice item, unknown (f): does a sample replay with
    // _time as now? Every live DataGen sample observed on a Leader has
    // `isTemplate: true`; these ship `false`. Left as it is on purpose until an
    // install on a real Leader shows which value stamps the current time on
    // replay. Do not flip it on a guess (src/cribl/pack.ts says the same).
    lines.push(
      `${f.id}:`,
      `  sampleName: ${f.id}.json`,
      '  isTemplate: false',
      '  tsTemplateField: ""',
      `  created: ${AS_OF_MS}`,
      `  size: ${f.bytes.length}`,
      `  numEvents: ${f.count}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export function generate() {
  const files = SAMPLES.map(([id, gen]) => {
    const events = gen()
    for (const e of events) {
      if (e.gigamon_origin !== 'sample') throw new Error(`gen-pack-samples: ${id} has an event without gigamon_origin="sample"`)
      if ('_time' in e) throw new Error(`gen-pack-samples: ${id} has an event with _time`)
    }
    if (events.length > MAX_EVENTS_PER_FILE) throw new Error(`gen-pack-samples: ${id} has ${events.length} events; the limit is ${MAX_EVENTS_PER_FILE}`)
    return { id, count: events.length, bytes: Buffer.from(render(events), 'utf8') }
  })
  const total = files.reduce((s, f) => s + f.bytes.length, 0)
  if (total > TOTAL_BUDGET_BYTES) throw new Error(`gen-pack-samples: ${total} bytes of samples exceeds the ${TOTAL_BUDGET_BYTES}-byte budget`)
  return { files, samplesYml: Buffer.from(renderSamplesYml(files), 'utf8'), total }
}

function main() {
  const check = process.argv.includes('--check')
  const { files, samplesYml, total } = generate()
  const expected = new Map(files.map((f) => [join(SAMPLES_DIR, `${f.id}.json`), f.bytes]))
  expected.set(SAMPLES_YML, samplesYml)

  if (check) {
    const problems = []
    for (const [path, bytes] of expected) {
      if (!existsSync(path)) {
        problems.push(`missing: ${path}`)
        continue
      }
      if (!readFileSync(path).equals(bytes)) problems.push(`differs from the generator: ${path}`)
    }
    const want = new Set(files.map((f) => `${f.id}.json`))
    for (const name of existsSync(SAMPLES_DIR) ? readdirSync(SAMPLES_DIR) : []) {
      if (!want.has(name)) problems.push(`not produced by the generator: ${join(SAMPLES_DIR, name)}`)
    }
    if (problems.length) {
      process.stderr.write(`gen-pack-samples --check failed:\n  ${problems.join('\n  ')}\nRun \`npm run pack:samples\` and commit the result.\n`)
      process.exit(1)
    }
    process.stdout.write(`gen-pack-samples: ${files.length} samples, ${files.reduce((s, f) => s + f.count, 0)} events, ${total} bytes - match\n`)
    return
  }

  mkdirSync(SAMPLES_DIR, { recursive: true })
  for (const [path, bytes] of expected) writeFileSync(path, bytes)
  for (const f of files) process.stdout.write(`  ${f.id}.json  ${f.count} events  ${f.bytes.length} bytes\n`)
  process.stdout.write(`gen-pack-samples: wrote ${files.length} samples, ${total} bytes\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
