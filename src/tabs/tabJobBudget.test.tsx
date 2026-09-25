// How many search jobs each tab submits, held to a number written down here.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS GUARDING. Concurrent Cribl Search jobs from one user are
// admitted ~1.6 s apart, so every job a tab submits when it opens is a place in
// a queue the reader waits on. Phase 7 made accelerated panels read their
// schedule's stored result as an ARTIFACT — a plain GET of
// `/search/jobs/<runId>/results`, no job — so an accelerated panel should cost
// no queue position at all. Nothing counted that. A panel that quietly went back
// to submitting (its `accel` dropped, its `accelPanel` misspelt, a tail the
// artifact path cannot shape, a stub-shaped change in read.ts) still renders the
// same numbers, a little later, and every other test stays green.
//
// So every tab in the tab bar's TABS (src/app/tabs.tsx) is rendered here, inside the real <App/>, in
// Snapshot mode (the default), against ONE fetch stub that looks like a healthy
// workspace:
//
//   * the run history is ONE job table, and every page is a query of it that
//     honours the `filterExp`, `sortExp`/`sortDir`, `offset` and `limit` it is
//     sent — see `historyPage` below. It holds two completed runs of every
//     manifest entry (id `<entry>.<epoch>.<rand>`, `type: 'scheduled'`, the
//     shape Cribl gives a scheduled run), other teams' scheduled runs newer
//     than all of them, and a thousand ad-hoc jobs newer still. Scheduled jobs
//     are HIDDEN unless the filter asks for `type=='scheduled'`, which is what
//     the real endpoint does (measured 2026-09-21) — so a history read that
//     lost its type filter reads only ad-hoc jobs here, as it would there;
//   * the head page is exactly full before it reaches half of the hourly
//     entries (LAGGARDS), so those are answered by their own server-filtered
//     page and the rest by the head page — both paths run on every tab, and
//     each test checks which one answered;
//   * each run's artifact answers with rows carrying that entry's body columns,
//     every column its panels' tails read, and every column the panels declare
//     in `reads` — so the artifact path can shape every panel it can shape;
//   * a `$vt_results` job, if one is submitted, answers with the same rows, so
//     a panel that falls off the artifact path is counted ONCE, as the stored
//     read it is, and not again as a live fallback;
//   * the saved-search list holds every manifest entry exactly as this release
//     writes it, schedule ON — so accel/serving.ts reads every entry as
//     `scheduled`, through the same boot read main.tsx starts, and the budget
//     below is the one for a healthy workspace. The paused case is its own
//     describe at the bottom: a switched-off entry's panels run live, which is
//     what the switch's confirmation priced;
//   * KV, Lake, metrics and everything else answer harmlessly (a 404 on a KV
//     key is "nobody wrote it"; the Lake API answers with a 30-day retention).
//
// Every `POST …/search/jobs` is a submit, and each is identified — by the exact
// query a live panel runs, or by the schedule a stored read names — and compared
// with BUDGET below. The comparison is EQUALITY, in both directions: a new
// submit fails it, and so does a live panel that silently stopped submitting
// (it was either accelerated, which deserves its budget row deleted on purpose,
// or it stopped rendering, which deserves a look).
//
// ── ZERO JOBS IS NOT ENOUGH: THE PANELS MUST HAVE BEEN SERVED ───────────────
// A read path that hangs submits nothing either, and a tab of spinners passes
// a job count. So each tab also states how many of its `<Panel>`s show a dated
// stored run once it settles (`served`, read from the header's own snapshot
// census), and no panel may still say "Running search…" or have failed. A
// stored read that never answers fails here, not only a stored read that
// turned into a job.
//
// ── BELOW-THE-FOLD PANELS ARE COUNTED, DELIBERATELY ─────────────────────────
// `useNearViewport` defers a panel's query until it nears the viewport, and
// FAILS OPEN where `IntersectionObserver` does not exist: every panel runs at
// once. happy-dom has no IntersectionObserver today; this file removes it
// explicitly anyway, so the count cannot change under it if happy-dom ever
// grows one. What is counted is therefore a tab's WHOLE budget — everything it
// submits once the reader has scrolled it end to end — not its on-mount count,
// which is smaller (components/nearViewport.ts keeps that one).
//
// ── WHAT THIS FILE CANNOT ASSERT ────────────────────────────────────────────
//  • Time. There is no network here, so neither the ~1.6 s admission stagger
//    nor the artifact GET's own latency appears; a budget of zero jobs is a
//    claim about the queue, not about milliseconds.
//  • That a real workspace looks like this stub. A schedule that has never run,
//    a history the account cannot read, or a run still going sends panels down
//    the fallback path by design (accel/read.ts), and those tabs then submit
//    more than their budget. That is correct behaviour this file does not model.
//  • Jobs submitted by a click — drill-downs, Security's flow drill, TCP's cell
//    drill, Flow Map's per-service panels, Guided Setup's measurements. Nothing
//    is clicked here but a view switch (`views`), which must submit nothing;
//    each of those is `enabled` only on a selection.
//  • Live mode. Live runs every panel's own query by design; its cost is priced
//    on the mode control, not budgeted here.
//  • That a KPI tile was served from a stored run. The census counts `<Panel>`s
//    only; a tile is held by the checks that it is not still showing its "…"
//    and that nothing on the tab failed — a tile whose read hangs fails here —
//    not by `served`.
// ─────────────────────────────────────────────────────────────────────────────

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { DashboardProvider } from '../app/DashboardContext'
import { TABS } from '../app/tabs'
import { MANIFEST, accelSavedSearch, columnsOf, resolvedManifest, type AccelEntry, type AccelId, type AccelSavedSearch } from '../cribl/accel/manifest'
import { accelServing, forgetAccelServing, loadAccelServing } from '../cribl/accel/serving'
import { lakeWindow } from '../queries/lakeWindow'
import { METRICS_QUERY } from '../queries/dataFlow'
import { PRESENCE_QUERY } from '../queries/fieldExplorer'
import { resetAccelKeyMemo } from '../cribl/accel/read'
import { HEAD_LIMIT, cronIntervalMs } from '../cribl/accel/status'
import { resetSelectedSnapshot } from '../cribl/accel/selection'
import { dataMode } from '../cribl/dataMode'
import { summariseRows, type Row } from '../cribl/search'
import { resetSnapshotCensus, useSnapshotCensus, type SnapshotCensus } from '../components/snapshotCensus'
import { SOURCES } from '../queries/security'
import { buildTrendQuery, latencyQuery } from '../queries/tcpHealth'
import { SERVERS, PQC_BY_SERVER } from '../queries/tlsPosture'
import { SERVERS_Q, GROUPS_Q } from '../queries/pqcReadiness'

// ── The budget ──────────────────────────────────────────────────────────────

/** One job a tab is allowed to submit, and why it has not been accelerated. */
interface Allowed {
  /** The panel, in the words its heading uses. */
  panel: string
  /** The exact query the panel runs, as the tab imports it (for a stored read
   *  that submits a job, `accelReadQuery(id)` — none is budgeted today).
   *  Matched after search.ts's `set …;` execution prefixes are removed. */
  query: string
  why: string
}

const live = (panel: string, query: string, why: string): Allowed => ({ panel, query, why })

const NOT_IN_MANIFEST = 'no scheduled search serves it — the manifest has no entry for this query'

interface TabBudget {
  /** How many of the tab's `<Panel>`s show a dated stored run once it has
   *  settled — the header census's numerator, not its denominator. KPI tile
   *  rows are not `<Panel>`s and are not in it (snapshotCensus.ts). */
  served: number
  /** Every job the tab may submit. */
  jobs: readonly Allowed[]
  /** A view the tab switches to with a button of this label, and `served` once
   *  it is showing. Switching may submit nothing: the reads already ran. */
  views?: Readonly<Record<string, number>>
}

/**
 * Every job each tab submits when opened and scrolled, with nothing clicked,
 * and how many of its panels are served from a stored run meanwhile.
 *
 * An empty `jobs` list is the claim "every panel on this tab that has a
 * schedule is served from a stored artifact". Adding a row is a decision to put
 * a job back in the reader's queue and needs its reason; deleting one should
 * follow a panel gaining a schedule — and `served` then rises by one.
 */
const BUDGET: Readonly<Record<string, TabBudget>> = {
  '/findings': { served: 1, jobs: [] },
  '/security': {
    // Its stored read, the overview scan, is drawn together with the live
    // fan-out query in both MITRE panels, so each is captioned live (the worse
    // of its parts — mergeSnapshotStates); the third panel waits on a click.
    served: 0,
    jobs: [live('Top sources by fan-out', SOURCES, NOT_IN_MANIFEST)],
  },
  '/flow-map': { served: 1, jobs: [] },
  '/capacity': { served: 3, jobs: [] },
  '/tcp-health': {
    served: 1,
    jobs: [
      live('Trend (default metric: resets)', buildTrendQuery('resets'), `${NOT_IN_MANIFEST}. Below the fold, so deferred on a real screen`),
      live('Latency', latencyQuery, `${NOT_IN_MANIFEST}. Below the fold, so deferred on a real screen`),
    ],
  },
  '/dns-health': { served: 1, jobs: [] },
  '/web-api': { served: 5, jobs: [] },
  '/tls-posture': {
    served: 0,
    jobs: [
      live('TLS servers', SERVERS, NOT_IN_MANIFEST),
      live('PQC groups by server', PQC_BY_SERVER, NOT_IN_MANIFEST),
    ],
  },
  '/pqc': {
    served: 0,
    jobs: [
      live('Servers', SERVERS_Q, NOT_IN_MANIFEST),
      live('Supported groups', GROUPS_Q, NOT_IN_MANIFEST),
    ],
  },
  '/ai-saas': { served: 3, jobs: [] },
  '/data-flow': { served: 2, jobs: [] },
  '/fields': {
    // The default view is AMI coverage, whose family panels are drawn from the
    // stored presence scan but carry no snapshot caption of their own; the one
    // captioned panel, Fields, is on the In feed view — see `views`.
    served: 0,
    views: { 'In feed': 1 },
    // Its field summaries are computed from the newest run's artifact in the
    // browser (readAccelFieldSummaries), so the tab submits nothing.
    jobs: [],
  },
  // Neither reads a stored run: no panel on them has a schedule.
  '/reference': { served: 0, jobs: [] },
  '/setup': { served: 0, jobs: [] },
}

// ── The workspace ───────────────────────────────────────────────────────────

const HOUR = 3_600_000
const NOW = Date.now()

function res(status: number, body: unknown, asText?: string) {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => asText ?? JSON.stringify(body),
  }
}

const ndjson = (rows: readonly Row[]) =>
  [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n')

const MINUTE = 60_000

/** Entries the head page is expected to hold: those firing at least hourly. */
const HOURLY = MANIFEST.filter((e) => {
  const every = cronIntervalMs(e.cron)
  return every !== null && every <= HOUR
})
/** Half of the hourly entries, placed where the head page does not reach, so
 *  their newest run comes from their own server-filtered page. */
const LAGGARDS = new Set<AccelId>(HOURLY.filter((_, i) => i % 2 === 1).map((e) => e.id))
const LEADERS = HOURLY.filter((e) => !LAGGARDS.has(e.id))
/** Other teams' scheduled runs, newer than every run of ours: exactly enough
 *  that the head page fills up on them and the leaders' newest runs. */
const FOREIGN = HEAD_LIMIT - LEADERS.length

/** When an entry's newest run finished. Leaders newest, laggards after them,
 *  anything slower than hourly (the daily Lake total) older still. */
function newestAt(e: AccelEntry): number {
  const i = MANIFEST.indexOf(e)
  if (LAGGARDS.has(e.id)) return NOW - HOUR - 10 * MINUTE - i * 1000
  if (HOURLY.includes(e)) return NOW - HOUR + i * 1000
  return NOW - 5 * HOUR - i * 1000
}

interface JobRow {
  id: string
  type: 'scheduled' | 'adhoc'
  status: string
  earliest?: string
  timeCreated: number
  timeStarted: number
  timeCompleted: number
}

const jobRow = (id: string, type: JobRow['type'], at: number, earliest?: string): JobRow => ({
  id,
  type,
  status: 'completed',
  earliest,
  timeCreated: at,
  timeStarted: at,
  timeCompleted: at,
})

/** A scheduled run's job id, in the shape Cribl gives one. */
const runIdAt = (e: AccelEntry, at: number) => `${e.id}.${at}.aB3dE9`
/** The id of an entry's newest run. */
const runIdOf = (e: AccelEntry) => runIdAt(e, newestAt(e))

/** The whole job table. Two runs per entry — the newest and the one an hour
 *  before it — so a page is a real choice between them, not a single row. */
const JOBS: readonly JobRow[] = [
  ...MANIFEST.flatMap((e) => [
    jobRow(runIdOf(e), 'scheduled', newestAt(e), e.earliest),
    jobRow(runIdAt(e, newestAt(e) - HOUR), 'scheduled', newestAt(e) - HOUR, e.earliest),
  ]),
  ...Array.from({ length: FOREIGN }, (_, k) => jobRow(`other_team_search.${NOW - 30 * MINUTE + k}.zZ9yY8`, 'scheduled', NOW - 30 * MINUTE + k)),
  ...Array.from({ length: 1000 }, (_, k) => jobRow(`${NOW - 5 * MINUTE + k}.adhoc${k}`, 'adhoc', NOW - 5 * MINUTE + k)),
]
const RUN_ENTRY = new Map<string, AccelEntry>(
  MANIFEST.flatMap((e) => [
    [runIdOf(e), e],
    [runIdAt(e, newestAt(e) - HOUR), e],
  ]),
)

/**
 * One page of the job list, the way the endpoint answers it: filtered by the
 * `filterExp` it was sent, sorted, then cut by `offset` and `limit`.
 *
 * Only the two clause shapes status.ts sends are understood, joined by `&&`;
 * anything else is a 500, which is what the real endpoint answers for an
 * expression it cannot parse. A filter with no `type` clause does NOT see
 * scheduled runs — the endpoint hides them by default.
 */
function historyPage(url: string): { status: number; items: JobRow[] } {
  const params = new URL(url, 'http://stub').searchParams
  let type: string | null = null
  const prefixes: string[] = []
  for (const clause of (params.get('filterExp') ?? '').split('&&').map((c) => c.trim()).filter(Boolean)) {
    const t = /^type\s*==\s*'(\w+)'$/.exec(clause)
    const p = /^id\.startsWith\('([^']*)'\)$/.exec(clause)
    if (t) type = t[1]
    else if (p) prefixes.push(p[1])
    else return { status: 500, items: [] }
  }
  const sortBy = (params.get('sortExp') ?? 'timeCreated') as keyof JobRow
  const dir = params.get('sortDir') === 'asc' ? 1 : -1
  const limit = Number(params.get('limit') ?? 100)
  const offset = Number(params.get('offset') ?? 0)
  const items = JOBS
    .filter((j) => (type === null ? j.type !== 'scheduled' : j.type === type))
    .filter((j) => prefixes.every((pre) => j.id.startsWith(pre)))
    .sort((a, b) => dir * ((a[sortBy] as number) - (b[sortBy] as number)))
    .slice(offset, offset + limit)
  return { status: 200, items }
}

/** Split on commas outside parentheses. */
function topLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of text) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * The group-by keys of a body's last `summarize` — the string-valued columns.
 * tail.ts compares types strictly (a number never equals a string), so a key
 * stored as a number would make every `where app_name in (…)` tail refuse, and
 * the panel would leave the artifact path for a reason no workspace produces.
 */
function stringColumnsOf(body: string): Set<string> {
  const last = body.split('|').map((s) => s.trim()).filter((s) => s.startsWith('summarize')).pop() ?? ''
  const by = / by (.*)$/.exec(last)?.[1] ?? ''
  return new Set(
    topLevel(by)
      .map((k) => /^([A-Za-z_]\w*)\s*=/.exec(k)?.[1] ?? k)
      .filter((k) => /^[A-Za-z_]\w*$/.test(k) && k !== '_time'),
  )
}

/** The first literal a tail filters a column on, so the stored rows survive it. */
function literalFor(e: AccelEntry, col: string): string | undefined {
  for (const p of e.panels) {
    const m = new RegExp(`\\b${col}\\s*(?:in\\s*\\(|==)\\s*"([^"]*)"`).exec(p.tail ?? '')
    if (m) return m[1]
  }
  return undefined
}

/** A sampled flow record, for the entry whose body keeps raw events. */
const RAW_FIELDS: Row = { src_ip: '10.0.0.1', dst_ip: '10.0.0.2', app_name: 'dns', dst_port: 53, protocol: 17 }

/** Two stored rows with every column this entry's body, tails and panels name. */
function rowsFor(e: AccelEntry): Row[] {
  const cols = new Set<string>(columnsOf(e.body).outputs ?? [])
  for (const p of e.panels) {
    if (p.tail) for (const c of columnsOf(p.tail, cols).inputs) cols.add(c)
    for (const c of p.reads) cols.add(c)
  }
  const strings = stringColumnsOf(e.body)
  return [0, 1].map((i) => ({
    ...(cols.size === 0 ? RAW_FIELDS : {}),
    ...Object.fromEntries(
      [...cols].map((c) => [c, strings.has(c) ? (i === 0 ? (literalFor(e, c) ?? `${c}-a`) : `${c}-b`) : 5 + i]),
    ),
  }))
}

/** What `$vt_results` hands back: the stored rows, virtual columns and all. */
const vtRows = (e: AccelEntry): Row[] =>
  rowsFor(e).map((r) => ({ ...r, jobId: runIdOf(e), jobName: e.id, dataset: '$vt_results' }))

/** The schedule a `$vt_results` selector names, by id, display name or run id. */
function entryNamedBy(query: string): AccelEntry | undefined {
  const sel = /\$vt_results"\s+job(?:Name|Id)="([^"]+)"/.exec(query)?.[1]
  return MANIFEST.find((e) => sel === e.id || sel === e.name || sel === runIdOf(e))
}

let submits: string[] = []
/** The entry each server-filtered history page asked for. */
let ownPages: string[] = []
/** Which history pages ANSWERED with each entry's newest run: `head` (the
 *  HEAD_LIMIT page), `own` (that entry's server-filtered page) or `full`. A
 *  page that was asked for and came back empty answers nothing. */
let answeredBy = new Map<string, Set<'head' | 'own' | 'full'>>()
/** The entry of each artifact read — each stored read that submitted no job. */
let artifactReads: string[] = []

/** Every entry as this release writes it, resolved against the stub's 30-day
 *  Lake — what `readAccelState` will compare the list with. */
let SAVED: AccelSavedSearch[] = []
beforeAll(async () => {
  SAVED = await Promise.all(resolvedManifest(lakeWindow(30, 30)).map((e) => accelSavedSearch(e)))
})
/** Entries whose schedule the saved-search list reports as switched off. */
let paused = new Set<AccelId>()

function stub(): void {
  submits = []
  ownPages = []
  answeredBy = new Map()
  artifactReads = []
  const jobs = new Map<string, AccelEntry | null>()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    if (method === 'POST' && /\/search\/jobs$/.test(u)) {
      const { query } = JSON.parse(String(init.body)) as { query: string }
      submits.push(query)
      const id = `job-${submits.length}`
      jobs.set(id, entryNamedBy(query) ?? null)
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/lakes/default/datasets')) {
      return res(200, {
        items: [
          { id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: { currentSizeBytes: 110_519_717_848, metricsDate: '2026-09-22' } },
          { id: 'cribl_metrics', retentionPeriodInDays: 30, metrics: {} },
        ],
      })
    }
    if (method === 'GET' && u.includes('/search/saved')) {
      const items = SAVED.map((s) => ({ ...s, schedule: { ...s.schedule, enabled: !paused.has(s.id as AccelId) } }))
      return res(200, { items, count: items.length, totalCount: items.length })
    }
    const sub = /\/search\/jobs\/([^/?]+)\/([a-z-]+)/.exec(u)
    if (sub) {
      const id = decodeURIComponent(sub[1])
      const kind = sub[2]
      if (kind === 'status') return res(200, { items: [{ status: 'completed' }] })
      // A scheduled run's own artifact, read by run id: its stored rows.
      const artifact = RUN_ENTRY.get(id)
      const submitted = jobs.get(id)
      const rows = artifact ? rowsFor(artifact) : submitted ? vtRows(submitted) : []
      if (artifact && kind === 'results') artifactReads.push(artifact.id)
      if (kind === 'results') return res(200, {}, ndjson(rows))
      if (kind === 'field-summaries') return res(200, summariseRows(rows))
      return res(404, { message: 'not stubbed' })
    }
    if (u.includes('/search/jobs?')) {
      const only = /startsWith\('([a-z0-9_]+)\.'\)/.exec(new URL(u, 'http://stub').searchParams.get('filterExp') ?? '')?.[1]
      if (only) ownPages.push(only)
      const page = historyPage(u)
      const kind = only ? 'own' : Number(new URL(u, 'http://stub').searchParams.get('limit')) === HEAD_LIMIT ? 'head' : 'full'
      for (const j of page.items) {
        const e = RUN_ENTRY.get(j.id)
        if (e && j.id === runIdOf(e)) answeredBy.set(e.id, (answeredBy.get(e.id) ?? new Set()).add(kind))
      }
      return page.status === 200 ? res(200, { items: page.items }) : res(page.status, { message: 'bad filter' })
    }
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) {
      const row = JOBS.find((j) => j.id === decodeURIComponent(byId[1]))
      return row ? res(200, { items: [row] }) : res(404, { message: 'gone' })
    }
    return res(404, { message: 'not stubbed' })
  })
}

// ── Rendering ───────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

const settle = async (turns: number) => {
  for (let i = 0; i < turns; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

// THE MODULE CACHES. The run-history pages (status.ts), the per-run artifact
// cache (read.ts) and the Lake facts (lakeWindowRead.ts) are module-level and
// would otherwise carry one tab's reads into the next — every run id here is
// stable across tests, so only the first tab to read a run would ever fetch it
// and the rest would depend on test order. src/vitest.setup.ts drops all three
// before EVERY test in the suite (`forgetRunHistory`, `forgetArtifacts`,
// `forgetLakeFacts`), and a setup file's hooks run before this file's own
// beforeEach; they are not repeated here. What that hook does not own is reset
// below.

// THE TAB MODULES. Every tab but the landing one is a lazy chunk
// (src/app/tabs.tsx), so rendering one is a real module import — transformed on
// first use, inside the test that renders it. Under a busy full-suite run that
// import alone has taken longer than a test's 5 s, and when it outlasts the
// turn count in `renderAt` instead, the tab mounts after the count is read.
// Load every tab here, once, through the tab bar's own `preload`, so each test
// times the tab's reads and not its module. (`preload` swallows a failed
// import; a tab that cannot load still fails its test, on the render.)
beforeAll(async () => {
  await Promise.all(TABS.map((t) => t.preload?.()))
}, 60_000)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // See the header: no observer means no deferral, so the whole tab is counted.
  vi.stubGlobal('IntersectionObserver', undefined)
  resetSelectedSnapshot()
  resetSnapshotCensus()
  resetAccelKeyMemo()
  paused = new Set()
  stub()
  // What main.tsx starts at boot. vitest.setup.ts dropped the last test's
  // verdicts; every entry reads `scheduled` against this stub.
  void loadAccelServing()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  census = null
})

afterEach(async () => {
  act(() => root.unmount())
  // Let the unmounted tab's aborted reads finish against THIS stub, so none of
  // them lands in the next tab's count.
  await settle(5)
  container.remove()
  resetSelectedSnapshot()
  resetSnapshotCensus()
  resetAccelKeyMemo()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The header's own snapshot census, as the mode control reads it. */
let census: SnapshotCensus | null = null
function CensusProbe() {
  census = useSnapshotCensus()
  return null
}

async function renderAt(path: string): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <DashboardProvider>
          <App />
          <CensusProbe />
        </DashboardProvider>
      </MemoryRouter>,
    )
  })
  // Generous: the mode hydrates, the history is read, artifacts download, a
  // fallback would submit, poll and read. A job that has not been submitted by
  // now is not one this budget can see.
  await settle(40)
}

const EXEC_PREFIX = /^(?:set [^;]+;\s*)+/

/** Which budget row a submitted query is, or a line saying it is none. */
function identify(tab: string, submitted: string): string {
  const query = submitted.replace(EXEC_PREFIX, '')
  const row = BUDGET[tab]?.jobs.find((a) => a.query === query)
  return row ? row.panel : `UNBUDGETED ${query.slice(0, 140)}`
}

// ── The gate ────────────────────────────────────────────────────────────────

describe('the job budget covers every tab', () => {
  it('has one row per tab in the tab bar’s TABS, and no row for a tab that is gone', async () => {
    // The tab bar is rendered from TABS (src/app/tabs.tsx), so its links ARE
    // the list, as the viewer sees it. A tab added without a budget row fails here, before anything
    // else can quietly skip it.
    await renderAt('/reference')
    const routes = [...container.querySelectorAll('nav.tab-bar a')].map((a) => a.getAttribute('href'))
    expect(routes.length).toBeGreaterThan(0)
    expect(routes).toEqual(Object.keys(BUDGET))
  })
})

describe('the workspace this gate reads', () => {
  it('splits the hourly entries between the head page and their own pages', () => {
    // If every entry fitted on the head page, the filtered-page path would
    // never run here; if none did, the head path would not. Both must.
    expect(LEADERS.length).toBeGreaterThan(0)
    expect(LAGGARDS.size).toBeGreaterThan(0)
    expect(FOREIGN).toBeGreaterThan(0)
  })

  it('reads every schedule as on and running this release’s query', async () => {
    // Otherwise the budget above would be for `unknown` verdicts — the
    // behaviour before accel/serving.ts — and say nothing about a healthy
    // workspace read the way the app reads it.
    await loadAccelServing()
    expect(MANIFEST.map((e) => [e.id, accelServing(e.id)])).toEqual(MANIFEST.map((e) => [e.id, 'scheduled']))
  })
})

describe('jobs each tab submits in Snapshot mode, opened and scrolled', () => {
  for (const [tab, { served, jobs: allowed, views = {} }] of Object.entries(BUDGET)) {
    it(`${tab}: ${allowed.length === 0 ? 'no job' : `exactly ${allowed.length} job${allowed.length === 1 ? '' : 's'}`}, ${served} panel${served === 1 ? '' : 's'} served from a stored run`, async () => {
      expect(dataMode(), 'this budget is for Snapshot mode, the default').toBe('snapshot')
      await renderAt(tab)

      // A tab that crashed submits nothing, and would pass an empty budget.
      expect(container.textContent).not.toContain('This view hit an error')
      expect(container.querySelector('.app-main')?.textContent?.trim() ?? '').not.toBe('')

      const expected = allowed.map((a) => a.panel).sort()
      expect(submits.map((s) => identify(tab, s)).sort()).toEqual(expected)

      // SERVED, NOT MERELY QUIET. A read path that hangs submits nothing too.
      const settled = (where: string) => {
        const main = container.querySelector('.app-main')?.textContent ?? ''
        expect(main, `${where}: a panel is still waiting on its read`).not.toContain('Running search…')
        expect(main, `${where}: a panel’s read failed`).not.toMatch(/Search failed|Search stopped/)
        // A KPI tile says it is loading with an ellipsis for a value, not a spinner.
        const waiting = [...container.querySelectorAll('.kpi')]
          .filter((k) => k.querySelector('.kpi-value')?.textContent?.trim().startsWith('…'))
          .map((k) => k.querySelector('.kpi-label')?.textContent?.trim())
        expect(waiting, `${where}: a KPI tile is still waiting on its read`).toEqual([])
      }
      settled(tab)
      expect(census?.snapshotted, 'panels showing a dated stored run').toBe(served)

      for (const [label, n] of Object.entries(views)) {
        const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
        expect(button, `no "${label}" button on ${tab}`).toBeDefined()
        await act(async () => { button!.click() })
        await settle(40)
        settled(`${tab} → ${label}`)
        expect(census?.snapshotted, `panels showing a dated stored run on ${label}`).toBe(n)
        expect(submits.map((s) => identify(tab, s)).sort(), `switching to ${label} submitted a job`).toEqual(expected)
      }

      // A tab that submits nothing and reads a stored run must show one: a
      // zero-job tab whose census never rises is a read that went nowhere.
      if (allowed.length === 0 && artifactReads.length > 0) {
        expect(Math.max(served, ...Object.values(views)), `${tab} reads stored runs and serves no panel from them`).toBeGreaterThan(0)
      }

      // WHICH HISTORY PAGE ANSWERED. Every hourly entry this tab read as an
      // artifact had its newest run IN THE RESPONSE of the page the stub put it
      // on: the head page for a leader (and no page of its own asked for), its
      // own filtered page for a laggard. Asking is not answering: a filtered
      // page that lost its `type=='scheduled'` clause is still requested, comes
      // back empty (the endpoint hides scheduled runs), and status.ts falls
      // through to the full page — so the run is still found, the panel still
      // served, and only this check sees that the small page never worked. A
      // stub that ignored `limit` would hand every entry to the head.
      const read = new Set(artifactReads)
      for (const e of HOURLY) {
        if (!read.has(e.id)) continue
        const want = LAGGARDS.has(e.id) ? 'own' : 'head'
        expect(
          answeredBy.get(e.id)?.has(want) ?? false,
          `${e.id}: newest run not answered by ${want === 'own' ? 'its own filtered page' : 'the head page'} (answered by: ${[...(answeredBy.get(e.id) ?? [])].join(', ') || 'nothing'})`,
        ).toBe(true)
        if (want === 'head') expect(ownPages.includes(e.id), `${e.id}: a leader asked for its own page`).toBe(false)
      }
    })
  }
})

// ── A SWITCHED-OFF SCHEDULE ─────────────────────────────────────────────────
// Review 2026-09-24, defect 1. The switches and Pause say the panels they feed
// "go back to their live queries" and price exactly that; until accel/serving.ts
// the panels went on reading the paused schedule's last run for days, under
// "check the schedule". This is the budget for that state, on the tab that
// motivated the phase: both of Data Flow's Cribl-side figures paused, both run
// live — no more, and not as stored reads.
describe('a paused schedule’s panels run live', () => {
  it('/data-flow with its pipeline and Lake schedules paused: exactly those two live queries', async () => {
    act(() => root.unmount())
    paused = new Set<AccelId>(['gno_pipeline_c1h', 'gno_lake_30d_c1d'])
    // The boot read in beforeEach saw the healthy list; this one sees the pause.
    forgetAccelServing()
    void loadAccelServing()
    root = createRoot(container)
    await renderAt('/data-flow')
    const lakeQuery = lakeWindow(30, 30)!.query
    const strip = (q: string) => q.replace(EXEC_PREFIX, '')
    expect(submits.map(strip).sort()).toEqual([METRICS_QUERY, lakeQuery].sort())
    const main = container.querySelector('.app-main')?.textContent ?? ''
    expect(main, 'a paused schedule’s panel told the reader to check the schedule').not.toContain('schedule overdue')
    // Neither the diagram (its Cribl half is live) nor the Lake card is a dated
    // stored run any more.
    expect(census?.snapshotted).toBe(0)
  })

  it('/fields with its presence schedule paused: exactly that one live query', async () => {
    // Field Explorer reads through accel/read.ts without useSearch, so it has
    // to ask the same question on its own.
    act(() => root.unmount())
    paused = new Set<AccelId>(['gno_presence_c1h'])
    forgetAccelServing()
    await loadAccelServing()
    root = createRoot(container)
    await renderAt('/fields')
    expect(submits.map((q) => q.replace(EXEC_PREFIX, ''))).toEqual([PRESENCE_QUERY])
  })
})
