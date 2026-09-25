// The Raw HTTP stack's specs: what the onboarding pack's YAML is held equal to.
//
// ── WHY THESE LIVE HERE, AND NOT IN provision.ts ────────────────────────────
//
// Until 2026-09-25 these were Guided Setup's create bodies: provision.ts's
// `deployAll` POSTed and PATCHed them into a worker group as the global Raw
// HTTP stack (`in_gigamon_http`, `gigamon_ami_json_array`,
// `gigamon_http_normalize`, `gigamon_ami_http`). The owner collapsed that
// onboarding into the pack's (2026-09-25): nothing creates or re-applies the
// global stack any more, and provision.ts only reads it and removes it.
//
// The specs stay, VALUE FOR VALUE, for one reason: src/cribl/pack.test.ts
// holds the pack under packs/cc-network-gigamon-ami/ equal to them — the HTTP
// input to `sourceCreateBody` for a Cribl-managed group, the breaker to
// `HTTP_BREAKER_SPEC`, the pipelines to `PIPELINE_SPEC` and
// `PARQUET_PIPELINE_SPEC`, the JSON route to `ROUTE_SPEC` and the destinations
// to landing.ts's bodies — apart from the differences that file writes down.
// They are the TypeScript statement of what the pack ships, and a change to
// either side alone fails that test. NEVER CHANGE A VALUE HERE to make the
// pack test pass; change the pack and this together, deliberately.
//
// Nothing in this module is sent to Cribl by the app. The pack client
// (cribl/packClient.ts) and the onboarding plan read `tlsFor` for the pack's
// own source, which is the one function here the app still calls at runtime.
//
// PURE: no `capi`, no `kv`, no network — only ids and bodies.

import {
  HTTP_BREAKER_DESCRIPTION, HTTP_BREAKER_ID, HTTP_PIPELINE_ID, HTTP_ROUTE_ID, HTTP_SOURCE_ID, LAKE_DESTINATION_ID,
} from './provision'
import { destinationSpec, type LandingProfile, DEFAULT_PROFILE } from './landing'
import { PACK_PARQUET_PIPELINE_ID } from './pack'

/** The two Evals below are copied verbatim from the existing `gigamon_ami`
 *  pipeline so HTTP-delivered flows get identical field derivations. */
const NUMERIC_FIELDS = [
  'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets', 'src_port', 'dst_port',
  'protocol', 'app_id', 'ip_version', 'tcp_rtt', 'tcp_rtt_app', 'tcp_dup_ack',
  'tcp_loss_count', 'tcp_wrong_crc', 'tcp_unseq', 'dns_response_time', 'dns_ttl',
  'ssl_mitm_score', 'ssl_request_size', 'snmp_version', 'end_reason', 'seq_num',
  'http_request_ts', 'http_response_ts', 'tcp_flags',
]

const CAST_FN = {
  id: 'eval', filter: 'true', disabled: false, description: 'Cast numeric strings',
  conf: { add: NUMERIC_FIELDS.map((n) => ({ name: n, value: `${n}==null?${n}:Number(${n})` })) },
}

const DERIVE_FN = {
  id: 'eval', filter: 'true', disabled: false, description: 'Derive helper fields',
  conf: {
    add: [
      { name: 'src_subnet', value: "typeof src_ip==='string'?src_ip.split('.').slice(0,3).join('.'):undefined" },
      { name: 'dst_subnet', value: "typeof dst_ip==='string'?dst_ip.split('.').slice(0,3).join('.'):undefined" },
      { name: 'total_bytes', value: '(src_bytes||0)+(dst_bytes||0)' },
      { name: 'total_packets', value: '(src_packets||0)+(dst_packets||0)' },
      { name: 'l4_proto', value: "({'6':'TCP','17':'UDP','1':'ICMP'})[String(protocol)]||String(protocol)" },
      { name: 'http_server_ms', value: '(http_request_ts!=null&&http_response_ts!=null)?(http_response_ts-http_request_ts)*1000:undefined' },
      { name: 'tcp_reset', value: 'tcp_flags==null?undefined:((tcp_flags&4)?1:0)' },
      { name: 'src_subnet16', value: "typeof src_ip==='string'?src_ip.split('.').slice(0,2).join('.'):undefined" },
      { name: 'dst_subnet16', value: "typeof dst_ip==='string'?dst_ip.split('.').slice(0,2).join('.'):undefined" },
    ],
  },
}

/**
 * NO PARSE STEP. The Syslog pipeline began with a fallback-to-_raw Eval and a
 * JSON `serde` of the syslog message. Over HTTP there is no message to take
 * apart: `HTTP_BREAKER_SPEC` below splits the POSTed array and extracts every
 * record's fields (`jsonExtractAll`) before the pipeline runs, just as the
 * DataGen's events arrive already as objects. So this is the pack's
 * `gigamon_ami_normalize` — cast and derive — and the two feeds produce rows of
 * one shape.
 */
export const PIPELINE_SPEC = {
  id: HTTP_PIPELINE_ID,
  conf: { functions: [CAST_FN, DERIVE_FN] },
}

/**
 * Removes `_raw` from every event. An Eval `remove`, Cribl's documented way to
 * take a top-level field off an event (the Drop function drops the whole
 * event). Last, and a function of its own, so the two before it stay
 * `PIPELINE_SPEC`'s value for value.
 */
const DROP_RAW_FN = {
  id: 'eval', filter: 'true', disabled: false, description: 'Remove _raw from the Parquet copy',
  conf: { remove: ['_raw'] },
}

/**
 * The onboarding pack's Parquet pipeline (pack 0.2.2 on; `PACK_PARQUET_PIPELINE_ID`):
 * `PIPELINE_SPEC`'s cast and derive, then `DROP_RAW_FN`. The pack's route into
 * `gigamon_ami_pq` runs it; the JSON and sample routes run `PIPELINE_SPEC`'s
 * functions and keep `_raw`, which the app's evidence drills, Field Explorer
 * and Copilot briefs read from `gigamon_ami`. After the breaker every field
 * of a record is its own field, so in the Parquet copy `_raw` is only a second
 * copy of the record (owner decision 2026-09-25).
 *
 * PACK-ONLY, and it always was: the global stack never had a Parquet path. It
 * lives beside `PIPELINE_SPEC` so the two cannot drift apart; pack.test.ts
 * holds the pack's `default/pipelines/gigamon_ami_normalize_parquet/conf.yml`
 * equal to it, and its first functions to `PIPELINE_SPEC`'s.
 */
export const PARQUET_PIPELINE_SPEC = {
  id: PACK_PARQUET_PIPELINE_ID,
  conf: { functions: [CAST_FN, DERIVE_FN, DROP_RAW_FN] },
}

/**
 * The breaker ruleset, from the lab model (`gigamon_json_http`): one
 * `json_array` rule over the whole body, every record's fields extracted, a
 * 51,200-byte cap per event, and the timestamp found automatically in the first
 * 150 characters. `minRawLength` 256 is the model's. Its description is the
 * global ruleset's ownership stamp (provision.ts `HTTP_BREAKER_DESCRIPTION`),
 * which the pack's own ruleset must never carry.
 */
export const HTTP_BREAKER_SPEC = {
  id: HTTP_BREAKER_ID,
  lib: 'custom',
  description: HTTP_BREAKER_DESCRIPTION,
  minRawLength: 256,
  rules: [
    {
      name: 'gigamon_ami_json_array',
      condition: 'true',
      type: 'json_array',
      jsonExtractAll: true,
      maxEventBytes: 51200,
      timestampAnchorRegex: '/^/',
      timestamp: { type: 'auto', length: 150 },
      disabled: false,
    },
  ],
}

/**
 * The Raw HTTP source, less the three things set only at creation — port, TLS
 * and the auth token (see `sourceCreateBody`).
 */
export const SOURCE_SPEC = {
  id: HTTP_SOURCE_ID,
  type: 'http_raw',
  disabled: false,
  host: '0.0.0.0',
  sendToRoutes: true,
  breakerRulesets: [HTTP_BREAKER_ID],
  autoParse: false,
  streamtags: ['gigamon', 'ami'],
}

export const ROUTE_SPEC = {
  id: HTTP_ROUTE_ID,
  name: HTTP_ROUTE_ID,
  final: true,
  disabled: false,
  filter: `__inputId=='http_raw:${HTTP_SOURCE_ID}'`,
  pipeline: HTTP_PIPELINE_ID,
  output: LAKE_DESTINATION_ID,
  description: 'Gigamon AMI over HTTP → normalize → Cribl Lake (gigamon_ami)',
  clones: [],
  enableOutputExpression: false,
}

/**
 * Where a Raw HTTP source listens and how. `managed` is the worker group's
 * `onPrem === false` on a Cribl.Cloud Leader (provision.ts `hostingOf`): Cribl
 * runs the workers, exposes only 20000–20010, and provides a certificate
 * through `$CRIBL_CLOUD_CRT` / `$CRIBL_CLOUD_KEY`. A hybrid group's workers are
 * the customer's, have no such certificate, and take any port.
 */
export interface HttpIngress {
  managed: boolean
  port: number
}

/** TLS for a Raw HTTP source: Cribl's certificate on a managed group, none on a
 *  hybrid one — where the endpoint card says the traffic is unencrypted. The
 *  pack client sets the pack's own source with this. */
export function tlsFor(managed: boolean): Record<string, unknown> {
  return managed
    ? { disabled: false, minVersion: 'TLSv1.2', certPath: '$CRIBL_CLOUD_CRT', privKeyPath: '$CRIBL_CLOUD_KEY' }
    : { disabled: true }
}

/** The source's full body: the spec plus the three things set only at
 *  creation. pack.test.ts compares the pack's HTTP input with this for a
 *  Cribl-managed group. */
export function sourceCreateBody(ingress: HttpIngress, token: string): Record<string, unknown> {
  return {
    ...SOURCE_SPEC,
    port: ingress.port,
    tls: tlsFor(ingress.managed),
    authTokensExt: [{ token, authType: 'manual' }],
  }
}

/**
 * The global Cribl Lake destination's body for a profile: `destinationSpec`'s
 * settings plus the two keys that are not settings — `id` and `type`.
 */
export function destinationSpecFor(profile: LandingProfile): Record<string, unknown> {
  return { id: LAKE_DESTINATION_ID, type: 'cribl_lake', ...destinationSpec(profile).set }
}

/** `DEFAULT_PROFILE`'s destination: JSON / 30 days / 5 MB · 60 s · 15 s — what
 *  the pack's `gigamon_ami_json_lake` ships with, and what earlier releases'
 *  Guided Setup created as `gigamon_lake`. */
export const DESTINATION_SPEC = destinationSpecFor(DEFAULT_PROFILE)
