// The Cribl Search (KQL) the Shadow AI tab runs.
//
// Every string here is customer-visible: each KPI tile and panel shows the query
// that produced its number in the ⓘ popover. A committed snapshot of this module
// is regenerated from src/ and diffed by a test, so a change to one character is
// a change to what the app tells a customer — never a tidy-up.
//
// Nothing under src/queries may import a .tsx, or anything that reaches one: the
// snapshot is read by plain Node, which cannot load JSX. That rules out
// ../cribl/useSearch and everything in ../components.

import { q } from '../cribl/search'
import { AI_APPS } from '../data/aiApps'

// The quoted `app_name in (...)` list both AI queries embed — an edit to
// AI_APPS rewrites them.
const AI_IN = AI_APPS.map((a) => `"${a}"`).join(',')

export const appsQuery = q('| summarize flows=count(), bytes=sum(total_bytes), users=dcount(src_ip) by app_name | sort by flows desc | limit 90')

export const aiOverallQuery = q(`| where app_name in (${AI_IN}) | summarize users=dcount(src_ip), flows=count(), bytes=sum(total_bytes)`)

export const aiUsersQuery = q(`| where app_name in (${AI_IN}) | summarize aiflows=count(), aiapps=dcount(app_name), bytes=sum(total_bytes) by src_ip | sort by aiflows desc | limit 15`)
