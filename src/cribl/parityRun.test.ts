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
  compareQueryRows,
  entryOutcome,
  parityCostFloor,
  parityRunWindows,
  planEntries,
  querySpec,
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
      for (let t = w.earliest; t < w.latest; t += B) rows.push({ _time: t, json_events: 10, pq_events: 10 })
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
        keys: ['http_code', '_time'],
        aggregates: [
          { name: 'n', expr: 'count()', kind: 'count' },
          { name: 'p', expr: 'percentile(x,95)', kind: 'distribution' },
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
  it('runs nothing today: the type table is empty, so no entry is eligible, and each says why', () => {
    const plan = planEntries()
    expect(plan.selected).toEqual([])
    expect(plan.refused.map((r) => r.id)).toEqual(ROUTES.map((e) => e.id))
    for (const e of ROUTES.filter((x) => !x.pin && x.queries.length)) {
      expect(plan.refused.find((r) => r.id === e.id)?.why).toMatch(/^not eligible — .*type not measured/)
    }
  })

  it('selects an entry once its fields are typed, for evidence', () => {
    const plan = planEntries({ only: ['web.codes'], types: { http_code: 'number' } })
    expect(plan.selected).toEqual([expect.objectContaining({ id: 'web.codes', mode: 'evidence', ineligible: [] })])
  })

  it('runs an ineligible entry only to measure it, and never a pinned one', () => {
    const plan = planEntries({ only: ['web.codes', 'web.errorsDrill', 'flowMap.trend'], forceIneligible: true })
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
    texts: [{ query: TEXT, perWindow: windows.map((w, i) => ({ window: w, verdict: verdicts[i] as 'pass', sentence: '', rows: { json: 1, parquet: 1 }, grouped: null, report: null, textDiffers: [] })) }],
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
          if (/from '[./]*(?:cribl\/)?parityRun'/.test(readFileSync(p, 'utf8'))) offenders.push(relative(ROOT, p))
        }
      }
    }
    walk(join(ROOT, 'src'))
    expect(offenders).toEqual([])
  })

  it('has its npm script, and the runner never writes the routing table', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['parity:run']).toBe('node scripts/parity-run.mjs')
    for (const f of ['scripts/parity-run.mjs', 'scripts/parity-run-job.mjs']) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      expect(src, f).not.toMatch(/writeFileSync\([^)]*table/)
      expect(src, f).not.toMatch(/routing\/table\.ts['"]\s*\)/)
    }
  })
})
