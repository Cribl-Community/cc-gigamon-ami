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

// The per-finding aggregates, without the row total. Exported so the hourly
// snapshot body holds these characters rather than a retyped copy — and so it
// can give the total a different NAME, which it has to: `total` already means
// sum(total_bytes) to the Capacity tiles sharing that body. See snapshots.ts.
export const FINDING_AGGS = FINDINGS.map((f, i) => `f${i}=${f.agg}`).join(', ')

export const FINDINGS_QUERY = q('| summarize total=count(), ' + FINDING_AGGS)

/** The matching flows behind one finding — the "Flows ↗" link on its row. */
export const findingFlowsQuery = (f: Finding): string => q(`${f.filter} | limit 200`)
