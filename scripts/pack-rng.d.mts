// Types for scripts/pack-rng.mjs, for src/cribl/packSamples.test.ts.
export interface Rng {
  next(): number
  int(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
  weighted<T>(pairs: ReadonlyArray<readonly [T, number]>): T
  lognormal(median: number, sigma: number): number
  hex(n: number): string
  shuffle<T>(arr: readonly T[]): T[]
}
export function fnv1a(s: string): number
export function seededRng(seed: number): (label: string) => Rng
