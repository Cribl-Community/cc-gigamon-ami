// The two prices this app quotes, and the ways each one under-reports.
//
// Both figures go on screen next to a control somebody is about to press, so the
// failure that matters is not a crash — it is a number that is quietly too
// small, which reads as "this is cheap" and is unfalsifiable by the person
// reading it.
//
//   * THE TICK PRICE must not grow. It answers "what does one auto-refresh tick
//     cost on this tab", and a hook pinned to its own window does not re-run on
//     a tick. Widening the registry to price the Snapshot / Live control must
//     not quietly fold those back in — the label is already on screen and
//     already tested against the old meaning.
//   * THE LIVE PRICE must not shrink. It answers "what does pressing Live cost
//     right now", and the panels it exists to price are exactly the ones the
//     tick price excludes. Priced off the tick aggregate it would have omitted
//     Data Flow's 9,297.7 CPU-s Lake total entirely and quoted about 0.03
//     credits for a press costing 2.5 — out by roughly 80×.
//   * A PANEL NOBODY HAS PRICED must be counted as unpriced, never as zero. A
//     sum that silently drops its unknowns is a sum that only ever errs
//     downward.
//
// `fetch` is stubbed because the measurement itself is a round trip to
// `/search/jobs/{id}/metrics`, and "did this slot take that number" is a claim
// about what came back from it.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordJobCost,
  useCostSlot,
  useMountedLiveCost,
  useMountedSearchCost,
  type CostSlot,
  type CostSlotOptions,
  type LiveCost,
  type MountedCost,
} from './jobCost'

let container: HTMLDivElement
let root: Root
let tick: MountedCost
let live: LiveCost
let slots: CostSlot[] = []

/** Reads both aggregates. Mounted for the whole test, so an assertion after a
 *  panel unmounts reads what the registry says NOW rather than the last value a
 *  component that has since gone happened to render. */
function Reader() {
  tick = useMountedSearchCost()
  live = useMountedLiveCost()
  return null
}

/** One panel, holding one slot — so removing a config unmounts a component
 *  rather than changing another component's hook count. */
function Panel({ config, at }: { config: CostSlotOptions; at: number }) {
  slots[at] = useCostSlot(config)
  return null
}

function render(configs: readonly CostSlotOptions[]): void {
  act(() => {
    root.render([
      createElement(Reader, { key: 'reader' }),
      ...configs.map((c, i) => createElement(Panel, { key: `p${i}`, config: c, at: i })),
    ])
  })
}

/** Let the slot take a measured cost, the way search.ts does when a job ends. */
async function measure(slot: CostSlot, key: string, cpuSeconds: number): Promise<void> {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [{ metrics: { cpuMetrics: { billableCPUSeconds: cpuSeconds } } }] }),
  }))
  await act(async () => {
    await recordJobCost(slot, key, 'job-1')
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  slots = []
  container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('what one auto-refresh tick costs', () => {
  it('counts only the slots that re-run on a tick, and only once measured', async () => {
    render([{ autoRefresh: true }, { autoRefresh: false }])
    expect(tick).toEqual({ panels: 0, cpuSeconds: 0 })
    await measure(slots[0], 'a', 130)
    await measure(slots[1], 'b', 9297.7)
    expect(tick).toEqual({ panels: 1, cpuSeconds: 130 })
  })

  it('is not widened by a slot carrying a live figure it never measured', async () => {
    // The hint exists to price the Live control. Letting it reach the tick
    // aggregate would put the 30-day Lake total into "what a 1-minute refresh
    // costs", where it does not run at all.
    render([{ autoRefresh: true, liveHint: 9297.7 }])
    expect(tick).toEqual({ panels: 0, cpuSeconds: 0 })
  })

  it('drops a slot when its panel unmounts', async () => {
    render([{ autoRefresh: true }])
    await measure(slots[0], 'a', 130)
    expect(tick.panels).toBe(1)
    render([])
    expect(tick).toEqual({ panels: 0, cpuSeconds: 0 })
    expect(live).toEqual({ panels: 0, cpuSeconds: 0, unpriced: 0 })
  })
})

describe('what running every mounted panel live costs', () => {
  it('counts the pinned panel the tick price leaves out', async () => {
    // Data Flow: two hooks that follow the range, plus the Lake total pinned to
    // -30d. Pressing Live re-runs all three.
    render([{ autoRefresh: true }, { autoRefresh: true }, { autoRefresh: false }])
    await measure(slots[0], 'a', 130)
    await measure(slots[1], 'b', 130)
    await measure(slots[2], 'c', 9297.7)
    expect(tick).toEqual({ panels: 2, cpuSeconds: 260 })
    expect(live).toEqual({ panels: 3, cpuSeconds: 9557.7, unpriced: 0 })
  })

  it('prices a panel served from its schedule all session from the measured hint', async () => {
    // THE ~80× CASE. A snapshot-served panel never runs its live query, so its
    // slot measures nothing — accel/read.ts submits the `$vt_results` read with
    // no cost slot at all. Without the hint the Live segment omits it entirely.
    render([{ autoRefresh: false, liveHint: 9297.7 }, { autoRefresh: true }])
    await measure(slots[1], 'b', 130)
    expect(live).toEqual({ panels: 2, cpuSeconds: 9427.7, unpriced: 0 })
  })

  it('prefers what this slot measured over the hint', async () => {
    // The hint is a number from another workspace on another day; a measurement
    // is this query, this range, here. On the live fallback the slot measures
    // itself, and that must win from then on.
    render([{ autoRefresh: false, liveHint: 9297.7 }])
    expect(live.cpuSeconds).toBe(9297.7)
    await measure(slots[0], 'a', 8100)
    expect(live).toEqual({ panels: 1, cpuSeconds: 8100, unpriced: 0 })
  })

  it('reports a panel nobody has priced as unpriced, not as zero', async () => {
    // A sum that drops its unknowns only ever errs downward, on a control whose
    // entire justification is that it carries a price.
    render([{ autoRefresh: true }, { autoRefresh: true }])
    await measure(slots[0], 'a', 130)
    expect(live).toEqual({ panels: 1, cpuSeconds: 130, unpriced: 1 })
  })

  it('leaves out a panel that will not run at all', async () => {
    // `enabled: false` — a panel waiting on a parameter it has not been given.
    // Pressing Live does not run it, so it costs nothing to press.
    render([{ autoRefresh: false, willRun: false, liveHint: 9297.7 }, { autoRefresh: true }])
    await measure(slots[1], 'b', 130)
    expect(live).toEqual({ panels: 1, cpuSeconds: 130, unpriced: 0 })
  })

  it('follows a slot that becomes enabled without remounting', async () => {
    render([{ autoRefresh: true, willRun: false, liveHint: 754.9 }])
    expect(live).toEqual({ panels: 0, cpuSeconds: 0, unpriced: 0 })
    render([{ autoRefresh: true, willRun: true, liveHint: 754.9 }])
    expect(live).toEqual({ panels: 1, cpuSeconds: 754.9, unpriced: 0 })
  })

  it('still accepts the old boolean call, which means autoRefresh', async () => {
    // Field Explorer holds its two slots this way.
    render([true as unknown as CostSlotOptions])
    await measure(slots[0], 'a', 130)
    expect(tick).toEqual({ panels: 1, cpuSeconds: 130 })
    expect(live).toEqual({ panels: 1, cpuSeconds: 130, unpriced: 0 })
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//  • That either figure is RIGHT about a customer's bill. Both are sums of
//    billable CPU-seconds that Cribl reported for jobs this page happened to
//    run; what a credit costs, and what else is running in that workspace, are
//    outside anything the app can see.
//  • That the hint's 9,297.7 and 754.9 still hold. They are measured runs
//    (accel/estimate.ts), on one workspace, in September 2026. A slot that runs
//    live replaces its hint with its own measurement, which is the only repair
//    mechanism there is.
//  • Anything the header renders from these. The words, the rounding and the
//    credits conversion live in src/App.tsx.
