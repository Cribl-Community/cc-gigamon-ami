// What the saving figure is allowed to claim.
//
// This module's output goes on a screen next to the word "saves", so the tests
// here are less about arithmetic than about the three ways a cost estimate lies:
//
//   * by extrapolating a fit past where it was measured. The model is out by 12×
//     at the Lake entry's 30-day window, and the assertion below is what stops
//     somebody wiring it up there because the code path exists;
//   * by going negative. The fitted intercept is −1.1 CPU-s, which produces a
//     negative cost for a short window and a negative low bound for almost any
//     window. CPU_FLOOR is the reason it cannot;
//   * by presenting an assumption as a measurement. Nobody counted how often
//     Field Explorer is opened, so every figure that rests on that number carries
//     `assumedFrequency`, and so does any total containing one.
//
// The break-even assertions are the other half of honesty: a schedule bills
// whether or not the tab is opened, so this module has to be able to say when
// acceleration COSTS money.

import { describe, expect, it } from 'vitest'
import { CPU_SECONDS_PER_CREDIT } from '../jobCost'
import { MANIFEST, accelEntry } from './manifest'
import {
  CPU_FLOOR,
  CPU_PER_DATA_MINUTE,
  EXTRAPOLATION_WARNING,
  FIT,
  MEASURED,
  NARROW_BODY_MULTIPLIER,
  STORED_READ_CPU_SECONDS,
  WIDE_BODY_MULTIPLIER,
  creditsFor,
  estimateCpuSeconds,
  EMPTY_SET_PROVENANCE,
  estimateEntrySaving,
  estimateScheduleSetCost,
  estimateWorkspaceSaving,
  measuredCpuSeconds,
  runsPerDay,
  windowMinutes,
} from './estimate'

describe('the fit, as shipped against as measured', () => {
  it('keeps the measured coefficients so the shipped ones can be checked', () => {
    expect(FIT.intercept).toBe(-1.1)
    expect(FIT.slope).toBe(2.62)
    expect(FIT.rSquared).toBe(0.978)
    expect(FIT.residualRmsCpuSeconds).toBe(6.6)
    expect(FIT.jobs).toBe(12)
  })

  it('ships a zero floor rather than the fitted negative intercept', () => {
    // The point of the floor, in one line: a cost estimate that can go negative
    // is not conservative, it is wrong — and it discredits the column it sits in.
    expect(CPU_FLOOR).toBe(0)
    expect(FIT.intercept).toBeLessThan(0)
    expect(FIT.intercept + FIT.slope * 0.25, 'the measured fit really does go negative on a short window').toBeLessThan(0)
    expect(estimateCpuSeconds(0.25).cpuSeconds).toBeGreaterThanOrEqual(0)
  })

  it('floors the BOTTOM of the band too, which is where it actually bites', () => {
    // At the scheduled sample's two data-minutes the point estimate is 7.4 CPU-s
    // and the residual RMS is 6.6, so an unfloored low bound is −1.4.
    const e = estimateCpuSeconds(1)
    expect(e.cpuSeconds - FIT.residualRmsCpuSeconds).toBeLessThan(0)
    expect(e.band.low).toBe(0)
    expect(e.band.high).toBeCloseTo(e.cpuSeconds + FIT.residualRmsCpuSeconds, 10)
  })

  it('rounds the slope to the precision the residuals support', () => {
    expect(CPU_PER_DATA_MINUTE).toBe(2.6)
    expect(estimateCpuSeconds(10).cpuSeconds).toBeCloseTo(26, 10)
  })

  it('carries the wide-body multiplier separately from the slope', () => {
    // Two different claims: the slope is about how much data is read, the
    // multiplier about how much of each record comes back.
    expect(WIDE_BODY_MULTIPLIER).toBe(1.43)
    expect(estimateCpuSeconds(2, WIDE_BODY_MULTIPLIER).cpuSeconds).toBeCloseTo(7.436, 6)
    expect(estimateCpuSeconds(2, NARROW_BODY_MULTIPLIER).cpuSeconds).toBeCloseTo(5.2, 10)
  })

  it('answers zero rather than nonsense for an impossible window', () => {
    expect(estimateCpuSeconds(-30).cpuSeconds).toBe(0)
    expect(estimateCpuSeconds(Number.NaN).cpuSeconds).toBe(0)
    expect(estimateCpuSeconds(Number.POSITIVE_INFINITY).cpuSeconds).toBe(0)
  })
})

describe('the domain of the fit', () => {
  it('flags a window wider than the fit was ever measured over', () => {
    expect(estimateCpuSeconds(FIT.domainMaxDataMinutes).extrapolated).toBe(false)
    const wide = estimateCpuSeconds(FIT.domainMaxDataMinutes + 1)
    expect(wide.extrapolated).toBe(true)
    expect(wide.provenance).toContain(EXTRAPOLATION_WARNING)
  })

  it('is out by an order of magnitude at the Lake entry’s window, which is why that entry is measured', () => {
    // THE LOAD-BEARING ASSERTION OF THIS FILE. The model predicts 112,320 CPU-s
    // for the 30-day Lake total. That query measured 9,297.7. If somebody ever
    // "simplifies" this module by letting the model cost every entry, this fails
    // and says why.
    const minutes = windowMinutes(accelEntry('gno_lake_30d_c1d'))
    expect(minutes).toBe(30 * 24 * 60)
    const modelled = estimateCpuSeconds(minutes as number)
    expect(modelled.extrapolated).toBe(true)
    expect(modelled.cpuSeconds / MEASURED.gno_lake_30d_c1d.liveRunCpuSeconds).toBeGreaterThan(10)
    expect(MEASURED.gno_lake_30d_c1d.scheduledRunCpuSeconds, 'the 30-day entry must never be modelled').not.toBeNull()
    expect(estimateEntrySaving('gno_lake_30d_c1d').scheduledRun.basis).toBe('measured')
  })

  it('costs the sample entry with the model, inside the domain', () => {
    const minutes = windowMinutes(accelEntry('gno_sample_2m_c1h'))
    expect(minutes, 'the settled -4m…-2m window').toBe(2)
    expect(minutes as number).toBeLessThanOrEqual(FIT.domainMaxDataMinutes)
    const saving = estimateEntrySaving('gno_sample_2m_c1h')
    expect(saving.scheduledRun.basis).toBe('modelled')
    expect(saving.scheduledRun.extrapolated).toBe(false)
    expect(saving.scheduledRun.cpuSeconds).toBeCloseTo(7.436, 6)
  })
})

describe('credits', () => {
  it('uses jobCost’s definition of a credit rather than a second copy of it', () => {
    expect(CPU_SECONDS_PER_CREDIT).toBe(3600)
    expect(creditsFor(CPU_SECONDS_PER_CREDIT)).toBe(1)
    expect(creditsFor(1800)).toBe(0.5)
  })
})

describe('what each entry saves', () => {
  it('measures the manifest’s frequency where it was measured', () => {
    const s = estimateEntrySaving('gno_lake_30d_c1d')
    expect(s.assumedFrequency).toBe(false)
    expect(s.scheduledRunsPerDay).toBe(1)
    // 9,297.7 × 15 a day now; one run plus fifteen stored reads after.
    expect(s.beforeCpuSeconds.low).toBeCloseTo(139465.5, 4)
    expect(s.beforeCpuSeconds.high).toBeCloseTo(223144.8, 4)
    expect(s.afterCpuSeconds.low).toBeCloseTo(9297.7 + 15 * STORED_READ_CPU_SECONDS, 6)
    expect(s.savedCpuSeconds.low).toBeCloseTo(130164.8, 4)
    expect(s.savedCredits.low).toBeCloseTo(130164.8 / 3600, 6)
    expect(s.savedCredits.high).toBeCloseTo((223144.8 - (9297.7 + 24 * 0.2)) / 3600, 6)
  })

  it('flags the entry whose frequency nobody measured', () => {
    const s = estimateEntrySaving('gno_sample_2m_c1h')
    expect(s.assumedFrequency).toBe(true)
    expect(s.provenance).toContain('assumption')
    expect(s.scheduledRunsPerDay).toBe(24)
    expect(s.beforeCpuSeconds.low).toBeCloseTo(4 * 754.9, 6)
    expect(s.afterCpuSeconds.low).toBeCloseTo(7.436 * 24 + 4 * 0.2, 4)
    expect(s.savedCpuSeconds.low).toBeCloseTo(4 * 754.9 - (7.436 * 24 + 0.8), 4)
  })

  it('lets a caller who counted their own paints replace the assumption', () => {
    const s = estimateEntrySaving('gno_sample_2m_c1h', 40)
    expect(s.assumedFrequency, 'a supplied frequency is not an assumption of ours').toBe(false)
    expect(s.beforeCpuSeconds.low).toBe(s.beforeCpuSeconds.high)
    expect(s.beforeCpuSeconds.low).toBeCloseTo(40 * 754.9, 6)
  })

  it('saves more the more often the panel is read, and less the less', () => {
    const rare = estimateEntrySaving('gno_sample_2m_c1h', 1)
    const often = estimateEntrySaving('gno_sample_2m_c1h', 50)
    expect(often.savedCpuSeconds.low).toBeGreaterThan(rare.savedCpuSeconds.low)
  })

  it('says how often the panel must be read before the schedule pays for itself', () => {
    // The number that makes "turn it off" a supportable answer. Below it the
    // schedule bills more than the live queries it replaces.
    const lake = estimateEntrySaving('gno_lake_30d_c1d')
    expect(lake.breakEvenRunsPerDay as number).toBeCloseTo(1.00002, 4)
    const sample = estimateEntrySaving('gno_sample_2m_c1h')
    expect(sample.breakEvenRunsPerDay as number).toBeCloseTo(0.2365, 3)
    // …and that it is really a break-even: at exactly that rate, saving is zero.
    const atBreakEven = estimateEntrySaving('gno_sample_2m_c1h', sample.breakEvenRunsPerDay as number)
    expect(atBreakEven.savedCpuSeconds.low).toBeCloseTo(0, 6)
    const below = estimateEntrySaving('gno_sample_2m_c1h', (sample.breakEvenRunsPerDay as number) / 2)
    expect(below.savedCpuSeconds.low, 'below break-even the schedule costs money').toBeLessThan(0)
  })
})

describe('the workspace total', () => {
  it('adds the entries up and inherits their honesty', () => {
    const w = estimateWorkspaceSaving()
    expect(w.entries.map((e) => e.id)).toEqual(MANIFEST.map((e) => e.id))
    const sum = w.entries.reduce((n, e) => n + e.savedCpuSeconds.low, 0)
    expect(w.savedCpuSeconds.low).toBeCloseTo(sum, 6)
    expect(w.savedCredits.low).toBeCloseTo(sum / 3600, 6)
    // One entry rests on an assumed viewing frequency, so the total does too and
    // must say so — a total that launders an assumption is the whole failure
    // mode this module exists to avoid.
    expect(w.assumedFrequency).toBe(true)
    expect(w.provenance).toContain('assumed')
  })

  it('lands in the region the plan claimed, without asserting the plan’s number', () => {
    // The plan says ≈52.5 → ≈20 credits/day, i.e. ≈32.5 saved. That total also
    // covers work outside Phase 2, so this checks the order of magnitude rather
    // than pinning somebody else's arithmetic.
    const w = estimateWorkspaceSaving()
    expect(w.savedCredits.low).toBeGreaterThan(20)
    expect(w.savedCredits.high).toBeLessThan(100)
  })
})

describe('a set of schedules — what each dashboard switch shows', () => {
  it('states the charge the schedules themselves bill, banded, from each run’s own band', () => {
    const ids = ['gno_lake_30d_c1d', 'gno_sample_2m_c1h'] as const
    const cost = estimateScheduleSetCost(ids)
    const lo = ids.reduce((n, id) => { const e = estimateEntrySaving(id); return n + e.scheduledRun.band.low * e.scheduledRunsPerDay }, 0)
    const hi = ids.reduce((n, id) => { const e = estimateEntrySaving(id); return n + e.scheduledRun.band.high * e.scheduledRunsPerDay }, 0)
    expect(cost.chargeCpuSeconds).toEqual({ low: lo, high: hi })
    expect(cost.chargeCredits).toEqual({ low: creditsFor(lo), high: creditsFor(hi) })
    expect(cost.chargeCpuSeconds.low).toBeLessThan(cost.chargeCpuSeconds.high)
  })

  it('never hands back a figure without its basis and its sentence', () => {
    for (const e of MANIFEST) {
      const cost = estimateScheduleSetCost([e.id])
      expect(['measured', 'modelled']).toContain(cost.basis)
      expect(cost.provenance.length).toBeGreaterThan(40)
      expect(cost.saving.entries.map((x) => x.id)).toEqual([e.id])
    }
    const all = estimateScheduleSetCost(MANIFEST.map((e) => e.id))
    expect(all.basis).toBe('mixed')
    expect(all.provenance).toContain(all.saving.provenance)
  })

  it('says an empty set bills nothing, rather than printing a zero', () => {
    const cost = estimateScheduleSetCost([])
    expect(cost.basis).toBe('none')
    expect(cost.chargeCredits).toEqual({ low: 0, high: 0 })
    expect(cost.provenance).toBe(EMPTY_SET_PROVENANCE)
  })
})

describe('provenance', () => {
  it('rides along with every figure, because the UI renders it beside the number', () => {
    const sayings = [
      estimateCpuSeconds(2).provenance,
      measuredCpuSeconds(100).provenance,
      estimateEntrySaving('gno_lake_30d_c1d').provenance,
      estimateWorkspaceSaving().provenance,
    ]
    for (const s of sayings) {
      expect(s.length, 'a provenance line short enough to be decoration is decoration').toBeGreaterThan(60)
      expect(/estimate|measured/i.test(s)).toBe(true)
    }
  })

  it('claims no spread for a single measurement', () => {
    // n = 1. Inventing a band for it would be inventing data.
    const m = measuredCpuSeconds(9297.7)
    expect(m.band.low).toBe(9297.7)
    expect(m.band.high).toBe(9297.7)
    expect(m.basis).toBe('measured')
  })
})

describe('the manifest and the measurements stay in step', () => {
  it('has a measured cost for every entry the manifest schedules', () => {
    // Enforced by the type as well (Record<AccelId, …>), and asserted because a
    // type only stops the compiler — this is the sentence a reader needs.
    for (const entry of MANIFEST) expect(MEASURED[entry.id], `${entry.id} has no measured cost`).toBeDefined()
  })

  it('reads the window and the cadence off the manifest rather than restating them', () => {
    expect(windowMinutes(accelEntry('gno_sample_2m_c1h'))).toBe(2)
    expect(runsPerDay(accelEntry('gno_sample_2m_c1h'))).toBe(24)
    expect(runsPerDay(accelEntry('gno_lake_30d_c1d'))).toBe(1)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
//   * That any of these figures is what a customer will be billed. Every input
//     is a measurement of one workspace reading a demo feed on one date, and the
//     fit is twelve jobs. The tests check the arithmetic and the labelling; they
//     cannot check the world.
//   * That 15–24 paints a day of the Data Flow tab is still true. It was counted
//     from this workspace's job history once.
//   * That four views a day of Field Explorer is anything but a guess. It is
//     flagged as one everywhere it is used, which is the most this module can do.
//   * That the scheduled sample really costs 7.4 CPU-s. Nobody has run it —
//     constraint 8 forbids creating the saved search — so it is the model's
//     answer, inside the model's domain, with the model's band. The first real
//     Apply in Preview is where that becomes a measurement.
