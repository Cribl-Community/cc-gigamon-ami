// The Phase 8.0b/8.0c audit queries: pinned to the JSON dataset, never reached
// by the app, and their field lists held to the sources they are drawn from —
// both directions, so a new field cannot be forgotten silently and a field
// nothing reads any more cannot linger.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LAKE_DATASET } from '../cribl/config'
import { PIPELINE_SPEC } from '../cribl/packSpecs'
import { FINDINGS } from '../data/findings'
import { TECHNIQUES } from '../data/techniques'
import {
  AUDIT_DATASET,
  AUDIT_PIN,
  CAST_CHECK_FIELDS,
  CENSUS_COLUMNS_FIELDS,
  CENSUS_CONTROLS,
  CENSUS_FIELDS,
  DENSITY_CHECKS,
  DENSITY_SCOPES,
  GETTYPE_COLUMN,
  GETTYPE_NAMES,
  MEASURED_TYPES,
  NUMERIC_CENSUS_FIELDS,
  NUMERIC_CENSUS_QUERY,
  NUMERIC_GETTYPE_NAMES,
  PQC_IN_LIST,
  SENTINEL_AUDIT_QUERY,
  SENTINEL_EXTRA_FIELDS,
  SENTINEL_FIELDS,
  STATIC_FIELD_TYPES,
  TYPED_BY_CODE,
  TYPE_DENSITY_QUERY,
  sentinelAuditQuery,
} from './parquetAudit'
import { PQC_BY_SERVER } from './tlsPosture'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')
const ROOT = join(SRC, '..')

/** The two Evals of gigamon_ami_normalize, as Guided Setup writes them. */
const EVALS = PIPELINE_SPEC.conf.functions as ReadonlyArray<{ description: string; conf: { add: Array<{ name: string; value: string }> } }>
const CAST = new Set(EVALS.find((f) => f.description === 'Cast numeric strings')!.conf.add.map((a) => a.name))
const DERIVED = new Map(EVALS.find((f) => f.description === 'Derive helper fields')!.conf.add.map((a) => [a.name, a.value]))
const typedByPipeline = (f: string) => CAST.has(f) || DERIVED.has(f)

/**
 * Modules a router may never move, so their fields are not "touched by a
 * rewrite": presence (Field Explorer), measurement (Lake landing, this module),
 * not this dataset (Data Flow's metrics), and the helpers that build no panel
 * query. Evidence drill-downs stay IN the scan: their filters are the same
 * fields as their panels, so they add nothing and hide nothing.
 */
const PINNED_MODULES = new Set([
  'src/queries/fieldExplorer.ts',
  'src/queries/lakeLanding.ts',
  'src/queries/parquetAudit.ts',
  'src/queries/dataFlow.ts',
  'src/queries/lakeWindow.ts',
  'src/queries/datasets.ts',
  'src/queries/stackIds.ts',
])

/** Class A/B/D/E sites in every frozen query of every movable module. */
function touchedFields(): Set<string> {
  const frozen = JSON.parse(readFileSync(join(HERE, '__frozen__', 'display.json'), 'utf8')) as { modules: Record<string, Record<string, unknown>> }
  const out = new Set<string>()
  const re = /\b(?:count|isnotnull|percentile|avg|min)\(([a-z][a-z0-9_]*)|\b([a-z][a-z0-9_]*)=\*/g
  for (const [mod, entries] of Object.entries(frozen.modules)) {
    if (PINNED_MODULES.has(mod)) continue
    for (const v of Object.values(entries)) {
      if (typeof v !== 'string') continue
      for (const m of v.matchAll(re)) out.add(m[1] ?? m[2])
    }
  }
  return out
}

/** Identifiers in a technique's count expression, quoted literals and operators removed. */
function exprFields(expr: string): string[] {
  return (expr.replace(/"[^"]*"/g, '').match(/\b[a-z][a-z0-9_]*\b/g) ?? []).filter((w) => !['isnotnull', 'in', 'and', 'or', 'not'].includes(w))
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()

describe('pinned: measurement, on the JSON dataset', () => {
  it('names gigamon_ami and nothing else', () => {
    expect(AUDIT_DATASET).toBe(LAKE_DATASET)
    expect(AUDIT_DATASET).toBe('gigamon_ami')
    expect(AUDIT_PIN).toBe('measurement')
    for (const text of [TYPE_DENSITY_QUERY, NUMERIC_CENSUS_QUERY, SENTINEL_AUDIT_QUERY, sentinelAuditQuery({})]) {
      expect(text.startsWith(`dataset="${LAKE_DATASET}" | summarize rows=count(), `)).toBe(true)
      expect(text.match(/dataset=/g)).toHaveLength(1)
      expect(text).not.toContain(`${LAKE_DATASET}_pq`)
      expect(text).not.toContain('$vt_results')
      // The cap is the runner's execution prefix, never part of the frozen text.
      expect(text).not.toContain('max_running_time')
    }
  })

  it('is imported by no app module: the app never submits these, so no router can move them', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const rel = relative(ROOT, p).replace(/\\/g, '/')
          if (rel === 'src/queries/parquetAudit.ts' || rel === 'src/cribl/parquetAuditReport.ts') continue
          if (/from '[./]*(?:queries\/)?parquetAudit(?:Report)?'/.test(readFileSync(p, 'utf8'))) offenders.push(rel)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})

describe('what the pipeline types', () => {
  it('every cast field is cast by gigamon_ami_normalize, every computed one derived by it', () => {
    for (const [f, t] of Object.entries(TYPED_BY_CODE)) {
      if (t.basis === 'cast') {
        expect(CAST.has(f), f).toBe(true)
        expect(t.type, f).toBe('number')
      } else {
        expect(DERIVED.has(f), f).toBe(true)
      }
    }
  })

  it('a computed field is a string exactly when its expression builds one', () => {
    for (const [f, t] of Object.entries(TYPED_BY_CODE)) {
      if (t.basis !== 'computed') continue
      const expr = DERIVED.get(f)!
      const buildsString = /\.join\(|String\(/.test(expr)
      expect(t.type, `${f}: ${expr}`).toBe(buildsString ? 'string' : 'number')
    }
  })

  it('names no pipeline-typed field as a measured type', () => {
    for (const f of Object.keys(MEASURED_TYPES)) expect(typedByPipeline(f), f).toBe(false)
  })
})

describe('the census field list, derived', () => {
  it('equals every untyped field a rewrite touches, a Finding reads, or a technique counts', () => {
    const want = new Set<string>()
    for (const f of touchedFields()) if (!typedByPipeline(f)) want.add(f)
    for (const f of FINDINGS) if (!typedByPipeline(f.field)) want.add(f.field)
    for (const t of TECHNIQUES) if (t.kind === 'flow') for (const f of exprFields(t.expr!)) if (!typedByPipeline(f)) want.add(f)
    expect(sorted(CENSUS_FIELDS)).toEqual(sorted(want))
  })

  it('holds the fields the design names first', () => {
    for (const f of ['http2_code', 'krb5_message_type', 'snmp_community', 'icmp_tunneling', 'dcerpc_service']) expect(CENSUS_FIELDS).toContain(f)
  })

  it('checks the design\'s numeric sentinel fields and a numeric control, and nothing else typed', () => {
    expect([...CAST_CHECK_FIELDS]).toEqual(['tcp_rtt', 'tcp_rtt_app', 'http_server_ms', 'dns_response_time', 'dst_port'])
    for (const f of CAST_CHECK_FIELDS) expect(TYPED_BY_CODE[f]?.type, f).toBe('number')
    expect(CENSUS_FIELDS).toContain(CENSUS_CONTROLS.string)
    expect(TYPED_BY_CODE[CENSUS_CONTROLS.number]).toEqual({ type: 'number', basis: 'cast' })
  })

  it('reads a present count and one count per gettype name for every field, and no column name twice', () => {
    for (const f of CENSUS_COLUMNS_FIELDS) {
      expect(TYPE_DENSITY_QUERY).toContain(`tn_${f}=countif(isnotnull(${f}))`)
      for (const t of GETTYPE_NAMES) expect(TYPE_DENSITY_QUERY).toContain(`${GETTYPE_COLUMN[t]}_${f}=countif(gettype(${f})=="${t}")`)
    }
    const names = [...TYPE_DENSITY_QUERY.matchAll(/(?:summarize |, )([a-z][a-z0-9_]*)=/g)].map((m) => m[1])
    expect(names.length).toBe(new Set(names).size)
    expect(names.length).toBe(1 + Object.keys(DENSITY_SCOPES).length + DENSITY_CHECKS.length + (1 + GETTYPE_NAMES.length) * CENSUS_COLUMNS_FIELDS.length)
  })

  it('never probes a type with min or max over gettype: on sparse fields that answered "~" and 0 (2026-09-25)', () => {
    for (const text of [TYPE_DENSITY_QUERY, NUMERIC_CENSUS_QUERY]) {
      expect(text).not.toMatch(/\b(?:min|max)\(/)
      expect(text).not.toMatch(/tlo_|thi_/)
      for (const m of text.matchAll(/gettype\(/g)) expect(text.slice(m.index - 8, m.index)).toBe('countif(')
    }
  })

  it('counts the two measured names and Kusto\'s other two numeric ones, and nothing guessed', () => {
    expect([...GETTYPE_NAMES]).toEqual(['string', 'int', 'long', 'real'])
    expect([...NUMERIC_GETTYPE_NAMES]).toEqual(['int', 'long', 'real'])
    expect(new Set(Object.values(GETTYPE_COLUMN)).size).toBe(GETTYPE_NAMES.length)
    expect(Object.values(GETTYPE_COLUMN)).not.toContain('tn')
  })
})

describe('the numeric-only census', () => {
  it('types exactly the five cast-check fields and both controls', () => {
    expect([...NUMERIC_CENSUS_FIELDS]).toEqual([...CAST_CHECK_FIELDS, CENSUS_CONTROLS.number, CENSUS_CONTROLS.string])
    const names = [...NUMERIC_CENSUS_QUERY.matchAll(/(?:summarize |, )([a-z][a-z0-9_]*)=/g)].map((m) => m[1])
    expect(names.length).toBe(1 + (1 + GETTYPE_NAMES.length) * NUMERIC_CENSUS_FIELDS.length)
    for (const f of NUMERIC_CENSUS_FIELDS) expect(NUMERIC_CENSUS_QUERY).toContain(`ti_${f}=countif(gettype(${f})=="int")`)
  })

  it('reads no density and no uncast field', () => {
    expect(NUMERIC_CENSUS_QUERY).not.toContain('d_')
    for (const f of CENSUS_FIELDS) if (f !== CENSUS_CONTROLS.string) expect(NUMERIC_CENSUS_QUERY, f).not.toContain(`(${f})`)
  })
})

describe('the density gaps', () => {
  it('are exactly §1.3\'s "still missing" list', () => {
    expect(DENSITY_CHECKS.map((c) => [c.field, c.scope])).toEqual([
      ['dst_subnet', 'tcp'],
      ['src_subnet16', 'tcp'],
      ['dst_subnet16', 'tcp'],
      ['dst_ip', null],
      ['http_server_ms', 'web'],
      ['dst_port', 'icmp'],
      ['ssl_server_name', 'pqc'],
    ])
    expect(DENSITY_SCOPES.tcp.expr).toBe('protocol==6')
    expect(DENSITY_SCOPES.icmp.expr).toBe('protocol==1')
  })

  it('scope the PQC check with the in-list TLS PQC_BY_SERVER actually runs', () => {
    expect(PQC_BY_SERVER).toContain(`ssl_ext_ec_supported_groups_type in ${PQC_IN_LIST} |`)
  })

  it('write every numerator and denominator into the one query', () => {
    for (const id of Object.keys(DENSITY_SCOPES)) expect(TYPE_DENSITY_QUERY).toContain(`d_${id}=countif(${DENSITY_SCOPES[id].expr})`)
    expect(TYPE_DENSITY_QUERY).toContain('d_dst_ip=count(dst_ip)')
    expect(TYPE_DENSITY_QUERY).toContain('d_tcp_dst_subnet=countif(protocol==6 and isnotnull(dst_subnet))')
    expect(TYPE_DENSITY_QUERY).toContain('d_web_http_server_ms=countif(isnotnull(http_host) and isnotnull(http_server_ms))')
  })
})

describe('the sentinel field list, derived', () => {
  it('equals every field a rewrite touches, plus the named extras', () => {
    expect(sorted(SENTINEL_FIELDS)).toEqual(sorted([...touchedFields(), ...SENTINEL_EXTRA_FIELDS]))
    // An extra that a rewrite starts to touch stops being an extra.
    for (const f of SENTINEL_EXTRA_FIELDS) expect(touchedFields().has(f), f).toBe(false)
  })

  it('numbers exactly the design\'s five numeric fields', () => {
    const numeric = SENTINEL_FIELDS.filter((f) => STATIC_FIELD_TYPES[f] === 'number')
    expect(sorted(numeric)).toEqual(sorted(['tcp_rtt', 'tcp_rtt_app', 'http_server_ms', 'dns_response_time', 'dst_port']))
  })

  it('takes http_code as a string, and leaves krb5_message_type and http2_code to the census', () => {
    expect(STATIC_FIELD_TYPES.http_code).toBe('string')
    expect(STATIC_FIELD_TYPES.krb5_message_type).toBe('unknown')
    expect(STATIC_FIELD_TYPES.http2_code).toBe('unknown')
    expect(STATIC_FIELD_TYPES.src_subnet).toBe('string')
  })
})

describe('sentinelAuditQuery', () => {
  it('emits the form the type says, and both for unknown', () => {
    const text = sentinelAuditQuery({ http_code: 'string', tcp_rtt: 'number', http2_code: 'unknown' })
    expect(text).toBe(
      'dataset="gigamon_ami" | summarize rows=count(), ' +
        'sn_http_code=count(http_code), se_http_code=countif(http_code==""), ' +
        'sn_http2_code=count(http2_code), se_http2_code=countif(http2_code==""), sz_http2_code=countif(http2_code==0), ' +
        'sn_tcp_rtt=count(tcp_rtt), sz_tcp_rtt=countif(tcp_rtt==0)',
    )
  })

  it('before a census, reads every sentinel field with the static types', () => {
    expect(SENTINEL_AUDIT_QUERY).toBe(sentinelAuditQuery(STATIC_FIELD_TYPES))
    for (const f of SENTINEL_FIELDS) expect(SENTINEL_AUDIT_QUERY).toContain(`sn_${f}=count(${f})`)
    expect(SENTINEL_AUDIT_QUERY).toContain('sz_krb5_message_type=countif(krb5_message_type==0)')
    expect(SENTINEL_AUDIT_QUERY).toContain('se_krb5_message_type=countif(krb5_message_type=="")')
    expect(SENTINEL_AUDIT_QUERY).not.toContain('sz_http_code')
    expect(SENTINEL_AUDIT_QUERY).not.toContain('se_dst_port')
  })
})
