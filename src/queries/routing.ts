// The one query the Phase 8 query router needs of its own: whether the Parquet
// copy holds every record the JSON copy holds, over a window.
//
// ── WHY A ROUTED PANEL NEEDS THIS AT ALL ────────────────────────────────────
// The pack writes each event twice — to `gigamon_ami` (JSON) and to
// `gigamon_ami_pq` (Parquet) — and the Parquet destination is configured with
// `onBackpressure: drop` (pack outputs.yml), so that a slow Parquet writer never
// stalls the JSON copy. What `drop` DOES is unmeasured; if it does what it says,
// `_pq` can have holes by design, and a panel read from it would under-count
// with nothing on screen to say so (Phase 8 design §5, R1). So before a live
// panel reads `_pq` over a window, Stream's own counters must show the two
// destinations wrote the same number of events in every bucket of it.
//
// ── NOT RUN TODAY ───────────────────────────────────────────────────────────
// No query is routed to Parquet in this release (cribl/routing/table.ts), so
// nothing submits this. It is here, frozen, so the check a future routing
// change depends on is a reviewed string rather than one written in a hurry.
// Its cost is UNMEASURED: a `cribl_metrics` search is not cheap (a 48-hour
// "no rows" read measured ~2,000 CPU-s, 2026-09-24), which is why its verdicts
// are cached per bucket (cribl/routing/completeness.ts).
//
// ── HOW cribl_metrics NAMES A PACK'S OUTPUTS (measured) ─────────────────────
// Inside a pack an output is labelled `cribl_lake:<packId>.<outputId>`, e.g.
// `cribl_lake:cc-network-gigamon-ami.gigamon_ami_parquet_lake`. The ids come
// from src/cribl/pack.ts, never retyped. Pipeline labels inside a pack are
// UNMEASURED, and nothing here depends on them.
//
// WHAT IT CANNOT SHOW: that `total.out_events` counts a dropped event as not
// sent (unmeasured — if a dropped event is still counted, a hole is invisible
// here), and that `gigamon_ami` holds nothing but the pack's JSON copy (an
// install that also feeds it from Guided Setup's global stack has more in JSON
// than the pack wrote, and this compares only the pack's two outputs).

import { PACK_ID, PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID } from '../cribl/pack'

/** The pack's JSON destination, as cribl_metrics labels it. */
export const PACK_JSON_OUTPUT_LABEL = `cribl_lake:${PACK_ID}.${PACK_JSON_OUTPUT_ID}`

/** The pack's Parquet destination, as cribl_metrics labels it. */
export const PACK_PARQUET_OUTPUT_LABEL = `cribl_lake:${PACK_ID}.${PACK_PARQUET_OUTPUT_ID}`

/**
 * The bucket the verdicts are kept at, in seconds. Five minutes: small enough
 * that one hole refuses little, large enough that a counter row landing a few
 * seconds either side of a bucket edge is noise inside it. Judgement.
 */
export const COMPLETENESS_BUCKET_SECONDS = 300

const written = (label: string) => `sum(iif(metric=="total.out_events" and namespace=="data_insights" and output=="${label}", value, 0))`

/** Events each of the pack's two Lake destinations wrote, per five-minute bucket. */
export const COMPLETENESS_QUERY =
  `dataset="cribl_metrics" | summarize json_events=${written(PACK_JSON_OUTPUT_LABEL)}, ` +
  `pq_events=${written(PACK_PARQUET_OUTPUT_LABEL)} by bin(_time, 5m) | sort by _time asc`
