// The Snapshot / Live control, and the line beside it that says what you are
// looking at.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY TWO BUTTONS AND NOT A THIRD <select>. The header already carries two
// `<select class="range-select">` that look identical — the time range and the
// auto-refresh interval. A third identical affordance, of which only this one
// changes what the numbers on screen MEAN, is a trap: a reader who has learned
// that the selects beside it are display settings will read this as one too.
//
// WHY IT IS NOT FOLDED INTO THE REFRESH BUTTON, which is where the owner's
// instinct put it. A menu on Refresh hides the current state, and the current
// state is the entire product here — `LastUpdated` already answers "how fresh",
// and the mode is the other half of that same sentence. The instinct is honoured
// by ADJACENCY: this sits immediately left of Refresh, and in Snapshot mode it
// takes over the freshness line that Refresh's neighbour normally owns.
//
// WHY IT IS NOT `role="switch"`. A switch has no name for its off state, and
// Live is not "Snapshot, off". Two `aria-pressed` buttons in a `role="group"`
// give each state a word, which is also what lets the Live one carry its price.
//
// ── WHAT IT IS FORBIDDEN TO SAY ─────────────────────────────────────────────
// "Fast". At the poll cadence this app runs, a stored read is not reliably
// quicker than a live query against a Parquet-backed dataset, and no reading of
// either has ever been taken in a browser. `Snapshot` is a claim about WHEN the
// number was computed, which is measured, dated on screen, and true.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useId, useState } from 'react'
import { setDataMode, useDataMode, useDataModeSave, type DataMode } from '../cribl/dataMode'
import { useMountedSearchCost } from '../cribl/jobCost'
import { PanelInfo } from './PanelInfo'
import { useSnapshotCensus } from './snapshotCensus'
import {
  censusLine,
  liveSegmentLabel,
  modeAbout,
  MODE_SR_NOTE,
  SEGMENT_NAMES,
  SNAPSHOT_LABEL,
  unsavedLine,
} from './modeToggleCopy'

/**
 * How often the state line recomputes its age.
 *
 * The same five seconds `LastUpdated` uses, and for the same reason: the age is
 * the only part of the line that moves on its own, and a caption that says "42m
 * ago" for an hour is the literal I-D20 exists to stop.
 */
const AGE_TICK_MS = 5000

export function ModeToggle({ tabName }: { tabName: string }) {
  const mode = useDataMode()
  const save = useDataModeSave()
  const census = useSnapshotCensus()
  const cost = useMountedSearchCost()
  const noteId = useId()

  const [, setTick] = useState(0)
  useEffect(() => {
    // Only while a snapshot's age is on screen. A timer running behind Live mode
    // would re-render the header every five seconds to change nothing.
    if (mode !== 'snapshot' || census.snapshotted === 0) return
    const id = setInterval(() => setTick((n) => n + 1), AGE_TICK_MS)
    return () => clearInterval(id)
  }, [mode, census.snapshotted])

  const press = (next: DataMode) => () => setDataMode(next)
  const unsaved = unsavedLine(save)

  return (
    <span className="mode-toggle-wrap">
      {/* The state line comes FIRST in the DOM, left of the control, so it sits
          where `LastUpdated` sits in Live mode — one freshness statement, in one
          place, whichever mode is on. */}
      {mode === 'snapshot' && <span className="last-updated mode-state">{censusLine(census)}</span>}
      <span className="mode-toggle" role="group" aria-label="Data source" aria-describedby={noteId}>
        <button
          type="button"
          className={`seg ${mode === 'snapshot' ? 'seg-active' : ''}`}
          aria-pressed={mode === 'snapshot'}
          aria-label={SEGMENT_NAMES.snapshot}
          onClick={press('snapshot')}
        >
          {SNAPSHOT_LABEL}
        </button>
        <button
          type="button"
          className={`seg ${mode === 'live' ? 'seg-active' : ''}`}
          aria-pressed={mode === 'live'}
          aria-label={SEGMENT_NAMES.live}
          onClick={press('live')}
        >
          {liveSegmentLabel(cost, census)}
        </button>
      </span>
      <span id={noteId} className="sr-only">{MODE_SR_NOTE}</span>
      {/* Visible text, not a `title=`: a refused write is a fact about what the
          app will do next time, and GatedControl's rule — the reason a control
          behaves unexpectedly is never hover-only — applies to it exactly. */}
      {unsaved && <span className="mode-unsaved">{unsaved}</span>}
      <PanelInfo
        aboutHeading="Where these numbers come from"
        about={modeAbout(mode, census, cost, tabName)}
        label="Where the numbers on this tab come from"
        dialogLabel="Where the numbers on this tab come from"
      />
    </span>
  )
}
