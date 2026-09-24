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
//
// ── THE 0.1.0 SYSLOG OBJECTS ARE PINNED HERE, NOT READ FROM provision.ts ─────
//
// Guided Setup moved from Syslog to Raw HTTP on 2026-09-24 (stage 12.1), so
// provision.ts's SOURCE_SPEC, PIPELINE_SPEC and ROUTE_SPEC now describe an
// `http_raw` stack. Pack 0.1.0 still ships the Syslog stack, and 0.1.0 is the
// version this app pins: its content must not move because the app's specs
// did. So what the 0.1.0 syslog source, pipeline and route were checked against
// until then is written out below as FROZEN LITERALS — exactly the values
// provision.ts held before the switch — and compared value for value as
// before. Stage 11.7 (pack 0.2.0) re-points these at the HTTP specs. The cast
// and derive functions did not change, so `gno_sample` is still compared with
// the live PIPELINE_SPEC, which is now exactly those two.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, it, expect } from 'vitest'
import {
  PIPELINE_SPEC, SOURCE_SPEC, ROUTE_SPEC, HTTP_BREAKER_SPEC, destinationSpecFor,
  LEGACY_SYSLOG_SOURCE_ID, LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID,
} from './provision'
import { DEFAULT_PROFILE, destinationSpec } from './landing'
import {
  PACK_ID, PACK_VERSION, PACK_URL, packTag, packAssetName,
  PACK_SYSLOG_INPUT_ID, PACK_SAMPLE_INPUT_ID, PACK_SYSLOG_PIPELINE_ID, PACK_SAMPLE_PIPELINE_ID,
  PACK_SYSLOG_ROUTE_ID, PACK_SAMPLE_ROUTE_ID, PACK_LAKE_OUTPUT_ID, PACK_SAMPLE_OUTPUT_ID,
  PACK_LAKE_DATASET_ID, PACK_SAMPLE_DATASET_ID, PACK_SYSLOG_PLACEHOLDER_PORT, CLOUD_SYSLOG_PORT_RANGE,
  SAMPLE_ORIGIN_FIELD, SAMPLE_ORIGIN_VALUE, REPLACED_BY_PACK, KEPT_BESIDE_PACK,
  PACK_SHA256, PACK_PUBLISHED, PACK_ROUTES_FILE,
} from './pack'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACK_DIR = join(ROOT, 'packs', PACK_ID)
const yml = (rel: string) => parse(readFileSync(join(PACK_DIR, rel), 'utf8'))

type Obj = Record<string, unknown>
const without = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

// ── Frozen: the global Syslog specs pack 0.1.0 was built from ───────────────
const V010_NUMERIC_FIELDS = [
  'src_bytes', 'dst_bytes', 'src_packets', 'dst_packets', 'src_port', 'dst_port',
  'protocol', 'app_id', 'ip_version', 'tcp_rtt', 'tcp_rtt_app', 'tcp_dup_ack',
  'tcp_loss_count', 'tcp_wrong_crc', 'tcp_unseq', 'dns_response_time', 'dns_ttl',
  'ssl_mitm_score', 'ssl_request_size', 'snmp_version', 'end_reason', 'seq_num',
  'http_request_ts', 'http_response_ts', 'tcp_flags',
]
const V010_SYSLOG_PORT = 5514
const V010_FUNCTIONS = Object.freeze([
  {
    id: 'eval', filter: 'true', disabled: false, description: 'Fallback to _raw when no syslog MSG',
    conf: { add: [{ name: 'message', value: 'message==null?_raw:message' }] },
  },
  {
    id: 'serde', filter: "typeof message==='string' && message.trim().charAt(0)==='{'", disabled: false,
    description: 'Parse Gigamon AMI JSON from the syslog message',
    conf: { mode: 'extract', type: 'json', srcField: 'message' },
  },
  {
    id: 'eval', filter: 'true', disabled: false, description: 'Cast numeric strings',
    conf: { add: V010_NUMERIC_FIELDS.map((n) => ({ name: n, value: `${n}==null?${n}:Number(${n})` })) },
  },
  {
    id: 'eval', filter: 'true', disabled: false, description: 'Derive helper fields',
    conf: {
      add: [
        { name: 'src_subnet', value: "typeof src_ip==='string'?src_ip.split('.').slice(0,3).join('.'):undefined" },
        { name: 'dst_subnet', value: "typeof dst_ip==='string'?dst_ip.split('.').slice(0,3).join('.'):undefined" },
        { name: 'total_bytes', value: '(src_bytes||0)+(dst_bytes||0)' },
        { name: 'total_packets', value: '(src_packets||0)+(dst_packets||0)' },
        { name: 'l4_proto', value: "({'6':'TCP','17':'UDP','1':'ICMP'})[String(protocol)]||String(protocol)" },
        { name: 'http_server_ms', value: '(http_request_ts!=null&&http_response_ts!=null)?(http_response_ts-http_request_ts)*1000:undefined' },
        { name: 'tcp_reset', value: 'tcp_flags==null?undefined:((tcp_flags&4)?1:0)' },
        { name: 'src_subnet16', value: "typeof src_ip==='string'?src_ip.split('.').slice(0,2).join('.'):undefined" },
        { name: 'dst_subnet16', value: "typeof dst_ip==='string'?dst_ip.split('.').slice(0,2).join('.'):undefined" },
      ],
    },
  },
])
const V010_SOURCE_SPEC = Object.freeze({
  id: 'in_gigamon_syslog',
  type: 'syslog',
  disabled: false,
  host: '0.0.0.0',
  tcpPort: V010_SYSLOG_PORT,
  udpPort: V010_SYSLOG_PORT,
  sendToRoutes: true,
  streamtags: ['gigamon', 'ami'],
})
const V010_ROUTE_SPEC = Object.freeze({
  id: 'gigamon_ami_syslog',
  name: 'gigamon_ami_syslog',
  final: true,
  disabled: false,
  filter: "__inputId=='syslog:in_gigamon_syslog'",
  pipeline: 'gigamon_syslog',
  output: 'gigamon_lake',
  description: 'Gigamon AMI syslog → parse → Cribl Lake (gigamon_ami)',
  clones: [],
  enableOutputExpression: false,
})

describe('the frozen 0.1.0 specs are the Syslog stack provision.ts no longer creates', () => {
  it('name exactly the legacy ids the teardown still removes', () => {
    expect(V010_SOURCE_SPEC.id).toBe(LEGACY_SYSLOG_SOURCE_ID)
    expect(V010_ROUTE_SPEC.pipeline).toBe(LEGACY_SYSLOG_PIPELINE_ID)
    expect(V010_ROUTE_SPEC.id).toBe(LEGACY_SYSLOG_ROUTE_ID)
  })

  it('share their cast and derive functions with today’s pipeline, value for value', () => {
    // The one part of the 0.1.0 pipeline the HTTP stack kept. If this fails,
    // the two feeds no longer produce rows of one shape.
    expect(V010_FUNCTIONS.slice(2)).toEqual(PIPELINE_SPEC.conf.functions)
  })
})

const inputs = yml('default/inputs.yml').inputs as Record<string, Obj>
const outputs = yml('default/outputs.yml').outputs as Record<string, Obj>
const routes = yml(PACK_ROUTES_FILE).routes as Obj[]
const pipeline = (id: string) => yml(`default/pipelines/${id}/conf.yml`) as { functions: unknown[] }
/** The pipeline directories: `default/pipelines/` also holds the pack's route.yml. */
const pipelineDirs = () => readdirSync(join(PACK_DIR, 'default', 'pipelines'), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name)

describe('the pack routes file is where Cribl reads a pack\'s routes', () => {
  it('is default/pipelines/route.yml, and default/routes.yml does not exist', () => {
    // Measured on a Leader: every bundled pack keeps <pack>/default/pipelines/route.yml,
    // and no file named routes.yml exists anywhere. A routes file anywhere else
    // is not read, so the pack would install with no routes at all.
    expect(PACK_ROUTES_FILE).toBe('default/pipelines/route.yml')
    expect(existsSync(join(PACK_DIR, 'default', 'routes.yml'))).toBe(false)
  })
})

describe('the pack pipelines are the frozen 0.1.0 functions', () => {
  it('gno_syslog carries all four functions, value for value', () => {
    expect(pipeline(PACK_SYSLOG_PIPELINE_ID).functions).toEqual(V010_FUNCTIONS)
  })

  it('gno_sample carries only the cast and derive functions — provision.ts\'s PIPELINE_SPEC, value for value', () => {
    // The DataGen's events are already objects, so there is no syslog message
    // to take apart. Since the move to Raw HTTP the global pipeline is exactly
    // these two as well: the breaker extracts the fields before it runs.
    const castAndDerive = PIPELINE_SPEC.conf.functions
    expect(castAndDerive.map((f) => f.description)).toEqual(['Cast numeric strings', 'Derive helper fields'])
    expect(pipeline(PACK_SAMPLE_PIPELINE_ID).functions).toEqual(castAndDerive)
  })

  it('ships exactly those two pipelines', () => {
    expect(pipelineDirs().sort()).toEqual([PACK_SAMPLE_PIPELINE_ID, PACK_SYSLOG_PIPELINE_ID].sort())
  })
})

describe('the pack syslog source is the frozen 0.1.0 SOURCE_SPEC', () => {
  const src = inputs[PACK_SYSLOG_INPUT_ID]

  it('matches every field but the id, the port and `disabled`', () => {
    expect(without(src, 'tcpPort', 'udpPort', 'disabled')).toEqual(without(V010_SOURCE_SPEC, 'id', 'tcpPort', 'udpPort', 'disabled'))
  })

  it('ships disabled, unlike the global source', () => {
    // A Cloud port in 20000-20010 is reachable from the internet and takes
    // unauthenticated syslog. The input is enabled only after the user confirms
    // a port in Guided Setup; until then nothing listens.
    expect(src.disabled).toBe(true)
    expect(V010_SOURCE_SPEC.disabled).toBe(false)
  })

  it('ships a placeholder port a Cribl-managed group exposes, the same for TCP and UDP', () => {
    expect(src.tcpPort).toBe(PACK_SYSLOG_PLACEHOLDER_PORT)
    expect(src.udpPort).toBe(PACK_SYSLOG_PLACEHOLDER_PORT)
    expect(PACK_SYSLOG_PLACEHOLDER_PORT).toBeGreaterThanOrEqual(CLOUD_SYSLOG_PORT_RANGE.min)
    expect(PACK_SYSLOG_PLACEHOLDER_PORT).toBeLessThanOrEqual(CLOUD_SYSLOG_PORT_RANGE.max)
    // Not the global stack's 5514, which a Cloud tenant's exporter cannot reach.
    expect(PACK_SYSLOG_PLACEHOLDER_PORT).not.toBe(V010_SOURCE_SPEC.tcpPort)
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
  // Whole-object equality, never toMatchObject: a key added to a route (an
  // `outputExpression`, say) would otherwise pass unseen.
  it('the syslog route is the frozen 0.1.0 ROUTE_SPEC with the pack\'s ids, and nothing else', () => {
    expect(routes.find((r) => r.id === PACK_SYSLOG_ROUTE_ID)).toEqual({
      ...V010_ROUTE_SPEC,
      id: PACK_SYSLOG_ROUTE_ID,
      name: PACK_SYSLOG_ROUTE_ID,
      filter: `__inputId=='syslog:${PACK_SYSLOG_INPUT_ID}'`,
      pipeline: PACK_SYSLOG_PIPELINE_ID,
      output: PACK_LAKE_OUTPUT_ID,
    })
  })

  it('the sample route sends the DataGen to the sample destination, and nothing else', () => {
    expect(routes.find((r) => r.id === PACK_SAMPLE_ROUTE_ID)).toEqual({
      id: PACK_SAMPLE_ROUTE_ID,
      name: PACK_SAMPLE_ROUTE_ID,
      final: true,
      disabled: false,
      filter: `__inputId=='datagen:${PACK_SAMPLE_INPUT_ID}'`,
      pipeline: PACK_SAMPLE_PIPELINE_ID,
      output: PACK_SAMPLE_OUTPUT_ID,
      description: 'Gigamon AMI sample data → Cribl Lake (gigamon_ami_sample)',
      clones: [],
      enableOutputExpression: false,
    })
    expect(routes).toHaveLength(2)
  })
})

describe('pack ids never collide with the live global objects', () => {
  const packIds = [
    ...Object.keys(inputs), ...Object.keys(outputs), ...routes.map((r) => r.id as string),
    ...pipelineDirs(),
  ]
  const replaced = Object.keys(REPLACED_BY_PACK)
  const kept = Object.keys(KEPT_BESIDE_PACK)

  it('no pack object reuses a global id', () => {
    const globals = new Set([...replaced, ...kept])
    expect(packIds.filter((id) => globals.has(id))).toEqual([])
    // Nor the ids provision.ts creates today, nor the ones it created before.
    for (const id of [
      SOURCE_SPEC.id, PIPELINE_SPEC.id, ROUTE_SPEC.id, HTTP_BREAKER_SPEC.id, destinationSpecFor(DEFAULT_PROFILE).id,
      V010_SOURCE_SPEC.id, V010_ROUTE_SPEC.pipeline, V010_ROUTE_SPEC.id,
    ]) {
      expect(packIds).not.toContain(id)
    }
  })

  it('every replacement names an object the pack actually defines, and every entry a reason', () => {
    for (const { by, why } of Object.values(REPLACED_BY_PACK)) {
      expect(packIds).toContain(by)
      expect(why.trim()).not.toBe('')
    }
    for (const why of Object.values(KEPT_BESIDE_PACK)) expect(why.trim()).not.toBe('')
  })

  it('the migration removes exactly the syslog source, its pipeline and its route that provision.ts created', () => {
    expect([...replaced].sort()).toEqual([V010_SOURCE_SPEC.id, V010_ROUTE_SPEC.pipeline, V010_ROUTE_SPEC.id].sort())
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
