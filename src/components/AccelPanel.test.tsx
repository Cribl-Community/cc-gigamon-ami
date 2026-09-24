// What Guided Setup's Acceleration section promises, measured on the rendered
// DOM and on the copy functions behind it.
//
// THE THREE ASSERTIONS THAT MATTER MOST ARE ABOUT WHAT HAS *NOT* HAPPENED.
//
//   * A WRITE THAT NOBODY CONFIRMED. Every control on this screen creates,
//     edits or deletes a Cribl saved search that then bills on a cron. So the
//     tests press the outer triggers — Review changes, Remove acceleration,
//     Pause — and assert that no POST, PATCH or DELETE left the app. A button
//     that works before the confirmation is the failure this whole file exists
//     to catch, and it is invisible in a screenshot.
//   * A TEARDOWN THAT FIRED WITHOUT THE LITERAL. The delete confirmation is
//     type-to-confirm, and the test presses its confirm button with the box
//     empty and asserts nothing was deleted.
//   * A WRITE OFFERED FROM A STATE NOBODY COULD READ. When the saved-search
//     list is refused, every row is `unreadable` and neither Apply nor Remove is
//     on screen at all — the row must not read as "absent" with an offer to
//     create it, which is the Guided Setup bug this app already shipped once.
//
// THE OTHER HALF IS THE VOCABULARY. Six states, three columns and a set of words
// for "this is not a number": `0 CPU-s` beside a scheduled search reads as
// "free", and `billableCPUSeconds` genuinely answers 0 for a job that has not
// been billed yet, so the words for that case are pinned here.
//
// WHAT THIS ENVIRONMENT CANNOT BE ASKED, stated rather than faked — the list
// ConfirmDialog.test.tsx and JobWatchdog.test.tsx keep for the same reasons:
//
//   * FOCUS CONTAINMENT AND FOCUS RESTORATION. happy-dom implements no
//     sequential focus navigation and enforces nothing for `inert`, so a test
//     that pressed Tab would pass against an empty document. What is asserted
//     instead is the mechanism: the confirmations are `<ConfirmDialog>`, whose
//     own test file measures the portal, the `inert` root and the initial focus
//     on Cancel.
//   * HIT-AREA SIZE AND LAYOUT. No layout is computed here, so nothing about
//     the table's behaviour at phone width is checked by any assertion below.
//   * WHETHER A SCREEN READER ANNOUNCES A ROW CONTROL'S NAME. What is asserted
//     is that the name exists and carries the search id, which is the part that
//     can be got wrong in source.
//   * THAT CRIBL ACCEPTS ANY OF THESE BODIES. The stub takes whatever it is
//     handed. The first real Apply is a human's click in Preview; nothing here
//     creates a real saved search.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetRunHistory } from '../cribl/accel/status'
import { accelServing } from '../cribl/accel/serving'
import { resetDenials } from '../cribl/authz'
import { accelEntry, accelSavedSearch, MANIFEST } from '../cribl/accel/manifest'
import { applyPlan, readAccelState, removalPlan, type AccelRow } from '../cribl/accel/provision'
import { accelWritesSettled } from '../cribl/accel/store'
import { estimateWorkspaceSaving } from '../cribl/accel/estimate'
import type { AccelStatus } from '../cribl/accel/status'
import { AccelPanel } from './AccelPanel'
import { ACCEL_UNVERIFIED_OFF, SAMPLE_ACCEL_OFF } from './sampleDataCopy'
import { settleDatasetTarget } from '../cribl/datasetTarget'
// The words are next door, pure and DOM-free — most of what this screen can get
// wrong is a sentence rather than a tag, so most of what follows is a function
// call rather than a render.
import {
  ACCEL_LEAD,
  ACCEL_LEAD_TIP,
  PILL_STATE,
  REMOVE_LITERAL,
  UNINSTALL_WARNING,
  applyCostLine,
  applyResources,
  creditSpanWords,
  healthOf,
  lastRunCostWords,
  nothingToApplyWords,
  lastRunWhen,
  ownerOf,
  removeCostLine,
  removeResources,
  rowAction,
  rowActionName,
  rowNote,
  showOwnerColumn,
  switchName,
  toggleNothingWords,
} from './accelPanelCopy'
import { togglePlan } from '../cribl/accel/tabs'

const BASE = '/capi'
const SAVED = '/m/default_search/search/saved'
const JOBS = '/m/default_search/search/jobs'
const LAKE = 'gno_lake_30d_c1d'
const SAMPLE = 'gno_sample_2m_c1h'
const ME = 'auth0|me'
const THEM = 'auth0|user06'
const NOW = 1_789_600_000_000

// ── The fake workspace ──────────────────────────────────────────────────────

interface Call { method: string; path: string; query: string; body: Record<string, unknown> | undefined }

interface Run { id: string; status: string; timeCreated: number; timeStarted: number; timeCompleted: number | null }

interface WorkspaceOpts {
  saved?: Record<string, Record<string, unknown>>
  /** `${METHOD} ${path}` (no query) → answer this status instead. */
  status?: Record<string, number>
  /** Job history per schedule, newest first. Keyed by saved-search id here for
   *  legibility; the stub flattens it into the one unfiltered list the platform
   *  actually returns, and each run carries its owner in its job id. */
  runs?: Record<string, Run[]>
  /** Billable CPU-seconds by job id. Absent means the metrics read 404s. */
  cpu?: Record<string, number>
  /** The Lake API's dataset list. Absent means it answers 404, which leaves the
   *  Lake total's window unresolved — and that entry neither created nor
   *  overwritten (provision.ts `windowUnresolved`). */
  lake?: unknown
}

/** A Lake API answering the way a working 30-day tenant's does. */
const LAKE_30 = {
  items: [
    { id: 'gigamon_ami', retentionPeriodInDays: 30 },
    { id: 'cribl_metrics', retentionPeriodInDays: 30 },
  ],
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

function stubWorkspace(opts: WorkspaceOpts = {}) {
  const saved = new Map<string, Record<string, unknown>>(
    Object.entries(opts.saved ?? {}).map(([id, obj]) => [id, { ...obj }]),
  )
  const kv = new Map<string, string>()
  const calls: Call[] = []

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const rest = String(url).slice(BASE.length)
    const [path, query = ''] = rest.split('?')
    const body = init.body == null ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ method, path, query, body })

    const override = opts.status?.[`${method} ${path}`]
    if (override !== undefined) return response(override, override >= 400 ? DENIED : {})

    if (path.startsWith('/kvstore')) {
      if (path === '/kvstore/keys') return response(200, [...kv.keys()])
      const key = path.slice('/kvstore/'.length).split('/').map(decodeURIComponent).join('/')
      if (method === 'PUT') { kv.set(key, String(init.body ?? '')); return response(200, '') }
      if (method === 'DELETE') return response(kv.delete(key) ? 200 : 404, '')
      const held = kv.get(key)
      return held === undefined ? response(404, '') : response(200, held)
    }

    if (path.endsWith('/lakes/default/datasets') && method === 'GET') {
      return opts.lake ? response(200, opts.lake) : response(404, { message: 'no lake' })
    }

    if (path === JOBS && method === 'GET') {
      // ONE unfiltered list, every schedule's runs in it. Measured live
      // 2026-09-18: no request parameter selects a saved search's runs, and a
      // run declares its owner in its own job id (`<savedSearchId>.<suffix>`).
      // This stub used to key on `correlationId`, which returned nothing for
      // every schedule and reported all of them as never having run.
      const items = Object.values(opts.runs ?? {}).flat()
      return response(200, { items, count: items.length, totalCount: items.length })
    }
    if (path.startsWith(`${JOBS}/`) && path.endsWith('/metrics') && method === 'GET') {
      const jobId = decodeURIComponent(path.slice(JOBS.length + 1, -'/metrics'.length))
      const v = opts.cpu?.[jobId]
      return v === undefined
        ? response(404, { message: 'no metrics' })
        : response(200, { items: [{ metrics: { cpuMetrics: { billableCPUSeconds: v } } }] })
    }

    if (path === SAVED) {
      if (method === 'GET') {
        const items = [...saved.values()]
        return response(200, { items, count: items.length, totalCount: items.length })
      }
      if (method === 'POST') {
        const id = String(body?.id ?? '')
        saved.set(id, { ...(body as Record<string, unknown>), user: ME, displayUsername: 'me@example.com' })
        return response(200, { items: [body], count: 1 })
      }
    }
    if (path.startsWith(`${SAVED}/`)) {
      const id = decodeURIComponent(path.slice(SAVED.length + 1))
      if (method === 'GET') {
        const obj = saved.get(id)
        return obj ? response(200, { items: [obj], count: 1 }) : response(404, { message: 'not found' })
      }
      if (method === 'PATCH') {
        saved.set(id, body as Record<string, unknown>)
        return response(200, { items: [saved.get(id)], count: 1 })
      }
      if (method === 'DELETE') {
        if (!saved.has(id)) return response(404, { message: 'not found' })
        saved.delete(id)
        return response(200, { items: [], count: 0 })
      }
    }
    return response(404, { message: `the stub has no route for ${method} ${path}` })
  })

  return { calls, saved }
}

/** Every write request that reached `/search/saved`. The app's own KV writes are
 *  not this file's subject; a saved-search write without a confirmation is. */
const savedWrites = (calls: readonly Call[]) =>
  calls.filter((c) => c.path.startsWith(SAVED) && ['POST', 'PATCH', 'DELETE'].includes(c.method))

/** A correct object for an entry, as this release would write it — plus the
 *  server-controlled owner fields Cribl stamps on a POST. */
async function stored(id: typeof LAKE | typeof SAMPLE, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const want = (await accelSavedSearch(accelEntry(id))) as unknown as Record<string, unknown>
  return { ...want, user: ME, displayUsername: 'me@example.com', ...over }
}

/** …with its schedule changed, which is what `differs` looks like. */
async function drifted(id: typeof LAKE): Promise<Record<string, unknown>> {
  const want = await stored(id)
  return { ...want, schedule: { ...(want.schedule as Record<string, unknown>), cronSchedule: '*/5 * * * *' } }
}

/** An object carrying one of this app's ids that this app did not write. */
async function foreign(id: typeof LAKE): Promise<Record<string, unknown>> {
  const want = await stored(id)
  return { ...want, description: 'my own copy of the lake total', user: THEM, displayUsername: 'User 06' }
}

const run = (over: Partial<Run> = {}): Run => ({
  // `<savedSearchId>.<epochMs>.<rand>` — the shape the platform emits, measured
  // live 2026-09-18. listRuns selects a schedule’s runs by that prefix, so a bare
  // id belongs to no schedule and the table reports "Never run".
  id: `${LAKE}.1789600000000.abcdef`,
  status: 'completed',
  timeCreated: NOW - 3600_000,
  timeStarted: NOW - 3600_000,
  timeCompleted: NOW - 3500_000,
  ...over,
})

/** An AccelStatus for the pure-function cases. */
function status(over: Partial<AccelStatus> = {}): AccelStatus {
  return {
    id: LAKE,
    runs: [],
    last: null,
    lastCpuSeconds: null,
    lastCpuUnavailable: null,
    observedIntervalMs: null,
    expectedIntervalMs: 24 * 3600_000,
    denied: false,
    error: null,
    checkedAt: NOW,
    ...over,
  }
}

const asRun = (r: Run) => ({
  id: r.id,
  outcome: 'completed' as const,
  running: false,
  createdAt: r.timeCreated,
  startedAt: r.timeStarted,
  completedAt: r.timeCompleted,
  at: r.timeCompleted ?? r.timeStarted,
})

// ── Mounting ────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // The run-history page is cached module-wide so sixteen callers share one
  // request. A cache that outlived a test would hand the next one the previous
  // test's stubbed history, so it is dropped here — the same discipline as
  // resetAccelKeyMemo and resetSnapshotCensus.
  forgetRunHistory()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // user.ts memoises the platform lookup for the life of the module, so the
  // signed-in identity is one value for this whole file; fixtures pick a side
  // with their `user` field instead.
  vi.stubGlobal('getCriblUser', async () => ({ id: ME, username: 'me' }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetDenials()
  container = document.createElement('div')
  // Capra's Modal portals out of this element and marks it `inert`; the
  // assertions about dialog buttons look outside it.
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await accelWritesSettled()
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDenials()
})

/** Let the environment run: the state read, the status read and the identity
 *  lookup all settle on their own turns, and Capra's focus work after that. */
async function settle(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}

async function mount() {
  await act(async () => { root.render(<AccelPanel />) })
  await settle()
}

const bodyText = () => document.body.textContent ?? ''
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === name || b.getAttribute('aria-label') === name,
  )
async function press(el: HTMLElement | undefined) {
  expect(el, 'this test expected a control that is not on screen').toBeDefined()
  await act(async () => { (el as HTMLElement).click() })
  await settle(2)
}

// ── The vocabulary ──────────────────────────────────────────────────────────

describe('the six states a scheduled search can be in', () => {
  it('gives each one its own word', () => {
    // The point of the column. Two states would render "this app has never
    // created this" and "somebody else already owns this id" identically, and
    // the right action is opposite: create it, versus do not touch it.
    const words = Object.values(PILL_STATE)
    expect(new Set(words).size).toBe(words.length)
    expect(PILL_STATE.absent).not.toBe(PILL_STATE.foreign)
    expect(PILL_STATE.absent).not.toBe(PILL_STATE.unreadable)
    expect(PILL_STATE.enabled).not.toBe(PILL_STATE.paused)
  })
})

describe('health', () => {
  it('reads the status error BEFORE the run count', () => {
    // A refusal, a correlationId that matched nothing and a schedule that has
    // never fired all give zero rows. Only `error` separates the first from the
    // other two, and "never run" about a search nobody could look at is a lie
    // with an expensive next step attached to it.
    expect(healthOf('enabled', status({ error: 'Cribl answered 500' })).word).toBe('Cannot say')
    expect(healthOf('enabled', status({ denied: true, error: 'refused' })).word).toBe('Cannot see')
    expect(healthOf('enabled', status()).word).toBe('Never run')
  })

  it('never calls a search that does not exist "never run"', () => {
    expect(healthOf('absent', status()).word).toBe('Not scheduled')
    expect(healthOf('foreign', status()).word).toBe('Not this app’s')
    expect(healthOf('unreadable', status()).word).toBe('Cannot say')
  })

  it('says a paused search is not running, before it says anything about runs', () => {
    const h = healthOf('paused', status({ runs: [asRun(run())], last: asRun(run()) }))
    expect(h.word).toBe('Paused')
    expect(h.detail).toContain('live query')
  })

  it('does not render "cannot say" as healthy', () => {
    // cadenceLooksRight answers null with fewer than two runs. A table that
    // turned that into "on schedule" would be reporting a measurement it has
    // not got.
    const one = status({ runs: [asRun(run())], last: asRun(run()) })
    expect(healthOf('enabled', one).word).toBe('Too few runs to say')
    expect(healthOf('enabled', one).tone).toBe('unknown')
  })

  it('separates a healthy schedule from a schedule whose last run failed', () => {
    const failed = { ...asRun(run()), outcome: 'failed' as const }
    const h = healthOf('enabled', status({ runs: [failed], last: failed, observedIntervalMs: 24 * 3600_000 }))
    expect(h.word).toBe('Last run failed')
    expect(h.tone).toBe('bad')
    expect(h.detail).toContain('live query')
  })

  it('reports a slipped cadence without inventing a severity for it', () => {
    const late = status({
      runs: [asRun(run()), asRun(run({ id: `${LAKE}.b` }))],
      last: asRun(run()),
      observedIntervalMs: 72 * 3600_000,
      expectedIntervalMs: 24 * 3600_000,
    })
    expect(healthOf('enabled', late).word).toBe('Behind schedule')
    expect(healthOf('enabled', late).tone).toBe('warn')
  })
})

describe('what the last run cost', () => {
  it('never prints 0', () => {
    // `billableCPUSeconds` answers 0 for a job that has not been billed yet, and
    // a finished search of this dataset has a measured floor near five CPU-s. A
    // zero that reaches this column reads as "this schedule is free".
    expect(lastRunCostWords(status({ last: asRun(run()), lastCpuUnavailable: 'not-reported' }))).toBe('not reported yet')
    expect(lastRunCostWords(status({ last: asRun(run()), lastCpuUnavailable: 'running' }))).toBe('still running')
    expect(lastRunCostWords(status({ last: asRun(run()), lastCpuUnavailable: 'unreadable' }))).toBe('could not read')
    expect(lastRunCostWords(status({ last: asRun(run()), lastCpuSeconds: null }))).toBe('not reported yet')
  })

  it('states a real figure in both units an admin budgets in', () => {
    const words = lastRunCostWords(status({ last: asRun(run()), lastCpuSeconds: 9297.7 }))
    expect(words).toContain('9,298 CPU-s')
    expect(words).toContain('credits')
  })

  it('says nothing at all about runs it could not read', () => {
    expect(lastRunWhen(status({ error: 'refused' }))).toBe('—')
    expect(lastRunCostWords(status({ error: 'refused' }))).toBe('—')
    expect(lastRunWhen(status())).toBe('Never')
    expect(lastRunWhen(null)).toBe('Checking…')
  })
})

describe('the per-row control', () => {
  const row = (over: Partial<AccelRow>): AccelRow => ({
    id: LAKE,
    entry: accelEntry(LAKE),
    state: 'enabled',
    enabled: true,
    differences: [],
    stamp: null,
    ours: true,
    recorded: false,
    intended: {} as AccelRow['intended'],
    stored: null,
    ...over,
  })

  it('offers Pause on a running one and Resume on a paused one', () => {
    expect(rowAction(row({})).kind).toBe('pause')
    expect(rowAction(row({ state: 'paused', enabled: false })).kind).toBe('resume')
  })

  it('offers a word, never a disabled button, where there is nothing to press', () => {
    // A `disabled` button leaves the keyboard order and announces as
    // unavailable without ever saying why — which is the one thing these rows
    // exist to say. Same rule as the long-running-search table.
    expect(rowAction(row({ state: 'absent' }))).toEqual({ kind: 'none', word: 'Not created' })
    expect(rowAction(row({ state: 'foreign', ours: false }))).toEqual({ kind: 'none', word: 'Not this app’s' })
    expect(rowAction(row({ state: 'unreadable' }))).toEqual({ kind: 'none', word: 'Unverified' })
    expect(rowAction(row({ enabled: null }))).toEqual({ kind: 'none', word: 'No schedule' })
  })

  it('names the search in the control’s accessible name', () => {
    // "Pause" is meaningless to somebody hearing the third row of a table.
    for (const entry of MANIFEST) {
      expect(rowActionName('pause', entry)).toContain(entry.id)
      expect(rowActionName('resume', entry)).toContain(entry.id)
      expect(rowActionName('pause', entry).startsWith(`Pause ${entry.id}`)).toBe(true)
    }
  })
})

describe('the owner column', () => {
  const withOwner = (user: string | null): AccelRow => ({
    id: LAKE,
    entry: accelEntry(LAKE),
    state: 'enabled',
    enabled: true,
    differences: [],
    stamp: null,
    ours: true,
    recorded: false,
    intended: {} as AccelRow['intended'],
    stored: user === null ? {} : { user, displayUsername: 'User 06' },
  })

  it('is not a column when every one of them is yours', () => {
    expect(showOwnerColumn([withOwner(ME)], ME)).toBe(false)
  })

  it('appears the moment one of them is somebody else’s', () => {
    expect(showOwnerColumn([withOwner(ME), withOwner(THEM)], ME)).toBe(true)
    expect(ownerOf(withOwner(THEM)).name).toBe('User 06')
  })

  it('appears when the platform names nobody, rather than claiming they are yours', () => {
    // The localhost dev page and any build that does not resolve a user. "This
    // is yours" would be a claim the app cannot support.
    expect(showOwnerColumn([withOwner(THEM)], null)).toBe(true)
  })
})

// ── The confirmations ───────────────────────────────────────────────────────

describe('what a confirmation names', () => {
  it('names exactly the searches the run will write, and no others', async () => {
    // The guarantee cribl/accel/provision.ts asked for: a dialog that re-derives
    // its own list will eventually name a different set from the one the run
    // touches. Both directions.
    stubWorkspace({ saved: { [SAMPLE]: await stored(SAMPLE) }, lake: LAKE_30 })
    const state = await readAccelState()
    const plan = applyPlan(state)
    const named = applyResources(state).map((r) => r.id)
    // Every entry but the one already stored correctly.
    expect(named).toEqual(MANIFEST.map((e) => e.id).filter((id) => id !== SAMPLE))
    for (const id of named) expect(plan.willWrite.some((w) => w.includes(id))).toBe(true)
    for (const leave of plan.willLeave) expect(named.some((id) => leave.label.includes(id))).toBe(false)
  })

  it('does not offer to overwrite the Lake total while its window cannot be resolved, and says why', async () => {
    // Verifier, 2026-09-24, defect 2. This stub's Lake API answers 404, so what
    // this release "intends" for the Lake total is the manifest's DEFAULT
    // window. A dialog offering to write that over the stored search would
    // replace a window chosen from the tenant's retention with one nobody chose.
    stubWorkspace({ saved: { [LAKE]: await drifted(LAKE), [SAMPLE]: await stored(SAMPLE) } })
    const state = await readAccelState()
    const row = state.rows.find((r) => r.id === LAKE)!
    expect(row.state).toBe('differs')
    expect(applyResources(state).map((r) => r.id)).not.toContain(LAKE)
    const note = rowNote(row, healthOf(row.state, null))
    expect(note).toContain('retention could not be read')
    expect(note).toContain('Apply leaves it as it is')
    expect(note).not.toContain('Apply overwrites it')
  })

  it('does not offer to create an absent Lake total while its window cannot be resolved, and says why', async () => {
    // Owner decision, 2026-09-24: a create on the default window starts a
    // billed daily schedule reading a window nobody chose. This stub's Lake API
    // answers 404.
    stubWorkspace({ saved: { [SAMPLE]: await stored(SAMPLE) } })
    const state = await readAccelState()
    const row = state.rows.find((r) => r.id === LAKE)!
    expect(row.state).toBe('absent')
    expect(applyResources(state).map((r) => r.id)).not.toContain(LAKE)
    expect(applyPlan(state).willLeave.some((l) => l.label.includes(LAKE))).toBe(true)
    const note = rowNote(row, healthOf(row.state, null))
    expect(note).toContain('retention could not be read')
    expect(note).toContain('window')
    expect(note).toContain('Apply does not create it')
  })

  it('does not call the workspace complete when the Lake total is only held back', async () => {
    // With every other entry stored and the Lake read failing, the plan writes
    // nothing — but "every scheduled search is already exactly as it defines
    // it" would be false: one of them does not exist.
    const saved: Record<string, Record<string, unknown>> = {}
    for (const e of MANIFEST) if (e.id !== LAKE) saved[e.id] = await stored(e.id as typeof SAMPLE)
    stubWorkspace({ saved })
    const state = await readAccelState()
    expect(applyPlan(state).willWrite).toEqual([])
    const words = nothingToApplyWords(state)
    expect(words).not.toContain('every scheduled search this release defines is already')
    expect(words).toContain('retention could not be read')
    // …and on a genuinely complete workspace the old sentence stands.
    stubWorkspace({ saved: { ...saved, [LAKE]: await stored(LAKE) }, lake: LAKE_30 })
    expect(nothingToApplyWords(await readAccelState())).toContain('every scheduled search this release defines is already exactly as it defines it')
  })

  it('offers to delete only what this app can prove it created', async () => {
    stubWorkspace({ saved: { [LAKE]: await foreign(LAKE), [SAMPLE]: await stored(SAMPLE) } })
    const state = await readAccelState()
    expect(removeResources(state).map((r) => r.id)).toEqual([SAMPLE])
    expect(removalPlan(state).willLeave.some((l) => l.label.includes(LAKE))).toBe(true)
  })

  it('states the recurring charge Apply creates, not only the saving', () => {
    // Creating a schedule is taking on a charge that bills whether or not
    // anybody opens the panel. A dialog that led with the saving would be asking
    // somebody to approve a subscription by showing them the discount.
    const line = applyCostLine(estimateWorkspaceSaving())
    expect(line).toContain('recurring charge')
    expect(line).toContain('credits/day')
    expect(line).toContain('credits a month')
    expect(line).toContain('estimate, not a bill')
  })

  it('states the charge Remove puts back', () => {
    expect(removeCostLine(estimateWorkspaceSaving())).toContain('live queries back')
  })

  it('warns that uninstalling the app leaves them running and billing', () => {
    // Decision I-D28, and the reason this control exists at all rather than
    // being left to uninstall.
    expect(UNINSTALL_WARNING).toContain('Uninstalling this app does NOT remove these searches')
    expect(UNINSTALL_WARNING).toContain('billing')
    expect(UNINSTALL_WARNING).toContain('non-admin')
  })
})

describe('the estimate’s arithmetic reads as an estimate', () => {
  it('collapses a band with no spread rather than printing it twice', () => {
    expect(creditSpanWords({ low: 2.58, high: 2.58 })).toBe('about 2.6 credits/day')
    expect(creditSpanWords({ low: 36, high: 59 })).toContain('–')
  })
})

// ── The screen ──────────────────────────────────────────────────────────────

describe('the table', () => {
  it('is a real table, named, with a scope on every header', async () => {
    stubWorkspace()
    await mount()
    const table = container.querySelector('table')
    expect(table?.querySelector('caption')?.className).toContain('sr-only')
    for (const th of [...container.querySelectorAll('th')]) {
      expect(th.getAttribute('scope'), `a header cell with no scope: "${th.textContent}"`).toBeTruthy()
    }
  })

  it('renders a search that was never created as absent, with no owner column', async () => {
    stubWorkspace()
    await mount()
    expect(bodyText()).toContain('absent')
    expect(bodyText()).toContain('Not scheduled')
    expect(bodyText()).toContain('Not created')
    expect([...container.querySelectorAll('th[scope="col"]')].map((th) => th.textContent)).not.toContain('Owner')
  })

  it('distinguishes a search somebody edited from one that was never created', async () => {
    // The state pair this table exists for. `differs` also has to say WHAT
    // differs, because "it is not what we would write" is not something anybody
    // can act on.
    stubWorkspace({ saved: { [LAKE]: await drifted(LAKE) } })
    await mount()
    expect(bodyText()).toContain('differs')
    expect(bodyText()).toContain('absent')
    expect(bodyText()).toContain('when it runs')
  })

  it('distinguishes somebody else’s saved search from one of ours', async () => {
    stubWorkspace({ saved: { [LAKE]: await foreign(LAKE) } })
    await mount()
    expect(bodyText()).toContain('foreign')
    expect(bodyText()).toContain('Not this app’s')
    // …and the owner column appears, because it is no longer the reader's.
    expect([...container.querySelectorAll('th[scope="col"]')].map((th) => th.textContent)).toContain('Owner')
    expect(bodyText()).toContain('User 06')
  })

  it('renders an enabled search with its last run and what that run billed', async () => {
    stubWorkspace({
      saved: { [LAKE]: await stored(LAKE) },
      runs: { [LAKE]: [run(), run({ id: `${LAKE}.older`, timeCreated: NOW - 25 * 3600_000, timeStarted: NOW - 25 * 3600_000, timeCompleted: NOW - 24.9 * 3600_000 })] },
      cpu: { [`${LAKE}.1789600000000.abcdef`]: 9297.7 },
    })
    await mount()
    expect(bodyText()).toContain('enabled')
    expect(bodyText()).toContain('9,298 CPU-s')
    expect(bodyText()).not.toContain('0 CPU-s')
  })

  it('renders a paused search as paused, and offers Resume rather than Pause', async () => {
    const paused = await stored(LAKE)
    paused.schedule = { ...(paused.schedule as Record<string, unknown>), enabled: false }
    stubWorkspace({ saved: { [LAKE]: paused } })
    await mount()
    expect(bodyText()).toContain('paused')
    expect(buttonNamed(rowActionName('resume', accelEntry(LAKE)))).toBeDefined()
    expect(buttonNamed(rowActionName('pause', accelEntry(LAKE)))).toBeUndefined()
  })

  it('carries the search id in the accessible name of every row control', async () => {
    stubWorkspace({ saved: { [LAKE]: await stored(LAKE), [SAMPLE]: await stored(SAMPLE) } })
    await mount()
    const named = [...container.querySelectorAll<HTMLButtonElement>('tbody button[aria-label]')]
    expect(named.length).toBe(2)
    for (const button of named) {
      expect(MANIFEST.some((e) => (button.getAttribute('aria-label') ?? '').includes(e.id))).toBe(true)
    }
  })
})

describe('a read it could not make', () => {
  it('does not report a refused list as "absent", and offers no write at all', async () => {
    // The Guided Setup bug, restated for saved searches: a refused GET became
    // `false`, the row said "absent", and the screen offered to create a second
    // copy of something the reader simply could not see.
    stubWorkspace({ status: { [`GET ${SAVED}`]: 403 } })
    await mount()
    expect(bodyText()).toContain('unreadable')
    expect(bodyText()).not.toContain('Not scheduled')
    expect(buttonNamed('Review changes…')).toBeUndefined()
    expect(buttonNamed('Remove acceleration…')).toBeUndefined()
    // …and it says what an admin would have to grant.
    expect(bodyText()).toContain('/m/default_search/search/saved')
  })

  it('still offers Re-check, which is the only thing that can fix it', async () => {
    stubWorkspace({ status: { [`GET ${SAVED}`]: 403 } })
    await mount()
    expect(buttonNamed('Re-check')).toBeDefined()
  })
})

describe('no write without a confirmation', () => {
  it('writes nothing when Review changes is pressed', async () => {
    const { calls } = stubWorkspace()
    await mount()
    await press(buttonNamed('Review changes…'))
    expect(savedWrites(calls)).toEqual([])
    // The dialog is up, and it names both ids.
    expect(bodyText()).toContain(LAKE)
    expect(bodyText()).toContain(SAMPLE)
  })

  it('writes nothing when Pause is pressed', async () => {
    const { calls } = stubWorkspace({ saved: { [LAKE]: await stored(LAKE) } })
    await mount()
    await press(buttonNamed(rowActionName('pause', accelEntry(LAKE))))
    expect(savedWrites(calls)).toEqual([])
    expect(bodyText()).toContain('Yes, pause it')
  })

  it('writes nothing when Remove acceleration is pressed', async () => {
    const { calls } = stubWorkspace({ saved: { [LAKE]: await stored(LAKE) } })
    await mount()
    await press(buttonNamed('Remove acceleration…'))
    expect(savedWrites(calls)).toEqual([])
    expect(bodyText()).toContain(UNINSTALL_WARNING)
  })

  it('deletes nothing until the literal has been typed', async () => {
    // The type-to-confirm half. Pressing the confirm button with the box empty
    // must move focus to the field and send no request.
    const { calls } = stubWorkspace({ saved: { [LAKE]: await stored(LAKE) } })
    await mount()
    await press(buttonNamed('Remove acceleration…'))
    await press(buttonNamed('Yes, delete them'))
    expect(savedWrites(calls)).toEqual([])
    // …and the dialog says what has to happen first, rather than leaving a
    // button that quietly does nothing.
    expect(bodyText()).toContain(`That is not ${REMOVE_LITERAL}. Type it exactly to enable the button.`)
  })
})

describe('a confirmed write', () => {
  it('creates both scheduled searches, and nothing else', async () => {
    const { calls } = stubWorkspace({ lake: LAKE_30 })
    await mount()
    await press(buttonNamed('Review changes…'))
    await press(buttonNamed('Yes, create them'))
    await settle()
    const writes = savedWrites(calls)
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(MANIFEST.map(() => `POST ${SAVED}`))
    expect(writes.map((w) => w.body?.id).sort()).toEqual(MANIFEST.map((e) => e.id).sort())
  })

  it('pauses by sending the WHOLE body back, schedule and all', async () => {
    // A-SP23: a PATCH removes any field it omits and replaces `schedule`
    // wholesale, so a request carrying `{enabled}` unschedules the search it was
    // asked to pause. This is the assertion that would catch that.
    const { calls } = stubWorkspace({ saved: { [LAKE]: await stored(LAKE, { chartConfig: { type: 'bar' } }) } })
    await mount()
    await press(buttonNamed(rowActionName('pause', accelEntry(LAKE))))
    await press(buttonNamed('Yes, pause it'))
    await settle()
    const patch = savedWrites(calls).find((c) => c.method === 'PATCH')
    expect(patch, 'no PATCH was sent').toBeDefined()
    const schedule = patch?.body?.schedule as Record<string, unknown>
    expect(schedule.enabled).toBe(false)
    expect(schedule.cronSchedule).toBe(accelEntry(LAKE).cron)
    expect(schedule.tz).toBe('UTC')
    expect(schedule.keepLastN).toBe(accelEntry(LAKE).keepLastN)
    // …and the fields this app knows nothing about ride back out with it.
    expect(patch?.body?.chartConfig).toEqual({ type: 'bar' })
    expect(patch?.body?.query).toBe(accelEntry(LAKE).body)
  })

  it('tells the panels about a Pause the moment it lands, from the read the table already made', async () => {
    // Review 2026-09-24, defect 1: the dialog says the panels go live. They do
    // only if the read path hears about it — accel/serving.ts, fed here, with
    // no second read of the saved searches.
    // The sample, not the Lake total: this stub's Lake API answers 404, and a
    // Lake entry whose window could not be resolved has no body verdict at all
    // (`unknown` — provision.ts `windowUnresolved`), which is not this test.
    stubWorkspace({ saved: { [SAMPLE]: await stored(SAMPLE) } })
    await mount()
    expect(accelServing(SAMPLE)).toBe('scheduled')
    await press(buttonNamed(rowActionName('pause', accelEntry(SAMPLE))))
    await press(buttonNamed('Yes, pause it'))
    await settle()
    expect(accelServing(SAMPLE)).toBe('paused')
  })
})

describe('the preset list', () => {
  it('says why the second preset is unavailable, and keeps it reachable', async () => {
    // A disabled row that says nothing is broken UI. A `disabled` input is not
    // focusable and is not announced, so the reason — the only thing this row
    // carries — would never reach a keyboard or screen-reader user.
    stubWorkspace()
    await mount()
    const off = container.querySelector<HTMLInputElement>('.ac-preset-off input')
    expect(off).toBeDefined()
    expect(off?.getAttribute('aria-disabled')).toBe('true')
    expect(off?.hasAttribute('disabled')).toBe(false)
    const why = off?.getAttribute('aria-describedby')
    expect(why).toBeTruthy()
    // The reason stays visible and is the radio's description; the longer
    // explanation is the ⓘ beside the preset's name.
    expect(document.getElementById(why as string)?.textContent).toContain('Not available')
    expect(document.getElementById(why as string)?.textContent).toContain('JSON dataset')
    const tip = container.querySelector('.ac-preset-off .infotip')?.getAttribute('aria-label')
    expect(tip).toContain('more often than the live queries it replaces')
  })

  it('keeps one lead line on screen and the rest behind its ⓘ', async () => {
    // The declutter (2026-09-24) moved the intro's second half behind an ⓘ.
    // What must survive the move is the warning that the schedules outlive an
    // uninstall — reachable as the ⓘ's accessible name.
    stubWorkspace()
    await mount()
    expect(container.querySelector('.gs-intro')?.firstChild?.textContent).toBe(ACCEL_LEAD)
    const tip = container.querySelector('.gs-intro .infotip')?.getAttribute('aria-label')
    expect(tip).toBe(ACCEL_LEAD_TIP)
    expect(tip).toContain('uninstalling the app does not stop them')
  })

  it('leaves the unavailable preset unselected however hard it is clicked', async () => {
    stubWorkspace()
    await mount()
    const off = container.querySelector<HTMLInputElement>('.ac-preset-off input')
    await press(off as HTMLElement)
    expect(off?.checked).toBe(false)
  })
})

describe('the estimate on screen', () => {
  it('renders its provenance beside the figure, not behind an icon', async () => {
    // Every number here is a projection from twelve search jobs on one
    // workspace on one date. An explanation a customer has to discover is one
    // they can truthfully say they were never shown.
    stubWorkspace()
    await mount()
    const saving = estimateWorkspaceSaving()
    expect(bodyText()).toContain(saving.provenance)
    expect(bodyText()).toContain('assumed viewing frequency')
    for (const entry of saving.entries) expect(bodyText()).toContain(entry.what)
  })

  it('says how often each panel has to be looked at before it pays for itself', async () => {
    // The honest counterpart to a saving: a schedule bills whether or not
    // anybody opens the tab, so below the break-even it costs money. It is what
    // makes "turn it off" a supportable answer rather than an admission.
    stubWorkspace()
    await mount()
    expect(bodyText()).toContain('views a day it costs more than it saves')
  })
})

// ── The per-dashboard switches ──────────────────────────────────────────────

/** Every manifest entry, stored as this release would write it, with a field
 *  this app knows nothing about — and the named ones paused. */
async function everyEntry(paused: readonly string[] = []): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const e of MANIFEST) {
    const want = (await accelSavedSearch(accelEntry(e.id))) as unknown as Record<string, unknown>
    out[e.id] = {
      ...want,
      user: ME,
      displayUsername: 'me@example.com',
      chartConfig: { type: 'bar' },
      schedule: { ...(want.schedule as Record<string, unknown>), enabled: !paused.includes(e.id) },
    }
  }
  return out
}

const switchNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find((i) => i.getAttribute('aria-label') === name)
const dialog = () => document.body.querySelector('[role="dialog"]')

describe('the per-dashboard switches', () => {
  it('writes nothing on load, and reads each switch from the saved searches', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry(['gno_app_l4_c1h']) })
    await mount()
    expect(savedWrites(calls)).toEqual([])
    expect(switchNamed(switchName('tcp-health'))?.checked).toBe(true)
    // Capacity has one of its three paused: not on, and said in words.
    expect(switchNamed(switchName('capacity'))?.checked).toBe(false)
    expect(bodyText()).toContain('Mixed — 2 of 3 running')
    expect(switchNamed(switchName('master'))?.checked).toBe(false)
  })

  it('shows each switch’s cost as a charge AND a saving, never a bare figure', async () => {
    stubWorkspace({ saved: await everyEntry() })
    await mount()
    const state = document.getElementById(switchNamed(switchName('dns-health'))?.getAttribute('aria-describedby') ?? '')
    expect(state?.textContent).toMatch(/bills .*credits\/day · saves .*credits\/day/)
  })

  it('writes nothing when a switch is flipped, and the dialog names exactly the searches and the cost', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry() })
    await mount()
    await press(switchNamed(switchName('capacity')))
    expect(savedWrites(calls)).toEqual([])
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('gno_app_l4_c1h')
    expect(text).toContain('gno_talkers_src_c1h')
    // The shared scan is named as KEPT, and why — not as something paused.
    expect(text).toContain('Kept running: gno_overview_c1h')
    expect(text).toContain('Stops these schedules’ charge')
    expect(text).toContain('Yes, pause them')
    // No schedule the flip does not change is named as a resource.
    for (const e of MANIFEST.filter((x) => !['gno_app_l4_c1h', 'gno_talkers_src_c1h', 'gno_overview_c1h'].includes(x.id))) {
      expect(text).not.toContain(e.id)
    }
  })

  it('pauses exactly those searches once confirmed, each with its whole body', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry() })
    await mount()
    await press(switchNamed(switchName('capacity')))
    await press(buttonNamed('Yes, pause them'))
    await settle()
    const patches = savedWrites(calls)
    expect(patches.map((c) => `${c.method} ${c.path}`)).toEqual(
      ['gno_app_l4_c1h', 'gno_talkers_src_c1h'].map((id) => `PATCH ${SAVED}/${id}`),
    )
    for (const c of patches) {
      const id = c.path.slice(SAVED.length + 1) as 'gno_app_l4_c1h'
      expect(c.body?.schedule).toMatchObject({ enabled: false, cronSchedule: accelEntry(id).cron, tz: 'UTC', keepLastN: accelEntry(id).keepLastN })
      expect(c.body?.chartConfig).toEqual({ type: 'bar' })
      expect(c.body?.query).toBe(accelEntry(id).body)
    }
  })

  it('opens no dialog for a flip that would write nothing, and says why beside the switch', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry() })
    await mount()
    await press(switchNamed(switchName('findings')))
    expect(savedWrites(calls)).toEqual([])
    expect(dialog()).toBeNull()
    const state = await readAccelState()
    const why = toggleNothingWords(togglePlan(state, { kind: 'tab', tab: 'findings', on: false }))
    expect(why).toContain('gno_overview_c1h')
    expect(bodyText()).toContain(why as string)
  })

  it('the master switch names every search it will resume', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry(MANIFEST.map((e) => e.id)) })
    await mount()
    await press(switchNamed(switchName('master')))
    expect(savedWrites(calls)).toEqual([])
    const text = dialog()?.textContent ?? ''
    for (const e of MANIFEST) expect(text).toContain(e.id)
    expect(text).toContain('keeps no memory')
    expect(text).toContain('Yes, resume them')
  })

  // Review 2026-09-24, defect 1: one entry a release added and nobody applied
  // read the master as Mixed, and a Mixed master could only ask for on.
  it('the master switch still pauses everything when one entry was never created', async () => {
    const saved = await everyEntry()
    delete saved.gno_sample_2m_c1h
    const { calls } = stubWorkspace({ saved })
    await mount()
    expect(switchNamed(switchName('master'))?.checked).toBe(true)
    expect(bodyText()).toContain('1 not switchable here')
    await press(switchNamed(switchName('master')))
    expect(savedWrites(calls)).toEqual([])
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Yes, pause them')
    for (const e of MANIFEST.filter((x) => x.id !== 'gno_sample_2m_c1h')) expect(text).toContain(e.id)
    // Defect 4: the master's undo names the master switch, not "this tab".
    expect(text).toContain('Turning the master switch back on')
    expect(text).not.toContain('on this tab')
  })

  // Defect 3: a Mixed switch goes OFF, the cheaper direction.
  it('a Mixed tab flips off, pausing the rest, and never asks to resume first', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry(['gno_web_h2_c1h']) })
    await mount()
    await press(switchNamed(switchName('web-api')))
    expect(savedWrites(calls)).toEqual([])
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Yes, pause them')
    expect(text).not.toContain('Yes, resume them')
    for (const id of ['gno_web_host_c1h', 'gno_web_code_c1h', 'gno_web_trend_c1h']) expect(text).toContain(id)
    // Defect 4: the one paused before is named as one turning the tab back on resumes too.
    expect(text).toContain('gno_web_h2_c1h, which was already paused before this')
  })

  // Defect 5: a tab's line bills it only for what its switch alone decides.
  it('bills Findings nothing of its own and names the shared scan', async () => {
    stubWorkspace({ saved: await everyEntry() })
    await mount()
    const state = document.getElementById(switchNamed(switchName('findings'))?.getAttribute('aria-describedby') ?? '')
    expect(state?.textContent).toContain('no scheduled search of its own · shares gno_overview_c1h')
    expect(state?.textContent).not.toMatch(/bills/)
  })

  it('offers no switch write while it cannot read the saved-search list', async () => {
    const { calls } = stubWorkspace({ status: { [`GET ${SAVED}`]: 403 } })
    await mount()
    await press(switchNamed(switchName('master')))
    expect(dialog()).toBeNull()
    expect(savedWrites(calls)).toEqual([])
  })
})

// ── While only sample data exists ───────────────────────────────────────────
// Every schedule scans the customer's dataset, which is empty then. Nothing on
// this panel may offer to turn one ON, and the panel says why (owner decision,
// 2026-09-24). Off stays available: it is the state the rule asks for.
describe('while only sample data exists', () => {
  beforeEach(() => settleDatasetTarget(true))

  it('says why above the switches', async () => {
    stubWorkspace({ saved: await everyEntry(MANIFEST.map((e) => e.id)) })
    await mount()
    expect(bodyText()).toContain(SAMPLE_ACCEL_OFF)
  })

  it('an ON flip of the master opens no dialog, writes nothing, and says why beside it', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry(MANIFEST.map((e) => e.id)) })
    await mount()
    await press(switchNamed(switchName('master')))
    expect(dialog()).toBeNull()
    expect(savedWrites(calls)).toEqual([])
    expect(document.body.querySelector('.ac-switch-master .ac-switch-note')?.textContent).toBe(SAMPLE_ACCEL_OFF)
  })

  it('an ON flip of a tab opens no dialog either', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry(MANIFEST.map((e) => e.id)) })
    await mount()
    await press(switchNamed(switchName('dns-health')))
    expect(dialog()).toBeNull()
    expect(savedWrites(calls)).toEqual([])
  })

  it('an OFF flip still asks to pause', async () => {
    stubWorkspace({ saved: await everyEntry() })
    await mount()
    await press(switchNamed(switchName('master')))
    expect(dialog()?.textContent ?? '').toContain('Yes, pause them')
  })

  it('offers no Review changes, which would create them running', async () => {
    // Nothing created yet: Apply would have eighteen searches to write.
    stubWorkspace({})
    await mount()
    expect(buttonNamed('Review changes…')).toBeUndefined()
  })

  it('offers no Resume on a paused row', async () => {
    stubWorkspace({ saved: await everyEntry(MANIFEST.map((e) => e.id)) })
    await mount()
    expect(document.body.querySelector('button[aria-label^="Resume"]')).toBeNull()
    expect(bodyText()).toContain('Off: sample data only')
  })
})

// ── Before the dataset check has a final answer ─────────────────────────────
// Review 2026-09-24, defect 2. `sample` is false while the check is still out
// and in the provisional `deadline` state — neither is "real data exists". A
// control that turns schedules on must wait for a final answer, and a dialog
// opened before the answer turned out to be sample must not write after it.
describe('before the dataset check has a final answer', () => {
  /**
   * A workspace whose dataset check cannot finish: both datasets listed, no
   * size figure, and the one-record probe never answers — so the provisional
   * answer stays put. (The listing itself must answer: the panel's own read
   * resolves each schedule's window from it.)
   */
  function holdLakeListing(): void {
    const base = globalThis.fetch
    const listing = {
      items: [
        { id: 'gigamon_ami', retentionPeriodInDays: 30, metrics: {} },
        { id: 'gigamon_ami_sample', retentionPeriodInDays: 7, metrics: {} },
        { id: 'cribl_metrics', retentionPeriodInDays: 30, metrics: {} },
      ],
    }
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/lakes/default/datasets')) return Promise.resolve(response(200, listing))
      if ((init?.method ?? 'GET') === 'POST' && /\/search\/jobs$/.test(u)) return new Promise(() => {})
      return base(url, init)
    })
  }

  it('in the provisional state: no Review changes, no Resume, no ON flip — and it says why', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry(MANIFEST.map((e) => e.id)) })
    holdLakeListing()
    settleDatasetTarget(false, 'deadline')
    await mount()
    expect(document.body.querySelector('button[aria-label^="Resume"]')).toBeNull()
    await press(switchNamed(switchName('master')))
    expect(dialog()).toBeNull()
    expect(savedWrites(calls)).toEqual([])
    expect(document.body.querySelector('.ac-switch-master .ac-switch-note')?.textContent).toBe(ACCEL_UNVERIFIED_OFF)
    expect(bodyText()).toContain(ACCEL_UNVERIFIED_OFF)
    expect(bodyText()).not.toContain(SAMPLE_ACCEL_OFF)
  })

  it('in the provisional state: no Review changes on a workspace with nothing created', async () => {
    stubWorkspace({})
    holdLakeListing()
    settleDatasetTarget(false, 'deadline')
    await mount()
    expect(buttonNamed('Review changes…')).toBeUndefined()
  })

  it('a create dialog opened on real data writes nothing once the answer turns out to be sample', async () => {
    const { calls } = stubWorkspace({})
    await mount()
    await press(buttonNamed('Review changes…'))
    await act(async () => { settleDatasetTarget(true) })
    await press(buttonNamed('Yes, create them'))
    await settle()
    expect(savedWrites(calls)).toEqual([])
  })

  it('a resume-all dialog opened on real data writes nothing once the answer turns out to be sample', async () => {
    const { calls } = stubWorkspace({ saved: await everyEntry(MANIFEST.map((e) => e.id)) })
    await mount()
    await press(switchNamed(switchName('master')))
    expect(dialog()?.textContent ?? '').toContain('Yes, resume them')
    await act(async () => { settleDatasetTarget(true) })
    await press(buttonNamed('Yes, resume them'))
    await settle()
    expect(savedWrites(calls)).toEqual([])
  })

  it('a row Resume dialog opened on real data writes nothing once the answer turns out to be sample', async () => {
    const paused = await stored(LAKE)
    paused.schedule = { ...(paused.schedule as Record<string, unknown>), enabled: false }
    const { calls } = stubWorkspace({ saved: { [LAKE]: paused } })
    await mount()
    await press(buttonNamed(rowActionName('resume', accelEntry(LAKE))))
    await act(async () => { settleDatasetTarget(true) })
    await press(buttonNamed('Yes, resume it'))
    await settle()
    expect(savedWrites(calls)).toEqual([])
  })

  it('a pause dialog still pauses after the answer turns out to be sample — off is what the rule asks for', async () => {
    const { calls } = stubWorkspace({ saved: { [LAKE]: await stored(LAKE) } })
    await mount()
    await press(buttonNamed(rowActionName('pause', accelEntry(LAKE))))
    await act(async () => { settleDatasetTarget(true) })
    await press(buttonNamed('Yes, pause it'))
    await settle()
    expect(savedWrites(calls).map((c) => c.method)).toEqual(['PATCH'])
  })
})

describe('where this is mounted', () => {
  it('is rendered by the Guided Setup tab', async () => {
    // Phase 1 shipped a whole settings panel that nothing rendered, and nobody
    // noticed until a human opened the page. A component nothing mounts is not
    // a feature, and an import is the cheapest possible proof.
    const mod = await import('../tabs/GuidedSetup')
    expect(typeof mod.GuidedSetup).toBe('function')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src', 'tabs', 'GuidedSetup.tsx'), 'utf-8')
    expect(src).toContain("import { AccelPanel } from '../components/AccelPanel'")
    expect(src).toContain('<AccelPanel />')
  })
})

// ── What this file does NOT assert ──────────────────────────────────────────
//
//   * That focus is contained by either confirmation, or returned to the
//     trigger when one closes. happy-dom has no sequential focus navigation and
//     enforces nothing for `inert`; ConfirmDialog.test.tsx pins the mechanism
//     and says the same thing about its own limits.
//   * That the table is usable at phone width, or that any control meets a
//     minimum hit area. No layout is computed in this environment.
//   * That Cribl accepts the POST or the PATCH body. The stub takes whatever it
//     is handed; A-SP23 is a measurement this screen is built ON, not one any
//     test here re-proves. The first real Apply is a human's click in Preview.
//   * That a scheduled run's `correlationId` is the saved search's id — the one
//     unverified assumption the Health and Last run columns rest on. If it is
//     wrong, both columns say "Never run" for a search that is running fine,
//     which is the safe direction to be wrong in: nothing is ever shown as
//     fresher than it is.
//   * That the saving is real on a production tenant. Every figure in the
//     estimate is an extrapolation from one workspace's demo feed, which is why
//     the provenance is a return value of the module rather than a comment.
