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
//   - the HTTP input must ship disabled, on a port a Cribl-managed group
//     exposes, and with NO auth token: that port is internet-reachable, and a
//     token in the pack would be one secret shared by every tenant. Guided
//     Setup generates the token and enables the input. Every breaker ruleset
//     it names must be in the pack. Only http_raw and datagen inputs may ship.
//   - the routes file must be default/pipelines/route.yml, where every pack
//     on a Leader keeps it; a default/routes.yml is refused, not ignored.
//   - sample data must have no way into gigamon_ami (or its Parquet copy) that
//     the route checks do not see: no input may carry QuickConnect
//     `connections`, every input must send to routes, no route may carry an
//     output expression, every route filter names exactly one pack input in
//     the in-pack form __inputId=='<type>:<packId>.<id>' (measured 2026-09-25;
//     the global form <type>:<id> never matches inside a pack), a
//     DataGen route may write only the sample dataset, and only a DataGen
//     route may write it.
//   - each Lake destination writes one of the pack's three datasets in that
//     dataset's format (the dashboards read gigamon_ami as JSON), and a
//     *_to_parquet route is the only kind that may reach a Parquet destination.
//   - _raw (0.2.2 on): a route into a Parquet destination must run a pipeline
//     whose enabled Eval, filter "true", removes _raw (and nothing after it adds
//     it back); a route into a JSON destination must run one that removes it
//     nowhere. The JSON datasets keep _raw because the app's evidence drills,
//     Field Explorer and Copilot briefs read it; the Parquet copy would only
//     carry a second copy of each record. Judged by what the pipeline does, not
//     by its name, and narrowly (`rawHandling`): a removal written any other
//     way is refused on a Parquet route rather than trusted.
//   - no object id (or route name) starts with `gno_`, which is reserved for
//     the app's acceleration schedules.
//   - every output is a Cribl Lake destination. A `router` or `default` output
//     forwards to another output, so a sample route naming one would pass
//     every route check above while its events landed in gigamon_ami.
//   - the Parquet destination drops rather than blocks under backpressure: it
//     shares one HTTP input with the JSON feed the dashboards read, and a
//     blocked Parquet writer (its dataset not created yet, or a schema change
//     it cannot write) would otherwise stop that feed too.
//   - an input's routes are all reached: every route of an input but its last
//     is not final, and its last is. That is the dual write: the JSON route
//     first and not final, the Parquet route after it and final.
//   - an http_raw input names at least one breaker ruleset (without one the
//     POSTed array reaches the pipeline as one event), and any input-level
//     `pipeline` exists in the pack.
//   - RELEASE MODE. With --expect-version (what pack-release.yml passes when a
//     tag is pushed), a pack file that still says PENDING is refused: a
//     placeholder must not be published into every tenant that installs it.
//     This lives here, in the step that builds the published bytes, because
//     src/cribl/pack.ts's PACK_PUBLISHED is still false when the tag is pushed
//     (it is set in a later PR), so a test keyed on it never fires at release.
//
// NOT CHECKED HERE, ONLY IN src/cribl/pack.test.ts (the release workflow runs
// both): that each object equals the app's TypeScript spec value for value, and
// the exact route order and ids.
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
/** The ports a Cribl-managed worker group exposes for a source. */
const PORT_MIN = 20000
const PORT_MAX = 20010
/** A sample must loop within five minutes at its rate. */
const MAX_LOOP_SECONDS = 300
/** The field every sample event carries, and the DataGen metadata that sets it. */
const SAMPLE_ORIGIN_FIELD = 'gigamon_origin'
const SAMPLE_ORIGIN_METADATA = { name: SAMPLE_ORIGIN_FIELD, value: "'sample'" }
/** The only input types this pack ships. Gigamon AMX sends over HTTP; syslog was 0.1.0's. */
const INPUT_TYPES = new Set(['http_raw', 'datagen'])
/** Auth-token keys an http_raw input can carry. None may ship in the pack. */
const TOKEN_KEYS = ['authTokens', 'authTokensExt', 'authToken']
/** Reserved for the app's acceleration schedules (src/cribl/accel/manifest.ts). */
const RESERVED_PREFIX = 'gno_'
/**
 * Every Lake dataset a pack destination may write, and the format it must be
 * written in. gigamon_ami is JSON because every dashboard reads it as JSON.
 */
const DATASET_FORMATS = Object.freeze({ gigamon_ami: 'json', gigamon_ami_pq: 'parquet', gigamon_ami_sample: 'json' })
/** Where sample data goes, and the only place it may go. */
const SAMPLE_DATASET = 'gigamon_ami_sample'
/** A route id with this suffix writes the Parquet copy, and only such a route may. */
const PARQUET_ROUTE_SUFFIX = '_to_parquet'
/** Where a pack keeps its event breaker rulesets. UNMEASURED: see src/cribl/pack.ts. */
const BREAKERS_FILE = 'default/breakers.yml'
/** The only output type this pack ships. Anything else can forward elsewhere. */
const OUTPUT_TYPES = new Set(['cribl_lake'])
/**
 * A route filter naming exactly one input of THIS pack. Inside a pack an
 * event's `__inputId` is `<type>:<packId>.<inputId>` — measured 2026-09-25 on a
 * Cribl.Cloud Leader: a DataGen `dg_asis` in pack `cc-network-gigamon-ami-dgtest`
 * stamped `datagen:cc-network-gigamon-ami-dgtest.dg_asis` on every event. Pack
 * 0.2.0 shipped the global form `<type>:<inputId>`, which never matches inside a
 * pack, so with no catch-all route it dropped every event of both its sources.
 */
const PACK_FILTER = new RegExp(`^__inputId=='([a-z_]+):${PACK_NAME.replace(/[-.]/g, '\\$&')}\\.([A-Za-z0-9_-]+)'$`)
/** The global form, refused by name: it is the 0.2.0 bug. */
const BARE_FILTER = /^__inputId=='([a-z_]+):([A-Za-z0-9_-]+)'$/
/** `{ type, id }` of the one pack input a route filter names, or null. */
function routeFilterInput(filter) {
  const m = PACK_FILTER.exec(String(filter))
  return m ? { type: m[1], id: m[2] } : null
}
/** Whether an Eval field pattern (`*` is a wildcard) names `field`. */
const namesField = (pattern, field) =>
  typeof pattern === 'string' && new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(field)

/**
 * What a pipeline does to `_raw`. `touched`: some enabled function lists it
 * (or a wildcard matching it) in an Eval-style `remove`. `removed`: an enabled
 * Eval with filter "true" removes it from every event — `keep` not holding it
 * back — and no later enabled function adds it again. Deliberately narrow: the
 * only removal this recognises is the one the pack ships, so a cleverer one is
 * refused on a Parquet route rather than trusted.
 */
export function rawHandling(conf) {
  const fns = Array.isArray(conf?.functions) ? conf.functions.filter((f) => isPlainObject(f) && f.disabled !== true) : []
  const lists = (f, key) => (Array.isArray(f.conf?.[key]) ? f.conf[key] : [])
  const removes = (f) => lists(f, 'remove').some((p) => namesField(p, '_raw'))
  const touched = fns.some(removes)
  const at = fns.findIndex((f) =>
    f.id === 'eval' && (f.filter === 'true' || f.filter === true) && removes(f) && !lists(f, 'keep').some((p) => namesField(p, '_raw')))
  if (at === -1) return { touched, removed: false, why: 'no enabled Eval with filter "true" lists _raw under remove' }
  const readds = fns.slice(at + 1).find((f) => lists(f, 'add').some((a) => a?.name === '_raw'))
  if (readds) return { touched, removed: false, why: `a later function (${readds.description ?? readds.id}) adds _raw back` }
  return { touched, removed: true, why: '' }
}

/** The word that marks an undecided placeholder (src/cribl/pack.ts `PACK_PENDING`). */
const PENDING = /\bPENDING\b/

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

/**
 * Where a pack's routes live. Measured on a Leader: every bundled pack lists
 * <pack>/default/pipelines/route.yml, and no file named routes.yml exists
 * anywhere. A routes file elsewhere is not read, so the pack would install with
 * no routes and its sources would feed nothing.
 */
const ROUTES_FILE = 'default/pipelines/route.yml'
/** The wrong name this pack once used; refused outright so it cannot come back. */
const WRONG_ROUTES_FILE = 'default/routes.yml'

/** Only these reach the archive: the manifest, a README, default/ and data/samples/. */
function allowed(rel) {
  if (rel === WRONG_ROUTES_FILE) return false
  return rel === 'package.json' || rel === 'README.md' || rel === ROUTES_FILE ||
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

/** Refuse an object id carrying the prefix reserved for acceleration schedules. */
function reserved(where, id, errors) {
  if (typeof id === 'string' && id.startsWith(RESERVED_PREFIX)) {
    errors.push(`${where}: the ${RESERVED_PREFIX} prefix is reserved for acceleration schedules; name the object for what it does`)
  }
}

export function checkPack(dir, { expectVersion = null } = {}) {
  const errors = []
  if (!existsSync(dir)) return { errors: [`${dir}: no such directory`] }
  const { files, dirs } = walk(dir, errors)
  for (const f of files) {
    if (f === WRONG_ROUTES_FILE) errors.push(`${f}: a pack's routes live at ${ROUTES_FILE}; Cribl never reads ${WRONG_ROUTES_FILE}`)
    else if (!allowed(f)) errors.push(`${f}: not a file the pack may contain`)
  }

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

  // 1b. Release mode: nothing PENDING may be published. Samples are generated
  // data, not prose, so only the text a reader would read is searched.
  if (expectVersion !== null) {
    for (const f of files.filter((x) => !x.startsWith('data/'))) {
      if (PENDING.test(packedBytes(join(dir, f)).toString('utf8'))) {
        errors.push(`${f}: says PENDING; a release must not ship an undecided setting. Decide it, then remove the marker and its entry in src/cribl/pack.ts PACK_PENDING`)
      }
    }
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
        if (e[SAMPLE_ORIGIN_FIELD] !== 'sample') errors.push(`${f}[${i}]: ${SAMPLE_ORIGIN_FIELD} must be "sample"`)
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
  for (const id of Object.keys(declared)) reserved(`default/samples.yml: ${id}`, id, errors)

  // 4b. Event breaker rulesets.
  const breakersYml = yml[BREAKERS_FILE]
  if (breakersYml !== undefined && !isPlainObject(breakersYml)) errors.push(`${BREAKERS_FILE}: must be a map of ruleset id to ruleset`)
  const breakers = isPlainObject(breakersYml) ? breakersYml : {}
  for (const [id, b] of Object.entries(breakers)) {
    reserved(`${BREAKERS_FILE}: ${id}`, id, errors)
    if (!isPlainObject(b) || !Array.isArray(b.rules) || b.rules.length === 0) errors.push(`${BREAKERS_FILE}: ${id}: must have at least one rule`)
  }

  // 5. Inputs: DataGen references, the sample tag, the syslog port.
  const inputs = isPlainObject(yml['default/inputs.yml']?.inputs) ? yml['default/inputs.yml'].inputs : {}
  if (!files.includes('default/inputs.yml')) errors.push('default/inputs.yml: missing')
  for (const [id, input] of Object.entries(inputs)) {
    const where = `default/inputs.yml: ${id}`
    reserved(where, id, errors)
    if (!isPlainObject(input) || typeof input.type !== 'string') {
      errors.push(`${where}: must have a type`)
      continue
    }
    if (!INPUT_TYPES.has(input.type)) errors.push(`${where}: input type "${input.type}" is not one this pack may ship (${[...INPUT_TYPES].join(', ')})`)
    // Every input reaches a destination through the pack's routes and nothing
    // else. A QuickConnect `connections` list (with sendToRoutes false) skips
    // the routes, which is how the DataGen could write into gigamon_ami while
    // every route check still passed.
    if (input.connections !== undefined) errors.push(`${where}: connections (QuickConnect) bypass the pack's routes; send to routes instead`)
    if (input.sendToRoutes !== true) errors.push(`${where}: sendToRoutes must be true; the routes are the only path out of this pack`)
    if (input.pipeline !== undefined && !files.includes(`default/pipelines/${input.pipeline}/conf.yml`)) {
      errors.push(`${where}: pipeline "${input.pipeline}" has no default/pipelines/${input.pipeline}/conf.yml`)
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
    if (input.type === 'http_raw') {
      // A Cloud port in 20000-20010 is reachable from the internet: nothing
      // listens until Guided Setup sets a port and a token and enables it.
      // An absent key is refused too, because Cribl reads it as enabled.
      if (input.disabled !== true) errors.push(`${where}: an http_raw input must ship disabled: true; Guided Setup enables it with a port and a token`)
      // A token in the pack is one secret shared by every tenant that installs
      // it, and public in this repository. Any value, even an empty list, is
      // refused: the key's presence is the mistake.
      for (const k of TOKEN_KEYS) {
        if (k in input) errors.push(`${where}: must carry no auth token (${k}); the app generates one at install`)
      }
      const p = input.port
      if (!(Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX)) {
        errors.push(`${where}: port ${JSON.stringify(p)} is outside ${PORT_MIN}-${PORT_MAX}, the ports a Cribl-managed group exposes`)
      }
      if (!Array.isArray(input.breakerRulesets) || input.breakerRulesets.length === 0) {
        errors.push(`${where}: an http_raw input must name a breaker ruleset; without one a POSTed JSON array reaches the pipeline as one event`)
      }
      for (const b of Array.isArray(input.breakerRulesets) ? input.breakerRulesets : []) {
        if (!(b in breakers)) errors.push(`${where}: breaker ruleset "${b}" is not in ${BREAKERS_FILE}; a pack input must not depend on a global ruleset`)
      }
    }
  }

  // 6. Routes name real pipelines, outputs and inputs.
  const outputs = isPlainObject(yml['default/outputs.yml']?.outputs) ? yml['default/outputs.yml'].outputs : {}
  if (!files.includes('default/outputs.yml')) errors.push('default/outputs.yml: missing')
  for (const [id, o] of Object.entries(outputs)) {
    const where = `default/outputs.yml: ${id}`
    reserved(where, id, errors)
    if (!isPlainObject(o) || typeof o.type !== 'string') {
      errors.push(`${where}: must have a type`)
      continue
    }
    if (!OUTPUT_TYPES.has(o.type)) {
      errors.push(`${where}: output type "${o.type}" is not one this pack may ship (${[...OUTPUT_TYPES].join(', ')}); a router or default output forwards to another output, past every route check`)
    }
    if (o.type === 'cribl_lake' && o.format === 'parquet' && o.onBackpressure !== 'drop') {
      errors.push(`${where}: a Parquet destination must set onBackpressure: drop, not ${JSON.stringify(o.onBackpressure)}; it shares its input with the JSON feed the dashboards read, and blocking would stop that feed`)
    }
    if (o.type === 'cribl_lake') {
      const want = Object.hasOwn(DATASET_FORMATS, o.destPath) ? DATASET_FORMATS[o.destPath] : undefined
      if (want === undefined) errors.push(`${where}: writes dataset ${JSON.stringify(o.destPath)}, which is not one of this pack's datasets (${Object.keys(DATASET_FORMATS).join(', ')})`)
      else if (o.format !== want) errors.push(`${where}: ${o.destPath} must be written as ${want}, not ${o.format}`)
    }
  }
  /** The dataset and format a route's output writes, when it is a Lake destination. */
  const lakeOf = (outputId) => (isPlainObject(outputs[outputId]) && outputs[outputId].type === 'cribl_lake' ? outputs[outputId] : null)
  const routesDoc = yml[ROUTES_FILE]
  if (!files.includes(ROUTES_FILE)) errors.push(`${ROUTES_FILE}: missing`)
  const routes = Array.isArray(routesDoc?.routes) ? routesDoc.routes : []
  if (files.includes(ROUTES_FILE) && routes.length === 0) errors.push(`${ROUTES_FILE}: has no routes`)
  for (const route of routes) {
    const where = `${ROUTES_FILE}: ${route?.id}`
    reserved(where, route?.id, errors)
    if (route?.name !== undefined && String(route.name).startsWith(RESERVED_PREFIX)) {
      errors.push(`${where}: name ${JSON.stringify(route.name)}: the ${RESERVED_PREFIX} prefix is reserved for acceleration schedules`)
    }
    // A route's `output` must be the only place its events go. An output
    // expression overrides it at runtime, so a route could name the sample
    // destination and still write into gigamon_ami.
    if (isPlainObject(route) && 'outputExpression' in route) errors.push(`${where}: outputExpression is not allowed; a route's output must be the only place its events go`)
    if (route?.enableOutputExpression !== undefined && route.enableOutputExpression !== false) errors.push(`${where}: enableOutputExpression must be false`)
    if (!files.includes(`default/pipelines/${route?.pipeline}/conf.yml`)) errors.push(`${where}: pipeline "${route?.pipeline}" has no default/pipelines/${route?.pipeline}/conf.yml`)
    if (!(route?.output in outputs)) errors.push(`${where}: output "${route?.output}" is not in default/outputs.yml`)
    // Exactly one pack input per route. A catch-all (`true`) or any other
    // expression would let a route take events this file cannot see, which is
    // how sample data could meet the customer's destination.
    const m = routeFilterInput(route?.filter)
    if (!m) {
      errors.push(
        BARE_FILTER.test(String(route?.filter))
          ? `${where}: filter ${JSON.stringify(route?.filter)} names the input as a global one; inside a pack __inputId is '<type>:${PACK_NAME}.<id>' (measured 2026-09-25), so this filter never matches and the route drops every event`
          : `${where}: filter must be __inputId=='<type>:${PACK_NAME}.<id>' naming one input of this pack, not ${JSON.stringify(route?.filter)}`,
      )
    } else if (inputs[m.id]?.type !== m.type) errors.push(`${where}: filter names input ${m.type}:${PACK_NAME}.${m.id}, which default/inputs.yml does not define`)
    const from = m ? inputs[m.id] : undefined
    const lake = lakeOf(route?.output)
    const isSampleRoute = from?.type === 'datagen'
    if (isSampleRoute && lake && lake.destPath !== SAMPLE_DATASET) {
      errors.push(`${where}: a DataGen route may only write ${SAMPLE_DATASET}, not ${lake.destPath}; Lake has no row delete`)
    }
    if (!isSampleRoute && lake?.destPath === SAMPLE_DATASET) errors.push(`${where}: only a DataGen route may write ${SAMPLE_DATASET}`)
    const parquetRoute = String(route?.id).endsWith(PARQUET_ROUTE_SUFFIX)
    if (parquetRoute && lake?.format !== 'parquet') errors.push(`${where}: a *${PARQUET_ROUTE_SUFFIX} route may only target a Parquet destination, not ${route?.output}`)
    if (!parquetRoute && lake?.format === 'parquet') errors.push(`${where}: only a *${PARQUET_ROUTE_SUFFIX} route may target the Parquet destination ${route?.output}`)
    // _raw: dropped from the Parquet copy, kept in every JSON dataset (the
    // app's evidence drills, Field Explorer and Copilot briefs read it there).
    const conf = yml[`default/pipelines/${route?.pipeline}/conf.yml`]
    if (lake && isPlainObject(conf)) {
      const raw = rawHandling(conf)
      if (lake.format === 'parquet' && !raw.removed) {
        errors.push(`${where}: writes the Parquet destination ${route?.output} through pipeline "${route?.pipeline}", which does not remove _raw; the Parquet copy must not carry it (${raw.why})`)
      }
      if (lake.format !== 'parquet' && raw.touched) {
        errors.push(`${where}: writes the ${lake.format} dataset ${lake.destPath} through pipeline "${route?.pipeline}", which removes _raw; a JSON dataset keeps it`)
      }
    }
  }
  // Every route of an input is reached. Routes run in order and a final route
  // stops the event, so a final route ahead of another route of the same input
  // silently starves it (the JSON route final: the Parquet copy gets nothing;
  // the Parquet route first: the dashboards get nothing). The last route of an
  // input is final, so its events go nowhere past this pack's routes.
  const byInput = new Map()
  for (const route of routes) {
    const m = routeFilterInput(route?.filter)
    if (!m) continue
    if (!byInput.has(m.id)) byInput.set(m.id, [])
    byInput.get(m.id).push(route)
  }
  for (const [input, list] of byInput) {
    list.forEach((route, i) => {
      const where = `${ROUTES_FILE}: ${route?.id}`
      const last = i === list.length - 1
      if (!last && route.final !== false) {
        errors.push(`${where}: final: ${JSON.stringify(route.final)}, so ${input}'s later route ${list.slice(i + 1).map((r) => r?.id).join(', ')} never runs; only an input's last route may be final`)
      }
      if (last && route.final !== true) errors.push(`${where}: the last route of ${input} must be final: true`)
    })
  }

  for (const f of files.filter((x) => /^default\/pipelines\/[^/]+\/conf\.yml$/.test(x))) {
    reserved(f, f.split('/')[2], errors)
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
