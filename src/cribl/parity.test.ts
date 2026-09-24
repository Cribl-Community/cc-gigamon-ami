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
  compareColumn,
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
    expect(a.sentence).toContain('Under Parquet this aggregate is true on every row')
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
  it('cannot see +1 on a count of 100 or more, so a run with no smaller figure is not exercised, not a pass', () => {
    // web-kpi.hosts is 1,000 in the baseline: +1 there is inside ±1 % already.
    const rows = withParquet(withJson(agreeing(), 'dns', { resolvers: 500 }), 'dns', { resolvers: 501 })
    const r = compareParity(rows, WINDOW, DATASETS)
    const c = r.classes.find((x) => x.cls === 'C')!
    expect(c.verdict).toBe('unexercised')
    expect(c.sentence).toMatch(/only while the count is under 100/)
    expect(r.verdict).toBe('partial')
  })
  it('says in its pass sentence that the resolvers figure reads only DNS rows', () => {
    const c = compareParity(agreeing(), WINDOW, DATASETS).classes.find((x) => x.cls === 'C')!
    expect(c.verdict).toBe('pass')
    expect(c.sentence).toMatch(/reads only app_name="dns" rows/)
    // The 1,000-host figure agreed, but inside a slack +1 fits in: named, not counted.
    expect(c.sentence).toMatch(/1 more agreed only inside a slack/)
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
  it('fails when JSON read 0 and Parquet reads a number — 0 on one side is not "nothing to compare"', () => {
    const rows = withParquet(withJson(agreeing(), 'latency', { net_lo: 0 }), 'latency', { net_lo: 0.042 })
    expect(verdicts(rows).E).toBe('fail')
  })
  it('passes a figure 4 % off and fails one 6 % off: ±5 % is the tolerance, not a bound nothing reaches', () => {
    expect(verdicts(withParquet(agreeing(), 'capacity-kpi', { rtt: 0.042 * 1.04 })).E).toBe('pass')
    expect(verdicts(withParquet(agreeing(), 'capacity-kpi', { rtt: 0.042 * 1.06 })).E).toBe('fail')
  })
})

describe('the count tolerance', () => {
  it('passes a count 0.9 % off and fails one 1.5 % off when the control agreed exactly', () => {
    expect(verdicts(withParquet(agreeing(), 'findings', { f2: 1_009 })).B).toBe('pass')
    expect(verdicts(withParquet(agreeing(), 'findings', { f2: 1_015 })).B).toBe('fail')
  })
})

describe('the count slack the control’s own drift allows', () => {
  // The control 0.8 % apart: inside its ±1 %, so the run is judged — and 800
  // records are on one side and not the other.
  const drifted = () => withParquet(agreeing(), 'count', { c: 99_200 })

  it('does not report a one-record window-edge difference in a rare count as the class A failure', () => {
    const rows = withParquet(withJson(drifted(), 'security', { c_T1572: 18 }), 'security', { c_T1572: 19 })
    const r = compareParity(rows, WINDOW, DATASETS)
    expect(r.comparable).toBe(true)
    expect(r.drift).toBeCloseTo(0.008, 6)
    expect(r.classes.find((c) => c.cls === 'A')!.verdict).toBe('pass')
    // Not 'pass': the same slack hides class C's +1 (below), and the run says so.
    expect(r.verdict).toBe('partial')
    expect(r.sentence).toMatch(/class C was not exercised/)
  })
  it('allows whole records in proportion, not a blanket margin: 18 → 20 still fails', () => {
    const rows = withParquet(withJson(drifted(), 'security', { c_T1572: 18 }), 'security', { c_T1572: 20 })
    expect(verdicts(rows).A).toBe('fail')
  })
  it('still fails the measured 18 → 40,280, and says the allowance was widened', () => {
    const rows = withParquet(withJson(drifted(), 'security', { c_T1572: 18 }), 'security', { c_T1572: 40_280 })
    const a = compareParity(rows, WINDOW, DATASETS).classes.find((c) => c.cls === 'A')!
    expect(a.verdict).toBe('fail')
    expect(a.sentence).toMatch(/widened by the control's own drift of 0\.8 %/)
  })
  it('makes +1 distinct invisible, so class C on a drifted run is not exercised rather than passed', () => {
    expect(verdicts(withParquet(drifted(), 'dns', { resolvers: 13 })).C).toBe('unexercised')
  })
  it('gives a count of 0 the same one record: 0 → 1 agrees under drift, and fails with none', () => {
    const t1572 = (rows: Rows) =>
      compareParity(rows, WINDOW, DATASETS).classes.find((c) => c.cls === 'A')!.columns.find((c) => c.column === 'c_T1572')!
    const zeroToOne = (base: Rows) => withParquet(withJson(base, 'security', { c_T1572: 0 }), 'security', { c_T1572: 1 })
    expect(t1572(zeroToOne(drifted())).verdict).toBe('agrees')
    expect(t1572(zeroToOne(drifted())).allowed).toBe(1)
    expect(verdicts(zeroToOne(drifted())).A).toBe('pass')
    expect(t1572(zeroToOne(agreeing())).verdict).toBe('differs')
    expect(verdicts(zeroToOne(agreeing())).A).toBe('fail')
  })
  it('allows 0 → 1, not 0 → 2, and never 0 → 40,280', () => {
    const from0 = (n: number) => withParquet(withJson(drifted(), 'security', { c_T1572: 0 }), 'security', { c_T1572: n })
    expect(verdicts(from0(2)).A).toBe('fail')
    const a = compareParity(from0(40_280), WINDOW, DATASETS).classes.find((c) => c.cls === 'A')!
    expect(a.verdict).toBe('fail')
    expect(a.sentence).toContain('Under Parquet this aggregate is true on every row')
  })
  it('sizes the allowance by the drift, not a multiple of it: 1,000 at 1.5 % drift allows 15', () => {
    const f2 = col('findings', 'f2')
    const at = (p: number) => compareColumn(f2, { f2: 1_000 }, { f2: p }, 0.015)
    expect(at(1_015).allowed).toBe(15)
    expect(at(1_015).verdict).toBe('agrees')
    expect(at(1_016).verdict).toBe('differs')
    expect(at(985).verdict).toBe('agrees')
    expect(at(984).verdict).toBe('differs')
  })
  it('lets the tolerance win where it is larger: 1,000 on a 0.8 % run allows 10, not 8 or more', () => {
    expect(verdicts(withParquet(drifted(), 'findings', { f2: 1_010 })).B).toBe('pass')
    expect(verdicts(withParquet(drifted(), 'findings', { f2: 1_011 })).B).toBe('fail')
  })
})

describe('a min or max on a run whose control drifted', () => {
  const drifted = () => withParquet(agreeing(), 'count', { c: 99_200 })
  const netLo = (rows: Rows) =>
    compareParity(rows, WINDOW, DATASETS).classes.find((c) => c.cls === 'E')!.columns.find((c) => c.column === 'net_lo')!

  it('is window-edge noise when Parquet still holds a value: not the class E failure, and not blamed on Parquet', () => {
    const rows = withParquet(withJson(drifted(), 'latency', { net_lo: 0.004 }), 'latency', { net_lo: 0.003 })
    const r = compareParity(rows, WINDOW, DATASETS)
    const e = r.classes.find((c) => c.cls === 'E')!
    expect(netLo(rows).verdict).toBe('edge')
    expect(e.verdict).toBe('pass')
    expect(r.verdict).not.toBe('fail')
    expect(e.sentence).toMatch(/1 min or max figure moved beyond ±5 % with a non-zero value still on gigamon_ami_pq/)
    expect(e.sentence).toMatch(/evidence neither of that failure nor of its absence/)
    expect(e.sentence).not.toMatch(/dragged toward 0 by rows/)
  })
  it('is not evidence for the class: with nothing else to compare, class E is not exercised', () => {
    let rows = withParquet(withJson(drifted(), 'latency', { net_lo: 0.004 }), 'latency', { net_lo: 0.003 })
    for (const [check, column] of [['latency', 'net'], ['latency', 'app'], ['latency', 'app_lo'], ['web-kpi', 'server_p95'], ['capacity-kpi', 'rtt']]) {
      rows = withParquet(withJson(rows, check, { [column]: 0 }), check, { [column]: 0 })
    }
    const r = compareParity(rows, WINDOW, DATASETS)
    const e = r.classes.find((c) => c.cls === 'E')!
    expect(e.verdict).toBe('unexercised')
    expect(e.sentence).toMatch(/1 of 6 was a min or max that moved within window-edge noise; 5 of 6 were empty or zero on both sides/)
    expect(r.verdict).toBe('partial')
  })
  it('is still the class E failure when Parquet went to 0 or to no value', () => {
    for (const v of [0, null]) {
      const rows = withParquet(withJson(drifted(), 'latency', { net_lo: 0.004 }), 'latency', { net_lo: v })
      const e = compareParity(rows, WINDOW, DATASETS).classes.find((c) => c.cls === 'E')!
      expect(e.verdict, String(v)).toBe('fail')
      expect(e.sentence).toContain('Under Parquet this aggregate is dragged toward 0 by rows that never had a value')
    }
  })
  it('is a failure, with the mechanism named, when the control agreed exactly', () => {
    const rows = withParquet(withJson(agreeing(), 'latency', { net_lo: 0.004 }), 'latency', { net_lo: 0.003 })
    expect(netLo(rows).verdict).toBe('differs')
    expect(compareParity(rows, WINDOW, DATASETS).classes.find((c) => c.cls === 'E')!.sentence).toContain('dragged toward 0')
  })
  it('does the same for the maxima outside the classes: noise when non-zero, a failure at 0', () => {
    const moved = compareParity(withParquet(drifted(), 'latency', { net_hi: 0.03, app_hi: 0.03 }), WINDOW, DATASETS)
    expect(moved.unaffected.find((c) => c.column === 'net_hi')!.verdict).toBe('edge')
    // Partial, not pass: the drift that makes these noise also hides class C.
    expect(moved.verdict).toBe('partial')
    expect(moved.sentence).toMatch(/class C was not exercised .* 2 unclassed min or max figures moved beyond ±5 %/)
    expect(moved.sentence).toMatch(/counted neither way/)
    expect(compareParity(withParquet(drifted(), 'latency', { net_hi: 0 }), WINDOW, DATASETS).verdict).toBe('fail')
  })
  it('does not touch a percentile or an average, which ±5 % still judges', () => {
    expect(verdicts(withParquet(drifted(), 'capacity-kpi', { rtt: 0.042 * 1.06 })).E).toBe('fail')
  })
})

describe('a failure sentence', () => {
  it('names the mechanism only for a figure that moved the way the mechanism moves it', () => {
    const e = compareParity(withParquet(agreeing(), 'capacity-kpi', { rtt: 0.042 * 1.06 }), WINDOW, DATASETS).classes.find((c) => c.cls === 'E')!
    expect(e.verdict).toBe('fail')
    expect(e.sentence).not.toMatch(/Under Parquet this aggregate/)
    expect(e.sentence).toMatch(/It did not move the way Parquet's null semantics predicts .*not that mechanism/)
    const b = compareParity(withParquet(agreeing(), 'findings', { f2: 500, f3: 43_338 }), WINDOW, DATASETS).classes.find((c) => c.cls === 'B')!
    expect(b.sentence).toMatch(/1 of these moved the way Parquet's null semantics predicts .*the other 1 did not, so for that one/)
  })
})

describe('figures outside the five classes', () => {
  it('are compared and counted: a SERVFAIL count gone to 0 fails the run and names its tile', () => {
    expect(col('dns', 'sf').role).toBe('unaffected')
    const r = compareParity(withParquet(agreeing(), 'dns', { sf: 0, nx: 0 }), WINDOW, DATASETS)
    for (const c of r.classes) expect(c.verdict, c.cls).toBe('pass')
    expect(r.verdict).toBe('fail')
    expect(r.sentence).toMatch(/2 figures outside the five null classes changed/)
    expect(r.sentence).toContain('"SERVFAIL / error rate" tile (SERVFAIL): 1,000 on gigamon_ami, 0 on gigamon_ami_pq')
  })
  it('fail on a total outside tolerance, and on a max, which belongs to no class', () => {
    expect(compareParity(withParquet(agreeing(), 'capacity-kpi', { total: 1 }), WINDOW, DATASETS).sentence).toContain('"Total traffic" tile')
    expect(col('latency', 'net_hi').role).toBe('unaffected')
    expect(compareParity(withParquet(agreeing(), 'latency', { net_hi: 0 }), WINDOW, DATASETS).verdict).toBe('fail')
  })
  it('are named beside a class failure, not hidden by it', () => {
    const rows = withParquet(withParquet(withJson(agreeing(), 'security', { c_T1572: 18 }), 'security', { c_T1572: 43_338 }), 'dns', { sf: 0 })
    expect(compareParity(rows, WINDOW, DATASETS).sentence).toMatch(/class A changed a dashboard number; and 1 figure outside the five null classes changed/)
  })
})

describe('a check that did not run', () => {
  it('is "not run", never "nothing in this window", when neither side answered', () => {
    const rows: Rows = agreeing()
    delete rows['host-presence']
    delete rows['code-presence']
    const r = compareParity(rows, WINDOW, DATASETS)
    const d = r.classes.find((c) => c.cls === 'D')!
    expect(d.verdict).toBe('notrun')
    expect(d.sentence).toMatch(/got no result from either gigamon_ami or gigamon_ami_pq/)
    expect(d.sentence).toMatch(/not a statement about the window/)
    expect(d.sentence).not.toMatch(/empty or zero/)
    expect(r.verdict).toBe('incomplete')
    expect(r.sentence).toMatch(/class D was not judged/)
    expect(r.sentence).not.toMatch(/nothing to compare|not exercised/)
  })
  it('is "not run", not a Parquet difference, when only the Parquet side has no row', () => {
    const rows: Rows = { ...agreeing(), security: { json: agreeing().security.json, parquet: null } }
    const r = compareParity(rows, WINDOW, DATASETS)
    const a = r.classes.find((c) => c.cls === 'A')!
    expect(a.verdict).toBe('notrun')
    expect(a.sentence).toContain('got no result from gigamon_ami_pq')
    expect(r.verdict).toBe('incomplete')
  })
  it('makes a run incomplete when only figures outside the classes are missing', () => {
    // A check list whose only non-control check is DNS, with DNS never answered:
    // its class C figure and its unclassed reply-code counts all went unjudged.
    const checks = PARITY_CHECKS.filter((c) => c.id === 'count' || c.id === 'dns')
    const r = compareParity({ count: agreeing().count }, WINDOW, DATASETS, checks)
    expect(r.verdict).toBe('incomplete')
    expect(r.sentence).toMatch(/check dns/)
  })
  it('names the classes that were not exercised, when only unclassed figures went unrun', () => {
    // A check whose only figure belongs to no class, never answered; and class D
    // empty on both sides.
    const bare = { id: 'bare', query: 'dataset="gigamon_ami" | summarize k=sum(bytes)', protects: { k: 'a bare sum' } }
    let rows: Rows = agreeing()
    for (const check of ['host-presence', 'code-presence']) rows = withParquet(withJson(rows, check, { n: 0 }), check, { n: 0 })
    const r = compareParity(rows, WINDOW, DATASETS, [...PARITY_CHECKS, bare])
    expect(r.verdict).toBe('incomplete')
    expect(r.sentence).toMatch(/so figures outside the five classes were not judged\. Class D was also not exercised/)
  })
  it('is still said when the run failed for another reason', () => {
    const rows: Rows = withParquet(withJson(agreeing(), 'security', { c_T1572: 18 }), 'security', { c_T1572: 43_338 })
    delete rows['code-presence']
    const r = compareParity(rows, WINDOW, DATASETS)
    expect(r.verdict).toBe('fail')
    expect(r.sentence).toMatch(/Also, 1 figure got no result/)
  })
  it('is what the report says when the control count itself did not run', () => {
    const rows: Rows = agreeing()
    delete rows.count
    const r = compareParity(rows, WINDOW, DATASETS)
    expect(r.verdict).toBe('incomparable')
    expect(r.sentence).toMatch(/control count got no result/)
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
    const r = compareParity(rows, WINDOW, DATASETS)
    expect(r.verdict).toBe('incomparable')
    expect(r.sentence).toMatch(/held no records/)
  })
})

describe('a class with nothing to compare', () => {
  it('is "not exercised", never a pass, and the run is partial', () => {
    let rows = agreeing()
    for (const check of ['host-presence', 'code-presence']) rows = withParquet(withJson(rows, check, { n: 0 }), check, { n: 0 })
    const r = compareParity(rows, WINDOW, DATASETS)
    expect(r.classes.find((c) => c.cls === 'D')!.verdict).toBe('unexercised')
    expect(r.verdict).toBe('partial')
    expect(r.sentence).toMatch(/class D was not exercised/)
  })
})

// ── WHAT THESE TESTS CANNOT ASSERT ──────────────────────────────────────────
// * That Parquet actually fails C, D and E the way these cases model it. The
//   A and B magnitudes are measured; the C, D and E ones are the mechanism's
//   prediction. Only a parity run against two real datasets settles them.
// * That ±1 % and ±5 % are the right tolerances. They are chosen, and a real
//   JSON-vs-JSON run over the same window is what would calibrate them. The
//   cases above pin THAT they are the tolerances (just inside passes, just
//   outside fails), not that they are right.
// * That the control's drift hits a rare count in proportion. The slack assumes
//   the records one side lacks are a fair sample of the window; records lost at
//   one edge of it need not be.
// * That class C's resolvers figure can show anything at all: see the header
//   of parity.ts on DNS-only rows.
// * That a pass on the whole-window latency aggregate implies a pass on every
//   per-minute point of the panel it stands for.
