// The control, rendered.
//
// modeToggleCopy.test.ts already holds the words still. What is left here is the
// half that only exists in a DOM: that the two segments are one group with one
// pressed state, that pressing one MOVES A MOUNTED PANEL — the defect the whole
// store rewrite exists for — and that a refused write reaches the screen as
// visible text rather than a hover title.
//
// ── WHAT THIS FILE COULD NOT ASSERT, AND WHY ────────────────────────────────
// happy-dom implements no sequential focus navigation and no layout, so three
// of §3.11's accessibility claims are unverifiable here and are NOT asserted
// anywhere:
//
//   * FOCUS ORDER. That both segments are in tab order, and that Tab moves from
//     the first to the second and then out of the group, cannot be tested: no
//     element is ever focusable-by-sequence in this environment. What is
//     asserted instead is the mechanism — two real `<button type="button">`
//     with no `tabindex`, which is what puts them in tab order in a browser.
//   * HIT AREA. `.seg` takes a 24px min-height from App.css's target-size rule.
//     happy-dom reports every box as 0×0, so the rule is read by
//     src/app/contrast.test.ts's sibling machinery and not measured here.
//   * THAT IT READS AS ONE CONTROL. Whether a screen reader announces "Data
//     source, group" and then each segment's pressed state is a property of the
//     assistive technology, not of the DOM. The `role`, the `aria-label`, the
//     `aria-pressed` pair and the `aria-describedby` target are asserted; how
//     they are spoken is not.
//
// A green run here is therefore not an accessibility result. It is evidence
// about the markup the result would depend on.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { dataMode, registerDataModeWriter, resetDataMode, setDataMode } from '../cribl/dataMode'
import { ModeToggle } from './ModeToggle'
import { Panel } from './Panel'
import { resetSnapshotCensus } from './snapshotCensus'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetDataMode()
  resetSnapshotCensus()
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

function render(children?: React.ReactNode) {
  act(() => {
    root.render(
      <DashboardProvider>
        <ModeToggle tabName="Data Flow" />
        {children}
      </DashboardProvider>,
    )
  })
}

const segments = () => [...container.querySelectorAll<HTMLButtonElement>('.mode-toggle .seg')]
const pressed = () => segments().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent)
const stateLine = () => container.querySelector('.mode-state')?.textContent ?? null

describe('the Snapshot / Live control', () => {
  it('is one group of two buttons, exactly one of them pressed', () => {
    render()
    const group = container.querySelector('.mode-toggle')
    expect(group?.getAttribute('role')).toBe('group')
    expect(group?.getAttribute('aria-label')).toBe('Data source')
    expect(segments()).toHaveLength(2)
    expect(pressed()).toEqual(['Snapshot'])
  })

  it('is not a third look-alike <select>', () => {
    // The header already carries two `.range-select`, and only this control
    // changes what the numbers mean. Two of anything that looks the same is a
    // pattern; three is a trap.
    render()
    expect(container.querySelector('.mode-toggle select')).toBeNull()
    for (const b of segments()) expect(b.getAttribute('type')).toBe('button')
  })

  it('never says "Fast"', () => {
    // A speed promise nobody has measured in a browser. `Snapshot` is a claim
    // about WHEN the number was computed, which is measured and dated.
    render()
    expect(container.textContent).not.toContain('Fast')
  })

  it('moves a mounted panel when it is pressed — the defect the store exists for', () => {
    // The old `useAccelEnabled()` was `useState(true)` plus a one-way mount
    // effect: a header segment wired to it flipped `aria-pressed` and changed
    // nothing on screen. This is that assertion, from the outside.
    render(
      <Panel
        title="Lake total"
        snapshot={{ source: 'schedule', outcome: 'fresh', at: Date.now(), stale: false }}
        onRunLive={() => {}}
      >
        <p>rows</p>
      </Panel>,
    )
    expect(container.querySelector('.panel .chip')?.textContent, 'the per-panel Live control was missing in Snapshot mode').toBe(
      'Run live',
    )

    act(() => segments()[1].click())
    expect(dataMode()).toBe('live')
    expect(pressed()).toEqual([segments()[1].textContent])
    expect(
      container.querySelector('.panel .chip'),
      'switching the app to Live left a per-panel Live control offering an escape already taken',
    ).toBeNull()
  })

  it('shows the census beside it in Snapshot mode and stands down in Live', () => {
    render(
      <Panel title="A" snapshot={{ source: 'schedule', outcome: 'fresh', at: Date.now(), stale: false }}>
        <p>a</p>
      </Panel>,
    )
    expect(stateLine()).toContain('1 of 1 panel')
    act(() => segments()[1].click())
    expect(stateLine(), 'the snapshot census survived the switch to Live').toBeNull()
  })

  it('says plainly when nothing on the tab has a snapshot', () => {
    render(
      <Panel title="A">
        <p>a</p>
      </Panel>,
    )
    expect(stateLine()).toContain('everything on this tab is live')
  })

  it('puts a refused write on screen as text, not in a title', () => {
    // GatedControl's rule: the reason a control behaves unexpectedly is never
    // hover-only. `saveAccelPref` answers false on the dev page and wherever the
    // platform names no signed-in user, and the mode still works for the
    // session — which is what the line has to say.
    render()
    expect(container.querySelector('.mode-unsaved')).toBeNull()
    act(() => segments()[1].click())
    const line = container.querySelector('.mode-unsaved')
    expect(line?.textContent).toContain('could not be saved')
    expect(line?.getAttribute('title'), 'the reason was hidden behind a hover').toBeNull()
  })

  it('says nothing about saving when the store took the choice', async () => {
    registerDataModeWriter(async () => true)
    render()
    act(() => segments()[1].click())
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('.mode-unsaved')).toBeNull()
  })

  it('describes the group by a note that is on the page, not an orphan id', () => {
    render()
    const id = container.querySelector('.mode-toggle')?.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    const note = container.querySelector(`#${CSS.escape(id!)}`)
    expect(note, 'aria-describedby pointed at nothing').not.toBeNull()
    expect(note!.className).toBe('sr-only')
    expect(note!.textContent).toContain('costs search credits')
  })

  it('follows the store when something else changes the mode', () => {
    // A stored preference landing after first paint, and the per-tab code that
    // will read the same store. A control that only moved on its own click
    // would disagree with the panels underneath it.
    render()
    act(() => setDataMode('live'))
    expect(pressed()).toEqual([segments()[1].textContent])
  })
})
