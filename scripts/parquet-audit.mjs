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
//   --rows-per-hour <n>      the dataset's intake, for the estimate (default: D-10 s1, 1,050,992)
//   --cpu-per-1k <n>         billable CPU-s per 1,000 JSON rows, for the estimate (default 0.45)
//   --types-from <file.json> run the sentinel query with a prior report's census type table,
//                            instead of both forms for every unresolved field. The 60-minute
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
// 60-minute and a few 15-minute windows. The estimate is printed first, and
// nothing is submitted without --run: Cribl has no CPU cap, and the running-time
// cap bounds wall time only, so the approval has to be a person's, made on the
// printed figure.
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
  const out = { run: false, at: null, offsets: null, cap: 300, base: 'http://localhost:5173/capi', out: join(ROOT, '.dev', 'parquet-audit'), rowsPerHour: null, cpuPer1k: null, typesFrom: null }
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
    else if (a === '--cpu-per-1k') out.cpuPer1k = Number(next())
    else if (a === '--types-from') out.typesFrom = resolve(next())
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n'))
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!Number.isFinite(out.cap) || out.cap <= 0) throw new Error('--cap must be a positive number of seconds')
  if (out.offsets && out.offsets.some((h) => !Number.isFinite(h) || h < 0)) throw new Error('--offsets must be non-negative hours')
  return out
}

const args = parseArgs(process.argv.slice(2))
const startedMs = Date.now()
const nowSec = args.at ? Math.floor(Date.parse(args.at) / 1000) : Math.floor(startedMs / 1000)
if (!Number.isFinite(nowSec)) throw new Error(`--at ${args.at} is not a date`)
const windows = R.auditWindows(nowSec, args.offsets ? { sentinelOffsetsHours: args.offsets } : {})
const basis = {
  rowsPerHour: args.rowsPerHour ?? R.DEFAULT_COST_BASIS.rowsPerHour,
  cpuPer1kRows: args.cpuPer1k ?? R.DEFAULT_COST_BASIS.cpuPer1kRows,
}
const estimate = R.auditCostEstimate(windows, basis)

let sentinelTypes = Q.STATIC_FIELD_TYPES
let sentinelQuery = Q.SENTINEL_AUDIT_QUERY
if (args.typesFrom) {
  const prior = JSON.parse(readFileSync(args.typesFrom, 'utf8'))
  if (!prior.census) throw new Error(`${args.typesFrom} holds no census to take types from`)
  sentinelTypes = R.censusTypeTable(prior.census)
  sentinelQuery = Q.sentinelAuditQuery(sentinelTypes)
}

// ── The plan, always printed first ──────────────────────────────────────────
console.log('Phase 8.0b / 8.0c audit — dataset "%s" (JSON), pinned: %s', Q.AUDIT_DATASET, Q.AUDIT_PIN)
console.log('')
console.log('Jobs, in order:')
console.log(`  1. 8.0b census + density   ${windows.census.label}`)
windows.sentinel.forEach((w, i) => console.log(`  ${i + 2}. 8.0c sentinels          ${w.label}`))
console.log(`Running-time cap per job: ${args.cap} s. Sentinel types: ${args.typesFrom ? `from ${args.typesFrom}` : 'static (both forms where unknown)'}.`)
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
const census = await runJob('8.0b census + density', windows.census, Q.TYPE_DENSITY_QUERY)
jobs.push(census.job)
const sentinelRows = []
for (const w of windows.sentinel) {
  const r = await runJob('8.0c sentinels', w, sentinelQuery)
  jobs.push(r.job)
  if (r.row) sentinelRows.push(r.row)
}

const censusEntries = census.row ? R.readTypeCensus(census.row) : null
if (censusEntries && !args.typesFrom) sentinelTypes = R.censusTypeTable(censusEntries)
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
  density: census.row ? R.readDensity(census.row) : null,
  sentinelTypes,
  sentinels: sentinelRows.length === windows.sentinel.length ? R.readSentinels(sentinelRows, sentinelTypes) : null,
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
