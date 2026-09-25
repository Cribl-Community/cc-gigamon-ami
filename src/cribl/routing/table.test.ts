// The routing table's own rules: nothing is on Parquet without evidence and
// eligibility, every query the app runs on gigamon_ami has exactly one entry,
// the pins are where they must be, and schedules never route (S1).

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as capacity from '../../queries/capacityTopTalkers'
import * as dataFlow from '../../queries/dataFlow'
import * as datasets from '../../queries/datasets'
import * as dns from '../../queries/dnsHealth'
import * as fieldExplorer from '../../queries/fieldExplorer'
import * as findings from '../../queries/findings'
import * as flowMap from '../../queries/flowMap'
import * as lakeLanding from '../../queries/lakeLanding'
import * as pqc from '../../queries/pqcReadiness'
import * as security from '../../queries/security'
import * as shadowAi from '../../queries/shadowAi'
import * as snapshots from '../../queries/snapshots'
import * as tcp from '../../queries/tcpHealth'
import * as tls from '../../queries/tlsPosture'
import * as web from '../../queries/webApiHealth'
import { FIELD_TYPES } from '../../data/fieldTypes'
import { MANIFEST, accelPostBody } from '../accel/manifest'
import { PARITY_CHECKS, type FieldType } from '../parity'
import { ROUTES, evidenceProblems, routingSnapshot, tableProblems, type RouteEntry, type RouteEvidence } from './table'

const HOUR = 3600
const T0 = 1_790_157_600
/** Three 15-minute windows at three different hours: enough, by the table's rule. */
const EVIDENCE: RouteEvidence = {
  report: 'docs/parity/2026-10-01-proof-install.json',
  date: '2026-10-01',
  windows: [0, 5, 11].map((h) => ({ earliest: T0 + h * HOUR, latest: T0 + h * HOUR + 900 })),
}
const TREND = tcp.buildTrendQuery('dupacks')
const TREND_TYPES: Record<string, FieldType> = { protocol: 'number', tcp_dup_ack: 'number' }
const parquetEntry = (over: Partial<RouteEntry> = {}): RouteEntry => ({
  id: 'tcp.trend',
  from: 'test',
  queries: [TREND],
  pin: null,
  target: 'parquet',
  evidence: EVIDENCE,
  ...over,
})

describe('the shipped table', () => {
  it('breaks none of its own rules', () => {
    expect(tableProblems()).toEqual([])
  })

  it('moves nothing: every entry is on JSON, with no evidence', () => {
    // No parity evidence exists: gigamon_ami_pq holds no data until pack
    // 0.2.1's HTTP source ships. The day an entry moves, this changes in the
    // same commit as the evidence that moved it.
    expect(ROUTES.filter((e) => e.target !== 'json').map((e) => e.id)).toEqual([])
    expect(ROUTES.filter((e) => e.evidence !== null).map((e) => e.id)).toEqual([])
  })

  it('keeps ids unique', () => {
    const ids = ROUTES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is what the display freeze holds, entry by entry', () => {
    const snap = routingSnapshot()
    expect(Object.keys(snap).sort()).toEqual(ROUTES.map((e) => e.id).sort())
    for (const e of ROUTES) expect(snap[e.id].target).toBe(e.target)
  })
})

describe('the rule: Parquet only with evidence and eligibility', () => {
  it('FAILS an entry on Parquet with no evidence', () => {
    expect(tableProblems([parquetEntry({ evidence: null })], TREND_TYPES)).toEqual(['tcp.trend: routed to Parquet with no parity evidence'])
  })

  it('fails evidence that is not enough: one window, no date, no report', () => {
    const thin: RouteEvidence = { report: ' ', date: 'last week', windows: [EVIDENCE.windows[0]] }
    expect(evidenceProblems(thin)).toEqual([
      'names no report',
      'has no date in YYYY-MM-DD form ("last week")',
      'covers fewer than three windows at different hours',
    ])
  })

  it('fails three windows in the same hour — "different hours" is the point', () => {
    const sameHour = { ...EVIDENCE, windows: [0, 1, 2].map((m) => ({ earliest: T0 + m * 900, latest: T0 + m * 900 + 600 })) }
    expect(evidenceProblems(sameHour)).toEqual(['covers fewer than three windows at different hours'])
  })

  it('fails an entry whose text is not eligible under the type table, whatever the evidence', () => {
    expect(tableProblems([parquetEntry()], FIELD_TYPES)[0]).toContain('not eligible — type not measured: protocol, tcp_dup_ack')
    const kpi = parquetEntry({ id: 'capacity.kpi', queries: [capacity.buildKpiQuery('src_ip', '')] })
    const allNumbers = new Proxy({}, { get: () => 'number' }) as Record<string, FieldType>
    expect(tableProblems([kpi], allNumbers)[0]).toContain('class E on tcp_rtt')
  })

  it('fails a pinned entry on Parquet', () => {
    expect(tableProblems([parquetEntry({ pin: 'presence' })], TREND_TYPES)).toEqual(['tcp.trend: pinned (presence) and routed to Parquet'])
  })

  it('accepts a class-free entry with typed fields and enough evidence', () => {
    expect(tableProblems([parquetEntry()], TREND_TYPES)).toEqual([])
  })

  it('leaves density to the install: D/F on an unmeasured key is not a table problem', () => {
    const talkers = parquetEntry({ id: 'capacity.talkers.src_ip', queries: [capacity.buildTalkersQuery('src_ip', '')] })
    expect(tableProblems([talkers], { src_ip: 'string', total_bytes: 'number' })).toEqual([])
  })

  it('fails a text listed twice', () => {
    expect(tableProblems([parquetEntry({ target: 'json', evidence: null }), parquetEntry({ id: 'x', target: 'json', evidence: null })], TREND_TYPES)).toEqual([
      'x: its text is also listed by tcp.trend',
    ])
  })
})

describe('coverage', () => {
  const MODULES: Record<string, Record<string, unknown>> = {
    capacity, dataFlow, datasets, dns, fieldExplorer, findings, flowMap, lakeLanding, pqc, security, shadowAi, snapshots, tcp, tls, web,
  }
  const listed = new Set(ROUTES.flatMap((e) => e.queries))

  it('lists every query constant in src/queries that reads gigamon_ami', () => {
    const missing: string[] = []
    for (const [mod, exports] of Object.entries(MODULES)) {
      for (const [name, v] of Object.entries(exports)) {
        if (typeof v === 'string' && v.startsWith('dataset="gigamon_ami"') && !listed.has(v)) missing.push(`${mod}.${name}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('covers every module under src/queries that it should, so a new tab module is not skipped', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'queries')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()
    // No gigamon_ami query of their own: Stream ids, the Lake window, the metrics check.
    // parquetAudit.ts does read gigamon_ami, but only scripts/parquet-audit.mjs
    // submits it: parquetAudit.test.ts fails if any app module imports it, so no
    // query of it can reach the router, and listing it here would import it.
    // benchmark.ts holds no string of its own: its set is other modules' strings
    // (each listed under its own entry), and the store benchmark submits every
    // run asWritten, so none reaches the router.
    const NONE = ['benchmark.ts', 'lakeWindow.ts', 'parquetAudit.ts', 'routing.ts', 'stackIds.ts']
    expect(files.filter((f) => !NONE.includes(f)).length).toBe(Object.keys(MODULES).length)
  })

  it('pins the measurements of gigamon_ami itself', () => {
    const measured = new Set(ROUTES.filter((e) => e.pin === 'measurement').flatMap((e) => e.queries))
    for (const q of [lakeLanding.LANDING_LAG_QUERY, datasets.REAL_DATA_PROBE_QUERY, dataFlow.LAKE_HELD_QUERY, lakeLanding.PARTITION_CANDIDATES_QUERY]) {
      expect(measured.has(q), q).toBe(true)
    }
  })

  it('files every parity audit: its own string as a measurement, a shared one under its panel', () => {
    for (const c of PARITY_CHECKS) {
      const owner = ROUTES.find((e) => e.queries.includes(c.query))
      expect(owner, `parity check ${c.id}`).toBeDefined()
      if (owner!.pin !== 'measurement') expect(owner!.pin, `${c.id} shares ${owner!.id}'s text`).toBeNull()
    }
  })

  it('pins Field Explorer to JSON as presence', () => {
    expect(ROUTES.find((e) => e.queries.includes(fieldExplorer.PRESENCE_QUERY))?.pin).toBe('presence')
  })
})

describe('schedules stay on JSON (S1)', () => {
  it('writes every saved-search body exactly as the manifest holds it, on gigamon_ami, never _pq', () => {
    for (const entry of MANIFEST) {
      const body = accelPostBody(entry, 'x').query
      expect(body, entry.id).toBe(entry.body)
      expect(body, entry.id).not.toContain('gigamon_ami_pq')
    }
  })

  it('has no path from acceleration to the router: no accel module imports it', () => {
    // The router sits in cribl/search.ts `executedQuery`, which a saved search
    // body never passes through (accel/provision.ts writes it with capi).
    const accel = join(dirname(fileURLToPath(import.meta.url)), '..', 'accel')
    const importers = readdirSync(accel)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /from '\.\.\/routing\//.test(readFileSync(join(accel, f), 'utf8')))
    expect(importers).toEqual([])
  })
})
