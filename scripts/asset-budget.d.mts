// Types for scripts/asset-budget.mjs, for vite.config.ts and src/assetBudget.test.ts.
import type { Plugin } from 'vite'

export type ChunkGraph = {
  chunks: Record<string, { isEntry: boolean; imports: string[]; dynamicImports: string[] }>
}
export type Size = { raw: number; gzip: number }
export type Measurement = {
  entry: { file: string } & Size
  initial: { files: string[] } & Size
  largestLazy: ({ file: string } & Size) | null
  total: { files: number; raw: number }
}
export type Metric = 'initialRaw' | 'initialGzip' | 'largestLazyRaw' | 'totalRaw'
export type Violation = { metric: Metric; actual: number; limit: number; delta: number; message: string }

export const METRICS: readonly Metric[]
export const GRAPH_PATH: string
export function chunkGraphPlugin(): Plugin
export function graphFromBundle(bundle: Record<string, unknown>): ChunkGraph
export function initialChunks(graph: ChunkGraph): string[]
export function measure(graph: ChunkGraph, read: (file: string) => Buffer): Measurement
export function compareToBudget(m: Measurement, budgets: Partial<Record<Metric, number>>): Violation[]
export function staleGraphProblems(graph: ChunkGraph, distJsFiles: string[]): string[]
export function report(m: Measurement, budgets: Record<Metric, number>): string
