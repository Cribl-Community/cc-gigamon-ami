// Which dashboard tab each scheduled search serves, and the rule that turns a
// set of switches into a set of enabled schedules.
//
// ─────────────────────────────────────────────────────────────────────────────
// OWNER DECISION, 2026-09-24: acceleration is a DEFAULT, switchable per
// dashboard tab plus a master switch, each showing its own cost. This module is
// the pure half of that: no network, no clock, no DOM.
//
// ── THE MAPPING IS DERIVED, NOT KEPT ────────────────────────────────────────
// Every manifest entry already lists the panels it serves, and every panel's
// `queryId` already starts with its tab's slug (`capacity-kpi`, `web-hosts`,
// `tcp-heatmap-24-…`). So the only table here is the list of TABS — route,
// label and that slug — and the tab → schedules mapping is computed from the
// manifest. A new entry needs no edit here; a new tab slug with no row here
// fails tabs.test.ts, which also reads every src/tabs/*.tsx for the `gno_` ids
// it names and asserts the derived mapping agrees with the code in both
// directions, and reads App.tsx for each route and label.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A schedule is enabled iff the master switch is on AND at least one tab it
// serves is on. `scheduleEnabled` is that sentence and nothing else.
//
// ── THE STATE IS READ, NOT REMEMBERED ───────────────────────────────────────
// A tab's switch is derived from the live saved searches' `schedule.enabled`,
// never from a stored preference: a preference is a second truth, and the
// first time somebody pauses a search in Cribl's own UI the two disagree and
// the switch lies. The price of that honesty is written down rather than
// hidden:
//
//   * A TAB WHOSE SCHEDULES DISAGREE IS `mixed`, not on and not off — judged
//     only over the rows it can switch; the others are a count beside it.
//   * A FLIP MOVES ONE WAY. An off flip only pauses and an on flip only
//     resumes, whatever the rule would say from a mixed state; and a Mixed
//     switch flips OFF (`flipPlan`). Review 2026-09-24, defects 1–3.
//   * TABS THAT SHARE A SCHEDULE CANNOT BE TOLD APART BY IT. Findings and
//     Security read only `gno_overview_c1h`, which also feeds Capacity, Web &
//     API and Data Flow. So, when a tab T is switched OFF, another tab S counts
//     as "on" only on evidence that does not come from T's own schedules — at
//     least one of S's schedules outside T's set is running. Without that
//     condition a shared schedule votes for itself through every tab it feeds
//     and could never be paused by any tab switch at all.
//   * Turning a tab ON enables every schedule it reads, because the rule says a
//     schedule serving an on tab is on.
//   * THE MASTER SWITCH HAS NO MEMORY. Off pauses every schedule this app can
//     change; on resumes every one — "all tabs on" — because there is no stored
//     set of tabs to restore, and inventing one is the second truth above.
//
// Only rows this app may flip take part (enabled or paused, ours, with a
// schedule — the same test `rowAction` in components/accelPanelCopy.ts makes;
// tabs.test.ts pins that the two agree). An absent, foreign, unreadable or
// schedule-less row is never written by a switch, and the plan says why.
//
// ── NOT IN THIS SLICE (TODO) ────────────────────────────────────────────────
//   * TODO(onboarding): installing acceleration as part of the onboarding run
//     belongs to the branch rewriting onboarding; this module only switches
//     schedules that Apply already created.
//
// ── WHILE ONLY SAMPLE DATA EXISTS ───────────────────────────────────────────
// Every schedule scans the customer's dataset, so while it holds nothing
// (cribl/datasetTarget.ts) a schedule is a charge for a stored run of nothing.
// That is a third input to `scheduleEnabled`, beside the master switch and the
// tabs — `realData` — and like them it is READ, never stored. With it false, no
// flip turns anything on: an on flip plans no change and says why
// (`refused: 'sample-only'`); an off flip still pauses, because off is the
// state the rule asks for. The same holds while the check has not given a FINAL
// answer (`unverified`, `refused: 'unverified'`): "not known to be sample" is
// not "real data exists", and a schedule turned on in that window keeps billing
// if the answer turns out to be sample.

import { MANIFEST, type AccelEntry, type AccelId } from './manifest'
import type { AccelRow, AccelState } from './provision'

/** One dashboard tab that at least one scheduled search can serve. */
export interface AccelTab {
  /** The route's last segment, which is also the key. */
  readonly key: AccelTabKey
  /** The route in src/App.tsx's TABS. Checked against that file by the test. */
  readonly route: string
  /** The label in src/App.tsx's TABS, so the switch says what the tab bar says. */
  readonly label: string
  /** The `queryId` prefix every panel on this tab uses in the manifest. */
  readonly prefix: string
}

export type AccelTabKey =
  | 'findings'
  | 'security'
  | 'flow-map'
  | 'capacity'
  | 'tcp-health'
  | 'dns-health'
  | 'web-api'
  | 'ai-saas'
  | 'data-flow'
  | 'fields'

/** In the tab bar's order. Tabs no schedule serves (TLS, PQC, Reference, Setup)
 *  are not here: a switch for a tab nothing accelerates would switch nothing. */
export const ACCEL_TABS: readonly AccelTab[] = Object.freeze([
  { key: 'findings', route: '/findings', label: 'Findings', prefix: 'findings-' },
  { key: 'security', route: '/security', label: 'Security', prefix: 'security-' },
  { key: 'flow-map', route: '/flow-map', label: 'Flow Map', prefix: 'flow-map-' },
  { key: 'capacity', route: '/capacity', label: 'Capacity & Top Talkers', prefix: 'capacity-' },
  { key: 'tcp-health', route: '/tcp-health', label: 'TCP Health', prefix: 'tcp-' },
  { key: 'dns-health', route: '/dns-health', label: 'DNS Health', prefix: 'dns-' },
  { key: 'web-api', route: '/web-api', label: 'Web & API', prefix: 'web-' },
  { key: 'ai-saas', route: '/ai-saas', label: 'Shadow AI', prefix: 'shadow-ai-' },
  { key: 'data-flow', route: '/data-flow', label: 'Data Flow', prefix: 'data-flow-' },
  { key: 'fields', route: '/fields', label: 'Field Explorer', prefix: 'field-explorer-' },
] satisfies AccelTab[])

export function accelTab(key: AccelTabKey): AccelTab {
  const tab = ACCEL_TABS.find((t) => t.key === key)
  if (!tab) throw new Error(`unknown tab '${key}'`)
  return tab
}

/** The tab a served panel is on, or null for a `queryId` no tab claims — which
 *  the test treats as a failure, not a pass. */
export function tabOfQueryId(queryId: string): AccelTab | null {
  // Longest prefix first, so a future `flow-` could not swallow `flow-map-`.
  const byLength = [...ACCEL_TABS].sort((a, b) => b.prefix.length - a.prefix.length)
  return byLength.find((t) => queryId.startsWith(t.prefix)) ?? null
}

/** Entries are frozen and never change while the page is open, so each one's
 *  tabs are worked out once — the panel re-renders on every step of a write. */
const tabsMemo = new WeakMap<AccelEntry, readonly AccelTabKey[]>()

/** The tabs one schedule serves, in tab-bar order. */
export function tabsOfEntry(entry: AccelEntry): readonly AccelTabKey[] {
  const held = tabsMemo.get(entry)
  if (held) return held
  const keys = new Set(entry.panels.map((p) => tabOfQueryId(p.queryId)?.key).filter((k): k is AccelTabKey => k !== undefined))
  const out = Object.freeze(ACCEL_TABS.filter((t) => keys.has(t.key)).map((t) => t.key))
  tabsMemo.set(entry, out)
  return out
}

/** The schedules one tab reads, in manifest order. */
export function schedulesOfTab(key: AccelTabKey, manifest: readonly AccelEntry[] = MANIFEST): AccelId[] {
  return manifest.filter((e) => tabsOfEntry(e).includes(key)).map((e) => e.id)
}

/** The schedules only this tab reads — what its switch alone decides, and so
 *  the only cost its line may claim as its own. */
export function ownSchedulesOfTab(key: AccelTabKey, manifest: readonly AccelEntry[] = MANIFEST): AccelId[] {
  return manifest.filter((e) => tabsOfEntry(e).length === 1 && tabsOfEntry(e)[0] === key).map((e) => e.id)
}

/** The schedules this tab reads that another tab reads too. */
export function sharedSchedulesOfTab(key: AccelTabKey, manifest: readonly AccelEntry[] = MANIFEST): AccelId[] {
  return manifest.filter((e) => tabsOfEntry(e).length > 1 && tabsOfEntry(e).includes(key)).map((e) => e.id)
}

export type TabSwitches = Readonly<Record<AccelTabKey, boolean>>

/** Every tab on — the default the owner decided on. */
export const ALL_TABS_ON: TabSwitches = Object.freeze(
  Object.fromEntries(ACCEL_TABS.map((t) => [t.key, true])) as Record<AccelTabKey, boolean>,
)

/**
 * THE RULE. A schedule is enabled iff the customer's dataset holds real data
 * AND the master switch is on AND at least one tab it serves is on.
 *
 * `realData` defaults to true — every install before sample data existed, and
 * every install once real data has landed.
 */
export function scheduleEnabled(entry: AccelEntry, master: boolean, tabs: TabSwitches, realData = true): boolean {
  return realData && master && tabsOfEntry(entry).some((k) => tabs[k])
}

/** What a switch knows about the workspace beyond the saved searches. */
export interface SwitchContext {
  /** The app is reading the sample dataset: the customer's holds no data. */
  sampleOnly?: boolean
  /** The dataset check has no final answer yet (cribl/datasetTarget.ts
   *  `realDataConfirmed`). Refuses an ON flip exactly as `sampleOnly` does. */
  unverified?: boolean
}

// ── What is there now ───────────────────────────────────────────────────────

/**
 * Whether a switch may write this row, and if so what its schedule is now.
 *
 * `true`/`false` is the stored `schedule.enabled`. `null` means a switch leaves
 * it alone, for the reason in `why`. Mirrors `rowAction` in
 * components/accelPanelCopy.ts, which is where the per-row control makes the
 * same decision; tabs.test.ts pins that they agree.
 */
export function switchable(row: AccelRow): { enabled: boolean | null; why: string | null } {
  if (row.state === 'absent' && row.windowUnresolved) {
    return { enabled: null, why: 'not created yet — the Lake dataset’s retention could not be read, so the window it would read is not known' }
  }
  if (row.state === 'absent') return { enabled: null, why: 'not created yet — Review changes creates it' }
  if (row.state === 'foreign' || (!row.ours && !row.recorded)) return { enabled: null, why: 'not created by this app, so no switch here changes it' }
  if (row.state === 'unreadable') return { enabled: null, why: 'Cribl would not say what state it is in' }
  if (row.enabled === null) return { enabled: null, why: 'it has no readable schedule — Review changes restores one' }
  return { enabled: row.enabled, why: null }
}

export type SwitchState = 'on' | 'off' | 'mixed' | 'unavailable'

export interface SwitchReading {
  /**
   * Decided from the rows the switch can change and nothing else: `on` when
   * none of them is paused, `off` when none is running, `mixed` only when both
   * lists are non-empty, `unavailable` when there is no such row. A row the
   * switch cannot change (absent, foreign, unreadable, no schedule) is counted
   * in `untouchable` beside it, never as a vote — review 2026-09-24, defect 1:
   * counting it made one unapplied entry read the master as Mixed, and a Mixed
   * switch could not be turned off.
   */
  state: SwitchState
  /** Every schedule the switch covers, in manifest order. */
  ids: readonly AccelId[]
  running: readonly AccelId[]
  paused: readonly AccelId[]
  /** Schedules the switch cannot change, and why. */
  untouchable: readonly { id: AccelId; why: string }[]
}

/** The live `enabled` flag of every row a switch may change. */
export type LiveSchedules = ReadonlyMap<AccelId, boolean>

export function liveSchedules(state: AccelState): LiveSchedules {
  const out = new Map<AccelId, boolean>()
  if (state.error !== null) return out
  for (const row of state.rows) {
    const s = switchable(row)
    if (s.enabled !== null) out.set(row.id, s.enabled)
  }
  return out
}

function reasons(state: AccelState): Map<AccelId, string> {
  const out = new Map<AccelId, string>()
  for (const row of state.rows) {
    const why = state.error !== null ? 'this app could not read the saved-search list' : switchable(row).why
    if (why !== null) out.set(row.id, why)
  }
  return out
}

function reading(ids: readonly AccelId[], live: LiveSchedules, why: ReadonlyMap<AccelId, string>): SwitchReading {
  const running = ids.filter((id) => live.get(id) === true)
  const paused = ids.filter((id) => live.get(id) === false)
  const untouchable = ids.filter((id) => !live.has(id)).map((id) => ({ id, why: why.get(id) ?? 'not read yet' }))
  const state: SwitchState =
    running.length + paused.length === 0
      ? 'unavailable'
      : paused.length === 0
        ? 'on'
        : running.length === 0
          ? 'off'
          : 'mixed'
  return { state, ids, running, paused, untouchable }
}

/** Each tab's switch, read from the saved searches as they are. */
export function tabReadings(state: AccelState): Record<AccelTabKey, SwitchReading> {
  const live = liveSchedules(state)
  const why = reasons(state)
  return Object.fromEntries(ACCEL_TABS.map((t) => [t.key, reading(schedulesOfTab(t.key), live, why)])) as Record<
    AccelTabKey,
    SwitchReading
  >
}

/** The master switch, read the same way over every schedule. */
export function masterReading(state: AccelState): SwitchReading {
  return reading(MANIFEST.map((e) => e.id), liveSchedules(state), reasons(state))
}

// ── What a flip would do ────────────────────────────────────────────────────

export type ToggleTarget = { kind: 'master'; on: boolean } | { kind: 'tab'; tab: AccelTabKey; on: boolean }

export interface ToggleChange {
  id: AccelId
  entry: AccelEntry
  /** The enabled flag the dialog saw. The write refuses the row if Cribl no
   *  longer reports it, so a confirmation cannot be spent on a state it never
   *  described. */
  from: boolean
  to: boolean
  /** The tabs this schedule feeds. */
  tabs: readonly AccelTabKey[]
}

export interface TogglePlan {
  target: ToggleTarget
  /** Exactly the saved searches the write will PATCH. */
  changes: readonly ToggleChange[]
  /** Schedules the switch covers that stay running, and which on tab keeps each. */
  kept: readonly { id: AccelId; for: readonly AccelTabKey[] }[]
  /** Schedules the switch covers and cannot change, and why. */
  untouchable: readonly { id: AccelId; why: string }[]
  /** Schedules the switch covers that were ALREADY where the flip points before
   *  it — paused before an off flip, running before an on flip. The undo line
   *  names them, because flipping back does not return them to that state. */
  already: readonly AccelId[]
  /** Every tab whose switch reads differently afterwards, the target included. */
  tabsChanged: readonly { tab: AccelTabKey; before: SwitchState; after: SwitchState }[]
  /** Why an ON flip plans nothing whatever the saved searches say, or null. */
  refused: 'sample-only' | 'unverified' | null
}

/**
 * The saved searches a flip would PATCH, from the live state.
 *
 * Built on `scheduleEnabled`: the target's switch takes its new value, every
 * other tab is on or off as the evidence says (see the header on why that
 * evidence excludes the target's own schedules), and only the target's own
 * schedules — or every schedule, for the master — are candidates to change.
 */
export function togglePlan(state: AccelState, target: ToggleTarget, ctx: SwitchContext = {}): TogglePlan {
  const realData = !ctx.sampleOnly && !ctx.unverified
  const live = liveSchedules(state)
  const why = reasons(state)
  const scope: AccelId[] = target.kind === 'master' ? MANIFEST.map((e) => e.id) : schedulesOfTab(target.tab)
  const inScope = new Set(scope)

  const tabs = Object.fromEntries(
    ACCEL_TABS.map((t) => {
      if (target.kind === 'master') return [t.key, target.on]
      if (t.key === target.tab) return [t.key, target.on]
      // On only on evidence from outside the target's schedules.
      const evidence = schedulesOfTab(t.key).some((id) => !inScope.has(id) && live.get(id) === true)
      return [t.key, evidence]
    }),
  ) as Record<AccelTabKey, boolean>
  const master = target.kind === 'master' ? target.on : true

  const changes: ToggleChange[] = []
  const kept: { id: AccelId; for: AccelTabKey[] }[] = []
  const already: AccelId[] = []
  for (const entry of MANIFEST) {
    if (!inScope.has(entry.id)) continue
    const now = live.get(entry.id)
    if (now === undefined) continue
    if (now === target.on) already.push(entry.id)
    const to = scheduleEnabled(entry, master, tabs, realData)
    const served = tabsOfEntry(entry)
    // A flip moves schedules ONE way: an off flip never resumes, an on flip
    // never pauses (review 2026-09-24, defect 2). The rule can say otherwise
    // from a mixed state — Data Flow off with the shared overview paused once
    // wanted overview resumed, under a dialog titled Pause — and when it does,
    // that row is simply left as it is.
    if (to !== now && to === target.on) changes.push({ id: entry.id, entry, from: now, to, tabs: served })
    else if (to && now && target.kind === 'tab' && !target.on) {
      kept.push({ id: entry.id, for: served.filter((k) => k !== target.tab && tabs[k]) })
    }
  }

  const before = tabReadings(state)
  const afterLive = new Map(live)
  for (const c of changes) afterLive.set(c.id, c.to)
  const tabsChanged = ACCEL_TABS.flatMap((t) => {
    const after = reading(schedulesOfTab(t.key), afterLive, why).state
    return after === before[t.key].state ? [] : [{ tab: t.key, before: before[t.key].state, after }]
  })

  return {
    target,
    changes,
    kept,
    untouchable: scope.filter((id) => !live.has(id)).map((id) => ({ id, why: why.get(id) ?? 'not read yet' })),
    already,
    tabsChanged,
    refused: !target.on || realData ? null : ctx.sampleOnly ? 'sample-only' : 'unverified',
  }
}

/**
 * What flipping one switch means, from what it reads now.
 *
 * On goes off and off goes on. MIXED GOES OFF (review 2026-09-24, defect 3):
 * pausing the rest is the cheaper and safer direction, and a Mixed switch that
 * could only go on made a user who wanted a tab off start a charge first. The
 * one exception is a Mixed tab whose running schedules are all kept by other
 * tabs, so off would change nothing; then the flip goes on, and the dialog's
 * title and button say Resume. Unavailable asks for on, which changes nothing
 * and says why beside the switch.
 */
export function flipPlan(state: AccelState, key: AccelTabKey | 'master', ctx: SwitchContext = {}): TogglePlan {
  const r = key === 'master' ? masterReading(state) : tabReadings(state)[key]
  const target = (on: boolean): ToggleTarget => (key === 'master' ? { kind: 'master', on } : { kind: 'tab', tab: key, on })
  if (r.state === 'on') return togglePlan(state, target(false), ctx)
  if (r.state === 'mixed') {
    const off = togglePlan(state, target(false), ctx)
    return off.changes.length ? off : togglePlan(state, target(true), ctx)
  }
  return togglePlan(state, target(true), ctx)
}
