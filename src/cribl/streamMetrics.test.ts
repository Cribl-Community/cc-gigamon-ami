import { afterEach, describe, expect, it, vi } from 'vitest'
import { denialSince, denialMark } from './authz'
import { parseStreamMetrics, readStreamMetrics, streamMetricsRequest, streamWindow } from './streamMetrics'

const path = { group: 'default', sourceId: 'in_gigamon_ami_http', pipeline: 'gigamon', destination: 'gigamon_lake' }
const bounds = { earliest: 1_793_894_000_000, latest: 1_793_894_900_000 }
afterEach(() => vi.unstubAllGlobals())

describe('Stream Monitoring aggregate reads', () => {
  it('uses the documented millisecond bounds and native metric names, exact objects and worker scope', () => {
    expect(streamMetricsRequest(path, 'source', bounds)).toEqual({
      where: 'input == "http_raw:in_gigamon_ami_http" && __worker_group == "default" && __dist_mode == "worker"',
      aggs: { aggregations: ['sum("total.in_events").as("events")', 'sum("total.in_bytes").as("bytes")'], splitBys: ['input'], cumulative: true },
      ...bounds,
    })
    expect(streamMetricsRequest(path, 'pipeline', bounds)).toEqual({
      where: 'id == "gigamon" && __worker_group == "default" && __dist_mode == "worker"',
      aggs: { aggregations: ['sum("pipe.out_events").as("events")'], splitBys: ['id'], cumulative: true },
      ...bounds,
    })
    expect(streamMetricsRequest(path, 'destination', bounds)).toEqual({
      where: 'output == "cribl_lake:gigamon_lake" && __worker_group == "default" && __dist_mode == "worker"',
      aggs: { aggregations: ['sum("total.out_events").as("events")', 'sum("total.out_bytes").as("bytes")'], splitBys: ['output'], cumulative: true },
      ...bounds,
    })
  })

  it('quotes every runtime identifier as an expression string, not source code', () => {
    const request = streamMetricsRequest({ ...path, sourceId: 'a" || true', group: 'b"c' }, 'source', bounds)
    expect(request.where).toContain(`input == ${JSON.stringify('http_raw:a" || true')}`)
    expect(request.where).toContain(`__worker_group == ${JSON.stringify('b"c')}`)
  })

  it('parses the observed native response envelope without an items wrapper', () => {
    expect(parseStreamMetrics({
      results: [{ events: 36956, bytes: 52591200, input: 'http_raw:in_gigamon_ami_http' }],
      metrics: { ignored: true }, info: {},
    }, path, 'source')).toEqual({ events: 36956, bytes: 52591200 })
    expect(parseStreamMetrics({ results: [{ events: 36956, output: 'cribl_lake:gigamon_lake' }] }, path, 'destination'))
      .toEqual({ events: 36956, bytes: null })
  })

  it('distinguishes observed zero from absent, invalid and unrelated series', () => {
    expect(parseStreamMetrics({ results: [{ id: 'gigamon', events: 0 }] }, path, 'pipeline')).toEqual({ events: 0, bytes: null })
    for (const results of [[], [{ id: 'other', events: 50 }], [{ id: 'gigamon' }]]) {
      expect(parseStreamMetrics({ results }, path, 'pipeline').events).toBeNull()
    }
    for (const events of [null, '0', -1, Infinity, NaN]) {
      expect(parseStreamMetrics({ results: [{ id: 'gigamon', events }] }, path, 'pipeline').events).toBeNull()
    }
    expect(() => parseStreamMetrics({ items: [] }, path, 'source')).toThrow('invalid response')
    expect(() => parseStreamMetrics({ results: [{ id: 'gigamon', events: 1 }, { id: 'gigamon', events: 2 }] }, path, 'pipeline')).toThrow('duplicate')
  })

  it('never silently clamps a longer or malformed range to the verified short window', () => {
    expect(streamWindow('-15m', bounds.latest)).toEqual(bounds)
    expect(streamWindow('-5m', bounds.latest)).toEqual({ earliest: bounds.latest - 300000, latest: bounds.latest })
    expect(streamWindow('-1h', bounds.latest)).toEqual({ earliest: bounds.latest - 3600000, latest: bounds.latest })
    expect(streamWindow('-30m', bounds.latest)).toEqual({ earliest: bounds.latest - 1800000, latest: bounds.latest })
    for (const range of ['-4h', '-24h', 'now', '-0m']) expect(streamWindow(range, bounds.latest)).toBeNull()
  })

  it('uses capi with abort and marks denied reads as background, never as an unrelated control refusal', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 403, text: async () => '{"message":"denied"}' })
    vi.stubGlobal('fetch', fetch)
    const mark = denialMark()
    const controller = new AbortController()
    const request = streamMetricsRequest(path, 'source', bounds)
    await expect(readStreamMetrics(path, 'source', request, controller.signal)).rejects.toThrow('HTTP 403')
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/system\/metrics\/query$/), expect.objectContaining({
      method: 'POST', signal: controller.signal, body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' },
    }))
    expect(denialSince(mark)).toBeNull()
  })
})
