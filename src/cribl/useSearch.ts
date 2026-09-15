import { useCallback, useEffect, useRef, useState } from 'react'
import { runSearch, type Row } from './search'
import { useCostSlot } from './jobCost'
import { useDashboard } from '../app/DashboardContext'

export interface UseSearchState {
  rows: Row[]
  totalEventCount: number
  loading: boolean
  error: string | null
  /** Milliseconds the last successful query took. */
  elapsedMs: number | null
  /** Re-run just this query (per-panel refresh, no global page refresh). */
  refetch: () => void
}

export interface UseSearchOptions {
  /** Skip execution (e.g. waiting on a required parameter). */
  enabled?: boolean
  /** Extra dependencies that should re-trigger the query. */
  deps?: unknown[]
  limit?: number
  /** Pin the query to its own earliest bound instead of the global time range. */
  earliest?: string
}

/**
 * Run a Cribl Search query, re-running when the query text, the global time
 * range, a refresh, or any provided deps change.
 *
 * A query pinned to its own `earliest` ignores the global range and
 * auto-refresh ticks; only an explicit refresh re-runs it. Otherwise Data
 * Flow's 30-day total — the most expensive query in the app — re-ran on every
 * range change and every tick without its window changing.
 */
export function useSearch(query: string, opts: UseSearchOptions = {}): UseSearchState {
  const { enabled = true, deps = [], limit, earliest } = opts
  const { range, refreshNonce, manualRefreshNonce } = useDashboard()
  const pinned = earliest !== undefined
  const effectiveEarliest = earliest ?? range.earliest
  const refreshKey = pinned ? manualRefreshNonce : refreshNonce
  const costSlot = useCostSlot(enabled && !pinned)
  // Local nonce for per-panel refresh — bumping it re-runs only this hook.
  const [localNonce, setLocalNonce] = useState(0)
  const refetch = useCallback(() => setLocalNonce((n) => n + 1), [])
  const [state, setState] = useState<Omit<UseSearchState, 'refetch'>>({
    rows: [],
    totalEventCount: 0,
    loading: enabled,
    error: null,
    elapsedMs: null,
  })
  const reqId = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, loading: false }))
      return
    }
    const controller = new AbortController()
    const myReq = ++reqId.current
    setState((s) => ({ ...s, loading: true, error: null }))
    const t0 = performance.now()
    runSearch(query, { earliest: effectiveEarliest, limit, signal: controller.signal, costSlot })
      .then((res) => {
        if (myReq !== reqId.current) return
        setState({
          rows: res.rows,
          totalEventCount: res.totalEventCount,
          loading: false,
          error: null,
          elapsedMs: Math.round(performance.now() - t0),
        })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || myReq !== reqId.current) return
        setState((s) => ({ ...s, loading: false, error: (err as Error).message }))
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, enabled, effectiveEarliest, refreshKey, localNonce, limit, ...deps])

  return { ...state, refetch }
}
