// The onboarding panel in a build whose pinned pack is released. This build
// pins 0.2.2 before its release (pack.ts), so the release constants are moved
// forward below, as the flip after the tag will move them. *(Corrected
// 2026-09-25, `feat/pack-022-parquet-pipeline`: from `feat/pack-flip-021`
// until then this file swapped nothing, because the build shipped with 0.2.1
// released. Before that it mocked a release in, as it does again now.)* The
// unreleased build as it ships is OnboardingPanel.unpublished.test.tsx.
//
//  10. the premise, pinned: this build installs, Onboard is offered (not
//      aria-disabled) and opens a real dialog without a write, and an installed
//      build shows the panel with no pack in the group;
// What is asserted is requests and strings, against a fake Leader at `fetch`:
//   3. nothing writes on mount, a group change, Re-check, opening either
//      dialog, Cancel or Escape — and thirty minutes of timers later, still
//      nothing;
//   4. the token is shown once: after the run that set it, and not after a
//      remount, a group change there and back, or Remove; never in a toast,
//      the dialog, or the app's store;
//   8. "Also send sample data" is unticked, and unticked names no sample row;
//  11. Remove pack names the three datasets it keeps, deletes none, and needs
//      the group typed;
//  11. Upgrade: offered for an owned copy that is behind, its dialog lists what
//      the new version adds and no longer ships, and says settings are not verified to
//      survive, and a confirmed run upgrades, reads back, commits and deploys;
//   the pack sources' own settings — Rotate token (the new token shown once),
//   Move port, Start and Stop sample data (Start refused until its dataset
//   exists) — each from its own confirmation, and none of them on load;
//   and the Raw HTTP stack's panel steps aside once the pack onboards.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetDenials } from '../cribl/authz'
import { settleDatasetTarget } from '../cribl/datasetTarget'
import { PACK_HTTP_INPUT_ID, PACK_ID, PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID, PACK_URL, PACK_VERSION, packReleaseUrl } from '../cribl/pack'
import { thisPackRelease } from '../cribl/packClient'
import { acquireSetupRun, resetSetupRunLock } from '../cribl/setupRunLock'
import { OnboardingPanel } from './OnboardingPanel'
import { ProvisionPanel } from './ProvisionPanel'
import { REMOVE_ONLY_LEAD, SAMPLE_LABEL, SAMPLE_START_REFUSAL, TOKEN_UNDEPLOYED } from './onboardingCopy'

const toasts = vi.hoisted(() => [] as Array<{ kind: string; text: string }>)
vi.mock('./Toast', () => ({
  pushToast: (p: { kind: string; text: string }) => { toasts.push(p) },
  clearToastError: () => {},
  ToastProvider: () => null,
}))
vi.mock('../cribl/pack', async (orig) => {
  // PACK_VERSION's release recorded, as the flip after its tag records it:
  // published, a digest, and appended to the versions already published. This
  // build pins 0.2.2 before its release (pack.ts), so without this every block
  // below would describe the refusal, which OnboardingPanel.unpublished.test.tsx
  // already pins. The flip removes this mock and repins block 10's premise to
  // the real digest, as `feat/pack-flip-021` did for 0.2.1.
  const real = await orig<typeof import('../cribl/pack')>()
  return {
    ...real,
    PACK_PUBLISHED: true, PACK_SHA256: 'ab'.repeat(32),
    PACK_PUBLISHED_VERSIONS: Object.freeze([...real.PACK_PUBLISHED_VERSIONS, real.PACK_VERSION]),
  }
})

const GROUPS = ['default', 'lab']
const HASH = 'dddd000011112222dddd000011112222dddd0000'
const DATASETS = '/products/lake/lakes/default/datasets'
const SAVED = '/m/default_search/search/saved'

interface Call { method: string; path: string; body: unknown }
let calls: Call[] = []
/** The fake Leader's uncommitted files — a test may add to them. */
let heldManifest: string[] = []
let fake: { packs: Record<string, Array<Record<string, unknown>>>; inputs: Record<string, Record<string, Record<string, unknown>>>; failHttp: boolean; globalHttp: boolean }

const shippedHttp = () => ({
  id: PACK_HTTP_INPUT_ID, type: 'http_raw', disabled: true, host: '0.0.0.0', port: 20005,
  tls: { disabled: false, minVersion: 'TLSv1.2', certPath: '$CRIBL_CLOUD_CRT', privKeyPath: '$CRIBL_CLOUD_KEY' },
  sendToRoutes: true, breakerRulesets: ['gigamon_ami_http_json_array'], autoParse: false, streamtags: ['gigamon', 'ami'],
})
const shippedSample = () => ({ id: PACK_SAMPLE_INPUT_ID, type: 'datagen', disabled: true, sendToRoutes: true, samples: [] })

function reply(status: number, value?: unknown) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown }
}

/** A Cribl.Cloud Leader with two groups, real data in gigamon_ami, and — when
 *  asked — this app's current pack already installed in `default`. */
const OLD_TOKEN = 'e'.repeat(64)
/** A Raw HTTP source that onboarding has configured: a token, a port, running. */
const configuredHttp = () => ({ ...shippedHttp(), disabled: false, port: 20007, authTokensExt: [{ token: OLD_TOKEN, authType: 'manual' }] })

function leader(o: {
  installed?: boolean; failHttp?: boolean; globalHttp?: boolean; failCommitOnce?: boolean
  /** The installed copy is the published 0.1.0, from its release. */
  v010?: boolean
  /** The installed copy's Raw HTTP source is configured and running. */
  configured?: boolean
  /** The sample source is running. */
  sampleOn?: boolean
  /** gigamon_ami_sample exists. */
  sampleDataset?: boolean
} = {}) {
  let failCommit = o.failCommitOnce ?? false
  calls = []
  const pending: string[] = []
  heldManifest = pending
  const saved = new Map<string, unknown>()
  const datasets = new Map<string, Record<string, unknown>>([[PACK_LAKE_DATASET_ID, {
    id: PACK_LAKE_DATASET_ID, format: 'json', retentionPeriodInDays: 30, metrics: { currentSizeBytes: 5e6, metricsDate: '2026-09-24' },
  }]])
  if (o.sampleDataset) datasets.set(PACK_SAMPLE_DATASET_ID, { id: PACK_SAMPLE_DATASET_ID, format: 'json', retentionPeriodInDays: 30 })
  const installedInputs = () => ({
    [PACK_HTTP_INPUT_ID]: o.configured ? configuredHttp() : shippedHttp(),
    [PACK_SAMPLE_INPUT_ID]: { ...shippedSample(), disabled: !o.sampleOn },
  })
  fake = {
    packs: {
      default: o.v010 ? [{ id: PACK_ID, version: '0.1.0', source: packReleaseUrl('0.1.0') }]
        : o.installed ? [{ id: PACK_ID, version: PACK_VERSION, source: PACK_URL }] : [],
      lab: [],
    },
    inputs: {
      default: o.v010 ? { in_gno_syslog: { id: 'in_gno_syslog', type: 'syslog', port: 20003 } } : o.installed ? installedInputs() : {},
      lab: {},
    },
    failHttp: o.failHttp ?? false,
    globalHttp: o.globalHttp ?? false,
  }
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    // `/capi` in dev preview; the absolute API base once installed.
    const path = String(url).replace(/^\/capi/, '').replace(/^https:\/\/main-acme\.cribl\.cloud\/api\/v1/, '').split('?')[0]
    const raw = init.body == null ? undefined : String(init.body)
    let body: unknown = raw
    try { body = raw === undefined ? undefined : JSON.parse(raw) } catch { /* text */ }
    calls.push({ method, path, body })
    const at = (m: string, p: string) => method === m && path === p

    if (path.startsWith('/kvstore')) return method === 'GET' ? reply(404, '') : reply(200, '')
    if (at('GET', '/master/groups')) return reply(200, { items: GROUPS.map((id) => ({ id, name: id, isFleet: false })) })
    if (at('GET', '/products/stream/groups')) return reply(200, { items: GROUPS.map((id) => ({ id, name: id, onPrem: false, configVersion: 'aaaa1111' })) })
    if (at('GET', '/version')) return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }] })
    if (at('GET', '/version/files')) return reply(200, { items: [] })
    if (at('GET', '/version/status')) return reply(200, { items: [{ files: pending.map((p) => ({ path: p })) }] })
    if (at('POST', '/version/commit')) {
      if (failCommit) { failCommit = false; return reply(500, { message: 'commit refused' }) }
      const files = (body as { files: string[] }).files
      pending.splice(0, pending.length, ...pending.filter((f) => !files.includes(f)))
      return reply(200, { items: [{ commit: HASH }] })
    }
    if (at('GET', DATASETS)) return reply(200, { items: [...datasets.values()] })
    if (at('POST', DATASETS)) {
      datasets.set(String((body as { id: string }).id), body as Record<string, unknown>)
      return reply(200, { items: [body] })
    }
    if (at('GET', SAVED)) return reply(200, { items: [...saved.values()], count: saved.size, totalCount: saved.size })
    if (at('POST', SAVED)) { saved.set(String((body as { id: string }).id), body); return reply(200, { items: [body] }) }
    if (method === 'GET' && path.startsWith(`${SAVED}/`)) return reply(404, { message: 'not found' })

    for (const g of GROUPS) {
      const P = `/m/${g}/p/${PACK_ID}`
      if (at('GET', `/products/stream/groups/${g}`)) return reply(200, { items: [{ id: g, configVersion: 'aaaa1111' }] })
      if (at('PATCH', `/products/stream/groups/${g}/deploy`)) return reply(200, { items: [] })
      if (at('GET', `/m/${g}/system/inputs`)) {
        return reply(200, { items: fake.globalHttp && g === 'default' ? [{ id: 'in_gigamon_http', type: 'http_raw', port: 20001 }] : [] })
      }
      if (at('GET', `/m/${g}/packs`)) return reply(200, { items: fake.packs[g] })
      if (at('POST', `/m/${g}/packs`)) {
        fake.packs[g] = [{ id: PACK_ID, version: PACK_VERSION, source: (body as { source: string }).source }]
        fake.inputs[g] = { [PACK_HTTP_INPUT_ID]: shippedHttp(), [PACK_SAMPLE_INPUT_ID]: shippedSample() }
        pending.push(`groups/${g}/default/${PACK_ID}/package.json`)
        return reply(200, { items: [{ id: PACK_ID }] })
      }
      if (at('PATCH', `/m/${g}/packs/${PACK_ID}`)) {
        fake.packs[g] = [{ id: PACK_ID, version: PACK_VERSION, source: (body as { source: string }).source }]
        fake.inputs[g] = { [PACK_HTTP_INPUT_ID]: shippedHttp(), [PACK_SAMPLE_INPUT_ID]: shippedSample() }
        pending.push(`groups/${g}/default/${PACK_ID}/package.json`)
        return reply(200, { items: [{ id: PACK_ID }] })
      }
      if (at('DELETE', `/m/${g}/packs/${PACK_ID}`)) {
        fake.packs[g] = []
        fake.inputs[g] = {}
        pending.push(`groups/${g}/default/${PACK_ID}/package.json`)
        return reply(200, { items: [] })
      }
      if (at('GET', `${P}/system/inputs`)) return reply(200, { items: Object.values(fake.inputs[g]) })
      for (const id of [PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID]) {
        if (at('GET', `${P}/system/inputs/${id}`)) {
          const it = fake.inputs[g][id]
          return it ? reply(200, { items: [it] }) : reply(404, {})
        }
        if (at('PATCH', `${P}/system/inputs/${id}`)) {
          if (fake.failHttp && id === PACK_HTTP_INPUT_ID) return reply(500, { message: 'refused' })
          fake.inputs[g][id] = body as Record<string, unknown>
          pending.push(`groups/${g}/local/${PACK_ID}/inputs.yml`)
          return reply(200, { items: [body] })
        }
      }
      if (method === 'GET' && path.startsWith(`${P}/`)) return fake.packs[g].length ? reply(200, { items: [] }) : reply(404, {})
      // Guided Setup's global stack: absent unless asked for.
      if (method === 'GET' && path.startsWith(`/m/${g}/`)) {
        if (fake.globalHttp && g === 'default' && path.endsWith('/in_gigamon_http')) return reply(200, { items: [{ id: 'in_gigamon_http' }] })
        return reply(404, { message: 'not found' })
      }
    }
    return reply(599, { message: `no route for ${method} ${path}` })
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
  resetSetupRunLock()
  settleDatasetTarget(false, 'has-data')
  toasts.length = 0
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  vi.useRealTimers()
  delete window.__CRIBL_SEARCH_ORIGIN
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDenials()
  resetSetupRunLock()
})

async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function mount(el = <OnboardingPanel />) {
  await act(async () => { root.render(<DashboardProvider>{el}</DashboardProvider>) })
  await settle(12)
}
const buttonNamed = (label: string) => [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label)
const press = async (el: Element | undefined, turns = 12) => {
  expect(el, 'no such button on the page').toBeTruthy()
  await act(async () => { (el as HTMLButtonElement).click() })
  await settle(turns)
}
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')
const dialogText = () => (dialog()?.textContent ?? '').replace(/\s+/g, ' ')
const bodyText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
const shownToken = () => document.body.querySelector('[aria-label="Auth token"]')?.textContent ?? null
const writes = () => calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))
const kvWrites = () => calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/kvstore') && c.path !== '/kvstore/keys')
const sentToken = () => {
  const patch = calls.find((c) => c.method === 'PATCH' && c.path.endsWith(`/system/inputs/${PACK_HTTP_INPUT_ID}`))
  return ((patch?.body as { authTokensExt?: Array<{ token: string }> })?.authTokensExt ?? [])[0]?.token ?? null
}
async function pick(group: string) {
  await act(async () => {
    const sel = document.body.querySelector<HTMLSelectElement>('#gs-onb-group-select')!
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(sel, group)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle(12)
}
async function typeInDialog(text: string) {
  await act(async () => {
    const el = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}
async function escape() {
  await act(async () => {
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await settle()
}
async function onboardThroughTheDialog() {
  await press(buttonNamed('Onboard'))
  expect(dialog(), 'the Onboard confirmation did not open').not.toBeNull()
  await press(buttonNamed('Yes, onboard in default'), 40)
}
async function removeThroughTheDialog() {
  await press(buttonNamed('Remove pack'))
  await typeInDialog('default')
  await press(buttonNamed('Yes, remove from default'), 30)
}

// ── 10 ──────────────────────────────────────────────────────────────────────

describe('10. this build once its pin is released: 0.2.2, recorded by the mock above', () => {
  it('pins the premise: the pinned release is installable (its digest mocked until the flip records the real one)', () => {
    expect(thisPackRelease()).toMatchObject({
      version: '0.2.2', published: true, installable: true, refusal: null, url: PACK_URL,
      sha256: 'ab'.repeat(32),
    })
  })

  it('Onboard is offered, not aria-disabled; it opens a real dialog naming the pack, and nothing is written until Yes', async () => {
    leader()
    await mount()
    const onboard = buttonNamed('Onboard')!
    expect(onboard.getAttribute('aria-disabled')).not.toBe('true')
    expect(bodyText()).not.toContain('Onboard is not available')
    await press(onboard)
    expect(dialog(), 'the Onboard confirmation did not open').not.toBeNull()
    expect(dialogText()).toContain(PACK_ID)
    expect(dialogText()).toContain(PACK_VERSION)
    expect(buttonNamed('Yes, onboard in default')).toBeTruthy()
    await press(buttonNamed('Cancel'))
    expect(dialog()).toBeNull()
    expect(writes(), 'a write to Cribl before Yes').toEqual([])
    expect(calls.some((c) => c.method === 'POST' && c.path === '/m/default/packs')).toBe(false)
  })

  it('the pack panel holds the page’s one picker, and the Raw HTTP panel holds none', async () => {
    leader({ globalHttp: true })
    await mount(<><OnboardingPanel /><ProvisionPanel /></>)
    expect(document.body.querySelector('#gs-onb-group-select')).not.toBeNull()
    expect(document.body.querySelector('#gs-group-select')).toBeNull()
    expect(buttonNamed('Deploy onboarding stack')).toBeUndefined()
    expect(writes()).toEqual([])
  })

  it('installed in Cribl, with no pack in the group: the pack panel shows, to onboard', async () => {
    ;(window as { CRIBL_API_URL?: string }).CRIBL_API_URL = 'https://main-acme.cribl.cloud/api/v1'
    // A built bundle: Vite's DEV is false there (vitest's is true).
    vi.stubEnv('DEV', false)
    vi.resetModules()
    try {
      const { OnboardingPanel: Installed } = await import('./OnboardingPanel')
      const { DashboardProvider: Provider } = await import('../app/DashboardContext')
      leader()
      await act(async () => { root.render(<Provider><Installed /></Provider>) })
      await settle(12)
      expect(bodyText()).toContain('Onboard Gigamon AMI with the pack')
      const onboard = buttonNamed('Onboard')!
      const why = document.getElementById(onboard.getAttribute('aria-describedby') ?? '')?.textContent
      expect(onboard.getAttribute('aria-disabled'), why ?? '').not.toBe('true')
      expect(writes()).toEqual([])
    } finally {
      delete (window as { CRIBL_API_URL?: string }).CRIBL_API_URL
      vi.unstubAllEnvs()
    }
  })
})

// ── 3 ───────────────────────────────────────────────────────────────────────

describe('3. nothing writes on load, a group change, Re-check, a dialog opened and dismissed, or with time', () => {
  it('mount, group change and back, Re-check, Onboard opened and cancelled, then escaped; Remove opened and cancelled', async () => {
    leader({ installed: true })
    await mount()
    await pick('lab')
    await pick('default')
    await press(buttonNamed('Re-check'))
    await press(buttonNamed('Finish onboarding'))
    expect(dialog()).not.toBeNull()
    await press(buttonNamed('Cancel'))
    expect(dialog()).toBeNull()
    await press(buttonNamed('Finish onboarding'))
    await escape()
    expect(dialog()).toBeNull()
    await press(buttonNamed('Remove pack'))
    expect(dialog()).not.toBeNull()
    await press(buttonNamed('Cancel'))
    expect(writes(), 'a write to Cribl').toEqual([])
    // The one store write is the picker remembering the viewer's own group,
    // from its change event — never on mount, and never to Cribl config.
    expect(kvWrites().every((c) => c.method === 'PUT' && c.path.startsWith('/kvstore/guided_setup_memory/prefs/'))).toBe(true)
  })

  it('thirty minutes of timers after mount: no request that writes', async () => {
    leader({ installed: true })
    await mount()
    const before = calls.length
    vi.useFakeTimers()
    await act(async () => { vi.advanceTimersByTime(30 * 60_000) })
    vi.useRealTimers()
    await settle()
    expect(calls.slice(before).filter((c) => c.method !== 'GET')).toEqual([])
  })
})

// ── 4 ───────────────────────────────────────────────────────────────────────

describe('4. the token is shown once', () => {
  it('after the run that set it — and nowhere else: not a toast, not the store', async () => {
    leader()
    await mount()
    await onboardThroughTheDialog()
    const token = sentToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(shownToken()).toBe(token)
    expect(JSON.stringify(toasts)).not.toContain(token)
    for (const c of kvWrites()) expect(JSON.stringify(c.body)).not.toContain(token)
    // The step list is on screen too: the token appears exactly once in the page.
    expect(bodyText().split(token!).length - 1).toBe(1)
  })

  it('the dialog shows "a new token (not shown)", never a value', async () => {
    leader()
    await mount()
    await press(buttonNamed('Onboard'))
    expect(dialogText()).toContain('a new token (not shown)')
    expect(dialogText()).not.toMatch(/[0-9a-f]{64}/)
  })

  it('gone after a remount', async () => {
    leader()
    await mount()
    await onboardThroughTheDialog()
    expect(shownToken()).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
    expect(shownToken()).toBeNull()
  })

  it('gone after a group change there and back', async () => {
    leader()
    await mount()
    await onboardThroughTheDialog()
    expect(shownToken()).not.toBeNull()
    await pick('lab')
    await pick('default')
    expect(shownToken()).toBeNull()
  })

  it('gone after Remove', async () => {
    leader()
    await mount()
    await onboardThroughTheDialog()
    expect(shownToken()).not.toBeNull()
    await removeThroughTheDialog()
    expect(shownToken()).toBeNull()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/m/default/packs/${PACK_ID}`)).toBe(true)
  })

  it('not shown when the PATCH that would set it fails', async () => {
    leader({ failHttp: true })
    await mount()
    await onboardThroughTheDialog()
    expect(shownToken()).toBeNull()
    expect(bodyText()).toContain('failed')
    expect(writes().some((c) => c.path === '/version/commit')).toBe(false)
  })
})

// ── 8 ───────────────────────────────────────────────────────────────────────

describe('8. "Also send sample data"', () => {
  const box = () => document.body.querySelector<HTMLInputElement>('#gs-onb-sample')!

  it('is unticked by default, and unticked names no sample dataset and starts no sample source', async () => {
    leader()
    await mount()
    expect(bodyText()).toContain(SAMPLE_LABEL)
    expect(box().checked).toBe(false)
    await press(buttonNamed('Onboard'))
    expect(dialogText()).not.toContain(`Cribl Lake dataset ${PACK_SAMPLE_DATASET_ID}`)
    expect(dialogText()).not.toMatch(/Sample data: about/)
    await press(buttonNamed('Cancel'))
  })

  it('ticked, the dialog names the sample dataset and its volume', async () => {
    leader()
    await mount()
    await act(async () => { box().click() })
    await settle()
    expect(box().checked).toBe(true)
    await press(buttonNamed('Onboard'))
    expect(dialogText()).toContain(PACK_SAMPLE_DATASET_ID)
    expect(dialogText()).toMatch(/Sample data: about 432,000 events a day/)
  })
})

// ── 11 ──────────────────────────────────────────────────────────────────────

describe('11. Remove pack', () => {
  it('names the three datasets it keeps, lists no Lake dataset as deleted, and needs the group typed', async () => {
    leader({ installed: true })
    await mount()
    await press(buttonNamed('Remove pack'))
    const text = dialogText()
    expect(text).toContain(`Kept: the Cribl Lake datasets ${PACK_LAKE_DATASET_ID}, ${PACK_PARQUET_DATASET_ID}, ${PACK_SAMPLE_DATASET_ID}`)
    expect(text).toContain(`Delete ${PACK_SAMPLE_DATASET_ID} in Cribl Lake if you want the sample flows gone`)
    const yes = buttonNamed('Yes, remove from default')
    expect(yes?.getAttribute('aria-disabled')).toBe('true')
    await press(yes)
    expect(writes()).toEqual([])
    await typeInDialog('default')
    expect(buttonNamed('Yes, remove from default')?.getAttribute('aria-disabled')).toBeNull()
  })
})

// ── A Remove whose commit failed ────────────────────────────────────────────

describe('a Remove whose commit failed', () => {
  it('offers to finish it: the uncommitted removal is committed and deployed, from its own confirmation', async () => {
    leader({ installed: true, failCommitOnce: true })
    await mount()
    await removeThroughTheDialog()
    // The pack is gone from the group, so there is nothing left to Remove —
    // and the deletion is still in no commit the Workers run.
    expect(buttonNamed('Remove pack')).toBeUndefined()
    const finish = buttonNamed('Finish removing the pack')
    expect(finish, 'nothing on the page can commit the removal').toBeTruthy()
    const before = writes().length
    await press(finish)
    expect(dialogText()).toContain(`groups/default/default/${PACK_ID}/package.json`)
    expect(writes().length, 'opening the confirmation wrote something').toBe(before)
    await press(buttonNamed('Yes, commit and deploy default'), 30)
    expect(writes().slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /version/commit', 'PATCH /products/stream/groups/default/deploy',
    ])
    expect(buttonNamed('Finish removing the pack')).toBeUndefined()
  })
})

// ── The run lock, and the Raw HTTP panel stepping aside ─────────────────────

describe('one run at a time, and one onboarding path', () => {
  it('while another Guided Setup run holds the lock, Onboard does not open', async () => {
    leader()
    await mount()
    const release = acquireSetupRun('onboarding_stack')!
    await settle()
    expect(buttonNamed('Onboard')?.getAttribute('aria-disabled')).toBe('true')
    await press(buttonNamed('Onboard'))
    expect(dialog()).toBeNull()
    release()
  })

  it('with the pack available and no global stack, the Raw HTTP panel is absent', async () => {
    leader()
    await mount(<ProvisionPanel />)
    expect(container.textContent).toBe('')
  })

  it('with the global Raw HTTP stack in the group, it offers Remove and nothing else', async () => {
    leader({ globalHttp: true })
    await mount(<ProvisionPanel />)
    expect(bodyText()).toContain(REMOVE_ONLY_LEAD)
    expect(bodyText()).not.toContain('Deploy onboarding stack')
    expect(bodyText()).not.toContain('Re-apply onboarding stack')
    expect(buttonNamed('Remove partial stack') ?? buttonNamed('Remove onboarding stack')).toBeTruthy()
    // The page's one picker is the pack panel's now.
    expect(document.body.querySelector('#gs-group-select')).toBeNull()
  })
})

// ── 11: Upgrade ─────────────────────────────────────────────────────────────

describe('11. Upgrade', () => {
  it('is offered for this app’s older copy; opening its dialog and cancelling writes nothing', async () => {
    leader({ v010: true })
    await mount()
    const upgrade = buttonNamed(`Upgrade to ${PACK_VERSION}`)
    expect(upgrade?.getAttribute('aria-disabled')).toBeNull()
    await press(upgrade)
    const text = dialogText()
    expect(text).toContain(`Upgrade the Gigamon AMI pack in default to ${PACK_VERSION}`)
    expect(text).toContain('in_gno_syslog')
    expect(text).toContain(PACK_HTTP_INPUT_ID)
    expect(text).toContain('have not been verified to survive an upgrade')
    await press(buttonNamed('Cancel'))
    expect(dialog()).toBeNull()
    expect(writes()).toEqual([])
  })

  it('confirmed: upgrades, reads the source back, then commits and deploys the pack’s files', async () => {
    leader({ v010: true })
    await mount()
    await press(buttonNamed(`Upgrade to ${PACK_VERSION}`))
    await press(buttonNamed('Yes, upgrade in default'), 40)
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH /m/default/packs/${PACK_ID}`, 'POST /version/commit', 'PATCH /products/stream/groups/default/deploy',
    ])
    expect(toasts.at(-1)?.kind).toBe('done')
  })

  it('the lock taken by another panel while its dialog is open: Yes writes nothing', async () => {
    leader({ v010: true })
    await mount()
    await press(buttonNamed(`Upgrade to ${PACK_VERSION}`))
    expect(dialog()).not.toBeNull()
    // Taken and pressed in one turn, before a render could mark the button.
    let release: (() => void) | null = null
    await act(async () => {
      release = acquireSetupRun('lake_landing')
      buttonNamed('Yes, upgrade in default')!.click()
    })
    await settle(30)
    expect(writes()).toEqual([])
    expect(bodyText()).toContain('Nothing was written: Another run is already in progress.')
    ;(release as (() => void) | null)?.()
  })

  it('held because it reset the source: none of the source controls opens a dialog that would deploy it', async () => {
    leader({ installed: true, configured: true, sampleOn: true })
    await mount()
    // The upgrade this app held: the pack's manifest uncommitted in the group.
    heldManifest.push(`groups/default/default/${PACK_ID}/package.json`)
    for (const label of ['Rotate token', 'Stop sample data']) {
      await press(buttonNamed(label))
      expect(dialog(), label).toBeNull()
    }
    expect(bodyText()).toContain('package.json in default is uncommitted')
    expect(writes()).toEqual([])
  })

  it('is not offered for the current copy', async () => {
    leader({ installed: true })
    await mount()
    expect(buttonNamed(`Upgrade to ${PACK_VERSION}`)).toBeUndefined()
  })
})

// ── The pack sources' own settings ──────────────────────────────────────────

describe('the pack sources’ own settings', () => {
  it('opening and cancelling each of their dialogs writes nothing', async () => {
    leader({ installed: true, configured: true, sampleDataset: true })
    await mount()
    for (const label of ['Rotate token', 'Move port', 'Start sample data']) {
      await press(buttonNamed(label))
      expect(dialog(), `${label} opened no dialog`).not.toBeNull()
      await press(buttonNamed('Cancel'))
    }
    expect(writes()).toEqual([])
  })

  it('Rotate token: names the source and the exporter, then shows the new token once — and not in a toast or the store', async () => {
    leader({ installed: true, configured: true })
    await mount()
    await press(buttonNamed('Rotate token'))
    expect(dialogText()).toContain(`Rotate the auth token of ${PACK_HTTP_INPUT_ID} in default`)
    expect(dialogText()).toContain('Gigamon AMX has to be given the new token')
    expect(dialogText()).not.toMatch(/[0-9a-f]{64}/)
    await press(buttonNamed('Yes, rotate the token'), 40)
    const token = sentToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(token).not.toBe(OLD_TOKEN)
    expect(shownToken()).toBe(token)
    expect(bodyText().split(token!).length - 1).toBe(1)
    expect(JSON.stringify(toasts)).not.toContain(token)
    for (const c of kvWrites()) expect(JSON.stringify(c.body)).not.toContain(token)
    const patch = writes().find((c) => c.method === 'PATCH' && c.path.endsWith(`/system/inputs/${PACK_HTTP_INPUT_ID}`))!
    // The whole source went back, with only the token moved.
    expect(patch.body).toEqual({ ...configuredHttp(), authTokensExt: [{ token, authType: 'manual' }] })
    expect(writes().map((c) => c.path).slice(-2)).toEqual(['/version/commit', '/products/stream/groups/default/deploy'])
    // Gone after a group change there and back.
    await pick('lab')
    await pick('default')
    expect(shownToken()).toBeNull()
  })

  it('Move port: the dialog names the new port, and the PATCH carries it', async () => {
    leader({ installed: true, configured: true })
    await mount()
    await act(async () => {
      const el = document.body.querySelector<HTMLInputElement>('#gs-onb-move-port')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, '20009')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    await press(buttonNamed('Move port'))
    expect(dialogText()).toContain(`Move ${PACK_HTTP_INPUT_ID} in default to port 20009`)
    await press(buttonNamed('Yes, move to port 20009'), 40)
    const patch = writes().find((c) => c.method === 'PATCH' && c.path.endsWith(`/system/inputs/${PACK_HTTP_INPUT_ID}`))
    expect((patch!.body as { port: number }).port).toBe(20009)
  })

  it('Start sample data is refused, with its reason on screen, until gigamon_ami_sample exists', async () => {
    leader({ installed: true, configured: true, sampleDataset: false })
    await mount()
    const start = buttonNamed('Start sample data')
    expect(start?.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(start?.getAttribute('aria-describedby') ?? '')?.textContent).toBe(SAMPLE_START_REFUSAL)
    await press(start)
    expect(dialog()).toBeNull()
    expect(writes()).toEqual([])
  })

  it('Stop sample data is offered whether or not the dataset exists, and stops it', async () => {
    leader({ installed: true, configured: true, sampleOn: true, sampleDataset: false })
    await mount()
    const stop = buttonNamed('Stop sample data')
    expect(stop?.getAttribute('aria-disabled')).toBeNull()
    await press(stop)
    await press(buttonNamed('Yes, stop the sample data'), 40)
    const patch = writes().find((c) => c.method === 'PATCH' && c.path.endsWith(`/system/inputs/${PACK_SAMPLE_INPUT_ID}`))
    expect((patch!.body as { disabled: boolean }).disabled).toBe(true)
  })

  it('a rotation whose commit failed: the token is shown once, and said not to be deployed', async () => {
    leader({ installed: true, configured: true, failCommitOnce: true })
    await mount()
    await press(buttonNamed('Rotate token'))
    await press(buttonNamed('Yes, rotate the token'), 40)
    const token = sentToken()
    expect(shownToken()).toBe(token)
    expect(bodyText()).toContain(TOKEN_UNDEPLOYED)
    expect(writes().map((c) => c.path).at(-1)).toBe('/version/commit')
  })

  it('a rotation that deployed carries no such warning', async () => {
    leader({ installed: true, configured: true })
    await mount()
    await press(buttonNamed('Rotate token'))
    await press(buttonNamed('Yes, rotate the token'), 40)
    expect(shownToken()).toBe(sentToken())
    expect(bodyText()).not.toContain(TOKEN_UNDEPLOYED)
  })

  it('the lock taken by another panel while a dialog is open: its Yes writes nothing', async () => {
    for (const [label, yes] of [['Stop sample data', 'Yes, stop the sample data'], ['Rotate token', 'Yes, rotate the token']] as const) {
      leader({ installed: true, configured: true, sampleOn: true })
      await mount()
      await press(buttonNamed(label))
      expect(dialog(), label).not.toBeNull()
      // Taken and pressed in one turn, before a render could mark the button.
      let release: (() => void) | null = null
      await act(async () => {
        release = acquireSetupRun('lake_landing')
        buttonNamed(yes)!.click()
      })
      await settle(30)
      expect(writes(), label).toEqual([])
      expect(bodyText()).toContain('Nothing was written: Another run is already in progress.')
      ;(release as (() => void) | null)?.()
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('while another Guided Setup run holds the lock, none of them opens', async () => {
    leader({ installed: true, configured: true, sampleDataset: true })
    await mount()
    const release = acquireSetupRun('lake_landing')!
    await settle()
    for (const label of ['Rotate token', 'Move port', 'Start sample data']) {
      expect(buttonNamed(label)?.getAttribute('aria-disabled'), label).toBe('true')
      await press(buttonNamed(label))
      expect(dialog()).toBeNull()
    }
    release()
    expect(writes()).toEqual([])
  })
})

// What this file could not assert: focus order and focus return (happy-dom has
// no sequential focus navigation — ConfirmDialog.test.tsx asserts the
// mechanism), that the endpoint card's URL is reachable from a real exporter,
// and anything about layout at phone width. The token is asserted absent from
// toasts through a mock of `pushToast`, not from Capra's rendered toasts.
