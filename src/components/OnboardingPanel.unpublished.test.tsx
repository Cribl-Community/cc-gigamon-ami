// The onboarding panel in THIS build: no pack release recorded (pack.ts
// `PACK_PUBLISHED` false, no sha256). Nothing here swaps a constant — this is
// the build as it ships, and the refusal is what is pinned:
//   * Onboard is aria-disabled, with the release's own sentence as visible text
//     it points at, and pressing it opens nothing and sends nothing;
//   * `POST /packs` is never sent, by anything on the page;
//   * the Raw HTTP stack's panel is the onboarding (`onboardingPath`), with its
//     Deploy and its picker, exactly as before;
//   * a copy this app owns (the published 0.1.0, from its release) is still
//     offered Remove, and Upgrade is aria-disabled with the release's refusal
//     as the visible sentence it points at — pressing it sends nothing;
//   * an installed build with no pack in the group shows no pack panel at all.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetDenials } from '../cribl/authz'
import { PACK_ID, PACK_VERSION, packRelease, packReleaseUrl } from '../cribl/pack'
import { OnboardingPanel } from './OnboardingPanel'
import { ProvisionPanel } from './ProvisionPanel'

const GROUP = 'default'
interface Call { method: string; path: string }
let calls: Call[] = []

function reply(status: number, value?: unknown) {
  const text = value === undefined ? '' : JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown }
}

function leader(o: { copy?: { version: string; source: string }; pending?: string[] } = {}) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    // `/capi` in dev preview; the absolute API base once installed.
    const path = String(url).replace(/^\/capi/, '').replace(/^https:\/\/main-acme\.cribl\.cloud\/api\/v1/, '').split('?')[0]
    calls.push({ method, path })
    if (path.startsWith('/kvstore')) return method === 'GET' ? reply(404, '') : reply(200, '')
    if (path === '/products/stream/groups') return reply(200, { items: [{ id: GROUP, name: GROUP, onPrem: false }] })
    if (path === `/m/${GROUP}/packs`) return reply(200, { items: o.copy ? [{ id: PACK_ID, ...o.copy }] : [] })
    if (path === `/m/${GROUP}/p/${PACK_ID}/system/inputs`) return reply(200, { items: [] })
    if (path === `/m/${GROUP}/system/inputs`) return reply(200, { items: [] })
    if (path === '/products/lake/lakes/default/datasets') return reply(200, { items: [] })
    if (path === '/version/status') return reply(200, { items: [{ files: (o.pending ?? []).map((p) => ({ path: p })) }] })
    return reply(404, { message: 'not found' })
  })
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
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  delete window.__CRIBL_SEARCH_ORIGIN
  delete (window as { CRIBL_API_URL?: string }).CRIBL_API_URL
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

async function settle(turns = 10) {
  for (let i = 0; i < turns; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function mount(el: React.ReactElement) {
  await act(async () => { root.render(<DashboardProvider>{el}</DashboardProvider>) })
  await settle()
}
const buttonNamed = (label: string) => [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label)
const bodyText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

const REFUSAL = `pack ${PACK_VERSION} has not been released, so there is nothing to install yet`

describe('10. while this build records no release', () => {
  it('pins the premise: this build cannot install the pack', () => {
    expect(packRelease()).toMatchObject({ installable: false, refusal: REFUSAL })
  })

  it('Onboard is aria-disabled and points at the refusal, which is on screen; pressing it sends nothing', async () => {
    leader()
    await mount(<OnboardingPanel />)
    const onboard = buttonNamed('Onboard')!
    expect(onboard.getAttribute('aria-disabled')).toBe('true')
    const said = document.getElementById(onboard.getAttribute('aria-describedby') ?? '')
    expect(said?.textContent).toBe(`Onboard is not available: ${REFUSAL}.`)
    const before = calls.length
    await act(async () => { onboard.click() })
    await settle()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.slice(before)).toEqual([])
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/packs'))).toBe(false)
    // No port to pick for an install that cannot happen.
    expect(document.body.querySelector('#gs-onb-port')).toBeNull()
  })

  it('the Raw HTTP stack’s panel is the onboarding, with its Deploy and the page’s picker', async () => {
    leader()
    await mount(<><OnboardingPanel /><ProvisionPanel /></>)
    expect(buttonNamed('Deploy onboarding stack')).toBeTruthy()
    expect(document.body.querySelector('#gs-group-select')).not.toBeNull()
    expect(document.body.querySelector('#gs-onb-group-select')).toBeNull()
    expect(bodyText()).toContain(`Worker group ${GROUP}, picked in the panel below.`)
  })

  it('a copy this app owns is offered Remove, and Upgrade is aria-disabled, pointing at the release’s refusal; pressing it sends nothing', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') } })
    await mount(<OnboardingPanel />)
    expect(buttonNamed('Remove pack')).toBeTruthy()
    const upgrade = buttonNamed(`Upgrade to ${PACK_VERSION}`)!
    expect(upgrade.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(upgrade.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe(`Upgrade to ${PACK_VERSION} is not available: ${REFUSAL}.`)
    const before = calls.length
    await act(async () => { upgrade.click() })
    await settle()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.slice(before)).toEqual([])
    expect(calls.some((c) => c.method === 'PATCH' && c.path === `/m/${GROUP}/packs/${PACK_ID}`)).toBe(false)
    await act(async () => { buttonNamed('Remove pack')!.click() })
    await settle()
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(`Remove the Gigamon AMI pack from ${GROUP}`)
    // 0.1.0's own objects, by their published ids.
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('in_gno_syslog')
  })

  it('a copy this app did not install is not offered Remove', async () => {
    leader({ copy: { version: '0.1.0', source: 'https://elsewhere.example.com/fork.crbl' } })
    await mount(<OnboardingPanel />)
    expect(buttonNamed('Remove pack')).toBeUndefined()
  })

  it('installed in Cribl, with no pack in the group: no pack panel at all', async () => {
    ;(window as { CRIBL_API_URL?: string }).CRIBL_API_URL = 'https://main-acme.cribl.cloud/api/v1'
    vi.resetModules()
    const { OnboardingPanel: Installed } = await import('./OnboardingPanel')
    const { DashboardProvider: Provider } = await import('../app/DashboardContext')
    leader()
    await act(async () => { root.render(<Provider><Installed /></Provider>) })
    await settle()
    expect(bodyText()).not.toContain('Onboard Gigamon AMI with the pack')
    // It still read, to know whether a pack is there.
    expect(calls.some((c) => c.path === `/m/${GROUP}/packs`)).toBe(true)
    expect(calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))).toEqual([])
    // …and nothing else a hidden panel has no use for: the datasets, the
    // scheduled searches, the group's ports, the Leader's history.
    const read = new Set(calls.map((c) => c.path))
    for (const p of ['/products/lake/lakes/default/datasets', '/m/default_search/search/saved', `/m/${GROUP}/system/inputs`, '/version', '/products/stream/groups']) {
      expect(read.has(p), `a hidden panel read ${p}`).toBe(false)
    }
  })

  it('installed in Cribl, with no pack in the group but its removal left uncommitted: the panel shows, to finish it', async () => {
    ;(window as { CRIBL_API_URL?: string }).CRIBL_API_URL = 'https://main-acme.cribl.cloud/api/v1'
    vi.resetModules()
    const { OnboardingPanel: Installed } = await import('./OnboardingPanel')
    const { DashboardProvider: Provider } = await import('../app/DashboardContext')
    leader({ pending: [`groups/${GROUP}/default/${PACK_ID}/package.json`] })
    await act(async () => { root.render(<Provider><Installed /></Provider>) })
    await settle()
    expect(bodyText()).toContain('Onboard Gigamon AMI with the pack')
    expect(buttonNamed('Finish removing the pack')).toBeTruthy()
    expect(buttonNamed('Remove pack')).toBeUndefined()
    // A panel that shows reads what its status rows say.
    expect(calls.some((c) => c.path === '/products/lake/lakes/default/datasets')).toBe(true)
  })
})

// What this file could not assert: that a real Leader would refuse the POST
// (it is never sent, which is the point), focus handling (happy-dom), and the
// Live Preview pass the design asks for, which needs the app installed.
