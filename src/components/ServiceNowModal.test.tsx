// ServiceNowModal, after slice 1.9 moved it off the hand-built `.modal` box.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL.
//
// The plan's slice 1.7 row says `ServiceNowModal` and `TourPicker` were moved
// onto `ConfirmDialog`'s dialog "and the old CSS deleted". They were not: both
// were still a `<div className="modal-scrim">` with `.modal` inside it, and
// App.css still carried the whole family. Nothing caught that, because a claim
// in a plan is not a claim anything executes. This is the executable half.
//
// WHAT IT PROVES, and it is deliberately the SAME shape as the assertions in
// ConfirmDialog.test.tsx rather than a new idea: the dialog renders a
// `role="dialog"` labelled by its own heading, portals out of `#root` while
// marking `#root` inert, and closes through the one path its caller was given.
// Those are the four things the hand-built box did not do — `TourPicker` did not
// even set `aria-modal`, and its heading was an `<h3>` nothing pointed at — and
// they are the reason the migration was worth the churn.
//
// WHY ONLY ONE OF THE TWO. `TourPicker` moved in the same commit, onto the same
// Capra `Modal` with the same four properties, and is NOT covered here: it reads
// its open state from `TourProvider`, which needs a Router and the per-user KV
// preference store, so testing it would mean standing up two doubles to
// re-measure the same Capra mechanism this file already measures. That is a
// trade, and it is recorded rather than hidden — what `TourPicker` does not have
// is a regression detector of its own.
//
// WHAT IT DOES NOT PROVE. That focus is trapped: happy-dom has no sequential
// focus navigation, so a Tab test here cannot fail. ConfirmDialog.test.tsx says
// this at length; the same reasoning applies and is not repeated. It also proves
// nothing about how the dialog LOOKS, which is what the slice report's call-site
// audit and the Preview check are for.
// ─────────────────────────────────────────────────────────────────────────────

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '@capra/core'
import { ServiceNowModal } from './ServiceNowModal'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  // Capra portals the dialog out of this element and marks it `inert`; two of
  // the assertions below are about that.
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** One turn, for the work react-aria does after the commit that opens a dialog. */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')

describe('ServiceNowModal, on Capra’s Modal', () => {
  const render = (isOpen: boolean, onClose = () => {}) =>
    act(() => { root.render(<ServiceNowModal isOpen={isOpen} service="checkout-api" onClose={onClose} />) })

  it('renders nothing while it is closed', async () => {
    await render(false)
    await flush()
    expect(dialog()).toBeNull()
  })

  it('is a dialog labelled by its own title', async () => {
    await render(true)
    await flush()
    const d = dialog()
    expect(d).not.toBeNull()
    const labelledBy = d!.getAttribute('aria-labelledby')
    expect(labelledBy, 'Capra labels its dialog by the heading it builds from `title`').toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('ServiceNow · Incident')
  })

  it('loses its accessible name entirely if `title` stops being a string', async () => {
    // Not a hypothetical. This modal's title used to carry a brand-green status
    // dot beside the words, and carrying it across as
    // `title={<span><span className="sn-dot" /> ServiceNow · Incident</span>}`
    // is the obvious migration: `ModalProps.title` is typed `ReactNode`, so it
    // compiles, renders, and looks right. It also produces a dialog with NO
    // aria-labelledby at all — Capra builds the labelled `<h2>` only for text.
    // That is how it was written first, and this is what caught it.
    //
    // Asserted as a failure on purpose, the way src/app/contrast.test.ts asserts
    // the pill variants it refuses. A comment saying "keep this a string" is not
    // enough by itself, because the element form is exactly what anyone putting
    // the dot back would write. If this test starts failing, Capra has begun
    // labelling element titles too — read that as good news, and then decide
    // whether the dot is worth having back rather than assuming it.
    await act(() => {
      root.render(
        <Modal isOpen title={<span>ServiceNow · Incident</span>} onClose={() => {}} footer={null}>
          body
        </Modal>,
      )
    })
    await flush()
    expect(
      dialog()!.getAttribute('aria-labelledby'),
      'Capra now labels a dialog whose `title` is an element. Read the comment above before using one.',
    ).toBeNull()
  })

  it('renders outside #root and marks #root inert while it is open', async () => {
    await render(true)
    await flush()
    expect(container.contains(dialog()), 'the dialog is portalled out of #root').toBe(false)
    expect(container.hasAttribute('inert'), '#root is inert behind the dialog').toBe(true)

    await render(false)
    await flush()
    expect(container.hasAttribute('inert'), '#root is interactive again once it closes').toBe(false)
  })

  it('reaches onClose from the header close button', async () => {
    const onClose = vi.fn()
    await render(true, onClose)
    await flush()
    // Capra's own ✕. Found by role rather than by class: the class is Capra's
    // and is not a contract, the role is.
    const close = dialog()!.querySelector<HTMLButtonElement>('button[aria-label], button[title]')
    expect(close, 'Capra renders a close control in the header').not.toBeNull()
    await act(async () => { close!.click() })
    expect(onClose).toHaveBeenCalled()
  })

  it('cannot submit until an assignment group is chosen', async () => {
    await render(true)
    await flush()
    const buttons = [...dialog()!.querySelectorAll('button')]
    const submit = buttons.find((b) => b.textContent?.includes('Submit incident'))
    expect(submit, 'the footer holds the submit action').not.toBeUndefined()
    expect(submit!.disabled).toBe(true)
  })

  it('draws its footer actions with the house button, not a second one', async () => {
    // The whole point of the slice: one button family. If a future edit reaches
    // for a Capra Button here and a `.btn` next door, this is what notices.
    await render(true)
    await flush()
    const footerButtons = [...dialog()!.querySelectorAll('button')]
      .filter((b) => b.textContent === 'Cancel' || b.textContent === 'Submit incident')
    expect(footerButtons).toHaveLength(2)
    for (const b of footerButtons) expect(b.classList.contains('btn')).toBe(true)
  })
})
