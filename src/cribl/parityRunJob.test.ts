// @vitest-environment node
//
// The parity run end to end against a FAKE transport: scripts/parity-run-job.mjs
// over scripts/parquet-audit-job.mjs's `makeApi`, driven by parityRun.ts's
// `executeParityRun`, written by `writeReportOnce` into a temporary directory.
// Nothing here reaches the network: every request goes to `fakeCribl` below.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeApi, type FetchLike } from '../../scripts/parquet-audit-job.mjs'
import { runParityJob, writeReportOnce } from '../../scripts/parity-run-job.mjs'
import { COMPLETENESS_BUCKET_SECONDS as B } from '../queries/routing'
import type { FieldType, Row } from './parity'
import {
  PARITY_CONTROL_QUERY,
  buildParityReport,
  comparisonText,
  executeParityRun,
  parityCostFloor,
  parityReportStem,
  parityRunWindows,
  planEntries,
  renderParityMarkdown,
  type ParityRunReport,
  type RunWindow,
} from './parityRun'
import { ROUTES, tableProblems, type RouteEntry } from './routing/table'

const NOW = Date.UTC(2026, 9, 1, 12, 7, 31) / 1000
const TYPES: Record<string, FieldType> = { http_code: 'number' }
const CODES = ROUTES.find((e) => e.id === 'web.codes')!.queries[0]
/** What the runner submits for CODES: its `limit 12` raised, so a tie at rank 12 can be seen. */
const CODES_SUBMITTED = comparisonText(CODES)

interface Scenario {
  /** Parquet's completeness count for a bucket, given the JSON one; default: equal. */
  pqEvents?: (start: number) => number
  /** Rows a text answers on a side. */
  rows?: (query: string, parquet: boolean) => Row[]
  /** The header's totalEventCount, when it should not be the row count. */
  total?: (query: string) => number | undefined
  /** The control count a side answers; default 50,000 on both. */
  control?: (parquet: boolean, earliest: number) => number
  /** The column the completeness rows carry their bucket in; default what a live row names it. */
  bucketColumn?: string
}

/** A stand-in for the Search API: jobs complete at once and answer from the scenario. */
function fakeCribl(s: Scenario = {}) {
  const jobs = new Map<string, { query: string; earliest: number; latest: number }>()
  const posts: { query: string; earliest: number }[] = []
  let n = 0
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace('http://fake/capi/m/default_search', '')
    if (init.method === 'POST' && path === '/search/jobs') {
      const b = JSON.parse(init.body!)
      const id = `job${++n}`
      jobs.set(id, b)
      posts.push({ query: b.query, earliest: b.earliest })
      return reply(200, { items: [{ id }] })
    }
    const m = /^\/search\/jobs\/([^/]+)\/(status|results|metrics|cancel)/.exec(path)
    if (!m) return reply(404, 'no route')
    const job = jobs.get(m[1])!
    if (m[2] === 'status') return reply(200, { items: [{ status: 'completed' }] })
    if (m[2] === 'metrics') return reply(200, { items: [{ metrics: { cpuMetrics: { billableCPUSeconds: 1.5 } } }] })
    if (m[2] === 'cancel') return reply(200, {})
    const q = job.query.replace(/^set max_running_time_per_search=\d+; /, '')
    const parquet = q.startsWith('dataset="gigamon_ami_pq"')
    let rows: Row[]
    if (q.startsWith('dataset="cribl_metrics"')) {
      rows = []
      for (let t = job.earliest; t < job.latest; t += B) rows.push({ [s.bucketColumn ?? 'bin_time_5m']: t, json_events: 1000, pq_events: s.pqEvents?.(t) ?? 1000 })
    } else if (q.endsWith(PARITY_CONTROL_QUERY.slice('dataset="gigamon_ami" '.length))) {
      rows = [{ c: s.control?.(parquet, job.earliest) ?? 50_000 }]
    } else {
      rows = s.rows?.(q, parquet) ?? [{ http_code: 200, n: 900 }, { http_code: 404, n: 40 }]
    }
    const header = { totalEventCount: s.total?.(q) ?? rows.length, job: { id: m[1] } }
    return reply(200, [header, ...rows].map((r) => JSON.stringify(r)).join('\n'))
  }
  return { fetch, posts }
}

function run(s: Scenario, windows: RunWindow[], plan = planEntries({ only: ['web.codes'], types: TYPES })) {
  const cribl = fakeCribl(s)
  const sleep = async () => {}
  const api = makeApi({ base: 'http://fake/capi', fetch: cribl.fetch, sleep })
  const deps = { api, sleep, now: () => NOW * 1000, log: () => {}, cap: 300 }
  const result = executeParityRun(windows, plan.selected, {
    submit: (purpose, w, query) => runParityJob(deps, purpose, w, query, { maxRows: 100 }),
    nowSec: () => NOW,
    log: () => {},
  })
  return { cribl, plan, result }
}

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function write(r: Awaited<ReturnType<typeof run>['result']>, plan: ReturnType<typeof planEntries>, windows: RunWindow[]) {
  dir ??= mkdtempSync(join(tmpdir(), 'parity-run-'))
  const ranAt = '2026-10-01T12:07:31.000Z'
  const stem = writeReportOnce({
    dir,
    stem: parityReportStem('2026-10-01T12:07:31.000Z', ranAt),
    build: (st) => {
      const report = buildParityReport(r, {
        referenceAt: '2026-10-01T12:07:31.000Z',
        referenceFrom: '--at',
        ranAt,
        finishedAt: ranAt,
        reportPath: `.dev/parity-run/${st}.json`,
        capSeconds: 300,
        estimate: parityCostFloor(windows, plan.selected),
        refused: plan.refused,
      })
      return { json: JSON.stringify(report), md: renderParityMarkdown(report) }
    },
  })
  return { stem, report: JSON.parse(readFileSync(join(dir, `${stem}.json`), 'utf8')) as ParityRunReport }
}

describe('a parity run against a fake transport', () => {
  it('earns evidence the routing table accepts when pasted, and names its own report', async () => {
    const windows = parityRunWindows(NOW)
    const { plan, result } = run({}, windows)
    const { stem, report } = write(await result, plan, windows)
    expect(report.windows.map((w) => w.status)).toEqual(['compared', 'compared', 'compared'])
    const ev = report.evidence['web.codes']
    expect(ev).toEqual({ report: `.dev/parity-run/${stem}.json`, date: '2026-10-01', windows: windows.map((w) => ({ earliest: w.earliest, latest: w.latest })) })
    const pasted: RouteEntry = { ...ROUTES.find((e) => e.id === 'web.codes')!, target: 'parquet', evidence: ev }
    expect(tableProblems(ROUTES.map((e) => (e.id === 'web.codes' ? pasted : e)), TYPES)).toEqual([])
    expect(report.billed).toEqual({ known: 1.5 * report.jobs.length, knownJobs: report.jobs.length, unknownJobs: 0, complete: true })
  })

  it('runs the text on JSON with only the limit of a top N raised, and moves only the dataset selector on Parquet', async () => {
    const windows = parityRunWindows(NOW)
    const { cribl, result } = run({}, windows)
    const r = await result
    expect(CODES_SUBMITTED).toBe(CODES.replace(/limit 12$/, 'limit 62'))
    expect(r.entries[0].texts[0]).toMatchObject({ query: CODES, submitted: CODES_SUBMITTED })
    const texts = cribl.posts.map((p) => p.query.replace(/^set max_running_time_per_search=300; /, ''))
    expect(texts.filter((t) => t === CODES_SUBMITTED)).toHaveLength(3)
    expect(texts.filter((t) => t === CODES_SUBMITTED.replace('dataset="gigamon_ami" ', 'dataset="gigamon_ami_pq" '))).toHaveLength(3)
    // The control count: once as written, once on the Parquet dataset, per window.
    expect(texts.filter((t) => t === PARITY_CONTROL_QUERY)).toHaveLength(3)
    expect(texts.filter((t) => t === PARITY_CONTROL_QUERY.replace('dataset="gigamon_ami" ', 'dataset="gigamon_ami_pq" '))).toHaveLength(3)
    expect(texts.some((t) => t.includes('allow_previous_results'))).toBe(false)
  })

  it('does not compare a window whose control count disagrees, and submits nothing more for it', async () => {
    const windows = parityRunWindows(NOW)
    const lagging = windows[1]
    // Parquet holds 10 % fewer records in the middle window: landing lag, not Parquet.
    const { cribl, plan, result } = run({ control: (pq, earliest) => (pq && earliest === lagging.earliest ? 45_000 : 50_000) }, windows)
    const { report } = write(await result, plan, windows)
    expect(report.windows.map((w) => w.status)).toEqual(['compared', 'incomparable', 'compared'])
    expect(report.windows[1].why).toMatch(/control count disagreed \(50000 on JSON, 45000 on Parquet\)/)
    // Completeness + the two control counts, and no query run.
    expect(cribl.posts.filter((p) => p.earliest === lagging.earliest)).toHaveLength(3)
    expect(report.entries[0].perWindow.map((p) => p.verdict)).toEqual(['pass', 'skipped', 'pass'])
    expect(report.entries[0]).toMatchObject({ verdict: 'not-enough', evidence: null })
  })

  it('compares each text with the window\'s control drift', async () => {
    const windows = parityRunWindows(NOW)
    // The control agrees, 0.4 % apart. A group of 40 that moved by one record is
    // outside 1 % of 40 with no drift, and inside the one record a drifting
    // control allows: it passes only if the drift reached the comparison.
    const control = (pq: boolean) => (pq ? 50_200 : 50_000)
    const rows = (_q: string, pq: boolean) => [{ http_code: 200, n: 900 }, { http_code: 404, n: pq ? 41 : 40 }]
    const drifting = run({ control, rows }, windows)
    const a = write(await drifting.result, drifting.plan, windows)
    expect(a.report.windows.every((w) => w.status === 'compared' && w.drift !== null && Math.abs(w.drift - 0.004) < 1e-9)).toBe(true)
    expect(a.report.entries[0].perWindow.map((p) => p.verdict)).toEqual(['pass', 'pass', 'pass'])
    // The same rows beside a control that agreed exactly fail.
    const exact = run({ rows }, windows)
    const b = write(await exact.result, exact.plan, windows)
    expect(b.report.entries[0]).toMatchObject({ verdict: 'failed', evidence: null })
  })

  it('stops the run when the completeness answer carries no bucket it can read, rather than bill another check', async () => {
    const windows = parityRunWindows(NOW)
    const { cribl, plan, result } = run({ bucketColumn: 'bucket_start' }, windows)
    const { report } = write(await result, plan, windows)
    expect(report.windows.map((w) => w.status)).toEqual(['skipped', 'skipped', 'skipped'])
    expect(report.windows[0].why).toMatch(/no bucket this can read \(no bin_time_5m or _time\)/)
    expect(report.windows[1].why).toMatch(/^not run: /)
    // One completeness job, then nothing.
    expect(cribl.posts).toHaveLength(1)
  })

  it('proves a window complete from rows that name the bucket as a live result does', async () => {
    const windows = parityRunWindows(NOW)
    const { plan, result } = run({ bucketColumn: 'bin_time_5m' }, windows)
    const { report } = write(await result, plan, windows)
    expect(report.windows.map((w) => w.status)).toEqual(['compared', 'compared', 'compared'])
  })

  it('skips a window the completeness check does not prove complete, and submits nothing else for it', async () => {
    const windows = parityRunWindows(NOW, { offsetsHours: [0, 6, 12, 18] })
    const gap = windows[1]
    const { cribl, plan, result } = run({ pqEvents: (t) => (t === gap.earliest + B ? 400 : 1000) }, windows)
    const { report } = write(await result, plan, windows)
    expect(report.windows[1]).toMatchObject({ status: 'skipped' })
    expect(report.windows[1].why).toMatch(/not proven complete: the Parquet copy is missing records .*400 of 1000/)
    expect(cribl.posts.filter((p) => p.earliest === gap.earliest)).toHaveLength(1)
    // Three other windows at different hours still pass, so the evidence stands on those.
    expect(report.evidence['web.codes'].windows.map((w) => w.earliest)).toEqual([windows[0], windows[2], windows[3]].map((w) => w.earliest))
  })

  it('records no evidence when too few windows are proven complete', async () => {
    const windows = parityRunWindows(NOW)
    const { plan, result } = run({ pqEvents: (t) => (t === windows[0].earliest ? 0 : 1000) }, windows)
    const { report } = write(await result, plan, windows)
    expect(report.evidence).toEqual({})
    expect(report.entries[0]).toMatchObject({ verdict: 'not-enough' })
  })

  it('fails an entry whose Parquet rows differ, and never records a measurement as evidence', async () => {
    const windows = parityRunWindows(NOW)
    const differ = run({ rows: (_q, pq) => (pq ? [{ http_code: 200, n: 900 }, { http_code: '', n: 500 }] : [{ http_code: 200, n: 900 }, { http_code: 404, n: 40 }]) }, windows)
    const a = write(await differ.result, differ.plan, windows)
    expect(a.report.entries[0]).toMatchObject({ verdict: 'failed', evidence: null })

    // On an empty type table, forced, the same passing rows are a measurement, never evidence.
    const forced = run({}, windows, planEntries({ only: ['web.codes'], forceIneligible: true, types: {} }))
    const b = write(await forced.result, forced.plan, windows)
    expect(b.report.entries[0]).toMatchObject({ mode: 'measurement', verdict: 'measured-only', evidence: null })
    expect(b.report.entries[0].perWindow.map((p) => p.verdict)).toEqual(['pass', 'pass', 'pass'])
    expect(b.report.evidence).toEqual({})
  })

  it('does not compare a read cut short of the job\'s totalEventCount', async () => {
    const windows = parityRunWindows(NOW)
    const { plan, result } = run({ total: (q) => (q === CODES_SUBMITTED ? 5000 : undefined) }, windows)
    const { report } = write(await result, plan, windows)
    const cmp = report.entries[0].texts[0].perWindow
    expect(cmp.map((c) => c.verdict)).toEqual(['notrun', 'notrun', 'notrun'])
    expect(report.jobs.find((j) => j.error)?.error).toMatch(/read 2 of 5000 rows/)
    expect(report.evidence).toEqual({})
  })
})

describe('writeReportOnce', () => {
  it('never overwrites: a second report of the same stem gets its own name', () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-run-'))
    const build = (tag: string) => (st: string) => ({ json: `{"tag":"${tag}","stem":"${st}"}`, md: tag })
    const a = writeReportOnce({ dir, stem: 's', build: build('first') })
    const b = writeReportOnce({ dir, stem: 's', build: build('second') })
    expect([a, b]).toEqual(['s', 's-2'])
    expect(JSON.parse(readFileSync(join(dir, 's.json'), 'utf8'))).toEqual({ tag: 'first', stem: 's' })
    expect(JSON.parse(readFileSync(join(dir, 's-2.json'), 'utf8'))).toEqual({ tag: 'second', stem: 's-2' })
  })

  it('skips a name whose .md alone exists, and one that appears between the check and the write', () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-run-'))
    writeFileSync(join(dir, 's.md'), 'someone else')
    let raced = false
    const fs = {
      existsSync: (p: string) => {
        try {
          readFileSync(p)
          return true
        } catch {
          return false
        }
      },
      writeFileSync: (p: string, data: string, opts: { flag: 'wx' }) => {
        if (!raced && p.endsWith('s-2.json')) {
          raced = true
          writeFileSync(p, 'arrived first', opts)
        }
        writeFileSync(p, data, opts)
      },
    }
    const got = writeReportOnce({ dir, stem: 's', build: (st) => ({ json: st, md: st }), fs })
    expect(got).toBe('s-3')
    expect(readFileSync(join(dir, 's.md'), 'utf8')).toBe('someone else')
    expect(readFileSync(join(dir, 's-2.json'), 'utf8')).toBe('arrived first')
  })
})
