// What the per-dashboard switches SAY: the dialog's title, undo and toast, each
// tab's cost line, and the ⓘ sentence about tabs that share a schedule.
//
// Review 2026-09-24, defects 4, 5, 6 and 8. Every sentence here is derived from
// a plan or from the manifest; none of them may be fixed text that a manifest
// change silently falsifies.

import { describe, expect, it } from 'vitest'
import { MANIFEST, accelEntry, type AccelEntry, type AccelId } from '../cribl/accel/manifest'
import type { AccelEntryState, AccelRow, AccelState } from '../cribl/accel/provision'
import { estimateScheduleSetCost } from '../cribl/accel/estimate'
import { ownSchedulesOfTab, togglePlan, type SwitchReading, type TogglePlan } from '../cribl/accel/tabs'
import {
  SWITCHES_LEAD_TIP,
  sharedOnlyTabsSentence,
  switchStateWords,
  tabCostWords,
  toggleDoneWords,
  toggleTitle,
  toggleUndo,
} from './accelPanelCopy'

function row(id: AccelId, state: AccelEntryState): AccelRow {
  return {
    id,
    entry: accelEntry(id),
    state,
    enabled: state === 'enabled' ? true : state === 'paused' ? false : null,
    differences: [],
    stamp: null,
    ours: state !== 'foreign',
    recorded: false,
    intended: {} as AccelRow['intended'],
    stored: null,
  }
}
function stateOf(states: Partial<Record<AccelId, AccelEntryState>>, rest: AccelEntryState = 'enabled'): AccelState {
  return { rows: MANIFEST.map((e) => row(e.id, states[e.id] ?? rest)), orphans: [], denied: false, error: null, truncated: false, readAt: 0 }
}

describe('the dialog’s undo line says what flipping back really does', () => {
  it('names the master switch for the master, never "this tab"', () => {
    const off = toggleUndo(togglePlan(stateOf({}), { kind: 'master', on: false }))
    expect(off).not.toContain('this tab')
    expect(off).toContain('master switch')
    const on = toggleUndo(togglePlan(stateOf({}, 'paused'), { kind: 'master', on: true }))
    expect(on).not.toContain('this tab')
    expect(on).toContain('master switch')
  })

  it('names the searches a tab turned off will NOT get back as they were', () => {
    // gno_web_h2_c1h was paused before this flip; turning Web & API back on
    // resumes it too, so the line must not promise "resumes them again".
    const plan = togglePlan(stateOf({ gno_web_h2_c1h: 'paused' }), { kind: 'tab', tab: 'web-api', on: false })
    const undo = toggleUndo(plan)
    expect(undo).toContain('Web & API')
    expect(undo).toContain('gno_web_h2_c1h')
    expect(undo).toMatch(/paused before/)
  })

  it('names none when every search was where the flip found it', () => {
    const undo = toggleUndo(togglePlan(stateOf({}), { kind: 'tab', tab: 'capacity', on: false }))
    expect(undo).not.toMatch(/before this/)
  })
})

describe('the title and the toast take their direction from the changes', () => {
  const resumeUnderOff: TogglePlan = {
    target: { kind: 'tab', tab: 'data-flow', on: false },
    changes: [{ id: 'gno_overview_c1h', entry: accelEntry('gno_overview_c1h'), from: false, to: true, tabs: [] }],
    kept: [],
    untouchable: [],
    already: [],
    tabsChanged: [],
  }

  it('says Resume for a plan that resumes, whatever the target says', () => {
    expect(toggleTitle(resumeUnderOff)).toMatch(/Resume/)
    expect(toggleTitle(resumeUnderOff)).not.toMatch(/Pause/)
  })

  it('says Paused and Resumed per change', () => {
    expect(toggleDoneWords(resumeUnderOff, ['gno_overview_c1h'])).toBe('Resumed: gno_overview_c1h.')
    const pause = togglePlan(stateOf({}), { kind: 'tab', tab: 'capacity', on: false })
    expect(toggleDoneWords(pause, pause.changes.map((c) => c.id))).toBe('Paused: gno_app_l4_c1h, gno_talkers_src_c1h.')
  })
})

describe('a tab’s cost line claims only what its switch alone decides', () => {
  it('gives Findings no charge of its own, and names what it shares', () => {
    const words = tabCostWords('findings', estimateScheduleSetCost(ownSchedulesOfTab('findings')))
    expect(words).not.toMatch(/bills|saves/)
    expect(words).toContain('gno_overview_c1h')
    expect(words).toMatch(/shares/)
  })

  it('bills Capacity for its own two and names the shared one separately', () => {
    const own = estimateScheduleSetCost(ownSchedulesOfTab('capacity'))
    expect(own.ids).toEqual(['gno_app_l4_c1h', 'gno_talkers_src_c1h'])
    const words = tabCostWords('capacity', own)
    expect(words).toMatch(/^bills .*credits\/day · saves .*credits\/day/)
    expect(words).toContain('shares gno_overview_c1h')
  })

  it('says nothing about sharing for a tab that shares nothing', () => {
    expect(tabCostWords('dns-health', estimateScheduleSetCost(ownSchedulesOfTab('dns-health')))).not.toMatch(/shares/)
  })
})

describe('the sentence about tabs that read only shared searches is derived from the manifest', () => {
  it('names Findings and Security, the shared scan and the tabs that keep it, from the real manifest', () => {
    const s = sharedOnlyTabsSentence()
    expect(s).toContain('Findings and Security read only gno_overview_c1h')
    expect(s).toContain('Capacity & Top Talkers, Web & API and Data Flow')
    expect(SWITCHES_LEAD_TIP).toContain(s)
  })

  it('changes when the manifest does — Security with a search of its own becomes a tab that keeps the scan on', () => {
    const dns = accelEntry('gno_dns_overall_c1h')
    const own: AccelEntry = { ...dns, id: 'gno_security_own_c1h' as AccelId, panels: [{ ...dns.panels[0], queryId: 'security-own' }] }
    const s = sharedOnlyTabsSentence([...MANIFEST, own])
    expect(s).toContain('Findings reads only gno_overview_c1h')
    expect(s).not.toContain('Findings and Security')
    expect(s).toContain('only once Security, Capacity & Top Talkers, Web & API and Data Flow are off too')
  })

  it('is empty when no tab reads only shared searches', () => {
    expect(sharedOnlyTabsSentence(MANIFEST.filter((e) => e.id !== 'gno_overview_c1h'))).toBe('')
  })
})

describe('a switch’s state words count what it cannot change, in every state', () => {
  it('says On with the count beside it', () => {
    const r: SwitchReading = {
      state: 'on',
      ids: ['gno_web_host_c1h', 'gno_web_h2_c1h'],
      running: ['gno_web_host_c1h'],
      paused: [],
      untouchable: [{ id: 'gno_web_h2_c1h', why: 'not created yet' }],
    }
    expect(switchStateWords(r)).toBe('On — 1 scheduled search running · 1 not switchable here')
    expect(switchStateWords({ ...r, state: 'off', running: [], paused: ['gno_web_host_c1h'] })).toBe(
      'Off — 1 scheduled search paused · 1 not switchable here',
    )
  })

  it('says Mixed as running out of switchable, not out of everything', () => {
    const r: SwitchReading = {
      state: 'mixed',
      ids: ['gno_web_host_c1h', 'gno_web_code_c1h', 'gno_web_h2_c1h'],
      running: ['gno_web_host_c1h'],
      paused: ['gno_web_code_c1h'],
      untouchable: [{ id: 'gno_web_h2_c1h', why: 'not created yet' }],
    }
    expect(switchStateWords(r)).toBe('Mixed — 1 of 2 running · 1 not switchable here')
  })
})
