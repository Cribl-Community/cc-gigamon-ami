// parity.ts's two Phase 8.1 extensions: reading a WHOLE query (`classifyQuery`,
// grouped and piped, classes F and T), and comparing a grouped panel's rows
// (`compareGrouped`). The scalar check is parity.test.ts.
//
// The queries are the dashboards' own, imported — a classifier that is right
// about a hand-written example and wrong about the string a panel runs has
// checked nothing.

import { describe, expect, it } from 'vitest'
import { buildTalkersQuery } from '../queries/capacityTopTalkers'
import { OVERALL, PER_RESOLVER } from '../queries/dnsHealth'
import { SOURCES } from '../queries/security'
import { APP_L4_SNAPSHOT_QUERY, SERVICE_EDGES_SNAPSHOT_QUERY } from '../queries/snapshots'
import { buildTrendQuery } from '../queries/tcpHealth'
import { SLOW } from '../queries/webApiHealth'
import { classifyQuery, compareGrouped, type ClassHit, type GroupedSpec, type Row } from './parity'

const has = (hits: ClassHit[], cls: string, field: string) => hits.some((h) => h.cls === cls && h.field === field)

describe('classifyQuery — a whole dashboard query', () => {
  it('finds F on a grouped key and D on its presence head (Capacity talkers)', () => {
    const { hits, fields } = classifyQuery(buildTalkersQuery('src_ip', ''))
    expect(has(hits, 'D', 'src_ip')).toBe(true)
    expect(has(hits, 'F', 'src_ip')).toBe(true)
    expect(fields.sort()).toEqual(['src_ip', 'total_bytes'])
  })

  it('reports C on DNS OVERALL and nothing else — C is neutral, not a refusal', () => {
    const { hits } = classifyQuery(OVERALL)
    expect(hits).toEqual([{ cls: 'C', field: 'dns_host' }])
  })

  it('reads C on both dcounts of SOURCES, and F on its src_ip key', () => {
    const { hits } = classifyQuery(SOURCES)
    expect(has(hits, 'C', 'dst_port')).toBe(true)
    expect(has(hits, 'C', 'dst_ip')).toBe(true)
    expect(has(hits, 'F', 'src_ip')).toBe(true)
    expect(hits.some((h) => h.cls === 'F' && h.field === 'flows'), 'a column the query made is not a raw field').toBe(false)
  })

  it('finds E beside D and F in a grouped query (DNS per resolver)', () => {
    const { hits } = classifyQuery(PER_RESOLVER)
    expect(has(hits, 'E', 'dns_response_time')).toBe(true)
    expect(has(hits, 'D', 'dns_host')).toBe(true)
    expect(has(hits, 'F', 'dns_host')).toBe(true)
  })

  it('treats the normalised key iif(isnotnull(x), x, "") as neither A nor F (APP_L4)', () => {
    const { hits, fields } = classifyQuery(APP_L4_SNAPSHOT_QUERY)
    expect(hits, 'app and l4 are made by the query and read "" for an absent value on both datasets').toEqual([])
    expect(fields.sort()).toEqual(['app_name', 'l4_proto', 'total_bytes'])
  })

  it('still sees F on a raw key beside a normalised one (service edges)', () => {
    const { hits } = classifyQuery(SERVICE_EDGES_SNAPSHOT_QUERY)
    expect(has(hits, 'F', 'src_aws_flat_tags_name')).toBe(true)
    expect(has(hits, 'F', 'dst_svc')).toBe(false)
    expect(has(hits, 'A', 'dst_aws_flat_tags_name')).toBe(false)
  })

  it('does not call a time bin a key (TCP trend is class-free)', () => {
    const { hits, fields } = classifyQuery(buildTrendQuery('dupacks'))
    expect(hits).toEqual([])
    expect(fields.sort()).toEqual(['protocol', 'tcp_dup_ack'])
  })

  it('marks T on a field the type table calls mixed, and only there', () => {
    expect(classifyQuery(buildTrendQuery('dupacks'), { tcp_dup_ack: 'mixed' }).hits).toEqual([{ cls: 'T', field: 'tcp_dup_ack' }])
    expect(classifyQuery(buildTrendQuery('dupacks'), { tcp_dup_ack: 'number' }).hits).toEqual([])
  })

  it('finds A inside a where stage and B in a grouped summarize', () => {
    const q = 'dataset="gigamon_ami" | where isnotnull(snmp_community) | summarize n=count(http_code) by app_name'
    const { hits } = classifyQuery(q)
    expect(has(hits, 'A', 'snmp_community')).toBe(true)
    expect(has(hits, 'B', 'http_code')).toBe(true)
    expect(has(hits, 'F', 'app_name')).toBe(true)
  })

  it('reads every field of a two-field presence head (Web SLOW)', () => {
    const { hits } = classifyQuery(SLOW)
    expect(has(hits, 'D', 'http_server_ms')).toBe(true)
    expect(has(hits, 'D', 'http_host')).toBe(true)
    expect(has(hits, 'E', 'http_server_ms')).toBe(true)
  })
})

describe('compareGrouped — a top-N panel, JSON against Parquet', () => {
  const SPEC: GroupedSpec = { keys: ['host'], rank: 'n', n: 3, columns: { n: 'count', p95: 'distribution' } }
  const row = (host: string | null, n: number, p95 = 10): Row => (host === null ? { n, p95 } : { host, n, p95 })

  it('passes the same top N with every figure inside its tolerance', () => {
    const json = [row('a', 100), row('b', 80), row('c', 60), row('d', 5)]
    const pq = [row('a', 100), row('b', 80), row('c', 60, 10.2), row('d', 5)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.verdict).toBe('pass')
    expect(r.compared).toEqual(['"a"', '"b"', '"c"'])
  })

  it('fails a key present on one side only — the "" group Parquet ranks first', () => {
    // Class F: JSON omits the key column for rows that lack it; Parquet keys
    // them "" and, on a sparse field, that group is usually the largest.
    const json = [row('a', 100), row('b', 80), row('c', 60), row(null, 500)]
    const pq = [row('', 500), row('a', 100), row('b', 80), row('c', 60)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.onlyParquet).toEqual(['""'])
    expect(r.onlyJson).toEqual(['(absent)'])
    expect(r.sentence).toContain('on Parquet only')
  })

  it('never calls an absent key and an empty-string key the same key', () => {
    const r = compareGrouped([row(null, 50)], [row('', 50)], { ...SPEC, n: 1 })
    expect(r.verdict).toBe('fail')
  })

  it('drops keys tied at the rank-N boundary on either side, then compares the rest', () => {
    // c and d tie at 60 across the cut on JSON; which one makes the top 3 is
    // not reproducible, so neither is compared — and neither fails the check.
    const json = [row('a', 100), row('b', 80), row('c', 60), row('d', 60)]
    const pq = [row('a', 100), row('b', 80), row('d', 60), row('c', 60)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.tied.sort()).toEqual(['"c"', '"d"'])
    expect(r.verdict).toBe('pass')
    expect(r.compared).toEqual(['"a"', '"b"'])
  })

  it('does not drop a tie that sits wholly inside the top N', () => {
    const json = [row('a', 80), row('b', 80), row('c', 60), row('d', 5)]
    const r = compareGrouped(json, json, SPEC)
    expect(r.tied).toEqual([])
    expect(r.compared).toHaveLength(3)
  })

  it('fails a shared key whose count moved outside ±1 %', () => {
    const json = [row('a', 1000), row('b', 800), row('c', 600)]
    const pq = [row('a', 1000), row('b', 800), row('c', 620)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.differs).toEqual([{ key: '"c"', column: 'n', json: 600, parquet: 620, allowed: 6 }])
  })

  it('fails a latency that went to 0 or to no value — class E per key', () => {
    const json = [row('a', 100, 12), row('b', 80, 9), row('c', 60, 7)]
    const pq = [row('a', 100, 0), row('b', 80, 9), { host: 'c', n: 60 }]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.differs.map((d) => `${d.key}.${d.column}`)).toEqual(['"a".p95', '"c".p95'])
  })

  it('widens counts by the control’s drift, as the scalar check does', () => {
    const json = [row('a', 1000), row('b', 800), row('c', 600)]
    const pq = [row('a', 1000), row('b', 800), row('c', 615)]
    expect(compareGrouped(json, pq, SPEC, 0).verdict).toBe('fail')
    expect(compareGrouped(json, pq, SPEC, 0.03).verdict).toBe('pass')
  })

  it('is not exercised when nothing is left once ties are dropped', () => {
    const json = [row('a', 5), row('b', 5)]
    expect(compareGrouped(json, json, { ...SPEC, n: 1 }).verdict).toBe('unexercised')
  })
})
