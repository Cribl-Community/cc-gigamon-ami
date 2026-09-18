// The time control in Snapshot mode, and the four ways it could mislead.
//
//   * It could offer a time nothing is stored for. Every option here comes from
//     a run that finished, read from the job history.
//   * It could imply that all the schedules agree. They do not — the hourly
//     entries fire at :20, :21 and :22 and the Lake total once a day — so the
//     line under it says how many sets have a run from the moment picked.
//   * It could show a short list as if it were the whole past. Two different
//     limits end it, and which one is named matters to whoever would change it.
//   * It could quietly jump back to Newest when a run ages out from under a
//     reader, leaving the control disagreeing with the panels.
//
// ── WHAT THIS FILE COULD NOT ASSERT ─────────────────────────────────────────
// happy-dom has no layout and no sequential focus navigation, so neither the
// hit area of the select nor its place in the tab order is measured here. What
// is asserted is the markup those would depend on: a real `<select>` with a
// `<label for>` and an `aria-describedby` pointing at the visible sentence. A
// green run here is evidence about the markup, not an accessibility result.
//
// It also does not assert that the picker replaces the range picker: that is
// App.tsx's branch on the mode, and it is asserted where the header is rendered.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetSelectedSnapshot, selectedSnapshot, setSelectedSnapshot } from '../cribl/accel/selection'
import type { AccelRun, SnapshotTimeline } from '../cribl/accel/status'
import { SnapshotPicker } from './SnapshotPicker'
import { NEWEST, coverageAt, horizonLine, snapshotOptions } from './snapshotPickerCopy'

const HOUR = 3_600_000
const T = 1_789_600_000_000

const run = (id: string, at: number): AccelRun => ({
  id,
  outcome: 'completed',
  running: false,
  createdAt: at,
  startedAt: at,
  completedAt: at,
  at,
})

/** A timeline as `snapshotTimeline` answers with one. */
function timelineOf(
  entries: Array<{ id: string; runs: AccelRun[]; boundBy?: 'keepLastN' | 'retention'; error?: string }>,
): SnapshotTimeline {
  const built = entries.map((e) => ({
    id: e.id as SnapshotTimeline['entries'][number]['id'],
    runs: e.runs,
    horizon: { ms: 24 * HOUR, boundBy: e.boundBy ?? ('keepLastN' as const) },
    denied: false,
    error: e.error ?? null,
  }))
  const times = [...new Set(built.flatMap((e) => e.runs.map((r) => r.at as number)))].sort((a, b) => b - a)
  return {
    entries: built,
    times,
    oldestAt: times.length > 0 ? times[times.length - 1] : null,
    denied: false,
    error: built.find((e) => e.error !== null)?.error ?? null,
    checkedAt: T,
  }
}

const HOURLY = timelineOf([
  { id: 'gno_overview_c1h', runs: [run('a', T - HOUR), run('b', T - 2 * HOUR), run('c', T - 3 * HOUR)] },
  { id: 'gno_lake_30d_c1d', runs: [run('lake', T - 8 * HOUR)] },
])

describe('the options', () => {
  it('puts Newest first, and it is not the same option as the newest time', () => {
    // A reader who picked 09:20 an hour ago should still be looking at 09:20; a
    // reader on Newest should have moved on. Collapsing the two would silently
    // un-pin somebody's chosen moment the next time the schedule fired.
    const options = snapshotOptions(HOURLY.times, T)
    expect(options[0]).toEqual({ value: NEWEST, label: 'Newest snapshot' })
    expect(options.slice(1).map((o) => o.value)).toEqual(HOURLY.times.map(String))
  })

  it('labels each one by its own clock time', () => {
    const options = snapshotOptions([T - HOUR], T)
    expect(options[1].label).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('what the line under it says', () => {
  it('names how far back the list goes', () => {
    expect(horizonLine(HOURLY, null, T)).toContain('4 stored runs')
    expect(horizonLine(HOURLY, null, T)).toMatch(/back to \d/)
  })

  it('says how many sets answered the moment that was picked', () => {
    // The hourly entries and the daily one do not align. Five hours back the
    // daily run (eight hours old) had already finished and the hourly set had
    // not yet started, so one set answers and the other's panels show nothing.
    // Saying so is what stops the control implying a coherence that is not there.
    expect(horizonLine(HOURLY, T - 3 * HOUR, T)).toContain('2 of 2 sets')
    expect(horizonLine(HOURLY, T - 5 * HOUR, T)).toContain('1 of 2 sets')
    expect(horizonLine(HOURLY, T - 9 * HOUR, T)).toContain('0 of 2 sets')
  })

  it('counts only entries whose history could be read', () => {
    // An entry the account cannot list is not an entry with no run. Folding the
    // two together would report a permissions problem as a gap in the timeline.
    const partial = timelineOf([
      { id: 'gno_overview_c1h', runs: [run('a', T - HOUR)] },
      { id: 'gno_lake_30d_c1d', runs: [], error: 'refused' },
    ])
    expect(coverageAt(partial, T)).toEqual({ answered: 1, total: 1 })
  })

  it('explains an empty picker rather than leaving it looking broken', () => {
    // The normal state of a fresh install: nothing has been applied yet.
    const empty = timelineOf([{ id: 'gno_overview_c1h', runs: [] }])
    expect(horizonLine(empty, null, T)).toContain('Guided Setup')
  })

  it('says when it is the platform, not the schedule, that ends the list', () => {
    const reaped = timelineOf([{ id: 'gno_overview_c1h', runs: [run('a', T - HOUR)], boundBy: 'retention' }])
    expect(horizonLine(reaped, null, T)).toContain('seven days')
  })

  it('does not report a refusal as an empty past', () => {
    expect(horizonLine({ ...HOURLY, denied: true }, null, T)).toContain('cannot list')
  })
})

describe('the control, rendered', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    resetSelectedSnapshot()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    resetSelectedSnapshot()
  })

  const render = (timeline?: SnapshotTimeline) =>
    act(() => {
      root.render(
        <DashboardProvider>
          <SnapshotPicker timeline={timeline} />
        </DashboardProvider>,
      )
    })

  const select = () => container.querySelector('select') as HTMLSelectElement

  it('offers every stored run, newest first, under Newest', () => {
    render(HOURLY)
    expect([...select().options].map((o) => o.textContent)).toHaveLength(HOURLY.times.length + 1)
    expect(select().value).toBe(NEWEST)
  })

  it('moves the whole app when one is picked', () => {
    render(HOURLY)
    act(() => {
      select().value = String(T - 2 * HOUR)
      select().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(selectedSnapshot()).toBe(T - 2 * HOUR)
  })

  it('goes back to following the newest run', () => {
    setSelectedSnapshot(T - 2 * HOUR)
    render(HOURLY)
    act(() => {
      select().value = NEWEST
      select().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(selectedSnapshot()).toBe(null)
  })

  it('cannot be used when nothing is stored', () => {
    // Disabled rather than empty: there is genuinely nothing to choose, and the
    // sentence beside it says why.
    render(timelineOf([{ id: 'gno_overview_c1h', runs: [] }]))
    expect(select().disabled).toBe(true)
    expect(container.textContent).toContain('Guided Setup')
  })

  it('keeps a moment that has aged out of the list rather than silently un-picking it', () => {
    // The run dropped off while the tab was open. The panels are still answering
    // for that moment, so a control that jumped back to Newest would disagree
    // with the screen — which is worse than one offering a time that has gone.
    setSelectedSnapshot(T - 40 * HOUR)
    render(HOURLY)
    expect(selectedSnapshot()).toBe(T - 40 * HOUR)
  })

  it('carries its sentence as visible text, not only as a hover title', () => {
    render(HOURLY)
    const note = container.querySelector('#snapshot-at-note')
    expect(note?.className).not.toContain('sr-only')
    expect(select().getAttribute('aria-describedby')).toBe('snapshot-at-note')
    expect(container.querySelector('label[for="snapshot-at"]')?.textContent).toBe('Snapshot')
  })
})
