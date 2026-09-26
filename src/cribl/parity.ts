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
// Parquet reads an ABSENT field back as `""` (string) or `0` (numeric)
// (measured 2026-09-21; proof (g), 2026-09-24, found the same with an explicit
// `parquetSchema`, so no schema mode avoids it). Five kinds of aggregate change
// meaning under that:
//
//   A  isnotnull(f)             measured: Q29 c_T1572 18 → 43,338
//   B  count(f)                 measured: Q32 f2      18 → 43,338
//   C  dcount(f)                JSON side measured; Parquet side NOT measured
//   D  f=* presence filter      measured once: ≈2× the JSON value
//   E  percentile/avg/min(f)    NOT measured on Parquet — dragged toward 0
//
// (Corrected 2026-09-25, Phase 8 design revision 2 §0.6. This table said C, D
// and E were all "NOT measured".)
//
//   C  On JSON, `dcount(f)` over a sparse field ALREADY counts the null bucket
//      as one value (F-19: `dcount(http_code)` 7 against 6 non-null; F-23).
//      Parquet's fill is one extra value too, so the two are expected to AGREE
//      as written — C is parity-neutral [inferred], except where a real `""`/`0`
//      coexists with a fill, or a column's type drifted. The Parquet side has
//      never been read. The check below still classifies `dcount` as C and
//      still expects +1 (`NULL_CLASSES.C`, `CLASS_DETECTS`); that changes with
//      the first real Parquet parity run (design §4 8.0e), not in a comment.
//      Since 2026-09-25 no comparison here can see that +1 anyway: see THE
//      DISTINCT-COUNT SLACK.
//      The JSON +1 itself is a separate, existing correctness question (design
//      §6), not a Parquet one.
//   D  `b=*` read ≈2× the JSON value for one STRING field in the lab (proof
//      (g), 2026-09-24). A numeric `0` fill is still unmeasured.
//   E  All four E fields this app reads (`tcp_rtt`, `tcp_rtt_app`,
//      `dns_response_time`, `http_server_ms`) are numeric, so the fill is `0`.
//      Still unmeasured on Parquet; on the demo feed's density,
//      `percentile(http_server_ms,95)` over all rows is inferred to read
//      exactly 0.
//
// ── WHY THIS WILL RUN (owner, 2026-09-25) ───────────────────────────────────
// Phase 8's Q1 — "what would make reading gigamon_ami_pq worth doing?" — was
// answered (a), Live-mode latency: "the live queries will make it worth
// landing the data in pq format." So the read side is to be built (§4 8.1),
// and a query moves to Parquet only on a recorded run of THIS check that
// agreed for it. Nothing reads gigamon_ami_pq until such a run exists; the
// answer decides that the work is done, not that any query is equal there.
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
//     max(tolerance × expected, ceil(expected × drift), drift > 0 ? 1 : 0)
// where drift is the control's own relative disagreement. With drift 0 that is
// exactly the tolerance, and a count of 0 on JSON is allowed nothing; with ANY
// drift it is at least one record — including on a count of 0, since the one
// record the window edge added may be the first T1572 flow in it — so a
// one-record window-edge difference is not reported as the class A failure.
// 0 or 18 → 40,280 is still thousands of records outside it. The same slack
// hides a +1 distinct value on a run whose control drifted. That is the +1 the
// check still EXPECTS for class C (`NULL_CLASSES.C`) — not the effect Parquet
// is expected to have, which the table above now infers is none (JSON already
// counts the null bucket) — and the class C sentence says it could not be seen
// rather than calling that a pass.
//
// ── THE DISTINCT-COUNT SLACK (owner decision 2026-09-25) ────────────────────
// A figure computed by `dcount()`, `dcountif()` or `count_distinct()` may differ
// between JSON and Parquet by ONE distinct value, in either direction, and
// still agree: it is allowed max(the count rule above, `DCOUNT_SLACK`). The
// reason is the owner's decision itself — that a ±1 on a distinct count says
// nothing a dashboard reader could act on — and it rests on no measurement
// here. The owner reports JSON reading one higher than Parquet on the same
// data; no report in this repo records that. The 2026-09-23 measurement found
// `dcount` exact at a few hundred distinct values and ≈ ±0.5 % only at ~10k
// (LIMITS below), so on the small counts where this slack is the only thing
// allowing a difference (under about 100, with no drift) it does NOT say the
// estimate is off by one. A difference of 2 on a figure the count rule
// allows less than 2 still fails. Only the distinct-count figure itself gets
// this: every other figure keeps `TOLERANCE` and THE COUNT SLACK exactly, a
// `count()` one record off on a small count still fails, and in a top N a
// key's PLACE — ranked by a distinct count or not — is judged as before; the
// slack reaches only the comparison of the figure (`compareGrouped` rule 4).
// `isDistinctCount` decides which figures, from the aggregate's own text.
//
// What it costs: class C's failure mode is exactly one extra distinct value
// (`CLASS_DETECTS`), so a ±1 slack hides it on every figure, at any size and
// any drift. Class C in `compareParity` is therefore never `pass` — at best
// `unexercised`, with the figures named as agreeing inside a slack the failure
// fits in — and a run with nothing else wrong is `partial`. That is the
// decision's price, said rather than hidden: a +1 from Parquet's "" and a +1
// from the estimate cannot be told apart in one figure. A difference of 2 or
// more on a small distinct count still fails class C.
//
// ── THE EXTREMES UNDER DRIFT ────────────────────────────────────────────────
// A min or a max is set by ONE record, so the records the control says one
// side lacks can move it any distance: ±5 % means nothing to a single row at the
// window edge. Parquet's failure for an extreme has one shape — the value reads
// 0, or no value. So on a run whose control drifted, a min or max that moved
// while the Parquet side still held a non-zero value is `edge`: neither an
// agreement nor the Parquet failure, and counted as evidence for no class (like
// "not exercised"). One that went to 0 or to no value is still `differs`. With
// drift 0 the two sides hold the same records and any move is Parquet's.
//
// Nor does a failure sentence claim the mechanism unless the figure moved the
// way the mechanism moves it (up for A–D, toward 0 for E): a changed number
// that moved the other way is still a failure, and is said to be one without
// being blamed on null semantics.
//
// ── WHAT THIS CANNOT ESTABLISH ──────────────────────────────────────────────
// * The tolerances are chosen, not measured. The only measured agreement is the
//   bare count, within 0.2 % over "comparable" six-minute windows of two
//   datasets fed by one generator. ±1 % and ±5 % are judgement.
// * The +1 the check expects for class C (kept in code until the first real
//   Parquet run; the table above infers C is parity-neutral) is invisible on
//   every figure: a distinct count is always allowed one distinct value (THE
//   DISTINCT-COUNT SLACK), and the class sentence says so rather than implying
//   otherwise. *(Corrected 2026-09-25, `feat/parity-dcount-tolerance`: this
//   said it was outside ±1 % while the distinct count was under 100.)*
// * `dcount()` is approximate (≈ ±0.5 % at ~10k distinct values, exact at a few
//   hundred — measured 2026-09-23), which is part of why C is not compared
//   exactly. See THE DISTINCT-COUNT SLACK above.
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
//   that the next parity run MEASURES those three classes on Parquet (D's one
//   lab reading and C's JSON side came from separate probes, not this check).

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
 * The absolute difference a distinct-count figure is always allowed (owner
 * decision 2026-09-25) — see THE DISTINCT-COUNT SLACK.
 */
export const DCOUNT_SLACK = 1

// The same names `parityRun.ts`'s COUNT_RE accepts as a count, so the two lists agree.
const DISTINCT_COUNT_RE = /^(dcount|dcountif|count_distinct)\s*\(/

/**
 * Whether an aggregate's figure is a distinct count, and so gets `DCOUNT_SLACK`.
 * Anchored, like `classify`: a distinct count wrapped in another call
 * (`round(dcount(x)/2)`) is some other figure, and keeps the ordinary rule.
 */
export function isDistinctCount(expr: string): boolean {
  return DISTINCT_COUNT_RE.test(expr.trim())
}

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
  /** A distinct count (`isDistinctCount`): allowed at least `DCOUNT_SLACK`. */
  distinct: boolean
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
        distinct: isDistinctCount(expr),
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

/**
 * `edge`: a min or max that moved on a run whose control drifted, with the
 * Parquet side still non-zero — see THE EXTREMES UNDER DRIFT. Not a failure,
 * and not evidence for any class.
 */
export type ColumnVerdict = 'agrees' | 'differs' | 'edge' | 'unexercised' | 'notrun'

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
 * holds and the other does not. See THE COUNT SLACK in the header. A distinct
 * count (`distinct`) is allowed at least `DCOUNT_SLACK` on top of that rule,
 * never less than it: see THE DISTINCT-COUNT SLACK.
 */
export function allowedDifference(
  col: Pick<ParityColumn, 'kind' | 'tolerance'> & { distinct?: boolean },
  expected: number,
  drift: number,
): number {
  const byTolerance = col.tolerance * Math.abs(expected)
  if (col.kind !== 'count') return byTolerance
  const byCount = Math.max(byTolerance, Math.ceil(Math.abs(expected) * drift), drift > 0 ? 1 : 0)
  return col.distinct ? Math.max(byCount, DCOUNT_SLACK) : byCount
}

const EXTREME_RE = /^(min|max)\(/

/**
 * One column, both sides.
 *
 * A side with no row is `notrun` — the job did not answer, which says nothing
 * about the window or about Parquet. Nothing on both sides is `unexercised`,
 * never `agrees`: a figure that was zero on both sides compared nothing. For a
 * count-kind aggregate a missing value and 0 are the same statement (a `sum`
 * over rows that all lack the key is omitted from the row). For a distribution
 * they are NOT: a latency tile that read "no value" or 0 on JSON and a number
 * on Parquet (or the reverse) is class E's failure exactly — except for a min
 * or max on a drifted run whose Parquet side is still non-zero, which is `edge`.
 *
 * A count of 0 on JSON is compared like any other, against the one-record
 * allowance drift gives it (THE COUNT SLACK): 0 → 1 on a drifted run agrees,
 * 0 → 2 does not, and with drift 0 nothing is allowed.
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
  // A moved extreme that Parquet's failure cannot have produced: see THE
  // EXTREMES UNDER DRIFT. Never on a run whose control agreed exactly.
  const moved: ColumnVerdict = drift > 0 && EXTREME_RE.test(col.expr) && !nothing(parquet) ? 'edge' : 'differs'

  if (col.kind === 'distribution') {
    if (json === null && parquet === null) return { ...base, verdict: 'unexercised' }
    if (json === null || parquet === null) return { ...base, verdict: moved }
    if (json === 0) return { ...base, verdict: parquet === 0 ? 'unexercised' : moved }
  } else {
    if (nothing(json) && nothing(parquet)) return { ...base, verdict: 'unexercised' }
  }
  const j = json ?? 0
  const p = parquet ?? 0
  const allowed = allowedDifference(col, j, drift)
  return { ...base, ratio: j === 0 ? null : p / j, allowed, verdict: Math.abs(p - j) <= allowed ? 'agrees' : moved }
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
   * An `edge` figure (THE EXTREMES UNDER DRIFT) fails nothing, and is named.
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
    `A difference of one distinct value is always allowed (a decision, not a measurement), so this check cannot ` +
    `see the one extra value it looks for; a difference of two or more on a small count still fails. The "Distinct resolvers" figure reads only app_name="dns" rows: if every one of them ` +
    `carries dns_host, Parquet has no empty value to add there and its agreement shows nothing about this class.`,
}

/**
 * Whether a differing figure moved the way Parquet's null semantics moves it:
 * up for A–D (every row counts, or "" is one more value), toward 0 or to
 * nothing for E. Only then may a sentence name the mechanism.
 */
function mechanismShaped(cls: NullClass, c: ColumnResult): boolean {
  if (cls === 'E') return c.parquet === null || Math.abs(c.parquet) < Math.abs(c.json ?? Infinity)
  return (c.parquet ?? 0) > (c.json ?? 0)
}

function mechanismWords(cls: NullClass, bad: ColumnResult[]): string {
  const how = `this aggregate ${NULL_CLASSES[cls].underParquet}`
  const shaped = bad.filter((c) => mechanismShaped(cls, c)).length
  if (shaped === bad.length) return ` Under Parquet ${how}.`
  const other = bad.length - shaped
  return shaped
    ? ` ${shaped} of these moved the way Parquet's null semantics predicts (${how}); the other ${other} did not, so for ${other === 1 ? 'that one' : 'those'} this run shows a changed number, not that mechanism.`
    : ` ${bad.length === 1 ? 'It did' : 'None of them did'} not move the way Parquet's null semantics predicts (${how}), so this run shows a changed number, not that mechanism.`
}

/** Why an `edge` figure is counted neither way. */
function edgeWhy(drift: number): string {
  return (
    `the control drifted ${pct(drift).slice(1)}, and one record at the window edge can move a min or max that far; ` +
    `Parquet's failure would have read 0 or no value, so this is evidence neither of that failure nor of its absence`
  )
}

/** The `edge` figures among `cols`, as a trailing sentence, or ''. */
function edgeClause(cols: ColumnResult[], d: ParityDatasets, drift: number, lead: string): string {
  const edge = cols.filter((c) => c.verdict === 'edge')
  if (!edge.length) return ''
  const n = edge.length === 1 ? `1 ${lead}min or max figure` : `${edge.length} ${lead}min or max figures`
  return (
    ` ${n} moved beyond ${pct(TOLERANCE.distribution)} with a non-zero value still on ${d.parquet}, and ${edge.length === 1 ? 'was' : 'were'} ` +
    `counted neither way: ${edgeWhy(drift)} — ${edge.map((c) => sides(c, d)).join('; ')}.`
  )
}

function classSentence(cls: NullClass, verdict: ClassVerdict, cols: ColumnResult[], control: ColumnResult, d: ParityDatasets, w: ParityWindow, drift: number): string {
  const name = `Class ${cls} (${NULL_CLASSES[cls].pattern})`
  const over = `over ${windowWords(w)}`
  const limit = CLASS_LIMIT[cls] ? ` ${CLASS_LIMIT[cls]}` : ''
  const edge = cols.filter((c) => c.verdict === 'edge')
  const edgeNote = edgeClause(cols, d, drift, '')
  switch (verdict) {
    case 'incomparable':
      return `${name} was not judged: ${controlWords(control, d)} ${over}.`
    case 'fail': {
      const bad = cols.filter((c) => c.verdict === 'differs')
      const widened = drift > 0 && bad.some((c) => c.kind === 'count') ? `, each count widened by the control's own drift of ${pct(drift).slice(1)}` : ''
      return (
        `${name} FAILED on ${bad.length} of ${cols.length} figures ${over}, outside the difference each was allowed${widened}: ` +
        bad.map((c) => sides(c, d)).join('; ') +
        '.' +
        mechanismWords(cls, bad) +
        edgeNote
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
      const empty = cols.length - blind.length - edge.length
      if (!blind.length && !edge.length) {
        return `${name} was not exercised: every figure that carries it was empty or zero on both sides ${over}, so this run says nothing about it.`
      }
      const bits = [
        blind.length
          ? `${blind.length} of ${cols.length} figures agreed, but each was allowed a difference the failure could hide inside ` +
            `(${blind.map((c) => sides(c, d)).join('; ')})`
          : '',
        edge.length ? `${edge.length} of ${cols.length} ${edge.length === 1 ? 'was a min or max that' : 'were a min or max that'} moved within window-edge noise` : '',
        empty ? `${empty} of ${cols.length} ${empty === 1 ? 'was' : 'were'} empty or zero on both sides` : '',
      ].filter(Boolean)
      return `${name} was not exercised ${over}: ${bits.join('; ')}.` + edgeNote + limit
    }
    case 'pass': {
      const seen = cols.filter((c) => sees(cls, c))
      const blind = cols.filter((c) => c.verdict === 'agrees' && !sees(cls, c))
      const empty = cols.length - seen.length - blind.length - edge.length
      return (
        `${name} held: ${seen.length} of ${cols.length} figures agreed between ${d.json} and ${d.parquet} ${over}, ` +
        `each within the difference it was allowed — ${seen.map((c) => c.protects).join('; ')}.` +
        (blind.length ? ` ${blind.length} more agreed only inside a slack this class's failure fits in: ${blind.map((c) => c.protects).join('; ')}.` : '') +
        edgeNote +
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
  // Classed `edge` figures are in their class's sentence; these are the rest.
  const outsideEdge = edgeClause(unaffected, datasets, drift, 'unclassed ')
  const notExercised = unexercised.length ? ` Class ${unexercised.join(', ')} was also not exercised — nothing in this window could have shown its failure.` : ''
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
      sentence = `Parity FAILED for ${between}: ${why.join('; and ')}.` + (notRunWords ? ` Also, ${notRunWords}.` : '') + outsideEdge
      break
    }
    case 'incomplete': {
      const notJudged = classes.filter((c) => c.verdict === 'notrun').map((c) => c.cls)
      sentence =
        `Parity is incomplete for ${between}: nothing compared failed, but ${notRunWords}, ` +
        (notJudged.length ? `so class ${notJudged.join(', ')} was not judged.` : 'so figures outside the five classes were not judged.') +
        notExercised +
        outsideEdge
      break
    }
    case 'partial':
      sentence =
        `Parity held for ${between} on ${5 - unexercised.length} of 5 classes; class ${unexercised.join(', ')} was not exercised — nothing in this window could have shown its failure.` +
        outsideEdge
      break
    default:
      sentence = outsideEdge
        ? `Parity held for ${between} on all 5 classes, and on every other figure outside them.` + outsideEdge
        : `Parity held for ${between} on all 5 classes, and on every figure outside them.`
  }

  return { window, datasets, control, drift, comparable, verdict, classes, unaffected, sentence }
}

// ── Reading a whole query: grouped, piped, and classes F and T ──────────────
//
// `classify` reads ONE aggregate under one head, which is all a scalar parity
// check needs, and it anchors every pattern at the start of the expression. The
// Phase 8 router (cribl/routing/*) needs the same judgement about any dashboard
// query: grouped, with `extend`/`where` stages, a `by` clause, a sort, and an
// aggregate that may sit inside another call. `classifyQuery` walks such a query
// and finds A, B, C and E ANYWHERE in an expression — `round(avg(x), 1)` and
// `toint(percentile(x, 95))` are class E exactly as `avg(x)` is — with a
// superset of `classify`'s patterns (the `…if` forms, `percentiles`, `median`,
// `stdev`, `variance`, `isnull`); parityQuery.test.ts holds it to never reading
// fewer classes than `classify` on any parity column. It adds:
//
//   F  a grouping on a raw field: `by f`, `by tolower(f)`, `by k` where an
//      `extend` made `k` from `f`, and `| distinct f`. JSON emits ONE group with
//      the key omitted where rows lack `f` (measured 2026-09-23); Parquet emits
//      a group keyed "" or 0. Harmless only on a key present on every row.
//   T  any read of a field whose type differs between Parquet files. A file
//      holding a string makes that column STRING (measured 2026-09-24), and
//      `dcount` then splits 10 from "10". Known only from a type table.
//
// LINEAGE. Every column the query makes (`extend`, and `summarize`'s own
// aggregates and keys) remembers the raw fields it was made from, so a class on
// a made column lands on the raw field behind it: `extend r=x*1000 | summarize
// avg(r)` is E on `x`, and `summarize m=max(x) by … | summarize avg(m)` is E on
// `x` too (conservative: a made column carries every raw field its expression
// read, whatever the function did to them).
//
// C is reported and is NEUTRAL (Phase 8 design §2.3): JSON already counts the
// absent value as one distinct value on a sparse field (F-19), and Parquet's
// fill is one distinct value too. The router does not refuse on it.
//
// The normalised key `iif(isnotnull(x), x, "")` (APP_L4) is recognised — made by
// `extend` or named in the `by` clause — and is neither A nor F: it reads "" for
// an absent `x` on both datasets. A column made from it carries no raw field.
//
// WHAT THIS CANNOT SEE. It reads the text, not the semantics: a column made in
// a way it does not recognise (`parse`, `mv-expand`, a `project` rename) is read
// as a raw field, never skipped, and a stage it does not recognise still has
// every raw field it names read (so the type table refuses an unknown one).
// Every error it makes is meant to be towards "not eligible" — the direction
// that keeps a query on JSON. *(Corrected 2026-09-25, review of
// `feat/phase8-1-router`: this promise was false for a wrapped aggregate and a
// derived group key, both read as class-free.)*

/** The null classes plus the two that only a whole query shows. */
export type QueryClass = NullClass | 'F' | 'T'

/** What the type census (Phase 8 §8.0b) says a field holds. `mixed`: some Parquet files hold a string. */
export type FieldType = 'string' | 'number' | 'mixed'

export interface ClassHit {
  cls: QueryClass
  field: string
}

export interface QueryReading {
  /** Every class hit, in the order the query meets them. C is included, and is neutral. */
  hits: ClassHit[]
  /** Every raw field the query reads — its head, every expression and every key. */
  fields: string[]
}

/** Split on `sep` where it is outside parentheses and quotes. */
function splitOutside(s: string, sep: string): string[] {
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
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i))
      start = i + sep.length
      i += sep.length - 1
    }
  }
  out.push(s.slice(start))
  return out.map((x) => x.trim())
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'by', 'asc', 'desc', 'true', 'false', 'null'])
const NORMALISED_RE = /^iif\(\s*isnotnull\(\s*([\w.]+)\s*\)\s*,\s*\1\s*,\s*""\s*\)$/

/**
 * The calls that make a class wherever they sit in an expression. A superset of
 * `classify`'s anchored patterns: an aggregate wrapped in `round`, `toint` or any
 * other call is still the aggregate. E is every aggregate a filled 0 pulls
 * toward 0 or moves (a mean, a minimum, a quantile, a spread); `max` is not in
 * it, as in `classify`.
 */
const CALL_CLASSES: Readonly<Record<string, NullClass>> = Object.freeze({
  isnotnull: 'A',
  isnull: 'A',
  count: 'B',
  dcount: 'C',
  count_distinct: 'C',
  dcountif: 'C',
  avg: 'E',
  avgif: 'E',
  min: 'E',
  minif: 'E',
  percentile: 'E',
  percentiles: 'E',
  percentileif: 'E',
  percentilesif: 'E',
  median: 'E',
  stdev: 'E',
  stdevif: 'E',
  stdevp: 'E',
  variance: 'E',
  varianceif: 'E',
  variancep: 'E',
})

/** Every `name(args)` call in an expression, outside quotes, nested ones included, with its argument text. */
function callsIn(expr: string): { name: string; args: string }[] {
  const bare = expr.replace(/"[^"]*"|'[^']*'/g, '""')
  const out: { name: string; args: string }[] = []
  for (const m of bare.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\(/g)) {
    const open = m.index + m[0].length
    let depth = 1
    let i = open
    for (; i < bare.length && depth > 0; i++) {
      if (bare[i] === '(') depth++
      else if (bare[i] === ')') depth--
    }
    out.push({ name: m[1].toLowerCase(), args: bare.slice(open, depth === 0 ? i - 1 : i) })
  }
  return out
}

/** Every identifier an expression reads: not a function name, keyword, literal or `_time`. */
function identifiersOf(expr: string): string[] {
  const bare = expr.replace(/"[^"]*"|'[^']*'/g, '""')
  const out: string[] = []
  for (const m of bare.matchAll(/(?<![\w.])[A-Za-z_][\w.]*/g)) {
    const name = m[0]
    if (bare.slice(m.index + name.length).trimStart().startsWith('(')) continue
    if (KEYWORDS.has(name.toLowerCase()) || name === '_time') continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** `name=expr` → [name, expr]; a bare `expr` has no name. `==` is a comparison, not a name. */
function named(part: string): [string | null, string] {
  const m = /^([A-Za-z_][\w.]*)\s*=(?!=)\s*/.exec(part)
  return m ? [m[1], part.slice(m[0].length).trim()] : [null, part.trim()]
}

/**
 * Every class a query's text carries, and every raw field it reads.
 *
 * `types` is the type table; a field typed `mixed` there is class T. A field
 * with NO type is not class T — "unknown" is its own reason, and the router
 * refuses on it (cribl/routing/eligibility.ts).
 */
export function classifyQuery(query: string, types: Readonly<Record<string, FieldType>> = {}): QueryReading {
  const stages = splitOutside(query.replace(/^dataset="[^"]*"/, ''), '|')
  const head = stages.shift() ?? ''
  const hits: ClassHit[] = []
  const fields: string[] = []
  /** Each column the query made → the raw fields it was made from ([] for a normalised key). */
  const lineage = new Map<string, string[]>()
  const hit = (cls: QueryClass, field: string) => {
    if (!hits.some((h) => h.cls === cls && h.field === field)) hits.push({ cls, field })
  }
  /** The raw fields behind an expression, through every column the query made. */
  const rawOf = (expr: string): string[] => {
    const out: string[] = []
    for (const id of identifiersOf(expr)) {
      for (const f of lineage.get(id) ?? [id]) if (!out.includes(f)) out.push(f)
    }
    return out
  }
  const read = (expr: string) => {
    for (const f of rawOf(expr)) if (!fields.includes(f)) fields.push(f)
  }
  /** Classes A, B, C and E of one expression, wherever the call sits, attributed to the raw fields it reads. */
  const classes = (expr: string) => {
    for (const { name, args } of callsIn(expr)) {
      const cls = CALL_CLASSES[name]
      if (!cls) continue
      // `count()` reads no field and is the one count that is not class B.
      for (const f of rawOf(args)) hit(cls, f)
    }
  }
  /** A column made from `expr`: normalised → no raw field; otherwise every raw field it reads. */
  const make = (name: string, expr: string) => {
    const norm = NORMALISED_RE.exec(expr)
    lineage.set(name, norm ? [] : rawOf(expr))
  }
  const groupOn = (expr: string) => {
    if (NORMALISED_RE.test(expr)) return
    for (const f of rawOf(expr)) hit('F', f)
  }

  for (const m of head.matchAll(/(?:^|\s)([\w.]+)=\*(?=\s|$)/g)) hit('D', m[1])
  read(head.replace(/=\*/g, ''))

  for (const stage of stages) {
    const verb = /^([\w-]+)/.exec(stage)?.[1] ?? ''
    const body = stage.slice(verb.length).trim()
    if (verb === 'extend') {
      for (const part of splitTopLevel(body)) {
        const [name, expr] = named(part)
        const norm = NORMALISED_RE.exec(expr)
        if (norm) read(norm[1])
        else {
          classes(expr)
          read(expr)
        }
        if (name) make(name, expr)
      }
    } else if (verb === 'where') {
      classes(body)
      read(body)
    } else if (verb === 'summarize') {
      const [aggs, keys = ''] = splitOutside(body, ' by ')
      const made: [string, string][] = []
      for (const part of splitTopLevel(aggs)) {
        const [name, expr] = named(part)
        classes(expr)
        read(expr)
        if (name) made.push([name, expr])
      }
      for (const key of splitTopLevel(keys)) {
        const [name, expr] = named(key)
        groupOn(expr)
        const norm = NORMALISED_RE.exec(expr)
        read(norm ? norm[1] : expr)
        made.push([name ?? expr, expr])
      }
      // After a summarize only its own columns exist; each carries its lineage.
      const next = made.map(([n, e]) => [n, NORMALISED_RE.test(e) ? [] : rawOf(e)] as const)
      for (const [n, raw] of next) lineage.set(n, [...raw])
    } else if (verb === 'distinct') {
      for (const part of splitTopLevel(body)) {
        const [name, expr] = named(part)
        groupOn(expr)
        read(expr)
        if (name) make(name, expr)
        else if (/^[A-Za-z_][\w.]*$/.test(expr) && !lineage.has(expr)) lineage.set(expr, [expr])
      }
    } else {
      // sort, limit, top, project and the rest. A column the query made reads
      // as its lineage; a name it did not make reads as a raw field, so the
      // type table refuses what this cannot place.
      classes(body)
      read(body)
    }
  }
  for (const f of fields) if (types[f] === 'mixed') hit('T', f)
  return { hits, fields }
}

// ── Grouped parity ──────────────────────────────────────────────────────────
//
// `compareParity` compares one scalar row per side. A grouped panel (a top-N
// list, a heatmap) answers many rows, and "whichever group came first" is not
// a comparison. The rule (Phase 8 design §4, 8.1):
//
//   1. Take the top-N keys on each side, by the panel's own rank column, and
//      note every key tied with the N-th across the cut, on that side.
//   2. A key in one side's top N and not the other's fails — that is exactly
//      class F (a "" group taking slot 1) and class D (a filter admitting rows
//      the other side never had) — UNLESS a tie explains it: the key is tied at
//      the cut on either side, so which of the tied rows made the cut is not
//      reproducible (measured 2026-09-23). A tie excuses ONLY that: a key's
//      place in the top N.
//   3. A key that one side's top N holds and the other side's rows do not hold
//      AT ALL fails, tied or not. No tie-break can explain a key that does not
//      exist on the other side, and this is where a one-sided "" group hides.
//   4. Every key in either side's top N that both sides hold — tied keys
//      included — has every compared figure held within `TOLERANCE`, counts
//      widened by the control's own drift, as `allowedDifference` does for a
//      scalar figure, and a distinct count (`spec.distinct`) allowed at least
//      `DCOUNT_SLACK` (owner decision 2026-09-25). A tie on one side says
//      nothing about the other side's figure for the same key, and the slack
//      says nothing about rule 2: a key pushed out of a top N ranked by a
//      distinct count that moved by one still fails there.
//   5. `pass` needs at least one compared key tied on neither side; a check
//      whose every compared key was tied is `unexercised`, since the ranking
//      itself was never tested.
//
// THE CONSERVATIVE CHOICE, and why. The rule used to drop every key tied on
// EITHER side from BOTH sides before comparing anything, so a key tied at the
// cut on one side and ranked plainly on the other was never checked: a "" group
// tied on Parquet only, or a key whose count moved 50 % while JSON happened to
// tie it, both read as `pass` (review of feat/phase8-1-router, 2026-09-25).
// Excusing membership only, and always comparing figures, can fail a panel
// whose difference is real but below the cut, where the viewer would never see
// it; a false fail keeps a query on JSON, and a false pass is what would move it.
//
// An absent key and an empty-string key are DIFFERENT keys here, on purpose:
// JSON omits a key column that Parquet fills with "", and calling the two equal
// would hide class F.

export interface GroupedSpec {
  /** The key columns, in order. */
  keys: readonly string[]
  /** The column the panel ranks by, descending. */
  rank: string
  /** How many rows the panel shows. */
  n: number
  /** The figures compared per key, and what kind of aggregate each is. */
  columns: Readonly<Record<string, 'count' | 'distribution'>>
  /**
   * The count columns that are distinct counts (`isDistinctCount`): each figure
   * is allowed at least `DCOUNT_SLACK`. The ranking is not — a key's place in
   * the top N is judged by rule 2 whatever column ranks it.
   */
  distinct?: readonly string[]
}

export interface GroupedDifference {
  key: string
  column: string
  json: number | null
  parquet: number | null
  /** The difference allowed; null when one side of a distribution had no value at all (an absent count reads as 0). */
  allowed: number | null
}

export interface GroupedReport {
  /** `unexercised`: no key tied on neither side was left to compare. */
  verdict: 'pass' | 'fail' | 'unexercised'
  /** Every key whose figures were compared: in either side's top N and held by both, tied keys included. */
  compared: string[]
  /** Keys tied at the top-N boundary on either side. Their place in the top N was excused; their figures were not. */
  tied: string[]
  /** In JSON's top N and neither in Parquet's nor excused by a tie, or absent from Parquet's rows altogether. */
  onlyJson: string[]
  /** The same, the other way round. */
  onlyParquet: string[]
  differs: GroupedDifference[]
  sentence: string
}

/**
 * One row's key as text. An absent value and "" stay different keys. Exported
 * for the parity runner (parityRun.ts), which looks a compared key's rows up by
 * the same text `compareGrouped` reports.
 */
export function keyOf(row: Row, keys: readonly string[]): string {
  return keys.map((k) => (row[k] === undefined || row[k] === null ? '(absent)' : JSON.stringify(row[k]))).join(' · ')
}

/** One side's top-N keys, every key tied with the N-th across the cut, and every row by key. */
function topN(rows: readonly Row[], spec: GroupedSpec): { top: Map<string, Row>; tied: Set<string>; all: Map<string, Row> } {
  const rankOf = (r: Row) => numberOf(r[spec.rank]) ?? -Infinity
  const ranked = [...rows].sort((a, b) => rankOf(b) - rankOf(a))
  const all = new Map<string, Row>()
  for (const r of ranked) if (!all.has(keyOf(r, spec.keys))) all.set(keyOf(r, spec.keys), r)
  const top = new Map<string, Row>()
  for (const r of ranked.slice(0, spec.n)) top.set(keyOf(r, spec.keys), r)
  const tied = new Set<string>()
  if (ranked.length > spec.n && rankOf(ranked[spec.n - 1]) === rankOf(ranked[spec.n])) {
    const boundary = rankOf(ranked[spec.n - 1])
    for (const r of ranked) if (rankOf(r) === boundary) tied.add(keyOf(r, spec.keys))
  }
  return { top, tied, all }
}

/**
 * Compare a grouped panel's rows, JSON against Parquet, over one window.
 * `drift` is the scalar control's relative disagreement over that window (0
 * when it agreed exactly): run this only beside a comparable control, as
 * `compareParity` judges nothing without one.
 */
export function compareGrouped(jsonRows: readonly Row[], parquetRows: readonly Row[], spec: GroupedSpec, drift = 0): GroupedReport {
  if (!(spec.n > 0)) throw new Error('parity: a grouped check needs n > 0')
  const j = topN(jsonRows, spec)
  const p = topN(parquetRows, spec)
  const tied = new Set([...j.tied, ...p.tied])
  const union = [...j.top.keys(), ...[...p.top.keys()].filter((k) => !j.top.has(k))]

  const onlyJson: string[] = []
  const onlyParquet: string[] = []
  const compared: string[] = []
  for (const key of union) {
    const inJ = j.top.has(key)
    const inP = p.top.has(key)
    // Rule 3: a key the other side does not hold at all fails, tie or no tie.
    if (!j.all.has(key)) {
      onlyParquet.push(key)
      continue
    }
    if (!p.all.has(key)) {
      onlyJson.push(key)
      continue
    }
    // Rule 2: in one top N only, and no tie on either side explains it.
    if (inJ !== inP && !tied.has(key)) (inJ ? onlyJson : onlyParquet).push(key)
    // Rule 4: held by both, so its figures are compared, tied or not.
    compared.push(key)
  }

  const differs: GroupedDifference[] = []
  for (const key of compared) {
    for (const [column, kind] of Object.entries(spec.columns)) {
      const a = numberOf(j.all.get(key)![column])
      const b = numberOf(p.all.get(key)![column])
      if ((a === null || b === null) && kind !== 'count') {
        // For a distribution "no value" against a number is class E's failure.
        if (a !== b) differs.push({ key, column, json: a, parquet: b, allowed: null })
        continue
      }
      // For a count, absent and 0 are one statement, as in compareColumn, so an
      // absent count is held to the same rule as a 0 — the distinct-count slack
      // included. (Whether Cribl ever omits a count column on a row it answers
      // is unmeasured.) The difference keeps "no value" for the reader.
      const jv = a ?? 0
      const pv = b ?? 0
      const allowed = allowedDifference({ kind, tolerance: TOLERANCE[kind], distinct: spec.distinct?.includes(column) ?? false }, jv, drift)
      if (Math.abs(pv - jv) > allowed) differs.push({ key, column, json: a, parquet: b, allowed })
    }
  }

  const failed = onlyJson.length > 0 || onlyParquet.length > 0 || differs.length > 0
  // Rule 5: a pass needs a key whose ranking no tie excused.
  const verdict: GroupedReport['verdict'] = failed ? 'fail' : compared.some((k) => !tied.has(k)) ? 'pass' : 'unexercised'
  const cut = `The top ${spec.n} by ${spec.rank}`
  const tiedWords = tied.size
    ? ` ${tied.size} key${tied.size === 1 ? ' was' : 's were'} tied at the top-${spec.n} boundary: ${tied.size === 1 ? 'its' : 'their'} place in the top ${spec.n} was not compared, and every figure a key held on both sides was.`
    : ''
  let sentence: string
  if (verdict === 'pass') {
    sentence = `${cut} held: the same ${compared.length} key${compared.length === 1 ? '' : 's'} on both sides, every figure within the difference it was allowed.${tiedWords}`
  } else if (verdict === 'unexercised') {
    sentence = `${cut} was not exercised: no key outside a tie was left to compare.${tiedWords}`
  } else {
    const bits = [
      onlyJson.length ? `on JSON only: ${onlyJson.join(', ')}` : '',
      onlyParquet.length ? `on Parquet only: ${onlyParquet.join(', ')}` : '',
      differs.length
        ? `${differs.length} figure${differs.length === 1 ? '' : 's'} outside the difference allowed: ` +
          differs.map((d) => `${d.key} ${d.column} ${fmtValue(d.json)} → ${fmtValue(d.parquet)}`).join('; ')
        : '',
    ].filter(Boolean)
    sentence = `${cut} FAILED — ${bits.join('; ')}.${tiedWords}`
  }
  return { verdict, compared, tied: [...tied], onlyJson, onlyParquet, differs, sentence }
}
