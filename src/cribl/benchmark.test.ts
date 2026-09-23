// The benchmark's job is to be RIGHT, not to produce a number.
//
// Every test below corresponds to a way this measurement could report a
// confident falsehood, and each of those ways has already been measured on this
// workspace — none is hypothetical:
//
//   reuse      30.92 s -> 0.95 s on a repeat inside the 2-minute window
//   cold start 105 s on the first query, sub-second on the twelve after
//   stagger    ~1.6 s between concurrently admitted jobs
//   nulls      a technique counter 18 -> 43,338 on Parquet, same window
//
// WHAT THIS FILE CANNOT ESTABLISH: that the numbers a run produces are true.
// It tests the plan, the reduction and the refusals. Whether the server's
// reported elapsed time means what we think it means is a live question and is
// not settled here.
import { describe, expect, it } from 'vitest'
import {
  ADMISSION_STAGGER_MS,
  MEASURED_RUNS,
  REUSE_GAP_MS,
  STORE_WORDS,
  WARMUP_RUNS,
  compare,
  estimateDurationMs,
  runCount,
  runSentence,
  planRuns,
  summarise,
  type BenchTarget,
  type RunResult,
} from './benchmark'

const target = (over: Partial<BenchTarget> = {}): BenchTarget => ({
  id: 'json',
  kind: 'lake-json',
  dataset: 'gigamon_ami',
  label: STORE_WORDS['lake-json'],
  available: true,
  ...over,
})

const JSON_T = target()
const PQ_T = target({ id: 'pq', kind: 'lake-parquet', dataset: 'gigamon_ami_pq', label: STORE_WORDS['lake-parquet'] })
const LH_T = target({ id: 'lh', kind: 'lakehouse', dataset: 'main', label: STORE_WORDS.lakehouse })

const run = (over: Partial<RunResult> & { targetId: string }): RunResult => ({
  warmup: false,
  serverMs: 1000,
  clientMs: 2000,
  cpuSeconds: 10,
  rows: 100,
  ...over,
})

describe('the run plan', () => {
  it('discards a warm-up for every target — cold start measured 105 s', () => {
    const plan = planRuns([JSON_T, PQ_T])
    expect(plan.filter((p) => p.warmup)).toHaveLength(2 * WARMUP_RUNS)
    expect(plan.filter((p) => !p.warmup)).toHaveLength(2 * MEASURED_RUNS)
  })

  it('INTERLEAVES rounds instead of grouping by target', () => {
    // Grouping would run every JSON measurement inside one minute and every
    // Parquet one three minutes later, charging any drift in the feed entirely
    // to one store. This assertion is the whole reason the loop is nested the
    // way it is, and it would pass silently if the loops were swapped.
    const ids = planRuns([JSON_T, PQ_T]).map((p) => p.target.id)
    expect(ids.slice(0, 4)).toEqual(['json', 'pq', 'json', 'pq'])
  })

  it('leaves out a store that is not configured', () => {
    expect(planRuns([JSON_T, target({ id: 'pq', available: false })]).every((p) => p.target.id === 'json')).toBe(true)
    expect(planRuns([target({ available: false })])).toEqual([])
  })

  it('keeps the reuse gap longer than the window it defeats', () => {
    // REUSE_WINDOW is '2min'. A gap shorter than that is not a gap.
    expect(REUSE_GAP_MS).toBeGreaterThan(120_000)
  })
})

describe('reducing runs to a summary', () => {
  it('takes the MEDIAN, so one hung job cannot drag the answer', () => {
    // ~1% of queries hit the 24 h usage-group rule. A mean of [900, 1000, 90000]
    // is 30,633; the median is 1000.
    const rows = [
      run({ targetId: 'json', serverMs: 900 }),
      run({ targetId: 'json', serverMs: 1000 }),
      run({ targetId: 'json', serverMs: 90_000 }),
    ]
    expect(summarise(JSON_T, rows).serverMs).toBe(1000)
  })

  it('never lets a warm-up into the figures', () => {
    const rows = [
      run({ targetId: 'json', warmup: true, serverMs: 105_000, clientMs: 106_000 }),
      run({ targetId: 'json', serverMs: 800, clientMs: 1500 }),
    ]
    const s = summarise(JSON_T, rows)
    expect(s.serverMs).toBe(800)
    expect(s.ran, 'the warm-up was counted as a run').toBe(1)
  })

  it('counts a failed run without letting it into the median', () => {
    const rows = [
      run({ targetId: 'json', serverMs: 800 }),
      run({ targetId: 'json', serverMs: null, error: 'Search stopped' }),
    ]
    const s = summarise(JSON_T, rows)
    expect(s.serverMs).toBe(800)
    expect(s.failed).toBe(1)
    expect(s.ran).toBe(2)
  })

  it('reports the app overhead, which is the number nothing has measured', () => {
    // A store answering in 0.15 s behind a panel that takes 1.5 s means 1.35 s
    // of this app — poll quantisation, admission wait and render. No storage
    // format moves it, and it is invisible unless reported separately.
    const s = summarise(JSON_T, [run({ targetId: 'json', serverMs: 150, clientMs: 1500 })])
    expect(s.overheadMs).toBe(1350)
  })

  it('never reports a negative overhead', () => {
    // Clock skew between the server's elapsed and the browser's wall could
    // otherwise produce "the app took minus 40 ms", which reads as a bug.
    expect(summarise(JSON_T, [run({ targetId: 'json', serverMs: 900, clientMs: 860 })]).overheadMs).toBe(0)
  })

  it('answers null rather than zero when nothing succeeded', () => {
    const s = summarise(JSON_T, [run({ targetId: 'json', serverMs: null, error: 'boom' })])
    expect(s.serverMs).toBeNull()
    expect(s.overheadMs).toBeNull()
  })
})

describe('the verdict, and the three times it refuses to give one', () => {
  it('names the fastest by SERVER time, not by client wall', () => {
    // Client wall cannot resolve sub-second differences through the poll ramp,
    // so a verdict from it would be noise with a decimal point. Here Parquet is
    // faster on the server and slower on the client; the server wins.
    const a = summarise(JSON_T, [run({ targetId: 'json', serverMs: 4000, clientMs: 5000 })])
    const b = summarise(PQ_T, [run({ targetId: 'pq', serverMs: 500, clientMs: 5200 })])
    const c = compare([a, b])
    expect(c.fastest?.target.id).toBe('pq')
    expect(c.speedup).toBe(8)
  })

  it('REFUSES a winner when the row counts disagree', () => {
    // The Parquet null-semantics defect, exactly: same query, same window, a
    // counter measured 18 against 43,338. A store answering a different
    // question faster is not a faster store, and naming it the winner is how
    // the wrong format ships.
    const a = summarise(JSON_T, [run({ targetId: 'json', serverMs: 4000, rows: 18 })])
    const b = summarise(PQ_T, [run({ targetId: 'pq', serverMs: 400, rows: 43_338 })])
    const c = compare([a, b])
    expect(c.fastest).toBeNull()
    expect(c.disagree).toBe(true)
    expect(c.noWinnerBecause).toContain('did not answer the same question')
  })

  it('refuses a winner when only one store is configured, and says so kindly', () => {
    const c = compare([summarise(JSON_T, [run({ targetId: 'json' })])])
    expect(c.fastest).toBeNull()
    expect(c.noWinnerBecause).toContain('Only one store is configured')
    expect(c.noWinnerBecause, 'a single store should still be told its timings stand').toContain('stand on their own')
  })

  it('refuses a winner when a second store was configured but never answered', () => {
    const a = summarise(JSON_T, [run({ targetId: 'json', serverMs: 900 })])
    const b = summarise(PQ_T, [run({ targetId: 'pq', serverMs: null, error: 'no such dataset' })])
    const c = compare([a, b])
    expect(c.fastest).toBeNull()
    expect(c.noWinnerBecause).toContain('Only one store returned a timing')
  })

  it('still reports every summary when it refuses a winner', () => {
    // A refusal must not hide the data. The reader needs the rows column to see
    // WHY there is no winner.
    const a = summarise(JSON_T, [run({ targetId: 'json', rows: 18 })])
    const b = summarise(PQ_T, [run({ targetId: 'pq', rows: 43_338 })])
    expect(compare([a, b]).summaries).toHaveLength(2)
  })
})

describe('what the button says it will do', () => {
  it('counts the runs, warm-ups included, one store or three', () => {
    const per = WARMUP_RUNS + MEASURED_RUNS
    expect(runCount([JSON_T])).toBe(per)
    expect(runCount([JSON_T, PQ_T, LH_T])).toBe(3 * per)
    expect(runCount([target({ available: false })])).toBe(0)
  })

  it('describes the work, and quotes no cost at all', () => {
    // Cost is not a design constraint here — the owner's call, 2026-09-22 — so
    // the button says what it will DO. A credit figure in front of a
    // measurement is asking the reader to weigh something they have already
    // decided not to weigh, and a benchmark nobody runs measures nothing.
    const s = runSentence([JSON_T, LH_T])
    expect(s).toContain('warm-up')
    expect(s).toContain('one at a time')
    for (const word of ['credit', 'CPU-second', 'bill', 'cost', 'paid']) {
      expect(s.toLowerCase(), `the run sentence mentions ${word}`).not.toContain(word.toLowerCase())
    }
  })

  it('says there is nothing to run rather than describing zero searches', () => {
    expect(runSentence([target({ available: false })])).toBe('No store is configured, so there is nothing to run.')
  })

  it('budgets an admission gap between sequential runs', () => {
    // Runs are sequential precisely to avoid the ~1.6 s stagger, so the wall
    // time is runs x (query + gap) rather than the longest single query.
    expect(estimateDurationMs([JSON_T], 1000)).toBe((WARMUP_RUNS + MEASURED_RUNS) * (1000 + ADMISSION_STAGGER_MS))
  })
})

describe('CPU-seconds as WORK, not as a bill', () => {
  it('is still measured and still summarised', () => {
    // 127 CPU-s against 0.2 for the same answer is 635x less work. That is an
    // efficiency fact whoever pays for it, and it is the second axis of this
    // comparison: a store can win on wall-clock while doing far more work to
    // get there, and that gap predicts behaviour under load.
    const s = summarise(JSON_T, [
      run({ targetId: 'json', cpuSeconds: 120 }),
      run({ targetId: 'json', cpuSeconds: 127 }),
      run({ targetId: 'json', cpuSeconds: 134 }),
    ])
    expect(s.cpuSeconds).toBe(127)
  })

  it('answers null rather than zero when the meter could not be read', () => {
    // Zero work is a claim. "We could not tell" is a different one, and a
    // benchmark that reported the first for the second would flatter a store.
    expect(summarise(JSON_T, [run({ targetId: 'json', cpuSeconds: null })]).cpuSeconds).toBeNull()
  })
})
