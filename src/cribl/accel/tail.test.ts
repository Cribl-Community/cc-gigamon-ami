// The tail evaluator's job is to be RIGHT or to say "ask Cribl" — never to be
// nearly right. Every refusal below is a case where a guess would move a number
// on a customer's screen, and the fallback for a refusal is only one submitted
// job.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Row } from '../search'
import { MANIFEST } from './manifest'
import { evaluateTail, isRowwise, parseTail } from './tail'

const ALL = { complete: true }

describe('every tail the manifest ships', () => {
  it('parses — so no panel falls back for want of an operator', () => {
    // A tail that stops parsing costs a job per read and nothing else, so this
    // would never show up as a wrong number. It is pinned so that it shows up
    // at all.
    const unparsed = MANIFEST.flatMap((e) => e.panels)
      .filter((p) => p.tail !== undefined && parseTail(p.tail) === null)
      .map((p) => p.queryId)
    expect(unparsed).toEqual([])
  })
})

describe('the truncation rule', () => {
  const rows: Row[] = [{ k: 'a', n: 1 }, { k: 'a', n: 2 }]

  it('refuses a re-aggregating tail over rows not proven complete', () => {
    // A summarize over a truncated read is a wrong total; a sort | limit over
    // one is the wrong top N. Neither looks wrong.
    expect(evaluateTail('| summarize n=sum(n) by k', rows, { complete: false })).toBeNull()
    expect(evaluateTail('| sort by n desc | limit 1', rows, { complete: false })).toBeNull()
  })

  it('allows a row-wise tail over a partial read — fewer rows, each one right', () => {
    expect(evaluateTail('| where n > 1 | extend m=n | project m', rows, { complete: false })).toEqual([{ m: 2 }])
  })

  it('classifies limit and sort as needing every row', () => {
    expect(isRowwise(parseTail('| limit 5')!)).toBe(false)
    expect(isRowwise(parseTail('| project a')!)).toBe(true)
  })
})

describe('summarize', () => {
  const rows: Row[] = [
    { app: 'x', ip: '1', b: 10 },
    { app: 'x', ip: '2', b: 5 },
    { app: 'y', ip: '1', b: 7 },
    { app: 'x', ip: '1', b: 1 },
  ]

  it('sums and counts distinct values per group', () => {
    const out = evaluateTail('| summarize b=sum(b), u=dcount(ip) by app | sort by b desc', rows, ALL)
    expect(out).toEqual([{ app: 'x', b: 16, u: 2 }, { app: 'y', b: 7, u: 1 }])
  })

  it('emits one row without a by clause', () => {
    expect(evaluateTail('| summarize b=sum(b), n=count()', rows, ALL)).toEqual([{ b: 23, n: 4 }])
  })

  it('counts matching rows with sum(iif(cond, 1, 0))', () => {
    expect(evaluateTail('| summarize xs=sum(iif(app != "y", 1, 0))', rows, ALL)).toEqual([{ xs: 3 }])
  })

  it('refuses a missing addend rather than reading it as zero', () => {
    // "Absent is zero" is how a Parquet technique counter went 18 -> 43,338.
    expect(evaluateTail('| summarize b=sum(b)', [...rows, { app: 'z', ip: '3' }], ALL)).toBeNull()
  })

  it('refuses a missing or null group key', () => {
    expect(evaluateTail('| summarize b=sum(b) by app', [...rows, { ip: '9', b: 1 }], ALL)).toBeNull()
    expect(evaluateTail('| summarize b=sum(b) by app', [...rows, { app: null, ip: '9', b: 1 }], ALL)).toBeNull()
  })

  it('refuses a summarize over no rows at all', () => {
    expect(evaluateTail('| summarize b=sum(b)', [], ALL)).toBeNull()
  })

  it('refuses a key column that mixes types, which Cribl would merge', () => {
    // Probes 5a/5e: "0" and 0, and "12", 12 and 12.0, were ONE group, emitted in
    // whichever form Cribl met first. Splitting them is a wrong total; guessing
    // the form is a guess. Refused.
    expect(evaluateTail('| summarize n=count(), s=sum(v) by k', [{ k: '12', v: 4 }, { k: 12, v: 8 }], ALL)).toBeNull()
    expect(evaluateTail('| summarize n=count() by k', [{ k: true }, { k: 'true' }], ALL)).toBeNull()
    expect(evaluateTail('| summarize d=dcount(x)', [{ x: '12' }, { x: 12 }], ALL)).toBeNull()
  })

  it('still groups a single-typed key column', () => {
    expect(evaluateTail('| summarize n=count() by k', [{ k: '1' }, { k: '1' }, { k: '2' }], ALL)).toEqual([
      { k: '1', n: 2 },
      { k: '2', n: 1 },
    ])
  })
})

describe('where', () => {
  const rows: Row[] = [{ a: 'openai', n: 3 }, { a: 'OpenAI', n: 0 }, { a: '', n: 5 }]

  it('matches in (...) exactly, case included', () => {
    expect(evaluateTail('| where a in ("openai", "claude")', rows, ALL)).toEqual([{ a: 'openai', n: 3 }])
  })

  it('compares strings for equality and numbers for order', () => {
    expect(evaluateTail('| where a != ""', rows, ALL)).toHaveLength(2)
    expect(evaluateTail('| where a == "openai"', rows, ALL)).toHaveLength(1)
    expect(evaluateTail('| where n > 0', rows, ALL)).toHaveLength(2)
    // The boundary: > is strict.
    expect(evaluateTail('| where n > 3', rows, ALL)).toEqual([{ a: '', n: 5 }])
    expect(evaluateTail('| where n == 3', rows, ALL)).toEqual([{ a: 'openai', n: 3 }])
    expect(evaluateTail('| where n != 3', rows, ALL)).toHaveLength(2)
  })

  it('refuses >=, < and <=, which no manifest tail uses and nothing has measured', () => {
    for (const op of ['>=', '<', '<=']) expect(parseTail(`| where n ${op} 1`), op).toBeNull()
  })

  it('refuses a null or absent operand instead of guessing how Cribl compares it', () => {
    expect(evaluateTail('| where a != ""', [...rows, { n: 1 }], ALL)).toBeNull()
    expect(evaluateTail('| where n > 0', [...rows, { a: 'q', n: null }], ALL)).toBeNull()
  })

  it('refuses a type the literal does not match', () => {
    expect(evaluateTail('| where n > 0', [{ n: '4' }], ALL)).toBeNull()
    expect(evaluateTail('| where a != ""', [{ a: 4 }], ALL)).toBeNull()
  })

  it('refuses string ordering, which is collation', () => {
    expect(evaluateTail('| where a > "m"', rows, ALL)).toBeNull()
  })
})

describe('sort and limit', () => {
  it('orders by a number, desc and asc', () => {
    const rows: Row[] = [{ v: 2 }, { v: 9 }, { v: 5 }]
    expect(evaluateTail('| sort by v desc | limit 2', rows, ALL)).toEqual([{ v: 9 }, { v: 5 }])
    expect(evaluateTail('| sort by v asc', rows, ALL)).toEqual([{ v: 2 }, { v: 5 }, { v: 9 }])
  })

  it('refuses a missing sort key rather than placing it', () => {
    expect(evaluateTail('| sort by v desc', [{ v: 1 }, {}], ALL)).toBeNull()
  })

  it('refuses a sort with no stated direction', () => {
    expect(parseTail('| sort by v')).toBeNull()
  })
})

describe('what it refuses to parse', () => {
  it.each([
    'summarize n=count()', // no leading pipe
    '| summarize n=avg(v)',
    '| summarize n=sum(v * 2)',
    '| summarize n=sum(iif(a == "x", 2, 0))',
    '| extend n=v + 1',
    '| top 5 by v',
    '| where a contains "x"',
    '| where a == b',
    '| limit -1',
    '| project a | ',
    '| where a in ("x"',
  ])('%s', (tail) => {
    expect(parseTail(tail)).toBeNull()
  })

  it('keeps a pipe inside a string literal as part of the literal', () => {
    expect(evaluateTail('| where a == "x|y"', [{ a: 'x|y' }, { a: 'x' }], ALL)).toEqual([{ a: 'x|y' }])
  })
})

describe('what it never does', () => {
  it('mutates the rows it was given', () => {
    const rows: Row[] = [{ a: 1 }]
    evaluateTail('| extend b=a', rows, ALL)
    expect(rows).toEqual([{ a: 1 }])
  })

  it('invents a column the input lacks', () => {
    expect(evaluateTail('| extend b=zz | project a, c=zz', [{ a: 1 }], ALL)).toEqual([{ a: 1 }])
  })
})

// ── Parity with Cribl, on real stored rows ──────────────────────────────────
//
// The fixture holds three scheduled runs' stored rows and Cribl Search's OWN
// output of each panel tail over the same run (measured 2026-09-23; IPs and
// hostnames replaced by placeholders, numbers untouched). This is the one test
// that says the evaluator agrees with Cribl rather than with its author.
//
// Two panels compare as SETS: their sort key ties, and Cribl's order among a
// tie is not reproducible (measured). The DNS resolver panels are not here —
// their artifact is 1.3 MB — and their parity (sort-value sequence identical;
// a 588-way tie at the limit boundary) is recorded in the plan's verification
// notes instead.
describe('parity with Cribl on stored rows', () => {
  interface Fixture {
    entries: Record<string, Row[]>
    tails: Record<string, { entry: string; order: 'exact' | 'set'; cribl: Row[] }>
  }
  const fixture = JSON.parse(
    // join + fileURLToPath rather than `new URL(…, import.meta.url)`: under
    // happy-dom the global URL is the DOM's, which rejects the file scheme.
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'tail-parity.json'), 'utf-8'),
  ) as Fixture
  const panels = MANIFEST.flatMap((e) => e.panels)

  it('covers the tails it claims to', () => {
    expect(Object.keys(fixture.tails).sort()).toEqual([
      'capacity-app-mix', 'capacity-l4', 'capacity-talkers-app',
      'shadow-ai-apps', 'shadow-ai-overall', 'shadow-ai-users',
      'web-hosts', 'web-slow',
    ])
  })

  it.each(Object.keys(fixture.tails))('%s', (queryId) => {
    const t = fixture.tails[queryId]
    const panel = panels.find((p) => p.queryId === queryId)
    expect(panel?.tail, `${queryId} has no tail in the manifest`).toBeDefined()
    const rows = fixture.entries[t.entry]
    const mine = evaluateTail(panel!.tail!, rows, ALL)
    expect(mine, `${queryId} was refused on real rows`).not.toBeNull()
    // Compared on the columns the panel reads — what reaches the screen.
    const reads = [...panel!.reads]
    const shape = (rs: Row[]) => rs.map((r) => Object.fromEntries(reads.map((k) => [k, r[k] ?? null])))
    const a = shape(mine!)
    const b = shape(t.cribl)
    if (t.order === 'exact') expect(a).toEqual(b)
    else {
      const key = (r: Row) => JSON.stringify(r)
      expect(a.map(key).sort()).toEqual(b.map(key).sort())
    }
  })
})
