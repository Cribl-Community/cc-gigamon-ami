// The cutover preflight in a build whose NEXT pin is released and flipped: the
// mock below moves pack.ts's release constants to a released 0.2.3 (published,
// a 64-hex sha256, 0.2.3 appended to `PACK_PUBLISHED_VERSIONS`), so 0.2.2 is an
// owned version older than an installable pin with no stated gap — a case the
// real constants cannot make (every older real version is non-delivering or has
// a gap). Owner decision 2026-09-25 (`fix/preflight-rules-route`): while the pin
// can be installed, any owned older version blocks, because Upgrade clears it.

import { describe, expect, it, vi } from 'vitest'
import { OLDER_VERSION_GAPS, gatherPreflight, preflightVerdict, type PreflightReaders } from './cutoverPreflight'
import { PACK_OBJECTS, PACK_PARQUET_OUTPUT_ID, PACK_PARQUET_PIPELINE_ID, PACK_VERSION } from './pack'
import { thisPackRelease, type PackState } from './packClient'

vi.mock('./pack', async (orig) => {
  const real = await orig<typeof import('./pack')>()
  return {
    ...real,
    PACK_VERSION: '0.2.3',
    PACK_PUBLISHED: true,
    PACK_SHA256: 'a'.repeat(64),
    PACK_PUBLISHED_VERSIONS: Object.freeze([...real.PACK_PUBLISHED_VERSIONS, '0.2.3']),
  }
})

function packState(over: Partial<PackState>): PackState {
  const all = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 'present' as const]))
  return {
    error: null, installed: true, version: null, published: true, fromRelease: true, current: false,
    objects: {
      inputs: all(PACK_OBJECTS.inputs), breakers: all(PACK_OBJECTS.breakers), pipelines: all(PACK_OBJECTS.pipelines),
      routes: all(PACK_OBJECTS.routes), outputs: all(PACK_OBJECTS.outputs),
    },
    http: { disabled: false, port: 20005, tokenSet: true, tls: true, tlsCert: 'cloud' },
    sample: { disabled: true }, installedSample: { id: 'in_gigamon_ami_sample', disabled: true },
    routeTable: [{ id: 'gigamon_ami_http_to_parquet', output: PACK_PARQUET_OUTPUT_ID, pipeline: PACK_PARQUET_PIPELINE_ID, disabled: false, final: true, outputExpression: false }],
    outputTable: [{ id: PACK_PARQUET_OUTPUT_ID, type: 'cribl_lake', dataset: 'gigamon_ami_pq' }],
    ...over,
  }
}

const readers = (pack: PackState): PreflightReaders => ({
  readPackState: async () => pack,
  checkStatus: async () => ({ breaker: 'absent', pipeline: 'absent', source: 'absent', route: 'absent' }),
  checkLegacyStatus: async () => ({ legacy_source: 'absent', legacy_pipeline: 'absent', legacy_route: 'absent' }),
  listDatasets: async () => ({
    outcome: 'ok', object: '/x', status: 200, detail: null,
    value: ['gigamon_ami', 'gigamon_ami_pq'].map((id) => ({
      id, description: null, format: 'json', retentionPeriodInDays: 30, acceleratedFields: null, searchConfig: null,
      deletionStartedAt: null, metrics: { currentSizeBytes: 1, metricsDate: '2026-09-24' }, raw: {},
    })),
  }),
  listStreamGroupsCurrent: async () => ({ outcome: 'ok', value: [{ id: 'default', name: 'default', configVersion: 'a', onPrem: false }], object: '/x', status: 200, detail: null }),
  portsOfOthers: async () => [],
  pendingConfigPaths: async () => [],
  deployState: async () => ({ state: 'current', head: 'a' }),
  leaderHostname: () => 'main-acme.cribl.cloud',
  suggestedIngressHost: () => 'default.main.acme.cribl.cloud',
})

const verdictFor = async (over: Partial<PackState>) => preflightVerdict(await gatherPreflight('default', readers(packState(over))))

describe('an installable pin (the constants moved to a released 0.2.3)', () => {
  it('has the moved constants: the pin is installable, and 0.2.2 has no stated gap', () => {
    expect(PACK_VERSION).toBe('0.2.3')
    expect(thisPackRelease().installable).toBe(true)
    expect(OLDER_VERSION_GAPS['0.2.2']).toBeUndefined()
  })

  it('blocks an owned older version with no stated gap (0.2.2): Upgrade can clear it', async () => {
    const v = await verdictFor({ version: '0.2.2' })
    expect(v.ready).toBe(false)
    const text = v.blockers.join('\n')
    expect(text).toMatch(/0\.2\.2 is installed; this build pins 0\.2\.3\. Upgrade it to 0\.2\.3 from Guided Setup’s onboarding panel \(Upgrade\)/)
    expect(text).not.toMatch(/not offered yet/)
    expect(v.warnings.join('\n')).not.toMatch(/this build pins/)
  })

  it('blocks an owned older version with a stated gap (0.2.1), naming the gap', async () => {
    const v = await verdictFor({ version: '0.2.1', routeTable: null })
    expect(v.ready).toBe(false)
    expect(v.blockers.join('\n')).toMatch(/0\.2\.1 keeps _raw on every row of its Parquet copy/)
  })

  it('is ready on the current 0.2.3 with its shipped Parquet route', async () => {
    const v = await verdictFor({ version: '0.2.3', current: true })
    expect(v.blockers).toEqual([])
    expect(v.ready).toBe(true)
  })
})
