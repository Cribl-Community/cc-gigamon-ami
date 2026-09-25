// How a saved-search state becomes a verdict the read path acts on, and when
// that state is read. The hook's answer to each verdict is useSearchServing.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accelEntry, accelSavedSearch, type AccelId } from './manifest'
import type { AccelRow, AccelState, StoredSavedSearch } from './provision'
import { HYDRATE_DEADLINE_MS } from './mode'
import {
  accelServing,
  forgetAccelServing,
  loadAccelServing,
  publishAccelServing,
  refreshAccelServing,
  servingVerdicts,
} from './serving'

const ID: AccelId = 'gno_pipeline_c1h'

async function row(stored: StoredSavedSearch | null, state: AccelRow['state'] = 'enabled'): Promise<AccelRow> {
  const entry = accelEntry(ID)
  return {
    id: ID,
    entry,
    state,
    enabled: null,
    differences: [],
    stamp: null,
    ours: true,
    recorded: true,
    intended: await accelSavedSearch(entry),
    stored,
  }
}

const stateOf = (r: AccelRow, error: string | null = null): AccelState => ({
  rows: [r],
  orphans: [],
  denied: false,
  error,
  truncated: false,
  readAt: 0,
})

async function written(patch: Partial<StoredSavedSearch> & { enabled?: boolean } = {}): Promise<StoredSavedSearch> {
  const intended = await accelSavedSearch(accelEntry(ID))
  const { enabled = true, ...rest } = patch
  return { ...intended, schedule: { ...intended.schedule, enabled }, ...rest }
}

const verdict = async (stored: StoredSavedSearch | null, state?: AccelRow['state'], error?: string) =>
  servingVerdicts(stateOf(await row(stored, state), error ?? null)).get(ID)

describe('servingVerdicts', () => {
  it('reads an untouched schedule as scheduled', async () => {
    expect(await verdict(await written())).toBe('scheduled')
  })

  it('reads schedule.enabled === false as paused', async () => {
    expect(await verdict(await written({ enabled: false }), 'paused')).toBe('paused')
  })

  it('names the pause, not the drift, when both are true', async () => {
    expect(await verdict(await written({ enabled: false, query: 'dataset="x"' }), 'differs')).toBe('paused')
  })

  it('reads a different query as drifted', async () => {
    expect(await verdict(await written({ query: 'dataset="cribl_metrics" | summarize n=count()' }), 'differs')).toBe('drifted')
  })

  it('reads a different window as drifted', async () => {
    expect(await verdict(await written({ earliest: '-2h' }), 'differs')).toBe('drifted')
  })

  it('does NOT read a changed cron, name or description as drift: the number is the same query', async () => {
    const w = await written({ name: 'renamed', description: 'hand edited' })
    w.schedule = { ...w.schedule, cronSchedule: '5 * * * *', keepLastN: 3 }
    expect(await verdict(w, 'differs')).toBe('scheduled')
  })

  it('reads an absent search, and one with no schedule at all, as unscheduled', async () => {
    expect(await verdict(null, 'absent')).toBe('unscheduled')
    const w = await written()
    delete w.schedule
    expect(await verdict(w, 'differs')).toBe('unscheduled')
  })

  it('is unknown for a row it could not settle, and for a list it could not read', async () => {
    expect(await verdict(await written({ enabled: false }), 'unreadable')).toBe('unknown')
    expect(await verdict(await written({ enabled: false }), 'paused', 'refused')).toBe('unknown')
  })
})

describe('the store', () => {
  beforeEach(() => {
    forgetAccelServing()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('answers unknown, not pending, when nothing ever asked — every unit test elsewhere', () => {
    expect(accelServing(ID)).toBe('unknown')
  })

  it('does not start a read from Refresh on a page that never read', () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404, statusText: '', json: async () => ({}), text: async () => '' }))
    vi.stubGlobal('fetch', fetchSpy)
    refreshAccelServing()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(accelServing(ID)).toBe('unknown')
  })

  it('holds panels while the first read is out, and releases them at the deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    void loadAccelServing()
    expect(accelServing(ID)).toBe('pending')
    vi.advanceTimersByTime(HYDRATE_DEADLINE_MS)
    expect(accelServing(ID)).toBe('unknown')
  })

  it('adopts a state somebody else read, and that ends the wait', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    void loadAccelServing()
    expect(accelServing(ID)).toBe('pending')
    publishAccelServing(stateOf(await row(await written({ enabled: false }), 'paused')))
    expect(accelServing(ID)).toBe('paused')
  })
})
