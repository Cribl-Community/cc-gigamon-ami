// Which past state the app is showing, and the two ways that state could lie.
//
// The store itself is four lines. What is worth testing is what it does NOT do:
// it does not persist, and it does not survive a switch to Live. Both of those
// would produce the same class of defect — a screen whose numbers mean something
// other than what the controls say, with nothing visible to give it away.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDataMode, setDataMode } from '../dataMode'
import { resetSelectedSnapshot, selectedSnapshot, setSelectedSnapshot, subscribeSelectedSnapshot } from './selection'

const AT = 1_789_600_000_000

beforeEach(() => {
  resetSelectedSnapshot()
  resetDataMode()
})

afterEach(() => {
  resetSelectedSnapshot()
  resetDataMode()
})

describe('the chosen moment', () => {
  it('starts at null, which means follow the newest run', () => {
    // Not "no selection". Null IS a selection — the one every panel made before
    // this existed, and the one a reload has to land on.
    expect(selectedSnapshot()).toBe(null)
  })

  it('tells its subscribers, rather than being read once', () => {
    // The whole reason this is an external store and not a hook's own state:
    // panels are mounted all over the app and a value read at mount cannot move.
    const seen: Array<number | null> = []
    const off = subscribeSelectedSnapshot(() => seen.push(selectedSnapshot()))
    setSelectedSnapshot(AT)
    setSelectedSnapshot(null)
    off()
    setSelectedSnapshot(AT)
    expect(seen).toEqual([AT, null])
  })

  it('does not wake anything for a press that changes nothing', () => {
    let calls = 0
    const off = subscribeSelectedSnapshot(() => calls++)
    setSelectedSnapshot(AT)
    setSelectedSnapshot(AT)
    off()
    expect(calls).toBe(1)
  })

  it('refuses a moment that is not a number', () => {
    setSelectedSnapshot(Number.NaN)
    expect(selectedSnapshot()).toBe(null)
    setSelectedSnapshot(Number.POSITIVE_INFINITY)
    expect(selectedSnapshot()).toBe(null)
  })

  it('is dropped when the mode goes Live', () => {
    // In Live mode the header's time control is the range picker, so a chosen
    // moment is state nothing on screen mentions. Kept, it would mean pressing
    // Live and then Snapshot silently reinstates a time the reader last chose
    // some while ago.
    setSelectedSnapshot(AT)
    setDataMode('live')
    expect(selectedSnapshot()).toBe(null)
  })

  it('is not brought back by returning to Snapshot', () => {
    setSelectedSnapshot(AT)
    setDataMode('live')
    setDataMode('snapshot')
    expect(selectedSnapshot()).toBe(null)
  })

  it('survives everything else, because it is a viewing mode and not a panel’s state', () => {
    // A reader who picks 04:20 on Service map and clicks through to Findings is
    // asking the same question of both. Module-level state is what makes a tab
    // change keep it; there is nothing to mount and nothing to unmount.
    setSelectedSnapshot(AT)
    setDataMode('snapshot')
    expect(selectedSnapshot()).toBe(AT)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//   * That the moment is gone after a reload. Nothing here writes to the KV
//     store or to browser storage, and a test that a module-level variable does
//     not survive a page load is a test of the language. The claim lives in the
//     module's header and in the absence of any writer.
//   * That a mounted panel re-reads when the moment changes. That is
//     `useSyncExternalStore`'s contract plus useSearch's dependency list, and it
//     is covered where the hook is exercised.
