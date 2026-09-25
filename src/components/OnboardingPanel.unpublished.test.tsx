// The onboarding panel in a build that pins a pack version before its release
// exists: pack.ts `PACK_PUBLISHED` false, no sha256, the pinned version off
// `PACK_PUBLISHED_VERSIONS`. That is THIS build again: it pins 0.2.2 before
// its release, so the mock below changes nothing today; it stays so this file
// keeps describing an unreleased pin after the flip, as it did while 0.2.1 was
// released. The published build's behaviour is OnboardingPanel.test.tsx (its
// block 10). *(Corrected 2026-09-25, `feat/pack-flip-021`, and again the same
// day, `feat/pack-022-parquet-pipeline`, when the pin moved to the unreleased
// 0.2.2.)* The refusal is what is pinned:
//   * Onboard is aria-disabled, with the release's own sentence as visible text
//     it points at, and pressing it opens nothing and sends nothing;
//   * `POST /packs` is never sent, by anything on the page;
//   * NOTHING FALLS BACK: the pack panel holds the page's picker, and the Raw
//     HTTP stack's panel offers no Deploy (it renders only to remove an old
//     stack). *(Until 2026-09-25 that panel became the onboarding here, with
//     its Deploy and picker — `onboardingPath`'s 'global' mode.)*
//   * a copy this app owns (the published 0.1.0, from its release) is still
//     offered Remove, and Upgrade is aria-disabled with the release's refusal
//     as the visible sentence it points at — pressing it sends nothing;
//   * an installed build with no pack in the group shows the pack panel, with
//     Onboard refused — it is the only onboarding on the page. *(Until
//     2026-09-25 it showed no pack panel there at all.)* Live Preview shows it
//     the same way.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetDenials } from '../cribl/authz'
import { PACK_ID, PACK_VERSION, packReleaseUrl } from '../cribl/pack'
import { thisPackRelease } from '../cribl/packClient'
import { OnboardingPanel } from './OnboardingPanel'
import { ProvisionPanel } from './ProvisionPanel'

vi.mock('../cribl/pack', async (orig) => {
  const real = await orig<typeof import('../cribl/pack')>()
  return {
    ...real,
    PACK_PUBLISHED: false, PACK_SHA256: null,
    PACK_PUBLISHED_VERSIONS: Object.freeze(real.PACK_PUBLISHED_VERSIONS.filter((v) => v !== real.PACK_VERSION)),
  }
})

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
  vi.unstubAllEnvs()
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
  it('pins the premise: a build with no release recorded cannot install the pack', () => {
    // What the panel reads (packClient.ts, bound to the constants moved above).
    expect(thisPackRelease()).toMatchObject({ installable: false, refusal: REFUSAL })
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

  it('nothing falls back to the Raw HTTP stack: the pack panel holds the page’s picker, and there is no Deploy', async () => {
    // Until 2026-09-25 this asserted the opposite — the global stack's panel as
    // the onboarding, with "Deploy onboarding stack" and the page's picker.
    leader()
    await mount(<><OnboardingPanel /><ProvisionPanel /></>)
    expect(buttonNamed('Deploy onboarding stack')).toBeUndefined()
    expect(document.body.querySelector('#gs-group-select')).toBeNull()
    expect(document.body.querySelector('#gs-port-input')).toBeNull()
    expect(document.body.querySelector('#gs-onb-group-select')).not.toBeNull()
    expect(bodyText()).not.toContain('picked in the panel below')
    expect(bodyText()).not.toContain('Raw HTTP stack created outside the pack')
    expect(bodyText()).toContain(`Onboard is not available: ${REFUSAL}.`)
    expect(calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))).toEqual([])
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

  it('installed in Cribl, with no pack in the group: the pack panel shows, Onboard refused, and nothing is written', async () => {
    // Until 2026-09-25 an installed build showed no pack panel here at all,
    // because the global Raw HTTP stack's panel was the onboarding. With that
    // fallback gone, this panel is the only place the page says why nothing
    // can be onboarded yet.
    ;(window as { CRIBL_API_URL?: string }).CRIBL_API_URL = 'https://main-acme.cribl.cloud/api/v1'
    // A built bundle: Vite's DEV is false there (vitest's is true).
    vi.stubEnv('DEV', false)
    vi.resetModules()
    const { OnboardingPanel: Installed } = await import('./OnboardingPanel')
    const { DashboardProvider: Provider } = await import('../app/DashboardContext')
    leader()
    await act(async () => { root.render(<Provider><Installed /></Provider>) })
    await settle()
    expect(bodyText()).toContain('Onboard Gigamon AMI with the pack')
    expect(buttonNamed('Onboard')?.getAttribute('aria-disabled')).toBe('true')
    expect(bodyText()).toContain(`Onboard is not available: ${REFUSAL}.`)
    expect(document.body.querySelector('#gs-onb-group-select')).not.toBeNull()
    expect(calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))).toEqual([])
  })

  it('installed in Cribl, with no pack in the group but its removal left uncommitted: the panel shows, to finish it', async () => {
    ;(window as { CRIBL_API_URL?: string }).CRIBL_API_URL = 'https://main-acme.cribl.cloud/api/v1'
    vi.stubEnv('DEV', false)
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

describe('Live Preview: installed in Cribl, served by the dev server', () => {
  it('shows the pack panel with Onboard refused, and writes nothing', async () => {
    ;(window as { CRIBL_API_URL?: string }).CRIBL_API_URL = 'https://main-acme.cribl.cloud/api/v1'
    vi.stubEnv('DEV', true)
    vi.resetModules()
    const { OnboardingPanel: Preview } = await import('./OnboardingPanel')
    const { DashboardProvider: Provider } = await import('../app/DashboardContext')
    leader()
    await act(async () => { root.render(<Provider><Preview /></Provider>) })
    await settle()
    expect(bodyText()).toContain('Onboard Gigamon AMI with the pack')
    expect(buttonNamed('Onboard')?.getAttribute('aria-disabled')).toBe('true')
    expect(bodyText()).toContain(`Onboard is not available: ${REFUSAL}.`)
    expect(calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))).toEqual([])
  })
})

// What this file could not assert: that a real Leader would refuse the POST
// (it is never sent, which is the point), focus handling (happy-dom), and the
// Live Preview pass the design asks for, which needs the app installed.
