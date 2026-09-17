// What a status pill is allowed to be, checked on the rendered DOM.
//
// Three of these assertions exist because of a colour measurement that lives
// somewhere else. src/app/contrast.test.ts proves the ink `<StatusPill>` uses
// clears 4.5:1 in both themes — but only for the variant it actually renders,
// and Capra's default is a different one that measures 3.16–3.91:1. So the
// variant is pinned here, on the attribute Capra's stylesheet keys off, and the
// two files together are the guarantee. Either one alone is a comment.
//
// The rest is the rule the UX spec states as "always word + glyph + colour,
// never colour alone": every pill says its state in words, and every pill that
// makes a colour claim carries a glyph as well.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StatusPill, type StatusState } from './StatusPill'

/** Every state the type admits. Listed, not derived, so adding one to the union
 *  without deciding what it looks like fails the type-check here. */
const ALL: StatusState[] = [
  'present', 'absent', 'failed', 'skipped', 'unreadable', 'checking',
  'enabled', 'paused', 'differs', 'foreign',
  'derived', 'missing',
  'critical', 'high', 'medium', 'low',
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(state: StatusState) {
  act(() => { root.render(<StatusPill state={state} />) })
  return container.querySelector<HTMLElement>('[data-appearance]')!
}

describe('StatusPill', () => {
  it('never renders the variant that fails AA', () => {
    // Capra's Pill defaults to variant="bold", which paints white on a solid
    // fill: 3.26:1 for info, 3.16 for success, 3.91 for danger, in both themes,
    // at the 12px Capra draws a pill. If this ever reads "bold" or "muted",
    // src/app/contrast.test.ts is no longer measuring what the app paints.
    for (const state of ALL) {
      expect(render(state).dataset.variant, `${state} was drawn with the wrong Pill variant`).toBe('outline')
    }
  })

  it('says the state in words, so colour is never the only carrier', () => {
    for (const state of ALL) {
      expect(render(state).textContent).toContain(state)
    }
  })

  it('carries a glyph wherever it makes a colour claim', () => {
    // Capra supplies the icon from the appearance; `default` has none, and needs
    // none — a neutral pill is not claiming anything the colour could be the
    // only evidence for.
    for (const state of ALL) {
      const pill = render(state)
      const neutral = pill.dataset.appearance === 'default'
      expect(
        pill.querySelector('svg') !== null,
        neutral ? `${state} grew a glyph the neutral appearance does not have` : `${state} is colour and words but no glyph`,
      ).toBe(!neutral)
    }
  })

  it('does not call an undeployed resource a failure', () => {
    // The change this component makes on purpose. `.gs-missing` painted `absent`
    // danger, so a fresh install opened Guided Setup on five red rows describing
    // the expected state of a stack nobody had deployed yet. `failed` — a write
    // Cribl refused — is the one that stays red.
    expect(render('absent').dataset.appearance).toBe('default')
    expect(render('failed').dataset.appearance).toBe('danger')
  })

  it('maps severity onto the same four appearances the rest of the app uses', () => {
    // Findings had its own four-class family for this. The point of the
    // component is that "critical" and "a write that failed" are one colour.
    expect(render('critical').dataset.appearance).toBe('danger')
    expect(render('high').dataset.appearance).toBe('warning')
    expect(render('medium').dataset.appearance).toBe('info')
    expect(render('low').dataset.appearance).toBe('default')
  })
})
