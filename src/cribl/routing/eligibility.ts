// Whether one query's TEXT may be answered from the Parquet copy — the first of
// the two conditions the router checks (the other is recorded evidence:
// routing/table.ts).
//
// PURE. No network, no React, no clock.
//
// ── THREE INPUTS, NOT ONE (Phase 8 design §4, 8.1) ──────────────────────────
//   1. The query text, read by parity.ts's `classifyQuery`. A, B and E refuse:
//      each is a number Parquet's ""/0 fill changes, and fixing it is a
//      rewrite (8.2) or a pipeline change (8.3), not a routing decision. C is
//      NEUTRAL (JSON already counts the absent value as one distinct value).
//      D and F refuse unless (3) says the field is dense. T refuses.
//   2. The field TYPE table (src/data/fieldTypes.ts). Every field the query
//      reads must have a measured type; an unknown one refuses. It holds
//      only what the 2026-09-25 censuses counted (28 fields); a query reading
//      any other field still refuses on this alone.
//   3. Per-install DENSITY: how many rows carry a field. A `by f` or `f=*` on a
//      field present on EVERY row reads the same on both copies; on a sparse
//      field it does not. Demo figures are not production figures, so density
//      is read per install (8.0b's query), never hand-labelled. Unknown today.
//
// The reasons come back as data, each with its kind, because the table's own
// check (routing/table.ts) judges the text and types alone — density belongs to
// an install, not to a release — while the router judges all three.

import { classifyQuery, type FieldType, type QueryClass } from '../parity'

/** How many rows over a measured window carried a field. */
export interface Density {
  present: number
  total: number
}

export type DensityTable = Readonly<Record<string, Density>>

/** Nothing measured on this install — today's answer everywhere. */
export const NO_DENSITY: DensityTable = Object.freeze({})

export type ReasonKind = 'class' | 'type' | 'density'

export interface Refusal {
  kind: ReasonKind
  words: string
}

export interface Eligibility {
  eligible: boolean
  refusals: Refusal[]
  /** Classes present that do not refuse (C), for the record. */
  neutral: QueryClass[]
}

/** Dense means EVERY row: 99.3 % (dns_host within DNS rows) still leaves a "" group Parquet ranks. */
export function isDense(d: Density | undefined): boolean {
  return d !== undefined && d.total > 0 && d.present === d.total
}

const CLASS_WHY: Partial<Record<QueryClass, string>> = {
  A: 'reads true on every Parquet row (needs a portable rewrite, 8.2)',
  B: 'counts every Parquet row (needs a portable rewrite, 8.2)',
  E: 'is pulled toward 0 by Parquet\'s filled zeros (stays on JSON, 8.3)',
  T: 'has a type that differs between Parquet files',
}

/** Whether `query` may be answered from Parquet, and every reason it may not. */
export function eligibility(
  query: string,
  types: Readonly<Record<string, FieldType>>,
  density: DensityTable = NO_DENSITY,
): Eligibility {
  const { hits, fields } = classifyQuery(query, types)
  const refusals: Refusal[] = []
  const neutral: QueryClass[] = []
  for (const { cls, field } of hits) {
    if (cls === 'C') {
      if (!neutral.includes('C')) neutral.push('C')
      continue
    }
    if (cls === 'D' || cls === 'F') {
      const d = density[field]
      if (isDense(d)) continue
      refusals.push({
        kind: 'density',
        words: d
          ? `class ${cls} on ${field}: ${d.present} of ${d.total} rows carry it`
          : `class ${cls} on ${field}: how many rows carry it is not measured`,
      })
      continue
    }
    refusals.push({ kind: 'class', words: `class ${cls} on ${field} ${CLASS_WHY[cls]}` })
  }
  const unknown = fields.filter((f) => types[f] === undefined)
  if (unknown.length) refusals.push({ kind: 'type', words: `type not measured: ${unknown.join(', ')}` })
  return { eligible: refusals.length === 0, refusals, neutral }
}
