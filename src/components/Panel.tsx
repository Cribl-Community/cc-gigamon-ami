import type { ReactNode } from 'react'
import { useDataMode } from '../cribl/dataMode'
import { PanelInfo, type ComputedFrom } from './PanelInfo'
import { snapshotServed, useSnapshotSlot, type PanelSnapshotState } from './snapshotCensus'
import { snapshotNote } from './snapshotNote'

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
  /**
   * Where this panel's numbers came from on this page load — the shape
   * `useSearch` already answers with.
   *
   * Passing it does two things, and the second is why it is a prop rather than
   * something a tab renders itself. It puts the caption under the title (the
   * time AND the age — see snapshotNote.ts), and it enters this panel in the
   * header's census, which is what makes `3 of 6 panels` a count of what the
   * reader can see rather than of hooks they cannot.
   *
   * A panel that never had a scheduled run passes nothing and is still counted —
   * as part of the six.
   */
  snapshot?: PanelSnapshotState
  /**
   * Run THIS panel live for this visit, without leaving Snapshot mode.
   *
   * Generalised from Field Explorer's shipped "Run live". Local, visit-scoped
   * and never persisted: a per-panel override that survived a navigation would
   * be an invisible standing charge replicated across dozens of panels, and
   * nothing on screen would say which ones were on. The tab owns the boolean —
   * it is what decides the panel's `accelEnabled` — and hands it back as
   * `liveOnly` so the control can say which way it is pointing.
   *
   * Offered only on a snapshot-served panel: on a live one it would be a second
   * per-panel refresh sitting beside `onRefresh`, differing only by a mode the
   * reader cannot see.
   */
  onRunLive?: () => void
  /** Whether that control is currently on. */
  liveOnly?: boolean
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
export function Panel({ title, note, info, query, computed, infoLabel, infoDialogLabel, onRefresh, refreshing, children, className = '', tourId, anchorRef, snapshot, onRunLive, liveOnly }: PanelProps) {
  // Unconditional: every mounted panel is part of the census denominator, so a
  // tab of six with two snapshots reports `2 of 6` rather than `2 of 2`.
  useSnapshotSlot(snapshot ? { ...snapshot, liveOnly } : undefined)
  const mode = useDataMode()
  const source = snapshotNote(snapshot ? { ...snapshot, liveOnly } : undefined)
  // Hidden in global Live mode rather than disabled: there is nothing to escape
  // from, and a control offering an escape that has already been taken reads as
  // broken. Kept while `liveOnly` is on so the way back is never lost.
  const offerLive = !!onRunLive && mode === 'snapshot' && (liveOnly || snapshotServed(snapshot))
  const hasHeader = title || note || onRefresh || source || offerLive
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
            {source && (
              <span className={`snap-note snap-note-${source.tone}`} title={source.title}>
                {source.text}
              </span>
            )}
            {note && <span className="panel-note">{note}</span>}
            {offerLive && (
              /* Not a <GatedControl>: this reads, it does not write, and nothing
                 about it can be refused — it just costs a scan. */
              <button
                type="button"
                className={`chip ${liveOnly ? 'chip-active' : ''}`}
                aria-pressed={!!liveOnly}
                onClick={onRunLive}
                title={liveOnly ? 'Go back to the scheduled run’s stored result' : 'Run this panel’s own query now'}
              >
                {liveOnly ? 'Live · back to snapshot' : 'Run live'}
              </button>
            )}
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
