// The slowest tab in the app, and what it costs to open it now.
//
// Shadow AI fired three unfiltered whole-window scans on mount — apps by flows,
// the AI totals, the top AI users — and none of them was served. Most of the
// eight-second wait was not any one query: concurrent jobs from one account are
// admitted about 1.6 s apart, so the third had not started for ~3 s.
//
// `gno_app_src_c1h` groups by (app_name, src_ip) once an hour and each panel
// re-aggregates its own columns out of the stored pairs. The claims worth a test
// are not about speed, which nothing here can measure:
//
//   1. THE THREE PANELS ASK THE SCHEDULE, AND EACH ASKS FOR ITS OWN ROWS. Three
//      stored reads, three different tails, no live scan of gigamon_ami.
//   2. THE AI TAILS FILTER TO THE AI APPS AND THE APP LIST DOES NOT. A tail that
//      lost its `where` would put every application on the wire into the "AI
//      users" tile — a wrong number, not an error.
//   3. "AI users" IS RECOUNTED, NEVER SUMMED. The whole reason the body groups
//      by the pair. Asserted on the number that reaches the screen, over a
//      fixture where a summing implementation and a recounting one differ.
//   4. A NUMBER FROM A STORED RUN CARRIES THE TIME IT WAS PRODUCED, and a failed
//      fast read falls back to the live queries with none of Cribl's words on
//      screen.
//
// The network is stubbed at `fetch` and everything below it is real — the hook,
// accel/read.ts, search.ts — because "which job did this tab submit" is the
// question.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetSelectedSnapshot } from '../cribl/accel/selection'
import { resetAccelKeyMemo } from '../cribl/accel/read'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import { ShadowAi } from './ShadowAi'

const ENTRY = 'gno_app_src_c1h'
const HOUR = 3_600_000
const NOW = Date.now()

interface Submitted {
  query: string
  earliest: string
  latest: string
}

function res(status: number, body: unknown, asText?: string) {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => body,
    text: async () => asText ?? JSON.stringify(body),
  }
}

const ndjson = (rows: Array<Record<string, unknown>>) =>
  [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n')

const run = (over: Record<string, unknown> = {}) => ({
  id: `${ENTRY}.run-1`,
  status: 'completed',
  timeCreated: NOW - HOUR,
  timeStarted: NOW - HOUR,
  timeCompleted: NOW - HOUR,
  ...over,
})

/**
 * What each tail returns, computed by hand from four stored (app, source) pairs:
 *
 *   openai / 10.0.0.1  40 flows, 400 bytes
 *   openai / 10.0.0.2  30 flows, 300 bytes
 *   claude / 10.0.0.1  20 flows, 200 bytes
 *   zoom   / 10.0.0.9   5 flows,  50 bytes
 *
 * CHOSEN SO THE TWO IMPLEMENTATIONS DISAGREE. 10.0.0.1 reaches BOTH openai and
 * claude, so adding up the per-app distinct-source counts gives 3 AI users while
 * counting distinct sources over the AI rows gives 2. The rows below are what a
 * correct `summarize` would answer, not what the code produces.
 */
const APPS_ROWS = [
  { app_name: 'openai', flows: 70, bytes: 700, users: 2, jobId: 'run-1', jobName: ENTRY },
  { app_name: 'claude', flows: 20, bytes: 200, users: 1, jobId: 'run-1', jobName: ENTRY },
  { app_name: 'zoom', flows: 5, bytes: 50, users: 1, jobId: 'run-1', jobName: ENTRY },
]
const OVERALL_ROWS = [{ users: 2, flows: 90, bytes: 900, jobId: 'run-1', jobName: ENTRY }]
const USERS_ROWS = [
  { src_ip: '10.0.0.1', aiflows: 60, aiapps: 2, bytes: 600, jobId: 'run-1', jobName: ENTRY },
  { src_ip: '10.0.0.2', aiflows: 30, aiapps: 1, bytes: 300, jobId: 'run-1', jobName: ENTRY },
]

/** A live run, deliberately different, so which path answered is visible on
 *  screen rather than inferred from the submit list. */
const LIVE_APPS = [{ app_name: 'perplexity-ai', flows: 7, bytes: 70, users: 1 }]
const LIVE_OVERALL = [{ users: 99, flows: 7, bytes: 70 }]
const LIVE_USERS = [{ src_ip: '10.9.9.9', aiflows: 7, aiapps: 1, bytes: 70 }]

let submits: Submitted[] = []

function stub(cfg: { storedFail?: { status: number; body: unknown }; storedEmpty?: boolean; history?: unknown[] } = {}): void {
  submits = []
  const jobs = new Map<string, Array<Record<string, unknown>>>()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const stored = body.query.includes('$vt_results')
      if (stored && cfg.storedFail) return res(cfg.storedFail.status, cfg.storedFail.body)
      const id = `job-${submits.length}`
      jobs.set(id, stored && cfg.storedEmpty ? [] : rowsFor(body.query, stored))
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const id = /\/search\/jobs\/([^/]+)\/results/.exec(u)?.[1] ?? ''
      return res(200, {}, ndjson(jobs.get(id) ?? []))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

/** Which panel a submitted query belongs to, by the alias only its tail emits. */
function rowsFor(query: string, stored: boolean): Array<Record<string, unknown>> {
  if (query.includes('aiflows')) return stored ? USERS_ROWS : LIVE_USERS
  if (query.includes('by app_name')) return stored ? APPS_ROWS : LIVE_APPS
  return stored ? OVERALL_ROWS : LIVE_OVERALL
}

const storedSubmits = () => submits.filter((s) => s.query.includes('$vt_results'))
const liveSubmits = () => submits.filter((s) => s.query.includes('dataset="gigamon_ami"'))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetSelectedSnapshot()
  resetSnapshotCensus()
  resetAccelKeyMemo()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  resetSelectedSnapshot()
  resetSnapshotCensus()
  resetAccelKeyMemo()
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/shadow-ai']}>
        <DashboardProvider>
          <ShadowAi />
        </DashboardProvider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve() })
}

const tile = (label: string) =>
  [...container.querySelectorAll('.kpi')].find((k) => k.querySelector('.kpi-label')?.textContent?.startsWith(label))
const tileValue = (label: string) => tile(label)?.querySelector('.kpi-value')?.textContent ?? ''
const sourceNotes = () => [...container.querySelectorAll('.snap-note')].map((n) => n.textContent ?? '')

describe('Shadow AI, served by one hourly scan', () => {
  it('asks the schedule once per panel and runs no live scan', async () => {
    stub()
    await render()

    expect(storedSubmits()).toHaveLength(3)
    for (const s of storedSubmits()) expect(s.query).toContain(`jobName="${ENTRY}"`)
    expect(liveSubmits(), 'a panel scanned the dataset although the schedule answered').toHaveLength(0)
  })

  it('gives each panel its own tail, so no panel reads another panel’s row', async () => {
    // The shared row carries every panel's columns. A hook that reached it
    // un-tailed would read a column it never asked for — the exact shape of a
    // plausible wrong number, with no error and no fallback.
    stub()
    await render()

    const tails = storedSubmits().map((s) => s.query)
    expect(tails.filter((q) => q.includes('by app_name') && !q.includes('aiflows'))).toHaveLength(1)
    expect(tails.filter((q) => q.includes('aiflows=sum(flows)'))).toHaveLength(1)
    expect(tails.filter((q) => q.includes('users=dcount(src_ip)') && !q.includes('by app_name'))).toHaveLength(1)
  })

  it('filters the two AI panels to the AI apps, and the application list to nothing', async () => {
    // A tail that lost its `where` would put every application on the wire into
    // the AI tiles. A tail that GAINED one would hide the SaaS list below.
    stub()
    await render()

    const withFilter = storedSubmits().filter((s) => s.query.includes('app_name in ("openai"'))
    expect(withFilter, 'the AI tiles and the AI user list both filter to AI_APPS').toHaveLength(2)
    const appList = storedSubmits().find((s) => !s.query.includes('app_name in ('))!
    expect(appList.query, 'the application list must see every app, not only the AI ones').toContain(
      'by app_name | sort by flows desc | limit 90',
    )
  })

  it('counts a source that uses two AI apps once', async () => {
    // THE REASON THE BODY GROUPS BY (app_name, src_ip). 10.0.0.1 reaches openai
    // and claude. Summing the per-app counts stored beside each app gives 3;
    // recomputing the distinct count over the AI rows gives 2. The tile shows
    // what the schedule's own `dcount` returned, which is the recount.
    stub()
    await render()

    expect(tileValue('AI users')).toBe('2')
    expect(tileValue('AI flows')).toBe('90')
    // The per-source badge is the same argument one level down.
    expect(container.textContent).toContain('2 AI apps')
  })

  it('reads the AI app count off the served application list', async () => {
    // Two of the three stored apps are on the curated GenAI list; zoom is not.
    stub()
    await render()
    expect(tileValue('AI / LLM apps detected')).toBe('2')
    expect(tileValue('Top AI app')).toBe('openai')
  })

  it('says when each number was produced', async () => {
    // A schedule that stops firing leaves a perfectly readable result behind. A
    // panel rendering it without a date is the one failure this phase cannot
    // detect from the inside.
    stub()
    await render()
    const notes = sourceNotes()
    expect(notes.length, 'a served panel rendered no source caption').toBeGreaterThanOrEqual(3)
    for (const n of notes) expect(n).toMatch(/snapshot \d{2}:\d{2}/)
  })
})

describe('when the schedule cannot answer', () => {
  it('falls back to all three live queries and shows none of Cribl’s words', async () => {
    // accel/read.ts refuses to forward an API error into a panel; this is the
    // assertion that the tab does not reintroduce it. `$vt_results` is a virtual
    // table the customer never named — seeing it echoed back as the reason a
    // chart is missing explains nothing to anybody.
    stub({ storedFail: { status: 400, body: { message: 'dataset="$vt_results" jobName= is not valid' } } })
    await render()

    expect(liveSubmits(), 'each panel should have run its own query').toHaveLength(3)
    expect(tileValue('AI users')).toBe('99')
    expect(container.textContent).not.toContain('$vt_results')
    expect(container.textContent).not.toContain('Cribl API')
    expect(sourceNotes().every((n) => !/snapshot \d{2}:\d{2}/.test(n))).toBe(true)
  })

  it('falls back when the schedule has never run, which is every fresh install', async () => {
    // Empty is not an error, and it is the state a workspace is in between
    // installing the app and somebody pressing Apply. Both read keys are tried
    // before this is believed — see read.ts's KEY_MEMO — so the count is six.
    stub({ history: [], storedEmpty: true })
    await render()

    expect(storedSubmits()).toHaveLength(6)
    expect(liveSubmits()).toHaveLength(3)
    expect(tileValue('AI users')).toBe('99')
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//  • That the tails are valid KQL. Nothing here parses them; the stub matches on
//    substrings and returns rows somebody typed. manifest.test.ts walks
//    body → tail → panel mechanically, and the first real proof is a run.
//  • That `dcount` over stored pairs equals `dcount` over raw records. It is
//    exact if the platform's dcount is exact and an estimate over different
//    inputs if it is an HLL sketch — unmeasured, and written down in
//    src/queries/snapshots.ts rather than hidden behind a passing test.
//  • Anything about how long the tab takes. happy-dom has no network and no
//    layout; the ~1.6 s admission stagger that was most of the old eight seconds
//    is a property of the platform and cannot appear here.
