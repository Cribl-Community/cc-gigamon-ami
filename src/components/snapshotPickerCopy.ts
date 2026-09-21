// Everything the snapshot picker says, and nothing that renders.
//
// Split out of SnapshotPicker.tsx for the reason the other *Copy.ts modules in
// this directory give: oxlint's react(only-export-components) breaks fast
// refresh for a .tsx that also exports plain functions, and every function here
// is a sentence a customer reads, so the argument about the WORDS can be tested
// without a DOM, a store or a router anywhere near it.
//
// The design behind the control — why it REPLACES the range picker, why the
// options are real runs rather than a clock, and what coherence it must not
// imply — is in SnapshotPicker.tsx's header. This file is the implementation of
// that argument, not the argument.

import { runAtOrBefore, type SnapshotTimeline } from '../cribl/accel/status'
import { asOf } from './PanelInfo'

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
/** The start of the hour a moment falls in. */
function hourOf(t: number): number {
  return Math.floor(t / 3_600_000) * 3_600_000
}

export function snapshotOptions(times: readonly number[], now: number = Date.now()): SnapshotOption[] {
  return [
    { value: NEWEST, label: 'Newest snapshot' },
    // LABELLED BY THE HOUR IT COVERS, not by the instant queried.
    //
    // `snapshotTimeline` offers one moment per hour, and the value it offers is
    // the LATEST run inside that hour so every entry resolves to its own run
    // from it. Those instants are the staggered cron minutes — 22:36, 21:54,
    // 20:36 — and a list of them reads as arbitrary even once there are only
    // twenty-five of it. The hour is what the reader is actually choosing, so
    // the hour is what the option says. The value is unchanged: it is still the
    // real run instant, because that is what `runAtOrBefore` needs.
    ...times.map((t) => ({ value: String(t), label: asOf(hourOf(t), now) ?? 'an unknown time' })),
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
