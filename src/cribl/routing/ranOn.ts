// Which dataset the last job of each query actually ran on — what the ⓘ names
// (components/PanelInfo.tsx, Phase 8 design §4.1).
//
// Keyed by the query as written. The ⓘ shows what RAN, never a prediction: a
// routing decision depends on the window and the moment, and only the submit
// (routing/route.ts) knows both. And it is recorded when the job ANSWERS, not
// when it is sent (search.ts calls `recordLanded` after reading the results),
// so a job still in flight, one that fails and one that is aborted leave the ⓘ
// naming the dataset of the figure still on screen. *(Corrected 2026-09-25,
// review of `feat/phase8-1-router`: this was written at submit, so a refresh
// routed elsewhere moved the ⓘ before — or without — the figure moving.)*
// Until a query has been routed elsewhere it ran on gigamon_ami — today,
// always.
//
// WHAT THIS STILL CANNOT SEE. Two panels showing the same query text share one
// entry, and a panel whose figure is a stored run's is not this module's
// business: PanelInfo names JSON for it before reading this.
//
// Its own module, apart from the router, so the ⓘ can read it without pulling
// the routing table (and through it every src/queries module) into the first
// page load. Page-lifetime; nothing is stored.

import { useSyncExternalStore } from 'react'
import { REAL_DATASET } from '../../queries/datasets'

/**
 * The Parquet copy a routed query reads. Written out rather than imported from
 * cribl/pack.ts for the reason above; route.test.ts pins it to
 * `PACK_PARQUET_DATASET_ID`.
 */
export const PARQUET_DATASET = 'gigamon_ami_pq'

const byQuery = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version++
  for (const l of listeners) l()
}

/** routing/route.ts `recordLanded`, once per routed job that answered. */
export function recordRanOn(query: string, dataset: string): void {
  const was = ranOn(query)
  byQuery.set(query, dataset)
  if (was !== dataset) changed()
}

/** The dataset the last job of `query` ran on. */
export function ranOn(query: string): string {
  return byQuery.get(query) ?? REAL_DATASET
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** `ranOn`, re-rendering when it changes. */
export function useRanOn(query: string | undefined): string {
  useSyncExternalStore(subscribe, () => version, () => version)
  return query === undefined ? REAL_DATASET : ranOn(query)
}

/** Tests only. */
export function forgetRanOn(): void {
  byQuery.clear()
  changed()
}
