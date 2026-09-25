// The store benchmark's stages, as data: what runs, in what order, over which
// window, and the rule that the 15-minute stage waits for the one-minute
// stage's measured work.
import { describe, expect, it } from 'vitest'
import {
  BENCH_QUERIES,
  FIFTEEN_RUNS_PER_PAIR,
  JSON_TARGET_ID,
  PARQUET_ABSENT_WORDS,
  PARQUET_DATASET,
  PARQUET_TARGET_ID,
  WINDOW_END_AGO_SECONDS,
  LANDING_MARGIN_SECONDS,
  LANDING_MAX_SHIFT_SECONDS,
  LANDING_READ_SECONDS,
  benchPlan,
  chooseWindow,
  coveredEnd,
  landingCostLine,
  landingEstimate,
  landingQueryFor,
  landingReadWindow,
  landingWords,
  benchReport,
  benchTargets,
  canonicalAnswer,
  fifteenCostLine,
  fifteenRefusal,
  parquetState,
  probeDisagreement,
  probeDisagrees,
  probePlan,
  projectFifteen,
  queryFor,
  selectionKey,
  stageStopped,
  stageWindow,
  stageWorkWords,
  type BenchQueryId,
  type BenchRun,
  type LagReading,
  type StageRecord,
} from './benchmarkPlan'
import { LANDING_LAG_QUERY } from '../queries/lakeLanding'
import { BENCH_LANDING_QUERY } from '../queries/benchmark'
import { MEASURED_RUNS, WARMUP_RUNS } from './benchmark'
import { PARITY_COUNT_QUERY } from '../queries/lakeLanding'
import { buildTrendQuery } from '../queries/tcpHealth'
import { APP_SRC_SNAPSHOT_QUERY, OVERVIEW_SNAPSHOT_QUERY } from '../queries/snapshots'
import { PACK_PARQUET_DATASET_ID } from './pack'
import type { LakeDataset, ReadResult } from './lake'

const ds = (id: string, size: number | null, deleting = false): LakeDataset => ({
  id,
  description: null,
  format: null,
  retentionPeriodInDays: 30,
  acceleratedFields: null,
  searchConfig: null,
  deletionStartedAt: deleting ? '2026-09-25T00:00:00Z' : null,
  metrics: size === null ? null : { currentSizeBytes: size, metricsDate: '2026-09-25' },
  raw: {},
})

const listing = (...items: LakeDataset[]): ReadResult<LakeDataset[]> => ({
  outcome: 'ok',
  value: items,
  object: '/products/lake/lakes/default/datasets',
  status: 200,
  detail: null,
})

const WITH_PQ = listing(ds('gigamon_ami', 1e9), ds(PARQUET_DATASET, 5e8))
const both = benchTargets(WITH_PQ, { sampleOnly: false, includeParquet: true })

describe('the query set', () => {
  it('is the app’s own strings, imported rather than retyped', () => {
    const byId = Object.fromEntries(BENCH_QUERIES.map((q) => [q.id, q.query]))
    expect(byId).toEqual({
      count: PARITY_COUNT_QUERY,
      dupacks: buildTrendQuery('dupacks'),
      appSrc: APP_SRC_SNAPSHOT_QUERY,
      overview: OVERVIEW_SNAPSHOT_QUERY,
    })
  })

  it('leaves the overview scan unticked: its values are known to differ on Parquet', () => {
    expect(BENCH_QUERIES.filter((q) => q.defaultOn).map((q) => q.id)).toEqual(['count', 'dupacks', 'appSrc'])
  })

  it('moves only the dataset selector for the Parquet copy', () => {
    for (const q of BENCH_QUERIES) {
      const pq = queryFor(q, both[1])
      expect(pq.startsWith(`dataset="${PACK_PARQUET_DATASET_ID}" `)).toBe(true)
      expect(pq.replace(`dataset="${PACK_PARQUET_DATASET_ID}"`, 'dataset="gigamon_ami"')).toBe(q.query)
      expect(queryFor(q, both[0])).toBe(q.query)
    }
  })

  it('never reads the source field, which forced whole-object reads on Parquet', () => {
    for (const q of BENCH_QUERIES) expect(q.query).not.toMatch(/\bsource\b/)
  })
})

describe('which stores are offered', () => {
  it('offers the Parquet copy only when it exists and Lake reports data in it', () => {
    expect(parquetState(WITH_PQ)).toBe('holds-data')
    expect(parquetState(listing(ds('gigamon_ami', 1e9)))).toBe('absent')
    expect(parquetState(listing(ds(PARQUET_DATASET, 0)))).toBe('empty')
    expect(parquetState(listing(ds(PARQUET_DATASET, null)))).toBe('empty')
    expect(parquetState(listing(ds(PARQUET_DATASET, 5e8, true)))).toBe('deleting')
    expect(parquetState(null)).toBe('unreadable')
    expect(parquetState({ ...WITH_PQ, outcome: 'failed', value: null } as unknown as ReadResult<LakeDataset[]>)).toBe('unreadable')
  })

  it('says why the Parquet copy is not offered, in each case', () => {
    const t = benchTargets(listing(ds('gigamon_ami', 1e9)), { sampleOnly: false, includeParquet: true })
    expect(t.map((x) => x.available)).toEqual([true, false])
    expect(t[1].absentNote).toBe(PARQUET_ABSENT_WORDS.absent)
  })

  it('leaves the Parquet copy out when the person unticks it', () => {
    const t = benchTargets(WITH_PQ, { sampleOnly: false, includeParquet: false })
    expect(t.map((x) => x.available)).toEqual([true, false])
  })

  it('offers nothing on a sample-only workspace: the customer dataset holds nothing to time', () => {
    const t = benchTargets(WITH_PQ, { sampleOnly: true, includeParquet: true })
    expect(t.every((x) => !x.available)).toBe(true)
    expect(t[0].absentNote).toMatch(/holds no data/)
  })
})

describe('the windows', () => {
  const now = Date.UTC(2026, 8, 25, 14, 37, 42)

  it('are absolute, on whole minutes, and end ten minutes ago', () => {
    const one = stageWindow('one', now)
    const fifteen = stageWindow('fifteen', now)
    expect(one.latest).toBe(Date.UTC(2026, 8, 25, 14, 37) / 1000 - WINDOW_END_AGO_SECONDS)
    expect(one.latest - one.earliest).toBe(60)
    expect(fifteen.latest - fifteen.earliest).toBe(900)
    expect(one.latest % 60).toBe(0)
    expect(now / 1000 - fifteen.latest).toBeGreaterThanOrEqual(WINDOW_END_AGO_SECONDS)
  })
})

describe('the landing check', () => {
  const now = Date.UTC(2026, 8, 25, 14, 37, 42)
  const usual = stageWindow('fifteen', now)
  const reading = (dataset: string, over: Partial<LagReading> = {}): LagReading => ({
    targetId: dataset === PARQUET_DATASET ? PARQUET_TARGET_ID : JSON_TARGET_ID,
    dataset,
    query: '',
    jobId: 'j',
    newest: now / 1000 - 60,
    count: 1000,
    cpuSeconds: 4,
    ...over,
  })

  it('is the Lake landing panel’s own landing-lag search, imported, with only the dataset moved', () => {
    expect(BENCH_LANDING_QUERY).toBe(LANDING_LAG_QUERY)
    expect(landingQueryFor(both[0])).toBe(LANDING_LAG_QUERY)
    expect(landingQueryFor(both[1])).toBe(LANDING_LAG_QUERY.replace('dataset="gigamon_ami"', `dataset="${PARQUET_DATASET}"`))
  })

  it('reads from the earliest end the window may move back to, up to now', () => {
    const r = landingReadWindow(now)
    expect(r.earliest).toBe(usual.latest - LANDING_MAX_SHIFT_SECONDS)
    expect(r.latest).toBe(Math.floor(now / 1000))
    expect(r.latest - r.earliest).toBeGreaterThanOrEqual(LANDING_READ_SECONDS)
    expect(r.latest - r.earliest).toBeLessThan(LANDING_READ_SECONDS + 60)
  })

  it('keeps the usual window when every store covers its end', () => {
    const c = chooseWindow(now, [reading('gigamon_ami'), reading(PARQUET_DATASET)])
    expect(c.refusal).toBeNull()
    expect(c.window).toEqual(usual)
    expect(c.shiftedSeconds).toBe(0)
  })

  it('holds back the margin for files still being written, on a whole minute', () => {
    const newest = usual.latest + 30
    expect(coveredEnd(reading('x', { newest }))).toBe(Math.floor((newest - LANDING_MARGIN_SECONDS) / 60) * 60)
    expect(coveredEnd(reading('x', { newest: null }))).toBeNull()
    expect(coveredEnd(reading('x', { count: 0 }))).toBeNull()
    expect(coveredEnd(reading('x', { error: 'boom' }))).toBeNull()
  })

  it('moves the window back to the latest end EVERY store covers, fifteen minutes long', () => {
    const behind = usual.latest - 7 * 60 + LANDING_MARGIN_SECONDS + 20
    const c = chooseWindow(now, [reading('gigamon_ami'), reading(PARQUET_DATASET, { newest: behind })])
    expect(c.refusal).toBeNull()
    expect(c.window.latest).toBe(usual.latest - 7 * 60)
    expect(c.window.latest - c.window.earliest).toBe(900)
    expect(c.shiftedSeconds).toBe(7 * 60)
    // Whichever store is behind decides: the JSON dataset lagging moves it too.
    const j = chooseWindow(now, [reading('gigamon_ami', { newest: behind }), reading(PARQUET_DATASET)])
    expect(j.window.latest).toBe(usual.latest - 7 * 60)
  })

  it('moves back as far as the limit, and refuses one minute past it', () => {
    const atLimit = usual.latest - LANDING_MAX_SHIFT_SECONDS + LANDING_MARGIN_SECONDS
    expect(chooseWindow(now, [reading(PARQUET_DATASET, { newest: atLimit })]).shiftedSeconds).toBe(LANDING_MAX_SHIFT_SECONDS)
    const past = chooseWindow(now, [reading(PARQUET_DATASET, { newest: atLimit - 60 })])
    expect(past.refusal).toContain(`${PARQUET_DATASET}’s newest record is from`)
    expect(past.refusal).toContain('more than 15 minutes before the window’s usual end')
    expect(past.refusal).toContain('ran nothing else')
    expect(past.window).toEqual(usual)
  })

  it('refuses when a store has nothing in the window it read, when a check failed, and when nothing was checked', () => {
    expect(chooseWindow(now, [reading('gigamon_ami'), reading(PARQUET_DATASET, { newest: null, count: 0 })]).refusal)
      .toContain(`Nothing has landed in ${PARQUET_DATASET} since`)
    expect(chooseWindow(now, [reading(PARQUET_DATASET, { error: 'HTTP 500' })]).refusal)
      .toContain(`The landing check on ${PARQUET_DATASET} did not complete (HTTP 500)`)
    expect(chooseWindow(now, []).refusal).toContain('No store was checked')
  })

  it('says what it found, whether the window moved, and its work — never counting unreported work as zero', () => {
    const read = landingReadWindow(now)
    const moved = landingWords({ read, readings: [reading('gigamon_ami'), reading(PARQUET_DATASET)], shiftedSeconds: 180, refusal: null })
    expect(moved.join(' ')).toContain('The window was moved back 3 minutes')
    expect(moved.join(' ')).toContain('Work done by the landing check: 8 CPU-seconds.')
    const kept = landingWords({ read, readings: [reading('gigamon_ami', { cpuSeconds: null }), reading(PARQUET_DATASET)], shiftedSeconds: 0, refusal: null })
    expect(kept.join(' ')).toContain('Every store holds the whole window, so it was not moved.')
    expect(kept.join(' ')).toContain('at least 4 CPU-seconds')
    const refused = landingWords({ read, readings: [reading(PARQUET_DATASET)], shiftedSeconds: 0, refusal: 'no' })
    expect(refused.join(' ')).not.toMatch(/moved/)
  })

  it('prices itself from the row count’s one-minute work, and says so when it cannot', () => {
    const probe: StageRecord = {
      stage: 'one',
      key: 'k',
      window: stageWindow('one', now),
      queryIds: ['count'],
      targets: both,
      runs: [
        { queryId: 'count', query: '', jobId: 'a', targetId: JSON_TARGET_ID, warmup: false, serverMs: 1, clientMs: 1, cpuSeconds: 2, rows: 1 },
        { queryId: 'count', query: '', jobId: 'b', targetId: PARQUET_TARGET_ID, warmup: false, serverMs: 1, clientMs: 1, cpuSeconds: 4, rows: 1 },
      ],
      planned: 2,
      ended: true,
    }
    expect(landingEstimate(probe, JSON_TARGET_ID)).toBe(2 * 25)
    expect(landingCostLine(probe, both)).toContain('Expect about 150 CPU-seconds')
    const noCount = { ...probe, runs: probe.runs.map((r) => ({ ...r, queryId: 'dupacks' as const })) }
    expect(landingEstimate(noCount, JSON_TARGET_ID)).toBeNull()
    expect(landingCostLine(noCount, both)).toContain('not known until they run')
  })

  it('is not a "stop": a stage the check refused says why instead', () => {
    const rec: StageRecord = {
      stage: 'fifteen',
      key: 'k',
      window: usual,
      queryIds: ['count'],
      targets: both,
      runs: [],
      planned: 8,
      ended: true,
      landing: { read: landingReadWindow(now), readings: [], shiftedSeconds: 0, refusal: 'behind' },
    }
    expect(stageStopped(rec)).toBe(false)
    expect(stageStopped({ ...rec, landing: undefined })).toBe(true)
  })
})

describe('the plans', () => {
  const ids: BenchQueryId[] = ['count', 'appSrc']

  it('runs each search once per store in the one-minute stage, with no warm-up', () => {
    const plan = probePlan(ids, both)
    expect(plan.map((p) => `${p.queryId}:${p.target.id}:${p.warmup}`)).toEqual([
      'count:json:false',
      'count:parquet:false',
      'appSrc:json:false',
      'appSrc:parquet:false',
    ])
  })

  it('runs benchmark.ts’s protocol per search in the 15-minute stage: a warm-up first, interleaved by round', () => {
    const plan = benchPlan(['count'], both)
    expect(plan).toHaveLength(2 * (WARMUP_RUNS + MEASURED_RUNS))
    expect(plan.slice(0, 2).every((p) => p.warmup)).toBe(true)
    expect(plan.slice(2).every((p) => !p.warmup)).toBe(true)
    expect(plan.map((p) => p.target.id)).toEqual(['json', 'parquet', 'json', 'parquet', 'json', 'parquet', 'json', 'parquet'])
  })

  it('keys a selection by its searches and its available stores, in any order', () => {
    expect(selectionKey(['appSrc', 'count'], both)).toBe(selectionKey(['count', 'appSrc'], both))
    const jsonOnly = benchTargets(WITH_PQ, { sampleOnly: false, includeParquet: false })
    expect(selectionKey(ids, jsonOnly)).not.toBe(selectionKey(ids, both))
    expect(selectionKey(['count'], both)).not.toBe(selectionKey(ids, both))
  })
})

// ── Records ─────────────────────────────────────────────────────────────────

const run = (queryId: BenchQueryId, targetId: string, over: Partial<BenchRun> = {}): BenchRun => ({
  queryId,
  targetId,
  query: 'q',
  jobId: 'j',
  warmup: false,
  serverMs: 500,
  clientMs: 900,
  cpuSeconds: 2,
  rows: 1,
  ...over,
})

const probeOf = (runs: BenchRun[], ids: BenchQueryId[] = ['count']): StageRecord => ({
  stage: 'one',
  key: selectionKey(ids, both),
  window: { earliest: 0, latest: 60 },
  queryIds: ids,
  targets: both,
  runs,
  planned: probePlan(ids, both).length,
  ended: true,
})

describe('the stage gate', () => {
  const key = selectionKey(['count'], both)
  const good = probeOf([run('count', JSON_TARGET_ID), run('count', PARQUET_TARGET_ID, { cpuSeconds: 4 })])

  it('refuses before any one-minute stage', () => {
    expect(fifteenRefusal(null, key)).toMatch(/Measure one minute first/)
  })

  it('refuses when the one-minute stage was for another selection', () => {
    expect(fifteenRefusal(good, selectionKey(['count', 'appSrc'], both))).toMatch(/Measure one minute first/)
  })

  it('refuses a stopped one-minute stage', () => {
    expect(fifteenRefusal({ ...good, runs: good.runs.slice(0, 1) }, key)).toMatch(/stopped/)
  })

  it('refuses when a one-minute search failed, naming it', () => {
    const p = probeOf([run('count', JSON_TARGET_ID), run('count', PARQUET_TARGET_ID, { error: 'Cribl Search failed', cpuSeconds: null })])
    expect(fifteenRefusal(p, key)).toMatch(/did not complete for Row count on gigamon_ami_pq/)
  })

  it('refuses when the work of any one-minute search was not reported: there is nothing to judge against', () => {
    const p = probeOf([run('count', JSON_TARGET_ID), run('count', PARQUET_TARGET_ID, { cpuSeconds: null })])
    expect(fifteenRefusal(p, key)).toMatch(/did not report the work done by Row count on gigamon_ami_pq/)
  })

  it('opens once every one-minute search completed with its work read', () => {
    expect(fifteenRefusal(good, key)).toBeNull()
  })

  it('never refuses for being expensive: there is no threshold', () => {
    const huge = probeOf([run('count', JSON_TARGET_ID, { cpuSeconds: 5_000 }), run('count', PARQUET_TARGET_ID, { cpuSeconds: 9_000 })])
    expect(fifteenRefusal(huge, key)).toBeNull()
  })
})

describe('the 15-minute cost line', () => {
  const p = probeOf([run('count', JSON_TARGET_ID, { cpuSeconds: 2 }), run('count', PARQUET_TARGET_ID, { cpuSeconds: 4 })])

  it('multiplies each measured figure by the window and the runs', () => {
    const proj = projectFifteen(p)
    expect(proj.measuredTotal).toBe(6)
    expect(proj.projectedTotal).toBe(6 * 15 * FIFTEEN_RUNS_PER_PAIR)
    expect(proj.pairs.map((x) => x.projected)).toEqual([2 * 15 * 4, 4 * 15 * 4])
  })

  it('quotes the measured work and the projection in words, and says the projection is an assumption', () => {
    const line = fifteenCostLine(p)
    expect(line).toContain('6 CPU-seconds of work')
    expect(line).toContain('360 CPU-seconds')
    expect(line).toContain('0.1 credits')
    expect(line).toMatch(/assumption, not a measurement/)
  })
})

describe('the verdict', () => {
  const bench = (runs: BenchRun[], id: BenchQueryId = 'count'): StageRecord => ({
    stage: 'fifteen',
    key: selectionKey([id], both),
    window: { earliest: 0, latest: 900 },
    queryIds: [id],
    targets: both,
    runs,
    planned: runs.length,
    ended: true,
  })
  const protocol = (json: Partial<BenchRun>, pq: Partial<BenchRun>, id: BenchQueryId = 'count') =>
    benchPlan([id], both).map((p) => run(id, p.target.id, { warmup: p.warmup, ...(p.target.id === JSON_TARGET_ID ? json : pq) }))

  it('names the fastest store by server time when the stores gave the same answer', () => {
    const [r] = benchReport(bench(protocol({ serverMs: 900, answer: 'c=5' }, { serverMs: 300, answer: 'c=5' })))
    expect(r.decided).toBe(true)
    expect(r.verdict).toMatch(/^Cribl Lake · Parquet answered fastest, 3× faster/)
    expect(r.verdict).toMatch(/same rows, value for value/)
  })

  it('says only the row count was checked for a search checked on rows', () => {
    const [r] = benchReport(bench(protocol({ serverMs: 900 }, { serverMs: 300 }, 'appSrc'), 'appSrc'))
    expect(r.decided).toBe(true)
    expect(r.verdict).toMatch(/values are not compared/)
  })

  it('REFUSES a verdict when the row counts disagree, however much faster one store is', () => {
    const [r] = benchReport(bench(protocol({ serverMs: 900, rows: 18, answer: 'a' }, { serverMs: 100, rows: 43_338, answer: 'a' })))
    expect(r.decided).toBe(false)
    expect(r.comparison.disagree).toBe(true)
    expect(r.verdict).toMatch(/did not return the same number of rows/)
  })

  // The row count and the trend return the same NUMBER of rows from any store
  // (one row; one per minute), so the row-count refusal can never fire for them.
  // Before 2026-09-25 this named Parquet fastest for a count of 43,338 against 18.
  it('REFUSES a verdict for the row count when the count itself differs, though both returned one row', () => {
    const [r] = benchReport(bench(protocol({ serverMs: 900, rows: 1, answer: 'c=43338' }, { serverMs: 100, rows: 1, answer: 'c=18' })))
    expect(r.decided).toBe(false)
    expect(r.comparison.disagree).toBe(true)
    expect(r.verdict).toMatch(/same number of rows but different values/)
  })

  it('refuses a verdict for a values-checked search whose rows were not all read back', () => {
    const [r] = benchReport(bench(protocol({ serverMs: 900, answer: 'c=5' }, { serverMs: 100, answer: null }, 'dupacks'), 'dupacks'))
    expect(r.decided).toBe(false)
    expect(r.verdict).toMatch(/could not all be read back/)
  })

  it('never names a winner for the opening-tiles scan, whose answer is known to differ', () => {
    const [r] = benchReport(bench(protocol({ serverMs: 900 }, { serverMs: 100 }, 'overview'), 'overview'))
    expect(r.decided).toBe(false)
    expect(r.verdict).toMatch(/known to differ on the Parquet copy/)
    // …and still shows both stores' timings.
    expect(r.comparison.summaries.map((s) => s.serverMs)).toEqual([900, 100])
  })

  it('names no winner on a tie', () => {
    const [r] = benchReport(bench(protocol({ serverMs: 400, answer: 'a' }, { serverMs: 400, answer: 'a' })))
    expect(r.decided).toBe(false)
    expect(r.verdict).toMatch(/within 5% of each other/)
  })

  it('ignores the warm-up: a cold first run cannot move the median', () => {
    const runs = protocol({ serverMs: 500 }, { serverMs: 400 }).map((x) => (x.warmup ? { ...x, serverMs: 105_000 } : x))
    const [r] = benchReport(bench(runs))
    expect(r.comparison.summaries.map((s) => s.serverMs)).toEqual([500, 400])
  })

  it('says a single store stands on its own rather than naming a winner', () => {
    const jsonOnly = benchTargets(WITH_PQ, { sampleOnly: false, includeParquet: false })
    const runs = benchPlan(['count'], jsonOnly).map((p) => run('count', p.target.id, { warmup: p.warmup }))
    const [r] = benchReport({ ...bench(runs), targets: jsonOnly })
    expect(r.decided).toBe(false)
    expect(r.verdict).toMatch(/Only one store was measured/)
  })

  it('flags a one-minute disagreement too, without naming a winner there', () => {
    const p = probeOf([run('count', JSON_TARGET_ID, { rows: 10 }), run('count', PARQUET_TARGET_ID, { rows: 12 })])
    expect(probeDisagrees(p, 'count')).toBe(true)
    expect(probeDisagrees(probeOf([run('count', JSON_TARGET_ID), run('count', PARQUET_TARGET_ID)]), 'count')).toBe(false)
  })

  it('flags a one-minute count that differs in value, with one row from each store', () => {
    const p = probeOf([run('count', JSON_TARGET_ID, { rows: 1, answer: 'c=10' }), run('count', PARQUET_TARGET_ID, { rows: 1, answer: 'c=12' })])
    expect(probeDisagreement(p, 'count')).toBe('values')
    const same = probeOf([run('count', JSON_TARGET_ID, { rows: 1, answer: 'c=10' }), run('count', PARQUET_TARGET_ID, { rows: 1, answer: 'c=10' })])
    expect(probeDisagreement(same, 'count')).toBeNull()
  })
})

describe('the canonical answer', () => {
  it('does not depend on the order of the rows or of the fields in a row', () => {
    expect(canonicalAnswer([{ a: 1, b: 2 }, { a: 3, b: 4 }])).toBe(canonicalAnswer([{ b: 4, a: 3 }, { b: 2, a: 1 }]))
  })

  it('tells a different value apart', () => {
    expect(canonicalAnswer([{ c: 18 }])).not.toBe(canonicalAnswer([{ c: 43_338 }]))
  })
})

describe('a stage that has not ended', () => {
  const key = selectionKey(['count'], both)

  it('is not called stopped while it runs, however few runs are in', () => {
    const running = { ...probeOf([]), ended: false }
    expect(stageStopped(running)).toBe(false)
    expect(stageStopped({ ...running, ended: true })).toBe(true)
  })

  it('keeps the 15-minute stage refused while the one-minute stage runs, and says why', () => {
    const running = { ...probeOf([run('count', JSON_TARGET_ID), run('count', PARQUET_TARGET_ID)]), ended: false }
    expect(fifteenRefusal(running, key)).toBe('The one-minute stage is still running.')
  })
})

describe('the stage’s work in words', () => {
  it('states the total when every run’s work was reported', () => {
    expect(stageWorkWords([run('count', JSON_TARGET_ID, { cpuSeconds: 2 }), run('count', PARQUET_TARGET_ID, { cpuSeconds: 4 })])).toBe(
      'Work done by this stage: 6 CPU-seconds.',
    )
  })

  it('never counts unreported work as zero: the figure becomes a floor, and says how many it leaves out', () => {
    const words = stageWorkWords([run('count', JSON_TARGET_ID, { cpuSeconds: 2 }), run('count', PARQUET_TARGET_ID, { cpuSeconds: null })])
    expect(words).toContain('at least 2 CPU-seconds')
    expect(words).toContain('did not report the work of 1 of its 2 searches')
  })

  it('says not reported when nothing was', () => {
    expect(stageWorkWords([run('count', JSON_TARGET_ID, { cpuSeconds: null })])).toMatch(/not reported/)
  })
})
