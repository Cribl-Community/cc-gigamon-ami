// The words under a panel title, and the two ways they can lie.
//
// A caption saying where a number came from is a claim, and the two claims that
// matter are made here rather than in a tab: that a live panel is never
// described as a snapshot, and that a panel which never had a schedule is never
// described as one whose schedule has not run. The second is the quiet one —
// 37 of the 39 panels in this app are in that state, and telling their readers
// "no snapshot yet" would put a permanent shortfall on every tab.

import { describe, expect, it } from 'vitest'
import { NOTES, type AccelOutcome } from '../cribl/accel/read'
import { AGED_AFTER_MS, ageWords, snapshotNote } from './snapshotNote'
import { snapshotServed, type PanelSnapshotState } from './snapshotCensus'

/** 2026-09-18 09:02 local, so the clock in every expectation is a real one. */
const NOW = new Date(2026, 8, 18, 9, 2, 0).getTime()
const AT_0820 = new Date(2026, 8, 18, 8, 20, 0).getTime()

const served = (over: Partial<PanelSnapshotState> = {}): PanelSnapshotState => ({
  source: 'schedule',
  outcome: 'fresh',
  at: AT_0820,
  stale: false,
  ...over,
})

describe('ageWords', () => {
  it('says the age the way a person says it', () => {
    expect(ageWords(0)).toBe('just now')
    expect(ageWords(42_000)).toBe('just now')
    expect(ageWords(42 * 60_000)).toBe('42m ago')
    expect(ageWords(3 * 3600_000)).toBe('3h ago')
    expect(ageWords(2 * 24 * 3600_000)).toBe('2d ago')
  })

  it('does not report a negative age as a time in the future', () => {
    // Clock skew between the Cribl leader that stamped the run and the browser
    // reading it. "in 4 minutes" beside a number is worse than a rounded "just
    // now", because it reads as a bug in the data rather than in the clock.
    expect(ageWords(-4 * 60_000)).toBe('just now')
    expect(ageWords(Number.NaN)).toBe('just now')
  })
})

describe('snapshotNote', () => {
  it('says nothing about a panel that never had a schedule', () => {
    // NOT "live · no snapshot yet". `outcome: null` means this panel never had
    // one, and read.ts keeps the two states apart on purpose so they cannot be
    // rendered as the same sentence.
    expect(snapshotNote(undefined, NOW)).toBeNull()
    expect(snapshotNote({ source: 'live', outcome: null, at: null, stale: false }, NOW)).toBeNull()
  })

  it('renders the clock AND the age, which is I-D20', () => {
    const note = snapshotNote(served(), NOW)
    expect(note!.text).toBe('snapshot 08:20 · 42m ago')
    expect(note!.tone).toBe('fresh')
    expect(note!.title).toBe(NOTES.fresh)
  })

  it('mutes a snapshot once it is more than an hour old', () => {
    // The first visible symptom of a schedule that has stopped firing, and it
    // arrives an hour before STALE_FACTOR's two cadences call it overdue.
    const justInside = snapshotNote(served({ at: NOW - AGED_AFTER_MS + 1000 }), NOW)
    expect(justInside!.tone).toBe('fresh')
    const justOutside = snapshotNote(served({ at: NOW - AGED_AFTER_MS - 1000 }), NOW)
    expect(justOutside!.tone).toBe('aged')
    expect(justOutside!.text).toContain('1h ago')
  })

  it('still shows a stale snapshot, flagged — it never hides the number', () => {
    // read.ts returns a stale result rather than replacing it, because falling
    // back to live on staleness reinstates the expensive query at the exact
    // moment the schedule breaks. The caption is where that shows up.
    const note = snapshotNote(served({ stale: true, outcome: 'stale', at: NOW - 3 * 3600_000 }), NOW)
    expect(note!.text).toBe('snapshot 06:02 · 3h ago · schedule overdue')
    expect(note!.tone).toBe('overdue')
    expect(note!.title).toBe(NOTES.stale)
  })

  it('lets the viewer’s own press speak over every diagnosis', () => {
    // A panel the reader pressed Live on is not "no snapshot yet", whatever the
    // read said on the way past.
    const note = snapshotNote(served({ liveOnly: true, source: 'live', outcome: 'off', at: null }), NOW)
    expect(note!.text).toBe('live · you asked for this one now')
    expect(note!.tone).toBe('live')
  })

  it('never calls a live read a snapshot, whatever the outcome says', () => {
    const outcomes: AccelOutcome[] = ['no-run', 'run-pending', 'run-failed', 'aged-out', 'undated', 'unreadable', 'off']
    for (const outcome of outcomes) {
      const note = snapshotNote({ source: 'live', outcome, at: null, stale: false }, NOW)
      expect(note, `no words for outcome '${outcome}'`).not.toBeNull()
      expect(note!.text.startsWith('live'), `'${outcome}' rendered as "${note!.text}"`).toBe(true)
      expect(note!.tone).toBe('live')
      expect(note!.title, `'${outcome}' did not carry read.ts's own sentence`).toBe(NOTES[outcome])
    }
  })

  it('names a switched-off or drifted schedule as the reason a panel is live', () => {
    // Review 2026-09-24: a paused schedule's panel used to say "schedule
    // overdue — check the schedule". It is live now, and says why.
    for (const outcome of ['paused', 'drifted', 'unscheduled'] as const) {
      const note = snapshotNote({ source: 'live', outcome, at: null, stale: false }, NOW)
      expect(note!.tone).toBe('live')
      expect(note!.title).toBe(NOTES[outcome])
    }
    expect(snapshotNote({ source: 'live', outcome: 'paused', at: null, stale: false }, NOW)!.text).toBe('live · its schedule is paused')
  })

  it('does not say "nothing stored" at a moment whose runs answered an older query', () => {
    // There ARE runs from that time; they are not shown because they came from
    // a query the ⓘ no longer describes. "Nothing stored" would be false.
    const note = snapshotNote({ source: 'none', outcome: 'drifted-at', at: null, stale: false, nearestAt: NOW - 3_600_000 }, NOW)
    expect(note!.text).toBe('stored runs are from an older query')
    expect(note!.tone).toBe('absent')
    expect(note!.title).toBe(NOTES['drifted-at'])
  })

  it('falls back to live words rather than dating a run it cannot date', () => {
    // read.ts already refuses to return an undated stored result — an undated
    // number cannot be labelled, and the label is the whole safety argument.
    // This is the belt: a `schedule` source with no `at` still never produces a
    // caption claiming a time.
    const note = snapshotNote({ source: 'schedule', outcome: 'undated', at: null, stale: false }, NOW)
    expect(note!.text).toBe('live · this run could not be dated')
  })
})

describe('snapshotServed', () => {
  it('is true only where a Live control has something to escape from', () => {
    expect(snapshotServed(served())).toBe(true)
    expect(snapshotServed(served({ liveOnly: true })), 'offered a way to live on a panel already live').toBe(false)
    expect(snapshotServed({ source: 'live', outcome: 'no-run', at: null, stale: false })).toBe(false)
    expect(snapshotServed(undefined)).toBe(false)
  })

  it('still offers the control on a stale snapshot', () => {
    // The state where a reader is most likely to want a number computed now.
    expect(snapshotServed(served({ stale: true, outcome: 'stale' }))).toBe(true)
  })
})
