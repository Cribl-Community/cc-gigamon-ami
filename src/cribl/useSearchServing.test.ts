// What the saved search itself says, from the panel's side (accel/serving.ts).
//
// ── THE DEFECT THIS FILE HOLDS ──────────────────────────────────────────────
// Review 2026-09-24, defect 1: the Pause button and the per-tab and master
// switches say "the panels they feed go back to their live queries" and price
// that — and nothing on the read path looked at `schedule.enabled`. A paused
// schedule's panels kept reading its newest stored run and, two cadences later,
// said "older than its schedule promises — check the schedule in Guided Setup"
// for up to seven days. Data Flow's Lake card did it in Live mode too.
//
// Defect 5: after a release changes an entry's body, the saved search runs the
// old query until somebody re-applies, and its stored run sat under an ⓘ quoting
// the new one. A drifted entry now runs live, so the ⓘ describes what ran.
//
// The verdicts are handed in with `publishAccelServing` — the same call
// AccelPanel makes with the state it read — so what is under test is the hook's
// answer to a verdict, and serving.test.ts holds how a verdict is reached.

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider, useDashboard } from '../app/DashboardContext'
import { resetAccelMode } from './accel/mode'
import { accelEntry, accelSavedSearch, type AccelId } from './accel/manifest'
import type { AccelState, StoredSavedSearch } from './accel/provision'
import { loadAccelServing, publishAccelServing } from './accel/serving'
import { NOTES } from './accel/read'
import { resetDataMode, setDataMode } from './dataMode'
import { useSearch, type UseSearchState } from './useSearch'

const LAKE: AccelId = 'gno_lake_30d_c1d'
const QUERY = 'dataset="cribl_metrics" | summarize total_events=count()'
const NOW = Date.now()

const STORED = { total_events: 1, jobId: 'run-1', jobName: LAKE, dataset: '$vt_results' }
const completed = { id: 'run-1', status: 'completed', timeCreated: NOW - 60_000, timeStarted: NOW - 60_000, timeCompleted: NOW - 60_000 }

function res(status: number, body: unknown, asText?: string) {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => body,
    text: async () => asText ?? JSON.stringify(body),
  }
}

let submits: string[] = []

function stub(): void {
  submits = []
  vi.stubGlobal('getCriblUser', async () => ({ id: 'u-1', username: 'jpederson' }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    if (u.includes('/kvstore/')) return method === 'PUT' ? res(200, {}) : res(404, {}, '')
    if (method === 'POST' && u.endsWith('/search/jobs')) {
      const { query } = JSON.parse(String(init.body)) as { query: string }
      submits.push(query)
      return res(200, { items: [{ id: query.includes('$vt_results') ? 'job-stored' : 'job-live' }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) {
      const rows = u.includes('job-stored') ? [STORED] : [{ total_events: 2 }]
      return res(200, {}, [JSON.stringify({ totalEventCount: rows.length, job: 'j' }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: [completed] })
    if (/\/search\/jobs\/([^/?]+)$/.test(u)) return res(200, { items: [completed] })
    return res(404, { message: 'unrouted' })
  })
}

const storedReads = () => submits.filter((s) => s.includes('$vt_results'))
const liveRuns = () => submits.filter((s) => !s.includes('$vt_results'))

/** A state read in which the Lake entry's saved search is `stored`. */
async function stateWith(stored: StoredSavedSearch | null): Promise<AccelState> {
  const entry = accelEntry(LAKE)
  const intended = await accelSavedSearch(entry)
  return {
    rows: [
      {
        id: LAKE,
        entry,
        state: stored === null ? 'absent' : stored.schedule?.enabled === false ? 'paused' : 'enabled',
        enabled: stored === null ? null : (stored.schedule?.enabled as boolean),
        differences: [],
        stamp: null,
        ours: true,
        recorded: true,
        intended,
        stored,
      },
    ],
    orphans: [],
    denied: false,
    error: null,
    truncated: false,
    readAt: NOW,
  }
}

async function asWritten(patch: { enabled?: boolean; query?: string } = {}): Promise<StoredSavedSearch> {
  const intended = await accelSavedSearch(accelEntry(LAKE))
  return {
    ...intended,
    query: patch.query ?? intended.query,
    schedule: { ...intended.schedule, enabled: patch.enabled ?? true },
  }
}

async function publish(stored: StoredSavedSearch | null): Promise<void> {
  const state = await stateWith(stored)
  await act(async () => { publishAccelServing(state) })
}

let container: HTMLDivElement
let root: Root
let seen: UseSearchState | null = null
let pageRefresh: (() => void) | null = null

/** Data Flow's Lake card has the one hook that reads its schedule in Live mode
 *  too; `inLive` gives it that shape. */
function Probe({ inLive }: { inLive?: boolean }): ReactNode {
  pageRefresh = useDashboard().refresh
  seen = useSearch(QUERY, { accel: LAKE, earliest: '-30d', snapshotInLive: inLive })
  return null
}

async function render(props: { inLive?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(DashboardProvider, null, createElement(Probe, props)))
  })
  await settle()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetAccelMode()
  resetDataMode()
  seen = null
  stub()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a schedule that is on and runs the query the panel shows', () => {
  it('is read, exactly as before', async () => {
    await publish(await asWritten())
    await render()
    expect(storedReads()).toHaveLength(1)
    expect(liveRuns()).toEqual([])
    expect(seen!.source).toBe('schedule')
  })
})

describe('a paused schedule', () => {
  it('sends its panel live — what the switch’s confirmation said and priced', async () => {
    await publish(await asWritten({ enabled: false }))
    await render()
    expect(storedReads(), 'a paused schedule’s old run was read').toEqual([])
    expect(liveRuns()).toHaveLength(1)
    expect(seen!.source).toBe('live')
    expect(seen!.outcome).toBe('paused')
    expect(seen!.stale).toBe(false)
    expect(seen!.note).toBe(NOTES.paused)
    expect(seen!.note).not.toContain('check the schedule')
  })

  it('sends Data Flow’s Lake card live in Live mode too', async () => {
    act(() => setDataMode('live'))
    await publish(await asWritten({ enabled: false }))
    await render({ inLive: true })
    expect(storedReads()).toEqual([])
    expect(liveRuns()).toHaveLength(1)
    expect(seen!.outcome).toBe('paused')
  })

  it('re-runs a panel already on screen once, live, when a Pause is heard', async () => {
    await publish(await asWritten())
    await render()
    expect(storedReads()).toHaveLength(1)
    await publish(await asWritten({ enabled: false }))
    await settle()
    expect(storedReads()).toHaveLength(1)
    expect(liveRuns()).toHaveLength(1)
    expect(seen!.outcome).toBe('paused')
  })
})

describe('while the first saved-search read is out', () => {
  it('holds the panel, so a paused schedule’s panel runs live ONCE rather than reading first', async () => {
    // Without the hold a paused entry's panel reads its stale run, renders it
    // under "check the schedule", and then re-runs live when the verdict lands:
    // two answers, the first one a nag about a switch somebody chose.
    const plain = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      String(url).includes('/search/saved') || String(url).includes('/lakes/') ? new Promise(() => {}) : plain(url, init))
    void loadAccelServing()
    await render()
    expect(submits, 'a read went out before the schedule’s state was known').toEqual([])
    expect(seen!.loading).toBe(true)
    await publish(await asWritten({ enabled: false }))
    await settle()
    expect(storedReads()).toEqual([])
    expect(liveRuns()).toHaveLength(1)
  })
})

describe('a schedule whose query drifted from the one the ⓘ shows', () => {
  it('runs live, so the ⓘ describes the query the number came from', async () => {
    await publish(await asWritten({ query: 'dataset="cribl_metrics" | summarize total_events=sum(_value) by an_older_shape' }))
    await render()
    expect(storedReads(), 'a run of the older query was shown under the newer ⓘ').toEqual([])
    expect(liveRuns()).toHaveLength(1)
    expect(seen!.outcome).toBe('drifted')
    expect(seen!.note).toContain('Re-apply')
  })
})

describe('a schedule that is gone', () => {
  it('runs live rather than reading what a removed search left behind', async () => {
    await publish(null)
    await render()
    expect(storedReads()).toEqual([])
    expect(liveRuns()).toHaveLength(1)
    expect(seen!.outcome).toBe('unscheduled')
  })
})

describe('a verdict nobody could read', () => {
  it('moves nobody’s bill: a refused list reads the stored run as before', async () => {
    const state = await stateWith(await asWritten({ enabled: false }))
    await act(async () => { publishAccelServing({ ...state, denied: true, error: 'refused' }) })
    await render()
    expect(storedReads()).toHaveLength(1)
    expect(liveRuns()).toEqual([])
  })
})

describe('the page’s Refresh', () => {
  it('re-reads the saved searches, so a Pause made elsewhere is heard on the click', async () => {
    // Never on a timer — a schedule paused from another browser is picked up
    // when a person asks for fresh data, and not before.
    let enabled = true
    const plain = globalThis.fetch
    const savedReads = () => listCalls
    let listCalls = 0
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/search/saved')) {
        listCalls++
        const item = await asWritten({ enabled })
        return res(200, { items: [item], count: 1, totalCount: 1 })
      }
      return plain(url, init)
    })
    await loadAccelServing()
    await render()
    expect(storedReads()).toHaveLength(1)
    const before = savedReads()
    enabled = false
    await settle()
    expect(savedReads(), 'the saved searches were re-read without anybody asking').toBe(before)
    await act(async () => { pageRefresh!() })
    await settle()
    await settle()
    expect(savedReads()).toBe(before + 1)
    expect(seen!.outcome).toBe('paused')
    expect(liveRuns()).toHaveLength(1)
  })
})

