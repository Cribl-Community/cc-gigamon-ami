import { useEffect, useState } from 'react'
import { useDashboard } from '../app/DashboardContext'
import { readStreamMetrics, streamMetricsRequest, streamWindow, type MetricsRequest, type StreamCounter, type StreamMetricPath, type StreamStage } from '../cribl/streamMetrics'

export const STREAM_METRICS_DEADLINE_MS = 30_000
const STAGES: StreamStage[] = ['source', 'pipeline', 'destination']
interface Result {
  key: string
  counters: Partial<Record<StreamStage, StreamCounter>>
  requests: Partial<Record<StreamStage, MetricsRequest>>
  errors: string[]
}

export function useStreamMetrics(flow: StreamMetricPath | null) {
  const { range, refreshNonce } = useDashboard()
  const [result, setResult] = useState<Result | null>(null)
  const key = JSON.stringify([flow, range.earliest, refreshNonce])
  const supported = streamWindow(range.earliest, 0) !== null
  useEffect(() => {
    if (!flow || !supported) {
      setResult(null)
      return
    }
    const controller = new AbortController()
    let active = true
    const bounds = streamWindow(range.earliest, Date.now())!
    const requests = Object.fromEntries(STAGES.map((stage) => [stage, streamMetricsRequest(flow, stage, bounds)])) as Record<StreamStage, MetricsRequest>
    const counters: Result['counters'] = {}
    const errors: string[] = []
    const timer = setTimeout(() => {
      if (!active) return
      active = false
      controller.abort()
      setResult({ key, requests, counters: { ...counters }, errors: [...errors, 'Stream metrics request timed out. Refresh to try again.'] })
    }, STREAM_METRICS_DEADLINE_MS)
    void Promise.all(STAGES.map(async (stage) => {
      try {
        counters[stage] = await readStreamMetrics(flow, stage, requests[stage], controller.signal)
      } catch {
        errors.push(`Could not read ${stage} Stream metrics. Re-check access and refresh.`)
      }
    })).then(() => {
      if (!active) return
      clearTimeout(timer)
      setResult({ key, requests, counters, errors })
    })
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [key, supported, flow, range.earliest])
  const current = result?.key === key ? result : null
  return {
    counters: current?.counters ?? {}, requests: current?.requests ?? {},
    loading: flow !== null && supported && current === null,
    error: current?.errors.join(' ') || null, supported,
  }
}
