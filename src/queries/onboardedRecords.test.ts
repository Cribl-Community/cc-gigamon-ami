import { describe, expect, it } from 'vitest'
import { DATASET_RECORDS_QUERY as query } from './dataFlow'

describe('Data Flow dataset records', () => {
  it('counts the whole gigamon_ami dataset, with no provenance filter', () => {
    expect(query).toMatch(/^dataset="gigamon_ami" \| extend /)
    expect(query).not.toContain('| where')
    expect(query).not.toContain('gigamon_ingest_')
    expect(query).not.toContain('cribl_metrics')
    expect(query).not.toContain('gigamon_ami_sample')
  })

  it('aggregates once, with explicit numeric casts and two-direction coverage for bytes and packets', () => {
    expect(query.match(/\| summarize/g)).toHaveLength(1)
    expect(query).toContain('events=count()')
    for (const unit of ['bytes', 'packets']) {
      for (const direction of ['src', 'dst']) expect(query).toContain(`flow_${direction}_${unit}=toreal(${direction}_${unit})`)
      const coverage = unit === 'bytes' ? 'byte_records' : 'packet_records'
      const valid = `isnotnull(flow_src_${unit}) and isnotnull(flow_dst_${unit}) and flow_src_${unit}>=0 and flow_dst_${unit}>=0`
      expect(query).toContain(`${coverage}=countif(${valid})`)
      expect(query).toContain(`${unit}=sum(iif(${valid}, flow_src_${unit}+flow_dst_${unit}, 0))`)
    }
    expect(query).not.toContain('coalesce')
  })
})

// This pins KQL/cast/coverage wiring; it is not a Cribl KQL execution.
