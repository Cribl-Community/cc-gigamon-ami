// Everything the Snapshot / Live control says, and nothing that renders.
//
// Split out of ModeToggle.tsx for the reason the other *Copy.ts modules in this
// directory give: oxlint's react(only-export-components) breaks fast refresh for
// a .tsx exporting plain functions, and — more to the point — every function
// here is a sentence a customer reads, so the argument about the WORDS can be
// reviewed and tested without a DOM, a store or a router anywhere near it.
//
// The design behind the control is in ModeToggle.tsx's header. This file is the
// implementation of that argument, not the argument.

import { CPU_SECONDS_PER_CREDIT, type LiveCost } from '../cribl/jobCost'
import { formatCost } from '../lib/format'
import type { DataMode, DataModeSave } from '../cribl/dataMode'
import { asOf } from './PanelInfo'
import { ageWords } from './snapshotNote'
import type { SnapshotCensus } from './snapshotCensus'

/** The two segments' visible words. `Live` takes a price when one is honest —
 *  see `livePrice`. */
export const SNAPSHOT_LABEL = 'Snapshot'
export const LIVE_LABEL = 'Live'

/**
 * The accessible name of each segment: what pressing it does, not what it is.
 *
 * The visible word is the state; a screen reader listening to a two-button
 * group hears "Snapshot, pressed" and "Live, not pressed" and has no idea that
 * the second one costs money. These say it.
 */
export const SEGMENT_NAMES: Readonly<Record<DataMode, string>> = Object.freeze({
  snapshot: 'Snapshot — show each panel’s most recent scheduled run, with the time it was taken',
  live: 'Live — run every panel’s own query now, which costs search credits',
})

/**
 * The note the group is described by, modelled on `#auto-refresh-note`.
 *
 * It carries the three facts a sighted reader gets from the state line and the
 * per-panel captions, which are spread across the page: what each mode is, that
 * some panels have no snapshot and stay live in both, and that the count beside
 * the control is what says how many.
 */
export const MODE_SR_NOTE =
  'Snapshot shows the result of each panel’s most recent scheduled run, labelled with the time it was taken. ' +
  'Live runs every panel’s own query now and costs search credits. Panels with no scheduled run stay live in ' +
  'both modes; the line beside this control says how many panels on this tab have a snapshot. ' +
  'The information button explains where the numbers come from.'

/**
 * The price on the Live segment — or null, which is a decision and not a gap.
 *
 * WHAT IT COSTS IS `useMountedLiveCost()`, NOT `useMountedSearchCost()`, and the
 * difference was an eighty-times understatement. The tick aggregate counts only
 * slots marked `autoRefresh`, and cribl/useSearch.ts takes its slot as
 * `useCostSlot({ autoRefresh: enabled && !pinned, … })` with `pinned` true for
 * every snapshot-served and every window-pinned hook. So the figure that used to
 * reach this function omitted the 9,297.7 CPU-s Lake total outright: the segment
 * would have read *about 0.03 credits* for a press costing about 2.5, on the one
 * control whose entire justification is that it carries a price. cribl/jobCost.ts
 * answers the other question — what running every mounted panel live right now
 * costs, tick or no tick — and that is what a press of `Live` actually does.
 *
 * WHY A NUMBER IS STILL WITHHELD, AND WHEN. A panel that has been served from
 * its schedule all session has never run live here and holds no measurement of
 * its own; `liveHint` fills that from accel/estimate.ts's measured runs, which
 * covers every panel with a manifest entry. A panel with NEITHER — one that has
 * not finished a run and has no entry to borrow a figure from — is reported as
 * `unpriced`, and while there is one the sum is short by an unknown amount.
 *
 * A control that is trusted because it quotes a number may not quote a number it
 * knows is incomplete, and "at least about 1.0 credits" hedges twice while still
 * reading as a price. So the number appears only when `unpriced` is zero, and
 * the ⓘ says how many panels are missing when it is not. This used to fire on
 * every tab with any snapshot-served panel — which was all of the interesting
 * ones; it now fires only while something is genuinely unmeasured, usually for
 * the second before the first runs land.
 */
export function livePrice(cost: LiveCost): string | null {
  // Order matters only for the reader: both are "no honest figure", but they are
  // different states and the ⓘ branches on them separately.
  if (cost.unpriced > 0) return null
  if (cost.panels === 0) return null
  return formatCost(cost.cpuSeconds / CPU_SECONDS_PER_CREDIT)
}

/** The Live segment's visible text: the word alone, or the word and its price. */
export function liveSegmentLabel(cost: LiveCost): string {
  const price = livePrice(cost)
  return price ? `${LIVE_LABEL} — ${price}` : LIVE_LABEL
}

/**
 * The line beside the control in Snapshot mode.
 *
 * Three facts, none of them a literal: the count from the mounted-panel census,
 * the clock from `asOf`, and the age from the same `at` that produced the clock.
 * The OLDEST rather than the newest, because the question a reader is asking is
 * whether they can trust the screen, and the newest snapshot on a tab cannot
 * answer that for the panel beside it.
 */
export function censusLine(census: SnapshotCensus, now: number = Date.now()): string {
  if (census.panels === 0) return 'Snapshot · nothing on this tab reads a query'
  if (census.snapshotted === 0) {
    return `Snapshot · none of the ${census.panels} ${plural(census.panels, 'panel')} here has one — everything on this tab is live`
  }
  const when = census.oldest === null ? null : asOf(census.oldest, now)
  const oldest = when ? ` · oldest ${when} · ${ageWords(now - census.oldest!)}` : ''
  return `Snapshot · ${census.snapshotted} of ${census.panels} ${plural(census.panels, 'panel')}${oldest}`
}

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`)
// Spelled out rather than run through `plural`, which appends an `s` and would
// write "querys" on the one line in this file that quotes money. An irregular
// plural is not a case to teach a helper; it is a word.
const queries = (n: number) => (n === 1 ? 'query' : 'queries')

/**
 * The line that appears when the store refused to remember the choice.
 *
 * Null in every other state, INCLUDING before anything has been pressed: an app
 * that announced "this will not be remembered" on load would be making a claim
 * about a store it has not tried to write to. `saveAccelPref` answers false with
 * no signed-in user and on the `npm run dev` page, where the app-scoped KV store
 * 404s — and in both cases the mode still works for this session, which is what
 * the sentence has to say as well.
 */
export function unsavedLine(save: DataModeSave): string | null {
  return save === 'refused' ? 'This choice applies until you leave — it could not be saved for next time.' : null
}

/**
 * The ⓘ beside the control: where the numbers on this tab actually come from.
 *
 * Every figure in it is computed from what is mounted right now, exactly as
 * `useAutoRefreshCopy` does for auto-refresh. The one number this file could
 * quote and does not is the Live price when it is incomplete — see `livePrice`.
 */
export function modeAbout(
  mode: DataMode,
  census: SnapshotCensus,
  cost: LiveCost,
  tabName: string,
  now: number = Date.now(),
): string {
  const lines: string[] = []

  if (census.snapshotted === 0) {
    lines.push(
      `No panel on ${tabName} has a scheduled run behind it, so every number here was computed by a query that ran ` +
        'when the page loaded, in both modes.',
    )
  } else {
    const when = census.oldest === null ? null : asOf(census.oldest, now)
    lines.push(
      `${census.snapshotted} of the ${census.panels} panels on ${tabName} can be served from a scheduled run — Cribl runs ` +
        'those queries on a schedule and the panel reads the result that run stored, rather than running the query ' +
        'again. Each one says the time its run was taken, under its own title.' +
        (when ? ` The oldest on this tab was taken at ${when}, ${ageWords(now - census.oldest!)}.` : ''),
    )
  }

  lines.push(
    mode === 'snapshot'
      ? 'Snapshot is the default, so opening the app costs a stored read rather than a scan of the Lake. A panel with ' +
          'no scheduled run still runs its own query, and says so.'
      : 'Live runs every panel’s own query when the page loads and on every refresh, which costs search credits. ' +
          'Switch back to Snapshot to read stored runs again.',
  )

  const price = livePrice(cost)
  if (price) {
    lines.push(
      `Running this tab live costs ${price}, added up over the ${cost.panels} ${queries(cost.panels)} mounted here ` +
        'from what each one measured when it last ran — or, for one that has only ever been read from its schedule ' +
        'today, from a measured run of the same query.',
    )
  } else if (cost.unpriced > 0) {
    const all = cost.panels + cost.unpriced
    lines.push(
      `What Live costs on this tab is not stated here, and that is deliberate: ${cost.unpriced} of the ${all} ` +
        `${queries(all)} here ${cost.unpriced === 1 ? 'has' : 'have'} not run yet and ` +
        `${cost.unpriced === 1 ? 'has' : 'have'} no measured cost to borrow, so any total would be short by an ` +
        'unknown amount. A price that left out the most expensive query on the tab would be worse than no price.',
    )
  } else {
    lines.push('The cost of running this tab live appears here once its panels have run at least once.')
  }

  lines.push('Your choice of mode is remembered for the rest of the day, and the app opens on Snapshot again tomorrow.')
  return lines.join(' ')
}
