// What a panel says about its own numbers, and what it contributes to the
// header's count.
//
// Two things here are load-bearing and easy to break by accident:
//
//   1. THE DENOMINATOR. Every mounted `<Panel>` is counted, snapshot-served or
//      not. A census that registered only the served ones would report `3 of 3`
//      on a tab of six and the header's headline number would be quietly false
//      — which is the exact failure the count exists to prevent.
//   2. THE SLOT IS RELEASED. A panel that unmounts and leaves its slot behind
//      makes the count climb for the life of the tab, so by the fourth
//      navigation the header claims forty panels on a tab of six.
//
// ── WHAT THIS FILE COULD NOT ASSERT ─────────────────────────────────────────
// That the caption is legible at 12px beside a panel title, and that the "Run
// live" chip clears a 24px target. happy-dom has no layout: every box is 0×0
// and no computed style is resolved. The colour pairings the caption uses are
// measured in src/app/contrast.test.ts; the target size comes from App.css's
// own min-height rule, which nothing in this environment can read back.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDataMode, setDataMode } from '../cribl/dataMode'
import { Panel } from './Panel'
import { resetSnapshotCensus, useSnapshotCensus, type SnapshotCensus } from './snapshotCensus'

let container: HTMLDivElement
let root: Root
let census: SnapshotCensus = { panels: 0, snapshotted: 0, oldest: null }

/** Reads the same store the header reads, so the count under test is the one a
 *  customer sees rather than a second implementation of it. */
function CensusProbe() {
  census = useSnapshotCensus()
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetDataMode()
  resetSnapshotCensus()
  census = { panels: 0, snapshotted: 0, oldest: null }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetDataMode()
  resetSnapshotCensus()
})

const NOW = Date.now()
const AN_HOUR = 3600_000

const draw = (children: React.ReactNode) =>
  act(() => {
    root.render(
      <>
        <CensusProbe />
        {children}
      </>,
    )
  })

const note = () => container.querySelector('.snap-note')
const chip = () => container.querySelector<HTMLButtonElement>('.panel .chip')

describe('a panel’s own words about where its number came from', () => {
  it('dates a snapshot with the clock and the age', () => {
    draw(
      <Panel title="Lake total" snapshot={{ source: 'schedule', outcome: 'fresh', at: NOW - 42 * 60_000, stale: false }}>
        <p>rows</p>
      </Panel>,
    )
    expect(note()!.textContent).toContain('42m ago')
    expect(note()!.className).toContain('snap-note-fresh')
    // read.ts's own sentence, never Cribl's words.
    expect(note()!.getAttribute('title')).toBe('From the scheduled run.')
  })

  it('says nothing at all for a panel that never had a schedule', () => {
    // 37 of the 39 panels are in this state. A caption here would put a
    // permanent, meaningless shortfall on every tab.
    draw(
      <Panel title="TLS versions">
        <p>rows</p>
      </Panel>,
    )
    expect(note()).toBeNull()
  })

  it('flags an overdue schedule without hiding the number', () => {
    draw(
      <Panel title="Lake total" snapshot={{ source: 'schedule', outcome: 'stale', at: NOW - 5 * AN_HOUR, stale: true }}>
        <p>8.2 TB</p>
      </Panel>,
    )
    expect(note()!.className).toContain('snap-note-overdue')
    expect(container.querySelector('.panel-body')!.textContent, 'the number went away with the warning').toBe('8.2 TB')
  })
})

describe('the per-panel Live control', () => {
  const served = { source: 'schedule' as const, outcome: 'fresh' as const, at: NOW, stale: false }

  it('is offered only where there is a snapshot to escape from', () => {
    draw(
      <Panel title="A" snapshot={served} onRunLive={() => {}}>
        <p>a</p>
      </Panel>,
    )
    expect(chip()!.textContent).toBe('Run live')
    expect(chip()!.getAttribute('aria-pressed')).toBe('false')

    draw(
      <Panel title="A" snapshot={{ source: 'live', outcome: 'no-run', at: null, stale: false }} onRunLive={() => {}}>
        <p>a</p>
      </Panel>,
    )
    expect(chip(), 'a live panel was given a second refresh button that differs only by an invisible mode').toBeNull()
  })

  it('keeps the way back once it is on', () => {
    // `liveOnly` makes the panel live, so the "is it snapshot-served" test now
    // says no. A control that hid itself the moment it was pressed would strand
    // the viewer on a live panel with no way back to the stored run.
    draw(
      <Panel title="A" snapshot={served} onRunLive={() => {}} liveOnly>
        <p>a</p>
      </Panel>,
    )
    expect(chip()!.textContent).toBe('Live · back to snapshot')
    expect(chip()!.getAttribute('aria-pressed')).toBe('true')
    expect(note()!.textContent).toBe('live · you asked for this one now')
  })

  it('disappears in global Live mode, where there is nothing left to escape', () => {
    act(() => setDataMode('live'))
    draw(
      <Panel title="A" snapshot={served} onRunLive={() => {}}>
        <p>a</p>
      </Panel>,
    )
    expect(chip()).toBeNull()
  })

  it('does not flip the global mode', () => {
    // It is local and visit-scoped by construction: the tab owns the boolean.
    // The assertion is that pressing it reaches the tab's handler and nothing
    // else — a control that also moved the app-wide store would silently bill
    // every other panel on the tab.
    let pressedCount = 0
    draw(
      <Panel title="A" snapshot={served} onRunLive={() => { pressedCount += 1 }}>
        <p>a</p>
      </Panel>,
    )
    act(() => chip()!.click())
    expect(pressedCount).toBe(1)
    expect(census.snapshotted, 'the per-panel control changed the app-wide census').toBe(1)
  })
})

describe('the header census', () => {
  it('counts every mounted panel, not only the served ones', () => {
    draw(
      <>
        <Panel title="A" snapshot={{ source: 'schedule', outcome: 'fresh', at: NOW - 10 * 60_000, stale: false }}>
          <p>a</p>
        </Panel>
        <Panel title="B" snapshot={{ source: 'live', outcome: 'no-run', at: null, stale: false }}>
          <p>b</p>
        </Panel>
        <Panel title="C">
          <p>c</p>
        </Panel>
      </>,
    )
    expect(census.panels, 'the denominator counted only the panels with a schedule').toBe(3)
    expect(census.snapshotted).toBe(1)
  })

  it('reports the OLDEST snapshot, which is the one that decides whether to trust the screen', () => {
    draw(
      <>
        <Panel title="A" snapshot={{ source: 'schedule', outcome: 'fresh', at: NOW - 10 * 60_000, stale: false }}>
          <p>a</p>
        </Panel>
        <Panel title="B" snapshot={{ source: 'schedule', outcome: 'stale', at: NOW - 6 * AN_HOUR, stale: true }}>
          <p>b</p>
        </Panel>
      </>,
    )
    expect(census.oldest).toBe(NOW - 6 * AN_HOUR)
  })

  it('never counts a panel it cannot date', () => {
    // An undated stored result cannot be labelled, and the label is the whole
    // safety argument. read.ts already falls back to live rather than return
    // one; this is the second line.
    draw(
      <Panel title="A" snapshot={{ source: 'schedule', outcome: 'undated', at: null, stale: false }}>
        <p>a</p>
      </Panel>,
    )
    expect(census.snapshotted).toBe(0)
    expect(census.panels).toBe(1)
  })

  it('releases a panel’s slot when it unmounts', () => {
    // Every navigation unmounts a tab's panels. A registry that leaked would
    // have the header claiming forty panels on a tab of six by the fourth tab
    // change, which reads as the count being made up.
    draw(
      <>
        <Panel title="A"><p>a</p></Panel>
        <Panel title="B"><p>b</p></Panel>
      </>,
    )
    expect(census.panels).toBe(2)
    draw(<Panel title="A"><p>a</p></Panel>)
    expect(census.panels, 'a navigated-away panel stayed in the count').toBe(1)
  })

  it('follows a panel whose read answers later', () => {
    // Every panel mounts with nothing and fills in when its query returns. A
    // census keyed on the first render would report zero snapshots for the life
    // of the tab.
    draw(<Panel title="A"><p>a</p></Panel>)
    expect(census.snapshotted).toBe(0)
    draw(
      <Panel title="A" snapshot={{ source: 'schedule', outcome: 'fresh', at: NOW, stale: false }}>
        <p>a</p>
      </Panel>,
    )
    expect(census.snapshotted).toBe(1)
    expect(census.oldest).toBe(NOW)
  })

  it('drops a panel out of the count when the viewer runs it live', () => {
    // `3 of 6` has to mean "three of these panels are showing you a stored run".
    // A panel the reader has just put back on a live query is not one of them.
    draw(
      <Panel title="A" snapshot={{ source: 'schedule', outcome: 'fresh', at: NOW, stale: false }} onRunLive={() => {}} liveOnly>
        <p>a</p>
      </Panel>,
    )
    expect(census.snapshotted).toBe(0)
    expect(census.panels).toBe(1)
  })
})
