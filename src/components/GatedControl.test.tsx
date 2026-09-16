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

const button = () => container.querySelector<HTMLButtonElement>('.gs-btn-primary')!
const note = () => container.querySelector('.gate-note-text')?.textContent ?? null
const retry = () => container.querySelector<HTMLButtonElement>('.gate-retry')

/** Render one gated control whose write does `run`. */
function render(run: () => Promise<unknown>) {
  act(() => {
    root.render(<GatedControl write="syslog_stack.apply" label="Deploy" busyLabel="Deploying…" run={run} />)
  })
}

describe('GatedControl', () => {
  it('lets the first attempt through — it has no way to know it will be refused', () => {
    let attempts = 0
    render(async () => { attempts++ })
    expect(button().disabled, 'the control was disabled before anybody had been refused anything').toBe(false)
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

    expect(button().disabled, 'a refused control stayed pressable').toBe(true)
    expect(note()).toContain('PATCH /m/default/system/inputs/in_gigamon_syslog')
    expect(button().title, 'the disabled button gives no reason on hover').toContain('HTTP 403')
  })

  it('reopens on "Try again", so a grant made meanwhile can be used', async () => {
    let attempts = 0
    render(async () => {
      attempts++
      if (attempts === 1) noteDenial('PATCH', '/m/default/routes/default', 403)
    })
    await act(async () => { button().click() })
    expect(button().disabled).toBe(true)

    await act(async () => { retry()!.click() })
    expect(button().disabled, '"Try again" did not reopen the control').toBe(false)
    expect(note()).toBeNull()

    await act(async () => { button().click() })
    expect(attempts, 'the second attempt never ran').toBe(2)
  })

  it('leaves the control alone when the run failed for any other reason', async () => {
    // A syslog port already in use answers 409, a bad spec 400. Latching on
    // those would tell a customer their permissions are wrong and disable the
    // button that would have worked on the next try.
    render(async () => { throw new Error('port 5514 already in use') })
    await act(async () => { button().click() })

    expect(button().disabled, 'an ordinary failure was reported as a permission').toBe(false)
    expect(note()).toBeNull()
  })

  it('ignores a refusal that happened before this attempt began', async () => {
    // The status check on load can be refused too. That is worth saying on the
    // resource rows, but it is not this control's refusal and must not close it
    // before anybody has pressed anything.
    noteDenial('GET', '/m/default/system/inputs/in_gigamon_syslog', 403)
    render(async () => {})
    await act(async () => { button().click() })
    expect(button().disabled).toBe(false)
  })

  it('stays shut for a caller’s own reason without calling it a permission', () => {
    act(() => {
      root.render(
        <GatedControl write="syslog_stack.apply" label="Deploy" unavailable="Another run is already in progress." run={async () => {}} />,
      )
    })
    expect(button().disabled).toBe(true)
    expect(button().title).toBe('Another run is already in progress.')
    expect(note(), 'a caller’s "not right now" was dressed up as a refusal').toBeNull()
  })
})
