// Flow Map's three dependency views (DNS, Web/API, Subnets), as arithmetic.
//
// What is held still here:
//   1. A DEPENDENCY'S FIGURES SUM OVER EVERY PAIR READ, not only the pairs drawn,
//      so a resolver's failure share is not short because some of its clients
//      are off screen.
//   2. THE HEALTH BANDS: error/failure share amber at 1 %, red at 5 % (as on the
//      DNS and Web tabs' tiles); p95 amber over its target, red over 3×.
//   3. THE LIMITS: at most MAX_SOURCES clients, MAX_TARGETS dependencies and
//      MAX_EDGES lines, and the volume left undrawn is reported, not dropped.

import { describe, expect, it } from 'vitest'
import { DNS_DEPS_QUERY, SUBNET_DEPS_QUERY, WEB_DEPS_QUERY } from '../queries/flowMap'
import { buildDepGraph, MAX_EDGES, MAX_SOURCES, MAX_TARGETS, SPECS } from './FlowMapDeps'

const target = (g: ReturnType<typeof buildDepGraph>, id: string) => g.targets.find((n) => n.id === id)!

describe('each view names its own query', () => {
  it('DNS, Web/API and Subnets run the three dependency queries', () => {
    expect(SPECS.dns.query).toBe(DNS_DEPS_QUERY)
    expect(SPECS.web.query).toBe(WEB_DEPS_QUERY)
    expect(SPECS.subnets.query).toBe(SUBNET_DEPS_QUERY)
  })
})

describe('DNS dependency map', () => {
  it('sums a resolver over every client pair and colours it by SERVFAIL + NXDOMAIN share', () => {
    const g = buildDepGraph('dns', [
      { src_ip: '10.0.0.1', dns_host: '10.9.0.53', total: 900, sf: 10, nx: 20, p95: 0.02 },
      { src_ip: '10.0.0.2', dns_host: '10.9.0.53', total: 100, sf: 20, nx: 10, p95: 0.5 },
      { src_ip: '10.0.0.1', dns_host: '10.9.1.53', total: 1000, sf: 0, nx: 5, p95: 0.01 },
    ])
    const busy = target(g, '10.9.0.53')
    expect(busy.w).toBe(1000)
    // 60 failures in 1,000 queries = 6 % → red.
    expect(busy.health).toBe('danger')
    expect(busy.status).toBe('6% failed')
    // 5 in 1,000 = 0.5 % → healthy.
    expect(target(g, '10.9.1.53').health).toBe('success')
  })

  it('colours a pair by the worse of its own failure share and its p95 response time', () => {
    const g = buildDepGraph('dns', [
      // 0 % failed, but p95 150 ms > 100 ms target → amber.
      { src_ip: '10.0.0.1', dns_host: 'r1', total: 100, sf: 0, nx: 0, p95: 0.15 },
      // 0 % failed, p95 400 ms > 300 ms → red.
      { src_ip: '10.0.0.2', dns_host: 'r1', total: 100, sf: 0, nx: 0, p95: 0.4 },
    ])
    const bySrc = Object.fromEntries(g.edges.map((e) => [e.a.id, e.health]))
    expect(bySrc).toEqual({ '10.0.0.1': 'warning', '10.0.0.2': 'danger' })
  })
})

describe('Web/API dependency map', () => {
  it('colours a host by http_code ≥ 400 share, and a pair with no http_rtt on errors alone', () => {
    const g = buildDepGraph('web', [
      { src_ip: '10.0.0.1', http_host: 'api.example.com', n: 98, err: 1, p95: 50 },
      { src_ip: '10.0.0.2', http_host: 'api.example.com', n: 2, err: 1 },
    ])
    const host = target(g, 'api.example.com')
    // 2 in 100 = 2 % → amber.
    expect(host.health).toBe('warning')
    const noRtt = g.edges.find((e) => e.a.id === '10.0.0.2')!
    expect(noRtt.text).toContain('no http_rtt')
    // 50 % errors on that pair alone → red.
    expect(noRtt.health).toBe('danger')
  })
})

describe('Subnet dependency map', () => {
  it('colours a destination /24 by its duplicate-ACK share and its worst pair p95 tcp_rtt', () => {
    const g = buildDepGraph('subnets', [
      { src_subnet: '10.0.0', dst_subnet: '10.1.0', flows: 100, net: 0.01, net_n: 100, dupack_flows: 30, dupack_n: 100 },
      { src_subnet: '10.0.1', dst_subnet: '10.1.1', flows: 100, net: 0.3, net_n: 100, dupack_flows: 0, dupack_n: 100 },
      { src_subnet: '10.0.2', dst_subnet: '10.1.2', flows: 100, net: 0, net_n: 0, dupack_flows: 0, dupack_n: 0 },
    ])
    expect(target(g, '10.1.0').health).toBe('danger') // 30 % dup-ACK
    expect(target(g, '10.1.1').health).toBe('warning') // 300 ms > 200 ms
    expect(target(g, '10.1.2').health).toBe('unknown') // no data at all
  })
})

describe('limits', () => {
  it('draws at most the top clients, dependencies and lines, and reports the volume left undrawn', () => {
    const rows = []
    for (let s = 0; s < MAX_SOURCES + 5; s++) {
      for (let t = 0; t < MAX_TARGETS + 5; t++) rows.push({ src_ip: `10.0.0.${s}`, http_host: `h${t}`, n: 1 + s + t, err: 0 })
    }
    const g = buildDepGraph('web', rows)
    expect(g.sources).toHaveLength(MAX_SOURCES)
    expect(g.targets).toHaveLength(MAX_TARGETS)
    expect(g.edges.length).toBeLessThanOrEqual(MAX_EDGES)
    expect(g.sourceCount).toBe(MAX_SOURCES + 5)
    expect(g.targetCount).toBe(MAX_TARGETS + 5)
    const drawn = g.edges.reduce((t, e) => t + e.w, 0)
    expect(g.hiddenW).toBe(g.totalW - drawn)
    expect(g.hiddenW).toBeGreaterThan(0)
  })

  it('ignores a row with no client, no dependency or no count', () => {
    const g = buildDepGraph('dns', [
      { src_ip: '', dns_host: 'r1', total: 5 },
      { src_ip: '10.0.0.1', dns_host: '', total: 5 },
      { src_ip: '10.0.0.1', dns_host: 'r1', total: 0 },
    ])
    expect(g.pairCount).toBe(0)
    expect(g.edges).toEqual([])
  })
})
