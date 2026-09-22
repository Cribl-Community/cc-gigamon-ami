// Does every panel that asks for a snapshot actually reach one?
//
// THE HOLE THIS CLOSES. `accel` is typed to `AccelId`, so naming an entry that
// does not exist is a build error. **`accelPanel` is a bare `string`.** A typo
// there makes `addressable` false, so `snapshotServed` is false and the hook
// quietly runs the live query instead — no error, no warning, no failing test,
// and a scan that was supposed to cost 0.2 billable CPU-seconds costs 127
// forever. Twenty hand-written literals at the call sites were, until this file,
// correct only by hand.
//
// `manifest.test.ts` is thorough but walks body → tail → columns *inside* the
// manifest and never leaves it. Nothing in the repo compared a call site's
// string to it in either direction. Found by a coverage census on 2026-09-22.
//
// WHAT THIS CANNOT CATCH: a call site naming a real `queryId` that belongs to a
// DIFFERENT entry than the one it passes as `accel`. Resolving that needs the
// `accel` expression, and four call sites pass a constant or an index
// (`MIX_ACCEL`, `TCP_ACCEL[mask]`) rather than a literal. Right-id-wrong-entry
// is a rarer mistake than a typo, and it degrades to a live query rather than to
// a wrong number — but it is not covered here, and this paragraph is the record
// that it is not.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANIFEST } from './manifest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Every .tsx/.ts under src/, except tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) sourceFiles(p, out)
    else if (/\.(tsx?|)$/.test(name.name) && /\.tsx?$/.test(name.name) && !/\.test\.tsx?$/.test(name.name)) out.push(p)
  }
  return out
}

const FILES = sourceFiles(SRC)
const rel = (p: string) => p.slice(SRC.length + 1).replace(/\\/g, '/')

/** Every `accelPanel: 'literal'` in the app, with the file it came from. */
const used: { file: string; id: string }[] = FILES.flatMap((f) => {
  const text = readFileSync(f, 'utf8')
  return [...text.matchAll(/accelPanel:\s*'([^']+)'/g)].map((m) => ({ file: rel(f), id: m[1] }))
})

/** Every panel id the manifest declares, and which entry declares it. */
const declared = new Map<string, string>()
for (const entry of MANIFEST) for (const p of entry.panels) declared.set(p.queryId, entry.id)

describe('a panel that asks for a snapshot reaches one', () => {
  it('finds the call sites at all — a regex that matches nothing would pass every test below', () => {
    // The guard on the guard. If the literal spelling changes, this file would
    // silently stop checking anything, which is the same class of defect it
    // exists to catch.
    expect(used.length, 'no accelPanel literals found — has the spelling changed?').toBeGreaterThan(15)
    expect(declared.size, 'the manifest declared no panels').toBeGreaterThan(20)
  })

  it.each(used.map((u) => [u.file, u.id] as const))('%s names a real panel: %s', (file, id) => {
    expect(
      declared.has(id),
      `${file} passes accelPanel '${id}', which no manifest entry declares. ` +
        `This does not fail loudly at runtime — the hook falls back to the LIVE query, forever.`,
    ).toBe(true)
  })

  it('every declared panel is addressed by somebody, or its entry serves exactly one', () => {
    // An entry whose panel nothing reads is a scheduled scan billing ~40 CPU-s
    // an hour to answer a question no screen asks. A SINGLE-panel entry needs no
    // accelPanel — useSearch resolves it when `served.length === 1` — so only
    // multi-panel entries are checked here.
    const addressed = new Set(used.map((u) => u.id))
    const orphans: string[] = []
    for (const entry of MANIFEST) {
      if (entry.panels.length <= 1) continue
      for (const p of entry.panels) if (!addressed.has(p.queryId)) orphans.push(`${entry.id} › ${p.queryId}`)
    }
    // Generated ids (the TCP heatmap builds `tcp-heatmap-${mask}-${metric}` at
    // the call site) cannot appear as literals, so they are expected here.
    const unexplained = orphans.filter((o) => !o.includes('tcp-heatmap-'))
    expect(unexplained, 'a scheduled scan is paying for a panel record nothing reads').toEqual([])
  })

  it('no two entries declare the same panel id', () => {
    // `useSearch` finds a panel with `served.find(p => p.queryId === accelPanel)`
    // inside ONE entry, so a duplicate across entries is not ambiguous to the
    // code — but it is to a reader, and it makes the orphan check above lie.
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const entry of MANIFEST) {
      for (const p of entry.panels) {
        const prior = seen.get(p.queryId)
        if (prior) clashes.push(`${p.queryId}: ${prior} and ${entry.id}`)
        else seen.set(p.queryId, entry.id)
      }
    }
    expect(clashes).toEqual([])
  })
})
