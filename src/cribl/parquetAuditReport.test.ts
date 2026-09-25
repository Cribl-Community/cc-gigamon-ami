// Reading the Phase 8.0b/8.0c audit, and the runner's refusal to spend without
// --run. Nothing here reaches the network: the runner is spawned without --run,
// pointed at a port nothing listens on, and must still exit cleanly.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CENSUS_COLUMNS_FIELDS, SENTINEL_FIELDS, STATIC_FIELD_TYPES } from '../queries/parquetAudit'
import {
  COST_MARGIN,
  auditCostEstimate,
  auditWindows,
  censusControls,
  censusTypeTable,
  readDensity,
  readSentinels,
  readTypeCensus,
  renderAuditMarkdown,
  type AuditReport,
  type Row,
} from './parquetAuditReport'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NOON = Date.parse('2026-09-25T12:00:30Z') / 1000

/** A census row where every field is present `n` times as `type`, with overrides. */
function censusRow(over: Record<string, { n: number; s: number; lo: string; hi: string }> = {}): Row {
  const row: Row = {}
  for (const f of CENSUS_COLUMNS_FIELDS) {
    const numeric = STATIC_FIELD_TYPES[f] === 'number' || f === 'protocol'
    const v = over[f] ?? (numeric ? { n: 10, s: 0, lo: 'long', hi: 'long' } : { n: 10, s: 10, lo: 'string', hi: 'string' })
    row[`tn_${f}`] = v.n
    row[`ts_${f}`] = v.s
    row[`tlo_${f}`] = v.n ? v.lo : '~'
    row[`thi_${f}`] = v.n ? v.hi : ''
  }
  return row
}

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
  it('prices each window from the flat JSON coefficient, and says it is not a bound', () => {
    const e = auditCostEstimate(auditWindows(NOON))
    expect(Math.round(e.census)).toBe(473)
    expect(Math.round(e.sentinel)).toBe(355)
    expect(e.planFor).toBeCloseTo(e.total * COST_MARGIN)
    expect(e.lines.join(' ')).toContain('not a bound')
    expect(e.lines.join(' ')).toContain('wall time only')
  })

  it('scales with the install\'s own intake when given it', () => {
    const e = auditCostEstimate(auditWindows(NOON), { rowsPerHour: 2_101_984, cpuPer1kRows: 0.45 })
    expect(Math.round(e.census)).toBe(946)
  })
})

describe('the type census', () => {
  it('types each field from its present and string counts, and flags a contradiction of the pipeline', () => {
    const c = readTypeCensus(censusRow({
      http2_code: { n: 5, s: 0, lo: 'long', hi: 'long' },
      krb5_message_type: { n: 8, s: 3, lo: 'long', hi: 'string' },
      sip_from: { n: 0, s: 0, lo: '', hi: '' },
      ssl_ext_ec_supported_groups_type: { n: 4, s: 0, lo: 'array', hi: 'array' },
      tcp_rtt: { n: 6, s: 6, lo: 'string', hi: 'string' },
    }))
    const by = Object.fromEntries(c.map((e) => [e.field, e]))
    expect(by.http2_code.verdict).toBe('number')
    expect(by.krb5_message_type.verdict).toBe('mixed')
    expect(by.sip_from).toMatchObject({ verdict: 'absent', lo: null, hi: null })
    expect(by.ssl_ext_ec_supported_groups_type.verdict).toBe('other')
    expect(by.tcp_rtt).toMatchObject({ verdict: 'string', expected: 'number', agrees: false })
    expect(by.http_code).toMatchObject({ verdict: 'string', expected: 'string', agrees: true })
    expect(censusControls(c).ok).toBe(true)
  })

  it('distrusts the whole census when a control reads wrong', () => {
    const c = readTypeCensus(censusRow({ app_name: { n: 10, s: 0, lo: 'str', hi: 'str' } }))
    expect(censusControls(c)).toMatchObject({ ok: false })
    // Untrusted: the sentinel types fall back to the static table.
    expect(censusTypeTable(c)).toEqual(STATIC_FIELD_TYPES)
    const p = readTypeCensus(censusRow({ protocol: { n: 10, s: 10, lo: 'string', hi: 'string' } }))
    expect(censusControls(p).ok).toBe(false)
  })

  it('resolves unknowns from a trusted census, keeps them unknown when mixed, and keeps static types when absent', () => {
    const t = censusTypeTable(readTypeCensus(censusRow({
      http2_code: { n: 5, s: 0, lo: 'long', hi: 'long' },
      krb5_message_type: { n: 8, s: 3, lo: 'long', hi: 'string' },
      sip_from: { n: 0, s: 0, lo: '', hi: '' },
    })))
    expect(t.http2_code).toBe('number')
    expect(t.krb5_message_type).toBe('unknown')
    expect(t.sip_from).toBe(STATIC_FIELD_TYPES.sip_from)
    expect(t.snmp_community).toBe('string')
    expect(Object.keys(t)).toEqual([...SENTINEL_FIELDS])
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
    const census = readTypeCensus(censusRow({ tcp_rtt: { n: 6, s: 6, lo: 'string', hi: 'string' } }))
    const report: AuditReport = {
      takenAt: '2026-09-25T12:00:30.000Z',
      dataset: 'gigamon_ami',
      capSeconds: 300,
      estimate: auditCostEstimate(w),
      jobs: [{ purpose: '8.0b census + density', window: w.census, query: 'set max_running_time_per_search=300; dataset="gigamon_ami" | summarize rows=count()', jobId: '1.abc', status: 'completed', billableCPUSeconds: 401.5, elapsedMs: 2800, error: null }],
      census,
      controls: censusControls(census),
      density: readDensity({ rows: 10, d_tcp: 5, d_tcp_dst_subnet: 5 }),
      sentinelTypes: STATIC_FIELD_TYPES,
      sentinels: readSentinels([{ sn_http_code: 1, se_http_code: 0 }], STATIC_FIELD_TYPES),
    }
    const md = renderAuditMarkdown(report)
    for (const h of ['## Type table (8.0b)', '## Density table (8.0b)', '## Sentinel table (8.0c)', '## Jobs']) expect(md).toContain(h)
    expect(md).toContain('| `tcp_rtt` (check) | 6 | 6 | string | string | number | **no** |')
    expect(md).toContain('set max_running_time_per_search=300; dataset="gigamon_ami"')
    expect(md).toContain('Billed in total: 402 CPU-s')
  })
})

describe('scripts/parquet-audit.mjs', () => {
  it('prints the plan and the estimate, and submits nothing without --run', () => {
    // --base names a port nothing listens on: had it tried to submit, it would fail.
    const r = spawnSync(process.execPath, ['scripts/parquet-audit.mjs', '--at', '2026-09-25T12:00:30Z', '--base', 'http://127.0.0.1:9/capi'], { cwd: ROOT, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('pinned: measurement')
    expect(r.stdout).toContain('Expected ≈828 CPU-s')
    expect(r.stdout).toContain('Nothing submitted. Re-run with --run')
    expect(r.stdout).not.toContain('submitted\n  ')
  })

  it('refuses an argument it does not know rather than guessing', () => {
    const r = spawnSync(process.execPath, ['scripts/parquet-audit.mjs', '--runn'], { cwd: ROOT, encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('unknown argument --runn')
  })
})
