import { useEffect, useRef, useSyncExternalStore } from 'react'
import { searchUrl } from './config'

/**
 * Measured cost of the searches mounted right now, for the auto-refresh cost
 * labels in the header.
 *
 * Each search caller holds a slot. When its job completes, the job's billable
 * CPU-seconds are read from `GET /search/jobs/{id}/metrics` (once per query and
 * range). Only slots that re-run on an auto-refresh tick count: a hook pinned to
 * its own window (Data Flow's 30-day total) ignores ticks, so it adds nothing
 * to what a tick costs.
 */

/** 1 credit = 1 billable CPU-hour on the usage-based Search engine. */
export const CPU_SECONDS_PER_CREDIT = 3600

export interface CostSlot {
  id: number
  /** Whether this search re-runs on an auto-refresh tick. */
  autoRefresh: boolean
  /** The query + range the measurement belongs to. */
  key: string | null
  cpuSeconds: number | null
}

export interface MountedCost {
  /** Mounted searches that re-run on a tick and have a measured cost. */
  panels: number
  /** Their summed billable CPU-seconds per refresh. */
  cpuSeconds: number
}

const slots = new Map<number, CostSlot>()
const listeners = new Set<() => void>()
let nextId = 1
let snapshot: MountedCost = { panels: 0, cpuSeconds: 0 }

function recompute(): void {
  let panels = 0
  let cpuSeconds = 0
  for (const s of slots.values()) {
    if (s.autoRefresh && s.cpuSeconds !== null) {
      panels += 1
      cpuSeconds += s.cpuSeconds
    }
  }
  if (panels === snapshot.panels && cpuSeconds === snapshot.cpuSeconds) return
  snapshot = { panels, cpuSeconds }
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

/** A cost slot that lives as long as the calling component. */
export function useCostSlot(autoRefresh: boolean): CostSlot {
  const ref = useRef<CostSlot | null>(null)
  if (ref.current === null) ref.current = { id: nextId++, autoRefresh, key: null, cpuSeconds: null }
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
    recompute()
  }, [slot, autoRefresh])

  return slot
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const getSnapshot = () => snapshot

/** What one auto-refresh tick costs on the mounted tab, as far as it is measured. */
export function useMountedSearchCost(): MountedCost {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
