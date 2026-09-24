// The asset-size budget gate (scripts/asset-budget.mjs), tested on a fixture
// chunk graph rather than on a real build: the arithmetic and the walk are what
// can be wrong, and a real build's sizes move with every commit.
//
// What this does NOT prove: that the committed budgets are the right numbers,
// or that the graph `npm run build` writes describes the dist/ beside it. The
// script checks the second at run time (every dist JS file must be in the graph
// and every graph file on disk); the first is a human decision recorded in
// asset-budget.json.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  chunkGraphPlugin,
  compareToBudget,
  GRAPH_PATH,
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
      unbundledJs: [],
    })
  })

  it('records a .js file the bundle emits as an asset, not a chunk, as unbundled', () => {
    const g = graphFromBundle({
      'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', isEntry: true, imports: [], dynamicImports: [] },
      'assets/worker.js': { type: 'asset', fileName: 'assets/worker.js' },
      'assets/index.css': { type: 'asset', fileName: 'assets/index.css' },
    })
    expect(g.unbundledJs).toEqual(['assets/worker.js'])
  })
})

// A scratch project root: the plugin and the CLI both work from a root, so each
// test gets its own and nothing touches this checkout's dist/ or node_modules/.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'gno-asset-budget-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}
function put(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}
type PluginHooks = {
  configResolved(c: { root: string; publicDir: string }): void
  writeBundle(o: unknown, b: Record<string, unknown>): void
}
const ONE_CHUNK = {
  'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', isEntry: true, imports: [], dynamicImports: [] },
}

describe('chunkGraphPlugin', () => {
  it('lists the .js files Vite copies from public/, which never pass through the bundle', () => {
    const { dir, done } = scratch()
    try {
      put(dir, 'public/foo.js', 'x')
      put(dir, 'public/sub/bar.js', 'y')
      put(dir, 'public/icon.svg', '<svg/>')
      const p = chunkGraphPlugin() as unknown as PluginHooks
      p.configResolved({ root: dir, publicDir: join(dir, 'public') })
      p.writeBundle({}, ONE_CHUNK)
      const g = JSON.parse(readFileSync(join(dir, GRAPH_PATH), 'utf8'))
      expect(g.unbundledJs).toEqual(['foo.js', 'sub/bar.js'])
    } finally { done() }
  })

  it('copes with no public directory at all (publicDir: false resolves to "")', () => {
    const { dir, done } = scratch()
    try {
      const p = chunkGraphPlugin() as unknown as PluginHooks
      p.configResolved({ root: dir, publicDir: '' })
      p.writeBundle({}, ONE_CHUNK)
      expect(JSON.parse(readFileSync(join(dir, GRAPH_PATH), 'utf8')).unbundledJs).toEqual([])
    } finally { done() }
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

  it('accepts a dist .js file the graph records as unbundled (a public/ copy)', () => {
    const g = { ...GRAPH, unbundledJs: ['foo.js'] }
    expect(staleGraphProblems(g, [...Object.keys(CONTENT), 'foo.js'])).toEqual([])
  })

  it('says an unknown dist file was not produced by the bundler, rather than blaming a stale build', () => {
    const p = staleGraphProblems(GRAPH, [...Object.keys(CONTENT), 'foo.js'])
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/foo\.js is in dist\/ but was not produced by the bundler/)
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

  it('CI runs the budget after the build AND after the tests, so an over-budget PR still shows its test results', () => {
    const steps = stepsOf(workflow('ci.yml'))
    const build = runIndex(steps, 'npm run build')
    const test = runIndex(steps, 'npm test --if-present')
    const budget = runIndex(steps, 'npm run assets:budget')
    expect(build, 'build step').toBeGreaterThan(-1)
    expect(test, 'test step').toBeGreaterThan(build)
    expect(budget, 'budget step').toBeGreaterThan(test)
  })

  it('CI runs the budget as a live, blocking step', () => {
    expectBlockingStep(workflow('ci.yml'), 'npm run assets:budget')
  })

  it('the release workflow runs the budget after `npm run package` (which builds), as a blocking step', () => {
    const src = workflow('release.yml')
    const steps = stepsOf(src)
    const pkg = steps.findIndex((s) => /^npm run package(\s|$)/.test(s.run ?? ''))
    expect(pkg, 'package step').toBeGreaterThan(-1)
    expect(runIndex(steps, 'npm run assets:budget'), 'budget step').toBeGreaterThan(pkg)
    expectBlockingStep(src, 'npm run assets:budget')
  })

  it('`npm run assets:budget` runs the gate unconditionally — no argv-vs-module-URL guard that can fail open', () => {
    const cli = readFileSync(join(ROOT, cliFile()), 'utf8')
    expect(cli).not.toMatch(/process\.argv|import\.meta\.url/)
    expect(cli).toMatch(/^main\(\)\s*$/m)
  })
})

function cliFile() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const m = /^node (\S+)$/.exec(pkg.scripts['assets:budget'])
  if (!m) throw new Error('assets:budget is not `node <file>`')
  return m[1]
}

describe('the CLI, end to end on a scratch build', () => {
  const run = (cwd: string) => spawnSync(process.execPath, [join(ROOT, cliFile())], { cwd, encoding: 'utf8' })
  const BUDGETS = { budgets: { initialRaw: 10_000, initialGzip: 10_000, largestLazyRaw: 10_000, totalRaw: 10_000 } }
  const scratchBuild = (graph: object) => {
    const s = scratch()
    put(s.dir, 'asset-budget.json', JSON.stringify(BUDGETS))
    put(s.dir, 'dist/assets/index.js', 'a'.repeat(100))
    put(s.dir, 'dist/foo.js', 'b'.repeat(50))
    put(s.dir, GRAPH_PATH, JSON.stringify(graph))
    return s
  }
  const CHUNKS = { 'assets/index.js': { isEntry: true, imports: [], dynamicImports: [] } }

  it('fails, loudly, when there is no build to measure', () => {
    const { dir, done } = scratch()
    try {
      const r = run(dir)
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/no build to measure/)
    } finally { done() }
  })

  it('measures a build whose dist/ also holds a .js file copied from public/', () => {
    const { dir, done } = scratchBuild({ chunks: CHUNKS, unbundledJs: ['foo.js'] })
    try {
      const r = run(dir)
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/within budget/)
    } finally { done() }
  })

  it('fails on a dist .js file nothing accounts for, without claiming a rebuild will fix it', () => {
    const { dir, done } = scratchBuild({ chunks: CHUNKS })
    try {
      const r = run(dir)
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/foo\.js is in dist\/ but was not produced by the bundler/)
      expect(r.stderr).not.toMatch(/rebuild with/)
    } finally { done() }
  })
})

// ── Workflow steps, read as steps rather than as text ──────────────────────
// A text search for `run: npm run assets:budget` still matches once the line is
// commented out, and says nothing about a `continue-on-error: true` or an `if:`
// on the step — each of which leaves a green CI that never enforced the gate.
// This is not a YAML parser; it reads the one shape these workflows use (a
// `steps:` list of `- key: value` items).

type Step = { keys: Record<string, string>; run?: string }

function workflow(name: string) {
  return readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')
}

function codeLines(src: string) {
  return src.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
}
const indentOf = (l: string) => l.length - l.trimStart().length
const isStepsLine = (l: string) => /^\s*steps:\s*$/.test(l)

function stepsOf(src: string): Step[] {
  const lines = codeLines(src)
  const at = lines.findIndex(isStepsLine)
  if (at < 0) throw new Error('workflow has no steps: list')
  const base = indentOf(lines[at])
  const steps: Step[] = []
  let dash = -1
  for (const l of lines.slice(at + 1)) {
    const ind = indentOf(l)
    if (ind <= base) break
    const item = /^\s*-\s+(.*)$/.exec(l)
    if (item && (dash < 0 || ind === dash)) {
      dash = ind
      steps.push({ keys: {} })
    }
    const body = item && ind === dash ? item[1] : l.trim()
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(body)
    // A key belongs to the step only at the step's own level (the dash, or the
    // column after it); deeper lines are a `with:` map or a `run: |` body.
    if (kv && (ind === dash || ind === dash + 2)) steps[steps.length - 1].keys[kv[1]] = kv[2]
  }
  for (const s of steps) if ('run' in s.keys) s.run = s.keys.run.trim()
  return steps
}

function runIndex(steps: Step[], command: string) {
  return steps.findIndex((s) => s.run === command)
}

/** The step exists exactly once, carries no key but `run`, and its job cannot swallow its failure. */
function expectBlockingStep(src: string, command: string) {
  const hits = stepsOf(src).filter((s) => s.run === command)
  expect(hits, `one \`run: ${command}\` step`).toHaveLength(1)
  expect(Object.keys(hits[0].keys), `${command} step keys`).toEqual(['run'])
  const lines = codeLines(src)
  const head = lines.slice(0, lines.findIndex(isStepsLine))
  expect(head.filter((l) => /^\s*continue-on-error:/.test(l)), 'job-level continue-on-error').toEqual([])
}
