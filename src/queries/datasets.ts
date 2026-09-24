// The two Lake datasets a dashboard query can address, and the one rule that
// moves a query from the first to the second.
//
// Owner decision, 2026-09-24: the onboarding pack can feed SYNTHETIC sample
// flows (an opt-in DataGen) into a Lake dataset of their own. Never into
// `gigamon_ami` — Lake has no row delete, so a generated flow written into the
// customer's dataset could not be taken back out before retention expired.
//
// The app reads the sample dataset only while the customer's holds no data
// (cribl/datasetTarget.ts decides that), and moves back on its own once real
// data lands. Every query in this directory is written against `gigamon_ami`
// and stays that way: the frozen display snapshot is the customer's view, and
// the move is applied where a query leaves the app — the job body
// (cribl/search.ts), the ⓘ (components/PanelInfo.tsx), and the deep link and
// Copilot brief (cribl/config.ts).
//
// PURE, AND IMPORTS NOTHING. cribl/config.ts imports this module for its link
// helpers, and this module would otherwise need config's `LAKE_DATASET` — a
// cycle. So both names are literals here, and datasets.test.ts pins each one
// to the constant it duplicates (config.ts's LAKE_DATASET and pack.ts's
// PACK_SAMPLE_DATASET_ID).

/** The customer's dataset — what every query in src/queries is written against. */
export const REAL_DATASET = 'gigamon_ami'

/** Where the pack's opt-in sample DataGen writes. */
export const SAMPLE_DATASET = 'gigamon_ami_sample'

/**
 * Whether the customer's dataset holds any record at all — the one search the
 * sample-data decision may submit, and only when the Lake API's own size figure
 * cannot answer (cribl/datasetTarget.ts).
 *
 * Measured 2026-09-24 over 30 days: 0.08–0.38 billable CPU-s against an empty
 * dataset (the case it runs in), 41.6 against a populated one, where it runs at
 * most once a page load and its answer is then final. Written out rather than
 * built with `q()` for the reason in the header; the test pins it to `q('| limit 1')`.
 */
export const REAL_DATA_PROBE_QUERY = `dataset="${REAL_DATASET}" | limit 1`

/**
 * A dataset named in a query: `dataset="gigamon_ami"` in KQL, or
 * `dataset "gigamon_ami"` in the prose of a Copilot brief. The closing quote is
 * part of the match, so `gigamon_ami_pq` and a Stream id such as
 * `cribl_lake:gigamon_ami_json` are never touched.
 */
const SELECTOR = new RegExp(`(\\bdataset\\s*=\\s*|\\bdataset\\s+)"${REAL_DATASET}"`, 'g')

/**
 * The same query, addressing `dataset` instead of the customer's dataset.
 *
 * Idempotent, and the identity when `dataset` is the customer's. Nothing else in
 * the query changes: the sample dataset carries the same fields, so the same
 * aggregate means the same thing over it.
 */
export function retargetQuery(text: string, dataset: string): string {
  if (dataset === REAL_DATASET) return text
  return text.replace(SELECTOR, (_whole, lead: string) => `${lead}"${dataset}"`)
}
