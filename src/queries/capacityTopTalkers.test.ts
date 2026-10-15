import { describe, expect, it } from 'vitest'
import { buildAppmixQuery, buildKpiQuery, buildL4Query, buildTalkersQuery, PIVOTS } from './capacityTopTalkers'
import { PARITY_CAPACITY_KPI_QUERY } from './lakeLanding'
import { APP_L4_SNAPSHOT_QUERY, OVERVIEW_SNAPSHOT_QUERY } from './snapshots'
import { accelEntry } from '../cribl/accel/manifest'
import { evaluateTail } from '../cribl/accel/tail'

describe('Capacity KPI byte totals', () => {
  const computation = 'coalesce(src_bytes, 0) + coalesce(dst_bytes, 0)'
  const aggregates = 'total=sum(total_bytes), tin=sum(dst_bytes), tout=sum(src_bytes), pkts=sum(total_packets), rtt=avg(tcp_rtt), retrans=sum(tcp_dup_ack)'

  it('runs the requested query for every unfiltered pivot', () => {
    for (const pivot of PIVOTS) {
      expect(buildKpiQuery(pivot.key, '')).toBe(
        `dataset="gigamon_ami" | extend total_bytes = ${computation} | summarize ${aggregates}`,
      )
    }
  })

  describe('App Protocol Mix and Traffic by L4 Protocol byte totals', () => {
    const computation = 'coalesce(src_bytes, 0) + coalesce(dst_bytes, 0)'

    it('calculates bytes before grouping, preserving filters, sorting and limits', () => {
      for (const pivot of PIVOTS) {
        for (const applied of ['', 'example']) {
          const scope = applied ? `${pivot.field}="*example*" ` : ''
          const head = `dataset="gigamon_ami" ${scope}| extend total_bytes = ${computation} | summarize bytes=sum(total_bytes)`
          expect(buildAppmixQuery(pivot.key, applied)).toBe(
            `${head} by app_name | sort by bytes desc | limit 8`,
          )
          expect(buildL4Query(pivot.key, applied)).toBe(
            `dataset="gigamon_ami" ${scope}| extend l4_protocol = case(protocol == 6, "TCP", protocol == 17, "UDP", protocol == 1, "ICMP", protocol == 58, "ICMPv6", protocol == 132, "SCTP", "Other") | extend total_bytes = ${computation} | summarize bytes=sum(total_bytes) by l4_protocol | sort by bytes desc`,
          )
        }
      }
    })

    it('shares the calculated byte total across App Top Talkers, mix and L4', () => {
      expect(APP_L4_SNAPSHOT_QUERY).toContain(`| extend total_bytes = ${computation}`)
      expect(APP_L4_SNAPSHOT_QUERY).toContain('bytes=sum(total_bytes) by app, l4')
      const entry = accelEntry('gno_app_l4_c1h')
      expect(entry.body).toBe(APP_L4_SNAPSHOT_QUERY)
      expect(entry.panels.find((p) => p.queryId === 'capacity-talkers-app')?.tail).toContain('bytes=sum(bytes)')
      for (const id of ['capacity-app-mix', 'capacity-l4']) {
        expect(entry.panels.find((p) => p.queryId === id)?.tail).toContain('bytes=sum(bytes)')
      }
    })

    it('sums the stored calculated bytes for mix, L4 and App Top Talkers', () => {
      const entry = accelEntry('gno_app_l4_c1h')
      const rows = [
        { app: 'https', l4: 'tcp', bytes: 30 },
        { app: 'https', l4: 'udp', bytes: 20 },
        { app: '', l4: 'tcp', bytes: 10 },
      ]
      const read = (id: string) => evaluateTail(entry.panels.find((p) => p.queryId === id)!.tail!, rows, { complete: true })
      expect(read('capacity-app-mix')?.map((r) => [r.app_name, r.bytes])).toEqual([['https', 50], ['', 10]])
      expect(read('capacity-l4')?.map((r) => [r.l4_protocol, r.bytes])).toEqual([['tcp', 40], ['udp', 20]])
      expect(read('capacity-talkers-app')?.map((r) => [r.app_name, r.bytes])).toEqual([['https', 50]])
    })
  })

  describe('Source IP Top Talkers byte totals', () => {
    const query = 'dataset="gigamon_ami" src_ip=* | extend total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0) | summarize bytes=sum(total_bytes) by src_ip | sort by bytes desc | limit 12'

    it('runs the requested query and uses it for the hourly saved search', () => {
      expect(buildTalkersQuery('src_ip', '')).toBe(query)
      const entry = accelEntry('gno_talkers_src_c1h')
      expect(entry.body).toBe(query)
      expect(entry.panels[0].display).toBe(query)
    })

    it('keeps the source filter before calculating bytes', () => {
      expect(buildTalkersQuery('src_ip', '10.20.')).toBe(
        query.replace('src_ip=*', 'src_ip="*10.20.*" src_ip=*'),
      )
    })

    it('calculates App Top Talkers bytes while preserving the app grouping and filter', () => {
      const appQuery = 'dataset="gigamon_ami" app_name=* | extend total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0) | summarize bytes=sum(total_bytes) by app_name | sort by bytes desc | limit 12'
      expect(buildTalkersQuery('app_name', '')).toBe(appQuery)
      expect(buildTalkersQuery('app_name', 'https')).toBe(
        appQuery.replace('app_name=*', 'app_name="*https*" app_name=*'),
      )
      expect(accelEntry('gno_app_l4_c1h').panels.find((p) => p.queryId === 'capacity-talkers-app')?.display).toBe(appQuery)
    })

    it('calculates AWS-service bytes while preserving the service grouping and filter', () => {
      const serviceQuery = 'dataset="gigamon_ami" dst_aws_flat_tags_name=* | extend total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0) | summarize bytes=sum(total_bytes) by dst_aws_flat_tags_name | sort by bytes desc | limit 12'
      expect(buildTalkersQuery('dst_aws_flat_tags_name', '')).toBe(serviceQuery)
      expect(buildTalkersQuery('dst_aws_flat_tags_name', 'example')).toBe(
        serviceQuery.replace('dst_aws_flat_tags_name=*', 'dst_aws_flat_tags_name="*example*" dst_aws_flat_tags_name=*'),
      )
    })
  })

  it('keeps each pivot filter before the byte computation', () => {
    for (const pivot of PIVOTS) {
      expect(buildKpiQuery(pivot.key, 'example')).toBe(
        `dataset="gigamon_ami" ${pivot.field}="*example*" | extend total_bytes = ${computation} | summarize ${aggregates}`,
      )
    }
  })

  it('uses the same computation in the scheduled overview without changing Data Flow bytes', () => {
    expect(OVERVIEW_SNAPSHOT_QUERY).toContain(
      `| extend capacity_total_bytes = ${computation} | summarize total=sum(capacity_total_bytes), `,
    )
    expect(OVERVIEW_SNAPSHOT_QUERY).toContain('bytes=sum(total_bytes)')
    expect(OVERVIEW_SNAPSHOT_QUERY).not.toContain('| extend total_bytes')
    expect(accelEntry('gno_overview_c1h').body).toBe(OVERVIEW_SNAPSHOT_QUERY)
  })

  it('keeps the parity measurement identical to the live KPI query', () => {
    expect(PARITY_CAPACITY_KPI_QUERY).toBe(buildKpiQuery('src_ip', ''))
  })
})
