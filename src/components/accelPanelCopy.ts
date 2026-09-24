// Every sentence and every figure the Acceleration section says, pure and
// DOM-free.
//
// The same split components/jobWatchdogCopy.ts makes, for the same two reasons.
//
// THE FIRST IS TESTABILITY OF THE PART THAT CAN BE WRONG. What this screen can
// get wrong is almost never its markup. It is the words: calling a search the
// app could not read "absent" and offering to create a second one over the top,
// printing `0 CPU-s` beside a schedule because the meter has not caught up,
// saying "on schedule" about a cadence nothing has measured, or quoting a saving
// without the sentence that says it is a projection. Every one of those is a
// pure function of a state object, and every one is asserted here rather than
// through a rendered DOM that can only be inspected as one long string.
//
// THE SECOND IS THAT A COMPONENT FILE SHOULD EXPORT A COMPONENT. Twenty exported
// helpers beside `AccelPanel` is twenty `react(only-export-components)` warnings
// and a file a reader has to scroll past to find the screen.
//
// NOTHING HERE READS THE NETWORK, THE CLOCK OR THE DOM. Every function takes the
// state it describes. `lastRunWhen` formats a timestamp it is handed, and that
// is the whole of this module's contact with the outside world.

import type { ConfirmResource } from './ConfirmDialog'
import type { StatusState } from './StatusPill'
import { SEARCH_GROUP } from '../cribl/config'
import type { AccelEntry } from '../cribl/accel/manifest'
import type { AccelEntryState, AccelRow, AccelState } from '../cribl/accel/provision'
import type { AccelStatus } from '../cribl/accel/status'
import { cadenceLooksRight } from '../cribl/accel/status'
import { creditsFor, type EntrySaving, type Span, type WorkspaceSaving } from '../cribl/accel/estimate'
import { formatCost, formatRecurringCost } from '../lib/format'

// ── The words, kept pure so a test can read them without a DOM ──────────────

/**
 * One state of a scheduled search → one word on a pill.
 *
 * Written as an exhaustive `Record` rather than passing `row.state` straight
 * through, even though the two unions happen to line up today: a seventh
 * `AccelEntryState` then fails the build here, where somebody has to choose what
 * a reader is told, instead of rendering a word nobody designed.
 */
export const PILL_STATE: Record<AccelEntryState, StatusState> = {
  absent: 'absent',
  enabled: 'enabled',
  paused: 'paused',
  differs: 'differs',
  foreign: 'foreign',
  unreadable: 'unreadable',
}

export type HealthTone = 'ok' | 'warn' | 'bad' | 'unknown'

export interface Health {
  /** The column's word. Never a colour on its own. */
  word: string
  /** The sentence under the table, when the word needs one. */
  detail: string | null
  tone: HealthTone
}

/**
 * Whether the schedule is doing its job.
 *
 * READ IN THIS ORDER ON PURPOSE. The object's own state comes first, because
 * "never run" is the wrong sentence about a search that does not exist. Then the
 * status read's `error` — before `runs.length` — because a refusal, a
 * correlationId that matched nothing and a schedule that has genuinely never
 * fired all produce zero rows, and only `error` separates the first from the
 * other two (cribl/accel/status.ts, header). `null` from `cadenceLooksRight` is
 * "cannot say" and must never render as healthy.
 */
export function healthOf(state: AccelEntryState, status: AccelStatus | null): Health {
  if (state === 'absent') return { word: 'Not scheduled', detail: null, tone: 'unknown' }
  if (state === 'foreign') {
    return {
      word: 'Not this app’s',
      detail: 'A saved search with this id exists and carries no stamp from this app, so this app will not read, change or remove it.',
      tone: 'warn',
    }
  }
  if (state === 'unreadable') {
    return { word: 'Cannot say', detail: 'Cribl would not say whether this saved search exists.', tone: 'unknown' }
  }
  if (!status) return { word: 'Checking…', detail: null, tone: 'unknown' }
  if (status.denied) {
    return { word: 'Cannot see', detail: status.error ?? 'Cribl refused to list this search’s runs.', tone: 'unknown' }
  }
  if (status.error !== null) return { word: 'Cannot say', detail: status.error, tone: 'unknown' }
  if (state === 'paused') {
    return {
      word: 'Paused',
      detail: 'It is not running, so nothing is refreshing the panel it feeds. That panel falls back to its live query.',
      tone: 'warn',
    }
  }
  if (status.runs.length === 0) {
    return { word: 'Never run', detail: 'Cribl lists no run for this search yet.', tone: 'warn' }
  }
  const last = status.last
  if (last?.running) return { word: 'Running now', detail: null, tone: 'ok' }
  if (last?.outcome === 'failed') {
    return { word: 'Last run failed', detail: 'A failed run’s results are not read — the panel it feeds runs its live query instead.', tone: 'bad' }
  }
  if (last?.outcome === 'canceled') {
    return { word: 'Last run cancelled', detail: 'A cancelled run’s results are not read — the panel it feeds runs its live query instead.', tone: 'bad' }
  }
  const cadence = cadenceLooksRight(status)
  if (cadence === true) return { word: 'On schedule', detail: null, tone: 'ok' }
  if (cadence === false) {
    return { word: 'Behind schedule', detail: 'It is firing less often than its cron asks for.', tone: 'warn' }
  }
  return { word: 'Too few runs to say', detail: 'A cadence needs two runs to measure.', tone: 'unknown' }
}

/** When the newest run produced its result. */
export function lastRunWhen(status: AccelStatus | null): string {
  if (!status) return 'Checking…'
  if (status.error !== null) return '—'
  if (!status.last) return 'Never'
  if (status.last.at === null) return 'Time not recorded'
  return new Date(status.last.at).toLocaleString()
}

/**
 * What the newest run billed — or, where that is not a number, WHICH KIND of
 * not-a-number it is.
 *
 * Never `0`. `billableCPUSeconds` reads 0 on a job that has not been billed yet,
 * and a finished search of this dataset has a measured floor near 5 CPU-s, so an
 * exact zero is the meter lagging. "0 CPU-s" beside a scheduled search is the
 * single most misleading thing this table could say — it reads as "free".
 */
export function lastRunCostWords(status: AccelStatus | null): string {
  if (!status || status.error !== null || !status.last) return '—'
  switch (status.lastCpuUnavailable) {
    case 'running':
      return 'still running'
    case 'not-reported':
      return 'not reported yet'
    case 'unreadable':
      return 'could not read'
  }
  const cpu = status.lastCpuSeconds
  if (cpu === null) return 'not reported yet'
  return `${Math.round(cpu).toLocaleString('en-US')} CPU-s · ${formatCost(creditsFor(cpu))}`
}

export type RowAction =
  | { kind: 'pause' }
  | { kind: 'resume' }
  /** No control, and the word that says which half of the rule this row failed
   *  — never a `disabled` button, which leaves the keyboard order and announces
   *  "unavailable" without ever saying why. */
  | { kind: 'none'; word: string }

export function rowAction(row: AccelRow): RowAction {
  if (row.state === 'absent') return { kind: 'none', word: 'Not created' }
  if (row.state === 'foreign' || (!row.ours && !row.recorded)) return { kind: 'none', word: 'Not this app’s' }
  if (row.state === 'unreadable') return { kind: 'none', word: 'Unverified' }
  if (row.enabled === null) return { kind: 'none', word: 'No schedule' }
  return row.enabled ? { kind: 'pause' } : { kind: 'resume' }
}

/**
 * The accessible name of a per-row control.
 *
 * "Pause" alone is the whole announcement of a control that stops a schedule,
 * and in the third row of a table it names nothing. The visible label stays one
 * word; the id and the panel it serves ride in the accessible name — the same
 * split components/JobWatchdog.tsx makes for its Cancel.
 */
export function rowActionName(kind: 'pause' | 'resume', entry: AccelEntry): string {
  return `${kind === 'pause' ? 'Pause' : 'Resume'} ${entry.id} — ${entry.serves}`
}

/** Who Cribl says owns the saved search. `user` is server-controlled: this app
 *  cannot set it and cannot move it (A-SP23). */
export function ownerOf(row: AccelRow): { id: string | null; name: string | null } {
  const stored = row.stored
  const id = typeof stored?.user === 'string' && stored.user ? stored.user : null
  const name = typeof stored?.displayUsername === 'string' && stored.displayUsername ? stored.displayUsername : null
  return { id, name }
}

/**
 * Whether the Owner column is worth a column.
 *
 * Only when somebody else owns one of these. On the ordinary install every row
 * belongs to whoever pressed Apply, and a column repeating the reader's own name
 * twice is a column that pushes the ones carrying information off a narrow
 * screen. A null `me` — the localhost dev page, where the platform names nobody
 * — shows the column, because "this is yours" would then be a claim the app
 * cannot support.
 */
export function showOwnerColumn(rows: readonly AccelRow[], me: string | null): boolean {
  return rows.some((row) => {
    const owner = ownerOf(row)
    return owner.id !== null && owner.id !== me
  })
}

/** The extra sentence a row needs, or null. Rendered under the row rather than
 *  in a cell, because `.dtable` cells do not wrap. */
export function rowNote(row: AccelRow, health: Health): string | null {
  if (row.state === 'differs' && row.differences.length) {
    return `Edited since this app wrote it: ${row.differences.join('; ')}. Apply overwrites it with what this release defines.`
  }
  return health.detail
}

// ── The estimate, in words ──────────────────────────────────────────────────

const round2 = (n: number) => Number(n.toPrecision(2))

/**
 * A band as one phrase.
 *
 * Collapses to `formatCost` when both ends round to the same figure, because
 * "about 2.6–2.6 credits/day" reads as a bug rather than as a measurement with
 * no spread — which is exactly what a single measurement is (n = 1 claims no
 * spread; see estimate.ts).
 */
export function creditSpanWords(span: Span, unit = 'credits/day'): string {
  const low = round2(span.low)
  const high = round2(span.high)
  if (low === high) return formatCost(span.low, unit)
  const fmt = (n: number) => (n >= 10 ? n.toLocaleString('en-US') : n < 1 ? String(n) : n.toFixed(1))
  return `about ${fmt(low)}–${fmt(high)} ${unit}`
}

/** CPU-seconds a day the schedules themselves bill. The charge Apply creates. */
export function scheduleCpuSecondsPerDay(saving: WorkspaceSaving): number {
  return saving.entries.reduce((n, e) => n + e.scheduledRun.cpuSeconds * e.scheduledRunsPerDay, 0)
}

/** CPU-seconds a day the live queries bill today. The charge Remove puts back. */
export function liveCpuSecondsPerDay(saving: WorkspaceSaving): Span {
  return {
    low: saving.entries.reduce((n, e) => n + e.beforeCpuSeconds.low, 0),
    high: saving.entries.reduce((n, e) => n + e.beforeCpuSeconds.high, 0),
  }
}

/**
 * What Apply commits the customer to.
 *
 * The saving is the second sentence, never the first. Creating a schedule is
 * taking on a recurring charge that runs whether or not anybody opens the panel
 * it feeds, and a confirmation that led with the saving would be asking somebody
 * to approve a subscription by showing them the discount.
 */
export function applyCostLine(saving: WorkspaceSaving): string {
  const perDay = creditsFor(scheduleCpuSecondsPerDay(saving))
  const live = liveCpuSecondsPerDay(saving)
  return (
    `This creates a recurring charge. The schedules run on their cron whether or not anybody opens the panels ` +
    `they feed: ${formatRecurringCost(perDay)} at the run costs measured on this workspace. ` +
    `They replace live queries this workspace bills ${creditSpanWords({ low: creditsFor(live.low), high: creditsFor(live.high) })} for today, ` +
    `so the expected net is a saving of ${creditSpanWords(saving.savedCredits)} — an estimate, not a bill.`
  )
}

/** What Remove puts back. */
export function removeCostLine(saving: WorkspaceSaving): string {
  const perDay = creditsFor(scheduleCpuSecondsPerDay(saving))
  const live = liveCpuSecondsPerDay(saving)
  return (
    `This stops the schedules' own charge (${formatRecurringCost(perDay)}) and puts the live queries back: ` +
    `both panels run their own query again on every paint, which this workspace measured at ` +
    `${creditSpanWords({ low: creditsFor(live.low), high: creditsFor(live.high) })}.`
  )
}

/** One entry's line in the estimate, basis and all. */
export function entrySavingWords(saving: EntrySaving): string {
  const basis =
    saving.scheduledRun.basis === 'measured'
      ? 'the scheduled run’s cost was measured'
      : saving.scheduledRun.extrapolated
        ? 'the scheduled run’s cost is arithmetic from outside the model’s measured range'
        : 'the scheduled run’s cost is modelled'
  const rate = saving.breakEvenRunsPerDay === null ? null : round2(saving.breakEvenRunsPerDay)
  const breakEven = rate === null ? '' : ` · below ${rate} ${rate === 1 ? 'view' : 'views'} a day it costs more than it saves`
  const assumed = saving.assumedFrequency ? ' · how often this panel is opened was never measured' : ''
  return `${basis}${breakEven}${assumed}`
}

// ── What each confirmation names ────────────────────────────────────────────

export const SAVED_KIND = 'Cribl Search saved search'

/**
 * The objects Apply will write.
 *
 * Built from the same rows `applyPlan()` walks, and the test asserts the two
 * agree in both directions: every id here is named in `plan.willWrite`, and no
 * id in `plan.willLeave` appears here. That is the guarantee the provisioning
 * module asked for — a dialog that re-derives its own list will eventually name
 * a different set from the one the run touches — kept while the dialog still
 * gets structured resources rather than prose it would have to parse.
 */
export function applyResources(state: AccelState): ConfirmResource[] {
  const out: ConfirmResource[] = []
  for (const row of state.rows) {
    if (row.state === 'absent') {
      out.push({
        action: 'create',
        kind: SAVED_KIND,
        id: row.id,
        group: SEARCH_GROUP,
        detail: `${row.entry.name} · runs ${row.entry.cron} ${row.entry.tz} over ${row.entry.earliest} → ${row.entry.latest}, keeping the last ${row.entry.keepLastN} runs readable. Feeds ${row.entry.serves}.`,
      })
    } else if (row.state === 'differs') {
      out.push({
        action: 'replace',
        kind: SAVED_KIND,
        id: row.id,
        group: SEARCH_GROUP,
        detail: `Overwritten with what this release defines, because ${row.differences.join(' and ')} ${row.differences.length === 1 ? 'differs' : 'differ'}. Whether it is paused stays as it is.`,
      })
    }
  }
  return out
}

/** The objects Remove will delete. Only what is really there, and only what
 *  this app can prove it created. */
export function removeResources(state: AccelState): ConfirmResource[] {
  const out: ConfirmResource[] = []
  for (const row of state.rows) {
    if (row.state === 'absent' || row.state === 'unreadable') continue
    if (!row.ours && !row.recorded) continue
    out.push({
      action: 'delete',
      kind: SAVED_KIND,
      id: row.id,
      group: SEARCH_GROUP,
      detail: `${row.entry.name} · ${row.entry.serves} goes back to running its own query on every paint.`,
    })
  }
  return out
}

/**
 * The sentence that has to be in the teardown dialog, and the reason this whole
 * control exists rather than leaving it to uninstall. Decision I-D28.
 */
export const UNINSTALL_WARNING =
  'Uninstalling this app does NOT remove these searches. The platform gives an app no uninstall hook, the ' +
  'record this app keeps of what it created lives in app storage that is deleted with the app, and a ' +
  'non-admin loses the grant needed to delete them afterwards. Left behind, they keep firing on their cron ' +
  'and keep billing, with nothing in the workspace to say what they were for. Remove them here first.'

/** The literal a person types to confirm the teardown. Words, not an id: an id
 *  gets pasted, which proves nothing. */
export const REMOVE_LITERAL = 'remove acceleration'

// ── What the panel says before anybody presses anything ─────────────────────
//
// One lead line, and the rest behind an ⓘ (Guided Setup's declutter,
// 2026-09-24). The intro this replaces named "two panels" — true of Phase 2's
// first release, and stale once the manifest grew to the entries it holds now.
// The estimate block below the table is NOT moved behind an icon: see the
// panel's header on why its provenance stays visible.

export const ACCEL_LEAD =
  'Runs the most expensive panel queries on a schedule, and has those panels read the stored result instead.'

export const ACCEL_LEAD_TIP =
  'It adds no new number to any screen: it changes where existing numbers come from, and each panel’s ⓘ still shows the query behind its figure, because that query is what ran. ' +
  'The schedules bill whether or not anybody opens the app, and uninstalling the app does not stop them — Remove acceleration does.'

/** The one preset on offer. The words are behind its ⓘ; the name is the label. */
export const SAVINGS_PRESET_TIP =
  'Schedules only the queries that are expensive to run live, each at the cadence its answer actually changes at. There is no cadence control: a faster schedule costs more and answers the same question.'

/** The disabled preset's reason. Visible, because it is why the option cannot be picked. */
export const DEFAULT_VIEW_UNAVAILABLE = 'Not available: on today’s JSON dataset it would cost more than it saves.'

export const DEFAULT_VIEW_TIP =
  'It would schedule the panels each tab opens on, billing for a precomputed answer far more often than the live queries it replaces, until the dataset is cheaper to scan.'

/** What pausing or resuming one entry does to the bill, both ways round. */
export function scheduleCostLine(saving: WorkspaceSaving, id: string, enable: boolean): string {
  const entry = saving.entries.find((e) => e.id === id)
  if (!entry) return ''
  const schedule = creditsFor(entry.scheduledRun.cpuSeconds * entry.scheduledRunsPerDay)
  const live = creditSpanWords({ low: creditsFor(entry.beforeCpuSeconds.low), high: creditsFor(entry.beforeCpuSeconds.high) })
  return enable
    ? `Starts this schedule's charge again (${formatRecurringCost(schedule)}) and stops the live query's (${live}).`
    : `Stops this schedule's charge (${formatRecurringCost(schedule)}). The panel it feeds goes back to its live query, which this workspace bills ${live} for.`
}
