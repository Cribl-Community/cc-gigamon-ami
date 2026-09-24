// The line under a panel's title that says where its number came from, and how
// old it is.
//
// ─────────────────────────────────────────────────────────────────────────────
// GENERALISED FROM ONE SHIPPED PANEL. Field Explorer's `sampleNote`
// (tabs/FieldExplorer.tsx) is the precedent and its argument is the one that
// carries over: *every other panel in this app answers for the window in the
// picker, so a reader has no reason to suspect this one does not* — and a
// schedule that silently stopped firing leaves a perfectly plausible number on
// screen indefinitely. The time is what makes that visible without anybody
// having to know the feature exists.
//
// ── I-D20: THE AGE, NOT ONLY THE CLOCK ──────────────────────────────────────
// `taken 08:20` is a fact about a clock, and a reader glancing at it at four in
// the afternoon reads it as recent. No measured value on this screen may be a
// bare literal, so the age is rendered beside the time — `snapshot 08:20 · 42m
// ago` — and the two are computed from the same `at`, so they cannot disagree.
// Past an hour the line goes muted: an hourly schedule that is more than an hour
// behind is the first visible symptom of the failure accel/read.ts's header
// calls the dangerous one, and it arrives long before `STALE_FACTOR`'s two
// cadences make it "overdue".
//
// ── THE WORDS ARE read.ts's, NEVER CRIBL'S ──────────────────────────────────
// Each live case here is one `AccelOutcome`, a closed set written in
// accel/read.ts. Nothing built from an API response reaches this file: a 4xx on
// a stored read would otherwise print Cribl's echo of
// `dataset="$vt_results" jobName=…` into a customer's panel header. The long
// form of each sentence is read.ts's own `NOTES`, which is what `title` carries;
// the short form below is what fits beside a panel title.
// ─────────────────────────────────────────────────────────────────────────────

import { NOTES, type AccelOutcome } from '../cribl/accel/read'
import { asOf } from './PanelInfo'
import type { PanelSnapshotState } from './snapshotCensus'

/** How the line should be painted. Never the only signal — the words say the
 *  same thing, which is StatusPill's rule applied to a caption. */
export type SnapshotTone =
  /** A stored run, less than an hour old. */
  | 'fresh'
  /** A stored run more than an hour old, but not yet past its schedule. */
  | 'aged'
  /** Older than the schedule promises. Still shown: read.ts returns a stale
   *  result flagged rather than replacing it. */
  | 'overdue'
  /** This panel ran its own query — either because there was no snapshot to
   *  read, or because the viewer asked. */
  | 'live'
  /** Nothing to show: the moment the viewer picked has no stored run for this
   *  panel, and running the query now would answer about the present. */
  | 'absent'

export interface SnapshotNote {
  /** What goes on screen beside the panel title. */
  text: string
  tone: SnapshotTone
  /** The longer sentence, for `title=`. Always read.ts's own words, and never
   *  the only place a fact appears — `text` above carries it too. */
  title: string
}

/**
 * An age a person would say out loud: `just now`, `42m ago`, `3h ago`,
 * `2d ago`.
 *
 * NOT `formatElapsed` from components/jobWatchdogCopy.ts, which is a different
 * question with a different answer. That one reads `19h 4m` — a duration in a
 * table cell, precise to the minute because somebody is deciding whether to
 * cancel a job. This one is a caption beside a number, where the minute of a
 * three-hour-old snapshot is noise and "ago" is what makes it an age rather
 * than a length.
 */
export function ageWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Anything older than this reads as old rather than current, whatever the
 *  schedule's own cadence says. One hour because the snapshot cadence is
 *  hourly at :20, so an hour is the first age that cannot be explained by the
 *  schedule simply not having fired yet. */
export const AGED_AFTER_MS = 60 * 60 * 1000

/** The short form of each live outcome, for a panel header. The long form is
 *  read.ts's NOTES, which `title` carries unchanged. */
const LIVE_WORDS: Readonly<Record<AccelOutcome, string>> = Object.freeze({
  // Neither of these two can reach a live note — they are the snapshot cases,
  // handled above the map. Present so the record is total and a new outcome is
  // a build error rather than a blank caption.
  fresh: 'live',
  stale: 'live',
  undated: 'live · this run could not be dated',
  'no-run': 'live · no snapshot yet',
  'run-pending': 'live · this hour’s run is still going',
  'run-failed': 'live · the last scheduled run did not finish',
  'aged-out': 'live · no stored result is left',
  unreadable: 'live · the stored result could not be read',
  off: 'live · you asked for this one now',
  paused: 'live · its schedule is paused',
  drifted: 'live · its schedule runs an older query — Re-apply in Guided Setup',
  unscheduled: 'live · no schedule serves it',
  // Never reached through LIVE_WORDS — `no-run-at` is answered above, where the
  // words can say which times DO exist. Present because the record is total, so
  // a new outcome is a build error rather than a blank caption.
  // Like `no-run-at`, this one never reaches a live note either: the panel is
  // shown nothing rather than a live number under a past label.
  unshaped: 'no snapshot for this panel at that time',
  'no-run-at': 'nothing stored from that time',
  // Also answered above (source `none`), with NOTES as the title.
  'drifted-at': 'stored runs are from an older query',
})

/**
 * The caption for one panel.
 *
 * Answers null for a panel that never had a schedule. That is not the same
 * state as "its schedule has not run yet", and rendering the two the same way
 * would tell a reader on TLS Posture that their snapshot is missing when no
 * snapshot was ever going to exist for it.
 */
export function snapshotNote(state: PanelSnapshotState | null | undefined, now: number = Date.now()): SnapshotNote | null {
  if (!state) return null

  // The viewer's own press wins over every diagnosis. `off` is the outcome
  // read.ts answers with when acceleration was switched off for this read, and
  // "you asked for this one now" is true of both the global Live mode and the
  // panel's own control — which is why there is one sentence and not two.
  if (state.liveOnly) {
    return { text: 'live · you asked for this one now', tone: 'live', title: NOTES.off }
  }

  // A panel with nothing to show from the moment that was picked. It is not
  // live, so it must not be painted or worded as live — the reader is looking at
  // an empty card and the caption is the only thing that says why.
  if (state.source === 'none') {
    return {
      // A drifted entry has runs from that time; they answered an older query.
      // "nothing stored" would send the reader looking for a missing run.
      text: state.outcome === 'drifted-at' ? LIVE_WORDS['drifted-at'] : state.nearestAt != null ? `nothing at that time · nearest ${asOf(state.nearestAt, now) ?? 'another run'}` : 'nothing stored from that time',
      tone: 'absent',
      title: state.outcome ? NOTES[state.outcome] : NOTES['no-run-at'],
    }
  }

  if (state.source === 'schedule' && state.at !== null) {
    const when = asOf(state.at, now) ?? 'an unknown time'
    const age = ageWords(now - state.at)
    if (state.stale) {
      return {
        text: `snapshot ${when} · ${age} · schedule overdue`,
        tone: 'overdue',
        title: NOTES.stale,
      }
    }
    return {
      text: `snapshot ${when} · ${age}`,
      tone: now - state.at > AGED_AFTER_MS ? 'aged' : 'fresh',
      title: NOTES.fresh,
    }
  }

  if (state.outcome === null) return null
  return { text: LIVE_WORDS[state.outcome], tone: 'live', title: NOTES[state.outcome] }
}
