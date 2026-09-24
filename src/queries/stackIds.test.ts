// The Data Flow counters, run against a model of cribl_metrics.
//
// The queries in ./dataFlow.ts are `summarize col=sum(iif(COND, value, 0))`, so
// each column is a predicate over counter rows plus a sum. This file turns each
// COND into a JS predicate — the only operators the queries use are `==`,
// `and`, `or` and parentheses — and sums synthetic rows shaped the way the rows
// were measured on 2026-09-24 (see ./stackIds.ts). That makes "nothing is
// double-counted" a number this file checks, not an argument it takes on trust.

import { describe, expect, it } from 'vitest'
import { LAKE_DATASET } from '../cribl/config'
import { LAKE_DESTINATION_ID, SYSLOG_PIPELINE_ID, SYSLOG_ROUTE_ID, SYSLOG_SOURCE_ID } from '../cribl/provision'
import { LAKE_TOTAL_QUERY, METRICS_QUERY } from './dataFlow'
import { COUNTED_DATASET, COUNTED_PATHS, STACKS, type StackPath } from './stackIds'

type Row = Record<string, string | number | null>

const DIMS = ['metric', 'namespace', 'id', 'from_input', 'output', 'input'] as const

/** `col=sum(iif(COND, value, 0))` → a predicate per column. */
function columns(query: string): Record<string, (r: Row) => boolean> {
  const out: Record<string, (r: Row) => boolean> = {}
  for (const m of query.matchAll(/(\w+)=sum\(iif\((.*?), value, 0\)\)(?:, |$)/g)) {
    const js = m[2]
      .replace(new RegExp(`\\b(${DIMS.join('|')})(?===)`, 'g'), 'r.$1')
      .replace(/ and /g, ' && ')
      .replace(/ or /g, ' || ')
    out[m[1]] = new Function('r', `return ${js}`) as (r: Row) => boolean
  }
  return out
}

function run(query: string, rows: readonly Row[]): Record<string, number> {
  const cols = columns(query)
  const out: Record<string, number> = {}
  for (const [name, pred] of Object.entries(cols)) {
    out[name] = rows.reduce((n, r) => n + (pred(r) ? Number(r.value) : 0), 0)
  }
  return out
}

const NS = 'data_insights'

/**
 * The rows `n` events on a source produce: one intake row, and per path one
 * pipeline pass and one destination write — plus the null-namespace
 * aggregates that sit beside them in cribl_metrics and must never be summed.
 */
function sourceRows(input: string, paths: readonly StackPath[], n: number): Row[] {
  const rows: Row[] = [
    { metric: 'total.in_events', namespace: NS, input, value: n },
    { metric: 'total.in_events', namespace: null, input, value: n },
    { metric: 'total.in_events', namespace: null, value: n },
  ]
  for (const p of paths) {
    rows.push(
      { metric: 'pipe.in_events', namespace: NS, id: p.pipeline, from_input: input, value: n },
      { metric: 'pipe.out_events', namespace: NS, id: p.pipeline, from_input: input, value: n },
      { metric: 'pipe.out_events', namespace: null, id: p.pipeline, value: n },
      { metric: 'total.out_events', namespace: NS, from_input: input, output: p.output, value: n },
      { metric: 'total.out_bytes', namespace: NS, from_input: input, output: p.output, value: n * 10 },
      { metric: 'total.out_events', namespace: null, output: p.output, value: n },
    )
  }
  return rows
}

/** Every source in the list, each sending a different number of events. */
function everyStackRunning(): { rows: Row[]; landed: number } {
  const byInput = new Map<string, StackPath[]>()
  for (const p of STACKS.flatMap((s) => s.paths)) byInput.set(p.input, [...(byInput.get(p.input) ?? []), p])
  const rows: Row[] = []
  let landed = 0
  let n = 7
  for (const [input, paths] of byInput) {
    rows.push(...sourceRows(input, paths, n))
    if (paths.some((p) => p.dataset === COUNTED_DATASET)) landed += n
    n = n * 3 + 1
  }
  return { rows, landed }
}

describe('the Data Flow counters count every stack, and each event once', () => {
  it('adds up the demo, Syslog and pack stacks side by side, dual-write included', () => {
    const { rows, landed } = everyStackRunning()
    expect(landed).toBeGreaterThan(0)
    const m = run(METRICS_QUERY, rows)
    expect(m.src_events).toBe(landed)
    expect(m.pipe_events).toBe(landed)
    expect(m.dst_events).toBe(landed)
    expect(m.dst_bytes).toBe(landed * 10)
  })

  it('holds the Lake card to gigamon_ami: a Parquet copy of every event does not double it', () => {
    const json = COUNTED_PATHS.find((p) => p.route === 'gigamon_ami_http_to_json')!
    const all = STACKS.flatMap((s) => s.paths)
    const parquet = all.find((p) => p.route === 'gigamon_ami_http_to_parquet')!
    const sample = all.find((p) => p.route === 'gigamon_ami_sample')!
    expect(parquet.dataset).toBe('gigamon_ami_pq')
    const rows = [
      ...sourceRows(json.input, [json, parquet], 500),
      ...sourceRows(sample.input, [sample], 40),
    ]
    expect(run(LAKE_TOTAL_QUERY, rows)).toEqual({ total_events: 500, total_bytes: 5000 })
    const m = run(METRICS_QUERY, rows)
    expect([m.src_events, m.pipe_events, m.dst_events]).toEqual([500, 500, 500])
  })

  it('still counts today’s demo feed exactly as it did', () => {
    const rows = sourceRows('datagen:in_gigamon_datagen', [COUNTED_PATHS[0]], 17522)
    expect(run(LAKE_TOTAL_QUERY, rows).total_events).toBe(17522)
    const m = run(METRICS_QUERY, rows)
    expect([m.src_events, m.pipe_events, m.dst_events]).toEqual([17522, 17522, 17522])
  })

  it('names no destination that writes another dataset', () => {
    const outputs = [...LAKE_TOTAL_QUERY.matchAll(/output=="([^"]+)"/g)].map((x) => x[1])
    expect(new Set(outputs)).toEqual(new Set(['cribl_lake:gigamon_lake', 'cribl_lake:out_gno_lake', 'cribl_lake:gigamon_ami_json_lake']))
    for (const p of STACKS.flatMap((s) => s.paths).filter((x) => x.dataset !== COUNTED_DATASET)) {
      expect(LAKE_TOTAL_QUERY).not.toContain(`"${p.output}"`)
    }
  })
})

describe('the stack list', () => {
  it('gives each source at most one path into gigamon_ami', () => {
    // The Destinations and Lake sums rely on it: two gigamon_ami paths from one
    // source would write each event into the dataset twice, and count it twice.
    const inputs = COUNTED_PATHS.map((p) => p.input)
    expect(new Set(inputs).size).toBe(inputs.length)
  })

  it('reports on the dataset the app reads', () => {
    expect(COUNTED_DATASET).toBe(LAKE_DATASET)
  })

  it('names the Syslog onboarding stack Guided Setup actually writes', () => {
    const syslog = STACKS.find((s) => s.key === 'global-legacy-syslog')!.paths[0]
    expect(syslog).toEqual({
      route: SYSLOG_ROUTE_ID,
      input: `syslog:${SYSLOG_SOURCE_ID}`,
      pipeline: SYSLOG_PIPELINE_ID,
      output: `cribl_lake:${LAKE_DESTINATION_ID}`,
      dataset: LAKE_DATASET,
    })
  })
})
