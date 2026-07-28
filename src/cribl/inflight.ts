import { useSyncExternalStore } from 'react'

/**
 * Tracks how many Cribl Search queries are in flight right now.
 *
 * Instrumented inside runSearch/runFieldSummaries rather than in useSearch, so
 * every caller is counted automatically — including tabs that call the search
 * client directly (e.g. Field Explorer's presence + field-summaries queries).
 */
let count = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function beginQuery(): void {
  count += 1
  emit()
}

export function endQuery(): void {
  count = Math.max(0, count - 1)
  emit()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

const getSnapshot = () => count

/** Number of queries currently running (0 when idle). */
export function useInflight(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
