// What the gate does at the button, which is the only place a customer meets it.
//
// The design is retrospective on purpose (see the header of src/cribl/authz.ts):
// the app cannot know before the click whether this user may perform the write,
// so the first attempt really is attempted. Everything worth asserting follows
// from that — that the first attempt is NOT blocked, that a refusal closes the
// control with a sentence naming the call, that "Try again" reopens it, and that
// an ordinary failure is left alone. The last one is the easiest to get wrong:
// a gate that latched on any failed run would disable Deploy because a syslog
// port was in use, and tell the customer it was a permission.
//
// AND HOW "closed" is expressed, which is the half this file used to assert the
// opposite of: it asserted `button().disabled` on a refusal and read the reason
// out of `title`, both of which are the defect. A `disabled` button is not
// tabbable and is not announced; a `title` is not readable by a keyboard or a
// finger. Every state below that stops the click is asserted three ways —
// `disabled` absent, `aria-disabled` present, and the reason on screen carrying
// the id the button describes itself with — because those three together are
// what "the reason is visible, keyboard-reachable and announced" reduces to in
// HTML. What this file CANNOT assert is at the bottom.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noteDenial, resetDenials } from '../cribl/authz'
import { GatedControl } from './GatedControl'

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
  resetDenials()
})

const button = () => container.querySelector<HTMLButtonElement>('.btn-primary')!
const note = () => container.querySelector('.gate-note-text')?.textContent ?? null
const retry = () => container.querySelector<HTMLButtonElement>('.gate-retry')

/** Whether the button says it is unavailable — and never by leaving the page. */
function blockedState() {
  const b = button()
  return {
    disabled: b.hasAttribute('disabled'),
    ariaDisabled: b.getAttribute('aria-disabled'),
    describedBy: (b.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean),
    title: b.hasAttribute('title'),
  }
}

/** The text of each element the button points `aria-describedby` at. Empty ids,
 *  or ids nothing on the page carries, come back as nulls — which is the failure
 *  worth catching: a description that names nothing announces nothing. */
const describedText = () => blockedState().describedBy.map((id) => document.getElementById(id)?.textContent ?? null)

/** Render one gated control whose write does `run`. */
function render(run: () => Promise<unknown>) {
  act(() => {
    root.render(<GatedControl write="onboarding_stack.apply" label="Deploy" busyLabel="Deploying…" run={run} />)
  })
}

describe('GatedControl', () => {
  it('lets the first attempt through — it has no way to know it will be refused', () => {
    let attempts = 0
    render(async () => { attempts++ })
    expect(blockedState().disabled, 'the control was disabled before anybody had been refused anything').toBe(false)
    expect(blockedState().ariaDisabled, 'the control announced itself unavailable before any refusal').toBeNull()
    expect(note(), 'a reason was shown for a refusal that has not happened').toBeNull()
    act(() => button().click())
    expect(attempts).toBe(1)
  })

  it('closes with the call named when the platform refuses one', async () => {
    render(async () => {
      // What deployAll does: several calls, one of which the platform refuses.
      noteDenial('PATCH', '/m/default/system/inputs/in_gigamon_syslog', 403, 'Not authorized or licensed to perform this action.')
    })
    await act(async () => { button().click() })

    const state = blockedState()
    expect(state.ariaDisabled, 'a refused control did not say it was unavailable').toBe('true')
    expect(state.disabled, 'a refused control was taken out of the keyboard order — the reason is now unreachable').toBe(false)
    expect(state.title, 'the reason went back into a tooltip, where a keyboard and a touch screen cannot find it').toBe(false)
    expect(note()).toContain('PATCH /m/default/system/inputs/in_gigamon_syslog')
    expect(describedText(), 'the button described itself with an id nothing on the page carries').toHaveLength(1)
    expect(describedText()[0], 'the button announces something other than the refusal').toContain('HTTP 403')
  })

  it('stops the click itself, so no caller has to rely on `disabled` to stop it', async () => {
    let attempts = 0
    render(async () => {
      attempts++
      noteDenial('PATCH', '/m/default/routes/default', 403)
    })
    await act(async () => { button().click() })
    expect(attempts).toBe(1)

    // The press that `disabled` used to swallow in the browser. It reaches the
    // handler now, and the handler is what refuses it: a caller that dropped its
    // own re-check would otherwise write twice.
    await act(async () => { button().click() })
    expect(attempts, 'a blocked control ran its write anyway').toBe(1)
  })

  it('sends a press on the refused control to "Try again"', async () => {
    // Pressing a control that says it is unavailable has to do something, or the
    // sentence naming the way out is one the person can read and not reach.
    render(async () => { noteDenial('PATCH', '/m/default/routes/default', 403) })
    await act(async () => { button().click() })
    await act(async () => { button().click() })
    expect(document.activeElement, 'a press on the blocked control went nowhere').toBe(retry())
  })

  it('reopens on "Try again", so a grant made meanwhile can be used', async () => {
    let attempts = 0
    render(async () => {
      attempts++
      if (attempts === 1) noteDenial('PATCH', '/m/default/routes/default', 403)
    })
    await act(async () => { button().click() })
    expect(blockedState().ariaDisabled).toBe('true')

    await act(async () => { retry()!.click() })
    expect(blockedState().ariaDisabled, '"Try again" did not reopen the control').toBeNull()
    expect(blockedState().describedBy, 'the button still describes itself with a note that has gone').toEqual([])
    expect(note()).toBeNull()

    await act(async () => { button().click() })
    expect(attempts, 'the second attempt never ran').toBe(2)
  })

  it('puts focus back on the button when "Try again" removes the note under it', async () => {
    // The note unmounts on that press, so focus would fall to <body> — one press
    // after the press that deliberately put it here.
    render(async () => { noteDenial('PATCH', '/m/default/routes/default', 403) })
    await act(async () => { button().click() })
    await act(async () => { retry()!.click() })
    expect(document.activeElement, 'focus was dropped on the floor when the refusal cleared').toBe(button())
  })

  it('leaves the control alone when the run failed for any other reason', async () => {
    // A syslog port already in use answers 409, a bad spec 400. Latching on
    // those would tell a customer their permissions are wrong and disable the
    // button that would have worked on the next try.
    render(async () => { throw new Error('port 5514 already in use') })
    await act(async () => { button().click() })

    expect(blockedState().ariaDisabled, 'an ordinary failure was reported as a permission').toBeNull()
    expect(note()).toBeNull()
  })

  it('ignores a refusal that happened before this attempt began', async () => {
    // The status check on load can be refused too. That is worth saying on the
    // resource rows, but it is not this control's refusal and must not close it
    // before anybody has pressed anything.
    noteDenial('GET', '/m/default/system/inputs/in_gigamon_syslog', 403)
    render(async () => {})
    await act(async () => { button().click() })
    expect(blockedState().ariaDisabled).toBeNull()
  })

  describe('a reason of the caller’s own', () => {
    const renderUnavailable = (unavailable: string | null, run = async () => {}) => {
      act(() => {
        root.render(
          <GatedControl write="onboarding_stack.apply" label="Deploy" busyLabel="Deploying…" unavailable={unavailable} run={run} />,
        )
      })
    }

    it('stays shut without calling it a permission', () => {
      renderUnavailable('Another run is already in progress.')
      expect(blockedState().ariaDisabled).toBe('true')
      expect(note(), 'a caller’s "not right now" was dressed up as a refusal').toBeNull()
    })

    it('says why on screen, and not in a tooltip', () => {
      // The whole defect, in one assertion. `title` was the ONLY carrier of this
      // sentence: invisible to a keyboard, invisible to a finger, and gone from
      // the accessibility tree the moment the button stopped being announced.
      renderUnavailable('Another run is already in progress.')
      const state = blockedState()
      expect(state.title, 'the reason is in a tooltip again').toBe(false)
      expect(state.disabled, 'the button carrying the reason left the keyboard order').toBe(false)
      expect(describedText(), 'the reason is not what the button announces').toEqual(['Another run is already in progress.'])
      expect(container.textContent, 'the reason is not on screen at all').toContain('Another run is already in progress.')
    })

    it('runs nothing when pressed', () => {
      let attempts = 0
      renderUnavailable('Another run is already in progress.', async () => { attempts++ })
      act(() => button().click())
      expect(attempts, '`disabled` was the only thing stopping this click').toBe(0)
    })

    it('opens again when the caller says it can', () => {
      renderUnavailable('These are the limits already in force — nothing to save.')
      expect(blockedState().ariaDisabled).toBe('true')
      renderUnavailable(null)
      expect(blockedState().ariaDisabled).toBeNull()
      expect(blockedState().describedBy).toEqual([])
      expect(container.textContent).not.toContain('nothing to save')
    })

    it('is not printed under the button while that button is the run in flight', async () => {
      // Every caller computes this string from the state the press just set, so
      // the honest reading of "Another run is already in progress." under a
      // button reading "Deploying…" is: this one.
      let release!: () => void
      const inFlight = new Promise<void>((r) => { release = r })
      renderUnavailable(null, () => inFlight)
      await act(async () => { button().click() })
      renderUnavailable('Another run is already in progress.', () => inFlight)

      expect(button().textContent, 'the button stopped saying it was working').toBe('Deploying…')
      expect(blockedState().disabled, 'a write in flight is the one state that may use `disabled`').toBe(true)
      expect(container.textContent, 'the button told the reader it was waiting for itself').not.toContain('Another run is already in progress.')

      // And the moment it lands, the caller's sentence is true again.
      await act(async () => { release() })
      expect(container.textContent).toContain('Another run is already in progress.')
    })
  })

  describe('several reasons at once', () => {
    // A confirmation whose type-to-confirm is unmet AND whose write has already
    // been refused. Rare, but both are true, and a button that named one of them
    // would send somebody to satisfy a requirement that cannot help.
    /** Get refused first — nothing can latch a refusal but a run — then let the
     *  caller's two other reasons arrive underneath it. */
    async function refuseThenBlock(onActivate: () => void, attempts?: () => void) {
      const req = document.createElement('p')
      req.id = 'ttc-req'
      req.textContent = 'To confirm, type default'
      document.body.appendChild(req)
      const control = (blocked: boolean) => (
        <GatedControl
          write="onboarding_stack.apply"
          label="Deploy"
          unavailable={blocked ? 'Type the worker group name first.' : null}
          blockedUntil={blocked ? { describedBy: 'ttc-req', onActivate } : null}
          run={async () => {
            attempts?.()
            noteDenial('PATCH', '/m/default/routes/default', 403)
          }}
        />
      )
      act(() => { root.render(control(false)) })
      await act(async () => { button().click() })
      act(() => { root.render(control(true)) })
      return () => req.remove()
    }

    it('names every reason in aria-describedby, refusal first', async () => {
      const cleanup = await refuseThenBlock(() => {})

      expect(blockedState().describedBy, 'a reason stopped being announced because another one arrived').toHaveLength(3)
      expect(describedText()[0], 'the refusal is not read first').toContain('HTTP 403')
      expect(describedText()).toContain('To confirm, type default')
      expect(describedText()).toContain('Type the worker group name first.')
      expect(describedText(), 'a described id names nothing on the page').not.toContain(null)
      cleanup()
    })

    it('sends the press to the refusal, not to the requirement it cannot help', async () => {
      let activated = 0
      let attempts = 0
      const cleanup = await refuseThenBlock(() => { activated++ }, () => { attempts++ })
      await act(async () => { button().click() })

      expect(activated, 'the press went to the type-to-confirm field, which cannot make a refused write land').toBe(0)
      expect(attempts, 'a control with three reasons not to write wrote').toBe(1)
      expect(document.activeElement).toBe(retry())
      cleanup()
    })
  })

  describe('a requirement the caller owns', () => {
    const renderSoft = (onActivate: () => void, run = async () => {}) =>
      act(() => {
        root.render(
          <GatedControl
            write="onboarding_stack.apply"
            label="Deploy"
            blockedUntil={{ describedBy: 'ttc-req', onActivate }}
            run={run}
          />,
        )
      })

    it('is reachable, announced, and sends the press where the caller said', () => {
      let activated = 0
      let attempts = 0
      renderSoft(() => { activated++ }, async () => { attempts++ })
      const state = blockedState()
      expect(state.ariaDisabled).toBe('true')
      expect(state.disabled).toBe(false)
      expect(state.describedBy, 'the caller’s own description was dropped').toEqual(['ttc-req'])
      act(() => button().click())
      expect(activated).toBe(1)
      expect(attempts, 'a control blocked on an unmet requirement wrote anyway').toBe(0)
    })

    it('prints no sentence of its own — the caller already has one on screen', () => {
      renderSoft(() => {})
      expect(container.querySelector('.gate')!.textContent, 'a second copy of the requirement was printed under the button').toBe('Deploy')
    })
  })
})

// WHAT THIS FILE CANNOT ASSERT, and why. Read this before reporting an
// accessibility outcome from a green run of it.
//
//  * THAT THE BUTTON IS ACTUALLY TABBABLE. happy-dom implements no sequential
//    focus navigation, so a test that pressed Tab and expected to arrive here
//    would pass against an empty document. What is asserted instead is the
//    mechanism that decides it: the `disabled` attribute is absent. That is the
//    only thing that was removing this button from the tab order, but "absent"
//    is a weaker claim than "reached", and only a real browser closes the gap.
//  * THAT A SCREEN READER READS THE REASON. `aria-describedby` naming an element
//    that exists and has text is the whole of what the DOM can be asked. Whether
//    NVDA or VoiceOver announces it on focus, in what order it reads three ids,
//    and whether it repeats the description on a second visit are all decided by
//    the screen reader.
//  * THAT `aria-disabled` LOOKS UNAVAILABLE. It does not, today: `.btn:disabled`
//    in App.css fades to 0.5 opacity and `.btn[aria-disabled="true"]` has no rule
//    at all, so a blocked button still paints and still hovers like a live one.
//    That is a stylesheet this change did not own. The reason beside the button
//    is now the signal, which is more than the tooltip it replaced, but somebody
//    reading with their eyes alone is being asked to read.
//  * THAT THE CALLER'S SENTENCE IS LEGIBLE WHERE IT LANDS. It carries no class
//    and inherits the type of the row or dialog it was dropped into (see the
//    prop's doc for why). happy-dom computes no layout, so nothing here can say
//    it wraps, fits, or reads at a sensible size in AccelPanel's dialog footer.
//  * FOCUS AFTER A REFUSAL LATCHES. The button is `disabled` while the write is
//    in flight, so the press that gets refused has already dropped focus to
//    <body> in a real browser — before this component has anything to say. The
//    note announces itself with `role="status"` rather than taking focus, which
//    is the right call for a result the person asked for, but it means the way
//    back to "Try again" is a Tab, not a keystroke this file can measure.
