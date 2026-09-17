// The last stretch of the promise: what the ⓘ actually PUTS ON SCREEN.
//
// display.json freezes the query string each surface points at. This freezes
// what happens to that string on the way to the customer's eyes. PanelInfo runs
// every query through pretty() before rendering it, before the Copy button
// writes it, and before "Open in Search" links it — so one line changed in this
// component rewrites what all 61 ⓘ popovers show while display.json stays
// byte-identical. Phase 1 rewrites this exact component.
//
// The transformation is documented, singular and deliberate: one pipeline clause
// per line, nothing else. So the expected text below is written out in full
// rather than computed with the same regex the component uses — a test that
// reimplements the code it checks agrees with the bug.
//
// Both halves of the popover are checked, because display.json freezes both and
// only one of them used to be verified here: the QUERY (the code block, the copy
// payload, and the `q` the deep link carries) and the PROSE (the `info=` words,
// which reach the screen through the same component and could stop rendering
// with every frozen string still byte-identical). The deep link's TIME BOUND is
// asserted too — `et` is half of what a query means, and nothing checked it.
//
// What this file does NOT establish: that the query handed to PanelInfo is the
// one that produced the number beside it. See the header of
// src/queries/display-freeze.test.ts — that is a human review question.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { PanelInfo, placePopover, type AnchorBox } from './PanelInfo'

// A query with every shape the pretty-printer touches: a leading filter with no
// pipe, three pipeline clauses, and a trailing `| limit` — the clause a "tidy
// up" is most likely to drop.
const QUERY =
  'dataset="gigamon_ami" app_name="dns" dns_host=* | summarize p50=percentile(dns_response_time,50), total=count() by dns_host | sort by total desc | limit 500'

const AS_SHOWN = [
  'dataset="gigamon_ami" app_name="dns" dns_host=*',
  '| summarize p50=percentile(dns_response_time,50), total=count() by dns_host',
  '| sort by total desc',
  '| limit 500',
].join('\n')

let container: HTMLDivElement
let root: Root
let copied: string | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  copied = null
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { copied = t; return Promise.resolve() } },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const ABOUT = 'Per-resolver p50 latency.'
/** DashboardProvider's own default range — what a customer's first click carries. */
const DEFAULT_EARLIEST = '-15m'

/** Render one ⓘ and open its popover, the way a customer does. */
function openPopover(query: string) {
  act(() => {
    root.render(
      <DashboardProvider>
        <PanelInfo about={ABOUT} query={query} />
      </DashboardProvider>,
    )
  })
  const btn = container.querySelector<HTMLButtonElement>('.pinfo-btn')
  expect(btn, 'PanelInfo rendered no ⓘ button').not.toBeNull()
  act(() => btn!.click())
}

describe('PanelInfo', () => {
  it('shows the query under its one documented transformation, clause per line', () => {
    openPopover(QUERY)
    const code = container.querySelector('.pinfo-code')
    expect(code, 'the popover rendered no query block').not.toBeNull()
    expect(
      code!.textContent,
      'The ⓘ is showing the customer something other than the frozen query, one clause per line. ' +
        'display.json cannot see this: it freezes the query going in, not what this component renders.',
    ).toBe(AS_SHOWN)
  })

  it('copies exactly what it displays', async () => {
    openPopover(QUERY)
    const copy = container.querySelector<HTMLButtonElement>('.pinfo-copy')
    expect(copy, 'the popover rendered no Copy button').not.toBeNull()
    await act(async () => { copy!.click() })
    expect(copied, 'Copy wrote something other than the query on screen.').toBe(AS_SHOWN)
  })

  it('still shows the words as well as the query', () => {
    // display.json freezes the `info=` prose of every surface, and this is the
    // one component that renders it. One deleted line here and 77 popovers stop
    // explaining anything while the snapshot stays byte-identical — the prose
    // half of the promise was never checked on the screen until now.
    openPopover(QUERY)
    expect(
      container.querySelector('.pinfo-about')?.textContent,
      'The ⓘ rendered its query but not the words that say what the number means.',
    ).toBe(ABOUT)
  })

  it('links to Cribl Search with the query unmodified, over the range on screen', () => {
    // The deep link must carry the query Cribl Search will actually run, which
    // is the one-line original — not the display form. And the TIME BOUND is
    // half of what the query means: the same KQL over -15m and over -24h are two
    // different claims, so `et` is pinned here too.
    openPopover(QUERY)
    const link = container.querySelector<HTMLAnchorElement>('.pinfo-code-link')
    expect(link, 'the query block is not a link into Cribl Search').not.toBeNull()
    const url = new URL(link!.getAttribute('href')!, 'https://cribl.example')
    expect(url.searchParams.get('q'), 'The "Open in Search" link carries a different query from the one on screen.').toBe(QUERY)
    expect(
      [url.searchParams.get('et'), url.searchParams.get('lt')],
      'The "Open in Search" link opens over a different window from the dashboard, so it answers a different question.',
    ).toEqual([DEFAULT_EARLIEST, 'now'])
  })

  it('renders no query block at all when a panel has only prose', () => {
    // An ⓘ with no query must not invent one — several diagram nodes and the
    // "not observable in this feed" panel carry explanation only.
    act(() => {
      root.render(
        <DashboardProvider>
          <PanelInfo about="Techniques this feed has no signal for." />
        </DashboardProvider>,
      )
    })
    act(() => container.querySelector<HTMLButtonElement>('.pinfo-btn')!.click())
    expect(container.querySelector('.pinfo-about')?.textContent).toBe('Techniques this feed has no signal for.')
    expect(container.querySelector('.pinfo-code'), 'a query block appeared for an ⓘ with no query').toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Phase 1.5 — placement, focus and dismissal.
//
// What this environment CAN and CANNOT check, said plainly up front, because a
// test that cannot fail is worse than no test:
//
//  * happy-dom has NO layout engine. `getBoundingClientRect()` returns all
//    zeros, `scrollHeight` is 0, nothing has a font. So nothing below asserts
//    that a real popover is 482px tall. The placement arithmetic is tested
//    directly, against numbers measured by hand off the frozen content, and the
//    component is tested by stubbing the two measurements it reads and checking
//    the style it computes from them. The measurements are inputs here, never
//    claims.
//  * happy-dom has NO sequential focus navigation — pressing Tab moves nothing.
//    So "the Copy button is reachable" pins the DOM conditions the Tab path
//    depends on, not the traversal itself. Stated in that test too.
//  * happy-dom DOES dispatch and capture events faithfully, including the one
//    detail this component turns on: `scroll` does not bubble, but a capture
//    listener on `window` still sees a nested element's scroll. Those tests are
//    the real thing.
//  * Hit areas (SC 2.5.8, 24×24) are CSS, in the `.pinfo-btn` / `.pinfo-copy` /
//    `.pinfo-open` rules of src/App.css. There is deliberately no assertion for
//    them here: happy-dom computes no boxes, so any such test would pass on an
//    empty rectangle and keep passing after someone deleted the rule.
// ---------------------------------------------------------------------------

/** Undo the geometry stubs a test installed. */
let undoGeometry: Array<() => void> = []

afterEach(() => {
  for (const fn of undoGeometry.splice(0)) fn()
})

/**
 * Give the component the two measurements it actually reads — the trigger's
 * rect and the popover's natural height — plus a viewport. `anchor` is held by
 * reference, so a test can move it and watch the popover follow.
 */
function stubGeometry(opts: { anchor: AnchorBox; popHeight: number; viewportW?: number; viewportH?: number }) {
  const realRect = Element.prototype.getBoundingClientRect
  const realScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!
  const view = window as unknown as { innerWidth: number; innerHeight: number }
  const realW = view.innerWidth
  const realH = view.innerHeight

  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList?.contains('pinfo-btn')) {
      const a = opts.anchor
      return {
        x: a.left, y: a.top, top: a.top, bottom: a.bottom, left: a.left,
        right: a.left + 24, width: 24, height: a.bottom - a.top, toJSON: () => ({}),
      } as DOMRect
    }
    return realRect.call(this)
  }
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) { return this.classList?.contains('pinfo-pop') ? opts.popHeight : 0 },
  })
  if (opts.viewportW !== undefined) view.innerWidth = opts.viewportW
  if (opts.viewportH !== undefined) view.innerHeight = opts.viewportH

  undoGeometry.push(() => {
    Element.prototype.getBoundingClientRect = realRect
    Object.defineProperty(Element.prototype, 'scrollHeight', realScroll)
    view.innerWidth = realW
    view.innerHeight = realH
  })
}

/** Focus something outside the ⓘ, the way clicking elsewhere on the page does. */
function focusElsewhere(): HTMLButtonElement {
  const el = document.createElement('button')
  document.body.appendChild(el)
  el.focus()
  undoGeometry.push(() => el.remove())
  return el
}

describe('placePopover', () => {
  // The heights below are the ones measured off the frozen content: a median
  // popover comes to 239px, p90 to 387px, and the tallest to 482px. The app
  // runs in a Cribl iframe that is commonly 720px tall and sometimes 600px —
  // shorter than the browser window it sits in, which is the whole problem.
  const anchorAt = (top: number): AnchorBox => ({ top, bottom: top + 24, left: 300 })

  it('opens below the trigger when the popover fits below', () => {
    const p = placePopover(anchorAt(100), 387, 1024, 720)
    expect(p.side).toBe('below')
    expect(p.top).toBe(132)
    expect(p.maxHeight, 'a popover that fits needs no scroll region').toBeUndefined()
  })

  it('flips above the trigger instead of running off the bottom', () => {
    // The ⓘ at y=576–600 in a 720px iframe leaves 100px below for 387px of
    // content. The old code put it at 608 and left 275px of it — the links, the
    // Copy button and the whole KQL block — below the fold, on a fixed element
    // the page cannot scroll to and whose recovery gestures both closed it.
    const p = placePopover(anchorAt(576), 387, 1024, 720)
    expect(p.side).toBe('above')
    expect(p.top).toBe(181)
    expect(p.top + 387, 'the flipped popover must clear the trigger').toBeLessThanOrEqual(576 - 8)
    expect(p.top, 'the flipped popover must clear the top edge').toBeGreaterThanOrEqual(12)
    expect(p.maxHeight).toBeUndefined()
  })

  it('clamps and scrolls when the tallest popover fits on neither side', () => {
    // 482px of content, anchored mid-screen in a 600px iframe: 256px below,
    // 280px above, so there is no whole-popover answer. Take the roomier side
    // and let it scroll — which is only safe because scrolling it no longer
    // closes it.
    const p = placePopover(anchorAt(300), 482, 1024, 600)
    expect(p.side).toBe('clamped-above')
    expect(p.top).toBe(12)
    expect(p.maxHeight).toBe(280)
    expect(p.top + p.maxHeight!, 'the clamped popover must clear the trigger').toBeLessThanOrEqual(300 - 8)
    expect(p.top + p.maxHeight!, 'the clamped popover must stay on screen').toBeLessThanOrEqual(600 - 12)
  })

  it('covers the anchor when neither side leaves a usable band', () => {
    // A very short viewport with the ⓘ in the middle of it: 151px below, 145px
    // above. Clamping into either is not a reading experience, so the popover
    // takes the viewport and covers the anchor.
    const p = placePopover(anchorAt(165), 482, 1024, 360)
    expect(p.side).toBe('overlay')
    expect(p.top).toBe(12)
    expect(p.maxHeight).toBe(336)
    expect(p.top + p.maxHeight!).toBeLessThanOrEqual(360 - 12)
  })

  it('keeps the horizontal clamp it always had', () => {
    expect(placePopover({ top: 100, bottom: 124, left: 900 }, 200, 1024, 768).left).toBe(612)
    expect(placePopover({ top: 100, bottom: 124, left: 4 }, 200, 1024, 768).left).toBe(12)
  })
})

describe('PanelInfo placement is wired to what it measures', () => {
  it('flips the rendered popover above a trigger near the bottom of a short iframe', () => {
    stubGeometry({ anchor: { top: 576, bottom: 600, left: 300 }, popHeight: 387, viewportH: 720 })
    openPopover(QUERY)
    const pop = container.querySelector<HTMLElement>('.pinfo-pop')!
    expect(pop.style.top, 'the popover is still anchored below a trigger it does not fit below').toBe('181px')
    expect(pop.style.maxHeight).toBe('')
  })

  it('gives the rendered popover a scroll region when it has to clamp', () => {
    stubGeometry({ anchor: { top: 300, bottom: 324, left: 300 }, popHeight: 482, viewportH: 600 })
    openPopover(QUERY)
    const pop = container.querySelector<HTMLElement>('.pinfo-pop')!
    expect(pop.style.top).toBe('12px')
    expect(pop.style.maxHeight, 'a clamped popover with no max-height is just a popover off the bottom').toBe('280px')
  })

  it('follows the anchor when it moves with no scroll and no resize event', async () => {
    // A diagram canvas transform, the Cribl shell's nav collapsing, a Capra
    // drawer opening, a panel above growing when its query lands: the anchor
    // moves and nothing is dispatched. `pos` used to be computed once in the
    // click handler and never again, so the popover stayed where it was.
    const anchor: AnchorBox = { top: 100, bottom: 124, left: 300 }
    stubGeometry({ anchor, popHeight: 200, viewportH: 768 })
    openPopover(QUERY)
    expect(container.querySelector<HTMLElement>('.pinfo-pop')!.style.top).toBe('132px')

    anchor.top = 300
    anchor.bottom = 324
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })

    expect(
      container.querySelector<HTMLElement>('.pinfo-pop')!.style.top,
      'the popover stayed where the anchor used to be — the case no scroll or resize event reports',
    ).toBe('332px')
  })
})

describe('PanelInfo keyboard path', () => {
  it('moves focus into the popover when it opens', () => {
    openPopover(QUERY)
    expect(
      document.activeElement,
      'focus stayed on the trigger, so the Copy button and links are at the end of the page rather than one Tab away',
    ).toBe(container.querySelector('.pinfo-pop'))
  })

  it('names the dialog, and says on the trigger what it opens', () => {
    act(() => {
      root.render(
        <DashboardProvider>
          <PanelInfo about={ABOUT} query={QUERY} dialogLabel="How “Resolver latency” was computed" />
        </DashboardProvider>,
      )
    })
    const btn = container.querySelector<HTMLButtonElement>('.pinfo-btn')!
    expect(btn.getAttribute('aria-haspopup'), 'aria-expanded alone says "expanded" without saying what').toBe('dialog')
    act(() => btn.click())
    expect(btn.getAttribute('aria-expanded')).toBe('true')

    const pop = container.querySelector('.pinfo-pop')!
    const id = pop.getAttribute('aria-labelledby')
    expect(id, 'role="dialog" with no accessible name — about 70 of them — is a straight axe aria-dialog-name failure').toBeTruthy()
    expect(document.getElementById(id!)?.textContent).toBe('How “Resolver latency” was computed')
  })

  it('keeps the Copy button and the links inside the dialog and in the tab order', () => {
    // happy-dom implements no sequential focus navigation, so this pins the DOM
    // conditions the Tab path depends on — the controls are inside the dialog,
    // they follow the trigger in document order, and nothing removes them from
    // the tab order — rather than the traversal, which only a browser can walk.
    openPopover(QUERY)
    const pop = container.querySelector<HTMLElement>('.pinfo-pop')!
    const btn = container.querySelector<HTMLElement>('.pinfo-btn')!
    for (const sel of ['.pinfo-actions .pinfo-open', '.pinfo-copy', '.pinfo-code-link']) {
      const el = pop.querySelector<HTMLElement>(sel)
      expect(el, `${sel} is not inside the dialog`).not.toBeNull()
      expect(el!.getAttribute('tabindex'), `${sel} was taken out of the tab order`).toBeNull()
      expect(el!.hasAttribute('disabled'), `${sel} is disabled`).toBe(false)
      expect(
        btn.compareDocumentPosition(el!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${sel} comes before the trigger, so Tab leaves the popover to reach it`,
      ).toBeTruthy()
    }
  })

  it('Escape closes the popover and hands focus back to the trigger', () => {
    openPopover(QUERY)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('.pinfo-pop')).toBeNull()
    expect(
      document.activeElement,
      'the dialog unmounted with focus inside it, so focus fell to <body> and the keyboard reader is back at the top of the page',
    ).toBe(container.querySelector('.pinfo-btn'))
  })

  it('an outside click closes it and hands focus back, when it still held focus', () => {
    openPopover(QUERY)
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(container.querySelector('.pinfo-pop')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.pinfo-btn'))
  })

  it('hands focus back when the trigger itself is used to close', () => {
    // Safari does not focus a button on click, so focus can still be inside the
    // dialog when the trigger dismisses it — and an unmount with focus inside
    // drops the keyboard reader at <body>, the top of the tab order.
    openPopover(QUERY)
    const btn = container.querySelector<HTMLButtonElement>('.pinfo-btn')!
    act(() => btn.click())
    expect(container.querySelector('.pinfo-pop')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('does not snatch focus back when the reader has moved to another control', () => {
    openPopover(QUERY)
    const elsewhere = focusElsewhere()
    act(() => { elsewhere.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(container.querySelector('.pinfo-pop')).toBeNull()
    expect(document.activeElement, 'closing stole focus from the control the reader just clicked').toBe(elsewhere)
  })
})

describe('PanelInfo dismissal', () => {
  it('survives scrolling its own query block', () => {
    // `scroll` does not bubble, but the capture listener on window is still on
    // the path, so a nested element's scroll fired it. That turned the query
    // block's own scrollbar into a self-destruct button: the three longest
    // frozen queries hide 40, 9 and 3 lines below the fold of that block, and
    // the only gesture that reveals them was the one that closed the popover.
    openPopover(QUERY)
    const code = container.querySelector('.pinfo-code')!
    act(() => { code.dispatchEvent(new Event('scroll')) })
    expect(
      container.querySelector('.pinfo-pop'),
      'scrolling the query closed the popover, so the tail of a long query cannot be read',
    ).not.toBeNull()
  })

  it('survives the page scrolling while the reader is inside it', () => {
    // Tabbing to a control makes the browser scroll it into view. Closing on
    // that is the reproducible focus loss: the dialog unmounts with focus
    // inside it and focus resets to <body>.
    openPopover(QUERY)
    const copy = container.querySelector<HTMLElement>('.pinfo-copy')!
    copy.focus()
    act(() => { document.dispatchEvent(new Event('scroll')) })
    expect(container.querySelector('.pinfo-pop'), 'the browser scrolling a focused control into view closed the dialog').not.toBeNull()
    expect(document.activeElement).toBe(copy)
  })

  it('still closes when the page scrolls and the reader has moved on', () => {
    // The standard's reason for the scroll listener stands: a fixed popover
    // detaches from its anchor. Keep that, lose only the false positives.
    openPopover(QUERY)
    focusElsewhere()
    act(() => { document.dispatchEvent(new Event('scroll')) })
    expect(container.querySelector('.pinfo-pop'), 'a fixed popover left open over a scrolled page floats away from its anchor').toBeNull()
  })
})
