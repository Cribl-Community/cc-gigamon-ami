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
import {
  AUTH_HEADER, ENDPOINT_INCOMPLETE, GROUP_TIP, PROVISION_LEAD, PROVISION_LEAD_TIP, TOKEN_ELSEWHERE, TOKEN_ONCE, UNENCRYPTED_WARNING, deployNote,
} from './provisionPanelCopy'
import {
  HTTP_BREAKER_ID, HTTP_BREAKER_SPEC, HTTP_PIPELINE_ID, HTTP_SOURCE_ID, PIPELINE_SPEC, ROUTE_SPEC, SOURCE_SPEC,
} from '../cribl/provision'

const GROUP = 'default'
const OTHERS_WORK = `groups/${GROUP}/local/cribl/inputs.yml`

interface Call { method: string; path: string }

/**
 * A Leader with none of the stack provisioned — so the screen offers "Deploy
 * onboarding stack" — whose Git status this test can move under the panel.
 */
function stubLeader(opts: { behindAndSlow?: boolean } = {}) {
  const calls: Call[] = []
  const state = { pending: [] as string[] }
  // `behindAndSlow`: the group runs an older commit than HEAD, and
  // `/version/files` never answers — the slowest `pendingDeploy` can be.
  const running = opts.behindAndSlow ? 'bbbb2222' : 'aaaa1111'

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
    if (path === '/version/files') {
      return opts.behindAndSlow ? new Promise<never>(() => {}) : reply(200, { items: [] })
    }
    if (path === '/version') {
      return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }, { hash: 'bbbb2222', refs: '' }] })
    }
    // Cribl-managed, on the Cribl.Cloud Leader the beforeEach names.
    if (path === '/products/stream/groups') return reply(200, { items: [{ id: GROUP, name: GROUP, onPrem: false }] })
    // No other sources and no packs, so every port is free.
    if (path === `/m/${GROUP}/system/inputs`) return reply(200, { items: [] })
    if (path === `/m/${GROUP}/packs`) return reply(200, { items: [] })
    if (path === `/products/stream/groups/${GROUP}`) {
      return reply(200, { items: [{ id: GROUP, configVersion: running }] })
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
  // A Cribl.Cloud Leader, which is what makes `onPrem: false` mean
  // Cribl-managed. A test about a self-hosted Leader overrides it.
  window.__CRIBL_SEARCH_ORIGIN = 'https://main-acme.cribl.cloud'
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
  delete window.__CRIBL_SEARCH_ORIGIN
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

describe('the status rows', () => {
  // `refresh()` used to await `Promise.all([checkStatus, pendingDeploy, …])`,
  // so the rows waited for the slowest of the three — and `pendingDeploy` reads
  // `/version/files` once per commit the group is behind. The undeployed-commit
  // line is a side question; it must not hold the rows hostage.
  it('appear when the status check answers, without waiting on the undeployed-commit read', async () => {
    stubLeader({ behindAndSlow: true })
    await mount()
    expect(buttonNamed('Re-check'), 'still "Checking…" while /version/files had not answered').toBeTruthy()
    expect(buttonNamed('Deploy onboarding stack')).toBeTruthy()
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

/**
 * A Leader with the whole stack present EXCEPT the Raw HTTP source, which a
 * Deploy therefore creates. It remembers the create body and answers later
 * reads of the source with it, so the endpoint card reads what was created.
 */
interface StackOpts {
  /** The group record's `onPrem`; null leaves it out, as a self-hosted Leader does. */
  onPrem?: boolean | null
  usedPorts?: number[]
  /** Start with the Raw HTTP source already there (so the whole stack is). */
  sourcePresent?: boolean
  /** Start without our route in the table, and answer its PATCH with this. */
  routeMissing?: boolean
  routePatchStatus?: number
  /** What the old Syslog stack's three reads answer. Default absent. */
  legacy?: 'present' | 'absent' | 'unreadable'
  /** Status per DELETE path. Default 200. */
  deleteStatus?: Record<string, number>
}

function stubLeaderWithoutSource(opts: StackOpts = {}) {
  const sent: Array<{ method: string; path: string; body: string }> = []
  let source: Record<string, unknown> | null = opts.sourcePresent
    ? { ...SOURCE_SPEC, port: 20001, tls: { disabled: false }, authTokensExt: [{ token: 'lab-existing-token-value', authType: 'manual' }] }
    : null
  const legacyRoute = { id: 'gigamon_ami_syslog', name: 'gigamon_ami_syslog', filter: "__inputId=='syslog:in_gigamon_syslog'" }
  let routes: Array<Record<string, unknown>> = [
    ...(opts.legacy === 'present' ? [legacyRoute] : []),
    ...(opts.routeMissing ? [] : [{ ...ROUTE_SPEC }]),
    { id: 'default', filter: 'true' },
  ]
  const legacyRead = () =>
    opts.legacy === 'present' ? { status: 200, value: { items: [{ id: 'x' }] } }
      : opts.legacy === 'unreadable' ? { status: 403, value: { message: 'forbidden' } }
        : { status: 404, value: { message: 'not found' } }
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '').split('?')[0]
    const bodyText = init.body == null ? '' : String(init.body)
    sent.push({ method, path, body: bodyText })
    const reply = (status: number, value?: unknown) => {
      const text = value === undefined ? '' : JSON.stringify(value)
      return { ok: status >= 200 && status < 300, status, statusText: 'OK', text: async () => text, json: async () => JSON.parse(text) as unknown }
    }
    const at = (m: string, p: string) => method === m && path === p
    if (at('GET', '/version/status')) return reply(200, { items: [{ files: [] }] })
    if (at('GET', '/version/files')) return reply(200, { items: [] })
    if (at('GET', '/version')) return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }] })
    if (at('POST', '/version/commit')) return reply(200, { items: [{ commit: 'bbbb2222bbbb2222' }] })
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(200, { items: [] })
    if (at('GET', '/products/stream/groups')) {
      const onPrem = opts.onPrem === undefined ? false : opts.onPrem
      return reply(200, { items: [{ id: GROUP, name: GROUP, ...(onPrem === null ? {} : { onPrem }) }] })
    }
    if (at('GET', `/products/stream/groups/${GROUP}`)) return reply(200, { items: [{ id: GROUP, configVersion: 'aaaa1111' }] })
    if (at('GET', '/master/groups')) return reply(200, { items: [{ id: GROUP, name: GROUP, type: 'stream' }] })
    if (at('GET', '/products/lake/lakes/default/datasets')) return reply(200, { items: [{ id: 'gigamon_ami' }] })
    if (at('GET', `/m/${GROUP}/system/outputs/gigamon_lake`)) return reply(200, { items: [{ id: 'gigamon_lake' }] })
    if (at('GET', `/m/${GROUP}/lib/breakers/${HTTP_BREAKER_ID}`)) return reply(200, { items: [{ ...HTTP_BREAKER_SPEC }] })
    if (at('GET', `/m/${GROUP}/pipelines/${HTTP_PIPELINE_ID}`)) return reply(200, { items: [{ ...PIPELINE_SPEC }] })
    if (at('GET', `/m/${GROUP}/routes`)) {
      // A legacy-unreadable Leader refuses the table too, for the legacy check;
      // the HTTP check reads the same path, so it answers the table either way.
      return reply(200, { items: [{ id: 'default', routes }] })
    }
    if (at('PATCH', `/m/${GROUP}/routes/default`)) {
      if (opts.routePatchStatus && opts.routePatchStatus !== 200) return reply(opts.routePatchStatus, { message: 'refused' })
      routes = (JSON.parse(bodyText) as { routes: Array<Record<string, unknown>> }).routes
      return reply(200, { items: [] })
    }
    if (at('GET', `/m/${GROUP}/system/inputs/in_gigamon_syslog`) || at('GET', `/m/${GROUP}/pipelines/gigamon_syslog`)) {
      const r = legacyRead()
      return reply(r.status, r.value)
    }
    if (at('GET', `/m/${GROUP}/packs`)) return reply(200, { items: [] })
    if (method === 'DELETE') {
      const status = opts.deleteStatus?.[path] ?? 200
      if (status === 200 && path === `/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`) source = null
      return reply(status, status === 200 ? { items: [] } : { message: 'refused' })
    }
    if (at('GET', `/m/${GROUP}/system/inputs`)) {
      return reply(200, { items: (opts.usedPorts ?? []).map((port, i) => ({ id: `other${i}`, type: 'http', port })) })
    }
    if (at('GET', `/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`)) {
      return source ? reply(200, { items: [source] }) : reply(404, { message: 'not found' })
    }
    if (at('POST', `/m/${GROUP}/system/inputs`)) {
      source = JSON.parse(bodyText) as Record<string, unknown>
      return reply(200, { items: [source] })
    }
    if (path.startsWith('/kvstore')) return method === 'GET' ? reply(404, '') : reply(200, '')
    return reply(404, { message: `no stub for ${method} ${path}` })
  })
  return { sent, created: () => source }
}

async function deployThroughTheDialog() {
  await press(buttonNamed('Deploy onboarding stack'))
  await press(buttonNamed(`Yes, deploy to ${GROUP}`))
  await settle(20)
}

/** Type into the open dialog's type-to-confirm field. */
async function typeGroup() {
  await act(async () => {
    const el = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, GROUP)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

async function removeThroughTheDialog(trigger: string) {
  await press(buttonNamed(trigger))
  await typeGroup()
  await press(buttonNamed(`Yes, delete from ${GROUP}`))
  await settle(20)
}

const dialogText = () => (document.body.querySelector('[role="dialog"]')?.textContent ?? '').replace(/\s+/g, ' ')
const deleted = (sent: Array<{ method: string; path: string }>) => sent.filter((c) => c.method === 'DELETE').map((c) => c.path)
const tokenOf = (created: Record<string, unknown> | null) =>
  ((created?.authTokensExt as Array<{ token: string }> | undefined) ?? [])[0]?.token

const portInput = () => document.body.querySelector<HTMLInputElement>('#gs-port-input')

describe('the Raw HTTP source’s port, TLS and token', () => {
  it('offers the first free port in 20000–20010 on a Cribl-managed group', async () => {
    stubLeaderWithoutSource({ usedPorts: [20000] })
    await mount()
    expect(portInput()?.value).toBe('20001')
  })

  it('will not open the confirmation for a port another source uses', async () => {
    stubLeaderWithoutSource({ usedPorts: [20000, 20001] })
    await mount()
    await act(async () => {
      const input = portInput()!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '20001')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    expect(bodyText()).toContain('Another source in this group already listens on 20001.')
    expect(buttonNamed('Deploy onboarding stack')?.getAttribute('aria-disabled')).toBe('true')
    await press(buttonNamed('Deploy onboarding stack'))
    expect(bodyText()).not.toContain('onboarding stack to Cribl Stream worker group')
  })

  it('shows the token once on the endpoint card, next to an https POST URL, and nowhere after a reload', async () => {
    const leader = stubLeaderWithoutSource()
    await mount()
    await deployThroughTheDialog()

    const token = ((leader.created()?.authTokensExt as Array<{ token: string }> | undefined) ?? [])[0]?.token
    expect(token, 'the source was not created with a token').toMatch(/^[0-9a-f]{64}$/)
    expect(bodyText()).toContain('Point Gigamon AMX here')
    expect(bodyText()).toContain(token)
    expect(bodyText()).toContain(TOKEN_ONCE)
    expect(bodyText()).toContain('https://')
    expect(bodyText()).toContain(':20000/')
    expect(buttonNamed('Copy token')).toBeTruthy()
    expect(bodyText()).not.toContain(UNENCRYPTED_WARNING)
    // It never went to this app's own store — the only writes there are the
    // audit trail and the commit memory, and neither carries it.
    expect(leader.sent.filter((c) => c.path.startsWith('/kvstore') && c.body.includes(token!))).toEqual([])

    // A reload is a new mount: nothing kept it, so nothing can show it.
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
    expect(bodyText()).not.toContain(token)
    expect(bodyText()).toContain(TOKEN_ELSEWHERE)
  })

  it('shows the token even when the run stopped after the source was created', async () => {
    // The source is created, then the route fails. The token exists only in
    // this page's state, so a card that waited for every row to be present
    // would never show it: "shown once" would be "never shown".
    const leader = stubLeaderWithoutSource({ routeMissing: true, routePatchStatus: 500 })
    await mount()
    await deployThroughTheDialog()
    const token = tokenOf(leader.created())
    expect(token, 'the source was not created').toMatch(/^[0-9a-f]{64}$/)
    expect(bodyText()).toContain(token)
    expect(bodyText()).toContain(TOKEN_ONCE)
    expect(bodyText()).toContain(ENDPOINT_INCOMPLETE)
  })

  it('prints the exact header AMX must send', async () => {
    stubLeaderWithoutSource()
    await mount()
    await deployThroughTheDialog()
    expect(bodyText()).toContain(AUTH_HEADER)
  })

  it('keeps showing the token when Remove could not delete the source', async () => {
    const leader = stubLeaderWithoutSource({ deleteStatus: { [`/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`]: 500 } })
    await mount()
    await deployThroughTheDialog()
    const token = tokenOf(leader.created())
    expect(bodyText()).toContain(token)
    await removeThroughTheDialog('Remove onboarding stack')
    expect(deleted(leader.sent), 'Remove was never confirmed').toContain(`/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`)
    expect(bodyText(), 'the token was dropped although the source that uses it is still there').toContain(token)
  })

  it('blocks creating a source when the group record does not say how it is hosted', async () => {
    stubLeaderWithoutSource({ onPrem: null })
    await mount()
    expect(bodyText()).toContain('could not tell whether')
    expect(buttonNamed('Deploy onboarding stack')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('does not treat a self-hosted Leader’s group as Cribl-managed', async () => {
    window.__CRIBL_SEARCH_ORIGIN = 'https://leader.example.com'
    stubLeaderWithoutSource({ onPrem: false })
    await mount()
    expect(bodyText()).toContain('could not tell whether')
    expect(buttonNamed('Deploy onboarding stack')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('says plainly on a hybrid group that the traffic is unencrypted, and prints http', async () => {
    stubLeaderWithoutSource({ onPrem: true })
    await mount()
    expect(portInput()?.value).toBe('10080')
    await deployThroughTheDialog()
    expect(bodyText()).toContain(UNENCRYPTED_WARNING)
    expect(bodyText()).toContain('http://<worker-ingress-host>:10080/')
  })
})

describe('removing the old Syslog objects', () => {
  const SYSLOG = [`/m/${GROUP}/system/inputs/in_gigamon_syslog`, `/m/${GROUP}/pipelines/gigamon_syslog`]

  it('has its own button, whose confirmation names only those objects and deletes only them', async () => {
    const leader = stubLeaderWithoutSource({ sourcePresent: true, legacy: 'present' })
    await mount()
    await press(buttonNamed('Remove old Syslog objects'))
    const text = dialogText()
    expect(text).toContain('in_gigamon_syslog')
    expect(text).toContain('gigamon_syslog')
    expect(text).toContain('gigamon_ami_syslog')
    expect(text, 'the Syslog-only dialog names the HTTP source').not.toContain(HTTP_SOURCE_ID)
    await typeGroup()
    await press(buttonNamed(`Yes, delete from ${GROUP}`))
    await settle(20)
    expect(deleted(leader.sent)).toEqual(SYSLOG)
  })

  it('deletes none of them from the main Remove when their status could not be read, and says so', async () => {
    const leader = stubLeaderWithoutSource({ sourcePresent: true, legacy: 'unreadable' })
    await mount()
    await press(buttonNamed('Remove onboarding stack'))
    expect(dialogText()).toContain('could not tell whether')
    expect(dialogText()).toContain('in_gigamon_syslog')
    await typeGroup()
    await press(buttonNamed(`Yes, delete from ${GROUP}`))
    await settle(20)
    expect(deleted(leader.sent)).toContain(`/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`)
    expect(deleted(leader.sent).filter((p) => SYSLOG.includes(p))).toEqual([])
  })
})

// ── What this file does not establish ───────────────────────────────────────
//
//   * THE PENDING-FILE READ ON THE TEARDOWN TRIGGERS. The two Remove dialogs
//     are opened and confirmed above, but the re-read of Git status at open is
//     asserted on the deploy trigger alone.
//   * THAT A POST WITH `Authorization: <token>` IS ACCEPTED. The header line
//     comes from openapi.json; proving it takes a POST to a live source, which
//     is a write nothing in this suite (or its reviewers) may make.
//   * THAT COPY PUTS THE TOKEN ON THE CLIPBOARD. happy-dom has no clipboard;
//     the Copy buttons are asserted present, not working. Both call the same `openConfirm`, which is a
//     type-level fact here and not a measured one.
//   * THAT THE READ IS CHEAP. One `GET /version/status` per press is asserted
//     as a count, not as a cost; whether a real Leader answers it quickly enough
//     that the dialog does not feel late is a Preview check.
