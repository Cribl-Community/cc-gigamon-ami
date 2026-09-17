// Every Cribl Search query the Findings tab runs.
//
// These strings are customer-visible: the ⓘ popover on each tile and panel
// shows the query as the provenance of the number above it, so the exact text
// is the promise. A committed snapshot is regenerated from this module and
// compared, and any edit — including spacing, quoting or ordering "tidied up"
// inside a string — is a deliberate, reviewable change.
//
// Nothing here may import from a .tsx, directly or transitively: the freeze
// loads this module under plain Node, which cannot parse JSX.

import { q } from '../cribl/search'
import { FINDINGS, type Finding } from '../data/findings'

export const FINDINGS_QUERY = q(
  '| summarize total=count(), ' + FINDINGS.map((f, i) => `f${i}=${f.agg}`).join(', '),
)

/** The matching flows behind one finding — the "Flows ↗" link on its row. */
export const findingFlowsQuery = (f: Finding): string => q(`${f.filter} | limit 200`)
