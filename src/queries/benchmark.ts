// The searches Guided Setup's store benchmark times, and the one move it makes
// to point each at the Parquet copy.
//
// ── NO KQL OF ITS OWN ───────────────────────────────────────────────────────
// Every string below is IMPORTED — the row count the Lake landing parity check
// runs, TCP Health's duplicate-ACK trend, the application-by-source snapshot
// and the opening-tiles scan — so a benchmark of "the duplicate-ACK trend" is a
// benchmark of the characters that panel runs, and a change to that panel's
// query moves this set with it. This is the behaviour measurement of the
// Phase 8 read-side design (§3.2): the control and floor, a panel with a
// Parquet figure already in hand, a class-free high-cardinality group-by, and,
// optionally, the overview scan (time and work only — several of its figures
// read an absent field as "" or 0 on Parquet).
//
// The Parquet side is the same text with only its dataset selector moved
// (`onParquet`, which is `retargetQuery`), exactly the move the sample seam and
// the router make. Never a second copy of a query.
//
// It is here, and not beside the panel, so the query freeze sees the set and
// the Parquet text each ⓘ shows (src/queries/__frozen__/display.json). It is
// NOT a routing input: the benchmark submits every run `asWritten`, and nothing
// it measures moves a query (cribl/routing/table.ts is where that happens, on
// recorded evidence).
//
// Nothing here may import a .tsx or anything reaching one — the freeze loads
// this module under plain Node.

import { PARITY_COUNT_QUERY } from './lakeLanding'
import { buildTrendQuery } from './tcpHealth'
import { APP_SRC_SNAPSHOT_QUERY, OVERVIEW_SNAPSHOT_QUERY } from './snapshots'
import { retargetQuery } from './datasets'
import { PACK_PARQUET_DATASET_ID } from '../cribl/pack'

export type BenchQueryId = 'count' | 'dupacks' | 'appSrc' | 'overview'

export interface BenchQuery {
  id: BenchQueryId
  /** What the reader calls it. */
  label: string
  /** The query as the app writes it, on `gigamon_ami`. */
  query: string
  /** Why it is in the set, for the ⓘ beside its name. */
  why: string
  /** Ticked when the panel opens. */
  defaultOn: boolean
}

/** The Parquet copy the benchmark may measure: the pack's own dataset id. */
export const BENCH_PARQUET_DATASET = PACK_PARQUET_DATASET_ID

export const BENCH_QUERIES: readonly BenchQuery[] = Object.freeze([
  {
    id: 'count',
    label: 'Row count',
    query: PARITY_COUNT_QUERY,
    why:
      'Counts every record in the window. It is the control: every store must read every row to answer it, so it shows ' +
      'the least any search of that store can cost.',
    defaultOn: true,
  },
  {
    id: 'dupacks',
    label: 'Duplicate-ACK trend',
    query: buildTrendQuery('dupacks'),
    why: 'TCP Health’s per-minute duplicate-ACK trend, exactly as that panel runs it: a filter, a sum and a time bin.',
    defaultOn: true,
  },
  {
    id: 'appSrc',
    label: 'Flows by application and source',
    query: APP_SRC_SNAPSHOT_QUERY,
    why:
      'The scan behind the application-by-source panels: a group-by on two high-cardinality fields, the shape most ' +
      'likely to behave differently on a columnar store.',
    defaultOn: true,
  },
  {
    id: 'overview',
    label: 'Opening tiles, one scan',
    query: OVERVIEW_SNAPSHOT_QUERY,
    why:
      'The single scan behind the opening tiles of five dashboards. Several of its figures read an absent field as empty ' +
      'or zero on the Parquet copy, so its answer is known to differ there: it measures time and work only.',
    defaultOn: false,
  },
])

/** The same search, reading the Parquet copy. Only the dataset selector moves. */
export function onParquet(query: string): string {
  return retargetQuery(query, BENCH_PARQUET_DATASET)
}
