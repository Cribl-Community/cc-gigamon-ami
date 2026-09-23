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
//   2. THE OUTBOUND TOTALS SUM ACROSS THE UNTAGGED SENTINEL. The body keeps
//      flows to peers with no AWS name tag as an empty-string group precisely so
//      this number is not short, in the direction nobody can see.
//   3. THE EXTERNAL SPOKE IS total − named, over EVERY tagged pair. It used to
//      be computed against the already-limited top 40, so traffic to a named
//      peer outside that cut counted as unnamed. That is the one number this
//      change moves, and it moves towards being right.
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

/** Two tagged services, both of them destinations, so both get drawn. */
const NODE_ROWS = [
  { dst_aws_flat_tags_name: 'alpha', app: 0.01, app_n: 10, dns: 0.01, dns_n: 10, resets: 0, flows: 100, jobId: `${NODES}.run-1`, jobName: NODES },
  { dst_aws_flat_tags_name: 'beta', app: 0.01, app_n: 10, dns: 0.01, dns_n: 10, resets: 0, flows: 100, jobId: `${NODES}.run-1`, jobName: NODES },
]

/**
 * The un-tailed grouping, with the sentinel group the body's `extend` creates.
 *
 * alpha sends 60 flows to beta and 40 to peers nobody can name; beta sends 10 to
 * alpha and none anywhere else. So:
 *
 *   outbound total   alpha 100, beta 10   (summed ACROSS the sentinel)
 *   named out        alpha  60, beta 10
 *   external spoke   alpha  40, beta  0   — one spoke, 40 flows
 *
 * Drop the sentinel row and alpha's outbound total reads 60, its external spoke
 * disappears, and nothing on screen says a thing.
 */
const GRAPH_ROWS = [
  { src_aws_flat_tags_name: 'alpha', dst_svc: 'beta', flows: 60, jobId: `${EDGES}.run-1`, jobName: EDGES },
  { src_aws_flat_tags_name: 'alpha', dst_svc: '', flows: 40, jobId: `${EDGES}.run-1`, jobName: EDGES },
  { src_aws_flat_tags_name: 'beta', dst_svc: 'alpha', flows: 10, jobId: `${EDGES}.run-1`, jobName: EDGES },
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

  it('draws the edge between the two tagged services', async () => {
    stub()
    await render()
    expect(container.querySelectorAll('.svc-node')).toHaveLength(2)
    expect(titles().some((t) => t.includes('alpha'))).toBe(true)
  })

  it('sums each service’s outbound total across the untagged group', async () => {
    // alpha sends 60 to beta and 40 to unnamed peers. The spoke to the external
    // hub is the difference, so it exists only if the sentinel row was counted
    // in the total and excluded from the named sum.
    stub()
    await render()

    const spoke = titles().find((t) => t.includes('unnamed / external peers'))
    expect(spoke, 'the external spoke is missing, so the untagged flows were dropped').toBeDefined()
    expect(spoke).toContain('40')
    // beta sends everything to a named peer, so it has no spoke of its own.
    expect(titles().filter((t) => t.includes('→ unnamed / external peers'))).toHaveLength(1)
    expect(titles().some((t) => t.includes('Peers with no AWS name tag') && t.includes('40'))).toBe(true)
  })

  it('dates the card, because both of its halves came from a stored run', async () => {
    // Two searches, one card, merged to the worse of the two — a graph drawn
    // half from 04:20 and half from now would look completely normal.
    stub()
    await render()
    expect(container.querySelector('.snap-note')?.textContent ?? '').toMatch(/snapshot \d{2}:\d{2}/)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//  • That two reads are faster than three. happy-dom has no network, and the
//    ~1.6 s the platform leaves between admitting concurrent jobs — which is
//    what the second read actually cost — cannot appear here.
//  • That the client-side filter/sort/limit reproduces `| where dst_svc != "" |
//    sort by flows desc | limit 40` on a real result. The fixture has three
//    pairs; the cut only bites past forty.
//  • Anything about the drawing. The nodes are laid out on an ellipse this test
//    never measures, and happy-dom computes no layout to measure it with.
