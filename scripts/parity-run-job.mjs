// The parity runner's two side effects, split out of scripts/parity-run.mjs so
// they can be tested: one Search job read to its last row, and one report
// written without ever replacing another. This module never calls fetch
// itself; the runner hands `makeApi` its fetch, the tests hand it a stub.
//
// The job loop is scripts/parquet-audit-job.mjs's `runSearchJob`, so the rules
// the audit's tests hold hold here too: a job POST is never retried (a retry
// after a lost answer would submit, and bill, a second job); reads are retried
// on 429/5xx; a job whose poll or results read fails while it may still be
// running is cancelled, and the failure and the cancel are recorded on it.

import { existsSync as fsExists, writeFileSync as fsWrite } from 'node:fs'
import { join } from 'node:path'
import { runSearchJob } from './parquet-audit-job.mjs'

/** Rows read per job. A panel query returns at most a few hundred; a trend, one per minute. */
export const DEFAULT_MAX_ROWS = 10000

/**
 * Run one job and read ALL its rows. Answers `{ job, rows }`; `rows` is null
 * when no complete answer was read — a failed job, or a read that came back
 * short of the header's `totalEventCount` (a truncated read is never compared:
 * the missing rows are exactly the ones a top-N or a group could differ in).
 */
export async function runParityJob(deps, purpose, window, query, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const { job, value } = await runSearchJob(deps, purpose, window, query, {
    limit: maxRows,
    accept: (rows, header) => {
      const total = header?.totalEventCount
      if (typeof total === 'number' && total > rows.length) {
        throw new Error(`read ${rows.length} of ${total} rows (--max-rows ${maxRows}); a partial answer is not compared`)
      }
      return rows
    },
  })
  return { job, rows: value }
}

/**
 * Write `<dir>/<stem>.json` and `.md` without ever replacing a file: the first
 * of `stem`, `stem-2`, … for which neither exists, each written with the
 * exclusive flag, so a file that appeared since the check is refused rather
 * than overwritten. `build(stemChosen)` makes both texts, because the report
 * names its own path in every evidence object it carries.
 *
 * Answers the stem written. `fs` is for tests.
 */
export function writeReportOnce({ dir, stem, build, fs = { existsSync: fsExists, writeFileSync: fsWrite }, max = 99 }) {
  for (let i = 1; i <= max; i++) {
    const s = i === 1 ? stem : `${stem}-${i}`
    const json = join(dir, `${s}.json`)
    const md = join(dir, `${s}.md`)
    if (fs.existsSync(json) || fs.existsSync(md)) continue
    const out = build(s)
    try {
      fs.writeFileSync(json, out.json, { flag: 'wx' })
    } catch (err) {
      if (err?.code === 'EEXIST') continue
      throw err
    }
    fs.writeFileSync(md, out.md, { flag: 'wx' })
    return s
  }
  throw new Error(`no free report name for ${stem} after ${max} tries`)
}
