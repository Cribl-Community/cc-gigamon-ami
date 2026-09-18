// The sentences the Snapshot / Live control says, and the one it refuses to.
//
// The control's whole justification is that it carries a price the way the
// auto-refresh menu does. So the most important assertion in this file is a
// NEGATIVE one: while any mounted query has no live figure at all, the segment
// says nothing about money rather than quoting a sum it knows is short.
//
// WHAT MOVED, AND WHY THE OLD ASSERTION WAS RIGHT TO GO. The withholding used
// to trigger on `census.snapshotted > 0` — any snapshot-served panel at all —
// because the price came from `useMountedSearchCost()`, which counts only slots
// marked `autoRefresh` and so excluded every accelerated and window-pinned hook.
// That was correct about the figure available to it and wrong about the world:
// it withheld the price on every tab a reader would want it on. The price now
// comes from `useMountedLiveCost()`, which prices those panels from
// accel/estimate.ts's measured runs, so the only thing left to withhold for is a
// query with NO figure from either source. The negative assertion is kept — it
// is the one that stops an under-quote — and re-aimed at that.

import { describe, expect, it } from 'vitest'
import { CPU_SECONDS_PER_CREDIT, type LiveCost } from '../cribl/jobCost'
import type { SnapshotCensus } from './snapshotCensus'
import {
  censusLine,
  liveSegmentLabel,
  livePrice,
  modeAbout,
  MODE_SR_NOTE,
  SEGMENT_NAMES,
  unsavedLine,
} from './modeToggleCopy'

const NOW = new Date(2026, 8, 18, 9, 2, 0).getTime()
const AT_0820 = new Date(2026, 8, 18, 8, 20, 0).getTime()

const census = (over: Partial<SnapshotCensus> = {}): SnapshotCensus => ({
  panels: 6,
  snapshotted: 3,
  oldest: AT_0820,
  ...over,
})
const cost = (cpuSeconds: number, panels = 4, unpriced = 0): LiveCost => ({ panels, cpuSeconds, unpriced })

describe('the price on the Live segment', () => {
  it('is withheld while any mounted query carries no live figure at all', () => {
    // THE UNDER-QUOTE, HELD STILL. `unpriced` is cribl/jobCost.ts's count of
    // mounted slots that would run and have neither a measurement of their own
    // nor a `liveHint` to borrow. While there is one, the sum on screen is short
    // by an unknown amount — and a control trusted because it quotes a number
    // may not quote one it knows is incomplete. The census is irrelevant here on
    // purpose: a snapshot-served panel is now PRICED, from the same measured run
    // accel/estimate.ts keeps, so being served is no longer a reason to go quiet.
    expect(livePrice(cost(100, 4, 1))).toBeNull()
    expect(liveSegmentLabel(cost(100, 4, 2))).toBe('Live')
  })

  it('is shown on a tab whose panels are snapshot-served, which is the point', () => {
    // The regression this whole change exists to end: before it, every tab with
    // a schedule behind any panel showed the bare word `Live`. These are exactly
    // the tabs where the press is expensive and the price matters most.
    expect(livePrice(cost(CPU_SECONDS_PER_CREDIT))).toBe('about 1.0 credits')
    expect(liveSegmentLabel(cost(CPU_SECONDS_PER_CREDIT))).toBe('Live — about 1.0 credits')
  })

  it('does not round an incomplete sum down into a reassuring one', () => {
    // The specific shape of a silent under-quote: a cheap panel has measured and
    // the 9,297.7 CPU-s Lake total has not. `formatCost` would answer "under 0.1
    // credits" for the part it can see, which is not a hedged figure — it is a
    // wrong one, in the direction a reader cannot detect.
    expect(livePrice(cost(12, 1, 1))).toBeNull()
    expect(liveSegmentLabel(cost(12, 1, 1))).toBe('Live')
  })

  it('says nothing before anything has been measured', () => {
    // A cost slot starts at `cpuSeconds: null` and is counted only once its
    // search has completed and the metrics endpoint has answered. Until then
    // the segment is the word alone, exactly as the auto-refresh options are.
    expect(livePrice(cost(0, 0))).toBeNull()
    expect(liveSegmentLabel(cost(0, 0))).toBe('Live')
  })
})

describe('the state line beside the control', () => {
  it('counts panels, names the oldest and says how old it is', () => {
    expect(censusLine(census(), NOW)).toBe('Snapshot · 3 of 6 panels · oldest 08:20 · 42m ago')
  })

  it('says plainly when nothing here has a snapshot, rather than implying the mode did something', () => {
    // 37 of the 39 panels in this app are in this state today, and on most tabs
    // all of them are. A bare "Snapshot" beside them claims the screen came
    // from a stored run.
    expect(censusLine(census({ snapshotted: 0, oldest: null }), NOW)).toBe(
      'Snapshot · none of the 6 panels here has one — everything on this tab is live',
    )
  })

  it('does not say "1 panels"', () => {
    expect(censusLine(census({ panels: 1, snapshotted: 1 }), NOW)).toBe('Snapshot · 1 of 1 panel · oldest 08:20 · 42m ago')
    expect(censusLine(census({ panels: 1, snapshotted: 0, oldest: null }), NOW)).toContain('none of the 1 panel here')
  })

  it('has something to say about a tab with no panels at all', () => {
    // Guided Setup and AMI Reference run no query. The line must not read
    // "0 of 0 panels", which is arithmetic rather than a sentence.
    expect(censusLine(census({ panels: 0, snapshotted: 0, oldest: null }), NOW)).toBe(
      'Snapshot · nothing on this tab reads a query',
    )
  })
})

describe('the refused-write line', () => {
  it('appears only once a write has actually been refused', () => {
    // Announcing "this will not be remembered" on load would be a claim about a
    // store the app has not tried to write to.
    expect(unsavedLine('unasked')).toBeNull()
    expect(unsavedLine('saving')).toBeNull()
    expect(unsavedLine('saved')).toBeNull()
    expect(unsavedLine('refused')).toContain('could not be saved')
  })

  it('says the mode still works, not that the press failed', () => {
    // It did work — for this session. What is lost is the next navigation.
    expect(unsavedLine('refused')).toContain('applies until you leave')
  })
})

describe('the accessible names and the note', () => {
  it('put the cost in the name of the segment that costs money', () => {
    // A screen reader hears "Snapshot, pressed" and "Live, not pressed" from the
    // visible words alone, with no hint that one of them bills the install.
    expect(SEGMENT_NAMES.live).toContain('costs search credits')
    expect(SEGMENT_NAMES.snapshot).toContain('the time it was taken')
  })

  it('tells a non-sighted reader the three things the page says visually', () => {
    expect(MODE_SR_NOTE).toContain('scheduled run')
    expect(MODE_SR_NOTE).toContain('costs search credits')
    expect(MODE_SR_NOTE, 'the shortfall is on screen but not in the note').toContain('stay live in both modes')
  })
})

describe('the ⓘ', () => {
  it('explains the missing price instead of leaving a gap where a number should be', () => {
    const about = modeAbout('snapshot', census(), cost(100, 4, 2), 'Data Flow', NOW)
    expect(about).toContain('3 of the 6 panels on Data Flow')
    expect(about).toContain('08:20')
    expect(about, 'the ⓘ quoted no reason for the missing price').toContain('worse than no price')
    expect(about, 'the ⓘ must say HOW MANY queries are unpriced, not just that some are').toContain('2 of the 6 queries')
  })

  it('quotes the price on a snapshot-served tab once every query has a figure', () => {
    // The other half of the change: with nothing unpriced the ⓘ states the sum
    // AND where it came from, including the panels that were never run live in
    // this session and are priced from a measured run of the same query.
    const about = modeAbout('snapshot', census(), cost(CPU_SECONDS_PER_CREDIT), 'Data Flow', NOW)
    expect(about).toContain('Running this tab live costs about 1.0 credits')
    expect(about).toContain('read from its schedule today')
    expect(about, 'it should not also claim a price is being withheld').not.toContain('worse than no price')
  })

  it('says so when the tab has no scheduled run behind any panel', () => {
    const about = modeAbout('live', census({ snapshotted: 0, oldest: null }), cost(0, 0), 'TLS Posture', NOW)
    expect(about).toContain('No panel on TLS Posture has a scheduled run')
    expect(about).toContain('once its panels have run')
  })

  it('states the expiry the mode actually has', () => {
    // The per-viewer Live choice expires at local midnight, so the morning open
    // is Snapshot again. An ⓘ that did not say so would leave a viewer
    // wondering why their choice vanished overnight.
    expect(modeAbout('live', census(), cost(100), 'Findings', NOW)).toContain('opens on Snapshot again tomorrow')
  })
})
