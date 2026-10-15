import { describe, expect, it } from 'vitest'
import { buildDrillQuery, buildHeatQuery, buildTrendQuery, METRICS, SUBNET24_HEAD, SUBNET16_HEAD } from './tcpHealth'
import { TCP_SUBNET24_SNAPSHOT_QUERY, TCP_SUBNET16_SNAPSHOT_QUERY } from './snapshots'

describe('TCP Health trends', () => {
  it('sums reset flags over time without changing the other trends or reset heatmaps', () => {
    expect(buildTrendQuery('resets')).toBe(
      'dataset="gigamon_ami" protocol=6 | summarize v=sum(tcp_flag_reset), flows=count() by bin(_time, 1m) | sort by _time asc',
    )
    for (const metric of METRICS.filter((m) => m.key !== 'resets')) {
      expect(buildTrendQuery(metric.key)).toBe(
        `dataset="gigamon_ami" protocol=6 | summarize v=sum(${metric.field}), flows=count() by bin(_time, 1m) | sort by _time asc`,
      )
    }
    for (const mask of ['24', '16'] as const) {
      expect(buildHeatQuery('resets', mask)).toContain('v=sum(tcp_reset)')
    }
  })
})

describe('TCP Health subnet derivation', () => {
  it('derives /24 labels from endpoint addresses for all four metrics and the snapshot', () => {
    expect(SUBNET24_HEAD).toMatch(/^protocol=6 src_ip=\* dst_ip=\*/)
    for (const side of ['src', 'dst']) {
      expect(SUBNET24_HEAD).toContain(
        `| extend ${side}_subnet = strcat(extract(@"^([0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3})[.][0-9]{1,3}$", 1, ${side}_ip), ".0/24")`,
      )
    }
    expect(SUBNET24_HEAD).toContain('where src_subnet != ".0/24" and dst_subnet != ".0/24"')
    for (const metric of METRICS) {
      expect(buildHeatQuery(metric.key, '24')).toBe(
        `dataset="gigamon_ami" ${SUBNET24_HEAD} | summarize v=sum(${metric.field}), flows=count() by src_subnet, dst_subnet | sort by flows desc | limit 120`,
      )
    }
    expect(TCP_SUBNET24_SNAPSHOT_QUERY).toContain(`dataset="gigamon_ami" ${SUBNET24_HEAD} | summarize`)
  })

  it('uses the derived labels when drilling into a /24 cell', () => {
    expect(buildDrillQuery({ row: '10.20.1.0/24', col: '10.20.2.0/24' }, '24')).toContain(
      `${SUBNET24_HEAD} | where src_subnet=="10.20.1.0/24" and dst_subnet=="10.20.2.0/24" | summarize`,
    )
    expect(buildDrillQuery(null, '24')).toBe('')
  })

  it('derives /16 labels for every metric, the snapshot and cell drill-downs', () => {
    expect(SUBNET16_HEAD).toMatch(/^protocol=6 src_ip=\* dst_ip=\*/)
    for (const side of ['src', 'dst']) {
      expect(SUBNET16_HEAD).toContain(
        `| extend ${side}_subnet16 = strcat(extract(@"^([0-9]{1,3}[.][0-9]{1,3})[.][0-9]{1,3}[.][0-9]{1,3}$", 1, ${side}_ip), ".0.0/16")`,
      )
    }
    expect(SUBNET16_HEAD).toContain('where src_subnet16 != ".0.0/16" and dst_subnet16 != ".0.0/16"')
    for (const metric of METRICS) {
      expect(buildHeatQuery(metric.key, '16')).toBe(
        `dataset="gigamon_ami" ${SUBNET16_HEAD} | summarize v=sum(${metric.field}), flows=count() by src_subnet16, dst_subnet16 | sort by flows desc | limit 120`,
      )
    }
    expect(TCP_SUBNET16_SNAPSHOT_QUERY).toContain(`${SUBNET16_HEAD} | summarize`)
    expect(buildDrillQuery({ row: '10.20.0.0/16', col: '10.21.0.0/16' }, '16')).toContain(
      `${SUBNET16_HEAD} | where src_subnet16=="10.20.0.0/16" and dst_subnet16=="10.21.0.0/16" | summarize`,
    )
    expect(buildDrillQuery(null, '16')).toBe('')
  })
})
