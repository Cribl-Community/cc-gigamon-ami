/// <reference types="vite/client" />
// The onboarding run and Remove pack, against a fake Leader.
//
// Stubbed at `fetch`, as packClient.test.ts and provision.test.ts are, so what
// is asserted is what a Leader would receive: the method, the path, the body,
// and — the point of a strictly sequential run — the ORDER. The dialog is built
// the way the panel builds it: `prepareOnboarding` does its reads against the
// same fake, and `onboardingDialog` turns them into the confirmation, so the
// run is handed exactly what a person would have been shown.
//
// pack.ts's release constants are swapped for a recorded release (as a release
// moves them) in every test but the unpublished-pin one: today's build refuses
// to install, and that refusal is pinned there.
//
// What is held still, by the design's numbers:
//   4. the token reaches one PATCH body and the caller's `onToken` — only after
//      `updated`, or after an error a re-read shows it landed — and no step, log
//      entry, commit message or other request;
//   5. run order and scope for {sample ticked or not} × {pack absent or
//      current}: the commit's files are the pack's alone, and the objects the
//      dialog names are the objects written;
//   6. every step's stop-or-continue;
//   7. a source that moved sends nothing; moved hosting or a taken port at
//      step 0 means zero writes; a changed acceleration mode refuses step 6;
//   8. unticked sample: no sample dataset POST and no sample PATCH;
//   9. sample-only creates every schedule paused, an unresolved window creates
//      no Lake entry, and nothing reads `$vt_results`;
//  11. Remove: the pack's DELETE, never a Lake DELETE; nothing committed after
//      it is an error.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MANIFEST } from '../accel/manifest'
import {
  PACK_HTTP_INPUT_ID, PACK_ID, PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID,
  PACK_URL, PACK_VERSION, packReleaseUrl,
} from '../pack'
import type { TargetReason } from '../datasetTarget'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SHIPPED = (parse(readFileSync(join(ROOT, 'packs', PACK_ID, 'default', 'inputs.yml'), 'utf8')) as {
  inputs: Record<string, Record<string, unknown>>
}).inputs

const GROUP = 'default'
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const HASH = 'dddd000011112222dddd000011112222dddd0000'
const LAKE_ENTRY = 'gno_lake_30d_c1d'
const DATASETS = '/products/lake/lakes/default/datasets'
const SAVED = '/m/default_search/search/saved'
const P = `/m/${GROUP}/p/${PACK_ID}`
const HTTP_INPUT = `${P}/system/inputs/${PACK_HTTP_INPUT_ID}`
const SAMPLE_INPUT = `${P}/system/inputs/${PACK_SAMPLE_INPUT_ID}`

interface Call { method: string; path: string; body: unknown }

type Fail =
  | 'dataset:gigamon_ami' | 'dataset:gigamon_ami_pq' | 'dataset:gigamon_ami_sample'
  | 'packPost' | 'verify' | 'httpPatch' | 'samplePatch' | 'commit' | 'deploy' | 'savedPost' | 'packDelete'

interface Opts {
  managed?: boolean
  /** Lake datasets that exist before the run. */
  datasets?: Array<{ id: string; retention?: number | null; format?: string; size?: number }>
  /** The pack already installed and current, with these sources. */
  installed?: { http?: Record<string, unknown>; sample?: Record<string, unknown> }
  /** Another copy of the pack, not this app's current one. */
  otherCopy?: { version: string; source: string }
  /** The group's own sources. */
  groupInputs?: Array<Record<string, unknown>>
  fail?: Partial<Record<Fail, number>>
  /** A failed http PATCH still stores the body (and so the token). */
  tokenLandsOnError?: boolean
  /** Git reports nothing pending after the pack is deleted, and the commit
   *  answers with no hash. */
  nothingToCommit?: boolean
  /** Saved searches are stored enabled whatever the POST said. */
  savedIgnoresPaused?: boolean
}

let calls: Call[] = []
let world: ReturnType<typeof makeWorld>

function makeWorld(o: Opts) {
  const datasets = new Map<string, Record<string, unknown>>()
  for (const d of o.datasets ?? []) {
    datasets.set(d.id, {
      id: d.id, format: d.format ?? 'json', retentionPeriodInDays: d.retention === undefined ? 30 : d.retention,
      metrics: { currentSizeBytes: d.size ?? 0, metricsDate: '2026-09-24' },
    })
  }
  const shipped = (id: string) => ({ id, ...structuredClone(SHIPPED[id]) })
  const w = {
    managed: o.managed ?? true,
    datasets,
    packs: o.otherCopy
      ? [{ id: PACK_ID, ...o.otherCopy }]
      : o.installed ? [{ id: PACK_ID, version: PACK_VERSION, source: PACK_URL }] : [] as Array<Record<string, unknown>>,
    packInputs: o.installed || o.otherCopy
      ? {
          [PACK_HTTP_INPUT_ID]: { ...shipped(PACK_HTTP_INPUT_ID), ...(o.installed?.http ?? {}) },
          [PACK_SAMPLE_INPUT_ID]: { ...shipped(PACK_SAMPLE_INPUT_ID), ...(o.installed?.sample ?? {}) },
        } as Record<string, Record<string, unknown>>
      : {} as Record<string, Record<string, unknown>>,
    groupInputs: o.groupInputs ?? [],
    pending: [] as string[],
    saved: new Map<string, Record<string, unknown>>(),
    kv: new Map<string, string>(),
    committed: [] as string[][],
    jobs: [] as string[],
    shipped,
  }
  return w
}

function reply(status: number, value?: unknown) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown } as unknown as Response
}

function leader(o: Opts = {}): void {
  calls = []
  world = makeWorld(o)
  const w = world
  const fail = o.fail ?? {}
  window.__CRIBL_SEARCH_ORIGIN = w.managed ? 'https://main-acme.cribl.cloud' : 'https://leader.example.com'
  vi.stubGlobal('getCriblUser', async () => ({ id: 'auth0|me', username: 'me' }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const full = String(url).replace(/^\/capi/, '')
    const path = full.split('?')[0]
    const raw = init.body == null ? undefined : String(init.body)
    let body: unknown = raw
    try { body = raw === undefined ? undefined : JSON.parse(raw) } catch { /* text/plain KV body */ }
    calls.push({ method, path, body })
    const at = (m: string, p: string) => method === m && path === p

    if (path.startsWith('/kvstore')) {
      const key = path.slice('/kvstore/'.length)
      if (method === 'PUT') { w.kv.set(key, raw ?? ''); return reply(200, '') }
      if (path === '/kvstore/keys') return reply(200, [...w.kv.keys()])
      const held = w.kv.get(key)
      return held === undefined ? reply(404, '') : reply(200, held)
    }

    if (at('GET', '/products/stream/groups')) {
      return reply(200, { items: [{ id: GROUP, name: GROUP, onPrem: !w.managed, configVersion: 'aaaa1111' }] })
    }
    if (at('GET', `/products/stream/groups/${GROUP}`)) return reply(200, { items: [{ id: GROUP, configVersion: 'aaaa1111' }] })
    if (at('GET', '/version')) return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }] })

    // Lake.
    if (at('GET', DATASETS)) return reply(200, { items: [...w.datasets.values()] })
    if (at('POST', DATASETS)) {
      const spec = body as Record<string, unknown>
      const s = fail[`dataset:${String(spec.id)}` as Fail]
      if (s) return reply(s, { message: 'refused' })
      w.datasets.set(String(spec.id), { ...spec, metrics: { currentSizeBytes: 0, metricsDate: null } })
      return reply(200, { items: [spec] })
    }

    // The group's sources and packs.
    if (at('GET', `/m/${GROUP}/system/inputs`)) return reply(200, { items: w.groupInputs })
    if (at('GET', `/m/${GROUP}/packs`)) {
      const listed = fail.verify && w.packs.length ? w.packs.map((p) => ({ ...p, source: 'https://elsewhere.example.com/x.crbl' })) : w.packs
      return reply(200, { items: listed })
    }
    if (at('POST', `/m/${GROUP}/packs`)) {
      if (fail.packPost) return reply(fail.packPost, { message: 'the Leader could not fetch the release' })
      w.packs = [{ id: PACK_ID, version: PACK_VERSION, source: (body as { source: string }).source }]
      w.packInputs = { [PACK_HTTP_INPUT_ID]: w.shipped(PACK_HTTP_INPUT_ID), [PACK_SAMPLE_INPUT_ID]: w.shipped(PACK_SAMPLE_INPUT_ID) }
      w.pending.push(`groups/${GROUP}/default/${PACK_ID}/package.json`)
      return reply(200, { items: [{ id: PACK_ID }] })
    }
    if (at('DELETE', `/m/${GROUP}/packs/${PACK_ID}`)) {
      if (fail.packDelete) return reply(fail.packDelete, { message: 'refused' })
      w.packs = []
      w.packInputs = {}
      if (!o.nothingToCommit) w.pending.push(`groups/${GROUP}/default/${PACK_ID}/package.json`)
      return reply(200, { items: [] })
    }
    if (at('GET', `${P}/system/inputs`)) return reply(200, { items: Object.values(w.packInputs) })
    for (const [id, item] of [[PACK_HTTP_INPUT_ID, HTTP_INPUT], [PACK_SAMPLE_INPUT_ID, SAMPLE_INPUT]] as const) {
      if (at('GET', item)) {
        const found = w.packInputs[id]
        return found ? reply(200, { items: [found] }) : reply(404, { message: 'not found' })
      }
      if (at('PATCH', item)) {
        const s = fail[id === PACK_HTTP_INPUT_ID ? 'httpPatch' : 'samplePatch']
        if (s) {
          if (o.tokenLandsOnError) w.packInputs[id] = body as Record<string, unknown>
          return reply(s, { message: 'the Leader refused the source' })
        }
        w.packInputs[id] = body as Record<string, unknown>
        w.pending.push(`groups/${GROUP}/local/${PACK_ID}/inputs.yml`)
        return reply(200, { items: [body] })
      }
    }
    for (const [p, items] of [
      [`${P}/lib/breakers/gigamon_ami_http_json_array`, [{ id: 'gigamon_ami_http_json_array' }]],
      [`${P}/pipelines`, [{ id: 'gigamon_ami_normalize' }]],
      [`${P}/routes`, [{ id: 'default', routes: [{ id: 'gigamon_ami_http_to_json' }, { id: 'gigamon_ami_http_to_parquet' }, { id: 'gigamon_ami_sample' }] }]],
      [`${P}/system/outputs`, [{ id: 'gigamon_ami_json_lake' }, { id: 'gigamon_ami_parquet_lake' }, { id: 'gigamon_ami_sample_lake' }]],
    ] as const) {
      if (at('GET', p)) return w.packs.length ? reply(200, { items }) : reply(404, { message: 'no pack' })
    }

    // Git.
    if (at('GET', '/version/status')) return reply(200, { items: [{ files: w.pending.map((f) => ({ path: f })) }] })
    if (at('POST', '/version/commit')) {
      if (fail.commit) return reply(fail.commit, { message: 'commit refused' })
      const files = (body as { files: string[] }).files
      w.committed.push(files)
      w.pending = w.pending.filter((f) => !files.includes(f))
      return reply(200, { items: [o.nothingToCommit ? {} : { commit: HASH }] })
    }
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(fail.deploy ?? 200, fail.deploy ? { message: 'deploy refused' } : { items: [] })

    // Saved searches.
    if (at('GET', SAVED)) return reply(200, { items: [...w.saved.values()], count: w.saved.size, totalCount: w.saved.size })
    if (at('POST', SAVED)) {
      if (fail.savedPost) return reply(fail.savedPost, { message: 'Not authorized or licensed to perform this action.' })
      const b = body as Record<string, unknown>
      const stored = o.savedIgnoresPaused ? { ...b, schedule: { ...(b.schedule as object), enabled: true } } : b
      w.saved.set(String(b.id), stored)
      return reply(200, { items: [stored] })
    }
    if (method === 'GET' && path.startsWith(`${SAVED}/`)) {
      const found = w.saved.get(decodeURIComponent(path.slice(SAVED.length + 1)))
      return found ? reply(200, { items: [found] }) : reply(404, { message: 'not found' })
    }
    if (at('POST', '/m/default_search/search/jobs')) {
      w.jobs.push(String((body as { query?: string }).query ?? ''))
      return reply(500, { message: 'no search in this fake' })
    }
    return reply(599, { message: `fake Leader has no route for ${method} ${full}` })
  })
}

/** Writes to customer configuration: everything but GETs and this app's own store. */
const writes = () => calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))
const kvPuts = () => calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/kvstore'))

type Run = typeof import('./run')
type Plan = typeof import('./plan')
type Target = typeof import('../datasetTarget')

/** The run with 0.2.0's release recorded (as a release moves pack.ts's
 *  constants), or with pack.ts as it is today. */
async function load(opts: { published?: boolean } = {}): Promise<{ run: Run; plan: Plan; dt: Target }> {
  vi.resetModules()
  if (opts.published === false) vi.doUnmock('../pack')
  else {
    vi.doMock('../pack', async (orig) => ({
      ...(await orig<typeof import('../pack')>()),
      PACK_PUBLISHED: true, PACK_SHA256: 'ab'.repeat(32), PACK_PUBLISHED_VERSIONS: Object.freeze(['0.1.0', PACK_VERSION]),
    }))
  }
  const [run, plan, dt] = await Promise.all([import('./run'), import('./plan'), import('../datasetTarget')])
  return { run, plan, dt }
}

interface Onboarded {
  steps: import('./run').RunStep[]
  stopped: import('./run').RunStep | null
  tokens: Array<{ token: string; afterError: boolean }>
  records: Array<{ hash: string; message: string }>
  dialog: import('./plan').OnboardingDialog
}

/** Prepare, build the dialog, optionally move the world, then run. */
async function onboard(
  o: { sample?: boolean; port?: number; target?: TargetReason; runTarget?: TargetReason; between?: () => void } = {},
): Promise<Onboarded> {
  const { run, plan, dt } = await load()
  dt.settleDatasetTarget(o.target === 'real-empty' || o.target === 'real-absent', o.target ?? 'no-sample')
  const prepared = await run.prepareOnboarding(GROUP, {
    sample: o.sample ?? false, port: o.port ?? 20007, target: dt.datasetTarget(), undeployed: null, undeployedChecking: false,
  })
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.why}`)
  const dialog = plan.onboardingDialog(prepared.ctx)
  o.between?.()
  if (o.runTarget) dt.settleDatasetTarget(o.runTarget === 'real-empty' || o.runTarget === 'real-absent', o.runTarget)
  const tokens: Onboarded['tokens'] = []
  const records: Onboarded['records'] = []
  const out = await run.runOnboarding(prepared.ctx, dialog, {
    onStep: () => {},
    onToken: (token, afterError) => tokens.push({ token, afterError }),
    record: async (hash, message) => { records.push({ hash, message }) },
    target: () => dt.datasetTarget(),
    token: () => TOKEN,
  })
  return { steps: out.steps, stopped: out.stopped, tokens, records, dialog }
}

beforeEach(() => { calls = [] })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../pack')
  vi.resetModules()
  delete window.__CRIBL_SEARCH_ORIGIN
})

const tokenless = { disabled: true }
const REAL_DATA = [{ id: PACK_LAKE_DATASET_ID, size: 5_000_000 }]

// ── 5. Order and scope ──────────────────────────────────────────────────────

/** Each write, as a word, in the order it was sent. */
function writeWords(): string[] {
  return writes().map((c) => {
    if (c.path === DATASETS) return `dataset:${(c.body as { id: string }).id}`
    if (c.method === 'POST' && c.path === `/m/${GROUP}/packs`) return 'install'
    if (c.path === HTTP_INPUT) return 'http'
    if (c.path === SAMPLE_INPUT) return 'sample'
    if (c.path === '/version/commit') return 'commit'
    if (c.path.endsWith('/deploy')) return 'deploy'
    if (c.path === SAVED) return 'saved'
    return `${c.method} ${c.path}`
  }).filter((w, i, all) => w !== 'saved' || all[i - 1] !== 'saved')
}

describe('5. the run, in order, and only what the dialog named', () => {
  for (const sample of [false, true]) {
    for (const pack of ['absent', 'current'] as const) {
      it(`sample ${sample ? 'ticked' : 'unticked'}, pack ${pack}`, async () => {
        leader({ datasets: REAL_DATA, installed: pack === 'current' ? { http: tokenless } : undefined })
        const r = await onboard({ sample, target: 'has-data' })
        expect(r.stopped).toBeNull()

        // Strictly this order.
        expect(writeWords()).toEqual([
          `dataset:${PACK_PARQUET_DATASET_ID}`,
          ...(sample ? [`dataset:${PACK_SAMPLE_DATASET_ID}`] : []),
          ...(pack === 'absent' ? ['install'] : []),
          'http',
          ...(sample ? ['sample'] : []),
          'commit', 'deploy', 'saved',
        ])

        // The commit carries the pack's files and nothing else.
        expect(world.committed).toHaveLength(1)
        expect(world.committed[0].length).toBeGreaterThan(0)
        for (const f of world.committed[0]) expect(f).toContain(`/${PACK_ID}/`)

        // What was written is what the dialog named (the pack's own objects
        // arrive with the install, and are named as rows of it).
        const written = new Set<string>()
        for (const c of writes()) {
          if (c.path === DATASETS || c.path === SAVED) written.add((c.body as { id: string }).id)
          else if (c.method === 'POST' && c.path === `/m/${GROUP}/packs`) written.add(PACK_ID)
          else if (c.path === HTTP_INPUT) written.add(PACK_HTTP_INPUT_ID)
          else if (c.path === SAMPLE_INPUT) written.add(PACK_SAMPLE_INPUT_ID)
          else if (c.path.endsWith('/deploy')) written.add(GROUP)
        }
        const named = new Set(r.dialog.resources.filter((x) => x.detail !== `in pack ${PACK_ID}`).map((x) => x.id))
        expect([...written].sort()).toEqual([...named].sort())
      })
    }
  }

  it('creates each dataset with the body the plan gives it, and gigamon_ami when it is absent', async () => {
    leader({ datasets: [] })
    const { plan } = await load()
    const r = await onboard({ sample: true })
    expect(r.stopped).toBeNull()
    const posted = writes().filter((c) => c.path === DATASETS).map((c) => c.body)
    expect(posted).toEqual(plan.onboardingDatasets({ sample: true, jsonRetentionDays: 30 }).map((s) => ({ ...s })))
  })

  it('records the pack commit under the onboarding key, and the log entry carries no token', async () => {
    leader({ datasets: REAL_DATA })
    const r = await onboard()
    expect(r.records).toEqual([{ hash: HASH, message: `Gigamon AMI: onboard pack ${PACK_ID} ${PACK_VERSION} in ${GROUP}` }])
    const logged = kvPuts().filter((c) => c.path.startsWith('/kvstore/gigamon/log/'))
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged[0].body)).toContain('onboarding_pack.applied')
    for (const put of kvPuts()) expect(JSON.stringify(put.body)).not.toContain(TOKEN)
  })
})

// ── 4. The token ────────────────────────────────────────────────────────────

describe('4. the token is handed over once, and written into one request only', () => {
  it('after `updated`: once, to the caller; in the PATCH body and nowhere else', async () => {
    leader({ datasets: REAL_DATA })
    const r = await onboard()
    expect(r.tokens).toEqual([{ token: TOKEN, afterError: false }])
    const carrying = calls.filter((c) => JSON.stringify(c.body ?? '').includes(TOKEN))
    expect(carrying.map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH ${HTTP_INPUT}`])
    expect(JSON.stringify(r.steps)).not.toContain(TOKEN)
    expect(JSON.stringify(r.dialog)).not.toContain(TOKEN)
  })

  it('a failed PATCH that left no token: none handed over, and the run stops before the commit', async () => {
    leader({ datasets: REAL_DATA, fail: { httpPatch: 500 } })
    const r = await onboard()
    expect(r.tokens).toEqual([])
    expect(r.stopped?.key).toBe('http_input')
    expect(writes().some((c) => c.path === '/version/commit')).toBe(false)
    expect(JSON.stringify(r.steps)).not.toContain(TOKEN)
  })

  it('a failed PATCH that a re-read shows DID land: handed over, with a warning', async () => {
    leader({ datasets: REAL_DATA, fail: { httpPatch: 500 }, tokenLandsOnError: true })
    const r = await onboard()
    expect(r.tokens).toEqual([{ token: TOKEN, afterError: true }])
    expect(r.steps.some((s) => s.key === 'http_input' && s.warning)).toBe(true)
    expect(JSON.stringify(r.steps)).not.toContain(TOKEN)
  })

  it('a source that already has a token is started, not rotated: no new token', async () => {
    leader({ datasets: REAL_DATA, installed: { http: { disabled: true, authTokensExt: [{ token: 'f'.repeat(64), authType: 'manual' }] } } })
    const r = await onboard()
    expect(r.tokens).toEqual([])
    const patch = writes().find((c) => c.path === HTTP_INPUT)
    expect(patch, 'the source was not started').toBeDefined()
    const sent = patch!.body as { authTokensExt: unknown; disabled: boolean }
    expect(sent.authTokensExt).toEqual([{ token: 'f'.repeat(64), authType: 'manual' }])
    expect(sent.disabled).toBe(false)
  })

  it('a source that has a token and runs is not written at all', async () => {
    leader({ datasets: REAL_DATA, installed: { http: { disabled: false, authTokensExt: [{ token: 'f'.repeat(64), authType: 'manual' }] } } })
    const r = await onboard()
    expect(r.tokens).toEqual([])
    expect(writes().some((c) => c.path === HTTP_INPUT)).toBe(false)
    expect(r.dialog.resources.some((x) => x.id === PACK_HTTP_INPUT_ID && x.action === 'replace')).toBe(false)
  })
})

// ── 6. What stops the run, and what does not ────────────────────────────────

describe('6. the failure matrix', () => {
  it('gigamon_ami not created: STOP — nothing after it', async () => {
    leader({ datasets: [], fail: { 'dataset:gigamon_ami': 500 } })
    const r = await onboard()
    expect(r.stopped?.key).toBe('dataset_json')
    expect(writeWords()).toEqual([`dataset:${PACK_LAKE_DATASET_ID}`])
  })

  it('gigamon_ami_pq not created: reported, and the run goes on', async () => {
    leader({ datasets: REAL_DATA, fail: { 'dataset:gigamon_ami_pq': 500 } })
    const r = await onboard({ target: 'has-data' })
    expect(r.stopped).toBeNull()
    expect(r.steps.find((s) => s.key === 'dataset_parquet')?.action).toBe('error')
    expect(writeWords()).toEqual([`dataset:${PACK_PARQUET_DATASET_ID}`, 'install', 'http', 'commit', 'deploy', 'saved'])
  })

  it('gigamon_ami_pq there with another shape: left as it is, and said so', async () => {
    leader({ datasets: [...REAL_DATA, { id: PACK_PARQUET_DATASET_ID, format: 'json' }] })
    const r = await onboard({ target: 'has-data' })
    const s = r.steps.find((x) => x.key === 'dataset_parquet')
    expect(s).toMatchObject({ action: 'exists', warning: true })
    expect(s?.detail).toMatch(/format json, not parquet/)
    expect(writes().some((c) => c.path === DATASETS)).toBe(false)
  })

  it('the sample dataset not created: the sample source is not started, and the rest still commits', async () => {
    leader({ datasets: REAL_DATA, fail: { 'dataset:gigamon_ami_sample': 500 } })
    const r = await onboard({ sample: true, target: 'has-data' })
    expect(r.steps.find((s) => s.key === 'sample_input')?.action).toBe('skipped')
    expect(writes().some((c) => c.path === SAMPLE_INPUT)).toBe(false)
    expect(writeWords()).toContain('commit')
  })

  it('the install refused: STOP — the datasets stay, no source is written, and the staged file is mentioned', async () => {
    leader({ datasets: REAL_DATA, fail: { packPost: 500 } })
    const r = await onboard()
    expect(r.stopped?.key).toBe('pack')
    expect(r.stopped?.detail).toMatch(/may remain staged on the Leader/)
    expect(writeWords()).toEqual([`dataset:${PACK_PARQUET_DATASET_ID}`, 'install'])
  })

  it('the install not read back as this app’s: STOP before any token is written', async () => {
    leader({ datasets: REAL_DATA, fail: { verify: 1 } })
    const r = await onboard()
    expect(r.stopped?.key).toBe('verify')
    expect(writes().some((c) => c.path === HTTP_INPUT)).toBe(false)
    expect(r.tokens).toEqual([])
  })

  it('the sample source refused: "sample not started", and the run still commits and deploys', async () => {
    leader({ datasets: REAL_DATA, fail: { samplePatch: 500 } })
    const r = await onboard({ sample: true, target: 'has-data' })
    expect(r.steps.find((s) => s.key === 'sample_input')?.detail).toMatch(/^sample not started/)
    expect(writeWords().slice(-3)).toEqual(['commit', 'deploy', 'saved'])
  })

  it('the commit refused: no deploy, and no saved-search call', async () => {
    leader({ datasets: REAL_DATA, fail: { commit: 500 } })
    const r = await onboard({ target: 'has-data' })
    expect(r.stopped?.key).toBe('commit')
    expect(writes().some((c) => c.path.endsWith('/deploy'))).toBe(false)
    expect(calls.some((c) => c.path.startsWith(SAVED) && c.method !== 'GET')).toBe(false)
    expect(r.steps.find((s) => s.key === 'acceleration')?.action).toBe('skipped')
  })

  it('the deploy refused: the commit is recorded, and no saved-search call', async () => {
    leader({ datasets: REAL_DATA, fail: { deploy: 500 } })
    const r = await onboard({ target: 'has-data' })
    expect(r.stopped?.key).toBe('deploy')
    expect(r.records.map((x) => x.hash)).toEqual([HASH])
    expect(calls.some((c) => c.path.startsWith(SAVED) && c.method !== 'GET')).toBe(false)
  })

  it('a refused saved search latches Acceleration’s Apply too, naming the path', async () => {
    leader({ datasets: REAL_DATA, fail: { savedPost: 403 } })
    const r = await onboard({ target: 'has-data' })
    // The same module instance the run used (load() reset the registry once).
    const authz = await import('../authz')
    expect(authz.latchedDenial('accel.apply')).toMatchObject({ method: 'POST', path: SAVED, status: 403 })
    expect(r.steps.some((s) => s.key === 'acceleration' && s.action === 'error')).toBe(true)
  })
})

// ── 7. What was shown is what is written ────────────────────────────────────

describe('7. anything that moved after the dialog', () => {
  it('a live source that moved: step 3 sends nothing, and nothing is committed', async () => {
    leader({ datasets: REAL_DATA, installed: { http: { disabled: true, port: 20005 } } })
    const r = await onboard({
      port: 20007,
      // Someone moves the source to the chosen port while the dialog is open,
      // so the diff it showed (a port row) is no longer the diff.
      between: () => { world.packInputs[PACK_HTTP_INPUT_ID].port = 20007 },
    })
    expect(r.stopped?.key).toBe('http_input')
    expect(r.stopped?.detail).toMatch(/changed after this change was shown/)
    expect(writes().some((c) => c.path === HTTP_INPUT)).toBe(false)
    expect(writes().some((c) => c.path === '/version/commit')).toBe(false)
  })

  it('the group’s hosting moved: zero writes', async () => {
    leader({ datasets: REAL_DATA })
    const r = await onboard({ between: () => { world.managed = false } })
    expect(r.stopped?.key).toBe('precheck')
    expect(r.stopped?.detail).toMatch(/Nothing was written/)
    expect(writes()).toEqual([])
  })

  it('the chosen port was taken: zero writes', async () => {
    leader({ datasets: REAL_DATA })
    const r = await onboard({
      port: 20007,
      between: () => { world.groupInputs = [{ id: 'someone_else', type: 'http', port: 20007 }] },
    })
    expect(r.stopped?.detail).toMatch(/port 20007/)
    expect(writes()).toEqual([])
  })

  it('the pack installed by somebody else since: zero writes', async () => {
    leader({ datasets: REAL_DATA })
    const r = await onboard({
      between: () => { world.packs = [{ id: PACK_ID, version: PACK_VERSION, source: PACK_URL }] },
    })
    expect(r.stopped?.detail).toMatch(/has been installed since/)
    expect(writes()).toEqual([])
  })

  it('a dataset that appeared since: zero writes', async () => {
    leader({ datasets: REAL_DATA })
    const r = await onboard({
      between: () => { world.datasets.set(PACK_PARQUET_DATASET_ID, { id: PACK_PARQUET_DATASET_ID, format: 'parquet', retentionPeriodInDays: 30 }) },
    })
    expect(r.stopped?.detail).toMatch(new RegExp(`${PACK_PARQUET_DATASET_ID} exists now`))
    expect(writes()).toEqual([])
  })

  it('what the app knows about the data changed: the scheduled searches are refused, everything else ran', async () => {
    leader({ datasets: REAL_DATA })
    const r = await onboard({ target: 'has-data', runTarget: 'real-empty' })
    expect(r.dialog.accelMode).toBe('running')
    const s = r.steps.find((x) => x.key === 'acceleration')
    expect(s?.action).toBe('refused')
    expect(calls.some((c) => c.path === SAVED && c.method === 'POST')).toBe(false)
    expect(writeWords()).toContain('deploy')
  })
})

// ── 8. The sample checkbox, in the run ──────────────────────────────────────

describe('8. unticked sample data', () => {
  it('no sample dataset POST, no sample source PATCH', async () => {
    leader({ datasets: [] })
    await onboard({ sample: false })
    expect(writes().some((c) => c.path === DATASETS && (c.body as { id: string }).id === PACK_SAMPLE_DATASET_ID)).toBe(false)
    expect(writes().some((c) => c.path === SAMPLE_INPUT)).toBe(false)
  })
})

// ── 9. Acceleration ─────────────────────────────────────────────────────────

describe('9. acceleration is always installed, and paused on sample data', () => {
  const posted = () => calls.filter((c) => c.method === 'POST' && c.path === SAVED).map((c) => c.body as { id: string; schedule?: { enabled?: boolean } })

  it('sample ticked with no data seen: every schedule is created paused', async () => {
    leader({ datasets: [{ id: PACK_LAKE_DATASET_ID, size: 0 }] })
    const r = await onboard({ sample: true, target: 'no-sample' })
    expect(r.dialog.accelMode).toBe('paused')
    expect(posted().length).toBeGreaterThan(0)
    for (const b of posted()) expect(b.schedule?.enabled).toBe(false)
  })

  it('real data seen, sample unticked: created running', async () => {
    leader({ datasets: REAL_DATA })
    await onboard({ target: 'has-data' })
    for (const b of posted()) expect(b.schedule?.enabled).toBe(true)
    expect(posted().map((b) => b.id).sort()).toEqual(MANIFEST.map((e) => e.id).sort())
  })

  it('gigamon_ami created by this run: the Lake entry was not in the dialog, so it is not created', async () => {
    leader({ datasets: [] })
    const r = await onboard({ target: 'no-sample' })
    expect(posted().some((b) => b.id === LAKE_ENTRY)).toBe(false)
    expect(r.steps.find((s) => s.label.includes(LAKE_ENTRY))?.action).toBe('skipped')
  })

  it('gigamon_ami’s retention unreadable: no Lake entry', async () => {
    leader({ datasets: [{ id: PACK_LAKE_DATASET_ID, retention: null, size: 5_000_000 }] })
    await onboard({ target: 'has-data' })
    expect(posted().some((b) => b.id === LAKE_ENTRY)).toBe(false)
    expect(posted().length).toBe(MANIFEST.length - 1)
  })

  it('created paused but read back running: said, not believed', async () => {
    leader({ datasets: [{ id: PACK_LAKE_DATASET_ID, size: 0 }], savedIgnoresPaused: true })
    const r = await onboard({ sample: true, target: 'no-sample' })
    const warned = r.steps.find((s) => s.key === 'acceleration' && s.action === 'error' && s.warning)
    expect(warned?.detail).toMatch(/created paused, but Cribl reports .* running\. Switch them off in Acceleration\./)
  })

  it('no stored-result read is ever submitted', async () => {
    leader({ datasets: [{ id: PACK_LAKE_DATASET_ID, size: 0 }, { id: PACK_SAMPLE_DATASET_ID }] })
    await onboard({ sample: true, target: 'real-empty' })
    expect(world.jobs.some((q) => q.includes('$vt_results'))).toBe(false)
  })
})

// ── 10. The unpublished pin, in the run ─────────────────────────────────────

describe('10. while no release is recorded', () => {
  it('prepare refuses with the release’s own sentence, and nothing is sent', async () => {
    leader({ datasets: REAL_DATA })
    const { run, dt } = await load({ published: false })
    dt.settleDatasetTarget(false, 'has-data')
    const r = await run.prepareOnboarding(GROUP, { sample: false, port: 20007, target: dt.datasetTarget(), undeployed: null, undeployedChecking: false })
    expect(r).toEqual({ ok: false, why: `pack ${PACK_VERSION} has not been released, so there is nothing to install yet` })
    expect(calls).toEqual([])
  })

  it('a run handed a dialog anyway writes nothing: step 0 re-reads the release', async () => {
    leader({ datasets: REAL_DATA })
    const published = await load()
    published.dt.settleDatasetTarget(false, 'has-data')
    const prepared = await published.run.prepareOnboarding(GROUP, { sample: false, port: 20007, target: published.dt.datasetTarget(), undeployed: null, undeployedChecking: false })
    if (!prepared.ok) throw new Error(prepared.why)
    const dialog = published.plan.onboardingDialog(prepared.ctx)
    const today = await load({ published: false })
    calls = []
    const out = await today.run.runOnboarding(prepared.ctx, dialog, {
      onStep: () => {}, onToken: () => {}, record: async () => {}, target: () => today.dt.datasetTarget(), token: () => TOKEN,
    })
    expect(out.stopped?.key).toBe('precheck')
    expect(writes()).toEqual([])
    expect(calls.some((c) => c.method === 'POST' && c.path === `/m/${GROUP}/packs`)).toBe(false)
  })
})

// ── 11. Remove pack ─────────────────────────────────────────────────────────

describe('11. Remove pack', () => {
  const remove = async () => {
    const { run } = await load()
    const steps: import('./run').RunStep[] = []
    let gone = 0
    const out = await run.runPackRemoval(GROUP, { onStep: (s) => steps.push(s), record: async () => {}, onSourcesGone: () => { gone++ } })
    return { out, steps, gone }
  }

  it('deletes the pack, commits and deploys, and never deletes a Lake dataset', async () => {
    leader({ datasets: [...REAL_DATA, { id: PACK_PARQUET_DATASET_ID }, { id: PACK_SAMPLE_DATASET_ID }], installed: {} })
    const { out, gone } = await remove()
    expect(out.stopped).toBeNull()
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE /m/${GROUP}/packs/${PACK_ID}`, 'POST /version/commit', `PATCH /products/stream/groups/${GROUP}/deploy`,
    ])
    expect(calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/products/lake'))).toBe(false)
    expect(gone).toBe(1)
    for (const f of world.committed[0]) expect(f).toContain(`/${PACK_ID}/`)
  })

  it('nothing committed after the DELETE is an error, not "up to date"', async () => {
    leader({ datasets: REAL_DATA, installed: {}, nothingToCommit: true })
    const { out } = await remove()
    expect(out.stopped?.key).toBe('commit')
    expect(writes().some((c) => c.path.endsWith('/deploy'))).toBe(false)
  })

  it('a copy this app did not install from its release is kept', async () => {
    leader({ datasets: REAL_DATA, otherCopy: { version: '0.1.0', source: 'https://elsewhere.example.com/fork.crbl' } })
    const { out, gone } = await remove()
    expect(out.stopped?.detail).toMatch(/^kept/)
    expect(writes()).toEqual([])
    expect(gone).toBe(0)
  })

  it('the published 0.1.0, installed from its release, is removed', async () => {
    leader({ datasets: REAL_DATA, otherCopy: { version: '0.1.0', source: packReleaseUrl('0.1.0') } })
    const { out } = await remove()
    expect(out.stopped).toBeNull()
    expect(writes()[0]).toMatchObject({ method: 'DELETE', path: `/m/${GROUP}/packs/${PACK_ID}` })
  })
})

// What this file could not assert: that a real Leader names a pack's files in
// Git with a `/cc-network-gigamon-ami/` segment (the fake says so; the commit
// refuses to report success when it does not), that `schedule.enabled: false`
// in a POST is honoured (the run reads back and warns, which is asserted only
// as far as the fake reports what it stored), how long the Leader takes to
// fetch the release, and anything about focus or layout — this is not a DOM
// test.
