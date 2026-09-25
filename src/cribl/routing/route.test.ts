// The router in the submit path: with the shipped table nothing changes; with a
// table that moves one query (an in-test override — the shipped one moves
// none), that query's job reads gigamon_ami_pq, and only when every other
// condition holds. The sample-data seam still comes first.
//
// Through the real runSearch with `fetch` stubbed, because the claim worth
// testing is "this is the query the platform receives".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_DATASET } from '../../queries/datasets'
import { buildTalkersQuery } from '../../queries/capacityTopTalkers'
import { buildTrendQuery } from '../../queries/tcpHealth'
import { setActiveDataset, LAKE_DATASET } from '../config'
import { PACK_PARQUET_DATASET_ID } from '../pack'
import { runSearch, setQueryRouter } from '../search'
import { forgetCompleteness } from './completeness'
import { PARQUET_DATASET, forgetRanOn, ranOn } from './ranOn'
import { decideRoute, installQueryRouter, overrideRouting } from './route'
import { ROUTES, type RouteEntry, type RouteEvidence } from './table'

const T0 = 1_790_157_600
const WINDOW = { earliest: T0, latest: T0 + 900 }
const NOW = T0 + 1800
const TREND = buildTrendQuery('dupacks')
const EVIDENCE: RouteEvidence = {
  report: 'docs/parity/2026-10-01-proof-install.json',
  date: '2026-10-01',
  windows: [0, 5, 11].map((h) => ({ earliest: T0 + h * 3600, latest: T0 + h * 3600 + 900 })),
}
const MOVED: RouteEntry = { id: 'tcp.trend', from: 'test', queries: [TREND], pin: null, target: 'parquet', evidence: EVIDENCE }
/** Everything a move needs, so each test can take away one thing. */
const MOVING = {
  entries: [MOVED],
  types: { protocol: 'number', tcp_dup_ack: 'number' } as const,
  complete: () => ({ complete: true, why: null }),
}

/** Submit through the real client; answer with the query body Cribl would receive. */
async function submitted(query: string, opts: { earliest?: string | number; latest?: string | number; asWritten?: boolean } = {}): Promise<string> {
  const bodies: string[] = []
  const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/search/jobs')) {
      bodies.push((JSON.parse(String(init.body)) as { query: string }).query)
      return json({ items: [{ id: 'job-test' }] })
    }
    if (String(url).includes('/status')) return json({ items: [{ status: 'completed' }] })
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"totalEventCount":0}', json: async () => ({}) }
  })
  await runSearch(query, { earliest: WINDOW.earliest, latest: WINDOW.latest, ...opts })
  vi.unstubAllGlobals()
  return bodies[0].replace(/^(set [^;]+; )+/, '')
}

/**
 * Run a job through the real client to its end, which is `status`. `onStatus`
 * runs at each status poll, while the job is still in flight.
 */
async function ran(query: string, status: 'completed' | 'failed', onStatus?: () => void, signal?: AbortSignal): Promise<void> {
  const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) })
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).endsWith('/search/jobs')) return json({ items: [{ id: 'job-test' }] })
    if (String(url).includes('/cancel')) return json({})
    if (String(url).includes('/status')) {
      onStatus?.()
      return json({ items: [{ status }] })
    }
    if (String(url).includes('/diag') || String(url).includes('/logs')) return json({ items: [] })
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"totalEventCount":0}', json: async () => ({}) }
  })
  try {
    await runSearch(query, { earliest: WINDOW.earliest, latest: WINDOW.latest, pollMs: 1, signal })
  } finally {
    vi.unstubAllGlobals()
  }
}

beforeEach(() => installQueryRouter())
afterEach(() => {
  setQueryRouter(null)
  overrideRouting(null)
  forgetRanOn()
  forgetCompleteness()
  setActiveDataset(LAKE_DATASET)
  vi.unstubAllGlobals()
})

describe('with the shipped table', () => {
  it('submits every listed query exactly as written, on gigamon_ami', async () => {
    for (const e of ROUTES) {
      for (const q of e.queries) {
        expect(await submitted(q), `${e.id} left gigamon_ami`).toBe(q)
        expect(ranOn(q)).toBe(LAKE_DATASET)
      }
    }
  })

  it('decides JSON for every entry, and says why', () => {
    for (const e of ROUTES) {
      for (const q of e.queries) {
        const d = decideRoute(q, WINDOW, NOW)
        expect(d.dataset).toBe(LAKE_DATASET)
        expect(d.why).toBe(e.pin ? `pinned to JSON (${e.pin})` : 'the routing table keeps it on JSON')
      }
    }
  })

  it('leaves a text no entry lists on JSON — a typed filter has no evidence', () => {
    const typed = buildTalkersQuery('src_ip', 'openai')
    expect(decideRoute(typed, WINDOW, NOW)).toEqual({ dataset: LAKE_DATASET, id: null, why: 'not in the routing table' })
  })
})

describe('with a table that moves one query (test override)', () => {
  it('submits that query on gigamon_ami_pq, and records where it ran for the ⓘ', async () => {
    overrideRouting(MOVING)
    expect(await submitted(TREND)).toBe(TREND.replace('dataset="gigamon_ami"', `dataset="${PARQUET_DATASET}"`))
    expect(ranOn(TREND)).toBe('gigamon_ami_pq')
  })

  it('moves nothing else', async () => {
    overrideRouting(MOVING)
    const other = buildTrendQuery('crc')
    expect(await submitted(other)).toBe(other)
  })

  it('puts the ⓘ back on JSON when the next job of the same query runs there', async () => {
    overrideRouting(MOVING)
    await submitted(TREND)
    overrideRouting({ ...MOVING, complete: () => ({ complete: false, why: 'gap' }) })
    await submitted(TREND)
    expect(ranOn(TREND)).toBe(LAKE_DATASET)
  })

  it('names no new dataset while the job is still running: the figure on screen is the old one', async () => {
    overrideRouting(MOVING)
    let during: string | null = null
    await ran(TREND, 'completed', () => {
      during = ranOn(TREND)
    })
    expect(during, 'the job had not answered yet').toBe(LAKE_DATASET)
    expect(ranOn(TREND), 'and once it answered, it names where it ran').toBe(PARQUET_DATASET)
  })

  it('keeps the ⓘ on the dataset of the figure still on screen when the next job fails', async () => {
    overrideRouting(MOVING)
    await ran(TREND, 'completed')
    expect(ranOn(TREND)).toBe(PARQUET_DATASET)
    // The next job routes to JSON and fails: the panel keeps the Parquet figure,
    // so the ⓘ must keep naming Parquet.
    overrideRouting({ ...MOVING, complete: () => ({ complete: false, why: 'gap' }) })
    await expect(ran(TREND, 'failed')).rejects.toThrow('Cribl Search failed')
    expect(ranOn(TREND)).toBe(PARQUET_DATASET)
  })

  it('keeps the ⓘ where it was when the next job is aborted', async () => {
    overrideRouting({ ...MOVING, complete: () => ({ complete: false, why: 'gap' }) })
    await ran(TREND, 'completed')
    overrideRouting(MOVING)
    const ac = new AbortController()
    // Whether the client then throws or answers, the panel drops an aborted job's rows.
    await ran(TREND, 'completed', () => ac.abort(), ac.signal).catch(() => undefined)
    expect(ranOn(TREND)).toBe(LAKE_DATASET)
  })

  it('stays on JSON when the window is not proven complete — the shipped completeness cache is empty', async () => {
    overrideRouting({ entries: MOVING.entries, types: MOVING.types })
    expect(await submitted(TREND)).toBe(TREND)
    expect(decideRoute(TREND, WINDOW, NOW).why).toContain('no completeness check covers')
  })

  it('stays on JSON when a field has no type', () => {
    overrideRouting({ ...MOVING, types: {} })
    expect(decideRoute(TREND, WINDOW, NOW).why).toBe('type not measured: protocol, tcp_dup_ack')
  })

  it('stays on JSON without evidence, even if the table says Parquet', () => {
    overrideRouting({ ...MOVING, entries: [{ ...MOVED, evidence: null }] })
    expect(decideRoute(TREND, WINDOW, NOW).dataset).toBe(LAKE_DATASET)
  })

  it('stays on JSON for a pinned entry whatever else it says', () => {
    overrideRouting({ ...MOVING, entries: [{ ...MOVED, pin: 'measurement' }] })
    expect(decideRoute(TREND, WINDOW, NOW).why).toBe('pinned to JSON (measurement)')
  })

  it('stays on JSON on an install where a D/F key is sparse', () => {
    const talkers = buildTalkersQuery('src_ip', '')
    overrideRouting({
      ...MOVING,
      entries: [{ ...MOVED, id: 'capacity.talkers.src_ip', queries: [talkers] }],
      types: { src_ip: 'string', total_bytes: 'number' },
      density: { src_ip: { present: 993, total: 1000 } },
    })
    expect(decideRoute(talkers, WINDOW, NOW).dataset).toBe(LAKE_DATASET)
  })

  it('never routes a measurement submitted asWritten', async () => {
    overrideRouting(MOVING)
    expect(await submitted(TREND, { asWritten: true })).toBe(TREND)
  })

  it('lets the sample seam win: on sample data the query goes to the sample, never to Parquet', async () => {
    overrideRouting(MOVING)
    setActiveDataset(SAMPLE_DATASET)
    expect(await submitted(TREND)).toBe(TREND.replace('dataset="gigamon_ami"', `dataset="${SAMPLE_DATASET}"`))
    expect(ranOn(TREND), 'the router was not even asked').toBe(LAKE_DATASET)
  })
})

it('routes to the dataset the pack creates, whose name ranOn.ts writes out', () => {
  expect(PARQUET_DATASET).toBe(PACK_PARQUET_DATASET_ID)
})

describe('without installQueryRouter', () => {
  it('runs every query as written — the router is opt-in wiring, never a default', async () => {
    setQueryRouter(null)
    overrideRouting(MOVING)
    expect(await submitted(TREND)).toBe(TREND)
  })
})
