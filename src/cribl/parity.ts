// The Lake landing parity check, as a computation: which queries it runs, which
// null-semantics class each result column belongs to, which dashboard number
// that column protects, and how a JSON-side row and a Parquet-side row are
// compared and reported.
//
// PURE. Nothing here calls `runSearch`, `capi` or `fetch`. `parityJobs` says
// WHAT to run over which dataset and window; whoever runs it hands the rows back
// to `compareParity`. The KQL is in src/queries/lakeLanding.ts for the reason
// that module's header gives (the freeze cannot resolve a query constant from
// src/cribl/*).
//
// ── WHY FIVE CLASSES, AND WHY RATIOS ────────────────────────────────────────
// Automatic-schema Parquet reads an ABSENT field back as `""` or `0` (measured
// 2026-09-21). Five kinds of aggregate change meaning under that:
//
//   A  isnotnull(f)             measured: Q29 c_T1572 18 → 43,338
//   B  count(f)                 measured: Q32 f2      18 → 43,338
//   C  dcount(f)                NOT measured — expected +1, the "" value
//   D  f=* presence filter      NOT measured — may admit every row
//   E  percentile/avg/min(f)    NOT measured — dragged toward 0
//
// The first version of this check asked only whether a figure was zero on one
// side and non-zero on the other, and reported "no difference" while c_T1572
// went 18 → 40,280. The failure is a change of MAGNITUDE, so every column here
// is compared as a ratio against a tolerance.
//
// The classes are DERIVED from each query's own text (`classify`), not written
// beside it, so a column cannot be filed under the wrong class and a new
// aggregate cannot join a check without being classified.
//
// ── WHAT THIS CANNOT ESTABLISH ──────────────────────────────────────────────
// * The tolerances are chosen, not measured. The only measured agreement is the
//   bare count, within 0.2 % over "comparable" six-minute windows of two
//   datasets fed by one generator. ±1 % and ±5 % are judgement.
// * Class C's +1 is outside ±1 % only while the distinct count is under 100
//   (1/100 = 1 %). On a larger count it is inside the tolerance and invisible,
//   and the class sentence says so rather than implying otherwise.
// * `dcount()` is approximate (≈ ±0.5 % at ~10k distinct values, exact at a few
//   hundred — measured 2026-09-23), which is part of why C is not compared
//   exactly.
// * Nothing here has been run against Cribl. The C, D and E queries exist so
//   that the next parity run MEASURES those three classes.

import {
  PARITY_CAPACITY_KPI_QUERY,
  PARITY_CODE_PRESENCE_QUERY,
  PARITY_COUNT_QUERY,
  PARITY_DNS_QUERY,
  PARITY_FINDINGS_QUERY,
  PARITY_HOST_PRESENCE_QUERY,
  PARITY_LATENCY_QUERY,
  PARITY_SECURITY_QUERY,
  PARITY_WEB_KPI_QUERY,
} from '../queries/lakeLanding'
import { FINDINGS } from '../data/findings'
import { TECHNIQUES } from '../data/techniques'
import { LAKE_DATASET } from './config'

// ── The classes ─────────────────────────────────────────────────────────────

export type NullClass = 'A' | 'B' | 'C' | 'D' | 'E'

export const NULL_CLASSES: Readonly<Record<NullClass, { pattern: string; underParquet: string }>> = Object.freeze({
  A: { pattern: 'isnotnull(f)', underParquet: 'true on every row, so a rare signal counts the whole window' },
  B: { pattern: 'count(f)', underParquet: 'counts every row, so every detection fires' },
  C: { pattern: 'dcount(f)', underParquet: 'gains one distinct value, the empty string' },
  D: { pattern: 'f=* presence filter', underParquet: 'may admit every row, so a scoped panel stops being scoped' },
  E: { pattern: 'percentile / avg / min(f)', underParquet: 'is dragged toward 0 by rows that never had a value' },
})

export const CLASS_ORDER: readonly NullClass[] = Object.freeze(['A', 'B', 'C', 'D', 'E'])

/**
 * The allowed relative difference, by kind of aggregate.
 *
 * `count` covers counts, sums and distinct counts; `distribution` covers
 * percentile, avg, min and max, which move with the exact records in the window
 * in a way a count does not. Judgement, not measurement — see the header.
 */
export const TOLERANCE: Readonly<Record<'count' | 'distribution', number>> = Object.freeze({
  count: 0.01,
  distribution: 0.05,
})

// ── The checks ──────────────────────────────────────────────────────────────

export interface ParityCheck {
  id: string
  query: string
  /** Every result column, and the dashboard number it stands for. */
  protects: Readonly<Record<string, string>>
  /** The check whose one column says whether the two sides hold the same records. */
  control?: string
}

const flowTechniques = TECHNIQUES.filter((t) => t.kind === 'flow')

/**
 * Every query a parity run compares, and what each result column protects.
 *
 * `count`, `security` and `findings` are the triple (classes A and B). The rest
 * close C, D and E. `parity.test.ts` holds both directions of `protects`
 * against the query's own summarize clause, so a column the query returns cannot
 * go unlabelled and a label cannot outlive its column.
 */
export const PARITY_CHECKS: readonly ParityCheck[] = Object.freeze([
  {
    id: 'count',
    query: PARITY_COUNT_QUERY,
    control: 'c',
    protects: { c: 'The control: every record in the window' },
  },
  {
    id: 'security',
    query: PARITY_SECURITY_QUERY,
    protects: Object.fromEntries(
      flowTechniques.map((t) => [`c_${t.id.replace(/\./g, '_')}`, `Security · "${t.name}" (${t.id}) flow-signal count`]),
    ),
  },
  {
    id: 'findings',
    query: PARITY_FINDINGS_QUERY,
    protects: {
      total: 'Findings · the flow total each finding is measured against',
      ...Object.fromEntries(FINDINGS.map((f, i) => [`f${i}`, `Findings · "${f.title}"`])),
    },
  },
  {
    id: 'dns',
    query: PARITY_DNS_QUERY,
    protects: {
      total: 'DNS health · "SERVFAIL / error rate" tile (its denominator)',
      noerr: 'DNS health · NOERROR count (computed by the tile query, not drawn)',
      sf: 'DNS health · "SERVFAIL / error rate" tile (SERVFAIL)',
      nx: 'DNS health · "SERVFAIL / error rate" tile (NXDOMAIN)',
      resolvers: 'DNS health · "Distinct resolvers" tile',
    },
  },
  {
    id: 'web-kpi',
    query: PARITY_WEB_KPI_QUERY,
    protects: {
      txns: 'Web & API · "HTTP transactions" tile',
      errors: 'Web & API · "Error rate" tile (its 4xx/5xx count)',
      server_p95: 'Web & API · "Server think-time p95" tile',
      hosts: 'Web & API · distinct http_host (computed by the tile query, not drawn)',
      h2: 'Web & API · "HTTP/2 transactions" tile',
    },
  },
  {
    id: 'capacity-kpi',
    query: PARITY_CAPACITY_KPI_QUERY,
    protects: {
      total: 'Capacity · "Total traffic" tile',
      tin: 'Capacity · "Traffic in" tile',
      tout: 'Capacity · "Traffic out" tile',
      pkts: 'Capacity · "Packets" tile',
      rtt: 'Capacity · "Avg RTT" tile',
      retrans: 'Capacity · "Retransmits" tile',
    },
  },
  {
    id: 'latency',
    query: PARITY_LATENCY_QUERY,
    protects: {
      net: 'TCP health · "Network vs app latency", p95 tcp_rtt (whole window, not per minute)',
      net_lo: 'TCP health · "Network vs app latency", tcp_rtt band lower edge (min)',
      net_hi: 'TCP health · "Network vs app latency", tcp_rtt band upper edge (max)',
      app: 'TCP health · "Network vs app latency", p95 tcp_rtt_app (whole window, not per minute)',
      app_lo: 'TCP health · "Network vs app latency", tcp_rtt_app band lower edge (min)',
      app_hi: 'TCP health · "Network vs app latency", tcp_rtt_app band upper edge (max)',
    },
  },
  {
    id: 'host-presence',
    query: PARITY_HOST_PRESENCE_QUERY,
    protects: { n: 'Web & API · "Top endpoints by requests", the rows its http_host=* filter admits' },
  },
  {
    id: 'code-presence',
    query: PARITY_CODE_PRESENCE_QUERY,
    protects: { n: 'Web & API · "Status codes" and "Requests and errors over time", the rows their http_code=* filter admits' },
  },
])

// ── Reading a query ─────────────────────────────────────────────────────────

/** Split on commas that are outside parentheses and quotes. */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out.map((x) => x.trim()).filter(Boolean)
}

/**
 * The search head (what sits between the dataset term and `| summarize`) and
 * each `name=aggregate` of the summarize clause. Throws on a query with no
 * scalar summarize: a parity check compares one row per side, and a grouped
 * query would compare whichever group came first.
 */
export function summarizeColumns(query: string): { head: string; columns: { name: string; expr: string }[] } {
  const at = query.indexOf('| summarize ')
  if (at < 0) throw new Error(`parity: no summarize clause in ${query}`)
  const head = query.slice(0, at).replace(/^dataset="[^"]*"/, '').trim()
  const clause = query.slice(at + '| summarize '.length)
  if (/\sby\s/.test(clause.replace(/"[^"]*"/g, '""')) || clause.includes('|')) {
    throw new Error(`parity: a grouped or piped summarize cannot be compared row for row: ${query}`)
  }
  const columns = splitTopLevel(clause).map((part) => {
    const eq = part.indexOf('=')
    if (eq < 0) throw new Error(`parity: unnamed aggregate "${part}" in ${query}`)
    return { name: part.slice(0, eq).trim(), expr: part.slice(eq + 1).trim() }
  })
  return { head, columns }
}

const PRESENCE_RE = /(?:^|\s)[\w.]+=\*(?=\s|$)/
const DISTRIBUTION_RE = /^(percentile|avg|min|max)\(/

/** The null-semantics classes an aggregate under a given search head belongs to. */
export function classify(expr: string, head: string): NullClass[] {
  const out: NullClass[] = []
  if (/\bisnotnull\(/.test(expr)) out.push('A')
  if (/^count\(\s*[\w.]+\s*\)$/.test(expr)) out.push('B')
  if (/^dcount\(/.test(expr)) out.push('C')
  if (PRESENCE_RE.test(head)) out.push('D')
  if (/^(percentile|avg|min)\(/.test(expr)) out.push('E')
  return out
}

export interface ParityColumn {
  check: string
  column: string
  expr: string
  classes: NullClass[]
  role: 'control' | 'classed' | 'unaffected'
  kind: 'count' | 'distribution'
  tolerance: number
  protects: string
}

/** Every column of every check, classified. */
export function parityColumns(checks: readonly ParityCheck[] = PARITY_CHECKS): ParityColumn[] {
  return checks.flatMap((check) => {
    const { head, columns } = summarizeColumns(check.query)
    return columns.map(({ name, expr }) => {
      const classes = classify(expr, head)
      const kind = DISTRIBUTION_RE.test(expr) ? 'distribution' : 'count'
      const protects = check.protects[name]
      if (!protects) throw new Error(`parity: column ${check.id}.${name} protects nothing — label it`)
      return {
        check: check.id,
        column: name,
        expr,
        classes,
        role: check.control === name ? 'control' : classes.length ? 'classed' : 'unaffected',
        kind,
        tolerance: TOLERANCE[kind],
        protects,
      } satisfies ParityColumn
    })
  })
}

// ── What to run ─────────────────────────────────────────────────────────────

/** One absolute window, epoch seconds. Never relative: see lakeLanding.ts §3. */
export interface ParityWindow {
  earliest: number
  latest: number
}

export interface ParityDatasets {
  /** The dataset the dashboards read today. */
  json: string
  /** The Parquet dataset being judged. */
  parquet: string
}

const DATASET_ID_RE = /^[A-Za-z0-9_]+$/

/** The same query, reading another dataset. Throws rather than guess. */
export function retarget(query: string, dataset: string): string {
  if (!DATASET_ID_RE.test(dataset)) throw new Error(`parity: not a dataset id: ${dataset}`)
  const prefix = `dataset="${LAKE_DATASET}" `
  if (!query.startsWith(prefix)) throw new Error(`parity: query does not read ${LAKE_DATASET}: ${query}`)
  return `dataset="${dataset}" ${query.slice(prefix.length)}`
}

export interface ParityJob {
  check: string
  side: 'json' | 'parquet'
  query: string
  earliest: number
  latest: number
}

/** Every job a parity run submits: each check, once per side, one window. */
export function parityJobs(window: ParityWindow, datasets: ParityDatasets, checks: readonly ParityCheck[] = PARITY_CHECKS): ParityJob[] {
  if (!(window.latest > window.earliest)) throw new Error('parity: the window is empty or reversed')
  if (datasets.json === datasets.parquet) throw new Error('parity: both sides name the same dataset')
  return checks.flatMap((c) =>
    (['json', 'parquet'] as const).map((side) => ({
      check: c.id,
      side,
      query: retarget(c.query, datasets[side]),
      earliest: window.earliest,
      latest: window.latest,
    })),
  )
}

// ── Comparing ───────────────────────────────────────────────────────────────

export type Row = Readonly<Record<string, unknown>>

function numberOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export type ColumnVerdict = 'agrees' | 'differs' | 'unexercised'

export interface ColumnResult extends ParityColumn {
  json: number | null
  parquet: number | null
  /** parquet ÷ json, when json is a non-zero number. */
  ratio: number | null
  verdict: ColumnVerdict
}

/**
 * One column, both sides.
 *
 * Nothing on both sides is `unexercised`, never `agrees`: a figure that was
 * zero on both sides compared nothing. For a count-kind aggregate a missing
 * value and 0 are the same statement (a `sum` over rows that all lack the key
 * is omitted from the row). For a distribution they are NOT: a latency tile
 * that read "no value" on JSON and 0 on Parquet is class E's failure exactly.
 */
export function compareColumn(col: ParityColumn, jsonRow: Row | null | undefined, parquetRow: Row | null | undefined): ColumnResult {
  const json = numberOf(jsonRow?.[col.column])
  const parquet = numberOf(parquetRow?.[col.column])
  const base = { ...col, json, parquet }
  const nothing = (v: number | null) => v === null || v === 0

  if (col.kind === 'distribution') {
    if (json === null && parquet === null) return { ...base, ratio: null, verdict: 'unexercised' }
    if (json === null || parquet === null) return { ...base, ratio: null, verdict: 'differs' }
    if (json === 0) return { ...base, ratio: null, verdict: parquet === 0 ? 'unexercised' : 'differs' }
  } else {
    if (nothing(json) && nothing(parquet)) return { ...base, ratio: null, verdict: 'unexercised' }
    if (nothing(json)) return { ...base, ratio: null, verdict: 'differs' }
  }
  const j = json as number
  const p = parquet ?? 0
  const ratio = p / j
  return { ...base, ratio, verdict: Math.abs(p - j) / Math.abs(j) <= col.tolerance ? 'agrees' : 'differs' }
}

export type ClassVerdict = 'pass' | 'fail' | 'unexercised' | 'incomparable'

export interface ClassReport {
  cls: NullClass
  pattern: string
  verdict: ClassVerdict
  /** The dashboard numbers this class's columns stand for. */
  protects: string[]
  columns: ColumnResult[]
  sentence: string
}

export interface ParityReport {
  window: ParityWindow
  datasets: ParityDatasets
  control: ColumnResult
  comparable: boolean
  verdict: 'pass' | 'fail' | 'partial' | 'incomparable'
  classes: ClassReport[]
  /** Columns no class applies to — compared, but attributed to none. */
  unaffected: ColumnResult[]
  sentence: string
}

function fmtValue(v: number | null): string {
  if (v === null) return 'no value'
  if (Number.isInteger(v)) return v.toLocaleString('en-US')
  return String(Number(v.toPrecision(4)))
}

function pct(t: number): string {
  return `±${Math.round(t * 1000) / 10} %`
}

/** "2026-09-23 10:00:00–10:06:00 UTC", or both ends in full across midnight. */
export function windowWords(w: ParityWindow): string {
  const iso = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const a = iso(w.earliest)
  const b = iso(w.latest)
  const sameDay = a.slice(0, 10) === b.slice(0, 10)
  return `${a}–${sameDay ? b.slice(11) : b} UTC`
}

function sides(r: ColumnResult, d: ParityDatasets): string {
  const move = r.ratio === null ? 'where the JSON side had none' : `×${Number(r.ratio.toPrecision(3))}`
  return `${r.protects}: ${fmtValue(r.json)} on ${d.json}, ${fmtValue(r.parquet)} on ${d.parquet} (${move})`
}

/** A limit a class's own tolerance puts on what a pass can mean. */
const CLASS_LIMIT: Partial<Record<NullClass, string>> = {
  C: `A difference of one distinct value is outside ${pct(TOLERANCE.count)} only while the count is under 100, so a pass cannot rule out the extra "" on a larger one.`,
}

function classSentence(cls: NullClass, verdict: ClassVerdict, cols: ColumnResult[], control: ColumnResult, d: ParityDatasets, w: ParityWindow): string {
  const name = `Class ${cls} (${NULL_CLASSES[cls].pattern})`
  const over = `over ${windowWords(w)}`
  switch (verdict) {
    case 'incomparable':
      return `${name} was not judged: the control disagreed (${sides(control, d)}), so the two datasets did not hold the same records ${over}.`
    case 'fail': {
      const bad = cols.filter((c) => c.verdict === 'differs')
      const tol = bad.map((c) => c.tolerance)
      return (
        `${name} FAILED on ${bad.length} of ${cols.length} figures ${over}, outside ${pct(Math.max(...tol))}: ` +
        bad.map((c) => sides(c, d)).join('; ') +
        `. Under Parquet this aggregate ${NULL_CLASSES[cls].underParquet}.`
      )
    }
    case 'unexercised':
      return `${name} was not exercised: every figure that carries it was empty or zero on both sides ${over}, so this run says nothing about it.`
    case 'pass': {
      const agreed = cols.filter((c) => c.verdict === 'agrees')
      const limit = CLASS_LIMIT[cls] ? ` ${CLASS_LIMIT[cls]}` : ''
      return (
        `${name} held: ${agreed.length} of ${cols.length} figures agreed between ${d.json} and ${d.parquet} ${over}, ` +
        `each within ${pct(Math.max(...agreed.map((c) => c.tolerance)))} — ${agreed.map((c) => c.protects).join('; ')}.` +
        (agreed.length < cols.length ? ` The other ${cols.length - agreed.length} were empty or zero on both sides.` : '') +
        limit
      )
    }
  }
}

/**
 * Compare a parity run. `rows` maps each check id to the one row each side
 * returned (null when a side returned no row at all).
 *
 * THE CONTROL GATES EVERYTHING. When the flat count disagrees, the windows did
 * not hold the same records and no class is judged — a failure there would be a
 * claim about Parquet that is really a claim about landing lag.
 */
export function compareParity(
  rows: Readonly<Record<string, { json: Row | null; parquet: Row | null } | undefined>>,
  window: ParityWindow,
  datasets: ParityDatasets,
  checks: readonly ParityCheck[] = PARITY_CHECKS,
): ParityReport {
  const results = parityColumns(checks).map((col) => compareColumn(col, rows[col.check]?.json, rows[col.check]?.parquet))
  const control = results.find((r) => r.role === 'control')
  if (!control) throw new Error('parity: no control column')
  const comparable = control.verdict === 'agrees'

  const classes = CLASS_ORDER.map((cls): ClassReport => {
    const cols = results.filter((r) => r.classes.includes(cls))
    const verdict: ClassVerdict = !comparable
      ? 'incomparable'
      : cols.some((c) => c.verdict === 'differs')
        ? 'fail'
        : cols.some((c) => c.verdict === 'agrees')
          ? 'pass'
          : 'unexercised'
    return {
      cls,
      pattern: NULL_CLASSES[cls].pattern,
      verdict,
      protects: cols.map((c) => c.protects),
      columns: cols,
      sentence: classSentence(cls, verdict, cols, control, datasets, window),
    }
  })
  const unaffected = results.filter((r) => r.role === 'unaffected')

  const failed = classes.filter((c) => c.verdict === 'fail').map((c) => c.cls)
  const unexercised = classes.filter((c) => c.verdict === 'unexercised').map((c) => c.cls)
  const verdict: ParityReport['verdict'] = !comparable ? 'incomparable' : failed.length ? 'fail' : unexercised.length ? 'partial' : 'pass'
  const between = `${datasets.json} against ${datasets.parquet} over ${windowWords(window)}`
  const sentence =
    verdict === 'incomparable'
      ? `Parity was not judged for ${between}: the control count disagreed, so the two sides did not hold the same records.`
      : verdict === 'fail'
        ? `Parity FAILED for ${between}: class ${failed.join(', ')} changed a dashboard number.`
        : verdict === 'partial'
          ? `Parity held for ${between} on ${5 - unexercised.length} of 5 classes; class ${unexercised.join(', ')} had nothing to compare in this window.`
          : `Parity held for ${between} on all 5 classes.`

  return { window, datasets, control, comparable, verdict, classes, unaffected, sentence }
}

