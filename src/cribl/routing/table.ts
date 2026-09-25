// THE ROUTING TABLE: for every query family the app runs against `gigamon_ami`,
// which dataset answers it — the JSON archive or the Parquet copy — and on what
// evidence. Phase 8.1 (design §4 "8.1"), built 2026-09-25 with NOTHING MOVED.
//
// ── WHY PER QUERY, NOT PER INSTALL ──────────────────────────────────────────
// Parquet's automatic schema reads an absent field back as "" or 0, and that
// changes some aggregates and not others (parity.ts, classes A–F and T). So
// "this install reads Parquet" is not a decision anyone can make safely; "this
// query's text, with these field types, on this install's density, with this
// parity evidence, may read Parquet" is. Each entry is one such decision.
//
// ── MOVING A QUERY IS A DATA CHANGE, BACKED BY EVIDENCE ─────────────────────
// An entry says `target: 'parquet'` only with `evidence` — a parity report that
// passed for that entry's own text over at least three windows at different
// hours — and only when its text is eligible under the type table
// (routing/eligibility.ts). `tableProblems()` enforces both, and
// routing/table.test.ts fails the build on any entry that breaks either. Today
// no entry has evidence, so every entry says `json`: the Parquet dataset holds
// no data yet (it fills from pack 0.2.1's HTTP source, not released).
//
// Even a `parquet` entry routes only while the install's own density and a
// completeness check agree at submit time (routing/route.ts): the table says a
// query MAY move; the install decides whether it does, per window.
//
// ── MATCHED BY EXACT TEXT ───────────────────────────────────────────────────
// The router looks a submitted query up by its text as written. A text no entry
// lists — a builder given a typed filter, a drill-down built from a clicked row —
// is not in the table and runs on JSON. That is deliberate: evidence is for a
// query's OWN text, and a text nobody measured has none.
//
// ── SCHEDULES STAY ON JSON (S1) ─────────────────────────────────────────────
// A saved search's body is fixed KQL written from accel/manifest.ts, not
// submitted through cribl/search.ts, so no router reaches it; routing an
// accelerated panel moves only its live run. A `_pq` hole under
// `onBackpressure: drop` would otherwise be stored into `$vt_results` and served
// as "as of HH:MM" with nothing to catch it (design §4, S1–S3).
//
// The display freeze holds this table (scripts/extract-queries.mjs `routing`),
// so a routing change shows in the freeze diff beside the query it moves.

import { PIVOTS, buildAppmixQuery, buildKpiQuery, buildL4Query, buildTalkersQuery } from '../../queries/capacityTopTalkers'
import { LAKE_HELD_QUERY, VOLUME_QUERY } from '../../queries/dataFlow'
import { REAL_DATA_PROBE_QUERY } from '../../queries/datasets'
import { OVERALL, PER_RESOLVER } from '../../queries/dnsHealth'
import { FEED_SAMPLE_QUERY, PRESENCE_QUERY } from '../../queries/fieldExplorer'
import { FINDINGS_QUERY } from '../../queries/findings'
import { edgesQuery, nodesQuery, srcQuery } from '../../queries/flowMap'
import {
  LANDING_LAG_QUERY,
  PARITY_CODE_PRESENCE_QUERY,
  PARITY_COUNT_QUERY,
  PARITY_HOST_PRESENCE_QUERY,
  PARITY_LATENCY_QUERY,
  PARTITION_CANDIDATES_QUERY,
} from '../../queries/lakeLanding'
import { GROUPS_Q, SERVERS_Q } from '../../queries/pqcReadiness'
import { COUNTS, SOURCES } from '../../queries/security'
import { aiOverallQuery, aiUsersQuery, appsQuery } from '../../queries/shadowAi'
import {
  APP_L4_SNAPSHOT_QUERY,
  APP_SRC_SNAPSHOT_QUERY,
  OVERVIEW_SNAPSHOT_QUERY,
  SERVICE_EDGES_SNAPSHOT_QUERY,
  TCP_SUBNET16_SNAPSHOT_QUERY,
  TCP_SUBNET24_SNAPSHOT_QUERY,
  WEB_HOST_SNAPSHOT_QUERY,
} from '../../queries/snapshots'
import { METRICS, buildHeatQuery, buildTrendQuery, latencyQuery } from '../../queries/tcpHealth'
import { PQC_BY_SERVER, SERVERS } from '../../queries/tlsPosture'
import { CODES, ERRORS_DRILL, H2, HOSTS, KPI, SLOW, TREND } from '../../queries/webApiHealth'
import { FIELD_TYPES } from '../../data/fieldTypes'
import type { FieldType, ParityWindow } from '../parity'
import type { PinReason } from '../queryTarget'
import { eligibility } from './eligibility'

export type RouteTarget = 'json' | 'parquet'

/** The parity run that justifies a `parquet` entry. */
export interface RouteEvidence {
  /** Where the report is kept: a path in this repo, or the proof install's record of it. */
  report: string
  /** The absolute windows the report passed over — at least three, at different hours. */
  windows: readonly ParityWindow[]
  /** When the run was made, YYYY-MM-DD. */
  date: string
}

export interface RouteEntry {
  /** Stable id: `<tab or module>.<figure>`. */
  id: string
  /** Where the text comes from, for a reader of the freeze. */
  from: string
  /** Every exact text this entry governs. Empty for a family built at run time. */
  queries: readonly string[]
  /** Set when the question itself must read JSON, whatever any evidence says. */
  pin: PinReason | null
  target: RouteTarget
  evidence: RouteEvidence | null
}

function entry(id: string, from: string, queries: readonly string[], pin: PinReason | null = null): RouteEntry {
  // Every entry is on JSON: no parity evidence exists for any of them yet.
  return Object.freeze({ id, from, queries: Object.freeze([...new Set(queries)]), pin, target: 'json', evidence: null })
}

const pivots = (build: (p: (typeof PIVOTS)[number]['key'], applied: string) => string) => PIVOTS.map((p) => build(p.key, ''))

/**
 * Every query family, in the order of the Phase 8 inventory (design §1.4).
 * Capacity's talkers are split by pivot because their verdicts differ: two
 * pivots are dense keys and the AWS tag is 6.7 % present (design row 2).
 */
export const ROUTES: readonly RouteEntry[] = Object.freeze([
  entry('capacity.kpi', 'capacityTopTalkers.ts › buildKpiQuery(pivot, "")', pivots(buildKpiQuery)),
  entry('capacity.talkers.src_ip', 'capacityTopTalkers.ts › buildTalkersQuery("src_ip", "")', [buildTalkersQuery('src_ip', '')]),
  entry('capacity.talkers.app_name', 'capacityTopTalkers.ts › buildTalkersQuery("app_name", "")', [buildTalkersQuery('app_name', '')]),
  entry('capacity.talkers.dst_aws_flat_tags_name', 'capacityTopTalkers.ts › buildTalkersQuery("dst_aws_flat_tags_name", "")', [buildTalkersQuery('dst_aws_flat_tags_name', '')]),
  entry('capacity.appmix', 'capacityTopTalkers.ts › buildAppmixQuery(pivot, "")', pivots(buildAppmixQuery)),
  entry('capacity.l4', 'capacityTopTalkers.ts › buildL4Query(pivot, "")', pivots(buildL4Query)),
  entry('dataFlow.volume', 'dataFlow.ts › VOLUME_QUERY', [VOLUME_QUERY]),
  entry('dns.overall', 'dnsHealth.ts › OVERALL', [OVERALL]),
  entry('dns.perResolver', 'dnsHealth.ts › PER_RESOLVER', [PER_RESOLVER]),
  entry('findings.counts', 'findings.ts › FINDINGS_QUERY', [FINDINGS_QUERY]),
  entry('flowMap.nodes', 'flowMap.ts › nodesQuery', [nodesQuery]),
  entry('flowMap.edges', 'flowMap.ts › edgesQuery, srcQuery', [edgesQuery, srcQuery]),
  entry('flowMap.serviceEdges', 'snapshots.ts › SERVICE_EDGES_SNAPSHOT_QUERY', [SERVICE_EDGES_SNAPSHOT_QUERY]),
  entry('flowMap.domains', 'flowMap.ts › buildDomainsQuery(service), built per clicked service', []),
  entry('flowMap.trend', 'flowMap.ts › buildTrendQuery(service), built per clicked service', []),
  entry('pqc.servers', 'pqcReadiness.ts › SERVERS_Q', [SERVERS_Q]),
  entry('pqc.groups', 'pqcReadiness.ts › GROUPS_Q', [GROUPS_Q]),
  entry('security.counts', 'security.ts › COUNTS', [COUNTS]),
  entry('security.sources', 'security.ts › SOURCES', [SOURCES]),
  entry('shadowAi.apps', 'shadowAi.ts › appsQuery', [appsQuery]),
  entry('shadowAi.aiOverall', 'shadowAi.ts › aiOverallQuery', [aiOverallQuery]),
  entry('shadowAi.aiUsers', 'shadowAi.ts › aiUsersQuery', [aiUsersQuery]),
  entry('snapshots.overview', 'snapshots.ts › OVERVIEW_SNAPSHOT_QUERY', [OVERVIEW_SNAPSHOT_QUERY]),
  entry('snapshots.appSrc', 'snapshots.ts › APP_SRC_SNAPSHOT_QUERY', [APP_SRC_SNAPSHOT_QUERY]),
  entry('snapshots.appL4', 'snapshots.ts › APP_L4_SNAPSHOT_QUERY', [APP_L4_SNAPSHOT_QUERY]),
  entry('snapshots.webHost', 'snapshots.ts › WEB_HOST_SNAPSHOT_QUERY', [WEB_HOST_SNAPSHOT_QUERY]),
  entry('tcp.subnetSnapshot', 'snapshots.ts › TCP_SUBNET24_SNAPSHOT_QUERY, TCP_SUBNET16_SNAPSHOT_QUERY', [TCP_SUBNET24_SNAPSHOT_QUERY, TCP_SUBNET16_SNAPSHOT_QUERY]),
  entry('tcp.heat', 'tcpHealth.ts › buildHeatQuery(metric, mask)', METRICS.flatMap((m) => (['24', '16'] as const).map((mask) => buildHeatQuery(m.key, mask)))),
  entry('tcp.trend', 'tcpHealth.ts › buildTrendQuery(metric)', METRICS.map((m) => buildTrendQuery(m.key))),
  entry('tcp.latency', 'tcpHealth.ts › latencyQuery', [latencyQuery]),
  entry('tls.servers', 'tlsPosture.ts › SERVERS', [SERVERS]),
  entry('tls.pqcByServer', 'tlsPosture.ts › PQC_BY_SERVER', [PQC_BY_SERVER]),
  entry('web.kpi', 'webApiHealth.ts › KPI', [KPI]),
  entry('web.codes', 'webApiHealth.ts › CODES', [CODES]),
  entry('web.hosts', 'webApiHealth.ts › HOSTS', [HOSTS]),
  entry('web.slow', 'webApiHealth.ts › SLOW', [SLOW]),
  entry('web.trend', 'webApiHealth.ts › TREND', [TREND]),
  entry('web.h2', 'webApiHealth.ts › H2', [H2]),

  // ── Pinned: the question itself must read JSON ─────────────────────────
  entry('fieldExplorer.presence', 'fieldExplorer.ts › PRESENCE_QUERY, FEED_SAMPLE_QUERY, sectionQuery(fields)', [PRESENCE_QUERY, FEED_SAMPLE_QUERY], 'presence'),
  entry('dns.resolverDrill', 'dnsHealth.ts › resolverDrillQuery(host)', [], 'evidence'),
  entry('findings.flows', 'findings.ts › findingFlowsQuery(finding), and each Copilot brief', [], 'evidence'),
  entry('pqc.drill', 'pqcReadiness.ts › drillQuery(filter)', [], 'evidence'),
  entry('security.drill', 'security.ts › drillQueryFor(technique)', [], 'evidence'),
  entry('tcp.drill', 'tcpHealth.ts › buildDrillQuery(cell, mask)', [], 'evidence'),
  entry('tls.serverDrill', 'tlsPosture.ts › serverDrill(server)', [], 'evidence'),
  entry('web.errorsDrill', 'webApiHealth.ts › ERRORS_DRILL', [ERRORS_DRILL], 'evidence'),
  entry('lakeLanding.landingLag', 'lakeLanding.ts › LANDING_LAG_QUERY', [LANDING_LAG_QUERY], 'measurement'),
  entry('datasets.realDataProbe', 'datasets.ts › REAL_DATA_PROBE_QUERY', [REAL_DATA_PROBE_QUERY], 'measurement'),
  entry('dataFlow.lakeHeld', 'dataFlow.ts › LAKE_HELD_QUERY', [LAKE_HELD_QUERY], 'measurement'),
  entry('lakeLanding.partitionCandidates', 'lakeLanding.ts › PARTITION_CANDIDATES_QUERY', [PARTITION_CANDIDATES_QUERY], 'measurement'),
  // The parity audits' own strings. The four checks that ARE a panel's query
  // (Security COUNTS, FINDINGS_QUERY, DNS OVERALL, Web KPI, and the Capacity
  // KPI) belong to that panel's entry above — a text has one entry — and the
  // audit submits them `asWritten`, so the router never sees an audit.
  entry(
    'lakeLanding.parity',
    'lakeLanding.ts › PARITY_COUNT_QUERY, PARITY_LATENCY_QUERY, PARITY_HOST_PRESENCE_QUERY, PARITY_CODE_PRESENCE_QUERY',
    [PARITY_COUNT_QUERY, PARITY_LATENCY_QUERY, PARITY_HOST_PRESENCE_QUERY, PARITY_CODE_PRESENCE_QUERY],
    'measurement',
  ),
])

// ── The table's own rules ───────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Why a piece of evidence is not enough, or nothing. */
export function evidenceProblems(ev: RouteEvidence): string[] {
  const out: string[] = []
  if (!ev.report.trim()) out.push('names no report')
  if (!DATE_RE.test(ev.date)) out.push(`has no date in YYYY-MM-DD form ("${ev.date}")`)
  if (ev.windows.some((w) => !(w.latest > w.earliest))) out.push('has an empty or reversed window')
  const hours = new Set(ev.windows.map((w) => new Date(w.earliest * 1000).getUTCHours()))
  if (ev.windows.length < 3 || hours.size < 3) out.push('covers fewer than three windows at different hours')
  return out
}

/**
 * Everything wrong with a table: an entry on Parquet with no evidence, with
 * evidence that is not enough, with a pin, with no text, or with a text that is
 * not eligible under the type table; and any text in two entries or not reading
 * `gigamon_ami`. Density is not judged here — it belongs to an install, and the
 * router checks it at submit time.
 */
export function tableProblems(entries: readonly RouteEntry[] = ROUTES, types: Readonly<Record<string, FieldType>> = FIELD_TYPES): string[] {
  const out: string[] = []
  const owner = new Map<string, string>()
  for (const e of entries) {
    for (const text of e.queries) {
      const had = owner.get(text)
      if (had) out.push(`${e.id}: its text is also listed by ${had}`)
      owner.set(text, e.id)
      if (!text.startsWith('dataset="gigamon_ami" ')) out.push(`${e.id}: a text that does not read gigamon_ami — ${text}`)
    }
    if (e.target !== 'parquet') continue
    if (e.pin) out.push(`${e.id}: pinned (${e.pin}) and routed to Parquet`)
    if (!e.evidence) out.push(`${e.id}: routed to Parquet with no parity evidence`)
    else for (const p of evidenceProblems(e.evidence)) out.push(`${e.id}: its evidence ${p}`)
    if (!e.queries.length) out.push(`${e.id}: routed to Parquet with no text listed`)
    for (const text of e.queries) {
      const refused = eligibility(text, types).refusals.filter((r) => r.kind !== 'density')
      if (refused.length) out.push(`${e.id}: routed to Parquet but not eligible — ${refused.map((r) => r.words).join('; ')}`)
    }
  }
  return out
}

/** One entry's eligibility under the type table, in words — what the freeze shows. */
export function eligibilityWords(e: RouteEntry, types: Readonly<Record<string, FieldType>> = FIELD_TYPES): string {
  if (e.pin) return `pinned to JSON (${e.pin})`
  if (!e.queries.length) return 'no text listed: built at run time, so it never routes'
  const why = [...new Set(e.queries.flatMap((q) => eligibility(q, types).refusals.map((r) => r.words)))]
  return why.length ? `no — ${why.join('; ')}` : 'yes, where this install measures its keys dense'
}

/** The table as the display freeze holds it: one line of facts per entry. */
export function routingSnapshot(entries: readonly RouteEntry[] = ROUTES, types: Readonly<Record<string, FieldType>> = FIELD_TYPES): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    out[e.id] = {
      from: e.from,
      target: e.target,
      pin: e.pin,
      eligible: eligibilityWords(e, types),
      evidence: e.evidence,
      queries: e.queries.length,
    }
  }
  return out
}
