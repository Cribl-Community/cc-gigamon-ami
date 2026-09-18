// Whether a panel's query is held back, and — far more importantly — whether it
// is ever held back FOREVER.
//
// The win this hook exists for is measured elsewhere (jobs from one user are
// admitted ~1.6 s apart, so six on one mount means the last begins at ~8 s).
// What a test can hold still is the failure side, and every failure here is the
// same shape: a panel that never loads. So these are mostly assertions that
// `near` becomes true — through the observer, through focus, through the
// synchronous rect check, and through the API simply not existing.
//
// HAPPY-DOM HAS NO LAYOUT, AND AN IntersectionObserver THAT NEVER FIRES. Rects
// are stubbed to place a panel, and the observer is replaced with one this file
// can fire by hand. What that costs is listed at the bottom; read it before
// claiming this proves the deferral works in a browser.

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEAR_MARGIN_PX, useNearViewport, type UseNearViewportOptions } from './nearViewport'

interface FakeObserver {
  el: Element | null
  disconnected: boolean
  fire: (isIntersecting: boolean) => void
}

let observers: FakeObserver[] = []

/** An IntersectionObserver that never fires on its own, so every arrival in
 *  this file is one the test caused. */
function stubObserver(): void {
  class IO {
    private readonly cb: (entries: Array<{ isIntersecting: boolean }>) => void
    private readonly self: FakeObserver
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
      this.cb = cb
      this.self = {
        el: null,
        disconnected: false,
        fire: (isIntersecting: boolean) => act(() => this.cb([{ isIntersecting }])),
      }
      observers.push(this.self)
    }
    observe(el: Element) {
      this.self.el = el
    }
    disconnect() {
      this.self.disconnected = true
    }
    unobserve() {}
  }
  vi.stubGlobal('IntersectionObserver', IO)
}

/** Put every element at this position relative to the viewport. happy-dom
 *  answers 0 for every rect, which the hook reads as "not laid out". */
function stubRect(top: number, height = 200): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    top,
    bottom: top + height,
    left: 0,
    right: 400,
    width: 400,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect)
}

let container: HTMLDivElement
let root: Root
let seen = false
let node: HTMLElement | null = null

function Probe({ opts }: { opts: UseNearViewportOptions }): ReactNode {
  const near = useNearViewport(opts)
  seen = near.near
  return createElement('div', {
    ref: (el: HTMLElement | null) => {
      node = el
      near.ref(el)
    },
  })
}

async function mount(opts: UseNearViewportOptions = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { opts }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  observers = []
  seen = false
  node = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.innerHeight = 800
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a panel below the fold', () => {
  it('waits, and then loads when it comes near', async () => {
    stubObserver()
    stubRect(4000) // four screens down
    await mount()
    expect(seen, 'a panel four screens down submitted its query on mount').toBe(false)
    expect(observers).toHaveLength(1)
    expect(observers[0].el).toBe(node)

    observers[0].fire(true)
    expect(seen).toBe(true)
  })

  it('stops watching once it has arrived, and never goes back', async () => {
    // `near` feeds a hook's dependency key. Flipping back would re-submit the
    // query the moment the reader scrolls past — the opposite of the point.
    stubObserver()
    stubRect(4000)
    await mount()
    observers[0].fire(true)
    expect(observers[0].disconnected, 'the observer kept watching an arrived panel').toBe(true)

    observers[0].fire(false)
    expect(seen).toBe(true)
  })

  it('loads when focus reaches it, without waiting for a scroll', async () => {
    // Keyboard tabbing and the guided tour both land focus in a panel. The
    // observer would catch up a frame later; a reader standing in the panel
    // should not be looking at a spinner in the meantime.
    stubObserver()
    stubRect(4000)
    await mount()
    expect(seen).toBe(false)

    await act(async () => {
      node!.dispatchEvent(new Event('focusin', { bubbles: true }))
    })
    expect(seen).toBe(true)
    expect(observers[0].disconnected).toBe(true)
  })
})

describe('a panel that must not be held back', () => {
  it('runs on the first render when it is marked eager', async () => {
    stubObserver()
    stubRect(4000) // even four screens down: eager wins, nothing is observed
    await mount({ eager: true })
    expect(seen).toBe(true)
    expect(observers, 'an eager panel was observed instead of just running').toHaveLength(0)
  })

  it('runs immediately when it is already on screen — no observer, no extra frame', async () => {
    // The whole first-paint argument. A short screen, a tall screen and a
    // collapsed sidebar all end up here, and none of them may pay a frame.
    stubObserver()
    stubRect(100)
    await mount()
    expect(seen).toBe(true)
    expect(observers).toHaveLength(0)
  })

  it('runs when it is within the margin but not yet visible', async () => {
    stubObserver()
    stubRect(800 + NEAR_MARGIN_PX - 10)
    await mount()
    expect(seen, 'a panel inside the load-ahead margin was deferred anyway').toBe(true)
  })

  it('waits when it is just outside the margin', async () => {
    stubObserver()
    stubRect(800 + NEAR_MARGIN_PX + 10)
    await mount()
    expect(seen).toBe(false)
  })

  it('runs everywhere IntersectionObserver does not exist', async () => {
    // Failing open is the only safe direction: a slower mount against a panel
    // that is blank for the life of the session.
    stubRect(4000)
    vi.stubGlobal('IntersectionObserver', undefined)
    await mount()
    expect(seen).toBe(true)
  })

  it('runs when the environment cannot say where anything is', async () => {
    // happy-dom's own answer — every rect zero — and any element not yet laid
    // out. "I cannot tell" resolves the same way every uncertainty here does.
    //
    // THIS IS WHY EVERY OTHER TEST IN THIS REPO STILL PASSES UNCHANGED. happy-dom
    // does supply an IntersectionObserver (one that never fires), so without
    // this branch every deferred panel in every tab test would have waited for
    // a callback that was never coming.
    stubObserver()
    await mount()
    expect(seen).toBe(true)
    expect(observers).toHaveLength(0)
  })
})

// ── What this file could not assert, and why ────────────────────────────────
//  * THAT DEFERRAL MAKES ANYTHING FASTER. The measurement it is built on (~1.6 s
//    between admissions) is a property of the Cribl workspace, not of this
//    repo. Nothing here runs a search.
//  * THAT A REAL IntersectionObserver FIRES. happy-dom implements none, so the
//    stub above is the only one these tests have ever seen. The rootMargin
//    string this hook passes it is therefore unverified by any test — it is
//    checked by eye against the same NEAR_MARGIN_PX the rect path uses.
//  * THAT SCROLLING REACHES A PANEL. There is no layout and no scrolling here;
//    the "comes near" cases are the stub's callback being called by hand.
//  * THAT KEYBOARD NAVIGATION REACHES A PANEL. happy-dom has no sequential
//    focus navigation, so the focus case dispatches `focusin` directly rather
//    than pressing Tab until focus lands in the panel.
