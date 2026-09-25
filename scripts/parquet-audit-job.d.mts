// Types for scripts/parquet-audit-job.mjs, for src/cribl/parquetAuditJob.test.ts.
import type { AuditJob, AuditWindow, Row } from '../src/cribl/parquetAuditReport'

export type Api = (method: string, path: string, body?: unknown) => Promise<string>
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export const SEARCH_GROUP: string
export const RETRY_DELAYS_MS: readonly number[]
export function isRetryable(status: number): boolean
export class HttpError extends Error {
  status: number
  constructor(method: string, path: string, status: number, text: string)
}
export function makeApi(deps: { base: string; fetch: FetchLike; sleep: (ms: number) => Promise<void> }): Api
export const COST_READ_DELAYS_MS: readonly number[]
export function readBilledCpu(
  api: Api,
  sleep: (ms: number) => Promise<void>,
  path: string,
  delays?: readonly number[],
): Promise<{ value: number | null; note: string }>
export type JobDeps = { api: Api; sleep: (ms: number) => Promise<void>; now: () => number; log: (line: string) => void; cap: number }
export function sendCancel(api: Api, path: string): Promise<string>
export function runSearchJob<T>(
  deps: JobDeps,
  purpose: string,
  window: AuditWindow,
  query: string,
  opts: { limit: number; accept: (rows: Row[], header: Row | null) => T },
): Promise<{ job: AuditJob; value: T | null }>
export function runAuditJob(
  deps: { api: Api; sleep: (ms: number) => Promise<void>; now: () => number; log: (line: string) => void; cap: number },
  purpose: string,
  window: AuditWindow,
  query: string,
): Promise<{ job: AuditJob; row: Row | null }>
