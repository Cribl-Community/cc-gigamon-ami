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
import { PARITY_CHECKS, classify, classifyQuery, compareGrouped, summarizeColumns, type ClassHit, type GroupedSpec, type Row } from './parity'
import { eligibility } from './routing/eligibility'
import { ROUTES } from './routing/table'
import { FIELD_TYPES } from '../data/fieldTypes'

const has = (hits: ClassHit[], cls: string, field: string) => hits.some((h) => h.cls === cls && h.field === field)

describe('classifyQuery — a whole dashboard query', () => {
  it('finds F on a grouped key and A on its presence head (Capacity talkers)', () => {
    const { hits, fields } = classifyQuery(buildTalkersQuery('src_ip', ''))
    expect(has(hits, 'A', 'src_ip')).toBe(true)
    expect(hits.some((h) => h.cls === 'D'), 'a presence term is A since 2026-09-27, not D').toBe(false)
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

  it('finds E beside A and F in a grouped query (DNS per resolver)', () => {
    const { hits } = classifyQuery(PER_RESOLVER)
    expect(has(hits, 'E', 'dns_response_time')).toBe(true)
    expect(has(hits, 'A', 'dns_host')).toBe(true)
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
    expect(has(hits, 'A', 'http_server_ms')).toBe(true)
    expect(has(hits, 'A', 'http_host')).toBe(true)
    expect(has(hits, 'E', 'http_server_ms')).toBe(true)
  })
})

// The first real parity run (2026-09-27, parity.ts THE FIRST PARITY RUN): every
// text that failed opens with a presence term `f=*`, which on Parquet matched
// every row; neither text that passed has one. The term is class A.
describe('classifyQuery — a presence term in the search head', () => {
  const Q = (head: string, tail = '| summarize n=count()') => `dataset="gigamon_ami" ${head} ${tail}`

  it.each([
    ['web.trend', 'http_code'],
    ['web.codes', 'http_code'],
    ['web.hosts', 'http_host'],
    ['web.h2', 'http2_host'],
    ['pqc.groups', 'ssl_ext_ec_supported_groups_type'],
    ['flowMap.serviceEdges', 'src_aws_flat_tags_name'],
  ])('reads %s as class A on %s, and the table refuses it whatever the types', (id, field) => {
    for (const q of ROUTES.find((e) => e.id === id)!.queries) {
      expect(has(classifyQuery(q).hits, 'A', field), q).toBe(true)
      const e = eligibility(q, FIELD_TYPES, { [field]: { present: 1, total: 1 } })
      expect(e.eligible, q).toBe(false)
      expect(e.refusals.some((r) => r.kind === 'class' && r.words.startsWith(`class A on ${field}`)), q).toBe(true)
    }
  })

  it('reads both terms of flowMap.edges, on both of its texts', () => {
    const [pairs, sources] = ROUTES.find((e) => e.id === 'flowMap.edges')!.queries
    expect(has(classifyQuery(pairs).hits, 'A', 'src_aws_flat_tags_name')).toBe(true)
    expect(has(classifyQuery(pairs).hits, 'A', 'dst_aws_flat_tags_name')).toBe(true)
    expect(has(classifyQuery(sources).hits, 'A', 'src_aws_flat_tags_name')).toBe(true)
  })

  it('finds no presence term in either text that passed (dns.overall, tls.pqcByServer)', () => {
    for (const id of ['dns.overall', 'tls.pqcByServer']) {
      for (const q of ROUTES.find((e) => e.id === id)!.queries) expect(classifyQuery(q).hits.filter((h) => h.cls === 'A'), q).toEqual([])
    }
  })

  it('reads the absence test f!=* as class A too: on Parquet it matches no row', () => {
    expect(classifyQuery(Q('http_code!=*')).hits).toEqual([{ cls: 'A', field: 'http_code' }])
    expect(classifyQuery(Q('app_name="dns" http_host != *')).hits).toEqual([{ cls: 'A', field: 'http_host' }])
  })

  it('reads a term inside parentheses or beside another term', () => {
    expect(classifyQuery(Q('(http_code=* or http2_code=*)')).hits).toEqual([
      { cls: 'A', field: 'http_code' },
      { cls: 'A', field: 'http2_code' },
    ])
  })

  it.each([
    ['a double-quoted star', 'http_host="*"'],
    ['a single-quoted star', "http_host='*'"],
    ['a quoted run of stars, negated', 'http_host != "**"'],
  ])('reads %s as the same presence term as a bare one', (_, head) => {
    expect(classifyQuery(Q(head)).hits).toEqual([{ cls: 'A', field: 'http_host' }])
    expect(classifyQuery(Q(head)).fields).toEqual(['http_host'])
  })

  it.each([
    ['a quoted wildcard value', 'http_host="*.example.com"'],
    // Each of these would be a term if the quotes were not blanked first: the
    // spelled term is followed by a space or a parenthesis, which the term's
    // own lookahead accepts.
    ['a quoted value that spells a term', 'app_name="x http_code=* y"'],
    ['a quoted value that spells a term in parentheses', 'app_name="(http_code=*)"'],
    ['a single-quoted value that spells a term', "app_name='x http_code=* y'"],
    ['a quoted star inside another quoted value', `app_name='x http_code="*" y'`],
    ['the dataset selector, quoted', 'dataset="*"'],
    ['a wildcard value', 'http_host=*.example.com'],
    ['a comparison', 'http_code==*'],
    ['the dataset selector, anywhere', 'dataset=*'],
  ])('does not read %s as a presence term', (_, head) => {
    expect(classifyQuery(Q(head)).hits.filter((h) => h.cls === 'A'), head).toEqual([])
  })

  it('reads a key after the first pipe as a key, not a term', () => {
    expect(classifyQuery('dataset="gigamon_ami" | summarize n=count() by http_code').hits).toEqual([{ cls: 'F', field: 'http_code' }])
  })

  it('reads a presence term in a | search stage as class A, as in the head', () => {
    expect(classifyQuery('dataset="gigamon_ami" | search http_code=* | summarize n=count()').hits).toEqual([{ cls: 'A', field: 'http_code' }])
    expect(
      classifyQuery('dataset="gigamon_ami" app_name="http" | search http_host!="*" | summarize total=count() by bin(_time,1m)').hits,
    ).toEqual([{ cls: 'A', field: 'http_host' }])
    // …and a quoted value there is still a value.
    expect(classifyQuery('dataset="gigamon_ami" | search app_name="x http_code=* y" | summarize n=count()').hits).toEqual([])
  })

  it('refuses a | search presence term in the table check, whatever the types', () => {
    const q = 'dataset="gigamon_ami" | search http_code=* | summarize total=count() by bin(_time,1m)'
    const e = eligibility(q, FIELD_TYPES, { http_code: { present: 1, total: 1 } })
    expect(e.eligible).toBe(false)
    expect(e.refusals.some((r) => r.kind === 'class' && r.words.startsWith('class A on http_code'))).toBe(true)
  })

  it('still reads the field behind a term, so the type table sees it', () => {
    expect(classifyQuery(Q('http2_host!=*')).fields).toEqual(['http2_host'])
  })
})

// Shapes no dashboard query has TODAY, each of which once read as class-free —
// so, once the type table was filled, as eligible for Parquet. The classifier's
// promise is that every mistake it makes is towards "not eligible"; each of
// these was a mistake the other way (review of feat/phase8-1-router).
describe('classifyQuery — a class hidden inside an expression', () => {
  const Q = (tail: string) => `dataset="gigamon_ami" ${tail}`
  const NUM = { tcp_rtt: 'number', protocol: 'number', http_code: 'number' } as const

  it.each([
    ['round(avg(tcp_rtt), 1)', '| summarize rtt=round(avg(tcp_rtt), 1)'],
    ['toint(percentile(tcp_rtt, 95))', '| summarize p=toint(percentile(tcp_rtt, 95))'],
    ['percentiles(tcp_rtt, 50, 95)', '| summarize percentiles(tcp_rtt, 50, 95)'],
    ['avgif(tcp_rtt, protocol == 6)', '| summarize a=avgif(tcp_rtt, protocol == 6)'],
    ['minif(tcp_rtt, ...) under a where', '| where protocol == 6 | summarize lo=minif(tcp_rtt, protocol == 6) by bin(_time, 1m)'],
    ['avg of an extend-made column', '| extend r=tcp_rtt * 1000 | summarize a=avg(r)'],
    ['an aggregate over an aggregate', '| summarize m=max(tcp_rtt) by bin(_time, 1m) | summarize a=avg(m)'],
  ])('finds E in %s, and the router refuses it on type-complete input', (_, tail) => {
    const q = Q(tail)
    expect(has(classifyQuery(q).hits, 'E', 'tcp_rtt'), q).toBe(true)
    expect(eligibility(q, NUM).eligible, q).toBe(false)
  })

  it('finds B inside a wrapped count(field)', () => {
    expect(has(classifyQuery(Q('| summarize n=tolong(count(http_code))')).hits, 'B', 'http_code')).toBe(true)
  })

  it('finds A on isnull as well as isnotnull, anywhere in an expression', () => {
    expect(has(classifyQuery(Q('| summarize n=countif(isnull(snmp_community))')).hits, 'A', 'snmp_community')).toBe(true)
  })

  it.each([
    ['a key made by extend', '| extend a=tolower(app_name) | summarize n=count() by a'],
    ['a key that is an expression', '| summarize n=count() by tolower(app_name)'],
    ['a named key expression', '| summarize n=count() by a=strcat(app_name, "/x")'],
    ['a key made by extend from a made column', '| extend b=app_name | extend a=tolower(b) | summarize n=count() by a'],
    ['a distinct stage', '| distinct app_name'],
  ])('finds F on the raw field under %s, and refuses it while density is unmeasured', (_, tail) => {
    const q = Q(tail)
    expect(has(classifyQuery(q).hits, 'F', 'app_name'), q).toBe(true)
    const e = eligibility(q, { app_name: 'string' })
    expect(e.eligible, q).toBe(false)
    expect(e.refusals.some((r) => r.kind === 'density' && r.words.includes('app_name')), q).toBe(true)
  })

  it('still exempts the normalised key, whether made by extend or named in the by clause', () => {
    for (const tail of [
      '| extend a=iif(isnotnull(app_name), app_name, "") | summarize n=count() by a',
      '| summarize n=count() by a=iif(isnotnull(app_name), app_name, "")',
      '| extend a=iif(isnotnull(app_name), app_name, "") | summarize n=count() by tolower(a)',
    ]) {
      expect(classifyQuery(Q(tail)).hits, tail).toEqual([])
    }
  })

  it('never reads fewer classes than classify does, on any parity column', () => {
    for (const check of PARITY_CHECKS) {
      const { head, columns } = summarizeColumns(check.query)
      for (const { expr } of columns) {
        const want = classify(expr, head).filter((c) => c !== 'D')
        const got = new Set(classifyQuery(`dataset="gigamon_ami" | summarize x=${expr}`).hits.map((h) => h.cls))
        for (const c of want) expect(got.has(c), `${check.id}: ${expr} is ${c}`).toBe(true)
      }
    }
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

  it('excuses a two-sided tie only its place in the top N, and still compares its figures', () => {
    // c and d tie at 60 across the cut on both sides; which one makes the top 3
    // is not reproducible, so being in one side's top 3 and not the other's is
    // not a failure. But both keys exist on both sides, so their figures are
    // compared.
    const json = [row('a', 100), row('b', 80), row('c', 60), row('d', 60)]
    const pq = [row('a', 100), row('b', 80), row('d', 60), row('c', 60)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.tied.sort()).toEqual(['"c"', '"d"'])
    expect(r.verdict).toBe('pass')
    expect([...r.compared].sort()).toEqual(['"a"', '"b"', '"c"', '"d"'])
    expect(r.onlyJson).toEqual([])
    expect(r.onlyParquet).toEqual([])
  })

  it('fails a key tied on ONE side whose figure moved a long way on the other', () => {
    // JSON ties c and d at the cut; Parquet ranks c at 90, inside its top 3 with
    // no tie at all. The tie is JSON's, and it excuses nothing about c's 60 -> 90.
    const json = [row('a', 100), row('b', 80), row('c', 60), row('d', 60)]
    const pq = [row('a', 100), row('c', 90), row('b', 80), row('d', 5)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.differs.map((d) => `${d.key}.${d.column}`)).toContain('"c".n')
  })

  it('fails the same case whichever of the tied keys JSON happened to rank first', () => {
    const json = [row('a', 100), row('b', 80), row('d', 60), row('c', 60)]
    const pq = [row('a', 100), row('c', 90), row('b', 80), row('d', 5)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.differs.map((d) => `${d.key}.${d.column}`).sort()).toEqual(['"c".n', '"d".n'])
  })

  it('fails a "" key tied at the cut on Parquet only: a tie cannot excuse a key JSON never had', () => {
    // Class F behind a tie: Parquet's "" group ties c at its cut. JSON has no
    // "" group at all, and c moved 70 -> 60.
    const json = [row('a', 100), row('b', 80), row('c', 70), row('d', 5)]
    const pq = [row('a', 100), row('b', 80), row('', 60), row('c', 60)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.onlyParquet).toEqual(['""'])
    expect(r.differs.map((d) => `${d.key}.${d.column}`)).toContain('"c".n')
  })

  it('passes a one-sided tie whose keys agree on both sides', () => {
    // JSON ties c and d at 60; Parquet has c 60, d 59.6. Whether JSON shows c
    // or d is arbitrary, and each figure agrees within tolerance.
    const json = [row('a', 100), row('b', 80), row('d', 60), row('c', 60)]
    const pq = [row('a', 100), row('b', 80), row('c', 60), row('d', 59.6)]
    const r = compareGrouped(json, pq, SPEC)
    expect(r.verdict).toBe('pass')
    expect(r.tied.sort()).toEqual(['"c"', '"d"'])
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

describe('compareGrouped — the distinct-count slack (owner decision 2026-09-25)', () => {
  // `users` is a dcount, `n` a count(): both small, so the ordinary ±1 % allows
  // less than one of either.
  const SPEC: GroupedSpec = { keys: ['app'], rank: 'n', n: 3, columns: { n: 'count', users: 'count' }, distinct: ['users'] }
  const row = (app: string, n: number, users: number): Row => ({ app, n, users })
  const base = [row('a', 50, 12), row('b', 40, 9), row('c', 30, 7), row('d', 2, 1)]
  const withUsers = (key: string, users: number) => base.map((r) => (r.app === key ? { ...r, users } : r))

  it('passes a distinct count one higher or one lower on Parquet', () => {
    expect(compareGrouped(base, withUsers('a', 13), SPEC).verdict).toBe('pass')
    expect(compareGrouped(base, withUsers('a', 11), SPEC).verdict).toBe('pass')
    expect(compareGrouped(withUsers('a', 13), base, SPEC).verdict).toBe('pass')
  })

  it('fails a distinct count two apart, and says it was allowed 1', () => {
    const r = compareGrouped(base, withUsers('a', 14), SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.differs).toEqual([{ key: '"a"', column: 'users', json: 12, parquet: 14, allowed: 1 }])
    expect(compareGrouped(base, withUsers('b', 7), SPEC).verdict).toBe('fail')
  })

  it('gives the slack only to the distinct-count columns: a count() one off on a small count still fails', () => {
    const pq = base.map((r) => (r.app === 'c' ? { ...r, n: 31 } : r))
    const r = compareGrouped(base, pq, SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.differs).toEqual([{ key: '"c"', column: 'n', json: 30, parquet: 31, allowed: 0.3 }])
    // The same column named as a distinct count would have been allowed it.
    expect(compareGrouped(base, pq, { ...SPEC, distinct: ['users', 'n'] }).verdict).toBe('pass')
    // With no `distinct` list at all, a dcount column keeps the ordinary rule.
    expect(compareGrouped(base, withUsers('a', 13), { ...SPEC, distinct: undefined }).verdict).toBe('fail')
  })

  it('never makes a distinct count tighter than the ordinary rule: 1,000 allows 10', () => {
    const big = [row('a', 50, 1000), row('b', 40, 9), row('c', 30, 7)]
    expect(compareGrouped(big, [row('a', 50, 1010), row('b', 40, 9), row('c', 30, 7)], SPEC).verdict).toBe('pass')
    expect(compareGrouped(big, [row('a', 50, 1011), row('b', 40, 9), row('c', 30, 7)], SPEC).verdict).toBe('fail')
  })

  it('reads an absent count as 0, as compareColumn does: a dcount of 1 against no value agrees, 2 does not', () => {
    // Whether Cribl ever omits a count column on a row it answers is unmeasured;
    // if it does, the grouped path must say what the single-row path says.
    const one = [row('a', 50, 12), row('b', 40, 9), row('c', 30, 1)]
    const two = [row('a', 50, 12), row('b', 40, 9), row('c', 30, 2)]
    const noUsers = [row('a', 50, 12), row('b', 40, 9), { app: 'c', n: 30 }]
    expect(compareGrouped(one, noUsers, SPEC).verdict).toBe('pass')
    expect(compareGrouped(noUsers, one, SPEC).verdict).toBe('pass')
    const r = compareGrouped(two, noUsers, SPEC)
    expect(r.verdict).toBe('fail')
    expect(r.differs).toEqual([{ key: '"c"', column: 'users', json: 2, parquet: null, allowed: 1 }])
    // A column that is not a distinct count keeps the ordinary rule against no value.
    expect(compareGrouped(one, noUsers, { ...SPEC, distinct: undefined }).verdict).toBe('fail')
  })

  it('does not excuse a key’s place in a top N ranked by a distinct count that moved by one', () => {
    // Ranked by `users`: JSON's top 2 is a, b; on Parquet b reads one lower and c
    // one higher, so c takes b's place. Each figure is within its slack; the
    // ranking is not, and rule 2 fails it.
    const RANKED: GroupedSpec = { keys: ['app'], rank: 'users', n: 2, columns: { users: 'count' }, distinct: ['users'] }
    const json = [row('a', 1, 20), row('b', 1, 10), row('c', 1, 9)]
    const pq = [row('a', 1, 20), row('b', 1, 9), row('c', 1, 10)]
    const r = compareGrouped(json, pq, RANKED)
    expect(r.differs).toEqual([])
    expect(r.onlyJson).toEqual(['"b"'])
    expect(r.onlyParquet).toEqual(['"c"'])
    expect(r.verdict).toBe('fail')
  })
})
