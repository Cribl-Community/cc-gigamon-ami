// The time control in Snapshot mode: which stored run the whole app is showing.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT REPLACES THE RANGE PICKER RATHER THAN SITTING BESIDE IT. One time control,
// two meanings by mode — in Live it says how far back from now, in Snapshot it
// says which stored run. Two time controls on one header, only one of which does
// anything, is the trap: a reader in Snapshot mode who narrows the range picker
// would watch nothing change, because a `$vt_results` read ignores the picker
// entirely (accel/read.ts's header). The control that does nothing has to be the
// one that is not there.
//
// ── WHY THE OPTIONS ARE REAL RUNS AND NOT A CLOCK ──────────────────────────
// It would be easy to offer "1 hour ago, 2 hours ago…" and resolve each to
// whatever is nearest. That offers times nothing was stored for, and the picker
// would answer some of them with a shrug. Every option in this list is a run
// that finished — read from the job history, not computed from the cron — so
// picking one cannot fail for the entry it came from.
//
// ── THE COHERENCE THIS MUST NOT IMPLY ───────────────────────────────────────
// The hourly entries align at :20, :21 and :22, and the Lake total runs once a
// day at 00:10. So a single list of times is a list drawn from schedules that do
// not agree, and a viewer picking 04:20 is asking five different searches a
// question only three of them have an answer to at that exact minute. The rule,
// applied here and in accel/read.ts: each panel answers from the newest run of
// ITS OWN entry at or before the chosen moment — never the nearest, because a
// run that finished at 05:20 did not exist at 04:20 — and a panel with nothing
// at all from before that moment renders empty and says which times it does
// have. This control says how many sets answered, so the shortfall is visible
// from the header rather than only by noticing an empty card.
//
// ── THE HORIZON IS SAID OUT LOUD ────────────────────────────────────────────
// Two things bound how far back the list goes and they are different limits:
// `keepLastN × cadence` is what the app asked for, and Cribl's 7-day result
// retention is what the platform allows. Whichever is shorter is the real one.
// An empty or short picker with no sentence beside it reads as a broken control;
// with the sentence it reads as a fact about the schedule.
//
// ── NOTHING HERE WRITES, AND NOTHING HERE POLLS ─────────────────────────────
// The history read is a config-plane GET: it bills nothing and creates no job.
// It runs on mount and on an explicit refresh, never on a timer — the app's rule
// is that nothing happens on a timer that a person did not ask for, and a picker
// that re-read itself every minute would also move the option under a reader's
// cursor.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { useDashboard } from '../app/DashboardContext'
import { setSelectedSnapshot, useSelectedSnapshot } from '../cribl/accel/selection'
import { runAtOrBefore, snapshotTimeline, type SnapshotTimeline } from '../cribl/accel/status'
import { asOf, PanelInfo } from './PanelInfo'

/** The option that follows the newest run — what the app opens on. */
export const NEWEST = 'newest'

export interface SnapshotOption {
  /** Epoch ms, or NEWEST. The `<option value>`. */
  value: string
  label: string
}

/**
 * The options, newest first, with "Newest" at the top.
 *
 * "Newest" is not the same option as the topmost time even when they resolve to
 * the same run: one follows the schedule and the other pins a moment. A reader
 * who picked 09:20 an hour ago should still be looking at 09:20, and a reader on
 * Newest should have moved on.
 */
export function snapshotOptions(times: readonly number[], now: number = Date.now()): SnapshotOption[] {
  return [
    { value: NEWEST, label: 'Newest snapshot' },
    ...times.map((t) => ({ value: String(t), label: asOf(t, now) ?? 'an unknown time' })),
  ]
}

/**
 * How many of the entries have a run to answer a chosen moment with, and the
 * oldest time on offer.
 *
 * Counted over the entries whose history could actually be READ: an entry the
 * account cannot list is not an entry with no run, and folding the two together
 * would report a permissions problem as a gap in the timeline.
 */
export function coverageAt(timeline: SnapshotTimeline, at: number | null): { answered: number; total: number } {
  const readable = timeline.entries.filter((e) => e.error === null)
  if (at === null) return { answered: readable.filter((e) => e.runs.length > 0).length, total: readable.length }
  return { answered: readable.filter((e) => runAtOrBefore(e, at) !== null).length, total: readable.length }
}

/**
 * The sentence under the control.
 *
 * Every branch names a fact rather than a state: how far back the list goes, or
 * why it does not go back at all. "No snapshots" on its own would read as a
 * fault in the app on a workspace where nobody has applied the schedules yet,
 * which is the normal state of a fresh install.
 */
export function horizonLine(timeline: SnapshotTimeline, selected: number | null, now: number = Date.now()): string {
  if (timeline.denied) return 'This account cannot list Cribl Search jobs, so stored runs cannot be found.'
  if (timeline.error !== null) return 'The list of stored runs could not be read, so only the newest is available.'
  if (timeline.times.length === 0) return 'No scheduled run has stored a result yet — Guided Setup turns the snapshots on.'

  const { answered, total } = coverageAt(timeline, selected)
  const oldest = asOf(timeline.oldestAt, now) ?? 'an unknown time'
  const reach = `${timeline.times.length} stored ${timeline.times.length === 1 ? 'run' : 'runs'}, back to ${oldest}`
  // Named separately from the count, because they are different facts about the
  // same short list: one is how much there is, the other is who decided.
  const bound = timeline.entries.some((e) => e.horizon.boundBy === 'retention')
    ? ' Cribl keeps a search result for seven days, which is what ends this list.'
    : ''
  if (selected === null) return `${reach}.${bound}`
  return `${reach}. ${answered} of ${total} ${total === 1 ? 'set' : 'sets'} has a run from the time you picked.`
}

/**
 * The picker.
 *
 * `timeline` may be passed in by a caller that already has one — which is what
 * the tests do, and what a future Guided Setup surface would do. Left out, the
 * control reads the job history itself.
 */
export function SnapshotPicker({ timeline: given }: { timeline?: SnapshotTimeline } = {}) {
  const { refreshNonce } = useDashboard()
  const selected = useSelectedSnapshot()
  const [read, setRead] = useState<SnapshotTimeline | null>(null)
  const timeline = given ?? read

  useEffect(() => {
    if (given) return
    let live = true
    const controller = new AbortController()
    // Deliberately not caught into an error state of its own: snapshotTimeline
    // never throws, and its `error` field is what the sentence below renders.
    void snapshotTimeline(undefined, { signal: controller.signal }).then((t) => {
      if (live) setRead(t)
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [given, refreshNonce])

  const times = timeline?.times ?? []
  const options = snapshotOptions(times)
  const value = selected === null ? NEWEST : String(selected)
  // A moment that is no longer in the list — the run aged out while the tab was
  // open — still shows as selected rather than silently jumping to Newest: the
  // panels are still answering for it, and a control that disagrees with the
  // screen is worse than one offering a time that has gone.
  const missing = selected !== null && !times.includes(selected)

  return (
    <span className="snap-picker">
      <label className="range-label" htmlFor="snapshot-at">
        Snapshot
      </label>
      <select
        id="snapshot-at"
        className="range-select"
        value={missing ? NEWEST : value}
        aria-label="Which stored snapshot to show"
        aria-describedby="snapshot-at-note"
        disabled={times.length === 0}
        onChange={(e) => setSelectedSnapshot(e.target.value === NEWEST ? null : Number(e.target.value))}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {/* VISIBLE, not sr-only. How far back the list goes and how many sets
          answered is the whole reason this control can be trusted, and a fact
          only a screen reader gets is a fact the app is hiding from most of the
          people who need it. `aria-describedby` points at the same element, so
          there is one sentence rather than two that can drift. */}
      <span id="snapshot-at-note" className="snap-picker-note">
        {timeline ? horizonLine(timeline, selected) : 'Looking for stored runs.'}
      </span>
      <PanelInfo
        aboutHeading="Which snapshot you are looking at"
        about={
          'In Snapshot mode this picks which stored run every panel reads, so you can look at a past state of the network rather than only the newest one. ' +
          'Each panel answers from the newest run of its own scheduled search at or before the time you pick — never a later one — and a panel with nothing from that time shows no figure and says which times it does have, because running its query now would answer about the present. ' +
          (timeline ? horizonLine(timeline, selected) : '')
        }
        label="What the snapshot picker shows"
      />
    </span>
  )
}
