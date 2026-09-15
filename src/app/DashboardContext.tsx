import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export interface TimeRange {
  label: string
  earliest: string // relative, e.g. '-15m'
}

export const TIME_RANGES: TimeRange[] = [
  { label: 'Last 5 minutes', earliest: '-5m' },
  { label: 'Last 15 minutes', earliest: '-15m' },
  { label: 'Last 30 minutes', earliest: '-30m' },
  { label: 'Last 1 hour', earliest: '-1h' },
  { label: 'Last 4 hours', earliest: '-4h' },
  { label: 'Last 24 hours', earliest: '-24h' },
]

// 15 s and 30 s are switched off for everyone: every tick re-runs every
// mounted panel as a full Lake scan, so a wall display on those intervals costs
// hundreds to thousands of credits a day. They return when panels can be served
// from stored results instead of live scans.
export const AUTO_REFRESH = [
  { label: 'Off', seconds: 0, available: true },
  { label: '15s', seconds: 15, available: false },
  { label: '30s', seconds: 30, available: false },
  { label: '1m', seconds: 60, available: true },
]

interface DashboardState {
  range: TimeRange
  setRange: (r: TimeRange) => void
  /** Bumped on manual or auto refresh to re-run all queries. */
  refreshNonce: number
  /** Bumped only by an explicit refresh — searches pinned to their own window
   *  re-run on this, not on auto-refresh ticks. */
  manualRefreshNonce: number
  refresh: () => void
  /** Epoch ms of the last refresh (for "updated Xs ago"). */
  lastRefresh: number
  autoSeconds: number
  setAutoSeconds: (n: number) => void
}

const Ctx = createContext<DashboardState | null>(null)

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<TimeRange>(TIME_RANGES[1]) // Last 15 minutes
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [manualRefreshNonce, setManualRefreshNonce] = useState(0)
  const [lastRefresh, setLastRefresh] = useState(() => Date.now())
  const [autoSeconds, setAutoSeconds] = useState(0)

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
    setManualRefreshNonce((n) => n + 1)
    setLastRefresh(Date.now())
  }, [])

  // Auto-refresh on the chosen interval. A tick is not an explicit refresh, so
  // it leaves manualRefreshNonce alone.
  useEffect(() => {
    if (autoSeconds <= 0) return
    const id = setInterval(() => {
      setRefreshNonce((n) => n + 1)
      setLastRefresh(Date.now())
    }, autoSeconds * 1000)
    return () => clearInterval(id)
  }, [autoSeconds])

  const value = useMemo(
    () => ({ range, setRange, refreshNonce, manualRefreshNonce, refresh, lastRefresh, autoSeconds, setAutoSeconds }),
    [range, refreshNonce, manualRefreshNonce, refresh, lastRefresh, autoSeconds],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDashboard(): DashboardState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider')
  return ctx
}
