// The one visible "where this came from" line for a row of KPI tiles.
//
// `<Panel>` renders this caption itself, in its header. A tile row has no header
// — and six tiles each carrying the same sentence would be the same fact six
// times, in the smallest type on the screen. So the tab renders one of these
// beside the row, and each tile's ⓘ carries the full block-4 wording.
//
// It is the same `snapshotNote` the panels use, so the words, the tones and the
// hour-old threshold cannot drift between a tile row and the card below it.

import { snapshotNote } from './snapshotNote'
import type { PanelSnapshotState } from './snapshotCensus'

export function SnapshotCaption({ state }: { state?: PanelSnapshotState }) {
  const note = snapshotNote(state)
  if (!note) return null
  return (
    <span className={`snap-note snap-note-${note.tone}`} title={note.title}>
      {note.text}
    </span>
  )
}
