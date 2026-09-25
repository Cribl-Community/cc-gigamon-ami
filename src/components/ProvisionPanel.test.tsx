// Guided Setup's panel for the global stacks earlier releases created — the Raw
// HTTP stack and the Syslog stack before it — which offers Remove and nothing
// else.
//
// ── THE PREMISE: A BUILD WHOSE PACK CANNOT BE INSTALLED ─────────────────────
//
// Until 2026-09-25 this panel was THE onboarding in exactly such a build: a
// worker-group picker, a port field, "Deploy onboarding stack" (which created
// the source, breaker ruleset, pipeline and route and committed and deployed
// them) and the "Point Gigamon AMX here" card with the token that run made.
// The owner collapsed that onboarding into the pack's, with no fallback. So
// pack.ts's release constants are moved back here, explicitly — the build in
// which the old panel came back — and the first block below asserts it does
// not: no Deploy, no picker, no port, no endpoint card, and nothing at all when
// the group holds none of the old objects. Every test in this file ran with
// that premise, and would have found a Deploy button on the old code.
//
// *(Converted 2026-09-25, `feat/collapse-old-onboarding`. Deleted with the
// create path they tested: the port picker, TLS and token tests, the endpoint
// card, "the confirm-time check of how the group is hosted", the hosting race
// on a group switch, and the Deploy-trigger variants of the lock and
// pending-file tests. The Remove-trigger variants below replace the last two.)*
//
// WHAT THIS ENVIRONMENT CANNOT BE ASKED: happy-dom implements no sequential
// focus navigation and no layout, so nothing below reports focus order or focus
// restoration. What is asserted here is a request and a string.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetDenials } from '../cribl/authz'
import { ProvisionPanel } from './ProvisionPanel'
import { acquireSetupRun, resetSetupRunLock } from '../cribl/setupRunLock'
import { thisPackRelease } from '../cribl/packClient'
import { pickSetupGroup } from './useSetupGroup'
import { LEGACY_ONLY_LEAD, REMOVE_UNDO } from './provisionPanelCopy'
import { REMOVE_ONLY_LEAD } from './onboardingCopy'
import { HTTP_BREAKER_ID, HTTP_PIPELINE_ID, HTTP_SOURCE_ID } from '../cribl/provision'
import { HTTP_BREAKER_SPEC, PIPELINE_SPEC, ROUTE_SPEC, SOURCE_SPEC } from '../cribl/packSpecs'

vi.mock('../cribl/pack', async (orig) => {
  // A build that pins a version before its release: not published, no sha256,
  // the pinned version off the published list.
  const real = await orig<typeof import('../cribl/pack')>()
  return {
    ...real,
    PACK_PUBLISHED: false, PACK_SHA256: null,
    PACK_PUBLISHED_VERSIONS: Object.freeze(real.PACK_PUBLISHED_VERSIONS.filter((v) => v !== real.PACK_VERSION)),
  }
})

const GROUP = 'default'
const OTHER = 'hyb'
const OTHERS_WORK = `groups/${GROUP}/local/cribl/inputs.yml`

interface LeaderOpts {
  /** Which of the global Raw HTTP stack's objects the group holds. Default none. */
  http?: 'present' | 'absent' | 'unreadable'
  /** What the old Syslog stack's reads answer. Default absent. */
  legacy?: 'present' | 'absent' | 'unreadable'
  /** Status per DELETE path. Default 200. */
  deleteStatus?: Record<string, number>
  /** GROUP runs an older commit than HEAD, and every commit it is behind moved one of its files. */
  groupBehind?: boolean
}

/**
 * A Leader with two worker groups: GROUP holds what `opts` says; OTHER holds
 * nothing. `hold(path)` makes every GET of that exact path wait until the
 * returned function is called — the slow Leader a group switch races.
 */
function stubLeader(opts: LeaderOpts = {}) {
  const sent: Array<{ method: string; path: string; body: string }> = []
  const state = { pending: [] as string[] }
  const holds = new Map<string, Promise<void>>()
  const hold = (path: string) => {
    let release = () => {}
    holds.set(path, new Promise<void>((r) => { release = r }))
    return () => release()
  }
  const http = opts.http ?? 'absent'
  const legacy = opts.legacy ?? 'absent'
  const legacyRoute = { id: 'gigamon_ami_syslog', name: 'gigamon_ami_syslog', filter: "__inputId=='syslog:in_gigamon_syslog'" }
  let routes: Array<Record<string, unknown>> = [
    ...(legacy === 'present' ? [legacyRoute] : []),
    ...(http === 'present' ? [{ ...ROUTE_SPEC }] : []),
    { id: 'default', filter: 'true' },
  ]
  const answer = (which: 'present' | 'absent' | 'unreadable', body: unknown) =>
    which === 'present' ? { status: 200, value: { items: [body] } }
      : which === 'unreadable' ? { status: 403, value: { message: 'forbidden' } }
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
    const held = method === 'GET' ? holds.get(path) : undefined
    if (held) await held
    const at = (m: string, p: string) => method === m && path === p

    if (at('GET', '/version/status')) return reply(200, { items: [{ files: state.pending.map((p) => ({ path: p })) }] })
    if (at('GET', '/version/files')) {
      return reply(200, { items: [{ count: 1, items: [{ name: `groups/${GROUP}/local/cribl/inputs.yml` }] }] })
    }
    if (at('GET', '/version')) return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }, { hash: 'bbbb2222', refs: '' }] })
    if (at('POST', '/version/commit')) return reply(200, { items: [{ commit: 'cccc3333cccc3333' }] })
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(200, { items: [] })
    if (at('GET', '/master/groups')) {
      return reply(200, { items: [{ id: GROUP, name: GROUP, type: 'stream' }, { id: OTHER, name: OTHER, type: 'stream' }] })
    }
    if (at('GET', '/products/stream/groups')) {
      return reply(200, { items: [{ id: GROUP, name: GROUP, onPrem: false }, { id: OTHER, name: OTHER, onPrem: true }] })
    }
    if (at('GET', `/products/stream/groups/${GROUP}`)) {
      return reply(200, { items: [{ id: GROUP, configVersion: opts.groupBehind ? 'bbbb2222' : 'aaaa1111' }] })
    }
    if (at('GET', `/products/stream/groups/${OTHER}`)) return reply(200, { items: [{ id: OTHER, configVersion: 'aaaa1111' }] })

    if (at('GET', `/m/${GROUP}/routes`)) return reply(200, { items: [{ id: 'default', routes }] })
    if (at('PATCH', `/m/${GROUP}/routes/default`)) {
      routes = (JSON.parse(bodyText) as { routes: Array<Record<string, unknown>> }).routes
      return reply(200, { items: [] })
    }
    const objects: Array<[string, 'present' | 'absent' | 'unreadable', unknown]> = [
      [`/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`, http, { ...SOURCE_SPEC, port: 20001 }],
      [`/m/${GROUP}/pipelines/${HTTP_PIPELINE_ID}`, http, { ...PIPELINE_SPEC }],
      [`/m/${GROUP}/lib/breakers/${HTTP_BREAKER_ID}`, http, { ...HTTP_BREAKER_SPEC }],
      [`/m/${GROUP}/system/inputs/in_gigamon_syslog`, legacy, { id: 'in_gigamon_syslog' }],
      [`/m/${GROUP}/pipelines/gigamon_syslog`, legacy, { id: 'gigamon_syslog' }],
    ]
    for (const [p, which, body] of objects) {
      if (at('GET', p)) {
        const r = answer(which, body)
        return reply(r.status, r.value)
      }
    }
    for (const gid of [GROUP, OTHER]) {
      if (at('GET', `/m/${gid}/system/inputs`) || at('GET', `/m/${gid}/packs`)) return reply(200, { items: [] })
    }
    if (at('GET', `/m/${OTHER}/routes`)) return reply(200, { items: [{ id: 'default', routes: [{ id: 'default', filter: 'true' }] }] })
    if (method === 'DELETE') {
      const status = opts.deleteStatus?.[path] ?? 200
      return reply(status, status === 200 ? { items: [] } : { message: 'refused' })
    }
    if (path.startsWith('/kvstore')) return method === 'GET' ? reply(404, '') : reply(200, '')
    return reply(404, { message: `no stub for ${method} ${path}` })
  })
  return { sent, state, hold }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
  resetSetupRunLock()
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
const dialogText = () => (document.body.querySelector('[role="dialog"]')?.textContent ?? '').replace(/\s+/g, ' ')
const buttonNamed = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label)

const press = async (el: Element | undefined) => {
  expect(el, 'no such button on the page').toBeTruthy()
  await act(async () => { (el as HTMLButtonElement).click() })
  await settle()
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

const deleted = (sent: Array<{ method: string; path: string }>) => sent.filter((c) => c.method === 'DELETE').map((c) => c.path)
const writes = (sent: Array<{ method: string; path: string }>) => sent.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))
const statusReads = (sent: Array<{ method: string; path: string }>) =>
  sent.filter((c) => c.method === 'GET' && c.path === '/version/status').length

/** What the old create path put on the page. None of it may come back. */
function expectNoCreatePath() {
  expect(buttonNamed('Deploy onboarding stack'), 'the global Deploy came back').toBeUndefined()
  expect(buttonNamed('Re-apply onboarding stack')).toBeUndefined()
  expect(document.body.querySelector('#gs-group-select'), 'a second worker-group picker').toBeNull()
  expect(document.body.querySelector('#gs-port-input'), 'the global port picker').toBeNull()
  expect(bodyText()).not.toContain('Point Gigamon AMX here')
  expect(bodyText()).not.toContain('Guided setup — onboard live Gigamon AMI over Raw HTTP')
}

describe('the premise: the pinned pack cannot be installed, and nothing falls back to the global stack', () => {
  it('the pack is not installable in this file', () => {
    expect(thisPackRelease()).toMatchObject({ installable: false, published: false, sha256: null })
  })

  it('renders nothing at all when the group holds none of the old objects', async () => {
    const { sent } = stubLeader()
    await mount()
    expect(container.textContent).toBe('')
    expectNoCreatePath()
    expect(writes(sent)).toEqual([])
  })

  it('offers Remove and nothing else when the old Raw HTTP stack is there', async () => {
    stubLeader({ http: 'present' })
    await mount()
    expect(bodyText()).toContain('Raw HTTP stack created outside the pack')
    expect(bodyText()).toContain(REMOVE_ONLY_LEAD)
    expect(buttonNamed('Remove Raw HTTP stack')).toBeTruthy()
    expectNoCreatePath()
  })

  it('offers Remove and nothing else when only the old Syslog stack is there', async () => {
    stubLeader({ legacy: 'present' })
    await mount()
    expect(bodyText()).toContain('Syslog stack from an earlier release')
    expect(bodyText()).toContain(LEGACY_ONLY_LEAD)
    expect(buttonNamed('Remove old Syslog stack')).toBeTruthy()
    expect(buttonNamed('Remove old Syslog objects'), 'a second button for the same objects').toBeUndefined()
    expectNoCreatePath()
  })

  it('shows itself while a read was refused, because a stack that exists must not be hidden by a failed read', async () => {
    stubLeader({ http: 'unreadable' })
    await mount()
    expect(bodyText()).toContain('Cribl refused the read')
    expectNoCreatePath()
  })
})

describe('the Remove confirmation', () => {
  it('names only what is there, and does not promise a rebuild the page cannot do', async () => {
    stubLeader({ http: 'present' })
    await mount()
    await press(buttonNamed('Remove Raw HTTP stack'))
    const text = dialogText()
    for (const id of [HTTP_SOURCE_ID, HTTP_PIPELINE_ID, HTTP_BREAKER_ID, 'gigamon_ami_http']) expect(text).toContain(id)
    expect(text).not.toContain('in_gigamon_syslog')
    expect(text).toContain(REMOVE_UNDO)
    expect(text).not.toContain('Deploy onboarding stack')
  })

  it('deletes the old Raw HTTP objects and takes our route out of the table', async () => {
    const { sent } = stubLeader({ http: 'present' })
    await mount()
    await removeThroughTheDialog('Remove Raw HTTP stack')
    expect(deleted(sent)).toEqual([
      `/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`,
      `/m/${GROUP}/pipelines/${HTTP_PIPELINE_ID}`,
      `/m/${GROUP}/lib/breakers/${HTTP_BREAKER_ID}`,
    ])
    // Never a create or an edit of anything but the routing table.
    expect(writes(sent).filter((c) => c.method === 'POST' && c.path !== '/version/commit')).toEqual([])
    expect(writes(sent).filter((c) => c.method === 'PATCH').map((c) => c.path)).toEqual([
      `/m/${GROUP}/routes/default`, `/products/stream/groups/${GROUP}/deploy`,
    ])
  })

  it('re-reads the pending-file list when it opens, and names work that arrived after the page loaded', async () => {
    const { sent, state } = stubLeader({ http: 'present' })
    await mount()
    const before = statusReads(sent)
    state.pending = [OTHERS_WORK]
    await press(buttonNamed('Remove Raw HTTP stack'))
    expect(statusReads(sent), 'opening the dialog performed no Git status read').toBeGreaterThan(before)
    expect(dialogText()).toContain(OTHERS_WORK)
    expect(dialogText()).toContain('somebody else’s unfinished work')
  })
})

describe('removing the old Syslog objects', () => {
  const SYSLOG = [`/m/${GROUP}/system/inputs/in_gigamon_syslog`, `/m/${GROUP}/pipelines/gigamon_syslog`]

  it('has its own button, whose confirmation names only those objects and deletes only them', async () => {
    const { sent } = stubLeader({ http: 'present', legacy: 'present' })
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
    expect(deleted(sent)).toEqual(SYSLOG)
  })

  it('deletes none of them from the main Remove when their status could not be read, and says so', async () => {
    const { sent } = stubLeader({ http: 'present', legacy: 'unreadable' })
    await mount()
    await press(buttonNamed('Remove Raw HTTP stack'))
    expect(dialogText()).toContain('could not tell whether')
    expect(dialogText()).toContain('in_gigamon_syslog')
    await typeGroup()
    await press(buttonNamed(`Yes, delete from ${GROUP}`))
    await settle(20)
    expect(deleted(sent)).toContain(`/m/${GROUP}/system/inputs/${HTTP_SOURCE_ID}`)
    expect(deleted(sent).filter((p) => SYSLOG.includes(p))).toEqual([])
  })
})

describe('one Guided Setup run at a time', () => {
  it('Remove does not open while another panel’s run holds the lock', async () => {
    const { sent } = stubLeader({ http: 'present' })
    await mount()
    const release = acquireSetupRun('onboarding_pack')!
    await settle()
    const remove = buttonNamed('Remove Raw HTTP stack')!
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    const before = sent.length
    await act(async () => { remove.click() })
    await settle()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(sent.slice(before)).toEqual([])
    release()
  })

  it('a confirmation opened before the lock was taken cannot run while it is held', async () => {
    const { sent } = stubLeader({ http: 'present' })
    await mount()
    await press(buttonNamed('Remove Raw HTTP stack'))
    await typeGroup()
    const release = acquireSetupRun('onboarding_pack')!
    await settle()
    expect(bodyText()).toContain('Another run is already in progress.')
    await act(async () => { buttonNamed(`Yes, delete from ${GROUP}`)!.click() })
    await settle()
    expect(writes(sent)).toEqual([])
    release()
  })
})

describe('the status rows and the undeployed-commit note', () => {
  it('appear when the status check answers, without waiting on the undeployed-commit read', async () => {
    const { hold } = stubLeader({ http: 'present', groupBehind: true })
    hold('/version/files')
    await mount()
    expect(buttonNamed('Re-check'), 'still "Checking…" while /version/files had not answered').toBeTruthy()
  })

  it('says the group is behind a commit that touches it, not that an earlier deploy failed', async () => {
    stubLeader({ http: 'present', groupBehind: true })
    await mount()
    await settle(10)
    expect(bodyText()).toContain(`${GROUP} is behind a commit that touches it`)
    expect(bodyText()).not.toContain('did not finish')
    const tips = [...document.body.querySelectorAll('.gs-action-warn .infotip')].map((t) => t.getAttribute('aria-label') ?? '')
    expect(tips.join(' ')).toContain('aaaa1111')
  })

  it('says in the dialog that the check was still running when it opened, and does not change when it lands', async () => {
    const { hold } = stubLeader({ http: 'present', groupBehind: true })
    const release = hold('/version/files')
    await mount()
    await press(buttonNamed('Remove Raw HTTP stack'))
    const opened = dialogText()
    expect(opened).toContain(`still checking whether ${GROUP} is behind a commit that touches it`)
    release()
    await settle(10)
    expect(dialogText(), 'the dialog’s claim changed underneath the reader').toBe(opened)
  })

  it('does not show an undeployed commit of the group the viewer left under the group they picked', async () => {
    // GROUP is behind a commit that touches it; OTHER holds nothing and is not.
    // The proof for GROUP arrives after the viewer has moved to OTHER — through
    // the page's one picker, which is the onboarding panel's.
    const { hold } = stubLeader({ http: 'present', groupBehind: true })
    const release = hold('/version/files')
    await mount()
    await act(async () => { await pickSetupGroup(OTHER) })
    await settle()
    release()
    await settle(10)
    expect(document.body.innerHTML).not.toContain('aaaa1111')
    expect(bodyText()).not.toContain('behind a commit')
  })
})

// ── What this file does not establish ───────────────────────────────────────
//
//   * THAT A PRESS IS DROPPED WHEN A REFRESH STARTS UNDER ITS GIT READ.
//     `openConfirm` opens nothing when the refresh sequence moved while
//     `/version/status` was out; no test here holds that read open across a
//     group change.
//   * THAT THE READ IS CHEAP. One `GET /version/status` per press is asserted
//     as a count, not as a cost.
