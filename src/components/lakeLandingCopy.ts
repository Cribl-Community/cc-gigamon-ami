// Every sentence, figure and formatter the "How data lands in Cribl Lake" panel
// says, pure and DOM-free.
//
// The same split components/accelPanelCopy.ts and components/jobWatchdogCopy.ts
// make, for the same two reasons, and it is the reason the panel file itself now
// exports one component and nothing else.
//
// THE FIRST IS TESTABILITY OF THE PART THAT CAN BE WRONG. What this panel can get
// wrong is almost never its markup. It is the words and the units: printing the
// text "undefined" in a diff cell, quoting a decrease against a dataset size
// nobody dated, calling a hand-tuned destination by one of this app's preset
// names, or rendering a spike-gated row with no sentence saying which spike gates
// it. Every one of those is a pure function of a state object, and every one is
// asserted directly here rather than through a rendered DOM that can only be read
// back as one long string.
//
// THE SECOND IS THAT A COMPONENT FILE SHOULD EXPORT A COMPONENT. Eleven exported
// helpers beside `LakeLandingPanel` is eleven `react(only-export-components)`
// warnings and 130 lines a reader scrolls past to reach the screen.
//
// NOTHING HERE READS THE NETWORK, THE CLOCK OR THE DOM. `relativeAge` formats two
// timestamps it is handed; that is the whole of this module's contact with the
// outside world.

import type { ConfirmResource } from './ConfirmDialog'
import { CPU_SECONDS_PER_CREDIT } from '../cribl/jobCost'
import { fmtBytes, formatCost } from '../lib/format'
import {
  DEPLOY_CONSEQUENCES,
  FLUSH_PRESETS,
  SPIKE_GATED,
  flushPresetOf,
  type FlushSettings,
} from '../cribl/landing'
import type { LakeDestination } from '../cribl/lake'
import type { DestinationConfirmContext, RetentionConfirmContext } from '../cribl/lakeLanding'

/**
 * The id of the wrapper around <ProvisionPanel> in src/tabs/GuidedSetup.tsx.
 *
 * Exported so the anchor and its target are one string. The dataset-absent state
 * links here — an in-page anchor to the panel that creates the dataset, because
 * there is no route to send anybody to (I-D2).
 */
export const INGEST_ANCHOR_ID = 'gs-ingest-panel'

/** Past this, a measurement renders muted: it has stopped being a claim about
 *  now, and the relative age beside it says so in words as well. */
export const STALE_AFTER_MS = 60 * 60 * 1000

/**
 * What each measurement costs, in billable CPU-seconds.
 *
 * RE-EXPORTED, NOT TRANSCRIBED. These were copies of two numbers in the docblocks
 * of src/queries/lakeLanding.ts until the Phase 3 settling pass; a copy means
 * editing a query without editing another file leaves a cost label that is
 * quietly wrong. They now come from beside the KQL they are a claim about, which
 * also puts them in the display-freeze snapshot next to it. Re-exported from here
 * so a reader of this module still finds them where the labels are computed.
 */
export { LAG_CPU_SECONDS, PARTITION_CPU_SECONDS } from '../queries/lakeLanding'

/** A measurement's price as a customer reads it. Both of these land under the
 *  0.1-credit floor `formatCost` refuses to print more precision than. */
export const costLabel = (cpuSeconds: number): string => formatCost(cpuSeconds / CPU_SECONDS_PER_CREDIT)

/**
 * The two controls this phase refused to build, found by the spike that gates
 * each rather than by position or by matching the control's prose.
 *
 * `P-S7` appears only on the reader row and `P-S9` only on the partitions row,
 * so these two lookups stay correct if somebody reorders SPIKE_GATED or rewords
 * a control. The test asserts both resolve; a silent `undefined` here would
 * render a spike-gated row with no explanation, which is the one thing worse
 * than not building the control.
 */
export const READER_GATE = SPIKE_GATED.find((g) => g.spikes.includes('P-S7'))
export const PARTITION_GATE = SPIKE_GATED.find((g) => g.spikes.includes('P-S9'))

// ── Small formatters, exported so a test can read them without a DOM ────────

/**
 * One value cell of a destination diff, as the string a reader should see.
 *
 * <DiffTable>'s handoff expected `diffDestination()` to hand over strings
 * already — "the module that computed the diff is the one that knows what the
 * field means". It does not: `landing.ts`'s `DiffRow` carries `unknown` on both
 * sides, so the formatting lands here. `undefined` becomes `null` deliberately,
 * because that is what <DiffTable> prints as the words "not set"; `String(
 * undefined)` would put the text "undefined" in front of a customer.
 */
export function printValue(v: unknown): string | null {
  if (v === undefined) return null
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v) ?? null
  } catch {
    // A body with a cycle in it is not something this app can render, and a
    // dialog that threw while explaining a write is worse than a named gap.
    return '(this value cannot be displayed)'
  }
}

/**
 * How long ago, in words, for the line beside a measured value.
 *
 * Coarse on purpose. The point of an age is to answer "can I still believe
 * this?", and a second-by-second countdown implies a precision that a single
 * sample taken at the instant of a press does not have.
 */
export function relativeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}

/**
 * A landing lag as a duration.
 *
 * THE UNIT IS THE QUERY'S, NOT THIS APP'S. `lag_s` is `now()-newest` in
 * LANDING_LAG_QUERY, and `_time` on a Cribl Lake dataset is epoch seconds, so
 * the difference is seconds. Nobody has run that query — it is a Preview check
 * (2.2) — so if the first real measurement comes back three orders of magnitude
 * out, this is not the line to patch: the query is, and the name `lag_s` with
 * it.
 */
export function formatLag(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'not a number'
  const s = Math.max(0, seconds)
  if (s < 90) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const minutes = s / 60
  if (minutes < 90) return `${minutes.toFixed(1)} min`
  return `${(minutes / 60).toFixed(1)} h`
}

/** The flush settings a live destination body is actually on, or null when the
 *  body did not carry all three — in which case this app will not guess one. */
export function flushOf(dest: LakeDestination | null): FlushSettings | null {
  const raw = dest?.raw as Record<string, unknown> | undefined
  if (!raw) return null
  const n = (k: string) => (typeof raw[k] === 'number' && Number.isFinite(raw[k]) ? (raw[k] as number) : null)
  const size = n('maxFileSizeMB')
  const open = n('maxFileOpenTimeSec')
  const idle = n('maxFileIdleTimeSec')
  if (size === null || open === null || idle === null) return null
  return { maxFileSizeMB: size, maxFileOpenTimeSec: open, maxFileIdleTimeSec: idle }
}

/** How a flush setting reads on the row: the preset's name AND the three
 *  numbers, because `custom` is a real answer and a preset name alone would let
 *  a hand-tuned destination pass as one of ours. */
export function flushWords(settings: FlushSettings): string {
  const id = flushPresetOf(settings)
  const numbers = `${settings.maxFileSizeMB} MB · ${settings.maxFileOpenTimeSec} s open · ${settings.maxFileIdleTimeSec} s idle`
  return id === 'custom' ? `Custom — ${numbers}` : `${FLUSH_PRESETS[id].label} — ${numbers}`
}

/**
 * How much data a decrease is about, in this tenant's own terms.
 *
 * From the live read, never a literal (I-D20). The size Cribl Lake reports is
 * computed on a DAY rather than live, so the date rides with it — a size quoted
 * without one is a claim about right now that the number cannot make.
 */
export function sizeSentence(ctx: RetentionConfirmContext): string {
  if (ctx.sizeBytes === null) {
    return 'Cribl Lake did not report a size for this dataset, so nothing here can say how much data the decrease removes.'
  }
  const when = ctx.metricsDate ? ` when Cribl last measured it, on ${ctx.metricsDate}` : ', at Cribl’s last measurement'
  return `This dataset held ${fmtBytes(ctx.sizeBytes)}${when}. The decrease removes everything in it older than ${ctx.change.to} days.`
}

/** The objects a destination change touches, in dependency order: the object
 *  itself, then the deploy that makes it real on the Workers. */
export function destinationResources(ctx: DestinationConfirmContext): ConfirmResource[] {
  return [
    {
      action: 'replace',
      kind: 'Cribl Lake destination',
      id: ctx.destinationId,
      group: ctx.group,
      detail:
        'The live body is re-read and sent back with only the keys below changed. This app did not create this destination on most tenants, and the only way back is this same editor or the group’s Git history.',
    },
    {
      action: 'deploy',
      kind: 'Cribl worker group',
      id: ctx.group,
      detail: 'The change is committed on the Leader and pushed to this group’s running Workers.',
    },
  ]
}

/**
 * Everything a destination change causes that is not in the diff.
 *
 * The feed list first, because it answers "what am I about to interrupt?"; then
 * how much of somebody else's work rides along in the commit; then
 * DEPLOY_CONSEQUENCES verbatim from cribl/landing.ts — including the Worker
 * Process restart, which is the sentence an admin who runs this at 11 a.m. on a
 * Tuesday will wish they had been shown.
 */
export function destinationConsequences(ctx: DestinationConfirmContext): string[] {
  const feeds =
    ctx.feeds.length === 0
      ? 'Nothing that this app could see currently writes through this destination.'
      : `Everything that writes through it moves with it: ${ctx.feeds.map((f) => f.label).join(', ')}.`
  const complete = ctx.feedsComplete ? '' : ' One of the two reads behind that list was refused, so the list may be short.'
  const pending =
    ctx.pendingFiles.length === 0
      ? 'Cribl reports no pending change to this group’s configuration, so the commit carries only this edit.'
      : `The commit carries ${ctx.pendingFiles.length} pending file${ctx.pendingFiles.length === 1 ? '' : 's'} — including anybody else’s unfinished work in them: ${ctx.pendingFiles.join(', ')}.`
  return [feeds + complete, pending, ...DEPLOY_CONSEQUENCES]
}
