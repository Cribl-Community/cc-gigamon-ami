import { capi } from './capi'

export interface StreamMetricPath {
  group: string
  sourceId: string
  pipeline: string
  destination: string
}

export type StreamStage = 'source' | 'pipeline' | 'destination'
export interface MetricsRequest {
  where: string
  aggs: { aggregations: string[]; splitBys: string[]; cumulative: true }
  earliest: number
  latest: number
}

// Native Monitoring 15-minute and one-hour queries have live evidence. Do not silently
// clamp a longer dashboard range or imply the metrics store retained all of it.
export const STREAM_METRICS_MAX_SECONDS = 3600
export function streamWindow(earliest: string, now: number): { earliest: number; latest: number } | null {
  const match = /^-(\d+)(m|h)$/.exec(earliest)
  const seconds = match ? Number(match[1]) * (match[2] === 'h' ? 3600 : 60) : 0
  return seconds > 0 && seconds <= STREAM_METRICS_MAX_SECONDS && Number.isSafeInteger(now)
    ? { earliest: now - seconds * 1000, latest: now } : null
}

function dimension(path: StreamMetricPath, stage: StreamStage): [string, string] {
  return stage === 'source' ? ['input', `http_raw:${path.sourceId}`]
    : stage === 'pipeline' ? ['id', path.pipeline] : ['output', `cribl_lake:${path.destination}`]
}

export function streamMetricsRequest(path: StreamMetricPath, stage: StreamStage, bounds: { earliest: number; latest: number }): MetricsRequest {
  const [key, value] = dimension(path, stage)
  const metric = stage === 'source' ? 'total.in' : stage === 'pipeline' ? 'pipe.out' : 'total.out'
  return {
    where: `${key} == ${JSON.stringify(value)} && __worker_group == ${JSON.stringify(path.group)} && __dist_mode == "worker"`,
    aggs: {
      aggregations: [
        `sum("${metric}_events").as("events")`,
        ...(stage === 'pipeline' ? [] : [`sum("${metric}_bytes").as("bytes")`]),
      ],
      splitBys: [key], cumulative: true,
    },
    ...bounds,
  }
}

export interface StreamCounter {
  events: number | null
  bytes: number | null
}
const absent = (): StreamCounter => ({ events: null, bytes: null })

/** A missing row/aggregate is not zero. Never sum duplicate cumulative rows. */
export function parseStreamMetrics(body: unknown, path: StreamMetricPath, stage: StreamStage): StreamCounter {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { results?: unknown }).results)) {
    throw new Error('Stream metrics returned an invalid response.')
  }
  const [key, value] = dimension(path, stage)
  const rows = (body as { results: unknown[] }).results.filter((r): r is Record<string, unknown> =>
    !!r && typeof r === 'object' && (r as Record<string, unknown>)[key] === value)
  if (!rows.length) return absent()
  if (rows.length !== 1) throw new Error('Stream metrics returned duplicate cumulative rows.')
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  return { events: number(rows[0].events), bytes: number(rows[0].bytes) }
}

/** POST is an aggregate read, not a configuration write or a Search job. */
export async function readStreamMetrics(path: StreamMetricPath, stage: StreamStage, request: MetricsRequest, signal: AbortSignal) {
  const response = await capi('POST', '/system/metrics/query', request, { signal, background: true })
  if (response.status !== 200) throw new Error(`Could not read ${stage} Stream metrics (HTTP ${response.status}).`)
  return parseStreamMetrics(response.body, path, stage)
}
