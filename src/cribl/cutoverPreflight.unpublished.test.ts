// The cutover preflight in a build whose pinned pack CANNOT be installed: the
// window between pinning the next version and its release. This build is not
// that — 0.2.2 is released and flipped — so the mock below moves pack.ts's
// release constants to an unreleased 0.2.3 (`PACK_PUBLISHED` false, no sha256,
// 0.2.3 off `PACK_PUBLISHED_VERSIONS`), as OnboardingPanel.unpublished.test.tsx
// does; delete it and every assertion here stops holding.
//
// Owner decision 2026-09-25 (`fix/preflight-rules-route`): while the pin cannot
// be installed, Upgrade is refused, so an owned older version blocks only on a
// known, stated gap (`OLDER_VERSION_GAPS` — 0.2.1 keeps _raw in the Parquet
// copy) and any other is a warning. 0.1.0 and 0.2.0 keep their refusal.

import { describe, expect, it, vi } from 'vitest'
import { OLDER_VERSION_GAPS, gatherPreflight, preflightVerdict, type PreflightReaders } from './cutoverPreflight'
import { PACK_OBJECTS, PACK_PARQUET_OUTPUT_ID, PACK_PARQUET_PIPELINE_ID, PACK_PIPELINE_ID, PACK_PUBLISHED_VERSIONS, PACK_VERSION } from './pack'
import { thisPackRelease, type PackRoute, type PackState } from './packClient'

vi.mock('./pack', async (orig) => {
  const real = await orig<typeof import('./pack')>()
  return { ...real, PACK_VERSION: '0.2.3', PACK_PUBLISHED: false, PACK_SHA256: null }
})

const PQ_ROUTE: PackRoute = { id: 'gigamon_ami_http_to_parquet', output: PACK_PARQUET_OUTPUT_ID, pipeline: PACK_PARQUET_PIPELINE_ID, disabled: false, final: true, outputExpression: false }

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
    routeTable: [PQ_ROUTE],
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

describe('a pin that cannot be installed (the constants moved to an unreleased 0.2.3)', () => {
  it('has the moved constants: the pin is not installable, and 0.2.2 is an owned older version with no stated gap', () => {
    expect(PACK_VERSION).toBe('0.2.3')
    expect(thisPackRelease().installable).toBe(false)
    expect(PACK_PUBLISHED_VERSIONS).toContain('0.2.2')
    expect(OLDER_VERSION_GAPS['0.2.2']).toBeUndefined()
  })

  it('warns, and does not block, on an owned older version with no stated gap (0.2.2)', async () => {
    const v = await verdictFor({ version: '0.2.2' })
    expect(v.blockers).toEqual([])
    expect(v.ready).toBe(true)
    expect(v.warnings.join('\n')).toMatch(/0\.2\.2 is installed; this build pins 0\.2\.3, which cannot be installed yet \(pack 0\.2\.3 has not been released/)
    expect(v.warnings.join('\n')).toMatch(/no known problem/)
  })

  it('still blocks an owned older version with a stated gap (0.2.1), and says Upgrade is not offered yet', async () => {
    const v = await verdictFor({ version: '0.2.1', routeTable: null })
    expect(v.ready).toBe(false)
    const text = v.blockers.join('\n')
    expect(text).toMatch(/0\.2\.1 is installed; this build pins 0\.2\.3, and 0\.2\.1 keeps _raw on every row of its Parquet copy/)
    expect(text).toMatch(/Upgrade is not offered yet: pack 0\.2\.3 has not been released/)
  })

  it.each(['0.1.0', '0.2.0'])('still refuses %s as delivering nothing', async (version) => {
    const v = await verdictFor({ version, routeTable: null })
    expect(v.ready).toBe(false)
    expect(v.blockers.join('\n')).toMatch(new RegExp(`${version.replace(/\./g, '\\.')} delivers nothing`))
    expect(v.warnings.join('\n')).not.toMatch(/this build pins/)
  })

  it('still checks the Parquet route of a warned-about 0.2.2', async () => {
    const v = await verdictFor({ version: '0.2.2', routeTable: [{ ...PQ_ROUTE, pipeline: PACK_PIPELINE_ID }] })
    expect(v.ready).toBe(false)
    expect(v.blockers.join('\n')).toMatch(/through gigamon_ami_normalize, not gigamon_ami_normalize_parquet, so the Parquet copy \(gigamon_ami_pq\) would keep _raw/)
  })
})
