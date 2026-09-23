// The pack's YAML against the app's TypeScript specs, value for value.
//
// The pack under packs/cc-network-gigamon-ami/ is a second copy of objects the
// app already describes in TypeScript: provision.ts's PIPELINE_SPEC,
// SOURCE_SPEC and ROUTE_SPEC, and the Lake destination landing.ts builds from
// DEFAULT_PROFILE. provision.ts says in as many words that one copy of those
// numbers was the whole point of landing.ts. This file is what makes the second
// copy safe: change either side alone and it fails.
//
// Ids are the one deliberate difference. Every pack object has a `gno_` id so
// nothing collides with the live global objects; src/cribl/pack.ts records
// them, and this file checks the YAML uses exactly those.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, it, expect } from 'vitest'
import { PIPELINE_SPEC, SOURCE_SPEC, ROUTE_SPEC, destinationSpecFor } from './provision'
import { DEFAULT_PROFILE, destinationSpec } from './landing'
import {
  PACK_ID, PACK_VERSION, PACK_URL, packTag, packAssetName,
  PACK_SYSLOG_INPUT_ID, PACK_SAMPLE_INPUT_ID, PACK_SYSLOG_PIPELINE_ID, PACK_SAMPLE_PIPELINE_ID,
  PACK_SYSLOG_ROUTE_ID, PACK_SAMPLE_ROUTE_ID, PACK_LAKE_OUTPUT_ID, PACK_SAMPLE_OUTPUT_ID,
  PACK_LAKE_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SYSLOG_PLACEHOLDER_PORT, CLOUD_SYSLOG_PORT_RANGE,
  SAMPLE_ORIGIN_FIELD, SAMPLE_ORIGIN_VALUE, GLOBAL_TO_PACK,
} from './pack'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACK_DIR = join(ROOT, 'packs', PACK_ID)
const yml = (rel: string) => parse(readFileSync(join(PACK_DIR, rel), 'utf8'))

type Obj = Record<string, unknown>
const without = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

const inputs = yml('default/inputs.yml').inputs as Record<string, Obj>
const outputs = yml('default/outputs.yml').outputs as Record<string, Obj>
const routes = yml('default/routes.yml').routes as Obj[]
const pipeline = (id: string) => yml(`default/pipelines/${id}/conf.yml`) as { functions: unknown[] }

describe('the pack pipelines are provision.ts\'s PIPELINE_SPEC', () => {
  it('gno_syslog carries all four functions, value for value', () => {
    expect(pipeline(PACK_SYSLOG_PIPELINE_ID).functions).toEqual(PIPELINE_SPEC.conf.functions)
  })

  it('gno_sample carries only the cast and derive functions, value for value', () => {
    // The DataGen's events are already objects, so there is no syslog message
    // to take apart: the prep and parse steps would only add a `message` copy.
    const castAndDerive = PIPELINE_SPEC.conf.functions.slice(2)
    expect(castAndDerive.map((f) => f.description)).toEqual(['Cast numeric strings', 'Derive helper fields'])
    expect(pipeline(PACK_SAMPLE_PIPELINE_ID).functions).toEqual(castAndDerive)
  })

  it('ships exactly those two pipelines', () => {
    expect(readdirSync(join(PACK_DIR, 'default', 'pipelines')).sort()).toEqual([PACK_SAMPLE_PIPELINE_ID, PACK_SYSLOG_PIPELINE_ID].sort())
  })
})

describe('the pack syslog source is provision.ts\'s SOURCE_SPEC', () => {
  const src = inputs[PACK_SYSLOG_INPUT_ID]

  it('matches every field but the id and the port', () => {
    expect(without(src, 'tcpPort', 'udpPort')).toEqual(without(SOURCE_SPEC, 'id', 'tcpPort', 'udpPort'))
  })

  it('ships a placeholder port a Cribl-managed group exposes, the same for TCP and UDP', () => {
    expect(src.tcpPort).toBe(PACK_SYSLOG_PLACEHOLDER_PORT)
    expect(src.udpPort).toBe(PACK_SYSLOG_PLACEHOLDER_PORT)
    expect(PACK_SYSLOG_PLACEHOLDER_PORT).toBeGreaterThanOrEqual(CLOUD_SYSLOG_PORT_RANGE.min)
    expect(PACK_SYSLOG_PLACEHOLDER_PORT).toBeLessThanOrEqual(CLOUD_SYSLOG_PORT_RANGE.max)
    // Not the global stack's 5514, which a Cloud tenant's exporter cannot reach.
    expect(PACK_SYSLOG_PLACEHOLDER_PORT).not.toBe(SOURCE_SPEC.tcpPort)
  })
})

describe('the sample DataGen', () => {
  const gen = inputs[PACK_SAMPLE_INPUT_ID]

  it('ships disabled, and tags every event as sample data', () => {
    expect(gen.type).toBe('datagen')
    expect(gen.disabled).toBe(true)
    // `metadata` values are JS expressions, so the literal carries its own quotes.
    expect(gen.metadata).toEqual([{ name: SAMPLE_ORIGIN_FIELD, value: `'${SAMPLE_ORIGIN_VALUE}'` }])
  })

  it('replays every sample samples.yml declares', () => {
    const declared = Object.keys(yml('default/samples.yml') as Obj)
    expect((gen.samples as { sample: string }[]).map((s) => s.sample).sort()).toEqual(declared.sort())
  })
})

describe('the pack Lake destinations are destinationSpecFor(DEFAULT_PROFILE)', () => {
  it('out_gno_lake is the app\'s own destination body under the pack id', () => {
    expect({ id: PACK_LAKE_OUTPUT_ID, ...outputs[PACK_LAKE_OUTPUT_ID] }).toEqual({ ...destinationSpecFor(DEFAULT_PROFILE), id: PACK_LAKE_OUTPUT_ID })
    expect(outputs[PACK_LAKE_OUTPUT_ID].destPath).toBe(PACK_LAKE_DATASET_ID)
  })

  it('out_gno_sample_lake is the same profile pointed at the sample dataset', () => {
    const profile = { ...DEFAULT_PROFILE, datasetId: PACK_SAMPLE_DATASET_ID }
    expect(outputs[PACK_SAMPLE_OUTPUT_ID]).toEqual({ type: 'cribl_lake', ...destinationSpec(profile).set })
  })

  it('never lets sample data reach the customer\'s dataset', () => {
    expect(PACK_SAMPLE_DATASET_ID).not.toBe(PACK_LAKE_DATASET_ID)
    const sampleRoute = routes.find((r) => r.id === PACK_SAMPLE_ROUTE_ID)!
    expect(outputs[sampleRoute.output as string].destPath).toBe(PACK_SAMPLE_DATASET_ID)
  })
})

describe('the pack routes', () => {
  it('the syslog route is ROUTE_SPEC with the pack\'s ids', () => {
    const route = routes.find((r) => r.id === PACK_SYSLOG_ROUTE_ID)!
    expect(without(route, 'id', 'name', 'filter', 'pipeline', 'output')).toEqual(without(ROUTE_SPEC, 'id', 'name', 'filter', 'pipeline', 'output'))
    expect(route).toMatchObject({
      name: PACK_SYSLOG_ROUTE_ID,
      filter: `__inputId=='syslog:${PACK_SYSLOG_INPUT_ID}'`,
      pipeline: PACK_SYSLOG_PIPELINE_ID,
      output: PACK_LAKE_OUTPUT_ID,
    })
  })

  it('the sample route sends the DataGen to the sample destination', () => {
    expect(routes.find((r) => r.id === PACK_SAMPLE_ROUTE_ID)).toMatchObject({
      name: PACK_SAMPLE_ROUTE_ID,
      final: true,
      disabled: false,
      filter: `__inputId=='datagen:${PACK_SAMPLE_INPUT_ID}'`,
      pipeline: PACK_SAMPLE_PIPELINE_ID,
      output: PACK_SAMPLE_OUTPUT_ID,
    })
    expect(routes).toHaveLength(2)
  })
})

describe('pack ids never collide with the live global objects', () => {
  const packIds = [
    ...Object.keys(inputs), ...Object.keys(outputs), ...routes.map((r) => r.id as string),
    ...readdirSync(join(PACK_DIR, 'default', 'pipelines')),
  ]

  it('no pack object reuses a global id', () => {
    const globals = new Set(Object.keys(GLOBAL_TO_PACK))
    expect(packIds.filter((id) => globals.has(id))).toEqual([])
    // Nor the ids provision.ts creates today.
    for (const id of [SOURCE_SPEC.id, PIPELINE_SPEC.id, ROUTE_SPEC.id, destinationSpecFor(DEFAULT_PROFILE).id]) {
      expect(packIds).not.toContain(id)
    }
  })

  it('every id in the mapping names an object the pack actually defines', () => {
    for (const id of Object.values(GLOBAL_TO_PACK)) expect(packIds).toContain(id)
  })

  it('the mapping\'s keys are the global stack\'s ids', () => {
    expect(Object.keys(GLOBAL_TO_PACK)).toEqual(expect.arrayContaining([SOURCE_SPEC.id, PIPELINE_SPEC.id, ROUTE_SPEC.id, destinationSpecFor(DEFAULT_PROFILE).id]))
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
})
