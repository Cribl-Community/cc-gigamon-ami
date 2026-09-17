// What a customer hears, and for how long, after a write they confirmed.
//
// Guided Setup's deploy is the only place in this app that changes a customer's
// Cribl configuration, and a toast is the only thing that reports how it went.
// So the assertions here are not about a component: they are about whether the
// outcome of that write reaches somebody who is not looking at the screen, and
// whether it is still there when they come back to it.
//
// The bug being pinned shut is the old markup's, not Capra's. `.gs-toasts` was
// an `aria-live="polite"` container rendered only while it had a toast in it —
// region and message in the same commit, which is the arrangement assistive
// technology commonly does not announce — and errors used the same polite
// container and the same 6-second timer as a progress line. `role="alert"` and
// `duration: 0` are what changed that, and both are asserted below.
//
// Everything runs on fake timers because the interesting part of a toast is when
// it goes away.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, pushToast } from './Toast'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Mounted first and on its own, which is the point: nothing has been pushed
  // yet. In the app this is main.tsx, beside <App/>.
  act(() => { root.render(<ToastProvider />) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/** Capra portals its container to document.body, so the toasts are not in `container`. */
const toasts = () => [...document.body.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
const textOf = (el: HTMLElement) => el.textContent ?? ''

/** Let the toast's own dismiss timer run. */
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('pushToast', () => {
  it('announces a failed write assertively, and keeps it on screen', () => {
    act(() => { pushToast({ kind: 'error', text: 'Deploy failed — port 5514 already in use' }) })

    const [t] = toasts()
    expect(t, 'the failure never reached the DOM').toBeTruthy()
    // The whole reason this is not the old markup: an inserted role="alert" is
    // announced; an aria-live container that appears with its content is not.
    expect(t.getAttribute('role'), 'a failed write was announced politely').toBe('alert')
    expect(t.getAttribute('aria-live')).toBe('assertive')
    expect(textOf(t)).toContain('port 5514 already in use')

    // A minute later — ten times the old 6-second timer — it is still readable.
    wait(60_000)
    expect(toasts().length, 'the failure auto-dismissed and took the reason with it').toBe(1)
  })

  it('gives the failure a close button, because it will not leave on its own', () => {
    act(() => { pushToast({ kind: 'error', text: 'Commit failed' }) })
    const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')
    expect(close, 'an error that never expires and cannot be dismissed is a permanent obstruction').toBeTruthy()
    act(() => { close!.click() })
    expect(toasts().length).toBe(0)
  })

  it('shows progress as one line rather than a queue', () => {
    // A deploy emits eight phases. The old stack showed each for 2.6s; Capra
    // holds a toast for at least 5s, so eight of them would be a wall.
    act(() => { pushToast({ kind: 'provision', text: 'Applying Syslog source…' }) })
    act(() => { pushToast({ kind: 'provision', text: 'Applying Route…' }) })
    act(() => { pushToast({ kind: 'commit', text: 'Committing 5 changed files…' }) })
    act(() => { pushToast({ kind: 'deploy', text: 'Deploying to default…' }) })

    const shown = toasts()
    expect(shown.length, 'every phase of the run stacked up instead of replacing the last').toBe(1)
    expect(textOf(shown[0])).toContain('Deploying to default…')
    expect(shown[0].getAttribute('role'), 'progress narration interrupted the user').toBe('status')
  })

  it('replaces the progress line with the outcome when the run ends', () => {
    act(() => { pushToast({ kind: 'deploy', text: 'Deploying to default…' }) })
    act(() => { pushToast({ kind: 'done', text: 'Deployed to default ✓ (a1b2c3d4e5)' }) })

    const shown = toasts()
    expect(shown.length, '“Deploying…” was left on screen next to “Deployed”').toBe(1)
    expect(textOf(shown[0])).toContain('Deployed to default ✓')
  })

  it('clears the progress line when the run fails, so it cannot contradict the error', () => {
    act(() => { pushToast({ kind: 'provision', text: 'Applying Route…' }) })
    act(() => { pushToast({ kind: 'error', text: 'Route failed — 403' }) })

    const shown = toasts()
    expect(shown.length).toBe(1)
    expect(shown[0].getAttribute('role')).toBe('alert')
    expect(textOf(shown[0])).toContain('Route failed — 403')
  })

  it('lets a progress line expire on its own if nothing follows it', () => {
    // The run died, the tab was left open. The line should not outlive the run
    // as a permanent "Deploying…".
    act(() => { pushToast({ kind: 'provision', text: 'Applying Syslog source…' }) })
    expect(toasts().length).toBe(1)
    wait(30_000)
    expect(toasts().length, 'a progress line became permanent').toBe(0)
  })
})
