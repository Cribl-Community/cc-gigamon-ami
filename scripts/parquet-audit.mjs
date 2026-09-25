// Phase 8.0b / 8.0c: run the JSON audit queries and write the type, density
// and sentinel tables.
//
//   node scripts/parquet-audit.mjs                 print the plan and the cost estimate; submits NOTHING
//   node scripts/parquet-audit.mjs --run           submit, poll, and write the report
//
// Options:
//   --at <ISO time>          the reference "now" (default: the current time). Windows end 10 min before it.
//                            The report records it as referenceAt, apart from ranAt (when the jobs ran).
//   --offsets 0,6,12         hours before the newest window at which each 15-min sentinel window ends
//   --cap <seconds>          running-time cap prefixed onto each job (default 300)
//   --base <url>             API base (default http://localhost:5173/capi, the `npm run dev` proxy)
//   --out <dir>              where the dated report goes (default .dev/parquet-audit, gitignored)
//   --census wide|numeric    wide (default): the 60-min census of every field + density, then the
//                            sentinel windows. numeric: ONE 15-min census of the five cast-check
//                            fields and both controls — no density, no sentinel job — to resolve
//                            the numeric types cheaply.
//   --sentinels-from <file.json>  numeric only: re-read that report's raw sentinel rows with the
//                            new census's types, billing nothing. Its windows are that report's.
//   --rows-per-hour <n>      the dataset's intake, for the estimate (default: the measured run's, 1,049,258)
//   --census-coef <n>        census CPU-s per 1,000 rows per census field (default: measured 2026-09-25, ≈0.186)
//   --sentinel-coef <n>      sentinel CPU-s per 1,000 rows (default: measured 2026-09-25, ≈0.369)
//   --types-from <file.json> wide only: run the sentinel query with a prior report's census type
//                            table, instead of both forms for every unresolved field. The 60-minute
//                            census (job 1) STILL RUNS and is billed again; its fresh table is
//                            recorded beside the prior one's types, not used for the sentinels.
//
// Reports are never overwritten: the file name carries the reference time and
// the wall-clock start of the run (parquet-audit-ref<at>Z-ran<start>Z), a clash
// gets -2, -3, …, and the files are opened with the exclusive flag. A job whose
// poll or results read fails is cancelled (POST .../cancel), and the failure and
// the cancel are recorded on that job in the report.
//
// WHAT IT NEEDS. `npm run dev` running, with `.dev/cribl.json` in place: the
// Vite proxy at /capi injects the OAuth token (vite.config.ts). This script
// never handles a credential and never talks to Cribl except through that proxy.
//
// WHAT IT SPENDS, AND WHY --run. The queries scan `gigamon_ami` (JSON) over one
// 60-minute and a few 15-minute windows (or one 15-minute window, numeric-only).
// The estimate is printed first, as a FLOOR derived from the one measured run
// (2026-09-25: the wide census billed 5,457 CPU-s, the three sentinel windows
// 51, 111 and 128), and nothing is submitted without --run: Cribl has no CPU
// cap, and the running-time cap bounds wall time only, so the approval has to be
// a person's, made on the printed figure. After each job the runner reads its
// metrics for up to ~90 s; a cost that never appears is recorded as "not yet
// available", never as 0, and the total says it is incomplete.
//
// WHY scripts/ AND NOT .dev/. `.dev/` is gitignored because it holds
// credentials; a runner there would be absent from a fresh clone and invisible
// to review. The measurement is evidence a routing decision will later rest on
// (design §4, 8.1), so the thing that took it is committed beside the other Node
// tools, and the query text it posts is the frozen text in
// src/queries/parquetAudit.ts, unmodified bar the cap prefix. The REPORTS go to
// .dev/ by default: they carry a tenant's figures, and recording one in the plan
// is a deliberate act, not a side effect of running this.
//
// The app never runs these queries; nothing on a timer does either.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import nodeModule from 'node:module'

// src/ imports are extensionless ('../queries/parquetAudit'); Node 24 strips
// the types but wants the file's real name. Same hook as extract-queries.mjs.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context)
      throw err
    }
  },
})

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const Q = await import(pathToFileURL(join(ROOT, 'src/queries/parquetAudit.ts')).href)
const R = await import(pathToFileURL(join(ROOT, 'src/cribl/parquetAuditReport.ts')).href)
const J = await import(pathToFileURL(join(ROOT, 'scripts/parquet-audit-job.mjs')).href)

function parseArgs(argv) {
  const out = { run: false, at: null, offsets: null, cap: 300, base: 'http://localhost:5173/capi', out: join(ROOT, '.dev', 'parquet-audit'), rowsPerHour: null, censusCoef: null, sentinelCoef: null, typesFrom: null, census: 'wide', sentinelsFrom: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--run') out.run = true
    else if (a === '--at') out.at = next()
    else if (a === '--offsets') out.offsets = next().split(',').map((s) => Number(s.trim()))
    else if (a === '--cap') out.cap = Number(next())
    else if (a === '--base') out.base = next().replace(/\/$/, '')
    else if (a === '--out') out.out = resolve(next())
    else if (a === '--rows-per-hour') out.rowsPerHour = Number(next())
    else if (a === '--census-coef') out.censusCoef = Number(next())
    else if (a === '--sentinel-coef') out.sentinelCoef = Number(next())
    else if (a === '--cpu-per-1k') throw new Error('--cpu-per-1k is gone: one flat coefficient under-priced the 2026-09-25 run 7×. Use --census-coef and --sentinel-coef.')
    else if (a === '--types-from') out.typesFrom = resolve(next())
    else if (a === '--census') out.census = next()
    else if (a === '--sentinels-from') out.sentinelsFrom = resolve(next())
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
      console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).join('\n'))
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!Number.isFinite(out.cap) || out.cap <= 0) throw new Error('--cap must be a positive number of seconds')
  if (out.offsets && out.offsets.some((h) => !Number.isFinite(h) || h < 0)) throw new Error('--offsets must be non-negative hours')
  if (out.census !== 'wide' && out.census !== 'numeric') throw new Error('--census must be wide or numeric')
  if (out.census === 'numeric' && (out.typesFrom || out.offsets)) throw new Error('--types-from and --offsets shape the sentinel jobs, which --census numeric does not submit')
  if (out.census !== 'numeric' && out.sentinelsFrom) throw new Error('--sentinels-from is for --census numeric: a wide run measures its own sentinels')
  for (const [flag, v] of [['--rows-per-hour', out.rowsPerHour], ['--census-coef', out.censusCoef], ['--sentinel-coef', out.sentinelCoef]]) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error(`${flag} must be a positive number`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const startedMs = Date.now()
const nowSec = args.at ? Math.floor(Date.parse(args.at) / 1000) : Math.floor(startedMs / 1000)
if (!Number.isFinite(nowSec)) throw new Error(`--at ${args.at} is not a date`)
const numeric = args.census === 'numeric'
const windows = R.auditWindows(nowSec, numeric ? R.NUMERIC_CENSUS_WINDOW : args.offsets ? { sentinelOffsetsHours: args.offsets } : {})
const censusFields = numeric ? Q.NUMERIC_CENSUS_FIELDS : Q.CENSUS_COLUMNS_FIELDS
const censusQuery = numeric ? Q.NUMERIC_CENSUS_QUERY : Q.TYPE_DENSITY_QUERY
const censusPurpose = numeric ? '8.0b numeric-only census' : '8.0b census + density'
const basis = {
  rowsPerHour: args.rowsPerHour ?? R.DEFAULT_COST_BASIS.rowsPerHour,
  censusCpuPer1kRowsPerField: args.censusCoef ?? R.DEFAULT_COST_BASIS.censusCpuPer1kRowsPerField,
  sentinelCpuPer1kRows: args.sentinelCoef ?? R.DEFAULT_COST_BASIS.sentinelCpuPer1kRows,
}
const estimate = R.auditCostEstimate(windows, basis, censusFields.length, args.census)

let sentinelTypes = Q.STATIC_FIELD_TYPES
let sentinelQuery = Q.SENTINEL_AUDIT_QUERY
if (args.typesFrom) {
  const prior = JSON.parse(readFileSync(args.typesFrom, 'utf8'))
  if (!prior.census) throw new Error(`${args.typesFrom} holds no census to take types from`)
  sentinelTypes = R.censusTypeTable(prior.census)
  sentinelQuery = Q.sentinelAuditQuery(sentinelTypes)
}
// --sentinels-from: an earlier report's raw sentinel rows and its type table,
// re-read with this run's census. Read (and refused) before anything is billed.
let priorSentinels = null
if (args.sentinelsFrom) {
  const prior = JSON.parse(readFileSync(args.sentinelsFrom, 'utf8'))
  const rows = prior.raw?.sentinels
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${args.sentinelsFrom} holds no raw sentinel rows to re-read`)
  priorSentinels = { rows, types: prior.sentinelTypes ?? Q.STATIC_FIELD_TYPES }
}

// ── The plan, always printed first ──────────────────────────────────────────
console.log('Phase 8.0b / 8.0c audit — dataset "%s" (JSON), pinned: %s', Q.AUDIT_DATASET, Q.AUDIT_PIN)
console.log('')
console.log('Jobs, in order:')
console.log(`  1. ${censusPurpose.padEnd(24)} ${windows.census.label}`)
windows.sentinel.forEach((w, i) => console.log(`  ${i + 2}. ${'8.0c sentinels'.padEnd(24)} ${w.label}`))
if (numeric) console.log(`Numeric-only census of ${censusFields.join(', ')}; no density, no sentinel job.${priorSentinels ? ` Sentinels re-read, billing nothing, from ${args.sentinelsFrom}.` : ''}`)
console.log(`Running-time cap per job: ${args.cap} s.${numeric ? '' : ` Sentinel types: ${args.typesFrom ? `from ${args.typesFrom}` : 'static (both forms where unknown)'}.`}`)
if (args.typesFrom) console.log('--types-from does not skip the census: job 1 runs and is billed again, and its fresh table is recorded beside the prior types.')
console.log('')
console.log('Expected cost:')
for (const l of estimate.lines) console.log('  ' + l)
console.log('')
if (!args.run) {
  console.log('Nothing submitted. Re-run with --run to submit these jobs through %s.', args.base)
  process.exit(0)
}

// ── Running ─────────────────────────────────────────────────────────────────
// The report directory is made before anything is billed, so a bad --out fails for free.
mkdirSync(args.out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deps = {
  api: J.makeApi({ base: args.base, fetch: (u, init) => fetch(u, init), sleep }),
  sleep,
  now: () => Date.now(),
  log: (line) => console.log(line),
  cap: args.cap,
}
const runJob = (purpose, window, query) => J.runAuditJob(deps, purpose, window, query)

const ranAt = new Date().toISOString()
console.log('Submitting, one job at a time:')
const jobs = []
const census = await runJob(censusPurpose, windows.census, censusQuery)
jobs.push(census.job)
const sentinelRows = []
for (const w of windows.sentinel) {
  const r = await runJob('8.0c sentinels', w, sentinelQuery)
  jobs.push(r.job)
  if (r.row) sentinelRows.push(r.row)
}

const censusEntries = census.row ? R.readTypeCensus(census.row, censusFields) : null
let sentinels = null
if (numeric) {
  if (censusEntries && priorSentinels) {
    const reread = R.rereadSentinels(censusEntries, priorSentinels)
    sentinelTypes = reread.types
    sentinels = reread.sentinels
  } else if (censusEntries) sentinelTypes = R.censusTypeTable(censusEntries)
} else {
  if (censusEntries && !args.typesFrom) sentinelTypes = R.censusTypeTable(censusEntries)
  if (sentinelRows.length === windows.sentinel.length) sentinels = R.readSentinels(sentinelRows, sentinelTypes)
}
const report = {
  referenceAt: new Date(nowSec * 1000).toISOString(),
  referenceFrom: args.at ? '--at' : 'run start',
  ranAt,
  finishedAt: new Date().toISOString(),
  dataset: Q.AUDIT_DATASET,
  capSeconds: args.cap,
  estimate,
  jobs,
  census: censusEntries,
  controls: censusEntries ? R.censusControls(censusEntries) : null,
  density: census.row && !numeric ? R.readDensity(census.row) : null,
  sentinelTypes,
  sentinels,
  censusMode: args.census,
  sentinelsFrom: sentinels && priorSentinels ? args.sentinelsFrom : null,
  raw: { census: census.row, sentinels: sentinelRows },
}

// Never overwrite a report: it is evidence that cost CPU-s to take. A free name
// is chosen, and the exclusive flag refuses one that appeared since.
const stem = R.reportFileStem(report.referenceAt, report.ranAt)
let base = null
for (let attempt = 0; base === null; attempt++) {
  const candidate = join(args.out, R.freeReportStem(stem, (name) => existsSync(join(args.out, name))))
  try {
    writeFileSync(`${candidate}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    base = candidate
  } catch (err) {
    if (err?.code !== 'EEXIST' || attempt >= 5) throw err
  }
}
writeFileSync(`${base}.md`, R.renderAuditMarkdown(report) + '\n', { flag: 'wx' })
console.log('')
console.log(`Wrote ${base}.json and ${base}.md`)
process.exit(jobs.every((j) => j.status === 'completed' && !j.error) ? 0 : 1)
