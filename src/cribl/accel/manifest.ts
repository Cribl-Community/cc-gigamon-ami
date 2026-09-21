// What Phase 2 schedules, as data — one list, read by everything that touches a
// scheduled search.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A LIST AND NOT TWO LINES AT TWO CALL SITES.
//
// Phase 2 replaces two live queries with two saved searches that run on a cron,
// and then reads the stored result. That one sentence creates five places that
// have to agree about the same two objects:
//
//   • the apply path, which POSTs them;
//   • the teardown, which DELETEs them — and must delete ours and nobody else's;
//   • the status table, which says whether each one exists, is enabled, and
//     when it last ran;
//   • the read path, which asks `$vt_results` for a run BY NAME;
//   • config/policies.yml and src/cribl/paths.ts, which declare the grant.
//
// Written as literals at each of those sites, that is five hand-kept lists, and
// the failure mode is not a crash. A customer ends up with a scheduled search
// running every hour that nothing in the app can see, name, pause or remove —
// billing them, with the app's own id on it, for a panel that stopped reading it
// three releases ago. Nobody notices, because everything still renders.
//
// So the list is the object. A new entry is one record here; the apply, the
// teardown, the status table and the read path all iterate it.
//
// ── THE BODIES ARE IMPORTED, NEVER RESTATED ─────────────────────────────────
// `body` comes from src/queries/*, by import. That is the whole honesty of this
// phase in one line: a panel's ⓘ shows the query behind its number, and after
// Phase 2 that number comes from a scheduled run rather than a live one. The ⓘ
// stays truthful only while the thing that ran IS the string the ⓘ shows. Retype
// the query here and the two drift the first time somebody edits one of them —
// silently, because both still run and both still return a number.
//
// The dependency points this way and only this way: src/queries/* is loaded
// under plain Node by scripts/extract-queries.mjs, so nothing there may import
// anything that reaches a .tsx. This module imports FROM those modules, which is
// free. Do not make them import from this one.
//
// ── ONE BODY, SEVERAL PANELS: WHAT REPLACED `display` ───────────────────────
// The first two entries were one search per panel, and manifest.test.ts asserted
// `display === body` — the single thing standing between a scheduled body and
// the ⓘ that claims it produced the number. The hourly entries are one scan
// serving five panels on five tabs, and no union body can satisfy that
// assertion. It was loosened DELIBERATELY, and this is what replaced it.
//
// `serves` is now a list of records — `{ queryId, what, display, tail, reads }`.
// `display` moved off the entry and onto the record, because there is one ⓘ per
// panel and they are different strings; `tail` is the KQL that cuts that panel's
// row out of the shared result; `reads` is the columns the panel then looks at.
// Together they are a chain, and `columnsOf` below lets a test walk it
// mechanically: every alias a tail touches exists in the body, and every column
// a panel reads is one its tail emits. That is strictly MORE than `display ===
// body` checked — it caught nothing about tails, and `read.ts` has had a `tail`
// option nothing digested since Phase 2.
//
// What a test cannot check is that the body's `total` means the same thing as
// the panel's `total`. src/queries/snapshots.ts carries that argument in prose,
// beside the strings it is about.
//
// The description below still carries two digests, and they answer the same two
// questions:
//
//   body-sha256     what the saved search actually runs.
//   display-sha256  every string that decides what a panel claims and reads —
//                   the served records, digested together.
//
// So an operator who finds one of these in their workspace can still tell
// whether the app that claims it is running the same thing. What they lose, and
// it is a real loss: on a five-panel entry the display digest says *something*
// among the five moved, not which. The app's own Acceleration panel lists them.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// No fetch, no capi, no KV. This module is a description of two objects; the
// modules that create, remove, read and report them own their own failure modes.
// It stays importable by a test, by the teardown and by a panel without any of
// them dragging a transport in.
// ─────────────────────────────────────────────────────────────────────────────

import { APP_VERSION } from '../config'
import { LAKE_TOTAL_QUERY, METRICS_QUERY, VOLUME_AGGS, VOLUME_QUERY } from '../../queries/dataFlow'
import { FEED_SAMPLE_QUERY, PRESENCE_QUERY } from '../../queries/fieldExplorer'
import { KPI_AGGS as CAPACITY_KPI_AGGS, buildKpiQuery } from '../../queries/capacityTopTalkers'
import { KPI_AGGS as WEB_KPI_AGGS, KPI as WEB_KPI_QUERY } from '../../queries/webApiHealth'
import { COUNT_AGGS as SECURITY_COUNT_AGGS, COUNTS as SECURITY_COUNTS_QUERY } from '../../queries/security'
import { FINDING_AGGS, FINDINGS_QUERY } from '../../queries/findings'
import { nodesQuery } from '../../queries/serviceMap'
import { AI_FILTER, aiOverallQuery, aiUsersQuery, appsQuery } from '../../queries/shadowAi'
import { OVERALL as DNS_OVERALL_QUERY, PER_RESOLVER as DNS_PER_RESOLVER_QUERY } from '../../queries/dnsHealth'
import { APP_SRC_SNAPSHOT_QUERY, DNS_RESOLVER_SNAPSHOT_QUERY, OVERVIEW_SNAPSHOT_QUERY, SERVICE_EDGES_SNAPSHOT_QUERY } from '../../queries/snapshots'

/**
 * The manifest's own version, stamped into every saved search's description.
 *
 * It is not the app version and does not move with it. It moves when the SHAPE
 * of what gets written changes — a new schedule field, a different id scheme —
 * so an operator looking at a search created by an older release can tell that
 * it was written to a different contract, rather than inferring it from an app
 * version that also changes for a CSS fix.
 */
export const MANIFEST_VERSION = 2

/**
 * Every id this app may own in a customer's `/search/saved`, as a type.
 *
 * A union rather than `string`, because the teardown, the status table and the
 * read path all key on these, and a typo in one of them should be a build error
 * rather than a saved search nothing reads.
 */
export type AccelId =
  | 'gno_lake_30d_c1d'
  | 'gno_sample_2m_c1h'
  | 'gno_overview_c1h'
  | 'gno_svc_nodes_c1h'
  | 'gno_svc_edges_c1h'
  | 'gno_presence_c1h'
  | 'gno_app_src_c1h'
  | 'gno_dns_resolver_c1h'
  | 'gno_pipeline_c1h'

/**
 * The shape ids take, and the ONLY thing that tells this app's scheduled
 * searches apart from every other saved search in the workspace.
 *
 * Saved searches at `/search/saved` are a flat, shared namespace: an admin's own
 * work, other apps' work, and ours, in one list. There is no owning-app field to
 * filter on. So the teardown's entire claim to be safe is that it only ever
 * DELETEs an id matching this pattern AND present in MANIFEST below — prefix
 * first, because a bug in the manifest must still not reach somebody else's
 * search. Widening this regex widens what an uninstall can destroy.
 */
const ACCEL_ID = /^gno_[a-z0-9_]+$/

/** Whether an id in the workspace's saved-search list is one this app writes. */
export function isAccelId(id: string): boolean {
  return ACCEL_ID.test(id)
}

/** One panel this entry's single scan answers for. */
export interface AccelServed {
  /** Stable handle for this panel, in the description's digest and in the app's
   *  own acceleration table. Not shown to a customer. */
  readonly queryId: string
  /** The panel, in the words that panel uses. An admin deciding whether to pause
   *  the schedule needs to know what goes dark. */
  readonly what: string
  /** The query this panel's ⓘ shows for the number the run feeds. */
  readonly display: string
  /**
   * KQL appended to the stored-result selector, cutting this panel's row out of
   * a body several panels share. Absent when the body IS the panel's query.
   *
   * It is inside the display digest, which it was not in Phase 2: a tail
   * projecting the wrong alias renders a DIFFERENT NUMBER under a
   * correct-looking ⓘ — no error, no fallback, nothing on screen to notice.
   */
  readonly tail?: string
  /** The columns the panel reads off the row the tail emits. Declared so a test
   *  can walk body → tail → panel and fail on a column that stops existing. */
  readonly reads: readonly string[]
}

/** One scheduled search: what it runs, when, and on whose behalf. */
export interface AccelEntry {
  readonly id: AccelId
  /** The title Cribl's Saved Searches list shows. Prefixed so an operator
   *  scanning that list sees ours grouped, the way the id does for the code. */
  readonly name: string
  /** Every panel this one scan answers for, in reading order. */
  readonly panels: readonly AccelServed[]
  /** The same list as one line of prose, for the admin surfaces. Derived by
   *  `entry()` below rather than typed, so it cannot describe a panel the
   *  schedule stopped serving. */
  readonly serves: string
  /** The query the schedule runs. Imported from src/queries — see the header. */
  readonly body: string
  /** The job window. On the sample entry this is NOT the live panel's window,
   *  and that difference is deliberately here rather than in the query text:
   *  changing the text would change what the ⓘ claims. */
  readonly earliest: string
  readonly latest: string
  /** Unix cron, five fields, read in `tz`. */
  readonly cron: string
  /** IANA zone. UTC on every entry: a schedule read in a local zone moves twice
   *  a year, and a 30-day total that skips or repeats an hour is a number nobody
   *  can reconcile against the Lake. */
  readonly tz: string
  /** How many past runs stay readable. This is the read path's whole margin: at
   *  `keepLastN: 1` a run that starts while a panel is reading leaves the panel
   *  with nothing, because a running job's results are not readable. */
  readonly keepLastN: number
  /** Why this one exists, in the terms the admin approving it cares about —
   *  what it costs today and what it costs scheduled. */
  readonly why: string
}

/**
 * How a single scan's output columns are read out of KQL text.
 *
 * DELIBERATELY NOT A KQL PARSER, for the same reason `cronIntervalMs` is not a
 * cron library: it reads the handful of shapes this manifest uses and is honest
 * about the rest. What it exists for is the chain a union body creates —
 * body → tail → the columns a panel reads — which nothing checked before, and
 * which is where a wrong number hides. `manifest.test.ts` walks it.
 *
 * `inputs` is every identifier the fragment reads and does NOT itself produce —
 * the set a tail has to find in the body. `outputs` is what it leaves behind.
 * A clause that is not `summarize`, `extend`, `project`, `where`, `sort` or
 * `limit` makes `outputs` null — "this code cannot say", which the test treats
 * as a failure rather than a pass, because a silent pass is exactly what a
 * loosened assertion must not become.
 */
export interface Columns {
  inputs: Set<string>
  outputs: Set<string> | null
}

/** Identifiers that are KQL, not columns. */
const KQL_WORDS = new Set([
  'summarize', 'project', 'extend', 'where', 'sort', 'by', 'asc', 'desc', 'limit', 'and', 'or', 'not', 'in', 'true', 'false', 'null',
])

/**
 * The right-hand side of each `alias=expr` term, so the alias itself is not
 * counted as a column the clause READS.
 *
 * Without this, `summarize out=sum(flows) by src` looks like it reads a column
 * called `out` — which the body does not produce, and the check would fail on a
 * correct tail. A test that fails on correct code gets loosened, and a loosened
 * check is how this whole assertion stopped being worth anything the first time.
 */
function expressions(text: string): string {
  return topLevelCommas(text)
    .map((term) => term.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/, ' '))
    .join(', ')
}

/** Every bare identifier in an expression: quoted strings removed, anything
 *  immediately followed by `(` treated as a function name rather than a column. */
function identifiers(text: string): string[] {
  const noStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/'(?:[^'\\]|\\.)*'/g, ' ')
  const out: string[] = []
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(\(?)/g
  let m
  while ((m = re.exec(noStrings)) !== null) {
    if (m[2] === '(') continue
    if (KQL_WORDS.has(m[1])) continue
    out.push(m[1])
  }
  return out
}

/** Split on commas that are not inside parentheses. */
function topLevelCommas(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** The alias each `name=expr` term defines, in order. A term with no `=` is not
 *  an alias — it is a bare column, which `project` and `by` both allow. */
export function aliasesOf(aggregates: string): string[] {
  return topLevelCommas(aggregates)
    .map((term) => /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(term)?.[1])
    .filter((a): a is string => a !== undefined)
}

/** `by` split off a summarize clause, at paren depth zero. */
function splitBy(clause: string): { aggs: string; keys: string } {
  let depth = 0
  for (let i = 0; i < clause.length - 3; i++) {
    const c = clause[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /\s/.test(c) && clause.slice(i + 1, i + 4) === 'by ') {
      return { aggs: clause.slice(0, i), keys: clause.slice(i + 4) }
    }
  }
  return { aggs: clause, keys: '' }
}

/**
 * What a KQL fragment reads, and what columns it leaves behind.
 *
 * `carried` is the column set flowing in — the body's output, when the fragment
 * being read is a tail. `project` and `summarize` replace it, `extend` adds to
 * it, and `where`, `sort` and `limit` pass it through.
 *
 * With no `carried`, the first `|`-segment is treated as the head
 * (`dataset="…" foo=*`) and skipped: it filters rows, and this function is about
 * columns.
 */
export function columnsOf(kql: string, carried?: Set<string>): Columns {
  const inputs = new Set<string>()
  let outputs: Set<string> | null = carried ? new Set(carried) : new Set()
  // Read against what is available WHERE THE CLAUSE SITS, not against the
  // columns the fragment started with: `| summarize out=… | sort by out` reads a
  // column the fragment produced a moment earlier, and counting that as an input
  // would fail a correct tail. A check that fails on correct code gets loosened,
  // and a loosened check is how the assertion this replaces came to be worth
  // nothing.
  const reads = (text: string) => {
    for (const id of identifiers(text)) if (!outputs || !outputs.has(id)) inputs.add(id)
  }
  const segments = kql.split('|').map((s) => s.trim())
  for (const seg of segments.slice(carried === undefined ? 1 : 0)) {
    const verb = /^([A-Za-z]+)\b/.exec(seg)?.[1] ?? ''
    const rest = seg.slice(verb.length).trim()
    if (verb === 'summarize') {
      const { aggs, keys } = splitBy(rest)
      reads(expressions(aggs))
      reads(expressions(keys))
      outputs = new Set([...aliasesOf(aggs), ...topLevelCommas(keys).map((k) => aliasesOf(k)[0] ?? k)])
    } else if (verb === 'project') {
      reads(expressions(rest))
      outputs = new Set(topLevelCommas(rest).map((t) => aliasesOf(t)[0] ?? t))
    } else if (verb === 'extend') {
      reads(expressions(rest))
      if (outputs) for (const a of aliasesOf(rest)) outputs.add(a)
    } else if (verb === 'where' || verb === 'sort' || verb === 'limit') {
      reads(rest)
    } else if (seg.length > 0) {
      outputs = null
    }
  }
  return { inputs, outputs }
}

/**
 * Build one entry, deriving what can be derived.
 *
 * `serves` is composed from the panels rather than typed beside them, so the
 * sentence an admin reads before pausing a schedule cannot name a panel the
 * schedule stopped answering for. Freezing happens here too: five entries each
 * carrying its own `Object.freeze` is five chances to forget one, and the
 * teardown, the status table and the read path all hold these objects.
 */
function entry(e: Omit<AccelEntry, 'serves'>): AccelEntry {
  return Object.freeze({
    ...e,
    panels: Object.freeze(e.panels.map((p) => Object.freeze(p))),
    serves: e.panels.map((p) => p.what).join(' · '),
  })
}

/** A tail keeping exactly the aliases a fragment of the shared body defines.
 *  Composed from the same fragment the body is, so a tail cannot come to
 *  disagree with the body about which columns exist. */
const projectionOf = (aggregates: string, extra: readonly string[] = []): string =>
  '| project ' + [...extra, ...aliasesOf(aggregates)].join(', ')

const CAPACITY_KPI_COLUMNS = aliasesOf(CAPACITY_KPI_AGGS)
const WEB_KPI_COLUMNS = aliasesOf(WEB_KPI_AGGS)
const SECURITY_COUNT_COLUMNS = aliasesOf(SECURITY_COUNT_AGGS)
const FINDING_COLUMNS = aliasesOf(FINDING_AGGS)
const VOLUME_COLUMNS = aliasesOf(VOLUME_AGGS)

/**
 * THE NINE ENTRIES.
 *
 * Five when this comment was written, and the count is deliberately not the
 * heading's point — it went five → six → nine in two days and a number in prose
 * is the first thing to rot. What holds is the division below, which is the only
 * thing a reader needs before adding a tenth.
 *
 * `gno_lake_30d_c1d` and `gno_sample_2m_c1h` replace a live query this workspace
 * measured as expensive, and are judged by that saving.
 *
 * Every hourly snapshot after them does something those two do not, and it
 * changes the bar they have to clear: they make a question ANSWERABLE. "What did
 * the network look like at 04:00?" has no price today — a live query only ever
 * reads now, and the range picker only widens a window that still ends now.
 * Twenty-four retained runs of an hourly scan are a day of past states a viewer
 * can move between. So these are not judged by a saving: each one costs roughly
 * 40 CPU-s an hour whether or not anybody opens the tab, and `why` says what it
 * buys.
 *
 * The later ones add a third argument the first hourly three did not make. One
 * scan can serve several panels — the overview carries five across five tabs,
 * Shadow AI's grouping carries that whole tab, the DNS grouping carries both of
 * that tab's mount queries — and where it does, the saving is not one query
 * replaced by a cheaper one but N replaced by one. That is why the grouping of a
 * shared body is load-bearing in a way a single-panel body's never is: it has to
 * be fine enough that every panel can recompute its own figure from the stored
 * rows. src/queries/snapshots.ts carries that argument beside the strings.
 */
// NAME CHARACTER SET, measured 2026-09-18 against a live workspace, NOT documented.
// Cribl refuses a saved search whose `name` does not match /^[a-zA-Z0-9 _-]+$/ —
// letters, digits, space, underscore, hyphen. `openapi.json` (4.19.0) does not say
// so: `SavedQuery.name` is a bare { type: 'string', description: 'Display name…' }
// with no `pattern`. Two of these names originally carried a middle dot and
// parentheses, both POSTs were refused with a schema error naming the pattern, and
// nothing was created.
//
// So the rule the rest of this repo follows — check the spec before you send a body —
// was followed here and was not enough. The spec is not the contract; the server is.
// Keep the `GNO ` prefix (an operator scans the shared Saved Searches list by it, and
// manifest.test.ts pins it) and keep every other character inside that class.
export const MANIFEST: readonly AccelEntry[] = Object.freeze([
  entry({
    id: 'gno_lake_30d_c1d',
    name: 'GNO Lake total 30 days',
    panels: [
      {
        queryId: 'data-flow-lake-total',
        what: 'Data Flow — Lake total (1 tile)',
        display: LAKE_TOTAL_QUERY,
        reads: ['total_events', 'total_bytes'],
      },
    ],
    body: LAKE_TOTAL_QUERY,
    earliest: '-30d',
    latest: 'now',
    // 00:10 UTC rather than 00:00: the minute-of-hour at submit is what the cost
    // model is a function of (A-SP0), and the top of the hour is also when every
    // other scheduled thing in a workspace fires.
    cron: '10 0 * * *',
    tz: 'UTC',
    // Two, so a reader arriving while today's run is still going still has
    // yesterday's to show. One would be a daily window of blankness.
    keepLastN: 2,
    why:
      "Data Flow's 30-day Lake total is the most expensive query this app runs: 9,297.7 billable CPU-s a run, 15–24 runs a day, because it sums thirty days of Stream write counters and every viewer's first paint asks for it again. The figure it produces changes once a day at most. Run once at 00:10 UTC, the tile reads that run's stored result for about 0.2 CPU-s.",
  }),
  entry({
    id: 'gno_sample_2m_c1h',
    name: 'GNO Feed sample 2 minutes',
    panels: [
      {
        queryId: 'field-explorer-in-feed',
        what: 'Field Explorer — In feed (field summaries)',
        display: FEED_SAMPLE_QUERY,
        // Field summaries are computed over whatever the read job returned, so
        // there is no projection and no fixed column list: the panel reads the
        // fields that are in the sample, which is the question it asks.
        reads: [],
      },
    ],
    body: FEED_SAMPLE_QUERY,
    // -5m…-3m, and it used to be -4m…-2m. TWO things are still landing at the
    // young end, not one. The current minute's prefix is being written, and
    // under the Lake landing profile this app provisions a file stays open for
    // up to 120 seconds before it flushes — so roughly half the old window sat
    // in data that had not arrived yet. The panel answers which of ~319 fields
    // are arriving, and a half-empty sample under-reports that: wrong in the one
    // direction a viewer cannot detect, on the one question the panel exists for.
    // Three minutes clears the flush with a minute to spare, and the window
    // keeps its two-minute length (estimate.test.ts pins it).
    earliest: '-5m',
    latest: '-3m',
    cron: '7 * * * *',
    tz: 'UTC',
    // Three: hourly runs mean a reader can be up to an hour behind the newest
    // one, and two would leave no slack if a run fails.
    keepLastN: 3,
    why:
      "Field Explorer's 'In feed' browser costs 754.9 CPU-s every time somebody opens the tab, to answer which of the ~319 AMI fields are actually arriving. It is a 5,000-row sample, so it was never reading the whole window anyway. One run an hour over a settled two-minute window answers the same question, and the visit reads the stored rows.",
  }),
  entry({
    id: 'gno_overview_c1h',
    name: 'GNO Overview hourly',
    panels: [
      {
        queryId: 'capacity-kpi',
        what: 'Capacity and top talkers — the six KPI tiles',
        // The unfiltered form, which is the only one this can serve: the filter
        // a viewer types becomes part of the query text, and no stored result
        // holds a row for a filter nobody had typed when the scan ran. The
        // builder answers the same string for all three pivots while the filter
        // is empty, so one call covers the state the tab opens in.
        display: buildKpiQuery('src_ip', ''),
        tail: projectionOf(CAPACITY_KPI_AGGS),
        reads: CAPACITY_KPI_COLUMNS,
      },
      {
        queryId: 'web-kpi',
        what: 'Web and API health — the three KPI tiles',
        display: WEB_KPI_QUERY,
        tail: projectionOf(WEB_KPI_AGGS),
        reads: WEB_KPI_COLUMNS,
      },
      {
        queryId: 'security-technique-counts',
        what: 'Security — the flow-signal technique counts',
        display: SECURITY_COUNTS_QUERY,
        tail: projectionOf(SECURITY_COUNT_AGGS),
        reads: SECURITY_COUNT_COLUMNS,
      },
      {
        queryId: 'findings-counts',
        what: 'Findings — the detection counts',
        display: FINDINGS_QUERY,
        // `findings_total`, not `total`: the shared body cannot define `total`,
        // because Capacity's tiles above already mean sum(total_bytes) by that
        // name. See the alias rule in src/queries/snapshots.ts — and note that
        // this projection is what makes it safe rather than merely documented,
        // because `total` is then not a column Findings could read at all.
        tail: projectionOf(FINDING_AGGS, ['findings_total']),
        reads: ['findings_total', ...FINDING_COLUMNS],
      },
      {
        queryId: 'data-flow-volume',
        what: 'Data Flow — records, bytes and packets in the window',
        display: VOLUME_QUERY,
        tail: projectionOf(VOLUME_AGGS),
        reads: VOLUME_COLUMNS,
      },
    ],
    body: OVERVIEW_SNAPSHOT_QUERY,
    // -18m…-3m: fifteen minutes of data, ending clear of the 120-second file
    // flush. The length matters less than the end — a window running up to `now`
    // reports a partial last minute as a whole one.
    earliest: '-18m',
    latest: '-3m',
    // :20 — the only submit minute inside A-SP0's measured domain (D = 18–20,
    // bracketed by its measured 20.00) rather than an extrapolation from it. It
    // also makes "the 08:20 snapshot" literally true on screen, which is what a
    // reader picking a past state is choosing.
    cron: '20 * * * *',
    tz: 'UTC',
    // TWENTY-FOUR, and this is the number that makes the snapshot picker real.
    // Phase 2's rule was that a keepLastN larger than what the code reads is a
    // promise the code does not keep — and the code read exactly one run, the
    // newest. It now reads any of them: components/SnapshotPicker.tsx lists the
    // retained runs and a viewer picks one. A day of them, hourly, is what "show
    // me 04:20" needs, and it sits well inside Cribl's 7-day result retention,
    // so the schedule bounds the timeline rather than the platform quietly doing
    // it first and leaving a picker full of times that read as empty.
    keepLastN: 24,
    why:
      'Five panels on five tabs each open with their own unfiltered whole-window scan: the Capacity tiles, the Web and API tiles, the Security technique counts, the Findings counts and the Data Flow volume figures. One scan an hour carries all five, and each panel reads its own columns out of the stored row. It also gives those five a past — twenty-four retained runs mean a viewer can ask what the tiles said at 04:20, which no live query can answer at any price.',
  }),
  entry({
    id: 'gno_svc_nodes_c1h',
    name: 'GNO Service map nodes',
    panels: [
      {
        queryId: 'service-map-nodes',
        what: 'Service map — the graph nodes',
        display: nodesQuery,
        // No tail: the body IS the panel's query, sort and limit included. The
        // multi-panel machinery is not used where it would buy nothing.
        reads: ['dst_aws_flat_tags_name', 'app', 'app_n', 'dns', 'dns_n', 'resets', 'flows'],
      },
    ],
    body: nodesQuery,
    earliest: '-18m',
    latest: '-3m',
    // :21, a minute after the overview, so the three hourly scans queue instead
    // of competing — concurrent jobs from one account are admitted about 1.6 s
    // apart, and one cron minute would start all three against each other.
    cron: '21 * * * *',
    tz: 'UTC',
    keepLastN: 24,
    why:
      'Service map is the default route, so it is what "opening the app in the morning" actually means. Its graph is three scans of the window before anything is on screen. This one is the node query verbatim, run hourly — and it is what lets the map show a past state rather than only the last fifteen minutes.',
  }),
  entry({
    id: 'gno_svc_edges_c1h',
    name: 'GNO Service map edges',
    // ONE PANEL, AND IT USED TO BE TWO. The entry served `service-map-edges`
    // and `service-map-sources` — two records, two tails, and therefore TWO
    // STORED READS on the app's default route, because read.ts submits a
    // `$vt_results` job per served panel (its KEY_MEMO caches the read key, not
    // the rows). One scan was being asked for twice.
    //
    // The two tails were `| where dst_svc != "" | sort by flows desc | limit 40`
    // and `| summarize out=sum(flows) by src_aws_flat_tags_name | sort by out
    // desc | limit 20`. Both are now done in ServiceMap.tsx over the rows of a
    // single un-tailed read — which the tab was already half doing, since its
    // external-peer spokes have always been arithmetic over the edge rows.
    //
    // This cost nothing and bought a whole read on the route every arrival lands
    // on. It also made the ⓘ claim STRONGER rather than weaker: `display` is now
    // the body, run verbatim, so this entry is back inside the Phase 2 promise
    // that a served panel shows the string that produced its number. In Live
    // mode the tab submits this same body once instead of two narrower scans.
    panels: [
      {
        queryId: 'service-map-edges',
        what: 'Service map — the edges between services and the per-source outbound totals',
        display: SERVICE_EDGES_SNAPSHOT_QUERY,
        // No tail: the panel reads the whole grouping and cuts both of its own
        // views out of it. The sentinel group the body's `extend` creates is
        // what makes that safe — see src/queries/snapshots.ts. Dropping the
        // untagged destinations server-side would take the client-only totals
        // with it, short, with nothing on screen to say so.
        reads: ['src_aws_flat_tags_name', 'dst_svc', 'flows'],
      },
    ],
    body: SERVICE_EDGES_SNAPSHOT_QUERY,
    earliest: '-18m',
    latest: '-3m',
    cron: '22 * * * *',
    tz: 'UTC',
    keepLastN: 24,
    why:
      "The other two scans behind Service map's graph — the edges and the per-source outbound totals — out of one grouping, read once. With the node entry this takes the app's default route to no live queries at all on arrival, and gives the whole map a day of past states.",
  }),

  entry({
    id: 'gno_presence_c1h',
    name: 'GNO Field presence 15 minutes',
    panels: [
      {
        queryId: 'field-explorer-presence',
        what: 'Field Explorer — AMI field coverage (which fields are arriving)',
        display: PRESENCE_QUERY,
        // No tail. The body IS the answer: one row of `c0…cN` counts, read
        // positionally against CHECK_FIELDS. See the alias note below.
        reads: [],
      },
    ],
    body: PRESENCE_QUERY,
    // Fifteen minutes of data ending three minutes back — the same shape the
    // other hourly entries use, and for the same two reasons. Three minutes
    // clears the 120 s flush this app's Lake landing profile sets, and fifteen
    // is what the app's default range shows, so the snapshot answers the same
    // question the default live view asks rather than a wider or narrower one.
    //
    // A LONGER window would find more of the rare fields this panel exists to
    // notice — the query counts over the whole window precisely so that
    // something like ssl_issuer is not missed the way a sample would miss it —
    // and it costs linearly: ~39 CPU-s at fifteen minutes against ~156 at an
    // hour, on A-SP0's measured 2.6 CPU-s per data-minute. Fifteen is chosen so
    // the stored answer and the live answer mean the same thing. If a field is
    // genuinely rare enough to miss in fifteen minutes, it is missing from the
    // live view too, and the panel should not quietly disagree with itself.
    earliest: '-18m',
    latest: '-3m',
    cron: '23 * * * *',
    tz: 'UTC',
    keepLastN: 24,
    why:
      "Field Explorer's coverage view answers which of the ~319 AMI fields are actually arriving, with one count() per field over the whole window — measured at 4.6 s on the live workspace, and the reason the tab still took eight seconds after its sample was accelerated. It is the second of that tab's two mount queries and the one a census of hooks never saw, because it calls runSearch directly.",
  }),

  entry({
    id: 'gno_app_src_c1h',
    name: 'GNO App by source 15 minutes',
    panels: [
      {
        queryId: 'shadow-ai-apps',
        what: 'Shadow AI — apps on the wire, and the known-SaaS list beside them',
        display: appsQuery,
        // The live query's `flows`, `bytes` and `users` for one app, rebuilt
        // from the (app, source) pairs. `users` is RECOMPUTED here rather than
        // summed — see the body's own comment: one row per pair means
        // dcount(src_ip) is the true distinct-source count, and a stored per-app
        // dcount could not be added up safely anywhere else on this entry.
        tail: '| summarize flows=sum(flows), bytes=sum(bytes), users=dcount(src_ip) by app_name | sort by flows desc | limit 90',
        reads: ['app_name', 'flows', 'bytes', 'users'],
      },
      {
        queryId: 'shadow-ai-overall',
        what: 'Shadow AI — the AI users, AI flows and AI bytes tiles',
        display: aiOverallQuery,
        // THE TILE THE GROUPING EXISTS FOR. `users` here is every distinct
        // source that reached ANY AI app, counted once. A body grouped by
        // app_name alone could only offer per-app counts for this tile to add
        // up, and anybody using two AI apps would be counted twice — high, in
        // the direction nobody can check, on the number the tab is named after.
        //
        // AI_FILTER is the same string the live query embeds, imported rather
        // than retyped, so adding a vendor to AI_APPS moves both together.
        tail: `| where ${AI_FILTER} | summarize users=dcount(src_ip), flows=sum(flows), bytes=sum(bytes)`,
        reads: ['users', 'flows', 'bytes'],
      },
      {
        queryId: 'shadow-ai-users',
        what: 'Shadow AI — the top AI users, with the app-diversity badge',
        display: aiUsersQuery,
        // `aiapps` is the badge beside each source, and it is exact for the same
        // reason: one stored row per (app, source), so counting distinct
        // app_name within a source counts each app once.
        tail: `| where ${AI_FILTER} | summarize aiflows=sum(flows), aiapps=dcount(app_name), bytes=sum(bytes) by src_ip | sort by aiflows desc | limit 15`,
        reads: ['src_ip', 'aiflows', 'aiapps', 'bytes'],
      },
    ],
    body: APP_SRC_SNAPSHOT_QUERY,
    // The house window, for the house reason: fifteen minutes is what the app's
    // default range shows, so the stored answer means the same thing as the live
    // one, and the run ends three minutes back to clear the 120 s file flush the
    // Lake landing profile sets.
    earliest: '-18m',
    latest: '-3m',
    // :36 — the audit's own minute for this entry, and well clear of the five
    // minutes already in use (:07, :20, :21, :22, :23). Jobs from one account
    // are admitted about 1.6 s apart, so entries that share a minute queue
    // behind each other instead of running.
    cron: '36 * * * *',
    tz: 'UTC',
    keepLastN: 24,
    why:
      'Shadow AI is the slowest tab in the app: three unfiltered whole-window scans on mount, none of them served, and the reader waits for all three because they are admitted about 1.6 s apart. One grouping by application and source carries all three — the app bar lists, the AI tiles and the top-AI-users table — and each panel re-aggregates the columns it needs out of the stored pairs. It also gives the tab a past: twenty-four retained runs mean somebody investigating an AI-usage spike can ask what it looked like at 04:36, which no live query answers at any price.',
  }),

  entry({
    id: 'gno_dns_resolver_c1h',
    name: 'GNO DNS resolvers',
    panels: [
      {
        queryId: 'dns-resolver-table',
        what: 'DNS health — the resolver table and the slowest-resolver tile',
        display: DNS_PER_RESOLVER_QUERY,
        // The head this replaces is `dns_host=*`. In the stored rows those rows
        // are the empty-string sentinel the body's `extend` created, so the
        // filter moves here and means exactly what it meant live. `dns_host` is
        // restored by name because that is what the row renderer reads — the
        // body could not group on it without losing the sentinel.
        //
        // AND THIS IS WHERE `limit 500` LIVES NOW. It is the panel's view of the
        // grouping, not a property of the scan: left in the body it would cap
        // the tiles above at the top 500 resolvers' worth of DNS as well.
        tail: '| where dns_h != "" | extend dns_host=dns_h | sort by total desc | limit 500',
        reads: ['dns_host', 'p50', 'noerr', 'sf', 'nx', 'total'],
      },
      {
        queryId: 'dns-overall',
        what: 'DNS health — the SERVFAIL / error-rate and distinct-resolver tiles',
        display: DNS_OVERALL_QUERY,
        // Summed across every group INCLUDING the sentinel, which is what
        // `app_name="dns" | summarize count()` does live. This is the panel the
        // body's `extend` exists for: drop the responses that name no resolver
        // and both this total and the failure rate over it come back short.
        //
        // `resolvers` is a COUNT OF ROWS, not a composed `dcount`. The body
        // emits one row per distinct resolver, so counting the non-sentinel ones
        // is the distinct count by definition — see src/queries/snapshots.ts for
        // why that is the honest way to serve this tile and why a summed
        // per-group `dcount` would not be.
        tail: '| summarize total=sum(total), noerr=sum(noerr), sf=sum(sf), nx=sum(nx), resolvers=sum(iif(dns_h != "", 1, 0))',
        reads: ['total', 'sf', 'nx', 'resolvers'],
      },
    ],
    body: DNS_RESOLVER_SNAPSHOT_QUERY,
    // The house window, for the house reasons: fifteen minutes is what the app's
    // default range shows, so the stored answer means the same thing as the live
    // one, and the run ends three minutes back to clear the 120 s file flush the
    // Lake landing profile sets.
    earliest: '-18m',
    latest: '-3m',
    // :33 — the audit's own minute for this entry. Clear of the block already in
    // use (:07, :20…:24) and of the Shadow AI scan at :36, because jobs from one
    // account are admitted about 1.6 s apart and entries sharing a minute queue
    // behind each other instead of running.
    cron: '33 * * * *',
    tz: 'UTC',
    keepLastN: 24,
    why:
      "DNS health is the longest wait in the app on open: two whole-window scans fire together and the reader waits for both, roughly 7-12 seconds. One grouping by resolver carries both — the resolver table and the three tiles above it — and each reads its own view out of the stored rows. The bigger prize is not the seconds. A percentile over a high-cardinality grouping is this app's most hang-prone shape, and the jobs that hang are the ones a viewer is sitting in front of; on a schedule a slow run costs a retained result rather than a blank tab. It also gives the tab a past: twenty-four retained runs mean somebody investigating a resolver that started failing can ask what it looked like at 04:33.",
  }),

  entry({
    id: 'gno_pipeline_c1h',
    name: 'GNO Pipeline telemetry',
    panels: [
      {
        queryId: 'data-flow-pipeline',
        what: 'Data Flow — the Cribl stage counters (source, pipeline, destination, blocked, backpressure)',
        display: METRICS_QUERY,
        // No tail: the body IS the panel's query, one row of six counters.
        reads: ['src_events', 'pipe_events', 'dst_events', 'dst_bytes', 'blocked', 'backpressure'],
      },
    ],
    body: METRICS_QUERY,
    // ── WHY THIS WINDOW, WHEN THE PANEL HAS NONE OF ITS OWN ──────────────────
    // METRICS_QUERY is the one query on this tab that simply follows the range
    // picker (DataFlow.tsx passes no `earliest`), so unlike the sample or the
    // Lake total there was no pinned window to copy. It is also a COUNTER SUM
    // rather than a scan: the window is not a sample of a population, it IS the
    // interval being counted, so halving it halves every figure on the diagram.
    //
    // -18m…-3m, and the fifteen minutes are chosen to match `gno_overview_c1h`
    // rather than for their own sake. The diagram's whole claim is that the
    // Cribl stages and the AMI records agree — that nothing is dropped between
    // source, pipeline, Lake and Search — and the records side of that
    // comparison is VOLUME_QUERY, served by the overview scan over exactly this
    // window. Serve the telemetry over a different length and the two sides stop
    // being comparable: the diagram would show a shortfall that is a window
    // difference and reads as loss.
    //
    // The three minutes are the same 120 s flush margin every other entry keeps,
    // and they matter here for a second reason: cribl_metrics counters for the
    // current minute are still being written, so a window ending at `now` counts
    // a partial minute as a whole one and under-reports the newest stage.
    earliest: '-18m',
    latest: '-3m',
    // :24, one minute after the presence scan and four after the overview one
    // whose numbers this entry's are read beside. That is the closest free
    // minute to it — the two windows then overlap in eleven of their fifteen
    // minutes rather than being identical, which is the price of not making two
    // schedules compete for the same admission slot. On a steady feed the
    // residual is noise; on a bursty one, a small difference between the records
    // side of the diagram and the telemetry side is that offset.
    cron: '24 * * * *',
    tz: 'UTC',
    keepLastN: 24,
    why:
      "The last live query on the Data Flow tab, and nobody proposed it before the coverage audit: the two figures beside it — the record-derived volumes and the 30-day Lake total — have been served since Phase 2, so this one query was what kept the whole diagram reporting LIVE and undated. It reads cribl_metrics rather than gigamon_ami, which gno_lake_30d_c1d has been doing on a schedule since Phase 2, so the mechanism is proven on this dataset. With it the tab reaches three of three, and the diagram gains a past: twenty-four retained runs mean an operator can ask whether the destination was blocked at 04:24 rather than only whether it is blocked now.",
  }),
])

/** The entry for an id. Throws rather than returning undefined: every caller
 *  here is asking about a search this app claims to own, and "no such entry" is
 *  a programming error, not a state to render. */
export function accelEntry(id: AccelId): AccelEntry {
  const found = MANIFEST.find((e) => e.id === id)
  if (!found) throw new Error(`accel manifest has no entry '${id}'`)
  return found
}

// ── The description an operator reads in Cribl's own UI ─────────────────────

/**
 * Line endings normalised before hashing.
 *
 * This repo is checked out on Windows with `core.autocrlf=true`, so the same
 * query string can reach a hash as `\r\n` on one machine and `\n` on another.
 * A digest that disagrees with itself across checkouts would report every
 * scheduled search as drifted — which cost six CI runs in Phase 1 to learn once
 * already.
 */
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

/**
 * First 12 hex characters of the SHA-256 of `text`.
 *
 * Web Crypto, not node:crypto: app code is type-checked without Node types and
 * runs in the browser. `crypto.subtle` exists only in a secure context, which
 * covers everywhere this app runs — installed over https, and the localhost dev
 * page, which browsers treat as secure.
 *
 * Twelve characters because this is an identity check a human performs by eye
 * against a description field, not a signature. It is not a defence against
 * anyone constructing a collision; nothing here is a security control.
 */
export async function shortSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lf(text)))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

/**
 * The `description` field of the saved search:
 *
 *   `GNO <appVersion> · manifest v1 · serves <id> · body-sha256:… · display-sha256:…`
 *
 * This is the only thing about the object that says who wrote it. An operator
 * who finds a scheduled search in their workspace and wants to know whether the
 * installed app still owns it reads this line, in Cribl's own UI, without the
 * app in front of them. It answers three questions in order: which app and which
 * release created it, which entry of that app's list it is, and whether the
 * query it is running is still the one that app intends to run and to show.
 *
 * `serves <id>` restates the saved search's own id, and does so on purpose: the
 * description travels — into a support ticket, a screenshot, a diff — where the
 * id beside it does not, and a line that identifies itself is worth the eleven
 * duplicated characters.
 *
 * Two digests rather than one because the body and the ⓘ are two claims; see the
 * header. Async because Web Crypto is, which makes every caller that writes a
 * saved search async too — they already are, since they are HTTP.
 */
export async function accelDescription(entry: AccelEntry): Promise<string> {
  const [body, display] = await Promise.all([shortSha256(entry.body), shortSha256(displayDigestInput(entry))])
  return `GNO ${APP_VERSION} · manifest v${MANIFEST_VERSION} · serves ${entry.id} · body-sha256:${body} · display-sha256:${display}`
}

/**
 * Every string that decides what a served panel claims and reads, as one text to
 * digest.
 *
 * Sorted by `queryId`, so reordering the list — which changes nothing about what
 * runs — does not report the workspace's search as drifted. The separator is a
 * NUL, which none of these strings can contain: joined on a character a query
 * could hold, two different manifests could hash the same.
 *
 * The tail is in here, and that is the point of the change. `read.ts` has taken
 * a `tail` since Phase 2 and nothing digested it, so a tail projecting the wrong
 * alias would have put a different number under a correct-looking ⓘ with no
 * error and no fallback anywhere.
 */
export function displayDigestInput(entry: AccelEntry): string {
  return [...entry.panels]
    .sort((a, b) => (a.queryId < b.queryId ? -1 : a.queryId > b.queryId ? 1 : 0))
    .map((p) => [p.queryId, p.display, p.tail ?? '', p.reads.join(',')].join(' '))
    .join('  ')
}

// ── The POST body ───────────────────────────────────────────────────────────

/**
 * The schedule sub-object, in full, every time.
 *
 * A-SP23, measured 2026-09-17 against this workspace: **the `schedule` object is
 * replaced wholesale, never merged.** A PATCH carrying `{enabled, cronSchedule}`
 * returned 200 and silently dropped `tz` and `keepLastN` — the one that decides
 * which hour it fires, and the one the read path's entire margin depends on.
 * The same PATCH carrying only the three schema-required fields (`id`, `name`,
 * `query`) returned 200 and deleted `schedule`, `earliest`, `latest` and
 * `description` outright, unscheduling the search forever with no error.
 *
 * So there is no such thing as a partial write here. Pause/Resume is
 * read-modify-write of the WHOLE body:
 *
 *   const cur = (await GET /search/saved/{id}).items[0]
 *   await PATCH /search/saved/{id} with { ...cur, schedule: { ...cur.schedule, enabled: false } }
 *
 * And there is nothing to make that safe with: the object carries no ETag, no
 * version and no createdAt, so two writers racing clobber each other silently
 * and neither can tell. That is a property of the endpoint, not something this
 * app can fix — the mitigation is that these writes only ever happen from a
 * confirmed click, one at a time.
 */
export interface AccelSchedule {
  enabled: boolean
  cronSchedule: string
  tz: string
  keepLastN: number
  /** 0, explicitly. Left unset the Leader applies its global jitter, which would
   *  move the submit minute — and the submit minute is the variable the cost
   *  model (A-SP0) is a function of. A fixed minute is a predictable bill. */
  jitterPercent: number
  /** False: a Leader that was down for six hours must not wake up and run six
   *  30-day Lake totals back to back. The panel wants the newest result, not
   *  every result it missed. */
  resumeMissed: boolean
  /** True: a run interrupted by a restart should finish, so the day's one
   *  expensive run is not simply lost until tomorrow. */
  resumeOnBoot: boolean
  /** Disabled. These runs feed a panel; nobody subscribed to them. */
  notifications: { disabled: boolean; items: unknown[] }
}

/**
 * Exactly the bytes this app POSTs to `/search/saved`.
 *
 * `user` and `displayUsername` are absent deliberately: A-SP23 found them
 * server-controlled — POST stamps them, and supplying a different value on a
 * later PATCH is silently discarded. Ownership of these searches belongs to
 * whoever pressed Apply and cannot be moved by the app.
 */
export interface AccelSavedSearch {
  id: string
  name: string
  query: string
  description: string
  earliest: string
  latest: string
  /** False: the searches are readable by the workspace, because the panel they
   *  feed is. A private saved search would serve only the admin who applied it,
   *  and every other viewer would silently get nothing. */
  isPrivate: boolean
  schedule: AccelSchedule
}

/**
 * Build the POST body. Pure and synchronous, taking the description it will
 * carry, so a test can assert the exact object without awaiting anything and a
 * caller that already computed a description does not compute it twice.
 *
 * Every field the saved search should have is named here, including the ones
 * whose values are the API's own defaults. That is the A-SP23 lesson written as
 * code: for this endpoint an omitted field is a deleted field, so "the default
 * is fine" and "the field is absent" are the same sentence, and the only way to
 * be sure what the object holds is to state all of it.
 */
export function accelPostBody(entry: AccelEntry, description: string): AccelSavedSearch {
  return {
    id: entry.id,
    name: entry.name,
    query: entry.body,
    description,
    earliest: entry.earliest,
    latest: entry.latest,
    isPrivate: false,
    schedule: {
      enabled: true,
      cronSchedule: entry.cron,
      tz: entry.tz,
      keepLastN: entry.keepLastN,
      jitterPercent: 0,
      resumeMissed: false,
      resumeOnBoot: true,
      notifications: { disabled: true, items: [] },
    },
  }
}

/** The same body with its description computed. What the apply path calls. */
export async function accelSavedSearch(entry: AccelEntry): Promise<AccelSavedSearch> {
  return accelPostBody(entry, await accelDescription(entry))
}
