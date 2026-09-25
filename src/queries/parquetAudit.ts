// The Phase 8.0b and 8.0c audit queries: types, density and sentinels on the
// JSON dataset, measured before any query may read `gigamon_ami_pq`.
//
// ── WHAT THESE ARE FOR ──────────────────────────────────────────────────────
// Phase 8 design, revision 2, §4 "8.0" items b and c. Every portable rewrite
// the design proposes (§2, the "R" forms) depends on two facts per field that
// nothing in the repo records yet:
//
//   TYPE      whether the field holds strings or numbers on JSON. The pipeline
//             casts some fields and derives others (src/cribl/provision.ts
//             `PIPELINE_SPEC`); everything else keeps whatever type the raw
//             record carried, and "not cast" does not mean "string". The R form
//             for a string is `isnotnull(f) and f!=""`, for a number `f>0`, and
//             picking the wrong one is a silent wrong number.
//   SENTINEL  whether the field ever holds a REAL `""` (string) or `0` (number)
//             on JSON. On automatic-schema Parquet an absent field reads back as
//             exactly those bytes, so an R form is exact only where the real
//             value never occurs. A field with real sentinels needs a presence
//             flag (P) or stays on JSON (J).
//
// Plus the density gaps §1.3 lists as unmeasured, because the router's third
// eligibility input (§4, 8.1) is per-install density and these four were never
// read.
//
// ── PINNED: MEASUREMENT ─────────────────────────────────────────────────────
// Every string here reads `gigamon_ami`, the JSON archive, BY DEFINITION: it
// measures that dataset. A router that moved one onto `gigamon_ami_pq` would
// not produce a Parquet reading of the same question — it would produce a
// meaningless one, because on Parquet every absent field is present, typed and
// a sentinel. `AUDIT_PIN` names the reason so a router can see it, and
// parquetAudit.test.ts holds that no app module imports this file: the app
// never submits these, so there is no call site for a router to intercept. Only
// `scripts/parquet-audit.mjs` runs them, and it posts the frozen text as is.
//
// ── NOT RUN BY THE APP, AND NEVER ON A TIMER ────────────────────────────────
// They cost billable CPU-s (the runner prints its estimate before it will do
// anything) and are run by a person with `--run`. The running-time cap is
// prefixed at execution by the runner, never written here, exactly as
// `cribl/search.ts#withExecPrefix` does for the app's own jobs.
//
// These strings are frozen by `src/queries/__frozen__/display.json` like every
// other module here: an edit to a field list or a column name is a reviewable
// change, because it changes what the recorded evidence measured.
//
// Nothing here may import a .tsx or anything reaching one — the freeze loads
// this module under plain Node.

import { LAKE_DATASET } from '../cribl/config'
import { PQC_GROUP_CODES } from '../data/pqc'

/** The one dataset these queries may read. Not `activeDataset()`: the sample
 *  dataset is a different feed, and the Parquet copy is the thing under test. */
export const AUDIT_DATASET = LAKE_DATASET

/**
 * Why a router may never move these queries.
 *
 * The same word the design gives LANDING_LAG, REAL_DATA_PROBE, LAKE_HELD and
 * PARTITION_CANDIDATES (§4, 8.1). `queryTarget.ts`'s `PinReason` does not carry
 * it yet; the router branch adds it, and this constant is what it should read.
 */
export const AUDIT_PIN = 'measurement'

const head = `dataset="${AUDIT_DATASET}" | summarize rows=count(), `

// ── What the pipeline already guarantees ────────────────────────────────────

/**
 * The fields this audit touches whose type the pipeline decides, and how.
 *
 * `cast` fields go through `f==null?f:Number(f)`, `computed` ones are derived
 * by `gigamon_ami_normalize`'s second Eval. parquetAudit.test.ts holds both
 * lists against `PIPELINE_SPEC` in src/cribl/provision.ts, so a field the
 * pipeline stops casting cannot keep its "number" here.
 *
 * `protocol` is here as the census's numeric CONTROL (see `CENSUS_CONTROLS`),
 * not because a rewrite touches it.
 */
export const TYPED_BY_CODE: Readonly<Record<string, { type: 'number' | 'string'; basis: 'cast' | 'computed' }>> = Object.freeze({
  protocol: { type: 'number', basis: 'cast' },
  dst_port: { type: 'number', basis: 'cast' },
  tcp_rtt: { type: 'number', basis: 'cast' },
  tcp_rtt_app: { type: 'number', basis: 'cast' },
  dns_response_time: { type: 'number', basis: 'cast' },
  http_server_ms: { type: 'number', basis: 'computed' },
  l4_proto: { type: 'string', basis: 'computed' },
  src_subnet: { type: 'string', basis: 'computed' },
  dst_subnet: { type: 'string', basis: 'computed' },
  src_subnet16: { type: 'string', basis: 'computed' },
  dst_subnet16: { type: 'string', basis: 'computed' },
})

/**
 * Types already measured, and where.
 *
 * `http_code` read `""` on Parquet (memory table, 2026-09-21), which only a
 * string column does. It is still in the census: that measurement was on the
 * Parquet side, and this one is on JSON.
 */
export const MEASURED_TYPES: Readonly<Record<string, 'number' | 'string'>> = Object.freeze({
  http_code: 'string',
})

// ── 8.0b: the type census ───────────────────────────────────────────────────

/**
 * Every field the pipeline does NOT type that the design's rewrites touch, or a
 * Findings / Security detection reads.
 *
 * Derived, in parquetAudit.test.ts, from three sources, both directions:
 *   - the class A/B/D/E patterns (`isnotnull(f)`, `count(f)`, `f=*`,
 *     `percentile|avg|min(f)`) in every frozen query of every module a router
 *     could ever move (the pinned modules excluded);
 *   - `FINDINGS[].field`;
 *   - the identifiers in every flow-signal `TECHNIQUES[].expr`;
 * minus the fields `TYPED_BY_CODE` covers. A new field in any of those fails
 * the test until it is added here, and a field nothing reads any more fails it
 * until it is taken out. The order is the census report's row order.
 */
export const CENSUS_FIELDS: readonly string[] = Object.freeze([
  // The fields the design names first (§1.2, §4 8.0b).
  'http2_code', 'krb5_message_type', 'snmp_community', 'icmp_tunneling', 'dcerpc_service',
  // The other Findings fields.
  'sip_from', 'http_cookie', 'ftp_data_content', 'snmp_processing_anomaly_type',
  'http_code', 'dns_reply_code', 'udp_wrong_crc', 'ip_wrong_crc',
  // Head filters (class D) and group keys the rewrites touch.
  'app_name', 'src_ip', 'dst_aws_flat_tags_name', 'src_aws_flat_tags_name', 'dns_host',
  'http_host', 'http2_host', 'ssl_server_name', 'ssl_ext_ec_supported_groups_type',
])

/**
 * Fields typed by the pipeline that the census reads anyway, to confirm the
 * JSON dataset really holds them as numbers. A cast that did not happen (a feed
 * that bypassed `gigamon_ami_normalize`) would make every `f==0` sentinel below
 * the wrong question, so it is checked rather than assumed.
 */
export const CAST_CHECK_FIELDS: readonly string[] = Object.freeze([
  'tcp_rtt', 'tcp_rtt_app', 'http_server_ms', 'dns_response_time', 'dst_port',
])

/**
 * The census's self-check. `gettype`'s vocabulary is not documented by a
 * measurement in this repo, so a string-typed control and a number-typed one
 * ride along: if `app_name` does not read all-"string", or `protocol` reads any
 * "string", the census cannot be trusted and the report says so rather than
 * typing every field wrong.
 */
export const CENSUS_CONTROLS: Readonly<{ string: string; number: string }> = Object.freeze({
  string: 'app_name',
  number: 'protocol',
})

/** Every field the census types, in column order. */
export const CENSUS_COLUMNS_FIELDS: readonly string[] = Object.freeze([
  ...CENSUS_FIELDS,
  ...CAST_CHECK_FIELDS,
  CENSUS_CONTROLS.number,
])

/**
 * The four census columns per field.
 *
 * `tlo_`/`thi_` are the lowest and highest type NAME among the present values.
 * The `iif` guards use only measured semantics (a null condition takes the else
 * branch; strings order as strings): `"~"` sorts after every type name so `min`
 * ignores absent rows, and `""` sorts before every name so `max` does. Two names
 * that differ mean the field's values carry more than one type — class T.
 */
const censusAggs = (f: string): string =>
  `tn_${f}=countif(isnotnull(${f})), ts_${f}=countif(gettype(${f})=="string"), ` +
  `tlo_${f}=min(iif(isnotnull(${f}),gettype(${f}),"~")), thi_${f}=max(iif(isnotnull(${f}),gettype(${f}),""))`

// ── 8.0b: the density gaps ──────────────────────────────────────────────────

/** The PQC `in` list exactly as TLS `PQC_BY_SERVER` and PQC `SERVERS_Q` write it. */
export const PQC_IN_LIST = `(${PQC_GROUP_CODES.map((c) => `"${c}"`).join(', ')})`

/**
 * The §1.3 "Still missing" densities, exactly as the design lists them.
 *
 * Each is `count(field)` within a scope: a denominator column (`d_<scope>`) and
 * a numerator (`d_<id>`). `scope: null` means over every row (`rows`).
 */
export const DENSITY_SCOPES: Readonly<Record<string, { expr: string; words: string }>> = Object.freeze({
  tcp: { expr: 'protocol==6', words: 'TCP rows (protocol=6), the heatmap head' },
  web: { expr: 'isnotnull(http_host)', words: 'rows with http_host (WEB_HOST)' },
  icmp: { expr: 'protocol==1', words: 'ICMP rows (protocol=1)' },
  pqc: { expr: `ssl_ext_ec_supported_groups_type in ${PQC_IN_LIST}`, words: 'rows the PQC in-list admits (PQC_BY_SERVER)' },
})

export const DENSITY_CHECKS: ReadonlyArray<{ id: string; field: string; scope: keyof typeof DENSITY_SCOPES | null }> = Object.freeze([
  { id: 'tcp_dst_subnet', field: 'dst_subnet', scope: 'tcp' },
  { id: 'tcp_src_subnet16', field: 'src_subnet16', scope: 'tcp' },
  { id: 'tcp_dst_subnet16', field: 'dst_subnet16', scope: 'tcp' },
  { id: 'dst_ip', field: 'dst_ip', scope: null },
  { id: 'web_http_server_ms', field: 'http_server_ms', scope: 'web' },
  { id: 'icmp_dst_port', field: 'dst_port', scope: 'icmp' },
  { id: 'pqc_ssl_server_name', field: 'ssl_server_name', scope: 'pqc' },
])

const densityAggs = (): string => [
  ...Object.entries(DENSITY_SCOPES).map(([id, s]) => `d_${id}=countif(${s.expr})`),
  ...DENSITY_CHECKS.map((c) => c.scope === null
    ? `d_${c.id}=count(${c.field})`
    : `d_${c.id}=countif(${DENSITY_SCOPES[c.scope].expr} and isnotnull(${c.field}))`),
].join(', ')

/**
 * 8.0b, one query in the D-10 s1 shape: one ungrouped `summarize` over the
 * window, `rows=count()` first so every share has its denominator. Run over an
 * absolute 60 minutes ending at least 10 minutes ago (landing lag).
 */
export const TYPE_DENSITY_QUERY = head + densityAggs() + ', ' + CENSUS_COLUMNS_FIELDS.map(censusAggs).join(', ')

// ── 8.0c: the sentinel audit ────────────────────────────────────────────────

/** A field's type as far as the sentinel query needs it. `unknown` emits both forms. */
export type SentinelType = 'string' | 'number' | 'unknown'

/**
 * Every field the portable rewrites touch (classes A, B, D and E), which is the
 * set whose real `""`/`0` would make an R form drop real values.
 *
 * parquetAudit.test.ts derives it from the frozen queries, both directions, as
 * it does `CENSUS_FIELDS`. `dst_port` is the one field here no rewrite touches:
 * the design names it (§4 8.0c) because §6's T1046 `ports ≥ 6` depends on
 * whether a real port 0 exists.
 */
export const SENTINEL_FIELDS: readonly string[] = Object.freeze([
  // Uncast: the census decides the form.
  'http_code', 'http2_code', 'krb5_message_type', 'snmp_community', 'icmp_tunneling', 'dcerpc_service',
  'sip_from', 'http_cookie', 'ftp_data_content', 'snmp_processing_anomaly_type',
  'app_name', 'src_ip', 'dst_aws_flat_tags_name', 'src_aws_flat_tags_name', 'dns_host',
  'http_host', 'http2_host', 'ssl_server_name', 'ssl_ext_ec_supported_groups_type',
  // Computed strings.
  'l4_proto', 'src_subnet', 'dst_subnet', 'src_subnet16', 'dst_subnet16',
  // Numbers (the design's list: §4 8.0c).
  'tcp_rtt', 'tcp_rtt_app', 'http_server_ms', 'dns_response_time', 'dst_port',
])

/** The fields in `SENTINEL_FIELDS` that no rewrite touches, each named in the
 *  design for the reason given above. The derivation test allows exactly these. */
export const SENTINEL_EXTRA_FIELDS: readonly string[] = Object.freeze(['dst_port'])

/**
 * What the sentinel query assumes before any census has run: the pipeline's
 * types, the one measured type, and `unknown` for everything else, which emits
 * BOTH forms so the report can pick the one the census's type says applies.
 */
export const STATIC_FIELD_TYPES: Readonly<Record<string, SentinelType>> = Object.freeze(
  Object.fromEntries(SENTINEL_FIELDS.map((f) => [f, TYPED_BY_CODE[f]?.type ?? MEASURED_TYPES[f] ?? 'unknown'])),
)

/**
 * The sentinel audit over the fields `types` names, in `SENTINEL_FIELDS` order.
 *
 * Per field: `sn_` the present count (a zero-sentinel reading with nothing
 * present is no evidence), `se_` the rows holding `""` for a string, `sz_` the
 * rows holding `0` for a number, both for `unknown`. Measured semantics only:
 * `f==""` is false for null, `f==0` on null is null and so not counted.
 *
 * Takes the type table as input so a re-run on another install can be given
 * that install's recorded census (`scripts/parquet-audit.mjs --types-from`),
 * and the report records the exact text that ran.
 */
export function sentinelAuditQuery(types: Readonly<Record<string, SentinelType>>): string {
  const aggs = SENTINEL_FIELDS.filter((f) => f in types).map((f) => {
    const t = types[f]
    const parts = [`sn_${f}=count(${f})`]
    if (t !== 'number') parts.push(`se_${f}=countif(${f}=="")`)
    if (t !== 'string') parts.push(`sz_${f}=countif(${f}==0)`)
    return parts.join(', ')
  })
  return head + aggs.join(', ')
}

/** 8.0c as it runs before the census: both forms wherever the type is unknown.
 *  Run over a few absolute 15-minute windows at different hours. */
export const SENTINEL_AUDIT_QUERY = sentinelAuditQuery(STATIC_FIELD_TYPES)
