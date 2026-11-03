// The default route, and how many jobs it takes to draw.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS GUARDING. Flow map's graph was three searches: the nodes,
// the edges, and the outbound total per source. Two of those three were already
// one scheduled scan — but they were registered as two PANELS of that entry, and
// accel/read.ts submits a `$vt_results` job per served panel (its memo caches
// the read key, not the rows). So the route the app opens on asked for one
// stored result twice.
//
// It is one hook now, over the un-tailed body, with both views cut out of its
// rows in the tab. That is invisible on screen — the picture is identical — so
// the only thing that can hold it still is a count of submitted jobs and the
// arithmetic the tab now does itself:
//
//   1. TWO JOBS, NOT THREE. And the graph read carries no tail, because a tail
//      is either a second read or one panel reading the other's rows.
//   2. THE OUTBOUND TOTALS SUM OVER EVERY PAIR READ, not only the drawn edges,
//      so a client's "flows out" is not short in the direction nobody can see.
//   3. THE "OTHER DESTINATIONS" SPOKE IS total − to-drawn, over every pair
//      read, not over the already-limited top 40 edges.
//   (Since 2026-11-03 nodes are destination IPs and the pairs are source IP →
//   destination IP; the AWS name tags these points were first written for are
//   not in the feed.)
//
// The network is stubbed at `fetch`; the hook, the read path and search.ts are
// all real.
// ─────────────────────────────────────────────────────────────────────────────

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { accelEntry } from '../cribl/accel/manifest'
import { resetAccelKeyMemo } from '../cribl/accel/read'
import { forgetRunHistory } from '../cribl/accel/status'
import { resetSelectedSnapshot } from '../cribl/accel/selection'
import { resetSnapshotCensus } from '../components/snapshotCensus'
import { FlowMap } from './FlowMap'

const NODES = 'gno_svc_nodes_c1h'
const EDGES = 'gno_svc_edges_c1h'
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

const run = (id: string) => ({
  id: `${id}.run-1`,
  status: 'completed',
  timeCreated: NOW - HOUR,
  timeStarted: NOW - HOUR,
  timeCompleted: NOW - HOUR,
})

/**
 * Three destinations: 10.1.0.1 is named by its http_host and healthy; 10.1.0.2
 * has no host and a p95 tcp_rtt of 700 ms (red); 10.1.0.3 is fast but 30% of
 * its flows carry duplicate ACKs (red).
 */
const NODE_ROWS = [
  { dst_ip: '10.1.0.1', host: 'alpha.example.com', net: 0.01, net_n: 10, dupack_flows: 0, dupack_n: 10, flows: 100, jobId: `${NODES}.run-1`, jobName: NODES },
  { dst_ip: '10.1.0.2', host: '', net: 0.7, net_n: 10, dupack_flows: 0, dupack_n: 0, flows: 100, jobId: `${NODES}.run-1`, jobName: NODES },
  { dst_ip: '10.1.0.3', host: '', net: 0.01, net_n: 10, dupack_flows: 3, dupack_n: 10, flows: 50, jobId: `${NODES}.run-1`, jobName: NODES },
]

/**
 * Source IP → destination IP pairs. 10.0.0.1 sends 60 flows to 10.1.0.2 and 40
 * to 10.1.0.1; 10.0.0.2 sends 10 to 10.1.0.1; 10.0.0.3 sends only to 10.9.9.9,
 * which is not a drawn destination, so it is drawn as a client whose whole
 * traffic is a spoke to "Other destinations".
 */
const GRAPH_ROWS = [
  { src_ip: '10.0.0.1', dst_ip: '10.1.0.2', flows: 60, jobId: `${EDGES}.run-1`, jobName: EDGES },
  { src_ip: '10.0.0.1', dst_ip: '10.1.0.1', flows: 40, jobId: `${EDGES}.run-1`, jobName: EDGES },
  { src_ip: '10.0.0.2', dst_ip: '10.1.0.1', flows: 10, jobId: `${EDGES}.run-1`, jobName: EDGES },
  { src_ip: '10.0.0.3', dst_ip: '10.9.9.9', flows: 500, jobId: `${EDGES}.run-1`, jobName: EDGES },
]

let submits: Submitted[] = []
/** Stored results read by run id — a GET, no job. See accel/read.ts's
 *  `newestArtifact`: since Phase 7 item 1.1 this is how both reads land. */
let artifactReads: string[] = []

/**
 * `history: false` is a workspace whose run list cannot be read, which sends
 * both reads down the `$vt_results` path — the fallback, still tested.
 */
function stub({ history = true }: { history?: boolean } = {}): void {
  submits = []
  artifactReads = []
  const jobs = new Map<string, Array<Record<string, unknown>>>()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      const id = `job-${submits.length}`
      jobs.set(id, body.query.includes(NODES) ? NODE_ROWS : body.query.includes(EDGES) ? GRAPH_ROWS : [])
      return res(200, { items: [{ id }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const id = decodeURIComponent(/\/search\/jobs\/([^/?]+)\/results/.exec(u)?.[1] ?? '')
      // A scheduled run's own artifact: its stored rows, by run id.
      if (id === `${NODES}.run-1` || id === `${EDGES}.run-1`) {
        artifactReads.push(id)
        return res(200, {}, ndjson(id.startsWith(NODES) ? NODE_ROWS : GRAPH_ROWS))
      }
      return res(200, {}, ndjson(jobs.get(id) ?? []))
    }
    if (u.includes('/search/jobs?')) {
      // ONE page for every entry — the history read is shared, so it holds both
      // schedules' runs, as the workspace's real job list does.
      if (!history) return res(500, { message: 'no' })
      return res(200, { items: [run(NODES), run(EDGES)] })
    }
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) {
      const id = decodeURIComponent(byId[1])
      return id === `${NODES}.run-1` ? res(200, { items: [run(NODES)] })
        : id === `${EDGES}.run-1` ? res(200, { items: [run(EDGES)] })
        : res(404, { message: 'gone' })
    }
    return res(404, { message: 'unrouted' })
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The history page is cached module-wide; one test's page must not answer
  // for the next.
  forgetRunHistory()
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
      <MemoryRouter initialEntries={['/flow-map']}>
        <DashboardProvider>
          <FlowMap />
        </DashboardProvider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve() })
}

const storedSubmits = () => submits.filter((s) => s.query.includes('$vt_results'))
const titles = () => [...container.querySelectorAll('title')].map((t) => t.textContent ?? '')

describe('the default route, drawn from two reads', () => {
  it('SUBMITS NO JOB AT ALL — both stored results are read as artifacts', async () => {
    // Phase 7's exit criterion for the route the app opens on. Every job costs
    // a place in the ~1.6 s admission queue; the two stored results this graph
    // needs already exist, so reading them should cost two GETs and nothing
    // else. A submit here means the fast path was skipped and the default route
    // is queueing again.
    stub()
    await render()

    expect(submits, 'the default route submitted a search job').toEqual([])
    expect(artifactReads.sort()).toEqual([`${EDGES}.run-1`, `${NODES}.run-1`])
  })

  it('asks for two stored results, not three', async () => {
    // Step 0. Three would mean the per-source totals went back to being their
    // own served panel, and the route the app opens on would be reading one
    // stored result twice.
    stub()
    await render()
    expect(artifactReads).toHaveLength(2)
  })

  it('reads the graph body whole, with no tail — on the fallback path too', async () => {
    // A tail here is one of two bugs: a second read, or one view reading the
    // other view's filtered-and-limited rows. Both are silent. The run list is
    // made unreadable so the query path runs and its text can be read.
    stub({ history: false })
    await render()

    expect(storedSubmits()).toHaveLength(2)

    const graph = storedSubmits().find((s) => s.query.includes(EDGES))!
    // The only prefix search.ts adds is the running-time cap; everything after
    // the selector would be a tail. See accel/read.ts on A-D15.
    expect(graph.query).toMatch(/^set max_running_time_per_search=\d+; dataset="\$vt_results" jobName="gno_svc_edges_c1h"$/)
    expect(accelEntry(EDGES).panels[0].tail).toBeUndefined()
  })

  it('draws the destinations, named by http_host where known, and the client-only sources', async () => {
    stub()
    await render()
    expect(container.querySelectorAll('.svc-node:not(.svc-node-source)')).toHaveLength(3)
    expect(container.querySelectorAll('.svc-node-source')).toHaveLength(3)
    expect(titles().some((t) => t.startsWith('alpha.example.com (10.1.0.1)'))).toBe(true)
    // No http_host: the IP is the label.
    expect(titles().some((t) => t.startsWith('10.1.0.2 —'))).toBe(true)
    // Only drawn destinations get solid edges.
    expect(titles().filter((t) => / → 10\.1\.0\.|→ alpha/.test(t))).toHaveLength(3)
  })

  it('colours a destination red on p95 tcp_rtt or on its duplicate-ACK share', async () => {
    stub()
    await render()
    expect(titles().find((t) => t.startsWith('10.1.0.2 —'))).toContain('tcp_rtt p95 700')
    expect(titles().find((t) => t.startsWith('10.1.0.3 —'))).toContain('dup-ACK 30% of 10')
    // A destination with no tcp_dup_ack values says so rather than reading 0%.
    expect(titles().find((t) => t.startsWith('10.1.0.2 —'))).toContain('dup-ACK no data')
    // Red nodes carry two pulse rings each: 10.1.0.2 and 10.1.0.3, not 10.1.0.1.
    expect(container.querySelectorAll('.svc-pulse-ring')).toHaveLength(4)
  })

  it('totals each source IP over every pair read, and spokes the rest to "Other destinations"', async () => {
    stub()
    await render()
    expect(titles()).toContain('10.0.0.1 — client only · 100 flows out')
    expect(titles()).toContain('10.0.0.2 — client only · 10 flows out')
    expect(titles()).toContain('10.0.0.3 — client only · 500 flows out')
    expect(titles()).toContain('10.0.0.3 → other destinations — 500 flows')
    expect(titles().some((t) => t.startsWith('10.0.0.1 → other'))).toBe(false)
  })

  it('dates the card, because both of its halves came from a stored run', async () => {
    // Two searches, one card, merged to the worse of the two — a graph drawn
    // half from 04:20 and half from now would look completely normal.
    stub()
    await render()
    expect(container.querySelector('.snap-note')?.textContent ?? '').toMatch(/snapshot (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2}/)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//  • That two reads are faster than three. happy-dom has no network, and the
//    ~1.6 s the platform leaves between admitting concurrent jobs — which is
//    what the second read actually cost — cannot appear here.
//  • That the 8-client and top-40 edge cuts hold on a real result. The fixture
//    has four pairs; the cuts only bite past eight clients and forty edges.
//  • Node colour. The health class is asserted through the title's figures,
//    not a computed colour, which happy-dom does not resolve.
//  • Anything about the drawing. The nodes are laid out on an ellipse this test
//    never measures, and happy-dom computes no layout to measure it with.

describe('the view switcher', () => {
  const click = async (label: string) => {
    const b = [...container.querySelectorAll('button')].find((x) => x.textContent === label)!
    await act(async () => { b.click() })
    for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve() })
  }

  it('offers Destinations, DNS, Web/API and Subnets, with Destinations selected', async () => {
    stub()
    await render()
    const group = container.querySelector('[aria-label="Flow map view"]')!
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Destinations', 'DNS', 'Web/API', 'Subnets'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false'])
  })

  it.each([
    ['DNS', 'app_name="dns" dns_host=*'],
    ['Web/API', 'by src_ip, http_host'],
    ['Subnets', 'by src_subnet, dst_subnet'],
  ])('%s runs its own one live search and nothing from the destinations view', async (label, marker) => {
    stub()
    await render()
    expect(submits).toEqual([])
    await click(label)
    // The dependency views are a lazy chunk: wait for it to load and submit.
    await vi.waitFor(() => expect(submits).toHaveLength(1))
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
    expect(submits).toHaveLength(1)
    expect(submits[0].query).toContain(marker)
    expect(submits[0].query).not.toContain('$vt_results')
  })

  it('switching back to Destinations submits nothing new', async () => {
    stub()
    await render()
    await click('DNS')
    await vi.waitFor(() => expect(submits.length).toBeGreaterThan(0))
    const after = submits.length
    await click('Destinations')
    expect(submits.length).toBe(after)
  })
})
