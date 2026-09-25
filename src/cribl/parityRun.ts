// Phase 8.0e — the parity-evidence run, as a computation. The runner is
// scripts/parity-run.mjs; this module is everything it decides.
//
// WHAT IT IS FOR. `routing/table.ts` lets an entry say `target: 'parquet'` only
// with `evidence`: a report, a date, and at least three windows at different UTC
// hours over which that entry's own texts agreed on `gigamon_ami` and
// `gigamon_ami_pq`. This module plans such a run, judges its rows, and builds the
// report — including, for each entry that earned it, an `evidence` object in
// exactly the shape `RouteEvidence` takes, so a person can paste it into the
// table. The runner NEVER edits the table: moving a query is a reviewed data
// change (table.ts header), not a side effect of a measurement.
//
// NO NETWORK OF ITS OWN. Nothing here submits anything: `executeParityRun`
// takes a `submit` function, which the runner builds from
// scripts/parity-run-job.mjs and the tests build from a fake transport. No app
// module imports this file, and none can reach it from src/main.tsx
// (parityRun.test.ts fails on any import of it, static, dynamic or re-export,
// in either quote style; policyCoverage.test.ts walks the app's import graph
// and fails if it is reachable), so the app never runs a parity job and no
// router can move one.
//
// ── WHICH ENTRIES ───────────────────────────────────────────────────────────
// By default every entry ELIGIBLE under the rule `tableProblems` applies — the
// text's classes and the type table, with density left to the install. Today
// `FIELD_TYPES` is empty, so no entry is eligible and the default run submits
// nothing: the plan lists every entry and why. `--force-ineligible` runs an
// ineligible entry to MEASURE it; its result is marked measurement-only and
// never carries evidence. A pinned entry, one with no text, and one whose rows
// this module cannot compare (below) never run.
//
// ── WINDOWS ─────────────────────────────────────────────────────────────────
// At least three, absolute, on whole 5-minute buckets (the completeness
// check's), each starting in a different UTC hour, the newest ending at least
// COMPLETENESS_SETTLE_SECONDS before the reference time — so the check made
// just before the window's jobs can prove every bucket of it settled. A
// reference time later than the real clock is refused before anything is
// billed: its newest windows could never be proven settled, and each would
// still cost a completeness job. *(Added 2026-09-25, review of
// `feat/phase8-parity-runner`.)*
//
// ── ORDER, PER WINDOW, AND WHAT STOPS IT ────────────────────────────────────
//   1. COMPLETENESS_QUERY over the window. Not proven complete (a gap, an empty
//      or missing bucket, unsettled, or no answer) → the window is SKIPPED, and
//      the report says why. Nothing else is submitted for it. An answer with
//      rows but not one bucket this can read (no `bin_time_5m`, no `_time`)
//      STOPS THE RUN: no later window could be proven either, and each would
//      bill another cribl_metrics job to find that out.
//   2. The control count (`PARITY_COUNT_QUERY`) on both datasets. Not agreeing
//      within its tolerance → the window is INCOMPARABLE: the two sides did not
//      hold the same records, and a difference would be landing lag, not
//      Parquet. Nothing else is submitted for it.
//   3. Each selected text, as written on `gigamon_ami` and with only its
//      dataset selector moved (`retarget`) on `gigamon_ami_pq` — except that a
//      top N (a descending sort with a limit) is submitted on both sides with
//      its limit raised (`comparisonText`) and compared at its own N. With the
//      text's own `limit N`, Cribl cuts each side at N itself, and when a tie
//      sits at the N-th rank it may keep a different tied key on each side:
//      the tie rule in `compareGrouped` can excuse that only when it can see
//      past the cut. *(Corrected 2026-09-25, review of
//      `feat/phase8-parity-runner`: every text ran as written, so a boundary
//      tie on identical data was recorded as a FAIL.)*
//
// ── HOW ROWS ARE COMPARED ───────────────────────────────────────────────────
// `querySpec` reads the text's LAST `summarize` — its named aggregates and its
// `by` keys — and what follows it, which may only be `sort by c [asc|desc]` and
// `limit`/`take N`. Anything else after the summarize, an unnamed aggregate, an
// aggregate it cannot classify as a count or a distribution, or a key that is
// not a plain field, `name=expr` or `bin(_time, <span>)` → it refuses the entry
// at plan time. A `bin(_time, 1m)` key comes back named `bin_time_1m` (the live
// charts read that column), so that is the key compared. *(Corrected
// 2026-09-25, review of `feat/phase8-parity-runner`: it was named `_time`,
// which no live row carries, so every minute of a trend folded into one
// "(absent)" key and one row per side was compared.)* Then:
//   * a descending sort with a limit is a top N: `compareGrouped` with that
//     rank and N, and the control's drift;
//   * anything else returns every row, and every row is compared (N = all) —
//     except a limit with no descending sort that was REACHED on either side:
//     which rows came back is then arbitrary, and the window is incomparable;
//   * a scalar summarize is one group with no key;
//   * a figure that is TEXT on either side (e.g. `max(ssl_issuer)`) is held to
//     exact equality, absent and "" different — `compareGrouped` reads only
//     numbers;
//   * a window where every compared figure was empty or zero on both sides is
//     UNEXERCISED, never a pass — "" on both sides included;
//   * rows this cannot tell apart are INCOMPARABLE, never compared: two rows on
//     one side with the same key, or a key column no row on a side carries;
//   * in a top N, a key missing from the other side's rows when that side came
//     back full at the raised limit with the key's rank inside what it cut is
//     INCOMPARABLE: whether it was cut or lost cannot be read.
//
// ── WHAT THIS CANNOT PROVE ──────────────────────────────────────────────────
// * Density. Evidence is judged, like `tableProblems`, on text and type; the
//   router still refuses at submit on an install where a D/F key is not dense.
// * That the three windows are representative: they are three windows.
// * That `gigamon_ami` is written only by the pack (routing.ts says why the
//   completeness check cannot see another writer; the control count would).

import { PACK_PARQUET_DATASET_ID } from './pack'
import { COMPLETENESS_BUCKET_SECONDS, COMPLETENESS_QUERY } from '../queries/routing'
import { FIELD_TYPES } from '../data/fieldTypes'
import { LAKE_DATASET } from './config'
import {
  PARITY_CHECKS,
  compareColumn,
  compareGrouped,
  keyOf,
  parityColumns,
  retarget,
  type ColumnResult,
  type FieldType,
  type GroupedReport,
  type GroupedSpec,
  type ParityWindow,
  type Row,
} from './parity'
import { eligibility } from './routing/eligibility'
import { COMPLETENESS_BUCKET_COLUMN, COMPLETENESS_SETTLE_SECONDS, bucketRecords, windowCompleteness, type BucketRecord } from './routing/completeness'
import { ROUTES, evidenceProblems, type RouteEntry, type RouteEvidence } from './routing/table'
import { COST_MARGIN, DEFAULT_COST_BASIS, MEASURED_RUN } from './parquetAuditReport'

export const PARITY_JSON_DATASET = LAKE_DATASET
export const PARITY_PARQUET_DATASET = PACK_PARQUET_DATASET_ID

// ── Windows ─────────────────────────────────────────────────────────────────

export interface RunWindow extends ParityWindow {
  label: string
}

export interface WindowOptions {
  /** Window length. A whole number of 5-minute buckets. Default 15. */
  minutes?: number
  /** Hours before the newest window at which each window ends. Default 0, 6, 12. */
  offsetsHours?: readonly number[]
  /** The real clock, epoch seconds. A reference time later than it is refused. */
  clockSec?: number
}

export const DEFAULT_WINDOW_MINUTES = 15
export const DEFAULT_OFFSETS_HOURS: readonly number[] = Object.freeze([0, 6, 12])
/** What `evidenceProblems` asks for, restated so the plan refuses before anything is billed. */
export const MIN_WINDOWS = 3

const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z')
const hourOf = (s: number) => new Date(s * 1000).getUTCHours()

/**
 * The run's windows, newest first. Throws — before anything is billed — on a
 * length that is not whole buckets, fewer than three windows, an offset that
 * leaves a window off the bucket grid, or two windows starting in the same UTC
 * hour (which `evidenceProblems` would refuse after the money was spent).
 */
export function parityRunWindows(nowSec: number, opts: WindowOptions = {}): RunWindow[] {
  const minutes = opts.minutes ?? DEFAULT_WINDOW_MINUTES
  const offsets = opts.offsetsHours ?? DEFAULT_OFFSETS_HOURS
  const B = COMPLETENESS_BUCKET_SECONDS
  if (!Number.isFinite(nowSec)) throw new Error('parity run: the reference time is not a time')
  if (opts.clockSec !== undefined && nowSec > opts.clockSec) {
    throw new Error(`parity run: the reference time ${iso(nowSec)} is later than now (${iso(Math.floor(opts.clockSec))}); its windows could never be proven settled, and each would still bill a completeness job`)
  }
  if (!(minutes > 0) || (minutes * 60) % B !== 0) throw new Error(`parity run: a window must be a whole number of ${B / 60}-minute buckets (got ${minutes} min)`)
  if (offsets.length < MIN_WINDOWS) throw new Error(`parity run: evidence needs at least ${MIN_WINDOWS} windows (got ${offsets.length})`)
  for (const h of offsets) {
    if (!Number.isFinite(h) || h < 0) throw new Error(`parity run: an offset must be a non-negative number of hours (got ${h})`)
    if (Math.round(h * 3600) % B !== 0) throw new Error(`parity run: offset ${h} h puts a window off the ${B / 60}-minute bucket grid`)
  }
  // The newest window ends on a bucket edge at least the settle margin back.
  const newestEnd = Math.floor((nowSec - COMPLETENESS_SETTLE_SECONDS) / B) * B
  const windows = offsets.map((h) => {
    const latest = newestEnd - Math.round(h * 3600)
    const earliest = latest - minutes * 60
    return { earliest, latest, label: `${iso(earliest)} → ${iso(latest)} (${minutes} min)` }
  })
  const hours = new Set(windows.map((w) => hourOf(w.earliest)))
  if (hours.size !== windows.length) throw new Error('parity run: two windows start in the same UTC hour; evidence needs different hours (choose other --offsets)')
  return windows
}

// ── Reading a query's result shape ──────────────────────────────────────────

export type AggregateKind = 'count' | 'distribution'

export interface QuerySpec {
  keys: string[]
  aggregates: { name: string; expr: string; kind: AggregateKind }[]
  order: { column: string; dir: 'asc' | 'desc' } | null
  limit: number | null
}

export type SpecResult = { ok: true; spec: QuerySpec } | { ok: false; why: string }

/** Split on `sep` where it sits outside parentheses and quotes. */
function splitTop(s: string, sep: string): string[] {
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

const COUNT_RE = /^(count|countif|sum|sumif|dcount|dcountif|count_distinct)\(/
const DISTRIBUTION_RE = /^(percentile|percentiles|avg|avgif|min|max|median|stdev|variance)\(/

/**
 * What a query's rows look like: keys, named aggregates, order, limit — or why
 * this runner cannot compare them. Reads the text only; see the header.
 */
export function querySpec(query: string): SpecResult {
  const stages = splitTop(query, '|')
  let at = -1
  stages.forEach((s, i) => {
    if (/^summarize\s/.test(s)) at = i
  })
  if (at < 0) return { ok: false, why: 'it has no summarize, so its rows are records, not figures' }

  const clause = stages[at].replace(/^summarize\s+/, '')
  const [aggPart, ...byParts] = splitTop(clause, ' by ')
  if (byParts.length > 1) return { ok: false, why: 'its summarize has more than one `by`' }
  const aggregates: QuerySpec['aggregates'] = []
  for (const part of splitTop(aggPart, ',').filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq < 0 || !/^[A-Za-z_]\w*$/.test(part.slice(0, eq).trim())) return { ok: false, why: `an unnamed aggregate, "${part}"` }
    const name = part.slice(0, eq).trim()
    const expr = part.slice(eq + 1).trim()
    const kind: AggregateKind | null = COUNT_RE.test(expr) ? 'count' : DISTRIBUTION_RE.test(expr) ? 'distribution' : null
    if (!kind) return { ok: false, why: `an aggregate it cannot classify as a count or a distribution, "${part}"` }
    aggregates.push({ name, expr, kind })
  }
  if (!aggregates.length) return { ok: false, why: 'its summarize names no aggregate' }

  const keys: string[] = []
  for (const k of byParts.length ? splitTop(byParts[0], ',').filter(Boolean) : []) {
    const bin = /^bin\(\s*_time\s*,\s*(\w+)\s*\)$/.exec(k)
    const named = /^([A-Za-z_]\w*)\s*=/.exec(k)
    // Cribl names a `bin(_time, 1m)` group key `bin_time_1m`.
    if (bin) keys.push(`bin_time_${bin[1]}`)
    else if (named) keys.push(named[1])
    else if (/^[A-Za-z_][\w.]*$/.test(k)) keys.push(k)
    else return { ok: false, why: `a group key it cannot name, "${k}"` }
  }

  let order: QuerySpec['order'] = null
  let limit: number | null = null
  for (const s of stages.slice(at + 1)) {
    const sort = /^(?:sort|order)\s+by\s+([A-Za-z_]\w*)(?:\s+(asc|desc))?$/.exec(s)
    const lim = /^(?:limit|take)\s+(\d+)$/.exec(s)
    if (sort && order === null && limit === null) order = { column: sort[1], dir: (sort[2] as 'asc' | 'desc' | undefined) ?? 'desc' }
    else if (lim && limit === null) limit = Number(lim[1])
    else return { ok: false, why: `a stage after its summarize this runner does not read, "${s}"` }
  }
  return { ok: true, spec: { keys, aggregates, order, limit } }
}

// ── What is submitted ───────────────────────────────────────────────────────

/** How many rows a top N of `n` is submitted for, so the rows past the cut — and a tie across it — can be seen. */
export function topNFetchLimit(n: number): number {
  return n + Math.max(n, 50)
}

/**
 * The text the runner submits for `query`: the text as written, except that a
 * top N (a descending sort, then `limit`/`take N`) has its limit raised to
 * `topNFetchLimit(N)`. Each key's figures are the same aggregates over the
 * same records; only how many rows come back changes. The comparison is still
 * made at the text's own N (`compareQueryRows`).
 */
export function comparisonText(query: string): string {
  const parsed = querySpec(query)
  if (!parsed.ok || parsed.spec.order?.dir !== 'desc' || parsed.spec.limit === null) return query
  const raised = query.replace(/(\|\s*(?:limit|take)\s+)\d+(\s*)$/, `$1${topNFetchLimit(parsed.spec.limit)}$2`)
  if (raised === query) throw new Error(`parity run: could not raise the limit of ${query}`)
  return raised
}

// ── Comparing one query over one window ─────────────────────────────────────

export type QueryVerdict = 'pass' | 'fail' | 'unexercised' | 'incomparable' | 'notrun'

export interface TextDifference {
  key: string
  column: string
  json: unknown
  parquet: unknown
}

export interface QueryComparison {
  verdict: QueryVerdict
  sentence: string
  rows: { json: number | null; parquet: number | null }
  /** The top-N spec handed to `compareGrouped`, when it ran. */
  grouped: GroupedSpec | null
  report: GroupedReport | null
  textDiffers: TextDifference[]
}

type RawKind = 'absent' | 'number' | 'text'
function rawKind(v: unknown): RawKind {
  if (v === undefined || v === null) return 'absent'
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'text'
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return 'number'
  return 'text'
}

/**
 * One query's rows, JSON against Parquet, over one window. `drift` is the
 * window's control drift (0 when it agreed exactly). Null rows on a side mean
 * its job gave no complete answer: `notrun`, never a difference.
 */
export function compareQueryRows(query: string, jsonRows: readonly Row[] | null, parquetRows: readonly Row[] | null, drift = 0): QueryComparison {
  const base = { rows: { json: jsonRows?.length ?? null, parquet: parquetRows?.length ?? null }, grouped: null, report: null, textDiffers: [] }
  if (!jsonRows || !parquetRows) {
    const which = [!jsonRows && 'JSON', !parquetRows && 'Parquet'].filter(Boolean).join(' and ')
    return { ...base, verdict: 'notrun', sentence: `Not compared: the ${which} job gave no complete answer.` }
  }
  const parsed = querySpec(query)
  if (!parsed.ok) return { ...base, verdict: 'incomparable', sentence: `Not compared: ${parsed.why}.` }
  const { spec } = parsed

  // Rows this cannot tell apart are not compared: `compareGrouped` keeps one row
  // per key, so two rows under one key would compare the first and drop the rest.
  for (const [side, rows] of [['JSON', jsonRows], ['Parquet', parquetRows]] as const) {
    if (!rows.length) continue
    const missing = spec.keys.filter((k) => rows.every((r) => r[k] === undefined || r[k] === null))
    if (missing.length) {
      return { ...base, verdict: 'incomparable', sentence: `Not compared: no ${side} row carries the key column${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, so its rows cannot be told apart.` }
    }
    const seen = new Set<string>()
    for (const r of rows) {
      const k = keyOf(r, spec.keys)
      if (seen.has(k)) return { ...base, verdict: 'incomparable', sentence: `Not compared: two ${side} rows share the key ${k || '(none)'}, so its rows cannot be told apart.` }
      seen.add(k)
    }
  }

  const all = Math.max(jsonRows.length, parquetRows.length, 1)
  let grouped: GroupedSpec
  if (spec.order?.dir === 'desc') {
    grouped = { keys: spec.keys, rank: spec.order.column, n: spec.limit ?? all, columns: {} }
  } else {
    if (spec.limit !== null && (jsonRows.length >= spec.limit || parquetRows.length >= spec.limit)) {
      return {
        ...base,
        verdict: 'incomparable',
        sentence: `Not compared: the query keeps ${spec.limit} rows ${spec.order ? 'in ascending order' : 'in no stated order'}, and a side returned ${spec.limit}, so which rows came back is arbitrary.`,
      }
    }
    grouped = { keys: spec.keys, rank: spec.aggregates[0].name, n: all, columns: {} }
  }
  grouped = { ...grouped, columns: Object.fromEntries(spec.aggregates.map((a) => [a.name, a.kind])) }
  const report = compareGrouped(jsonRows, parquetRows, grouped, drift)

  // A top N submitted at the raised limit (`comparisonText`): a key one side
  // ranks in its top N and the other side did not return at all may only have
  // been cut there — when that side came back full and the key's rank is no
  // higher than the lowest rank it returned. Where it went cannot be read, so
  // the window is not compared, rather than failed or passed.
  if (spec.order?.dir === 'desc' && spec.limit !== null) {
    const fetched = topNFetchLimit(spec.limit)
    const rank = spec.order.column
    const num = (v: unknown) => (rawKind(v) === 'number' ? Number(v) : -Infinity)
    const rowOf = (rows: readonly Row[], key: string) => rows.find((r) => keyOf(r, spec.keys) === key)
    const cutFrom = (side: readonly Row[], key: string, other: readonly Row[]) => {
      if (side.length < fetched || rowOf(side, key)) return false
      const lowest = Math.min(...side.map((r) => num(r[rank])))
      const held = rowOf(other, key)
      return !!held && num(held[rank]) <= lowest
    }
    const cut = [...report.onlyJson.filter((k) => cutFrom(parquetRows, k, jsonRows)), ...report.onlyParquet.filter((k) => cutFrom(jsonRows, k, parquetRows))]
    if (cut.length) {
      const one = cut.length === 1
      return {
        ...base,
        verdict: 'incomparable',
        grouped,
        report,
        sentence: `Not compared: ${cut.join(', ')} ${one ? 'is' : 'are'} missing from a side that came back full at ${fetched} rows, with ${one ? 'its' : 'their'} rank inside what that side cut, so whether ${one ? 'it was' : 'they were'} cut or lost cannot be read.`,
      }
    }
  }

  // Text figures: exact, absent ≠ "". compareGrouped reads numbers only.
  const byKey = (rows: readonly Row[]) => {
    const m = new Map<string, Row>()
    for (const r of rows) {
      const k = keyOf(r, spec.keys)
      if (!m.has(k)) m.set(k, r)
    }
    return m
  }
  const jm = byKey(jsonRows)
  const pm = byKey(parquetRows)
  const textDiffers: TextDifference[] = []
  let exercised = false
  for (const key of report.compared) {
    const jr = jm.get(key)
    const pr = pm.get(key)
    for (const a of spec.aggregates) {
      const jv = jr?.[a.name]
      const pv = pr?.[a.name]
      const jk = rawKind(jv)
      const pk = rawKind(pv)
      if (jk === 'text' || pk === 'text') {
        // "" on both sides exercised nothing: an absent value read as "" is
        // exactly what that cannot tell apart.
        if (!(jv === '' && pv === '')) exercised = true
        if (!(jk === 'text' && pk === 'text' && jv === pv)) textDiffers.push({ key, column: a.name, json: jv ?? null, parquet: pv ?? null })
      } else if ((jk === 'number' && Number(jv) !== 0) || (pk === 'number' && Number(pv) !== 0)) exercised = true
    }
  }

  const rows = base.rows
  if (report.verdict === 'fail' || textDiffers.length) {
    const textWords = textDiffers.length
      ? ` ${textDiffers.length} text figure${textDiffers.length === 1 ? '' : 's'} differed: ` +
        textDiffers.map((d) => `${d.key} ${d.column} ${JSON.stringify(d.json)} → ${JSON.stringify(d.parquet)}`).join('; ') + '.'
      : ''
    return { verdict: 'fail', sentence: (report.verdict === 'fail' ? report.sentence : 'The figures held.') + textWords, rows, grouped, report, textDiffers }
  }
  if (report.verdict === 'unexercised' || !exercised) {
    return {
      verdict: 'unexercised',
      sentence: report.verdict === 'unexercised' ? report.sentence : 'Not exercised: every compared figure was empty or zero on both sides.',
      rows,
      grouped,
      report,
      textDiffers,
    }
  }
  return { verdict: 'pass', sentence: report.sentence, rows, grouped, report, textDiffers }
}

// ── The plan ────────────────────────────────────────────────────────────────

export type EntryMode = 'evidence' | 'measurement'

export interface PlannedEntry {
  id: string
  mode: EntryMode
  queries: readonly string[]
  /** For a measurement-only entry: why it is not eligible. */
  ineligible: string[]
}

export interface RefusedEntry {
  id: string
  why: string
}

export interface EntryPlan {
  selected: PlannedEntry[]
  refused: RefusedEntry[]
}

export interface EntryPlanOptions {
  /** Entry ids to consider; null or empty for every entry. An unknown id throws. */
  only?: readonly string[] | null
  /** Run ineligible entries to measure them. Never evidence. */
  forceIneligible?: boolean
  entries?: readonly RouteEntry[]
  types?: Readonly<Record<string, FieldType>>
}

/** Why an entry's texts are not eligible, as `tableProblems` judges it: text and type, not density. */
export function ineligibility(e: RouteEntry, types: Readonly<Record<string, FieldType>> = FIELD_TYPES): string[] {
  return [...new Set(e.queries.flatMap((q) => eligibility(q, types).refusals.filter((r) => r.kind !== 'density').map((r) => r.words)))]
}

/** Which entries the run submits, and why every other one is left out. */
export function planEntries(opts: EntryPlanOptions = {}): EntryPlan {
  const entries = opts.entries ?? ROUTES
  const types = opts.types ?? FIELD_TYPES
  const only = opts.only?.length ? new Set(opts.only) : null
  if (only) {
    const known = new Set(entries.map((e) => e.id))
    const unknown = [...only].filter((id) => !known.has(id))
    if (unknown.length) throw new Error(`parity run: no routing entry named ${unknown.join(', ')}`)
  }
  const selected: PlannedEntry[] = []
  const refused: RefusedEntry[] = []
  for (const e of entries) {
    if (only && !only.has(e.id)) continue
    if (e.pin) {
      refused.push({ id: e.id, why: `pinned to JSON (${e.pin}): the question itself must read JSON, so no run can move it` })
      continue
    }
    if (!e.queries.length) {
      refused.push({ id: e.id, why: 'no text listed: built at run time, so there is nothing to compare' })
      continue
    }
    const unreadable = e.queries.map((q) => querySpec(q)).find((s): s is { ok: false; why: string } => !s.ok)
    if (unreadable) {
      refused.push({ id: e.id, why: `this runner cannot compare its rows: ${unreadable.why}` })
      continue
    }
    const why = ineligibility(e, types)
    if (why.length && !opts.forceIneligible) {
      refused.push({ id: e.id, why: `not eligible — ${why.join('; ')}` })
      continue
    }
    selected.push({ id: e.id, mode: why.length ? 'measurement' : 'evidence', queries: e.queries, ineligible: why })
  }
  return { selected, refused }
}

// ── The cost floor ──────────────────────────────────────────────────────────

export interface ParityCostBasis {
  rowsPerHour: number
  /** JSON CPU-s per 1,000 rows for a plain summarize. Default: the audit's measured sentinel shape. */
  cpuPer1kRows: number
}

export const DEFAULT_PARITY_COST_BASIS: ParityCostBasis = Object.freeze({
  rowsPerHour: DEFAULT_COST_BASIS.rowsPerHour,
  cpuPer1kRows: DEFAULT_COST_BASIS.sentinelCpuPer1kRows,
})

export interface ParityCostFloor {
  json: number
  parquet: number
  total: number
  jobs: { completeness: number; control: number; queries: number }
  lines: string[]
}

/**
 * What the run is expected to bill at the least, BEFORE it runs — assuming
 * every window is proven complete and comparable, so every job is submitted.
 * A FLOOR from one measured JSON shape, and the Parquet half is an ASSUMPTION:
 * no Parquet coefficient has been measured by this project, so the JSON one is
 * used, labelled as such. The completeness jobs are left out: their cost is
 * unmeasured, and the one `cribl_metrics` figure this project has (≈2,000 CPU-s
 * for a 48-hour read) grows faster than the window, so scaling it down is not a
 * floor.
 */
export function parityCostFloor(windows: readonly ParityWindow[], selected: readonly PlannedEntry[], basis: ParityCostBasis = DEFAULT_PARITY_COST_BASIS): ParityCostFloor {
  const texts = selected.reduce((s, e) => s + e.queries.length, 0)
  const perSide = windows.reduce((s, w) => s + ((w.latest - w.earliest) / 3600) * (basis.rowsPerHour / 1000) * basis.cpuPer1kRows * (1 + texts), 0)
  const r = (x: number) => Math.round(x).toLocaleString('en-US')
  const m = MEASURED_RUN
  const jobs = { completeness: windows.length, control: 2 * windows.length, queries: 2 * texts * windows.length }
  return {
    json: perSide,
    parquet: perSide,
    total: perSide * 2,
    jobs,
    lines: [
      `Jobs if every window is proven complete and comparable: ${jobs.completeness} completeness checks (cribl_metrics), ${jobs.control} control counts, ${jobs.queries} query runs (${texts} text${texts === 1 ? '' : 's'} × 2 datasets × ${windows.length} windows).`,
      `Basis: the Phase 8.0c sentinel jobs measured on the ${m.feed}, ${m.date} (report ${m.report}), ${basis.cpuPer1kRows.toFixed(3)} CPU-s per 1,000 rows on JSON, and an intake of ${r(basis.rowsPerHour)} rows/hour. Those were plain counts; a grouped panel query is assumed to cost no less.`,
      `JSON side: ≈${r(perSide)} CPU-s.`,
      `Parquet side: ≈${r(perSide)} CPU-s — an ASSUMPTION. No Parquet coefficient has been measured; this reuses the JSON one. The one Parquet figure this project has (D-10, ≈4.7 CPU-s per MB read against ≈0.16 on JSON) suggests Parquet may bill far more per row.`,
      `Completeness checks: NOT included. Their cost is unmeasured, and a cribl_metrics read is not cheap (≈2,000 CPU-s for 48 hours, 2026-09-24).`,
      `Expected at least ≈${r(perSide * 2)} CPU-s — a FLOOR, not a bound. Budget ≈${r(perSide * 2 * COST_MARGIN)} CPU-s (${COST_MARGIN}×); that is not a bound either. The running-time cap limits wall time only, and Cribl has no CPU cap.`,
    ],
  }
}

// ── Running ─────────────────────────────────────────────────────────────────

/** One submitted job, as scripts/parity-run-job.mjs records it (the audit's job record). */
export interface ParityJobRecord {
  purpose: string
  window: ParityWindow & { label?: string }
  query: string
  jobId: string | null
  submittedAt: string | null
  status: string
  billableCPUSeconds: number | null
  costRead?: string | null
  elapsedMs: number | null
  error: string | null
  cancel: string | null
}

export interface ParityRunDeps {
  /** Submit one job and read all its rows; `rows` null when no complete answer was read. Never throws. */
  submit(purpose: string, window: RunWindow, query: string): Promise<{ job: ParityJobRecord; rows: Row[] | null }>
  /** Epoch seconds, read when a completeness answer arrives. */
  nowSec(): number
  log(line: string): void
}

export type WindowStatus = 'compared' | 'skipped' | 'incomparable'

export interface WindowResult {
  window: RunWindow
  status: WindowStatus
  /** Why it was skipped or incomparable; null when compared. */
  why: string | null
  completeness: { complete: boolean; why: string | null; checkedAt: number | null; buckets: BucketRecord[] }
  control: ColumnResult | null
  drift: number | null
}

export interface TextResult {
  query: string
  /** What was submitted on JSON (`comparisonText`); the Parquet side moves only its dataset selector. */
  submitted: string
  perWindow: (QueryComparison & { window: RunWindow })[]
}

export interface RunResult {
  datasets: { json: string; parquet: string }
  windows: WindowResult[]
  entries: { id: string; mode: EntryMode; ineligible: string[]; texts: TextResult[] }[]
  jobs: ParityJobRecord[]
}

const CONTROL = (() => {
  const col = parityColumns(PARITY_CHECKS).find((c) => c.role === 'control')
  const check = PARITY_CHECKS.find((c) => c.id === col?.check)
  if (!col || !check) throw new Error('parity run: no control check')
  return { col, query: check.query }
})()

/** The control count's text, as written. */
export const PARITY_CONTROL_QUERY = CONTROL.query

/** Run the plan, one job at a time. Every stop is recorded, never thrown. */
export async function executeParityRun(windows: readonly RunWindow[], selected: readonly PlannedEntry[], deps: ParityRunDeps): Promise<RunResult> {
  const pq = PARITY_PARQUET_DATASET
  const jobs: ParityJobRecord[] = []
  const submit = async (purpose: string, w: RunWindow, query: string) => {
    const r = await deps.submit(purpose, w, query)
    jobs.push(r.job)
    return r.rows
  }
  const entries: RunResult['entries'] = selected.map((e) => ({ id: e.id, mode: e.mode, ineligible: e.ineligible, texts: e.queries.map((query) => ({ query, submitted: comparisonText(query), perWindow: [] })) }))
  const results: WindowResult[] = []

  let stopped: string | null = null
  for (const w of windows) {
    deps.log(`Window ${w.label}`)
    if (stopped) {
      results.push({ window: w, status: 'skipped', why: `not run: ${stopped}`, completeness: { complete: false, why: 'not run', checkedAt: null, buckets: [] }, control: null, drift: null })
      deps.log('  skipped: the run had stopped')
      continue
    }
    const rows = await submit('completeness', w, COMPLETENESS_QUERY)
    if (!rows) {
      results.push({ window: w, status: 'skipped', why: 'the completeness check gave no answer, so nothing proves the Parquet copy complete', completeness: { complete: false, why: 'no answer', checkedAt: null, buckets: [] }, control: null, drift: null })
      deps.log('  skipped: the completeness check gave no answer')
      continue
    }
    const checkedAt = deps.nowSec()
    const buckets = bucketRecords(rows, checkedAt)
    if (rows.length && !buckets.length) {
      stopped = `the completeness check answered ${rows.length} row${rows.length === 1 ? '' : 's'} with no bucket this can read (no ${COMPLETENESS_BUCKET_COLUMN} or _time), so no window could be proven complete, and the run stopped rather than bill another check`
      results.push({ window: w, status: 'skipped', why: stopped, completeness: { complete: false, why: stopped, checkedAt, buckets }, control: null, drift: null })
      deps.log(`  skipped, and the run stopped: ${stopped}`)
      continue
    }
    const verdict = windowCompleteness(w, checkedAt, new Map(buckets.map((b) => [b.start, b])))
    const completeness = { complete: verdict.complete, why: verdict.why, checkedAt, buckets }
    if (!verdict.complete) {
      results.push({ window: w, status: 'skipped', why: `not proven complete: ${verdict.why}`, completeness, control: null, drift: null })
      deps.log(`  skipped, not proven complete: ${verdict.why}`)
      continue
    }

    const cj = await submit('control, JSON', w, CONTROL.query)
    const cp = await submit('control, Parquet', w, retarget(CONTROL.query, pq))
    const control = compareColumn(CONTROL.col, cj?.[0] ?? null, cp?.[0] ?? null)
    if (control.verdict !== 'agrees') {
      const why = control.verdict === 'notrun'
        ? `the control count got no answer from ${control.missing.join(' and ')}`
        : control.verdict === 'unexercised'
          ? 'the control count was empty on both sides'
          : `the control count disagreed (${control.json} on JSON, ${control.parquet} on Parquet), so the two datasets did not hold the same records`
      results.push({ window: w, status: 'incomparable', why, completeness, control, drift: null })
      deps.log(`  incomparable: ${why}`)
      continue
    }
    const drift = Math.abs((control.parquet ?? 0) - (control.json as number)) / Math.abs(control.json as number)
    results.push({ window: w, status: 'compared', why: null, completeness, control, drift })

    for (const e of entries) {
      for (const t of e.texts) {
        const j = await submit(`${e.id}, JSON`, w, t.submitted)
        const p = await submit(`${e.id}, Parquet`, w, retarget(t.submitted, pq))
        const cmp = compareQueryRows(t.query, j, p, drift)
        t.perWindow.push({ ...cmp, window: w })
        deps.log(`  ${e.id}: ${cmp.verdict}`)
      }
    }
  }
  return { datasets: { json: PARITY_JSON_DATASET, parquet: pq }, windows: results, entries, jobs }
}

// ── Judging an entry, and the evidence it earns ─────────────────────────────

export type EntryVerdict = 'evidence' | 'failed' | 'not-enough' | 'measured-only'

export interface EntryOutcome {
  id: string
  mode: EntryMode
  verdict: EntryVerdict
  why: string
  /** Per window: pass only when every text passed. */
  perWindow: { window: RunWindow; verdict: QueryVerdict | 'skipped' }[]
  /** Exactly `RouteEvidence`: paste into the entry in routing/table.ts. Null unless `verdict` is `evidence`. */
  evidence: RouteEvidence | null
  texts: TextResult[]
}

const WORST: readonly (QueryVerdict | 'skipped')[] = ['fail', 'notrun', 'incomparable', 'skipped', 'unexercised', 'pass']

/**
 * One entry's verdict across the run. `evidence` only for an eligible entry
 * whose every text passed in at least three windows at different UTC hours
 * and failed in none — and only if `evidenceProblems` accepts the object as
 * built, so what is pasted is what the table will accept.
 */
export function entryOutcome(entry: RunResult['entries'][number], windows: readonly WindowResult[], reportPath: string, date: string): EntryOutcome {
  const perWindow = windows.map((wr) => {
    if (wr.status !== 'compared') return { window: wr.window, verdict: 'skipped' as const }
    const vs = entry.texts.map((t) => t.perWindow.find((c) => c.window.earliest === wr.window.earliest)?.verdict ?? 'notrun')
    const worst = WORST.find((v) => vs.includes(v as QueryVerdict)) ?? 'notrun'
    return { window: wr.window, verdict: worst }
  })
  const passing = perWindow.filter((p) => p.verdict === 'pass').map((p) => ({ earliest: p.window.earliest, latest: p.window.latest }))
  const candidate: RouteEvidence = { report: reportPath, windows: passing, date }
  const failedIn = perWindow.filter((p) => p.verdict === 'fail').length
  const base = { id: entry.id, mode: entry.mode, perWindow, texts: entry.texts }
  if (failedIn) return { ...base, verdict: 'failed', why: `failed in ${failedIn} window${failedIn === 1 ? '' : 's'}: it stays on JSON`, evidence: null }
  if (entry.mode === 'measurement') {
    return { ...base, verdict: 'measured-only', why: `measured only (--force-ineligible): not eligible — ${entry.ineligible.join('; ')}. A measurement of an ineligible text is never evidence.`, evidence: null }
  }
  const problems = evidenceProblems(candidate)
  if (problems.length) return { ...base, verdict: 'not-enough', why: `passed in ${passing.length} window${passing.length === 1 ? '' : 's'}, which is not evidence: it ${problems.join('; ')}`, evidence: null }
  return { ...base, verdict: 'evidence', why: `passed in ${passing.length} windows at different UTC hours and failed in none`, evidence: candidate }
}

// ── The report ──────────────────────────────────────────────────────────────

export interface ParityRunReport {
  kind: 'phase-8.0e parity run'
  referenceAt: string
  referenceFrom: '--at' | 'run start'
  ranAt: string
  finishedAt: string
  /** Where this report is kept — the `report` every evidence object names. */
  reportPath: string
  datasets: { json: string; parquet: string }
  capSeconds: number
  settleSeconds: number
  estimate: ParityCostFloor
  refused: RefusedEntry[]
  windows: WindowResult[]
  entries: EntryOutcome[]
  /** entry id → the object to paste as that entry's `evidence`. Only entries that earned one. */
  evidence: Record<string, RouteEvidence>
  jobs: ParityJobRecord[]
  billed: { known: number; knownJobs: number; unknownJobs: number; complete: boolean }
  note: string
}

export interface ReportMeta {
  referenceAt: string
  referenceFrom: '--at' | 'run start'
  ranAt: string
  finishedAt: string
  reportPath: string
  capSeconds: number
  estimate: ParityCostFloor
  refused: RefusedEntry[]
}

export function buildParityReport(run: RunResult, meta: ReportMeta): ParityRunReport {
  const date = meta.ranAt.slice(0, 10)
  const entries = run.entries.map((e) => entryOutcome(e, run.windows, meta.reportPath, date))
  const created = run.jobs.filter((j) => j.jobId !== null)
  const known = created.filter((j) => j.billableCPUSeconds !== null)
  return {
    kind: 'phase-8.0e parity run',
    ...meta,
    datasets: run.datasets,
    settleSeconds: COMPLETENESS_SETTLE_SECONDS,
    windows: run.windows,
    entries,
    evidence: Object.fromEntries(entries.filter((e) => e.evidence).map((e) => [e.id, e.evidence!])),
    jobs: run.jobs,
    billed: {
      known: known.reduce((s, j) => s + (j.billableCPUSeconds ?? 0), 0),
      knownJobs: known.length,
      unknownJobs: created.length - known.length,
      complete: known.length === created.length,
    },
    note: 'This report routes nothing. To move an entry, paste its `evidence` object into that entry in src/cribl/routing/table.ts with `target: \'parquet\'`, keep this report where `reportPath` says, and let routing/table.test.ts and review judge the change.',
  }
}

/** The report's file name, without extension: the reference minute and the run's start second. */
export function parityReportStem(referenceAt: string, ranAt: string): string {
  const c = (s: string, to: number) => s.slice(0, to).replace(/[:-]/g, '')
  return `parity-run-ref${c(referenceAt, 16)}Z-ran${c(ranAt, 19)}Z`
}

/** The Markdown half of the report. */
export function renderParityMarkdown(r: ParityRunReport): string {
  const out: string[] = []
  out.push('# Parity run (Phase 8.0e)', '')
  out.push(`Taken ${r.ranAt} to ${r.finishedAt}: \`${r.datasets.json}\` against \`${r.datasets.parquet}\`. Running-time cap ${r.capSeconds} s per job. Windows measured back from ${r.referenceAt} (${r.referenceFrom}), each ending at least ${r.settleSeconds} s before its completeness check.`, '')
  out.push(`**This report routes nothing.** ${r.note}`, '')
  out.push('## Windows', '')
  out.push('| Window | Status | Why | Control (JSON → Parquet) |', '|---|---|---|---|')
  for (const w of r.windows) out.push(`| ${w.window.label} | ${w.status} | ${w.why ?? '—'} | ${w.control ? `${w.control.json ?? '—'} → ${w.control.parquet ?? '—'}` : '—'} |`)
  out.push('', '## Entries', '')
  out.push('| Entry | Mode | Verdict | Per window | Why |', '|---|---|---|---|---|')
  for (const e of r.entries) out.push(`| \`${e.id}\` | ${e.mode} | ${e.verdict} | ${e.perWindow.map((p) => p.verdict).join(', ')} | ${e.why} |`)
  for (const e of r.entries) {
    for (const t of e.texts) {
      out.push('', `### \`${e.id}\``, '', '```kql', t.query, '```', '')
      if (t.submitted !== t.query) out.push(`Submitted with its limit raised, and compared at its own N: \`${t.submitted}\``, '')
      for (const c of t.perWindow) out.push(`- ${c.window.label}: **${c.verdict}** (rows ${c.rows.json ?? '—'} → ${c.rows.parquet ?? '—'}). ${c.sentence}`)
    }
  }
  const ids = Object.keys(r.evidence)
  out.push('', '## Evidence to paste', '')
  if (!ids.length) out.push('None: no entry earned evidence in this run.')
  for (const id of ids) out.push(`\`${id}\`:`, '', '```json', JSON.stringify(r.evidence[id], null, 2), '```', '')
  if (r.refused.length) {
    out.push('', '## Not run', '')
    for (const x of r.refused) out.push(`- \`${x.id}\`: ${x.why}`)
  }
  out.push('', '## Cost', '')
  for (const l of r.estimate.lines) out.push(`- ${l}`)
  out.push(
    `- Billed: ${Math.round(r.billed.known).toLocaleString('en-US')} CPU-s over ${r.billed.knownJobs} job${r.billed.knownJobs === 1 ? '' : 's'}` +
      (r.billed.complete ? '.' : ` — INCOMPLETE: ${r.billed.unknownJobs} job${r.billed.unknownJobs === 1 ? '' : 's'} never reported a cost, which is not 0.`),
  )
  return out.join('\n')
}
