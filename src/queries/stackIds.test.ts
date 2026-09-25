// The Data Flow counters, run against a model of cribl_metrics.
//
// The queries in ./dataFlow.ts are `summarize col=sum(iif(COND, value, 0))`, so
// each column is a predicate over counter rows plus a sum. This file turns each
// COND into a JS predicate — the only operators the queries use are `==`,
// `and`, `or` and parentheses — and sums synthetic rows shaped the way the rows
// were measured on 2026-09-24 (see ./stackIds.ts). That makes "nothing is
// double-counted" a number this file checks, not an argument it takes on trust.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { LAKE_DATASET } from '../cribl/config'
import {
  PACK_0_1_0, PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_ID, PACK_PUBLISHED_VERSIONS, PACK_ROUTES_FILE,
  PACK_SAMPLE_ROUTE_ID, packRouteLabel,
} from '../cribl/pack'
import {
  HTTP_PIPELINE_ID, HTTP_ROUTE_ID, HTTP_SOURCE_ID, LAKE_DESTINATION_ID, LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID,
  LEGACY_SYSLOG_SOURCE_ID, ROUTE_SPEC,
} from '../cribl/provision'
import { LAKE_TOTAL_QUERY, METRICS_QUERY } from './dataFlow'
import {
  COUNTED_DATASET, COUNTED_DESTINATIONS_PROSE, COUNTED_PATHS, COUNTED_PIPELINES_PROSE, COUNTED_SOURCES_PROSE,
  DESTINATION_COUNTED_PATHS, PIPELINE_COUNTED_PATHS, SHOWN_INPUTS, SHOWN_OUTPUTS, SHOWN_PIPELINES, STACKS, type StackPath,
} from './stackIds'

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

/** Every path of a stack whose objects live inside the pack. */
const PACK_PATHS: readonly StackPath[] = STACKS.filter((s) => s.scope === 'pack').flatMap((s) => s.paths)

/**
 * The label a pipe.* row carries for a pack's pipeline. UNMEASURED (no pipe.*
 * row appeared for a test pack's pipeline, 2026-09-25), so the model gives it a
 * label no query could guess: a query that leaned on any spelling of it would
 * read short here.
 */
const unmeasuredPipeLabel = (p: StackPath) => `unmeasured-pack-pipeline:${p.pipeline}`

/**
 * The rows `n` events on a source produce: one intake row, and per path one
 * pipeline pass and one destination write — plus the null-namespace
 * aggregates that sit beside them in cribl_metrics and must never be summed.
 */
function sourceRows(input: string, paths: readonly StackPath[], n: number, opts: { fromInput?: boolean; packPipe?: (p: StackPath) => string } = {}): Row[] {
  // `from_input` on a pipeline or destination row is measured on the
  // QuickConnect path only; a ROUTED path may not carry it. `fromInput: false`
  // models that, so a query that leans on it is caught here, not on a tenant.
  const fi: Row = (opts.fromInput ?? true) ? { from_input: input } : {}
  const rows: Row[] = [
    { metric: 'total.in_events', namespace: NS, input, value: n },
    { metric: 'total.in_events', namespace: null, input, value: n },
    { metric: 'total.in_events', namespace: null, value: n },
  ]
  for (const p of paths) {
    const pipe = PACK_PATHS.includes(p) ? (opts.packPipe ?? unmeasuredPipeLabel)(p) : p.pipeline
    rows.push(
      { metric: 'pipe.in_events', namespace: NS, id: pipe, ...fi, value: n },
      { metric: 'pipe.out_events', namespace: NS, id: pipe, ...fi, value: n },
      { metric: 'pipe.out_events', namespace: null, id: pipe, value: n },
      { metric: 'total.out_events', namespace: NS, ...fi, output: p.output, value: n },
      { metric: 'total.out_bytes', namespace: NS, ...fi, output: p.output, value: n * 10 },
      { metric: 'total.out_events', namespace: null, output: p.output, value: n },
    )
  }
  return rows
}

/** Every source in the list, each sending a different number of events. */
function everyStackRunning(opts: { fromInput?: boolean; packPipe?: (p: StackPath) => string } = {}): { rows: Row[]; landed: number } {
  const byInput = new Map<string, StackPath[]>()
  for (const p of STACKS.flatMap((s) => s.paths)) byInput.set(p.input, [...(byInput.get(p.input) ?? []), p])
  const rows: Row[] = []
  let landed = 0
  let n = 7
  for (const [input, paths] of byInput) {
    rows.push(...sourceRows(input, paths, n, opts))
    if (paths.some((p) => p.dataset === COUNTED_DATASET)) landed += n
    n = n * 3 + 1
  }
  return { rows, landed }
}

describe('the Data Flow counters count every stack, and each event once', () => {
  it('adds up the demo, Syslog, Raw HTTP and pack stacks side by side, dual-write included', () => {
    const { rows, landed } = everyStackRunning()
    expect(landed).toBeGreaterThan(0)
    const m = run(METRICS_QUERY, rows)
    expect(m.src_events).toBe(landed)
    expect(m.pipe_events).toBe(landed)
    expect(m.dst_events).toBe(landed)
    expect(m.dst_bytes).toBe(landed * 10)
  })

  it('counts the same when routed rows carry no from_input dimension', () => {
    // Unmeasured: whether a routed path's pipe.* and total.out_* rows name
    // their source. Every destination and pipeline on a single path is
    // filtered without it, so the answer must not move the figures.
    const { rows, landed } = everyStackRunning({ fromInput: false })
    const m = run(METRICS_QUERY, rows)
    expect([m.src_events, m.pipe_events, m.dst_events, m.dst_bytes]).toEqual([landed, landed, landed, landed * 10])
    expect(run(LAKE_TOTAL_QUERY, rows)).toEqual({ total_events: landed, total_bytes: landed * 10 })
  })

  it('counts the same whatever label a pack pipeline turns out to carry', () => {
    // A pack pipeline's cribl_metrics label is unmeasured. Whether its rows say
    // `<packId>.<id>`, the bare id, or nothing this file can guess, the
    // Processing figure must not move: no pack path is counted by its pipeline.
    for (const packPipe of [unmeasuredPipeLabel, (p: StackPath) => `${PACK_ID}.${p.pipeline}`, (p: StackPath) => p.pipeline]) {
      const { rows, landed } = everyStackRunning({ packPipe })
      expect(run(METRICS_QUERY, rows).pipe_events).toBe(landed)
    }
  })

  it('names no pipeline inside a pack', () => {
    const pipes = new Set([...METRICS_QUERY.matchAll(/\bid=="([^"]+)"/g)].map((x) => x[1]))
    const global = new Set(STACKS.filter((s) => s.scope === 'global').flatMap((s) => s.paths.map((p) => p.pipeline)))
    for (const id of pipes) expect(global.has(id), `${id} is not a global pipeline`).toBe(true)
    for (const p of PACK_PATHS) expect(COUNTED_PATHS.includes(p) ? DESTINATION_COUNTED_PATHS : [p]).toContain(p)
    expect(PIPELINE_COUNTED_PATHS.filter((p) => PACK_PATHS.includes(p))).toEqual([])
  })

  it('holds the Lake card to gigamon_ami: a Parquet copy of every event does not double it', () => {
    const json = COUNTED_PATHS.find((p) => p.route === packRouteLabel(PACK_HTTP_JSON_ROUTE_ID))!
    const all = STACKS.flatMap((s) => s.paths)
    const parquet = all.find((p) => p.route === packRouteLabel(PACK_HTTP_PARQUET_ROUTE_ID))!
    const sample = all.find((p) => p.route === packRouteLabel(PACK_SAMPLE_ROUTE_ID))!
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
    // Inside a pack a destination's label carries the pack id (measured 2026-09-25).
    expect(new Set(outputs)).toEqual(new Set([
      'cribl_lake:gigamon_lake', 'cribl_lake:cc-network-gigamon-ami.out_gno_lake', 'cribl_lake:cc-network-gigamon-ami.gigamon_ami_json_lake',
    ]))
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

  it('calls the old Syslog stack retired, and still counts and names it, because tenants may still run it', () => {
    // No release creates it any more — this one only offers to remove it — so
    // "offered" was wrong. It is not gone either: a tenant that ran an earlier
    // release can still be sending through it, and a counter that skipped it
    // would read short while looking complete.
    const legacy = STACKS.find((s) => s.key === 'global-legacy-syslog')!
    expect(legacy.status).toBe('retired')
    for (const p of legacy.paths) expect(COUNTED_PATHS).toContain(p)
    expect(SHOWN_INPUTS).toContain(LEGACY_SYSLOG_SOURCE_ID)
    expect(SHOWN_PIPELINES).toContain(LEGACY_SYSLOG_PIPELINE_ID)
  })

  it('names the Syslog stack earlier releases of Guided Setup wrote', () => {
    const syslog = STACKS.find((s) => s.key === 'global-legacy-syslog')!.paths[0]
    expect(syslog).toEqual({
      route: LEGACY_SYSLOG_ROUTE_ID,
      input: `syslog:${LEGACY_SYSLOG_SOURCE_ID}`,
      pipeline: LEGACY_SYSLOG_PIPELINE_ID,
      output: `cribl_lake:${LAKE_DESTINATION_ID}`,
      dataset: LAKE_DATASET,
    })
  })

  it('names the Raw HTTP stack Guided Setup actually writes, type prefix from its own route filter', () => {
    const http = STACKS.find((s) => s.key === 'global-http')!
    expect(http.status).toBe('offered')
    expect(http.paths).toEqual([{
      route: HTTP_ROUTE_ID,
      input: `http_raw:${HTTP_SOURCE_ID}`,
      pipeline: HTTP_PIPELINE_ID,
      output: `cribl_lake:${LAKE_DESTINATION_ID}`,
      dataset: LAKE_DATASET,
    }])
    // The route provision.ts writes selects exactly this `input` value.
    expect(ROUTE_SPEC.filter).toBe(`__inputId=='${http.paths[0].input}'`)
    expect(ROUTE_SPEC.pipeline).toBe(http.paths[0].pipeline)
    expect(ROUTE_SPEC.output).toBe(LAKE_DESTINATION_ID)
  })

  it('has no stack still waiting for its ids', () => {
    expect(STACKS.filter((s) => s.status === 'pending' || /PENDING/.test(s.key))).toEqual([])
  })

  it('names the pack 0.2.x objects the pack YAML defines, by their in-pack metric labels, type prefix included', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs', PACK_ID)
    const yml = (rel: string) => parse(readFileSync(join(dir, rel), 'utf8'))
    const inputs = yml('default/inputs.yml').inputs as Record<string, { type: string }>
    const outputs = yml('default/outputs.yml').outputs as Record<string, { type: string }>
    const routes = yml(PACK_ROUTES_FILE).routes as { id: string; filter: string; pipeline: string; output: string }[]
    const pack = STACKS.find((s) => s.key === 'pack-0.2')!
    // Every route the YAML defines is a path here, and nothing else is. Inside a
    // pack cribl_metrics names a route `<packId>.<id>`, a source
    // `<type>:<packId>.<id>` and a destination `<type>:<packId>.<id>`
    // (measured 2026-09-25); the route filter spells the source the same way.
    expect(pack.paths.map((p) => p.route).sort()).toEqual(routes.map((r) => `${PACK_ID}.${r.id}`).sort())
    for (const p of pack.paths) {
      const r = routes.find((x) => `${PACK_ID}.${x.id}` === p.route)!
      const inputId = Object.keys(inputs).find((id) => r.filter === `__inputId=='${inputs[id].type}:${PACK_ID}.${id}'`)!
      expect(inputId).toBeDefined()
      expect(p.input).toBe(`${inputs[inputId].type}:${PACK_ID}.${inputId}`)
      expect(p.pipeline).toBe(r.pipeline)
      expect(p.output).toBe(`${outputs[r.output].type}:${PACK_ID}.${r.output}`)
    }
  })

  it('calls the 0.2.x pack released exactly when 0.2.0 is on the published list', () => {
    // 0.2.0 was published (2026-09-25) before this build's 0.2.1 was; both ship
    // the same objects, so a tenant may run the stack's ids either way.
    const pack = STACKS.find((s) => s.key === 'pack-0.2')!
    expect(pack.status === 'released').toBe(PACK_PUBLISHED_VERSIONS.includes('0.2.0'))
    expect(pack.status).toBe('released')
  })

  it('calls 0.1.0 released, with the ids that release shipped', () => {
    const pack = STACKS.find((s) => s.key === 'pack-0.1.0')!
    expect(PACK_PUBLISHED_VERSIONS).toContain(PACK_0_1_0.version)
    expect(pack.status).toBe('released')
    expect(pack.paths).toEqual(PACK_0_1_0.paths)
  })
})

describe('the stage ⓘ prose', () => {
  const PROSE = [COUNTED_SOURCES_PROSE, COUNTED_PIPELINES_PROSE, COUNTED_DESTINATIONS_PROSE]
  const bare = (v: string) => v.slice(v.indexOf(':') + 1)

  it('names only objects a tenant can have today: the running, offered and retired stacks', () => {
    const today = (s: (typeof STACKS)[number]) => s.status === 'running' || s.status === 'offered' || s.status === 'retired'
    const shown = STACKS.filter(today).flatMap((s) => s.paths)
    const unshown = STACKS.filter((s) => !today(s)).flatMap((s) => s.paths)
    const ids = (ps: readonly StackPath[]) => new Set(ps.flatMap((p) => [bare(p.input), p.pipeline, bare(p.output)]))
    const allowed = ids(shown)
    const forbidden = [...ids(unshown)].filter((id) => !allowed.has(id))
    expect(forbidden.length).toBeGreaterThan(0)
    for (const text of PROSE) for (const id of forbidden) expect(text).not.toMatch(new RegExp(`\\b${id}\\b`))
    expect(SHOWN_INPUTS).toEqual(['in_gigamon_datagen', 'in_gigamon_syslog', 'in_gigamon_http'])
    expect(SHOWN_PIPELINES).toEqual(['gigamon_ami', 'gigamon_syslog', 'gigamon_http_normalize'])
    expect(SHOWN_OUTPUTS).toEqual(['gigamon_lake'])
    for (const id of SHOWN_INPUTS) expect(COUNTED_SOURCES_PROSE).toContain(id)
    for (const id of SHOWN_PIPELINES) expect(COUNTED_PIPELINES_PROSE).toContain(id)
    for (const id of SHOWN_OUTPUTS) expect(COUNTED_DESTINATIONS_PROSE).toContain(id)
  })

  it('explains no mechanism that ships in no release', () => {
    for (const text of PROSE) expect(text).not.toMatch(/Parquet|dual|same pipeline/i)
  })
})
