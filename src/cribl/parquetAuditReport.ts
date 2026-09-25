// Reading the Phase 8.0b/8.0c audit: windows, the cost estimate printed before
// anything runs, and the type, density and sentinel tables built from the rows.
//
// Pure. No network, no clock (every function takes its time as an argument),
// no React. `scripts/parquet-audit.mjs` is the only caller: it submits the
// frozen queries in src/queries/parquetAudit.ts and hands the rows here. The app
// never imports this module, and parquetAudit.test.ts holds that.
//
// The verdicts are deliberately narrow. The report says what the JSON dataset
// held over the windows it read, per field; it does not decide a rewrite. A
// field with zero real sentinels is ELIGIBLE for the portable rewrite (design
// §2, form R) on this install, over these windows — and the design's R4 says to
// audit again per release and per proof install, never on a timer.

import {
  CAST_CHECK_FIELDS,
  CENSUS_COLUMNS_FIELDS,
  CENSUS_CONTROLS,
  DENSITY_CHECKS,
  DENSITY_SCOPES,
  MEASURED_TYPES,
  SENTINEL_FIELDS,
  TYPED_BY_CODE,
  type SentinelType,
} from '../queries/parquetAudit'

export type Row = Record<string, unknown>

// ── Windows ─────────────────────────────────────────────────────────────────

export interface AuditWindow {
  /** Epoch seconds, inclusive. */
  earliest: number
  /** Epoch seconds. */
  latest: number
  label: string
}

export interface AuditWindowOptions {
  /** Minutes the newest window ends before `nowSec`, so landing lag cannot shorten it. */
  lagMinutes?: number
  censusMinutes?: number
  sentinelMinutes?: number
  /** How many hours before the newest window each sentinel window ends. */
  sentinelOffsetsHours?: readonly number[]
}

export const DEFAULT_WINDOWS: Required<AuditWindowOptions> = Object.freeze({
  lagMinutes: 10,
  censusMinutes: 60,
  sentinelMinutes: 15,
  sentinelOffsetsHours: Object.freeze([0, 6, 12]),
})

/**
 * Absolute windows, aligned to the minute: one census window (8.0b, 60 min as
 * D-10 s1 was) and one sentinel window per offset (8.0c, 15 min each, at
 * different hours so one hour's traffic mix cannot stand for the day's).
 */
export function auditWindows(nowSec: number, opts: AuditWindowOptions = {}): { census: AuditWindow; sentinel: AuditWindow[] } {
  const o = { ...DEFAULT_WINDOWS, ...opts }
  const end = Math.floor(nowSec / 60) * 60 - o.lagMinutes * 60
  const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z')
  const census = { earliest: end - o.censusMinutes * 60, latest: end, label: `${iso(end - o.censusMinutes * 60)} → ${iso(end)}` }
  const sentinel = o.sentinelOffsetsHours.map((h) => {
    const latest = end - h * 3600
    const earliest = latest - o.sentinelMinutes * 60
    return { earliest, latest, label: `${iso(earliest)} → ${iso(latest)}` }
  })
  return { census, sentinel }
}

// ── Cost ────────────────────────────────────────────────────────────────────

export interface CostBasis {
  /** Rows the dataset takes per hour. Default: D-10 s1, 1,050,992 rows in 60 min (demo feed, 2026-09-24). */
  rowsPerHour: number
  /** Billable CPU-s per 1,000 rows scanned on JSON. Default: ≈0.45, the 15-minute JSON scan coefficient. */
  cpuPer1kRows: number
}

export const DEFAULT_COST_BASIS: CostBasis = Object.freeze({ rowsPerHour: 1_050_992, cpuPer1kRows: 0.45 })

/** The multiplier on the estimate that the runner states as the figure to approve. */
export const COST_MARGIN = 2

export interface CostEstimate {
  census: number
  sentinel: number
  total: number
  /** `total × COST_MARGIN`: the figure a person approves by passing --run. */
  planFor: number
  lines: string[]
}

/**
 * What the run is expected to bill, in billable CPU-s, BEFORE it runs.
 *
 * An estimate, not a bound, and it says so: Cribl has no server-side CPU cap.
 * `max_running_time_per_search` bounds wall time only (the D-10 R4f query hit
 * its 120 s cap and billed 8,266 CPU-s anyway). The coefficient is a flat JSON
 * scan figure from a query with a handful of aggregates; these carry ~100–150,
 * so the runner asks approval for COST_MARGIN times the estimate.
 */
export function auditCostEstimate(windows: { census: AuditWindow; sentinel: AuditWindow[] }, basis: CostBasis = DEFAULT_COST_BASIS): CostEstimate {
  const cpu = (w: AuditWindow) => ((w.latest - w.earliest) / 3600) * basis.rowsPerHour / 1000 * basis.cpuPer1kRows
  const census = cpu(windows.census)
  const sentinel = windows.sentinel.reduce((s, w) => s + cpu(w), 0)
  const total = census + sentinel
  const r = (n: number) => Math.round(n).toLocaleString('en-US')
  return {
    census,
    sentinel,
    total,
    planFor: total * COST_MARGIN,
    lines: [
      `Basis: ${r(basis.rowsPerHour)} rows/hour × ${basis.cpuPer1kRows} billable CPU-s per 1,000 rows (flat JSON scan coefficient; demo-feed figures unless overridden).`,
      `8.0b census + density, ${Math.round((windows.census.latest - windows.census.earliest) / 60)} min: ≈${r(census)} CPU-s.`,
      `8.0c sentinels, ${windows.sentinel.length} × ${windows.sentinel.length ? Math.round((windows.sentinel[0].latest - windows.sentinel[0].earliest) / 60) : 0} min: ≈${r(sentinel)} CPU-s.`,
      `Expected ≈${r(total)} CPU-s. Plan for up to ≈${r(total * COST_MARGIN)} CPU-s (${COST_MARGIN}×: these queries carry far more aggregates than the coefficient's).`,
      'This is an estimate, not a bound: the running-time cap limits wall time only, and Cribl has no CPU cap. A query stopped by the cap is billed for what it used.',
    ],
  }
}

// ── 8.0b: types ─────────────────────────────────────────────────────────────

/** A census verdict. `number` means every present value's type name is numeric. */
export type CensusVerdict = 'absent' | 'string' | 'number' | 'mixed' | 'other'

/** Type names that count as numeric. Kept wide on purpose: `gettype`'s exact
 *  vocabulary is unmeasured here, and the names are printed in the report. */
const NUMERIC_TYPE = /^(int|long|real|double|decimal|number|float|integer)$/i

export interface CensusEntry {
  field: string
  present: number
  strings: number
  /** Lowest and highest type name among present values (`null` when none present). */
  lo: string | null
  hi: string | null
  verdict: CensusVerdict
  /** What the pipeline or a prior measurement says, where anything does. */
  expected: 'number' | 'string' | null
  /** False when the JSON reading contradicts `expected`. */
  agrees: boolean | null
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v !== '~' ? v : null)

function verdictOf(present: number, strings: number, lo: string | null, hi: string | null): CensusVerdict {
  if (present === 0) return 'absent'
  if (strings === present) return 'string'
  if (strings > 0) return 'mixed'
  if (lo !== null && hi !== null && NUMERIC_TYPE.test(lo) && NUMERIC_TYPE.test(hi)) return 'number'
  return 'other'
}

export function readTypeCensus(row: Row): CensusEntry[] {
  return CENSUS_COLUMNS_FIELDS.filter((f, i, all) => all.indexOf(f) === i).map((field) => {
    const present = num(row[`tn_${field}`])
    const strings = num(row[`ts_${field}`])
    const lo = str(row[`tlo_${field}`])
    const hi = str(row[`thi_${field}`])
    const verdict = verdictOf(present, strings, lo, hi)
    const expected = TYPED_BY_CODE[field]?.type ?? MEASURED_TYPES[field] ?? null
    const agrees = expected === null || verdict === 'absent' ? null : verdict === expected
    return { field, present, strings, lo, hi, verdict, expected, agrees }
  })
}

/**
 * Whether the census can be believed. The string control must read all
 * "string" and the numeric control must read as a number; otherwise `gettype`
 * answered in a vocabulary this reader does not know, and every verdict is
 * suspect.
 */
export function censusControls(census: readonly CensusEntry[]): { ok: boolean; why: string } {
  const s = census.find((e) => e.field === CENSUS_CONTROLS.string)
  const n = census.find((e) => e.field === CENSUS_CONTROLS.number)
  if (!s || s.verdict !== 'string') return { ok: false, why: `The string control \`${CENSUS_CONTROLS.string}\` read ${s ? `"${s.verdict}" (${s.lo}…${s.hi})` : 'nothing'}, not "string". Every verdict below is suspect.` }
  if (!n || n.verdict !== 'number') return { ok: false, why: `The numeric control \`${CENSUS_CONTROLS.number}\` read ${n ? `"${n.verdict}" (${n.lo}…${n.hi})` : 'nothing'}, not a number. Every verdict below is suspect.` }
  return { ok: true, why: `Controls hold: \`${s.field}\` reads "${s.hi}", \`${n.field}\` reads "${n.hi}".` }
}

/**
 * The type table the sentinel query takes, from a census: `number` or `string`
 * where the census is unambiguous and its controls held, `unknown` otherwise
 * (which emits both sentinel forms). Fields the census does not read keep what
 * the pipeline or a prior measurement says.
 */
export function censusTypeTable(census: readonly CensusEntry[]): Record<string, SentinelType> {
  const trusted = censusControls(census).ok
  const byField = new Map(census.map((e) => [e.field, e]))
  return Object.fromEntries(SENTINEL_FIELDS.map((f) => {
    const e = byField.get(f)
    if (trusted && e && (e.verdict === 'string' || e.verdict === 'number')) return [f, e.verdict]
    if (e && trusted && e.verdict !== 'absent') return [f, 'unknown']
    return [f, TYPED_BY_CODE[f]?.type ?? MEASURED_TYPES[f] ?? 'unknown']
  }))
}

// ── 8.0b: density ───────────────────────────────────────────────────────────

export interface DensityEntry {
  id: string
  field: string
  scope: string
  present: number
  of: number
  /** `present / of`, or null when the scope held no rows (no evidence). */
  share: number | null
}

export function readDensity(row: Row): DensityEntry[] {
  const rows = num(row.rows)
  return DENSITY_CHECKS.map((c) => {
    const of = c.scope === null ? rows : num(row[`d_${c.scope}`])
    const present = num(row[`d_${c.id}`])
    return {
      id: c.id,
      field: c.field,
      scope: c.scope === null ? 'all rows' : DENSITY_SCOPES[c.scope].words,
      present,
      of,
      share: of > 0 ? present / of : null,
    }
  })
}

// ── 8.0c: sentinels ─────────────────────────────────────────────────────────

export type SentinelVerdict =
  | 'no real sentinel (R eligible)'
  | 'real sentinels (P or J)'
  | 'not exercised'
  | 'type unresolved'

export interface SentinelEntry {
  field: string
  /** The type that decides which sentinel applies. */
  type: SentinelType
  /** The sentinel that applies: `""` for a string, `0` for a number, null when unresolved. */
  applies: '""' | '0' | null
  present: number
  /** Rows holding the applicable sentinel, summed over the windows (null when unresolved). */
  sentinels: number | null
  /** Per window: [present, `""` count or null, `0` count or null]. */
  perWindow: Array<[number, number | null, number | null]>
  verdict: SentinelVerdict
}

export function readSentinels(windows: readonly Row[], types: Readonly<Record<string, SentinelType>>): SentinelEntry[] {
  const opt = (r: Row, k: string): number | null => (k in r ? num(r[k]) : null)
  return SENTINEL_FIELDS.map((field) => {
    const type = types[field] ?? 'unknown'
    const perWindow = windows.map((r) => [num(r[`sn_${field}`]), opt(r, `se_${field}`), opt(r, `sz_${field}`)] as [number, number | null, number | null])
    const present = perWindow.reduce((s, w) => s + w[0], 0)
    const applies = type === 'string' ? '""' : type === 'number' ? '0' : null
    const col = applies === '""' ? 1 : applies === '0' ? 2 : null
    const counted = col === null ? null : perWindow.map((w) => w[col])
    const sentinels = counted === null || counted.some((c) => c === null) ? null : (counted as number[]).reduce((s, c) => s + c, 0)
    const verdict: SentinelVerdict =
      applies === null || sentinels === null ? 'type unresolved'
        : present === 0 ? 'not exercised'
          : sentinels === 0 ? 'no real sentinel (R eligible)'
            : 'real sentinels (P or J)'
    return { field, type, applies, present, sentinels, perWindow, verdict }
  })
}

// ── The report ──────────────────────────────────────────────────────────────

export interface AuditJob {
  purpose: string
  window: AuditWindow
  query: string
  jobId: string | null
  status: string
  billableCPUSeconds: number | null
  elapsedMs: number | null
  error: string | null
}

export interface AuditReport {
  takenAt: string
  dataset: string
  capSeconds: number
  estimate: CostEstimate
  jobs: AuditJob[]
  census: CensusEntry[] | null
  controls: { ok: boolean; why: string } | null
  density: DensityEntry[] | null
  sentinelTypes: Record<string, SentinelType>
  sentinels: SentinelEntry[] | null
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(2)} %`)
const n = (x: number | null) => (x === null ? '—' : x.toLocaleString('en-US'))

/** The Markdown half of the report. The JSON half is the `AuditReport` itself. */
export function renderAuditMarkdown(r: AuditReport): string {
  const out: string[] = []
  out.push(`# Parquet read-side audit (Phase 8.0b / 8.0c)`, '')
  out.push(`Taken ${r.takenAt} on \`${r.dataset}\` (JSON). Pinned: measurement. Running-time cap ${r.capSeconds} s per job.`, '')
  out.push('Demo-feed or production figures alike, these describe THIS install over THESE windows. Nothing here gates a phase; the design (R4) says to audit again per release and per proof install.', '')

  out.push('## Jobs', '', '| purpose | window (UTC) | job | status | billable CPU-s | elapsed |', '|---|---|---|---|---|---|')
  for (const j of r.jobs) {
    out.push(`| ${j.purpose} | ${j.window.label} | ${j.jobId ?? '—'} | ${j.status}${j.error ? `: ${j.error.replace(/\|/g, '/')}` : ''} | ${n(j.billableCPUSeconds)} | ${j.elapsedMs === null ? '—' : `${(j.elapsedMs / 1000).toFixed(1)} s`} |`)
  }
  const spent = r.jobs.reduce((s, j) => s + (j.billableCPUSeconds ?? 0), 0)
  out.push('', `Billed in total: ${n(Math.round(spent))} CPU-s, against an estimate of ≈${n(Math.round(r.estimate.total))}.`, '')

  out.push('## Type table (8.0b)', '')
  if (!r.census) out.push('Not read: the census job did not complete.', '')
  else {
    if (r.controls) out.push(r.controls.ok ? r.controls.why : `**${r.controls.why}**`, '')
    out.push('| field | present | string-typed | type names | verdict | pipeline / prior says | agrees |', '|---|---|---|---|---|---|---|')
    for (const e of r.census) {
      const names = e.lo === null ? '—' : e.lo === e.hi ? e.lo : `${e.lo} … ${e.hi}`
      const role = CAST_CHECK_FIELDS.includes(e.field) || e.field === CENSUS_CONTROLS.number ? ' (check)' : ''
      out.push(`| \`${e.field}\`${role} | ${n(e.present)} | ${n(e.strings)} | ${names} | ${e.verdict} | ${e.expected ?? '—'} | ${e.agrees === null ? '—' : e.agrees ? 'yes' : '**no**'} |`)
    }
    out.push('')
  }

  out.push('## Density table (8.0b)', '')
  if (!r.density) out.push('Not read: the census job did not complete.', '')
  else {
    out.push('| check | field | within | present | of | share |', '|---|---|---|---|---|---|')
    for (const d of r.density) out.push(`| ${d.id} | \`${d.field}\` | ${d.scope} | ${n(d.present)} | ${n(d.of)} | ${pct(d.share)} |`)
    out.push('')
  }

  out.push('## Sentinel table (8.0c)', '')
  if (!r.sentinels) out.push('Not read: no sentinel job completed.', '')
  else {
    out.push('The sentinel that applies follows the type: `""` for a string, `0` for a number. A field whose type the census left unresolved shows both counts and no verdict.', '')
    out.push('| field | type | applies | present | real sentinels | per window [present / "" / 0] | verdict |', '|---|---|---|---|---|---|---|')
    for (const s of r.sentinels) {
      const pw = s.perWindow.map(([p, e, z]) => `${n(p)} / ${n(e)} / ${n(z)}`).join('; ')
      out.push(`| \`${s.field}\` | ${s.type} | ${s.applies ?? '—'} | ${n(s.present)} | ${n(s.sentinels)} | ${pw} | ${s.verdict} |`)
    }
    out.push('')
  }

  out.push('## Queries, exactly as submitted (after the cap prefix)', '')
  const seen = new Set<string>()
  for (const j of r.jobs) {
    if (seen.has(j.query)) continue
    seen.add(j.query)
    out.push(`${j.purpose}:`, '', '```kql', j.query, '```', '')
  }
  return out.join('\n')
}
