// Every Cribl Search query the Security tab runs.
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
import { TECHNIQUES, type Technique } from '../data/techniques'

// One pass for the flow-signal counts. The aggregates are a named fragment so
// the hourly snapshot body (src/queries/snapshots.ts) holds the same characters
// rather than a second generator that could diverge from this one.
export const COUNT_AGGS = TECHNIQUES.filter((t) => t.kind === 'flow').map((t) => `c_${t.id.replace(/\./g, '_')}=sum(iif(${t.expr},1,0))`).join(', ')
export const COUNTS = q('| summarize ' + COUNT_AGGS)
// One pass for per-source behaviour (port scan + host fan-out).
export const SOURCES = q('| summarize ports=dcount(dst_port), dsts=dcount(dst_ip), flows=count() by src_ip | sort by flows desc | limit 200')

// Drill: flow-signal techniques run a scoped query; behaviour techniques use
// the already-loaded per-source rows.
export const drillQueryFor = (sel: Technique | null): string => sel?.kind === 'flow'
  ? q(`${sel.filter} | summarize flows=count() by src_ip, dst_ip, app_name, dst_port | sort by flows desc | limit 100`)
  : ''
