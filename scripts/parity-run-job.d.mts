// Types for scripts/parity-run-job.mjs, for src/cribl/parityRunJob.test.ts.
import type { Row } from '../src/cribl/parity'
import type { ParityJobRecord, RunWindow } from '../src/cribl/parityRun'
import type { JobDeps } from './parquet-audit-job.mjs'

export const DEFAULT_MAX_ROWS: number
export function runParityJob(
  deps: JobDeps,
  purpose: string,
  window: RunWindow,
  query: string,
  opts?: { maxRows?: number },
): Promise<{ job: ParityJobRecord; rows: Row[] | null }>

export interface ReportFs {
  existsSync(path: string): boolean
  writeFileSync(path: string, data: string, opts: { flag: 'wx' }): void
}
export function writeReportOnce(opts: {
  dir: string
  stem: string
  build: (stem: string) => { json: string; md: string }
  fs?: ReportFs
  max?: number
}): string
