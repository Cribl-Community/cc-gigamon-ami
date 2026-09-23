import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { forgetRunHistory } from '../cribl/accel/status'

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
  { label: '1m', seconds: 60 },
]

// Intervals the app does not offer. Every tick re-runs every mounted panel as a
// full Lake scan, so a wall display on these costs hundreds to thousands of
// credits a day — and this feed lands in minutes, so they would show nothing
// new. They are left out of the menu rather than greyed out in it, and priced
// in the ⓘ instead, so the omission is explained somewhere a curious reader can
// find it rather than being silent. They return when panels can be served from
// stored results instead of live scans.
export const WITHHELD_REFRESH_SECONDS = [15, 30]

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
    // A HUMAN asked for fresh data, so the shared run-history page must not
    // answer from its 15 s cache: accelerated panels pick their newest run from
    // it, and a run that landed seconds ago would otherwise be invisible to the
    // very click meant to show it. Auto-refresh ticks do not clear it; the TTL
    // is already shorter than the shortest interval.
    forgetRunHistory()
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
