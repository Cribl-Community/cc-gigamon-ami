// The gate on every Cribl Search string this app shows a customer — and on the
// number, the words and the data each of those strings is attached to.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS GATE PROVES, AND WHAT IT DOES NOT. Read this before trusting a tick.
//
// PROVES: that what each ⓘ TELLS a customer has not changed behind your back —
// the query strings, the expression each surface points at, the ⓘ prose and
// captions, the search options and deep-link time bounds, the catalogs and the
// first-paint useState defaults behind the numbers, every branch of every
// builder in src/queries, and the render path in PanelInfo that puts all of it
// on screen (src/components/PanelInfo.test.tsx) together with the helpers a
// query passes through on its way out (src/cribl/search.test.ts,
// src/cribl/config.test.ts, src/lib/format.test.ts).
//
// DOES NOT PROVE: that the figure printed beside an ⓘ is produced by the query
// that ⓘ shows. Swap the definitions of two tab-local constants behind two
// tiles' `value=` expressions; change the arithmetic between a search's rows and
// the number; funnel a result through useState — this gate stays green through
// all of it.
//
// WHY NOT, AND WHY WE ARE NOT GOING TO FIX IT: deciding it needs dataflow
// analysis of arbitrary React, and the Phase 1 refactor this gate exists to
// police breaks the binding BY DESIGN — extracting a panel into a component that
// receives its search state as a prop is the correct extraction, and it
// correctly leaves no search variable in that file. A heuristic that fails on
// the very refactor it is meant to guard is worse than an honest limit, because
// a green tick would be read as proof of something it never checked.
//
// SO ATTRIBUTION STAYS A HUMAN REVIEW QUESTION: read the tile, read its ⓘ, check
// they agree — exactly how four mismatched tiles were caught by eye in slice
// 1.1. `reads` below is a hint at that binding and never a proof, and an entry
// marked `(unbound)` means no search variable was in scope, so nothing at all
// was checked about that surface's figure. The count of those is asserted, so it
// can only go up when somebody decides it should.
//
// Also outside any snapshot of src/: a row drill-down handed a different row's
// runtime argument — `drillResolver(host)` → `drillResolver(shown[0].dns_host)`.
// That value exists only while the app is running.
// ─────────────────────────────────────────────────────────────────────────────
//
// The extraction is not reimplemented: this runs scripts/extract-queries.mjs
// --stdout, the same code `npm run queries:extract` runs to write the file, so
// the checker and the generator can never drift apart. The extractor throws on
// a query it cannot resolve rather than emitting a placeholder — a placeholder
// in the committed snapshot could never diff again, and this gate would be dead
// without anyone noticing.
//
// IF THIS TEST FAILS: read which of the checks it is.
//   • counts     — a surface, call site, deep link or brief appeared or vanished
//   • surfaces   — a query, what a surface points at, what it reads, or its prose
//   • briefs     — the query briefed to the Cribl Search Copilot agent changed
//   • prose      — the words of an ⓘ that has no query behind it changed
//   • unbound    — the freeze checked LESS than it did before
//   • fixtures   — a stand-in for runtime input, or a domain, changed
//   • states     — a useState default that picks the first-paint query changed
//   • modules    — an export of src/queries, or a branch of one, changed
//   • catalogs   — data behind a number changed without any query changing
//   • passthrough— a component started (or stopped) forwarding a query
//   • $limits    — the scope note shipped in the snapshot changed
// Any of them is fine if you meant it. Run `npm run queries:extract`, read the
// diff on display.json, and commit it with the change that caused it.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** What the snapshot records where it checked nothing. Must match the extractor. */
const UNBOUND = '(unbound)'

interface Entry {
  /** The expression as written, e.g. `kpiQuery` or `SERVERS_Q`. */
  ref: string
  /** Whole query, or a bare filter something wraps in q() later. */
  shape: 'query' | 'fragment'
  /** What that expression actually resolves to. */
  query: string
  /** The `.map()` receivers this site is rendered inside — the rows it becomes. */
  renderedOver?: string[]
  /**
   * The searches whose rows this JSX element mentions — a HINT at the number the
   * ⓘ explains, never a proof of it. `(unbound)` means none was in scope.
   */
  reads?: string[] | typeof UNBOUND
  /** The `value=` expression, verbatim: the figure itself. */
  value?: string
  /** `unit=` — what turns 87 into 87/100. */
  unit?: string
  /** `badge=` — the pill printed under the figure. */
  badge?: string
  /** The ⓘ prose. */
  info?: string
  /** The caption under the figure. */
  sub?: string
  /** A panel's header caption, frozen only where it is literal text. */
  note?: string
  /** Search options at a call site, as written — a pinned `earliest` changes the meaning. */
  options?: string
  /** …and as resolved, so hoisting the literal into a const cannot hide the window. */
  optionsValue?: Record<string, unknown>
  /** The time bound handed to a Cribl Search deep link, as written. */
  window?: string
  /** …and as resolved. */
  windowValue?: string | number | boolean | null
}

interface Brief {
  ref: string
  /** The prompt handed to the Copilot agent, dataset-qualified query included. */
  brief: string
}

type Bucket = 'surfaces' | 'searches' | 'links'
type Count = Bucket | 'briefs' | 'prose' | 'modules' | 'catalogs' | 'states' | 'passthrough' | 'unbound'
interface Snapshot {
  /** What the gate covers and what it does not, shipped in the artefact itself. */
  $limits: string[]
  counts: Record<Count, number>
  fixtures: Record<string, Record<string, unknown>>
  states: Record<string, Record<string, string>>
  passthrough: Record<string, number>
  catalogs: Record<string, string>
  modules: Record<string, Record<string, string>>
  files: Record<string, Record<Bucket, Record<string, Entry>> & {
    briefs: Record<string, Brief>
    /** An ⓘ with words but no query — the words are all there is to freeze. */
    prose: Record<string, Record<string, unknown>>
  }>
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXTRACTOR = join(ROOT, 'scripts', 'extract-queries.mjs')
const FROZEN_FILE = join(ROOT, 'src', 'queries', '__frozen__', 'display.json')

const BUCKETS: Bucket[] = ['surfaces', 'searches', 'links']
/** Every bucket, including the ones that are not keyed by a query. */
const ALL_BUCKETS = [...BUCKETS, 'briefs', 'prose'] as const
const WHAT: Record<string, string> = {
  surfaces: 'ⓘ surface',
  searches: 'search call site',
  links: 'Cribl Search deep link',
  briefs: 'Copilot brief',
  prose: 'query-less ⓘ',
  unbound: 'unchecked (unbound)',
}

/**
 * Appended to every failure message here, because a red build is exactly when
 * someone needs to know what this gate covers — and, more to the point, what a
 * green one would not have told them either.
 */
// The scope note is NOT restated here. It is generated once, in
// scripts/extract-queries.mjs, and shipped into the snapshot as `$limits`;
// this reads it back. An earlier version kept a second copy in this file and
// the two had already drifted — one claiming coverage the other did not — which
// is the worst possible outcome for a statement whose whole job is to say
// honestly what is and is not checked.
const SCOPE = (JSON.parse(readFileSync(FROZEN_FILE, 'utf8')) as Snapshot).$limits.join('\n')

const RERUN = 'If you meant it, run `npm run queries:extract` and commit src/queries/__frozen__/display.json.' +
  `\n\n${SCOPE}`

/**
 * Re-derive the snapshot from src/ with the generator itself, once per run.
 *
 * A failure is cached too: the extractor throwing is itself a result (see (e)
 * below), and re-running it per test would just reprint the same stack.
 */
let cached: { ok: Snapshot } | { err: Error } | null = null
function fresh(): Snapshot {
  if (!cached) {
    try {
      // stderr is piped, not inherited, so the extractor's own throw arrives as
      // this test's failure message instead of loose text above the report.
      const out = execFileSync(process.execPath, [EXTRACTOR, '--stdout'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
      cached = { ok: JSON.parse(out) as Snapshot }
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message: string }
      const detail = ((typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString()) || e.message).trim()
      cached = {
        err: new Error(
          `The query snapshot could not be re-derived from src/, so nothing was checked.\n\n${detail}\n\n` +
            'The extractor refuses to emit a placeholder for a query it cannot resolve: a placeholder in the committed snapshot could never diff again, and this gate would be dead. Make the surface resolvable, or give its runtime argument a fixture in src/queries/__fixtures__/args.ts.',
        ),
      }
    }
  }
  if ('err' in cached) throw cached.err
  return cached.ok
}

const frozen = JSON.parse(readFileSync(FROZEN_FILE, 'utf8')) as Snapshot

/**
 * Every field the snapshot marked `(unbound)` — every place it says out loud
 * that it checked nothing.
 *
 * Recomputed here from the entries rather than read from `counts`, so the
 * extractor cannot quietly stop marking them.
 */
function unbound(s: Snapshot): string[] {
  const out: string[] = []
  for (const [file, buckets] of Object.entries(s.files)) {
    for (const bucket of ALL_BUCKETS) {
      for (const [key, entry] of Object.entries(buckets[bucket] as Record<string, Record<string, unknown>>)) {
        for (const [field, value] of Object.entries(entry)) {
          if (value === UNBOUND) out.push(`${file} › ${bucket} › ${key} › ${field}`)
        }
      }
    }
  }
  return out.sort()
}

/** Count entries from the entries themselves, never from the recorded totals. */
function tally(s: Snapshot): Snapshot['counts'] {
  const out = { surfaces: 0, searches: 0, links: 0, briefs: 0, prose: 0, modules: 0, catalogs: 0, states: 0, passthrough: 0, unbound: 0 }
  for (const file of Object.values(s.files)) {
    for (const b of BUCKETS) out[b] += Object.keys(file[b]).length
    out.briefs += Object.keys(file.briefs).length
    out.prose += Object.keys(file.prose).length
  }
  for (const m of Object.values(s.modules)) out.modules += Object.keys(m).length
  for (const st of Object.values(s.states)) out.states += Object.keys(st).length
  out.catalogs = Object.keys(s.catalogs).length
  out.passthrough = Object.keys(s.passthrough).length
  out.unbound = unbound(s).length
  return out
}

/** Every query-bearing entry as one addressable row: `file › bucket › key`. */
function rows(s: Snapshot): Map<string, Entry> {
  const out = new Map<string, Entry>()
  for (const [file, buckets] of Object.entries(s.files)) {
    for (const b of BUCKETS) for (const [key, e] of Object.entries(buckets[b])) out.set(`${file} › ${b} › ${key}`, e)
  }
  return out
}

/** The fields of a surface entry, and what a change in each one means. */
const FIELDS: Array<{ key: keyof Entry; verdict: string; why: string }> = [
  { key: 'query', verdict: 'CHANGED', why: 'the query text behind this number' },
  { key: 'shape', verdict: 'RESHAPED', why: 'whole query vs bare fragment' },
  { key: 'renderedOver', verdict: 'RESCOPED', why: 'the .map() this surface is rendered inside — narrow it and panels leave the screen while every query stays identical' },
  { key: 'reads', verdict: 'REFED', why: 'the searches this element mentions — a hint at the number the ⓘ describes, not a proof of it' },
  { key: 'value', verdict: 'REVALUED', why: 'the expression that computes the figure' },
  { key: 'unit', verdict: 'REVALUED', why: 'the unit printed against the figure — what turns 87 into 87/100' },
  { key: 'badge', verdict: 'REVALUED', why: 'the status pill printed under the figure' },
  { key: 'info', verdict: 'REWORDED', why: 'the ⓘ prose a customer reads' },
  { key: 'sub', verdict: 'REWORDED', why: 'the caption under the figure' },
  { key: 'note', verdict: 'REWORDED', why: 'the caption in the panel header — "top 500 by volume" is a claim about the number beside it' },
  { key: 'options', verdict: 'RETIMED', why: 'the search options as written' },
  { key: 'optionsValue', verdict: 'RETIMED', why: 'the search options as they RESOLVE — a pinned window changes what the number counts, wherever the literal now lives' },
  { key: 'window', verdict: 'RETIMED', why: 'the time bound handed to the deep link, as written' },
  { key: 'windowValue', verdict: 'RETIMED', why: 'the time bound handed to the deep link, as it resolves' },
]

const show = (v: unknown) =>
  v === undefined ? '(none)'
    : Array.isArray(v) ? `[${v.join(', ')}]`
      : v !== null && typeof v === 'object' ? JSON.stringify(v)
        : String(v)

describe('frozen display queries', () => {
  // Deliberately separate from the contents check: a surface that quietly
  // disappears leaves the surviving entries identical, so a contents-only
  // comparison would diff clean on a tile that no longer tells anyone anything.
  it('still has exactly as many surfaces, call sites, deep links and briefs', () => {
    const before = tally(frozen)
    const after = tally(fresh())
    const moved = (Object.keys(before) as Array<keyof Snapshot['counts']>)
      .filter((b) => before[b] !== after[b])
      .map((b) => `${WHAT[b] ?? b} entries: ${before[b]} frozen → ${after[b]} in src/ (${after[b] > before[b] ? 'added' : 'lost'} ${Math.abs(after[b] - before[b])})`)
    expect(moved, `The number of customer-visible queries changed.\n  ${moved.join('\n  ')}\n${RERUN}`).toEqual([])
    // The recorded totals are part of the committed file, so they must agree too.
    expect(frozen.counts, 'display.json\'s recorded counts disagree with its own entries.').toEqual(before)
  })

  it('points every surface at the same query, reading the same number, described the same way', () => {
    const before = rows(frozen)
    const after = rows(fresh())
    const problems: string[] = []

    for (const [where, e] of after) {
      const was = before.get(where)
      if (!was) {
        problems.push(`ADDED     ${where}\n            now: ${e.ref} → ${e.query}`)
        continue
      }
      if (was.ref !== e.ref) {
        problems.push(`REPOINTED ${where}\n            was: ${was.ref} → ${was.query}\n            now: ${e.ref} → ${e.query}`)
        continue
      }
      for (const f of FIELDS) {
        const a = JSON.stringify(was[f.key] ?? null)
        const b = JSON.stringify(e[f.key] ?? null)
        if (a === b) continue
        problems.push(`${f.verdict.padEnd(9)} ${where}  (${e.ref})\n            ${f.why}\n            was: ${show(was[f.key])}\n            now: ${show(e[f.key])}`)
      }
    }
    for (const [where, e] of before) {
      if (!after.has(where)) problems.push(`REMOVED   ${where}\n            was: ${e.ref} → ${e.query}`)
    }

    expect(problems, `What the app tells a customer a number came from has changed.\n\n${problems.join('\n')}\n\n${RERUN}`).toEqual([])
  })

  it('hands the Copilot agent the same briefed query', () => {
    // criblInvestigateUrl embeds a dataset-qualified query built in the tab, and
    // the agent acts on it — a customer-visible query path like any other.
    const briefs = (s: Snapshot) => Object.fromEntries(
      Object.entries(s.files).flatMap(([file, b]) => Object.entries(b.briefs).map(([k, v]) => [`${file} › ${k}`, v])),
    )
    expect(briefs(fresh()), `The brief handed to Cribl Search Copilot changed.\n${RERUN}`).toEqual(briefs(frozen))
  })

  it('freezes the words of an ⓘ that has no query behind it', () => {
    // Three coverage tiles and the "not observable in this feed" panel explain a
    // number in English without naming a query. There is no provenance to
    // resolve, but the words are still a claim a customer reads.
    const prose = (s: Snapshot) => Object.fromEntries(
      Object.entries(s.files).flatMap(([file, b]) => Object.entries(b.prose).map(([k, v]) => [`${file} › ${k}`, v])),
    )
    expect(prose(fresh()), `The words in an ⓘ with no query behind it changed.
${RERUN}`).toEqual(prose(frozen))
  })

  it('names every surface whose figure it could not bind to a search, and never quietly adds one', () => {
    // `reads: []` used to be how this was recorded, and in review an empty list
    // reads exactly like a checked binding with nothing wrong. It is not: it
    // means the element resolved to no search variable — a destructured result,
    // one funnelled through useState, search state arriving as a prop — so
    // NOTHING about that figure was checked. Field Explorer's panels are in that
    // state today and are expected to stay there: the fix is the Phase 1
    // extraction, which does not restore the binding either (see the header).
    // The list is asserted rather than the bare count, so a new unchecked
    // surface names itself instead of hiding inside a number.
    const before = unbound(frozen)
    const after = unbound(fresh())
    const added = after.filter((k) => !before.includes(k))
    const gone = before.filter((k) => !after.includes(k))
    expect(
      { added, gone },
      'The set of surfaces this gate checks NOTHING about has changed.\n' +
        `  now unchecked: ${added.join('\n                 ') || '(none)'}\n` +
        `  now checked:   ${gone.join('\n                 ') || '(none)'}\n` +
        'An addition means one more number whose ⓘ nobody is verifying. That may be correct — a panel extracted into a component takes its search state as a prop, and no snapshot can follow that — but it has to be a decision, not a drift.\n' +
        `${RERUN}`,
    ).toEqual({ added: [], gone: [] })
  })

  it('ships its own limits in the file a reviewer reads', () => {
    // The snapshot is what gets read in a pull request, so the statement of what
    // it does and does not prove travels with it. Deleting that note is a change
    // to the gate, not a tidy-up.
    expect(
      fresh().$limits,
      `The scope note written into display.json changed.\n${RERUN}`,
    ).toEqual(frozen.$limits)
    expect(frozen.$limits.join(' '), 'display.json no longer says that attribution is unchecked.')
      .toContain('DOES NOT PROVE')
  })

  it('freezes the fixture values the builders were called with', () => {
    // A builder's template is only frozen relative to its input, so the input is
    // frozen too — editing a fixture must move the snapshot, not slip past it.
    expect(fresh().fixtures, `The fixtures in src/queries/__fixtures__/args.ts changed.\n${RERUN}`).toEqual(frozen.fixtures)
  })

  it('freezes the useState defaults that choose the first-paint query', () => {
    // The default pivot, metric and mask decide which query runs before anyone
    // clicks anything — the first screen every customer sees.
    expect(fresh().states, `A tab's useState default changed, so a different query now runs on load.\n${RERUN}`).toEqual(frozen.states)
  })

  it('freezes every export of src/queries, each builder over its whole domain', () => {
    // Not one sampled argument tuple: every pivot, every metric, both masks,
    // every catalog row. A branch nobody enumerated is a branch nobody froze.
    expect(fresh().modules, `An export of src/queries changed — a query constant, or a branch of a builder.\n${RERUN}`).toEqual(frozen.modules)
  })

  it('freezes the catalogs behind the numbers, not just the queries over them', () => {
    // Reclassify a finding's severity and three KPI tiles move while every ⓘ
    // still shows the unchanged FINDINGS_QUERY. The data is part of the promise.
    expect(fresh().catalogs, `A src/data catalog changed, which moves numbers no query text mentions.\n${RERUN}`).toEqual(frozen.catalogs)
  })

  it('accounts for every component that forwards a query instead of naming one', () => {
    // KpiTile, Panel and PanelInfo pass their caller's query through; they name
    // none themselves. A NEW forwarder — or a component that stops forwarding
    // and starts naming its own query — has to be visible here.
    expect(fresh().passthrough, `A component changed how it forwards a query.\n${RERUN}`).toEqual(frozen.passthrough)
  })
})
