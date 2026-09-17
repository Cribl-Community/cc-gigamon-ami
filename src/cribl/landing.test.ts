// The arithmetic behind a confirmation somebody presses Apply on.
//
// Almost nothing in this file is about a happy path, because the happy paths
// here are one-liners and the expensive mistakes are not. Three of them are
// worth naming, and each has a block below:
//
//   THE DIFF IS WHAT A CUSTOMER READS. `diffDestination` produces the before→
//   after in the dialog in front of a PATCH that replaces a live delivery point
//   both feeds write through. A row it misses is a change somebody approved
//   without seeing; a row it invents is a change they refuse for no reason; and
//   an empty diff reported as a change is how people learn to click through
//   dialogs. All three are asserted, including the boring-looking one — that
//   `{a:1,b:2}` and `{b:2,a:1}` are the same setting — because a reference
//   comparison would report every nested object as changed on every open.
//
//   A RETENTION DECREASE IS THE ONE IRREVERSIBLE EDIT IN THIS PHASE. Not "risky":
//   irreversible. Lake datasets are under no version control, so unlike the
//   destination edit there is no commit to revert. `retentionChange` is what
//   tells the dialog to be harder, and the direction and the `irreversible` flag
//   are asserted separately from the sentence, so a rewording cannot quietly
//   turn a decrease into an ordinary edit.
//
//   A SPEC BUILT HERE HAS TO DESCRIBE THE SAME OBJECTS GUIDED SETUP BUILDS.
//   `datasetSpec(DEFAULT_PROFILE)` is pinned against provision.ts's own
//   `DATASET_SPEC`, so the two cannot drift into describing two different
//   datasets under one id.
//
// WHAT THESE TESTS CANNOT ASSERT is at the bottom of the file.

import { describe, expect, it } from 'vitest'
import {
  applyDestinationEdit,
  datasetSpec,
  DATASET_DESCRIPTION,
  DEFAULT_PARTITION_LIMITS,
  DEFAULT_PROFILE,
  destinationSpec,
  DESTINATION_READONLY_KEYS,
  diffDestination,
  FLUSH_PRESETS,
  flushPresetOf,
  MAX_RETENTION_DAYS,
  partitionStats,
  pathFilterRows,
  PARTITION_DISTINCT_CEILING,
  PARTITION_FILL_FLOOR,
  PREP_PIPELINE_ID,
  retentionChange,
  SPIKE_GATED,
  spikeGateNote,
  validatePartitions,
  type LandingProfile,
} from './landing'
import { DATASET_SPEC } from './provision'
import { PARTITION_CANDIDATES } from '../queries/lakeLanding'

const profile = (over: Partial<LandingProfile> = {}): LandingProfile => ({ ...DEFAULT_PROFILE, ...over })

// ── The flush presets ───────────────────────────────────────────────────────

describe('flush presets', () => {
  it('ships the values provision.ts already writes, so an untouched install is on a named preset', () => {
    // cribl/provision.ts's DESTINATION_SPEC writes 5 / 60 / 15 and is not
    // exported, so this is the pin: if those change, `flushPresetOf` starts
    // answering "custom" for every install that has never opened the panel and
    // the panel offers to "keep" a setting it has already misreported.
    expect(FLUSH_PRESETS.nearLive).toMatchObject({ maxFileSizeMB: 5, maxFileOpenTimeSec: 60, maxFileIdleTimeSec: 15 })
    expect(DEFAULT_PROFILE.flush).toEqual({ maxFileSizeMB: 5, maxFileOpenTimeSec: 60, maxFileIdleTimeSec: 15 })
  })

  it('recognises each preset exactly, and calls anything else custom', () => {
    expect(flushPresetOf(FLUSH_PRESETS.balanced)).toBe('balanced')
    expect(flushPresetOf(FLUSH_PRESETS.criblDefault)).toBe('criblDefault')
    // One second out is not "balanced". Somebody tuned this by hand and a panel
    // that rounded it to the nearest preset would offer to keep a value it had
    // just misreported.
    expect(flushPresetOf({ ...FLUSH_PRESETS.balanced, maxFileIdleTimeSec: 31 })).toBe('custom')
  })

  it('says what each preset trades, in the direction of the trade', () => {
    for (const preset of Object.values(FLUSH_PRESETS)) {
      expect(preset.why.length).toBeGreaterThan(40)
    }
  })
})

// ── The dataset spec ────────────────────────────────────────────────────────

describe('datasetSpec', () => {
  it('describes the same dataset provision.ts creates', () => {
    expect(datasetSpec(DEFAULT_PROFILE)).toEqual(DATASET_SPEC)
    expect(DATASET_DESCRIPTION).toBe(DATASET_SPEC.description)
  })

  it('omits acceleratedFields when there are none rather than sending an empty array', () => {
    // PATCH on this endpoint is only LIKELY partial (claim C6, inferred from the
    // spec's examples). Every key sent is a key this app is betting it
    // understands, and an empty array is the version of that bet with no upside.
    expect(datasetSpec(DEFAULT_PROFILE)).not.toHaveProperty('acceleratedFields')
    expect(datasetSpec(profile({ partitions: ['protocol'] })).acceleratedFields).toEqual(['protocol'])
  })

  it('omits searchConfig on v1 and carries both object kinds on a Parquet dataset', () => {
    expect(datasetSpec(DEFAULT_PROFILE)).not.toHaveProperty('searchConfig')

    const json = datasetSpec(profile({ searchVersion: 'v2' })).searchConfig as { pathFilters: unknown[] }
    expect(json.pathFilters).toHaveLength(1)

    // The JSON row is NOT dropped when the dataset turns Parquet: every object
    // written before the change is still there until retention ages it out, and
    // a one-row filter is how a month of history stops being readable.
    const parquet = datasetSpec(profile({ searchVersion: 'v2', format: 'parquet' })).searchConfig as { pathFilters: { filter: string }[] }
    expect(parquet.pathFilters.map((r) => r.filter)).toEqual(['**/*.parquet', '**/*.json.gz'])
  })
})

describe('pathFilterRows', () => {
  it('puts the more specific glob first', () => {
    // `**` first would claim the Parquet objects for the NDJSON reader. This is
    // the whole correctness of the two-row case.
    expect(pathFilterRows(['json', 'parquet']).map((r) => r.dataPathFormat)).toEqual(['parquet', 'ndjson'])
  })

  it('uses a catch-all for a JSON-only dataset, not a gzip suffix', () => {
    // Objects written before gzip was the default do not carry `.json.gz`, and a
    // filter that misses them makes them unreadable.
    expect(pathFilterRows(['json'])).toEqual([
      { filter: '**', dataTypeId: 'generic_ndjson', dataPathFormat: 'ndjson', preprocessOuterJson: true },
    ])
  })

  it('answers nothing for no object kinds', () => {
    expect(pathFilterRows([])).toEqual([])
  })
})

// ── The destination spec ────────────────────────────────────────────────────

describe('destinationSpec', () => {
  it('keeps gzip on JSON and takes both compression keys away on Parquet', () => {
    expect(destinationSpec(DEFAULT_PROFILE).set.compress).toBe('gzip')
    const parquet = destinationSpec(profile({ format: 'parquet' }))
    expect(parquet.set).not.toHaveProperty('compress')
    expect(parquet.remove).toContain('compress')
    expect(parquet.remove).toContain('compressionLevel')
  })

  it('names the Parquet object suffix explicitly instead of relying on the format token', () => {
    // Cribl documents `__format` as yielding `json` or `raw` — never `parquet` —
    // so a destination relying on it writes `.json` objects full of Parquet. The
    // worker-id component is what stops two Worker Processes colliding.
    const suffix = destinationSpec(profile({ format: 'parquet' })).set.fileNameSuffix as string
    expect(suffix).toContain('CRIBL_WORKER_ID')
    expect(suffix).toContain('.parquet')
    expect(suffix).not.toContain('__format')
  })

  it('binds the prep pipeline only when _raw is being dropped, and unbinds it otherwise', () => {
    expect(destinationSpec(profile({ dropRaw: true })).set.pipeline).toBe(PREP_PIPELINE_ID)
    expect(destinationSpec(profile({ dropRaw: false })).remove).toContain('pipeline')
  })

  it('has an opinion about a handful of keys and no opinion about the rest', () => {
    // The app did not create this destination on most tenants. Anything it does
    // not name here is preserved by applyDestinationEdit.
    const keys = Object.keys(destinationSpec(DEFAULT_PROFILE).set)
    expect(keys).not.toContain('environment')
    expect(keys).not.toContain('streamtags')
    expect(keys).not.toContain('notifications')
  })
})

// ── The diff ────────────────────────────────────────────────────────────────

describe('diffDestination', () => {
  const live = {
    id: 'gigamon_lake',
    maxFileSizeMB: 5,
    maxFileOpenTimeSec: 60,
    compress: 'gzip',
    systemFields: ['cribl_pipe'],
    nested: { a: 1, b: 2 },
  }

  it('is empty for an edit that changes nothing — a no-op has to be recognisable as one', () => {
    expect(diffDestination(live, { set: { maxFileSizeMB: 5, compress: 'gzip' }, remove: [] })).toEqual([])
  })

  it('reports a changed value with both sides', () => {
    expect(diffDestination(live, { set: { maxFileSizeMB: 32 }, remove: [] })).toEqual([
      { key: 'maxFileSizeMB', kind: 'changed', before: 5, after: 32 },
    ])
  })

  it('reports a key the live object does not have as added, not as changed from undefined', () => {
    expect(diffDestination(live, { set: { parquetPageSize: '1MB' }, remove: [] })).toEqual([
      { key: 'parquetPageSize', kind: 'added', before: undefined, after: '1MB' },
    ])
  })

  it('reports a removal as its own row — dropping compress is a real change', () => {
    expect(diffDestination(live, { set: {}, remove: ['compress'] })).toEqual([
      { key: 'compress', kind: 'removed', before: 'gzip', after: undefined },
    ])
  })

  it('says nothing about removing a key that is not there', () => {
    // A diff row for something that will not happen is the same defect as a
    // missing row, pointing the other way.
    expect(diffDestination(live, { set: {}, remove: ['compressionLevel'] })).toEqual([])
  })

  it('treats equal-but-not-identical objects and arrays as unchanged', () => {
    expect(diffDestination(live, { set: { nested: { b: 2, a: 1 } }, remove: [] })).toEqual([])
    expect(diffDestination(live, { set: { systemFields: ['cribl_pipe'] }, remove: [] })).toEqual([])
  })

  it('treats a reordered array as changed, because pathFilters and systemFields are ordered', () => {
    const rows = diffDestination({ systemFields: ['a', 'b'] }, { set: { systemFields: ['b', 'a'] }, remove: [] })
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('changed')
  })

  it('distinguishes a nested change from a nested reorder', () => {
    const rows = diffDestination(live, { set: { nested: { a: 1, b: 3 } }, remove: [] })
    expect(rows).toEqual([{ key: 'nested', kind: 'changed', before: { a: 1, b: 2 }, after: { a: 1, b: 3 } }])
  })

  it('does not confuse a missing key with a key whose value is null', () => {
    expect(diffDestination({ pipeline: null }, { set: { pipeline: 'gigamon_lake_prep' }, remove: [] })).toEqual([
      { key: 'pipeline', kind: 'changed', before: null, after: 'gigamon_lake_prep' },
    ])
  })

  it('resolves a key named in both lists once, as a removal', () => {
    // A contradiction in the caller. It has to resolve the same way here and in
    // applyDestinationEdit, or the body sent stops matching the diff approved.
    const rows = diffDestination(live, { set: { compress: 'gzip' }, remove: ['compress'] })
    expect(rows).toEqual([{ key: 'compress', kind: 'removed', before: 'gzip', after: undefined }])
  })

  it('sorts its rows, so two diffs of the same edit read the same way', () => {
    const rows = diffDestination(live, { set: { maxFileSizeMB: 32, compress: 'none', aaa: 1 }, remove: [] })
    expect(rows.map((r) => r.key)).toEqual(['aaa', 'compress', 'maxFileSizeMB'])
  })

  it('produces exactly the keys a JSON→Parquet flush change touches', () => {
    const rows = diffDestination(live, destinationSpec(profile({ format: 'parquet', flush: FLUSH_PRESETS.balanced })))
    const byKind = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.key)
    // `pipeline` is not on the live object, so it is not a removal — see the
    // "says nothing about removing a key that is not there" case above.
    expect(byKind('removed')).toEqual(['compress'])
    expect(byKind('changed')).toContain('maxFileSizeMB')
    expect(byKind('added')).toContain('fileNameSuffix')
  })
})

describe('applyDestinationEdit', () => {
  const live = { id: 'gigamon_lake', environment: 'prod', compress: 'gzip', maxFileSizeMB: 5, status: { health: 'green' } }

  it('preserves every key the edit does not mention', () => {
    // The app did not create this object on most tenants; a key absent from the
    // body is a field it has just deleted from a customer's configuration.
    const body = applyDestinationEdit(live, { set: { maxFileSizeMB: 32 }, remove: [] })
    expect(body.environment).toBe('prod')
    expect(body.id).toBe('gigamon_lake')
    expect(body.maxFileSizeMB).toBe(32)
  })

  it('never sends the server-computed health back', () => {
    expect(applyDestinationEdit(live, { set: {}, remove: [] })).not.toHaveProperty('status')
    expect(DESTINATION_READONLY_KEYS).toEqual(['status'])
  })

  it('removes what the edit removes', () => {
    expect(applyDestinationEdit(live, { set: {}, remove: ['compress'] })).not.toHaveProperty('compress')
  })

  it('lets removal win over set, the same way the diff shows it', () => {
    expect(applyDestinationEdit(live, { set: { compress: 'gzip' }, remove: ['compress'] })).not.toHaveProperty('compress')
  })

  it('does not mutate the body it was given', () => {
    const before = JSON.stringify(live)
    applyDestinationEdit(live, { set: { maxFileSizeMB: 32 }, remove: ['compress'] })
    expect(JSON.stringify(live)).toBe(before)
  })
})

// ── Retention ───────────────────────────────────────────────────────────────

describe('retentionChange', () => {
  it('calls a decrease irreversible and an increase not', () => {
    expect(retentionChange(30, 7)).toMatchObject({ direction: 'decrease', irreversible: true })
    expect(retentionChange(30, 90)).toMatchObject({ direction: 'increase', irreversible: false })
  })

  it('offers an undo on an increase and none on a decrease', () => {
    // The asymmetry IS the feature. If both dialogs carry the same reassurance,
    // the irreversibility label is decoration.
    expect(retentionChange(30, 90).undo).toContain('30 days')
    expect(retentionChange(30, 7).undo).toBeNull()
  })

  it('says why a decrease cannot be undone, and says retention runs from upload date', () => {
    const why = retentionChange(30, 7).why ?? ''
    expect(why).toContain('UPLOADED')
    expect(why).toMatch(/not under version control|no way back/i)
  })

  it('reports no change for the same value, and calls it neither direction', () => {
    expect(retentionChange(30, 30)).toMatchObject({ direction: 'none', irreversible: false, undo: null })
  })

  it('refuses values Cribl Lake will refuse, before the round trip', () => {
    expect(retentionChange(30, 0).problems).not.toEqual([])
    expect(retentionChange(30, -1).problems).not.toEqual([])
    expect(retentionChange(30, MAX_RETENTION_DAYS + 1).problems).not.toEqual([])
    expect(retentionChange(30, 7.5).problems).not.toEqual([])
    expect(retentionChange(30, Number.NaN).problems).not.toEqual([])
  })

  it('never calls an invalid decrease irreversible — nothing is going to happen', () => {
    expect(retentionChange(30, 0).irreversible).toBe(false)
  })
})

// ── Partitions ──────────────────────────────────────────────────────────────

describe('partitionStats', () => {
  const row = {
    total: 1000,
    n_protocol: 1000,
    d_protocol: 4,
    n_app_name: 900,
    d_app_name: 40,
  }

  it('reads the candidates it was given columns for and computes fill', () => {
    const stats = partitionStats(row)
    expect(stats.map((s) => s.field)).toEqual(['protocol', 'app_name'])
    expect(stats[0].fill).toBe(1)
    expect(stats[1].fill).toBeCloseTo(0.9)
  })

  it('drops a candidate the query did not measure rather than reporting it as zero', () => {
    // A zero fill is a claim that the field was measured and found empty.
    expect(partitionStats(row).some((s) => s.field === 'l4_proto')).toBe(false)
  })

  it('answers nothing for a missing row or a row with no total', () => {
    expect(partitionStats(null)).toEqual([])
    expect(partitionStats({})).toEqual([])
  })

  it('reports fill as null rather than dividing by zero on an empty window', () => {
    expect(partitionStats({ total: 0, n_protocol: 0, d_protocol: 0 })[0].fill).toBeNull()
  })

  it('accepts the numbers as strings, which is how NDJSON sometimes carries them', () => {
    expect(partitionStats({ total: '10', n_protocol: '10', d_protocol: '2' })[0]).toMatchObject({ present: 10, distinct: 2 })
  })

  it('reads every candidate the query names', () => {
    const full: Record<string, unknown> = { total: 100 }
    for (const { key } of PARTITION_CANDIDATES) {
      full[`n_${key}`] = 100
      full[`d_${key}`] = 2
    }
    expect(partitionStats(full)).toHaveLength(PARTITION_CANDIDATES.length)
  })
})

describe('validatePartitions', () => {
  const good = [{ field: 'protocol', present: 100, distinct: 4, total: 100, fill: 1 }]

  it('accepts a measured, well-filled, low-cardinality field', () => {
    expect(validatePartitions(['protocol'], good)).toMatchObject({ ok: true, errors: [], warnings: [] })
  })

  it('refuses more fields than the tenant allows, and uses the tenant’s own number', () => {
    expect(validatePartitions(['a', 'b', 'c', 'd'], [], DEFAULT_PARTITION_LIMITS).ok).toBe(false)
    expect(validatePartitions(['a', 'b'], [], { maxAcceleratedFieldsCount: 1 }).ok).toBe(false)
    expect(validatePartitions(['a', 'b', 'c', 'd'], [], { maxAcceleratedFieldsCount: 5 }).errors).toEqual([])
  })

  it('refuses a duplicate and a blank', () => {
    expect(validatePartitions(['protocol', 'protocol'], good).ok).toBe(false)
    expect(validatePartitions(['   '], good).ok).toBe(false)
  })

  it('refuses the structural fields outright', () => {
    for (const field of ['_raw', 'message', '_time', 'source', 'dataset']) {
      expect(validatePartitions([field], good).ok, field).toBe(false)
    }
  })

  it('warns rather than refuses on a thin field — Cribl Lake does not reject it', () => {
    const thin = [{ field: 'dst_aws_flat_tags_name', present: 7, distinct: 3, total: 100, fill: 0.07 }]
    const verdict = validatePartitions(['dst_aws_flat_tags_name'], thin)
    expect(verdict.ok).toBe(true)
    expect(verdict.errors).toEqual([])
    expect(verdict.warnings[0].reason).toContain('7.0%')
    expect(PARTITION_FILL_FLOOR).toBeGreaterThan(0.07)
  })

  it('warns on a field with more distinct values than the ceiling, and names the count', () => {
    const wide = [{ field: 'app_name', present: 100, distinct: PARTITION_DISTINCT_CEILING + 1, total: 100, fill: 1 }]
    const verdict = validatePartitions(['app_name'], wide)
    expect(verdict.ok).toBe(true)
    expect(verdict.warnings[0].reason).toContain(String(PARTITION_DISTINCT_CEILING + 1))
    expect(verdict.warnings[0].reason).toContain('P-S9')
  })

  it('warns when a field has not been measured at all, rather than assuming it is fine', () => {
    const verdict = validatePartitions(['protocol'], [])
    expect(verdict.ok).toBe(true)
    expect(verdict.warnings[0].reason).toContain('not been measured')
  })

  it('reports one error per listed entry, not several about the same entry', () => {
    // `_raw` twice is two facts about the input — one entry is structural, the
    // other is a duplicate — so two errors is right. What would be wrong is one
    // entry collecting both, which is what the per-entry `continue`s prevent.
    const errors = validatePartitions(['_raw', '_raw'], good).errors
    expect(errors).toHaveLength(2)
    expect(errors[0].reason).toContain('structural')
    expect(errors[1].reason).toContain('twice')
  })

  it('gives both warnings when a field is thin AND wide — they are different advice', () => {
    const bad = [{ field: 'app_name', present: 5, distinct: PARTITION_DISTINCT_CEILING + 1, total: 100, fill: 0.05 }]
    expect(validatePartitions(['app_name'], bad).warnings).toHaveLength(2)
  })
})

// ── What was deliberately not built ─────────────────────────────────────────

describe('the refusals', () => {
  it('names both absent editors and the spikes each is waiting on', () => {
    expect(SPIKE_GATED.map((g) => g.control)).toEqual([
      'Federated Search v1 → v2 toggle',
      'Partition (acceleratedFields) editor',
    ])
    expect(SPIKE_GATED[0].spikes).toEqual(['P-S5', 'P-S7'])
    expect(SPIKE_GATED[1].spikes).toEqual(['P-S9'])
  })

  it('says what would have to be measured, not "later"', () => {
    for (const gate of SPIKE_GATED) {
      expect(gate.unknown.length).toBeGreaterThan(80)
      expect(gate.instead.length).toBeGreaterThan(20)
      expect(spikeGateNote(gate)).toContain(gate.spikes[0])
    }
  })
})

// ── What these tests could not assert, and why ──────────────────────────────
//
//   * THAT THE PATCH IS PARTIAL. Every Lake writer in this phase assumes
//     `PATCH /products/lake/lakes/default/datasets/{id}` updates only the fields
//     it is given (claim C6), and that assumption is inferred from the spec's
//     example bodies and nothing else. No test here can probe it; the cheapest
//     probe is a live 30 → 30 no-op followed by a full re-read, which is Preview
//     check 3.1 and belongs to the owner.
//   * THAT `notifications` SURVIVES A DESTINATION PATCH. `DESTINATION_READONLY_KEYS`
//     strips only `status`, against a design that also stripped `notifications`,
//     because the Preview check treats a re-read that lost `notifications` as a
//     failure. Which of the two is right is a question about the live endpoint.
//   * THE FLUSH PRESET VALUES AGAINST provision.ts. `DESTINATION_SPEC` is not
//     exported, so the pin above is against transcribed numbers with the source
//     named. Exporting it would make this a real comparison, and is a change to
//     a file this session does not own.
//   * ANY COST OR STORAGE CONSEQUENCE. Changing flush changes object sizes and
//     therefore every scan's cost; changing partitions changes the object count.
//     Both need a 24-hour watch on a real feed to see. Nothing here measures
//     either, and `PARTITION_FILL_FLOOR` and `PARTITION_DISTINCT_CEILING` are
//     stated judgements rather than measurements — which is why the tests assert
//     the sentence names the spike rather than asserting the number is right.
