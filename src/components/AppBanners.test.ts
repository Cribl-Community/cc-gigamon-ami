// What the one banner slot promises, and the two ways it could quietly break.
//
// FIRST, THE ORDER. The slot's only real behaviour is that it sorts, and it
// sorts because a banner's severity is its own state rather than its position
// in the markup — the dataset-intelligence banner is a warning while it is
// asking for something and info while it is working. `collectBanners` is pure,
// so that half is tested without a DOM at all.
//
// SECOND, THE SILENCE. Two banners share this slot and each reads an
// asynchronous gate. The failure this file exists to catch is a slot that waits
// for all of them: the guided-tour nudge held off the screen because the
// dataset-intelligence probe — two network round trips, which can take seconds
// or never answer — has not come back. And the older failure underneath it, the
// one cribl/prefs.ts has a third state for: a banner shown on the first frame
// to a viewer who dismissed it months ago, and snatched away when the store
// answers. Both are about a FRAME, not a final value, so these tests look at
// what is on screen at each step rather than at the end.
//
// No JSX, and modules imported inside each test: prefs.ts keeps one document
// per page, so each case needs its own copy of it, and the JSX transform's
// import of react/jsx-runtime is static and would not move with the reset —
// the same reasoning as cribl/prefs.test.ts, which this harness follows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectBanners, type AppBanner } from './AppBanners'

const banner = (id: string, appearance: AppBanner['appearance']): AppBanner =>
  ({ id, appearance, title: id, body: id })

describe('collectBanners', () => {
  it('puts the banner a reader must not miss above the one they can ignore', () => {
    const order = collectBanners([banner('c', 'info'), banner('a', 'danger'), banner('b', 'warning')])
    expect(order.map((b) => b.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps source order within a severity, so the slot does not shuffle on re-render', () => {
    const order = collectBanners([banner('first', 'warning'), banner('second', 'warning')])
    expect(order.map((b) => b.id)).toEqual(['first', 'second'])
  })

  it('drops a source that has nothing to say without dropping the others', () => {
    // The whole contract in one line: `null` is one source's silence, never a
    // reason to hold back another's.
    const order = collectBanners([null, banner('kept', 'info'), null])
    expect(order.map((b) => b.id)).toEqual(['kept'])
  })

  it('renders nothing rather than an empty slot when every source is silent', () => {
    expect(collectBanners([null, null])).toEqual([])
  })
})

/** Mount the real slot, with both gates under the test's control. */
async function mountSlot(user: Promise<{ id: string } | null>, answer: (url: string) => Promise<unknown>) {
  vi.resetModules()
  const react = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const { TourProvider } = await import('../app/TourContext')
  const { AppBanners } = await import('./AppBanners')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  // The tour nudge's gate: usePref answers `undefined` until this resolves, and
  // then goes on to read the per-user document through `fetch` below.
  vi.stubGlobal('getCriblUser', () => user)
  // Everything either banner asks the platform: the preferences document, and
  // aiEnabled(), the first of the dataset-intelligence banner's two round trips.
  vi.stubGlobal('fetch', (url: string) => answer(String(url)))

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const settle = () => react.act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await react.act(async () => {
    root.render(
      react.createElement(MemoryRouter, null,
        react.createElement(TourProvider, null, react.createElement(AppBanners))),
    )
  })
  await settle()

  return {
    text: () => container.textContent ?? '',
    alerts: () => container.querySelectorAll('[role="status"], [role="alert"]').length,
    settle,
    unmount: async () => {
      await react.act(async () => { root.unmount() })
      container.remove()
    },
  }
}

/** A user lookup that has not answered yet, and the hand that answers it. */
function deferredUser() {
  let answer: (u: { id: string } | null) => void = () => {}
  const promise = new Promise<{ id: string } | null>((resolve) => { answer = resolve })
  return { promise, answer }
}

/** A request that never comes back — the slow gate, as slow as it gets. */
const never = () => new Promise<never>(() => {})

/** The store holding one viewer's preferences; every other call never lands. */
const storeHolding = (doc: unknown) => (url: string) =>
  url.includes('/kvstore/')
    ? Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ version: 1, updatedAt: 1, doc }),
        json: async () => ({ version: 1, updatedAt: 1, doc }),
      })
    : never()

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('AppBanners', () => {
  it('shows nothing at all while the stored preference is still in flight', async () => {
    const user = deferredUser()
    const slot = await mountSlot(user.promise, never)

    // Not "shows an empty box": the slot itself is absent, because a banner
    // that appears and is taken away reads as a broken app rather than a slow
    // one, and the people it would flash at are exactly the ones who said no.
    expect(slot.alerts(), 'a banner was drawn before its preference had been read').toBe(0)
    expect(slot.text()).toBe('')

    await slot.unmount()
  })

  it('offers the tour once the preference lands, and does not wait for the other source', async () => {
    const user = deferredUser()
    const slot = await mountSlot(user.promise, never)

    // No user named, so there is no per-user document: the defaults apply and
    // `tourSeen` resolves to a definite false. The dataset-intelligence probe
    // is still in the air and will never land.
    user.answer(null)
    await slot.settle()

    expect(slot.text()).toContain('First time here?')
    expect(slot.text()).toContain('Choose a role')
    expect(
      slot.alerts(),
      'the nudge was held back — or joined — by a source that has not answered',
    ).toBe(1)

    await slot.unmount()
  })

  it('never offers a banner this viewer has already dismissed', async () => {
    const user = deferredUser()
    // A returning viewer: the store has their document and it says yes to both.
    const slot = await mountSlot(user.promise, storeHolding({ tourSeen: true, intelPromptDismissed: true }))
    expect(slot.alerts()).toBe(0)

    user.answer({ id: 'u-7' })
    await slot.settle()

    // Nothing, before the read and after it. The nudge is the one that would
    // show here if `undefined` were ever read as false, because it needs no
    // second round trip to decide — `tourSeen: true` is the whole answer.
    expect(slot.alerts(), 'a dismissed banner came back').toBe(0)
    expect(slot.text()).toBe('')

    await slot.unmount()
  })

  it('does offer it when the same document says the tour has not been seen', async () => {
    // The discrimination check on the test above: without this, a `/kvstore/`
    // path that had quietly changed shape would make that test pass for the
    // wrong reason — no banner because the read failed, not because it was
    // dismissed. Same harness, same route, one flag flipped, opposite result.
    const user = deferredUser()
    const slot = await mountSlot(user.promise, storeHolding({ tourSeen: false }))
    user.answer({ id: 'u-7' })
    await slot.settle()

    expect(slot.text()).toContain('First time here?')
    expect(slot.alerts()).toBe(1)

    await slot.unmount()
  })
})
