import type { ReactNode } from 'react'
import { PanelInfo, type ComputedFrom } from './PanelInfo'

interface PanelProps {
  title?: ReactNode
  note?: ReactNode
  /** Plain-English explanation, shown in the ⓘ popover. */
  info?: string
  /** Cribl Search (KQL) query behind the panel, revealed in the ⓘ popover. */
  query?: string
  /**
   * Where the figure actually came from — a stored run of a scheduled search, or
   * a live query — and when.
   *
   * Forwarded rather than left to the call site because of what happens when it
   * is not. A panel needing block 4 had to build its own <PanelInfo> inside
   * `title`, which moved `query=` off this element; the extractor reads `info=`
   * and `note=` from whichever element carries `query=`, so both silently left
   * src/queries/__frozen__/display.json — the ⓘ still rendered, and the gate
   * that proves its words stopped watching them. Three forwarded props are
   * cheaper than a second way of building an ⓘ.
   */
  computed?: ComputedFrom
  /** The ⓘ trigger's accessible name, where the default understates what the
   *  popover carries. */
  infoLabel?: string
  /** The popover's own accessible name, likewise. */
  infoDialogLabel?: string
  /** Re-run just this panel's query (per-panel refresh, no page reload). */
  onRefresh?: () => void
  /** Whether this panel's query is currently running (spins the refresh icon). */
  refreshing?: boolean
  children: ReactNode
  className?: string
  /** Anchor id for the guided tour to scroll to and highlight. */
  tourId?: string
  /**
   * The panel's own element, for `useNearViewport()` to watch.
   *
   * It goes on the `<section>` rather than on a wrapper the call site adds,
   * because a wrapper is either a layout change (a spare box inside `.grid-2`)
   * or, with `display: contents` to avoid that, an element with no box at all —
   * which an IntersectionObserver reads as permanently out of view. Either way
   * the panel never loads. One prop is cheaper than that bug.
   */
  anchorRef?: (el: Element | null) => void
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
export function Panel({ title, note, info, query, computed, infoLabel, infoDialogLabel, onRefresh, refreshing, children, className = '', tourId, anchorRef }: PanelProps) {
  const hasHeader = title || note || onRefresh
  return (
    <section className={`panel ${className}`} data-tour={tourId} ref={anchorRef}>
      {hasHeader && (
        <header className="panel-head">
          {title && (
            <h3 className="panel-title">
              {title}
              {(info || query) && (
                <PanelInfo
                  about={info}
                  query={query}
                  computed={computed}
                  label={infoLabel}
                  dialogLabel={infoDialogLabel}
                />
              )}
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
