// The pack's YAML against the app's TypeScript specs, value for value.
//
// The pack under packs/cc-network-gigamon-ami/ is a second copy of objects the
// app already describes in TypeScript: provision.ts's Raw HTTP stack
// (SOURCE_SPEC via sourceCreateBody, HTTP_BREAKER_SPEC, PIPELINE_SPEC,
// ROUTE_SPEC) and the Lake destinations landing.ts builds from a profile. This
// file is what makes the second copy safe: change either side alone and it
// fails.
//
// THE DIFFERENCES ARE WRITTEN DOWN, AND ONLY THOSE ARE ALLOWED:
//   - ids. Every pack object has its own id (src/cribl/pack.ts), distinct from
//     every global one, so the pack installs beside the global stack.
//   - the HTTP input ships `disabled: true`, on a placeholder port, with NO
//     auth token (the app generates one at install), and names the pack's own
//     breaker. TLS is the Cribl-managed form: a pack cannot know the group.
//   - the JSON route is NOT final, so the same event reaches the Parquet route
//     after it; the Parquet route's description names its dataset.
//   - the Parquet destination is the same profile with format parquet, pointed
//     at gigamon_ami_pq. Its schema mode is PENDING (pack.ts `PACK_PENDING`).
//
// Every comparison is whole-object: `toMatchObject` would let an added key (an
// `outputExpression`, an auth token) pass unseen.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, it, expect } from 'vitest'
import {
  PIPELINE_SPEC, SOURCE_SPEC, ROUTE_SPEC, HTTP_BREAKER_SPEC, destinationSpecFor, sourceCreateBody,
  HTTP_SOURCE_ID, HTTP_PIPELINE_ID, HTTP_ROUTE_ID, HTTP_BREAKER_ID, CLOUD_PORT_RANGE, tlsFor,
  LEGACY_SYSLOG_SOURCE_ID, LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID,
} from './provision'
import { DEFAULT_PROFILE, destinationSpec, type LandingProfile } from './landing'
import {
  PACK_ID, PACK_VERSION, PACK_URL, packTag, packAssetName,
  PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID, PACK_BREAKER_ID, PACK_PIPELINE_ID,
  PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_SAMPLE_ROUTE_ID,
  PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID, PACK_SAMPLE_OUTPUT_ID,
  PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID,
  PACK_HTTP_PLACEHOLDER_PORT, PACK_CLOUD_PORT_RANGE,
  SAMPLE_ORIGIN_FIELD, SAMPLE_ORIGIN_VALUE, REPLACED_BY_PACK, KEPT_BESIDE_PACK,
  PACK_SHA256, PACK_PUBLISHED, PACK_ROUTES_FILE, PACK_BREAKERS_FILE, PACK_PENDING,
} from './pack'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACK_DIR = join(ROOT, 'packs', PACK_ID)
const text = (rel: string) => readFileSync(join(PACK_DIR, rel), 'utf8')
const yml = (rel: string) => parse(text(rel))

type Obj = Record<string, unknown>
const without = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

const inputs = yml('default/inputs.yml').inputs as Record<string, Obj>
const outputs = yml('default/outputs.yml').outputs as Record<string, Obj>
const breakers = yml(PACK_BREAKERS_FILE) as Record<string, Obj>
const routes = yml(PACK_ROUTES_FILE).routes as Obj[]
const route = (id: string) => routes.find((r) => r.id === id)
const pipeline = (id: string) => yml(`default/pipelines/${id}/conf.yml`) as { functions: unknown[] }
/** The pipeline directories: `default/pipelines/` also holds the pack's route.yml. */
const pipelineDirs = () => readdirSync(join(PACK_DIR, 'default', 'pipelines'), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name)
const samples = yml('default/samples.yml') as Obj

const profileFor = (datasetId: string, format: LandingProfile['format']): LandingProfile =>
  ({ ...DEFAULT_PROFILE, datasetId, format })
const lakeOutput = (datasetId: string, format: LandingProfile['format']) =>
  ({ type: 'cribl_lake', ...destinationSpec(profileFor(datasetId, format)).set })

describe('the pack files are where Cribl reads them', () => {
  it('routes are in default/pipelines/route.yml, and default/routes.yml does not exist', () => {
    // Measured on a Leader: every bundled pack keeps <pack>/default/pipelines/route.yml,
    // and no file named routes.yml exists anywhere. A routes file anywhere else
    // is not read, so the pack would install with no routes at all.
    expect(PACK_ROUTES_FILE).toBe('default/pipelines/route.yml')
    expect(existsSync(join(PACK_DIR, 'default', 'routes.yml'))).toBe(false)
  })

  it('breakers are in default/breakers.yml (unmeasured: the proof install reads it back)', () => {
    expect(PACK_BREAKERS_FILE).toBe('default/breakers.yml')
    expect(existsSync(join(PACK_DIR, 'default', 'cribl', 'breakers.yml'))).toBe(false)
  })
})

describe('the pack HTTP input is provision.ts\'s Cribl-managed source, with the documented differences only', () => {
  const src = inputs[PACK_HTTP_INPUT_ID]
  const global = sourceCreateBody({ managed: true, port: PACK_HTTP_PLACEHOLDER_PORT }, 'not-a-token')

  it('matches every field but the id, `disabled`, the auth token and the breaker it names', () => {
    expect(without(src, 'disabled', 'breakerRulesets')).toEqual(
      without(global, 'id', 'disabled', 'authTokensExt', 'breakerRulesets'),
    )
    expect(src.breakerRulesets).toEqual([PACK_BREAKER_ID])
    expect(global.breakerRulesets).toEqual([HTTP_BREAKER_ID])
    expect(src.type).toBe('http_raw')
    // Cribl's own certificate: what a Cribl-managed group provides.
    expect(src.tls).toEqual(tlsFor(true))
  })

  it('ships disabled, unlike the global source', () => {
    // A Cloud port in 20000-20010 is reachable from the internet. Nothing
    // listens until Guided Setup sets a port and a token and enables it.
    expect(src.disabled).toBe(true)
    expect(SOURCE_SPEC.disabled).toBe(false)
  })

  it('carries no auth token of any kind: the app generates one at install', () => {
    for (const k of ['authTokensExt', 'authTokens', 'authToken']) expect(src).not.toHaveProperty(k)
    expect(text('default/inputs.yml')).not.toMatch(/^\s*(authTokens|authTokensExt|token)\s*:/m)
  })

  it('ships a placeholder port a Cribl-managed group exposes', () => {
    expect(src.port).toBe(PACK_HTTP_PLACEHOLDER_PORT)
    expect(PACK_CLOUD_PORT_RANGE).toEqual(CLOUD_PORT_RANGE)
    expect(PACK_HTTP_PLACEHOLDER_PORT).toBeGreaterThanOrEqual(PACK_CLOUD_PORT_RANGE.min)
    expect(PACK_HTTP_PLACEHOLDER_PORT).toBeLessThanOrEqual(PACK_CLOUD_PORT_RANGE.max)
  })

  it('ships exactly two inputs, and no syslog one', () => {
    expect(Object.keys(inputs).sort()).toEqual([PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID].sort())
    expect(Object.values(inputs).map((i) => i.type)).not.toContain('syslog')
  })
})

describe('the pack breaker is HTTP_BREAKER_SPEC under the pack id', () => {
  it('equals the global ruleset value for value', () => {
    expect(Object.keys(breakers)).toEqual([PACK_BREAKER_ID])
    expect(breakers[PACK_BREAKER_ID]).toEqual(without(HTTP_BREAKER_SPEC, 'id'))
  })
})

describe('the pack pipeline is provision.ts\'s PIPELINE_SPEC: cast and derive, no parse step', () => {
  it('carries the two functions, value for value', () => {
    expect(PIPELINE_SPEC.conf.functions.map((f) => f.description)).toEqual(['Cast numeric strings', 'Derive helper fields'])
    expect(pipeline(PACK_PIPELINE_ID).functions).toEqual(PIPELINE_SPEC.conf.functions)
  })

  it('is the only pipeline, and every route runs it', () => {
    expect(pipelineDirs()).toEqual([PACK_PIPELINE_ID])
    for (const r of routes) expect(r.pipeline).toBe(PACK_PIPELINE_ID)
  })
})

describe('the sample DataGen', () => {
  const gen = inputs[PACK_SAMPLE_INPUT_ID]

  it('ships disabled, and tags every event as sample data', () => {
    expect(gen.type).toBe('datagen')
    expect(gen.disabled).toBe(true)
    // Through the routes, and only the routes: a QuickConnect `connections`
    // list with sendToRoutes false would bypass the sample route entirely.
    expect(gen.sendToRoutes).toBe(true)
    expect(gen).not.toHaveProperty('connections')
    // `metadata` values are JS expressions, so the literal carries its own quotes.
    expect(gen.metadata).toEqual([{ name: SAMPLE_ORIGIN_FIELD, value: `'${SAMPLE_ORIGIN_VALUE}'` }])
  })

  it('replays every sample samples.yml declares', () => {
    expect((gen.samples as { sample: string }[]).map((s) => s.sample).sort()).toEqual(Object.keys(samples).sort())
  })
})

describe('the pack Lake destinations are landing.ts\'s profile bodies', () => {
  it('the JSON destination is destinationSpecFor(DEFAULT_PROFILE) under the pack id', () => {
    expect({ id: PACK_JSON_OUTPUT_ID, ...outputs[PACK_JSON_OUTPUT_ID] }).toEqual({ ...destinationSpecFor(DEFAULT_PROFILE), id: PACK_JSON_OUTPUT_ID })
    expect(outputs[PACK_JSON_OUTPUT_ID].destPath).toBe(PACK_LAKE_DATASET_ID)
    expect(outputs[PACK_JSON_OUTPUT_ID].format).toBe('json')
  })

  it('the Parquet destination is the same profile as Parquet, pointed at gigamon_ami_pq', () => {
    expect(outputs[PACK_PARQUET_OUTPUT_ID]).toEqual(lakeOutput(PACK_PARQUET_DATASET_ID, 'parquet'))
    expect(outputs[PACK_PARQUET_OUTPUT_ID].format).toBe('parquet')
    // PENDING (test (g), D-10): automatic schema is the placeholder, not a decision.
    expect(outputs[PACK_PARQUET_OUTPUT_ID].automaticSchema).toBe(true)
  })

  it('the sample destination is the JSON profile pointed at the sample dataset', () => {
    expect(outputs[PACK_SAMPLE_OUTPUT_ID]).toEqual(lakeOutput(PACK_SAMPLE_DATASET_ID, 'json'))
  })

  it('ships exactly those three', () => {
    expect(Object.keys(outputs).sort()).toEqual([PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID, PACK_SAMPLE_OUTPUT_ID].sort())
    expect(new Set([PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID]).size).toBe(3)
  })
})

describe('the pack routes', () => {
  const http = `__inputId=='http_raw:${PACK_HTTP_INPUT_ID}'`

  it('HTTP → JSON is ROUTE_SPEC with the pack ids, and NOT final', () => {
    expect(route(PACK_HTTP_JSON_ROUTE_ID)).toEqual({
      ...ROUTE_SPEC,
      id: PACK_HTTP_JSON_ROUTE_ID,
      name: PACK_HTTP_JSON_ROUTE_ID,
      final: false,
      filter: http,
      pipeline: PACK_PIPELINE_ID,
      output: PACK_JSON_OUTPUT_ID,
    })
    expect(ROUTE_SPEC.final).toBe(true)
  })

  it('HTTP → Parquet is the same route, final, to the Parquet destination only', () => {
    expect(route(PACK_HTTP_PARQUET_ROUTE_ID)).toEqual({
      ...ROUTE_SPEC,
      id: PACK_HTTP_PARQUET_ROUTE_ID,
      name: PACK_HTTP_PARQUET_ROUTE_ID,
      final: true,
      filter: http,
      pipeline: PACK_PIPELINE_ID,
      output: PACK_PARQUET_OUTPUT_ID,
      description: 'Gigamon AMI over HTTP → normalize → Cribl Lake (gigamon_ami_pq, Parquet)',
    })
  })

  it('the sample route sends the DataGen to the sample destination, and nothing else', () => {
    expect(route(PACK_SAMPLE_ROUTE_ID)).toEqual({
      id: PACK_SAMPLE_ROUTE_ID,
      name: PACK_SAMPLE_ROUTE_ID,
      final: true,
      disabled: false,
      filter: `__inputId=='datagen:${PACK_SAMPLE_INPUT_ID}'`,
      pipeline: PACK_PIPELINE_ID,
      output: PACK_SAMPLE_OUTPUT_ID,
      description: 'Gigamon AMI sample data → Cribl Lake (gigamon_ami_sample)',
      clones: [],
      enableOutputExpression: false,
    })
  })

  it('runs JSON before Parquet, so the non-final route sees the event first', () => {
    // A final route ahead of the JSON one would leave the dashboards' dataset
    // empty; the order is the fan-out.
    expect(routes.map((r) => r.id)).toEqual([PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_SAMPLE_ROUTE_ID])
  })

  it('never lets sample data reach the customer\'s datasets', () => {
    const sampleRoute = route(PACK_SAMPLE_ROUTE_ID)!
    expect(outputs[sampleRoute.output as string].destPath).toBe(PACK_SAMPLE_DATASET_ID)
    for (const r of routes.filter((x) => x.id !== PACK_SAMPLE_ROUTE_ID)) expect(r.filter).toBe(http)
  })
})

describe('the PENDING decisions cannot ship in a release', () => {
  const places = ['README.md', 'default/outputs.yml']

  it('are named in pack.ts, the README and the Parquet destination\'s file while they are open', () => {
    // Held both ways: while PACK_PENDING has entries, every place a reader
    // looks says PENDING; once it is empty, none of them may.
    for (const p of places) expect(/PENDING/.test(text(p))).toBe(Object.keys(PACK_PENDING).length > 0)
    for (const why of Object.values(PACK_PENDING)) expect(why.trim()).not.toBe('')
  })

  it('PACK_PUBLISHED cannot be true while anything is PENDING', () => {
    if (PACK_PUBLISHED) {
      expect(Object.keys(PACK_PENDING)).toEqual([])
      for (const p of places) expect(text(p)).not.toMatch(/PENDING/)
    }
  })
})

describe('pack ids', () => {
  const packIds = [
    ...Object.keys(inputs), ...Object.keys(outputs), ...routes.map((r) => r.id as string),
    ...pipelineDirs(), ...Object.keys(breakers), ...Object.keys(samples),
  ]
  const replaced = Object.keys(REPLACED_BY_PACK)
  const kept = Object.keys(KEPT_BESIDE_PACK)

  it('are exactly the ids pack.ts names', () => {
    expect([...packIds].sort()).toEqual([
      PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID, PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID, PACK_SAMPLE_OUTPUT_ID,
      PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_SAMPLE_ROUTE_ID, PACK_PIPELINE_ID, PACK_BREAKER_ID,
      ...Object.keys(samples),
    ].sort())
  })

  it('never carry the gno_ prefix, which is reserved for acceleration schedules', () => {
    expect(packIds.filter((id) => id.startsWith('gno_'))).toEqual([])
    expect(SAMPLE_ORIGIN_FIELD.startsWith('gno_')).toBe(false)
  })

  it('never reuse a global id, today\'s or an earlier release\'s', () => {
    const globals = new Set([
      ...replaced, ...kept,
      SOURCE_SPEC.id, PIPELINE_SPEC.id, ROUTE_SPEC.id, HTTP_BREAKER_SPEC.id, destinationSpecFor(DEFAULT_PROFILE).id,
      LEGACY_SYSLOG_SOURCE_ID, LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID,
    ])
    expect(packIds.filter((id) => globals.has(id))).toEqual([])
  })

  it('every replacement names an object the pack actually defines, and every entry a reason', () => {
    for (const { by, why } of Object.values(REPLACED_BY_PACK)) {
      expect(packIds).toContain(by)
      expect(why.trim()).not.toBe('')
    }
    for (const why of Object.values(KEPT_BESIDE_PACK)) expect(why.trim()).not.toBe('')
  })

  it('the migration removes exactly Guided Setup\'s HTTP stack and the old Syslog stack', () => {
    expect([...replaced].sort()).toEqual([
      HTTP_SOURCE_ID, HTTP_PIPELINE_ID, HTTP_ROUTE_ID, HTTP_BREAKER_ID,
      LEGACY_SYSLOG_SOURCE_ID, LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID,
    ].sort())
  })

  it('keeps the demo DataGen, the global gigamon_ami pipeline and the global Lake destination', () => {
    expect(destinationSpecFor(DEFAULT_PROFILE).id).toBe('gigamon_lake')
    expect([...kept].sort()).toEqual(['gigamon_ami', 'gigamon_lake', 'in_gigamon_datagen'])
  })

  it('no global id is both replaced and kept', () => {
    expect(replaced.filter((id) => kept.includes(id))).toEqual([])
  })
})

describe('the pinned pack', () => {
  const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'package.json'), 'utf8')) as Obj
  const semver = (v: string) => v.split('.').map(Number)
  const cmp = (a: string, b: string) => {
    const [x, y] = [semver(a), semver(b)]
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  }

  it('names the pack in the repo', () => {
    expect(manifest.name).toBe(PACK_ID)
  })

  it('is never ahead of the pack source (the source may run ahead of the pin)', () => {
    expect(PACK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(cmp(PACK_VERSION, manifest.version as string)).toBeLessThanOrEqual(0)
  })

  it('downloads from the release asset name, not a label, as a string', () => {
    // The asset's NAME forms a GitHub download URL; a `#label` only changes
    // what the release page shows. A URL built from a label is a 404.
    expect(typeof PACK_URL).toBe('string')
    expect(PACK_URL).toBe(
      `https://github.com/Cribl-Community/cc-gigamon-ami/releases/download/gigamon-pack-v${PACK_VERSION}/cc-network-gigamon-ami-${PACK_VERSION}.crbl`,
    )
    expect(packAssetName(PACK_VERSION)).toBe(`${manifest.name}-${PACK_VERSION}.crbl`)
  })

  it('has a sha256 pin exactly when its release is recorded as published', () => {
    // No release of PACK_VERSION exists yet, so there are no bytes to pin. The
    // two constants move together: a pin without a release, or a release
    // without a pin, fails here.
    expect(PACK_SHA256 === null).toBe(!PACK_PUBLISHED)
    if (PACK_SHA256 !== null) expect(PACK_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses a tag the app\'s marketplace release can never match', () => {
    // release.yml publishes the APP on any tag matching `v*`.
    expect(packTag(PACK_VERSION).startsWith('v')).toBe(false)
  })
})

describe('the pack release workflow cannot publish, hijack or break the app release', () => {
  const text = readFileSync(join(ROOT, '.github', 'workflows', 'pack-release.yml'), 'utf8')
  const wf = parse(text) as { on: Obj }
  // Comments state the rules in prose; only the executable lines are checked.
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

  it('runs on gigamon-pack-v* tags and nothing else', () => {
    expect(wf.on).toEqual({ push: { tags: ['gigamon-pack-v*'] } })
  })

  it('never packages or versions the app, never touches v* or latest tags, never reaches the Dispensary', () => {
    expect(code).not.toMatch(/npm run package|scripts\/package\.mjs|prepare-git-pack/)
    expect(code).not.toMatch(/git (tag|push)/)
    expect(code).not.toMatch(/DISPENSARY|PACKS_API_TOKEN/i)
    expect(code).toMatch(/git diff --exit-code -- package\.json package-lock\.json/)
  })

  it('creates a non-Latest release, never replaces an asset, and reads the URL back', () => {
    expect(code).toMatch(/gh release create[^\n]*\\\n(\s+--[^\n]*\\\n)*\s+--latest=false/)
    expect(code).not.toMatch(/--clobber|gh release upload|make_latest|softprops/)
    expect(code).toMatch(/browser_download_url/)
    expect(code).toMatch(/pack\.mjs build --expect-version/)
  })

  it('creates the release as a draft, verifies the asset, and only then publishes it', () => {
    expect(code).toMatch(/gh release create[^\n]*\\\n(\s+--[^\n]*\\\n)*\s+--draft \\\n/)
    const create = code.indexOf('gh release create')
    const download = code.indexOf('gh release download "$GITHUB_REF_NAME"')
    const compare = code.indexOf('if [ "$WANT" != "$GOT" ]')
    const publish = code.indexOf('gh release edit "$GITHUB_REF_NAME" --draft=false --latest=false')
    expect(create).toBeGreaterThan(-1)
    expect(download).toBeGreaterThan(create)
    expect(compare).toBeGreaterThan(download)
    expect(publish).toBeGreaterThan(compare)
    // A mismatch deletes the draft (never the tag) and stops: nothing is published.
    const mismatch = code.slice(compare, publish)
    expect(mismatch).toMatch(/gh release delete "\$GITHUB_REF_NAME" --yes/)
    expect(mismatch).not.toMatch(/--cleanup-tag/)
    expect(mismatch).toMatch(/exit 1/)
  })

  it('refuses a tag whose commit is not on main, before building anything', () => {
    const fetch = code.indexOf('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main')
    const guard = code.indexOf('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')
    expect(fetch).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(fetch)
    expect(guard).toBeLessThan(code.indexOf('pack.mjs build'))
    // A depth-1 checkout has no history for merge-base to walk.
    expect(code).toMatch(/fetch-depth: 0/)
  })
})
