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

// ── What the panel says before anybody presses anything ─────────────────────
//
// One lead line and a visible warning; everything else a row used to say in a
// paragraph under it is behind the ⓘ on that row's label (the owner's call,
// 2026-09-24: "some (i) icons instead of so many words on the screen"). The
// retention warning stays on screen because it is the one thing a reader must
// know before touching the panel; the confirmations are unchanged.

/** The one line under the panel title. */
export const LAKE_LEAD = 'The live settings of the Cribl Lake objects the dashboards read.'

/** Visible, always, beside the lead. The short form of the irreversible edit. */
export const LAKE_RETENTION_WARNING = 'Lowering retention deletes data and can’t be undone.'

/** Behind the ⓘ at the end of the lead. */
export const LAKE_LEAD_TIP =
  'Three settings can be changed here — retention, the description, and how objects are written — and each shows you its before-and-after to confirm first. ' +
  'Cribl Lake datasets are under no version control, so unlike a destination change there is no commit to revert a retention decrease.'

/** Row label ⓘs this module owns; the term definitions are cribl/landing.ts's LANDING_TERMS. */
export const ROW_TIPS = Object.freeze({
  retention:
    'How long Cribl Lake keeps data in this dataset, counted from when it was uploaded rather than from the event’s timestamp. Raising it keeps data longer from now on; lowering it deletes everything older than the new window, for everyone reading the dataset.',
  // History (kept out of the tip): the format move was planned as a later
  // phase's migration of a month of history, and measured on 2026-09-21 to be
  // creation-only — a PATCH to `format` answers 200, stores, and does nothing.
  objectFormat:
    'The file format objects are written in. It is set when a Cribl Lake dataset is created and cannot be changed afterwards, so moving to another format means a new dataset and migrating its history — not something this panel does. This release lands JSON.',
  storage:
    'A Cribl-managed Lake dataset has no storage location or storage class to change, so there is nothing here to edit.',
  objectsWritten:
    'How often the gigamon_lake destination closes an object: sooner makes new flows searchable sooner, later gives every search fewer, larger objects to open.',
  objectsWrittenEdit:
    'Pick a setting under “Adjust how objects are written”, then press Change. Applying it commits this group’s outputs.yml and deploys, which restarts the group’s Worker Processes.',
})

/** The words a row shows where a control would be, for a setting that has none. */
export const ROW_MARKERS = Object.freeze({
  objectFormat: 'fixed at creation',
  storage: 'not a setting',
})

// ── The onboarding pack's destination: shown, never edited ──────────────────
//
// Owner decision 2026-09-25: where the pack is installed, this panel shows the
// pack's `gigamon_ami_json_lake` READ ONLY. The reason, kept here and out of
// the tip's wording: a change to a pack object is stored as a local setting of
// the pack, and an in-place pack upgrade keeps local settings (measured
// 2026-09-25, 0.1.0 → 0.2.0 on a Leader), so an edit made here would outlive
// every later release's value for it without anybody seeing that it had.

/** The one line above the table while the pack's destination is on it. */
export const PACK_DESTINATION_LEAD =
  'The onboarding pack writes gigamon_ami through its own destination, gigamon_ami_json_lake, shown below read only.'

/** Behind the ⓘ at the end of that line. */
export const PACK_DESTINATION_TIP =
  'The onboarding pack’s releases set how gigamon_ami_json_lake writes objects, and this panel does not change it. ' +
  'A change made here would be kept as a local setting of the pack, which a later release of the pack does not replace — ' +
  'so the destination would quietly stop following the pack. When a release changes these settings, upgrading the pack from the onboarding panel brings them in, unless a local setting was already made in Cribl, which the upgrade keeps.'

/** One line, shown only while both destinations exist in the group. */
export const BOTH_DESTINATIONS_NOTE =
  'gigamon_lake can still write gigamon_ami as well — for the demo feed, or a stack from before the pack — and its “How objects are written” row is the one this panel changes.'

/** The Change column of the pack's row, where a control would be. */
export const PACK_DESTINATION_MARKER = 'set by the pack'

/** What a destination does when Cribl Lake cannot keep up, in words. The value
 *  Cribl reports is printed as it is when this app has no words for it. */
export function backpressureWords(raw: Readonly<Record<string, unknown>> | null | undefined): string {
  const v = raw?.onBackpressure
  if (v === 'block') return 'blocks when Cribl Lake falls behind'
  if (v === 'drop') return 'drops events when Cribl Lake falls behind'
  if (v === 'queue') return 'queues to disk when Cribl Lake falls behind'
  if (typeof v === 'string' && v) return `backpressure: ${v}`
  return 'backpressure behaviour not reported'
}

/** Inside the collapsed "Adjust how objects are written". */
export const ADJUST_NOTE =
  'Nothing here is applied until you press Change on the “How objects are written” row and confirm the before-and-after.'

// ── Create mode (no dataset yet) ────────────────────────────────────────────

export const CREATE_LEAD =
  'No dataset exists yet, so these are choices rather than an editor. The onboarding panel above creates the dataset.'

export const CREATE_LEAD_TIP =
  'The choices are stored for this install in this app’s own settings (app/settings/lake_landing). The onboarding panel above creates the dataset and the destination.'

export const CREATE_SAVE_NOTE = 'Saves to this app’s own store. Creates nothing in Cribl.'

/** The two format tiles' descriptions. What this release writes is said on both. */
export const FORMAT_TILES = Object.freeze({
  json:
    'One JSON record per line, gzipped. A search reads whole objects, so a query that needs three fields still pays for all of them. This is what this release writes.',
  parquet:
    'Columnar, so a search reads only the columns it names — but it can take several times the storage of the gzipped JSON it replaces. Choosing it records the intention only; this release still writes JSON.',
})

/** The tenant's partition-field limit, as the second line of the storage row's value. */
export function partitionLimitWords(max: number | null | undefined): string {
  return max != null
    ? `up to ${max} partition field${max === 1 ? '' : 's'} per dataset`
    : 'partition-field limit not reported'
}

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
// KEYED ON THE CONTROL, NOT ON A SPIKE ID, and that is not a style choice.
// These used to be `SPIKE_GATED.find((g) => g.spikes.includes('P-S9'))`. A
// spike list is exactly the thing that changes when a spike reports: P-S9
// reported on 2026-09-21, its list went empty, and the lookup silently returned
// `undefined` — which renders the row with no explanation beside a value nobody
// can edit. The control a gate describes is what identifies it for the life of
// the gate; which spikes are outstanding is the part that moves.
const gateFor = (control: string) => SPIKE_GATED.find((g) => g.control.includes(control))

export const READER_GATE = gateFor('Federated Search')
export const PARTITION_GATE = gateFor('Partition')

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
 * what the commit carries and what it leaves; then DEPLOY_CONSEQUENCES verbatim
 * from cribl/landing.ts — including the Worker Process restart, which is the
 * sentence an admin who runs this at 11 a.m. on a Tuesday will wish they had
 * been shown.
 *
 * ── THE TWO SENTENCES THIS REPLACED, AND WHY BOTH WERE UNTRUE ───────────────
 *
 * They were one sentence with two branches off `ctx.pendingFiles`, which was
 * the repo-wide Git status — not the commit's file list, and not scoped to this
 * group.
 *
 *   empty:     "Cribl reports no pending change to this group's configuration,
 *              so the commit carries only this edit."
 *   non-empty: "The commit carries N pending files — including anybody else's
 *              unfinished work in them: <the repo-wide list>."
 *
 * The first UNDER-NAMED. `outputs.yml` holds every destination in the group, so
 * "carries only this edit" is a claim about the other contents of a shared file,
 * asserted from a status read that was taken before the PATCH that dirties it
 * and could not have seen it. It also contradicted DEPLOY_CONSEQUENCES[1],
 * rendered three lines below it in this same list.
 *
 * The second OVER-NAMED. The commit's real list is one path; the sentence read
 * the repo-wide one, so the shipped dialog told an admin the commit would carry
 * `inputs.yml` — the panel's own test fixture had exactly that — and it does
 * not. A dialog that names a file it does not touch is the same class of
 * untruth as one that hides a file it does.
 *
 * So now: two facts, separately. What the commit carries is stated flat, with
 * no condition on it, because `POST /version/commit` takes PATHS and a path is
 * a whole file — no read makes that conditional. What is pending elsewhere IS
 * checkable, so it is checked and named; a warning that fires when nothing is
 * pending is the one people learn to click past.
 */
export function destinationConsequences(ctx: DestinationConfirmContext): string[] {
  const feeds =
    ctx.feeds.length === 0
      ? 'Nothing that this app could see currently writes through this destination.'
      : `Everything that writes through it moves with it: ${ctx.feeds.map((f) => f.label).join(', ')}.`
  const complete = ctx.feedsComplete ? '' : ' One of the two reads behind that list was refused, so the list may be short.'
  const carries = `The commit carries ${ctx.commitFiles.join(', ')} — that one file holds every destination in ${ctx.group}.`
  // THREE STATES, THREE SENTENCES. `null` is the read that failed, and it is
  // the state this used to render as the first one: `pendingConfigFiles` never
  // looked at its own response status, so a 403 or a 500 came back as an empty
  // list and the dialog told an admin that Cribl reports nothing else
  // uncommitted — on the strength of a read Cribl refused.
  const elsewhere =
    ctx.otherPending === null
      ? `Cribl did not answer what else is uncommitted on this Leader, so this app cannot tell you what else is sitting in the group. The commit still names only its own path.`
      : ctx.otherPending.length === 0
        ? `Cribl reports nothing else uncommitted on this Leader right now, so nothing else rides along. That was read when this dialog opened.`
        : `Cribl reports ${ctx.otherPending.length} other uncommitted file${ctx.otherPending.length === 1 ? '' : 's'} on this Leader; the commit names its own path and leaves ${ctx.otherPending.length === 1 ? 'it' : 'them'} alone: ${ctx.otherPending.join(', ')}.`
  return [feeds + complete, carries, elsewhere, ...DEPLOY_CONSEQUENCES]
}
