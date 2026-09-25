/// <reference types="vite/client" />
// The onboarding plan, pinned. Every derivation the one confirmation and the
// run share is held still here, and the three that come from the pack's own
// files are held against those files:
//   * the sample feed's volume against default/inputs.yml + default/samples.yml;
//   * the Raw HTTP source's fresh-install before→after against inputs.yml, AND
//     against what packClient.ts's own preview reads off a source built from
//     it — so the dialog shown before the pack exists is the diff the run will
//     be handed back as `approved`;
//   * truth tables for `accelMode` and `onboardingPath`.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_RETENTION_DAYS, SAMPLE_DATASET_SPEC, SAMPLE_FEED, SAMPLE_START_DIFF, SHIPPED_HTTP_INPUT,
  accelMode, expectedConfigureDiff, httpActionOf, onboardingDatasets, onboardingDialog, onboardingPath, onboardingSteps,
  packObjectsOf, packRemovalDialog, parquetDatasetSpec, sampleVolume, type OnboardingDialogContext,
} from './plan'
import {
  ONBOARDING_FAILURE_PROMISE, ONBOARDING_UNDO, ONBOARDING_UNINSTALL, REMOVE_PACK_UNDO, accelCostWords, emptyRealDatasetSentence,
  globalStackSentence, keptDatasetsSentence, keptSchedulesSentence, lakeEntryNotCreatedSentence, sampleVolumeWords, storageCostWords,
} from '../../components/onboardingCopy'
import { MANIFEST } from '../accel/manifest'
import type { AccelRow, AccelState } from '../accel/provision'
import type { DatasetTarget, TargetReason } from '../datasetTarget'
import {
  PACK_HTTP_INPUT_ID, PACK_ID, PACK_OBJECTS, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID,
  packRelease,
} from '../pack'
import { DATASET_SPEC, PARQUET_DATASET_SPEC, tlsFor } from '../provision'
import { DEFAULT_PROFILE, datasetSpec } from '../landing'
import { SAVED_KIND } from '../../components/accelPanelCopy'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PACK_DIR = join(ROOT, 'packs', PACK_ID)
const yml = (rel: string) => parse(readFileSync(join(PACK_DIR, rel), 'utf8')) as Record<string, unknown>
const srcFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  if (e.isDirectory()) return srcFiles(p)
  return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
})
const inputs = yml('default/inputs.yml').inputs as Record<string, Record<string, unknown>>
const samples = yml('default/samples.yml') as Record<string, { size: number; numEvents: number }>

const target = (reason: TargetReason, known = true): DatasetTarget => ({
  known,
  reason,
  sample: reason === 'real-empty' || reason === 'real-absent',
  dataset: reason === 'real-empty' || reason === 'real-absent' ? 'gigamon_ami_sample' : 'gigamon_ami',
})

// ── Pinned against the pack's own files ─────────────────────────────────────

describe('the sample feed, as the pack ships it', () => {
  it('is inputs.yml’s rates and samples.yml’s sizes, sample for sample', () => {
    const shipped = (inputs[PACK_SAMPLE_INPUT_ID].samples as Array<{ sample: string; eventsPerSec: number }>).map((s) => ({
      sample: s.sample,
      eventsPerSec: s.eventsPerSec,
      size: samples[s.sample].size,
      numEvents: samples[s.sample].numEvents,
    }))
    expect(SAMPLE_FEED).toEqual(shipped)
  })

  it('writes 432,000 events a day, about 280 MB of sample text before compression', () => {
    const v = sampleVolume()
    expect(v.eventsPerSec).toBe(5)
    expect(v.eventsPerDay).toBe(432_000)
    const perSec = SAMPLE_FEED.reduce((n, e) => n + e.eventsPerSec * (e.size / e.numEvents), 0)
    expect(v.bytesPerDay).toBe(Math.round(perSec * 86_400))
    expect(v.bytesPerDay).toBeGreaterThan(270e6)
    expect(v.bytesPerDay).toBeLessThan(290e6)
    expect(sampleVolumeWords(v)).toBe(
      `Sample data: about 432,000 events a day (5 a second), about ${Math.round(v.bytesPerDay / 1e6)} MB a day before compression, into ${PACK_SAMPLE_DATASET_ID}.`,
    )
  })
})

describe('the Raw HTTP source’s fresh-install before→after', () => {
  it('starts from inputs.yml exactly', () => {
    const http = inputs[PACK_HTTP_INPUT_ID]
    expect({ disabled: http.disabled, port: http.port, tls: http.tls }).toEqual({ ...SHIPPED_HTTP_INPUT, tls: { ...SHIPPED_HTTP_INPUT.tls } })
    expect(http).not.toHaveProperty('authTokens')
    expect(http).not.toHaveProperty('authTokensExt')
  })

  it('names the token as a new one, never its value', () => {
    const rows = expectedConfigureDiff('managed', 20005)
    expect(rows).toEqual([
      { key: 'authTokensExt', kind: 'added', before: undefined, after: 'a new token (not shown)' },
      { key: 'disabled', kind: 'changed', before: true, after: false },
    ])
  })

  it('moves the port only when it differs, and turns TLS off only on a hybrid group', () => {
    expect(expectedConfigureDiff('managed', 20007).map((r) => r.key)).toEqual(['authTokensExt', 'disabled', 'port'])
    const hybrid = expectedConfigureDiff('hybrid', 10080)
    expect(hybrid.map((r) => r.key)).toEqual(['authTokensExt', 'disabled', 'port', 'tls'])
    expect(hybrid.find((r) => r.key === 'tls')).toMatchObject({ before: tlsFor(true), after: tlsFor(false) })
  })

  describe('is what packClient.ts previews off a source built from inputs.yml', () => {
    afterEach(() => vi.unstubAllGlobals())
    const GROUP = 'g1'
    const live = { id: PACK_HTTP_INPUT_ID, ...inputs[PACK_HTTP_INPUT_ID] }
    const stub = () =>
      vi.stubGlobal('fetch', async (url: string) => {
        const path = String(url).replace(/^\/capi/, '').split('?')[0]
        const reply = (status: number, value: unknown) => ({
          ok: status < 300, status, statusText: 'x', text: async () => JSON.stringify(value), json: async () => value,
        })
        if (path === `/m/${GROUP}/system/inputs`) return reply(200, { items: [] })
        if (path === `/m/${GROUP}/packs`) return reply(200, { items: [{ id: PACK_ID }] })
        if (path === `/m/${GROUP}/p/${PACK_ID}/system/inputs`) return reply(200, { items: [live] })
        if (path === `/m/${GROUP}/p/${PACK_ID}/system/inputs/${PACK_HTTP_INPUT_ID}`) return reply(200, { items: [live] })
        return reply(404, {})
      })

    for (const [hosting, port] of [['managed', 20005], ['managed', 20007], ['hybrid', 10080]] as const) {
      it(`${hosting}, port ${port}`, async () => {
        stub()
        const { previewPackInput } = await import('../packClient')
        const preview = await previewPackInput(GROUP, { kind: 'configure', port, token: 'ab'.repeat(32), hosting })
        expect(preview.ok).toBe(true)
        if (!preview.ok) return
        expect(expectedConfigureDiff(hosting, port)).toEqual(preview.diff)
      })
    }
  })

  it('starting the sample DataGen changes one key', () => {
    expect(inputs[PACK_SAMPLE_INPUT_ID].disabled).toBe(true)
    expect(SAMPLE_START_DIFF).toEqual([{ key: 'disabled', kind: 'changed', before: true, after: false }])
  })
})

// ── The datasets ────────────────────────────────────────────────────────────

describe('the datasets the run creates', () => {
  it('gigamon_ami_pq: Parquet, no partitions, gigamon_ami’s retention or 30 days', () => {
    expect(parquetDatasetSpec(365)).toEqual({ ...PARQUET_DATASET_SPEC, retentionPeriodInDays: 365 })
    for (const unknown of [null, 0, -1, 1.5]) expect(parquetDatasetSpec(unknown).retentionPeriodInDays, String(unknown)).toBe(30)
    expect(parquetDatasetSpec(90)).not.toHaveProperty('acceleratedFields')
    expect(parquetDatasetSpec(90).format).toBe('parquet')
  })

  it('gigamon_ami_sample: JSON, 30 days, described as synthetic', () => {
    expect(SAMPLE_DATASET_SPEC).toMatchObject({ id: PACK_SAMPLE_DATASET_ID, format: 'json', retentionPeriodInDays: 30 })
    expect(SAMPLE_DATASET_SPEC).not.toHaveProperty('acceleratedFields')
    expect(String(SAMPLE_DATASET_SPEC.description)).toMatch(/synthetic/i)
    expect(ONBOARDING_RETENTION_DAYS).toBe(30)
  })

  it('in run order, the sample only when ticked', () => {
    expect(onboardingDatasets({ sample: false, jsonRetentionDays: null }).map((d) => d.id)).toEqual(['gigamon_ami', PACK_PARQUET_DATASET_ID])
    const all = onboardingDatasets({ sample: true, jsonRetentionDays: 60 })
    expect(all.map((d) => d.id)).toEqual(['gigamon_ami', PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID])
    expect(all[0]).toBe(DATASET_SPEC)
    expect(all[1].retentionPeriodInDays).toBe(60)
  })

  it('gigamon_ami is created with the same body by both creators — DATASET_SPEC, never a saved profile', () => {
    // Guided Setup's dataset step builds `datasetSpec(ctx.profile)`, and
    // `ctx.profile` is `opts.profile ?? DEFAULT_PROFILE`. No caller passes one:
    // if a caller starts to, the onboarding run's DATASET_SPEC must follow it,
    // and this fails so that it does.
    expect(onboardingDatasets({ sample: false, jsonRetentionDays: null })[0]).toEqual(datasetSpec(DEFAULT_PROFILE))
    const callers = srcFiles(join(ROOT, 'src')).flatMap((p) => {
      const s = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
      return [...s.matchAll(/(?<!function )\bdeployAll\(/g)].map((m) => {
        const end = s.indexOf('\n', s.indexOf('})', m.index ?? 0))
        return { p, call: s.slice(m.index, end) }
      })
    })
    expect(callers.map((c) => c.p)).toEqual([expect.stringMatching(/ProvisionPanel\.tsx$/)])
    for (const c of callers) {
      expect(c.call).toMatch(/onToken/)
      expect(c.call, c.p).not.toMatch(/\bprofile\b/)
    }
  })
})

// ── Truth tables ────────────────────────────────────────────────────────────

describe('accelMode — installed running or paused', () => {
  const REASONS: TargetReason[] = ['no-sample', 'has-data', 'probe-found', 'unreadable', 'probe-failed', 'real-empty', 'real-absent']
  const RUNNING_UNTICKED = new Set<TargetReason>(['no-sample', 'has-data', 'probe-found', 'unreadable', 'probe-failed'])
  const RUNNING_TICKED = new Set<TargetReason>(['has-data', 'probe-found'])

  for (const reason of REASONS) {
    it(reason, () => {
      expect(accelMode(false, target(reason)), 'sample unticked').toBe(RUNNING_UNTICKED.has(reason) ? 'running' : 'paused')
      expect(accelMode(true, target(reason)), 'sample ticked').toBe(RUNNING_TICKED.has(reason) ? 'running' : 'paused')
    })
  }

  it('a verdict still out, or past the hold’s deadline, is paused either way', () => {
    for (const t of [target('reading', false), target('deadline')]) {
      expect(accelMode(false, t)).toBe('paused')
      expect(accelMode(true, t)).toBe('paused')
    }
  })
})

describe('onboardingPath — which onboarding the page offers', () => {
  const unpublished = packRelease({ published: false, sha256: null, version: '0.2.0' })
  const noDigest = packRelease({ published: true, sha256: null, version: '0.2.0' })
  const released = packRelease({ published: true, sha256: 'ab'.repeat(32), version: '0.2.0' })

  it('the global stack is THE onboarding while the pack cannot be installed, whatever is present', () => {
    for (const release of [unpublished, noDigest]) {
      for (const presence of [null, { http: false, legacySyslog: false }, { http: true, legacySyslog: true }]) {
        expect(onboardingPath(release, presence)).toEqual({ mode: 'global', provision: 'full', why: release.refusal })
      }
    }
  })

  it('this build today: global', () => {
    expect(onboardingPath(packRelease(), null).mode).toBe('global')
  })

  it('with the pack available, the global panel offers Remove only, and only while something is (or may be) there', () => {
    expect(onboardingPath(released, { http: true, legacySyslog: false })).toEqual({ mode: 'pack', provision: 'remove-only' })
    expect(onboardingPath(released, { http: false, legacySyslog: true })).toEqual({ mode: 'pack', provision: 'remove-only' })
    expect(onboardingPath(released, null), 'unread is never hidden').toEqual({ mode: 'pack', provision: 'remove-only' })
    expect(onboardingPath(released, { http: false, legacySyslog: false })).toEqual({ mode: 'pack', provision: 'hidden' })
  })
})

describe('onboardingSteps — the order, and what stops the run', () => {
  it('fresh install with sample data', () => {
    expect(onboardingSteps({ sample: true, packInstalled: false }).map((s) => `${s.key}:${s.onFailure}`)).toEqual([
      'dataset_json:stop', 'dataset_parquet:continue', 'dataset_sample:continue', 'pack:stop', 'http_input:stop',
      'sample_input:continue', 'commit_deploy:stop', 'acceleration:continue', 'recheck:continue',
    ])
  })

  it('pack already current, no sample data', () => {
    expect(onboardingSteps({ sample: false, packInstalled: true }).map((s) => s.key)).toEqual([
      'dataset_json', 'dataset_parquet', 'http_input', 'commit_deploy', 'acceleration', 'recheck',
    ])
  })
})

// ── The one confirmation ────────────────────────────────────────────────────

const LAKE = 'gno_lake_30d_c1d'
const accel = (opts: { unresolved?: boolean; state?: AccelRow['state']; enabled?: boolean | null } = {}): AccelState => ({
  rows: MANIFEST.map((entry) => ({
    id: entry.id, entry, state: opts.state ?? 'absent', enabled: opts.enabled ?? null,
    differences: opts.state === 'differs' ? ['its schedule'] : [], stamp: null, ours: false, recorded: false,
    intended: {} as AccelRow['intended'], stored: null, windowUnresolved: entry.id === LAKE && opts.unresolved === true,
  })),
  orphans: [], denied: false, error: null, truncated: false, readAt: 0,
})

const ctx = (over: Partial<OnboardingDialogContext> = {}): OnboardingDialogContext => ({
  group: 'g1',
  hosting: 'managed',
  port: 20007,
  sample: false,
  release: packRelease({ published: true, sha256: 'ab'.repeat(32), version: '0.2.0' }),
  packInstalled: false,
  datasets: [],
  jsonRetentionDays: null,
  liveHttpDiff: null,
  liveSampleDiff: null,
  accel: accel(),
  target: target('no-sample'),
  scope: { carries: ['groups/g1/default/cc-network-gigamon-ami'], alreadyDirty: [], elsewhere: [], unknown: false } as unknown as OnboardingDialogContext['scope'],
  undeployed: null,
  globalStackPresent: false,
  ...over,
})

describe('onboardingDialog', () => {
  it('names every object in run order: datasets, the pack and its objects, the sources, the deploy, the schedules', () => {
    const d = onboardingDialog(ctx())
    const ids = d.resources.map((r) => `${r.action}:${r.id}`)
    const packObjects = Object.values(PACK_OBJECTS).flat()
    expect(ids).toEqual([
      'create:gigamon_ami', `create:${PACK_PARQUET_DATASET_ID}`, `create:${PACK_ID}`,
      ...packObjects.map((id) => `create:${id}`),
      `replace:${PACK_HTTP_INPUT_ID}`, 'deploy:g1',
      ...MANIFEST.map((e) => `create:${e.id}`),
    ])
    expect(d.title).toBe('Onboard Gigamon AMI in g1')
    expect(d.undo).toBe(ONBOARDING_UNDO)
  })

  it('a sample left unticked adds no sample dataset, does not start the sample source, and has no sample diff', () => {
    const d = onboardingDialog(ctx())
    // Filtered by kind: the pack's sample ROUTE shares the dataset's id.
    expect(d.resources.some((r) => r.kind === 'Cribl Lake dataset' && r.id === PACK_SAMPLE_DATASET_ID)).toBe(false)
    // The pack still ships the source (disabled): it is named once, as a pack object, never as a replace.
    expect(d.resources.filter((r) => r.id === PACK_SAMPLE_INPUT_ID).map((r) => r.action)).toEqual(['create'])
    expect(d.diff.some((r) => r.resourceId === PACK_SAMPLE_INPUT_ID)).toBe(false)
    expect(d.approvedSample).toBeNull()
    expect(d.costLine).not.toMatch(/Sample data/)
  })

  it('ticked: the sample dataset and source, their diff, the volume, and acceleration installed paused', () => {
    const d = onboardingDialog(ctx({ sample: true }))
    expect(d.resources.some((r) => r.kind === 'Cribl Lake dataset' && r.id === PACK_SAMPLE_DATASET_ID)).toBe(true)
    expect(d.resources.filter((r) => r.id === PACK_SAMPLE_INPUT_ID).map((r) => r.action)).toEqual(['create', 'replace'])
    expect(d.diff.filter((r) => r.resourceId === PACK_SAMPLE_INPUT_ID)).toEqual([{ resourceId: PACK_SAMPLE_INPUT_ID, key: 'disabled', before: 'true', after: 'false' }])
    expect(d.approvedSample).toEqual([{ key: 'disabled', kind: 'changed', before: true, after: false }])
    expect(d.costLine).toContain(sampleVolumeWords(sampleVolume()))
    expect(d.accelMode).toBe('paused')
    expect(d.costLine).toContain(accelCostWords('paused', null, { created: MANIFEST.length, keepRunning: 0 }))
    expect(d.resources.filter((r) => r.kind === 'Cribl Search saved search').every((r) => r.detail?.startsWith('installed paused'))).toBe(true)
  })

  it('hands the run back exactly the diff it showed', () => {
    const d = onboardingDialog(ctx({ hosting: 'hybrid', port: 10080 }))
    expect(d.approvedHttp).toEqual(expectedConfigureDiff('hybrid', 10080))
    expect(d.diff.map((r) => r.key)).toEqual(d.approvedHttp.map((r) => r.key))
    expect(d.diff.every((r) => r.resourceId === PACK_HTTP_INPUT_ID)).toBe(true)
    expect(d.diff.find((r) => r.key === 'authTokensExt')).toEqual({ resourceId: PACK_HTTP_INPUT_ID, key: 'authTokensExt', before: null, after: 'a new token (not shown)' })
  })

  it('with the pack installed: no pack rows, and the live diff instead of the shipped one', () => {
    const live = [{ key: 'disabled', kind: 'changed' as const, before: true, after: false }]
    const d = onboardingDialog(ctx({ packInstalled: true, liveHttpDiff: live, datasets: ['gigamon_ami', PACK_PARQUET_DATASET_ID] }))
    expect(d.resources.some((r) => r.id === PACK_ID)).toBe(false)
    expect(d.resources[0].id).toBe(PACK_HTTP_INPUT_ID)
    expect(d.approvedHttp).toEqual(live)
    expect(d.steps.some((s) => s.key === 'pack')).toBe(false)
  })

  it('states the storage twice-over, and running schedules’ cost in words', () => {
    const d = onboardingDialog(ctx({ target: target('has-data') }))
    expect(d.accelMode).toBe('running')
    expect(d.costLine).toContain(storageCostWords())
    expect(d.costLine).toMatch(/Scheduled searches this run creates: bills /)
    expect(d.consequences).not.toContain(emptyRealDatasetSentence())
  })

  it('says running schedules may scan an empty dataset when nothing saw data in it', () => {
    const d = onboardingDialog(ctx({ target: target('no-sample') }))
    expect(d.accelMode).toBe('running')
    expect(d.consequences).toContain(emptyRealDatasetSentence())
  })

  it('the Lake entry on an unresolved window: no row, and a sentence saying why', () => {
    const d = onboardingDialog(ctx({ accel: accel({ unresolved: true }) }))
    expect(d.resources.some((r) => r.id === LAKE)).toBe(false)
    expect(d.approvedAccel[LAKE]).toBeUndefined()
    expect(d.consequences).toContain(lakeEntryNotCreatedSentence(LAKE))
  })

  it('names the global stack when it is present, and always the failure promise and the uninstall warning', () => {
    const d = onboardingDialog(ctx({ globalStackPresent: true }))
    expect(d.consequences).toContain(globalStackSentence('g1'))
    expect(d.consequences).toContain(ONBOARDING_FAILURE_PROMISE)
    expect(d.consequences).toContain(ONBOARDING_UNINSTALL)
    expect(onboardingDialog(ctx()).consequences).not.toContain(globalStackSentence('g1'))
  })

  it('a corrected schedule is labelled with the pause state it keeps, not the mode new ones are created in', () => {
    // Paused mode (sample ticked, nothing seen), over schedules that run and drifted:
    // the correction keeps them running, so the row must not say "installed paused".
    const paused = onboardingDialog(ctx({ sample: true, accel: accel({ state: 'differs', enabled: true }) }))
    expect(paused.accelMode).toBe('paused')
    const replaced = (d: ReturnType<typeof onboardingDialog>) => d.resources.filter((r) => r.kind === SAVED_KIND && r.action === 'replace')
    expect(replaced(paused)).toHaveLength(MANIFEST.length)
    for (const r of replaced(paused)) {
      expect(r.detail).not.toMatch(/installed paused/)
      expect(r.detail).toMatch(/^running · Overwritten/)
    }
    // The reverse: running mode over a paused schedule that drifted — it stays paused.
    const running = onboardingDialog(ctx({ target: target('has-data'), accel: accel({ state: 'differs', enabled: false }) }))
    expect(running.accelMode).toBe('running')
    expect(replaced(running)).toHaveLength(MANIFEST.length)
    for (const r of replaced(running)) expect(r.detail).toMatch(/^paused · Overwritten/)
    // A drifted schedule with no readable flag is PATCHed enabled (applyAcceleration), so it reads running.
    for (const r of replaced(onboardingDialog(ctx({ sample: true, accel: accel({ state: 'differs', enabled: null }) })))) {
      expect(r.detail).toMatch(/^running · /)
    }
  })

  it('paused mode claims no "nothing billed" while schedules from an earlier Apply keep running', () => {
    const n = MANIFEST.length
    for (const a of [accel({ state: 'enabled', enabled: true }), accel({ state: 'differs', enabled: true }), accel({ state: 'differs', enabled: null })]) {
      const d = onboardingDialog(ctx({ sample: true, accel: a }))
      expect(d.accelMode).toBe('paused')
      expect(d.costLine).not.toMatch(/nothing is billed|bill nothing|nothing billed/)
      expect(d.costLine).toContain(`${n} already installed keep running and billing`)
    }
    // Paused ones that stay paused bill nothing, and are not counted.
    expect(onboardingDialog(ctx({ sample: true, accel: accel({ state: 'differs', enabled: false }) })).costLine).not.toMatch(/keep running/)
    expect(onboardingDialog(ctx({ sample: true, accel: accel({ state: 'paused', enabled: false }) })).costLine).not.toMatch(/keep running/)
    // Fresh: the "bill nothing" claim is about the searches this run creates, and only those.
    expect(onboardingDialog(ctx({ sample: true })).costLine).toContain(
      'Scheduled searches this run creates: installed paused, so they bill nothing until they are switched on in Acceleration.',
    )
  })

  it('running mode with nothing to create does not say nothing is billed while the installed ones run', () => {
    const d = onboardingDialog(ctx({ target: target('has-data'), accel: accel({ state: 'enabled', enabled: true }) }))
    expect(d.accelMode).toBe('running')
    expect(d.costLine).not.toMatch(/nothing billed|bill nothing/)
    expect(d.costLine).toContain(`${MANIFEST.length} already installed keep running and billing`)
  })

  it('the Parquet row on a fresh tenant: gigamon_ami’s retention, because this run creates gigamon_ami', () => {
    const fresh = onboardingDialog(ctx({ datasets: [], jsonRetentionDays: null }))
    const pq = fresh.resources.find((r) => r.id === PACK_PARQUET_DATASET_ID)?.detail ?? ''
    expect(pq).toMatch(/30-day retention, the same as gigamon_ami, created by this run/)
    expect(pq).not.toMatch(/could not be read/)
    // A retention figure for a dataset that is not there is not used: the JSON dataset is created at its own.
    const stray = onboardingDialog(ctx({ datasets: [], jsonRetentionDays: 90 }))
    expect(stray.resources.find((r) => r.id === PACK_PARQUET_DATASET_ID)?.detail).toMatch(/30-day retention, the same as gigamon_ami, created by this run/)
    // Present and unreadable is the one case that falls back to the default.
    const unread = onboardingDialog(ctx({ datasets: ['gigamon_ami'], jsonRetentionDays: null }))
    expect(unread.resources.find((r) => r.id === PACK_PARQUET_DATASET_ID)?.detail).toMatch(/the default, because gigamon_ami’s could not be read/)
  })

  it('the Parquet row says its retention and that its shape is fixed at creation', () => {
    const d = onboardingDialog(ctx({ datasets: ['gigamon_ami'], jsonRetentionDays: 90 }))
    const pq = d.resources.find((r) => r.id === PACK_PARQUET_DATASET_ID)?.detail ?? ''
    expect(pq).toMatch(/Parquet/)
    expect(pq).toMatch(/90-day/)
    expect(pq).toMatch(/fixed at creation/)
  })
})

// ── What step 3 does to the Raw HTTP source ─────────────────────────────────

describe('httpActionOf — configure, start, or leave alone', () => {
  it.each([
    [null, 'configure'],
    [{ tokenSet: false, disabled: true }, 'configure'],
    [{ tokenSet: false, disabled: false }, 'configure'],
    [{ tokenSet: true, disabled: true }, 'enable'],
    [{ tokenSet: true, disabled: false }, 'none'],
  ] as const)('%j → %s', (http, want) => {
    expect(httpActionOf(http)).toBe(want)
  })

  it('a source that is only stopped is started, keeping its token: no token row, and no "new auth token" claim', () => {
    const live = [{ key: 'disabled', kind: 'changed' as const, before: true, after: false }]
    const d = onboardingDialog(ctx({ packInstalled: true, httpAction: 'enable', liveHttpDiff: live, datasets: ['gigamon_ami', PACK_PARQUET_DATASET_ID] }))
    const row = d.resources.find((r) => r.id === PACK_HTTP_INPUT_ID)
    expect(row?.detail).toBe('started, keeping its auth token, port and TLS as they are')
    expect(d.approvedHttp).toEqual(live)
    expect(d.diff.some((r) => r.key === 'authTokensExt')).toBe(false)
  })

  it('a source that has a token and runs is not named, and nothing is approved for it', () => {
    const d = onboardingDialog(ctx({ packInstalled: true, httpAction: 'none', liveHttpDiff: [], datasets: ['gigamon_ami', PACK_PARQUET_DATASET_ID] }))
    expect(d.resources.some((r) => r.id === PACK_HTTP_INPUT_ID)).toBe(false)
    expect(d.approvedHttp).toEqual([])
    expect(d.diff.filter((r) => r.resourceId === PACK_HTTP_INPUT_ID)).toEqual([])
  })
})

// ── Remove pack ─────────────────────────────────────────────────────────────

describe('packRemovalDialog', () => {
  const scope = ctx().scope

  it('a delete row for the pack and for every object in it, then the deploy — and no Lake dataset', () => {
    const d = packRemovalDialog({ group: 'g1', version: '0.2.0', scope, undeployed: null })
    expect(d.resources.map((r) => `${r.action}:${r.id}`)).toEqual([
      `delete:${PACK_ID}`, ...Object.values(PACK_OBJECTS).flat().map((id) => `delete:${id}`), 'deploy:g1',
    ])
    expect(d.resources.some((r) => r.kind === 'Cribl Lake dataset')).toBe(false)
  })

  it('names the three datasets it keeps, and how to be rid of the sample flows', () => {
    const d = packRemovalDialog({ group: 'g1', version: '0.2.0', scope, undeployed: null })
    expect(d.kept).toEqual(['gigamon_ami', PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID])
    expect(d.consequences[0]).toBe(keptDatasetsSentence(d.kept))
    expect(d.consequences[0]).toMatch(new RegExp(`Delete ${PACK_SAMPLE_DATASET_ID} in Cribl Lake`))
    expect(d.consequences).toContain(keptSchedulesSentence())
    expect(d.irreversible.why).toMatch(/Git history/)
    expect(d.irreversible.why).toMatch(/new auth token/)
    expect(d.undo).toBe(REMOVE_PACK_UNDO)
  })

  it('names 0.1.0’s objects by their published ids, not the current ones', () => {
    const d = packRemovalDialog({ group: 'g1', version: '0.1.0', scope, undeployed: null })
    const ids = d.resources.map((r) => r.id)
    for (const id of ['in_gno_syslog', 'in_gno_sample', 'gno_syslog', 'out_gno_lake']) expect(ids).toContain(id)
    expect(ids).not.toContain(PACK_HTTP_INPUT_ID)
    expect(packObjectsOf('0.1.0').breakers).toEqual([])
    expect(packObjectsOf('0.2.0')).toBe(PACK_OBJECTS)
  })
})

describe('copy hygiene', () => {
  it('no internal project history in anything the dialog says', () => {
    const d = onboardingDialog(ctx({ sample: true, globalStackPresent: true, accel: accel({ unresolved: true }), undeployed: 'a'.repeat(40) }))
    const text = [d.title, d.costLine, d.undo, ...d.consequences, ...d.resources.map((r) => `${r.kind} ${r.id} ${r.detail ?? ''}`)].join('\n')
    expect(text).not.toMatch(/\b(spike|Phase \d|A-SP|I-D\d|P-S\d|slice)\b/)
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
  })

  it('nor in anything Remove pack says', () => {
    const d = packRemovalDialog({ group: 'g1', version: '0.2.0', scope: ctx().scope, undeployed: 'a'.repeat(40) })
    const text = [d.title, d.undo, d.irreversible.why, ...d.consequences, ...d.resources.map((r) => `${r.kind} ${r.id} ${r.detail ?? ''}`)].join('\n')
    expect(text).not.toMatch(/\b(spike|Phase \d|A-SP|I-D\d|P-S\d|slice)\b/)
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
  })
})

describe('what the plan may import', () => {
  it('never packClient.ts — the plan stays pure, and the reads and writes are the run’s', () => {
    // Any spelling of the specifier, static or dynamic. The client is reachable
    // now (the run and the panel import it); what this holds is that the plan,
    // which the dialog is a pure function of, reaches no network through it.
    const src = readFileSync(join(ROOT, 'src', 'cribl', 'onboarding', 'plan.ts'), 'utf8')
    expect(src).not.toMatch(/['"`][^'"`\n]*\bpackClient(\.ts|\.js)?['"`]/)
  })
})

// What this file could not assert: that the dialog renders these rows in this
// order (that is <ConfirmDialog>'s own test), that a Leader's preview of an
// installed pack gives the diff a fresh file predicts (the pack has never been
// installed on a Leader with these sources), and that the sample feed's bytes
// a day are the bytes Lake stores — the pipeline adds fields and Lake
// compresses, so the figure is the sample text alone, and the dialog says so.
