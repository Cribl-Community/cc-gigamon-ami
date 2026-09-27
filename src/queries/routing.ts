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

/**
 * Events two Lake destinations wrote, per five-minute bucket: `json_events`
 * for the one that writes `gigamon_ami`, `pq_events` for the one that writes
 * `gigamon_ami_pq`, each named by its cribl_metrics `output` label.
 */
export function completenessQuery(jsonOutputLabel: string, parquetOutputLabel: string): string {
  return (
    `dataset="cribl_metrics" | summarize json_events=${written(jsonOutputLabel)}, ` +
    `pq_events=${written(parquetOutputLabel)} by bin(_time, 5m) | sort by _time asc`
  )
}

/** Events each of the pack's two Lake destinations wrote, per five-minute bucket. */
export const COMPLETENESS_QUERY = completenessQuery(PACK_JSON_OUTPUT_LABEL, PACK_PARQUET_OUTPUT_LABEL)

// ── THE DEMO FEED: TEMPORARY, AND FOR THE PARITY RUNNER ONLY ────────────────
// Added 2026-09-27. On the owner's org no pack HTTP source sends anything yet,
// so the pack's two destinations write nothing and every window the parity
// runner checks with COMPLETENESS_QUERY would be skipped. A TEMPORARY global
// feed was deployed there instead (2026-09-27 00:38Z, that org's commit
// cb2b990): the global DataGen `in_gigamon_datagen` fans out through
// QuickConnect to `gigamon_lake` (JSON, `gigamon_ami`) and to
// `gigamon_ami_pq_demo_lake` (Parquet, `gigamon_ami_pq`, `_raw` removed).
// A global output is labelled `cribl_lake:<id>` (measured 2026-09-24, see
// ./stackIds.ts). `npm run parity:run -- --feed demo` proves windows complete
// on this pair; the app's router never does — it keeps the pack pair above.
//
// WHAT IT CANNOT SHOW: `gigamon_lake` is the global destination every global
// stack shares (the demo, and the Syslog and Raw HTTP stacks earlier releases
// created). Where anything else also writes through it — on another tenant, or
// on this one later — `json_events` counts more than the demo's Parquet copy
// was sent, the two columns disagree, and every window is refused: the safe
// way round. And, as for the pack pair, whether `total.out_events` counts an
// event the Parquet destination dropped is unmeasured.

/** The demo feed's JSON destination (global), as cribl_metrics labels it. */
export const DEMO_JSON_OUTPUT_LABEL = 'cribl_lake:gigamon_lake'

/** The demo feed's Parquet destination (global, TEMPORARY), as cribl_metrics labels it. */
export const DEMO_PARQUET_OUTPUT_LABEL = 'cribl_lake:gigamon_ami_pq_demo_lake'
