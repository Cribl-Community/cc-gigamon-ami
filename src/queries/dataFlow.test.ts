import { describe, expect, it } from 'vitest'
import { VOLUME_QUERY } from './dataFlow'
import { OVERVIEW_SNAPSHOT_QUERY } from './snapshots'
import { accelEntry } from '../cribl/accel/manifest'

describe('Data Flow directional volume totals', () => {
  it('derives bytes and packets before summing records', () => {
    expect(VOLUME_QUERY).toBe(
      'dataset="gigamon_ami" | extend total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0) | extend total_packets = coalesce(src_packets, 0) + coalesce(dst_packets, 0) | summarize events=count(), bytes=sum(total_bytes), packets=sum(total_packets)',
    )
  })

  it('serves the same calculated totals from the shared overview', () => {
    const entry = accelEntry('gno_overview_c1h')
    expect(entry.body).toBe(OVERVIEW_SNAPSHOT_QUERY)
    expect(entry.body).toContain('capacity_total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0)')
    expect(entry.body).toContain('capacity_total_packets = coalesce(src_packets, 0) + coalesce(dst_packets, 0)')
    expect(entry.body).toContain('events=count(), bytes=sum(capacity_total_bytes), packets=sum(capacity_total_packets)')
    expect(entry.panels.find((p) => p.queryId === 'data-flow-volume')?.display).toBe(VOLUME_QUERY)
  })
})
