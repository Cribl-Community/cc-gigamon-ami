// Every Cribl Search query the Lake landing panel runs.
//
// ── WHY THESE ARE HERE AND NOT IN cribl/landing.ts ──────────────────────────
// §2.4 of the acceleration plan puts this KQL in `src/cribl/landing.ts`, beside
// the computation. That was written before the freeze existed, and it cannot
// work: `scripts/extract-queries.mjs` resolves a constant only from
// `src/queries/*`, `src/data/*`, `cribl/config`, `cribl/search` and
// `lib/format` (its LOADABLE_RE), and a `<Panel query={…}>` pointing at anything
// else does not degrade — extraction THROWS, which fails `npm test`.
//
// So the choice was never "here or there". It was "here, or a panel whose ⓘ
// shows a query string that no gate is watching" — and CLAUDE.md's rule is
// already that every KQL string the app runs or shows lives in `src/queries/`.
// The three measurements below are the only KQL this phase adds, they are shown
// to the customer in an ⓘ, and they cost credits, which makes them exactly the
// strings a reviewer should be made to read a diff of. `cribl/landing.ts` keeps
// the non-KQL computation and imports from here.
//
// These strings are customer-visible: the ⓘ beside a measured value shows the
// query behind it, so the text IS the provenance of the figure on screen.
// Nothing here may be reformatted, requoted or reordered to tidy it up.
//
// Nothing here may import a .tsx or anything reaching one — the freeze loads
// this module under plain Node, which cannot parse JSX.
//
// ── EVERY QUERY BELOW RUNS FROM A BUTTON, NEVER A TIMER ─────────────────────
// They are measurements, not panel figures: each costs credits and each is
// rendered age-first with the time it was taken. Nothing in this app may put one
// on an interval — §1.4's no-spend-on-load rule, and the one a bill discovers
// rather than a test.
//
// The running-time cap is NOT written here. `cribl/search.ts#withExecPrefix`
// prefixes `set max_running_time_per_search=<n>; ` onto every job this app
// submits, sized by the window the job reads — so the `-5m` lag query lands in
// the 120-second tier of DEFAULT_CAP_TIERS and the wider partition-candidate
// window in whichever tier its range falls into. Writing a cap into these
// strings would put an execution directive into a customer-facing provenance
// claim, and would double up with the one search.ts already adds.

import { q } from '../cribl/search'
import { FINDINGS_QUERY } from './findings'
import { COUNTS } from './security'

// ── 1. Landing lag ──────────────────────────────────────────────────────────

/**
 * How far behind the newest record in the Lake dataset is.
 *
 * `n=count()` rides along because the lag alone cannot tell "nothing has landed
 * for eleven minutes" from "nothing has landed EVER": an empty window answers no
 * row at all, and a zero count is the honest distinction between a feed that has
 * stalled and a dataset nobody has written to yet.
 *
 * ≈35 billable CPU-s per press on the workspace this was sized against — one
 * third of the 102 CPU-s a 15-minute count measured (LIVE §7 job 2). That is the
 * basis of the button's "under 0.1 credits" label; it is a demo-feed figure and
 * the label is computed, never a literal.
 */
export const LANDING_LAG_QUERY = q('| summarize newest=max(_time), n=count() | extend lag_s=now()-newest')

/**
 * The window the lag query reads, and the reason it is this narrow.
 *
 * Five minutes is the smallest window that still answers the question. The lag
 * of a healthy feed is seconds, so a wider window buys nothing and costs
 * proportionally more — and a window wide enough to always find a row would
 * report a lag of "the oldest thing I looked at" on a dead feed, which reads as
 * healthy. When nothing landed in five minutes the right answer is no row, and
 * the panel says the feed is behind by at least the window.
 *
 * It also decides the cap: `capSecondsFor('-5m')` is the 120-second tier.
 */
export const LANDING_LAG_EARLIEST = '-5m'

// ── 2. Partition candidates ─────────────────────────────────────────────────

/**
 * The fields a Lake partition could be built on, and the short column key each
 * one reports under.
 *
 * FIXED AND LOW-CARDINALITY, deliberately. The obvious query is
 * `summarize count() by <field>`, and on this dataset that is the hang class:
 * a `by` on a high-cardinality AMI field is what produced the 24-hour jobs in
 * the measured digest. So the candidates are named in advance and each is
 * measured with a scalar pair — fill and distinct count — which is one pass and
 * no grouping at all.
 *
 * The keys are short because they become column names; `dst_aws_flat_tags_name`
 * as `n_dst_aws_flat_tags_name` is a column nobody can read in a result table.
 */
export const PARTITION_CANDIDATES: ReadonlyArray<{ field: string; key: string }> = Object.freeze([
  { field: 'protocol', key: 'protocol' },
  { field: 'l4_proto', key: 'l4_proto' },
  { field: 'app_name', key: 'app_name' },
  { field: 'ip_version', key: 'ip_version' },
  { field: 'dst_aws_flat_tags_name', key: 'dst_tag' },
  { field: 'src_aws_flat_tags_name', key: 'src_tag' },
  { field: 'src_workload_platform', key: 'platform' },
])

/**
 * Fill and distinct count for every candidate in one pass.
 *
 * Built from PARTITION_CANDIDATES rather than typed out, so a candidate cannot
 * be added to the list and left out of the measurement — the two would then
 * disagree in the direction nobody notices, with the panel rendering a blank
 * row for a field it claims to have measured.
 *
 * ≈100 billable CPU-s per press. `dcount()` and not `dc()`: see the KQL
 * reminders in cribl/search.ts's header.
 */
export const PARTITION_CANDIDATES_QUERY = q(
  '| summarize total=count(), ' +
    PARTITION_CANDIDATES.map(({ field, key }) => `n_${key}=count(${field}), d_${key}=dcount(${field})`).join(', '),
)

// ── 3. The parity triple ────────────────────────────────────────────────────
//
// Three queries run over ONE ABSOLUTE WINDOW before and after a read-path
// change, and compared row for row. All three are additive aggregations, so the
// rows must match exactly; anything else is the read path having changed the
// answer.
//
// The window is not part of these strings and must not become part of them. It
// is an absolute epoch pair chosen at the moment of the check, and it has to sit
// well behind the landing lag — objects still arriving inside the window change
// the answer between the two runs for reasons that have nothing to do with the
// read path (A-SP19's ≥99 %-complete-bin rule). A relative window baked in here
// would guarantee that failure and blame it on the reader.
//
// ≈100 billable CPU-s each, so ≈300 for a before-and-after pair × two sides.

/**
 * The cheapest of the three, and the one that fails first when the reader is
 * wrong: a flat count over the window.
 */
export const PARITY_COUNT_QUERY = q('| summarize c=count()')

/**
 * The Security tab's own flow-signal counts (Q29), read from where the tab
 * defines them.
 *
 * Imported rather than transcribed. The whole value of a parity check is that it
 * runs a query a customer actually looks at; a copy of Q29 in this file would go
 * on passing after the real Q29 changed, which is parity with a query nothing
 * renders.
 */
export const PARITY_SECURITY_QUERY = COUNTS

/** The Findings tab's detection counts (Q32), for the same reason. */
export const PARITY_FINDINGS_QUERY = FINDINGS_QUERY
