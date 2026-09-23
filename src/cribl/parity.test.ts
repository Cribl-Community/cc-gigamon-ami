// The Lake landing parity check, per null-semantics class.
//
// Each class gets two kinds of case: one where the JSON side and the Parquet
// side agree, which must pass, and one modelling the failure automatic-schema
// Parquet produces, which must FAIL. A and B use the measured magnitudes
// (18 → 43,338); C, D and E use the failure the mechanism predicts, because
// those three have never been measured — that is what these queries are for.
//
// The zero/non-zero trap is asserted by name: a check that only asked whether a
// figure was non-zero on both sides reported "no difference" while c_T1572 went
// 18 → 40,280. Both of those are non-zero.
//
// WHAT THESE TESTS CANNOT ASSERT is at the bottom of the file.

import { describe, expect, it } from 'vitest'
import { PIVOTS, buildKpiQuery } from '../queries/capacityTopTalkers'
import { OVERALL } from '../queries/dnsHealth'
import {
  PARITY_CAPACITY_KPI_QUERY,
  PARITY_CODE_PRESENCE_QUERY,
  PARITY_DNS_QUERY,
  PARITY_HOST_PRESENCE_QUERY,
  PARITY_LATENCY_QUERY,
  PARITY_WEB_KPI_QUERY,
} from '../queries/lakeLanding'
import { latencyQuery } from '../queries/tcpHealth'
import { CODES, HOSTS, KPI, TREND } from '../queries/webApiHealth'
import {
  CLASS_ORDER,
  PARITY_CHECKS,
  classify,
  compareParity,
  parityColumns,
  parityJobs,
  retarget,
  summarizeColumns,
  type NullClass,
  type ParityDatasets,
  type ParityWindow,
  type Row,
} from './parity'

const WINDOW: ParityWindow = { earliest: 1_790_157_600, latest: 1_790_157_960 } // six minutes
const DATASETS: ParityDatasets = { json: 'gigamon_ami', parquet: 'gigamon_ami_pq' }

type Rows = Record<string, { json: Row | null; parquet: Row | null }>

/** Both sides identical and non-zero everywhere: the migration that changed nothing. */
function agreeing(): Rows {
  const rows: Rows = {}
  for (const col of parityColumns()) {
    const v = col.role === 'control' ? 100_000 : col.column === 'resolvers' ? 12 : col.kind === 'distribution' ? 0.042 : 1_000
    rows[col.check] ??= { json: {}, parquet: {} }
    ;(rows[col.check].json as Record<string, unknown>)[col.column] = v
    ;(rows[col.check].parquet as Record<string, unknown>)[col.column] = v
  }
  return rows
}

function withParquet(rows: Rows, check: string, patch: Record<string, unknown>): Rows {
  return { ...rows, [check]: { json: rows[check].json, parquet: { ...rows[check].parquet, ...patch } } }
}
function withJson(rows: Rows, check: string, patch: Record<string, unknown>): Rows {
  return { ...rows, [check]: { json: { ...rows[check].json, ...patch }, parquet: rows[check].parquet } }
}

function verdicts(rows: Rows): Record<NullClass, string> {
  const r = compareParity(rows, WINDOW, DATASETS)
  return Object.fromEntries(r.classes.map((c) => [c.cls, c.verdict])) as Record<NullClass, string>
}

const col = (check: string, column: string) => {
  const c = parityColumns().find((x) => x.check === check && x.column === column)
  if (!c) throw new Error(`no column ${check}.${column}`)
  return c
}

// ── What the checks are ─────────────────────────────────────────────────────

describe('the parity checks', () => {
  it('reach all five classes, and each through a figure a dashboard shows', () => {
    const cols = parityColumns()
    for (const cls of CLASS_ORDER) expect(cols.filter((c) => c.classes.includes(cls)).length, cls).toBeGreaterThan(0)
  })

  it('file the columns the migration is known or expected to break under the right class', () => {
    expect(col('security', 'c_T1572').classes).toEqual(['A'])
    expect(col('findings', 'f2').classes).toEqual(['B'])
    expect(col('web-kpi', 'txns').classes).toEqual(['B'])
    expect(col('dns', 'resolvers').classes).toEqual(['C'])
    expect(col('host-presence', 'n').classes).toEqual(['D'])
    expect(col('code-presence', 'n').classes).toEqual(['D'])
    expect(col('web-kpi', 'server_p95').classes).toEqual(['E'])
    expect(col('capacity-kpi', 'rtt').classes).toEqual(['E'])
    expect(col('latency', 'net').classes).toEqual(['E'])
    expect(col('latency', 'net_lo').classes).toEqual(['E'])
    // The survivors the 2026-09-21 measurement found: a bare count, and a
    // comparison "" and 0 both fail.
    expect(col('findings', 'total').role).toBe('unaffected')
    expect(col('findings', 'f0').role).toBe('unaffected')
    expect(col('count', 'c').role).toBe('control')
  })

  it('label every column the query returns, and no column it does not', () => {
    for (const check of PARITY_CHECKS) {
      const returned = summarizeColumns(check.query).columns.map((c) => c.name).sort()
      expect(Object.keys(check.protects).sort(), check.id).toEqual(returned)
    }
  })

  it('run the dashboards’ own queries and fragments, not copies of them', () => {
    expect(PARITY_DNS_QUERY).toBe(OVERALL)
    expect(PARITY_WEB_KPI_QUERY).toBe(KPI)
    for (const p of PIVOTS) expect(PARITY_CAPACITY_KPI_QUERY).toBe(buildKpiQuery(p.key, ''))
    // Same aggregates as the per-minute panel, over the whole window.
    expect(latencyQuery.startsWith(PARITY_LATENCY_QUERY + ' by bin(_time, 1m)')).toBe(true)
    // Same presence heads as the panels.
    const head = (qs: string) => summarizeColumns(qs.replace(/ \| summarize .*/, ' | summarize n=count()')).head
    expect(summarizeColumns(PARITY_HOST_PRESENCE_QUERY).head).toBe(head(HOSTS))
    expect(summarizeColumns(PARITY_CODE_PRESENCE_QUERY).head).toBe(head(CODES))
    expect(summarizeColumns(PARITY_CODE_PRESENCE_QUERY).head).toBe(head(TREND))
  })

  it('refuse a grouped summarize, which would compare whichever group came first', () => {
    expect(() => summarizeColumns(HOSTS)).toThrow(/grouped/)
    expect(() => summarizeColumns(latencyQuery)).toThrow(/grouped/)
  })

  it('classify a presence head only when it is a bare =*', () => {
    expect(classify('count()', 'http_host=*')).toEqual(['D'])
    expect(classify('count()', 'app_name="dns"')).toEqual([])
    expect(classify('count()', 'src_ip="*10.0*"')).toEqual([])
  })
})

describe('what a parity run submits', () => {
  it('every check once per side, over one absolute window, the Parquet side reading its own dataset', () => {
    const jobs = parityJobs(WINDOW, DATASETS)
    expect(jobs).toHaveLength(PARITY_CHECKS.length * 2)
    for (const j of jobs) {
      expect(j.earliest).toBe(WINDOW.earliest)
      expect(j.latest).toBe(WINDOW.latest)
      expect(j.query.startsWith(`dataset="${DATASETS[j.side]}" `)).toBe(true)
    }
  })

  it('refuses a window, a pair or a dataset id it cannot trust', () => {
    expect(() => parityJobs({ earliest: 10, latest: 10 }, DATASETS)).toThrow()
    expect(() => parityJobs(WINDOW, { json: 'gigamon_ami', parquet: 'gigamon_ami' })).toThrow()
    expect(() => retarget(PARITY_DNS_QUERY, 'x" | delete')).toThrow()
    expect(() => retarget('dataset="cribl_metrics" | summarize c=count()', 'y')).toThrow()
  })
})

// ── The baseline ────────────────────────────────────────────────────────────

describe('a migration that changed nothing', () => {
  it('passes every class, and says so over the window it compared', () => {
    const r = compareParity(agreeing(), WINDOW, DATASETS)
    expect(r.comparable).toBe(true)
    expect(r.verdict).toBe('pass')
    for (const c of r.classes) expect(c.verdict, c.cls).toBe('pass')
    expect(r.sentence).toContain('gigamon_ami_pq')
    expect(r.sentence).toContain('2026-09-23 10:00:00–10:06:00 UTC')
  })
})

// ── Class by class ──────────────────────────────────────────────────────────

describe('class A — isnotnull(f)', () => {
  it('passes when the flow-signal count agrees', () => {
    expect(verdicts(withParquet(agreeing(), 'security', { c_T1572: 1_005 })).A).toBe('pass')
  })
  it('fails on the measured 18 → 43,338, and names the Security tile it would have faked', () => {
    const rows = withParquet(withJson(agreeing(), 'security', { c_T1572: 18 }), 'security', { c_T1572: 43_338 })
    const r = compareParity(rows, WINDOW, DATASETS)
    const a = r.classes.find((c) => c.cls === 'A')!
    expect(a.verdict).toBe('fail')
    expect(a.sentence).toContain('"Protocol Tunneling" (T1572)')
    expect(a.sentence).toContain('18 on gigamon_ami')
    expect(a.sentence).toContain('43,338 on gigamon_ami_pq')
    expect(r.verdict).toBe('fail')
  })
  it('fails on the zero/non-zero trap: both sides non-zero, magnitude wrong', () => {
    const rows = withParquet(withJson(agreeing(), 'security', { c_T1572: 18 }), 'security', { c_T1572: 40_280 })
    expect(verdicts(rows).A).toBe('fail')
  })
})

describe('class B — count(f)', () => {
  it('passes when the detection count agrees', () => {
    expect(verdicts(agreeing()).B).toBe('pass')
  })
  it('fails on the measured Findings f2 18 → 43,338', () => {
    const rows = withParquet(withJson(agreeing(), 'findings', { f2: 18 }), 'findings', { f2: 43_338 })
    expect(verdicts(rows).B).toBe('fail')
  })
  it('fails when a detection with nothing on JSON fires on Parquet', () => {
    const rows = withParquet(withJson(agreeing(), 'findings', { f4: 0 }), 'findings', { f4: 31_972 })
    expect(verdicts(rows).B).toBe('fail')
  })
})

describe('class C — dcount(f)', () => {
  it('passes when the distinct count agrees', () => {
    expect(verdicts(agreeing()).C).toBe('pass')
  })
  it('fails on the one extra distinct value "" adds to a small count', () => {
    const r = compareParity(withParquet(agreeing(), 'dns', { resolvers: 13 }), WINDOW, DATASETS)
    const c = r.classes.find((x) => x.cls === 'C')!
    expect(c.verdict).toBe('fail')
    expect(c.sentence).toContain('"Distinct resolvers" tile')
  })
  it('cannot see +1 on a count of 100 or more, and its pass sentence says so', () => {
    const rows = withParquet(withJson(agreeing(), 'dns', { resolvers: 500 }), 'dns', { resolvers: 501 })
    const c = compareParity(rows, WINDOW, DATASETS).classes.find((x) => x.cls === 'C')!
    expect(c.verdict).toBe('pass')
    expect(c.sentence).toMatch(/only while the count is under 100/)
  })
})

describe('class D — f=* presence filter', () => {
  it('passes when the filter admits the same rows on both sides', () => {
    expect(verdicts(agreeing()).D).toBe('pass')
  })
  it('fails when http_host=* admits every row of the window', () => {
    const rows = withParquet(agreeing(), 'host-presence', { n: 100_000 })
    expect(verdicts(rows).D).toBe('fail')
  })
  it('fails when the numeric http_code=* admits every row, even if the string filter held', () => {
    const rows = withParquet(agreeing(), 'code-presence', { n: 100_000 })
    const d = compareParity(rows, WINDOW, DATASETS).classes.find((x) => x.cls === 'D')!
    expect(d.verdict).toBe('fail')
    expect(d.sentence).toContain('"Status codes"')
  })
})

describe('class E — percentile / avg / min(f)', () => {
  it('passes when the latency figures agree within their tolerance', () => {
    const rows = withParquet(agreeing(), 'web-kpi', { server_p95: 0.042 * 1.03 })
    expect(verdicts(rows).E).toBe('pass')
  })
  it('fails when a percentile collapses to 0', () => {
    const r = compareParity(withParquet(agreeing(), 'web-kpi', { server_p95: 0 }), WINDOW, DATASETS)
    const e = r.classes.find((x) => x.cls === 'E')!
    expect(e.verdict).toBe('fail')
    expect(e.sentence).toContain('"Server think-time p95" tile')
  })
  it('fails when min is dragged to 0 by rows that had no value', () => {
    expect(verdicts(withParquet(agreeing(), 'latency', { net_lo: 0 })).E).toBe('fail')
  })
  it('fails when an average is pulled down by synthetic zeros', () => {
    expect(verdicts(withParquet(agreeing(), 'capacity-kpi', { rtt: 0.042 * 0.6 })).E).toBe('fail')
  })
  it('fails when JSON had no value and Parquet reads 0 — "no value" and "0 ms" are different tiles', () => {
    const rows = withParquet(withJson(agreeing(), 'web-kpi', { server_p95: null }), 'web-kpi', { server_p95: 0 })
    expect(verdicts(rows).E).toBe('fail')
  })
})

// ── What gates the verdict ──────────────────────────────────────────────────

describe('the control', () => {
  it('judges no class when the flat counts disagree, rather than blaming Parquet for landing lag', () => {
    const rows = withParquet(withParquet(agreeing(), 'count', { c: 90_000 }), 'security', { c_T1572: 43_338 })
    const r = compareParity(rows, WINDOW, DATASETS)
    expect(r.comparable).toBe(false)
    expect(r.verdict).toBe('incomparable')
    for (const c of r.classes) expect(c.verdict, c.cls).toBe('incomparable')
    expect(r.classes[0].sentence).toMatch(/did not hold the same records/)
  })
  it('judges no class over an empty window', () => {
    const rows = withParquet(withJson(agreeing(), 'count', { c: 0 }), 'count', { c: 0 })
    expect(compareParity(rows, WINDOW, DATASETS).verdict).toBe('incomparable')
  })
})

describe('a class with nothing to compare', () => {
  it('is "not exercised", never a pass, and the run is partial', () => {
    let rows = agreeing()
    for (const check of ['host-presence', 'code-presence']) rows = withParquet(withJson(rows, check, { n: 0 }), check, { n: 0 })
    const r = compareParity(rows, WINDOW, DATASETS)
    expect(r.classes.find((c) => c.cls === 'D')!.verdict).toBe('unexercised')
    expect(r.verdict).toBe('partial')
    expect(r.sentence).toMatch(/class D had nothing to compare/)
  })
})

// ── WHAT THESE TESTS CANNOT ASSERT ──────────────────────────────────────────
// * That Parquet actually fails C, D and E the way these cases model it. The
//   A and B magnitudes are measured; the C, D and E ones are the mechanism's
//   prediction. Only a parity run against two real datasets settles them.
// * That ±1 % and ±5 % are the right tolerances. They are chosen, and a real
//   JSON-vs-JSON run over the same window is what would calibrate them.
// * That a pass on the whole-window latency aggregate implies a pass on every
//   per-minute point of the panel it stands for.
