// The sentences the Snapshot / Live control says, and the one it refuses to.
//
// The control's whole justification is that it carries a price the way the
// auto-refresh menu does. So the most important assertion in this file is a
// NEGATIVE one: on the tabs where a snapshot is actually being served, the
// measured cost provably omits those panels, and the segment says nothing about
// money rather than quoting a figure that is low by about eighty times.

import { describe, expect, it } from 'vitest'
import { CPU_SECONDS_PER_CREDIT, type MountedCost } from '../cribl/jobCost'
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
const cost = (cpuSeconds: number, panels = 4): MountedCost => ({ panels, cpuSeconds })

describe('the price on the Live segment', () => {
  it('is withheld while any mounted panel is snapshot-served', () => {
    // THE EIGHTY-TIMES BUG, held still. cribl/useSearch.ts takes its cost slot
    // as `useCostSlot(enabled && !pinned)`, and every accelerated hook is
    // pinned, so a snapshot-served panel contributes nothing to the measured
    // cost in either mode. On Data Flow that omits the 8,938 billable CPU-s
    // Lake total: the segment would read "about 0.03 credits" for a press that
    // costs about 2.5. A control trusted because it quotes a number may not
    // quote one it knows is incomplete.
    expect(livePrice(cost(100), census({ snapshotted: 3 }))).toBeNull()
    expect(liveSegmentLabel(cost(100), census({ snapshotted: 1 }))).toBe('Live')
  })

  it('is shown when the measured cost covers every panel on the tab', () => {
    expect(livePrice(cost(CPU_SECONDS_PER_CREDIT), census({ snapshotted: 0 }))).toBe('about 1.0 credits')
    expect(liveSegmentLabel(cost(CPU_SECONDS_PER_CREDIT), census({ snapshotted: 0 }))).toBe('Live — about 1.0 credits')
  })

  it('says nothing before anything has been measured', () => {
    // A cost slot starts at `cpuSeconds: null` and is counted only once its
    // search has completed and the metrics endpoint has answered. Until then
    // the segment is the word alone, exactly as the auto-refresh options are.
    expect(livePrice(cost(0, 0), census({ snapshotted: 0 }))).toBeNull()
    expect(liveSegmentLabel(cost(0, 0), census({ snapshotted: 0 }))).toBe('Live')
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
    const about = modeAbout('snapshot', census(), cost(100), 'Data Flow', NOW)
    expect(about).toContain('3 of the 6 panels on Data Flow')
    expect(about).toContain('08:20')
    expect(about, 'the ⓘ quoted no reason for the missing price').toContain('worse than no price')
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
