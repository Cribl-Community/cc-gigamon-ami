// The field type table: filled only from a measured census, holding no field
// nothing reads, and — the point of filling it — what it now lets through.
//
// No route moves here: every ROUTES entry stays on JSON with no evidence
// (routing/table.test.ts). This file pins which entries the TEXT-and-TYPE half
// of eligibility now admits, so a reader sees what the table changed.
import { describe, expect, it } from 'vitest'
import { classifyQuery } from '../cribl/parity'
import { eligibility } from '../cribl/routing/eligibility'
import { ROUTES } from '../cribl/routing/table'
import { CENSUS_COLUMNS_FIELDS, NUMERIC_CENSUS_FIELDS } from '../queries/parquetAudit'
import { FIELD_TYPES } from './fieldTypes'
import { FINDINGS } from './findings'
import { TECHNIQUES } from './techniques'

/** Identifiers in a technique's count expression, quoted literals and operators removed. */
const exprFields = (expr: string): string[] =>
  (expr.replace(/"[^"]*"/g, '').match(/\b[a-z][a-z0-9_]*\b/g) ?? []).filter((w) => !['isnotnull', 'in', 'and', 'or', 'not'].includes(w))

/** Every field a routable text reads, as the router's own reader sees it. */
const routedFields = (): Set<string> =>
  new Set(ROUTES.filter((e) => !e.pin).flatMap((e) => e.queries.flatMap((q) => classifyQuery(q, {}).fields)))

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()

describe('the table holds only measured types', () => {
  it('is exactly what the 2026-09-25 censuses counted, one kind per field', () => {
    // N: the numeric census's per-type counts. W: the wide census's
    // ts_f == tn_f > 0 (every present value a string). See fieldTypes.ts.
    expect(FIELD_TYPES).toEqual({
      tcp_rtt: 'number', tcp_rtt_app: 'number', http_server_ms: 'number', dns_response_time: 'number',
      dst_port: 'number', protocol: 'number', app_name: 'string',
      http2_code: 'string', krb5_message_type: 'string', snmp_community: 'string', icmp_tunneling: 'string',
      dcerpc_service: 'string', sip_from: 'string', http_cookie: 'string', ftp_data_content: 'string',
      snmp_processing_anomaly_type: 'string', http_code: 'string', dns_reply_code: 'string',
      udp_wrong_crc: 'string', ip_wrong_crc: 'string', src_ip: 'string', dst_aws_flat_tags_name: 'string',
      src_aws_flat_tags_name: 'string', dns_host: 'string', http_host: 'string', http2_host: 'string',
      ssl_server_name: 'string', ssl_ext_ec_supported_groups_type: 'string',
    })
    expect(Object.isFrozen(FIELD_TYPES)).toBe(true)
  })

  it('types no field the census queries of the audit do not count — a pipeline cast is not a measurement', () => {
    const counted = new Set([...CENSUS_COLUMNS_FIELDS, ...NUMERIC_CENSUS_FIELDS])
    expect(Object.keys(FIELD_TYPES).filter((f) => !counted.has(f))).toEqual([])
    // The pipeline's derived strings were never counted, so they stay unknown.
    for (const f of ['l4_proto', 'src_subnet', 'dst_subnet', 'src_subnet16', 'dst_subnet16']) expect(FIELD_TYPES[f]).toBeUndefined()
  })

  it('has no dead entry: every key is read by a routable text, a Finding or a technique', () => {
    const used = new Set([
      ...routedFields(),
      ...FINDINGS.map((f) => f.field),
      ...TECHNIQUES.flatMap((t) => (t.expr ? exprFields(t.expr) : [])),
    ])
    expect(Object.keys(FIELD_TYPES).filter((f) => !used.has(f))).toEqual([])
  })

  it('names the fields the routable texts read that are still unmeasured (the list in fieldTypes.ts)', () => {
    expect(sorted([...routedFields()].filter((f) => FIELD_TYPES[f] === undefined))).toEqual(sorted([
      'l4_proto', 'src_subnet', 'dst_subnet', 'src_subnet16', 'dst_subnet16',
      'total_bytes', 'src_bytes', 'dst_bytes', 'total_packets',
      'tcp_dup_ack', 'tcp_reset', 'tcp_wrong_crc', 'tcp_loss_count', 'dst_ip',
      'ssl_mitm_score', 'ssl_issuer', 'ssl_common_name', 'ssl_protocol_version',
      'ssl_server_supported_version', 'ssl_validity_not_after',
    ]))
  })
})

describe('what the table lets through (nothing moves: every route stays json)', () => {
  const verdicts = ROUTES.filter((e) => !e.pin && e.queries.length).map((e) => {
    const refusals = e.queries.flatMap((q) => eligibility(q, FIELD_TYPES).refusals)
    return { id: e.id, all: refusals.length === 0, textAndType: refusals.every((r) => r.kind === 'density') }
  })

  it('admits DNS OVERALL outright: class-free bar C, every field measured', () => {
    expect(verdicts.filter((v) => v.all).map((v) => v.id)).toEqual(['dns.overall'])
  })

  it('leaves eight entries refused only by per-install density, which no install has measured', () => {
    expect(verdicts.filter((v) => v.textAndType && !v.all).map((v) => v.id).sort()).toEqual([
      'flowMap.edges', 'flowMap.serviceEdges', 'pqc.groups', 'tls.pqcByServer',
      'web.codes', 'web.h2', 'web.hosts', 'web.trend',
    ])
  })

  it('moves nothing', () => {
    expect(ROUTES.every((e) => e.target === 'json' && e.evidence === null)).toBe(true)
  })
})
