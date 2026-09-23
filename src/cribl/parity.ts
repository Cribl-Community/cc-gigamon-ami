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
// A figure NO class applies to (a bare count, `sum(iif(f==x,…))`, `max`) is
// still compared, and still counts: the classes say where the mechanism is
// expected to bite, not where a changed tile is allowed. A run in which the
// SERVFAIL count went to 0 is a failed run whether or not a class predicted it.
//
// ── THREE STATES THAT ARE NOT A RESULT ──────────────────────────────────────
// * NOT RUN — a side returned no row for a check. A scalar summarize answers
//   one row even over no events, so a missing row is a job that failed, was
//   cancelled or was never submitted. It is never read as "nothing in this
//   window", and never as a difference Parquet caused.
// * NOT EXERCISED — both sides answered, and the figure was empty or zero on
//   both. The window had nothing for this aggregate to be wrong about.
// * INCOMPARABLE — the control count disagreed (or did not run, or the window
//   was empty), so the two sides did not hold the same records.
//
// ── THE COUNT SLACK ─────────────────────────────────────────────────────────
// The control is allowed to disagree by up to ±1 %; that is up to 1,000 of
// 100,000 records present on one side and not the other. A rare count of 18
// then cannot be held to ±1 % (0.18 of a record): the records the control says
// are missing hit it in proportion, 18 × drift of them on average, and a count
// moves in whole records. So a count figure is allowed
//     max(tolerance × expected, ceil(expected × drift))
// where drift is the control's own relative disagreement. With drift 0 that is
// exactly the tolerance; with ANY drift it is at least one record, so a
// one-record window-edge difference is not reported as the class A failure.
// 18 → 40,280 is still thousands of records outside it. The same slack means a
// +1 distinct value (class C) cannot be seen on a run whose control drifted,
// and the class C sentence says so rather than calling that a pass.
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
// * Class C's only tile figure, `resolvers=dcount(dns_host)`, reads only
//   `app_name="dns"` rows. If every DNS row carries `dns_host`, Parquet has no
//   absent value there to turn into "", and its agreement shows nothing about
//   the mechanism. The pass sentence says so; a direct probe
//   (`dcount(f)` against `dcount(iif(f=="",null,f))` on the Parquet side) is
//   what would settle it, and it is not a query a dashboard runs.
// * That a scalar summarize over no events answers one row is KQL semantics,
//   not measured here. If Cribl answers no row, an empty window reads as NOT
//   RUN — the safe direction: neither a pass nor a failure.
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
  A: { pattern: 'isnotnull(f)', underParquet: 'is true on every row, so a rare signal counts the whole window' },
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

export type ColumnVerdict = 'agrees' | 'differs' | 'unexercised' | 'notrun'

export type Side = 'json' | 'parquet'

export interface ColumnResult extends ParityColumn {
  json: number | null
  parquet: number | null
  /** parquet ÷ json, when json is a non-zero number. */
  ratio: number | null
  /** The absolute difference this figure was allowed, when it was compared. */
  allowed: number | null
  /** The sides that returned no row for this figure's check. Empty unless `notrun`. */
  missing: Side[]
  verdict: ColumnVerdict
}

/**
 * The absolute difference a figure is allowed: its own tolerance, and — for a
 * count — at least the whole records the control's own `drift` says one side
 * holds and the other does not. See THE COUNT SLACK in the header.
 */
export function allowedDifference(col: Pick<ParityColumn, 'kind' | 'tolerance'>, expected: number, drift: number): number {
  const byTolerance = col.tolerance * Math.abs(expected)
  if (col.kind !== 'count') return byTolerance
  return Math.max(byTolerance, Math.ceil(Math.abs(expected) * drift))
}

/**
 * One column, both sides.
 *
 * A side with no row is `notrun` — the job did not answer, which says nothing
 * about the window or about Parquet. Nothing on both sides is `unexercised`,
 * never `agrees`: a figure that was zero on both sides compared nothing. For a
 * count-kind aggregate a missing value and 0 are the same statement (a `sum`
 * over rows that all lack the key is omitted from the row). For a distribution
 * they are NOT: a latency tile that read "no value" or 0 on JSON and a number
 * on Parquet (or the reverse) is class E's failure exactly.
 *
 * `drift` is the control's relative disagreement, 0 when it agreed exactly.
 */
export function compareColumn(
  col: ParityColumn,
  jsonRow: Row | null | undefined,
  parquetRow: Row | null | undefined,
  drift = 0,
): ColumnResult {
  const json = numberOf(jsonRow?.[col.column])
  const parquet = numberOf(parquetRow?.[col.column])
  const missing: Side[] = []
  if (jsonRow == null) missing.push('json')
  if (parquetRow == null) missing.push('parquet')
  const base = { ...col, json, parquet, missing, ratio: null, allowed: null }
  if (missing.length) return { ...base, verdict: 'notrun' }

  const nothing = (v: number | null) => v === null || v === 0

  if (col.kind === 'distribution') {
    if (json === null && parquet === null) return { ...base, verdict: 'unexercised' }
    if (json === null || parquet === null) return { ...base, verdict: 'differs' }
    if (json === 0) return { ...base, verdict: parquet === 0 ? 'unexercised' : 'differs' }
  } else {
    if (nothing(json) && nothing(parquet)) return { ...base, verdict: 'unexercised' }
    if (nothing(json)) return { ...base, verdict: 'differs' }
  }
  const j = json as number
  const p = parquet ?? 0
  const allowed = allowedDifference(col, j, drift)
  return { ...base, ratio: p / j, allowed, verdict: Math.abs(p - j) <= allowed ? 'agrees' : 'differs' }
}

export type ClassVerdict = 'pass' | 'fail' | 'unexercised' | 'notrun' | 'incomparable'

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
  /** The control's relative disagreement, 0 when it is not comparable. */
  drift: number
  comparable: boolean
  /**
   * `fail`: a class failed, or a figure outside the five classes changed.
   * `incomplete`: nothing failed, but a check returned no row on some side.
   * `partial`: every check ran, and some class had nothing to compare.
   */
  verdict: 'pass' | 'fail' | 'incomplete' | 'partial' | 'incomparable'
  classes: ClassReport[]
  /** Columns no class applies to — compared, and counted in the verdict. */
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
  const allowed = r.allowed === null ? '' : `, allowed ±${fmtValue(r.allowed)}`
  return `${r.protects}: ${fmtValue(r.json)} on ${d.json}, ${fmtValue(r.parquet)} on ${d.parquet} (${move}${allowed})`
}

/** "gigamon_ami_pq" / "either dataset", for the sides a not-run figure lacked. */
function missingSides(cols: ColumnResult[], d: ParityDatasets): string {
  const s = new Set(cols.flatMap((c) => c.missing))
  return s.size === 2 ? `either ${d.json} or ${d.parquet}` : s.has('json') ? d.json : d.parquet
}

function checksOf(cols: ColumnResult[]): string {
  return [...new Set(cols.map((c) => c.check))].join(', ')
}

/**
 * The smallest difference a class's failure mode produces, where that is a
 * fixed size. Class C's is one distinct value, the "": an agreeing figure that
 * was allowed ±1 or more could not have shown it, so it does not count as
 * evidence the class held.
 */
const CLASS_DETECTS: Partial<Record<NullClass, number>> = { C: 1 }

function sees(cls: NullClass, c: ColumnResult): boolean {
  const detect = CLASS_DETECTS[cls]
  return c.verdict === 'agrees' && (detect === undefined || (c.allowed ?? Infinity) < detect)
}

/** A limit on what a class's pass can mean, whatever the run's figures. */
const CLASS_LIMIT: Partial<Record<NullClass, string>> = {
  C:
    `A difference of one distinct value is outside ${pct(TOLERANCE.count)} only while the count is under 100, and not at all ` +
    `when the control itself drifted. The "Distinct resolvers" figure reads only app_name="dns" rows: if every one of them ` +
    `carries dns_host, Parquet has no empty value to add there and its agreement shows nothing about this class.`,
}

function classSentence(cls: NullClass, verdict: ClassVerdict, cols: ColumnResult[], control: ColumnResult, d: ParityDatasets, w: ParityWindow, drift: number): string {
  const name = `Class ${cls} (${NULL_CLASSES[cls].pattern})`
  const over = `over ${windowWords(w)}`
  const limit = CLASS_LIMIT[cls] ? ` ${CLASS_LIMIT[cls]}` : ''
  switch (verdict) {
    case 'incomparable':
      return `${name} was not judged: ${controlWords(control, d)} ${over}.`
    case 'fail': {
      const bad = cols.filter((c) => c.verdict === 'differs')
      const widened = drift > 0 ? `, each count widened by the control's own drift of ${pct(drift).slice(1)}` : ''
      return (
        `${name} FAILED on ${bad.length} of ${cols.length} figures ${over}, outside the difference each was allowed${widened}: ` +
        bad.map((c) => sides(c, d)).join('; ') +
        `. Under Parquet this aggregate ${NULL_CLASSES[cls].underParquet}.`
      )
    }
    case 'notrun': {
      const gone = cols.filter((c) => c.verdict === 'notrun')
      return (
        `${name} was not judged: ${gone.length} of ${cols.length} figures got no result from ${missingSides(gone, d)} ` +
        `(check ${checksOf(gone)}) ${over}. The job failed, was stopped or was never submitted — this is not a statement about the window.`
      )
    }
    case 'unexercised': {
      const blind = cols.filter((c) => c.verdict === 'agrees')
      const empty = cols.length - blind.length
      return blind.length
        ? `${name} was not exercised ${over}: ${blind.length} of ${cols.length} figures agreed, but each was allowed a difference ` +
            `the failure could hide inside (${blind.map((c) => sides(c, d)).join('; ')})` +
            (empty ? `, and the other ${empty} were empty or zero on both sides.` : '.') +
            limit
        : `${name} was not exercised: every figure that carries it was empty or zero on both sides ${over}, so this run says nothing about it.`
    }
    case 'pass': {
      const seen = cols.filter((c) => sees(cls, c))
      const blind = cols.filter((c) => c.verdict === 'agrees' && !sees(cls, c))
      const empty = cols.length - seen.length - blind.length
      return (
        `${name} held: ${seen.length} of ${cols.length} figures agreed between ${d.json} and ${d.parquet} ${over}, ` +
        `each within the difference it was allowed — ${seen.map((c) => c.protects).join('; ')}.` +
        (blind.length ? ` ${blind.length} more agreed only inside a slack this class's failure fits in: ${blind.map((c) => c.protects).join('; ')}.` : '') +
        (empty ? ` The other ${empty} were empty or zero on both sides.` : '') +
        limit
      )
    }
  }
}

function controlWords(control: ColumnResult, d: ParityDatasets): string {
  switch (control.verdict) {
    case 'notrun':
      return `the control count got no result from ${missingSides([control], d)}, so nothing says the two sides held the same records`
    case 'unexercised':
      return `the control count was empty on both sides, so the window held no records to compare`
    default:
      return `the control disagreed (${sides(control, d)}), so the two datasets did not hold the same records`
  }
}

function classVerdict(cls: NullClass, cols: ColumnResult[], comparable: boolean): ClassVerdict {
  if (!comparable) return 'incomparable'
  if (cols.some((c) => c.verdict === 'differs')) return 'fail'
  if (cols.some((c) => c.verdict === 'notrun')) return 'notrun'
  if (cols.some((c) => sees(cls, c))) return 'pass'
  return 'unexercised'
}

/**
 * Compare a parity run. `rows` maps each check id to the one row each side
 * returned: null (or the whole entry absent) when a side returned no row.
 *
 * THE CONTROL GATES EVERYTHING. When the flat count disagrees, the windows did
 * not hold the same records and no class is judged — a failure there would be a
 * claim about Parquet that is really a claim about landing lag. When it agrees
 * within its tolerance, its own drift widens every count (THE COUNT SLACK).
 */
export function compareParity(
  rows: Readonly<Record<string, { json: Row | null; parquet: Row | null } | undefined>>,
  window: ParityWindow,
  datasets: ParityDatasets,
  checks: readonly ParityCheck[] = PARITY_CHECKS,
): ParityReport {
  const columns = parityColumns(checks)
  const controlCol = columns.find((c) => c.role === 'control')
  if (!controlCol) throw new Error('parity: no control column')
  const control = compareColumn(controlCol, rows[controlCol.check]?.json, rows[controlCol.check]?.parquet)
  const comparable = control.verdict === 'agrees'
  const drift = comparable ? Math.abs((control.parquet ?? 0) - (control.json as number)) / Math.abs(control.json as number) : 0

  const results = columns.map((col) => (col === controlCol ? control : compareColumn(col, rows[col.check]?.json, rows[col.check]?.parquet, drift)))

  const classes = CLASS_ORDER.map((cls): ClassReport => {
    const cols = results.filter((r) => r.classes.includes(cls))
    const verdict = classVerdict(cls, cols, comparable)
    return {
      cls,
      pattern: NULL_CLASSES[cls].pattern,
      verdict,
      protects: cols.map((c) => c.protects),
      columns: cols,
      sentence: classSentence(cls, verdict, cols, control, datasets, window, drift),
    }
  })
  const unaffected = results.filter((r) => r.role === 'unaffected')
  const outsideChanged = unaffected.filter((r) => r.verdict === 'differs')
  const notRun = results.filter((r) => r.verdict === 'notrun')

  const failed = classes.filter((c) => c.verdict === 'fail').map((c) => c.cls)
  const unexercised = classes.filter((c) => c.verdict === 'unexercised').map((c) => c.cls)
  const verdict: ParityReport['verdict'] = !comparable
    ? 'incomparable'
    : failed.length || outsideChanged.length
      ? 'fail'
      : notRun.length
        ? 'incomplete'
        : unexercised.length
          ? 'partial'
          : 'pass'

  const between = `${datasets.json} against ${datasets.parquet} over ${windowWords(window)}`
  const notRunWords = notRun.length
    ? `${notRun.length} figure${notRun.length === 1 ? '' : 's'} got no result from ${missingSides(notRun, datasets)} (check ${checksOf(notRun)})`
    : ''
  let sentence: string
  switch (verdict) {
    case 'incomparable':
      sentence = `Parity was not judged for ${between}: ${controlWords(control, datasets)}.`
      break
    case 'fail': {
      const why = [
        failed.length ? `class ${failed.join(', ')} changed a dashboard number` : '',
        outsideChanged.length
          ? `${outsideChanged.length} figure${outsideChanged.length === 1 ? '' : 's'} outside the five null classes changed — ` +
            outsideChanged.map((c) => sides(c, datasets)).join('; ')
          : '',
      ].filter(Boolean)
      sentence = `Parity FAILED for ${between}: ${why.join('; and ')}.` + (notRunWords ? ` Also, ${notRunWords}.` : '')
      break
    }
    case 'incomplete': {
      const notJudged = classes.filter((c) => c.verdict === 'notrun').map((c) => c.cls)
      sentence =
        `Parity is incomplete for ${between}: nothing compared failed, but ${notRunWords}, ` +
        (notJudged.length ? `so class ${notJudged.join(', ')} was not judged.` : 'so figures outside the five classes were not judged.')
      break
    }
    case 'partial':
      sentence = `Parity held for ${between} on ${5 - unexercised.length} of 5 classes; class ${unexercised.join(', ')} was not exercised — nothing in this window could have shown its failure.`
      break
    default:
      sentence = `Parity held for ${between} on all 5 classes, and on every figure outside them.`
  }

  return { window, datasets, control, drift, comparable, verdict, classes, unaffected, sentence }
}
