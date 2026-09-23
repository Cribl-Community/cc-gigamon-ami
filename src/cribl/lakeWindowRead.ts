// The Lake dataset's retention, `cribl_metrics`' retention and the dataset's
// stored size — one Lake API read, shared for the session.
//
// src/queries/lakeWindow.ts turns the two retentions into the Lake card's window and
// counting method. This is the read that feeds it, kept out of that module
// because the manifest imports it and the query extractor loads the manifest
// under plain Node, where there is no network.
//
// A config-plane GET that bills nothing and writes nothing (`listDatasets`,
// already granted for Guided Setup's landing panel). Shared, because the Lake
// card, Guided Setup's acceleration status and Apply all need the same answer,
// and a retention does not change between two renders.

import { useEffect, useSyncExternalStore } from 'react'
import { LAKE_DATASET } from './config'
import { listDatasets } from './lake'
import { lakeWindow, type LakeWindow } from '../queries/lakeWindow'

/** `cribl_metrics`, as a Lake dataset — whose retention bounds the write counters. */
export const METRICS_DATASET = 'cribl_metrics'

export interface LakeFacts {
  /** Null when the dataset's retention could not be read — see `lakeWindow`. */
  window: LakeWindow | null
  /** What the dataset occupies on disk, from the Lake API's own daily metric. */
  storedBytes: number | null
  /** The DAY that size was computed. A size shown without it is a claim about
   *  now that the API does not make. */
  storedAsOf: string | null
  /** Why `window` is null, when it is. Never Cribl's words verbatim. */
  error: string | null
}

/** A successful read, reused for the session. */
let cached: LakeFacts | null = null
/** The last answer of either kind, for components — a failure included, so a
 *  card can say why it has no window rather than spin. Not reused by
 *  `readLakeFacts`, which retries a failure. */
let latest: LakeFacts | null = null
let inFlight: Promise<LakeFacts> | null = null
const listeners = new Set<() => void>()

/** Drop the cached answer — a refresh, a retention change, a test. */
export function forgetLakeFacts(): void {
  cached = null
  latest = null
  inFlight = null
  for (const l of listeners) l()
}

/**
 * The facts, from cache, from a read in flight, or from the network. A failure
 * is not cached: the next caller gets a fresh attempt.
 */
export function readLakeFacts(): Promise<LakeFacts> {
  if (cached !== null) return Promise.resolve(cached)
  if (inFlight !== null) return inFlight
  const p = listDatasets({ background: true }).then((r): LakeFacts => {
    if (r.outcome !== 'ok' || r.value === null) {
      return { window: null, storedBytes: null, storedAsOf: null, error: 'The Lake dataset’s retention could not be read.' }
    }
    const lake = r.value.find((d) => d.id === LAKE_DATASET)
    const metrics = r.value.find((d) => d.id === METRICS_DATASET)
    if (!lake) return { window: null, storedBytes: null, storedAsOf: null, error: `There is no ${LAKE_DATASET} dataset in this lake.` }
    return {
      window: lakeWindow(lake.retentionPeriodInDays, metrics?.retentionPeriodInDays ?? null),
      storedBytes: lake.metrics?.currentSizeBytes ?? null,
      storedAsOf: lake.metrics?.metricsDate ?? null,
      error: lake.retentionPeriodInDays === null ? 'The Lake dataset reports no retention.' : null,
    }
  })
  inFlight = p
  void p.then((facts) => {
    if (inFlight !== p) return
    inFlight = null
    latest = facts
    if (facts.error === null) cached = facts
    for (const l of listeners) l()
  })
  return p
}

/** Only `readLakeWindow`'s answer — the part the manifest resolves against. */
export async function readLakeWindow(): Promise<LakeWindow | null> {
  return (await readLakeFacts()).window
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
/** Undefined while nothing has been read yet — distinct from a read that failed. */
const snapshot = (): LakeFacts | undefined => latest ?? undefined

/**
 * The facts in a component, starting the read (in an effect, not in render)
 * the first time one asks. `undefined` means "not read yet"; a failed read
 * comes back with `error` set and `window` null.
 */
export function useLakeFacts(): LakeFacts | undefined {
  const facts = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (facts === undefined) void readLakeFacts()
  }, [facts])
  return facts
}
