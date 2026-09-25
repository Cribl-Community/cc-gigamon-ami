/// <reference types="vite/client" />
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
//     at gigamon_ami_pq, and `onBackpressure: drop` so it cannot stall the JSON
//     feed. Its schema mode is automatic, decided 2026-09-24 (pack.ts
//     `PACK_DECISIONS`).
//   - the breaker's rule name and description are the pack's own: the global
//     description is provision.ts's ownership stamp.
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
  DATASET_SPEC, PARQUET_DATASET_SPEC,
} from './provision'
import { DEFAULT_PROFILE, destinationSpec, pathFilterRows, type LandingProfile } from './landing'
import {
  PACK_ID, PACK_VERSION, PACK_URL, packTag, packAssetName,
  PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID, PACK_BREAKER_ID, PACK_PIPELINE_ID,
  PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_SAMPLE_ROUTE_ID,
  PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID, PACK_SAMPLE_OUTPUT_ID,
  PACK_LAKE_DATASET_ID, PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID,
  PACK_HTTP_PLACEHOLDER_PORT, PACK_CLOUD_PORT_RANGE,
  SAMPLE_ORIGIN_FIELD, SAMPLE_ORIGIN_VALUE, REPLACED_BY_PACK, KEPT_BESIDE_PACK,
  PACK_SHA256, PACK_PUBLISHED, PACK_PUBLISHED_VERSIONS, packReleaseUrl, PACK_ROUTES_FILE, PACK_BREAKERS_FILE, PACK_PENDING, PACK_DECISIONS, PACK_0_1_0,
  PACK_DATASETS_NOT_CREATED, packRelease,
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

describe('the pack breaker is HTTP_BREAKER_SPEC under the pack\'s own names', () => {
  const pack = breakers[PACK_BREAKER_ID] as { description: string; rules: Obj[] }

  it('equals the global ruleset value for value, but for its id, its rule names and its description', () => {
    expect(Object.keys(breakers)).toEqual([PACK_BREAKER_ID])
    expect(without(pack as unknown as Obj, 'description', 'rules')).toEqual(without(HTTP_BREAKER_SPEC, 'id', 'description', 'rules'))
    expect(pack.rules.map((r) => without(r, 'name'))).toEqual(HTTP_BREAKER_SPEC.rules.map((r) => without(r, 'name')))
  })

  it('names its rule for the pack, not after the global ruleset', () => {
    // An operator reading the pack in the UI would otherwise see the global
    // ruleset's id inside it.
    const globalNames = new Set<string>([HTTP_BREAKER_ID, ...HTTP_BREAKER_SPEC.rules.map((r) => r.name)])
    for (const r of pack.rules) expect(globalNames.has(r.name as string)).toBe(false)
  })

  it('does not carry the description provision.ts reads as its ownership stamp', () => {
    // stampedBreaker() treats HTTP_BREAKER_SPEC.description as "this app wrote
    // it". A pack ruleset listed beside the global one must never pass that test.
    expect(pack.description).not.toBe(HTTP_BREAKER_SPEC.description)
    expect(pack.description.trim()).not.toBe('')
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

  it('the Parquet destination is the same profile as Parquet, pointed at gigamon_ami_pq, and drops rather than blocks', () => {
    // The one documented difference. Both Lake destinations are fed by the one
    // HTTP input; a blocked Parquet writer (gigamon_ami_pq not created yet, or
    // a schema change it cannot write) would push back on that input and stop
    // the JSON feed every dashboard reads. The Parquet copy loses events
    // instead. UNMEASURED: the proof install has to show it.
    expect(outputs[PACK_PARQUET_OUTPUT_ID]).toEqual({ ...lakeOutput(PACK_PARQUET_DATASET_ID, 'parquet'), onBackpressure: 'drop' })
    expect((lakeOutput(PACK_PARQUET_DATASET_ID, 'parquet') as Obj).onBackpressure).toBe('block')
    expect(outputs[PACK_JSON_OUTPUT_ID].onBackpressure).toBe('block')
    expect(outputs[PACK_PARQUET_OUTPUT_ID].format).toBe('parquet')
    // DECIDED 2026-09-24 (PACK_DECISIONS.parquet_schema_mode): automatic, and
    // no explicit parquetSchema beside it.
    expect(outputs[PACK_PARQUET_OUTPUT_ID].automaticSchema).toBe(true)
    expect(outputs[PACK_PARQUET_OUTPUT_ID]).not.toHaveProperty('parquetSchema')
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

describe('the Parquet dataset the onboarding run is to create', () => {
  it('is the dataset the Parquet destination writes to', () => {
    expect(PARQUET_DATASET_SPEC.id).toBe(PACK_PARQUET_DATASET_ID)
    expect(outputs[PACK_PARQUET_OUTPUT_ID].destPath).toBe(PARQUET_DATASET_SPEC.id)
  })

  it('is Parquet with NO partition fields: the key is absent, not an empty list', () => {
    // DECIDED 2026-09-24 (PACK_DECISIONS.parquet_partitions). acceleratedFields
    // is honoured only at creation, so this body is the whole of that decision.
    expect(PARQUET_DATASET_SPEC.format).toBe('parquet')
    expect(PARQUET_DATASET_SPEC).not.toHaveProperty('acceleratedFields')
  })

  it('keeps the default retention of gigamon_ami, and reads Parquet objects on Search v2', () => {
    expect(PARQUET_DATASET_SPEC.retentionPeriodInDays).toBe(DEFAULT_PROFILE.retentionDays)
    expect(PARQUET_DATASET_SPEC.retentionPeriodInDays).toBe(DATASET_SPEC.retentionPeriodInDays)
    expect(PARQUET_DATASET_SPEC.searchConfig).toEqual({ searchVersion: 'v2', pathFilters: pathFilterRows(['parquet']) })
  })

  it('is exactly those keys, with a description of its own', () => {
    expect(Object.keys(PARQUET_DATASET_SPEC).sort()).toEqual(['description', 'format', 'id', 'retentionPeriodInDays', 'searchConfig'])
    expect(typeof PARQUET_DATASET_SPEC.description).toBe('string')
    expect(PARQUET_DATASET_SPEC.description).not.toBe(DATASET_SPEC.description)
  })

  it('cannot be mutated by a caller', () => {
    expect(Object.isFrozen(PARQUET_DATASET_SPEC)).toBe(true)
    expect(Object.isFrozen(PARQUET_DATASET_SPEC.searchConfig)).toBe(true)
  })
})

describe('the 0.2.0 decisions are taken', () => {
  it('nothing is PENDING', () => {
    expect(PACK_PENDING).toEqual({})
  })

  it('each former PENDING entry is recorded as a decision with its evidence', () => {
    expect(Object.keys(PACK_DECISIONS).sort()).toEqual(['parquet_partitions', 'parquet_schema_mode'])
    for (const why of Object.values(PACK_DECISIONS)) {
      expect(why).toMatch(/2026-09-24/)
      expect(why).not.toMatch(/PENDING/)
    }
  })
})

describe('the pack says which datasets the app creates, and the code agrees', () => {
  // The README ships inside the .crbl, so a sentence in it is frozen into every
  // tenant that installs the release. "The app creates them" was written while
  // only gigamon_ami had a creator.
  const SRC = join(ROOT, 'src')
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
  })
  // Comment lines dropped: pack.ts names the spec in prose, which creates nothing.
  const uncommented = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
  const code = sources(SRC).map((p) => ({ p, s: uncommented(readFileSync(p, 'utf8')) }))

  /**
   * Every mention of ensureLakeDataset in code that is not its definition, a
   * direct call (the scan below reads those) or a plain named import: an alias
   * (`import { ensureLakeDataset as ensure }`, `export { … as … }`) or a call by
   * reference (`specs.map(ensureLakeDataset)`) would let a second creator in
   * without an `ensureLakeDataset(` for the call scan to find. String literals
   * are blanked first — authz.ts and paths.ts name the site in prose.
   */
  function bareReferences(files: { p: string; s: string }[]): string[] {
    const out: string[] = []
    for (const { p, s } of files) {
      const noStrings = s.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      if (/\bensureLakeDataset\s+as\b/.test(noStrings)) out.push(`${p}: aliased`)
      const noImports = noStrings.replace(/\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*''/g, '')
      for (const m of noImports.matchAll(/\bensureLakeDataset\b/g)) {
        const at = m.index ?? 0
        if (noImports.slice(Math.max(0, at - 9), at) === 'function ') continue
        if (/^\s*\(/.test(noImports.slice(at + 'ensureLakeDataset'.length))) continue
        out.push(`${p}: ${noImports.slice(at, at + 40).split('\n')[0]}`)
      }
    }
    return out
  }

  it('the guard against a second creator sees an alias and a call by reference', () => {
    expect(bareReferences([{ p: 'x.ts', s: "import { ensureLakeDataset as ensure } from './provision'\nensure(SPEC)" }])).not.toEqual([])
    expect(bareReferences([{ p: 'x.ts', s: "import { ensureLakeDataset } from './provision'\nawait Promise.all(specs.map(ensureLakeDataset))" }])).not.toEqual([])
    expect(bareReferences([{ p: 'x.ts', s: "export { ensureLakeDataset as ensure } from './provision'" }])).not.toEqual([])
    expect(bareReferences([{ p: 'x.ts', s: "import {\n  capi,\n  ensureLakeDataset,\n} from './provision'\nawait ensureLakeDataset(SPEC)" }])).toEqual([])
    expect(bareReferences([{ p: 'x.ts', s: "  at: 'cribl/provision.ts#ensureLakeDataset',\nexport async function ensureLakeDataset(" }])).toEqual([])
  })

  it('the one dataset POST in src is ensureLakeDataset, and its only caller creates gigamon_ami', () => {
    // A second creator (the onboarding run calling ensureLakeDataset with the
    // Parquet or the sample spec) fails this until PACK_DATASETS_NOT_CREATED
    // and the pack text are changed with it. Naming a spec is not creating it:
    // the onboarding plan names both, and nothing calls it yet.
    const posts = code.flatMap(({ p, s }) => [...s.matchAll(/capi\('POST', datasetsPath, (\w+)\)/g)].map((m) => ({ p, body: m[1] })))
    expect(posts).toHaveLength(1)
    expect(posts[0].p.endsWith(join('cribl', 'provision.ts'))).toBe(true)
    const callers = code.flatMap(({ p, s }) =>
      [...s.matchAll(/(?<!function )\bensureLakeDataset\(([^\n,]*)/g)].map((m) => ({ p, arg: m[1].trim() })))
    expect(callers, 'ensureLakeDataset has a new caller: take what it creates out of PACK_DATASETS_NOT_CREATED').toEqual([
      { p: expect.stringMatching(/cribl[\\/]provision\.ts$/), arg: 'datasetSpec(ctx.profile) as LakeDatasetSpec' },
    ])
    expect(DATASET_SPEC.id).toBe(PACK_LAKE_DATASET_ID)
    expect(bareReferences(code), 'ensureLakeDataset is reached some way the call scan above cannot see').toEqual([])
    expect([...PACK_DATASETS_NOT_CREATED].sort()).toEqual([PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID].sort())
  })

  it('no pack file says the app creates a dataset it does not', () => {
    for (const f of ['README.md', 'default/outputs.yml']) {
      expect(text(f)).not.toMatch(/the app creates (them|this one|each)|which the app creates/i)
    }
  })

  it('the README names each dataset nothing creates yet, and what happens until something does', () => {
    const para = text('README.md').split(/\r?\n\r?\n/).find((b) => /No release of the app creates/.test(b)) ?? ''
    // The sentence itself, not the paragraph: a later clause may name an id too.
    const which = /No release of the app creates ([^.]*) yet\./.exec(para)?.[1] ?? ''
    for (const id of PACK_DATASETS_NOT_CREATED) expect(which).toContain(`\`${id}\``)
    expect(which).not.toContain(`\`${PACK_LAKE_DATASET_ID}\``)
    expect(para).toMatch(/drops/)
    expect(para).toMatch(/refuses to start the sample source/)
    const yml = text('default/outputs.yml')
    for (const id of PACK_DATASETS_NOT_CREATED) expect(yml).toMatch(new RegExp(`nothing creates[^.]*${id}[^.]*yet`, 's'))
  })
})

describe('the decisions say the same thing in pack.ts, the README and default/outputs.yml', () => {
  // The evidence is written three times. Edit one figure in one place and every
  // other test stays green; this is what makes the three copies one.
  const FIGURES: Readonly<Record<keyof typeof PACK_DECISIONS & string, readonly string[]>> = {
    parquet_schema_mode: ['2026-09-24', 'automaticSchema: true', '""', 'INT64'],
    parquet_partitions: ['2026-09-24', 'protocol=6', '63,249', '2.69 MB', '172%', '197%'],
  }

  it('covers every decision', () => {
    expect(Object.keys(FIGURES).sort()).toEqual(Object.keys(PACK_DECISIONS).sort())
  })

  for (const [key, figures] of Object.entries(FIGURES)) {
    it(`${key}: every figure is in all three`, () => {
      for (const fig of figures) {
        expect(PACK_DECISIONS[key], `PACK_DECISIONS.${key}`).toContain(fig)
        expect(text('README.md'), 'README.md').toContain(fig)
        expect(text('default/outputs.yml'), 'default/outputs.yml').toContain(fig)
      }
    })
  }
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

  it('a pack release tag cannot pass this suite while anything is PENDING', () => {
    // PACK_PUBLISHED is still false when a gigamon-pack-v* tag is pushed (it is
    // set in a later PR), so the test above never fires at release. This one
    // does: pack-release.yml runs this file, and GitHub sets GITHUB_REF_NAME to
    // the tag. scripts/pack.mjs refuses the same thing under --expect-version.
    const ref = process.env.GITHUB_REF_NAME ?? ''
    if (ref.startsWith('gigamon-pack-v')) {
      expect(Object.keys(PACK_PENDING)).toEqual([])
      for (const p of places) expect(text(p)).not.toMatch(/PENDING/)
    }
  })
})

describe('the published 0.1.0 pack is still named', () => {
  // 0.1.0 was released (gigamon-pack-v0.1.0, 2026-09-24) with a syslog input.
  // A tenant that installed it can upgrade in place to 0.2.0, and whatever the
  // upgrade leaves under the pack's local/ (a port override on in_gno_syslog,
  // say) is findable only by these ids. They are literals on purpose: they
  // describe bytes already published, which no later edit can change.
  it('records every object id the 0.1.0 release shipped, as published', () => {
    expect(PACK_0_1_0).toEqual({
      version: '0.1.0',
      tag: 'gigamon-pack-v0.1.0',
      publishedAt: '2026-09-24T16:00:09Z',
      sha256: '1fff07438e1974853ec9dfbbf570d8afad1136a3453741aeec7acae08af178ca',
      inputs: { syslog: 'in_gno_syslog', sample: 'in_gno_sample' },
      pipelines: { syslog: 'gno_syslog', sample: 'gno_sample' },
      routes: { syslog: 'gno_syslog', sample: 'gno_sample' },
      outputs: { lake: 'out_gno_lake', sample: 'out_gno_sample_lake' },
      samples: ['gno_dns', 'gno_security', 'gno_services', 'gno_tls_apps', 'gno_web_api'],
      sampleOriginField: 'gno_origin',
      paths: [
        { route: 'gno_syslog', input: 'syslog:in_gno_syslog', pipeline: 'gno_syslog', output: 'cribl_lake:out_gno_lake', dataset: 'gigamon_ami' },
        { route: 'gno_sample', input: 'datagen:in_gno_sample', pipeline: 'gno_sample', output: 'cribl_lake:out_gno_sample_lake', dataset: 'gigamon_ami_sample' },
      ],
    })
    expect(Object.isFrozen(PACK_0_1_0)).toBe(true)
    expect(Object.isFrozen(PACK_0_1_0.paths[0])).toBe(true)
    expect(packTag(PACK_0_1_0.version)).toBe(PACK_0_1_0.tag)
  })

  it('shares no object id with 0.2.0, so an upgrade\'s leftovers are told apart by id alone', () => {
    const old = [
      ...Object.values(PACK_0_1_0.inputs), ...Object.values(PACK_0_1_0.pipelines), ...Object.values(PACK_0_1_0.routes),
      ...Object.values(PACK_0_1_0.outputs), ...PACK_0_1_0.samples,
    ]
    const current = new Set([
      ...Object.keys(inputs), ...Object.keys(outputs), ...routes.map((r) => r.id as string),
      ...pipelineDirs(), ...Object.keys(breakers), ...Object.keys(samples),
    ])
    expect(old.filter((id) => current.has(id))).toEqual([])
  })

  it('is not the version this build installs', () => {
    expect(PACK_0_1_0.version).not.toBe(PACK_VERSION)
  })
})

// main's src/queries/stackIds.ts lists a `pack-0.1.0` stack that was built
// from constants this branch gives 0.2.0 values (PACK_SAMPLE_ROUTE_ID,
// PACK_SAMPLE_INPUT_ID, PACK_SAMPLE_OUTPUT_ID, PACK_PUBLISHED). A merge that
// fixed only the removed names still compiled, and the 0.1.0 row silently
// showed 0.2.0 ids. This holds both stacks to what was shipped. It was skipped
// until the merge brought the file; it is not skippable now, because a glob
// that stops matching (a rename, a move) would otherwise switch it off quietly.
interface MergedStack { key: string; status: string; paths: readonly Obj[] }
const stackIdsModule = Object.values(
  import.meta.glob<{ STACKS: readonly MergedStack[] }>('../queries/stackIds.ts', { eager: true }),
)[0]

describe('Data Flow\'s stack list names each pack release\'s own ids', () => {
  it('is there to check', () => {
    expect(stackIdsModule, 'src/queries/stackIds.ts moved or was renamed; point the glob above at it').toBeDefined()
  })

  const stack = (key: string) => stackIdsModule!.STACKS.find((s) => s.key === key)

  it('pack-0.1.0 is the published 0.1.0 ids, released', () => {
    expect(stack('pack-0.1.0')?.status).toBe('released')
    expect(stack('pack-0.1.0')?.paths).toEqual(PACK_0_1_0.paths)
  })

  it('pack-0.2.0 is this build\'s pack ids', () => {
    expect(stack('pack-0.2.0')?.status).toBe(PACK_PUBLISHED ? 'released' : 'unreleased')
    expect(stack('pack-0.2.0')?.paths).toEqual([
      { route: PACK_HTTP_JSON_ROUTE_ID, input: `http_raw:${PACK_HTTP_INPUT_ID}`, pipeline: PACK_PIPELINE_ID, output: `cribl_lake:${PACK_JSON_OUTPUT_ID}`, dataset: PACK_LAKE_DATASET_ID },
      { route: PACK_HTTP_PARQUET_ROUTE_ID, input: `http_raw:${PACK_HTTP_INPUT_ID}`, pipeline: PACK_PIPELINE_ID, output: `cribl_lake:${PACK_PARQUET_OUTPUT_ID}`, dataset: PACK_PARQUET_DATASET_ID },
      { route: PACK_SAMPLE_ROUTE_ID, input: `datagen:${PACK_SAMPLE_INPUT_ID}`, pipeline: PACK_PIPELINE_ID, output: `cribl_lake:${PACK_SAMPLE_OUTPUT_ID}`, dataset: PACK_SAMPLE_DATASET_ID },
    ])
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

  it('keeps every version it ever released on PACK_PUBLISHED_VERSIONS, and PACK_VERSION exactly when it is released', () => {
    // APPEND to EVER_RELEASED when a release is published; never remove from
    // it. A version missing from the list is "not published" to every tenant
    // running it: packClient.ts's Remove keeps it and its Upgrade refuses it.
    const EVER_RELEASED = ['0.1.0']
    for (const v of EVER_RELEASED) expect(PACK_PUBLISHED_VERSIONS, `${v} was released and has left the list`).toContain(v)
    expect(PACK_PUBLISHED_VERSIONS).toContain(PACK_0_1_0.version)
    expect(PACK_PUBLISHED_VERSIONS.includes(PACK_VERSION)).toBe(PACK_PUBLISHED)
    expect(new Set(PACK_PUBLISHED_VERSIONS).size).toBe(PACK_PUBLISHED_VERSIONS.length)
    for (const v of PACK_PUBLISHED_VERSIONS) expect(cmp(v, PACK_VERSION)).toBeLessThanOrEqual(0)
    expect(Object.isFrozen(PACK_PUBLISHED_VERSIONS)).toBe(true)
  })

  it('names each version’s release asset the way PACK_URL does', () => {
    expect(packReleaseUrl(PACK_VERSION)).toBe(PACK_URL)
    // Read from the published release (gh release view gigamon-pack-v0.1.0), 2026-09-24.
    expect(packReleaseUrl('0.1.0')).toBe(
      'https://github.com/Cribl-Community/cc-gigamon-ami/releases/download/gigamon-pack-v0.1.0/cc-network-gigamon-ami-0.1.0.crbl',
    )
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

// Whether this build may install its pinned pack, as a pure answer the UI can
// read without importing the pack client (which nothing on screen may reach
// until its grants are declared). packClient.ts's `installRefusal` is this
// function bound to the constants it imports, so the two cannot disagree.
describe('packRelease — the pinned release, and why it cannot be installed', () => {
  it('refuses today: 0.2.0 has no release', () => {
    const r = packRelease()
    expect(r).toMatchObject({ version: PACK_VERSION, url: PACK_URL, published: PACK_PUBLISHED, sha256: PACK_SHA256 })
    expect(r.refusal).toMatch(/has not been released/)
    expect(r.installable).toBe(false)
  })

  it('refuses a release with no sha256, or one that is not 64 lowercase hex characters', () => {
    expect(packRelease({ published: true, sha256: null, version: '9.9.9' }).refusal).toMatch(/no recorded sha256/)
    for (const sha of ['x', 'ab'.repeat(31), 'AB'.repeat(32), `${'ab'.repeat(32)} `]) {
      expect(packRelease({ published: true, sha256: sha, version: '9.9.9' }).refusal, sha).toMatch(/sha256/)
    }
  })

  it('opens only on a published version with a well-formed digest, and names that version’s URL', () => {
    const r = packRelease({ published: true, sha256: 'ab'.repeat(32), version: '9.9.9' })
    expect(r.refusal).toBeNull()
    expect(r.installable).toBe(true)
    expect(r.url).toBe(packReleaseUrl('9.9.9'))
  })

  it('never says how the gate is built — no internal names in the sentence a customer reads', () => {
    for (const r of [packRelease(), packRelease({ published: true, sha256: null, version: '9.9.9' })]) {
      expect(r.refusal).not.toMatch(/PACK_|sha256_shape|packClient|\bspike\b|Phase \d/)
    }
  })
})
