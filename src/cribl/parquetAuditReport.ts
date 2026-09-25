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
  GETTYPE_COLUMN,
  GETTYPE_NAMES,
  MEASURED_TYPES,
  NUMERIC_GETTYPE_NAMES,
  SENTINEL_FIELDS,
  STATIC_FIELD_TYPES,
  TYPED_BY_CODE,
  type GettypeName,
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

/**
 * The numeric-only census's window: one 15-minute census, no sentinel windows.
 * 15 minutes, not 60, because every field it types is on thousands of rows in
 * any quarter hour of the measured feed (the scarcest, `http_server_ms`, on
 * ≈3,400 per 15 minutes on 2026-09-25) and the census bills per row.
 */
export const NUMERIC_CENSUS_WINDOW: AuditWindowOptions = Object.freeze({ censusMinutes: 15, sentinelOffsetsHours: Object.freeze([]) })

// ── Cost ────────────────────────────────────────────────────────────────────

/**
 * The one measured run the estimate is derived from: the first real audit, on
 * the demo feed, 2026-09-25 (report
 * `parquet-audit-ref20260925T1719Z-ran20260925T171950Z`, in the main checkout's
 * gitignored `.dev/parquet-audit/`). Figures as billed, read from the job
 * metrics after the run (the runner itself printed "unknown": it read too soon).
 *
 * The two job SHAPES cost very differently per row, which is why a single flat
 * coefficient under-priced the run 7× (≈828 printed against ≈5,747 billed):
 *   - the wide census (28 fields × `gettype` probes, plus 11 density counts)
 *     billed 5,457 CPU-s over 1,049,258 rows — ≈5.2 CPU-s per 1,000 rows;
 *   - the sentinels (plain `count` / `countif(f==…)`, no `gettype`) billed 51,
 *     111 and 128 over 786,522 rows in three 15-minute windows — ≈0.37 per 1,000.
 * Demo-feed magnitudes never gate anything (I-D24); they only set the floor the
 * runner prints before a person decides.
 */
export const MEASURED_RUN = Object.freeze({
  date: '2026-09-25',
  report: 'parquet-audit-ref20260925T1719Z-ran20260925T171950Z',
  feed: 'demo feed',
  census: Object.freeze({ minutes: 60, rows: 1_049_258, fields: 28, billed: 5_457 }),
  sentinel: Object.freeze({ minutes: 15, rows: Object.freeze([260_906, 262_800, 262_816]), billed: Object.freeze([51, 111, 128]) }),
})

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0)

export interface CostBasis {
  /** Rows the dataset takes per hour. Default: the measured run's census hour, 1,049,258 rows. */
  rowsPerHour: number
  /**
   * Census shape: billable CPU-s per 1,000 rows per census field (a field the
   * census `gettype`-probes). Default: 5,457 ÷ 1,049.258 ÷ 28 ≈ 0.186, the
   * measured wide census; its density counts are folded in.
   */
  censusCpuPer1kRowsPerField: number
  /** Sentinel shape: billable CPU-s per 1,000 rows. Default: 290 ÷ 786.522 ≈ 0.369, the measured sentinels. */
  sentinelCpuPer1kRows: number
}

export const DEFAULT_COST_BASIS: CostBasis = Object.freeze({
  rowsPerHour: MEASURED_RUN.census.rows * (60 / MEASURED_RUN.census.minutes),
  censusCpuPer1kRowsPerField: MEASURED_RUN.census.billed / (MEASURED_RUN.census.rows / 1000) / MEASURED_RUN.census.fields,
  sentinelCpuPer1kRows: sum(MEASURED_RUN.sentinel.billed) / (sum(MEASURED_RUN.sentinel.rows) / 1000),
})

/** The multiplier on the floor that the runner states as a budget. Still not a bound. */
export const COST_MARGIN = 2

/** Which census the run submits: the wide one (every census field + density) or the numeric-only one. */
export type CensusMode = 'wide' | 'numeric'

export interface CostEstimate {
  census: number
  sentinel: number
  /** A FLOOR: what the measured run's coefficients give for these windows. */
  total: number
  /** `total × COST_MARGIN`: the budget a person approves by passing --run. Not a bound either. */
  planFor: number
  lines: string[]
}

/**
 * What the run is expected to bill, in billable CPU-s, BEFORE it runs.
 *
 * A FLOOR, not a bound, and it says so. It is derived per job shape from one
 * measured run (`MEASURED_RUN`), and scales by rows and, for a census, by the
 * number of fields it probes — an assumption for any census narrower than the
 * one measured, and for the per-type census, which makes four `gettype` calls
 * per field where the measured one made three. Cribl has no server-side CPU cap:
 * `max_running_time_per_search` bounds wall time only (the D-10 R4f query hit
 * its 120 s cap and billed 8,266 CPU-s anyway).
 */
export function auditCostEstimate(
  windows: { census: AuditWindow; sentinel: AuditWindow[] },
  basis: CostBasis = DEFAULT_COST_BASIS,
  censusFields: number = CENSUS_COLUMNS_FIELDS.length,
  mode: CensusMode = 'wide',
): CostEstimate {
  const rows1k = (w: AuditWindow) => ((w.latest - w.earliest) / 3600) * basis.rowsPerHour / 1000
  const census = rows1k(windows.census) * basis.censusCpuPer1kRowsPerField * censusFields
  const sentinel = windows.sentinel.reduce((s, w) => s + rows1k(w) * basis.sentinelCpuPer1kRows, 0)
  const total = census + sentinel
  const r = (n: number) => Math.round(n).toLocaleString('en-US')
  const m = MEASURED_RUN
  const minutes = (w: AuditWindow) => Math.round((w.latest - w.earliest) / 60)
  return {
    census,
    sentinel,
    total,
    planFor: total * COST_MARGIN,
    lines: [
      `Basis: measured on the ${m.feed}, ${m.date} (report ${m.report}). The ${m.census.minutes}-min wide census over ${r(m.census.rows)} rows billed ${r(m.census.billed)} CPU-s (${basis.censusCpuPer1kRowsPerField.toFixed(3)} CPU-s per 1,000 rows per census field, ${m.census.fields} fields); ` +
        `${m.sentinel.billed.length} × ${m.sentinel.minutes}-min sentinel windows over ${r(sum(m.sentinel.rows))} rows billed ${m.sentinel.billed.join(', ')} CPU-s (${basis.sentinelCpuPer1kRows.toFixed(3)} per 1,000 rows). Intake assumed ${r(basis.rowsPerHour)} rows/hour.`,
      mode === 'wide'
        ? `8.0b census + density, ${minutes(windows.census)} min, ${censusFields} fields: ≈${r(census)} CPU-s.`
        : `8.0b numeric-only census, ${minutes(windows.census)} min, ${censusFields} fields, no density: ≈${r(census)} CPU-s (scaled per field from the wide census; a census this narrow is unmeasured).`,
      windows.sentinel.length
        ? `8.0c sentinels, ${windows.sentinel.length} × ${minutes(windows.sentinel[0])} min: ≈${r(sentinel)} CPU-s.`
        : '8.0c sentinels: none submitted.',
      mode === 'wide'
        ? `Expected at least ≈${r(total)} CPU-s — a floor from one measured run. Budget ≈${r(total * COST_MARGIN)} CPU-s (${COST_MARGIN}×); that is not a bound either.`
        : `Estimate ≈${r(total)} CPU-s for an UNMEASURED shape: neither a floor nor a bound. Per-field scaling drops the per-row scan cost that does not shrink with fewer fields (pushing the true cost up) and the density counts this mode does not run (pushing the scaled figure up). Budget ≈${r(total * COST_MARGIN)} CPU-s (${COST_MARGIN}×).`,
      mode === 'wide'
        ? 'This is a floor, not a bound: the census now makes four gettype calls per field where the measured run made three, another feed or hour can bill more, the running-time cap limits wall time only, and Cribl has no CPU cap. A query stopped by the cap is billed for what it used.'
        : 'Not a bound: another feed or hour can bill more, the running-time cap limits wall time only, and Cribl has no CPU cap. A query stopped by the cap is billed for what it used. This run measures the narrow shape for next time.',
    ],
  }
}

// ── 8.0b: types ─────────────────────────────────────────────────────────────

/**
 * A census verdict, from which per-type counts are non-zero:
 *   `string`  every present value counted "string";
 *   `number`  every present value counted as one of `NUMERIC_GETTYPE_NAMES`
 *             (a mix of int and real is still a number — `names` shows the mix);
 *   `mixed`   more than one of {string, number, uncounted} — class T;
 *   `other`   present values none of the counted names account for.
 */
export type CensusVerdict = 'absent' | 'string' | 'number' | 'mixed' | 'other'

export interface CensusEntry {
  field: string
  present: number
  /** Present values per counted `gettype` name. */
  counts: Record<GettypeName, number>
  /** Present values no counted name accounts for: `present − Σ counts`, never below 0. */
  other: number
  /** The non-zero kinds, in `GETTYPE_NAMES` order then `other`, e.g. ["int", "real"]. */
  names: string[]
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

function verdictOf(present: number, counts: Record<GettypeName, number>, other: number): CensusVerdict {
  if (present === 0) return 'absent'
  const strings = counts.string > 0
  const numbers = NUMERIC_GETTYPE_NAMES.some((t) => counts[t] > 0)
  const uncounted = other > 0
  const kinds = [strings, numbers, uncounted].filter(Boolean).length
  if (kinds > 1) return 'mixed'
  if (strings) return 'string'
  if (numbers) return 'number'
  return 'other'
}

/**
 * The type table from a census row. `fields` is which census ran: the wide one
 * (`CENSUS_COLUMNS_FIELDS`, the default) or the numeric-only one
 * (`NUMERIC_CENSUS_FIELDS`). A column the row does not hold reads 0.
 */
export function readTypeCensus(row: Row, fields: readonly string[] = CENSUS_COLUMNS_FIELDS): CensusEntry[] {
  return fields.filter((f, i, all) => all.indexOf(f) === i).map((field) => {
    const present = num(row[`tn_${field}`])
    const counts = Object.fromEntries(GETTYPE_NAMES.map((t) => [t, num(row[`${GETTYPE_COLUMN[t]}_${field}`])])) as Record<GettypeName, number>
    const other = Math.max(0, present - GETTYPE_NAMES.reduce((s, t) => s + counts[t], 0))
    const names = [...GETTYPE_NAMES.filter((t) => counts[t] > 0), ...(other > 0 ? ['other'] : [])]
    const verdict = verdictOf(present, counts, other)
    const expected = TYPED_BY_CODE[field]?.type ?? MEASURED_TYPES[field] ?? null
    const agrees = expected === null || verdict === 'absent' ? null : verdict === expected
    return { field, present, counts, other, names, verdict, expected, agrees }
  })
}

/** "int 55,107 · real 3", or "—" when nothing is present. */
export function typeCountsText(e: CensusEntry): string {
  const parts = [
    ...GETTYPE_NAMES.filter((t) => e.counts[t] > 0).map((t) => `${t} ${e.counts[t].toLocaleString('en-US')}`),
    ...(e.other > 0 ? [`uncounted ${e.other.toLocaleString('en-US')}`] : []),
  ]
  return parts.length ? parts.join(' · ') : '—'
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
  if (!s || s.verdict !== 'string') return { ok: false, why: `The string control \`${CENSUS_CONTROLS.string}\` read ${s ? `"${s.verdict}" (${typeCountsText(s)})` : 'nothing'}, not "string". Every verdict below is suspect.` }
  if (!n || n.verdict !== 'number') return { ok: false, why: `The numeric control \`${CENSUS_CONTROLS.number}\` read ${n ? `"${n.verdict}" (${typeCountsText(n)})` : 'nothing'}, not a number. Every verdict below is suspect.` }
  return { ok: true, why: `Controls hold: \`${s.field}\` reads ${s.names.join(' + ')}, \`${n.field}\` reads ${n.names.join(' + ')}.` }
}

/**
 * The type table the sentinel query takes, from a census: `number` or `string`
 * where the census is unambiguous and its controls held, `unknown` otherwise
 * (which emits both sentinel forms). Fields the census does not read keep what
 * `base` says — by default what the pipeline or a prior measurement says; a
 * numeric-only census re-reading an earlier report passes that report's table.
 */
export function censusTypeTable(census: readonly CensusEntry[], base: Readonly<Record<string, SentinelType>> = STATIC_FIELD_TYPES): Record<string, SentinelType> {
  const trusted = censusControls(census).ok
  const byField = new Map(census.map((e) => [e.field, e]))
  return Object.fromEntries(SENTINEL_FIELDS.map((f) => {
    const e = byField.get(f)
    if (trusted && e && (e.verdict === 'string' || e.verdict === 'number')) return [f, e.verdict]
    if (e && trusted && e.verdict !== 'absent') return [f, 'unknown']
    return [f, base[f] ?? 'unknown']
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

/**
 * A numeric-only census applied to an earlier report's sentinel rows, billing
 * nothing: the fields this census typed take its verdict, every other field
 * keeps the earlier report's type, and the earlier rows are read again. A field
 * whose applicable form the earlier query did not emit stays `type unresolved`,
 * exactly as `readSentinels` already rules.
 */
export function rereadSentinels(
  census: readonly CensusEntry[],
  prior: { rows: readonly Row[]; types: Readonly<Record<string, SentinelType>> },
): { types: Record<string, SentinelType>; sentinels: SentinelEntry[] } {
  const types = censusTypeTable(census, prior.types)
  return { types, sentinels: readSentinels(prior.rows, types) }
}

// ── The report ──────────────────────────────────────────────────────────────

export interface AuditJob {
  purpose: string
  window: AuditWindow
  query: string
  jobId: string | null
  /** Wall-clock ISO time the job was submitted, or null when it never was. */
  submittedAt: string | null
  status: string
  /**
   * What the job billed, read from `GET …/metrics` after it ended. null when the
   * job was never created, or when the figure never appeared (`costRead` says
   * which) — never 0 for "unknown".
   */
  billableCPUSeconds: number | null
  /**
   * How the cost read went: `read after N s`, or `not yet available after N s`
   * when the metrics never carried a positive figure. null when there was no
   * job to read. Absent from reports written before the 2026-09-25 fix.
   */
  costRead?: string | null
  elapsedMs: number | null
  error: string | null
  /** null when no cancel was needed; 'sent', or 'failed: …', when the runner cancelled its own job. */
  cancel: string | null
}

export interface AuditReport {
  /**
   * The reference "now" the windows were computed from (ISO): `--at` when given,
   * else the moment the runner started. Every window ends `lagMinutes` before it.
   * NOT when the jobs ran — a re-run with the same `--at` reads the same windows
   * hours or days later.
   */
  referenceAt: string
  /** Where `referenceAt` came from: the `--at` option, or the runner's own start. */
  referenceFrom: '--at' | 'run start'
  /** Wall-clock ISO time the runner began submitting: when the measurement was actually taken. */
  ranAt: string
  /** Wall-clock ISO time the last job ended. */
  finishedAt: string
  dataset: string
  capSeconds: number
  estimate: CostEstimate
  jobs: AuditJob[]
  census: CensusEntry[] | null
  controls: { ok: boolean; why: string } | null
  density: DensityEntry[] | null
  sentinelTypes: Record<string, SentinelType>
  sentinels: SentinelEntry[] | null
  /** Which census ran. Absent from reports written before the numeric mode existed (they ran `wide`). */
  censusMode?: CensusMode
  /**
   * Set when the sentinel table was re-read, at no cost, from an earlier
   * report's raw sentinel rows (`--sentinels-from`): that report's file. Its
   * windows and counts are that report's, not this run's.
   */
  sentinelsFrom?: string | null
}

/**
 * The run's billed total, never counting an unknown as 0. A job never created
 * (no id) is left out; a created job whose cost never appeared makes the total
 * INCOMPLETE, and the report says how many.
 */
export function billedTotal(jobs: readonly AuditJob[]): { known: number; knownJobs: number; unknownJobs: number; complete: boolean } {
  const created = jobs.filter((j) => j.jobId !== null)
  const known = created.filter((j) => j.billableCPUSeconds !== null)
  return {
    known: known.reduce((s, j) => s + (j.billableCPUSeconds ?? 0), 0),
    knownJobs: known.length,
    unknownJobs: created.length - known.length,
    complete: known.length === created.length,
  }
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(2)} %`)
const n = (x: number | null) => (x === null ? '—' : x.toLocaleString('en-US'))

/** The Markdown half of the report. The JSON half is the `AuditReport` itself. */
export function renderAuditMarkdown(r: AuditReport): string {
  const out: string[] = []
  out.push(`# Parquet read-side audit (Phase 8.0b / 8.0c)`, '')
  out.push(`Taken ${r.ranAt} to ${r.finishedAt} on \`${r.dataset}\` (JSON). Pinned: measurement. Running-time cap ${r.capSeconds} s per job.`, '')
  out.push(`Windows are measured back from the reference time ${r.referenceAt} (${r.referenceFrom === '--at' ? 'given by `--at`, not when the jobs ran' : 'the moment the runner started'}).`, '')
  out.push('Demo-feed or production figures alike, these describe THIS install over THESE windows. Nothing here gates a phase; the design (R4) says to audit again per release and per proof install.', '')

  if (r.censusMode === 'numeric') out.push('Census: numeric-only (the cast-check fields and both controls; no density, no uncast fields).', '')
  out.push('## Jobs', '', '| purpose | window (UTC) | submitted | job | status | cancel | billable CPU-s | elapsed |', '|---|---|---|---|---|---|---|---|')
  for (const j of r.jobs) {
    const cost = j.billableCPUSeconds !== null ? n(j.billableCPUSeconds) : j.jobId === null ? '—' : 'not yet available'
    out.push(`| ${j.purpose} | ${j.window.label} | ${j.submittedAt ?? '—'} | ${j.jobId ?? '—'} | ${j.status}${j.error ? `: ${j.error.replace(/\|/g, '/')}` : ''} | ${j.cancel ? j.cancel.replace(/\|/g, '/') : '—'} | ${cost} | ${j.elapsedMs === null ? '—' : `${(j.elapsedMs / 1000).toFixed(1)} s`} |`)
  }
  const b = billedTotal(r.jobs)
  const floor = `against an estimated floor of ≈${n(Math.round(r.estimate.total))}`
  const jobsWord = (k: number) => `${k} job${k === 1 ? '' : 's'}`
  out.push('', b.complete
    ? `Billed in total: ${n(Math.round(b.known))} CPU-s, ${floor}.`
    : b.knownJobs === 0
      ? `Billed in total: not yet available — no job's cost could be read (${jobsWord(b.unknownJobs)}). Not 0: read each job's metrics later.`
      : `Billed in total: incomplete — ${n(Math.round(b.known))} CPU-s over ${b.knownJobs} of ${b.knownJobs + b.unknownJobs} jobs; the cost of ${jobsWord(b.unknownJobs)} is not yet available, so the true total is higher, ${floor}.`, '')

  out.push('## Type table (8.0b)', '')
  if (!r.census) out.push('Not read: the census job did not complete.', '')
  else {
    if (r.controls) out.push(r.controls.ok ? r.controls.why : `**${r.controls.why}**`, '')
    out.push(`Counted per \`gettype\` name (${GETTYPE_NAMES.join(', ')}); "uncounted" is present values none of those names account for.`, '')
    out.push('| field | present | types (count per gettype name) | verdict | pipeline / prior says | agrees |', '|---|---|---|---|---|---|')
    for (const e of r.census) {
      const role = CAST_CHECK_FIELDS.includes(e.field) || e.field === CENSUS_CONTROLS.number ? ' (check)' : ''
      out.push(`| \`${e.field}\`${role} | ${n(e.present)} | ${typeCountsText(e)} | ${e.verdict} | ${e.expected ?? '—'} | ${e.agrees === null ? '—' : e.agrees ? 'yes' : '**no**'} |`)
    }
    out.push('')
  }

  out.push('## Density table (8.0b)', '')
  if (!r.density) out.push(r.censusMode === 'numeric' ? 'Not read: the numeric-only census reads no density.' : 'Not read: the census job did not complete.', '')
  else {
    out.push('| check | field | within | present | of | share |', '|---|---|---|---|---|---|')
    for (const d of r.density) out.push(`| ${d.id} | \`${d.field}\` | ${d.scope} | ${n(d.present)} | ${n(d.of)} | ${pct(d.share)} |`)
    out.push('')
  }

  out.push('## Sentinel table (8.0c)', '')
  if (!r.sentinels) out.push(r.censusMode === 'numeric' ? 'Not read: the numeric-only census submits no sentinel job (see `--sentinels-from`).' : 'Not read: no sentinel job completed.', '')
  else {
    if (r.sentinelsFrom) out.push(`Re-read at no cost from the raw sentinel rows of ${r.sentinelsFrom}, with this run's types: the windows and counts are that report's.`, '')
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

// ── Where the report goes ───────────────────────────────────────────────────

const compact = (iso: string, to: number) => iso.slice(0, to).replace(/[:-]/g, '')

/**
 * The report's file name, without extension. It names BOTH times: the reference
 * time the windows came from, to the minute, and the wall-clock time the run
 * began, to the second — so a re-run with the same `--at` gets a name of its own
 * rather than the earlier report's.
 */
export function reportFileStem(referenceAt: string, ranAt: string): string {
  return `parquet-audit-ref${compact(referenceAt, 16)}Z-ran${compact(ranAt, 19)}Z`
}

/**
 * The first of `stem`, `stem-2`, `stem-3`, … for which no `.json` or `.md`
 * exists (`taken(name)`), so two runs in the same second never share a name. The
 * runner still writes with the exclusive flag: a report is evidence that cost
 * CPU-s to take, and is never overwritten.
 */
export function freeReportStem(stem: string, taken: (fileName: string) => boolean, max = 99): string {
  for (let i = 1; i <= max; i++) {
    const s = i === 1 ? stem : `${stem}-${i}`
    if (!taken(`${s}.json`) && !taken(`${s}.md`)) return s
  }
  throw new Error(`no free report name for ${stem} after ${max} tries`)
}
