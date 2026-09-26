// The parity runner's decisions (parityRun.ts): which windows, which entries,
// how rows are compared, and that the evidence it builds is exactly what the
// routing table accepts. Pure: nothing here submits anything. The end-to-end run
// against a fake transport is parityRunJob.test.ts.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMPLETENESS_BUCKET_SECONDS as B } from '../queries/routing'
import type { FieldType, Row } from './parity'
import {
  comparisonText,
  compareQueryRows,
  entryOutcome,
  parityCostFloor,
  parityRunWindows,
  planEntries,
  querySpec,
  topNFetchLimit,
  type RunResult,
  type RunWindow,
  type WindowResult,
} from './parityRun'
import { COMPLETENESS_SETTLE_SECONDS, bucketRecords, windowCompleteness } from './routing/completeness'
import { ROUTES, tableProblems, type RouteEntry } from './routing/table'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NOW = Date.UTC(2026, 9, 1, 12, 7, 31) / 1000
const hourOf = (s: number) => new Date(s * 1000).getUTCHours()

describe('parityRunWindows', () => {
  it('picks three settled windows on the bucket grid, each starting in a different UTC hour', () => {
    const ws = parityRunWindows(NOW)
    expect(ws).toHaveLength(3)
    expect(new Set(ws.map((w) => hourOf(w.earliest))).size).toBe(3)
    for (const w of ws) {
      expect(w.latest - w.earliest).toBe(15 * 60)
      expect(w.earliest % B).toBe(0)
      expect(w.latest % B).toBe(0)
      expect(w.latest).toBeLessThanOrEqual(NOW - COMPLETENESS_SETTLE_SECONDS)
    }
  })

  it('makes windows a completeness check read at the reference time can prove settled', () => {
    for (const w of parityRunWindows(NOW)) {
      const rows = []
      for (let t = w.earliest; t < w.latest; t += B) rows.push({ bin_time_5m: t, json_events: 10, pq_events: 10 })
      const recs = new Map(bucketRecords(rows, NOW).map((r) => [r.start, r]))
      expect(windowCompleteness(w, NOW, recs)).toEqual({ complete: true, why: null })
    }
  })

  it('refuses, before anything is billed, a plan the table would refuse as evidence', () => {
    expect(() => parityRunWindows(NOW, { offsetsHours: [0, 24, 48] })).toThrow(/same UTC hour/)
    expect(() => parityRunWindows(NOW, { offsetsHours: [0, 6] })).toThrow(/at least 3/)
    expect(() => parityRunWindows(NOW, { minutes: 7 })).toThrow(/whole number/)
    expect(() => parityRunWindows(NOW, { offsetsHours: [0, 6, 12.1] })).toThrow(/bucket grid/)
    expect(() => parityRunWindows(NOW, { offsetsHours: [0, -6, 12] })).toThrow(/non-negative/)
  })

  it('refuses a reference time later than the real clock, before anything is billed', () => {
    // --at tomorrow: every window would end in the future, and each would still bill a completeness job.
    expect(() => parityRunWindows(NOW + 86_400, { clockSec: NOW })).toThrow(/later than now/)
    expect(parityRunWindows(NOW, { clockSec: NOW })).toHaveLength(3)
    expect(parityRunWindows(NOW - 3600, { clockSec: NOW })).toHaveLength(3)
  })

  it('the runner hands it the real clock', () => {
    expect(readFileSync(join(ROOT, 'scripts/parity-run.mjs'), 'utf8')).toMatch(/parityRunWindows\(nowSec, \{[^}]*clockSec: Math\.floor\(startedMs \/ 1000\)/)
  })
})

describe('querySpec', () => {
  it('reads every text of every entry that can run', () => {
    for (const e of ROUTES) {
      if (e.pin) continue
      for (const q of e.queries) expect(querySpec(q).ok, `${e.id}: ${q}`).toBe(true)
    }
  })

  it('reads keys, aggregates, order and limit', () => {
    const r = querySpec('dataset="gigamon_ami" http_code=* | summarize n=count(), p=percentile(x,95) by http_code, bin(_time, 1m) | sort by n desc | limit 12')
    expect(r).toEqual({
      ok: true,
      spec: {
        keys: ['http_code', 'bin_time_1m'],
        aggregates: [
          { name: 'n', expr: 'count()', kind: 'count', distinct: false },
          { name: 'p', expr: 'percentile(x,95)', kind: 'distribution', distinct: false },
        ],
        order: { column: 'n', dir: 'desc' },
        limit: 12,
      },
    })
  })

  it('refuses what it cannot compare, and says why', () => {
    expect(querySpec('dataset="gigamon_ami" | limit 5')).toMatchObject({ ok: false, why: expect.stringMatching(/no summarize/) })
    expect(querySpec('dataset="gigamon_ami" | summarize count() by a')).toMatchObject({ ok: false, why: expect.stringMatching(/unnamed/) })
    expect(querySpec('dataset="gigamon_ami" | summarize n=count() | extend r=n*2')).toMatchObject({ ok: false, why: expect.stringMatching(/does not read/) })
    expect(querySpec('dataset="gigamon_ami" | summarize n=make_set(a)')).toMatchObject({ ok: false, why: expect.stringMatching(/cannot classify/) })
    expect(querySpec('dataset="gigamon_ami" | summarize n=count() by tolower(a)')).toMatchObject({ ok: false, why: expect.stringMatching(/cannot name/) })
  })
})

describe('compareQueryRows', () => {
  const TOP = 'dataset="gigamon_ami" http_code=* | summarize n=count() by http_code | sort by n desc | limit 3'
  const rows = (pairs: [unknown, number][]): Row[] => pairs.map(([k, n]) => (k === undefined ? { n } : { http_code: k, n }))

  it('passes the same top N', () => {
    const j = rows([[200, 900], [404, 50], [500, 10]])
    expect(compareQueryRows(TOP, j, j).verdict).toBe('pass')
  })

  it('fails a group Parquet fills with "" where JSON has none (class F)', () => {
    const j = rows([[200, 900], [404, 50], [500, 10]])
    const p = rows([[200, 900], ['', 400], [404, 50]])
    const c = compareQueryRows(TOP, j, p)
    expect(c.verdict).toBe('fail')
    expect(c.report?.onlyParquet).toContain('""')
  })

  it('will not compare an unordered limit that was reached: which rows came back is arbitrary', () => {
    const q = 'dataset="gigamon_ami" a in ("x") | summarize pqc=count() by b | limit 2'
    const two = [{ b: 'p', pqc: 1 }, { b: 'q', pqc: 2 }]
    expect(compareQueryRows(q, two, two).verdict).toBe('incomparable')
    expect(compareQueryRows(q, two.slice(0, 1), two.slice(0, 1)).verdict).toBe('pass')
  })

  it('holds a text figure to exact equality, absent and "" different', () => {
    const q = 'dataset="gigamon_ami" s=* | summarize flows=count(), issuer=max(ssl_issuer) by s | sort by flows desc | limit 5'
    const j = [{ s: 'a', flows: 10 }]
    const p = [{ s: 'a', flows: 10, issuer: '' }]
    const c = compareQueryRows(q, j, p)
    expect(c.verdict).toBe('fail')
    expect(c.textDiffers).toEqual([{ key: '"a"', column: 'issuer', json: null, parquet: '' }])
    expect(compareQueryRows(q, [{ s: 'a', flows: 10, issuer: 'CA' }], [{ s: 'a', flows: 10, issuer: 'CA' }]).verdict).toBe('pass')
  })

  it('calls "" on both sides of a text figure unexercised, never a pass', () => {
    const q = 'dataset="gigamon_ami" | summarize issuer=max(ssl_issuer)'
    expect(compareQueryRows(q, [{ issuer: '' }], [{ issuer: '' }]).verdict).toBe('unexercised')
    expect(compareQueryRows(q, [{ issuer: 'CA' }], [{ issuer: 'CA' }]).verdict).toBe('pass')
  })

  it('widens a count by the control\'s drift, and only by it', () => {
    const q = 'dataset="gigamon_ami" | summarize events=count()'
    // 3 % apart: outside the 1 % count tolerance with no drift, inside it once the control drifted 5 %.
    expect(compareQueryRows(q, [{ events: 10_000 }], [{ events: 10_300 }], 0).verdict).toBe('fail')
    expect(compareQueryRows(q, [{ events: 10_000 }], [{ events: 10_300 }], 0.05).verdict).toBe('pass')
  })
})

describe('compareQueryRows and a distinct count (owner decision 2026-09-25)', () => {
  const SCALAR = 'dataset="gigamon_ami" app_name="dns" | summarize total=count(), resolvers=dcount(dns_host)'
  const TOP = 'dataset="gigamon_ami" app_name=* | summarize flows=count(), users=count_distinct(src_ip) by app_name | sort by flows desc | limit 3'

  it('marks exactly the dcount/dcountif/count_distinct aggregates as distinct counts', () => {
    const spec = querySpec('dataset="gigamon_ami" | summarize a=count(), b=dcount(x), c=dcountif(x, y=="1"), d=count_distinct(x), e=sum(x), f=countif(x=="1")')
    expect(spec.ok && spec.spec.aggregates.map((a) => [a.name, a.distinct])).toEqual([
      ['a', false], ['b', true], ['c', true], ['d', true], ['e', false], ['f', false],
    ])
  })

  it('passes a scalar dcount one off either way, and fails it two off', () => {
    expect(compareQueryRows(SCALAR, [{ total: 5000, resolvers: 12 }], [{ total: 5000, resolvers: 11 }]).verdict).toBe('pass')
    expect(compareQueryRows(SCALAR, [{ total: 5000, resolvers: 12 }], [{ total: 5000, resolvers: 13 }]).verdict).toBe('pass')
    const c = compareQueryRows(SCALAR, [{ total: 5000, resolvers: 12 }], [{ total: 5000, resolvers: 14 }])
    expect(c.verdict).toBe('fail')
    expect(c.report?.differs).toEqual([{ key: '', column: 'resolvers', json: 12, parquet: 14, allowed: 1 }])
    expect(c.grouped?.distinct).toEqual(['resolvers'])
  })

  it('gives it to the distinct-count column only, inside a top N too: a count() one off on a small count fails', () => {
    const j = [{ app_name: 'dns', flows: 90, users: 12 }, { app_name: 'http', flows: 50, users: 30 }, { app_name: 'ssh', flows: 20, users: 4 }]
    const usersOff = j.map((r) => (r.app_name === 'ssh' ? { ...r, users: 5 } : r))
    expect(compareQueryRows(TOP, j, usersOff).verdict).toBe('pass')
    const flowsOff = j.map((r) => (r.app_name === 'ssh' ? { ...r, flows: 21 } : r))
    const c = compareQueryRows(TOP, j, flowsOff)
    expect(c.verdict).toBe('fail')
    expect(c.report?.differs.map((d) => `${d.key}.${d.column}`)).toEqual(['"ssh".flows'])
  })

  it('does not excuse a key’s place in a top N its distinct count ranks, when the count moved by one', () => {
    const RANKED = 'dataset="gigamon_ami" app_name=* | summarize users=dcount(src_ip) by app_name | sort by users desc | limit 2'
    const j = [{ app_name: 'dns', users: 20 }, { app_name: 'http', users: 10 }, { app_name: 'ssh', users: 9 }]
    const p = [{ app_name: 'dns', users: 20 }, { app_name: 'http', users: 9 }, { app_name: 'ssh', users: 10 }]
    const c = compareQueryRows(RANKED, j, p)
    expect(c.report?.differs).toEqual([])
    expect(c.verdict).toBe('fail')
    expect(c.report?.onlyJson).toEqual(['"http"'])
  })
})

describe('compareQueryRows over a time bin', () => {
  const TREND = ROUTES.find((e) => e.id === 'tcp.trend')!.queries[0]
  // A live result names a `bin(_time, 1m)` key `bin_time_1m`, as the charts read it.
  const live = (vs: [number, number, number][]): Row[] => vs.map(([t, v, flows]) => ({ bin_time_1m: t, v, flows }))

  it('compares every minute, so one wrong minute fails', () => {
    const j = live([[1000, 10, 100], [1060, 5, 50], [1120, 7, 70]])
    const p = live([[1000, 10, 100], [1060, 0, 0], [1120, 1, 900]])
    const c = compareQueryRows(TREND, j, p)
    expect(c.verdict).toBe('fail')
    expect([...(c.report?.compared ?? [])].sort()).toEqual(['1000', '1060', '1120'])
    expect(compareQueryRows(TREND, j, j).verdict).toBe('pass')
  })

  it('will not compare rows it cannot tell apart: a key column no row carries, or two rows under one key', () => {
    const noKey = [{ _time: 1000, v: 1, flows: 1 }, { _time: 1060, v: 2, flows: 2 }]
    expect(compareQueryRows(TREND, noKey, noKey)).toMatchObject({ verdict: 'incomparable', sentence: expect.stringMatching(/key column bin_time_1m/) })
    const dup = live([[1000, 1, 1], [1000, 2, 2]])
    expect(compareQueryRows(TREND, dup, live([[1000, 1, 1]]))).toMatchObject({ verdict: 'incomparable', sentence: expect.stringMatching(/two JSON rows share the key 1000/) })
    // Scalar: more than one row is not one group.
    const q = 'dataset="gigamon_ami" | summarize events=count()'
    expect(compareQueryRows(q, [{ events: 1 }, { events: 2 }], [{ events: 1 }]).verdict).toBe('incomparable')
  })
})

describe('a top N and a tie at its boundary', () => {
  const TOP = 'dataset="gigamon_ami" http_code=* | summarize n=count() by http_code | sort by n desc | limit 3'

  it('is submitted with its limit raised, and compared at its own N', () => {
    expect(comparisonText(TOP)).toBe(TOP.replace('limit 3', `limit ${topNFetchLimit(3)}`))
    expect(topNFetchLimit(3)).toBeGreaterThan(3)
    expect(topNFetchLimit(120)).toBe(240)
    const hosts = ROUTES.find((e) => e.id === 'web.hosts')!.queries[0]
    expect(comparisonText(hosts)).toMatch(/\| limit 62$/)
    // Anything that is not a descending top N runs exactly as written.
    for (const q of ['dataset="gigamon_ami" | summarize events=count()', 'dataset="gigamon_ami" a in ("x") | summarize pqc=count() by b | limit 2', ROUTES.find((e) => e.id === 'tcp.trend')!.queries[0]]) {
      expect(comparisonText(q)).toBe(q)
    }
  })

  it('passes identical data whose tie at rank N the server broke differently, once it can see past the cut', () => {
    // Ranks 1–2 are 900 and 50; 500 and 503 both have n=2. Cut at 3, JSON kept 500 and Parquet 503.
    const j = [{ http_code: 200, n: 900 }, { http_code: 404, n: 50 }, { http_code: 500, n: 2 }, { http_code: 503, n: 2 }]
    const p = [{ http_code: 200, n: 900 }, { http_code: 404, n: 50 }, { http_code: 503, n: 2 }, { http_code: 500, n: 2 }]
    const c = compareQueryRows(TOP, j, p)
    expect(c.verdict).toBe('pass')
    expect(c.report?.tied.sort()).toEqual(['500', '503'])
  })

  it('will not judge a key the other side cut at the raised limit: neither fail nor pass', () => {
    const fetched = topNFetchLimit(3)
    const filler = (from: number) => Array.from({ length: fetched - 3 }, (_, i) => ({ http_code: from + i, n: 2 }))
    // Both sides full at the raised limit; 777 (n=2) is on JSON's rows only, at the rank Parquet cut at.
    const j = [{ http_code: 200, n: 900 }, { http_code: 404, n: 50 }, { http_code: 777, n: 2 }, ...filler(1000)]
    const p = [{ http_code: 200, n: 900 }, { http_code: 404, n: 50 }, { http_code: 888, n: 2 }, ...filler(1000)]
    expect(j).toHaveLength(fetched)
    // 777 ranks 3rd on JSON (a stable sort keeps it ahead of the filler): in its top 3, absent from Parquet.
    expect(compareQueryRows(TOP, j, p)).toMatchObject({ verdict: 'incomparable', sentence: expect.stringMatching(/missing from a side that came back full/) })
    // The same keys missing from sides that were NOT full are a real difference.
    expect(compareQueryRows(TOP, j.slice(0, 5), p.slice(0, 5)).verdict).toBe('fail')
  })

  it('compares a scalar summarize as one group, and calls all-zero unexercised', () => {
    const q = 'dataset="gigamon_ami" | summarize events=count(), bytes=sum(total_bytes)'
    expect(compareQueryRows(q, [{ events: 100, bytes: 5 }], [{ events: 100, bytes: 5 }]).verdict).toBe('pass')
    expect(compareQueryRows(q, [{ events: 100, bytes: 5 }], [{ events: 100, bytes: 9 }]).verdict).toBe('fail')
    expect(compareQueryRows(q, [{ events: 0, bytes: 0 }], [{ events: 0, bytes: 0 }]).verdict).toBe('unexercised')
    expect(compareQueryRows(q, [], []).verdict).toBe('unexercised')
  })

  it('never reads a missing answer as a difference', () => {
    expect(compareQueryRows(TOP, null, []).verdict).toBe('notrun')
  })
})

describe('planEntries', () => {
  it('runs nothing on an empty type table: no entry is eligible, and each says why', () => {
    const plan = planEntries({ types: {} })
    expect(plan.selected).toEqual([])
    expect(plan.refused.map((r) => r.id)).toEqual(ROUTES.map((e) => e.id))
    for (const e of ROUTES.filter((x) => !x.pin && x.queries.length)) {
      expect(plan.refused.find((r) => r.id === e.id)?.why).toMatch(/^not eligible — .*type not measured/)
    }
  })

  it('runs, for evidence, exactly what the shipped type table makes eligible, and says why for the rest', () => {
    // src/data/fieldTypes.ts, filled 2026-09-25 from the censuses: dns.overall is eligible
    // outright; the eight others are refused by the router only on density, which the runner
    // leaves to each install (fieldTypes.test.ts pins the same lists).
    const plan = planEntries()
    expect(plan.selected.map((s) => s.id).sort()).toEqual([
      'dns.overall', 'flowMap.edges', 'flowMap.serviceEdges', 'pqc.groups', 'tls.pqcByServer',
      'web.codes', 'web.h2', 'web.hosts', 'web.trend',
    ])
    expect(plan.selected.every((s) => s.mode === 'evidence')).toBe(true)
    expect(plan.refused.find((r) => r.id === 'tcp.trend')?.why).toMatch(/tcp_dup_ack/)
  })

  it('selects an entry once its fields are typed, for evidence', () => {
    const plan = planEntries({ only: ['web.codes'], types: { http_code: 'number' } })
    expect(plan.selected).toEqual([expect.objectContaining({ id: 'web.codes', mode: 'evidence', ineligible: [] })])
  })

  it('runs an ineligible entry only to measure it, and never a pinned one', () => {
    const plan = planEntries({ only: ['web.codes', 'web.errorsDrill', 'flowMap.trend'], forceIneligible: true, types: {} })
    expect(plan.selected).toEqual([expect.objectContaining({ id: 'web.codes', mode: 'measurement' })])
    expect(plan.refused.map((r) => r.id).sort()).toEqual(['flowMap.trend', 'web.errorsDrill'])
  })

  it('refuses an id the table does not hold', () => {
    expect(() => planEntries({ only: ['web.nope'] })).toThrow(/web\.nope/)
  })
})

describe('the evidence an entry earns', () => {
  const T0 = Date.UTC(2026, 9, 1, 0, 0, 0) / 1000
  const win = (h: number): RunWindow => ({ earliest: T0 + h * 3600, latest: T0 + h * 3600 + 900, label: `h${h}` })
  const compared = (w: RunWindow): WindowResult => ({ window: w, status: 'compared', why: null, completeness: { complete: true, why: null, checkedAt: 0, buckets: [] }, control: null, drift: 0 })
  const TEXT = ROUTES.find((e) => e.id === 'web.codes')!.queries[0]
  const TYPES: Record<string, FieldType> = { http_code: 'number' }
  const entry = (verdicts: string[], windows: RunWindow[], mode: 'evidence' | 'measurement' = 'evidence'): RunResult['entries'][number] => ({
    id: 'web.codes',
    mode,
    ineligible: mode === 'measurement' ? ['type not measured: http_code'] : [],
    texts: [{ query: TEXT, submitted: TEXT, perWindow: windows.map((w, i) => ({ window: w, verdict: verdicts[i] as 'pass', sentence: '', rows: { json: 1, parquet: 1 }, grouped: null, report: null, textDiffers: [] })) }],
  })

  it('is accepted by tableProblems when pasted into its entry', () => {
    const ws = [win(1), win(8), win(15)]
    const out = entryOutcome(entry(['pass', 'pass', 'pass'], ws), ws.map(compared), '.dev/parity-run/parity-run-x.json', '2026-10-01')
    expect(out.verdict).toBe('evidence')
    expect(Object.keys(out.evidence!).sort()).toEqual(['date', 'report', 'windows'])
    const pasted: RouteEntry = { ...ROUTES.find((e) => e.id === 'web.codes')!, target: 'parquet', evidence: out.evidence }
    const table = ROUTES.map((e) => (e.id === 'web.codes' ? pasted : e))
    expect(tableProblems(table, TYPES)).toEqual([])
    // …and the same table without the types refuses it, as it must.
    expect(tableProblems(table, {})).not.toEqual([])
  })

  it('is never built from a measurement, a failure, or too few windows', () => {
    const ws = [win(1), win(8), win(15)]
    expect(entryOutcome(entry(['pass', 'pass', 'pass'], ws, 'measurement'), ws.map(compared), 'r', '2026-10-01')).toMatchObject({ verdict: 'measured-only', evidence: null })
    expect(entryOutcome(entry(['pass', 'fail', 'pass'], ws), ws.map(compared), 'r', '2026-10-01')).toMatchObject({ verdict: 'failed', evidence: null })
    expect(entryOutcome(entry(['pass', 'unexercised', 'pass'], ws), ws.map(compared), 'r', '2026-10-01')).toMatchObject({ verdict: 'not-enough', evidence: null })
    const skipped = ws.map(compared)
    skipped[2] = { ...skipped[2], status: 'skipped', why: 'gap' }
    expect(entryOutcome(entry(['pass', 'pass'], ws.slice(0, 2)), skipped, 'r', '2026-10-01')).toMatchObject({ verdict: 'not-enough', evidence: null })
  })
})

describe('parityCostFloor', () => {
  it('calls itself a floor, the Parquet half an assumption, and leaves the unmeasured completeness cost out', () => {
    const ws = parityRunWindows(NOW)
    const plan = planEntries({ only: ['web.codes', 'tcp.trend'], forceIneligible: true })
    const f = parityCostFloor(ws, plan.selected)
    expect(f.jobs).toEqual({ completeness: 3, control: 6, queries: 30 })
    expect(f.total).toBeCloseTo(f.json * 2)
    const text = f.lines.join('\n')
    expect(text).toMatch(/FLOOR, not a bound/)
    expect(text).toMatch(/Parquet side: .* an ASSUMPTION\. No Parquet coefficient has been measured/)
    expect(text).toMatch(/Completeness checks: NOT included/)
  })
})

describe('wiring', () => {
  it('is imported by no app module, so the app never submits a parity job', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          // Any spelling that loads it: `from '…'` or `from "…"` (an import or a
          // re-export), a side-effect `import '…'`, or a dynamic `import('…')`.
          // policyCoverage.test.ts also walks the import graph from src/main.tsx.
          if (/(?:\bfrom\s*|\bimport\s*\(?\s*)['"`][^'"`]*\bparityRun(?:\.ts)?['"`]/.test(readFileSync(p, 'utf8'))) offenders.push(relative(ROOT, p))
        }
      }
    }
    walk(join(ROOT, 'src'))
    expect(offenders).toEqual([])
  })

  it('catches every spelling of an import of it', () => {
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"`][^'"`]*\bparityRun(?:\.ts)?['"`]/
    for (const src of [
      "import { x } from './parityRun'",
      'import { x } from "../cribl/parityRun"',
      "const P = await import('../cribl/parityRun')",
      'export * from "./parityRun"',
      "import './parityRun.ts'",
    ]) expect(re.test(src), src).toBe(true)
    expect(re.test("import { x } from './parityRunJob'")).toBe(false)
  })

  it('has its npm script, and the runner writes nothing but its report, into the report directory', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['parity:run']).toBe('node scripts/parity-run.mjs')
    // Structural, not a grep for the table's name: no file-writing API at all
    // in the runner, whose one write is `writeReportOnce` into `args.out`…
    const WRITES = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|rm|rmSync|unlink|unlinkSync|truncate|truncateSync|open|openSync|symlink|symlinkSync)\b|node:fs\/promises|['"]fs\/promises['"]/
    const runner = readFileSync(join(ROOT, 'scripts/parity-run.mjs'), 'utf8')
    expect(runner).not.toMatch(WRITES)
    expect(runner.match(/from 'node:fs'/g)).toHaveLength(1)
    expect(runner).toMatch(/import \{ mkdirSync, readFileSync \} from 'node:fs'/)
    expect(runner.match(/writeReportOnce\(/g)).toHaveLength(1)
    expect(runner).toMatch(/W\.writeReportOnce\(\{\s*dir: args\.out,/)
    // …and in the job module the only write is writeReportOnce's own, through the fs it is handed.
    const job = readFileSync(join(ROOT, 'scripts/parity-run-job.mjs'), 'utf8')
    expect(job.replace(/writeFileSync as fsWrite|fs\.writeFileSync\(|writeFileSync: fsWrite|writeFileSync\s*\(p, data/g, '')).not.toMatch(WRITES)
    const audit = readFileSync(join(ROOT, 'scripts/parquet-audit-job.mjs'), 'utf8')
    expect(audit).not.toMatch(/node:fs|['"]fs['"]/)
  })
})
