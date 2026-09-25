// Types for scripts/check-pack-release.mjs, for src/cribl/packReleaseCheck.test.ts.

export interface ReleaseFacts {
  published: boolean
  sha256: string | null
  version: string
  url: string
}
export type ReleaseCheckPlan =
  | { skip: true; message: string }
  | { skip: false; url: string; expected: string; version: string }
  | { skip: false; error: string }

export interface FetchLike {
  (url: string, init?: { redirect?: 'follow' }): Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>
}
export interface DownloadOptions {
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  log?: (line: string) => void
}

export const ATTEMPTS: number
export const RETRY_PAUSE_MS: number
export function sha256Hex(bytes: Uint8Array): string
export function releaseCheckPlan(facts: ReleaseFacts): ReleaseCheckPlan
export function compareDigest(expected: string, actual: string): { ok: boolean; message: string }
export function retryableStatus(status: number): boolean
export function download(url: string, opts?: DownloadOptions): Promise<{ status: number; bytes?: Buffer } | { error: string }>
export function checkPackRelease(facts: ReleaseFacts, opts?: Omit<DownloadOptions, 'log'>): Promise<{ code: number; lines: string[] }>
export function main(): Promise<void>
