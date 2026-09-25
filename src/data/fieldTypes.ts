// What each AMI field holds, string or number — the TYPE table the Phase 8
// query router reads (cribl/routing/eligibility.ts).
//
// FILLED ONLY FROM A MEASURED CENSUS. Phase 8 design §1.2 / §8.0b: the table
// is filled from a `gettype` census on the JSON dataset, never from the
// pipeline's cast list alone ("not cast" does not mean "string": a raw JSON
// number stays a number, and `http_code` was assumed numeric and is a string).
// A field that is not here has an UNKNOWN type, and a query reading it is not
// eligible to leave JSON — the router refuses rather than guesses.
//
// `mixed` means some Parquet files hold the field as a string: a file holding a
// string makes the whole column STRING (measured 2026-09-24), `dcount` then
// splits 10 from "10", and that query is class T. No field is `mixed` below:
// every census count came back a single kind.
//
// It lives in src/data because it is data that moves a number without ever
// appearing in a query string (it decides which dataset answers), so the
// display freeze holds it as a catalog. An entry is added with the census's
// date and window in the commit that adds it.
//
// ── THE EVIDENCE (2026-09-25, branch feat/phase8-field-types) ───────────────
// Both runs are `scripts/parquet-audit.mjs` on `gigamon_ami` (JSON), THE DEMO
// FEED ON ONE INSTALL. Types are per install, and the design (R4) says to audit
// again per release and per proof install: this table is what that one install
// read over those windows, not a property of AMI everywhere. The reports carry
// a tenant's figures and are kept gitignored under .dev/parquet-audit/.
//
//   N  `parquet-audit-ref20260925T1749Z-ran20260925T174925Z` — the numeric-only
//      census (`--census numeric`, `NUMERIC_CENSUS_QUERY`), window
//      2026-09-25T17:24:00Z → 17:39:00Z (15 minutes), one
//      `countif(gettype(f)=="<name>")` per name in string/int/long/real.
//      Controls held (app_name all string, protocol all int). Every field
//      marked N counted ONE kind for every present value, nothing uncounted:
//        tcp_rtt 13,826 real · tcp_rtt_app 14,639 real · http_server_ms 3,360
//        real · dns_response_time 213,179 real · dst_port 262,829 int ·
//        protocol 262,880 int · app_name 262,880 string.
//   W  `parquet-audit-ref20260925T1719Z-ran20260925T171950Z` — the first, wide
//      census (`TYPE_DENSITY_QUERY` as it stood then), window
//      2026-09-25T16:09:00Z → 17:09:00Z (60 minutes). Its type-NAME columns
//      came from `min`/`max` over `gettype` and are KNOWN WRONG on sparse
//      fields (they answered "~" and 0), so NOTHING here is read from them.
//      The rule used instead: that run also counted
//      `ts_f = countif(gettype(f)=="string")` beside
//      `tn_f = countif(isnotnull(f))` — the same per-type count the fixed
//      census uses — and a field is typed `string` from W only where
//      `ts_f == tn_f > 0`: every present value counted as a string, so no other
//      kind can be present. All 22 uncast census fields met it (e.g.
//      krb5_message_type 113 of 113, dns_reply_code 850,806 of 850,806;
//      `app_name` is one of them, and N agrees), 28 fields in all. Its
//      numeric fields read `ts_f = 0`, which says only "not a string"; they
//      are typed from N, not W.
//
// ── NOT ESTABLISHED — needs the per-type census re-run ──────────────────────
// Everything else stays unknown, deliberately. The fields the routing table's
// texts read that no census counted per type (fieldTypes.test.ts pins this
// list, so it shrinks only with the table):
//   derived by the pipeline, never counted: l4_proto, src_subnet, dst_subnet,
//     src_subnet16, dst_subnet16
//   never in any census: total_bytes, src_bytes, dst_bytes, total_packets,
//     tcp_dup_ack, tcp_reset, tcp_wrong_crc, tcp_loss_count, dst_ip,
//     ssl_mitm_score, ssl_issuer, ssl_common_name, ssl_protocol_version,
//     ssl_server_supported_version, ssl_validity_not_after
// A pipeline cast or derive is a claim about the code, not a measurement of
// the dataset, and this table takes only the latter. Each needs a census that
// counts it per type (`countif(gettype(f)=="<name>")`) before it is added.
//
// A type-only import, erased before the extractor loads this under plain Node.
import type { FieldType } from '../cribl/parity'

export const FIELD_TYPES: Readonly<Record<string, FieldType>> = Object.freeze({
  // N — per-type counts, a single kind.
  tcp_rtt: 'number',
  tcp_rtt_app: 'number',
  http_server_ms: 'number',
  dns_response_time: 'number',
  dst_port: 'number',
  protocol: 'number',
  app_name: 'string',
  // W — `ts_f == tn_f > 0`: every present value counted as a string.
  http2_code: 'string',
  krb5_message_type: 'string',
  snmp_community: 'string',
  icmp_tunneling: 'string',
  dcerpc_service: 'string',
  sip_from: 'string',
  http_cookie: 'string',
  ftp_data_content: 'string',
  snmp_processing_anomaly_type: 'string',
  http_code: 'string',
  dns_reply_code: 'string',
  udp_wrong_crc: 'string',
  ip_wrong_crc: 'string',
  src_ip: 'string',
  dst_aws_flat_tags_name: 'string',
  src_aws_flat_tags_name: 'string',
  dns_host: 'string',
  http_host: 'string',
  http2_host: 'string',
  ssl_server_name: 'string',
  ssl_ext_ec_supported_groups_type: 'string',
})
