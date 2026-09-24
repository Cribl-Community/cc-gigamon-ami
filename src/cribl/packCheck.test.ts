// scripts/pack.mjs: the checks that stand between a pack edit and a Leader.
//
// A broken pack is otherwise discovered at install time on a customer's Leader,
// where a failed install can leave files no API removes. Each case below breaks
// ONE thing in a scratch copy of the committed pack and asserts that `check`
// refuses it with a message naming that thing; the committed pack must pass.
// The last block builds the archive and reads it back, because "deterministic"
// and "directories before their contents" are claims about bytes.

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterAll, describe, it, expect } from 'vitest'
import { PACK_ID } from './pack'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'pack.mjs')
const PACK_DIR = join(ROOT, 'packs', PACK_ID)

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

/** A throwaway copy of the committed pack, edited by `mutate`. */
function copyPack(mutate?: (dir: string) => void): string {
  const base = mkdtempSync(join(tmpdir(), 'gigamon-pack-'))
  scratch.push(base)
  const dir = join(base, PACK_ID)
  cpSync(PACK_DIR, dir, { recursive: true })
  mutate?.(dir)
  return dir
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const edit = (dir: string, rel: string, fn: (s: string) => string) => {
  const p = join(dir, rel)
  writeFileSync(p, fn(readFileSync(p, 'utf8')))
}

describe('pack.mjs check', () => {
  it('passes the committed pack', () => {
    const r = run(['check'])
    expect(r.out).toMatch(/is valid/)
    expect(r.status).toBe(0)
  }, 30_000)

  it('passes when the version matches the tag, and fails when it does not', () => {
    expect(run(['check', '--expect-version', '0.2.0']).status).toBe(0)
    const r = run(['check', '--expect-version', '9.9.9'])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/does not match the expected "9\.9\.9"/)
  }, 30_000)

  const cases: [string, (dir: string) => void, RegExp][] = [
    [
      'a sample written as NDJSON rather than one JSON array',
      (d) => edit(d, 'data/samples/gigamon_ami_dns.json', (s) => (JSON.parse(s) as unknown[]).map((e) => JSON.stringify(e)).join('\n') + '\n'),
      /gigamon_ami_dns\.json: not one JSON document/,
    ],
    [
      'a samples.yml size that does not match the packed bytes',
      (d) => edit(d, 'default/samples.yml', (s) => s.replace(/(gigamon_ami_dns:[\s\S]*?size: )(\d+)/, (_m, a: string, n: string) => `${a}${Number(n) + 1}`)),
      /gigamon_ami_dns: size is \d+ but the packed file is \d+ bytes/,
    ],
    [
      'a samples.yml event count that does not match the file',
      (d) => edit(d, 'default/samples.yml', (s) => s.replace(/(gigamon_ami_web_api:[\s\S]*?numEvents: )(\d+)/, (_m, a: string, n: string) => `${a}${Number(n) - 1}`)),
      /gigamon_ami_web_api: numEvents is \d+ but the file holds \d+ events/,
    ],
    [
      'a DataGen naming a sample id that does not exist',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace('sample: gigamon_ami_dns', 'sample: gigamon_ami_missing')),
      /sample "gigamon_ami_missing" is not in default\/samples\.yml/,
    ],
    [
      'a DataGen that ships enabled',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: datagen\n\s+disabled: )true/, '$1false')),
      /a DataGen must ship disabled: true/,
    ],
    [
      'a DataGen without the gigamon_origin tag',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(`value: "'sample'"`, `value: "'real'"`)),
      /metadata must set gigamon_origin/,
    ],
    [
      'a sample event without the gigamon_origin field',
      (d) => edit(d, 'data/samples/gigamon_ami_dns.json', (s) => s.replace('"gigamon_origin":"sample",', '')),
      /gigamon_ami_dns\.json\[0\]: gigamon_origin must be "sample"/,
    ],
    [
      'an HTTP port a Cribl-managed group does not expose',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace('port: 20005', 'port: 10080')),
      /in_gigamon_ami_http: port 10080 is outside 20000-20010/,
    ],
    [
      'an HTTP input that ships enabled',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: http_raw\n\s+disabled: )true/, '$1false')),
      /in_gigamon_ami_http: an http_raw input must ship disabled: true/,
    ],
    [
      'an HTTP input with no disabled key at all (Cribl reads that as enabled)',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: http_raw\n)\s+disabled: true\n/, '$1')),
      /in_gigamon_ami_http: an http_raw input must ship disabled: true/,
    ],
    [
      'an HTTP input carrying an auth token',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: http_raw\n)/, '$1    authTokensExt:\n      - token: abc123\n        authType: manual\n')),
      /in_gigamon_ami_http: must carry no auth token \(authTokensExt\)/,
    ],
    [
      'an HTTP input carrying an old-style auth token list',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: http_raw\n)/, '$1    authTokens:\n      - abc123\n')),
      /in_gigamon_ami_http: must carry no auth token \(authTokens\)/,
    ],
    [
      'an HTTP input naming a breaker ruleset the pack does not define',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace('- gigamon_ami_http_json_array', '- gigamon_json_http')),
      /in_gigamon_ami_http: breaker ruleset "gigamon_json_http" is not in default\/breakers\.yml/,
    ],
    [
      'a breaker ruleset with no rules',
      (d) => edit(d, 'default/breakers.yml', (s) => s.replace(/rules:\n[\s\S]*$/, 'rules: []\n')),
      /default\/breakers\.yml: gigamon_ami_http_json_array: must have at least one rule/,
    ],
    [
      'a syslog input (Gigamon AMX sends over HTTP)',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace('inputs:\n', 'inputs:\n  in_gigamon_ami_syslog:\n    type: syslog\n    disabled: true\n    sendToRoutes: true\n')),
      /in_gigamon_ami_syslog: input type "syslog" is not one this pack may ship/,
    ],
    // Leak path A: QuickConnect. The DataGen skips the routes and writes
    // straight to the customer's destination.
    [
      'a DataGen wired by QuickConnect to the customer\'s destination',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: datagen\n\s+disabled: true\n\s+)sendToRoutes: true/, '$1sendToRoutes: false\n    connections:\n      - output: gigamon_ami_json_lake')),
      /in_gigamon_ami_sample: connections \(QuickConnect\) bypass the pack's routes/,
    ],
    [
      'a DataGen that does not send to routes',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: datagen\n\s+disabled: true\n\s+)sendToRoutes: true/, '$1sendToRoutes: false')),
      /in_gigamon_ami_sample: sendToRoutes must be true/,
    ],
    [
      'an HTTP input with QuickConnect connections',
      (d) => edit(d, 'default/inputs.yml', (s) => s.replace(/(type: http_raw\n)/, '$1    connections:\n      - output: gigamon_ami_sample_lake\n')),
      /in_gigamon_ami_http: connections \(QuickConnect\) bypass the pack's routes/,
    ],
    // Leak path B: an output expression. The route names the sample
    // destination, and the expression sends the events somewhere else.
    [
      'a route whose output expression overrides its output',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace(/(output: gigamon_ami_sample_lake[\s\S]*?)enableOutputExpression: false/, `$1enableOutputExpression: true\n    outputExpression: "'gigamon_ami_json_lake'"`)),
      /gigamon_ami_sample: enableOutputExpression must be false/,
    ],
    [
      'a route carrying an outputExpression, even with the switch off',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace(/(output: gigamon_ami_sample_lake[\s\S]*?enableOutputExpression: false)/, `$1\n    outputExpression: "'gigamon_ami_json_lake'"`)),
      /gigamon_ami_sample: outputExpression is not allowed/,
    ],
    // Leak path C: a route that names the wrong destination outright.
    [
      'the sample route pointed at the customer\'s dataset',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace('output: gigamon_ami_sample_lake', 'output: gigamon_ami_json_lake')),
      /gigamon_ami_sample: a DataGen route may only write gigamon_ami_sample, not gigamon_ami/,
    ],
    [
      'an HTTP route into the sample dataset',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace('output: gigamon_ami_json_lake', 'output: gigamon_ami_sample_lake')),
      /gigamon_ami_http_to_json: only a DataGen route may write gigamon_ami_sample/,
    ],
    [
      'a catch-all route filter',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace("filter: __inputId=='datagen:in_gigamon_ami_sample'", 'filter: "true"')),
      /gigamon_ami_sample: filter must be __inputId=='<type>:<id>' naming one input of this pack/,
    ],
    // The Parquet route writes the Parquet copy and nothing else.
    [
      'the Parquet route pointed at the JSON destination',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace('output: gigamon_ami_parquet_lake', 'output: gigamon_ami_json_lake')),
      /gigamon_ami_http_to_parquet: a \*_to_parquet route may only target a Parquet destination/,
    ],
    [
      'a non-Parquet route pointed at the Parquet destination',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace('output: gigamon_ami_json_lake', 'output: gigamon_ami_parquet_lake')),
      /gigamon_ami_http_to_json: only a \*_to_parquet route may target the Parquet destination gigamon_ami_parquet_lake/,
    ],
    [
      'the dashboards\' dataset written as Parquet',
      (d) => edit(d, 'default/outputs.yml', (s) => s.replace(/(gigamon_ami_json_lake:\n\s+type: cribl_lake\n\s+destPath: gigamon_ami\n\s+format: )json/, '$1parquet')),
      /gigamon_ami_json_lake: gigamon_ami must be written as json, not parquet/,
    ],
    [
      'a destination into a dataset this pack does not write',
      (d) => edit(d, 'default/outputs.yml', (s) => s.replace('destPath: gigamon_ami_pq', 'destPath: gigamon_ami_other')),
      /gigamon_ami_parquet_lake: writes dataset "gigamon_ami_other", which is not one of this pack's datasets/,
    ],
    [
      'a gno_-prefixed object id (the prefix is reserved for acceleration schedules)',
      (d) => {
        edit(d, 'default/outputs.yml', (s) => s.replace('gigamon_ami_sample_lake:', 'gno_sample_lake:'))
        edit(d, 'default/pipelines/route.yml', (s) => s.replace('output: gigamon_ami_sample_lake', 'output: gno_sample_lake'))
      },
      /default\/outputs\.yml: gno_sample_lake: the gno_ prefix is reserved for acceleration schedules/,
    ],
    [
      'a gno_-prefixed route name',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace('name: gigamon_ami_sample', 'name: gno_sample')),
      /gigamon_ami_sample: name "gno_sample": the gno_ prefix is reserved/,
    ],
    [
      'a routes file at default/routes.yml, where Cribl never reads it',
      (d) => cpSync(join(d, 'default', 'pipelines', 'route.yml'), join(d, 'default', 'routes.yml')),
      /default\/routes\.yml: a pack's routes live at default\/pipelines\/route\.yml/,
    ],
    [
      'a pack with no default/pipelines/route.yml',
      (d) => rmSync(join(d, 'default', 'pipelines', 'route.yml')),
      /default\/pipelines\/route\.yml: missing/,
    ],
    [
      'a route to an output the pack does not define',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace('output: gigamon_ami_json_lake', 'output: gigamon_ami_nowhere')),
      /output "gigamon_ami_nowhere" is not in default\/outputs\.yml/,
    ],
    [
      'a route to a pipeline the pack does not define',
      (d) => edit(d, 'default/pipelines/route.yml', (s) => s.replace('pipeline: gigamon_ami_normalize', 'pipeline: gigamon_ami_nowhere')),
      /pipeline "gigamon_ami_nowhere" has no default\/pipelines\/gigamon_ami_nowhere\/conf\.yml/,
    ],
    [
      'a YAML file that does not parse',
      (d) => edit(d, 'default/outputs.yml', (s) => s.replace('  gigamon_ami_json_lake:', '  gigamon_ami_json_lake:\n   bad: [unclosed')),
      /default\/outputs\.yml: YAML error/,
    ],
    [
      'a sample carrying an address outside the allowed ranges',
      (d) => edit(d, 'data/samples/gigamon_ami_security.json', (s) => s.replace('"198.51.100.66"', '"8.8.8.8"')),
      /IPv4 address outside 10\.20\.0\.0\/16 and the documentation ranges: 8\.8\.8\.8/,
    ],
    [
      'a sample carrying a real hostname',
      (d) => edit(d, 'data/samples/gigamon_ami_security.json', (s) => s.replace('voip.example.com', 'voip.cribl.io')),
      /hostname outside example\.com\/\.net\/\.org: voip\.cribl\.io/,
    ],
    [
      'a file the pack may not contain',
      (d) => writeFileSync(join(d, 'default', 'notes.txt'), 'x'),
      /default\/notes\.txt: not a file the pack may contain/,
    ],
  ]

  for (const [what, mutate, message] of cases) {
    it(`fails on ${what}`, () => {
      const r = run(['check', '--dir', copyPack(mutate)])
      expect(r.status).toBe(1)
      expect(r.out).toMatch(message)
    }, 30_000)
  }
})

// ── The archive ─────────────────────────────────────────────────────────────

interface Entry { name: string; type: string; size: number; uid: number; gid: number; uname: string; gname: string; mtime: number }

/** A minimal ustar reader, independent of the one inside pack.mjs. */
function entries(crbl: Buffer): Entry[] {
  const tar = gunzipSync(crbl)
  const out: Entry[] = []
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512)
    if (h.every((x) => x === 0)) break
    const str = (a: number, n: number) => h.toString('ascii', a, a + n).split('\0')[0]
    const oct = (a: number, n: number) => parseInt(str(a, n).trim() || '0', 8)
    const size = oct(124, 12)
    out.push({ name: str(0, 100), type: str(156, 1), size, uid: oct(108, 8), gid: oct(116, 8), uname: str(265, 32), gname: str(297, 32), mtime: oct(136, 12) })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

describe('pack.mjs build', () => {
  function build(dir: string) {
    const out = mkdtempSync(join(tmpdir(), 'gigamon-crbl-'))
    scratch.push(out)
    const r = run(['build', '--dir', dir, '--out', out])
    expect(r.status, r.out).toBe(0)
    return readFileSync(join(out, `${PACK_ID}-0.2.0.crbl`))
  }

  it('writes the same bytes every time, and the same bytes from a CRLF working tree', () => {
    const a = build(PACK_DIR)
    expect(build(PACK_DIR).equals(a)).toBe(true)
    const crlf = copyPack((d) => {
      for (const rel of ['default/inputs.yml', 'default/breakers.yml', 'default/samples.yml', 'data/samples/gigamon_ami_dns.json']) edit(d, rel, (s) => s.replace(/\n/g, '\r\n'))
    })
    expect(build(crlf).equals(a)).toBe(true)
  }, 60_000)

  it('lists every directory before its contents, with no owner and a fixed time', () => {
    const list = entries(build(PACK_DIR))
    const seen = new Set<string>()
    for (const e of list) {
      const parent = e.name.replace(/\/$/, '').split('/').slice(0, -1).join('/')
      if (parent) expect(seen.has(`${parent}/`), `${e.name} before ${parent}/`).toBe(true)
      seen.add(e.name)
      expect([e.uid, e.gid, e.uname, e.gname]).toEqual([0, 0, '', ''])
      expect(e.name.startsWith('./')).toBe(false)
      expect(e.mtime * 1000).toBeLessThan(Date.parse('2026-09-23T00:00:00Z'))
    }
    expect(list.filter((e) => e.type === '5').map((e) => e.name)).toEqual(
      ['data/', 'data/samples/', 'default/', 'default/pipelines/', 'default/pipelines/gigamon_ami_normalize/'],
    )
    expect(list.map((e) => e.name)).toContain('package.json')
    expect(list.map((e) => e.name)).toContain('default/breakers.yml')
  }, 30_000)

  it('packs sizes that equal what samples.yml declares', () => {
    const list = entries(build(PACK_DIR))
    const yml = readFileSync(join(PACK_DIR, 'default', 'samples.yml'), 'utf8')
    const samples = list.filter((x) => x.type === '0' && x.name.startsWith('data/samples/'))
    expect(samples).toHaveLength(5)
    for (const e of samples) {
      const id = e.name.slice('data/samples/'.length, -'.json'.length)
      expect(new RegExp(`${id}:[\\s\\S]*?size: (\\d+)`).exec(yml)![1]).toBe(String(e.size))
    }
  }, 30_000)
})
