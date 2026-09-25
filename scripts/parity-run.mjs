// Phase 8.0e: the parity-evidence run. For routing entries (src/cribl/routing/
// table.ts ROUTES), compare each text on gigamon_ami (JSON) with the same text
// on gigamon_ami_pq (Parquet) over three or more windows, and write a report
// whose per-entry `evidence` is exactly what the table's `evidence` field takes.
//
//   npm run parity:run                       print the plan and the cost floor; submits NOTHING
//   npm run parity:run -- --run              submit, poll, compare, and write the report
//
// Options:
//   --entries a,b             routing entry ids to consider (default: every entry)
//   --force-ineligible        also run entries the type table makes ineligible — to MEASURE them.
//                             Their results are marked measurement-only and never carry evidence.
//   --at <ISO time>           the reference "now" (default: the current time). The newest window
//                             ends on a 5-minute edge at least 360 s before it. A time later than
//                             the real clock is refused before anything is billed.
//   --offsets 0,6,12          hours before the newest window at which each window ends (≥ 3,
//                             each window starting in a different UTC hour)
//   --minutes 15              window length, a whole number of 5-minute buckets
//   --cap <seconds>           running-time cap prefixed onto each job (default 300)
//   --max-rows <n>            rows read per job (default 10000); a read short of the job's
//                             totalEventCount is not compared
//   --base <url>              API base (default http://localhost:5173/capi, the `npm run dev` proxy)
//   --out <dir>               where the report goes (default .dev/parity-run, gitignored)
//   --rows-per-hour <n>       the dataset's intake, for the floor (default: the audit's measured run)
//   --cpu-per-1k <n>          JSON CPU-s per 1,000 rows, for the floor (default: the audit's sentinels)
//
// WHAT IT NEVER DOES. It never edits src/cribl/routing/table.ts: moving a query
// is a reviewed change a person makes, pasting the evidence this report prints.
// It never records a --force-ineligible result, a failed entry, or one short of
// three passing windows at different UTC hours as evidence.
//
// WHAT IT NEEDS. `npm run dev` running with `.dev/cribl.json` in place: the Vite
// proxy at /capi injects the OAuth token. This script handles no credential.
//
// WHAT IT SPENDS, AND WHY --run. Every window costs a completeness check on
// cribl_metrics (cost unmeasured), a control count on each dataset, and every
// selected text on each dataset. The floor printed first is from one measured
// JSON shape; the Parquet half is an assumption (no Parquet coefficient has been
// measured). Nothing is submitted without --run: Cribl has no CPU cap, and the
// running-time cap bounds wall time only, so the approval is a person's, made on
// the printed figure.
//
// Reports are never overwritten: the name carries the reference minute and the
// run's start second, a clash gets -2, -3, …, and both files are opened with
// the exclusive flag. They go to .dev/ by default because they carry a tenant's
// figures; to use one as evidence, keep it where its `reportPath` says (or
// correct `report` in the pasted object to where it is kept).
//
// Built 2026-09-25 (feat/phase8-parity-runner). It has never run against a Leader.

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import nodeModule from 'node:module'

// src/ imports are extensionless; Node strips the types but wants the real file name.
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
const P = await import(pathToFileURL(join(ROOT, 'src/cribl/parityRun.ts')).href)
const J = await import(pathToFileURL(join(ROOT, 'scripts/parquet-audit-job.mjs')).href)
const W = await import(pathToFileURL(join(ROOT, 'scripts/parity-run-job.mjs')).href)

function parseArgs(argv) {
  const out = { run: false, entries: null, forceIneligible: false, at: null, offsets: null, minutes: null, cap: 300, maxRows: W.DEFAULT_MAX_ROWS, base: 'http://localhost:5173/capi', out: join(ROOT, '.dev', 'parity-run'), rowsPerHour: null, cpuPer1k: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--run') out.run = true
    else if (a === '--entries') out.entries = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--force-ineligible') out.forceIneligible = true
    else if (a === '--at') out.at = next()
    else if (a === '--offsets') out.offsets = next().split(',').map((s) => Number(s.trim()))
    else if (a === '--minutes') out.minutes = Number(next())
    else if (a === '--cap') out.cap = Number(next())
    else if (a === '--max-rows') out.maxRows = Number(next())
    else if (a === '--base') out.base = next().replace(/\/$/, '')
    else if (a === '--out') out.out = resolve(next())
    else if (a === '--rows-per-hour') out.rowsPerHour = Number(next())
    else if (a === '--cpu-per-1k') out.cpuPer1k = Number(next())
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
      console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).join('\n'))
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  for (const [flag, v] of [['--cap', out.cap], ['--max-rows', out.maxRows], ['--rows-per-hour', out.rowsPerHour], ['--cpu-per-1k', out.cpuPer1k]]) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error(`${flag} must be a positive number`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const startedMs = Date.now()
const nowSec = args.at ? Math.floor(Date.parse(args.at) / 1000) : Math.floor(startedMs / 1000)
if (!Number.isFinite(nowSec)) throw new Error(`--at ${args.at} is not a date`)

// Everything below up to --run is free: plan, windows, floor. Each refuses before anything is billed.
const windows = P.parityRunWindows(nowSec, { minutes: args.minutes ?? undefined, offsetsHours: args.offsets ?? undefined, clockSec: Math.floor(startedMs / 1000) })
const plan = P.planEntries({ only: args.entries, forceIneligible: args.forceIneligible })
const basis = {
  rowsPerHour: args.rowsPerHour ?? P.DEFAULT_PARITY_COST_BASIS.rowsPerHour,
  cpuPer1kRows: args.cpuPer1k ?? P.DEFAULT_PARITY_COST_BASIS.cpuPer1kRows,
}
const estimate = P.parityCostFloor(windows, plan.selected, basis)

console.log('Phase 8.0e parity run — "%s" (JSON) against "%s" (Parquet)', P.PARITY_JSON_DATASET, P.PARITY_PARQUET_DATASET)
console.log('This run never edits src/cribl/routing/table.ts.')
console.log('')
console.log('Windows (each checked for completeness first; a window not proven complete is skipped):')
for (const w of windows) console.log(`  ${w.label}`)
console.log('')
console.log(`Entries to run (${plan.selected.length}):`)
if (!plan.selected.length) console.log('  none')
for (const e of plan.selected) {
  console.log(`  ${e.id} — ${e.mode === 'evidence' ? 'eligible: may earn evidence' : 'MEASUREMENT ONLY (--force-ineligible): never evidence'}; ${e.queries.length} text${e.queries.length === 1 ? '' : 's'}`)
}
console.log('')
console.log(`Not run (${plan.refused.length}):`)
for (const r of plan.refused) console.log(`  ${r.id}: ${r.why}`)
console.log('')
if (!plan.selected.length) {
  console.log('Nothing to run: no entry is eligible under the current type table (src/data/fieldTypes.ts).')
  console.log('Pass --force-ineligible to measure ineligible entries anyway; their results are never evidence.')
  process.exit(0)
}
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
const ranAt = new Date().toISOString()
console.log('Submitting, one job at a time:')
const run = await P.executeParityRun(windows, plan.selected, {
  submit: (purpose, w, query) => W.runParityJob(deps, purpose, w, query, { maxRows: args.maxRows }),
  nowSec: () => Math.floor(Date.now() / 1000),
  log: (line) => console.log(line),
})
const finishedAt = new Date().toISOString()

const stem = W.writeReportOnce({
  dir: args.out,
  stem: P.parityReportStem(new Date(nowSec * 1000).toISOString(), ranAt),
  build: (s) => {
    const reportPath = relative(ROOT, join(args.out, `${s}.json`)).replace(/\\/g, '/')
    const report = P.buildParityReport(run, {
      referenceAt: new Date(nowSec * 1000).toISOString(),
      referenceFrom: args.at ? '--at' : 'run start',
      ranAt,
      finishedAt,
      reportPath,
      capSeconds: args.cap,
      estimate,
      refused: plan.refused,
    })
    return { json: JSON.stringify(report, null, 2) + '\n', md: P.renderParityMarkdown(report) + '\n' }
  },
})
console.log('')
console.log(`Wrote ${join(args.out, stem)}.json and .md`)
process.exit(run.jobs.every((j) => j.status === 'completed' && !j.error) ? 0 : 1)
