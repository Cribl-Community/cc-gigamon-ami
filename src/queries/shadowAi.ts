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

/**
 * The predicate that decides what counts as AI traffic, as one exported string.
 *
 * It was inlined into the two queries below and is now named, because a THIRD
 * thing needs the identical characters: the hourly snapshot entry
 * (`gno_app_src_c1h`) re-applies this filter to stored (app_name, src_ip) pairs,
 * so the tail that cuts the AI tiles out of the shared scan has to select the
 * same apps the live query selects. Retyped in cribl/accel/manifest.ts it would
 * agree on the day it was written and drift the first time somebody added a
 * model vendor to AI_APPS — and the drift would be silent, because both sides
 * would still return plausible numbers.
 *
 * The two query strings below are unchanged, character for character: this is
 * the same expression given a name, not a new one.
 */
export const AI_FILTER = `app_name in (${AI_IN})`

export const appsQuery = q('| summarize flows=count(), bytes=sum(total_bytes), users=dcount(src_ip) by app_name | sort by flows desc | limit 90')

export const aiOverallQuery = q(`| where ${AI_FILTER} | summarize users=dcount(src_ip), flows=count(), bytes=sum(total_bytes)`)

export const aiUsersQuery = q(`| where ${AI_FILTER} | summarize aiflows=count(), aiapps=dcount(app_name), bytes=sum(total_bytes) by src_ip | sort by aiflows desc | limit 15`)
