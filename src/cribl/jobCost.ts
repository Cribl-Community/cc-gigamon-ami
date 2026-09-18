import { useEffect, useRef, useSyncExternalStore } from 'react'
import { searchUrl } from './config'

/**
 * Measured cost of the searches mounted right now.
 *
 * Each search caller holds a slot. When its job completes, the job's billable
 * CPU-seconds are read from `GET /search/jobs/{id}/metrics` (once per query and
 * range).
 *
 * ── TWO QUESTIONS, TWO AGGREGATES ───────────────────────────────────────────
 * `useMountedSearchCost()` answers **what one auto-refresh tick costs**: only
 * slots that re-run on a tick count, so a hook pinned to its own window (Data
 * Flow's 30-day total) adds nothing to it. That is the header's auto-refresh
 * label and it is unchanged.
 *
 * `useMountedLiveCost()` answers **what running every mounted panel live right
 * now costs** — the price the Snapshot / Live control carries. It counts every
 * mounted slot that would actually run, tick or no tick, because pressing `Live`
 * re-runs the pinned and snapshot-served panels too. Pricing it off the tick
 * aggregate was the original plan and would have been wrong by roughly 80× on
 * Data Flow: `useCostSlot(enabled && !pinned)` plus `if (s.autoRefresh …)`
 * excluded the 9,297.7 CPU-s Lake total entirely, so the control would have
 * quoted about 0.03 credits for a press costing 2.5.
 *
 * ── WHERE A SNAPSHOT-SERVED PANEL'S LIVE PRICE COMES FROM ───────────────────
 * Every measurement that reaches a slot is a LIVE one: accel/read.ts submits its
 * `$vt_results` read with no `costSlot` at all, and only the live query and the
 * live fallback carry one. So `cpuSeconds` never needs unpicking — but a panel
 * that has been served from its schedule all session has never run live here and
 * holds no figure. `liveHint` fills exactly that gap, from the same measured
 * number accel/estimate.ts keeps (`MEASURED[id].liveRunCpuSeconds`: 9,297.7 and
 * 754.9, both measured runs, neither from the regressor). A figure this slot
 * measured itself always wins over the hint.
 *
 * A slot with neither is reported as `unpriced` rather than as zero. A control
 * that silently omits the panels it cannot price is a control that under-quotes,
 * which is the failure this whole aggregate exists to stop.
 */

/** 1 credit = 1 billable CPU-hour on the usage-based Search engine. */
export const CPU_SECONDS_PER_CREDIT = 3600

export interface CostSlot {
  id: number
  /** Whether this search re-runs on an auto-refresh tick. */
  autoRefresh: boolean
  /** Whether this search runs at all — false while a panel waits on a parameter
   *  it has not been given. Such a panel costs nothing to press `Live` on. */
  willRun: boolean
  /** The query + range the measurement belongs to. */
  key: string | null
  /** Billable CPU-seconds this slot's own last live job cost, or null. */
  cpuSeconds: number | null
  /** What the same body measured live elsewhere, for a panel that has not run
   *  live in this session. Only consulted when `cpuSeconds` is null. */
  liveHint: number | null
}

export interface MountedCost {
  /** Mounted searches that re-run on a tick and have a measured cost. */
  panels: number
  /** Their summed billable CPU-seconds per refresh. */
  cpuSeconds: number
}

export interface LiveCost {
  /** Mounted searches that would run, and carry a live figure. */
  panels: number
  /** Their summed billable CPU-seconds for one run of all of them. */
  cpuSeconds: number
  /** Mounted searches that would run and carry no live figure at all. The
   *  quoted cost is short by whatever these turn out to be. */
  unpriced: number
}

const slots = new Map<number, CostSlot>()
const listeners = new Set<() => void>()
let nextId = 1
let snapshot: MountedCost = { panels: 0, cpuSeconds: 0 }
let liveSnapshot: LiveCost = { panels: 0, cpuSeconds: 0, unpriced: 0 }

/** What one run of this slot's query costs live, as far as anything has measured
 *  it. The slot's own measurement wins: it is this workspace, this query, this
 *  range, rather than a number taken on another day. */
function liveCostOf(slot: CostSlot): number | null {
  return slot.cpuSeconds ?? slot.liveHint
}

function recompute(): void {
  let panels = 0
  let cpuSeconds = 0
  let livePanels = 0
  let liveCpuSeconds = 0
  let unpriced = 0
  for (const s of slots.values()) {
    if (s.autoRefresh && s.cpuSeconds !== null) {
      panels += 1
      cpuSeconds += s.cpuSeconds
    }
    if (!s.willRun) continue
    const live = liveCostOf(s)
    if (live === null) unpriced += 1
    else {
      livePanels += 1
      liveCpuSeconds += live
    }
  }
  const tickMoved = panels !== snapshot.panels || cpuSeconds !== snapshot.cpuSeconds
  const liveMoved =
    livePanels !== liveSnapshot.panels ||
    liveCpuSeconds !== liveSnapshot.cpuSeconds ||
    unpriced !== liveSnapshot.unpriced
  if (!tickMoved && !liveMoved) return
  // Each snapshot keeps its identity when its own figures did not move, because
  // useSyncExternalStore compares snapshots by reference and would otherwise
  // re-render the header's auto-refresh label on every unrelated panel mount.
  if (tickMoved) snapshot = { panels, cpuSeconds }
  if (liveMoved) liveSnapshot = { panels: livePanels, cpuSeconds: liveCpuSeconds, unpriced }
  for (const l of listeners) l()
}

async function readBillableCpuSeconds(jobId: string): Promise<number | null> {
  try {
    const res = await fetch(searchUrl(`/search/jobs/${encodeURIComponent(jobId)}/metrics`))
    if (!res.ok) return null
    const body = (await res.json()) as { items?: Array<{ metrics?: { cpuMetrics?: { billableCPUSeconds?: unknown } } }> }
    const v = body.items?.[0]?.metrics?.cpuMetrics?.billableCPUSeconds
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** Record a completed job's cost against a slot. Skipped when the slot already
 *  holds a measurement for the same query and range. */
export async function recordJobCost(slot: CostSlot, key: string, jobId: string): Promise<void> {
  if (slot.key === key && slot.cpuSeconds !== null) return
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000))
    const cpuSeconds = await readBillableCpuSeconds(jobId)
    if (cpuSeconds !== null) {
      slot.key = key
      slot.cpuSeconds = cpuSeconds
      if (slots.has(slot.id)) recompute()
      return
    }
  }
}

/** What a caller tells its slot about itself. The boolean form is the older
 *  one-question shape and still means `autoRefresh`. */
export interface CostSlotOptions {
  /** This search re-runs on an auto-refresh tick. */
  autoRefresh: boolean
  /** This search runs at all. Default true. */
  willRun?: boolean
  /** Billable CPU-seconds the same body measured live elsewhere. */
  liveHint?: number | null
}

/** A cost slot that lives as long as the calling component. */
export function useCostSlot(opts: boolean | CostSlotOptions): CostSlot {
  const { autoRefresh, willRun = true, liveHint = null } = typeof opts === 'boolean' ? { autoRefresh: opts } : opts
  const ref = useRef<CostSlot | null>(null)
  if (ref.current === null) ref.current = { id: nextId++, autoRefresh, willRun, key: null, cpuSeconds: null, liveHint }
  const slot = ref.current

  useEffect(() => {
    slots.set(slot.id, slot)
    recompute()
    return () => {
      slots.delete(slot.id)
      recompute()
    }
  }, [slot])

  useEffect(() => {
    slot.autoRefresh = autoRefresh
    slot.willRun = willRun
    slot.liveHint = liveHint
    recompute()
  }, [slot, autoRefresh, willRun, liveHint])

  return slot
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const getSnapshot = () => snapshot
const getLiveSnapshot = () => liveSnapshot

/** What one auto-refresh tick costs on the mounted tab, as far as it is measured. */
export function useMountedSearchCost(): MountedCost {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** What running every mounted panel live right now costs — the Snapshot / Live
 *  control's price. See the header for why it is not the tick figure. */
export function useMountedLiveCost(): LiveCost {
  return useSyncExternalStore(subscribe, getLiveSnapshot, getLiveSnapshot)
}
