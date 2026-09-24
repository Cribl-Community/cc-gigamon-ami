// When the Guided Setup confirmation reads what is already uncommitted.
//
// ── THE SENTENCE THAT WAS TRUE OF NOTHING ───────────────────────────────────
//
// The clean-tree branch of `pendingSentence` ends: "That was read when this
// dialog opened, and anybody can save a change in Cribl while it is open."
//
// The first half was not true. `pendingPaths` came from `refresh()`, which runs
// on mount, on a worker-group change, on Re-check and after a run — opening the
// dialog performed no read at all. A tab left open ten minutes showed a
// ten-minute-old list under a sentence claiming otherwise, and that list is the
// one thing on the screen somebody uses to decide whether to press a button
// that commits another admin's unfinished work and restarts Worker Processes.
//
// Making the sentence true (saying when the list was actually read) was the
// other option. This one was taken because the reader is not trying to date the
// list, they are trying to decide; a fresh list decides better than a labelled
// stale one. The read finishes BEFORE `isOpen` flips, so there is no window in
// which the dialog shows the old list under the new sentence.
//
// WHAT THIS ENVIRONMENT CANNOT BE ASKED, as every other component test here
// says rather than fakes: happy-dom implements no sequential focus navigation
// and no layout, so nothing below reports focus order, focus restoration to the
// trigger, or whether the dialog is reachable at 400 px. Those are Preview
// checks. What is asserted here is a request and a string.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetDenials } from '../cribl/authz'
import { ProvisionPanel } from './ProvisionPanel'
import { GROUP_TIP, PROVISION_LEAD, PROVISION_LEAD_TIP, deployNote } from './provisionPanelCopy'

const GROUP = 'default'
const OTHERS_WORK = `groups/${GROUP}/local/cribl/inputs.yml`

interface Call { method: string; path: string }

/**
 * A Leader with none of the stack provisioned — so the screen offers "Deploy
 * onboarding stack" — whose Git status this test can move under the panel.
 */
function stubLeader() {
  const calls: Call[] = []
  const state = { pending: [] as string[] }

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '').split('?')[0]
    calls.push({ method, path })

    const reply = (status: number, value?: unknown) => {
      const text = value === undefined ? '' : JSON.stringify(value)
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      }
    }

    if (path === '/version/status') {
      return reply(200, { items: [{ files: state.pending.map((p) => ({ path: p })) }] })
    }
    if (path === '/version/files') return reply(200, { items: [] })
    if (path === '/version') return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }] })
    if (path === '/products/stream/groups') return reply(200, { items: [{ id: GROUP, name: GROUP }] })
    if (path === `/products/stream/groups/${GROUP}`) {
      return reply(200, { items: [{ id: GROUP, configVersion: 'aaaa1111' }] })
    }
    // This app's own store: nothing remembered, and the audit trail takes
    // whatever it is handed.
    if (path.startsWith('/kvstore')) return method === 'GET' ? reply(404, '') : reply(200, '')
    // Everything the status check looks for is absent, which is the state that
    // offers Deploy rather than Re-apply.
    return reply(404, { message: `no stub for ${method} ${path}` })
  })

  return { calls, state }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('getCriblUser', async () => ({ id: 'auth0|me', username: 'me' }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetDenials()
  container = document.createElement('div')
  // Capra's Modal portals out of this element, so the dialog's text is read off
  // document.body rather than off this.
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDenials()
})

async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}

async function mount() {
  await act(async () => { root.render(<DashboardProvider><ProvisionPanel /></DashboardProvider>) })
  await settle()
}

const bodyText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

const buttonNamed = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label)

const press = async (el: Element | undefined) => {
  expect(el, 'no such button on the page').toBeTruthy()
  await act(async () => { (el as HTMLButtonElement).click() })
  await settle()
}

const statusReads = (calls: readonly Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === '/version/status').length

describe('the pending-file list the Guided Setup confirmation names', () => {
  it('is read when the dialog opens, not whenever the page last refreshed', async () => {
    const { calls } = stubLeader()
    await mount()
    const before = statusReads(calls)

    await press(buttonNamed('Deploy onboarding stack'))

    expect(bodyText(), 'the confirmation did not open').toContain('onboarding stack to Cribl Stream worker group')
    expect(statusReads(calls), 'opening the dialog performed no Git status read').toBeGreaterThan(before)
  })

  it('names work that arrived after the page loaded, because it re-read', async () => {
    // The whole point, stated as the thing a reader would get wrong: somebody
    // else saved a change in Cribl while this tab sat open. The mount-time read
    // cannot know; the read at open does.
    const { state } = stubLeader()
    await mount()
    expect(bodyText()).not.toContain(OTHERS_WORK)

    state.pending = [OTHERS_WORK]
    await press(buttonNamed('Deploy onboarding stack'))

    expect(bodyText()).toContain(OTHERS_WORK)
    expect(bodyText()).toContain('somebody else’s unfinished work')
  })
})

describe('what the panel says before anything is pressed', () => {
  // The intro was 120 words and the group hint three sentences (declutter,
  // 2026-09-24). What moved behind an ⓘ must still be reachable — the ⓘ's
  // accessible name IS the text — and the commit-reach warning in particular
  // must survive the move, because it is the one thing the old intro said about
  // somebody else's configuration.
  const tipsIn = (selector: string) =>
    [...document.body.querySelectorAll(`${selector} .infotip`)].map((t) => t.getAttribute('aria-label'))

  it('shows one lead line, with the rest one ⓘ away', async () => {
    stubLeader()
    await mount()
    const lead = document.body.querySelector('.gs-intro')
    expect(lead?.firstChild?.textContent).toBe(PROVISION_LEAD)
    expect(PROVISION_LEAD.split(/\s+/).length).toBeLessThanOrEqual(25)
    expect(tipsIn('.gs-intro')).toEqual([PROVISION_LEAD_TIP])
    expect(PROVISION_LEAD_TIP).toContain('inputs.yml')
    expect(PROVISION_LEAD_TIP).toContain('never edited')
  })

  it('explains the worker group beside its label, not in a paragraph after the picker', async () => {
    stubLeader()
    await mount()
    expect(tipsIn('.gs-group-picker')).toEqual([GROUP_TIP])
    expect(document.body.querySelector('.gs-group-hint')).toBeNull()
  })

  it('still says, beside Deploy, that nothing is written before the review', async () => {
    stubLeader()
    await mount()
    expect(bodyText()).toContain(deployNote(GROUP))
  })
})

// ── What this file does not establish ───────────────────────────────────────
//
//   * THE TEARDOWN TRIGGER. It is only rendered when something in the group is
//     present, and this stub provisions nothing, so the assertions above are on
//     the deploy trigger alone. Both call the same `openConfirm`, which is a
//     type-level fact here and not a measured one.
//   * THAT THE READ IS CHEAP. One `GET /version/status` per press is asserted
//     as a count, not as a cost; whether a real Leader answers it quickly enough
//     that the dialog does not feel late is a Preview check.
