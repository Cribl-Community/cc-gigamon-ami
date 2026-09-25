// Every tab, on a workspace where only sample data exists.
//
// The owner's four rules for sample data (2026-09-24), held against the real
// <App/> with the real dataset verdict — nothing here settles it by hand:
//
//   1. every query a tab submits addresses gigamon_ami_sample, never
//      gigamon_ami — the one exception is the probe that decided it;
//   2. "Sample data" is said once, app-wide, on every tab, and every ⓘ names
//      the dataset that actually answered;
//   3. Snapshot steps aside: no stored-result job and no stored-run download,
//      although every schedule HAS a stored run here, and the Snapshot / Live
//      control is gone while the range picker is back;
//   4. deciding all of that writes nothing.
//
// The history stub offers a finished run of every manifest entry, so a panel
// that still reached for a snapshot would find one and be counted.
//
// WHAT THIS FILE CANNOT ASSERT: that the sample dataset holds anything a panel
// can draw — every job here answers with no rows, so each tab shows its empty
// state. That the pack's samples light every tab is packSamples.test.ts's job.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { DashboardProvider } from '../app/DashboardContext'
import { MANIFEST } from '../cribl/accel/manifest'
import { resetAccelKeyMemo } from '../cribl/accel/read'
import { resetSelectedSnapshot } from '../cribl/accel/selection'
import { resetDataMode } from '../cribl/dataMode'
import { datasetTarget, resetDatasetTarget, subscribeDatasetTarget } from '../cribl/datasetTarget'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import { SAMPLE_TITLE } from '../components/sampleDataCopy'
import { REAL_DATA_PROBE_QUERY } from '../queries/datasets'
import { LAKE_HELD_QUERY } from '../queries/dataFlow'
import { TABS } from '../app/tabs'

/** Every route in the tab bar's TABS (src/app/tabs.tsx), so a new tab is covered the day it lands. */
const ROUTES = TABS.map((t) => t.to)

const NOW = Date.now()
const runId = (id: string) => `${id}.${NOW - 60_000}.aB3dE9`
const RUN_IDS = new Set(MANIFEST.map((e) => runId(e.id)))

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

interface Call {
  method: string
  url: string
}

let calls: Call[] = []
let submits: string[] = []
let artifactReads: string[] = []
/** gigamon_ami's retention. Past cribl_metrics' 30 days, Data Flow's Lake card counts the dataset directly. */
let amiRetention = 30

function stub(): void {
  calls = []
  submits = []
  artifactReads = []
  let n = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    calls.push({ method, url: u })
    if (method === 'POST' && /\/search\/jobs$/.test(u)) {
      submits.push((JSON.parse(String(init.body)) as { query: string }).query)
      return res(200, { items: [{ id: `job-${++n}` }] })
    }
    if (u.includes('/lakes/default/datasets')) {
      return res(200, {
        items: [
          { id: 'gigamon_ami', retentionPeriodInDays: amiRetention, metrics: { currentSizeBytes: 0, metricsDate: '2026-09-23' } },
          { id: 'gigamon_ami_sample', retentionPeriodInDays: 7, metrics: {} },
          { id: 'cribl_metrics', retentionPeriodInDays: 30, metrics: {} },
        ],
      })
    }
    const sub = /\/search\/jobs\/([^/?]+)\/([a-z-]+)/.exec(u)
    if (sub) {
      const id = decodeURIComponent(sub[1])
      // A stored run's rows — the snapshot read. (Guided Setup's status table
      // reads a run's `/metrics` for its cost, which is not a snapshot.)
      if (RUN_IDS.has(id) && (sub[2] === 'results' || sub[2] === 'field-summaries')) artifactReads.push(id)
      if (sub[2] === 'status') return res(200, { items: [{ status: 'completed' }] })
      if (sub[2] === 'results') return res(200, {}, JSON.stringify({ totalEventCount: 0, job: 'j' }))
      if (sub[2] === 'field-summaries') return res(200, { fields: [] })
      if (sub[2] === 'cancel') return res(200, {})
      return res(404, { message: 'not stubbed' })
    }
    if (u.includes('/search/jobs?')) {
      // A finished run of every schedule: a panel that still reached for a
      // snapshot would find one.
      return res(200, {
        items: MANIFEST.map((e) => ({
          id: runId(e.id),
          type: 'scheduled',
          status: 'completed',
          earliest: e.earliest,
          timeCreated: NOW - 60_000,
          timeStarted: NOW - 60_000,
          timeCompleted: NOW - 60_000,
        })),
      })
    }
    return res(404, { message: 'not stubbed' })
  })
}

let container: HTMLDivElement
let root: Root

const settle = async (turns: number) => {
  for (let i = 0; i < turns; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('IntersectionObserver', undefined)
  resetDataMode()
  resetSelectedSnapshot()
  resetSnapshotCensus()
  resetAccelKeyMemo()
  // A page that has read nothing: the verdict below is the real read path's.
  resetDatasetTarget()
  amiRetention = 30
  stub()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  await settle(5)
  container.remove()
  resetDataMode()
  resetSelectedSnapshot()
  resetSnapshotCensus()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Every tab but the landing one is a lazy chunk (src/app/tabs.tsx), so rendering
// one is a real module import, transformed on first use. Guided Setup's is the
// largest, and on a busy machine it outlasted `settle(40)`: the test then counted
// ⓘs on "Loading tab…" and failed with "/setup shows no ⓘ at all". Load every
// tab once, through the tab bar's own `preload`, as tabJobBudget.test.tsx does.
beforeAll(async () => {
  await Promise.all(TABS.map((t) => t.preload?.()))
}, 60_000)

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
  await settle(40)
  // A tab still on its Suspense fallback would pass every "nothing was sent" check by rendering nothing.
  expect(container.textContent, `${path} never left "Loading tab…"`).not.toContain('Loading tab…')
}

const EXEC_PREFIX = /^(?:set [^;]+;\s*)+/
const bare = (q: string) => q.replace(EXEC_PREFIX, '')

/** Every submitted query that is not the probe. */
const panelSubmits = () => submits.map(bare).filter((q) => q !== REAL_DATA_PROBE_QUERY)

/** Tabs with no ⓘ at all: the AMI field reference (AmiReference.tsx) is a static table and runs no query. */
const NO_INFO = new Set(['/reference'])
/** Tabs whose ⓘs carry prose and provenance but no query block: Guided Setup's
 *  explain settings, and Data Flow's explain each stage of the diagram. Their
 *  prose is still held to the rule, by the whole-popover check. */
const NO_QUERY_INFO = new Set(['/setup', '/data-flow'])

/** Across every tab, so the sweep cannot pass by submitting nothing. */
let retargeted = 0

describe('every tab, while only sample data exists', () => {
  it('covers every tab in App’s TABS', () => {
    expect(ROUTES.length).toBeGreaterThan(10)
    expect(ROUTES).toContain('/flow-map')
    expect(ROUTES).toContain('/setup')
  })

  for (const route of ROUTES) {
    it(`${route}: queries the sample, reads no snapshot, says so, writes nothing`, async () => {
      await renderAt(route)
      expect(container.textContent).not.toContain('This view hit an error')
      expect(datasetTarget()).toMatchObject({ known: true, sample: true, dataset: 'gigamon_ami_sample' })

      // 1. Every query addresses the sample; the probe ran once, as written.
      expect(submits.map(bare).filter((q) => q === REAL_DATA_PROBE_QUERY)).toHaveLength(1)
      for (const q of panelSubmits()) {
        expect(q, q.slice(0, 120)).not.toMatch(/dataset="gigamon_ami"/)
        if (q.includes('dataset="gigamon_ami_sample"')) retargeted++
      }

      // 3. Snapshot stepped aside: no stored-result job, no stored-run download.
      for (const q of panelSubmits()) expect(q, q.slice(0, 120)).not.toContain('$vt_results')
      expect(artifactReads).toEqual([])
      expect(container.querySelector('[aria-label="Data source"]'), 'the Snapshot / Live control').toBeNull()
      expect(container.querySelector('#time-range'), 'the range picker').not.toBeNull()

      // 2. Said once, app-wide.
      const banners = [...container.querySelectorAll('.appbanners')].map((b) => b.textContent ?? '')
      expect(banners.join(' ')).toContain(SAMPLE_TITLE)
      expect(banners.join(' ')).toContain('gigamon_ami_sample')

      // …and every ⓘ names the dataset that answered.
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('.app-main .pinfo-btn')]
      let codes = 0
      for (const b of buttons) {
        await act(async () => { b.click() })
        const pop = document.body.querySelector('.pinfo-pop')
        expect(pop, `${b.getAttribute('aria-label')}: the ⓘ opened nothing`).not.toBeNull()
        // The whole popover, prose included — a stage's "what this does" that
        // says the panels query gigamon_ami is the same false claim as the code.
        expect(pop?.textContent ?? '', b.getAttribute('aria-label') ?? '').not.toMatch(/dataset\s*=?\s*"gigamon_ami"/)
        const code = document.body.querySelector('.pinfo-pop .pinfo-code')?.textContent ?? ''
        if (code !== '') codes++
        expect(code, b.getAttribute('aria-label') ?? '').not.toMatch(/dataset="gigamon_ami"/)
        const link = document.body.querySelector<HTMLAnchorElement>('.pinfo-pop a.pinfo-code-link')
        if (link) expect(new URL(link.href, 'http://x').searchParams.get('q') ?? '').not.toMatch(/dataset="gigamon_ami"/)
        await act(async () => { b.click() })
      }
      // The sweep cannot pass by finding nothing to check (review 2026-09-24,
      // gap 8): every tab but the ones named here shows at least one ⓘ with a
      // query in it.
      if (!NO_INFO.has(route)) expect(buttons.length, `${route} shows no ⓘ at all`).toBeGreaterThan(0)
      if (!NO_INFO.has(route) && !NO_QUERY_INFO.has(route)) expect(codes, `${route}: no ⓘ showed a query`).toBeGreaterThan(0)

      // 4. Nothing written: every non-GET is a search submit, a cancel, or the
      //    KV store's key listing (a read Cribl spells as POST — cribl/kv.ts).
      const writes = calls.filter(
        (c) => c.method !== 'GET' && !/\/search\/jobs$/.test(c.url) && !/\/cancel$/.test(c.url) && !/\/kvstore\/keys$/.test(c.url),
      )
      expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual([])
    })
  }

  it('retargeted a real number of queries across the tabs', () => {
    // Runs after the per-tab cases (vitest runs a file's tests in order).
    expect(retargeted).toBeGreaterThan(15)
  })
})

// Review 2026-09-24, defect 5. The Lake card describes the customer's dataset —
// its retention, its on-disk size, its name in the label — so the count beside
// them must be of that dataset too, not of the sample under its name.
describe('Data Flow’s Lake card while only sample data exists', () => {
  it('counts gigamon_ami as written, when its retention outruns cribl_metrics', async () => {
    amiRetention = 365
    await renderAt('/data-flow')
    expect(datasetTarget().sample).toBe(true)
    const counts = submits.map(bare).filter((q) => q.endsWith('| summarize total_events=count()'))
    expect(counts).toEqual([LAKE_HELD_QUERY])
    expect(LAKE_HELD_QUERY).toContain('dataset="gigamon_ami"')
  })
})

describe('the same workspace once real data lands', () => {
  it('moves every panel back on Refresh, and Snapshot returns', async () => {
    await renderAt('/tls-posture')
    expect(datasetTarget().sample).toBe(true)
    // Real data arrives: the probe now finds a record.
    const real = vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = String(url)
      if ((init.method ?? 'GET') === 'POST' && /\/search\/jobs$/.test(u)) {
        submits.push((JSON.parse(String(init.body)) as { query: string }).query)
        return res(200, { items: [{ id: `real-${submits.length}` }] })
      }
      if (u.includes('/lakes/default/datasets')) {
        // Lake's daily figure has not caught up yet: still zero.
        return res(200, {
          items: [
            { id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: { currentSizeBytes: 0, metricsDate: '2026-09-23' } },
            { id: 'gigamon_ami_sample', retentionPeriodInDays: 7, metrics: {} },
          ],
        })
      }
      const sub = /\/search\/jobs\/([^/?]+)\/([a-z-]+)/.exec(u)
      if (sub?.[2] === 'status') return res(200, { items: [{ status: 'completed' }] })
      if (sub?.[2] === 'results') return res(200, {}, [JSON.stringify({ totalEventCount: 1, job: 'j' }), JSON.stringify({ src_ip: '10.0.0.1' })].join('\n'))
      return res(404, {})
    })
    vi.stubGlobal('fetch', real)
    submits = []
    // Where the submits stand when the verdict moves. The Refresh itself
    // re-runs the panels while the re-check is still out, so those run against
    // the sample once more; everything after the move must not.
    let movedAt = -1
    const off = subscribeDatasetTarget(() => { if (!datasetTarget().sample && movedAt < 0) movedAt = submits.length })
    const refresh = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh'))
    await act(async () => { refresh?.click() })
    await settle(40)
    expect(datasetTarget(), JSON.stringify(datasetTarget())).toMatchObject({ sample: false, dataset: 'gigamon_ami', reason: 'probe-found' })
    expect(container.querySelector('.appbanners')?.textContent ?? '').not.toContain(SAMPLE_TITLE)
    expect(container.querySelector('[aria-label="Data source"]'), 'Snapshot / Live is back').not.toBeNull()
    off()
    // The TLS panels have no schedule, so they re-ran live — against gigamon_ami.
    expect(movedAt).toBeGreaterThanOrEqual(0)
    const after = submits.slice(movedAt).map(bare).filter((q) => q !== REAL_DATA_PROBE_QUERY)
    expect(after.length).toBeGreaterThan(0)
    for (const q of after) expect(q).not.toContain('gigamon_ami_sample')
  })
})
