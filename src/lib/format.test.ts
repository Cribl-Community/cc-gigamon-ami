import { describe, expect, it } from 'vitest'
import { fmtBytes, fmtCount, fmtMs, fmtPct, formatCost, str, toNum, windowSeconds } from './format'

// Smoke test for the Vitest harness itself: a real module, real assertions, and
// one DOM assertion so a broken `environment: 'happy-dom'` fails loudly here
// rather than in whatever test needs the DOM next.
//
// It is also the last step between a search result and the figure a customer
// reads. display.json freezes the query that produced the row; these functions
// turn the row into "15.5M" or "1.2 GB" or "87%", and an edit to any of them
// changes every number on every tab with no snapshot moving at all. So the
// units, the rounding and the seams between them are pinned here.

describe('formatCost', () => {
  it('hedges and drops precision the estimate does not have', () => {
    expect(formatCost(12.7, 'credits/hour')).toBe('about 13 credits/hour')
    expect(formatCost(1234.5)).toBe('about 1,235 credits')
  })

  it('keeps one decimal below 10 and rounds to a grouped integer above it', () => {
    expect(formatCost(5)).toBe('about 5.0 credits')
    // The seam at 10: still one decimal, so 9.99 reads "10.0", not "10".
    expect(formatCost(9.99)).toBe('about 10.0 credits')
  })

  it('floors anything too small or not a number at "under 0.1"', () => {
    expect(formatCost(0.05)).toBe('under 0.1 credits')
    expect(formatCost(Number.NaN)).toBe('under 0.1 credits')
    expect(formatCost(-3)).toBe('under 0.1 credits')
    // 0.1 itself is above the floor.
    expect(formatCost(0.1)).toBe('about 0.1 credits')
  })
})

describe('fmtCount', () => {
  it('leaves counts under 1000 as plain rounded integers', () => {
    expect(fmtCount(999)).toBe('999')
    // Rounding happens before the unit test, so 999.6 renders as "1000".
    expect(fmtCount(999.6)).toBe('1000')
  })

  it('compacts with K/M/B and honours the digits argument', () => {
    expect(fmtCount(1500)).toBe('1.5K')
    expect(fmtCount(15_500_000)).toBe('15.5M')
    expect(fmtCount(2e9)).toBe('2.0B')
    expect(fmtCount(1234, 0)).toBe('1K')
  })

  it('coerces strings and falls back to 0 for junk', () => {
    expect(fmtCount('2500')).toBe('2.5K')
    expect(fmtCount('abc')).toBe('0')
    expect(fmtCount(-2500)).toBe('-2.5K')
  })
})

describe('fmtBytes', () => {
  it('scales in binary units, one decimal above bytes', () => {
    // 1 KB = 1024, not 1000 — the Data Flow cards report Lake volume with this.
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(1024 ** 3)).toBe('1.0 GB')
  })

  it('caps at PB and keeps the sign', () => {
    expect(fmtBytes(1024 ** 6)).toBe('1024.0 PB')
    expect(fmtBytes(-2048)).toBe('-2.0 KB')
  })
})

describe('fmtMs', () => {
  it('rounds to whole milliseconds, then promotes to seconds at 1000', () => {
    expect(fmtMs(12.4)).toBe('12 ms')
    expect(fmtMs(999)).toBe('999 ms')
    expect(fmtMs(1000)).toBe('1.00 s')
    expect(fmtMs(1234)).toBe('1.23 s')
  })
})

describe('fmtPct', () => {
  it('prints one decimal by default and honours the digits argument', () => {
    expect(fmtPct(87)).toBe('87.0%')
    expect(fmtPct(0.3276, 2)).toBe('0.33%')
  })
})

describe('toNum / str', () => {
  it('turns a row value into a number, with 0 for anything that is not one', () => {
    // Search returns numerics as strings often enough that every tile relies on
    // this; a NaN reaching the screen would read as "NaN", not as "no data".
    expect(toNum('4210')).toBe(4210)
    expect(toNum(undefined)).toBe(0)
    expect(toNum('abc')).toBe(0)
    expect(toNum(null)).toBe(0)
  })

  it('reads a string field with a fallback, treating null and undefined alike', () => {
    expect(str({ dns_host: 'a.example' }, 'dns_host')).toBe('a.example')
    expect(str({ dns_host: null }, 'dns_host', '—')).toBe('—')
    expect(str({}, 'missing')).toBe('')
  })
})

describe('windowSeconds', () => {
  it('spans the relative bounds the range picker offers', () => {
    // The Sources card divides by this to print events/sec, so a wrong span is
    // a wrong rate under a correct-looking query.
    expect(windowSeconds('-5m')).toBe(300)
    expect(windowSeconds('-1h')).toBe(3600)
    expect(windowSeconds('-24h')).toBe(86400)
  })

  it('falls back to 15 minutes for a bound it cannot parse', () => {
    expect(windowSeconds('yesterday')).toBe(900)
  })
})

describe('test environment', () => {
  it('provides a DOM to render formatted values into', () => {
    const el = document.createElement('span')
    el.textContent = fmtCount(15_500_000)
    document.body.append(el)
    expect(document.body.querySelector('span')?.textContent).toBe('15.5M')
    el.remove()
  })
})
