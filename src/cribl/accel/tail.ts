// A panel's tail, evaluated over rows this app already holds.
//
// WHY THIS EXISTS. A shared scheduled scan serves several panels, and each panel
// is defined by a TAIL — the KQL after the body that cuts that panel's shape out
// of the stored rows. Cribl can evaluate a tail only by running a search: a
// `$vt_results` job, with its place in the ~1.6 s admission queue. And a PAST run
// cannot be addressed by `$vt_results` at all, only read as an artifact — so a
// panel whose tail re-aggregates had nothing to show on a picked snapshot
// (`unshaped`). Ten panels were blank on every picked snapshot for that reason.
//
// Evaluating the tail here fixes both: the newest run is read as an artifact with
// no job submitted, and a picked run finally has a shape.
//
// ── A WHITELIST, NOT AN INTERPRETER ─────────────────────────────────────────
// This parses EXACTLY the operators the manifest's tails use, in exactly the
// forms they use them, and refuses everything else by returning null. A refusal
// is never a fault: the caller falls back to the query path, where Cribl runs
// the tail itself. The cost of a missing operator is one submitted job; the cost
// of an operator guessed wrong is a wrong number rendered as a right one. So the
// grammar is deliberately narrow, and widening it needs a measured semantics
// test for every operator it adds — see tail.test.ts.
//
// ── THE TRUNCATION RULE ─────────────────────────────────────────────────────
// A `summarize` over a truncated read is a wrong total, and a `sort | limit`
// over one is the wrong top N. This module cannot know whether its input is
// complete, so `evaluateTail` takes `complete` and refuses any re-aggregating
// tail without it. The caller proves completeness from the results header's
// `totalEventCount`, never from "the limit was probably big enough".

import type { Row } from '../search'

// ── The grammar ─────────────────────────────────────────────────────────────

type Literal = string | number

type Cond =
  | { kind: 'cmp'; col: string; op: '==' | '!=' | '>'; value: Literal }
  | { kind: 'in'; col: string; values: readonly string[] }

type Agg =
  | { as: string; fn: 'sum'; col: string }
  | { as: string; fn: 'dcount'; col: string }
  | { as: string; fn: 'count' }
  | { as: string; fn: 'sumIif'; cond: Cond }

type Stage =
  | { op: 'project'; picks: readonly { as: string; from: string }[] }
  | { op: 'where'; cond: Cond }
  | { op: 'extend'; picks: readonly { as: string; from: string }[] }
  | { op: 'summarize'; aggs: readonly Agg[]; by: readonly string[] }
  | { op: 'sort'; col: string; desc: boolean }
  | { op: 'limit'; n: number }

const IDENT = '[A-Za-z_][A-Za-z0-9_]*'
const IDENT_RE = new RegExp(`^${IDENT}$`)
const STR = '"((?:[^"\\\\]|\\\\.)*)"'
const NUM = '(-?\\d+(?:\\.\\d+)?)'

/** Split on `|` and `,` outside double quotes and parentheses. */
function splitTop(s: string, sep: '|' | ','): string[] | null {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      cur += c
      if (c === '\\') { cur += s[++i] ?? ''; continue }
      if (c === '"') quoted = false
      continue
    }
    if (c === '"') { quoted = true; cur += c; continue }
    if (c === '(') depth++
    if (c === ')') { depth--; if (depth < 0) return null }
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (quoted || depth !== 0) return null
  out.push(cur)
  return out.map((t) => t.trim())
}

function literal(raw: string): Literal | undefined {
  const s = new RegExp(`^${STR}$`).exec(raw)
  if (s) return s[1].replace(/\\(.)/g, '$1')
  const n = new RegExp(`^${NUM}$`).exec(raw)
  if (n) return Number(n[1])
  return undefined
}

function parseCond(raw: string): Cond | null {
  const inM = new RegExp(`^(${IDENT})\\s+in\\s*\\((.*)\\)$`).exec(raw)
  if (inM) {
    const parts = splitTop(inM[2], ',')
    if (!parts || parts.length === 0) return null
    const values: string[] = []
    for (const p of parts) {
      const v = literal(p)
      if (typeof v !== 'string') return null
      values.push(v)
    }
    return { kind: 'in', col: inM[1], values }
  }
  // `==`, `!=` and `>` only — the operators the manifest uses, each with a test.
  // A tail using `>=`, `<` or `<=` is refused and costs a job, rather than
  // running comparison code nothing has measured against Cribl.
  if (new RegExp(`^${IDENT}\\s*(>=|<=|<)`).test(raw)) return null
  const cmp = new RegExp(`^(${IDENT})\\s*(==|!=|>)\\s*(.+)$`).exec(raw)
  if (cmp) {
    const value = literal(cmp[3].trim())
    if (value === undefined) return null
    return { kind: 'cmp', col: cmp[1], op: cmp[2] as Extract<Cond, { kind: 'cmp' }>['op'], value }
  }
  return null
}

function parsePicks(raw: string, bareAllowed: boolean): { as: string; from: string }[] | null {
  const terms = splitTop(raw, ',')
  if (!terms || terms.length === 0) return null
  const picks: { as: string; from: string }[] = []
  for (const t of terms) {
    const named = new RegExp(`^(${IDENT})\\s*=\\s*(${IDENT})$`).exec(t)
    if (named) { picks.push({ as: named[1], from: named[2] }); continue }
    if (bareAllowed && IDENT_RE.test(t)) { picks.push({ as: t, from: t }); continue }
    return null
  }
  return picks
}

function parseAgg(raw: string): Agg | null {
  const m = new RegExp(`^(${IDENT})\\s*=\\s*(${IDENT})\\s*\\((.*)\\)$`).exec(raw)
  if (!m) return null
  const [, as, fn, arg] = m
  const a = arg.trim()
  if (fn === 'count' && a === '') return { as, fn: 'count' }
  if ((fn === 'sum' || fn === 'dcount') && IDENT_RE.test(a)) return { as, fn, col: a }
  if (fn === 'sum') {
    // `sum(iif(<cond>, 1, 0))` — a count of the rows matching a condition, and
    // the only shape of iif the manifest uses. Any other branch values refuse.
    const iif = /^iif\s*\((.*)\)$/.exec(a)
    if (!iif) return null
    const parts = splitTop(iif[1], ',')
    if (!parts || parts.length !== 3 || parts[1] !== '1' || parts[2] !== '0') return null
    const cond = parseCond(parts[0])
    return cond ? { as, fn: 'sumIif', cond } : null
  }
  return null
}

function parseStage(raw: string): Stage | null {
  const m = /^([a-z]+)\s+([\s\S]+)$/.exec(raw)
  if (!m) return null
  const [, op, rest] = m
  switch (op) {
    case 'project': {
      const picks = parsePicks(rest, true)
      return picks ? { op, picks } : null
    }
    case 'extend': {
      const picks = parsePicks(rest, false)
      return picks ? { op, picks } : null
    }
    case 'where': {
      const cond = parseCond(rest.trim())
      return cond ? { op, cond } : null
    }
    case 'summarize': {
      const byM = /^([\s\S]*?)\s+by\s+([\s\S]+)$/.exec(rest)
      const aggPart = byM ? byM[1] : rest
      const aggRaw = splitTop(aggPart, ',')
      if (!aggRaw) return null
      const aggs: Agg[] = []
      for (const a of aggRaw) {
        const agg = parseAgg(a)
        if (!agg) return null
        aggs.push(agg)
      }
      let by: string[] = []
      if (byM) {
        const keys = splitTop(byM[2], ',')
        if (!keys || !keys.every((k) => IDENT_RE.test(k))) return null
        by = keys
      }
      return { op, aggs, by }
    }
    case 'sort': {
      // `sort by x desc` / `sort by x asc`. KQL's default direction is desc,
      // but every tail here states it, and an unstated one is refused rather
      // than assumed.
      const s = new RegExp(`^by\\s+(${IDENT})\\s+(desc|asc)$`).exec(rest.trim())
      return s ? { op, col: s[1], desc: s[2] === 'desc' } : null
    }
    case 'limit': {
      const n = /^(\d+)$/.exec(rest.trim())
      return n ? { op, n: Number(n[1]) } : null
    }
    default:
      return null
  }
}

/** The stages of a tail, or null when any part of it is outside the grammar. */
export function parseTail(tail: string): Stage[] | null {
  const t = tail.trim()
  if (!t.startsWith('|')) return null
  const parts = splitTop(t.slice(1), '|')
  if (!parts || parts.length === 0) return null
  const stages: Stage[] = []
  for (const p of parts) {
    const s = parseStage(p)
    if (!s) return null
    stages.push(s)
  }
  return stages
}

/** True when a tail is only a projection — reproducible over a PARTIAL read,
 *  because it transforms rows one at a time. Anything else needs every row. */
export function isRowwise(stages: readonly Stage[]): boolean {
  return stages.every((s) => s.op === 'project' || s.op === 'extend' || s.op === 'where')
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/** Thrown internally when a value is one this module will not guess about. */
class Refuse extends Error {}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function test(cond: Cond, row: Row): boolean {
  const v = row[cond.col]
  // AN ABSENT OR NULL OPERAND IS REFUSED, NOT COMPARED — by the type checks
  // below, which admit only a string or a finite number. Whether Cribl treats
  // `null != ""` as true, false or null is a measured question, and a guess here
  // decides which rows a count includes.
  if (cond.kind === 'in') {
    if (typeof v !== 'string') throw new Refuse()
    return cond.values.includes(v)
  }
  const want = cond.value
  if (typeof want === 'string') {
    if (typeof v !== 'string') throw new Refuse()
    if (cond.op === '==') return v === want
    if (cond.op === '!=') return v !== want
    throw new Refuse() // string ordering is collation, which is not reproduced
  }
  if (!isNum(v)) throw new Refuse()
  switch (cond.op) {
    case '==': return v === want
    case '!=': return v !== want
    case '>': return v > want
  }
}

/** The key a group is filed under. A missing or non-scalar key is refused:
 *  whether Cribl emits a null-key group, and under what value, is measured,
 *  not assumed. */
function keyPart(v: unknown): string {
  if (typeof v === 'string') return `s${v}`
  if (isNum(v)) return `n${v}`
  if (typeof v === 'boolean') return `b${v}`
  throw new Refuse()
}

/**
 * One JS type per column, or a refusal.
 *
 * Cribl merges group keys by their STRING form — `0` and `"0"`, `12`, `12.0`
 * and `"12"` are one group — and emits whichever form it met first (probes 5a,
 * 5e, 2026-09-23). "First" is its row order, not ours, so the merged key's type
 * cannot be reproduced, and a dcount over mixed forms was never measured. A
 * column carrying more than one type is refused rather than split into groups
 * Cribl would have merged. Every stored column measured so far has one type.
 */
function oneType(seen: Map<string, string>, col: string, v: unknown): void {
  const t = typeof v
  const was = seen.get(col)
  if (was === undefined) seen.set(col, t)
  else if (was !== t) throw new Refuse()
}

function summarize(stage: Extract<Stage, { op: 'summarize' }>, rows: readonly Row[]): Row[] {
  interface Acc { key: Row; sums: number[]; sets: Set<string>[]; counts: number[] }
  const groups = new Map<string, Acc>()
  const types = new Map<string, string>()
  for (const row of rows) {
    for (const b of stage.by) oneType(types, b, row[b])
    const k = stage.by.map((b) => keyPart(row[b])).join('\u0000')
    let g = groups.get(k)
    if (!g) {
      const key: Row = {}
      for (const b of stage.by) key[b] = row[b]
      g = { key, sums: stage.aggs.map(() => 0), sets: stage.aggs.map(() => new Set<string>()), counts: stage.aggs.map(() => 0) }
      groups.set(k, g)
    }
    stage.aggs.forEach((a, i) => {
      if (a.fn === 'count') { g.counts[i]++; return }
      if (a.fn === 'sumIif') { if (test(a.cond, row)) g.sums[i]++; return }
      const v = row[a.col]
      if (a.fn === 'sum') {
        // A missing addend is refused rather than read as 0 — the same null
        // question as `test`, and the Parquet work showed how far "absent is
        // zero" can move a number.
        if (!isNum(v)) throw new Refuse()
        g.sums[i] += v
        return
      }
      // dcount: distinct non-null values. A null is refused for the same reason.
      // EXACT, where Cribl's default dcount is an estimate - measured +/-0.5 %
      // at ~10k distinct values and exact at a few hundred. At the cardinalities
      // the manifest's dcounts see today they agree; far above them a snapshot
      // could read slightly differently from the same query run live.
      oneType(types, `dcount:${a.col}`, v)
      g.sets[i].add(keyPart(v))
    })
  }
  // A summarize with no `by` over zero rows still emits one row in KQL. Over
  // zero rows the values are the question this module does not answer — the
  // caller never hands it an empty read — so it refuses.
  if (stage.by.length === 0 && groups.size === 0) throw new Refuse()
  return [...groups.values()].map((g) => {
    const out: Row = { ...g.key }
    stage.aggs.forEach((a, i) => {
      out[a.as] = a.fn === 'dcount' ? g.sets[i].size : a.fn === 'count' ? g.counts[i] : g.sums[i]
    })
    return out
  })
}

function sortRows(stage: Extract<Stage, { op: 'sort' }>, rows: readonly Row[]): Row[] {
  // Numbers only, and none missing: where Cribl puts a null, and how it orders
  // mixed types, are measured questions. Ties keep the input order (a stable
  // sort); Cribl's tie order is unstable-but-repeatable and not reproducible,
  // so a tie AT a limit boundary can keep a different member of the tie. The
  // sort key agrees; the rows' OTHER columns need not (measured: 588 resolvers
  // tied at total=25 for the last 85 of 500 slots, each with its own p50).
  for (const r of rows) if (!isNum(r[stage.col])) throw new Refuse()
  const dir = stage.desc ? -1 : 1
  return [...rows].sort((a, b) => dir * ((a[stage.col] as number) - (b[stage.col] as number)))
}

function pick(picks: readonly { as: string; from: string }[], row: Row, keep: boolean): Row {
  const out: Row = keep ? { ...row } : {}
  // A column the input lacks is LEFT OUT, as Search leaves it out.
  for (const p of picks) if (p.from in row) out[p.as] = row[p.from]
  return out
}

export interface EvaluateOptions {
  /**
   * The rows are the WHOLE stored result — proven by the caller from the
   * results header, not assumed. Required for any tail that is not row-wise.
   */
  complete: boolean
}

/**
 * The rows a panel would receive had Cribl run `tail` over `rows`, or null when
 * that cannot be reproduced here with certainty.
 *
 * Null means "ask Cribl": an operator outside the grammar, a null or oddly
 * typed operand, or a re-aggregating tail over rows not proven complete.
 */
export function evaluateTail(tail: string, rows: readonly Row[], opts: EvaluateOptions): Row[] | null {
  const stages = parseTail(tail)
  if (!stages) return null
  if (!isRowwise(stages) && !opts.complete) return null
  try {
    let cur: Row[] = rows.map((r) => ({ ...r }))
    for (const s of stages) {
      switch (s.op) {
        case 'project': cur = cur.map((r) => pick(s.picks, r, false)); break
        case 'extend': cur = cur.map((r) => pick(s.picks, r, true)); break
        case 'where': cur = cur.filter((r) => test(s.cond, r)); break
        case 'summarize': cur = summarize(s, cur); break
        case 'sort': cur = sortRows(s, cur); break
        case 'limit': cur = cur.slice(0, s.n); break
      }
    }
    return cur
  } catch (err) {
    if (err instanceof Refuse) return null
    throw err
  }
}
