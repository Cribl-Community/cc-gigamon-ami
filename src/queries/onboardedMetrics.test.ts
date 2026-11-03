import { describe, expect, it } from 'vitest'
import { onboardedMetricsQueryFor } from './dataFlow'

type MetricRow = Record<string, string | number | null>
const path = { group: 'default', sourceId: 'in_gigamon_ami_http', pipeline: 'gigamon', destination: 'gigamon_lake' }
const query = onboardedMetricsQueryFor(path)
const dimensions = ['_metric', 'input', 'output', 'id']

function sum(rows: MetricRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const match of query.matchAll(/(\w+)=sum\(iif\((.*?), _value, 0\)\)/g)) {
    const js = match[2].replace(new RegExp(`\\b(${dimensions.join('|')})(?===)`, 'g'), 'r.$1').replace(/ and /g, ' && ')
    const predicate = new Function('r', `return ${js}`) as (r: MetricRow) => boolean
    out[match[1]] = rows.reduce((total, r) => total + (r.group === path.group && predicate(r) ? Number(r._value) : 0), 0)
  }
  return out
}

const source = { group: 'default', input: 'http_raw:in_gigamon_ami_http', _metric: 'cribl.logstream.total.in_events', _value: 100 }
const pipeline = {
  group: 'default', id: 'gigamon', _metric: 'cribl.logstream.pipe.out_events', _value: 90,
}
const destination = { group: 'default', output: 'cribl_lake:gigamon_lake', _metric: 'cribl.logstream.total.out_events', _value: 80 }

describe('onboarded named-object metrics', () => {
  it('counts each object independently, including shared traffic but excluding other groups and objects', () => {
    const rows = [
      source, pipeline, destination, { ...destination, _metric: 'cribl.logstream.total.out_bytes', _value: 800 },
      { ...source, input: 'datagen:in_gigamon_datagen', _value: 9000 },
      { ...source, input: 'http_raw:gigamonraw', _value: 9000 },
      { ...pipeline, from_input: 'http_raw:gigamonraw', _value: 10 },
      { ...pipeline, id: 'another_pipeline', _value: 9000 },
      { ...destination, from_input: 'datagen:in_gigamon_datagen', _value: 20 },
      { ...destination, output: 'cribl_lake:cc-network-gigamon-ami.gigamon_ami_json_lake', _value: 9000 },
      ...[source, pipeline, destination].map((r) => ({ ...r, group: 'other', _value: 9000 })),
    ]
    expect(sum(rows)).toEqual({ src_events: 100, pipe_events: 100, dst_events: 100, dst_bytes: 800 })
  })

  it('preserves sample counts so missing telemetry cannot masquerade as zero', () => {
    expect(query).toContain('dataset="default_metrics" | where group=="default"')
    expect(query).toContain('src_samples=countif(_metric=="cribl.logstream.total.in_events"')
    expect(query).toContain('pipe_samples=countif(_metric=="cribl.logstream.pipe.out_events"')
    expect(query).toContain('dst_samples=countif(_metric=="cribl.logstream.total.out_events"')
    expect(query).toContain('dst_byte_samples=countif(_metric=="cribl.logstream.total.out_bytes"')
    expect(query).not.toContain('namespace')
    expect(query).not.toContain('from_input')
  })

  it('quotes runtime identifiers as KQL string literals', () => {
    const q = onboardedMetricsQueryFor({ ...path, sourceId: 'a" or true or input=="b' })
    expect(q).toContain(`input==${JSON.stringify('http_raw:a" or true or input=="b')}`)
    expect(q).not.toContain('input=="http_raw:a" or true')
    expect(onboardedMetricsQueryFor({ ...path, group: 'a"b' })).toContain(`group==${JSON.stringify('a"b')}`)
  })
})
