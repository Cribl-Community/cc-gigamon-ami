// What the long-running-search screen promises, measured on the rendered DOM.
//
// THE ASSERTIONS THAT MATTER MOST ARE ABOUT WHAT IS *NOT* THERE. Three of them:
//
//   * a header that renders nothing when nothing is wrong. That is the whole
//     design argument (JobWatchdog.tsx's header), and it is one line away from
//     being undone by a well-meaning "all clear" chip;
//   * a header that does NOT render an all-clear when the poll was refused. Zero
//     rows from a 403 and zero rows from a quiet workspace are the same number,
//     and only one of them is good news;
//   * a cancel that has not happened. The dangerous failure here is not a broken
//     button, it is a button that works before anybody confirmed it — so the
//     test presses Cancel on a row and asserts that no POST left the app;
//   * a Cancel that is not OFFERED at all on a row that is not the viewer's, on
//     a row whose owner the platform did not name, and on any row at all once a
//     poll has failed. The app never stops work it did not start, and it never
//     acts on a list it has just said it cannot see.
//
// WHAT THIS ENVIRONMENT CANNOT BE ASKED, stated rather than faked, because a
// green tick that proves nothing is worse than a missing test:
//
//   * FOCUS CONTAINMENT. happy-dom has no sequential focus navigation — `Tab` is
//     a KeyboardEvent nothing interprets — and `inert` is stored as an attribute
//     that enforces nothing. So the `inert` assertion below is about the
//     MECHANISM being in the document, exactly as ConfirmDialog.test.tsx frames
//     the same limit, and it is explicitly not a claim that anything is blocked.
//   * WHETHER THE LIVE REGION IS SPOKEN. Nothing here has a screen reader. What
//     is asserted is the arrangement that makes announcement possible and whose
//     absence made the old toast stack silent: the region is in the document,
//     empty, before it ever carries a sentence.
//   * THAT THE HEADER COSTS NO LAYOUT WHEN SILENT. `display: contents` is a
//     stylesheet fact; happy-dom computes no layout. The test asserts the
//     element count, not the geometry.
//   * WHAT A NON-ADMIN'S JOB LIST ACTUALLY CONTAINS. That is V-S11, it needs a
//     real non-admin account on a real workspace, and no test can stand in for
//     it. What IS asserted is that the UI does not pretend to know: the coverage
//     note names what the list covers and claims nothing about what is missing
//     from it — and it is on screen in the EMPTY state too, which is the state a
//     role-scoped account is most likely to see.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { resetDenials } from '../cribl/authz'
import { checkNow, resetJobWatchdog, watchdogState, type HungJob, type WatchdogState } from '../cribl/jobWatchdog'
import { JobWatchdogIndicator, openWatchdogDrawer, resetWatchdogDrawer, useJobWatchdogBanner } from './JobWatchdog'
import {
  COVERAGE_NOTE,
  announcementFor,
  cancelOutcome,
  cancelUnavailable,
  elapsedInWords,
  formatElapsed,
  indicatorTone,
  ownerLabel,
  timeLimitLabel,
  windowLabel,
} from './jobWatchdogCopy'

const NOW = 1_789_600_000_000
const ME = 'auth0|me'
const THEM = 'auth0|user06'

/** A running job in the shape `GET /search/jobs?output=short` returns it. */
function running(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1789395843210.fxAzHG',
    type: 'standard',
    query: 'dataset="gigamon_ami" | summarize c=dcount(src_ip) by app_name',
    earliest: '-24h',
    latest: 'now',
    timeCreated: NOW - 19 * 3600_000,
    timeStarted: NOW - 19 * 3600_000,
    status: 'running',
    user: THEM,
    displayUsername: 'User 06',
    isPrivate: true,
    datasetIds: ['gigamon_ami'],
    ...over,
  }
}

/** A HungJob as the store hands one to a row, for the pure-function cases. */
function hung(over: Partial<HungJob> = {}): HungJob {
  return {
    id: '1789395843210.fxAzHG',
    owner: 'User 06',
    ownerId: THEM,
    mine: false,
    startedAt: NOW - 19 * 3600_000,
    startedAtIsCreation: false,
    elapsedMs: 19 * 3600_000,
    query: 'dataset="gigamon_ami" | limit 1',
    earliest: '-24h',
    latest: 'now',
    datasetIds: ['gigamon_ami'],
    type: 'standard',
    carriesRunningTimeCap: false,
    ...over,
  }
}

/** A WatchdogState for the pure-function cases. */
function state(over: Partial<WatchdogState> = {}): WatchdogState {
  return {
    jobs: [],
    otherDatasetsOverThreshold: 0,
    lastCheckedAt: NOW,
    lastAttemptAt: NOW,
    error: null,
    denied: false,
    checking: false,
    paused: false,
    thresholdSeconds: 1800,
    truncated: false,
    dismissedIds: [],
    idSetSeq: 0,
    ...over,
  }
}

interface Sent { url: string; method: string }

/** Stub the transport with a queue; the last response repeats. Returns what was sent. */
function stub(...responses: Array<{ status: number; body: unknown }>): Sent[] {
  const sent: Sent[] = []
  let i = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), method: String(init.method ?? 'GET') })
    const r = responses[Math.min(i++, responses.length - 1)]
    return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }
  })
  return sent
}

const list = (items: unknown[], totalCount = items.length) => ({
  status: 200,
  body: { items, count: items.length, offset: 0, limit: 200, totalCount },
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  // user.ts memoises the platform lookup for the life of the module, so the
  // signed-in identity is one value for this whole file. Fixtures pick a side by
  // their `user` field instead: THEM is a colleague's job, ME is one of ours.
  vi.stubGlobal('getCriblUser', async () => ({ id: ME, username: 'me' }))
  resetDenials()
  resetJobWatchdog()
  resetWatchdogDrawer()
  container = document.createElement('div')
  // Capra's Modal portals out of this element and marks it `inert`; two
  // assertions below are about elements outside it.
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetJobWatchdog()
  resetWatchdogDrawer()
  resetDenials()
})

/**
 * Let the environment run one turn. The poll, Capra's focus work and its `inert`
 * marking all land after the commit that triggered them.
 */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

/** Mount the header indicator with the context PanelInfo and the router need. */
async function mount() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <DashboardProvider>
          <JobWatchdogIndicator />
        </DashboardProvider>
      </MemoryRouter>,
    )
  })
  await settle()
}

const badge = () => container.querySelector<HTMLButtonElement>('.jw-badge')
const liveRegion = () => container.querySelector<HTMLElement>('[role="status"]')
/** Capra portals the drawer and the dialog to document.body, not into #root. */
const sheets = () => [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
const bodyText = () => document.body.textContent ?? ''

// ── The words ───────────────────────────────────────────────────────────────

describe('how long a job has been running', () => {
  it('reads as a table cell at every scale it can reach', () => {
    expect(formatElapsed(16 * 60_000)).toBe('16m')
    expect(formatElapsed(19 * 3600_000 + 4 * 60_000)).toBe('19h 4m')
    // Past a day the minutes are noise: the jobs this exists for ran 10.7 to
    // 19.1 hours and nobody reads the minute on a two-day-old job.
    expect(formatElapsed(50 * 3600_000)).toBe('2d 2h')
  })

  it('reads as prose in a sentence somebody reads once', () => {
    expect(elapsedInWords(16 * 60_000)).toBe('16 minutes')
    expect(elapsedInWords(19 * 3600_000 + 4 * 60_000)).toBe('19 hours')
    expect(elapsedInWords(50 * 3600_000)).toBe('2 days')
  })
})

describe('whose job it is, and whether there is a button for it', () => {
  it('says "you" for your own, and the name for somebody else’s', () => {
    expect(ownerLabel(hung({ mine: true }))).toBe('you')
    expect(ownerLabel(hung({ mine: false }))).toBe('User 06')
  })

  it('offers Cancel on your own row and on no other', () => {
    // THE SCOPE DECISION, in the one function both the row and the store read.
    // `mine: null` is the dev server and any platform build that names nobody:
    // "someone else's" is a claim, and so is "yours" — only `true` is evidence,
    // and cancelling on anything less ends work this app did not start.
    expect(cancelUnavailable(state(), hung({ mine: true }))).toBeNull()
    expect(cancelUnavailable(state(), hung({ mine: false }))).toBe('Not yours')
    expect(cancelUnavailable(state(), hung({ mine: null }))).toBe('Owner unknown')
  })

  it('withdraws it from every row once a poll has failed', () => {
    // Including your own: the row is from the last poll that worked, and the
    // watch has since said it cannot see. Acting on that is the same lie as a
    // header that keeps counting.
    expect(cancelUnavailable(state({ error: 'refused' }), hung({ mine: true }))).toBe('Unverified')
  })
})

describe('which population a row is', () => {
  it('separates a query that escaped this app’s own limit from one that never had one', () => {
    // Two different defects wearing the same badge: ours means the cap failed
    // and is worth reporting to Cribl; theirs means the query came from the
    // Search UI, a deep link or Copilot, none of which cap anything.
    expect(timeLimitLabel(hung({ carriesRunningTimeCap: true }))).toBe('Capped, still running')
    expect(timeLimitLabel(hung({ type: 'agentic' }))).toBe('Uncapped · Copilot')
    expect(timeLimitLabel(hung({ type: 'scheduled' }))).toBe('Uncapped · scheduled')
    expect(timeLimitLabel(hung())).toBe('Uncapped')
  })

  it('shows the window the query reads, which is what makes a row alarming or not', () => {
    // A -30d ad-hoc search running for hours explains itself. A -15m search
    // doing the same does not, and that is the row to look at first.
    expect(windowLabel(hung({ earliest: '-15m', latest: 'now' }))).toBe('-15m → now')
    expect(windowLabel(hung({ earliest: null, latest: null }))).toBe('not recorded')
  })
})

describe('what the app says it can see', () => {
  it('names what the list covers without claiming to know what it cannot see', () => {
    // The honest version of the deleted "can this account see other people's
    // jobs" probe. Every job this app creates is isPrivate:true and the only
    // accounts this was ever tried on were admins, so a list with nobody else's
    // jobs in it may be a quiet workspace or may be a role that shows you only
    // your own — and the app cannot tell which, which is what it says.
    expect(COVERAGE_NOTE).toContain('your Cribl role lets this app see')
    expect(COVERAGE_NOTE).toContain('cannot tell you which one this is')
    expect(COVERAGE_NOTE).toContain('never stops work it did not start')
    // The promise that was withdrawn with the wide cancel. Nothing here may
    // offer a view of everyone's searches, because nothing can honour it.
    expect(COVERAGE_NOTE).not.toContain('everyone')
  })
})

describe('what a cancel reports', () => {
  it('quotes the status Cribl reported when it worked', () => {
    const p = cancelOutcome(hung(), { ok: true, declined: null, httpStatus: 200, reportedStatus: 'canceled', detail: null })
    expect(p.kind).toBe('done')
    expect(p.text).toContain('canceled')
  })

  it('quotes the HTTP status when Cribl refused, and says it is still running', () => {
    const p = cancelOutcome(hung(), { ok: false, declined: null, httpStatus: 403, reportedStatus: null, detail: 'Not authorized' })
    // `error` is the one Toast.tsx renders with role="alert" and no auto-dismiss
    // — the job is still running and still billing, which is not something to
    // let slide off the screen after five seconds.
    expect(p.kind).toBe('error')
    expect(p.text).toContain('403')
    expect(p.text).toContain('still running')
  })

  it('does not quote a status of 0 when the request never reached Cribl', () => {
    const p = cancelOutcome(hung(), { ok: false, declined: null, httpStatus: 0, reportedStatus: null, detail: 'network down' })
    expect(p.text).not.toContain('answered 0')
    expect(p.text).toContain('network down')
  })

  it('tells the truth about a job that had already stopped', () => {
    // THE DEFECT THIS PINS. A cancel correctly declined because the job is no
    // longer listed used to be reported as “…nothing was cancelled.. It is still
    // running.” — the opposite of what happened, with a stray second full stop,
    // as an `error`, which Toast.tsx gives role="alert" and never dismisses. The
    // search the person wanted stopped IS stopped.
    const p = cancelOutcome(hung(), { ok: false, declined: 'gone', httpStatus: 0, reportedStatus: null, detail: null })
    expect(p.text).toContain('no longer running')
    expect(p.text).toContain('already been cancelled')
    expect(p.text, 'it told the customer the opposite of what happened').not.toContain('still running')
    expect(p.text, 'a second full stop from an interpolated sentence').not.toContain('..')
    expect(p.kind, 'a job that has finished is not an alert that has to be dismissed').toBe('done')
  })

  it('says nothing was sent when it declined, and why', () => {
    const notMine = cancelOutcome(hung(), { ok: false, declined: 'not-yours', httpStatus: 0, reportedStatus: null, detail: null })
    expect(notMine.kind).toBe('error')
    expect(notMine.text).toContain('only cancels searches you started')
    expect(notMine.text).toContain('User 06')

    const stale = cancelOutcome(hung(), { ok: false, declined: 'unverified', httpStatus: 0, reportedStatus: null, detail: null })
    expect(stale.text).toContain('Check again')
    // Neither of them quotes a status: nothing was sent, and "Cribl answered 0"
    // is a sentence about a request that was never made.
    for (const p of [notMine, stale]) expect(p.text).not.toContain('answered')
  })
})

// ── The header ──────────────────────────────────────────────────────────────

describe('the header indicator', () => {
  it('has nothing to say when nothing is wrong, and says nothing', async () => {
    stub(list([]))
    await mount()
    await settle()

    expect(indicatorTone(watchdogState())).toBeNull()
    // The whole design argument, pinned: an ambient indicator that is healthy
    // 364 days a year is decoration, and the eye learns to skip exactly the spot
    // the warning has to appear in.
    expect(badge(), 'the header grew an all-clear chip').toBeNull()
    expect(sheets(), 'a drawer was mounted with nothing to put in it').toHaveLength(0)
  })

  it('does not read a refused poll as an all-clear', async () => {
    stub({ status: 403, body: { message: 'Not authorized or licensed to perform this action.' } })
    await mount()
    await settle()

    // Zero rows, and the opposite of good news. This is the failure the store's
    // own header warns about — a caller rendering jobs.length without error.
    expect(watchdogState().jobs).toHaveLength(0)
    expect(indicatorTone(watchdogState())).toBe('blind')
    const b = badge()
    expect(b, 'a refusal rendered as silence').toBeTruthy()
    expect(b!.className).toContain('jw-badge-blind')
    expect(b!.getAttribute('aria-label')).toContain('could not check')
  })

  it('counts the long-running searches, and names them in the accessible name', async () => {
    stub(list([running(), running({ id: 'second', timeStarted: NOW - 3 * 3600_000 })]))
    await mount()
    await settle()

    const b = badge()
    expect(b!.textContent).toContain('2 long-running searches')
    // The visible text is a count; the accessible name is the sentence, with
    // the threshold in it, because "2" on its own is not a state.
    expect(b!.getAttribute('aria-label')).toContain('30 minutes')
  })

  it('stops asserting a count the moment it can no longer check', async () => {
    // THE DEFECT THIS PINS, and it is the attacker's own repro: poll 1 returns a
    // nineteen-hour job, poll 2 is refused. `indicatorTone` read `jobs.length`
    // before `error`, so the header went on saying "1 long-running search" from
    // a poll that had already been contradicted — and `blind`, which exists for
    // exactly this, could only ever win on a workspace where nothing was wrong.
    stub(list([running()]), { status: 403, body: { message: 'Not authorized.' } })
    await mount()
    await settle()
    expect(badge()!.textContent).toContain('1 long-running search')

    await act(async () => { await checkNow() })
    await settle()

    expect(watchdogState().jobs, 'the rows themselves are kept, for the drawer to date').toHaveLength(1)
    expect(indicatorTone(watchdogState())).toBe('blind')
    const b = badge()!
    expect(b.className).toContain('jw-badge-blind')
    expect(b.textContent, 'a count from the last good poll, presented as now').not.toContain('1 long-running search')
    expect(b.textContent).toContain('Search watch unavailable')
  })
})

describe('announcements', () => {
  it('mounts the live region empty, before it has anything to say', async () => {
    stub(list([]))
    await mount()

    const region = liveRegion()
    // The bug slice 1.6 found in the old toast stack: a live region that enters
    // the DOM already holding its first message is commonly not announced at
    // all, because there was no region for assistive technology to be watching
    // when the content "changed".
    expect(region, 'there is no live region for a sentence to arrive in').toBeTruthy()
    expect(region!.textContent).toBe('')
  })

  it('speaks once when the set of running jobs changes', async () => {
    stub(list([running()]))
    await mount()
    await settle()

    expect(liveRegion()!.textContent).toContain('1 search')
    expect(liveRegion()!.textContent).toContain('30 minutes')
  })

  it('says nothing at all when the first poll finds nothing', async () => {
    // idSetSeq stays at 0 when an empty list follows an empty list, so a healthy
    // workspace never announces its own health on load.
    stub(list([]))
    await mount()
    await settle()
    expect(liveRegion()!.textContent).toBe('')
  })

  it('does not repeat itself while the same job goes on running', async () => {
    stub(list([running()]))
    await mount()
    await settle()
    const spoken = liveRegion()!.textContent

    await act(async () => { await checkNow() })
    await settle()

    // A colleague's nineteen-hour job would otherwise interrupt somebody twelve
    // times an hour to say it is still there. The text is identical, so an
    // aria-live region has nothing new to read.
    expect(liveRegion()!.textContent).toBe(spoken)
  })

  it('states the count and the threshold and nothing about whose it is', () => {
    // Deliberate: a name or a query in the live region is somebody else's work
    // read aloud on a timer.
    const said = announcementFor(state({ jobs: [hung()], idSetSeq: 1 }))
    expect(said).toContain('1 search')
    expect(said).not.toContain('User 06')
    // It names both datasets the watch lists, the Parquet copy included.
    expect(said).toContain('of gigamon_ami or gigamon_ami_pq')
    expect(announcementFor(state({ jobs: [] }))).toContain('No search of gigamon_ami or gigamon_ami_pq')
  })
})

// ── The drawer ──────────────────────────────────────────────────────────────

/** Open the drawer from the badge. */
async function openDrawer() {
  await act(async () => { badge()!.click() })
  await settle()
}

describe('the drawer', () => {
  it('lists each job with the columns that carry the argument', async () => {
    stub(list([running({ carriesRunningTimeCap: false })]))
    await mount()
    await settle()
    await openDrawer()

    const table = document.body.querySelector('table.dtable')
    expect(table, 'the drawer did not use the one data table').toBeTruthy()
    // The `.dtable` contract: a caption naming what the table lists, scope on
    // every column head, and scope="row" on the cell a reader quotes back.
    expect(table!.querySelector('caption.sr-only')!.textContent).toContain('gigamon_ami')
    expect([...table!.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Search', 'Running for', 'Owner', 'Reads', 'Time limit', 'Action',
    ])
    expect(table!.querySelectorAll('thead th[scope="col"]')).toHaveLength(6)
    const idCell = table!.querySelector('tbody th[scope="row"]')
    expect(idCell!.textContent).toBe('1789395843210.fxAzHG')

    const row = table!.querySelector('tbody tr')!
    expect(row.textContent).toContain('19h 0m')
    expect(row.textContent).toContain('User 06')
    expect(row.textContent).toContain('-24h → now')
    expect(row.textContent).toContain('Uncapped')
  })

  it('puts somebody else’s query behind a control, not in a title attribute', async () => {
    stub(list([running()]))
    await mount()
    await settle()
    await openDrawer()

    const details = document.body.querySelector('details')
    expect(details, 'the query was not behind a disclosure').toBeTruthy()
    expect(details!.querySelector('pre')!.textContent).toContain('dcount(src_ip)')
    // A `title=` is unreachable by keyboard and unreadable by touch, and this is
    // the cell most likely to be given one.
    expect(document.body.querySelector('.jw-query[title]')).toBeNull()
  })

  it('says the empty state rather than an empty table', async () => {
    stub({ status: 403, body: { message: 'no' } })
    await mount()
    await settle()
    await openDrawer()

    // Reached through the `blind` badge, so the drawer has to hold the refusal —
    // and it must not also claim nothing is running.
    expect(bodyText()).toContain('cannot list Cribl Search jobs')
    expect(bodyText()).not.toContain('No search has been running longer')
    // Nor may it describe what the list covers, because on this poll it covers
    // nothing at all.
    expect(bodyText()).not.toContain('your Cribl role lets this app see')
  })

  it('says what the list covers even when the list is empty', async () => {
    // THE SILENT CASE. A Cribl role scoped to your own searches answers a 200
    // with zero rows, not a 403 — so `error` is null, nothing is wrong as far as
    // this app can see, and the drawer used to render one line saying no search
    // is running. To the account being shown least, silence reads as an
    // all-clear. There is no badge in this state either, so the drawer is
    // reached the way the banner reaches it.
    stub(list([]))
    await mount()
    await settle()
    expect(badge(), 'nothing is wrong, so the header says nothing').toBeNull()
    await act(async () => { openWatchdogDrawer() })
    await settle()

    expect(bodyText()).toContain('No search has been running longer')
    expect(bodyText()).toContain(COVERAGE_NOTE)
  })

  it('keeps the rows of a poll that failed, dated, and takes their Cancel away', async () => {
    // The other half of the header's blindness: the rows stay — they are the
    // last thing this app actually saw, and a hung job does not stop being worth
    // knowing about because a poll was refused — but nothing in the table is
    // actionable any more, and the note above it says the list is not current.
    stub(list([running({ user: ME })]), { status: 403, body: { message: 'no' } })
    await mount()
    await settle()
    await openDrawer()
    expect(cancelRow(), 'the row was the viewer’s own, so it starts with a button').toBeTruthy()

    await act(async () => { await checkNow() })
    await settle()

    expect(document.body.querySelector('table.dtable'), 'the rows were thrown away').toBeTruthy()
    expect(cancelRow(), 'a live Cancel on a row the watch can no longer see').toBeUndefined()
    expect(bodyText()).toContain('Unverified')
    expect(bodyText()).toContain('Nothing below is current')
  })

  it('names the watch’s own cost, in the one place a curious reader looks', async () => {
    stub(list([running()]))
    await mount()
    await settle()
    await openDrawer()

    const info = document.body.querySelector<HTMLButtonElement>('.pinfo-btn')
    expect(info!.getAttribute('aria-label')).toContain('costs')
    await act(async () => { info!.click() })
    // An app about recurring spend does not get to have one unexplained
    // recurring read of its own.
    expect(bodyText()).toContain('bills nothing')
    expect(bodyText()).toContain('0 billable CPU-seconds')
  })
})

// ── Cancel ──────────────────────────────────────────────────────────────────

const cancelRow = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Cancel search'))

describe('cancelling a long-running search of your own', () => {
  it('offers Cancel on your own row and a reason on everybody else’s', async () => {
    // THE SCOPE DECISION, on the rendered table. The list is as wide as the
    // account can see — that is the point, the ten jobs that opened this plan
    // were not one person's — and the button is not: cancelling a colleague's
    // search destroys work in progress whose value cannot be seen from here.
    stub(list([running({ id: 'mine', user: ME }), running({ id: 'theirs', timeStarted: NOW - 3 * 3600_000 })]))
    await mount()
    await settle()
    await openDrawer()

    const rows = [...document.body.querySelectorAll('tbody tr')]
    const byId = (id: string) => rows.find((r) => r.querySelector('th')?.textContent === id)!
    expect(byId('theirs').textContent, 'a colleague’s row is listed, and says whose it is').toContain('User 06')
    expect(byId('theirs').querySelector('button'), 'a Cancel on somebody else’s search').toBeNull()
    expect(byId('theirs').textContent).toContain('Not yours')
    expect(byId('mine').querySelector('button')!.textContent).toBe('Cancel…')
    // Never a disabled button: it drops out of the keyboard order and announces
    // as unavailable without ever saying why.
    expect(document.body.querySelectorAll('tbody button[disabled]')).toHaveLength(0)
  })

  it('carries the job and its age in the control’s accessible name', async () => {
    stub(list([running({ user: ME })]))
    await mount()
    await settle()
    await openDrawer()

    const b = cancelRow()!
    // The visible label stays one word; "Cancel" on its own is not an
    // announcement of a control that discards nineteen hours of work.
    expect(b.textContent).toBe('Cancel…')
    expect(b.getAttribute('aria-label')).toBe(
      'Cancel search 1789395843210.fxAzHG, running for 19 hours, started by you',
    )
  })

  it('sends nothing until the confirmation is accepted', async () => {
    const sent = stub(list([running({ user: ME })]))
    await mount()
    await settle()
    await openDrawer()
    const before = sent.length

    await act(async () => { cancelRow()!.click() })
    await settle()

    // The failure that matters is not a broken button, it is a working one: a
    // row click that cancelled a colleague's nineteen-hour investigation with no
    // confirmation in between.
    expect(sent.slice(before).filter((s) => s.method === 'POST'), 'a click on the row cancelled the job').toEqual([])
    expect(bodyText()).toContain('This cannot be undone.')
  })

  it('names the age and what cannot be measured, in the confirmation itself', async () => {
    stub(list([running({ user: ME })]))
    await mount()
    await settle()
    await openDrawer()
    await act(async () => { cancelRow()!.click() })
    await settle()

    const dialog = sheets().find((d) => (d.textContent ?? '').includes('This cannot be undone.'))!
    // Ownership is settled before this dialog opens, so what it argues from is
    // the age: every row here is past the threshold, and the ones it was built
    // for had been running for hours.
    expect(dialog.textContent).toContain('19 hours')
    // The word beside the object is `stop`, not `delete`: a cancelled job moves
    // to `canceled` and stays in the search history where its owner can find it.
    expect(dialog.textContent).toContain('stop')
    expect(dialog.textContent).not.toContain('delete')
    // The replacement for the credits column §1.8 asked for, said out loud
    // rather than left as a blank cell.
    expect(dialog.textContent).toContain('0 billable')
  })

  it('holds the drawer inert while the confirmation is up', async () => {
    stub(list([running({ user: ME })]))
    await mount()
    await settle()
    await openDrawer()
    const sheet = sheets()[0]
    expect(sheet.hasAttribute('inert')).toBe(false)

    await act(async () => { cancelRow()!.click() })
    await settle()

    // The MECHANISM, not a claim that anything is blocked: happy-dom stores
    // `inert` and enforces nothing, and the reason it is here at all is that
    // Capra's Modal marks `#root` inert but the drawer is portalled OUTSIDE
    // `#root`, so without this the page behind the dialog is inert and the
    // drawer behind it is not.
    expect(sheet.getAttribute('inert')).toBe('')
    expect(container.hasAttribute('inert'), 'Capra stopped marking the page inert').toBe(true)
  })

  it('performs the cancel through the gate that names the write', async () => {
    const sent = stub(
      list([running({ user: ME })]),
      { status: 200, body: { items: [{ id: '1789395843210.fxAzHG', status: 'canceled' }] } },
      list([]),
    )
    await mount()
    await settle()
    await openDrawer()
    await act(async () => { cancelRow()!.click() })
    await settle()

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Cancel this search')!
    await act(async () => { confirm.click() })
    await settle()

    const post = sent.find((s) => s.method === 'POST')
    expect(post, 'the confirmed cancel never reached Cribl').toBeTruthy()
    expect(post!.url).toContain('/search/jobs/1789395843210.fxAzHG/cancel')
    // And the row goes at once rather than sitting there for five minutes
    // looking as though the cancel did nothing.
    expect(watchdogState().jobs).toEqual([])
  })
})

// ── The banner ──────────────────────────────────────────────────────────────

/** The one escalation the watch has, read through the hook that produces it. */
function BannerProbe() {
  const banner = useJobWatchdogBanner()
  return <p className="probe">{banner ? banner.title : 'no banner'}</p>
}

async function mountBanner() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <DashboardProvider>
          <BannerProbe />
        </DashboardProvider>
      </MemoryRouter>,
    )
  })
  await settle()
}

const probe = () => container.querySelector('.probe')!.textContent

describe('the banner for a long-running search of the viewer’s own', () => {
  it('escalates one of yours, and never a colleague’s', async () => {
    stub(list([running({ id: 'theirs' }), running({ id: 'mine', user: ME, timeStarted: NOW - 2 * 3600_000 })]))
    await mountBanner()
    await settle()
    // The one escalation left of the three S9 specifies, and it fires on the
    // sharper trigger: a hung search of your own is yours to fix.
    expect(probe()).toContain('1 search of yours')
  })

  it('says nothing once the watch has gone blind', async () => {
    // The loudest surface in the app, claiming a search of yours is running
    // RIGHT NOW on the strength of a poll that has since been contradicted. The
    // header can go `blind` and the drawer can date its rows; a banner has no
    // honest version of itself, so it goes.
    stub(list([running({ user: ME })]), { status: 403, body: { message: 'no' } })
    await mountBanner()
    await settle()
    expect(probe()).toContain('1 search of yours')

    await act(async () => { await checkNow() })
    await settle()

    expect(watchdogState().jobs, 'the rows are still there — this is about the claim, not the data').toHaveLength(1)
    expect(probe()).toBe('no banner')
  })
})
