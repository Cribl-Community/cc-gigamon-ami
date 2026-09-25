// Reading the Phase 8.0b/8.0c audit, and the runner's refusal to spend without
// --run. Nothing here reaches the network: the runner is spawned without --run,
// pointed at a port nothing listens on, and must still exit cleanly.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAST_CHECK_FIELDS, CENSUS_COLUMNS_FIELDS, NUMERIC_CENSUS_FIELDS, SENTINEL_FIELDS, STATIC_FIELD_TYPES } from '../queries/parquetAudit'
import {
  COST_MARGIN,
  DEFAULT_COST_BASIS,
  MEASURED_RUN,
  NUMERIC_CENSUS_WINDOW,
  auditCostEstimate,
  auditWindows,
  billedTotal,
  censusControls,
  censusTypeTable,
  freeReportStem,
  readDensity,
  readSentinels,
  readTypeCensus,
  renderAuditMarkdown,
  reportFileStem,
  rereadSentinels,
  typeCountsText,
  type AuditJob,
  type AuditReport,
  type Row,
} from './parquetAuditReport'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NOON = Date.parse('2026-09-25T12:00:30Z') / 1000

type Counts = { n: number; s?: number; i?: number; l?: number; r?: number }

/** A census row, per-type counts per field: numbers read `int`, the rest `string`, with overrides. */
function censusRow(over: Record<string, Counts> = {}, fields: readonly string[] = CENSUS_COLUMNS_FIELDS): Row {
  const row: Row = {}
  for (const f of fields) {
    const numeric = STATIC_FIELD_TYPES[f] === 'number' || f === 'protocol'
    const v = over[f] ?? (numeric ? { n: 10, i: 10 } : { n: 10, s: 10 })
    row[`tn_${f}`] = v.n
    row[`ts_${f}`] = v.s ?? 0
    row[`ti_${f}`] = v.i ?? 0
    row[`tl_${f}`] = v.l ?? 0
    row[`tr_${f}`] = v.r ?? 0
  }
  return row
}

/** A job as the runner records it. */
const job = (over: Partial<AuditJob> = {}): AuditJob => ({
  purpose: '8.0c sentinels', window: { earliest: 0, latest: 900, label: 'w' }, query: 'q', jobId: '1.a', submittedAt: '2026-09-25T12:00:31.000Z',
  status: 'completed', billableCPUSeconds: 100, costRead: 'read after 14 s', elapsedMs: 1000, error: null, cancel: null, ...over,
})

describe('auditWindows', () => {
  it('ends every window ten minutes before now, on the minute, and spaces the sentinel windows by hours', () => {
    const w = auditWindows(NOON)
    expect(w.census).toEqual({ earliest: NOON - 30 - 70 * 60, latest: NOON - 30 - 10 * 60, label: '2026-09-25T10:50:00Z → 2026-09-25T11:50:00Z' })
    expect(w.sentinel.map((s) => s.label)).toEqual([
      '2026-09-25T11:35:00Z → 2026-09-25T11:50:00Z',
      '2026-09-25T05:35:00Z → 2026-09-25T05:50:00Z',
      '2026-09-24T23:35:00Z → 2026-09-24T23:50:00Z',
    ])
    expect(auditWindows(NOON, { sentinelOffsetsHours: [1] }).sentinel).toHaveLength(1)
  })
})

describe('auditCostEstimate', () => {
  it('reproduces the measured 2026-09-25 run for its own shape: 5,457 + 290 ≈ 5,747 CPU-s, not the flat ≈828', () => {
    const e = auditCostEstimate(auditWindows(NOON))
    expect(Math.round(e.census)).toBe(MEASURED_RUN.census.billed)
    expect(Math.round(e.sentinel)).toBe(290)
    expect(Math.round(e.total)).toBe(5_747)
    expect(e.planFor).toBeCloseTo(e.total * COST_MARGIN)
  })

  it('derives each shape\'s coefficient from the measured figures, not a typed-in constant', () => {
    expect(DEFAULT_COST_BASIS.censusCpuPer1kRowsPerField).toBeCloseTo(5_457 / 1_049.258 / 28, 9)
    expect(DEFAULT_COST_BASIS.sentinelCpuPer1kRows).toBeCloseTo((51 + 111 + 128) / 786.522, 9)
    expect(DEFAULT_COST_BASIS.rowsPerHour).toBe(1_049_258)
    expect(MEASURED_RUN.census.fields).toBe(CENSUS_COLUMNS_FIELDS.length)
  })

  it('states itself as a floor from the measured run, dated, and never as a bound', () => {
    const text = auditCostEstimate(auditWindows(NOON)).lines.join(' ')
    expect(text).toContain('measured on the demo feed, 2026-09-25')
    expect(text).toContain('5,457 CPU-s')
    expect(text).toContain('51, 111, 128 CPU-s')
    expect(text).toContain('Expected at least ≈5,747 CPU-s')
    expect(text).toContain('a floor, not a bound')
    expect(text).toContain('wall time only')
    expect(text).not.toMatch(/up to ≈/)
  })

  it('prices the numeric-only census per field over its 15-minute window, with no sentinels', () => {
    const w = auditWindows(NOON, NUMERIC_CENSUS_WINDOW)
    expect(w.sentinel).toEqual([])
    expect(w.census.latest - w.census.earliest).toBe(15 * 60)
    const e = auditCostEstimate(w, DEFAULT_COST_BASIS, NUMERIC_CENSUS_FIELDS.length, 'numeric')
    expect(Math.round(e.total)).toBe(341)
    expect(e.sentinel).toBe(0)
    expect(e.lines.join(' ')).toContain('numeric-only census, 15 min, 7 fields, no density')
    expect(e.lines.join(' ')).toContain('a census this narrow is unmeasured')
  })

  it('scales with the install\'s own intake when given it', () => {
    const e = auditCostEstimate(auditWindows(NOON), { ...DEFAULT_COST_BASIS, rowsPerHour: 2 * 1_049_258 })
    expect(Math.round(e.census)).toBe(2 * 5_457)
  })
})

describe('the type census', () => {
  it('types each field from which per-type counts are non-zero, and flags a contradiction of the pipeline', () => {
    const c = readTypeCensus(censusRow({
      http2_code: { n: 5, l: 5 },
      krb5_message_type: { n: 8, s: 3, i: 5 },
      sip_from: { n: 0 },
      ssl_ext_ec_supported_groups_type: { n: 4 },
      http_cookie: { n: 6, s: 4 },
      tcp_rtt: { n: 6, s: 6 },
      tcp_rtt_app: { n: 9, i: 7, r: 2 },
    }))
    const by = Object.fromEntries(c.map((e) => [e.field, e]))
    expect(by.http2_code).toMatchObject({ verdict: 'number', names: ['long'] })
    expect(by.krb5_message_type).toMatchObject({ verdict: 'mixed', names: ['string', 'int'] })
    expect(by.sip_from).toMatchObject({ verdict: 'absent', names: [], other: 0 })
    // Present values no counted name accounts for are never read as a number or a string.
    expect(by.ssl_ext_ec_supported_groups_type).toMatchObject({ verdict: 'other', other: 4, names: ['other'] })
    expect(by.http_cookie).toMatchObject({ verdict: 'mixed', other: 2 })
    expect(by.tcp_rtt).toMatchObject({ verdict: 'string', expected: 'number', agrees: false })
    // int and real together are still a number, and the report shows the mix.
    expect(by.tcp_rtt_app).toMatchObject({ verdict: 'number', names: ['int', 'real'], agrees: true })
    expect(typeCountsText(by.tcp_rtt_app)).toBe('int 7 · real 2')
    expect(by.http_code).toMatchObject({ verdict: 'string', expected: 'string', agrees: true })
    expect(censusControls(c).ok).toBe(true)
  })

  it('types the sparse numeric fields the min/max probe left unresolved on 2026-09-25', () => {
    // The shape that run recorded for tcp_rtt, with the per-type columns it lacked.
    const c = readTypeCensus({ rows: 1_049_258, tn_tcp_rtt: 55_107, ts_tcp_rtt: 0, ti_tcp_rtt: 0, tl_tcp_rtt: 0, tr_tcp_rtt: 55_107, tlo_tcp_rtt: '~', thi_tcp_rtt: 0 }, ['tcp_rtt'])
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ field: 'tcp_rtt', verdict: 'number', names: ['real'], agrees: true })
  })

  it('distrusts the whole census when a control reads wrong', () => {
    const c = readTypeCensus(censusRow({ app_name: { n: 10 } }))
    expect(censusControls(c)).toMatchObject({ ok: false })
    expect(censusControls(c).why).toContain('uncounted 10')
    // Untrusted: the sentinel types fall back to the static table.
    expect(censusTypeTable(c)).toEqual(STATIC_FIELD_TYPES)
    const p = readTypeCensus(censusRow({ protocol: { n: 10, s: 10 } }))
    expect(censusControls(p).ok).toBe(false)
    const mixed = readTypeCensus(censusRow({ protocol: { n: 10, i: 9, s: 1 } }))
    expect(censusControls(mixed).ok).toBe(false)
    expect(censusControls(readTypeCensus(censusRow())).why).toBe('Controls hold: `app_name` reads string, `protocol` reads int.')
  })

  it('resolves unknowns from a trusted census, keeps them unknown when mixed, and keeps static types when absent', () => {
    const t = censusTypeTable(readTypeCensus(censusRow({
      http2_code: { n: 5, l: 5 },
      krb5_message_type: { n: 8, s: 3, i: 5 },
      sip_from: { n: 0 },
    })))
    expect(t.http2_code).toBe('number')
    expect(t.krb5_message_type).toBe('unknown')
    expect(t.sip_from).toBe(STATIC_FIELD_TYPES.sip_from)
    expect(t.snmp_community).toBe('string')
    expect(Object.keys(t)).toEqual([...SENTINEL_FIELDS])
  })

  it('reads a numeric-only census over its own fields, and keeps the base table for the rest', () => {
    const c = readTypeCensus(censusRow({}, NUMERIC_CENSUS_FIELDS), NUMERIC_CENSUS_FIELDS)
    expect(c.map((e) => e.field)).toEqual([...NUMERIC_CENSUS_FIELDS])
    expect(censusControls(c).ok).toBe(true)
    const base = { ...STATIC_FIELD_TYPES, krb5_message_type: 'string' as const }
    const t = censusTypeTable(c, base)
    expect(t.krb5_message_type).toBe('string')
    for (const f of CAST_CHECK_FIELDS) expect(t[f]).toBe('number')
  })
})

describe('re-reading an earlier report\'s sentinels with a numeric-only census', () => {
  it('turns the five "type unresolved" numeric rows of 2026-09-25 into verdicts, billing nothing', () => {
    // The prior report's shape: those five were typed "unknown" after its census,
    // and its sentinel query (run before the census) emitted only their `0` form.
    const priorTypes = { ...STATIC_FIELD_TYPES, ...Object.fromEntries(CAST_CHECK_FIELDS.map((f) => [f, 'unknown' as const])) }
    const rows: Row[] = [0, 1, 2].map(() => ({
      ...Object.fromEntries(CAST_CHECK_FIELDS.flatMap((f) => [[`sn_${f}`, 1000], [`sz_${f}`, 0]])),
      sn_http_code: 3000, se_http_code: 0,
    }))
    expect(readSentinels(rows, priorTypes).find((s) => s.field === 'tcp_rtt')?.verdict).toBe('type unresolved')
    const census = readTypeCensus(censusRow({ tcp_rtt: { n: 50, r: 50 }, dst_port: { n: 90, i: 90 } }, NUMERIC_CENSUS_FIELDS), NUMERIC_CENSUS_FIELDS)
    const { types, sentinels } = rereadSentinels(census, { rows, types: priorTypes })
    const by = Object.fromEntries(sentinels.map((s) => [s.field, s]))
    for (const f of CAST_CHECK_FIELDS) {
      expect(types[f], f).toBe('number')
      expect(by[f], f).toMatchObject({ applies: '0', present: 3000, sentinels: 0, verdict: 'no real sentinel (R eligible)' })
    }
    expect(types.http_code).toBe('string')
  })
})

describe('density', () => {
  it('divides each numerator by its scope, and reports no share for an empty scope', () => {
    const d = readDensity({ rows: 1000, d_tcp: 400, d_tcp_dst_subnet: 400, d_tcp_src_subnet16: 399, d_tcp_dst_subnet16: 400, d_dst_ip: 990, d_web: 17, d_web_http_server_ms: 12, d_icmp: 0, d_icmp_dst_port: 0, d_pqc: 5, d_pqc_ssl_server_name: 5 })
    const by = Object.fromEntries(d.map((e) => [e.id, e]))
    expect(by.dst_ip).toMatchObject({ of: 1000, share: 0.99 })
    expect(by.tcp_src_subnet16.share).toBeCloseTo(399 / 400)
    expect(by.icmp_dst_port.share).toBeNull()
    expect(by.web_http_server_ms.share).toBeCloseTo(12 / 17)
  })
})

describe('sentinels', () => {
  it('reads the sentinel the type says, over every window, and refuses a verdict it cannot support', () => {
    const w1: Row = { sn_http_code: 10, se_http_code: 0, sn_tcp_rtt: 50, sz_tcp_rtt: 2, sn_dst_port: 90, sz_dst_port: 0, sn_http2_code: 3, se_http2_code: 0, sz_http2_code: 1, sn_sip_from: 0, se_sip_from: 0, sz_sip_from: 0 }
    const w2: Row = { ...w1, sz_tcp_rtt: 0 }
    const types = { ...STATIC_FIELD_TYPES, http2_code: 'number' as const, sip_from: 'string' as const, dcerpc_service: 'string' as const }
    const by = Object.fromEntries(readSentinels([w1, w2], types).map((e) => [e.field, e]))
    expect(by.http_code).toMatchObject({ applies: '""', present: 20, sentinels: 0, verdict: 'no real sentinel (R eligible)' })
    expect(by.tcp_rtt).toMatchObject({ applies: '0', sentinels: 2, verdict: 'real sentinels (P or J)' })
    expect(by.http2_code).toMatchObject({ applies: '0', sentinels: 2, verdict: 'real sentinels (P or J)' })
    expect(by.sip_from.verdict).toBe('not exercised')
    expect(by.krb5_message_type).toMatchObject({ applies: null, verdict: 'type unresolved' })
    // A string type the query did not emit `""` for (it ran before the census): no verdict.
    expect(by.dcerpc_service.verdict).toBe('type unresolved')
  })
})

describe('the Markdown report', () => {
  it('writes the three tables, the jobs and the exact query text', () => {
    const w = auditWindows(NOON)
    const census = readTypeCensus(censusRow({ tcp_rtt: { n: 6, s: 6 } }))
    const report: AuditReport = {
      referenceAt: '2026-09-25T12:00:30.000Z',
      referenceFrom: '--at',
      ranAt: '2026-09-26T08:15:02.000Z',
      finishedAt: '2026-09-26T08:21:40.000Z',
      dataset: 'gigamon_ami',
      capSeconds: 300,
      estimate: auditCostEstimate(w),
      jobs: [{ purpose: '8.0b census + density', window: w.census, query: 'set max_running_time_per_search=300; dataset="gigamon_ami" | summarize rows=count()', jobId: '1.abc', submittedAt: '2026-09-26T08:15:02.000Z', status: 'completed', billableCPUSeconds: 401.5, elapsedMs: 2800, error: null, cancel: null }],
      census,
      controls: censusControls(census),
      density: readDensity({ rows: 10, d_tcp: 5, d_tcp_dst_subnet: 5 }),
      sentinelTypes: STATIC_FIELD_TYPES,
      sentinels: readSentinels([{ sn_http_code: 1, se_http_code: 0 }], STATIC_FIELD_TYPES),
    }
    const md = renderAuditMarkdown(report)
    for (const h of ['## Type table (8.0b)', '## Density table (8.0b)', '## Sentinel table (8.0c)', '## Jobs']) expect(md).toContain(h)
    expect(md).toContain('| `tcp_rtt` (check) | 6 | string 6 | string | number | **no** |')
    expect(md).toContain('set max_running_time_per_search=300; dataset="gigamon_ami"')
    expect(md).toContain('Billed in total: 402 CPU-s, against an estimated floor of ≈5,747.')
    // The two times are kept apart: when the jobs ran, and what the windows were measured from.
    expect(md).toContain('Taken 2026-09-26T08:15:02.000Z to 2026-09-26T08:21:40.000Z')
    expect(md).toContain('reference time 2026-09-25T12:00:30.000Z (given by `--at`, not when the jobs ran)')
    expect(md).not.toContain('Taken 2026-09-25T12:00:30')
    expect(md).toContain('| 2026-09-26T08:15:02.000Z | 1.abc | completed | — |')
    const own = renderAuditMarkdown({ ...report, referenceFrom: 'run start' })
    expect(own).toContain('(the moment the runner started)')
  })

  it('records a job the runner cancelled after an error, with the error', () => {
    const w = auditWindows(NOON)
    const md = renderAuditMarkdown({
      referenceAt: '2026-09-25T12:00:30.000Z', referenceFrom: 'run start', ranAt: '2026-09-25T12:00:31.000Z', finishedAt: '2026-09-25T12:01:00.000Z',
      dataset: 'gigamon_ami', capSeconds: 300, estimate: auditCostEstimate(w),
      jobs: [{ purpose: '8.0c sentinels', window: w.sentinel[0], query: 'q', jobId: '2.x', submittedAt: '2026-09-25T12:00:31.000Z', status: 'running; canceled by the runner after the error', billableCPUSeconds: null, elapsedMs: 1000, error: 'GET /search/jobs/2.x/status → 502 bad | gateway', cancel: 'sent' }],
      census: null, controls: null, density: null, sentinelTypes: STATIC_FIELD_TYPES, sentinels: null,
    })
    expect(md).toContain('running; canceled by the runner after the error: GET /search/jobs/2.x/status → 502 bad / gateway | sent |')
    expect(md).toContain('| sent | not yet available |')
  })

  const reportWith = (jobs: AuditJob[]): AuditReport => ({
    referenceAt: '2026-09-25T12:00:30.000Z', referenceFrom: 'run start', ranAt: '2026-09-25T12:00:31.000Z', finishedAt: '2026-09-25T12:09:00.000Z',
    dataset: 'gigamon_ami', capSeconds: 300, estimate: auditCostEstimate(auditWindows(NOON)),
    jobs, census: null, controls: null, density: null, sentinelTypes: STATIC_FIELD_TYPES, sentinels: null,
  })

  it('never sums a cost it could not read as 0: the total says it is incomplete, and by how many jobs', () => {
    const jobs = [job({ billableCPUSeconds: 5_457 }), job({ billableCPUSeconds: null, costRead: 'not yet available after 89 s of reads' }), job({ billableCPUSeconds: 111 })]
    expect(billedTotal(jobs)).toEqual({ known: 5_568, knownJobs: 2, unknownJobs: 1, complete: false })
    const md = renderAuditMarkdown(reportWith(jobs))
    expect(md).not.toContain('Billed in total: 5,568 CPU-s,')
    expect(md).toContain('Billed in total: incomplete — 5,568 CPU-s over 2 of 3 jobs; the cost of 1 job is not yet available, so the true total is higher')
    expect(md).toContain('| not yet available |')
  })

  it('says "not yet available", not 0, when no job\'s cost could be read — the first run\'s report said "0 CPU-s"', () => {
    const md = renderAuditMarkdown(reportWith([job({ billableCPUSeconds: null }), job({ billableCPUSeconds: null })]))
    expect(md).toContain('Billed in total: not yet available — no job\'s cost could be read (2 jobs). Not 0')
    expect(md).not.toMatch(/Billed in total: 0 /)
  })

  it('leaves out a job that was never created: it billed nothing and has no cost to wait for', () => {
    const jobs = [job({ billableCPUSeconds: 51 }), job({ jobId: null, billableCPUSeconds: null, status: 'not submitted', error: 'POST → 429' })]
    expect(billedTotal(jobs)).toMatchObject({ known: 51, unknownJobs: 0, complete: true })
    const md = renderAuditMarkdown(reportWith(jobs))
    expect(md).toContain('Billed in total: 51 CPU-s, against an estimated floor')
    expect(md).toContain('| — | — |')
  })

  it('says a numeric-only run read no density and no sentinels, rather than that a job failed', () => {
    const census = readTypeCensus(censusRow({}, NUMERIC_CENSUS_FIELDS), NUMERIC_CENSUS_FIELDS)
    const md = renderAuditMarkdown({ ...reportWith([job()]), censusMode: 'numeric', census, controls: censusControls(census) })
    expect(md).toContain('Census: numeric-only')
    expect(md).toContain('Not read: the numeric-only census reads no density.')
    expect(md).toContain('Not read: the numeric-only census submits no sentinel job')
    expect(md).toContain('| `protocol` (check) | 10 | int 10 | number | number | yes |')
  })

  it('never calls a numeric-only estimate a floor in the total — its own estimate block says it is neither', () => {
    const census = readTypeCensus(censusRow({}, NUMERIC_CENSUS_FIELDS), NUMERIC_CENSUS_FIELDS)
    const md = renderAuditMarkdown({ ...reportWith([job({ billableCPUSeconds: 954 })]), censusMode: 'numeric', census, controls: censusControls(census) })
    expect(md).toMatch(/Billed in total: 954 CPU-s, against an estimate of ≈[\d,]+ for an unmeasured shape \(neither a floor nor a bound\)\./)
    expect(md).not.toContain('estimated floor')
  })
})

describe('where the report is written', () => {
  it('names both the reference time and the run time, so the same --at twice gives two names', () => {
    const at = '2026-09-25T12:00:30.000Z'
    const first = reportFileStem(at, '2026-09-25T12:01:02.123Z')
    const second = reportFileStem(at, '2026-09-26T09:40:11.000Z')
    expect(first).toBe('parquet-audit-ref20260925T1200Z-ran20260925T120102Z')
    expect(second).not.toBe(first)
  })

  it('never hands out a name whose .json or .md already exists', () => {
    const stem = 'parquet-audit-ref20260925T1200Z-ran20260925T120102Z'
    expect(freeReportStem(stem, () => false)).toBe(stem)
    const taken = new Set([`${stem}.json`, `${stem}-2.md`])
    expect(freeReportStem(stem, (n) => taken.has(n))).toBe(`${stem}-3`)
    expect(() => freeReportStem(stem, () => true, 3)).toThrow(/no free report name/)
  })

  it('the runner opens its report files exclusively, so nothing can replace an earlier one', () => {
    const src = readFileSync(join(ROOT, 'scripts/parquet-audit.mjs'), 'utf8')
    const writes = src.match(/writeFileSync\([^\n]*/g) ?? []
    expect(writes.length).toBe(2)
    for (const w of writes) expect(w).toContain("{ flag: 'wx' }")
    expect(src).toContain('R.freeReportStem(')
    expect(src).not.toMatch(/takenAt/)
  })
})

describe('scripts/parquet-audit.mjs', () => {
  it('prints the plan and the estimate, and submits nothing without --run', () => {
    // --base names a port nothing listens on: had it tried to submit, it would fail.
    const r = spawnSync(process.execPath, ['scripts/parquet-audit.mjs', '--at', '2026-09-25T12:00:30Z', '--base', 'http://127.0.0.1:9/capi'], { cwd: ROOT, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('pinned: measurement')
    expect(r.stdout).toContain('Expected at least ≈5,747 CPU-s — a floor')
    expect(r.stdout).not.toContain('≈828')
    expect(r.stdout).toContain('Nothing submitted. Re-run with --run')
    expect(r.stdout).not.toContain('submitted\n  ')
  })

  it('plans a numeric-only census as one 15-minute job, and re-reads earlier sentinels without billing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pqa-'))
    try {
      const prior = join(dir, 'prior.json')
      writeFileSync(prior, JSON.stringify({ sentinelTypes: STATIC_FIELD_TYPES, raw: { sentinels: [{ sn_tcp_rtt: 1, sz_tcp_rtt: 0 }] } }))
      const r = spawnSync(process.execPath, ['scripts/parquet-audit.mjs', '--at', '2026-09-25T12:00:30Z', '--base', 'http://127.0.0.1:9/capi', '--census', 'numeric', '--sentinels-from', prior], { cwd: ROOT, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('1. 8.0b numeric-only census 2026-09-25T11:35:00Z → 2026-09-25T11:50:00Z')
      expect(r.stdout).not.toContain('2. ')
      expect(r.stdout).toContain('Sentinels re-read, billing nothing')
      // An unmeasured shape: an estimate, never presented as a floor.
      expect(r.stdout).toContain('Estimate ≈341 CPU-s for an UNMEASURED shape: neither a floor nor a bound')
      expect(r.stdout).not.toContain('Expected at least')
      expect(r.stdout).not.toContain('This is a floor')
      expect(r.stdout).toContain('Nothing submitted.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses options that do not fit the census mode, and the retired flat coefficient', () => {
    const run = (...a: string[]) => spawnSync(process.execPath, ['scripts/parquet-audit.mjs', '--base', 'http://127.0.0.1:9/capi', ...a], { cwd: ROOT, encoding: 'utf8' })
    expect(run('--sentinels-from', 'x.json').stderr).toContain('--sentinels-from is for --census numeric')
    expect(run('--census', 'numeric', '--types-from', 'x.json').stderr).toContain('which --census numeric does not submit')
    expect(run('--census', 'narrow').stderr).toContain('--census must be wide or numeric')
    expect(run('--cpu-per-1k', '0.45').stderr).toContain('--cpu-per-1k is gone')
  })

  it('says in the plan that --types-from runs the census again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pqa-'))
    try {
      const prior = join(dir, 'prior.json')
      writeFileSync(prior, JSON.stringify({ census: readTypeCensus(censusRow()) }))
      const r = spawnSync(process.execPath, ['scripts/parquet-audit.mjs', '--at', '2026-09-25T12:00:30Z', '--base', 'http://127.0.0.1:9/capi', '--types-from', prior], { cwd: ROOT, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('1. 8.0b census + density')
      expect(r.stdout).toContain('--types-from does not skip the census: job 1 runs and is billed again')
      expect(r.stdout).toContain('Nothing submitted.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an argument it does not know rather than guessing', () => {
    const r = spawnSync(process.execPath, ['scripts/parquet-audit.mjs', '--runn'], { cwd: ROOT, encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('unknown argument --runn')
  })
})
