// Types for scripts/pack-lookalike.mjs, for src/cribl/packSamples.test.ts.
import type { Rng } from './pack-rng.mjs'

export interface AppProfile {
  app: string
  events: number
  share: number
  srcPrivate: number
  dstPrivate: number
  present: Record<string, number>
  numeric: Record<string, { p10: number; p50: number; p90: number; decimals: number }>
  categorical: Record<string, Record<string, number>>
}
export interface DemoProfile {
  totals: { events: number; files: number; eventsPerSecPerFile: number[]; eventsPerSec: number }
  fields: Record<string, { type: string | Record<string, number>; present: number }>
  apps: AppProfile[]
}
export type Event = Record<string, unknown>

export const STAMPED: readonly string[]
export const GENERATOR_NAME: string
export function lookalikeKit(opts: {
  profile: DemoProfile
  rng: (label: string) => Rng
  fnv1a: (s: string) => number
  keyOrder: readonly string[]
  webHosts: readonly string[]
  webCodes: readonly string[]
  asOfMs: number
}): {
  apps: { app: string; share: number; profile: AppProfile }[]
  lookalike(r: Rng, a: AppProfile, opts?: { force?: string[] }): Event
  coverage(r: Rng, already: Set<string>): Event[]
  dress(r: Rng, ev: Event): Event
  stamp(r: Rng, ev: Event, fileIndex: number, p: number): Event
  finishTypes(ev: Event): Event
}
