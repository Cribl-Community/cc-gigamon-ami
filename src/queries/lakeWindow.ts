// Which query totals the Lake dataset, and over what window — decided by the
// tenant's retention, not by a constant.
//
// The Lake card says what `gigamon_ami` HOLDS, so its window is the dataset's
// own retention: 30 days on one tenant, 365 on another. It used to be a fixed
// `-30d`, which on a 365-day dataset would have reported a month under a label
// meaning a year.
//
// TWO WAYS TO COUNT, and the retention decides between them (owner's call,
// 2026-09-23, "hybrid"):
//
//   • WRITE COUNTERS (`LAKE_TOTAL_QUERY`) — sums Stream's write counters in
//     `cribl_metrics`. Cheap, and exact while the window is one `cribl_metrics`
//     still holds: measured against a direct count the same day, 737.2M vs
//     756.8M eight hours apart, the gap being those eight hours of feed.
//   • A DIRECT COUNT (`LAKE_HELD_QUERY`) — counts `gigamon_ami` itself.
//     Always exact, and expensive: 525 s for 30 days (measured 2026-09-23).
//
// The write counters are used whenever the dataset's retention fits inside
// `cribl_metrics`' own; otherwise the counters would cover only part of what the
// dataset holds, and the direct count is the only honest answer.
//
// PURE, and imported by the manifest: nothing here may reach a .tsx or the
// network (the query extractor loads the manifest under plain Node). Reading
// the two retentions is `readLakeWindow` in ../lakeWindowRead.ts.

import { LAKE_HELD_QUERY, LAKE_TOTAL_QUERY } from './dataFlow'

export type LakeCountMethod = 'write-counters' | 'count'

export interface LakeWindow {
  /** The Lake dataset's own retention — the window the card reports. */
  retentionDays: number
  /** `cribl_metrics`' retention, which bounds what the write counters can see.
   *  Null when it could not be read. */
  metricsRetentionDays: number | null
  method: LakeCountMethod
  query: string
  /** `-<retention>d`, the form a search and a saved search take. */
  earliest: string
}

/** A retention the rule will act on: a whole number of days, at least one. */
const days = (n: number | null): number | null => (n !== null && Number.isInteger(n) && n >= 1 ? n : null)

/**
 * The window and the query for these two retentions, or null when the
 * dataset's own retention is unknown — the one thing the window cannot be
 * guessed from.
 *
 * `cribl_metrics`' retention unknown means the write counters cannot be shown
 * to cover the window, so the direct count is used: slower, never short.
 */
export function lakeWindow(datasetRetentionDays: number | null, metricsRetentionDays: number | null): LakeWindow | null {
  const r = days(datasetRetentionDays)
  if (r === null) return null
  const m = days(metricsRetentionDays)
  const method: LakeCountMethod = m !== null && r <= m ? 'write-counters' : 'count'
  return {
    retentionDays: r,
    metricsRetentionDays: m,
    method,
    query: method === 'write-counters' ? LAKE_TOTAL_QUERY : LAKE_HELD_QUERY,
    earliest: `-${r}d`,
  }
}

/**
 * The window when the dataset's retention cannot be read: thirty days, counted
 * with the write counters. It is the manifest's default for the saved search and
 * the Lake card's fallback, defined once here so the two cannot disagree.
 */
export const LAKE_DEFAULT_DAYS = 30
export const LAKE_DEFAULT_WINDOW: LakeWindow = lakeWindow(LAKE_DEFAULT_DAYS, LAKE_DEFAULT_DAYS) as LakeWindow

/** The retention a relative window like `-30d` covers, in days, or null. */
export function windowDays(earliest: string | null | undefined): number | null {
  const m = /^-(\d+)d$/.exec(earliest ?? '')
  return m ? Number(m[1]) : null
}
