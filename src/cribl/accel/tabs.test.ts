// The per-dashboard switches' pure half: which tab each schedule serves, the
// enable rule, and what a flip would write.
//
// THE MAPPING IS CHECKED AGAINST THE CODE, NOT AGAINST ITSELF. tabs.ts derives
// tab → schedules from each panel's `queryId` prefix. A test that only re-ran
// that derivation would pass on any prefix table at all, so this one reads the
// tab components' SOURCE for the `gno_` ids they actually name and requires the
// two to agree in both directions, and reads App.tsx for each route and label.
// A panel moved to another tab, or a schedule a tab reads that the manifest
// attributes elsewhere, fails here.
//
// THE RULE IS CHECKED OVER THE REAL MANIFEST, because the interesting cases are
// the shared schedules and those only exist in the real one.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rowAction, toggleNothingWords } from '../../components/accelPanelCopy'
import { SAMPLE_ACCEL_OFF } from '../../components/sampleDataCopy'
import { MANIFEST, accelEntry, type AccelId } from './manifest'
import type { AccelEntryState, AccelRow, AccelState } from './provision'
import {
  ACCEL_TABS,
  ALL_TABS_ON,
  flipPlan,
  masterReading,
  ownSchedulesOfTab,
  scheduleEnabled,
  schedulesOfTab,
  sharedSchedulesOfTab,
  switchable,
  tabOfQueryId,
  tabReadings,
  tabsOfEntry,
  togglePlan,
  type AccelTabKey,
  type TabSwitches,
} from './tabs'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8')
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\s\/\/[^'"`\n]*$/gm, '')

/** App.tsx's TABS: route, label and the component, and the component's file. */
function appTabs(): { route: string; label: string; file: string }[] {
  const app = read('App.tsx')
  const files = new Map<string, string>()
  for (const m of app.matchAll(/import \{ (\w+) \} from '\.\/tabs\/(\w+)'/g)) files.set(m[1], `tabs/${m[2]}.tsx`)
  return [...app.matchAll(/\{ to: '([^']+)', label: '([^']+)', el: <(\w+) \/> \}/g)].map((m) => ({
    route: m[1],
    label: m[2],
    file: files.get(m[3]) ?? '',
  }))
}

/** The `gno_` ids a tab component names in code. */
const idsNamedIn = (file: string): Set<string> => new Set(withoutComments(read(file)).match(/\bgno_[a-z0-9_]+/g) ?? [])

// ── Fixtures ────────────────────────────────────────────────────────────────

function row(id: AccelId, state: AccelEntryState, over: Partial<AccelRow> = {}): AccelRow {
  const enabled = state === 'enabled' ? true : state === 'paused' ? false : state === 'absent' || state === 'unreadable' ? null : true
  return {
    id,
    entry: accelEntry(id),
    state,
    enabled,
    differences: [],
    stamp: null,
    ours: state !== 'foreign',
    recorded: false,
    intended: {} as AccelRow['intended'],
    stored: null,
    ...over,
  }
}

function stateOf(states: Partial<Record<AccelId, AccelEntryState>>, rest: AccelEntryState = 'enabled'): AccelState {
  return {
    rows: MANIFEST.map((e) => row(e.id, states[e.id] ?? rest)),
    orphans: [],
    denied: false,
    error: null,
    truncated: false,
    readAt: 0,
  }
}

const allIds = MANIFEST.map((e) => e.id)
/** Schedules only this tab reads. */
const exclusiveTo = (key: AccelTabKey) => schedulesOfTab(key).filter((id) => tabsOfEntry(accelEntry(id)).length === 1)
const sorted = (ids: readonly string[]) => [...ids].sort()

// ── The mapping ─────────────────────────────────────────────────────────────

describe('which tab a schedule serves', () => {
  it('knows the tab of every panel every schedule serves', () => {
    const unknown = MANIFEST.flatMap((e) => e.panels.filter((p) => tabOfQueryId(p.queryId) === null).map((p) => `${e.id}: ${p.queryId}`))
    expect(unknown).toEqual([])
  })

  it('maps every schedule to at least one tab', () => {
    expect(MANIFEST.filter((e) => tabsOfEntry(e).length === 0).map((e) => e.id)).toEqual([])
  })

  it('gives every switchable tab at least one schedule — a switch that switches nothing is not offered', () => {
    expect(ACCEL_TABS.filter((t) => schedulesOfTab(t.key).length === 0).map((t) => t.key)).toEqual([])
  })

  it('uses the route and the label the tab bar uses', () => {
    const app = appTabs()
    for (const t of ACCEL_TABS) {
      expect(app.find((a) => a.route === t.route), `${t.route} is not a route in App.tsx`).toMatchObject({ route: t.route, label: t.label })
    }
  })

  it('agrees with the gno_ ids each tab component names, in both directions', () => {
    // The code is the witness: a tab that reads a schedule names its id.
    const app = appTabs()
    for (const t of ACCEL_TABS) {
      const file = app.find((a) => a.route === t.route)?.file ?? ''
      expect(file, `no component file for ${t.route}`).not.toBe('')
      expect(sorted([...idsNamedIn(file)]), `${file} vs the manifest's panels for ${t.key}`).toEqual(sorted(schedulesOfTab(t.key)))
    }
  })

  it('leaves no tab that reads a schedule without a switch', () => {
    const switchable = new Set(ACCEL_TABS.map((t) => t.route))
    const unswitched = appTabs().filter((a) => !switchable.has(a.route) && a.file && idsNamedIn(a.file).size > 0)
    expect(unswitched.map((a) => a.route)).toEqual([])
  })

  it('knows the shared overview scan feeds five tabs, and Findings and Security read nothing else', () => {
    expect(tabsOfEntry(accelEntry('gno_overview_c1h'))).toEqual(['findings', 'security', 'capacity', 'web-api', 'data-flow'])
    expect(schedulesOfTab('findings')).toEqual(['gno_overview_c1h'])
    expect(schedulesOfTab('security')).toEqual(['gno_overview_c1h'])
  })
})

// ── The rule ────────────────────────────────────────────────────────────────

describe('a schedule is enabled iff the master is on AND at least one tab it serves is on', () => {
  const only = (...on: AccelTabKey[]): TabSwitches =>
    Object.fromEntries(ACCEL_TABS.map((t) => [t.key, on.includes(t.key)])) as unknown as TabSwitches

  it('is off with the master off, whatever the tabs say', () => {
    expect(MANIFEST.filter((e) => scheduleEnabled(e, false, ALL_TABS_ON))).toEqual([])
  })

  it('is on for every schedule with everything on', () => {
    expect(MANIFEST.every((e) => scheduleEnabled(e, true, ALL_TABS_ON))).toBe(true)
  })

  it('keeps a shared schedule on while any one of its tabs is', () => {
    const overview = accelEntry('gno_overview_c1h')
    expect(scheduleEnabled(overview, true, only('security'))).toBe(true)
    expect(scheduleEnabled(overview, true, only('tcp-health'))).toBe(false)
  })
})

// ── What is there now ───────────────────────────────────────────────────────

describe('reading a switch from the saved searches', () => {
  it('decides what a switch may write exactly as the per-row control does', () => {
    const cases: AccelRow[] = [
      row('gno_lake_30d_c1d', 'enabled'),
      row('gno_lake_30d_c1d', 'paused'),
      row('gno_lake_30d_c1d', 'differs'),
      row('gno_lake_30d_c1d', 'differs', { enabled: null }),
      row('gno_lake_30d_c1d', 'absent'),
      row('gno_lake_30d_c1d', 'foreign'),
      row('gno_lake_30d_c1d', 'unreadable'),
      // Unreadable is decided by the state, not by a flag that happens to be
      // null: a settle that failed after a stale flag was seen is still unknown.
      row('gno_lake_30d_c1d', 'unreadable', { enabled: true }),
      row('gno_lake_30d_c1d', 'enabled', { ours: false, recorded: false }),
    ]
    for (const r of cases) {
      const action = rowAction(r)
      const s = switchable(r)
      expect(s.enabled === null, `${r.state}/${String(r.enabled)}`).toBe(action.kind === 'none')
      if (action.kind !== 'none') expect(s.enabled).toBe(action.kind === 'pause')
    }
  })

  it('reads on, off and mixed from schedule.enabled', () => {
    const readings = tabReadings(stateOf({ gno_app_l4_c1h: 'paused' }))
    expect(readings['tcp-health'].state).toBe('on')
    expect(readings.capacity.state).toBe('mixed')
    expect(readings.capacity.running).toEqual(['gno_overview_c1h', 'gno_talkers_src_c1h'])
    expect(readings.capacity.paused).toEqual(['gno_app_l4_c1h'])
    expect(tabReadings(stateOf({}, 'paused')).capacity.state).toBe('off')
  })

  // Review 2026-09-24, defect 1: this test used to pin 'mixed' here. A row the
  // switch cannot change is not evidence about which way the switch points, and
  // counting it made the master switch unable to pause anything the day a
  // release added an entry nobody had applied yet.
  it('reads a tab from the searches it can switch, and counts a never-created one beside it', () => {
    const r = tabReadings(stateOf({ gno_web_h2_c1h: 'absent' }))['web-api']
    expect(r.state).toBe('on')
    expect(r.untouchable).toEqual([{ id: 'gno_web_h2_c1h', why: expect.stringContaining('not created') }])
    expect(tabReadings(stateOf({ gno_web_h2_c1h: 'foreign' }, 'paused'))['web-api'].state).toBe('off')
  })

  it('lets the master switch pause every running search when one entry was never applied', () => {
    const state = stateOf({ gno_sample_2m_c1h: 'absent' })
    const master = masterReading(state)
    expect(master.state).toBe('on')
    expect(master.untouchable.map((u) => u.id)).toEqual(['gno_sample_2m_c1h'])
    const plan = flipPlan(state, 'master')
    expect(plan.target).toEqual({ kind: 'master', on: false })
    expect(plan.changes.map((c) => c.id)).toEqual(allIds.filter((id) => id !== 'gno_sample_2m_c1h'))
  })

  it('lets a tab with a foreign search be switched off', () => {
    const plan = flipPlan(stateOf({ gno_web_h2_c1h: 'foreign' }), 'web-api')
    expect(plan.target).toEqual({ kind: 'tab', tab: 'web-api', on: false })
    expect(plan.changes.map((c) => c.id)).toEqual(['gno_web_host_c1h', 'gno_web_code_c1h', 'gno_web_trend_c1h'])
  })

  it('reads nothing at all from a list it could not read', () => {
    const state = { ...stateOf({}), error: 'Cribl refused this read.' }
    expect(masterReading(state).state).toBe('unavailable')
    expect(Object.values(tabReadings(state)).every((r) => r.state === 'unavailable')).toBe(true)
    expect(togglePlan(state, { kind: 'master', on: false }).changes).toEqual([])
  })
})

// ── What a flip writes ──────────────────────────────────────────────────────

describe('turning a tab off pauses exactly the schedules no other enabled tab uses', () => {
  for (const t of ACCEL_TABS) {
    it(`${t.label}, from everything on`, () => {
      const plan = togglePlan(stateOf({}), { kind: 'tab', tab: t.key, on: false })
      expect(sorted(plan.changes.map((c) => c.id))).toEqual(sorted(exclusiveTo(t.key)))
      expect(plan.changes.every((c) => c.from === true && c.to === false)).toBe(true)
      // Everything else it reads is named as kept, with the tabs keeping it.
      expect(sorted(plan.kept.map((k) => k.id))).toEqual(sorted(schedulesOfTab(t.key).filter((id) => !exclusiveTo(t.key).includes(id))))
      expect(plan.kept.every((k) => k.for.length > 0 && !k.for.includes(t.key))).toBe(true)
    })
  }

  it('changes nothing for Findings while the overview scan still feeds a tab that is on', () => {
    const plan = togglePlan(stateOf({}), { kind: 'tab', tab: 'findings', on: false })
    expect(plan.changes).toEqual([])
    expect(plan.kept).toEqual([{ id: 'gno_overview_c1h', for: ['capacity', 'web-api', 'data-flow'] }])
  })

  it('pauses the shared scan once the last tab with its own evidence goes off, and says Findings and Security go with it', () => {
    // Capacity, then Web & API, already off: their own schedules paused.
    const state = stateOf({
      gno_app_l4_c1h: 'paused',
      gno_talkers_src_c1h: 'paused',
      gno_web_host_c1h: 'paused',
      gno_web_code_c1h: 'paused',
      gno_web_trend_c1h: 'paused',
      gno_web_h2_c1h: 'paused',
    })
    const plan = togglePlan(state, { kind: 'tab', tab: 'data-flow', on: false })
    expect(sorted(plan.changes.map((c) => c.id))).toEqual(sorted(['gno_lake_30d_c1d', 'gno_pipeline_c1h', 'gno_overview_c1h']))
    expect(plan.tabsChanged).toEqual([
      { tab: 'findings', before: 'on', after: 'off' },
      { tab: 'security', before: 'on', after: 'off' },
      { tab: 'capacity', before: 'mixed', after: 'off' },
      { tab: 'web-api', before: 'mixed', after: 'off' },
      { tab: 'data-flow', before: 'on', after: 'off' },
    ])
  })

  it('touches nothing outside the tab it was asked about', () => {
    for (const t of ACCEL_TABS) {
      for (const on of [true, false]) {
        const plan = togglePlan(stateOf({ gno_dns_resolver_c1h: 'paused' }), { kind: 'tab', tab: t.key, on })
        expect(plan.changes.every((c) => schedulesOfTab(t.key).includes(c.id))).toBe(true)
      }
    }
  })

  it('never writes a row a switch may not change, and says why', () => {
    const plan = togglePlan(stateOf({ gno_web_h2_c1h: 'foreign', gno_web_trend_c1h: 'absent' }), { kind: 'tab', tab: 'web-api', on: false })
    expect(plan.changes.map((c) => c.id)).toEqual(['gno_web_host_c1h', 'gno_web_code_c1h'])
    expect(plan.untouchable.map((u) => u.id)).toEqual(['gno_web_trend_c1h', 'gno_web_h2_c1h'])
  })
})

describe('turning a tab on resumes every schedule it reads', () => {
  for (const t of ACCEL_TABS) {
    it(`${t.label}, from everything off`, () => {
      const plan = togglePlan(stateOf({}, 'paused'), { kind: 'tab', tab: t.key, on: true })
      expect(plan.changes.map((c) => c.id)).toEqual(schedulesOfTab(t.key))
      expect(plan.changes.every((c) => c.from === false && c.to === true)).toBe(true)
    })
  }
})

describe('the master switch', () => {
  it('off pauses every running schedule', () => {
    const plan = togglePlan(stateOf({ gno_dns_resolver_c1h: 'paused' }), { kind: 'master', on: false })
    expect(plan.changes.map((c) => c.id)).toEqual(allIds.filter((id) => id !== 'gno_dns_resolver_c1h'))
  })

  it('on resumes every paused one, because it has no memory of which tabs were off', () => {
    const plan = togglePlan(stateOf({}, 'paused'), { kind: 'master', on: true })
    expect(plan.changes.map((c) => c.id)).toEqual(allIds)
  })

  it('reads mixed when the schedules disagree', () => {
    expect(masterReading(stateOf({ gno_sample_2m_c1h: 'paused' })).state).toBe('mixed')
    expect(masterReading(stateOf({})).state).toBe('on')
    expect(masterReading(stateOf({}, 'paused')).state).toBe('off')
    expect(masterReading(stateOf({}, 'absent')).state).toBe('unavailable')
  })
})

// ── Review 2026-09-24: direction ────────────────────────────────────────────

describe('a flip only ever moves schedules the way the switch was flipped', () => {
  // Defect 2: an off flip took every in-scope row whose rule value differed
  // from now, in either direction — so with the overview scan paused, Data
  // Flow off paused lake and pipeline AND resumed overview, under a dialog
  // titled Pause.
  const mixedStates = [
    stateOf({ gno_overview_c1h: 'paused' }),
    stateOf({ gno_overview_c1h: 'paused', gno_dns_resolver_c1h: 'paused', gno_app_l4_c1h: 'paused' }),
    stateOf({ gno_overview_c1h: 'enabled' }, 'paused'),
  ]
  for (const [i, state] of mixedStates.entries()) {
    it(`every change goes to target.on, for every tab and the master (state ${i})`, () => {
      for (const on of [true, false]) {
        const targets = [{ kind: 'master' as const, on }, ...ACCEL_TABS.map((t) => ({ kind: 'tab' as const, tab: t.key, on }))]
        for (const target of targets) {
          const plan = togglePlan(state, target)
          expect(plan.changes.filter((c) => c.to !== on).map((c) => c.id), JSON.stringify(target)).toEqual([])
          expect(plan.changes.every((c) => c.from !== c.to)).toBe(true)
        }
      }
    })
  }

  it('turning Data Flow off with overview paused resumes nothing', () => {
    const plan = togglePlan(stateOf({ gno_overview_c1h: 'paused' }), { kind: 'tab', tab: 'data-flow', on: false })
    expect(plan.changes.map((c) => [c.id, c.to])).toEqual([
      ['gno_lake_30d_c1d', false],
      ['gno_pipeline_c1h', false],
    ])
  })
})

describe('which way a flip goes', () => {
  // Defect 3: a switch reading Mixed was drawn unchecked, so every flip asked
  // for on — a user who wanted Web & API off had to start a charge first.
  it('goes off from on and on from off', () => {
    expect(flipPlan(stateOf({}), 'capacity').target).toEqual({ kind: 'tab', tab: 'capacity', on: false })
    expect(flipPlan(stateOf({}, 'paused'), 'capacity').target).toEqual({ kind: 'tab', tab: 'capacity', on: true })
    expect(flipPlan(stateOf({}), 'master').target).toEqual({ kind: 'master', on: false })
    expect(flipPlan(stateOf({}, 'paused'), 'master').target).toEqual({ kind: 'master', on: true })
  })

  it('goes off from mixed — pausing the rest is the cheaper direction', () => {
    const state = stateOf({ gno_web_h2_c1h: 'paused' })
    const plan = flipPlan(state, 'web-api')
    expect(plan.target).toEqual({ kind: 'tab', tab: 'web-api', on: false })
    expect(plan.changes.map((c) => c.id)).toEqual(['gno_web_host_c1h', 'gno_web_code_c1h', 'gno_web_trend_c1h'])
    expect(flipPlan(state, 'master').target).toEqual({ kind: 'master', on: false })
  })

  it('goes on from mixed only when off would change nothing — the dialog then says Resume', () => {
    // Capacity's own two paused; the overview scan it shares still running
    // for Web & API. Off has nothing to pause, so the only move is on.
    const state = stateOf({ gno_app_l4_c1h: 'paused', gno_talkers_src_c1h: 'paused' })
    expect(tabReadings(state).capacity.state).toBe('mixed')
    const plan = flipPlan(state, 'capacity')
    expect(plan.target).toEqual({ kind: 'tab', tab: 'capacity', on: true })
    expect(plan.changes.map((c) => c.id)).toEqual(['gno_app_l4_c1h', 'gno_talkers_src_c1h'])
  })
})

// ── Review 2026-09-24: what a tab's cost line may claim ─────────────────────

describe('own and shared schedules', () => {
  // Defect 5: each tab's line billed it for every schedule it reads, so
  // Findings claimed the whole overview saving.
  it('splits each tab into schedules only it reads and ones it shares', () => {
    for (const t of ACCEL_TABS) {
      expect(sorted([...ownSchedulesOfTab(t.key), ...sharedSchedulesOfTab(t.key)]), t.key).toEqual(sorted(schedulesOfTab(t.key)))
      expect(ownSchedulesOfTab(t.key)).toEqual(exclusiveTo(t.key))
    }
    expect(ownSchedulesOfTab('findings')).toEqual([])
    expect(sharedSchedulesOfTab('findings')).toEqual(['gno_overview_c1h'])
  })

  it('counts every schedule as some one tab’s own, or as shared — once', () => {
    const own = ACCEL_TABS.flatMap((t) => ownSchedulesOfTab(t.key))
    const shared = [...new Set(ACCEL_TABS.flatMap((t) => sharedSchedulesOfTab(t.key)))]
    expect(sorted([...own, ...shared])).toEqual(sorted(allIds))
    expect(own.length + shared.length).toBe(allIds.length)
  })
})

// ── While only sample data exists ───────────────────────────────────────────
// Every schedule scans the customer's dataset; while it is empty a schedule is
// a charge for a stored run of nothing. The switches must not offer to turn
// anything on, and must say why (owner decision, 2026-09-24).
describe('while only sample data exists', () => {
  const SAMPLE = { sampleOnly: true } as const

  it('the rule enables nothing, whatever the switches say', () => {
    for (const entry of MANIFEST) {
      expect(scheduleEnabled(entry, true, ALL_TABS_ON, false), entry.id).toBe(false)
      expect(scheduleEnabled(entry, true, ALL_TABS_ON), entry.id).toBe(true)
    }
  })

  it('an ON flip of the master plans no write, and says why', () => {
    const plan = flipPlan(stateOf({}, 'paused'), 'master', SAMPLE)
    expect(plan.target).toEqual({ kind: 'master', on: true })
    expect(plan.changes).toEqual([])
    expect(plan.refused).toBe('sample-only')
    expect(toggleNothingWords(plan)).toBe(SAMPLE_ACCEL_OFF)
  })

  it('an ON flip of every tab plans no write', () => {
    for (const t of ACCEL_TABS) {
      const plan = flipPlan(stateOf({}, 'paused'), t.key, SAMPLE)
      expect(plan.changes, t.key).toEqual([])
      expect(plan.refused, t.key).toBe('sample-only')
    }
  })

  it('an OFF flip still pauses — off is what the rule asks for', () => {
    const plan = flipPlan(stateOf({}), 'master', SAMPLE)
    expect(plan.target.on).toBe(false)
    expect(sorted(plan.changes.map((c) => c.id))).toEqual(sorted(MANIFEST.map((e) => e.id)))
    expect(plan.changes.every((c) => c.to === false)).toBe(true)
    expect(plan.refused).toBeNull()
  })

  it('the same flips plan writes once real data exists', () => {
    expect(flipPlan(stateOf({}, 'paused'), 'master').changes.length).toBe(MANIFEST.length)
    expect(flipPlan(stateOf({}, 'paused'), 'master').refused).toBeNull()
  })

  it('a paused row offers no Resume, and says why in the word', () => {
    const paused = row(MANIFEST[0].id, 'paused')
    expect(rowAction(paused, SAMPLE)).toEqual({ kind: 'none', word: 'Off: sample data only' })
    expect(rowAction(paused)).toEqual({ kind: 'resume' })
    expect(rowAction(row(MANIFEST[0].id, 'enabled'), SAMPLE)).toEqual({ kind: 'pause' })
  })
})
