// What an ⓘ has to do, checked on the rendered DOM.
//
// Guided Setup moved most of its explanations behind these, so the tip is now
// the only place a customer can read them. Three things hold that up: the
// words are reachable without a mouse (the icon is focusable and carries them
// as its accessible name), the tip opens on a tap as well as on hover and focus,
// and an open tip can be dismissed.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InfoTip } from './InfoTip'

const TEXT = 'Partitions are fixed when a Lake dataset is created.'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<InfoTip text={TEXT} />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const icon = () => container.querySelector<HTMLElement>('.infotip')!
const pop = () => container.querySelector<HTMLElement>('.infotip-pop')!
const isOpen = () => icon().classList.contains('infotip-open')

describe('InfoTip', () => {
  it('is a focusable note whose accessible name is the whole explanation', () => {
    expect(icon().getAttribute('role')).toBe('note')
    expect(icon().getAttribute('tabindex')).toBe('0')
    expect(icon().getAttribute('aria-label')).toBe(TEXT)
    expect(pop().getAttribute('role')).toBe('tooltip')
    expect(pop().textContent).toBe(TEXT)
    // Never the unstyleable native tooltip.
    expect(icon().hasAttribute('title')).toBe(false)
  })

  it('starts closed, and opens on hover', () => {
    expect(isOpen()).toBe(false)
    act(() => { icon().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })) })
    expect(isOpen()).toBe(true)
    act(() => { icon().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    expect(isOpen()).toBe(false)
  })

  it('opens on keyboard focus and closes on Escape', () => {
    act(() => icon().focus())
    expect(isOpen()).toBe(true)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(isOpen()).toBe(false)
  })

  it('toggles on a click or tap, which is the only reveal a touch screen has', () => {
    act(() => { icon().click() })
    expect(isOpen()).toBe(true)
    act(() => { icon().click() })
    expect(isOpen()).toBe(false)
  })

  it('does not let a click reach the control it sits inside', () => {
    let reached = false
    act(() => root.render(<label onClick={() => { reached = true }}>Field <InfoTip text={TEXT} /></label>))
    act(() => { icon().click() })
    expect(reached).toBe(false)
  })

  it('closes on a press outside it and on scroll', () => {
    act(() => { icon().click() })
    expect(isOpen()).toBe(true)
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(isOpen()).toBe(false)

    act(() => { icon().click() })
    expect(isOpen()).toBe(true)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(isOpen()).toBe(false)
  })

  it('positions an open pop from the icon rather than inside its card', () => {
    act(() => { icon().click() })
    // Inline coordinates are what let the pop escape a `.panel`'s
    // `overflow: hidden`; the fixed positioning itself is App.css's.
    expect(pop().style.top).not.toBe('')
    expect(pop().style.left).not.toBe('')
  })
})

// ── What this file could not assert, and why ────────────────────────────────
//
//   * THAT THE POP IS VISIBLE AND UNCLIPPED. happy-dom does no layout, so every
//     rect is zero and no stylesheet is applied; the placement arithmetic runs on
//     zeros. Checking that a tip on a panel's first line is not cut off needs a
//     real browser.
