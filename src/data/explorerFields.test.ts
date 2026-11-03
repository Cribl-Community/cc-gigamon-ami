import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_QUERY_FIELDS, EXPLORER_CATALOG, EXPLORER_FAMILIES, EXPLORER_USE_CASES } from './explorerFields'
import { CHECK_FIELDS, familyOf, PRESENCE_QUERY } from '../queries/fieldExplorer'

const NON_ANALYTICS = new Set([
  'fieldExplorer', // Presence must not keep an otherwise-unused attribute alive.
  'parquetAudit', // Offline type/density audits, never submitted by the app.
  'lakeLanding', 'lakeWindow', // Installation measurements, not analytics.
  'routing', 'datasets', 'stackIds', // Completeness/probes and Stream object ids.
])
const KEYWORDS = new Set('dataset and or not in true false null by asc desc as where extend summarize sort limit project distinct search'.split(' '))

/** Read query inputs, not string contents, function names or temporary aliases. */
function inputFields(query: string): string[] {
  const clean = query.replace(/@?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, '""')
  const defined = new Set<string>()
  const inputs = new Set<string>()
  for (const [index, stage] of clean.split('|').entries()) {
    const aliases = index === 0 ? [] : [...stage.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g)].map((m) => m[1])
    for (const match of stage.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      const word = match[0]
      const tail = stage.slice(match.index + word.length)
      if (KEYWORDS.has(word) || /^\s*\(/.test(tail) || defined.has(word) ||
        (index > 0 && /^\s*=(?!=)/.test(tail))) continue
      inputs.add(word)
    }
    for (const alias of aliases) defined.add(alias)
  }
  return [...inputs]
}

describe('Field Explorer is limited to app analytics inputs', () => {
  it('matches the frozen dashboard, scheduled-body and drill-down queries in both directions', () => {
    const frozen = JSON.parse(readFileSync('src/queries/__frozen__/display.json', 'utf8')) as {
      modules: Record<string, Record<string, unknown>>
    }
    const used = new Set<string>()
    for (const [module, exports] of Object.entries(frozen.modules)) {
      const name = module.split('/').pop()!.replace('.ts', '')
      if (NON_ANALYTICS.has(name)) continue
      for (const query of Object.values(exports)) {
        // Full statements only: fragments do not carry the alias definitions
        // from their enclosing query and can falsely count an output as input.
        if (typeof query !== 'string' || !query.startsWith('dataset="gigamon_ami"')) continue
        for (const field of inputFields(query)) used.add(field)
      }
    }
    expect([...APP_QUERY_FIELDS].sort()).toEqual([...used].sort())
    expect(APP_QUERY_FIELDS).toHaveLength(new Set(APP_QUERY_FIELDS).size)
  })

  it('distinguishes a persisted helper from a locally computed alias of the same name', () => {
    expect(inputFields('dataset="gigamon_ami" | summarize n=sum(tcp_reset), b=sum(total_bytes)')).toEqual(['tcp_reset', 'total_bytes'])
    expect(inputFields('dataset="gigamon_ami" | extend total_bytes=src_bytes+dst_bytes | summarize b=sum(total_bytes)')).toEqual(['src_bytes', 'dst_bytes'])
    expect(inputFields('dataset="gigamon_ami" http_host="tcp_fake" | summarize p95=percentile(toreal(http_rtt),95) by bin(_time,1m) | sort by p95 desc')).toEqual(['http_host', 'http_rtt', '_time'])
  })

  it('defines and checks exactly those fields, with no hidden fallback checks of unused attributes', () => {
    expect(EXPLORER_CATALOG.map((f) => f.name)).toEqual([...APP_QUERY_FIELDS])
    expect(CHECK_FIELDS).toEqual([...APP_QUERY_FIELDS])
    expect(PRESENCE_QUERY).toBe('dataset="gigamon_ami" | summarize ' + APP_QUERY_FIELDS.map((f, i) => `c${i}=count(${f})`).join(', '))
    for (const field of EXPLORER_CATALOG) {
      expect(field.desc.length, field.name).toBeGreaterThan(0)
      expect(field.useCase.length, field.name).toBeGreaterThan(0)
      expect(EXPLORER_FAMILIES).toContain(field.family)
      if (field.derivedField) expect(CHECK_FIELDS).toContain(field.derivedField)
    }
    for (const unused of ['app_id', 'http_uri', 'ssl_ja3', 'vlan_id', 'tcp_window_size', 'dns_ttl', 'flows', 'p95', 'total_bytes']) {
      expect(CHECK_FIELDS).not.toContain(unused)
    }
  })

  it('keeps fields in their application groups in coverage and feed views', () => {
    for (const [field, family] of [
      ['http_host', 'HTTP'], ['http_rtt', 'HTTP'],
      ['dns_host', 'DNS'], ['ssl_issuer', 'SSL / TLS'],
      ['tcp_reset', 'TCP / network performance'], ['udp_wrong_crc', 'TCP / network performance'],
      ['ftp_data_content', 'Other protocols'],
    ]) expect(familyOf(field)).toBe(family)
  })

  it('has no empty families/use cases or unused use-case fields, and covers every attribute by use case', () => {
    for (const family of EXPLORER_FAMILIES) expect(EXPLORER_CATALOG.some((f) => f.family === family)).toBe(true)
    for (const useCase of EXPLORER_USE_CASES) {
      expect(useCase.fields.length, useCase.name).toBeGreaterThan(0)
      for (const field of useCase.fields) expect(CHECK_FIELDS, useCase.name).toContain(field)
    }
    expect(new Set(EXPLORER_USE_CASES.flatMap((u) => u.fields))).toEqual(new Set(APP_QUERY_FIELDS))
  })
})
