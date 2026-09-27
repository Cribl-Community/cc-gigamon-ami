// Derive the statistics profile of the workspace's worker-group demo DataGen,
// which scripts/gen-pack-samples.mjs reads to shape the pack's samples like it.
//
//   node scripts/derive-demo-profile.mjs [--in .dev/demo-samples] [--out scripts/demo-profile.json]
//
// RUN BY HAND, NEVER IN CI. Its input is the demo DataGen's own sample files,
// saved (gitignored) under .dev/demo-samples/: gigamon_ami_NN.json, each a JSON
// array of events, plus _input.json (the DataGen's sample list and rates). They
// are REAL captured traffic — public addresses, real hostnames, MACs, flow ids,
// SNMP community strings — and none of it may reach the repository, which is
// public.
//
// WHAT IT WRITES, AND NOTHING ELSE. Statistics:
//   - totals: event, file and rate counts;
//   - every field NAME, the JSON type its values arrive as, and how many events
//     carry it;
//   - per application (app_name): its event count, how many of its events carry
//     each field, quantiles of the numeric fields in NUMERIC_STATS (never a raw value: p10,
//     p50, p90 of a size or a timing identify nobody) and the decimals they are
//     written with, and the value distribution of the fields in CATEGORICAL —
//     an ALLOWLIST of Gigamon's own enumerations (protocol numbers, DNS types,
//     HTTP methods, TLS versions and cipher ids, SNMP methods, ...), which
//     describe a protocol, not a network;
//   - dst_port, only below PORT_CUTOFF (well-known and registered service ports;
//     anything above is counted as `ephemeral`).
// Every other field — addresses, names, URIs, agents, ids, keys, free text — is
// counted for presence and never read for its value. app_name itself is
// Gigamon's classification label, which the tabs match on.
//
// REVIEW THE OUTPUT BEFORE COMMITTING IT. A value copied here is published. The
// allowlist is by field, so a field whose "enumeration" turns out to hold a
// site's own string (a custom header name, a tag value) must come off the list.
// The script refuses a categorical value that looks like an IPv4 or IPv6
// address, a MAC, an email address or a dotted hostname, as a second guard.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? resolve(process.argv[i + 1]) : dflt
}
const IN = arg('--in', join(ROOT, '.dev', 'demo-samples'))
const OUT = arg('--out', join(ROOT, 'scripts', 'demo-profile.json'))

/** Gigamon enumerations: values that describe a protocol, not a site. */
export const CATEGORICAL = [
  'app_id', 'protocol', 'ip_version', 'end_reason', 'event_type', 'vendor', 'version',
  'dns_query_type', 'dns_reply_code', 'dns_class', 'dns_flags', 'dns_host_class', 'dns_host_type', 'dns_message_type',
  'dns_name_resolution_type', 'dns_opcode', 'dns_qdcount', 'dns_section_type', 'dns_ancount', 'dns_arcount', 'dns_nscount',
  'http_method', 'http_code', 'http_version', 'http_content_type', 'http_mime_type', 'http_file_type',
  'http2_method', 'http2_code', 'http2_mime_type', 'http2_frame_type', 'http2_frame_length', 'http2_stream_id',
  'http2_file_generic_type', 'http2_signalization_override',
  'ssl_protocol_version', 'ssl_server_supported_version', 'ssl_client_supported_version', 'ssl_cipher_suite_id',
  'ssl_cipher_suite_list', 'ssl_client_hello_extension_type', 'ssl_client_hello_extension_len',
  'ssl_server_hello_extension_type', 'ssl_server_hello_extension_len', 'ssl_compression_method',
  'ssl_nb_compression_methods', 'ssl_content_type', 'ssl_handshake_type', 'ssl_index', 'ssl_declassify_override',
  'ssl_signalization_override', 'ssl_ext_ec_point_formats_nb', 'ssl_ext_ec_point_formats_type',
  'ssl_ext_ec_supported_groups_nb', 'ssl_ext_ec_supported_groups_type', 'ssl_ext_sig_algorithm_hash',
  'ssl_ext_sig_algorithm_scheme', 'ssl_ext_sig_algorithm_sig', 'ssl_ext_sig_algorithms_len',
  'ssl_certificate_subject_key_algo_oid', 'ssl_certificate_subject_key_size', 'ssl_cert_extension_oid',
  'ssl_mitm_score', 'ssl_supported_next_protocol',
  'snmp_method', 'snmp_version', 'snmp_value_type', 'snmp_value_type_raw', 'snmp_value_len',
  'snmp_processing_anomaly_type', 'snmp_processing_anomaly_event', 'snmp_processing_anomaly_id',
  // Not the ssh_tsp_alg_* lists: they name vendor extensions as
  // `name@vendor.tld`, which reads as a hostname; the generator writes its own.
  'ssh_version', 'ssh_msg_type', 'ssh_tsp_comp_guessed_cts', 'ssh_tsp_comp_guessed_stc', 'ssh_tsp_server_key_type',
  'icmp_type', 'icmp_code', 'icmp_typeval', 'icmp_message', 'icmp_tunneling',
  'ntp_mode', 'ntp_version', 'rtp_codec_name', 'rtp_codec_index', 'rtp_service', 'rtp_unseq', 'rtcp_message_type',
  'dhcp_message_type', 'dhcp_option_type', 'dhcp_ip_lease_time',
  'krb5_message_type', 'krb5_ticket_name_type',
  'dcerpc_protocol_type', 'dcerpc_major_version', 'dcerpc_minor_version', 'dcerpc_opnum', 'dcerpc_service',
  'whatsapp_service', 'whatsapp_service_way',
  'tcp_flags', 'tcp_dup_ack', 'tcp_unseq',
  'src_aws_instance_state', 'dst_aws_instance_state',
  'src_workload_platform', 'dst_workload_platform',
]

/** Sizes and timings: summarised as quantiles, never listed. */
export const NUMERIC_STATS = [
  'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets', 'tcp_rtt', 'tcp_rtt_app', 'dns_response_time', 'dns_ttl',
  'ssl_request_size', 'http_request_size', 'http_header_end_offset', 'http_content_len', 'http2_content_len',
  'http2_file_generic_size', 'tcp_wrong_crc', 'tcp_loss_count', 'ssh_rtt', 'rtp_lost', 'udp_wrong_crc', 'ip_wrong_crc',
  'http_rtt', 'rtp_service_duration', 'whatsapp_service_duration',
]

/** Service ports at or below this are copied; anything above counts as `ephemeral`. */
export const PORT_CUTOFF = 10000

/** Second guard: a value shaped like an address, a MAC, an email or a hostname is refused. */
function identifyingShape(v) {
  return /(?<![\d.])\d{1,3}(\.\d{1,3}){3}(?![\d.])/.test(v) ||
    /[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}/i.test(v) ||
    /\b[0-9a-f]{2}([:-][0-9a-f]{2}){5}\b/i.test(v) ||
    /@/.test(v) ||
    /(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w-])/i.test(v.replace(/^\d+(\.\d+)+$/, ''))
}

function quantile(sorted, q) {
  if (!sorted.length) return null
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}
/** RFC 1918: counted, never recorded. */
const isPrivate = (ip) => typeof ip === 'string' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
const decimalsOf = (s) => (/\.(\d+)$/.exec(s)?.[1].length ?? 0)

/** JSON with one line per object whose values are all primitives: reviewable, and a small diff. */
function compact(v, pad) {
  const flat = (x) => x === null || typeof x !== 'object' || Object.values(x).every((y) => y === null || typeof y !== 'object')
  if (flat(v)) return JSON.stringify(v)
  const inner = `${pad}  `
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + compact(x, inner)).join(',\n')}\n${pad}]`
  return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${compact(x, inner)}`).join(',\n')}\n${pad}}`
}

function main() {
  const input = JSON.parse(readFileSync(join(IN, '_input.json'), 'utf8'))
  const files = readdirSync(IN).filter((f) => /^gigamon_ami_\d+\.json$/.test(f)).sort()
  const events = files.flatMap((f) => JSON.parse(readFileSync(join(IN, f), 'utf8')))

  const fields = {}
  const apps = new Map()
  const refused = new Set()
  for (const e of events) {
    const app = String(e.app_name)
    if (!apps.has(app)) apps.set(app, { n: 0, srcPrivate: 0, dstPrivate: 0, present: {}, cat: {}, num: {}, dec: {} })
    const a = apps.get(app)
    a.n++
    if (isPrivate(e.src_ip)) a.srcPrivate++
    if (isPrivate(e.dst_ip)) a.dstPrivate++
    for (const [k, v] of Object.entries(e)) {
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
      const f = (fields[k] ??= { type: {}, present: 0 })
      f.type[type] = (f.type[type] ?? 0) + 1
      f.present++
      if (k === '_time' || k === 'app_name') continue
      a.present[k] = (a.present[k] ?? 0) + 1
      const s = String(v)
      if (k === 'dst_port') {
        const key = Number(s) <= PORT_CUTOFF ? s : 'ephemeral'
        ;(a.cat[k] ??= {})[key] = (a.cat[k][key] ?? 0) + 1
      } else if (CATEGORICAL.includes(k)) {
        // An object identifier (1.2.840..., 2.5.29.15) is dotted digits by
        // definition, and a four-arc one is shaped like an IPv4 address.
        const oid = k.endsWith('_oid') && /^[0-2](\.\d+)+$/.test(s)
        if (!oid && identifyingShape(s)) refused.add(k)
        ;(a.cat[k] ??= {})[s] = (a.cat[k][s] ?? 0) + 1
      } else if (NUMERIC_STATS.includes(k) && s !== '' && Number.isFinite(Number(s))) {
        ;(a.num[k] ??= []).push(Number(s))
        a.dec[k] = Math.max(a.dec[k] ?? 0, decimalsOf(s))
      }
    }
  }

  if (refused.size) {
    throw new Error(`derive-demo-profile: these CATEGORICAL fields hold identifying-looking values; take them off the list: ${[...refused].sort().join(', ')}`)
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const profile = {
    about:
      'Statistics of the workspace demo DataGen (worker group, in_gigamon_datagen), derived by scripts/derive-demo-profile.mjs. ' +
      'Field names, arrival types, presence rates, quantiles of sizes and timings, and the distributions of an allowlist of ' +
      'Gigamon enumerations only: no address, name, identifier or free-text value of the source is recorded here.',
    totals: {
      events: events.length,
      files: files.length,
      eventsPerSecPerFile: [...new Set((input.samples ?? []).map((s) => s.eventsPerSec))],
      eventsPerSec: (input.samples ?? []).reduce((n, s) => n + (Number(s.eventsPerSec) || 0), 0),
    },
    notes: ['`_time` is on every source event (the DataGen template stamps it); the pack\'s samples omit it and Cribl adds it on replay.'],
    fields: sortObj(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, {
      type: Object.keys(f.type).length === 1 ? Object.keys(f.type)[0] : sortObj(f.type),
      present: f.present,
    }]))),
    apps: [...apps.entries()]
      .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
      .map(([app, a]) => ({
        app,
        events: a.n,
        // How many of its flows have an RFC 1918 source, and destination: a count.
        srcPrivate: a.srcPrivate,
        dstPrivate: a.dstPrivate,
        share: Math.round((a.n / events.length) * 1e6) / 1e6,
        // How many of this app's events carry each field: a count, not a
        // rounded rate, so a field on one event in twelve thousand is not 0.
        present: sortObj(a.present),
        numeric: sortObj(Object.fromEntries(Object.entries(a.num).map(([k, xs]) => {
          const s = [...xs].sort((x, y) => x - y)
          const d = a.dec[k]
          const fx = (x) => Number(x.toFixed(d))
          return [k, { p10: fx(quantile(s, 0.1)), p50: fx(quantile(s, 0.5)), p90: fx(quantile(s, 0.9)), decimals: d }]
        }))),
        categorical: sortObj(Object.fromEntries(Object.entries(a.cat).map(([k, m]) => [k, sortObj(m)]))),
      })),
  }
  writeFileSync(OUT, `${compact(profile, '')}\n`)
  process.stdout.write(`derive-demo-profile: ${events.length} events, ${files.length} files, ${Object.keys(fields).length} fields, ${apps.size} apps -> ${OUT}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
