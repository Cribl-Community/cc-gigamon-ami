// The asset-size budget: fails when the JavaScript a first page load downloads
// grows past the limits in asset-budget.json.
//
//   npm run build && npm run assets:budget
//
// WHY. Route-level code splitting took the entry chunk from 1,186 kB to 835 kB.
// Nothing stops one static import of a heavy module in the shell from putting
// all of it back, and the build only prints a warning past 500 kB — which it
// already prints today, so nobody would see it change. This gate is that
// difference turned into a red CI step.
//
// WHAT IT MEASURES, all JavaScript, sizes in bytes as written to dist/:
//   initialRaw / initialGzip  the entry chunk plus every chunk it reaches by
//                             STATIC import — what index.html loads before the
//                             first tab can render (the entry <script> and its
//                             <link rel="modulepreload"> siblings)
//   largestLazyRaw            the biggest chunk NOT in that set — one lazy tab
//                             that grows without bound is the next regression
//   totalRaw                  every JS chunk together
// gzip is Node's zlib at its default level. It approximates the transfer size,
// it is not the transfer size, and it does not match Vite's printed report
// exactly (entry chunk at e728bb7: 254.23 kB here, 256.27 kB in Vite's table).
// The budget is set against this script's own figure, so the two never mix.
//
// WHERE THE CHUNK GRAPH COMES FROM. `chunkGraphPlugin()` in vite.config.ts
// writes the bundler's own chunk graph to node_modules/.tmp/asset-graph.json at
// the end of `vite build`. It is not Vite's `build.manifest`, on purpose: that
// file is written INTO dist/, and dist/ is copied verbatim into the app package
// (scripts/pkgutil.mjs), so enabling it would ship a new file to every install.
// This writes nothing into dist/.
//
// Because the graph lives outside dist/, it could describe a different build
// than the one beside it. So before measuring, every .js file in dist/ must be
// in the graph and every graph file must be on disk — a mismatch fails the gate
// rather than measuring the wrong thing.
//
// WHAT IT DOES NOT MEASURE: CSS, fonts, images, and anything the app fetches at
// run time. Nor does it prove a budget is the right number — that is a human
// decision, recorded with its measurement in asset-budget.json.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

export const METRICS = /** @type {const} */ (['initialRaw', 'initialGzip', 'largestLazyRaw', 'totalRaw'])

const LABELS = {
  initialRaw: 'initial JS (entry + static imports), raw',
  initialGzip: 'initial JS (entry + static imports), gzip',
  largestLazyRaw: 'largest lazy JS chunk, raw',
  totalRaw: 'total JS, raw',
}

/** The Rollup/Rolldown output bundle → { chunks: { fileName: { isEntry, imports, dynamicImports } } }. */
export function graphFromBundle(bundle) {
  const chunks = {}
  for (const item of Object.values(bundle)) {
    if (item.type !== 'chunk') continue
    chunks[item.fileName] = {
      isEntry: Boolean(item.isEntry),
      imports: [...item.imports],
      dynamicImports: [...item.dynamicImports],
    }
  }
  return { chunks }
}

/** Where `vite build` leaves the chunk graph, relative to the project root. */
export const GRAPH_PATH = join('node_modules', '.tmp', 'asset-graph.json')

/**
 * The Vite plugin that writes the chunk graph after `vite build` writes dist/.
 * `writeBundle` never runs under `vite dev`, and it writes nothing into dist/.
 */
export function chunkGraphPlugin() {
  let root = process.cwd()
  return {
    name: 'gno-chunk-graph',
    apply: 'build',
    configResolved(config) { root = config.root },
    writeBundle(_options, bundle) {
      const out = join(root, GRAPH_PATH)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(graphFromBundle(bundle), null, 2) + '\n')
    },
  }
}

/** Entry chunks plus the transitive closure of their static imports, sorted. */
export function initialChunks(graph) {
  const entries = Object.keys(graph.chunks).filter((f) => graph.chunks[f].isEntry)
  if (entries.length === 0) throw new Error('asset budget: the chunk graph has no entry chunk')
  const seen = new Set()
  const stack = [...entries]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    const c = graph.chunks[f]
    if (!c) throw new Error(`asset budget: the chunk graph imports ${f}, which it does not contain`)
    seen.add(f)
    stack.push(...c.imports)
  }
  return [...seen].sort()
}

/** Sizes, given `read(fileName) → Buffer`. */
export function measure(graph, read) {
  const size = (f) => {
    const buf = read(f)
    return { raw: buf.length, gzip: gzipSync(buf).length }
  }
  const initial = initialChunks(graph)
  const sizes = Object.fromEntries(Object.keys(graph.chunks).map((f) => [f, size(f)]))
  const entries = initial.filter((f) => graph.chunks[f].isEntry)
  const entry = entries.map((f) => ({ file: f, ...sizes[f] })).sort((a, b) => b.raw - a.raw)[0]
  const lazy = Object.keys(sizes)
    .filter((f) => !initial.includes(f))
    .map((f) => ({ file: f, ...sizes[f] }))
    .sort((a, b) => b.raw - a.raw || a.file.localeCompare(b.file))
  return {
    entry,
    initial: {
      files: initial,
      raw: initial.reduce((n, f) => n + sizes[f].raw, 0),
      gzip: initial.reduce((n, f) => n + sizes[f].gzip, 0),
    },
    largestLazy: lazy[0] ?? null,
    total: { files: Object.keys(sizes).length, raw: Object.values(sizes).reduce((n, s) => n + s.raw, 0) },
  }
}

function actualOf(m, metric) {
  switch (metric) {
    case 'initialRaw': return { value: m.initial.raw, files: m.initial.files }
    case 'initialGzip': return { value: m.initial.gzip, files: m.initial.files }
    case 'largestLazyRaw': return { value: m.largestLazy ? m.largestLazy.raw : 0, files: m.largestLazy ? [m.largestLazy.file] : [] }
    case 'totalRaw': return { value: m.total.raw, files: [] }
  }
}

const kB = (n) => `${(n / 1000).toFixed(2)} kB`

/** One violation per metric over its limit; [] when all are within budget. */
export function compareToBudget(m, budgets) {
  const out = []
  for (const metric of METRICS) {
    const limit = budgets[metric]
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`asset budget: asset-budget.json has no usable limit for ${metric}`)
    }
    const { value, files } = actualOf(m, metric)
    if (value <= limit) continue
    const delta = value - limit
    const where = files.length ? ` — ${files.join(', ')}` : ''
    out.push({
      metric,
      actual: value,
      limit,
      delta,
      message: `${LABELS[metric]}: ${kB(value)} is over its ${kB(limit)} budget by +${delta} B (${kB(delta)})${where}`,
    })
  }
  return out
}

/** Disagreements between the graph and the .js files actually in dist/. */
export function staleGraphProblems(graph, distJsFiles) {
  const inGraph = new Set(Object.keys(graph.chunks))
  const onDisk = new Set(distJsFiles)
  const problems = []
  for (const f of onDisk) if (!inGraph.has(f)) problems.push(`${f} is in dist/ but not in the chunk graph`)
  for (const f of inGraph) if (!onDisk.has(f)) problems.push(`${f} is in the chunk graph but not in dist/`)
  return problems.sort()
}

export function report(m, budgets) {
  const row = (metric, value, extra = '') =>
    `  ${LABELS[metric].padEnd(44)} ${kB(value).padStart(12)} / ${kB(budgets[metric]).padStart(12)}${extra}`
  return [
    `entry chunk: ${m.entry.file} ${kB(m.entry.raw)} (gzip ${kB(m.entry.gzip)})`,
    `initial set: ${m.initial.files.join(', ')}`,
    row('initialRaw', m.initial.raw),
    row('initialGzip', m.initial.gzip),
    row('largestLazyRaw', m.largestLazy ? m.largestLazy.raw : 0, m.largestLazy ? `  (${m.largestLazy.file})` : ''),
    row('totalRaw', m.total.raw, `  (${m.total.files} chunks)`),
  ].join('\n')
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main() {
  const root = process.cwd()
  const dist = join(root, 'dist')
  const graphPath = join(root, GRAPH_PATH)
  if (!existsSync(dist) || !existsSync(graphPath)) {
    console.error('asset budget: no build to measure — run `npm run build` first.')
    process.exit(1)
  }
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const { budgets } = JSON.parse(readFileSync(join(root, 'asset-budget.json'), 'utf8'))

  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
  const distJs = walk(dist).filter((f) => f.endsWith('.js')).map((f) => relative(dist, f).split(sep).join('/'))
  const stale = staleGraphProblems(graph, distJs)
  if (stale.length) {
    console.error('asset budget: the chunk graph does not describe this dist/ — rebuild with `npm run build`.')
    for (const p of stale) console.error('  ' + p)
    process.exit(1)
  }

  const m = measure(graph, (f) => readFileSync(join(dist, f)))
  console.log(report(m, budgets))
  const over = compareToBudget(m, budgets)
  if (over.length) {
    console.error('\nasset budget: OVER BUDGET')
    for (const v of over) console.error('  ' + v.message)
    console.error('\nIf the growth is deliberate, raise the limit in asset-budget.json and say why in the commit.')
    process.exit(1)
  }
  console.log('\nasset budget: within budget')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
