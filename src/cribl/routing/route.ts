// The query router: at submit, which dataset one query as written runs on. The
// ⓘ (routing/ranOn.ts) is told where a query ran only once its job has
// answered — `recordLanded`, which search.ts calls after the results are read —
// so a job in flight, failed or aborted never moves the ⓘ off the dataset of
// the figure still on screen.
//
// ── ORDER OF PRECEDENCE ─────────────────────────────────────────────────────
// 1. `asWritten` (a measurement of `gigamon_ami` itself) — never routed.
// 2. The sample-data seam (config.ts `toActiveDataset`): while the app reads the
//    sample, every query goes there and Parquet steps aside, as Snapshot does.
// 3. This router, per query:
//      no entry for the text        → JSON
//      the entry is pinned          → JSON
//      the table says JSON          → JSON          (every entry, today)
//      no evidence recorded         → JSON          (the table's test forbids it anyway)
//      the text is not eligible     → JSON          (types, and THIS install's density)
//      the window is not proven complete → JSON     (routing/completeness.ts)
//      otherwise                    → gigamon_ami_pq
// 1 and 2 live in cribl/search.ts `executedQuery`, which calls this for 3.
//
// ── WIRING ──────────────────────────────────────────────────────────────────
// cribl/search.ts cannot import this module: this imports the routing table,
// the table imports every src/queries module, and those import search.ts's
// `q()`. A static import back would be a cycle whose evaluation order decides
// whether a query constant exists yet. So search.ts exposes `setQueryRouter`,
// and main.tsx installs this once, by a DYNAMIC import: the table reaches every
// src/queries module, most of which belong to lazy tabs, and a static import
// would move them all into the first page load. Until it lands — and in every
// test that does not install it — each query runs as written, on JSON, which is
// always a correct answer and is exactly what the shipped table decides.
//
// Nothing here reads the network or writes anything. Density is NO_DENSITY and
// the completeness cache is empty on every install today; both are inputs the
// first real routing change must fill.

import { REAL_DATASET, retargetQuery } from '../../queries/datasets'
import { FIELD_TYPES } from '../../data/fieldTypes'
import type { FieldType } from '../parity'
import { setQueryRouter } from '../search'
import { windowCompleteness, type WindowSpan, type WindowVerdict } from './completeness'
import { NO_DENSITY, eligibility, type DensityTable } from './eligibility'
import { PARQUET_DATASET, recordRanOn } from './ranOn'
import { ROUTES, type RouteEntry } from './table'

export { PARQUET_DATASET }

export interface RoutingInputs {
  entries: readonly RouteEntry[]
  types: Readonly<Record<string, FieldType>>
  /** This install's measured density. */
  density: DensityTable
  complete: (window: WindowSpan, now: number) => WindowVerdict
}

const SHIPPED: RoutingInputs = Object.freeze({
  entries: ROUTES,
  types: FIELD_TYPES,
  density: NO_DENSITY,
  complete: (w: WindowSpan, now: number) => windowCompleteness(w, now),
})

let inputs: RoutingInputs = SHIPPED
let index: Map<string, RouteEntry> | null = null

/**
 * Tests only: route with another table, type table, density or completeness
 * answer. `null` puts the shipped inputs back. This is how a test proves a
 * `parquet` entry WOULD move a query — the shipped table has none.
 */
export function overrideRouting(next: Partial<RoutingInputs> | null): void {
  inputs = next ? { ...SHIPPED, ...next } : SHIPPED
  index = null
}

function entryFor(query: string): RouteEntry | undefined {
  if (!index) {
    index = new Map()
    for (const e of inputs.entries) for (const text of e.queries) index.set(text, e)
  }
  return index.get(query)
}

export interface RouteDecision {
  dataset: string
  /** The entry that decided, or null when the text is in no entry. */
  id: string | null
  /** Why, in words — for a test, a trace or a future ⓘ line. */
  why: string
}

const json = (id: string | null, why: string): RouteDecision => ({ dataset: REAL_DATASET, id, why })

/** Where one query, as written against `gigamon_ami`, runs over `window`. `now` is epoch seconds. */
export function decideRoute(query: string, window: WindowSpan, now: number): RouteDecision {
  const e = entryFor(query)
  if (!e) return json(null, 'not in the routing table')
  if (e.pin) return json(e.id, `pinned to JSON (${e.pin})`)
  if (e.target !== 'parquet') return json(e.id, 'the routing table keeps it on JSON')
  if (!e.evidence) return json(e.id, 'no parity evidence is recorded')
  const el = eligibility(query, inputs.types, inputs.density)
  if (!el.eligible) return json(e.id, el.refusals.map((r) => r.words).join('; '))
  const c = inputs.complete(window, now)
  if (!c.complete) return json(e.id, c.why ?? 'the Parquet copy is not proven complete over this window')
  return { dataset: PARQUET_DATASET, id: e.id, why: `routed by ${e.id}, on evidence from ${e.evidence.date}` }
}

/** The query the platform receives: `query` on its routed dataset. Installed into search.ts. */
export function routeForSubmit(query: string, window: WindowSpan): string {
  const d = decideRoute(query, window, Math.floor(Date.now() / 1000))
  return d.dataset === REAL_DATASET ? query : retargetQuery(query, d.dataset)
}

/**
 * A routed job of `query` answered, having run as `executed`. The router only
 * ever sends a query as written or retargeted onto PARQUET_DATASET, so the text
 * alone says which.
 */
export function recordLanded(query: string, executed: string): void {
  recordRanOn(query, executed === query ? REAL_DATASET : PARQUET_DATASET)
}

/** Once, from main.tsx. */
export function installQueryRouter(): void {
  setQueryRouter(routeForSubmit, recordLanded)
}
