// Types for scripts/fetch-release.mjs, for src/fetchRelease.test.ts.

export interface ReleaseTag {
  tag: string
  version: string
  staging: boolean
  rank: number[]
}
export interface GhResult {
  code: number
  stdout: string
  stderr: string
}
export type Gh = (args: string[]) => Promise<GhResult>

export interface FetchFs {
  copyFile(from: string, to: string): void
  rename(from: string, to: string): void
  rm(path: string): void
}

export const APP_NAME: string
export const NODE_FS: FetchFs
export const BUILD_DIR: string
export function parseReleaseTag(tag: unknown): ReleaseTag | null
export function assetNames(version: string): [string, string]
export function pickLatestRelease(releases: Array<{ tagName: string; isDraft?: boolean; isPrerelease?: boolean }>): ReleaseTag | null
export function readTarFile(tar: Buffer, wanted: string): Buffer | null
export function readBundlePackageJson(tgz: Uint8Array): Record<string, unknown>
export function checkBundle(file: string, pkg: Record<string, unknown> | null | undefined, expectedVersion: string): { ok: boolean; message: string }
export function parseArgs(argv: string[]): { tag: string | null } | { error: string }
export function runGh(args: string[]): Promise<GhResult>
export function fetchRelease(opts?: { tag?: string | null; gh?: Gh; buildDir?: string; tmp?: () => string; fs?: FetchFs }): Promise<{ code: number; lines: string[] }>
export function main(): Promise<void>
