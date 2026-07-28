import type { ReactNode } from 'react'
import { PanelInfo } from './PanelInfo'

interface PanelProps {
  title?: ReactNode
  note?: ReactNode
  /** Plain-English explanation, shown in the ⓘ popover. */
  info?: string
  /** Cribl Search (KQL) query behind the panel, revealed in the ⓘ popover. */
  query?: string
  /** Re-run just this panel's query (per-panel refresh, no page reload). */
  onRefresh?: () => void
  /** Whether this panel's query is currently running (spins the refresh icon). */
  refreshing?: boolean
  children: ReactNode
  className?: string
  /** Anchor id for the guided tour to scroll to and highlight. */
  tourId?: string
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

/** A titled dashboard panel (card). The ⓘ next to the title opens a popover
 *  explaining the panel and revealing the exact Cribl Search query behind it.
 *  An optional refresh button re-runs only this panel's query. */
export function Panel({ title, note, info, query, onRefresh, refreshing, children, className = '', tourId }: PanelProps) {
  const hasHeader = title || note || onRefresh
  return (
    <section className={`panel ${className}`} data-tour={tourId}>
      {hasHeader && (
        <header className="panel-head">
          {title && (
            <h3 className="panel-title">
              {title}
              {(info || query) && <PanelInfo about={info} query={query} />}
            </h3>
          )}
          <span className="panel-head-right">
            {note && <span className="panel-note">{note}</span>}
            {onRefresh && (
              <button
                type="button"
                className={`panel-refresh ${refreshing ? 'panel-refresh-on' : ''}`}
                onClick={onRefresh}
                aria-label="Refresh this panel"
                title="Refresh this panel"
              >
                <RefreshIcon />
              </button>
            )}
          </span>
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  )
}
