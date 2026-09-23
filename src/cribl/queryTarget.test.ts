// The routing rule, and the two queries that may never follow it.
//
// The pins are the point of this file. Both are STRUCTURAL — properties of the
// question rather than of the tenant's setup — and both would fail silently:
// Field Explorer on Parquet reports every field present (inverted, not merely
// wrong), and a drill-down on the curated copy shows a narrower row than the
// number that led to it. Neither raises an error.
//
// WHAT THIS FILE CANNOT ESTABLISH: that Parquet is safe to default to. That
// rests on one unmeasured question — whether an explicit `parquetSchema`
// preserves nullability — and the constants here encode the answer being
// unknown, not the answer being no.
import { describe, expect, it } from 'vitest'
import { LAKE_DATASET } from './config'
import {
  DEFAULT_DATASETS,
  DEFAULT_TARGET,
  PIN_WORDS,
  SAFE_WITHOUT_MEASUREMENT,
  TARGET_WORDS,
  availableTargets,
  routeQuery,
  targetNote,
  type QueryTarget,
  type TargetDatasets,
} from './queryTarget'

const BOTH: TargetDatasets = { json: 'gigamon_ami', parquet: 'gigamon_ami_pq' }
const ALL: TargetDatasets = { json: 'gigamon_ami', parquet: 'gigamon_ami_pq', lakehouse: 'main' }
const ALL_TARGETS: QueryTarget[] = ['lake-json', 'lake-parquet', 'lakehouse']

describe('the default target', () => {
  it('is JSON, and JSON is the only target safe without a measurement', () => {
    // Parquet is the INTENDED default and deliberately not the current one.
    // Under an automatic schema an absent field reads back ""/0 — a technique
    // counter measured 18 against 43,338 — and a percentile over a sparse
    // numeric cannot be repaired by any query rewrite. Defaulting there before
    // that is measured puts fabricated numbers on a new tenant's first screen.
    expect(DEFAULT_TARGET).toBe('lake-json')
    expect(SAFE_WITHOUT_MEASUREMENT).toEqual(['lake-json'])
    expect(SAFE_WITHOUT_MEASUREMENT).toContain(DEFAULT_TARGET)
  })

  it('addresses the dataset the rest of the app already reads', () => {
    expect(DEFAULT_DATASETS.json).toBe(LAKE_DATASET)
  })
})

describe('the pins — queries that may never leave the archive', () => {
  it('sends a presence query to JSON however the install is configured', () => {
    for (const chosen of ALL_TARGETS) {
      const r = routeQuery(chosen, 'presence', ALL)
      expect(r.target, `presence escaped to ${chosen}`).toBe('lake-json')
      expect(r.dataset).toBe('gigamon_ami')
      expect(r.pinned).toBe('presence')
    }
  })

  it('sends a drill-down to JSON however the install is configured', () => {
    for (const chosen of ALL_TARGETS) {
      const r = routeQuery(chosen, 'evidence', ALL)
      expect(r.target, `evidence escaped to ${chosen}`).toBe('lake-json')
      expect(r.pinned).toBe('evidence')
    }
  })

  it('explains each pin in terms of what would go wrong, not that it is disallowed', () => {
    expect(PIN_WORDS.presence).toContain('every field would read back as present')
    expect(PIN_WORDS.evidence).toContain('_raw')
    for (const reason of Object.values(PIN_WORDS)) expect(reason.length).toBeGreaterThan(80)
  })
})

describe('routing an ordinary query', () => {
  it('follows the chosen target when it is provisioned', () => {
    expect(routeQuery('lake-parquet', null, BOTH)).toEqual({
      target: 'lake-parquet',
      dataset: 'gigamon_ami_pq',
      pinned: null,
    })
    expect(routeQuery('lakehouse', null, ALL).dataset).toBe('main')
  })

  it('FALLS BACK to the archive rather than failing when the target is absent', () => {
    // A tenant who picks Parquet and has not provisioned it gets the archive,
    // not an error and not an empty panel — the rule the rest of the app
    // follows when an object is absent.
    const r = routeQuery('lake-parquet', null, { json: 'gigamon_ami' })
    expect(r.target).toBe('lake-json')
    expect(r.dataset).toBe('gigamon_ami')
    expect(r.pinned, 'a fallback is not a pin — the query COULD have moved').toBeNull()
  })

  it('never routes anywhere but the archive on a default install', () => {
    for (const chosen of ALL_TARGETS) {
      expect(routeQuery(chosen, null).dataset).toBe(LAKE_DATASET)
    }
  })
})

describe('what the picker offers', () => {
  it('offers only what exists, archive first', () => {
    expect(availableTargets({ json: 'gigamon_ami' })).toEqual(['lake-json'])
    expect(availableTargets(BOTH)).toEqual(['lake-json', 'lake-parquet'])
    expect(availableTargets(ALL)).toEqual(['lake-json', 'lake-parquet', 'lakehouse'])
  })

  it('always offers the archive — it is the one store that must exist', () => {
    expect(availableTargets({ json: 'x' })).toContain('lake-json')
  })

  it('names every target and gives every one a note', () => {
    for (const t of ALL_TARGETS) {
      expect(TARGET_WORDS[t].length).toBeGreaterThan(8)
      expect(targetNote(t, ALL).length).toBeGreaterThan(40)
    }
  })

  it('says which lanes are metered and which are already paid for', () => {
    // A picker offering three lanes without saying which bill per query would
    // be quietly misleading: an engine is provisioned compute, Lake is not.
    expect(targetNote('lake-json', ALL)).toContain('Billed per query')
    expect(targetNote('lake-parquet', ALL)).toContain('Billed per query')
    expect(targetNote('lakehouse', ALL)).toContain('cost nothing beyond its tier')
  })

  it('says how to get a target rather than only that it is missing', () => {
    expect(targetNote('lake-parquet', { json: 'x' })).toContain('Guided Setup can create it')
  })

  it('warns that Parquet is not yet the default, where the reader is choosing', () => {
    expect(targetNote('lake-parquet', ALL)).toContain('Not yet the default')
  })
})
