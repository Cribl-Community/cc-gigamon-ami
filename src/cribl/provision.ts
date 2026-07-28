// Guided-setup provisioning client.
//
// Deploys the *real-world* Gigamon AMI onboarding path into the Cribl Stream
// `default` group — a Syslog source, a parse+normalize pipeline, a route, and
// the Cribl Lake dataset — so a user can point their Gigamon Application
// Metadata Exporter (AMX) at Cribl and have flows land in the same `gigamon_ami`
// dataset these dashboards already read.
//
// Every operation is idempotent and ADDITIVE: it never edits the demo DataGen
// source, the existing `gigamon_ami` pipeline, or the `gigamon_lake`
// destination. The route is prepended above the catch-all `default` route with
// a filter scoped to this source, so unrelated data is unaffected.
//
// Calls go through the same channel as Search: `${API_BASE}/...` (installed →
// platform proxy; `npm run dev` → Vite `/capi` proxy). See cribl/config.ts.

import { API_BASE, STREAM_GROUP } from './config'

export const SYSLOG_SOURCE_ID = 'in_gigamon_syslog'
export const SYSLOG_PIPELINE_ID = 'gigamon_syslog'
export const SYSLOG_ROUTE_ID = 'gigamon_ami_syslog'
export const LAKE_DESTINATION_ID = 'gigamon_lake'
export const LAKE_DATASET_ID = 'gigamon_ami'
export const SYSLOG_PORT = 5514
const LAKE_ID = 'default'

// --- Resource specs (exported so the UI can show exactly what gets created) ---

/** The two Evals below are copied verbatim from the existing `gigamon_ami`
 *  pipeline so syslog-delivered flows get identical field derivations. */
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

// Syslog-specific pre-parse: Gigamon AMX exports AMI records as JSON in the
// syslog MSG. Fall back to _raw when the source delivers unframed JSON, then
// extract the JSON into top-level fields. (CEF export would need a different
// parse — see the note in the Guided Setup tab.)
const PREP_FN = {
  id: 'eval', filter: 'true', disabled: false, description: 'Fallback to _raw when no syslog MSG',
  conf: { add: [{ name: 'message', value: 'message==null?_raw:message' }] },
}
const PARSE_FN = {
  id: 'serde', filter: "typeof message==='string' && message.trim().charAt(0)==='{'", disabled: false,
  description: 'Parse Gigamon AMI JSON from the syslog message',
  conf: { mode: 'extract', type: 'json', srcField: 'message' },
}

export const PIPELINE_SPEC = {
  id: SYSLOG_PIPELINE_ID,
  conf: { functions: [PREP_FN, PARSE_FN, CAST_FN, DERIVE_FN] },
}

export const SOURCE_SPEC = {
  id: SYSLOG_SOURCE_ID,
  type: 'syslog',
  disabled: false,
  host: '0.0.0.0',
  tcpPort: SYSLOG_PORT,
  udpPort: SYSLOG_PORT,
  sendToRoutes: true,
  streamtags: ['gigamon', 'ami'],
}

export const ROUTE_SPEC = {
  id: SYSLOG_ROUTE_ID,
  name: SYSLOG_ROUTE_ID,
  final: true,
  disabled: false,
  filter: `__inputId=='syslog:${SYSLOG_SOURCE_ID}'`,
  pipeline: SYSLOG_PIPELINE_ID,
  output: LAKE_DESTINATION_ID,
  description: 'Gigamon AMI syslog → parse → Cribl Lake (gigamon_ami)',
  clones: [],
  enableOutputExpression: false,
}

export const DATASET_SPEC = {
  id: LAKE_DATASET_ID,
  description: 'Gigamon Application Metadata Intelligence (AMI) flow records',
  retentionPeriodInDays: 30,
  format: 'json',
}

// The Cribl Lake destination that writes into the `gigamon_ami` dataset. Only
// created if missing (it already exists in the demo tenant).
const DESTINATION_SPEC = {
  id: LAKE_DESTINATION_ID,
  type: 'cribl_lake',
  destPath: LAKE_DATASET_ID,
  format: 'json',
  storageLocationId: 'cribl_lake',
  maxFileSizeMB: 5,
  maxFileOpenTimeSec: 60,
  maxFileIdleTimeSec: 15,
  compress: 'gzip',
  onBackpressure: 'block',
}

// --- Low-level API helper ------------------------------------------------

interface ApiResp { status: number; body: unknown }

async function capi(method: string, path: string, body?: unknown): Promise<ApiResp> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let parsed: unknown = null
  const text = await res.text()
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  return { status: res.status, body: parsed }
}

function errText(r: ApiResp): string {
  if (r.body && typeof r.body === 'object') {
    const m = (r.body as { message?: string; error?: string }).message || (r.body as { error?: string }).error
    if (m) return m
    return JSON.stringify(r.body).slice(0, 200)
  }
  return typeof r.body === 'string' ? r.body.slice(0, 200) : `HTTP ${r.status}`
}

const g = (path: string) => `/m/${STREAM_GROUP}${path}`
const datasetsPath = `/products/lake/lakes/${LAKE_ID}/datasets`

// --- Status ---------------------------------------------------------------

export type ResourceKey = 'dataset' | 'destination' | 'pipeline' | 'source' | 'route'

export interface SetupStatus {
  dataset: boolean
  destination: boolean
  pipeline: boolean
  source: boolean
  route: boolean
}

export async function checkStatus(): Promise<SetupStatus> {
  const [ds, dest, pipe, src, routes] = await Promise.all([
    capi('GET', datasetsPath),
    capi('GET', g(`/system/outputs/${LAKE_DESTINATION_ID}`)),
    capi('GET', g(`/pipelines/${SYSLOG_PIPELINE_ID}`)),
    capi('GET', g(`/system/inputs/${SYSLOG_SOURCE_ID}`)),
    capi('GET', g('/routes')),
  ])
  const dsItems = (ds.body as { items?: Array<{ id?: string }> })?.items || []
  const routeList = ((routes.body as { items?: Array<{ routes?: Array<{ id?: string; name?: string }> }> })?.items?.[0]?.routes) || []
  return {
    dataset: dsItems.some((d) => d.id === LAKE_DATASET_ID),
    destination: dest.status === 200,
    pipeline: pipe.status === 200,
    source: src.status === 200,
    route: routeList.some((r) => r.id === SYSLOG_ROUTE_ID || r.name === SYSLOG_ROUTE_ID),
  }
}

// --- Ensure (idempotent create/update) -----------------------------------

export type StepAction = 'created' | 'updated' | 'exists' | 'error'
export interface StepResult { key: ResourceKey | 'deploy'; action: StepAction; detail?: string }

async function ensureDataset(): Promise<StepResult> {
  const list = await capi('GET', datasetsPath)
  const items = (list.body as { items?: Array<{ id?: string }> })?.items || []
  if (items.some((d) => d.id === LAKE_DATASET_ID)) return { key: 'dataset', action: 'exists' }
  const r = await capi('POST', datasetsPath, DATASET_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'dataset', action: 'created' }
    : { key: 'dataset', action: 'error', detail: errText(r) }
}

async function ensureDestination(): Promise<StepResult> {
  const cur = await capi('GET', g(`/system/outputs/${LAKE_DESTINATION_ID}`))
  if (cur.status === 200) return { key: 'destination', action: 'exists' }
  const r = await capi('POST', g('/system/outputs'), DESTINATION_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'destination', action: 'created' }
    : { key: 'destination', action: 'error', detail: errText(r) }
}

async function ensurePipeline(): Promise<StepResult> {
  const cur = await capi('GET', g(`/pipelines/${SYSLOG_PIPELINE_ID}`))
  if (cur.status === 200) {
    const r = await capi('PATCH', g(`/pipelines/${SYSLOG_PIPELINE_ID}`), PIPELINE_SPEC)
    return r.status === 200 ? { key: 'pipeline', action: 'updated' } : { key: 'pipeline', action: 'error', detail: errText(r) }
  }
  const r = await capi('POST', g('/pipelines'), PIPELINE_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'pipeline', action: 'created' }
    : { key: 'pipeline', action: 'error', detail: errText(r) }
}

async function ensureSource(): Promise<StepResult> {
  const cur = await capi('GET', g(`/system/inputs/${SYSLOG_SOURCE_ID}`))
  if (cur.status === 200) {
    const r = await capi('PATCH', g(`/system/inputs/${SYSLOG_SOURCE_ID}`), SOURCE_SPEC)
    return r.status === 200 ? { key: 'source', action: 'updated' } : { key: 'source', action: 'error', detail: errText(r) }
  }
  const r = await capi('POST', g('/system/inputs'), SOURCE_SPEC)
  return r.status >= 200 && r.status < 300
    ? { key: 'source', action: 'created' }
    : { key: 'source', action: 'error', detail: errText(r) }
}

async function ensureRoute(): Promise<StepResult> {
  const cur = await capi('GET', g('/routes'))
  const obj = (cur.body as { items?: Array<{ id: string; routes: Array<Record<string, unknown>> }> })?.items?.[0]
  if (!obj) return { key: 'route', action: 'error', detail: 'routing table not found' }
  const existing = obj.routes.filter((x) => x.id !== SYSLOG_ROUTE_ID && x.name !== SYSLOG_ROUTE_ID)
  const already = obj.routes.length !== existing.length
  const updated = { id: obj.id, routes: [ROUTE_SPEC, ...existing] }
  const r = await capi('PATCH', g(`/routes/${obj.id}`), updated)
  if (r.status !== 200) return { key: 'route', action: 'error', detail: errText(r) }
  return { key: 'route', action: already ? 'updated' : 'created' }
}

export async function commitAndDeploy(message: string): Promise<StepResult> {
  const commit = await capi('POST', '/version/commit', { message, group: STREAM_GROUP })
  if (commit.status < 200 || commit.status >= 300) return { key: 'deploy', action: 'error', detail: errText(commit) }
  const body = commit.body as { items?: Array<{ commit?: string }>; commit?: string }
  const hash = body?.items?.[0]?.commit || body?.commit
  if (!hash) return { key: 'deploy', action: 'exists', detail: 'nothing to commit' }
  const dep = await capi('PATCH', `/master/groups/${STREAM_GROUP}/deploy`, { version: hash })
  return dep.status === 200
    ? { key: 'deploy', action: 'created', detail: hash.slice(0, 10) }
    : { key: 'deploy', action: 'error', detail: errText(dep) }
}

/** Provision the whole stack in dependency order, reporting each step. */
export async function deployAll(onStep: (r: StepResult) => void): Promise<StepResult[]> {
  const out: StepResult[] = []
  for (const fn of [ensureDataset, ensureDestination, ensurePipeline, ensureSource, ensureRoute]) {
    const r = await fn()
    out.push(r)
    onStep(r)
    if (r.action === 'error') return out // stop before committing a partial stack
  }
  const dep = await commitAndDeploy('Guided setup: Gigamon AMI syslog onboarding')
  out.push(dep)
  onStep(dep)
  return out
}

/** Tear down the syslog stack (source, pipeline, route). Leaves the shared
 *  dataset and destination in place. */
export async function removeSyslogStack(onStep: (r: StepResult) => void): Promise<StepResult[]> {
  const out: StepResult[] = []
  // Route: remove our entry, keep the rest.
  const cur = await capi('GET', g('/routes'))
  const obj = (cur.body as { items?: Array<{ id: string; routes: Array<Record<string, unknown>> }> })?.items?.[0]
  if (obj) {
    const kept = obj.routes.filter((x) => x.id !== SYSLOG_ROUTE_ID && x.name !== SYSLOG_ROUTE_ID)
    const r = await capi('PATCH', g(`/routes/${obj.id}`), { id: obj.id, routes: kept })
    const res: StepResult = { key: 'route', action: r.status === 200 ? 'updated' : 'error', detail: r.status === 200 ? undefined : errText(r) }
    out.push(res); onStep(res)
  }
  const src = await capi('DELETE', g(`/system/inputs/${SYSLOG_SOURCE_ID}`))
  const sres: StepResult = { key: 'source', action: src.status < 300 ? 'updated' : 'error', detail: src.status < 300 ? 'deleted' : errText(src) }
  out.push(sres); onStep(sres)
  const pipe = await capi('DELETE', g(`/pipelines/${SYSLOG_PIPELINE_ID}`))
  const pres: StepResult = { key: 'pipeline', action: pipe.status < 300 ? 'updated' : 'error', detail: pipe.status < 300 ? 'deleted' : errText(pipe) }
  out.push(pres); onStep(pres)
  const dep = await commitAndDeploy('Guided setup: remove Gigamon AMI syslog onboarding')
  out.push(dep); onStep(dep)
  return out
}

/** Best-effort Syslog ingress endpoint to point Gigamon AMX at. The worker
 *  ingress host differs from the UI origin; on Cribl.Cloud it is typically
 *  `default.main.<org>.cribl.cloud`. Returns null when it can't be derived. */
export function suggestedSyslogHost(): string | null {
  if (typeof window === 'undefined') return null
  const origin = window.__CRIBL_SEARCH_ORIGIN || window.location.origin
  try {
    const host = new URL(origin).hostname // e.g. main-<org>.cribl.cloud
    if (host.startsWith('main-')) return `default.main.${host.slice('main-'.length)}`
    return host
  } catch {
    return null
  }
}
