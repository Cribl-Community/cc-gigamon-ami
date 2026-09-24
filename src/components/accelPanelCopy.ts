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
import { MANIFEST, type AccelEntry } from '../cribl/accel/manifest'
import type { AccelEntryState, AccelRow, AccelState } from '../cribl/accel/provision'
import type { AccelStatus } from '../cribl/accel/status'
import { cadenceLooksRight } from '../cribl/accel/status'
import { creditsFor, type EntrySaving, type ScheduleSetCost, type Span, type WorkspaceSaving } from '../cribl/accel/estimate'
import {
  ACCEL_TABS,
  accelTab,
  ownSchedulesOfTab,
  schedulesOfTab,
  sharedSchedulesOfTab,
  tabsOfEntry,
  type AccelTabKey,
  type SwitchReading,
  type SwitchState,
  type TogglePlan,
} from '../cribl/accel/tabs'
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
  'The schedules bill whether or not anybody opens the app, and uninstalling the app does not stop them. The switches here pause them — per dashboard or all at once — and the panels they fed run their live queries again; Remove acceleration deletes the scheduled searches outright.'

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

// ── The switches: one per dashboard tab, and the master ─────────────────────
//
// Owner decision 2026-09-24: acceleration is a default, switchable per tab and
// for everything at once, each switch showing its own cost. The rule and the
// reading live in cribl/accel/tabs.ts; this is only what the switches say.

/** One lead line; the rule and its consequences are behind the ⓘ. */
export const SWITCHES_LEAD = 'On by default. Switch it off for a dashboard nobody opens, or for all of them.'

/** "a", "a and b", "a, b and c". */
const andList = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/**
 * The tabs that read only searches other tabs share, and the tabs that keep
 * those searches running — DERIVED from the manifest (review 2026-09-24,
 * defect 6: this was fixed text that the next manifest change would falsify).
 * Tabs reading the same shared set are one sentence. Empty when no tab reads
 * only shared searches.
 */
export function sharedOnlyTabsSentence(manifest: readonly AccelEntry[] = MANIFEST): string {
  const groups = new Map<string, AccelTabKey[]>()
  for (const t of ACCEL_TABS) {
    const all = schedulesOfTab(t.key, manifest)
    if (all.length === 0 || ownSchedulesOfTab(t.key, manifest).length > 0) continue
    const key = sharedSchedulesOfTab(t.key, manifest).join(', ')
    groups.set(key, [...(groups.get(key) ?? []), t.key])
  }
  return [...groups.entries()]
    .map(([ids, tabs]) => {
      const feeds = new Set(manifest.filter((e) => ids.split(', ').includes(e.id)).flatMap((e) => tabsOfEntry(e)))
      // Only tabs with a search of their own can hold a shared one on: a tab
      // that reads nothing but shared searches is never evidence for them.
      const others = ACCEL_TABS.filter((t) => feeds.has(t.key) && !tabs.includes(t.key) && ownSchedulesOfTab(t.key, manifest).length > 0)
      const names = andList(tabs.map((k) => accelTab(k).label))
      const one = tabs.length === 1
      return (
        `${names} ${one ? 'reads' : 'read'} only ${ids}, which other dashboards share, so ` +
        `${one ? 'it goes off' : 'they go off together, and'} only once ${andList(others.map((t) => t.label))} ${others.length === 1 ? 'is' : 'are'} off too.`
      )
    })
    .join(' ')
}

export const SWITCHES_LEAD_TIP = [
  'A scheduled search runs while the master switch is on and at least one dashboard it feeds is on.',
  'Some searches feed several dashboards, so switching one dashboard off pauses only the searches no other dashboard that is on still reads.',
  sharedOnlyTabsSentence(),
  'Each switch is read from the saved searches themselves, not from a remembered setting, so a search paused in Cribl shows here as Mixed; flipping a Mixed switch turns it off.',
  'A search this app cannot switch (not created yet, or not its own) is counted beside the switch and never decides which way it points.',
  'The master switch keeps no memory of which dashboards were off: on resumes every one.',
]
  .filter(Boolean)
  .join(' ')

/** A switch's state as one word. The switch itself shows only on/off; this is
 *  what says Mixed, which a two-position control cannot. */
export const SWITCH_WORD: Record<SwitchState, string> = {
  on: 'On',
  off: 'Off',
  mixed: 'Mixed',
  unavailable: 'Not set up',
}

const searches = (n: number) => `${n} scheduled ${n === 1 ? 'search' : 'searches'}`

/** The state, with the counts that make Mixed a statement rather than a shrug. */
export function switchStateWords(r: SwitchReading): string {
  const untouchable = r.untouchable.length ? ` · ${r.untouchable.length} not switchable here` : ''
  switch (r.state) {
    case 'on':
      return `On — ${searches(r.running.length)} running${untouchable}`
    case 'off':
      return `Off — ${searches(r.paused.length)} paused${untouchable}`
    case 'mixed':
      return `Mixed — ${r.running.length} of ${r.running.length + r.paused.length} running${untouchable}`
    case 'unavailable':
      return `Not set up — none of its ${searches(r.ids.length)} can be switched here`
  }
}

/**
 * What a set of schedules costs and saves, as one line. Both halves, always:
 * a charge without the saving reads as a bill, a saving without the charge
 * reads as free. "Estimated" rides on the line whenever any part was modelled
 * or assumed; the provenance sentence goes in the ⓘ beside it.
 */
export function setCostWords(cost: ScheduleSetCost): string {
  if (cost.basis === 'none') return 'no scheduled search — nothing billed, nothing saved'
  const flag = cost.basis === 'measured' && !cost.saving.assumedFrequency && !cost.saving.modelledLiveCost ? '' : ' (estimated)'
  return `bills ${creditSpanWords(cost.chargeCredits)} · saves ${creditSpanWords(cost.saving.savedCredits)}${flag}`
}

/**
 * One tab's line: what the searches only it reads bill and save, and the
 * shared ones by name. Review 2026-09-24, defect 5: the line used to bill each
 * tab for every search it reads, so Findings claimed the whole overview
 * scan's saving, a saving that stays while Capacity, Web & API or Data Flow
 * is on whatever Findings' switch says. A shared search's cost is in the ⓘ.
 */
export function tabCostWords(key: AccelTabKey, own: ScheduleSetCost): string {
  const shared = sharedSchedulesOfTab(key)
  const mine = own.ids.length ? setCostWords(own) : 'no scheduled search of its own'
  return shared.length ? `${mine} · shares ${shared.join(', ')}` : mine
}

/** The switch's accessible name. The visible label is the tab's name. */
export function switchName(key: AccelTabKey | 'master'): string {
  return key === 'master' ? 'Acceleration for every dashboard' : `Acceleration for ${accelTab(key).label}`
}

const labels = (keys: readonly AccelTabKey[]) => keys.map((k) => accelTab(k).label).join(', ')

/**
 * Whether the plan's writes resume, from the changes themselves rather than
 * from the target (review 2026-09-24, defect 8). `togglePlan` now only moves
 * rows the target's way, so the two agree; this is what keeps the words true
 * if they ever do not.
 */
export function planResumes(plan: TogglePlan): boolean {
  return plan.changes.length ? plan.changes.every((c) => c.to) : plan.target.on
}

/** The dialog's title: kind, how many, and where. */
export function toggleTitle(plan: TogglePlan): string {
  const n = plan.changes.length
  const up = planResumes(plan)
  const what = `${up ? 'Resume' : 'Pause'} ${n === 1 ? 'a scheduled Cribl Search saved search' : `${n} scheduled Cribl Search saved searches`} in ${SEARCH_GROUP}`
  return plan.target.kind === 'master'
    ? `Acceleration ${up ? 'on' : 'off'} for every dashboard: ${what}`
    : `Acceleration ${up ? 'on' : 'off'} for ${accelTab(plan.target.tab).label}: ${what}`
}

/** The toast after a confirmed flip: each id under the word for what was done to it. */
export function toggleDoneWords(plan: TogglePlan, done: readonly string[]): string {
  const to = new Map(plan.changes.map((c) => [c.id as string, c.to]))
  const paused = done.filter((id) => to.get(id) === false)
  const resumed = done.filter((id) => to.get(id) === true)
  return [paused.length ? `Paused: ${paused.join(', ')}.` : '', resumed.length ? `Resumed: ${resumed.join(', ')}.` : ''].filter(Boolean).join(' ')
}

/**
 * The dialog's undo line, by what was switched (review 2026-09-24, defect 4).
 * Flipping back does not restore the state before this flip: it applies the
 * rule again, so any search that was ALREADY where this flip points is named
 * as one flipping back will move too.
 */
export function toggleUndo(plan: TogglePlan): string {
  const up = planResumes(plan)
  const n = plan.already.length
  const already = n
    ? ` That includes ${plan.already.join(', ')}, which ${n === 1 ? 'was' : 'were'} already ${up ? 'running' : 'paused'} before this and ${n === 1 ? 'is' : 'are'} not put back that way.`
    : ''
  const back =
    plan.target.kind === 'master'
      ? up
        ? 'Turning the master switch off again pauses every search this app can switch.'
        : 'Turning the master switch back on resumes every search this app can switch.'
      : up
        ? `Turning ${accelTab(plan.target.tab).label} off again pauses the searches it reads that no other dashboard that is on still reads.`
        : `Turning ${accelTab(plan.target.tab).label} back on resumes every search it reads.`
  return `${back}${already} Nothing is deleted.`
}

/** Exactly the saved searches the write will PATCH — `plan.changes`, no more. */
export function toggleResources(plan: TogglePlan): ConfirmResource[] {
  return plan.changes.map((c) => ({
    action: 'replace' as const,
    kind: SAVED_KIND,
    id: c.id,
    group: SEARCH_GROUP,
    detail: c.to
      ? `${c.entry.name} · its schedule is turned back on (${c.entry.cron} ${c.entry.tz}). Feeds ${labels(c.tabs)}.`
      : `${c.entry.name} · its schedule is turned off; the saved search and the runs it stored are kept. Feeds ${labels(c.tabs)}.`,
  }))
}

/** What the flip does to the bill, in the direction it goes. `cost` is the
 *  estimate for exactly `plan.changes`. */
export function toggleCostLine(plan: TogglePlan, cost: ScheduleSetCost): string {
  const live = liveCpuSecondsPerDay(cost.saving)
  const liveWords = creditSpanWords({ low: creditsFor(live.low), high: creditsFor(live.high) })
  const their = plan.changes.length === 1 ? 'this schedule’s' : 'these schedules’'
  return planResumes(plan)
    ? `Starts ${their} charge again (${creditSpanWords(cost.chargeCredits)}) whether or not anybody opens the dashboards, and replaces live queries this workspace bills ${liveWords} for — an expected net saving of ${creditSpanWords(cost.saving.savedCredits)}. An estimate, not a bill.`
    : `Stops ${their} charge (${creditSpanWords(cost.chargeCredits)}). The panels they feed go back to their live queries, which this workspace bills ${liveWords} for. An estimate, not a bill.`
}

const stateWord = (s: SwitchState) => SWITCH_WORD[s].toLowerCase()

/** Everything else the dialog must say: which dashboards change, what stays
 *  running and why, and what the switch will not touch. */
export function toggleConsequences(plan: TogglePlan): string[] {
  const out: string[] = []
  if (plan.tabsChanged.length) {
    out.push(`Dashboards that change: ${plan.tabsChanged.map((t) => `${accelTab(t.tab).label} ${stateWord(t.before)} → ${stateWord(t.after)}`).join('; ')}.`)
  }
  for (const k of plan.kept) {
    out.push(`Kept running: ${k.id} — it also feeds ${labels(k.for)}, which ${k.for.length === 1 ? 'is' : 'are'} on.`)
  }
  for (const u of plan.untouchable) out.push(`Not changed: ${u.id} — ${u.why}.`)
  if (plan.target.kind === 'master' && plan.target.on) {
    out.push('The master switch keeps no memory of which dashboards were off: this resumes every one.')
  }
  out.push('This endpoint carries no version to make a write conditional on, so this app re-reads each search before and after writing it, and leaves alone any that changed since this dialog opened.')
  return out
}

/** Why a flip has nothing to write — said beside the switch instead of opening
 *  a confirmation for nothing. Null when there is something to write. */
export function toggleNothingWords(plan: TogglePlan): string | null {
  if (plan.changes.length) return null
  if (plan.kept.length) {
    const ids = plan.kept.map((k) => k.id).join(', ')
    const tabs = [...new Set(plan.kept.flatMap((k) => k.for))]
    return `Stays on: ${ids} also ${plan.kept.length === 1 ? 'feeds' : 'feed'} ${labels(tabs)}, which ${tabs.length === 1 ? 'is' : 'are'} on.`
  }
  if (plan.untouchable.length) return `Nothing here can be switched: ${plan.untouchable.map((u) => `${u.id} — ${u.why}`).join('; ')}.`
  return `Already ${plan.target.on ? 'on' : 'off'}.`
}
