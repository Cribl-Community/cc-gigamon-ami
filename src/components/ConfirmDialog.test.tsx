// What the dialog in front of a destructive write actually does, measured on the
// rendered DOM.
//
// WHY THESE ASSERTIONS AND NOT A FOCUS-TRAP TEST. The obvious test for a dialog
// is "press Tab and prove focus does not leave" — and under happy-dom that test
// cannot fail. There is no sequential focus navigation to drive: `Tab` is a
// KeyboardEvent nothing in the environment interprets, `inert` is stored as an
// attribute and enforces nothing, and no element is ever unreachable because
// nothing was reachable by keyboard in the first place. A green tick from it
// would mean the runtime does not implement the thing being claimed. So the trap
// is asserted the only honest way available: the MECHANISM Capra puts in the
// document — the dialog rendered outside `#root`, and `#root` carrying `inert`
// while it is open and losing it on close. That is a real regression detector
// (if Capra stops portalling, or stops marking the rest of the page inert, these
// fail) and it is explicitly not a claim that focus is contained. The header of
// ConfirmDialog.tsx lists what was measured about Capra's Modal; this file pins
// the half that is ours.
//
// Everything else here IS the behaviour, not a proxy for it: which element holds
// focus, what the dialog is labelled and described by, whether the label is a
// real `<label>`, and — the one that matters most — whether the write can be
// reached before the literal is typed.
//
// The full list of what could not be asserted in this environment, and why, is
// at the bottom of the file.

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog, type ConfirmResource } from './ConfirmDialog'
import { GatedControl } from './GatedControl'
import { resetDenials } from '../cribl/authz'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetDenials()
  container = document.createElement('div')
  // The id matters: Capra portals the dialog out of it and marks it `inert`,
  // and two of the assertions below are about that element.
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetDenials()
})

/**
 * Let the environment run one turn. Capra's focus work, its `inert` marking and
 * its scroll lock all land AFTER the commit that opens or closes the dialog —
 * react-aria's FocusScope, not React — so a test that measures any of them
 * straight after a click measures the state it was already in.
 */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

/**
 * Drain turns until `predicate` holds, then stop; give up after `tries` and let
 * the assertion that follows report whatever it actually found.
 *
 * Written this way because the single-flush version was FLAKY, which is worse
 * than either passing or failing: it went green five times in isolation and
 * failed once inside a full-suite run, where the other worker threads change how
 * quickly a macrotask comes back. A test that reports the scheduler is not
 * reporting the component. This still fails when focus genuinely never moves —
 * it waits, it does not assume.
 */
async function until(predicate: () => boolean, tries = 30) {
  for (let i = 0; i < tries && !predicate(); i++) await flush()
}

const REMOVE_RESOURCES: ConfirmResource[] = [
  { action: 'delete', kind: 'Syslog source', id: 'in_gigamon_syslog', group: 'default' },
  { action: 'delete', kind: 'Pipeline', id: 'gigamon_syslog', group: 'default' },
  { action: 'delete', kind: 'Route', id: 'gigamon_ami_syslog', group: 'default' },
]

interface HarnessProps {
  resources?: ConfirmResource[]
  typeToConfirm?: { value: string; label: string } | null
  irreversible?: { why: string } | null
  consequences?: string[]
  run: () => Promise<unknown>
}

/**
 * The shape Guided Setup uses: a trigger that stays mounted, and the dialog
 * beside it. The trigger staying mounted is the point — it is what focus is
 * restored TO, and the old inline confirmation replaced it.
 */
function Harness({ resources = REMOVE_RESOURCES, typeToConfirm, irreversible, consequences, run }: HarnessProps) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" id="trigger" onClick={() => setOpen(true)}>Remove onboarding stack</button>
      <ConfirmDialog
        isOpen={open}
        title="Delete the Gigamon AMI syslog resources from Cribl Stream worker group default"
        resources={resources}
        irreversible={irreversible ?? undefined}
        consequences={consequences ?? ['Cribl Lake destination gigamon_lake and dataset gigamon_ami are kept.']}
        undo="Deploy onboarding stack, on this tab, rebuilds all three."
        typeToConfirm={typeToConfirm ?? undefined}
        onCancel={() => setOpen(false)}
        confirm={
          <GatedControl
            write="syslog_stack.remove"
            label="Yes, delete from default"
            busyLabel="Removing…"
            className="btn btn-danger"
            run={run}
          />
        }
      />
    </div>
  )
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')
const trigger = () => container.querySelector<HTMLButtonElement>('#trigger')!
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
const byText = (text: string) => buttons().find((b) => (b.textContent ?? '').includes(text))
const cancel = () => byText('Cancel')!
const confirmBtn = () => byText('Yes, delete from default')!
const input = () => document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!

/** Open it the way the app does: by pressing the trigger, with focus on it. */
async function open(props: HarnessProps) {
  act(() => { root.render(<Harness {...props} />) })
  trigger().focus()
  act(() => { trigger().click() })
  await until(() => document.activeElement === byText('Cancel'))
}

const noop = () => Promise.resolve()

describe('ConfirmDialog', () => {
  it('opens focused on Cancel, never on the destructive action', async () => {
    await open({ run: noop })
    // Left alone, Capra focuses the dialog <section> itself — which is not wrong,
    // but it is one keystroke from the button that deletes three things. S8 rule
    // 1 wants the way out under the cursor.
    expect(
      document.activeElement,
      `focus opened on "${document.activeElement?.textContent?.slice(0, 40)}" instead of Cancel`,
    ).toBe(cancel())
  })

  it('is labelled by a title that names the objects, the kind and the group', async () => {
    await open({ run: noop })
    const id = dialog()!.getAttribute('aria-labelledby')
    expect(id, 'the dialog has no accessible name at all').toBeTruthy()
    const label = document.getElementById(id!)
    expect(label?.tagName, 'the name is not a heading, so nothing can navigate to it').toBe('H2')
    // The whole point of the title: somebody who hears only the name knows what
    // is about to happen and where.
    expect(label?.textContent).toContain('Delete')
    expect(label?.textContent).toContain('Gigamon AMI syslog resources')
    expect(label?.textContent).toContain('worker group default')
  })

  it('describes itself with everything that has to be read before deciding, in order', async () => {
    await open({
      run: noop,
      irreversible: { why: 'Recoverable only from the group’s Git history.' },
      consequences: ['Cribl Lake destination gigamon_lake and dataset gigamon_ami are kept.'],
    })
    // Capra's ModalProps has no aria-describedby, so this attribute exists only
    // because ConfirmDialog hangs it on by hand. If Capra ever wires it itself,
    // this still passes and the effect becomes redundant rather than wrong.
    const id = dialog()!.getAttribute('aria-describedby')
    expect(id, 'the dialog announces its title and nothing else — the warnings are unread on open').toBeTruthy()
    const described = document.getElementById(id!)
    expect(described, 'aria-describedby points at an element that does not exist').toBeTruthy()

    const text = described!.textContent ?? ''
    const at = (needle: string) => {
      const i = text.indexOf(needle)
      expect(i, `"${needle}" is not in the described-by region at all`).toBeGreaterThanOrEqual(0)
      return i
    }
    // Reading order is the assertion. A screen reader reads this as one run, so
    // "cannot be undone" arriving after the object list is the difference between
    // a warning and a footnote.
    expect(at('This cannot be undone.')).toBeLessThan(at('are kept'))
    expect(at('are kept')).toBeLessThan(at('What will change'))
    expect(at('What will change')).toBeLessThan(at('in_gigamon_syslog'))
  })

  it('names every object it will touch, with the action as a word', async () => {
    await open({ run: noop })
    const rows = [...document.body.querySelectorAll<HTMLElement>('.cdlg-res-row')]
    expect(rows.length, 'the confirmation does not list what it affects').toBe(3)
    for (const [i, r] of REMOVE_RESOURCES.entries()) {
      const row = rows[i].textContent ?? ''
      // SC 1.4.1: a red row and a green row are the same row to anyone who
      // cannot tell them apart, so the verb is rendered as text.
      expect(row, `row ${i} does not say what happens to it`).toContain('delete')
      expect(row, `row ${i} does not name the object`).toContain(r.id)
    }
  })

  it('puts deletes last however the caller ordered them', async () => {
    await open({
      run: noop,
      resources: [
        { action: 'delete', kind: 'Pipeline', id: 'gigamon_syslog' },
        { action: 'create', kind: 'Cribl Lake dataset', id: 'gigamon_ami' },
        { action: 'replace', kind: 'Routing table', id: 'default' },
      ],
    })
    const rows = [...document.body.querySelectorAll<HTMLElement>('.cdlg-res-row')].map((r) => r.textContent ?? '')
    expect(rows[2], 'the delete did not read last').toContain('gigamon_syslog')
    // …and the two that are not deletes kept the caller's dependency order,
    // rather than being regrouped by action.
    expect(rows[0]).toContain('gigamon_ami')
    expect(rows[1]).toContain('default')
  })

  it('cancels on Escape and hands focus back to the control that opened it', async () => {
    const run = vi.fn(noop)
    await open({ run })
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await until(() => document.activeElement === trigger())
    expect(dialog(), 'Escape left the dialog open').toBeNull()
    // Without this, Escape drops focus on <body> and a keyboard user restarts
    // from the top of the page.
    expect(document.activeElement, 'focus was not restored to the trigger').toBe(trigger())
    expect(run, 'Escape performed the write').not.toHaveBeenCalled()
  })

  it('cancels on Cancel, and hands focus back the same way', async () => {
    const run = vi.fn(noop)
    await open({ run })
    act(() => { cancel().click() })
    await until(() => document.activeElement === trigger())
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves nothing behind when it is closed', () => {
    // Not decoration: a dialog that renders its confirm button while closed is a
    // write reachable from a page nobody opened a confirmation on.
    act(() => { root.render(<Harness run={noop} />) })
    expect(dialog()).toBeNull()
    expect(document.body.textContent).not.toContain('Yes, delete from default')
  })
})

describe('ConfirmDialog — the mechanism behind the trap', () => {
  // Read the header before changing either of these. Neither asserts that focus
  // is contained or that the page cannot be scrolled; happy-dom implements
  // neither. Both assert that Capra still puts the thing in the document that a
  // browser acts on, which is the part that can silently disappear in a patch.

  it('renders outside #root and marks the rest of the page inert', async () => {
    await open({ run: noop })
    expect(container.contains(dialog()), 'the dialog is inside #root, so `inert` on #root would hide it too').toBe(false)
    expect(container.hasAttribute('inert'), 'the page behind the dialog is still exposed to assistive technology').toBe(true)
    act(() => { cancel().click() })
    await until(() => !container.hasAttribute('inert'))
    expect(container.hasAttribute('inert'), 'the page stayed inert after the dialog closed').toBe(false)
  })

  it('locks and releases document scrolling', async () => {
    await open({ run: noop })
    expect(document.documentElement.style.overflow, 'the page behind the dialog still scrolls').toBe('hidden')
    act(() => { cancel().click() })
    await until(() => document.documentElement.style.overflow !== 'hidden')
    expect(document.documentElement.style.overflow, 'the page never got its scrollbar back').not.toBe('hidden')
  })
})

describe('ConfirmDialog — type to confirm', () => {
  const TTC = { value: 'default', label: 'To confirm, type the worker group name default' }

  it('labels the field with a real <label> carrying the literal', async () => {
    await open({ run: noop, typeToConfirm: TTC })
    const labels = [...document.body.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')]
    const label = labels.find((l) => l.htmlFor === input().id)
    // SC 3.3.2 wants a label, and SC 2.5.3 wants the accessible name to contain
    // the visible text — a placeholder satisfies neither, and disappears the
    // moment anybody starts typing the thing it was telling them to type.
    expect(label, 'the field has no <label> bound to it by `for`').toBeTruthy()
    expect(label!.textContent, 'the label does not say WHAT to type').toContain('default')
  })

  it('keeps the confirm button reachable while it is blocked', async () => {
    await open({ run: noop, typeToConfirm: TTC })
    const b = confirmBtn()
    // The whole argument for aria-disabled over disabled: a `disabled` button is
    // skipped by keyboard navigation and announced by nothing, so somebody using
    // a screen reader tabs past Cancel, finds nothing, and never learns that the
    // action exists or what it is waiting for.
    expect(b.getAttribute('aria-disabled'), 'the blocked button does not say it is unavailable').toBe('true')
    expect(b.disabled, 'the blocked button was removed from the keyboard order').toBe(false)
    const describedBy = b.getAttribute('aria-describedby')
    expect(describedBy, 'the blocked button does not point at anything explaining why').toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toContain('Type default')
  })

  it('will not perform the write until the literal is typed', async () => {
    const run = vi.fn(noop)
    await open({ run, typeToConfirm: TTC })
    act(() => { confirmBtn().click() })
    await flush()
    // This is the assertion the mechanism exists for. Everything else on this
    // dialog is about being understood; this is about not deleting a customer's
    // syslog source on a mis-click.
    expect(run, 'the teardown ran without the group name being typed').not.toHaveBeenCalled()
    expect(dialog(), 'the dialog closed on a press it did not act on').not.toBeNull()
  })

  it('moves focus to the field when the blocked button is pressed anyway', async () => {
    await open({ run: noop, typeToConfirm: TTC })
    act(() => { confirmBtn().click() })
    await until(() => document.activeElement === input())
    // Rule 6's other half. A button that does nothing and says nothing is
    // indistinguishable from a broken one; this puts the caret in the box that
    // has to be filled in, whose label says what to fill it with.
    expect(document.activeElement, 'pressing the blocked button left the user with no idea what to do next').toBe(input())
  })

  it('marks the field invalid only after somebody has actually tried', async () => {
    await open({ run: noop, typeToConfirm: TTC })
    // An empty box on open is not a mistake anybody has made yet. Announcing it
    // as an error is how a dialog teaches people to ignore its errors.
    expect(input().getAttribute('aria-invalid')).not.toBe('true')
    act(() => { confirmBtn().click() })
    await flush()
    expect(input().getAttribute('aria-invalid'), 'a failed attempt left the field looking fine').toBe('true')
    const describedBy = confirmBtn().getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent, 'the requirement never said what went wrong').toContain('not default')
  })

  it('performs the write once the literal matches exactly', async () => {
    const run = vi.fn(noop)
    await open({ run, typeToConfirm: TTC })
    type('default')
    expect(confirmBtn().getAttribute('aria-disabled'), 'the button stayed blocked after a correct entry').toBeNull()
    act(() => { confirmBtn().click() })
    await flush()
    expect(run, 'the correctly-typed confirmation did not run the write').toHaveBeenCalledTimes(1)
  })

  it('is not satisfied by something that merely contains the literal', async () => {
    const run = vi.fn(noop)
    await open({ run, typeToConfirm: TTC })
    type('default_search')
    act(() => { confirmBtn().click() })
    await flush()
    expect(run, 'a different group name was accepted as this one').not.toHaveBeenCalled()
  })

  it('forgets what was typed when the dialog closes', async () => {
    await open({ run: noop, typeToConfirm: TTC })
    type('default')
    act(() => { cancel().click() })
    await until(() => dialog() === null)
    act(() => { trigger().click() })
    await until(() => dialog() !== null)
    // A reopened dialog is a fresh decision. Carrying the typed value over would
    // leave the second teardown pre-confirmed by the first one that was cancelled.
    expect(input().value, 'the confirmation reopened already satisfied').toBe('')
    expect(confirmBtn().getAttribute('aria-disabled')).toBe('true')
  })
})

/** Capra's TextField owns the input's value, so typing goes through its onChange. */
function type(value: string) {
  act(() => {
    const el = input()
    // React installs its own value setter on the element; going through the
    // prototype is what makes the synthetic change event carry the new value.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// ── WHAT THIS FILE DOES NOT ASSERT, AND WHY ──────────────────────────────────
//
// Stated rather than quietly omitted, because the gap between "the dialog is
// accessible" and "these tests pass" is exactly this list.
//
//   * FOCUS IS CONTAINED. happy-dom has no sequential focus navigation: a `Tab`
//     KeyboardEvent moves nothing, and `inert` is stored and not enforced. The
//     mechanism is asserted above; the behaviour needs a real browser.
//   * THE DESCRIPTION IS ANNOUNCED ON OPEN. That `aria-describedby` resolves to
//     a container holding the right text in the right order is checkable here.
//     That a screen reader reads it before the buttons is a claim about NVDA,
//     JAWS and VoiceOver, and no DOM assertion reaches it.
//   * THE DIALOG IS ON TOP, AND THE SCRIM COVERS THE PAGE. There is no layout
//     and no paint. The overlay's `z-index: 10000` was read out of Capra's
//     stylesheet by hand (App.css's highest is 100); nothing here re-checks it.
//   * THE ACTION WORDS ARE LEGIBLE. Colour is not resolved in this environment.
//     src/app/contrast.test.ts measures the four `Pill` appearances this dialog
//     renders against Capra's modal surface, in both themes, and is where a
//     contrast regression fails.
//   * THE BUTTON SHOWS A PENDING STATE WHILE THE WRITE RUNS. Guided Setup closes
//     the dialog before the write starts — deliberately, so the step log and the
//     toasts are visible while it runs — so on this screen there is no in-flight
//     dialog state to test. S8 describes one for callers that keep it open.
//   * ESCAPE'S DEFAULT IS PREVENTED, so it does not also close something behind
//     the app. `cancelable` is honoured here but nothing else listens.
