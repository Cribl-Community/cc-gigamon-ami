import type { ReactNode } from 'react'
import { IS_INSTALLED } from '../cribl/config'

interface Props {
  state: { loading: boolean; error: string | null; rows: readonly unknown[] }
  children: ReactNode
  /** Message when the query returns no rows. */
  emptyLabel?: string
  /** Compact spinner (for small panels). */
  compact?: boolean
}

/** Renders loading / error / empty states around a query's content. */
export function QueryBoundary({ state, children, emptyLabel = 'No results', compact }: Props) {
  if (state.loading && state.rows.length === 0) {
    return (
      <div className={`qb-center ${compact ? 'qb-compact' : ''}`}>
        <span className="spinner" aria-hidden />
        <span className="qb-msg">Running search…</span>
      </div>
    )
  }
  if (state.error) {
    const hint = !IS_INSTALLED
      ? ' Dev preview needs the Vite proxy + a valid Cribl token (check the terminal).'
      : ''
    return (
      <div className={`qb-center qb-error ${compact ? 'qb-compact' : ''}`}>
        <span className="qb-error-title">Search failed</span>
        <span className="qb-msg">{state.error}{hint}</span>
      </div>
    )
  }
  if (state.rows.length === 0) {
    return (
      <div className={`qb-center qb-empty ${compact ? 'qb-compact' : ''}`}>
        <span className="qb-msg">{emptyLabel}</span>
      </div>
    )
  }
  // Data is on screen. While a re-run is in flight (range change / refresh /
  // auto-refresh) keep the previous result visible and mark it as updating —
  // blanking to a spinner loses context and reads as a stall.
  //
  // The wrapper is rendered in BOTH states on purpose. Returning a bare
  // fragment when idle and a wrapped tree when loading changes the element
  // structure, which makes React unmount and remount every child on each
  // refresh — that discarded scroll anchors, guided-tour highlights and any
  // DOM state inside the panels. Same shape either way; only classes change.
  return (
    <div className={`qb-live ${state.loading ? 'qb-updating' : ''}`}>
      <div className="qb-refreshing-content" aria-busy={state.loading || undefined}>{children}</div>
      <div className="qb-refreshing-badge" aria-hidden={!state.loading}>
        <span className="spinner spinner-sm" aria-hidden />
        <span>Updating…</span>
      </div>
    </div>
  )
}
