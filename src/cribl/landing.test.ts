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
  applyDatasetEdit,
  confirmationStillHolds,
  sameDiff,
  applyDestinationEdit,
  datasetMergeDrift,
  datasetSpec,
  DATASET_DESCRIPTION,
  DEFAULT_PARTITION_LIMITS,
  DEFAULT_PROFILE,
  DATASET_READONLY_KEYS,
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
  engineState,
  engineDatasets,
  servesDataset,
  engineWords,
  servesWords,
  LANDING_TERMS,
  gateState,
  gateWords,
  gateIsReady,
  type MetricsGate,
  type GateInput,
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
    // This body is the CREATE path's, which is the only reason omitting is safe:
    // C6 was measured false on 2026-09-21, so on a PATCH an omitted key is reset
    // to its default rather than left alone. On a create, a default is what an
    // omitted key should get.
    expect(datasetSpec(DEFAULT_PROFILE)).not.toHaveProperty('acceleratedFields')
    expect(datasetSpec(profile({ partitions: ['protocol'] })).acceleratedFields).toEqual(['protocol'])
  })

  it('omits searchConfig on v1 and carries both object kinds on a Parquet dataset', () => {
    // v1 is no longer the DEFAULT — that changed on 2026-09-22 — but it is still
    // a profile a caller can build, and on it the key must be absent rather than
    // present-and-empty. Asserted through an explicit v1 profile now that
    // DEFAULT_PROFILE no longer supplies one.
    expect(datasetSpec(profile({ searchVersion: 'v1' }))).not.toHaveProperty('searchConfig')
    // And the default a new install gets IS v2, reading both object kinds.
    const dflt = datasetSpec(DEFAULT_PROFILE).searchConfig as { searchVersion: string; pathFilters: unknown[] }
    expect(dflt.searchVersion).toBe('v2')
    expect(dflt.pathFilters).toHaveLength(1)

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
  it('keeps gzip on JSON and leaves compression alone on Parquet', () => {
    expect(destinationSpec(DEFAULT_PROFILE).set.compress).toBe('gzip')
    const parquet = destinationSpec(profile({ format: 'parquet' }))
    // Neither set nor removed. P-S1 measured (2026-09-21) that `compress`
    // cannot be removed from a cribl_lake destination — omitting it resets it
    // to gzip, setting it to "none" answers 200 and leaves it gzip — and that
    // it is inert for Parquet anyway, since the written objects come out
    // `.parquet` rather than `.parquet.gz`. Asking was a no-op that read like
    // a safeguard.
    expect(parquet.set).not.toHaveProperty('compress')
    expect(parquet.remove).not.toContain('compress')
    expect(parquet.remove).not.toContain('compressionLevel')
  })

  it('lets the format token name the Parquet object, because it reports what was written', () => {
    // This used to assert the opposite, on SPEC §2's claim that `__format`
    // yields only `json` or `raw`. Measured 2026-09-21: when the destination
    // genuinely writes Parquet, `__format` resolves to `parquet` and the
    // default suffix gives `.<worker>.parquet`. Hard-coding `.parquet` was
    // worse than redundant — it named gzipped JSON `.parquet` whenever the
    // target dataset had not been created as Parquet, and every query over
    // those objects failed with "Parquet magic bytes not found in footer".
    expect(destinationSpec(profile({ format: 'parquet' })).set).not.toHaveProperty('fileNameSuffix')
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
    // `compress` is no longer removed (it cannot be) and `fileNameSuffix` is no
    // longer added (the default token expression is correct), so a JSON→Parquet
    // change touches the flush keys and the parquet writer settings and nothing
    // about compression or naming.
    expect(byKind('removed')).toEqual([])
    expect(byKind('changed')).toContain('maxFileSizeMB')
    expect(byKind('added')).toContain('parquetVersion')
    expect(byKind('added')).not.toContain('fileNameSuffix')
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

describe('applyDatasetEdit', () => {
  const live = {
    id: 'gigamon_ami',
    description: 'Gigamon AMI flow records',
    retentionPeriodInDays: 30,
    format: 'json',
    bucketName: 'lake-example-workspace',
    viewName: 'gigamon_ami-read-view',
    httpDAUsed: false,
    acceleratedFields: ['app_name'],
    searchConfig: { searchVersion: 'v1' },
    cacheConnection: { cacheRef: 'lh-1', createdAt: 1789000000000, retentionInDays: 7 },
    metrics: { currentSizeBytes: 111184359155, metricsDate: '2026-09-13' },
    deletionStartedAt: 1789000000001,
  }

  it('keeps every field the edit does not mention', () => {
    // Nobody has measured whether a Lake PATCH merges or replaces, so under one
    // of the two readings a key missing here is a key deleted from a live
    // customer dataset — retention, partitions, the storage binding, the lot.
    const body = applyDatasetEdit(live, { retentionPeriodInDays: 90 })
    expect(body.retentionPeriodInDays).toBe(90)
    expect(body.acceleratedFields).toEqual(['app_name'])
    expect(body.searchConfig).toEqual({ searchVersion: 'v1' })
    expect(body.bucketName).toBe('lake-example-workspace')
    expect(body.description).toBe('Gigamon AMI flow records')
    expect(body.id).toBe('gigamon_ami')
  })

  it('drops the two keys that are not stored configuration, and only those', () => {
    const body = applyDatasetEdit(live, { description: 'x' })
    expect(body).not.toHaveProperty('metrics')
    expect(body).not.toHaveProperty('deletionStartedAt')
    expect(DATASET_READONLY_KEYS).toEqual(['metrics', 'deletionStartedAt'])
  })

  it('keeps the fields that merely LOOK derived, on purpose', () => {
    // The asymmetry this list is written around: under the partial reading a
    // stripped key survives, under the replacement reading it is deleted. So
    // "strip it to be safe" is not the safe option here, and `viewName`,
    // `httpDAUsed` and `cacheConnection` ride along untouched rather than being
    // guessed at — the same trade DESTINATION_READONLY_KEYS makes with
    // `notifications`.
    const body = applyDatasetEdit(live, { description: 'x' })
    expect(body.viewName).toBe('gigamon_ami-read-view')
    expect(body).toHaveProperty('httpDAUsed')
    // Verbatim, not rebuilt: A-SP23 measured a sibling endpoint replacing a
    // sub-object wholesale, so a hand-built one would drop fields.
    expect(body.cacheConnection).toEqual(live.cacheConnection)
  })

  it('does not mutate the body it was given', () => {
    const before = JSON.stringify(live)
    applyDatasetEdit(live, { retentionPeriodInDays: 7 })
    expect(JSON.stringify(live)).toBe(before)
  })
})

describe('datasetMergeDrift', () => {
  // The comparison that decides whether a confirmed write may still be sent. The
  // writers in cribl/lakeLanding.ts read the dataset once to fill the dialog and
  // again after the answer; this is what says whether the second read is still
  // the dataset the person approved. It is a pure function precisely so the key
  // selection — what is compared, what is ignored — can be pinned here rather
  // than inferred from a stubbed HTTP sequence.
  const live = {
    id: 'gigamon_ami',
    description: 'old',
    retentionPeriodInDays: 30,
    acceleratedFields: ['app_name'],
    searchConfig: { searchVersion: 'v1', datatypes: ['cribl_lake'] },
    storageLocationId: 'cribl_lake',
    metrics: { currentSizeBytes: 1, metricsDate: '2026-09-13' },
  }
  const edit = { retentionPeriodInDays: 90 }

  it('is empty when the two reads agree', () => {
    expect(datasetMergeDrift(live, { ...live }, edit)).toEqual([])
  })

  it('CANNOT SEE the field being edited at all, in either direction', () => {
    // The overlay puts the same value on both sides, so the edited key is
    // invisible here whatever it did in between — including the move that
    // destroys data. That is not this function's job and it is deliberately not
    // given one: `confirmationStillHolds` below is the check that covers it, and
    // `mergeSourceAfterConfirm` runs that one FIRST. This test exists so that
    // the next reader of the exclusion finds the limit pinned rather than the
    // reassurance the first version of it carried.
    expect(datasetMergeDrift(live, { ...live, retentionPeriodInDays: 90 }, edit)).toEqual([])
    expect(datasetMergeDrift(live, { ...live, retentionPeriodInDays: 365 }, edit)).toEqual([])
  })

  it('ignores the keys Cribl recomputes rather than stores', () => {
    // `metrics` is a daily server-computed snapshot and `deletionStartedAt` a
    // server-stamped marker; neither is stored configuration, and both can move
    // without anybody touching the dataset. Comparing them would refuse every
    // write on a busy dataset — and a refusal that fires when nothing happened
    // is how people learn to click past the one that matters. The list is
    // DATASET_READONLY_KEYS itself, reached through `applyDatasetEdit`, so it
    // cannot drift from the one deciding what the PATCH body carries.
    expect(datasetMergeDrift(live, { ...live, metrics: { currentSizeBytes: 999, metricsDate: '2026-09-17' } }, edit)).toEqual([])
    expect(datasetMergeDrift(live, { ...live, deletionStartedAt: 1789000000001 }, edit)).toEqual([])
  })

  it('reports every other key that moved, with both values', () => {
    const drift = datasetMergeDrift(live, { ...live, description: 'theirs', storageLocationId: 'other_bucket' }, edit)
    expect(drift).toEqual([
      { key: 'description', before: 'old', after: 'theirs' },
      { key: 'storageLocationId', before: 'cribl_lake', after: 'other_bucket' },
    ])
  })

  it('reports a key that appeared and a key that vanished', () => {
    // Absent and empty are different, and a cleared `acceleratedFields` is
    // exactly the change a stale merge would put back.
    const { acceleratedFields: _gone, ...without } = live
    expect(datasetMergeDrift(live, without, edit)).toEqual([{ key: 'acceleratedFields', before: ['app_name'], after: undefined }])
    expect(datasetMergeDrift(live, { ...live, viewName: 'v' }, edit)).toEqual([{ key: 'viewName', before: undefined, after: 'v' }])
  })

  it('compares nested values structurally, not by reference', () => {
    // `searchConfig` and `cacheConnection` come back as fresh objects on every
    // read. A reference comparison would refuse every write, every time.
    expect(datasetMergeDrift(live, { ...live, searchConfig: { datatypes: ['cribl_lake'], searchVersion: 'v1' } }, edit)).toEqual([])
    const drift = datasetMergeDrift(live, { ...live, searchConfig: { searchVersion: 'v2', datatypes: ['cribl_lake'] } }, edit)
    expect(drift.map((d) => d.key)).toEqual(['searchConfig'])
  })

  it('compares a key nothing in this app has ever heard of', () => {
    // Not a curiosity: under the replacement reading of this endpoint, a key
    // this app does not recognise is a key a stale merge would delete, and it is
    // the one nobody would think to look for afterwards.
    expect(datasetMergeDrift(live, { ...live, somethingCriblAddedLater: 42 }, edit).map((d) => d.key)).toEqual(['somethingCriblAddedLater'])
  })

  it('does not mutate either body it was given', () => {
    const first = JSON.stringify(live)
    const second = { ...live, description: 'theirs' }
    const secondBefore = JSON.stringify(second)
    datasetMergeDrift(live, second, edit)
    expect(JSON.stringify(live)).toBe(first)
    expect(JSON.stringify(second)).toBe(secondBefore)
  })
})

describe('confirmationStillHolds', () => {
  // THE CHECK THAT COVERS WHAT `datasetMergeDrift` STRUCTURALLY CANNOT: the
  // field being edited. A confirmation is a sentence about one before → after,
  // and the `before` is what decides both the words and the gates — so if it
  // moves, the answer somebody gave is an answer to a question that is no longer
  // being asked. Pure, so the three verdicts are pinned here rather than
  // inferred from a stubbed HTTP sequence.

  it('holds when the before has not moved', () => {
    expect(confirmationStillHolds(30, 30, 60).verdict).toBe('holds')
  })

  it('calls a move to the TARGET a no-op, which is the one exception', () => {
    // Somebody else applied exactly the change that was approved. Nothing left
    // to send, and nothing to warn anybody about.
    expect(confirmationStillHolds(30, 60, 60).verdict).toBe('noop')
  })

  it('VOIDS THE CONFIRMATION when the before moved anywhere else — the case that deletes data', () => {
    // Live 30. A is shown "raise retention from 30 to 60 days — nothing is
    // deleted", which carries no typed gate because an increase needs none. B
    // sets 365. Sending 60 now deletes 305 days of a customer's events under a
    // sentence that promised the opposite. The verdict is not "stale": there is
    // no refreshed version of that sentence that A ever read.
    const check = confirmationStillHolds(30, 365, 60)
    expect(check.verdict).toBe('void')
    // Both values, because the caller's sentence has to name them.
    expect(check.shown).toBe(30)
    expect(check.now).toBe(365)
    expect(check.target).toBe(60)
  })

  it('does not treat an unmoved before as a no-op even when it already equals the target', () => {
    // "Already this value" is the writer's own check and it runs before the
    // dialog opens. Answering `noop` here would hide a genuinely unmoved object
    // behind the sentence written for somebody else's write.
    expect(confirmationStillHolds(60, 60, 60).verdict).toBe('holds')
  })

  it('compares strings and absence, not only numbers', () => {
    // `setDescription` shows a `before` too, and an absent description is a
    // different claim from an empty one.
    expect(confirmationStillHolds('old', 'old', 'new').verdict).toBe('holds')
    expect(confirmationStillHolds('old', 'theirs', 'new').verdict).toBe('void')
    expect(confirmationStillHolds('old', 'new', 'new').verdict).toBe('noop')
    expect(confirmationStillHolds(null, null, 'new').verdict).toBe('holds')
    expect(confirmationStillHolds(null, '', 'new').verdict).toBe('void')
  })

  it('compares structurally, so a re-read object is not a conflict', () => {
    expect(confirmationStillHolds({ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 9 }).verdict).toBe('holds')
    expect(confirmationStillHolds({ a: 1 }, { a: 2 }, { a: 9 }).verdict).toBe('void')
  })
})

describe('sameDiff', () => {
  // What lets `updateDestination` refuse a moved destination without a list of
  // the keys a Stream output moves on its own — the measurement that kept that
  // window open. The diff IS what the person read, so comparing diffs refuses on
  // exactly what was on screen and on nothing else.
  const live = { maxFileSizeMB: 5, compress: 'gzip', status: { health: 'green' } }
  const edit = { set: { maxFileSizeMB: 32 }, remove: [] as string[] }

  it('is true for two diffs of the same edit against the same object', () => {
    expect(sameDiff(diffDestination(live, edit), diffDestination({ ...live }, edit))).toBe(true)
  })

  it('is true when only a field the edit does not touch moved', () => {
    // A server-derived field — and any field nobody guessed at — changes no row.
    // This is the false refusal the key list was needed to avoid, and it does not
    // happen. The merge is onto the second read, so their value is carried
    // forward rather than reverted.
    const moved = { ...live, status: { health: 'red' }, environment: 'staging' }
    expect(sameDiff(diffDestination(live, edit), diffDestination(moved, edit))).toBe(true)
  })

  it('is false when the before of an approved row moved', () => {
    // Somebody else set maxFileSizeMB to 64 while the dialog was open. The row
    // that was approved said 5 → 32; the row that would apply says 64 → 32.
    expect(sameDiff(diffDestination(live, edit), diffDestination({ ...live, maxFileSizeMB: 64 }, edit))).toBe(false)
  })

  it('is false when a row appears or disappears', () => {
    const both = { set: { maxFileSizeMB: 32, compress: 'none' }, remove: [] as string[] }
    expect(sameDiff(diffDestination(live, both), diffDestination({ ...live, compress: 'none' }, both))).toBe(false)
    const { compress: _gone, ...withoutCompress } = live
    expect(sameDiff(diffDestination(live, { set: {}, remove: ['compress'] }), diffDestination(withoutCompress, { set: {}, remove: ['compress'] }))).toBe(
      false,
    )
  })

  it('compares row values structurally', () => {
    const a = [{ key: 'x', kind: 'changed' as const, before: { a: 1, b: 2 }, after: 3 }]
    const b = [{ key: 'x', kind: 'changed' as const, before: { b: 2, a: 1 }, after: 3 }]
    expect(sameDiff(a, b)).toBe(true)
    expect(sameDiff(a, [{ ...a[0], kind: 'added' as const }])).toBe(false)
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
    // The warning used to cite P-S9 as the thing nobody had measured. P-S9 ran
    // on 2026-09-21, so the sentence states the relationship instead of naming
    // a pending spike — and must not silently drop the consequence while doing
    // it, which is the part a reader acts on.
    expect(verdict.warnings[0].reason).not.toContain('P-S9')
    expect(verdict.warnings[0].reason).toContain('combinations that actually occur')
    expect(verdict.warnings[0].reason).toContain('more, smaller objects')
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
    // P-S5 REPORTED on 2026-09-21 and came off this list; P-S7 did not. The
    // distinction is the whole point of the row: P-S5 answered the endpoint
    // question on empty throwaway datasets, where a reader change cannot be
    // wrong about rows because there are no rows. P-S7 is the one that asks
    // whether v2 returns the same rows from THIS dataset, and only a spike on
    // the live dataset can answer it.
    // BOTH gates are now settled, by opposite answers: the reader because the
    // change was made (this dataset runs v2 since 2026-09-21), partitions
    // because the control is impossible. Neither owes a spike, and neither may
    // say "yet".
    expect(SPIKE_GATED[0].spikes).toEqual([])
    expect(SPIKE_GATED[0].settled).toContain('already on Federated Search v2')
    // P-S9 reported on 2026-09-21 and closed its gate WITHOUT opening the
    // control: partitions are fixed at dataset creation, so an editor on an
    // existing dataset is impossible rather than pending.
    expect(SPIKE_GATED[1].spikes).toEqual([])
    expect(SPIKE_GATED[1].settled).toBeTruthy()
  })

  it('says what would have to be measured, not "later"', () => {
    for (const gate of SPIKE_GATED) {
      expect(gate.unknown.length).toBeGreaterThan(80)
      expect(gate.instead.length).toBeGreaterThan(20)
      const note = spikeGateNote(gate)
      if (gate.settled) {
        // A settled gate names the reason and must NOT say "yet" — "not yet"
        // invites someone to wait for something that will never arrive.
        expect(note).toContain(gate.settled)
        expect(note).not.toContain('yet')
        expect(gate.spikes).toEqual([])
      } else {
        expect(note).toContain(gate.spikes[0])
        expect(gate.spikes.length).toBeGreaterThan(0)
      }
    }
  })
})

// ── What these tests could not assert, and why ──────────────────────────────
//
//   * THAT THE PATCH IS PARTIAL — no longer open, and it was not. Claim C6 was
//     measured on 2026-09-21 against a throwaway dataset (P-S5 step S5-1) and
//     came back FALSE: a PATCH naming only `{description}` answered 200, dropped
//     `format` and reset `retentionPeriodInDays` to 365. No test here can probe
//     a live endpoint, which is why this sat in this list; what a test CAN do is
//     pin the recorded answer, and `lakeLanding.test.ts` now does.
//   * THAT `notifications` SURVIVES A DESTINATION PATCH — answered on 2026-09-21,
//     and `DESTINATION_READONLY_KEYS` stripping only `status` is the correct
//     half. A measured one-field PATCH rebuilt the object from the body plus
//     schema defaults: 14 of 42 keys deleted, 4 silently reset. A stripped key
//     is therefore deleted or defaulted, never merely unmentioned, so the
//     design's longer list would have wiped a customer's notifications on the
//     first flush edit. What a test here still cannot assert is the live
//     endpoint's behaviour itself; see the note on the constant.
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


// ── What a Search engine is, and is not ─────────────────────────────────────
//
// These exist because of a defect that SHIPPED. The row was labelled
// "Acceleration tier" and read "local search enabled · 1 engine" beside a
// gigamon_ami dashboard, with a tip saying engines "answer some searches
// without fanning out across the object store". Measured 2026-09-22: the engine
// serves ['main','metrics'], gigamon_ami is not among them, and a gigamon_ami
// query still reports cacheStatus "miss", reason "No Lakehouse Configured".
//
// The sentence was not false in general — it was false WHERE IT APPEARED, which
// no gate in this repo could catch, because a tip's prose is not frozen.

const PROVISIONING = { id: 'e1', status: 'provisioning', effectiveStatus: 'provisioning', datasets: [] }
const READY = { id: 'e1', status: 'ready', effectiveStatus: 'ready', datasets: ['main', 'metrics'] }

describe('engineState', () => {
  it('separates provisioning from ready — the two a COUNT rendered identically', () => {
    expect(engineState([])).toBe('none')
    expect(engineState([PROVISIONING])).toBe('provisioning')
    expect(engineState([READY])).toBe('ready')
  })

  it('reports an unseen status as other rather than guessing the nearest word', () => {
    // The API publishes seven values; two have been observed. A reader acts on
    // the word, so a wrong word is worse than an honest unknown.
    expect(engineState([{ id: 'e', status: 'resizing', effectiveStatus: 'resizing' }])).toBe('other')
    expect(engineState([{ id: 'e' }])).toBe('other')
  })

  it('prefers effectiveStatus, which is what the API says is in force', () => {
    expect(engineState([{ status: 'provisioning', effectiveStatus: 'ready' }])).toBe('ready')
  })

  it('does not call a fleet ready while part of it is still building', () => {
    // THIS SHIPPED THE OTHER WAY ROUND and is the same shape as the defect the
    // row was repaired for: true of part of the evidence, presented as true of
    // all of it. A workspace with one engine serving and one still provisioning
    // is not settled, and the row that says so must not claim it is.
    expect(engineState([READY, PROVISIONING])).toBe('provisioning')
    expect(engineState([PROVISIONING, READY])).toBe('provisioning')
  })

  it('needs EVERY engine ready before it says ready', () => {
    expect(engineState([READY, READY])).toBe('ready')
    expect(engineState([READY, { id: 'e2', effectiveStatus: 'failed' }])).toBe('other')
  })
})

describe('servesDataset', () => {
  it('is false for the Lake dataset this app reads, however ready the engine is', () => {
    // THE WHOLE POINT. An engine existing implies nothing about gigamon_ami.
    expect(servesDataset([READY], 'main')).toBe(true)
    expect(servesDataset([READY], 'metrics')).toBe(true)
    expect(servesDataset([READY], 'gigamon_ami')).toBe(false)
  })

  it('serves nothing while provisioning', () => {
    expect(engineDatasets([PROVISIONING])).toEqual([])
    expect(servesDataset([PROVISIONING], 'main')).toBe(false)
  })
})

describe('the words the row prints', () => {
  it('names the state only when there is a state worth naming', () => {
    expect(engineWords([READY])).toBe(' (ready)')
    expect(engineWords([PROVISIONING])).toBe(' (provisioning)')
    expect(engineWords([])).toBe('')
  })

  it('says what is served AND that the app dataset is not', () => {
    expect(servesWords([READY], 'gigamon_ami')).toBe('serves main, metrics — not gigamon_ami')
  })

  it('is honest in the other direction too, so it never needs revisiting', () => {
    const lakehouse = { id: 'e', effectiveStatus: 'ready', datasets: ['main', 'gigamon_ami'] }
    expect(servesWords([lakehouse], 'gigamon_ami')).toBe('serves gigamon_ami, main — including gigamon_ami')
  })

  it('does not claim a dataset is served by an engine still building', () => {
    expect(servesWords([PROVISIONING], 'gigamon_ami')).toBe('serves no datasets yet — not gigamon_ami')
  })
})

describe('the acceleration tip', () => {
  it('no longer claims an engine accelerates the searches this app runs', () => {
    // The exact phrase that shipped, and the claim that made it wrong here.
    expect(LANDING_TERMS.accelerationTier).not.toContain('without fanning out across the object store')
    expect(LANDING_TERMS.accelerationTier).toContain('Lakehouse')
    expect(LANDING_TERMS.accelerationTier).toContain('does NOT accelerate a Cribl Lake dataset')
  })

  it('still says a tenant with no engines is normal, which was always true', () => {
    expect(LANDING_TERMS.accelerationTier).toContain('not misconfigured')
  })
})


// ── The metrics gate truth table ────────────────────────────────────────────
//
// Every row of it, including the ones that cannot be reached live on this
// tenant. NO_ENGINE is PERMANENTLY fixture-only here — this app can never delete
// an engine, so once Gigamon_LHE existed the zero-engine column stopped being
// reproducible. That is a change in how it is verified, not in whether it ships:
// it is what every other tenant sees on day one.

const gate = (over: Partial<GateInput> = {}): GateInput =>
  ({ outcome: 'ok', enabled: true, engines: 1, records: [READY], ...over })

describe('gateState', () => {
  it.each<[string, GateInput, MetricsGate, string]>([
    ['R1 403 — the account may not look', gate({ outcome: 'not-readable' }), 'no-permission', 'live'],
    ['R1 500 — the read failed', gate({ outcome: 'failed' }), 'unreadable', 'live'],
    ['R1 404 + R2 200 empty', gate({ enabled: false, engines: 0, records: [] }), 'not-available', 'FIXTURE ONLY'],
    ['R1 200 + R2 200 empty', gate({ engines: 0, records: [] }), 'no-engine', 'FIXTURE ONLY'],
    ['R1 200 + R2 refused', gate({ engines: null, records: [] }), 'engines-unreadable', 'FIXTURE ONLY'],
    ['R1 200 + one provisioning', gate({ records: [PROVISIONING] }), 'provisioning', 'observed once'],
    ['R1 200 + one ready', gate({ records: [READY] }), 'ready', 'live'],
    ['R1 200 + an unseen status', gate({ records: [{ id: 'e', effectiveStatus: 'resizing' }] }), 'degraded', 'FIXTURE ONLY'],
  ])('%s -> %s', (_name, input, expected) => {
    expect(gateState(input)).toBe(expected)
  })

  it('separates "not on this tenant" from "on, and nothing sized"', () => {
    // THE PAIR THE OLD SHORT-CIRCUIT DESTROYED. Both have zero engines; they are
    // different facts, and only reading R2 on the 404 tells them apart.
    expect(gateState(gate({ enabled: false, engines: 0, records: [] }))).toBe('not-available')
    expect(gateState(gate({ engines: 0, records: [] }))).toBe('no-engine')
  })

  it('never reports ready while anything is still building', () => {
    expect(gateState(gate({ engines: 2, records: [READY, PROVISIONING] }))).toBe('provisioning')
    expect(gateIsReady(gateState(gate({ engines: 2, records: [READY, PROVISIONING] })))).toBe(false)
  })

  it('treats an unreadable engine list as its own state, not as zero engines', () => {
    expect(gateState(gate({ engines: null, records: [] }))).not.toBe('no-engine')
  })

  it('is ready only in the one state that can actually hold metrics', () => {
    const all: MetricsGate[] = ['no-permission', 'unreadable', 'not-available', 'no-engine', 'engines-unreadable', 'provisioning', 'ready', 'degraded']
    expect(all.filter(gateIsReady)).toEqual(['ready'])
  })
})

describe('gateWords', () => {
  const ALL: MetricsGate[] = ['no-permission', 'unreadable', 'not-available', 'no-engine', 'engines-unreadable', 'provisioning', 'ready', 'degraded']

  it('has a real sentence for every state — no state can render blank', () => {
    for (const g of ALL) {
      expect(gateWords(g).length, g).toBeGreaterThan(40)
      expect(gateWords(g).endsWith('.'), g).toBe(true)
    }
  })

  it('gives every state a DIFFERENT sentence', () => {
    // Two states sharing a sentence is two states the reader cannot tell apart,
    // which is the same as not having both.
    expect(new Set(ALL.map(gateWords)).size).toBe(ALL.length)
  })

  it('never claims an engine accelerates the Lake dataset', () => {
    // The 6.9 lesson, applied forward: this is new copy, written after that
    // defect, and it must not reintroduce the claim in a new place.
    // Not "never says the word" — `ready` has to say it in order to DENY it.
    // The rule is that every mention is a negation.
    for (const g of ALL) {
      const s = gateWords(g).toLowerCase()
      if (s.includes('accelerat')) expect(s, `${g} mentions acceleration without denying it`).toContain('does not accelerate')
    }
    expect(gateWords('ready')).toContain('does not accelerate the Cribl Lake dataset')
  })

  it('reassures rather than alarms on the states that are not faults', () => {
    expect(gateWords('not-available')).toContain('normal state')
    expect(gateWords('provisioning')).toContain('nothing needs doing')
  })
})
