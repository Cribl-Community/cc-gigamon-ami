// The two holds in front of a panel's first submit, together.
//
// `feat/sample-data-surfacing` made EVERY panel wait for the dataset verdict
// (datasetTarget.ts, HOLD_DEADLINE_MS). `fix/accel-paused-panels` made an
// accelerated panel also wait for its saved search's serving verdict
// (accel/serving.ts, HYDRATE_DEADLINE_MS). Each branch tested its own hold with
// the other one settled — vitest.setup.ts settles the dataset verdict, and the
// serving tests never reset it. Merged (integrate/0924, 2026-09-24), the two
// share one `active` flag and one effect key in useSearch.ts, so this file holds
// what neither branch could: a panel submits once, after BOTH have answered, in
// either order; and a panel whose schedule is paused comes back from the sample
// to run live on the customer's dataset, not to read the paused run.

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetAccelMode } from './accel/mode'
import { accelEntry, accelSavedSearch, type AccelId } from './accel/manifest'
import type { AccelState, StoredSavedSearch } from './accel/provision'
import { loadAccelServing, publishAccelServing } from './accel/serving'
import { resetDatasetTarget, settleDatasetTarget } from './datasetTarget'
import { resetDataMode } from './dataMode'
import { useSearch, type UseSearchState } from './useSearch'

const LAKE: AccelId = 'gno_lake_30d_c1d'
const QUERY = 'dataset="gigamon_ami" | summarize total_events=count()'
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

/** Every read answers, except the two the holds wait on — the saved-search list
 *  and the Lake API — which never do. The test releases each hold by hand. */
function stub(): void {
  submits = []
  vi.stubGlobal('getCriblUser', async () => ({ id: 'u-1', username: 'jpederson' }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    if (u.includes('/search/saved') || u.includes('/lakes/')) return new Promise(() => {})
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

async function publishPaused(): Promise<void> {
  const entry = accelEntry(LAKE)
  const intended = await accelSavedSearch(entry)
  const stored: StoredSavedSearch = { ...intended, schedule: { ...intended.schedule, enabled: false } }
  const state: AccelState = {
    rows: [{
      id: LAKE, entry, state: 'paused', enabled: false, differences: [], stamp: null,
      ours: true, recorded: true, intended, stored,
    }],
    orphans: [], denied: false, error: null, truncated: false, readAt: NOW,
  }
  await act(async () => { publishAccelServing(state) })
}

let container: HTMLDivElement
let root: Root
let seen: UseSearchState | null = null

function Probe(): ReactNode {
  seen = useSearch(QUERY, { accel: LAKE, earliest: '-30d' })
  return null
}

async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve() })
}

async function render(): Promise<void> {
  await act(async () => { root.render(createElement(DashboardProvider, null, createElement(Probe))) })
  await settle()
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

describe('a panel held by both the dataset verdict and its schedule’s verdict', () => {
  it('submits nothing when only the schedule has answered, then runs live once when the dataset does', async () => {
    resetDatasetTarget()
    void loadAccelServing()
    await render()
    expect(submits).toEqual([])
    await publishPaused()
    await settle()
    expect(submits, 'the panel submitted before the app knew which dataset answers').toEqual([])
    expect(seen!.loading).toBe(true)
    await act(async () => { settleDatasetTarget(false) })
    await settle()
    expect(storedReads()).toEqual([])
    expect(liveRuns()).toHaveLength(1)
    expect(seen!.outcome).toBe('paused')
  })

  it('submits nothing when only the dataset has answered, then runs live once when the schedule does', async () => {
    resetDatasetTarget()
    void loadAccelServing()
    await render()
    await act(async () => { settleDatasetTarget(false) })
    await settle()
    expect(submits, 'the panel read its stored run before the schedule’s state was known').toEqual([])
    expect(seen!.loading).toBe(true)
    await publishPaused()
    await settle()
    expect(storedReads()).toEqual([])
    expect(liveRuns()).toHaveLength(1)
    expect(seen!.outcome).toBe('paused')
  })
})

describe('a paused schedule, from the sample back to real data', () => {
  it('runs live on the sample, then live on gigamon_ami — never the paused run', async () => {
    await act(async () => { settleDatasetTarget(true) })
    await publishPaused()
    await render()
    expect(submits).toHaveLength(1)
    expect(submits[0]).toContain('dataset="gigamon_ami_sample"')
    expect(seen!.outcome).toBeNull()

    await act(async () => { settleDatasetTarget(false, 'probe-found') })
    await settle()
    expect(storedReads(), 'the paused schedule’s old run was read once real data landed').toEqual([])
    expect(liveRuns()).toHaveLength(2)
    expect(submits[1]).toContain('dataset="gigamon_ami"')
    expect(submits[1]).not.toContain('gigamon_ami_sample')
    expect(seen!.outcome).toBe('paused')
  })
})
