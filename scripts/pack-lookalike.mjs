// The demo lookalike: what makes the pack's samples the SHAPE of the
// workspace's worker-group demo DataGen (in_gigamon_datagen), used by
// scripts/gen-pack-samples.mjs.
//
// Owner decision 2026-09-26: the pack's sample DataGen produces "all the same
// data" as the demo DataGen, as a SYNTHESIZED LOOKALIKE. The demo's own sample
// files are real captured traffic and are never read here: this module reads
// only scripts/demo-profile.json, the statistics scripts/derive-demo-profile.mjs
// wrote from them (field names, arrival types, per-application presence counts,
// quantiles of sizes and timings, and the distributions of an allowlist of
// Gigamon enumerations). So CI needs nothing under .dev/.
//
// THREE THINGS IT DOES:
//
//   1. LOOKALIKE EVENTS. One per application first (a "coverage" event carrying
//      every field that application ever carried, so every field name of the
//      demo appears), then events drawn at the demo's application mix, each
//      field present at that application's own rate. A value is copied from the
//      profile only for an allowlisted enumeration (or a service port); a size
//      or timing is drawn between that application's p10 and p90; everything
//      that could identify anyone — addresses, names, MACs, ids, keys, agents,
//      URIs, free text — is made up here, from the same safe vocabulary as the
//      scenarios (10.20.0.0/16, the documentation ranges, example.* names,
//      the documentation MAC block 00:00:5e:00:53:00/24 of RFC 7042, and the
//      IPv6 documentation prefix 2001:db8::/32).
//
//   2. DRESSING the scenario events (the ones that light every tab) in the same
//      shape: each gains, at its application's rate, the demo's fields its
//      scenario does not already decide. A scenario's own vocabulary
//      (KEY_ORDER), and the families the tabs read for health, TLS posture and
//      the service map (DRESS_DENY), are never touched, so dressing cannot move
//      a tab's number.
//
//   3. STAMPING every event, after the files are assembled, with the flow
//      record fields every demo event carries (id, seq_num, start/end time, ts,
//      MACs, generator, event_type, vendor, version, end_reason), in replay
//      order.
//
// TYPES AS THEY ARRIVE. The demo sends every field but `_time` as a JSON string
// ("443", "0.004123"): Gigamon's own encoding. `finishTypes` writes every field
// the profile types `string` as a string, so the pack's pipeline casts exactly
// what the global gigamon_ami pipeline casts (packSpecs.ts PIPELINE_SPEC's
// NUMERIC_FIELDS, copied from it). A scenario-only field the demo never carries
// (tcp_zero_window, the k8s names, ...) keeps its scenario type: there is no
// evidence of how it would arrive.

/** Fields STAMP writes on every event, in replay order. */
export const STAMPED = [
  'id', 'seq_num', 'start_time', 'end_time', 'ts', 'generator', 'event_type', 'vendor', 'version', 'end_reason',
  'src_mac', 'dst_mac',
]

/** Families a tab reads for a health state, a badge or a node: never added to a scenario event. */
const DRESS_DENY = [
  /^src_aws_/, /^dst_aws_/, /_workload_platform$/, /^tcp_/, /^ssl_cert/, /^ssl_validity/, /^ssl_issuer$/,
  /^ssl_organization_name$/, /^ssl_common_name$/, /^ssl_subject_alt_name$/, /^ssl_serial_number$/,
  /^http_request_ts$/, /^http_response_ts$/, /^http_rtt$/, /^dns_response_time$/, /^dns_host$/, /^udp_wrong_crc$/,
  /^ip_wrong_crc$/, /^app_id$/, /^protocol$/, /^ip_version$/, /_ip$/, /_port$/, /_bytes$/, /_packets$/,
]

/** The one synthetic probe name the demo's `generator` field is written as. */
export const GENERATOR_NAME = 'ami-sensor-01.example.net'

// ── Address plan of the lookalike (disjoint from every scenario's hosts) ─────

const LOOK_CLIENTS = Array.from({ length: 40 }, (_, i) => `10.20.6.${10 + i}`)
const LOOK_SERVERS = Array.from({ length: 20 }, (_, i) => `10.20.7.${10 + i}`)
const LOOK_EXTERNAL = [
  ...Array.from({ length: 60 }, (_, i) => `203.0.113.${100 + i}`),
  ...Array.from({ length: 40 }, (_, i) => `198.51.100.${200 + i}`),
]
/** The scenario's two tagged resolvers: the demo's DNS goes to internal resolvers. */
const LOOK_RESOLVERS = ['10.20.5.53', '10.20.5.54']
/** Two AWS-tagged hosts of the lookalike's own: the service map stays within its node limit. */
const LOOK_TAGGED = ['bastion', 'build-runner']

const CA_NAMES = ['DigiCert Global G2 TLS RSA SHA256 2020 CA1', "Let's Encrypt R11", 'Amazon RSA 2048 M02',
  'Sectigo RSA Domain Validation Secure Server CA']
const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'curl/8.4.0', 'python-requests/2.31.0', 'Debian APT-HTTP/1.3 (2.7.14)',
]
const SERVERS = ['nginx/1.24.0', 'Apache/2.4.58', 'envoy', 'cloudfront']
const URIS = ['/', '/v1/status', '/api/v2/items', '/ubuntu/dists/noble/InRelease', '/generate_204', '/health', '/login']
const HEADER_NAMES = ['Host', 'User-Agent', 'Accept', 'Content-Type', 'Server']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const INSTANCE_TYPES = ['t3.medium', 'm5.large', 'c5.xlarge']

const pad = (n, w = 2) => String(n).padStart(w, '0')
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const httpDate = (ms) => {
  const d = new Date(ms)
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`
}
const isoSec = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

export function lookalikeKit({ profile, rng, fnv1a, keyOrder, webHosts, webCodes, asOfMs }) {
  const APPS = new Map(profile.apps.map((a) => [a.app, a]))
  const STRING_FIELDS = new Set(Object.entries(profile.fields).filter(([, f]) => f.type === 'string').map(([k]) => k))
  const SCENARIO_KEYS = new Set(keyOrder)
  /** The demo's single-valued constants, read off its largest application. */
  const top = profile.apps[0]
  const modeOf = (m) => Object.entries(m).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0]
  const CONST = Object.fromEntries(['event_type', 'vendor', 'version'].map((k) => [k, modeOf(top.categorical[k])]))
  const macOf = (ip) => `00:00:5e:00:53:${pad((fnv1a(`mac:${ip}`) % 256).toString(16))}`
  const digits = (r, n) => {
    let s = String(r.int(1, 9))
    while (s.length < n) s += String(r.int(0, 9))
    return s
  }

  function weighted(r, m) {
    return r.weighted(Object.entries(m))
  }

  function numeric(r, st) {
    const { p10, p50, p90, decimals } = st
    let x
    if (!(p90 > p10)) x = p50
    else if (p10 > 0) {
      x = r.lognormal(p50 > 0 ? p50 : (p10 + p90) / 2, Math.log(p90 / p10) / 2.5631)
      x = Math.min(Math.max(x, p10 / 2), p90 * 2)
    } else x = p10 + r.next() * (p90 - p10)
    return x.toFixed(decimals)
  }

  /** A made-up value for a field the profile gives no distribution for. */
  function synth(f, r, ctx) {
    const side = f.startsWith('src_') ? 'src' : 'dst'
    const tag = ctx.tag?.[side] ?? LOOK_TAGGED[0]
    switch (f) {
      case 'src_port': return String(r.int(1024, 65535))
      case 'dst_port': return String(r.int(10001, 65535))
      case 'app_id': return String(1 + (fnv1a(`app:${ctx.app}`) % 4000))
      // The DNS tab reads dns_host as the resolver (the scenarios write its
      // address), so a lookalike DNS flow names the resolver it went to.
      case 'dns_host': return ctx.dst
      case 'dns_query':
      case 'dns_name': return ctx.dnsName
      case 'dns_host_addr':
      case 'dns_reverse_addr': return r.pick([...LOOK_SERVERS, ...LOOK_EXTERNAL])
      case 'dns_host_addr6':
      case 'dns_reverse_addr6': return `2001:0db8:${[0, 0, 0, 0, 0, 0].map(() => r.hex(4)).join(':')}`
      case 'ntp_reference_clock': return '192.0.2.123'
      case 'dhcp_chaddr': return macOf(`dhcp:${ctx.src}`)
      case 'dhcp_ciaddr':
      case 'dhcp_yiaddr': return ctx.src
      case 'dhcp_siaddr':
      case 'dhcp_dns_server': return '10.20.5.53'
      // A netmask, not an address: both hygiene scans let a contiguous mask through.
      case 'dhcp_subnetmask': return '255.255.255.0'
      case 'dhcp_domain_name': return 'corp.example.com'
      case 'dhcp_host_name': return `ws-${r.int(100, 999)}.corp.example.com`
      case 'dhcp_option_value_buffer': return r.hex(8)
      case 'http_host': return ctx.httpHost
      case 'http2_host': return `www.${slug(ctx.app)}.example.com`
      case 'http_uri':
      case 'http_uri_decoded':
      case 'http_uri_full':
      case 'http_uri_path':
      case 'http2_uri_raw': return ctx.uri
      case 'http_referer_server': return 'www.example.com'
      case 'http_referer_path': return '/'
      case 'http_user_agent':
      case 'http2_user_agent': return r.pick(UA)
      // http_server is host-shaped in the demo; the agent strings are *_server_agent's.
      case 'http_server': return ctx.httpHost
      case 'http_server_agent':
      case 'http2_server_agent': return ctx.server
      case 'http_referer': return 'https://www.example.com/'
      case 'http_location':
      case 'http2_location': return `https://www.example.com${r.pick(URIS)}`
      case 'http_cookie': return `session=${r.hex(16)}`
      case 'http_etag': return `"${r.hex(16)}"`
      case 'http_expires':
      case 'http_last_modified':
      case 'http2_date': return httpDate(asOfMs + r.int(-30, 30) * 86_400_000)
      case 'http_header_name':
      case 'http_header_private_name': return r.pick(HEADER_NAMES)
      // HTTP/2 names its headers with the demo's ':'-prefixed pseudo-headers.
      case 'http2_header_name': return ctx.h2Header[0]
      case 'http2_header_value': return ctx.h2Header[1]
      case 'http2_header_raw': return `${ctx.h2Header[0]}: ${ctx.h2Header[1]}`
      case 'http_header_value': return r.pick(['text/html', 'application/json', 'text/plain'])
      case 'http_header_private_value': return r.hex(24)
      case 'http_header_statusline': return `GET ${ctx.uri} HTTP/1.1`
      case 'http_request_ts': return ctx.reqTs
      case 'http_response_ts': return ctx.respTs
      case 'http2_file_generic_id': return digits(r, 6)
      case 'http2_file_generic_name': return 'nightly_export.csv'
      case 'http2_content_disposition': return 'attachment; filename="nightly_export.csv"'
      case 'ssl_server_name':
      case 'ssl_server_name_raw':
      case 'ssl_common_name':
      case 'ssl_certificate_subject_cn': return ctx.sni
      case 'ssl_subject_alt_name': return `DNS:${ctx.sni}`
      case 'ssl_issuer':
      case 'ssl_certificate_issuer_cn': return ctx.issuer
      case 'ssl_certificate_dn_subject': return `CN=${ctx.sni},O=Example Org,C=US`
      case 'ssl_certificate_dn_issuer': return `CN=${ctx.issuer},O=Example Trust,C=US`
      case 'ssl_certificate_issuer_c':
      case 'ssl_certificate_subject_c': return 'US'
      case 'ssl_certificate_issuer_o': return 'Example Trust'
      case 'ssl_certificate_subject_o':
      case 'ssl_organization_name': return 'Example Org'
      case 'ssl_certificate_issuer_ou':
      case 'ssl_certificate_subject_ou': return 'Operations'
      case 'ssl_certificate_issuer_l':
      case 'ssl_certificate_subject_l': return 'Springfield'
      case 'ssl_certificate_issuer_st':
      case 'ssl_certificate_subject_st': return 'Example State'
      case 'ssl_serial_number':
      case 'ssl_certif_md5': return r.hex(32)
      case 'ssl_certif_sha1':
      case 'ssl_cert_ext_authority_key_id':
      case 'ssl_cert_ext_subject_key_id': return r.hex(40)
      case 'ssl_session_id': return r.hex(64)
      case 'ssl_validity_not_before': return isoSec(asOfMs - r.int(30, 200) * 86_400_000)
      case 'ssl_validity_not_after': return isoSec(asOfMs + r.int(120, 400) * 86_400_000)
      case 'ssh_server_agent':
      case 'ssh_user_agent': return r.pick(['OpenSSH_9.6', 'OpenSSH_8.9'])
      case 'ssh_tsp_alg_kex':
      case 'ssh_tsp_alg_kex_guessed_cts':
      case 'ssh_tsp_alg_kex_guessed_stc': return f === 'ssh_tsp_alg_kex' ? 'curve25519-sha256,ecdh-sha2-nistp256,diffie-hellman-group14-sha256' : 'curve25519-sha256'
      case 'ssh_tsp_alg_server_host_key': return 'ssh-ed25519,rsa-sha2-512,ecdsa-sha2-nistp256'
      case 'ssh_tsp_alg_encrypt_cts':
      case 'ssh_tsp_alg_encrypt_stc': return 'chacha20-poly1305,aes256-gcm,aes256-ctr'
      case 'ssh_tsp_alg_encrypt_guessed_cts':
      case 'ssh_tsp_alg_encrypt_guessed_stc': return 'chacha20-poly1305'
      case 'ssh_tsp_alg_mac_cts':
      case 'ssh_tsp_alg_mac_stc': return 'hmac-sha2-256,hmac-sha2-512'
      case 'ssh_tsp_alg_mac_guessed_cts':
      case 'ssh_tsp_alg_mac_guessed_stc': return 'hmac-sha2-256'
      case 'ssh_tsp_alg_comp_cts':
      case 'ssh_tsp_alg_comp_stc': return 'none,zlib'
      case 'ssh_tsp_server_key': return r.hex(64)
      case 'snmp_community': return 'public'
      case 'snmp_oid': return r.pick(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.2.2.1.10.1'])
      case 'snmp_request_id': return digits(r, 5)
      case 'snmp_value_raw': return r.hex(4)
      case 'icmp_id':
      case 'icmp_seq': return String(r.int(1, 999))
      case 'krb5_realm': return 'CORP.EXAMPLE.COM'
      case 'krb5_ticket_name': return 'HTTP/intranet.corp.example.com'
      case 'sip_from': return '<sip:1001@voip.example.com>'
      case 'sip_contact': return 'sip:1001@voip.example.com'
      case 'sip_callee_domain':
      case 'sip_caller_domain': return 'voip.example.com'
      case 'sip_callee_user_phone': return '1002'
      case 'sip_caller_user_phone': return '1001'
      case 'sip_cseq': return '1 INVITE'
      case 'ftp_data_content': return 'RETR nightly_export.csv'
      case 'dcerpc_call_id': return String(r.int(1, 99))
      case 'whatsapp_service_id':
      case 'rtp_service_id':
      case 'rtp_snumber':
      case 'rtp_timestamp': return digits(r, 6)
      case 'whatsapp_service_duration_tv':
      case 'rtp_service_duration_tv': return `${r.int(1, 90)}.${digits(r, 6)}`
      case 'ftp_data_inherit_key':
      case 'gtp_inherit_key':
      case 'rtp_inherit_key':
      case 'rtp_inherit_parent':
      case 'rtcp_inherit_key': return r.hex(12)
      case 'gtp_qos_raw':
      case 'rtp_payload_data': return r.hex(24)
    }
    // AWS metadata of a tagged host: the lookalike's own two, never a scenario's.
    const aws = /^(src|dst)_aws_(.+)$/.exec(f)
    if (aws) {
      const k = aws[2]
      const h = (n) => rng(`look:aws:${tag}:${k}`).hex(n)
      // Behind NAT the flow's own address may be public; the instance's is not.
      const privateIp = () => (ctx[side].startsWith('10.20.') ? ctx[side] : LOOK_SERVERS[fnv1a(tag) % LOOK_SERVERS.length])
      switch (k) {
        case 'availability_zone':
        case 'flat_tags_zone': return 'us-example-1a'
        case 'flat_tags_region': return 'us-example-1'
        case 'flat_tags_department': return 'platform'
        case 'flat_tags_deploy': return 'lab'
        case 'flat_tags_gigamonnode': return 'false'
        case 'flat_tags_gigamonnodeid': return h(8)
        case 'flat_tags_name': return tag
        case 'flat_tags_service_type': return tag === 'bastion' ? 'bastion' : 'ci'
        case 'iam_instance_profile_arn': return `arn:aws:iam::123456789012:instance-profile/${tag}-role`
        case 'iam_instance_profile_id': return `AIPA${h(17).toUpperCase()}`
        case 'image_id': return `ami-${h(17)}`
        case 'instance_id': return `i-${h(17)}`
        case 'instance_type': return INSTANCE_TYPES[fnv1a(tag) % INSTANCE_TYPES.length]
        case 'network_if_attach_id': return `eni-attach-${h(17)}`
        case 'network_if_id': return `eni-${h(17)}`
        case 'private_dns_name': return `ip-${privateIp().replace(/\./g, '-')}.ec2.example.net`
        case 'private_ip': return privateIp()
        case 'public_dns_name': return `${tag}.ec2.example.net`
        case 'public_ip': return `203.0.113.${240 + (fnv1a(tag) % 10)}`
        case 'security_group_id': return `sg-${h(17)}`
        case 'security_group_name': return `${tag}-sg`
        case 'subnet_id': return `subnet-${h(17)}`
        case 'tags': return `Deploy: Lab, Name: ${tag}, Service Type: ${tag === 'bastion' ? 'Bastion' : 'Ci'}`
        case 'vpc_id': return `vpc-${h(17)}`
      }
    }
    throw new Error(`pack-lookalike: no rule makes up a value for "${f}"; add one (never copy a demo value)`)
  }

  /** Values shared across one event's fields, so they agree with each other. */
  function context(r, a, ev) {
    const src = ev.src_ip ?? (r.chance(a.srcPrivate / a.events) ? r.pick(LOOK_CLIENTS) : r.pick(LOOK_EXTERNAL))
    const dst = ev.dst_ip ?? (a.app === 'dns' ? r.pick(LOOK_RESOLVERS) : r.chance(a.dstPrivate / a.events) ? r.pick(LOOK_SERVERS) : r.pick(LOOK_EXTERNAL))
    const reqTs = (100_000 + r.int(0, 86_400) + r.next()).toFixed(6)
    const uri = ev.http_uri ?? r.pick(URIS)
    const h2Host = `www.${slug(a.app)}.example.com`
    return {
      app: a.app,
      src,
      dst,
      tag: { src: r.pick(LOOK_TAGGED), dst: r.pick(LOOK_TAGGED) },
      dnsName: ev.dns_query ?? `${r.hex(r.int(13, 17))}.${r.pick(['cdn-a', 'edge-b', 'svc-c'])}.example.org`,
      httpHost: ev.http_host ?? r.pick(webHosts),
      uri,
      h2Header: r.pick([[':method', 'GET'], [':status', '200'], [':path', uri], [':authority', h2Host], [':scheme', 'https']]),
      server: ev.http_server ?? r.pick(SERVERS),
      sni: ev.ssl_server_name ?? `${slug(a.app) || 'tls'}.example.net`,
      issuer: ev.ssl_issuer ?? r.pick(CA_NAMES),
      reqTs,
      respTs: (Number(reqTs) + r.lognormal(0.05, 0.6)).toFixed(6),
    }
  }

  function valueOf(f, a, r, ctx) {
    if (f === 'src_ip') return ctx.src
    if (f === 'dst_ip') return ctx.dst
    const cat = a.categorical[f]
    if (f === 'dst_port' && cat) {
      const v = weighted(r, cat)
      return v === 'ephemeral' ? String(r.int(10001, 65535)) : v
    }
    if (f === 'http_code' && cat) {
      // The Web tab's codes panel holds twelve; the scenarios fill it. A demo
      // code outside that set would push one of them off, so draw within it.
      const inSet = Object.fromEntries(Object.entries(cat).filter(([c]) => webCodes.includes(c)))
      return Object.keys(inSet).length ? weighted(r, inSet) : '200'
    }
    if (cat) return weighted(r, cat)
    if (a.numeric[f]) return numeric(r, a.numeric[f])
    return synth(f, r, ctx)
  }

  /** Twins the demo writes as copies of each other. */
  function twins(ev) {
    if (ev.dns_name !== undefined && ev.dns_query !== undefined) ev.dns_name = ev.dns_query
    if (ev.ssl_server_name_raw !== undefined && ev.ssl_server_name !== undefined) ev.ssl_server_name_raw = ev.ssl_server_name
    if (ev.http_uri !== undefined) {
      if (ev.http_uri_decoded !== undefined) ev.http_uri_decoded = ev.http_uri
      if (ev.http_uri_full !== undefined) ev.http_uri_full = ev.http_uri
      if (ev.http_uri_path !== undefined) ev.http_uri_path = String(ev.http_uri).split('?')[0]
    }
    if (ev.http_referer !== undefined) {
      const m = /^https?:\/\/([^/]+)(\/.*)?$/.exec(String(ev.http_referer))
      if (m && ev.http_referer_server !== undefined) ev.http_referer_server = m[1]
      if (m && ev.http_referer_path !== undefined) ev.http_referer_path = m[2] ?? '/'
    }
    return ev
  }

  const appFields = (a) => Object.keys(a.present).filter((f) => !STAMPED.includes(f)).sort()

  /** A field's family: its protocol prefix, the flow counters, or one side's AWS metadata. */
  const familyOf = (f) => {
    if (/^(src|dst)_(bytes|packets)$/.test(f)) return 'flow'
    const aws = /^(src|dst)_(aws|workload)_/.exec(f)
    if (aws) return `${aws[1]}_aws`
    return f.split('_')[0]
  }

  /**
   * Which fields travel together, per application. The profile keeps each
   * field's count, not which fields shared an event, so co-occurrence is
   * rebuilt from the counts: within a family, fields with the same count are
   * one group (drawn once), and every smaller group of the family is drawn
   * only on an event that has the family's largest, at count / largest. Each
   * field still appears at its own rate (largest/n × count/largest = count/n);
   * a certificate's fields then come with a TLS session rather than without.
   */
  const PLANS = new Map()
  function planOf(a) {
    if (PLANS.has(a.app)) return PLANS.get(a.app)
    const fam = new Map()
    for (const f of appFields(a)) {
      const k = familyOf(f)
      if (!fam.has(k)) fam.set(k, new Map())
      const byCount = fam.get(k)
      const n = a.present[f]
      if (!byCount.has(n)) byCount.set(n, [])
      byCount.get(n).push(f)
    }
    const plan = [...fam.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([family, byCount]) => ({
      family,
      groups: [...byCount.entries()].sort((x, y) => y[0] - x[0]).map(([count, fields]) => ({ count, fields })),
    }))
    PLANS.set(a.app, plan)
    return plan
  }

  /** The fields one event of `a` carries; `anchored(family)` says a family is already there. */
  function drawFields(r, a, anchored = () => false) {
    const out = []
    for (const { family, groups } of planOf(a)) {
      const lead = groups[0]
      const has = anchored(family) || r.chance(lead.count / a.events)
      if (!has) continue
      out.push(...lead.fields)
      for (const g of groups.slice(1)) if (r.chance(g.count / lead.count)) out.push(...g.fields)
    }
    return out
  }

  /**
   * One lookalike event of application `a`, its fields drawn by `drawFields`;
   * `force` adds fields regardless (coverage, below).
   */
  function lookalike(r, a, { force = [] } = {}) {
    const ev = { gigamon_origin: 'sample', app_name: a.app }
    const ctx = context(r, a, {})
    const chosen = new Set([...drawFields(r, a), ...force])
    for (const f of appFields(a)) {
      if (chosen.has(f)) ev[f] = valueOf(f, a, r, ctx)
    }
    // Every demo flow carries its addresses and protocol; ports only where it has them.
    ev.src_ip = ctx.src
    ev.dst_ip = ctx.dst
    ev.protocol ??= a.categorical.protocol ? weighted(r, a.categorical.protocol) : '6'
    ev.ip_version ??= '4'
    return twins(ev)
  }

  /** The scenario event, plus the demo's fields for its application that it does not decide. */
  function dress(r, ev) {
    const a = APPS.get(ev.app_name)
    if (!a) return ev
    const ctx = context(r, a, ev)
    const out = { ...ev }
    // A family the scenario already wrote (its DNS or TLS fields) is there.
    const families = new Set(Object.keys(ev).map(familyOf))
    for (const f of drawFields(r, a, (fam) => families.has(fam))) {
      if (SCENARIO_KEYS.has(f) || f in out || DRESS_DENY.some((re) => re.test(f))) continue
      out[f] = valueOf(f, a, r, ctx)
    }
    if (a.categorical.app_id) out.app_id = modeOf(a.categorical.app_id)
    return twins(out)
  }

  /** The flow record fields every demo event carries, at replay position `p` of file `fileIndex`. */
  function stamp(r, ev, fileIndex, p) {
    const a = APPS.get(ev.app_name)
    const start = asOfMs + p * 1000 + r.int(0, 999)
    const end = start + Math.min(60_000, Math.round(r.lognormal(1500, 1.2)))
    const d = new Date(end)
    const gtime = (ms) => {
      const t = new Date(ms)
      return `${t.getUTCFullYear()}:${pad(t.getUTCMonth() + 1)}:${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.${pad(t.getUTCMilliseconds(), 3)}`
    }
    return {
      ...ev,
      id: digits(r, 19),
      seq_num: String(1_000_000 + fileIndex * 100_000 + p),
      start_time: gtime(start),
      end_time: gtime(end),
      ts: `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`,
      generator: GENERATOR_NAME,
      ...CONST,
      end_reason: a?.categorical.end_reason ? weighted(r, a.categorical.end_reason) : weighted(r, top.categorical.end_reason),
      src_mac: macOf(ev.src_ip),
      dst_mac: macOf(ev.dst_ip),
    }
  }

  /** Every field the demo sends as a string, as a string. */
  function finishTypes(ev) {
    const out = {}
    for (const [k, v] of Object.entries(ev)) out[k] = STRING_FIELDS.has(k) && typeof v !== 'string' ? String(v) : v
    return out
  }

  /**
   * Coverage: the fewest extra events that make every demo field appear.
   * Greedy: the application that carries the most still-missing fields gets
   * one ordinary event of its own with those fields forced on; repeat. A field
   * is only ever forced onto an application the demo saw carry it. Then one
   * unforced event of each demo application that neither the scenarios
   * (`alreadyApps`) nor the field pass produced, so every label appears.
   */
  function coverage(r, already, alreadyApps = new Set()) {
    const missing = new Set(Object.keys(profile.fields).filter((f) => f !== '_time' && !STAMPED.includes(f) && !already.has(f)))
    const out = []
    while (missing.size) {
      let best = null
      let bestN = 0
      for (const a of profile.apps) {
        const n = Object.keys(a.present).filter((f) => missing.has(f)).length
        if (n > bestN) [best, bestN] = [a, n]
      }
      if (!best) throw new Error(`pack-lookalike: no demo application carries ${[...missing].join(', ')}`)
      const force = Object.keys(best.present).filter((f) => missing.has(f))
      const ev = lookalike(r, best, { force })
      for (const f of Object.keys(ev)) missing.delete(f)
      out.push(ev)
    }
    // Then one ordinary event of every demo application no event carries yet,
    // so the samples carry every application label the demo does.
    const seen = new Set([...alreadyApps, ...out.map((e) => e.app_name)])
    for (const a of profile.apps) if (!seen.has(a.app)) out.push(lookalike(r, a))
    return out
  }

  /** The demo's applications, largest first, with their share of its events. */
  const apps = profile.apps.map((a) => ({ app: a.app, share: a.share, profile: a }))

  return { apps, lookalike, coverage, dress, stamp, finishTypes }
}
