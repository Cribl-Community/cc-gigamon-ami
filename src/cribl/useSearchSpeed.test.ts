// The two speed changes a panel can get wrong, from the panel's side.
//
// ── WHY THIS IS A SEPARATE FILE FROM useSearch.test.ts ──────────────────────
// That file is about acceleration: which of two SOURCES answered a panel, and
// what the customer is told about it. This one is about the two things that
// changed for every panel in both modes — when a query is SUBMITTED, and
// whether Cribl is allowed to answer it from something it already has — so its
// probe has a range picker, a refresh button and an auto-refresh dial, and none
// of its assertions are about `$vt_results`.
//
// ── WHAT IS ACTUALLY AT RISK ────────────────────────────────────────────────
//   * A DEFERRED PANEL THAT NEVER RUNS. Held back is a startup ordering device;
//     held back forever is a blank panel. And while it is held back it must say
//     "running", not "No results" — an unasked query has no answer, and telling
//     a viewer their traffic has no HTTP hosts because they have not scrolled
//     yet is a wrong number, not a missing one.
//   * A DEFERRED PANEL THAT RUNS TWICE. The flag flips from true to false
//     exactly once per visit, and that must cost exactly one job.
//   * A REFRESH THAT DOES NOT REFRESH. `set allow_previous_results="2min"` is
//     measured at 30.92 s → 0.95 s and zero billed (A-SP21), and it would be
//     silently wrong on the one control that means "not the number you already
//     have". The page's Refresh, a panel's own refresh, and an auto-refresh
//     cadence faster than the reuse window all have to escape it — and a range
//     change and a remount must NOT, because that is where the saving is.
//
// `fetch` is stubbed and the real search client runs, because every claim here
// is about the bytes in a job body.

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider, TIME_RANGES, useDashboard } from '../app/DashboardContext'
import { useSearch, type UseSearchState } from './useSearch'

const QUERY = 'dataset="gigamon_ami" | summarize c=count()'

interface Submitted {
  query: string
  earliest: string
}

let submits: Submitted[] = []

function stub(): void {
  submits = []
  const res = (status: number, body: unknown, asText?: string) => ({
    ok: status < 400,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => asText ?? JSON.stringify(body),
  })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      submits.push(JSON.parse(String(init.body)) as Submitted)
      return res(200, { items: [{ id: `job-${submits.length}` }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/results')) return res(200, {}, '{"totalEventCount":1,"job":"j"}\n{"c":1}')
    return res(404, { message: 'unrouted' })
  })
}

const reused = (s: Submitted[]) => s.filter((x) => x.query.includes('allow_previous_results'))
const fresh = (s: Submitted[]) => s.filter((x) => !x.query.includes('allow_previous_results'))

let container: HTMLDivElement
let root: Root
let seen: UseSearchState | null = null
let page: {
  refresh: () => void
  setRange: (r: (typeof TIME_RANGES)[number]) => void
  setAutoSeconds: (n: number) => void
} | null = null

function Probe({ deferred }: { deferred?: boolean }): ReactNode {
  const dash = useDashboard()
  page = { refresh: dash.refresh, setRange: dash.setRange, setAutoSeconds: dash.setAutoSeconds }
  seen = useSearch(QUERY, { deferred })
  return null
}

async function render(props: { deferred?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(DashboardProvider, null, createElement(Probe, props)))
  })
  await settle()
}

/** Re-render the same tree with new props — a panel arriving near the viewport
 *  is exactly this: the same hook, one flag later. */
async function rerender(props: { deferred?: boolean }): Promise<void> {
  await act(async () => {
    root.render(createElement(DashboardProvider, null, createElement(Probe, props)))
  })
  await settle()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  seen = null
  page = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  stub()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a deferred panel', () => {
  it('submits nothing, and reports itself running rather than empty', async () => {
    await render({ deferred: true })
    expect(submits, 'a panel below the fold took an admission slot anyway').toEqual([])
    // <QueryBoundary> renders "No results" for `loading: false, rows: []`. That
    // sentence is a claim about the customer's traffic, and this panel has not
    // asked anything yet.
    expect(seen!.loading).toBe(true)
    expect(seen!.rows).toEqual([])
    expect(seen!.error).toBe(null)
  })

  it('runs once, and only once, when it comes near', async () => {
    await render({ deferred: true })
    await rerender({ deferred: false })
    expect(submits).toHaveLength(1)
    expect(submits[0].query.endsWith(QUERY), 'the deferred panel altered its query').toBe(true)
    expect(seen!.loading).toBe(false)
    expect(seen!.rows).toEqual([{ c: 1 }])
  })

  it('does not re-run when the flag is re-asserted', async () => {
    // `near` is one-way, but a parent re-render must not be a second job even
    // if that ever changes.
    await render({ deferred: true })
    await rerender({ deferred: false })
    await rerender({ deferred: false })
    expect(submits).toHaveLength(1)
  })

  it('is distinguishable from a panel that cannot run at all', async () => {
    // `enabled: false` is "nothing is selected" and correctly reports no rows;
    // deferred is "not yet". Collapsing the two would put the wrong words under
    // half the panels on the page.
    function Disabled(): ReactNode {
      seen = useSearch(QUERY, { enabled: false, deferred: true })
      return null
    }
    await act(async () => {
      root.render(createElement(DashboardProvider, null, createElement(Disabled)))
    })
    await settle()
    expect(submits).toEqual([])
    expect(seen!.loading).toBe(false)
  })
})

describe('letting Cribl answer from a result it already has', () => {
  it('asks for reuse on the first paint of a panel', async () => {
    // The morning open, and every tab switch back. Measured 30.92 s → 0.95 s.
    await render()
    expect(submits).toHaveLength(1)
    expect(reused(submits)).toHaveLength(1)
    expect(submits[0].query).toContain('set allow_previous_results="2min"')
  })

  it('keeps asking across a range change', async () => {
    // The match is on the relative range SPEC, so flipping to -1h and back is
    // two queries Cribl has probably already answered.
    await render()
    await act(async () => page!.setRange(TIME_RANGES[3]))
    await settle()
    expect(submits).toHaveLength(2)
    expect(reused(submits)).toHaveLength(2)
    expect(submits[1].earliest).toBe('-1h')
  })

  it('gives it up when the viewer presses Refresh', async () => {
    // The whole point of the control. A reused answer here is the app telling
    // someone "yes, I refreshed" and showing them the same number.
    await render()
    await act(async () => page!.refresh())
    await settle()
    expect(submits).toHaveLength(2)
    expect(fresh(submits), 'Refresh was answered from a result up to 2 minutes old').toHaveLength(1)
    expect(fresh(submits)[0].query).toBe(submits[1].query)
  })

  it('gives it up for a panel’s own refresh button too', async () => {
    await render()
    await act(async () => seen!.refetch())
    await settle()
    expect(submits).toHaveLength(2)
    expect(submits[1].query).not.toContain('allow_previous_results')
  })

  it('takes reuse back once the refresh is over', async () => {
    // The bypass is per-run, not a mode. A range change after a refresh is an
    // ordinary submit again.
    await render()
    await act(async () => page!.refresh())
    await settle()
    await act(async () => page!.setRange(TIME_RANGES[3]))
    await settle()
    expect(submits).toHaveLength(3)
    expect(submits[2].query).toContain('allow_previous_results')
  })

  it('gives it up on an auto-refresh tick faster than the reuse window', async () => {
    // A minute's cadence answered from a two-minute-old result is a tick that
    // CANNOT show anything new, dated "updated 0s ago" while it does it.
    vi.useFakeTimers()
    try {
      await render()
      await act(async () => page!.setAutoSeconds(60))
      await act(async () => { vi.advanceTimersByTime(60_000) })
      await settle()
    } finally {
      vi.useRealTimers()
    }
    expect(submits).toHaveLength(2)
    expect(submits[1].query).not.toContain('allow_previous_results')
  })

  it('keeps it on a cadence slower than the reuse window', async () => {
    // The rule is the comparison, not "a tick never reuses". Today's menu only
    // offers Off and 1m, so this is the branch a reader will otherwise delete
    // as dead — and the menu is expected to grow once panels can be served from
    // stored results (WITHHELD_REFRESH_SECONDS says so out loud).
    vi.useFakeTimers()
    try {
      await render()
      await act(async () => page!.setAutoSeconds(600))
      await act(async () => { vi.advanceTimersByTime(600_000) })
      await settle()
    } finally {
      vi.useRealTimers()
    }
    expect(submits).toHaveLength(2)
    expect(submits[1].query).toContain('allow_previous_results')
  })
})

// ── What this file could not assert ─────────────────────────────────────────
//  * THAT CRIBL REUSES ANYTHING. A-SP21 measured that against the workspace;
//    with `fetch` stubbed, all that is proved here is which directive is in the
//    job body.
//  * THAT A PANEL IS ACTUALLY BELOW THE FOLD. happy-dom has no layout, so
//    `deferred` is passed as a prop rather than discovered — the hook that
//    discovers it is tested in components/nearViewport.test.ts, against stubs
//    of its own.
//  * THAT THE ADMISSION STAGGER IMPROVES. One probe submits one query here;
//    the ~1.6 s figure is a property of the workspace, not of this repo.
