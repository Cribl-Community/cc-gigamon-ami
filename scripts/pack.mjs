// Validate and build the Gigamon AMI onboarding pack (.crbl) from its text source.
//
//   node scripts/pack.mjs check [--dir <packDir>] [--expect-version X.Y.Z]
//   node scripts/pack.mjs build [--dir <packDir>] [--expect-version X.Y.Z] [--out build/packs]
//
// `check` writes nothing. `build` runs every check first, then writes
// <out>/<name>-<version>.crbl and prints its sha256.
//
// WHY THE CHECKS LIVE HERE, BEFORE PUBLISHING. A broken pack is found at install
// time, on a customer's Leader, where a failed install can leave files behind
// that no API removes. The same mistake found here costs nothing. Each check
// below is a failure that has either happened or been measured:
//   - a DataGen sample must be ONE JSON document, an array of events. An NDJSON
//     sample installed, and then every read of its content failed with a 500.
//   - samples.yml's `size` and `numEvents` must describe the bytes that are
//     actually packed, which is why sizes are computed from the normalised
//     bytes below and never taken from the working tree.
//   - every sample id a DataGen names must exist.
//   - every pipeline and output a route names must exist, and every YAML file
//     must parse.
//   - the syslog input's port must be one a Cribl-managed group exposes.
//
// WHY THIS WRITES ITS OWN TAR. Three things measured in the delivery spike:
//   - Cribl's extractor does not create missing parent directories, so the
//     archive carries an explicit entry for each directory, parents first.
//   - an archive made by the system tar on Windows records the author's OS user
//     name as the owner of every entry. This one records uid/gid 0 and no names.
//   - a working tree on Windows can hold CRLF files, which would change every
//     size. Text is normalised to LF before it is measured or packed.
// Entries are sorted and carry a fixed mtime, so the tar bytes are identical on
// every machine. The gzip layer is deterministic for a given zlib build; its
// header's OS byte is pinned so the platform does not leak into it either.

import {
  readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync,
} from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { parseDocument } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIR = join(ROOT, 'packs', 'cc-network-gigamon-ami')
const PACK_NAME = 'cc-network-gigamon-ami'
/**
 * 2026-01-01T00:00:00Z: every entry's mtime, so the archive does not depend on
 * when it was built. In the past on purpose: an extractor warns about, and may
 * refuse, a timestamp in the future.
 */
const FIXED_MTIME = 1767225600
/** The ports a Cribl-managed worker group exposes for syslog. */
const PORT_MIN = 20000
const PORT_MAX = 20010
/** A sample must loop within five minutes at its rate. */
const MAX_LOOP_SECONDS = 300
const SAMPLE_ORIGIN_METADATA = { name: 'gno_origin', value: "'sample'" }

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const [mode, ...rest] = argv
  const opts = { mode, dir: DEFAULT_DIR, expectVersion: null, out: join(ROOT, 'build', 'packs') }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--dir') opts.dir = resolve(rest[++i])
    else if (a === '--expect-version') opts.expectVersion = rest[++i]
    else if (a === '--out') opts.out = resolve(rest[++i])
    else throw new Error(`pack.mjs: unknown argument ${a}`)
  }
  if (mode !== 'check' && mode !== 'build') throw new Error('usage: node scripts/pack.mjs <check|build> [--dir d] [--expect-version X.Y.Z] [--out d]')
  return opts
}

// ── Reading the pack ────────────────────────────────────────────────────────

/** The bytes that go into the archive: UTF-8 text with every CRLF made LF. */
function packedBytes(path) {
  return Buffer.from(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
}

const toPosix = (p) => p.split(sep).join('/')

/** Every path under the pack, directories included, relative and POSIX-style. */
function walk(dir, errors) {
  const files = []
  const dirs = []
  const visit = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name)
      const rel = toPosix(relative(dir, full))
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        errors.push(`${rel}: symbolic links are not packed`)
        continue
      }
      if (name.startsWith('.')) {
        errors.push(`${rel}: dotfiles are not packed`)
        continue
      }
      if (st.isDirectory()) {
        dirs.push(rel)
        visit(full)
      } else if (st.isFile()) {
        files.push(rel)
      } else {
        errors.push(`${rel}: not a regular file`)
      }
    }
  }
  visit(dir)
  return { files, dirs }
}

/** Only these reach the archive: the manifest, a README, default/ and data/samples/. */
function allowed(rel) {
  return rel === 'package.json' || rel === 'README.md' ||
    /^default\/[a-z0-9_.-]+\.yml$/.test(rel) ||
    /^default\/pipelines\/[a-z0-9_-]+\/conf\.yml$/.test(rel) ||
    /^data\/samples\/[a-z0-9_-]+\.json$/.test(rel)
}

function parseYaml(dir, rel, errors) {
  const doc = parseDocument(packedBytes(join(dir, rel)).toString('utf8'), { uniqueKeys: true, strict: true, prettyErrors: false })
  for (const e of doc.errors) errors.push(`${rel}: YAML error: ${e.message}`)
  for (const w of doc.warnings) errors.push(`${rel}: YAML warning: ${w.message}`)
  return doc.errors.length ? undefined : doc.toJS()
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ── Public-repo hygiene for the samples ─────────────────────────────────────

const ALLOWED_NETS = [
  ['10.20.0.0', 16], // internal hosts: private address space
  ['192.0.2.0', 24], // TEST-NET-1
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
]
const ALLOWED_HOST_SUFFIXES = ['example.com', 'example.net', 'example.org']
/** Not hostnames: a file name in an FTP command is shaped like one. */
const FILE_EXTENSIONS = new Set(['csv', 'txt', 'json', 'gz', 'zip', 'js', 'css', 'png'])

const ipToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
function ipAllowed(ip) {
  const octets = ip.split('.').map(Number)
  if (octets.some((o) => o > 255)) return false
  const n = ipToInt(ip)
  return ALLOWED_NETS.some(([base, bits]) => {
    const size = 2 ** (32 - bits)
    const start = ipToInt(base)
    return n >= start && n < start + size
  })
}
function hostAllowed(host) {
  const h = host.toLowerCase()
  const arpa = /^((?:\d{1,3}\.){3}\d{1,3})\.in-addr\.arpa$/.exec(h)
  if (arpa) return ipAllowed(arpa[1].split('.').reverse().join('.'))
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))
}

const IPV4 = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g
/** Labels may carry `_` (service names such as `_ldap._tcp`); the last label starts with a letter. */
const HOSTNAME = /(?<![\w.-])((?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]*)(?![\w-])/gi

/** Every IPv4 address and hostname in any string (or key) of an event, checked. */
export function hygieneProblems(value, where) {
  const problems = []
  const visit = (v) => {
    if (typeof v === 'string') {
      const arpaFree = v.replace(/(?:\d{1,3}\.){3}\d{1,3}\.in-addr\.arpa/gi, (m) => {
        if (!hostAllowed(m)) problems.push(`${where}: reverse name outside the allowed ranges: ${m}`)
        return ' '
      })
      for (const m of arpaFree.matchAll(IPV4)) {
        if (!ipAllowed(m[1])) problems.push(`${where}: IPv4 address outside 10.20.0.0/16 and the documentation ranges: ${m[1]}`)
      }
      for (const m of arpaFree.matchAll(HOSTNAME)) {
        const host = m[1]
        const tld = host.split('.').pop().toLowerCase()
        if (FILE_EXTENSIONS.has(tld) && !host.includes('.example.')) continue
        if (!hostAllowed(host)) problems.push(`${where}: hostname outside example.com/.net/.org: ${host}`)
      }
      if (/[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f:]*::|::[0-9a-f]{1,4}/i.test(v)) problems.push(`${where}: IPv6 address; samples are IPv4 only: ${v}`)
    } else if (Array.isArray(v)) {
      v.forEach(visit)
    } else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        visit(k)
        visit(x)
      }
    }
  }
  visit(value)
  return problems
}

// ── Checks ──────────────────────────────────────────────────────────────────

export function checkPack(dir, { expectVersion = null } = {}) {
  const errors = []
  if (!existsSync(dir)) return { errors: [`${dir}: no such directory`] }
  const { files, dirs } = walk(dir, errors)
  for (const f of files) if (!allowed(f)) errors.push(`${f}: not a file the pack may contain`)

  // 1. The pack manifest.
  let manifest = {}
  if (!files.includes('package.json')) errors.push('package.json: missing')
  else {
    try {
      manifest = JSON.parse(packedBytes(join(dir, 'package.json')).toString('utf8'))
    } catch (e) {
      errors.push(`package.json: not JSON: ${e.message}`)
    }
    if (manifest.name !== PACK_NAME) errors.push(`package.json: name must be "${PACK_NAME}", not ${JSON.stringify(manifest.name)}`)
    if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) errors.push(`package.json: version must be X.Y.Z, not ${JSON.stringify(manifest.version)}`)
    if (expectVersion !== null && manifest.version !== expectVersion) {
      errors.push(`package.json: version ${JSON.stringify(manifest.version)} does not match the expected ${JSON.stringify(expectVersion)} (the tag)`)
    }
    for (const k of ['displayName', 'author', 'description', 'minLogStreamVersion']) {
      if (typeof manifest[k] !== 'string' || manifest[k].trim() === '') errors.push(`package.json: ${k} is required`)
    }
    if (manifest.cribl?.type === 'app') errors.push('package.json: cribl.type "app" would make this look like the app package')
  }

  // 2. Every YAML file parses.
  const yml = {}
  for (const f of files.filter((x) => x.endsWith('.yml'))) yml[f] = parseYaml(dir, f, errors)

  // 3. Every sample is one JSON array of event objects.
  const sampleFiles = files.filter((f) => f.startsWith('data/samples/'))
  const samples = new Map()
  for (const f of sampleFiles) {
    const id = f.slice('data/samples/'.length, -'.json'.length)
    const bytes = packedBytes(join(dir, f))
    let parsed
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch (e) {
      errors.push(`${f}: not one JSON document (a DataGen sample must be a JSON array, not NDJSON): ${e.message}`)
      continue
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      errors.push(`${f}: must be a non-empty JSON array of events`)
      continue
    }
    parsed.forEach((e, i) => {
      if (!isPlainObject(e)) errors.push(`${f}[${i}]: every event must be an object`)
      else {
        if (e.gno_origin !== 'sample') errors.push(`${f}[${i}]: gno_origin must be "sample"`)
        if ('_time' in e) errors.push(`${f}[${i}]: carries _time; Cribl sets it on replay`)
      }
    })
    errors.push(...hygieneProblems(parsed, f))
    samples.set(id, { bytes: bytes.length, events: parsed.length })
  }

  // 4. samples.yml describes exactly the packed sample files.
  const samplesYml = yml['default/samples.yml']
  if (sampleFiles.length && !files.includes('default/samples.yml')) errors.push('default/samples.yml: missing')
  const declared = isPlainObject(samplesYml) ? samplesYml : {}
  if (samplesYml !== undefined && !isPlainObject(samplesYml)) errors.push('default/samples.yml: must be a map of sample id to entry')
  for (const [id, entry] of Object.entries(declared)) {
    const where = `default/samples.yml: ${id}`
    if (!isPlainObject(entry)) {
      errors.push(`${where}: must be a map`)
      continue
    }
    const actual = samples.get(id)
    if (!existsSync(join(dir, 'data', 'samples', `${id}.json`))) {
      errors.push(`${where}: no data/samples/${id}.json`)
      continue
    }
    if (entry.sampleName !== `${id}.json`) errors.push(`${where}: sampleName must be "${id}.json"`)
    if (typeof entry.isTemplate !== 'boolean') errors.push(`${where}: isTemplate must be true or false`)
    if (typeof entry.created !== 'number') errors.push(`${where}: created must be a number`)
    if (!actual) continue
    if (entry.size !== actual.bytes) errors.push(`${where}: size is ${entry.size} but the packed file is ${actual.bytes} bytes`)
    if (entry.numEvents !== actual.events) errors.push(`${where}: numEvents is ${entry.numEvents} but the file holds ${actual.events} events`)
  }
  for (const id of samples.keys()) if (!(id in declared)) errors.push(`data/samples/${id}.json: not declared in default/samples.yml`)

  // 5. Inputs: DataGen references, the sample tag, the syslog port.
  const inputs = isPlainObject(yml['default/inputs.yml']?.inputs) ? yml['default/inputs.yml'].inputs : {}
  if (!files.includes('default/inputs.yml')) errors.push('default/inputs.yml: missing')
  for (const [id, input] of Object.entries(inputs)) {
    const where = `default/inputs.yml: ${id}`
    if (!isPlainObject(input) || typeof input.type !== 'string') {
      errors.push(`${where}: must have a type`)
      continue
    }
    if (input.type === 'datagen') {
      if (input.disabled !== true) errors.push(`${where}: a DataGen must ship disabled: true`)
      const list = Array.isArray(input.samples) ? input.samples : []
      if (list.length === 0) errors.push(`${where}: names no samples`)
      for (const s of list) {
        if (!(s?.sample in declared)) errors.push(`${where}: sample "${s?.sample}" is not in default/samples.yml`)
        if (!(typeof s?.eventsPerSec === 'number' && s.eventsPerSec > 0)) errors.push(`${where}: sample "${s?.sample}" needs a positive eventsPerSec`)
        const n = declared[s?.sample]?.numEvents
        if (typeof n === 'number' && s.eventsPerSec > 0 && n / s.eventsPerSec > MAX_LOOP_SECONDS) {
          errors.push(`${where}: sample "${s.sample}" takes ${n / s.eventsPerSec} s to loop; the limit is ${MAX_LOOP_SECONDS}`)
        }
      }
      const md = Array.isArray(input.metadata) ? input.metadata : []
      if (!md.some((m) => m?.name === SAMPLE_ORIGIN_METADATA.name && m?.value === SAMPLE_ORIGIN_METADATA.value)) {
        errors.push(`${where}: metadata must set ${SAMPLE_ORIGIN_METADATA.name} = ${SAMPLE_ORIGIN_METADATA.value}`)
      }
    }
    if (input.type === 'syslog') {
      for (const k of ['tcpPort', 'udpPort']) {
        const p = input[k]
        if (!(Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX)) {
          errors.push(`${where}: ${k} ${JSON.stringify(p)} is outside ${PORT_MIN}-${PORT_MAX}, the ports a Cribl-managed group exposes`)
        }
      }
    }
  }

  // 6. Routes name real pipelines, outputs and inputs.
  const outputs = isPlainObject(yml['default/outputs.yml']?.outputs) ? yml['default/outputs.yml'].outputs : {}
  if (!files.includes('default/outputs.yml')) errors.push('default/outputs.yml: missing')
  for (const [id, o] of Object.entries(outputs)) {
    if (!isPlainObject(o) || typeof o.type !== 'string') errors.push(`default/outputs.yml: ${id}: must have a type`)
  }
  const routesDoc = yml['default/routes.yml']
  if (!files.includes('default/routes.yml')) errors.push('default/routes.yml: missing')
  const routes = Array.isArray(routesDoc?.routes) ? routesDoc.routes : []
  if (files.includes('default/routes.yml') && routes.length === 0) errors.push('default/routes.yml: has no routes')
  for (const route of routes) {
    const where = `default/routes.yml: ${route?.id}`
    if (!files.includes(`default/pipelines/${route?.pipeline}/conf.yml`)) errors.push(`${where}: pipeline "${route?.pipeline}" has no default/pipelines/${route?.pipeline}/conf.yml`)
    if (!(route?.output in outputs)) errors.push(`${where}: output "${route?.output}" is not in default/outputs.yml`)
    const m = /^__inputId=='([a-z_]+):([A-Za-z0-9_-]+)'$/.exec(String(route?.filter))
    if (m && inputs[m[2]]?.type !== m[1]) errors.push(`${where}: filter names input ${m[1]}:${m[2]}, which default/inputs.yml does not define`)
  }
  for (const f of files.filter((x) => /^default\/pipelines\/[^/]+\/conf\.yml$/.test(x))) {
    if (yml[f] !== undefined && !Array.isArray(yml[f]?.functions)) errors.push(`${f}: must have a functions list`)
  }

  return { errors, files, dirs, manifest }
}

// ── The archive ─────────────────────────────────────────────────────────────

function octal(buf, off, len, value) {
  buf.write(value.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii')
}

function header(name, { size, dir }) {
  if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) throw new Error(`pack.mjs: ${name}: tar names here must be ASCII and at most 100 bytes`)
  const b = Buffer.alloc(512)
  b.write(name, 0, 100, 'ascii')
  octal(b, 100, 8, dir ? 0o755 : 0o644)
  octal(b, 108, 8, 0) // uid
  octal(b, 116, 8, 0) // gid
  octal(b, 124, 12, size)
  octal(b, 136, 12, FIXED_MTIME)
  b.fill(0x20, 148, 156) // checksum field counts as spaces while summing
  b.write(dir ? '5' : '0', 156, 1, 'ascii')
  b.write('ustar\0', 257, 6, 'ascii')
  b.write('00', 263, 2, 'ascii')
  // uname (265) and gname (297) stay empty: no OS user name reaches the archive.
  octal(b, 329, 8, 0) // devmajor
  octal(b, 337, 8, 0) // devminor
  let sum = 0
  for (const x of b) sum += x
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return b
}

/** Directories first within each level's parent, so every parent precedes its children. */
function entryOrder(files, dirs) {
  const all = [...dirs.map((d) => ({ path: d, dir: true })), ...files.map((f) => ({ path: f, dir: false }))]
  const key = (e) => (e.dir ? `${e.path}/` : e.path)
  return all.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

export function buildTar(dir, files, dirs) {
  const parts = []
  for (const e of entryOrder(files, dirs)) {
    if (e.dir) parts.push(header(`${e.path}/`, { size: 0, dir: true }))
    else {
      const data = packedBytes(join(dir, e.path))
      parts.push(header(e.path, { size: data.length, dir: false }), data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad) parts.push(Buffer.alloc(pad))
    }
  }
  parts.push(Buffer.alloc(1024)) // end-of-archive: two zero blocks
  let tar = Buffer.concat(parts)
  const RECORD = 10240
  if (tar.length % RECORD) tar = Buffer.concat([tar, Buffer.alloc(RECORD - (tar.length % RECORD))])
  return tar
}

export function gzipDeterministic(tar) {
  const gz = gzipSync(tar, { level: 9 })
  gz.writeUInt32LE(0, 4) // MTIME: none
  gz[9] = 0x03 // OS: Unix, whatever platform built it
  return gz
}

/** Read an archive back: every header's checksum, name, size and owner. */
export function listTar(tar) {
  const entries = []
  let off = 0
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every((x) => x === 0)) break
    const str = (a, n) => h.toString('ascii', a, a + n).split('\0')[0]
    const num = (a, n) => parseInt(str(a, n).trim() || '0', 8)
    const stored = num(148, 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]
    if (sum !== stored) throw new Error(`pack.mjs: bad header checksum at offset ${off}`)
    const size = num(124, 12)
    entries.push({
      name: str(0, 100), type: str(156, 1), size, mode: num(100, 8), uid: num(108, 8), gid: num(116, 8),
      mtime: num(136, 12), uname: str(265, 32), gname: str(297, 32),
      data: tar.subarray(off + 512, off + 512 + size),
    })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function verifyArchive(crbl, dir, files, dirs) {
  const entries = listTar(gunzipSync(crbl))
  const seen = new Set()
  const want = new Set([...dirs.map((d) => `${d}/`), ...files])
  for (const e of entries) {
    const parent = e.name.replace(/\/$/, '').split('/').slice(0, -1).join('/')
    if (parent && !seen.has(`${parent}/`)) throw new Error(`pack.mjs: ${e.name} precedes its directory ${parent}/`)
    if (e.uid || e.gid || e.uname || e.gname) throw new Error(`pack.mjs: ${e.name} carries an owner`)
    if (!want.delete(e.name)) throw new Error(`pack.mjs: unexpected archive entry ${e.name}`)
    if (e.type === '0' && !e.data.equals(packedBytes(join(dir, e.name)))) throw new Error(`pack.mjs: ${e.name} does not match its source`)
    seen.add(e.name)
  }
  if (want.size) throw new Error(`pack.mjs: missing from the archive: ${[...want].join(', ')}`)
  return entries
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    process.exit(2)
  }
  const { errors, files, dirs, manifest } = checkPack(opts.dir, { expectVersion: opts.expectVersion })
  const shown = relative(ROOT, opts.dir) || opts.dir
  if (errors.length) {
    process.stderr.write(`pack check failed for ${shown} (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n  ${errors.join('\n  ')}\n`)
    process.exit(1)
  }
  process.stdout.write(`pack check: ${shown} is valid (${manifest.name} ${manifest.version}, ${files.length} files)\n`)
  if (opts.mode !== 'build') return

  const tar = buildTar(opts.dir, files, dirs)
  const crbl = gzipDeterministic(tar)
  const entries = verifyArchive(crbl, opts.dir, files, dirs)
  mkdirSync(opts.out, { recursive: true })
  const outFile = join(opts.out, `${manifest.name}-${manifest.version}.crbl`)
  writeFileSync(outFile, crbl)
  const sha = (b) => createHash('sha256').update(b).digest('hex')
  for (const e of entries) process.stdout.write(`  ${e.type === '5' ? 'd' : '-'} ${String(e.size).padStart(8)}  ${e.name}\n`)
  process.stdout.write(`wrote ${outFile}\n  bytes   ${crbl.length}\n  sha256  ${sha(crbl)}\n  tar sha256 ${sha(tar)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
