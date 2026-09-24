// The asset-size budget gate (scripts/asset-budget.mjs), tested on a fixture
// chunk graph rather than on a real build: the arithmetic and the walk are what
// can be wrong, and a real build's sizes move with every commit.
//
// What this does NOT prove: that the committed budgets are the right numbers,
// or that the graph `npm run build` writes describes the dist/ beside it. The
// script checks the second at run time (every dist JS file must be in the graph
// and every graph file on disk); the first is a human decision recorded in
// asset-budget.json.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  compareToBudget,
  graphFromBundle,
  initialChunks,
  measure,
  staleGraphProblems,
} from '../scripts/asset-budget.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// index → (react, shared) statically; shared → react; index ⇢ TabA, TabB lazily;
// TabA → shared (already initial), TabB → heavy (lazy-only).
const GRAPH = {
  chunks: {
    'assets/index.js': { isEntry: true, imports: ['assets/react.js', 'assets/shared.js'], dynamicImports: ['assets/TabA.js', 'assets/TabB.js'] },
    'assets/react.js': { isEntry: false, imports: [], dynamicImports: [] },
    'assets/shared.js': { isEntry: false, imports: ['assets/react.js'], dynamicImports: [] },
    'assets/TabA.js': { isEntry: false, imports: ['assets/shared.js'], dynamicImports: [] },
    'assets/TabB.js': { isEntry: false, imports: ['assets/heavy.js'], dynamicImports: [] },
    'assets/heavy.js': { isEntry: false, imports: [], dynamicImports: [] },
  },
}

// Contents chosen so raw and gzip sizes differ in a known direction: repetitive
// text compresses far below its raw size.
const CONTENT: Record<string, string> = {
  'assets/index.js': 'a'.repeat(1000),
  'assets/react.js': 'b'.repeat(200),
  'assets/shared.js': 'c'.repeat(300),
  'assets/TabA.js': 'd'.repeat(50),
  'assets/TabB.js': 'e'.repeat(400),
  'assets/heavy.js': 'f'.repeat(600),
}
const read = (f: string) => Buffer.from(CONTENT[f])
const gz = (f: string) => gzipSync(read(f)).length

describe('graphFromBundle', () => {
  it('keeps chunks only, with their static and dynamic imports', () => {
    const g = graphFromBundle({
      'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', isEntry: true, isDynamicEntry: false, imports: ['assets/r.js'], dynamicImports: ['assets/t.js'] },
      'assets/r.js': { type: 'chunk', fileName: 'assets/r.js', isEntry: false, isDynamicEntry: false, imports: [], dynamicImports: [] },
      'assets/index.css': { type: 'asset', fileName: 'assets/index.css' },
    })
    expect(g).toEqual({
      chunks: {
        'assets/index.js': { isEntry: true, imports: ['assets/r.js'], dynamicImports: ['assets/t.js'] },
        'assets/r.js': { isEntry: false, imports: [], dynamicImports: [] },
      },
    })
  })
})

describe('initialChunks', () => {
  it('is the entry plus the transitive closure of its STATIC imports, never a dynamic one', () => {
    expect(initialChunks(GRAPH)).toEqual(['assets/index.js', 'assets/react.js', 'assets/shared.js'])
  })

  it('follows static imports more than one level deep', () => {
    const g = { chunks: {
      'e.js': { isEntry: true, imports: ['a.js'], dynamicImports: [] },
      'a.js': { isEntry: false, imports: ['b.js'], dynamicImports: [] },
      'b.js': { isEntry: false, imports: [], dynamicImports: [] },
    } }
    expect(initialChunks(g)).toEqual(['a.js', 'b.js', 'e.js'])
  })

  it('refuses a graph with no entry rather than measuring nothing as zero', () => {
    expect(() => initialChunks({ chunks: { 'a.js': { isEntry: false, imports: [], dynamicImports: [] } } })).toThrow(/no entry/)
  })

  it('refuses an import that names a chunk the graph does not have', () => {
    expect(() => initialChunks({ chunks: { 'e.js': { isEntry: true, imports: ['gone.js'], dynamicImports: [] } } })).toThrow(/gone\.js/)
  })
})

describe('measure', () => {
  const m = measure(GRAPH, read)

  it('sums raw and gzip over the initial set', () => {
    expect(m.initial.files).toEqual(['assets/index.js', 'assets/react.js', 'assets/shared.js'])
    expect(m.initial.raw).toBe(1500)
    expect(m.initial.gzip).toBe(gz('assets/index.js') + gz('assets/react.js') + gz('assets/shared.js'))
    expect(m.initial.gzip).toBeLessThan(m.initial.raw)
  })

  it('reports the entry chunk on its own', () => {
    expect(m.entry).toEqual({ file: 'assets/index.js', raw: 1000, gzip: gz('assets/index.js') })
  })

  it('picks the largest chunk NOT in the initial set as the largest lazy one', () => {
    // index.js is larger, but it is initial; heavy.js is lazy-only.
    expect(m.largestLazy).toEqual({ file: 'assets/heavy.js', raw: 600, gzip: gz('assets/heavy.js') })
  })

  it('totals every chunk', () => {
    expect(m.total).toEqual({ files: 6, raw: 2550 })
  })
})

describe('compareToBudget', () => {
  const m = measure(GRAPH, read)
  const exact = { initialRaw: 1500, initialGzip: m.initial.gzip, largestLazyRaw: 600, totalRaw: 2550 }

  it('passes at exactly the budget', () => {
    expect(compareToBudget(m, exact)).toEqual([])
  })

  it('fails one byte over, naming the chunks and the delta', () => {
    const v = compareToBudget(m, { ...exact, initialRaw: 1499 })
    expect(v).toHaveLength(1)
    expect(v[0].metric).toBe('initialRaw')
    expect(v[0].delta).toBe(1)
    expect(v[0].message).toMatch(/assets\/index\.js/)
    expect(v[0].message).toMatch(/\+1 B/)
  })

  it('names the lazy chunk that broke the lazy budget', () => {
    const v = compareToBudget(m, { ...exact, largestLazyRaw: 500 })
    expect(v.map((x) => x.metric)).toEqual(['largestLazyRaw'])
    expect(v[0].message).toMatch(/assets\/heavy\.js/)
    expect(v[0].message).toMatch(/\+100 B/)
  })

  it('checks the gzip and total budgets too', () => {
    const v = compareToBudget(m, { ...exact, initialGzip: m.initial.gzip - 1, totalRaw: 2549 })
    expect(v.map((x) => x.metric)).toEqual(['initialGzip', 'totalRaw'])
  })

  it('refuses a budget file that is missing a limit, rather than skipping it', () => {
    const { totalRaw: _omit, ...partial } = exact
    void _omit
    expect(() => compareToBudget(m, partial)).toThrow(/totalRaw/)
  })
})

describe('staleGraphProblems', () => {
  it('is empty when the graph and dist/ list the same JS files', () => {
    expect(staleGraphProblems(GRAPH, Object.keys(CONTENT))).toEqual([])
  })

  it('names a dist file the graph does not know, and a graph file dist lacks', () => {
    const onDisk = Object.keys(CONTENT).filter((f) => f !== 'assets/TabA.js').concat('assets/old-abc.js')
    const p = staleGraphProblems(GRAPH, onDisk)
    expect(p.join('\n')).toMatch(/assets\/old-abc\.js/)
    expect(p.join('\n')).toMatch(/assets\/TabA\.js/)
  })
})

describe('the wiring', () => {
  it('the committed budget sets every limit to a positive whole number of bytes', () => {
    const b = JSON.parse(readFileSync(join(ROOT, 'asset-budget.json'), 'utf8')) as { budgets: Record<string, unknown> }
    for (const k of ['initialRaw', 'initialGzip', 'largestLazyRaw', 'totalRaw']) {
      expect(Number.isInteger(b.budgets[k]) && (b.budgets[k] as number) > 0, k).toBe(true)
    }
  })

  it('vite.config.ts registers the plugin that writes the chunk graph', () => {
    const src = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    expect(src).toMatch(/plugins:\s*\[[^\]]*chunkGraphPlugin\(\)/)
  })

  it('CI runs the budget after the build', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const build = ci.indexOf('run: npm run build')
    const budget = ci.indexOf('run: npm run assets:budget')
    expect(build).toBeGreaterThan(-1)
    expect(budget).toBeGreaterThan(build)
  })
})
