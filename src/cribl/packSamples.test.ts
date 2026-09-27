// The pack's synthetic samples: reproducible, enough for every dashboard, and
// safe to publish.
//
// THREE CLAIMS, each held still here:
//
//   1. DETERMINISM. scripts/gen-pack-samples.mjs --check regenerates every
//      sample and samples.yml in memory and byte-compares them with the
//      committed files. The generator is the checker, the same pattern as the
//      query freeze: a hand edit, or a change to the generator nobody re-ran,
//      fails here.
//
//   2. COVERAGE. A sample that loads but lights nothing is worse than none: a
//      tab that stays empty on sample data reads as broken. Each dashboard's
//      needs are evaluated below over the events AFTER the pack's own cast and
//      derive functions have run on them — the real PIPELINE_SPEC expressions,
//      not a re-implementation — and the assertions are generated from the
//      app's catalogues wherever one exists (FINDINGS, TECHNIQUES, AMI_CATALOG,
//      tcpHealth's METRICS, PQC_GROUP_CODES), so a new catalogue entry fails
//      here until the samples cover it.
//
//   3. PUBLIC-REPO HYGIENE. The repository is public. Every IPv4 address is in
//      10.20.0.0/16 (private) or a documentation range, and every hostname is
//      under example.com, example.net or example.org. This scan is written
//      independently of the one in scripts/pack.mjs, which the release
//      workflow runs; either one alone would catch a leak.
//
// WHAT THIS DOES NOT ESTABLISH. It evaluates the dashboards' logic in
// JavaScript over the sample file, as a DataGen replaying it in order would
// feed them. It does not run KQL: Cribl's percentile() is approximate and its
// type coercion is measured, not specified. It cannot show how DataGen actually
// replays a sample (in order or at random), nor how `gigamon_origin` surfaces as a
// Search column, nor that replayed events land in the current time window.
// Those are measured by the proof install, not by a unit test.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { PIPELINE_SPEC } from './packSpecs'
import { PACK_ID } from './pack'
import { FINDINGS } from '../data/findings'
import { TECHNIQUES } from '../data/techniques'
import { AMI_CATALOG } from '../data/amiFields'
import { AI_APPS } from '../data/aiApps'
import { SAAS_APPS } from '../data/saasApps'
import { PQC_GROUP_CODES, classifyGroup, sensitivityOf, type Sensitivity } from '../data/pqc'
import { METRICS } from '../queries/tcpHealth'
import { lookalikeKit, STAMPED, type DemoProfile } from '../../scripts/pack-lookalike.mjs'
import { fnv1a, seededRng } from '../../scripts/pack-rng.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GENERATOR = join(ROOT, 'scripts', 'gen-pack-samples.mjs')
const SAMPLES_DIR = join(ROOT, 'packs', PACK_ID, 'data', 'samples')

type Ev = Record<string, unknown>

const files = readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.json')).sort()
const raw: Record<string, string> = Object.fromEntries(files.map((f) => [f, readFileSync(join(SAMPLES_DIR, f), 'utf8')]))
const rawEvents: Ev[] = files.flatMap((f) => JSON.parse(raw[f]) as Ev[])

// ── The pack's own cast + derive, run on each event ─────────────────────────

/**
 * Evaluate a Cribl eval expression against one event. Identifiers that look
 * like field names resolve on the event (absent ones as undefined, as in
 * Cribl); anything else — String, Number, undefined — is the JS global.
 */
function evalExpr(expr: string, ev: Ev): unknown {
  const scope = new Proxy(ev, {
    has: (_t, k) => typeof k === 'string' && /^[a-z_][a-z0-9_]*$/.test(k) && k !== 'undefined',
    get: (t, k) => (typeof k === 'string' ? t[k] : undefined),
  })
  // `with` is the only way to give an expression free variables; a Function
  // body is sloppy-mode code even when this file is a module.
  return new Function('scope', `with (scope) { return (${expr}) }`)(scope)
}

// The whole global pipeline: since the move to Raw HTTP it is exactly the cast
// and derive functions (the prep and parse steps went with Syslog).
const castAndDerive = PIPELINE_SPEC.conf.functions as { filter: string; conf: { add: { name: string; value: string }[] } }[]
const events: Ev[] = rawEvents.map((e) => {
  const out: Ev = { ...e }
  for (const fn of castAndDerive) {
    if (fn.filter !== 'true') throw new Error(`unexpected filter ${fn.filter}`)
    for (const { name, value } of fn.conf.add) out[name] = evalExpr(value, out)
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
})

const present = (v: unknown) => v !== undefined && v !== null && v !== ''
const num = (v: unknown) => Number(v)
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]
}
const groupBy = (evs: Ev[], key: string) => {
  const m = new Map<string, Ev[]>()
  for (const e of evs) {
    if (!present(e[key])) continue
    const k = String(e[key])
    m.set(k, [...(m.get(k) ?? []), e])
  }
  return m
}
const distinct = (evs: Ev[], key: string) => new Set(evs.filter((e) => present(e[key])).map((e) => String(e[key])))

// ── 1. Determinism ──────────────────────────────────────────────────────────

describe('the generator reproduces the committed samples', () => {
  it('--check regenerates every sample and samples.yml byte for byte', () => {
    let out = ''
    try {
      out = execFileSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      throw new Error(`${e.stderr || e.message}\nThe committed samples are not what scripts/gen-pack-samples.mjs produces.`)
    }
    expect(out).toMatch(/match/)
  }, 60_000)

  it('keeps each file under the per-file cap (and Cribl’s 256 KB default) and loops within five minutes', () => {
    // The generator's own cap, read from the script so there is one copy of it.
    const cap = Number(/export const MAX_FILE_BYTES = ([\d_]+)/.exec(readFileSync(GENERATOR, 'utf8'))![1].replace(/_/g, ''))
    expect(cap).toBeLessThan(256 * 1024)
    for (const f of files) {
      expect(Buffer.byteLength(raw[f])).toBeLessThanOrEqual(cap)
      expect((JSON.parse(raw[f]) as Ev[]).length).toBeLessThanOrEqual(300)
    }
  })

  it('every event is tagged as sample data and carries no _time', () => {
    for (const e of rawEvents) {
      expect(e.gigamon_origin).toBe('sample')
      expect(e).not.toHaveProperty('_time')
    }
  })

  it('omits a field rather than writing null or an empty string', () => {
    for (const e of rawEvents) for (const v of Object.values(e)) expect(present(v)).toBe(true)
  })
})

// ── 2. Coverage, per dashboard ──────────────────────────────────────────────

/** The three predicate shapes FINDINGS uses. A new shape fails loudly here. */
function findingMatches(filter: string, e: Ev): boolean {
  let m = /^(\w+)=\*$/.exec(filter)
  if (m) return present(e[m[1]])
  m = /^(\w+)(>=|>|==)(\d+)$/.exec(filter)
  if (m) {
    if (!present(e[m[1]])) return false
    const [v, n] = [num(e[m[1]]), Number(m[3])]
    return m[2] === '>=' ? v >= n : m[2] === '>' ? v > n : v === n
  }
  throw new Error(`packSamples.test.ts cannot evaluate the finding filter "${filter}"; teach findingMatches its shape`)
}

/** The expression shapes TECHNIQUES uses: isnotnull(f), f=="v", f in ("a","b"), joined by `or`. */
function techniqueMatches(expr: string, e: Ev): boolean {
  return expr.split(/\s+or\s+/).some((part) => {
    const p = part.trim().replace(/^\((.*)\)$/, '$1')
    let m = /^isnotnull\((\w+)\)$/.exec(p)
    if (m) return present(e[m[1]])
    m = /^(\w+)=="([^"]*)"$/.exec(p)
    if (m) return String(e[m[1]]) === m[2]
    m = /^(\w+) in \(([^)]*)\)$/.exec(p)
    if (m) return m[2].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).includes(String(e[m[1]]))
    throw new Error(`packSamples.test.ts cannot evaluate the technique expression "${p}"`)
  })
}

describe('Findings: every detection has something to find', () => {
  for (const f of FINDINGS) {
    it(`${f.id}: ${f.filter}`, () => {
      expect(events.some((e) => findingMatches(f.filter, e))).toBe(true)
    })
  }
})

describe('Security: every technique tile lights', () => {
  // A copy of Security.tsx's isInternal: the Lateral Spread tile counts only
  // RFC 1918 sources, which is why internal sample hosts are in 10.20.0.0/16.
  const isInternal = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  const bySrc = [...groupBy(events, 'src_ip')].map(([ip, evs]) => ({ ip, ports: distinct(evs, 'dst_port').size, dsts: distinct(evs, 'dst_ip').size }))

  for (const t of TECHNIQUES) {
    it(`${t.id} ${t.name}`, () => {
      if (t.kind === 'flow') expect(events.some((e) => techniqueMatches(t.expr!, e))).toBe(true)
      else {
        const b = t.behaviour!
        expect(bySrc.some((s) => (b.internalOnly ? isInternal(s.ip) : true) && s[b.metric] >= b.min)).toBe(true)
      }
    })
  }
})

describe('Flow Map: a graph with every health state', () => {
  // FlowMap.tsx's healthOf thresholds: SLO 100 ms, danger at 3x or >=90% resets.
  const nodes = [...groupBy(events, 'dst_aws_flat_tags_name')].map(([name, evs]) => {
    const app = evs.filter((e) => present(e.tcp_rtt_app)).map((e) => num(e.tcp_rtt_app) * 1000)
    const resets = evs.reduce((s, e) => s + (present(e.tcp_reset) ? num(e.tcp_reset) : 0), 0)
    return { name, appMs: app.length ? p95(app) : 0, appN: app.length, resetRate: resets / evs.length }
  })

  it('fits the node limit, so no service is cut from the map', () => {
    expect(nodes.length).toBeGreaterThanOrEqual(8)
    expect(nodes.length).toBeLessThanOrEqual(12)
  })

  it('has a breaching node by latency, one by resets, and an elevated one', () => {
    expect(nodes.some((n) => n.appN > 0 && n.appMs > 300)).toBe(true)
    expect(nodes.some((n) => n.resetRate >= 0.9)).toBe(true)
    expect(nodes.some((n) => n.appMs > 100 && n.appMs <= 300 && n.resetRate < 0.4)).toBe(true)
  })

  it('draws solid edges, a client-only node and dashed spokes to untagged peers', () => {
    const tagged = events.filter((e) => present(e.src_aws_flat_tags_name))
    const edges = new Set(tagged.filter((e) => present(e.dst_aws_flat_tags_name)).map((e) => `${e.src_aws_flat_tags_name}>${e.dst_aws_flat_tags_name}`))
    expect(edges.size).toBeGreaterThanOrEqual(8)
    const dsts = distinct(events, 'dst_aws_flat_tags_name')
    expect([...distinct(tagged, 'src_aws_flat_tags_name')].some((s) => !dsts.has(s))).toBe(true)
    expect(tagged.some((e) => !present(e.dst_aws_flat_tags_name))).toBe(true)
  })

  it('flags DNS as elevated on the resolver node', () => {
    const dns = events.filter((e) => e.dst_aws_flat_tags_name === 'core-dns' && present(e.dns_response_time)).map((e) => num(e.dns_response_time) * 1000)
    expect(p95(dns)).toBeGreaterThan(100)
  })
})

describe('TCP health: every heatmap metric has a hot cell', () => {
  for (const m of METRICS) {
    it(m.field, () => {
      expect(events.some((e) => e.protocol === 6 && present(e.src_subnet) && present(e.dst_subnet) && num(e[m.field]) > 0)).toBe(true)
    })
  }
})

describe('Web and API health', () => {
  const http = events.filter((e) => present(e.http_code))

  it('has enough hosts and codes to fill the panels, within their limits', () => {
    expect(distinct(http, 'http_host').size).toBeGreaterThanOrEqual(5)
    expect(distinct(http, 'http_host').size).toBeLessThanOrEqual(12)
    expect(distinct(http, 'http_code').size).toBeGreaterThanOrEqual(8)
    expect(distinct(http, 'http_code').size).toBeLessThanOrEqual(12)
    expect(http.some((e) => num(e.http_code) >= 500)).toBe(true)
  })

  it('has a host whose server p95 breaches the 200 ms SLO', () => {
    const slow = [...groupBy(http, 'http_host')].some(([, evs]) => p95(evs.filter((e) => present(e.http_server_ms)).map((e) => num(e.http_server_ms))) > 200)
    expect(slow).toBe(true)
  })

  it('carries HTTP/2 records', () => {
    expect(events.some((e) => present(e.http2_host) && present(e.http2_code))).toBe(true)
  })
})

describe('DNS health', () => {
  const dns = events.filter((e) => e.app_name === 'dns')

  it('has three or more resolvers and every reply code the tab counts', () => {
    expect(distinct(dns, 'dns_host').size).toBeGreaterThanOrEqual(3)
    for (const code of ['0', '2', '3']) expect(dns.some((e) => String(e.dns_reply_code) === code)).toBe(true)
  })

  it('has a resolver failing a real share of its queries', () => {
    const failing = [...groupBy(dns, 'dns_host')].some(([, evs]) => evs.filter((e) => String(e.dns_reply_code) === '2').length / evs.length > 0.2)
    expect(failing).toBe(true)
  })
})

describe('Shadow AI', () => {
  const ai = new Set(AI_APPS)
  const saas = new Set(SAAS_APPS)
  const apps = distinct(events, 'app_name')

  it('has AI apps, sanctioned SaaS, and apps in neither list', () => {
    expect([...apps].filter((a) => ai.has(a)).length).toBeGreaterThanOrEqual(5)
    expect([...apps].filter((a) => saas.has(a)).length).toBeGreaterThanOrEqual(5)
    const tls = events.filter((e) => present(e.ssl_server_name))
    expect(tls.some((e) => !ai.has(String(e.app_name)) && !saas.has(String(e.app_name)) && e.app_name !== 'https')).toBe(true)
  })

  it('has three or more users on two or more AI apps', () => {
    const users = [...groupBy(events.filter((e) => ai.has(String(e.app_name))), 'src_ip')].filter(([, evs]) => distinct(evs, 'app_name').size >= 2)
    expect(users.length).toBeGreaterThanOrEqual(3)
  })
})

describe('PQC readiness', () => {
  const groups = [...distinct(events, 'ssl_ext_ec_supported_groups_type')]

  it('offers two or more PQC groups, plus classical and GREASE ones', () => {
    expect(groups.filter((g) => PQC_GROUP_CODES.includes(g)).length).toBeGreaterThanOrEqual(2)
    const classes = new Set(groups.map((g) => classifyGroup(g).cls))
    expect(classes.has('classical')).toBe(true)
    expect(classes.has('grease')).toBe(true)
  })

  it('covers every data-sensitivity class', () => {
    const got = new Set([...distinct(events, 'ssl_server_name')].map(sensitivityOf))
    const all: Sensitivity[] = ['credential', 'pci', 'financial', 'phi', 'business', 'public']
    for (const s of all) expect(got.has(s)).toBe(true)
  })
})

describe('TLS posture: every badge appears', () => {
  // The generator's AS_OF, read from the script so there is one copy of it.
  const asOf = Date.parse(/export const AS_OF = '([^']+)'/.exec(readFileSync(GENERATOR, 'utf8'))![1])

  // A copy of TlsPosture.tsx's assess(), with the generator's AS_OF standing in
  // for Date.now(): a sample's certificate dates are fixed relative to AS_OF.
  const WEAK = new Set(['TLS_1_0', 'TLS_1_1', 'SSL_3_0', 'SSL_2_0'])
  const KNOWN_CA = ['digicert', 'let', 'globalsign', 'sectigo', 'comodo', 'geotrust', 'amazon', 'google trust',
    'gts', 'entrust', 'isrg', 'cloudflare', 'baltimore', 'microsoft', 'apple', 'godaddy', 'thawte', 'rapidssl']
  function assess(ver: string, notafter: string, issuer: string, cn: string, server: string): string {
    const weak = WEAK.has(ver)
    let daysLeft: number | null = null
    if (notafter) {
      const ms = Date.parse(notafter.replace(' ', 'T'))
      if (!Number.isNaN(ms)) daysLeft = Math.round((ms - asOf) / 86400000)
    }
    const iss = issuer.toLowerCase()
    const selfSigned = issuer !== '' && (issuer === cn || issuer === server)
    const knownCA = issuer !== '' && KNOWN_CA.some((k) => iss.includes(k))
    if (daysLeft != null && daysLeft < 0) return weak ? 'EXPIRED · weak' : 'EXPIRED'
    if (weak && daysLeft != null && daysLeft < 30) return 'WEAK + EXPIRING'
    if (weak) return 'WEAK PROTOCOL'
    if (selfSigned) return 'SELF-SIGNED'
    if (issuer !== '' && !knownCA) return 'UNKNOWN CA'
    if (daysLeft != null && daysLeft < 30) return 'RENEW'
    return 'OK'
  }

  const maxOf = (evs: Ev[], k: string) => evs.map((e) => (present(e[k]) ? String(e[k]) : '')).reduce((a, b) => (b > a ? b : a), '')
  const servers = [...groupBy(events, 'ssl_server_name')].map(([name, evs]) => {
    const issuer = maxOf(evs, 'ssl_issuer')
    return { name, issuer, badge: assess(maxOf(evs, 'ssl_protocol_version'), maxOf(evs, 'ssl_validity_not_after'), issuer, maxOf(evs, 'ssl_common_name'), name) }
  })

  for (const badge of ['RENEW', 'EXPIRED', 'WEAK PROTOCOL', 'SELF-SIGNED', 'UNKNOWN CA']) {
    it(badge, () => expect(servers.some((s) => s.badge === badge)).toBe(true))
  }
  it('OK, on a server with a certificate', () => {
    expect(servers.some((s) => s.badge === 'OK' && s.issuer !== '')).toBe(true)
  })
})

describe('Field Explorer: the catalogue is covered', () => {
  // Omitted on purpose: FlowMap.tsx's ⓘ states these have 0 records in this
  // feed, and a sample that carried them would make that prose false.
  const EXCLUDED = ['ssl_alert_level', 'ssl_alert_description']

  it('every AMI_CATALOG field appears at least once, except the declared exclusions', () => {
    const seen = new Set(events.flatMap((e) => Object.keys(e)))
    const missing = AMI_CATALOG.map((f) => f.name).filter((n) => !EXCLUDED.includes(n) && !seen.has(n))
    expect(missing).toEqual([])
  })

  it('the exclusions really are absent', () => {
    for (const n of EXCLUDED) expect(events.some((e) => n in e)).toBe(false)
  })
})

// ── 3. Public-repo hygiene ──────────────────────────────────────────────────

describe('public-repo hygiene', () => {
  const inNet = (ip: string, base: string, bits: number) => {
    const toInt = (s: string) => s.split('.').reduce((n, o) => n * 256 + Number(o), 0)
    if (ip.split('.').some((o) => Number(o) > 255)) return false
    return Math.floor(toInt(ip) / 2 ** (32 - bits)) === Math.floor(toInt(base) / 2 ** (32 - bits))
  }
  const ipOk = (ip: string) =>
    inNet(ip, '10.20.0.0', 16) || inNet(ip, '192.0.2.0', 24) || inNet(ip, '198.51.100.0', 24) || inNet(ip, '203.0.113.0', 24)
  const hostOk = (h: string) => /(^|\.)example\.(com|net|org)$/i.test(h)

  const text = files.map((f) => raw[f]).join('\n')
  // Reverse-lookup names are addresses written backwards; check the address.
  const reverse = [...text.matchAll(/((?:\d{1,3}\.){3}\d{1,3})\.in-addr\.arpa/gi)]
  // Two dotted shapes that are not addresses or hosts, let through only in
  // their own fields and only in their own shape: an OID (2.5.29.15) and an
  // AWS instance type (t3.medium). Each is checked, then taken out of the text.
  const OID = /^[0-2](\.\d+)+$/
  const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.(nano|micro|small|medium|large|\d*xlarge|metal)$/
  const scrubbed = text
    .replace(/(?:\d{1,3}\.){3}\d{1,3}\.in-addr\.arpa/gi, ' ')
    .replace(/"(\w+_oid)":"([^"]*)"/g, (m, _k, v: string) => (OID.test(v) ? ' ' : m))
    .replace(/"(\w+_aws_instance_type)":"([^"]*)"/g, (m, _k, v: string) => (INSTANCE_TYPE.test(v) ? ' ' : m))
  /** A netmask (ones then zeros, 255.255.255.0) identifies no host. */
  const isNetmask = (ip: string) => {
    if (!ip.startsWith('255.') || ip.split('.').some((o) => Number(o) > 255)) return false
    const n = ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
    const inv = (2 ** 32 - 1 - n) >>> 0
    return (inv & (inv + 1)) === 0
  }

  it('every IPv4 address is in 10.20.0.0/16 or a documentation range', () => {
    const ips = [...scrubbed.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)].map((m) => m[1])
    expect(ips.length).toBeGreaterThan(100)
    expect([...new Set(ips.filter((ip) => !ipOk(ip) && !isNetmask(ip)))]).toEqual([])
    const reversed = reverse.map((m) => m[1].split('.').reverse().join('.'))
    expect(reversed.filter((ip) => !ipOk(ip))).toEqual([])
  })

  it('an OID or instance type let through is only ever in its own field', () => {
    for (const e of rawEvents) {
      for (const [k, v] of Object.entries(e)) {
        if (typeof v !== 'string') continue
        if (OID.test(v) && v.split('.').length === 4) expect(k, `${k}=${v}`).toMatch(/_oid$/)
        if (INSTANCE_TYPE.test(v)) expect(k, `${k}=${v}`).toMatch(/_aws_instance_type$/)
      }
    }
  })

  it('every hostname is under example.com, example.net or example.org', () => {
    const hosts = [...scrubbed.matchAll(/(?<![\w.-])((?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]*)(?![\w-])/gi)].map((m) => m[1])
    // A file name in an FTP command is the one non-host token of that shape.
    const notHosts = new Set(['nightly_export.csv'])
    expect([...new Set(hosts.filter((h) => !notHosts.has(h) && !hostOk(h)))]).toEqual([])
  })

  it('every value of a host-bearing field is an example domain', () => {
    const fields = ['http_host', 'http2_host', 'ssl_server_name', 'ssl_common_name', 'dhcp_host_name', 'sip_callee_domain', 'krb5_realm']
    for (const e of rawEvents) {
      for (const f of fields) if (present(e[f])) expect(hostOk(String(e[f])), `${f}=${String(e[f])}`).toBe(true)
      if (present(e.dns_query) && !/\.in-addr\.arpa$/i.test(String(e.dns_query))) expect(hostOk(String(e.dns_query)), String(e.dns_query)).toBe(true)
    }
  })

  it('every flow is IPv4; a MAC is only in the documentation block, an IPv6 answer only in 2001:db8::/32', () => {
    expect(events.every((e) => e.ip_version === 4)).toBe(true)
    // RFC 7042's documentation MACs, 00:00:5e:00:53:00/24.
    const macs = [...text.matchAll(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi)].map((m) => m[0])
    expect(macs.length).toBeGreaterThan(100)
    expect([...new Set(macs.filter((m) => !/^00:00:5e:00:53:[0-9a-f]{2}$/i.test(m)))]).toEqual([])
    // Any colon-hex run of eight groups, or one with a `::`, standing alone.
    const v6 = [...text.matchAll(/(?<![\w:])((?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|[0-9a-f:]*::[0-9a-f:]*)(?![\w:])/gi)].map((m) => m[1]).filter((m) => m.length > 2)
    expect(v6.length).toBeGreaterThan(0)
    expect([...new Set(v6.filter((a) => !/^2001:0?db8:/i.test(a)))]).toEqual([])
  })
})

// ── 4. The demo lookalike ───────────────────────────────────────────────────
//
// Owner decision 2026-09-26: the samples are the SHAPE of the workspace's
// worker-group demo DataGen, synthesized. scripts/demo-profile.json is the
// statistics of it (scripts/derive-demo-profile.mjs, run by hand from files
// that never enter the repository). These hold the samples to the profile,
// and the profile to the same hygiene as the samples.

describe('the demo lookalike', () => {
  const PROFILE = JSON.parse(readFileSync(join(ROOT, 'scripts', 'demo-profile.json'), 'utf8')) as DemoProfile
  const demoFields = Object.keys(PROFILE.fields).filter((f) => f !== '_time')

  it('every field the demo carries appears in the samples', () => {
    const seen = new Set(rawEvents.flatMap((e) => Object.keys(e)))
    expect(demoFields.filter((f) => !seen.has(f))).toEqual([])
  })

  it('every field the demo sends as a string arrives as a string', () => {
    const strings = new Set(demoFields.filter((f) => PROFILE.fields[f].type === 'string'))
    const wrong = new Set<string>()
    for (const e of rawEvents) for (const [k, v] of Object.entries(e)) if (strings.has(k) && typeof v !== 'string') wrong.add(k)
    expect([...wrong]).toEqual([])
  })

  it('a field appears only on an application the demo saw carry it, or on a scenario event', () => {
    // Scenario-only apps (postgresql, redis, ...) are not in the demo; only the
    // demo apps are held. A scenario's own vocabulary is its own decision.
    const byApp = new Map(PROFILE.apps.map((a) => [a.app, a]))
    const KEY_ORDER = new Set(readFileSync(GENERATOR, 'utf8').match(/const KEY_ORDER = \[([\s\S]*?)\]/)![1].match(/'([a-z0-9_]+)'/g)!.map((s) => s.slice(1, -1)))
    const STAMPED = ['id', 'seq_num', 'start_time', 'end_time', 'ts', 'generator', 'event_type', 'vendor', 'version', 'end_reason', 'src_mac', 'dst_mac', 'app_id', 'gigamon_origin', 'app_name']
    const stray: string[] = []
    for (const e of rawEvents) {
      const a = byApp.get(String(e.app_name))
      if (!a) continue
      for (const k of Object.keys(e)) {
        if (KEY_ORDER.has(k) || STAMPED.includes(k)) continue
        if (!(a.present[k] > 0)) stray.push(`${a.app}.${k}`)
      }
    }
    expect([...new Set(stray)]).toEqual([])
  })

  describe('a lookalike event, drawn many times', () => {
    // The mechanism, not the committed files: which of a file's events are
    // lookalike is not recorded in them. 4,000 draws of the demo's largest
    // application, through the generator's own kit and PRNG.
    const kit = lookalikeKit({
      profile: PROFILE, rng: seededRng(1), fnv1a, keyOrder: [],
      webHosts: ['www.example.com'], webCodes: ['200', '404'], asOfMs: Date.parse('2026-10-01T00:00:00Z'),
    })
    const a = PROFILE.apps[0]
    const r = seededRng(2)('test')
    const drawn = Array.from({ length: 4000 }, () => kit.lookalike(r, a))

    it('carries each field at the demo’s rate for that application, within 3 points', () => {
      const off: string[] = []
      for (const [f, n] of Object.entries(a.present)) {
        if (STAMPED.includes(f) || ['src_ip', 'dst_ip', 'protocol', 'ip_version'].includes(f)) continue
        const got = drawn.filter((e) => f in e).length / drawn.length
        if (Math.abs(got - n / a.events) > 0.03) off.push(`${f}: ${got.toFixed(3)} vs ${(n / a.events).toFixed(3)}`)
      }
      expect(off).toEqual([])
    })

    it('copies an enumeration only as a value the demo sent for that application', () => {
      const bad: string[] = []
      for (const e of drawn) {
        for (const [f, dist] of Object.entries(a.categorical)) {
          if (f in e && f !== 'dst_port' && !(String(e[f]) in dist)) bad.push(`${f}=${String(e[f])}`)
        }
      }
      expect([...new Set(bad)]).toEqual([])
    })

    it('writes every demo field as the demo does: a string', () => {
      for (const e of drawn.slice(0, 200)) {
        const typed = kit.finishTypes(e)
        for (const [k, v] of Object.entries(typed)) if (k in PROFILE.fields) expect(typeof v, k).toBe('string')
      }
    })
  })

  it('the DataGen replays the demo’s largest application most, and every sample loops the lookalike in', () => {
    const mix = new Map<string, number>()
    for (const f of files) {
      const evs = JSON.parse(raw[f]) as Ev[]
      for (const e of evs) mix.set(String(e.app_name), (mix.get(String(e.app_name)) ?? 0) + 1 / evs.length / files.length)
    }
    const top = [...mix.entries()].sort((x, y) => y[1] - x[1])[0]
    expect(top[0]).toBe(PROFILE.apps[0].app)
    expect(top[1]).toBeGreaterThan(0.3)
  })

  it('the profile states the demo’s own rate, 146 events a second (73 samples at 2 each)', () => {
    expect(PROFILE.totals.eventsPerSec).toBe(146)
  })

  it('the profile itself holds no address, MAC, email or hostname', () => {
    const txt = readFileSync(join(ROOT, 'scripts', 'demo-profile.json'), 'utf8')
      .replace(/"(\w+_oid)": ?\{[^}]*\}/g, ' ')
    expect(txt).not.toMatch(/(?<![\d.])\d{1,3}(\.\d{1,3}){3}(?![\d.])/)
    expect(txt).not.toMatch(/\b[0-9a-f]{2}(:[0-9a-f]{2}){5}\b/i)
    expect(txt).not.toMatch(/[\w.-]+@[\w-]+\./)
    const hosts = [...txt.matchAll(/(?<![\w.-])((?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]*)(?![\w-])/gi)].map((m) => m[1])
      .filter((h) => !/\.(mjs|json)$/.test(h))
    expect([...new Set(hosts)]).toEqual([])
  })
})
