// What the Lake landing panel promises, measured on the rendered DOM and on the
// pure functions behind it.
//
// THE ASSERTIONS THAT MATTER MOST ARE ABOUT WHAT HAS *NOT* HAPPENED.
//
//   * A WRITE NOBODY CONFIRMED. Every control here PATCHes a live Cribl object —
//     a Lake dataset that is in no version control at all, or the one
//     destination both feeds write through, followed by a commit and a deploy
//     that restarts Worker Processes. So the tests press the outer Apply and
//     assert that NOTHING left the app until a button inside the dialog was
//     pressed. A control that writes before its confirmation is the failure this
//     file exists to catch, and it is invisible in a screenshot.
//   * A DECREASE CONFIRMED AS EASILY AS AN INCREASE. A retention decrease is the
//     one irreversible edit in the phase. `<ConfirmDialog>` does not enforce that
//     `irreversible` and `typeToConfirm` arrive together — its own test file says
//     so — so the asymmetry is this panel's to keep, and it is asserted both
//     ways: the decrease demands the dataset id and says why it cannot be undone,
//     the increase does neither and carries `undo` instead.
//   * A SPEND ON LOAD. No Cribl Search job may be submitted by mounting this
//     panel, by re-reading it, or by leaving it alone. Measurement is a button.
//   * A PANEL-LEVEL STATE MACHINE WEARING NINE FIELDS. One endpoint is refused
//     and the other eight rows must still render their values. On a healthy
//     workspace a per-panel implementation is indistinguishable from a per-row
//     one, which is why this is a test and not an eyeball.
//
// WHAT THIS ENVIRONMENT CANNOT BE ASKED, stated rather than faked — the same
// list ConfirmDialog.test.tsx, JobWatchdog.test.tsx and AccelPanel.test.tsx keep,
// for the same reasons. Read it before reporting a green run as a result:
//
//   * FOCUS ORDER, FOCUS CONTAINMENT AND FOCUS RESTORATION. happy-dom implements
//     no sequential focus navigation and enforces nothing for `inert`, so a test
//     that pressed Tab would pass against an empty document. Preview checks 7.1
//     and 7.3 are the only things that can report those.
//   * LAYOUT, HIT AREAS AND THE 200 % / ~400 px BEHAVIOUR. No layout is computed
//     here. Whether the table scrolls inside `.ac-tablewrap` rather than
//     scrolling the page is Preview 7.7, and nothing below touches it.
//   * WHETHER THE MUTED STALE TREATMENT IS LEGIBLE. The test asserts the class
//     the stale value takes; what that class resolves to is `contrast.test.ts`'s,
//     and whether it reads as "older" rather than as "disabled" is Preview 7.6.
//   * WHETHER CRIBL ACCEPTS ANY OF THESE BODIES. The stub takes whatever it is
//     handed and every status in it is fabricated — including every 403, so the
//     refusals asserted here are this file's inventions, not a permission being
//     enforced (V-S11). The first real Apply is a human's click in Preview.
//   * WHAT A MEASUREMENT ACTUALLY RETURNS. `lag_s` is stubbed. Whether Cribl
//     Search answers seconds, and therefore whether `formatLag` prints a sane
//     number, is Preview check 2.2 and nothing here.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDenials } from '../cribl/authz'
import { DashboardProvider } from '../app/DashboardContext'
import { DEPLOY_CONSEQUENCES, FLUSH_PRESETS, LANDING_TERMS, retentionChange } from '../cribl/landing'
import { LANDING_PROFILE_KEY } from '../cribl/lakeLanding'
import { LakeLandingPanel } from './LakeLandingPanel'
import { settleDatasetTarget } from '../cribl/datasetTarget'
import { SETUP_RUN_BUSY, acquireSetupRun, resetSetupRunLock, setupRunHolder } from '../cribl/setupRunLock'
// The words and the units, separately from the screen that renders them. Half
// the assertions in this file never mount anything — see lakeLandingCopy.ts.
import {
  INGEST_ANCHOR_ID,
  LAG_CPU_SECONDS,
  LAKE_LEAD,
  LAKE_LEAD_TIP,
  LAKE_RETENTION_WARNING,
  ROW_TIPS,
  PARTITION_CPU_SECONDS,
  PARTITION_GATE,
  READER_GATE,
  STALE_AFTER_MS,
  costLabel,
  destinationConsequences,
  destinationResources,
  flushOf,
  flushWords,
  formatLag,
  printValue,
  relativeAge,
  sizeSentence,
} from './lakeLandingCopy'
import { GuidedSetup } from '../tabs/GuidedSetup'
import { PACK_SETUP_FACTS, SETUP_FACTS } from './provisionPanelCopy'

const BASE = '/capi'
const LAKE = '/products/lake/lakes/default'
const DATASET = `${LAKE}/datasets/gigamon_ami`
const SEARCH_DATASET = '/m/default_search/search/datasets/gigamon_ami'
const DESTINATION = '/m/default/system/outputs/gigamon_lake'
const INPUTS = '/m/default/system/inputs'
const ROUTES = '/m/default/routes'
const LOCAL_SEARCH = '/m/default_search/search/local_search'
const GROUPS = '/products/stream/groups'
const JOBS = '/m/default_search/search/jobs'
const NOW = 1_789_600_000_000

// ── The fake workspace ──────────────────────────────────────────────────────

interface Call {
  method: string
  path: string
  query: string
  body: Record<string, unknown> | undefined
}

interface WorkspaceOpts {
  /**
   * Paths `/version/status` reports as uncommitted, for the whole run.
   *
   * A list with no `outputs.yml` in it stages the half-apply: the PATCH lands,
   * the commit list comes back empty, and the run used to report ok with the
   * Workers left on the old configuration and the recovery button hidden.
   */
  pending?: string[]
  /** `${METHOD} ${path}` (no query string) → answer this status instead. */
  status?: Record<string, number>
  /** Leave the dataset out of the lake entirely (create mode). */
  noDataset?: boolean
  /** Fields to override on the dataset body. */
  dataset?: Record<string, unknown>
  /** Fields to override on the destination body. */
  destination?: Record<string, unknown>
  /** Rows the next search job returns. */
  searchRows?: Record<string, unknown>[]
  /** Seed the app's own store. */
  kv?: Record<string, unknown>
}

function response(status: number, body: unknown) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}

const DENIED = { message: 'Not authorized or licensed to perform this action.' }

/** The destination as a healthy workspace answers it: the flush settings the app
 *  provisions today (5 / 60 / 15, `nearLive`) plus fields this app has never
 *  heard of, which is the case `applyDestinationEdit` exists to preserve. */
const LIVE_DESTINATION = {
  id: 'gigamon_lake',
  type: 'cribl_lake',
  destPath: 'gigamon_ami',
  format: 'json',
  storageLocationId: 'cribl_lake',
  compress: 'gzip',
  maxFileSizeMB: 5,
  maxFileOpenTimeSec: 60,
  maxFileIdleTimeSec: 15,
  onBackpressure: 'block',
  notifications: ['someone_elses_notification'],
  environment: 'prod',
  status: { health: 'green' },
}

const LIVE_DATASET = {
  id: 'gigamon_ami',
  description: 'Gigamon Application Metadata Intelligence (AMI) flow records',
  format: 'json',
  retentionPeriodInDays: 30,
  searchConfig: { searchVersion: 'v1' },
  metrics: { currentSizeBytes: 119_185_342_464, metricsDate: '2026-09-16' },
}

function stubWorkspace(opts: WorkspaceOpts = {}) {
  const kv = new Map<string, string>(
    Object.entries(opts.kv ?? {}).map(([k, v]) => [k, JSON.stringify(v)]),
  )
  const calls: Call[] = []
  const dataset = { ...LIVE_DATASET, ...opts.dataset }
  const destination = { ...LIVE_DESTINATION, ...opts.destination }

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const rest = String(url).slice(BASE.length)
    const [path, query = ''] = rest.split('?')
    const body = init.body == null ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ method, path, query, body })

    const override = opts.status?.[`${method} ${path}`]
    if (override !== undefined) return response(override, override >= 400 ? DENIED : {})

    // This app's own store.
    if (path.startsWith('/kvstore')) {
      if (path === '/kvstore/keys') return response(200, [...kv.keys()])
      const key = path.slice('/kvstore/'.length).split('/').map(decodeURIComponent).join('/')
      if (method === 'PUT') {
        kv.set(key, String(init.body ?? ''))
        return response(200, '')
      }
      if (method === 'DELETE') return response(kv.delete(key) ? 200 : 404, '')
      const held = kv.get(key)
      return held === undefined ? response(404, '') : response(200, held)
    }

    // Cribl Search.
    if (path === JOBS && method === 'POST') return response(200, { items: [{ id: 'job-1' }] })
    // SCOPED TO THE JOBS PATH, and it was not. A bare `endsWith('/status')` also
    // swallowed `GET /version/status`, so every Git status read in this file
    // came back as a finished search job with no `files` — which made
    // `pendingConfigFiles()` answer [] and `destinationCommitFiles` take its
    // constructed-path branch, in every test. The commit-scope tests below are
    // about exactly that read, so the stub had to stop answering for it.
    if (path.startsWith(JOBS) && path.endsWith('/status')) return response(200, { items: [{ status: 'completed' }] })
    if (path.endsWith('/results')) {
      const rows = opts.searchRows ?? []
      return response(200, [JSON.stringify({ job: 'job-1', totalEventCount: rows.length }), ...rows.map((r) => JSON.stringify(r))].join('\n'))
    }
    if (path.endsWith('/cancel')) return response(200, {})

    // Cribl Lake.
    if (path === `${LAKE}/config`) {
      return response(200, { items: [{ id: 'maxAcceleratedFieldsCount', value: 3 }] })
    }
    if (path === `${LAKE}/datasets`) {
      return response(200, { items: opts.noDataset ? [{ id: 'default_logs' }] : [{ id: 'default_logs' }, dataset] })
    }
    if (path === DATASET) {
      if (method === 'PATCH') {
        Object.assign(dataset, body)
        return response(200, { items: [dataset] })
      }
      return opts.noDataset ? response(404, { message: 'not found' }) : response(200, { items: [dataset] })
    }

    // Cribl Search's own view of the dataset.
    if (path === SEARCH_DATASET) {
      return response(200, { items: [{ id: 'gigamon_ami', searchVersion: 'v1', lakeStorageFormat: 'json' }] })
    }
    if (path === LOCAL_SEARCH) return response(404, { message: 'LocalSearch is not enabled' })

    // Cribl Stream.
    if (path === DESTINATION) {
      if (method === 'PATCH') {
        Object.assign(destination, body)
        return response(200, { items: [destination] })
      }
      return response(200, { items: [destination] })
    }
    if (path === INPUTS) {
      return response(200, {
        items: [{ id: 'in_gigamon_datagen', type: 'datagen', connections: [{ output: 'gigamon_lake' }] }],
      })
    }
    if (path === ROUTES) {
      return response(200, { items: [{ id: 'default', routes: [{ id: 'gigamon_ami_syslog', name: 'gigamon_ami_syslog', output: 'gigamon_lake' }] }] })
    }
    if (path === GROUPS) {
      return response(200, { items: [{ id: 'default', name: 'default', configVersion: 'abcdef1234567890' }] })
    }
    if (path === '/master/groups') return response(200, { items: [{ id: 'default', name: 'default' }] })
    if (path === '/version/status') {
      return response(200, { items: [{ files: (opts.pending ?? ['groups/default/local/cribl/outputs.yml']).map((f) => ({ path: f })) }] })
    }
    if (path === '/version/commit') return response(200, { items: [{ commit: 'cafebabe0123456789' }] })
    if (path === `${GROUPS}/default/deploy`) return response(200, { items: [{ configVersion: 'cafebabe01' }] })

    return response(404, { message: `the stub has no route for ${method} ${path}` })
  })

  return { calls, dataset, destination }
}

/** Every request that CHANGES something in the customer's Cribl. The app's own
 *  store is excluded on purpose, and so is `/kvstore/keys`, which is a POST that
 *  only reads (the store takes the prefix in a body rather than in the URL). */
const criblWrites = (calls: readonly Call[]) =>
  calls.filter((c) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.method) && !c.path.startsWith('/kvstore'))

/** Every Cribl Search job this panel submitted. */
const jobsSubmitted = (calls: readonly Call[]) => calls.filter((c) => c.method === 'POST' && c.path === JOBS)

// ── Mounting ────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

/**
 * Every `console.error` this file caused, as the text it would have printed.
 *
 * NOTHING HERE IS EXPECTED TO LOG AN ERROR, so any entry fails a test. This file
 * passed for a while with a stack overflow printed to stderr by nine of its
 * tests — React catches an error thrown from an event handler, reports it, and
 * carries on, so the assertions after the click still ran against a page that
 * had half-handled it. The calls still reach the real console, so the failure
 * comes with the message beside it.
 *
 * Installed once for the file, by assignment rather than `vi.spyOn`, so the
 * `vi.restoreAllMocks()` in each teardown does not take it away: an error a test
 * leaves behind (a promise that settles after unmount) is still recorded, and
 * fails the next test's setup, or the file's last hook when there is no next
 * test. A spy made per test lost those, and when a teardown threw before its
 * restore, the next test's spy wrapped the old one and called itself.
 */
const consoleErrors: string[] = []
const realConsoleError = console.error
const expectNoConsoleErrors = (when: string) =>
  expect(consoleErrors.splice(0), `an error was logged ${when}`).toEqual([])

beforeAll(() => {
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '))
    realConsoleError.apply(console, args)
  }
})

afterAll(async () => {
  // One turn of the event loop first, so an error the last test queued (a
  // settled promise, a zero-delay timer) lands while this is still listening.
  // One queued further out than that reaches the real console and fails nothing.
  await new Promise((r) => setTimeout(r, 0))
  console.error = realConsoleError
  expectNoConsoleErrors('after the last test in this file')
})

beforeEach(() => {
  expectNoConsoleErrors('after the previous test had finished')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('getCriblUser', async () => ({ id: 'auth0|me', username: 'me' }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetDenials()
  container = document.createElement('div')
  // Capra's Modal portals out of this element and marks it `inert`, so the
  // assertions about dialog contents look at document.body, not at this.
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  // In a finally, so a teardown that throws still leaves the next test its
  // globals, its timers and an unheld run lock.
  try {
    act(() => root.unmount())
  } finally {
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    resetDenials()
    resetSetupRunLock()
  }
  expectNoConsoleErrors('in this test')
})

/** Let the environment run: the group read, the profile read, nine independent
 *  reads and the audit list all settle on their own turns. */
async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** The panel's one <PanelInfo> reads the global range to build its "Open in
 *  Search" link, so it needs the provider even though nothing on this panel is
 *  bound to the range. */
const wrap = (node: React.ReactElement) => <DashboardProvider>{node}</DashboardProvider>

async function mount(node: React.ReactElement = <LakeLandingPanel />) {
  await act(async () => {
    root.render(wrap(node))
  })
  await settle()
}

const bodyText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

/**
 * The row headers, as the WORD each one is called.
 *
 * `textContent` on the cell would sweep up an <InfoTip>'s whole definition,
 * because the tip renders its text into the same header. The first text node is
 * the label itself.
 */
const rowLabels = () =>
  [...document.body.querySelectorAll('th[scope="row"]')].map((th) => (th.firstChild?.textContent ?? '').trim())

/** The row whose header is this word. */
const rowNamed = (label: string) =>
  [...document.body.querySelectorAll('tr')].find(
    (tr) => (tr.querySelector('th[scope="row"]')?.firstChild?.textContent ?? '').trim() === label,
  )

/** A control inside one named row — there are two Apply buttons on this panel,
 *  and which one a test pressed has to be unambiguous. */
const controlIn = (label: string, name: string) =>
  [...(rowNamed(label)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => (b.textContent ?? '').trim() === name || b.getAttribute('aria-label') === name,
  )

/** The explanation behind a row label's ⓘ — its accessible name, which is how a
 *  keyboard or screen-reader user reaches it — or null when the row has none. */
const tipOn = (label: string) =>
  rowNamed(label)?.querySelector('th[scope="row"] .infotip')?.getAttribute('aria-label') ?? null

/** What is on the page with every ⓘ closed: the body's text minus the tips'. */
const visibleText = () => {
  const copy = document.body.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.infotip-pop').forEach((p) => p.remove())
  return (copy.textContent ?? '').replace(/\s+/g, ' ')
}

/** Anything that reads as this project's own history rather than as help. */
const INTERNAL_HISTORY = /\b(P-S\d+|A-SP\d+|A-D\d+|I-D\d+|Phase \d)\b|\d+(\.\d+)?x faster|105 seconds|49 of 85/
/** The same, plus a bare date — for the tips, which are static text. The page as
 *  a whole legitimately prints the dataset's own metrics date. */
const TIP_HISTORY = new RegExp(`${INTERNAL_HISTORY.source}|\\d{4}-\\d\\d-\\d\\d`)

const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === name || b.getAttribute('aria-label') === name,
  )

const buttonStarting = (prefix: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (b.textContent ?? '').trim().startsWith(prefix),
  )

async function press(el: HTMLElement | undefined | null) {
  expect(el, 'this test expected a control that is not on screen').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle(3)
}

/**
 * Put a value into a controlled React input the way a browser does.
 *
 * React installs its own `value` setter on the element, so assigning
 * `el.value = x` and dispatching an event gives React a stale `defaultValue`.
 * The prototype setter is the documented way round it. The blur is for react-
 * aria's NumberField, which commits on blur rather than on every keystroke.
 */
async function typeInto(el: HTMLInputElement | null | undefined, value: string) {
  expect(el, 'this test expected an input that is not on screen').toBeTruthy()
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // Enter and `focusout`, not `blur`: react-aria's NumberField commits on
    // either, and React maps `onBlur` to the bubbling `focusout` rather than to
    // `blur`, which does not bubble and therefore never reaches the listener.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.dispatchEvent(new Event('focusout', { bubbles: true }))
  })
  await settle(2)
}

const inputLabelled = (label: string) =>
  [...document.body.querySelectorAll<HTMLInputElement>('input')].find((i) => {
    const id = i.getAttribute('id')
    const byFor = id ? document.querySelector(`label[for="${id}"]`) : null
    return (byFor?.textContent ?? '').trim() === label || i.getAttribute('aria-label') === label
  })

// ── The pure parts ──────────────────────────────────────────────────────────

describe('the words beside a measured value', () => {
  it('never renders a fresh install as a number', async () => {
    // I-D20, Preview 2.1. `0 s` and a bare `—` both read as "the feed is
    // perfectly current", which is the single most expensive wrong impression
    // this panel could give.
    stubWorkspace()
    await mount()
    expect(bodyText()).toContain('not measured')
    expect(bodyText()).not.toMatch(/Landing lag.{0,40}0 s/)
  })

  it('states an age coarsely, because one sample does not deserve a stopwatch', () => {
    expect(relativeAge(NOW - 5_000, NOW)).toBe('just now')
    expect(relativeAge(NOW - 60_000, NOW)).toBe('1 minute ago')
    expect(relativeAge(NOW - 15 * 60_000, NOW)).toBe('15 minutes ago')
    expect(relativeAge(NOW - 3 * 3600_000, NOW)).toBe('3 hours ago')
    expect(relativeAge(NOW - 5 * 24 * 3600_000, NOW)).toBe('5 days ago')
  })

  it('never reports a negative age from a clock that disagrees', () => {
    // The measurement's timestamp comes from this browser and the render from
    // the same one, but a stored profile can carry a timestamp from another
    // machine. "in -3 minutes" is worse than "just now".
    expect(relativeAge(NOW + 90_000, NOW)).toBe('just now')
  })

  it('formats a lag in the unit the query returns', () => {
    expect(formatLag(4.25)).toBe('4.3 s')
    expect(formatLag(42)).toBe('42 s')
    expect(formatLag(600)).toBe('10.0 min')
    expect(formatLag(7200)).toBe('2.0 h')
    expect(formatLag(Number.NaN)).toBe('not a number')
  })

  it('prices a measurement from its CPU-seconds rather than printing a figure', () => {
    // The plan writes the label out as "under 0.1 credits". It is computed, so
    // that a re-measured cost moves the label instead of leaving a stale string
    // beside a real number (I-D20, Preview 2.7).
    expect(costLabel(LAG_CPU_SECONDS)).toBe('under 0.1 credits')
    expect(costLabel(PARTITION_CPU_SECONDS)).toBe('under 0.1 credits')
    expect(costLabel(36_000)).toBe('about 10 credits')
  })
})

describe('the values a diff cell prints', () => {
  it('keeps absent and empty apart, because on a destination body they differ', () => {
    // `printValue` answers null for absent, and <DiffTable> renders that as the
    // words "not set"; an empty string renders as "empty". A single blank cell
    // would state neither.
    expect(printValue(undefined)).toBeNull()
    expect(printValue('')).toBe('')
    expect(printValue(null)).toBe('null')
  })

  it('never puts the text "undefined" in front of a customer', () => {
    expect(printValue(undefined)).not.toBe('undefined')
  })

  it('renders a nested value rather than [object Object]', () => {
    expect(printValue({ searchVersion: 'v2' })).toBe('{"searchVersion":"v2"}')
    expect(printValue(['cribl_pipe'])).toBe('["cribl_pipe"]')
    expect(printValue(5)).toBe('5')
    expect(printValue(false)).toBe('false')
  })

  it('survives a body it cannot serialise', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(printValue(cycle)).toBe('(this value cannot be displayed)')
  })
})

describe('reading a flush setting off a live destination', () => {
  it('refuses to guess when the body is short a field', () => {
    // A preset name invented from two of three numbers would offer to "keep" a
    // setting the panel had already misreported.
    expect(flushOf({ id: 'x', health: null, raw: { maxFileSizeMB: 5, maxFileOpenTimeSec: 60 } })).toBeNull()
    expect(flushOf(null)).toBeNull()
  })

  it('names the preset AND the numbers, so a hand-tuned destination cannot pass as ours', () => {
    expect(flushWords(FLUSH_PRESETS.nearLive)).toContain('Near-live')
    expect(flushWords(FLUSH_PRESETS.nearLive)).toContain('5 MB')
    expect(flushWords({ maxFileSizeMB: 7, maxFileOpenTimeSec: 61, maxFileIdleTimeSec: 14 })).toMatch(/^Custom —/)
  })
})

describe('what a destination confirmation owes the reader', () => {
  const ctx = {
    group: 'default',
    destinationId: 'gigamon_lake',
    diff: [],
    feeds: [
      { kind: 'quickconnect' as const, id: 'in_gigamon_datagen', label: 'QuickConnect from source in_gigamon_datagen' },
      { kind: 'route' as const, id: 'r1', label: 'route gigamon_ami_syslog' },
    ],
    feedsComplete: true,
    // The two lists are separate BECAUSE this fixture used to be one. It was
    // `pendingFiles: [outputs.yml, inputs.yml]` — the repo-wide Git status —
    // and the dialog told an admin the commit would carry `inputs.yml`. It
    // never does: `destinationCommitFiles` filters to this group's
    // `outputs.yml` alone. Naming a file the commit does not touch is the same
    // class of untruth as hiding one it does.
    commitFiles: ['groups/default/local/cribl/outputs.yml'],
    otherPending: ['groups/default/local/cribl/inputs.yml'],
  }

  it('says the Worker Processes restart, in the dialog and not in a toast afterwards', () => {
    // Preview 5.1. An admin who does not know will run it at 11 a.m. on a
    // Tuesday, and the only thing that decides whether they know is this list.
    const lines = destinationConsequences(ctx)
    expect(lines.some((l) => /restarts this worker group’s Worker Processes/i.test(l))).toBe(true)
    for (const owed of DEPLOY_CONSEQUENCES) expect(lines).toContain(owed)
  })

  it('names every feed, from the sources as well as the routes', () => {
    const lines = destinationConsequences(ctx)
    expect(lines[0]).toContain('QuickConnect from source in_gigamon_datagen')
    expect(lines[0]).toContain('route gigamon_ami_syslog')
  })

  it('says the feed list may be short when one of the two reads was refused', () => {
    // Under-reporting silently is how somebody approves a change to a delivery
    // path they were never shown.
    const lines = destinationConsequences({ ...ctx, feedsComplete: false })
    expect(lines[0]).toContain('may be short')
  })

  it('names the one file the commit carries, and says what else is in it', () => {
    // Not a count of the repo-wide pending list, which is what this asserted
    // until 2026-09-17 — see the fixture above.
    const line = destinationConsequences(ctx)[1]
    expect(line).toContain('groups/default/local/cribl/outputs.yml')
    expect(line).toContain('every destination in default')
    expect(line).not.toContain('inputs.yml')
  })

  it('names what is pending elsewhere as left alone, not as carried', () => {
    const line = destinationConsequences(ctx)[2]
    expect(line).toContain('inputs.yml')
    expect(line).toMatch(/leaves it alone/)
  })

  it('renders a refused status read differently from a clean one', () => {
    // The third state. `pendingConfigFiles` never checked its own response
    // status, so a 403 came back as [] and this line told the admin Cribl
    // reports nothing else uncommitted — on the strength of a read Cribl
    // refused. An empty list is a checked claim; a failed read is not, and the
    // two must not print the same.
    const failed = destinationConsequences({ ...ctx, otherPending: null })[2]
    const clean = destinationConsequences({ ...ctx, otherPending: [] })[2]
    expect(failed).not.toEqual(clean)
    expect(failed).not.toContain('nothing else uncommitted')
    expect(failed).toContain('did not answer')
  })

  it('says nothing else is pending only when the read said so', () => {
    // A claim the code can check is checked. A warning that fires when nothing
    // is pending is the one people learn to click past.
    const clean = destinationConsequences({ ...ctx, otherPending: [] })[2]
    expect(clean).toContain('nothing else uncommitted')
    expect(destinationConsequences(ctx)[2]).not.toContain('nothing else uncommitted')
  })

  it('never says the commit carries only this edit', () => {
    // The retired sentence. `outputs.yml` is shared, so it cannot be made true
    // by any read — and it contradicted DEPLOY_CONSEQUENCES three lines below.
    for (const c of [ctx, { ...ctx, otherPending: [] }]) {
      for (const line of destinationConsequences(c)) expect(line).not.toContain('carries only this edit')
    }
  })

  it('names the destination and the deploy as two separate objects', () => {
    const resources = destinationResources(ctx)
    expect(resources.map((r) => r.action)).toEqual(['replace', 'deploy'])
    expect(resources[0].id).toBe('gigamon_lake')
    expect(resources[0].group).toBe('default')
    expect(resources[1].id).toBe('default')
  })
})

describe('how much data a decrease is about', () => {
  it('quotes the tenant’s own size with the day Cribl measured it', () => {
    const change = retentionChange(30, 7)
    const said = sizeSentence({ change, datasetId: 'gigamon_ami', sizeBytes: 119_185_342_464, metricsDate: '2026-09-16' })
    expect(said).toContain('2026-09-16')
    expect(said).toContain('111.0 GB')
  })

  it('says it cannot say, rather than printing a number nobody measured', () => {
    const change = retentionChange(30, 7)
    const said = sizeSentence({ change, datasetId: 'gigamon_ami', sizeBytes: null, metricsDate: null })
    expect(said).toContain('did not report a size')
    expect(said).not.toMatch(/\d+(\.\d+)? ?(GB|MB|TB)/)
  })
})

describe('the controls this phase refused to build', () => {
  it('finds a gate for each of them, by the spike that gates it', () => {
    // A silent `undefined` here renders a spike-gated row with no explanation,
    // which is worse than not building the control at all.
    expect(READER_GATE).toBeDefined()
    expect(PARTITION_GATE).toBeDefined()
    expect(READER_GATE?.spikes).toEqual([])
    expect(READER_GATE?.settled).toContain('already on Federated Search v2')
    // P-S9 REPORTED (2026-09-21), so the partitions gate owes no spike. It is
    // still a gate — the answer was that the editor cannot exist, not that it
    // can now be built — which is why the lookup is keyed on the control and
    // not on a spike id. Keyed on the spike, this would be `undefined` here.
    expect(PARTITION_GATE?.spikes).toEqual([])
    expect(PARTITION_GATE?.settled).toContain('fixed when a Lake dataset is created')
  })
})

// ── The rendered panel ──────────────────────────────────────────────────────

describe('the nine reads', () => {
  it('paints the table before the first response, one busy cell per row', async () => {
    stubWorkspace()
    // A SYNCHRONOUS act: an async one flushes every pending microtask, which
    // would resolve all nine stubbed reads before the assertion and make this
    // test pass against a panel that painted nothing until they had.
    act(() => {
      root.render(wrap(<LakeLandingPanel />))
    })
    // No `settle` — this is the first paint.
    expect(document.body.querySelectorAll('td[aria-busy="true"]').length).toBeGreaterThan(0)
    expect(rowLabels().length).toBeGreaterThan(8)
    await settle()
  })

  it('renders every value against a healthy workspace', async () => {
    stubWorkspace()
    await mount()
    const text = bodyText()
    expect(text).toContain('30 days')
    expect(text).toContain('Near-live')
    expect(text).toContain('health green')
    expect(text).toContain('no local search engines')
    expect(text).toContain('QuickConnect from source in_gigamon_datagen')
    expect(text).toContain('Workers are running commit abcdef1234')
    expect(text).toContain('9 reads · all readable')
  })

  it('uses a real table with row headers, not a div grid', async () => {
    // §2.4, Preview 1.7. A div grid with visual alignment reads as one long
    // run of text to anybody not looking at it.
    stubWorkspace()
    await mount()
    const table = document.body.querySelector('table.dtable')
    expect(table).toBeTruthy()
    expect(table?.querySelector('caption')).toBeTruthy()
    expect(rowLabels()).toContain('Retention')
    expect(rowLabels()).toContain('How objects are written')
  })

  it('degrades exactly one row when one endpoint is refused', async () => {
    // Preview 1.3 and 1.6. The other eight must still render values, and the
    // failed row must NAME the object an admin has to grant — "unavailable"
    // with nothing named is the state this requirement exists to prevent.
    stubWorkspace({ status: { [`GET ${DESTINATION}`]: 403 } })
    await mount()
    const text = bodyText()
    expect(text).toContain('needs GET on /m/:gid/system/outputs/gigamon_lake')
    // The eight that resolved are still on screen.
    expect(text).toContain('30 days')
    expect(text).toContain('no local search engines')
    expect(text).toContain('1 not readable')
  })

  it('re-issues one GET on Retry, not nine', async () => {
    // Preview 1.5. Nine reads to recover one row is eight requests nobody asked
    // for, on the panel whose commonest failure will go on failing.
    const { calls } = stubWorkspace({ status: { [`GET ${DESTINATION}`]: 500 } })
    await mount()
    const before = calls.length
    await press(buttonNamed('Retry the read behind How objects are written'))
    const after = calls.slice(before)
    expect(after.map((c) => c.path)).toEqual([DESTINATION])
  })

  it('puts each row’s explanation behind an ⓘ on that row’s label', async () => {
    // §2.4 once rejected eight ⓘ icons down the left edge. The owner reversed
    // that on 2026-09-24 — "some (i) icons instead of so many words on the
    // screen" — so the paragraphs that sat under the rows are now the ⓘ on the
    // label each one explains. The read map on the panel title is still where
    // "where did this value come from" is answered.
    stubWorkspace()
    await mount()
    expect(tipOn('Landing lag')).toBe(LANDING_TERMS.landingLag)
    expect(tipOn('Search engine')).toBe(LANDING_TERMS.accelerationTier)
    expect(tipOn('Search reader')).toContain(LANDING_TERMS.searchV2)
    expect(tipOn('Retention')).toBe(ROW_TIPS.retention)
    expect(tipOn('Object format')).toBe(ROW_TIPS.objectFormat)
    expect(tipOn('Storage location')).toBe(ROW_TIPS.storage)
    expect(tipOn('How objects are written')).toContain(ROW_TIPS.objectsWritten)
    expect(tipOn('How objects are written')).toContain('restarts the group’s Worker Processes')
    // And none of them, nor anything else on the panel, is this project's own
    // history: spike ids, phases, decision numbers, measurement dates.
    const tips = [...document.body.querySelectorAll('.infotip')].map((t) => t.getAttribute('aria-label') ?? '')
    for (const tip of tips) expect(tip).not.toMatch(TIP_HISTORY)
    expect(bodyText().match(INTERNAL_HISTORY)?.[0]).toBeUndefined()
  })

  it('keeps one short lead line and the irreversible warning on screen', async () => {
    stubWorkspace()
    await mount()
    const text = visibleText()
    expect(text).toContain(LAKE_LEAD)
    expect(text).toContain(LAKE_RETENTION_WARNING)
    // The rest of what the intro said is one ⓘ away, not gone.
    const lead = [...document.body.querySelectorAll('.gs-intro .infotip')].map((t) => t.getAttribute('aria-label'))
    expect(lead).toContain(LAKE_LEAD_TIP)
    expect(LAKE_LEAD_TIP).toContain('no commit to revert')
  })

  it('points a missing dataset at the panel above it, not at a route', async () => {
    // Preview 1.8. `/setup/storage` is a design the owner withdrew (I-D2); a
    // link to one is that design leaking back in.
    stubWorkspace({ noDataset: true })
    await mount()
    const link = document.body.querySelector<HTMLAnchorElement>(`a[href="#${INGEST_ANCHOR_ID}"]`)
    expect(link).toBeTruthy()
    expect(bodyText()).toContain('does not exist yet')
    expect(document.body.querySelector('a[href*="/setup/"]')).toBeNull()
  })
})

describe('the spike-gated rows', () => {
  it('shows the live reader version with no control to change it', async () => {
    stubWorkspace()
    await mount()
    expect(rowLabels()).toContain('Search reader')
    // P-S7 reported on 2026-09-21 and the dataset is already on v2, so the row
    // must not say "yet" any more than the partitions row may. The reason is
    // the label's ⓘ; the row itself carries a short marker.
    expect(tipOn('Search reader')).toContain('already on Federated Search v2')
    expect(tipOn('Search reader')).not.toContain('yet')
    expect(rowNamed('Search reader')?.textContent).toContain('not editable here')
    // The cold-start cost and the breakerRulesets undo trap are for whoever
    // builds a control here, not for a customer: they live in the comment on
    // SPIKE_GATED in cribl/landing.ts, and must not be on the page.
    expect(bodyText()).not.toContain('105 seconds')
    expect(bodyText()).not.toContain('P-S7')
    // Nothing on screen offers to change it.
    expect(buttonNamed('Switch to v2')).toBeUndefined()
  })

  it('shows the live partitions with no editor, but keeps the measurement', async () => {
    stubWorkspace()
    await mount()
    expect(rowLabels()).toContain('Partitions')
    // The row no longer names a spike, because none is owed. It says the thing
    // that is actually true and permanent, and it does NOT say "yet".
    expect(tipOn('Partitions')).toContain('fixed when a Lake dataset is created')
    expect(tipOn('Partitions')).not.toContain('yet')
    expect(rowNamed('Partitions')?.textContent).toContain('fixed at creation')
    expect(bodyText()).not.toContain('P-S9')
    expect(controlIn('Partitions', `Measure the partition candidates for gigamon_ami — ${costLabel(PARTITION_CPU_SECONDS)}`)).toBeTruthy()
  })
})

describe('nothing writes, and nothing spends, on load', () => {
  it('sends no POST, PATCH or DELETE to Cribl when it mounts', async () => {
    const { calls } = stubWorkspace()
    await mount()
    expect(criblWrites(calls)).toEqual([])
  })

  it('submits no search job on mount or on a re-read', async () => {
    // Preview 2.4 and 2.5. A measurement on load is a bill, and a measurement
    // on a timer is a bill nobody is watching.
    const { calls } = stubWorkspace()
    await mount()
    expect(jobsSubmitted(calls)).toEqual([])
    await press(buttonNamed('Re-read everything'))
    expect(jobsSubmitted(calls)).toEqual([])
  })

  it('reads a stored measurement back rather than measuring again', async () => {
    const { calls } = stubWorkspace({
      kv: {
        [LANDING_PROFILE_KEY]: {
          version: 1,
          datasetId: 'gigamon_ami',
          group: 'default',
          format: 'json',
          retentionDays: 30,
          partitions: [],
          flush: FLUSH_PRESETS.nearLive,
          dropRaw: false,
          searchVersion: 'v1',
          lastLagSeconds: { value: 12, at: Date.now() - 4 * 60_000, jobId: 'job-0' },
        },
      },
    })
    await mount()
    expect(jobsSubmitted(calls)).toEqual([])
    expect(bodyText()).toContain('12 s')
    expect(bodyText()).toContain('measured 4 minutes ago')
  })

  it('mutes a measurement once it stops being a claim about now', async () => {
    stubWorkspace({
      kv: {
        [LANDING_PROFILE_KEY]: {
          version: 1,
          datasetId: 'gigamon_ami',
          group: 'default',
          format: 'json',
          retentionDays: 30,
          partitions: [],
          flush: FLUSH_PRESETS.nearLive,
          dropRaw: false,
          searchVersion: 'v1',
          lastLagSeconds: { value: 12, at: Date.now() - (STALE_AFTER_MS + 60_000), jobId: 'job-0' },
        },
      },
    })
    await mount()
    // The class is what is assertable here; what it resolves to is
    // contrast.test.ts's, and whether it reads as "older" is Preview 7.6.
    const muted = document.body.querySelector('.ll-stale')
    expect(muted?.textContent).toBe('12 s')
    // The age is a WORD as well as an ink — colour is never the only signal.
    expect(bodyText()).toContain('measured 1 hour ago')
  })
})

describe('measuring', () => {
  it('submits exactly one job and stores the result with its own timestamp', async () => {
    const { calls } = stubWorkspace({ searchRows: [{ newest: 1, n: 5, lag_s: 8.25 }] })
    await mount()
    await press(controlIn('Landing lag', `Measure the landing lag for gigamon_ami — ${costLabel(LAG_CPU_SECONDS)}`))
    const jobs = jobsSubmitted(calls)
    expect(jobs).toHaveLength(1)
    // Preview 2.2: the cap rides in the body, sized by the window, and is put
    // there by cribl/search.ts rather than written into the query string.
    expect(String(jobs[0].body?.query)).toMatch(/^set max_running_time_per_search=120; dataset="gigamon_ami"/)
    expect(jobs[0].body?.earliest).toBe('-5m')
    // …and it is persisted, so a reload does not re-spend.
    const stored = calls.find((c) => c.method === 'PUT' && c.path.includes('lake_landing'))
    expect(stored, 'the measurement was not written to the app store').toBeTruthy()
  })

  it('measures the customer dataset even while the app is reading the sample one', async () => {
    // Every other query moves to gigamon_ami_sample while only sample data
    // exists. This one is stored as gigamon_ami's landing lag, so it must not.
    settleDatasetTarget(true)
    const { calls } = stubWorkspace({ searchRows: [{ newest: 1, n: 5, lag_s: 8.25 }] })
    await mount()
    await press(controlIn('Landing lag', `Measure the landing lag for gigamon_ami — ${costLabel(LAG_CPU_SECONDS)}`))
    const jobs = jobsSubmitted(calls)
    expect(jobs).toHaveLength(1)
    expect(String(jobs[0].body?.query)).toMatch(/; dataset="gigamon_ami" \|/)
  })

  it('will not call an empty window a lag of zero', async () => {
    // That is the whole reason the query carries `n=count()` beside the lag: a
    // feed that stopped eleven minutes ago and a dataset nobody has ever
    // written to both answer no rows, and "0 s" reads as perfect health.
    const { calls } = stubWorkspace({ searchRows: [{ n: 0 }] })
    await mount()
    await press(controlIn('Landing lag', `Measure the landing lag for gigamon_ami — ${costLabel(LAG_CPU_SECONDS)}`))
    expect(bodyText()).toContain('Nothing landed in gigamon_ami in the last five minutes')
    expect(calls.find((c) => c.method === 'PUT' && c.path.includes('lake_landing'))).toBeUndefined()
  })
})

describe('no write without a confirmation', () => {
  it('sends nothing when Apply is pressed — only when the dialog is answered', async () => {
    const { calls, dataset } = stubWorkspace()
    await mount()

    await typeInto(inputLabelled('Retention, in days'), '45')
    await press(controlIn('Retention', 'Apply'))

    // The dialog is open and NOTHING has been written.
    expect(bodyText()).toContain('Raise retention on Cribl Lake dataset gigamon_ami from 30 to 45 days')
    expect(criblWrites(calls)).toEqual([])

    await press(buttonNamed('Yes, raise it'))
    const written = criblWrites(calls)
    expect(written.map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH ${DATASET}`])
    // The whole dataset, with retention overlaid — not `{retentionPeriodInDays}`
    // alone. Which fields ride along is cribl/lakeLanding.test.ts's subject; what
    // this panel test still owns is that ONE write goes out, and only after the
    // dialog was answered.
    expect((written[0].body as Record<string, unknown>).retentionPeriodInDays).toBe(45)
    expect(written[0].body).toHaveProperty('id', 'gigamon_ami')
    expect(dataset.retentionPeriodInDays).toBe(45)
  })

  it('writes nothing when the dialog is cancelled', async () => {
    const { calls } = stubWorkspace()
    await mount()
    await typeInto(inputLabelled('Retention, in days'), '45')
    await press(controlIn('Retention', 'Apply'))
    await press(buttonNamed('Cancel'))
    expect(criblWrites(calls)).toEqual([])
  })

  it('shows the before and after of the key that moves', async () => {
    stubWorkspace()
    await mount()
    await typeInto(inputLabelled('Retention, in days'), '45')
    await press(controlIn('Retention', 'Apply'))
    const table = [...document.body.querySelectorAll('table.dtable')].find((t) =>
      (t.textContent ?? '').includes('retentionPeriodInDays'),
    )
    expect(table, 'the confirmation drew no before→after table').toBeTruthy()
    const cells = [...(table?.querySelectorAll('td') ?? [])].map((td) => (td.textContent ?? '').trim())
    expect(cells).toContain('30')
    expect(cells).toContain('45')
  })
})

describe('one Guided Setup run at a time', () => {
  // The onboarding panels commit and deploy the same group from the same page.
  it('while another run holds the page’s lock, Apply opens no dialog and writes nothing', async () => {
    const { calls } = stubWorkspace()
    await mount()
    await typeInto(inputLabelled('Retention, in days'), '45')
    // Inside act: taking the lock notifies the panel's store subscription, and
    // a state update outside act is a warning — which fails this file.
    let release: () => void = () => {}
    await act(async () => {
      release = acquireSetupRun('onboarding_pack')!
    })
    await settle()
    const apply = controlIn('Retention', 'Apply')
    expect(apply?.getAttribute('aria-disabled')).toBe('true')
    expect(bodyText()).toContain(SETUP_RUN_BUSY)
    await press(apply)
    expect(bodyText()).not.toContain('Raise retention on Cribl Lake dataset gigamon_ami')
    expect(criblWrites(calls)).toEqual([])
    act(() => release())
  })

  /** The run lock's holder at each request that changes Cribl, as it is sent. */
  function holdersAtWrites(): Array<string | null> {
    const inner = globalThis.fetch
    const held: Array<string | null> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && !String(url).includes('/kvstore')) held.push(setupRunHolder())
      return inner(url, init)
    })
    return held
  }
  async function changeFlush() {
    await press(buttonStarting('Adjust how objects are written'))
    const balanced = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((i) => i.value === 'balanced')
    await press(balanced)
    await press(buttonNamed('Change…'))
    await press(buttonNamed('Yes, apply and deploy'))
  }

  it('a destination change holds the lock through its commit and deploy, and gives it back', async () => {
    const { calls } = stubWorkspace()
    const held = holdersAtWrites()
    await mount()
    await changeFlush()
    expect(criblWrites(calls).length).toBe(3)
    expect(held).toEqual(['lake_landing', 'lake_landing', 'lake_landing'])
    expect(setupRunHolder()).toBeNull()
  })

  it('a retention change holds it, and gives it back', async () => {
    const { calls } = stubWorkspace()
    const held = holdersAtWrites()
    await mount()
    await typeInto(inputLabelled('Retention, in days'), '45')
    await press(controlIn('Retention', 'Apply'))
    await press(buttonNamed('Yes, raise it'))
    expect(criblWrites(calls).length).toBe(1)
    expect(held).toEqual(['lake_landing'])
    expect(setupRunHolder()).toBeNull()
  })

  it('a description change holds it, and gives it back', async () => {
    const { calls } = stubWorkspace()
    const held = holdersAtWrites()
    await mount()
    await typeInto(inputLabelled('Dataset description'), 'AMI flows from the lab')
    await press(controlIn('Description', 'Apply'))
    await press(buttonNamed('Yes, change it'))
    expect(criblWrites(calls).length).toBe(1)
    expect(held).toEqual(['lake_landing'])
    expect(setupRunHolder()).toBeNull()
  })

  it('the retry of a half-applied run holds it, and gives it back', async () => {
    const { calls } = stubWorkspace({ status: { 'POST /version/commit': 500 } })
    await mount()
    await changeFlush()
    const held = holdersAtWrites()
    const before = calls.length
    await press(buttonNamed('Retry the commit and deploy'))
    await press(buttonNamed('Yes, commit and deploy'))
    expect(criblWrites(calls.slice(before)).map((c) => `${c.method} ${c.path}`)).toEqual(['POST /version/commit'])
    expect(held).toEqual(['lake_landing'])
    expect(setupRunHolder()).toBeNull()
  })
})

describe('the one irreversible edit', () => {
  it('asks for the dataset id and says why a decrease cannot be undone', async () => {
    const { calls } = stubWorkspace()
    await mount()
    await typeInto(inputLabelled('Retention, in days'), '7')
    await press(controlIn('Retention', 'Apply'))

    const text = bodyText()
    expect(text).toContain('This cannot be undone.')
    expect(text).toContain('Retention counts from the date data was UPLOADED')
    expect(text).toContain('To confirm, type gigamon_ami')
    // The loss in this tenant's own terms, from the live read (Preview 4.2).
    expect(text).toContain('111.0 GB')
    expect(text).toContain('2026-09-16')

    // Preview 4.4: pressing Confirm before typing writes nothing, and the
    // button stays reachable rather than taking the HTML `disabled` attribute.
    const confirm = buttonNamed('Yes, delete the older data')
    expect(confirm?.getAttribute('aria-disabled')).toBe('true')
    expect(confirm?.hasAttribute('disabled')).toBe(false)
    await press(confirm)
    expect(criblWrites(calls)).toEqual([])
  })

  it('does NOT ask for it on an increase, and offers the way back instead', async () => {
    // Preview 4.5. If both dialogs look the same, "labelled as irreversible" is
    // decoration and the decrease's ceremony proved nothing.
    stubWorkspace()
    await mount()
    await typeInto(inputLabelled('Retention, in days'), '60')
    await press(controlIn('Retention', 'Apply'))
    const text = bodyText()
    expect(text).not.toContain('To confirm, type')
    expect(text).not.toContain('This cannot be undone.')
    expect(text).toContain('Reversible: set retention back to 30 days')
  })
})

describe('the destination editor', () => {
  it('is unavailable — with a reason, not a disabled button — while nothing has changed', async () => {
    stubWorkspace()
    await mount()
    const change = buttonNamed('Change…')
    expect(change).toBeTruthy()
    expect(change?.hasAttribute('disabled')).toBe(false)
    expect(change?.getAttribute('aria-disabled')).toBe('true')
    expect(bodyText()).toContain('already match the live destination')
  })

  it('confirms the diff, both feeds and the restart before it writes anything', async () => {
    const { calls } = stubWorkspace()
    await mount()

    // Open the disclosure and pick a different flush preset.
    await press(buttonStarting('Adjust how objects are written'))
    const balanced = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (i) => i.value === 'balanced',
    )
    await press(balanced)
    await press(buttonNamed('Change…'))

    const text = bodyText()
    expect(text).toContain('destination gigamon_lake in group default')
    expect(text).toContain('maxFileOpenTimeSec')
    expect(text).toContain('QuickConnect from source in_gigamon_datagen')
    expect(text).toContain('restarts this worker group’s Worker Processes')
    // The read that built the diff is a GET; nothing has been changed.
    expect(criblWrites(calls)).toEqual([])

    await press(buttonNamed('Yes, apply and deploy'))
    const written = criblWrites(calls).map((c) => `${c.method} ${c.path}`)
    expect(written).toEqual([`PATCH ${DESTINATION}`, 'POST /version/commit', `PATCH ${GROUPS}/default/deploy`])
  })

  it('sends back the whole live body, keys this app has never heard of included', async () => {
    // A Stream destination PATCH is a full replacement, so anything missing
    // from the body is a field this app just deleted from a customer's config.
    const { calls } = stubWorkspace()
    await mount()
    await press(buttonStarting('Adjust how objects are written'))
    const balanced = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (i) => i.value === 'balanced',
    )
    await press(balanced)
    await press(buttonNamed('Change…'))
    await press(buttonNamed('Yes, apply and deploy'))

    const patch = calls.find((c) => c.method === 'PATCH' && c.path === DESTINATION)
    expect(patch?.body).toMatchObject({ environment: 'prod', notifications: ['someone_elses_notification'] })
    expect(patch?.body?.maxFileOpenTimeSec).toBe(120)
    // `status` is server-computed and must never go back.
    expect(patch?.body).not.toHaveProperty('status')
  })

  it('reports a half-applied run and offers to finish it', async () => {
    // The most likely real failure of this phase in a customer's hands: the
    // object is changed and the Workers are still running the old config. The
    // step list is the only thing that says so.
    const { calls } = stubWorkspace({ status: { 'POST /version/commit': 403 } })
    await mount()
    await press(buttonStarting('Adjust how objects are written'))
    const balanced = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (i) => i.value === 'balanced',
    )
    await press(balanced)
    await press(buttonNamed('Change…'))
    await press(buttonNamed('Yes, apply and deploy'))

    const text = bodyText()
    expect(text).toContain('1 of 2 applied')
    expect(text).toContain('still running the old configuration')
    expect(buttonNamed('Retry the commit and deploy')).toBeTruthy()
    // The destination really was written; only the commit was refused.
    expect(calls.some((c) => c.method === 'PATCH' && c.path === DESTINATION)).toBe(true)
  })
})

describe('a commit that was skipped rather than refused', () => {
  it('is reported and offered a retry, not counted as a success', async () => {
    // INSTANCE 3. Git reports work pending somewhere else and nothing in this
    // group's outputs.yml. Read before the PATCH — where the commit list used
    // to come from — that is the NORMAL answer, because the write that dirties
    // the file has not been sent yet. `destinationCommitFiles` matched nothing,
    // `commitAndDeployDestination` returned `skipped`, `outcome()` counted a
    // skip as ok, the toast said it worked, and `commitIncomplete` required an
    // `error` so the retry button did not render in the one state it exists for.
    //
    // Here the list is read after the PATCH, so an empty answer contradicts a
    // 200 and is reported as an error — and the strip no longer depends on that
    // status string either.
    const { calls } = stubWorkspace({ pending: ['groups/other/local/cribl/outputs.yml'] })
    await mount()
    await press(buttonStarting('Adjust how objects are written'))
    const balanced = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (i) => i.value === 'balanced',
    )
    await press(balanced)
    await press(buttonNamed('Change\u2026'))
    await press(buttonNamed('Yes, apply and deploy'))

    // The destination really was changed — which is what makes the silence bad.
    expect(calls.some((c) => c.method === 'PATCH' && c.path === DESTINATION)).toBe(true)
    // …and nothing was committed on a path nobody could name.
    expect(calls.some((c) => c.path === '/version/commit')).toBe(false)
    const text = bodyText()
    expect(text).toContain('still running the old configuration')
    expect(buttonNamed('Retry the commit and deploy')).toBeTruthy()
  })
})

describe('when Cribl says no', () => {
  it('names the method and the path it refused, beside the control that tried', async () => {
    // The gate in this app is retrospective: the first attempt fails and the
    // SECOND is stopped at the button with a reason. What matters is that the
    // reason is the one an admin can act on — "you do not have permission"
    // names nothing.
    const { calls } = stubWorkspace({ status: { [`PATCH ${DATASET}`]: 403 } })
    await mount()
    await typeInto(inputLabelled('Retention, in days'), '45')
    await press(controlIn('Retention', 'Apply'))
    await press(buttonNamed('Yes, raise it'))

    const text = bodyText()
    expect(text).toContain(`Cribl refused PATCH ${DATASET}`)
    expect(text).toContain('changing how long Cribl Lake keeps this dataset did not complete')
    // Offered a way out that does not need a reload.
    expect(buttonNamed('Try again')).toBeTruthy()
    // One attempt, not a retry loop.
    expect(criblWrites(calls).filter((c) => c.path === DATASET)).toHaveLength(1)
  })
})

describe('finishing a half-applied run', () => {
  /** Get to the state where the destination is changed and the commit was
   *  refused: the object is live and the Workers are on the old configuration. */
  async function halfApplied() {
    const workspace = stubWorkspace({ status: { 'POST /version/commit': 403 } })
    await mount()
    await press(buttonStarting('Adjust how objects are written'))
    const balanced = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (i) => i.value === 'balanced',
    )
    await press(balanced)
    await press(buttonNamed('Change…'))
    await press(buttonNamed('Yes, apply and deploy'))
    return workspace
  }

  it('holds the retry closed until the refusal is dismissed, and says what was refused', async () => {
    // The gate is retrospective, so after one refusal the control is held shut
    // with the method and the path on screen. Deliberately NOT the HTML
    // `disabled` attribute: a closed button that cannot say why it is closed is
    // the failure <GatedControl> exists to prevent.
    const { calls } = await halfApplied()
    const retry = buttonNamed('Retry the commit and deploy')
    expect(retry?.getAttribute('aria-disabled')).toBe('true')
    expect(retry?.hasAttribute('disabled')).toBe(false)
    expect(bodyText()).toContain('Cribl refused POST /version/commit')

    const before = calls.length
    await press(retry)
    // A press on a closed control sends nothing; it points at the way out.
    expect(criblWrites(calls.slice(before))).toEqual([])
  })

  it('confirms the commit and the restart again before it sends anything', async () => {
    // The retry is a WRITE, so it is behind a confirmation like every other one
    // — and that confirmation has to repeat the Worker Process restart, because
    // this is the press that actually causes it.
    const { calls } = await halfApplied()
    await press(buttonNamed('Try again'))
    const before = calls.length
    await press(buttonNamed('Retry the commit and deploy'))
    expect(bodyText()).toContain('Commit and deploy the destination change already made in group default')
    expect(bodyText()).toContain('restarts this worker group’s Worker Processes')
    // The only thing that has left the app since the press is the read that
    // works out what is pending.
    expect(criblWrites(calls.slice(before))).toEqual([])
  })

  it('does not send the destination body a second time', async () => {
    const { calls } = await halfApplied()
    await press(buttonNamed('Try again'))
    await press(buttonNamed('Retry the commit and deploy'))
    await press(buttonNamed('Yes, commit and deploy'))

    // Two commit attempts, one destination PATCH. Re-sending the body would be
    // a second overwrite of a live delivery point nobody confirmed twice.
    expect(calls.filter((c) => c.method === 'PATCH' && c.path === DESTINATION)).toHaveLength(1)
    expect(calls.filter((c) => c.path === '/version/commit')).toHaveLength(2)
  })
})

describe('create mode', () => {
  it('asks one question, and states the storage risk as well as the search benefit', async () => {
    stubWorkspace({ noDataset: true })
    await mount()
    const text = bodyText()
    expect(text).toContain('JSON, gzipped')
    expect(text).toContain('Parquet')
    // The benefit and the cost, both in the customer's terms. The encoding
    // detail (PLAIN with SNAPPY) is in the comment beside the tiles.
    expect(text).toContain('reads only the columns it names')
    expect(text).toContain('several times the storage')
  })

  it('promises nothing it cannot keep about Parquet', async () => {
    // This release always lands JSON, and whether a Parquet destination even
    // writes into a `format:json` dataset is P-S1's and P-S5's to answer —
    // which the tile no longer says by spike id.
    stubWorkspace({ noDataset: true })
    await mount()
    expect(bodyText()).toContain('records the intention only; this release still writes JSON')
    expect(bodyText().match(INTERNAL_HISTORY)?.[0]).toBeUndefined()
  })

  it('writes only this app’s own document when the choices are saved', async () => {
    const { calls } = stubWorkspace({ noDataset: true })
    await mount()
    await press(buttonNamed('Save these choices'))
    expect(criblWrites(calls)).toEqual([])
    expect(calls.some((c) => c.method === 'PUT' && c.path.includes('lake_landing'))).toBe(true)
  })

  it('does not offer the editors, because there is nothing to edit yet', async () => {
    stubWorkspace({ noDataset: true })
    await mount()
    expect(buttonNamed('Change…')).toBeUndefined()
    expect(rowLabels()).not.toContain('Description')
  })
})

describe('it is actually on the page', () => {
  it('renders inside Guided Setup, beneath the panel its absent state links to', async () => {
    // Phase 1 shipped <SearchLimitsPanel> rendered by nothing, and nobody found
    // out until a human looked at the page. This is that check, in a test.
    stubWorkspace()
    await mount(<GuidedSetup />)
    expect(bodyText()).toContain('How data lands in Cribl Lake')
    const anchor = document.getElementById(INGEST_ANCHOR_ID)
    expect(anchor, 'the in-page anchor the dataset-absent state links to is not on the page').toBeTruthy()
    // The anchor really wraps the ingest panel, not something else.
    expect(anchor?.querySelector('.panel')).toBeTruthy()
  })

  it('the page has its heading, and today its facts describe the pack onboarding installs', async () => {
    stubWorkspace()
    await mount(<GuidedSetup />)
    const h2 = [...document.querySelectorAll('h2')].map((h) => h.textContent)
    expect(h2).toContain('Guided setup')
    // 0.2.1 is released, so the pack is the onboarding and the facts are the
    // pack's. *(Corrected 2026-09-25, `feat/pack-flip-021`: until the release
    // they were the global Raw HTTP stack's.)*
    const facts = [...document.querySelectorAll('.gs-facts li')].map((li) => li.textContent ?? '')
    expect(facts).toHaveLength(PACK_SETUP_FACTS.length)
    PACK_SETUP_FACTS.forEach((f, i) => expect(facts[i].startsWith(f.label), f.label).toBe(true))
    // …and not the global stack's: its first fact names a global object the
    // pack does not create.
    expect(facts.some((f) => f.startsWith(SETUP_FACTS[0].label))).toBe(false)
  })
})
