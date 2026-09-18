// What the global Snapshot / Live mode does to a panel, from the panel's side.
//
// ── THE FOUR THINGS THAT WERE WRONG, AND ARE WHAT THIS FILE HOLDS ───────────
//
//   * THE DOUBLE SUBMIT. `useAccelEnabled` started `true` and could only fall to
//     `false` once the KV round trip landed, so a viewer who had chosen Live got
//     a stored read AND a live query on every mount of every accelerated panel.
//     On Data Flow's Lake tile the second of those bills 9,297.7 CPU-s. The cure
//     is that a panel the mode can change holds its first submit until the mode
//     is known, so these tests COUNT SUBMITS.
//
//   * ONE KV ROUND TRIP IN FRONT OF THE WHOLE APP. The cure must not become the
//     next problem: a panel with no schedule is unaffected by the mode and must
//     not wait on anything. Asserted against a store that never answers.
//
//   * `pinned` KEYED ON THE WRONG QUESTION. It asked "does this panel have a
//     schedule" rather than "is the schedule answering it", so a panel switched
//     to Live ran a live query over the SCHEDULE's window and then ignored the
//     range picker and every auto-refresh tick. The reader pressed Live and got
//     a panel that stopped following them.
//
//   * A WINDOW THE PANEL PINNED FOR ITSELF IS NOT THE MODE'S TO MOVE. Data
//     Flow's tile passes `earliest: '-30d'` because the tile MEANS thirty days.
//     If Live handed it the picker's `-15m` the number would change, not its
//     freshness — which is the one failure this whole phase promised could not
//     happen.
//
// `fetch` is stubbed and the real search client, accel/read.ts and accel/mode.ts
// all run, because every claim here is about which job bodies went out.

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider, TIME_RANGES, useDashboard, type TimeRange } from '../app/DashboardContext'
import { resetAccelMode } from './accel/mode'
import { resetDataMode, setDataMode } from './dataMode'
import { useSearch, type UseSearchState } from './useSearch'

const LAKE = 'gno_lake_30d_c1d'
const QUERY = 'dataset="cribl_metrics" | summarize total_events=count()'
const NOW = Date.now()
const HOUR = 3_600_000

const STORED = { total_events: 1, jobId: 'run-1', jobName: LAKE, dataset: '$vt_results' }
const completed = { id: 'run-1', status: 'completed', timeCreated: NOW - 60_000, timeStarted: NOW - 60_000, timeCompleted: NOW - 60_000 }

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

let submits: Submitted[] = []

/** `prefs` seeds `accel/prefs/u-1`; `holdPrefs` keeps that GET pending forever,
 *  which is the only way to see what a panel does while the mode is unknown. */
function stub(opts: { prefs?: Record<string, unknown>; holdPrefs?: boolean } = {}): void {
  submits = []
  vi.stubGlobal('getCriblUser', async () => ({ id: 'u-1', username: 'jpederson' }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    if (u.includes('/kvstore/')) {
      if (method === 'PUT') return res(200, {})
      if (opts.holdPrefs) await new Promise(() => {})
      return opts.prefs
        ? res(200, {}, JSON.stringify({ version: 1, updatedAt: 1, doc: opts.prefs }))
        : res(404, {}, '')
    }
    if (method === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      return res(200, { items: [{ id: body.query.includes('$vt_results') ? 'job-stored' : 'job-live' }] })
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

const storedReads = () => submits.filter((s) => s.query.includes('$vt_results'))
const liveRuns = () => submits.filter((s) => !s.query.includes('$vt_results'))

let container: HTMLDivElement
let root: Root
let accelSeen: UseSearchState | null = null
let plainSeen: UseSearchState | null = null
let setRange: ((r: TimeRange) => void) | null = null
let setAutoSeconds: ((n: number) => void) | null = null

/** An accelerated panel with NO window of its own — the shape every manifest
 *  entry after the first two will have, and the one the mode-dependent pin is
 *  for. Data Flow's tile is the other shape and has its own test below. */
function Probe({ pinItself, plain }: { pinItself?: boolean; plain?: boolean }): ReactNode {
  const dash = useDashboard()
  setRange = dash.setRange
  setAutoSeconds = dash.setAutoSeconds
  accelSeen = useSearch(QUERY, { accel: LAKE, earliest: pinItself ? '-30d' : undefined })
  const alsoPlain = useSearch(`${QUERY} | limit 1`, { enabled: plain === true })
  plainSeen = plain ? alsoPlain : null
  return null
}

async function render(props: { pinItself?: boolean; plain?: boolean } = {}): Promise<void> {
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
  accelSeen = null
  plainSeen = null
  setRange = null
  setAutoSeconds = null
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

describe('the first submit of an accelerated panel', () => {
  it('is ONE job when the viewer chose Live, not a stored read and then a live one', async () => {
    // THE DOUBLE SUBMIT. Two jobs here is 9,297.7 billable CPU-s on Data Flow's
    // tile for a viewer who asked for exactly one of them.
    stub({ prefs: { liveReads: true, liveReadsUntil: NOW + HOUR } })
    await render()
    expect(storedReads(), 'a stored read went out before the mode was known').toEqual([])
    expect(liveRuns()).toHaveLength(1)
    expect(accelSeen!.source).toBe('live')
  })

  it('is ONE stored read when the viewer is on Snapshot', async () => {
    stub()
    await render()
    expect(storedReads()).toHaveLength(1)
    expect(liveRuns()).toEqual([])
    expect(accelSeen!.source).toBe('schedule')
  })

  it('shows a spinner rather than "No results" while the mode is unknown', async () => {
    // Held back is not the same as answered. A panel reporting zero rows for a
    // query nobody has submitted is a wrong number, not a missing one.
    stub({ holdPrefs: true })
    await render()
    expect(submits).toEqual([])
    expect(accelSeen!.loading).toBe(true)
    expect(accelSeen!.rows).toEqual([])
    expect(accelSeen!.error).toBeNull()
  })
})

describe('a panel with no schedule', () => {
  it('does not wait on the mode, because the mode cannot change it', async () => {
    // The cure for the double submit must not put one KV round trip in front of
    // all thirty-seven unaccelerated panels in an app whose brief is speed.
    stub({ holdPrefs: true })
    await render({ plain: true })
    expect(liveRuns()).toHaveLength(1)
    expect(plainSeen!.loading).toBe(false)
    expect(plainSeen!.rows).toEqual([{ total_events: 2 }])
  })
})

describe('Live mode gives an accelerated panel back to the reader', () => {
  it('follows the range picker, where Snapshot does not', async () => {
    stub()
    await render()
    // Snapshot: the read is the schedule's, so the picker means nothing and
    // moving it must not submit a job to receive identical stored rows.
    expect(storedReads()).toHaveLength(1)
    await act(async () => { setRange!(TIME_RANGES[0]) })
    await settle()
    expect(submits).toHaveLength(1)

    // Live: an ordinary panel again — the picker's window, and a re-run when it
    // moves. Before the fix this stayed pinned to the manifest's `-30d` and
    // ignored the picker entirely.
    await act(async () => { setDataMode('live') })
    await settle()
    expect(liveRuns()).toHaveLength(1)
    expect(liveRuns()[0].earliest).toBe(TIME_RANGES[0].earliest)

    await act(async () => { setRange!(TIME_RANGES[2]) })
    await settle()
    expect(liveRuns()).toHaveLength(2)
    expect(liveRuns()[1].earliest).toBe(TIME_RANGES[2].earliest)
  })

  it('re-runs on an auto-refresh tick, where Snapshot does not', async () => {
    // The other half of `pinned`. A one-second cadence and a real timer: fake
    // timers would also stall the search client's own polling sleep, and the
    // claim under test is about which nonce the hook keys on.
    stub()
    await render()
    await act(async () => { setAutoSeconds!(1) })
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    await settle()
    expect(submits, 'a tick re-ran a panel served from its schedule').toHaveLength(1)

    await act(async () => { setDataMode('live') })
    await settle()
    const before = liveRuns().length
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    await settle()
    expect(liveRuns().length).toBeGreaterThan(before)
  })

  it('leaves a window the panel pinned for itself alone', async () => {
    // Data Flow's Lake tile. `-30d` is what the tile MEANS; handing it the
    // picker's `-15m` in Live mode would change the number rather than its age.
    stub()
    await render({ pinItself: true })
    await act(async () => { setDataMode('live') })
    await settle()
    expect(liveRuns()).toHaveLength(1)
    expect(liveRuns()[0].earliest).toBe('-30d')

    await act(async () => { setRange!(TIME_RANGES[0]) })
    await settle()
    expect(liveRuns(), 'the range picker moved a window the panel pinned for itself').toHaveLength(1)
  })
})

describe('switching modes', () => {
  it('re-runs the panels whose source changed and nothing else', async () => {
    stub()
    await render({ plain: true })
    expect(storedReads()).toHaveLength(1)
    const plainBefore = liveRuns().length

    await act(async () => { setDataMode('live') })
    await settle()
    expect(accelSeen!.source).toBe('live')
    // The unaccelerated panel's query, window and pin are all untouched by the
    // mode, so it must not be re-submitted: a mode press is not a page refresh.
    expect(liveRuns().filter((s) => s.query.includes('limit 1'))).toHaveLength(plainBefore)
  })

  it('goes back to the stored result on Snapshot', async () => {
    stub()
    await render()
    await act(async () => { setDataMode('live') })
    await settle()
    expect(accelSeen!.source).toBe('live')
    await act(async () => { setDataMode('snapshot') })
    await settle()
    expect(accelSeen!.source).toBe('schedule')
    expect(accelSeen!.at).toBe(completed.timeCompleted)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//  • Anything about the control itself — its markup, its `aria-pressed` pair,
//    its focus order or its hit area. The segments live in src/App.tsx, and
//    happy-dom implements neither sequential focus navigation nor layout.
//  • That the held first submit is IMPERCEPTIBLE. It is one app-scoped KV GET,
//    capped at HYDRATE_DEADLINE_MS, and nothing here measures wall time —
//    per the owner's instruction, this was built rather than measured.
//  • That the platform really admits concurrent jobs ~1.6 s apart. That figure
//    is why holding a submit is cheap and firing a spare one is not, and it is a
//    prior measurement taken on faith here.
