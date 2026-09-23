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
// So every tab in App.tsx's TABS is rendered here, inside the real <App/>, in
// Snapshot mode (the default), against ONE fetch stub that looks like a healthy
// workspace:
//
//   * the run history — head page, per-entry filtered page, full page — holds
//     one completed run of every manifest entry, id `<entry>.<epoch>.<rand>`,
//     the shape Cribl gives a scheduled run;
//   * each run's artifact answers with rows carrying that entry's body columns,
//     every column its panels' tails read, and every column the panels declare
//     in `reads` — so the artifact path can shape every panel it can shape;
//   * a `$vt_results` job, if one is submitted, answers with the same rows, so
//     a panel that falls off the artifact path is counted ONCE, as the stored
//     read it is, and not again as a live fallback;
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
//    is clicked here; each of those is `enabled` only on a selection.
//  • Live mode. Live runs every panel's own query by design; its cost is priced
//    on the mode control, not budgeted here.
// ─────────────────────────────────────────────────────────────────────────────

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { DashboardProvider } from '../app/DashboardContext'
import { MANIFEST, columnsOf, type AccelEntry, type AccelId } from '../cribl/accel/manifest'
import { accelReadQuery, resetAccelKeyMemo } from '../cribl/accel/read'
import { forgetRunHistory } from '../cribl/accel/status'
import { resetSelectedSnapshot } from '../cribl/accel/selection'
import { dataMode } from '../cribl/dataMode'
import { summariseRows, type Row } from '../cribl/search'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import { SOURCES } from '../queries/security'
import { buildTrendQuery, latencyQuery } from '../queries/tcpHealth'
import { SERVERS, PQC_BY_SERVER } from '../queries/tlsPosture'
import { SERVERS_Q, GROUPS_Q } from '../queries/pqcReadiness'

// ── The budget ──────────────────────────────────────────────────────────────

/** One job a tab is allowed to submit, and why it has not been accelerated. */
interface Allowed {
  /** The panel, in the words its heading uses. */
  panel: string
  /** A live panel: the exact query it runs, as the tab imports it. A stored
   *  read: the `$vt_results` selector it submits. Matched after search.ts's
   *  `set …;` execution prefixes are removed. */
  query: string
  why: string
}

const live = (panel: string, query: string, why: string): Allowed => ({ panel, query, why })
const storedRead = (panel: string, id: AccelId, why: string): Allowed => ({ panel, query: accelReadQuery(id), why })

const NOT_IN_MANIFEST = 'no scheduled search serves it — the manifest has no entry for this query'

/**
 * Every job each tab submits when opened and scrolled, with nothing clicked.
 *
 * An empty list is the claim "every panel on this tab is served from a stored
 * artifact". Adding a row is a decision to put a job back in the reader's queue
 * and needs its reason; deleting one should follow a panel gaining a schedule.
 */
const BUDGET: Readonly<Record<string, readonly Allowed[]>> = {
  '/findings': [],
  '/security': [
    live('Top sources by fan-out', SOURCES, NOT_IN_MANIFEST),
  ],
  '/flow-map': [],
  '/capacity': [],
  '/tcp-health': [
    live('Trend (default metric: resets)', buildTrendQuery('resets'), `${NOT_IN_MANIFEST}. Below the fold, so deferred on a real screen`),
    live('Latency', latencyQuery, `${NOT_IN_MANIFEST}. Below the fold, so deferred on a real screen`),
  ],
  '/dns-health': [],
  '/web-api': [],
  '/tls-posture': [
    live('TLS servers', SERVERS, NOT_IN_MANIFEST),
    live('PQC groups by server', PQC_BY_SERVER, NOT_IN_MANIFEST),
  ],
  '/pqc': [
    live('Servers', SERVERS_Q, NOT_IN_MANIFEST),
    live('Supported groups', GROUPS_Q, NOT_IN_MANIFEST),
  ],
  '/ai-saas': [],
  '/data-flow': [],
  '/fields': [
    storedRead(
      'In the feed (field summaries)',
      'gno_sample_2m_c1h',
      'ACCELERATED, AND STILL A JOB. readAccelFieldSummaries has no artifact path for the newest run: it submits a ' +
        '`$vt_results` job so Cribl’s /field-summaries endpoint can summarise it. The picked-moment path already ' +
        'summarises an artifact client-side (summariseRows); the newest-run path does not yet',
    ),
  ],
  '/reference': [],
  '/setup': [],
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

/** A scheduled run's job id, in the shape Cribl gives one. */
const runIdOf = (e: AccelEntry) => `${e.id}.${NOW - HOUR}.aB3dE9`

const runRow = (e: AccelEntry) => ({
  id: runIdOf(e),
  status: 'completed',
  earliest: e.earliest,
  timeCreated: NOW - HOUR,
  timeStarted: NOW - HOUR,
  timeCompleted: NOW - HOUR,
})

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

function stub(): void {
  submits = []
  const byRun = new Map(MANIFEST.map((e) => [runIdOf(e), e]))
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
    const sub = /\/search\/jobs\/([^/?]+)\/([a-z-]+)/.exec(u)
    if (sub) {
      const id = decodeURIComponent(sub[1])
      const kind = sub[2]
      if (kind === 'status') return res(200, { items: [{ status: 'completed' }] })
      // A scheduled run's own artifact, read by run id: its stored rows.
      const artifact = byRun.get(id)
      const submitted = jobs.get(id)
      const rows = artifact ? rowsFor(artifact) : submitted ? vtRows(submitted) : []
      if (kind === 'results') return res(200, {}, ndjson(rows))
      if (kind === 'field-summaries') return res(200, summariseRows(rows))
      return res(404, { message: 'not stubbed' })
    }
    if (u.includes('/search/jobs?')) {
      // Head, full, and one entry's server-filtered page — the last told apart
      // by the `id.startsWith('<entry>.')` its filterExp carries.
      const filter = new URL(u, 'http://stub').searchParams.get('filterExp') ?? ''
      const only = /startsWith\('([a-z0-9_]+)\.'\)/.exec(filter)?.[1]
      return res(200, { items: MANIFEST.filter((e) => only === undefined || e.id === only).map(runRow) })
    }
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) {
      const e = byRun.get(decodeURIComponent(byId[1]))
      return e ? res(200, { items: [runRow(e)] }) : res(404, { message: 'gone' })
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

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // See the header: no observer means no deferral, so the whole tab is counted.
  vi.stubGlobal('IntersectionObserver', undefined)
  forgetRunHistory()
  resetSelectedSnapshot()
  resetSnapshotCensus()
  resetAccelKeyMemo()
  stub()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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

async function renderAt(path: string): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <DashboardProvider>
          <App />
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
  const row = BUDGET[tab]?.find((a) => a.query === query)
  return row ? row.panel : `UNBUDGETED ${query.slice(0, 140)}`
}

// ── The gate ────────────────────────────────────────────────────────────────

describe('the job budget covers every tab', () => {
  it('has one row per tab in App’s TABS, and no row for a tab that is gone', async () => {
    // TABS is not exported; the tab bar is rendered from it, so its links ARE
    // the list. A tab added without a budget row fails here, before anything
    // else can quietly skip it.
    await renderAt('/reference')
    const routes = [...container.querySelectorAll('nav.tab-bar a')].map((a) => a.getAttribute('href'))
    expect(routes.length).toBeGreaterThan(0)
    expect(routes).toEqual(Object.keys(BUDGET))
  })
})

describe('jobs each tab submits in Snapshot mode, opened and scrolled', () => {
  for (const [tab, allowed] of Object.entries(BUDGET)) {
    it(`${tab}: ${allowed.length === 0 ? 'no job — every panel is read from a stored artifact' : `exactly ${allowed.length}`}`, async () => {
      expect(dataMode(), 'this budget is for Snapshot mode, the default').toBe('snapshot')
      await renderAt(tab)

      // A tab that crashed submits nothing, and would pass an empty budget.
      expect(container.textContent).not.toContain('This view hit an error')
      expect(container.querySelector('.app-main')?.textContent?.trim() ?? '').not.toBe('')

      expect(submits.map((s) => identify(tab, s)).sort()).toEqual(allowed.map((a) => a.panel).sort())
    })
  }
})
