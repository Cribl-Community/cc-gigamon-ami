// Block 4 — "How this was computed" — and the words it is allowed to use.
//
// WHY THIS FILE EXISTS RATHER THAN A SNAPSHOT ENTRY. The display freeze holds ⓘ
// prose where it is WRITTEN: an `info=` or `about=` attribute at a call site,
// read out of the source text by scripts/extract-queries.mjs. Block 4's
// sentences are not written at a call site — they are composed here, from the
// run that answered, because they are the one part of an ⓘ whose truth changes
// between two page loads of the same panel. So the freeze cannot hold them and
// this file does instead: change a sentence and a test has to be changed with
// it, deliberately, the same bargain display.json strikes for the rest.
//
// What each assertion is really about:
//
//   * A SCHEDULED FIGURE IS DATED. Every other panel answers for the window in
//     the picker; these two answer for a run that happened earlier, and a reader
//     has no way to know that unless the popover says when.
//   * A FALLBACK IS NOT SILENT. When the stored run could not be used, block 4
//     says which live query ran and why, in accel/read.ts's words — never in
//     Cribl's, which is the rule the whole read path is built around.
//   * THE CAP IS EXPLAINED IN WORDS. A panel that reports "Search stopped" is
//     otherwise unexplainable without showing the `set …` prefix the job body
//     carries and the ⓘ deliberately never shows, which would put a second,
//     unfrozen query fragment next to the frozen KQL.
//   * EVERY OTHER ⓘ IN THE APP IS UNCHANGED. 77 surfaces pass no `computed`, and
//     none of them may grow a fourth block.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { asOf, computedLines, PanelInfo, type ComputedFrom } from './PanelInfo'

const QUERY = 'dataset="cribl_metrics" | summarize total_events=count()'
const NOW = new Date('2026-09-17T14:32:00Z').getTime()
const HOUR = 3_600_000

const SCHEDULED: ComputedFrom = {
  source: 'schedule',
  at: NOW - 2 * HOUR,
  cadence: 'once a day, at 00:10 UTC',
  window: 'the last 30 days',
  live: 'use “Open in Search” above',
  capSeconds: 900,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Render one ⓘ and open its popover, the way a customer does. */
function openPopover(computed?: ComputedFrom) {
  act(() => {
    root.render(
      <DashboardProvider>
        <PanelInfo about="What this shows." query={QUERY} computed={computed} />
      </DashboardProvider>,
    )
  })
  act(() => container.querySelector<HTMLButtonElement>('.pinfo-btn')!.click())
}

const blocks = () => [...container.querySelectorAll('.pinfo-h')].map((h) => h.textContent)
const prose = () => [...container.querySelectorAll('.pinfo-about')].map((p) => p.textContent ?? '').join(' ')

describe('block 4, on a figure that came from a scheduled run', () => {
  it('says the query did not run for this page, and when it did run', () => {
    const lines = computedLines(SCHEDULED, NOW).join(' ')
    expect(lines).toContain('did not come from a query run when the page loaded')
    expect(lines).toContain('once a day, at 00:10 UTC')
    expect(lines).toContain('the last 30 days')
    // The clock itself is the viewer's own, so the assertion is that there IS
    // one: a stored figure described without saying when it was produced is the
    // failure this block exists to prevent.
    expect(lines, 'a stored figure was described without saying when it was produced').toContain('The run it read finished at')
    expect(lines).toMatch(/finished at \d{2}:\d{2}\./)
  })

  it('escalates a stale run instead of dating it and moving on', () => {
    // The dangerous state is not an error: a schedule that stopped firing leaves
    // a perfectly readable result behind, and the panel keeps rendering it.
    const lines = computedLines({ ...SCHEDULED, stale: true }, NOW).join(' ')
    expect(lines).toContain('older than this schedule promises')
    expect(lines).toContain('Guided Setup')
  })

  it('says how to get a figure computed against live data', () => {
    expect(computedLines(SCHEDULED, NOW).join(' ')).toContain('use “Open in Search” above')
  })

  it('still answers when the run could not be dated', () => {
    // accel/read.ts falls back to live rather than returning an undated result,
    // so this should be unreachable — and if it is ever reached, the popover has
    // to say so rather than printing "finished at null".
    const lines = computedLines({ ...SCHEDULED, at: null }, NOW).join(' ')
    expect(lines).toContain('could not tell when that run finished')
    expect(lines).not.toContain('null')
  })
})

describe('block 4, on a figure that came from a live query', () => {
  it('carries accel/read.ts’s reason, and never an API error', () => {
    const lines = computedLines(
      { ...SCHEDULED, source: 'live', at: null, fallback: 'The schedule has not produced a result yet, so the live query ran.' },
      NOW,
    ).join(' ')
    expect(lines).toContain('The schedule has not produced a result yet, so the live query ran.')
    expect(lines).toContain('as new as the page')
    expect(lines).not.toContain('$vt_results')
    expect(lines).not.toContain('Cribl API')
  })

  it('says nothing about a schedule when there was no fallback to explain', () => {
    const lines = computedLines({ ...SCHEDULED, source: 'live', at: null, fallback: null }, NOW).join(' ')
    expect(lines).toContain('ran over the last 30 days when the page loaded')
    expect(lines).not.toContain('schedule')
  })
})

describe('the running-time cap', () => {
  it('is stated in words, never as the syntax that carries it', () => {
    const lines = computedLines(SCHEDULED, NOW).join(' ')
    expect(lines).toContain('15 minutes')
    expect(lines, 'the ⓘ printed a second query fragment beside the frozen KQL').not.toContain('set max_running_time_per_search')
  })

  it('reads every tier of the cap table as a person would say it', () => {
    const say = (capSeconds: number) => computedLines({ ...SCHEDULED, capSeconds }, NOW).join(' ')
    expect(say(120)).toContain('2 minutes')
    expect(say(300)).toContain('5 minutes')
    expect(say(600)).toContain('10 minutes')
    expect(say(60)).toContain('a minute')
    expect(say(45)).toContain('45 seconds')
  })

  it('is left out entirely when the caller names none', () => {
    const { capSeconds: _drop, ...rest } = SCHEDULED
    expect(computedLines(rest, NOW).join(' ')).not.toContain('stops a live run')
  })
})

describe('asOf', () => {
  it('shows a 24-hour clock alone for a run from today', () => {
    // 24-hour on purpose: the cadence beside it is quoted in UTC, and "12:10 AM"
    // next to "00:10 UTC" invites exactly the wrong comparison.
    expect(asOf(NOW - HOUR, NOW)).toMatch(/^\d{2}:\d{2}$/)
  })

  it('shows the date as well once the run is not from today', () => {
    // "as of 00:10" read at ten at night is ambiguous by exactly the amount that
    // matters for a daily schedule — and a schedule dead for a week would
    // otherwise show a plausible time of day forever.
    const label = asOf(NOW - 3 * 24 * HOUR, NOW)!
    expect(label, 'a run from another day was labelled with a bare clock').toMatch(/[A-Za-z]/)
    expect(label).toMatch(/\d{2}:\d{2}$/)
  })

  it('answers null for a time that is not one, rather than "Invalid Date"', () => {
    expect(asOf(null, NOW)).toBeNull()
    expect(asOf(Number.NaN, NOW)).toBeNull()
  })
})

describe('the popover itself', () => {
  it('renders block 4 under the query, with its own heading', () => {
    openPopover(SCHEDULED)
    expect(blocks()).toEqual(['What this shows', 'Cribl Search · KQL', 'How this was computed'])
    expect(prose()).toContain('did not come from a query run when the page loaded')
  })

  it('leaves the query block exactly as it was', () => {
    // The whole argument for acceleration is that the ⓘ's provenance claim
    // survives it: the scheduled search runs this same string.
    openPopover(SCHEDULED)
    expect(container.querySelector('.pinfo-code')?.textContent).toBe(QUERY.replace(' | ', '\n| '))
  })

  it('grows no fourth block on the 77 ⓘ that pass no `computed`', () => {
    openPopover(undefined)
    expect(blocks()).toEqual(['What this shows', 'Cribl Search · KQL'])
  })
})

// ── What this file does NOT establish ───────────────────────────────────────
//
//   * That block 4 is READABLE where it lands. happy-dom has no layout, so the
//     popover's placement — and whether a fourth block pushes the KQL off a
//     600px Cribl iframe — is asserted only as arithmetic, in PanelInfo.test.tsx
//     against placePopover. The block scrolls with the rest of the popover.
//   * That the words are true of the run they describe. That is the tabs' job:
//     they build the `computed` prop from the hook's own `source`/`at`/`stale`,
//     and FieldExplorer.test.tsx / DataFlow.test.tsx check that wiring.
