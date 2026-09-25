// Whether a query's text may leave JSON: the three inputs, each able to refuse
// on its own. The queries are the dashboards' own.

import { describe, expect, it } from 'vitest'
import { buildKpiQuery, buildTalkersQuery } from '../../queries/capacityTopTalkers'
import { OVERALL } from '../../queries/dnsHealth'
import { FINDINGS_QUERY } from '../../queries/findings'
import { COUNTS } from '../../queries/security'
import { buildTrendQuery } from '../../queries/tcpHealth'
import { FIELD_TYPES } from '../../data/fieldTypes'
import { NO_DENSITY, eligibility, isDense } from './eligibility'

const TREND = buildTrendQuery('dupacks')
const TREND_TYPES = { protocol: 'number', tcp_dup_ack: 'number' } as const

describe('the type table', () => {
  it('is empty in this release, so every query that reads a field refuses', () => {
    // 8.0b fills it from a gettype census; until then "unknown" refuses.
    expect(FIELD_TYPES).toEqual({})
    const e = eligibility(TREND, FIELD_TYPES)
    expect(e.eligible).toBe(false)
    expect(e.refusals).toEqual([{ kind: 'type', words: 'type not measured: protocol, tcp_dup_ack' }])
  })

  it('lets a class-free query through once every field it reads has a type', () => {
    expect(eligibility(TREND, TREND_TYPES).eligible).toBe(true)
  })

  it('refuses on class T, a type that differs between Parquet files', () => {
    const e = eligibility(TREND, { ...TREND_TYPES, tcp_dup_ack: 'mixed' })
    expect(e.eligible).toBe(false)
    expect(e.refusals.map((r) => r.kind)).toEqual(['class'])
    expect(e.refusals[0].words).toContain('class T on tcp_dup_ack')
  })
})

describe('the classes', () => {
  it('treats C as neutral: DNS OVERALL refuses on nothing but its types', () => {
    const types = { app_name: 'string', dns_reply_code: 'string', dns_host: 'string' } as const
    const e = eligibility(OVERALL, types)
    expect(e.eligible).toBe(true)
    expect(e.neutral).toEqual(['C'])
  })

  it('refuses A (Security COUNTS) and B (FINDINGS) whatever the types say', () => {
    const everything = new Proxy({}, { get: () => 'string' }) as Record<string, 'string'>
    expect(eligibility(COUNTS, everything).refusals.some((r) => r.words.startsWith('class A on icmp_tunneling'))).toBe(true)
    expect(eligibility(FINDINGS_QUERY, everything).refusals.some((r) => r.words.startsWith('class B on snmp_community'))).toBe(true)
  })

  it('refuses E (Capacity KPI avg(tcp_rtt))', () => {
    const everything = new Proxy({}, { get: () => 'number' }) as Record<string, 'number'>
    const e = eligibility(buildKpiQuery('src_ip', ''), everything)
    expect(e.refusals.map((r) => r.words)).toEqual([expect.stringContaining('class E on tcp_rtt')])
  })
})

describe('per-install density', () => {
  const TALKERS = buildTalkersQuery('src_ip', '')
  const types = { src_ip: 'string', total_bytes: 'number' } as const

  it('refuses D and F while this install has not measured the key', () => {
    const e = eligibility(TALKERS, types, NO_DENSITY)
    expect(e.refusals.map((r) => r.kind)).toEqual(['density', 'density'])
  })

  it('accepts the same text on an install where the key is on every row', () => {
    expect(eligibility(TALKERS, types, { src_ip: { present: 1000, total: 1000 } }).eligible).toBe(true)
  })

  it('refuses it on an install where the key is 99.3 % present — the "" group would rank', () => {
    const e = eligibility(TALKERS, types, { src_ip: { present: 993, total: 1000 } })
    expect(e.eligible).toBe(false)
    expect(e.refusals[0].words).toBe('class D on src_ip: 993 of 1000 rows carry it')
  })

  it('never calls an empty measurement dense', () => {
    expect(isDense({ present: 0, total: 0 })).toBe(false)
    expect(isDense(undefined)).toBe(false)
  })
})
