// One tab, two windows — and whether the tab says so.
//
// Phase 2 decoupled the "In feed" field list from the global range picker: it
// reads an hourly scheduled sample of a settled two minutes, while the AMI
// coverage counts on the other two views still answer for whatever the picker
// says. That is the kind of change a user discovers by changing the range,
// seeing nothing move, and concluding the app is broken — so these tests are
// mostly about what the tab TELLS them, not about the numbers.
//
// The four claims:
//
//   1. A LIST FROM A STORED RUN CARRIES THE TIME IT WAS SAMPLED. Every other
//      panel answers for the picker's window; this one does not, and a schedule
//      that stopped firing leaves a plausible field list on screen forever.
//   2. THE PICKER DOES NOT RE-RUN THE SAMPLE — and still re-runs the coverage
//      counts, which is the half that would be a regression if it broke.
//   3. "Run live" PUTS THE LIST BACK ON THE PICKER'S WINDOW, at the price of a
//      full scan, and says which window it is now sampling.
//   4. A FAILED FAST READ PUTS NONE OF CRIBL'S WORDS ON SCREEN. accel/read.ts
//      refuses to forward them; this is the assertion that the tab does not
//      reintroduce them.
//
// The network is stubbed at `fetch` and everything else is real — the hook, the
// read path, search.ts — because "which job did this tab submit, and over which
// window" is the whole question.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider, TIME_RANGES, useDashboard, type TimeRange } from '../app/DashboardContext'
import { accelEntry } from '../cribl/accel/manifest'
import { resetSelectedSnapshot, setSelectedSnapshot } from '../cribl/accel/selection'
import { resetSnapshotCensus, useSnapshotCensus, type SnapshotCensus } from '../components/snapshotCensus'
import type { FieldSummary } from '../cribl/search'
import { FieldExplorer, SAMPLE_CADENCE, feedComputed, sampleNote } from './FieldExplorer'

const SAMPLE = 'gno_sample_2m_c1h'
const PRESENCE = 'gno_presence_c1h'
const HOUR = 3_600_000
const NOW = Date.now()

const field = (name: string, over: Partial<FieldSummary> = {}): FieldSummary => ({
  name,
  type: 'string',
  count: 5000,
  countDistinct: 42,
  countNull: 0,
  topValues: [{ value: 'x', count: 5000 }],
  ...over,
})

/** What the stored run's summaries look like: the feed's own fields, plus the
 *  virtual column that names the run they came from. */
const STORED_FIELDS: FieldSummary[] = [
  field('src_ip'),
  field('dns_host'),
  field('jobId', { countDistinct: 1, topValues: [{ value: 'run-1', count: 5000 }] }),
]
/** A live run has no virtual columns and — deliberately — a different field, so
 *  which path answered is visible in the list itself. */
const LIVE_FIELDS: FieldSummary[] = [field('src_ip'), field('http_host')]

const run = (over: Record<string, unknown> = {}) => ({
  // `<savedSearchId>.<suffix>` — the shape the platform emits, and what
  // listRuns selects a schedule’s runs by. Measured live 2026-09-18.
  id: `${SAMPLE}.run-1`,
  status: 'completed',
  timeCreated: NOW - HOUR,
  timeStarted: NOW - HOUR,
  timeCompleted: NOW - HOUR,
  ...over,
})

interface Submitted {
  query: string
  earliest: string
  latest: string
}

function res(status: number, body: unknown, asText?: string) {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => body,
    text: async () => asText ?? JSON.stringify(body),
  }
}

let submits: Submitted[] = []
let urls: string[] = []

function stub(cfg: { storedFail?: { status: number; body: unknown }; history?: unknown[]; stored?: FieldSummary[] } = {}): void {
  submits = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    urls.push(u)
    if ((init.method ?? 'GET') === 'POST' && u.endsWith('/search/jobs')) {
      const body = JSON.parse(String(init.body)) as Submitted
      submits.push(body)
      if (body.query.includes('$vt_results')) {
        return cfg.storedFail ? res(cfg.storedFail.status, cfg.storedFail.body) : res(200, { items: [{ id: 'job-stored' }] })
      }
      return res(200, { items: [{ id: body.query.includes('summarize c0=') ? 'job-presence' : 'job-live' }] })
    }
    if (u.includes('/status')) return res(200, { items: [{ status: 'completed' }] })
    if (u.includes('/field-summaries')) {
      return res(200, { fields: u.includes('job-stored') ? (cfg.stored ?? STORED_FIELDS) : LIVE_FIELDS })
    }
    if (u.includes('/results')) {
      // A CHOSEN MOMENT READS THE ARTIFACT, NOT `$vt_results`. That virtual
      // table returns only the NEWEST run (measured 2026-09-21), so
      // accel/read.ts GETs `/search/jobs/<runId>/results` for a past one.
      // The SAMPLE's artifact is raw event ROWS, which the app summarises
      // itself — serving the presence row here would have summarised into
      // c0…c95 and the panel would have rendered the wrong field list
      // without anything failing.
      if (u.includes(SAMPLE + '.')) {
        const names = (cfg.stored ?? STORED_FIELDS).map((f) => f.name)
        const one = Object.fromEntries(names.map((n) => [n, n === 'jobId' ? 'run-1' : 'v-' + n]))
        return res(200, {}, [JSON.stringify({ totalEventCount: 1, job: 'j' }), JSON.stringify(one)].join(String.fromCharCode(10)))
      }
      // The presence query: one row of per-field counts, all present.
      const row: Record<string, number> = {}
      for (let i = 0; i < 96; i++) row[`c${i}`] = 10
      return res(200, {}, [JSON.stringify({ totalEventCount: 1, job: 'j' }), JSON.stringify(row)].join('\n'))
    }
    if (u.includes('/search/jobs?')) return res(200, { items: cfg.history ?? [run()] })
    const byId = /\/search\/jobs\/([^/?]+)$/.exec(u)
    if (byId) return byId[1] === 'run-1' ? res(200, { items: [run()] }) : res(404, { message: 'gone' })
    return res(404, { message: 'unrouted' })
  })
}

// Scoped to the SAMPLE's own entry. This used to be every `$vt_results` read on
// the tab, which was the same set while the sample was the only served view —
// the coverage counts are served by gno_presence_c1h now, so an unscoped filter
// counts both and reports the sample as re-read when it was not.
const sampleSubmits = () => submits.filter((s) => s.query.includes('$vt_results') && s.query.includes(SAMPLE))
const storedPresenceSubmits = () => submits.filter((s) => s.query.includes('$vt_results') && s.query.includes(PRESENCE))
const liveSampleSubmits = () => submits.filter((s) => s.query.includes('| limit 5000') && !s.query.includes('$vt_results'))
const presenceSubmits = () => submits.filter((s) => s.query.includes('summarize c0='))

let container: HTMLDivElement
let root: Root
let setRange: ((r: TimeRange) => void) | null = null
let census: SnapshotCensus | null = null

/** Reaches the page's range picker without rendering the app header. */
function Picker() {
  setRange = useDashboard().setRange
  census = useSnapshotCensus()
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setRange = null
  census = null
  resetSelectedSnapshot()
  resetSnapshotCensus()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  resetSelectedSnapshot()
  resetSnapshotCensus()
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/field-explorer?view=feed']}>
        <DashboardProvider>
          <Picker />
          <FieldExplorer />
        </DashboardProvider>
      </MemoryRouter>,
    )
  })
  await settle()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve() })
}

const note = () => container.querySelector('.panel-note')?.textContent ?? ''
// The panel header's own source caption — <Panel> renders it from the `snapshot`
// prop, through the same `snapshotNote` every other panel in the app uses. The
// clock that used to live in `.panel-note` is here now, which is why these two
// are asserted separately rather than against `container.textContent`: a test
// that could not tell them apart would pass with the caption missing entirely.
const sourceNote = () => container.querySelector('.snap-note')?.textContent ?? ''
const fieldNames = () => [...container.querySelectorAll('.fe-name')].map((n) => n.textContent)
const runLive = () => [...container.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent?.includes('Run live') || b.textContent?.includes('back to hourly'))!

describe('the “In feed” list, served by the schedule', () => {
  it('says when the sample was taken, and how many rows it holds', async () => {
    stub()
    await render()

    expect(sourceNote(), 'the field list carries no time, so a dead schedule is invisible').toMatch(/snapshot \d{2}:\d{2}/)
    expect(note(), 'the note no longer says which sample this is').toContain('hourly sample')
    expect(note()).toContain('(5,000 rows)')
  })

  it('shows the stored run’s fields and never lists a virtual column as one of them', async () => {
    // `jobId` is not a field arriving in the customer's network telemetry.
    stub()
    await render()
    expect(fieldNames()).toContain('dns_host')
    expect(fieldNames()).not.toContain('jobId')
  })

  it('re-runs neither view when the range picker moves', async () => {
    // CHANGED 2026-09-18, and this used to assert the opposite for the coverage
    // counts: "does not re-run when the range picker moves — and the coverage
    // counts still do". That was correct while the sample was served and the
    // counts were not — Phase 2's "one tab, two windows" state, which the tab's
    // own copy explained to the reader.
    //
    // The counts are served now too (gno_presence_c1h), so while acceleration is
    // on a range change cannot affect EITHER, and re-running would submit jobs
    // to receive identical stored rows. The live 187.6–354.8 CPU-s presence scan
    // per range change is the thing this now saves.
    stub()
    await render()
    expect(sampleSubmits()).toHaveLength(1)
    expect(presenceSubmits()).toHaveLength(1)
    // The coverage counts ask the schedule FIRST now, which is the whole point.
    // This stub holds no run for that entry, so the read falls through to the
    // live scan counted above; with a run stored, that live scan never happens.
    expect(
      storedPresenceSubmits().length,
      'the coverage counts never asked the schedule',
    ).toBeGreaterThan(0)

    await act(async () => { setRange!(TIME_RANGES[5]) })
    await settle()

    expect(sampleSubmits(), 'a range change re-read a sample the picker cannot affect').toHaveLength(1)
    expect(liveSampleSubmits(), 'a range change spent a live 754.9 CPU-s sample').toEqual([])
    expect(presenceSubmits(), 'a range change re-read counts the picker cannot affect').toHaveLength(1)
  })

  it('tells the reader which control the range applies to', async () => {
    stub()
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('the time range above changes neither of them')
    expect(text).toContain('AMI coverage counts')
  })
})

describe('Run live', () => {
  it('re-runs the sample over the picker’s window and says so', async () => {
    stub()
    await render()
    expect(liveSampleSubmits()).toEqual([])

    await act(async () => { runLive().click() })
    await settle()

    const live = liveSampleSubmits()
    expect(live, 'pressing Run live ran nothing').toHaveLength(1)
    expect(live[0].earliest, 'Run live sampled something other than the window on screen').toBe(TIME_RANGES[1].earliest)
    expect(note()).toContain('live sample · last 15 minutes')
    expect(fieldNames()).toContain('http_host')
  })

  it('goes back to the stored sample when pressed again', async () => {
    stub()
    await render()
    await act(async () => { runLive().click() })
    await settle()
    await act(async () => { runLive().click() })
    await settle()

    expect(sourceNote(), 'back on the stored sample, and the header stopped dating it').toMatch(/snapshot \d{2}:\d{2}/)
    expect(note()).toContain('hourly sample')
    expect(sampleSubmits()).toHaveLength(2)
  })
})

describe('the header snapshot picker, which this panel used to ignore', () => {
  it('counts itself in the census, so the header does not under-report the tab', () => {
    // The In-feed panel is a <Panel>, and <Panel> registers UNCONDITIONALLY — so
    // before it was given a `snapshot` prop it sat in the denominator and never
    // in the numerator. The header therefore read `0 of 2` on a tab where one of
    // the two is served from an hourly schedule: not incomplete, wrong.
    return (async () => {
      stub()
      await render()
      expect(census!.snapshotted, 'the stored sample is not counted as a snapshot').toBeGreaterThan(0)
      expect(census!.panels).toBeGreaterThanOrEqual(census!.snapshotted)
    })()
  })

  it('re-reads for the moment the picker names, instead of showing the newest under its heading', async () => {
    stub()
    await render()
    // A CHOSEN MOMENT SUBMITS NO SEARCH ANY MORE, so counting submits cannot
    // show the panel re-read. `$vt_results` returns only the NEWEST run, so a
    // past moment is read straight off the stored artifact. The artifact fetch
    // IS the re-read, and it costs nothing, which is the better outcome.
    const artifacts = () => urls.filter((u) => u.includes(SAMPLE + '.') && u.includes('/results'))
    const before = artifacts().length

    // AT OR BEFORE, so the moment has to be at or after the run that answers it.
    // The stub stores one run finished an hour ago; half an hour ago is a moment
    // that run existed at.
    await act(async () => { setSelectedSnapshot(NOW - HOUR / 2) })
    await settle()

    expect(artifacts().length, 'picking a past moment did not re-read this panel').toBeGreaterThan(before)
    // accel/read.ts answers a moment through its own `$vt_results` path over the
    // fixed fast window, never through the live query — there is no live answer
    // to a question about half an hour ago.
    expect(liveSampleSubmits(), 'a picked moment spent a live 754.9 CPU-s sample').toEqual([])
  })

  it('runs nothing at all for a moment older than every stored run, and says so', async () => {
    // THE FAILURE PATH, AND THE ONE THAT COSTS MONEY IF IT IS WRONG. The obvious
    // implementation falls back to the live query when the stored read comes
    // back empty — which here would answer "what does the feed look like NOW"
    // under a heading naming four hours ago, and bill a 754.9 CPU-s scan to do
    // it. accel/read.ts returns `absent` instead; nothing is submitted.
    stub()
    await render()
    const before = sampleSubmits().length

    await act(async () => { setSelectedSnapshot(NOW - 4 * HOUR) })
    await settle()

    expect(sampleSubmits().length, 'a moment with no run behind it still submitted a read').toBe(before)
    expect(liveSampleSubmits(), 'a moment with no run behind it fell back to a live scan').toEqual([])
    expect(sourceNote(), 'the empty panel does not say why it is empty').toMatch(/nothing.*that time|nearest/)
    expect(census!.snapshotted, 'a panel showing nothing was counted as a snapshot').toBe(0)
  })

  it('hides “Run live” while a past moment is being shown', async () => {
    // The rule <Panel> applies to its own version of this control. "Sample the
    // range on screen" has nothing to mean when the question is what the feed
    // looked like four hours ago, and accel/read.ts refuses the live path there
    // regardless — so the control would be present and inert, which reads as
    // broken rather than as deliberate.
    stub()
    await render()
    expect(runLive(), 'the control is missing before any moment is picked').toBeTruthy()

    await act(async () => { setSelectedSnapshot(NOW - 4 * HOUR) })
    await settle()

    expect(runLive(), 'Run live is still offered while a past moment is shown').toBeUndefined()
  })
})

describe('when the schedule cannot answer', () => {
  it('samples the same settled two minutes live, rather than the picker’s window', async () => {
    // The panel means one thing: an hourly sample of two settled minutes. A
    // fallback over the picker's window would make it mean something else on a
    // workspace that has not applied acceleration yet — and would leave the list
    // frozen at whatever range happened to be set when the tab opened.
    stub({ stored: [], history: [] })
    await render()

    const live = liveSampleSubmits()
    expect(live).toHaveLength(1)
    expect([live[0].earliest, live[0].latest]).toEqual([accelEntry(SAMPLE).earliest, accelEntry(SAMPLE).latest])
    expect(note()).toContain('sample taken just now')
  })

  it('puts none of Cribl’s words on screen when the fast read fails', async () => {
    stub({ storedFail: { status: 400, body: { message: 'Error in query: dataset="$vt_results" jobName="gno_sample_2m_c1h"' } } })
    await render()

    const text = container.textContent ?? ''
    expect(text).not.toContain('$vt_results')
    expect(text).not.toContain('Cribl API')
    expect(text).not.toContain('jobName')
    expect(fieldNames(), 'the panel showed nothing after falling back').toContain('http_host')
  })
})

describe('the ⓘ beside the list', () => {
  it('still shows the query, and adds how it was computed', async () => {
    stub()
    await render()
    act(() => container.querySelector<HTMLButtonElement>('.panel-title .pinfo-btn')!.click())

    const pop = document.querySelector('.pinfo-pop')!
    expect(pop.querySelector('.pinfo-code')?.textContent, 'the ⓘ stopped showing the query behind the number').toContain('dataset="gigamon_ami"')
    const text = pop.textContent ?? ''
    expect(text).toContain('How this was computed')
    expect(text, 'the ⓘ does not say the sample is hourly').toContain(SAMPLE_CADENCE)
    expect(text, 'the ⓘ does not say what window the sample covers').toContain('settled two-minute window')
    expect(text, 'the ⓘ does not say how to get a live one').toContain('Run live')
  })

  it('keeps the accessible names that say this ⓘ also dates the sample', async () => {
    // These two names reach the screen only because <Panel> forwards them to
    // <PanelInfo>. They were lost once already: this ⓘ carries block 4 — WHEN
    // the list was sampled — so it was built as a bare <PanelInfo> inside the
    // title, which moved `query=` off the <Panel> element and silently dropped
    // the panel's `info` prose and `note` caption out of the display freeze.
    // Forwarding is what let it go back through <Panel>; nothing but this
    // notices if the forwarding is removed, because the popover still renders.
    stub()
    await render()
    const btn = container.querySelector<HTMLButtonElement>('.panel-title .pinfo-btn')!
    expect(btn.getAttribute('aria-label')).toBe(
      'What the field list shows, the query behind it, and when it was sampled',
    )
    act(() => btn.click())
    expect(document.querySelector('.pinfo-pop')?.textContent).toContain(
      'How the In feed field list was computed',
    )
  })
})

describe('the words about the schedule agree with the manifest', () => {
  it('quotes the cron this app actually writes', () => {
    // The cadence is prose and the cron is data; nothing but this holds them
    // together. `7 * * * *` in UTC is "once an hour, at 7 minutes past".
    const entry = accelEntry(SAMPLE)
    expect(entry.cron).toBe('7 * * * *')
    expect(entry.tz).toBe('UTC')
    expect(SAMPLE_CADENCE).toContain('once an hour')
    expect(SAMPLE_CADENCE).toContain('7 minutes past')
    expect(SAMPLE_CADENCE).toContain('UTC')
  })
})

describe('sampleNote', () => {
  const base = { source: 'schedule' as const, at: NOW - HOUR, stale: false, sampled: 5000 }
  const picker = { following: false, label: 'Last 15 minutes' }

  it('leaves the clock to the panel’s own source caption, and says which sample it is', () => {
    // THE DUPLICATION THIS REPLACED. The In-feed panel now passes `snapshot` to
    // <Panel>, so its header renders a `snapshotNote` caption — `snapshot 08:20
    // · 42m ago`, with `· schedule overdue` when it is late. This note sits six
    // words away from it. Printing the same clock and the same staleness twice
    // is one fact told twice in the smallest type on the screen, and the copy
    // that was edited second would be the one nobody noticed had drifted.
    //
    // What it must still do is say WHICH sample, because "which" is the thing
    // snapshotNote does not know: the hourly scheduled one, not the range above.
    const note = sampleNote({ ...base, stale: true }, picker)
    expect(note).toBe('hourly sample (5,000 rows)')
    expect(note, 'the panel header already says this').not.toContain('schedule overdue')
    expect(note, 'the panel header already says this').not.toMatch(/\d\d:\d\d/)
  })

  it('says nothing about rows before the first read has finished', () => {
    expect(sampleNote({ ...base, sampled: 0 }, picker)).not.toContain('rows')
  })

  it('claims no sample at all until one has come back', () => {
    // On first paint there is no sample; "taken just now" would be a statement
    // about something that does not exist yet.
    expect(sampleNote({ source: 'live', at: null, stale: false, sampled: 0 }, picker)).toBe('sampling…')
  })

  it('names the picker’s window when the reader asked for live', () => {
    expect(sampleNote({ ...base, source: 'live', at: NOW }, { following: true, label: 'Last 4 hours' }))
      .toBe('live sample · last 4 hours (5,000 rows)')
  })
})

describe('feedComputed', () => {
  it('explains a fallback, but never explains away a choice the reader made', () => {
    const fell = feedComputed(
      { source: 'live', at: NOW, stale: false, note: 'The schedule has not produced a result yet, so the live query ran.' },
      { following: false, earliest: '-15m', label: 'Last 15 minutes' },
    )
    expect(fell.fallback).toContain('has not produced a result yet')

    const asked = feedComputed(
      { source: 'live', at: NOW, stale: false, note: 'Acceleration is off for this panel, so the live query ran.' },
      { following: true, earliest: '-15m', label: 'Last 15 minutes' },
    )
    expect(asked.fallback, 'the ⓘ explained the reader’s own click back to them').toBeNull()
    expect(asked.window).toBe('last 15 minutes')
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That any of it is VISIBLE. happy-dom has no layout: these read text
//     content, so a note rendered white-on-white or clipped out of the header
//     would pass. The classes used are the ones already in App.css.
//   * That the range picker itself is labelled. It lives in the app header,
//     which this tab does not own; the labelling asserted here is the tab's own
//     sentence about which control the range applies to.
//   * That Cribl returns the newest run for a `jobName=` selector, or that a
//     scheduled run's correlationId is the saved search's id. Both are stubbed,
//     and both are unverifiable until the first real Apply (constraint 8).
