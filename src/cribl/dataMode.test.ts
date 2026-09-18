// What the mode store has to do, and the four ways a naive one gets it wrong.
//
// The store exists because `useAccelEnabled()` could not be moved after mount —
// a header segment wired to it would flip `aria-pressed` and change nothing on
// screen. So the first thing asserted here is the thing that was actually
// broken: a subscriber hears about the change. Everything after that is a
// failure path, which is where a store like this goes wrong — a refused write
// reported as saved, an older write landing after a newer press and reporting
// its own fate over it, and a stored preference arriving late and undoing a
// press the viewer has already made.
//
// Every assertion goes through the exported subscription rather than reading
// the module's variables, because a test that read the variables would keep
// passing with the subscription broken.

import { afterEach, describe, expect, it } from 'vitest'
import {
  dataMode,
  dataModeSave,
  registerDataModeWriter,
  resetDataMode,
  setDataMode,
  subscribeDataMode,
  type DataModeSave,
} from './dataMode'

afterEach(() => resetDataMode())

/** Drain the microtasks an unawaited write resolves on. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

/** Record every save state the store announces, through its own subscription. */
function record(): { states: DataModeSave[]; stop: () => void } {
  const states: DataModeSave[] = []
  const stop = subscribeDataMode(() => {
    const now = dataModeSave()
    if (states.at(-1) !== now) states.push(now)
  })
  return { states, stop }
}

describe('the data-source mode store', () => {
  it('starts on Snapshot, which is the owner’s stated default', () => {
    expect(dataMode()).toBe('snapshot')
    expect(dataModeSave()).toBe('unasked')
  })

  it('tells its subscribers when it moves — the whole reason it is not useState', () => {
    let notified = 0
    const stop = subscribeDataMode(() => { notified += 1 })
    setDataMode('live')
    expect(dataMode()).toBe('live')
    expect(notified, 'a press changed the value and told nobody').toBeGreaterThan(0)
    stop()
  })

  it('says the choice is not remembered when nothing can write it', () => {
    // The `npm run dev` page, where the app-scoped KV store 404s, and any
    // session where the platform names no signed-in user. The mode still works;
    // the control has to say it will not survive the next navigation.
    const { states, stop } = record()
    setDataMode('live')
    expect(dataMode()).toBe('live')
    expect(states.at(-1)).toBe('refused')
    stop()
  })

  it('reports a refused write as refused, not as saved', async () => {
    const { states, stop } = record()
    registerDataModeWriter(async () => false)
    setDataMode('live')
    expect(states.at(-1)).toBe('saving')
    await flush()
    expect(states.at(-1)).toBe('refused')
    stop()
  })

  it('reports a write that threw as refused, rather than leaving it saving forever', async () => {
    const { states, stop } = record()
    registerDataModeWriter(async () => {
      throw new Error('Cribl API 404 Not Found')
    })
    setDataMode('live')
    await flush()
    expect(states.at(-1)).toBe('refused')
    stop()
  })

  it('lets the newest press own the save state when an older write lands late', async () => {
    // THE SHAPE THIS FILE EXISTS FOR. Press Live, press Snapshot before the
    // first write answers, then let the Live write come back false. A store
    // that took every answer at face value would tell a viewer sitting on
    // Snapshot that their choice was refused — about a choice they no longer
    // hold, on a control whose only job is to say what is true right now.
    const { states, stop } = record()
    let settleLive: (ok: boolean) => void = () => {}
    registerDataModeWriter((next) =>
      next === 'live' ? new Promise<boolean>((res) => { settleLive = res }) : Promise.resolve(true),
    )
    setDataMode('live')
    setDataMode('snapshot')
    await flush()
    expect(dataMode()).toBe('snapshot')
    expect(states.at(-1)).toBe('saved')
    settleLive(false)
    await flush()
    expect(states.at(-1), 'a stale write reported its own fate over a newer press').toBe('saved')
    stop()
  })

  it('applies a stored preference only while nothing has been pressed', () => {
    // The KV round trip can land after the viewer has chosen. The old hook
    // could never lose this race because it could never be pressed; this one
    // can, so a late arrival is refused rather than allowed to undo a press.
    setDataMode('live')
    registerDataModeWriter(async () => true, 'snapshot')
    expect(dataMode(), 'a late preference load overwrote a press the viewer had made').toBe('live')

    resetDataMode()
    registerDataModeWriter(async () => true, 'live')
    expect(dataMode(), 'a stored preference did not apply to an app nobody had touched').toBe('live')
  })

  it('writes again when the same mode is pressed after a refusal, and not after a success', async () => {
    // Pressing Live twice is how a viewer retries a write that did not take,
    // and the control has just told them it did not. A store that
    // short-circuits on `next === mode` alone makes that press do nothing at
    // all, silently. Once the write HAS taken, the same press is a no-op —
    // otherwise every idle click bills a KV round trip.
    const writes: string[] = []
    let take = false
    registerDataModeWriter(async (m) => {
      writes.push(m)
      return take
    })
    setDataMode('live')
    await flush()
    setDataMode('live')
    await flush()
    expect(writes, 'a retry after a refused write did nothing').toEqual(['live', 'live'])

    take = true
    setDataMode('snapshot')
    await flush()
    setDataMode('snapshot')
    await flush()
    expect(writes, 'pressing an already-saved mode wrote it again').toEqual(['live', 'live', 'snapshot'])
  })

  it('never writes on registration — only a press writes', async () => {
    // CLAUDE.md's rule, and the one a reactive store makes easy to break: a
    // store that persisted its own initial value would write on every load, for
    // every viewer, to say what was already stored.
    const writes: string[] = []
    registerDataModeWriter(async (m) => {
      writes.push(m)
      return true
    }, 'live')
    await flush()
    expect(writes, 'loading the stored preference wrote it back').toEqual([])
  })
})
