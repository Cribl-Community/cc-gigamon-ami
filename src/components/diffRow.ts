// One row of a before→after, and what that pair means — the part of <DiffTable>
// that has no DOM in it.
//
// Split out of DiffTable.tsx for the reason accelPanelCopy.ts, jobWatchdogCopy.ts
// and lakeLandingCopy.ts were: a component file that also exports a function is a
// `react(only-export-components)` warning, and the classification below is worth
// asserting directly rather than through rendered text. DiffTable.test.tsx calls
// `diffState` on seven pairs; through the DOM it would have been reading for the
// word "changed", which is a substring of "unchanged" — a trap that caught the
// first version of that assertion.
//
// THE STATE IS DERIVED, NEVER PASSED. A caller cannot label a removal `added`,
// because it does not get to label anything: this reads the two values. What the
// caller owns is how a value PRINTS, because the module that computed the diff is
// the one that knows what the field means.

export interface DiffRow {
  /** The configuration key, spelled exactly as Cribl spells it. */
  key: string
  /**
   * Its value now, already rendered as the string a reader should see.
   * `null`/absent means the key is not on the object today.
   */
  before?: string | null
  /** What it becomes, same terms. `null`/absent means the key goes away. */
  after?: string | null
}

/** What this write does to one key. Derived from the pair — see `diffState`. */
export type DiffState = 'added' | 'removed' | 'changed' | 'unchanged'

/**
 * What happened to one key, read off the two values.
 *
 * `unchanged` is here even though a diff is supposed to carry only the keys that
 * moved: a caller computing one from a live GET can hand over a pair that turned
 * out to be equal — a retention Apply where only the description changed, say —
 * and rendering that row as `changed` would be the table telling a customer
 * something is about to happen to a field nothing is about to happen to. It
 * costs one line here and one word on screen.
 */
export function diffState(row: DiffRow): DiffState {
  const before = row.before ?? null
  const after = row.after ?? null
  if (before === after) return 'unchanged'
  if (before === null) return 'added'
  if (after === null) return 'removed'
  return 'changed'
}
