import { useCallback, useEffect, useRef, useState } from 'react'
import { runSearch, type Row } from './search'
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
  /** Override the global time range's earliest bound. */
  earliest?: string
}

/**
 * Run a Cribl Search query, re-running when the query text, the global time
 * range, the global refresh nonce, or any provided deps change.
 */
export function useSearch(query: string, opts: UseSearchOptions = {}): UseSearchState {
  const { enabled = true, deps = [], limit, earliest } = opts
  const { range, refreshNonce } = useDashboard()
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
    runSearch(query, { earliest: earliest ?? range.earliest, limit, signal: controller.signal })
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
  }, [query, enabled, range.earliest, refreshNonce, localNonce, earliest, limit, ...deps])

  return { ...state, refetch }
}
