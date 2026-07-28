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

export const AUTO_REFRESH = [
  { label: 'Off', seconds: 0 },
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
]

interface DashboardState {
  range: TimeRange
  setRange: (r: TimeRange) => void
  /** Bumped on manual or auto refresh to re-run all queries. */
  refreshNonce: number
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
  const [lastRefresh, setLastRefresh] = useState(() => Date.now())
  const [autoSeconds, setAutoSeconds] = useState(0)

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
    setLastRefresh(Date.now())
  }, [])

  // Auto-refresh on the chosen interval.
  useEffect(() => {
    if (autoSeconds <= 0) return
    const id = setInterval(refresh, autoSeconds * 1000)
    return () => clearInterval(id)
  }, [autoSeconds, refresh])

  const value = useMemo(
    () => ({ range, setRange, refreshNonce, refresh, lastRefresh, autoSeconds, setAutoSeconds }),
    [range, refreshNonce, refresh, lastRefresh, autoSeconds],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDashboard(): DashboardState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider')
  return ctx
}
