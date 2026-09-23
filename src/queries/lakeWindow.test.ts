// The Lake card's window is the dataset's retention, and its counting method is
// whichever one covers that window (owner's call, 2026-09-23: "hybrid").
import { describe, expect, it } from 'vitest'
import { LAKE_HELD_QUERY, LAKE_TOTAL_QUERY } from './dataFlow'
import { lakeWindow, windowDays } from './lakeWindow'
import { LAKE_ENTRY_ID, MANIFEST, accelEntry, accelPostBody, resolveEntry, resolvedManifest } from '../cribl/accel/manifest'

describe('lakeWindow', () => {
  it('uses the cheap write counters while the retention fits inside cribl_metrics’', () => {
    // Measured the same day: write counters 737.2M, a direct count 756.8M,
    // eight hours apart — the gap is those eight hours of feed.
    const w = lakeWindow(30, 30)!
    expect(w.method).toBe('write-counters')
    expect(w.query).toBe(LAKE_TOTAL_QUERY)
    expect(w.earliest).toBe('-30d')
  })

  it('counts the dataset itself once the retention is longer than cribl_metrics keeps', () => {
    // A 365-day dataset cannot be totalled from 30 days of write counters.
    const w = lakeWindow(365, 30)!
    expect(w.method).toBe('count')
    expect(w.query).toBe(LAKE_HELD_QUERY)
    expect(w.earliest).toBe('-365d')
    expect(w.retentionDays).toBe(365)
  })

  it('counts directly when cribl_metrics’ retention is unknown — slower, never short', () => {
    expect(lakeWindow(30, null)!.method).toBe('count')
  })

  it('has no window when the dataset’s own retention is unknown or nonsense', () => {
    for (const r of [null, 0, -1, 1.5, Number.NaN]) expect(lakeWindow(r as number | null, 30), String(r)).toBeNull()
  })

  it('reads a relative window back as days', () => {
    expect(windowDays('-365d')).toBe(365)
    expect(windowDays('-18m')).toBeNull()
    expect(windowDays(null)).toBeNull()
  })
})

describe('resolveEntry', () => {
  it('writes the Lake total with the tenant’s window and method', () => {
    const e = resolveEntry(accelEntry(LAKE_ENTRY_ID), lakeWindow(365, 30))
    const body = accelPostBody(e, '')
    expect(body.query).toBe(LAKE_HELD_QUERY)
    expect(body.earliest).toBe('-365d')
    // The id stays — renaming would orphan the stored runs — and the name an
    // operator reads in Cribl's list says the truth.
    expect(body.id).toBe(LAKE_ENTRY_ID)
    expect(body.name).toBe('GNO Lake total 365 days')
    // The ⓘ shows what ran.
    expect(e.panels[0].display).toBe(LAKE_HELD_QUERY)
  })

  it('leaves the manifest default when the retention could not be read', () => {
    expect(resolveEntry(accelEntry(LAKE_ENTRY_ID), null)).toBe(accelEntry(LAKE_ENTRY_ID))
  })

  it('touches no other entry', () => {
    const resolved = resolvedManifest(lakeWindow(365, 30))
    MANIFEST.forEach((e, i) => {
      if (e.id !== LAKE_ENTRY_ID) expect(resolved[i], e.id).toBe(e)
    })
  })

  it('resolves a 30-day tenant to exactly the manifest default — no spurious drift', () => {
    const e = resolveEntry(accelEntry(LAKE_ENTRY_ID), lakeWindow(30, 30))
    const d = accelEntry(LAKE_ENTRY_ID)
    expect([e.body, e.earliest, e.name, e.panels[0].display]).toEqual([d.body, d.earliest, d.name, d.panels[0].display])
  })
})
