// Which store answers a given query — and the queries that may never leave JSON.
//
// Pure. No network, no React. The routing rule is data so the exceptions are
// structural rather than remembered, and so a test can read them.
//
// ── THE SHAPE, decided 2026-09-22; PLANNED, NOT BUILT ────────────────────────
// Two Lake datasets rather than one. Guided Setup creates gigamon_ami, and its
// onboarding run (cribl/onboarding/run.ts) also creates gigamon_ami_pq; no
// query reads the second yet.
//
//   gigamon_ami      JSON, keeps `_raw`, 30-day archive. Drill-downs, Field
//                    Explorer and Copilot read it. Nothing about it changes.
//   gigamon_ami_pq   Parquet. The analytics copy the dashboards are to
//                    aggregate. TODAY IT IS NOT CURATED: the pack routes it
//                    through the same gigamon_ami_normalize pipeline, which
//                    keeps `_raw`, and its automatic schema keeps every field
//                    (pack.ts `PACK_DECISIONS.parquet_schema_mode`). Dropping
//                    `_raw` there is a future pipeline change.
//
// `_raw` is on 100 % of events and is ≈40 % of the bytes Search reads (337 MB
// of ~850 MB per 15 min), and NO dashboard query touches it.
//
// ── WHY READ THE PARQUET COPY AT ALL (corrected 2026-09-25) ─────────────────
// This paragraph used to say that dropping `_raw` from the analytics copy "is
// the whole argument for two stores in one sentence": a columnar reader skips
// `_raw`, JSON cost follows bytes, so Parquet reads are cheaper. The Phase 8
// design (revision 2, §3.1) found that argument UNSUPPORTED by the D-10
// partition run: flat Parquet cost ≈4.7 billable CPU-s per MB read against
// ≈0.16 on JSON, and a filter that read 17 % of the rows still cost 65 % of the
// CPU. Something other than bytes — per-row decode, per-job overhead, or both,
// unknown which — dominates Parquet cost. Curating the copy is therefore not
// known to make a scan cheaper.
//
// The value case is now the owner's, not this argument. Phase 8 Q1 was
// answered 2026-09-25 with (a), Live-mode latency: "the live queries will make
// it worth landing the data in pq format." Cost is not a design constraint
// (owner, 2026-09-22; see benchmark.ts), and CPU-s stays reported as work, not
// gated. What the answer buys is the router and the behaviour measurement — it
// is NOT evidence that any given query is faster or equal on Parquet. Until a
// recorded parity run says otherwise for a query, that query reads JSON.
//
// ── WHY A PIN IS NOT A PREFERENCE ───────────────────────────────────────────
// Two families of query CANNOT follow the install's chosen target, and both are
// structural rather than cautious:
//
//   PRESENCE — Field Explorer asks which AMI fields the feed actually carries.
//   Parquet with an automatic schema materialises every column, so every field
//   reads back present. The tab would report 94 of 94 fields in green, which is
//   the exact opposite of its purpose. It is not "less accurate" on Parquet; it
//   is inverted.
//
//   EVIDENCE — every drill-down and deep link is a whole-row read that an
//   analyst opens to see what actually happened. It wants `_raw` and every
//   field, which the curated copy does not carry. A drill that lands on Parquet
//   would show a narrower row than the number that led to it.
//
// A pin is therefore a property of the QUESTION, not of the tenant's setup, and
// stays true whichever target they pick.
import { LAKE_DATASET } from './config'

export type QueryTarget = 'lake-json' | 'lake-parquet' | 'lakehouse'

export const TARGET_WORDS: Readonly<Record<QueryTarget, string>> = Object.freeze({
  'lake-json': 'Cribl Lake · JSON',
  'lake-parquet': 'Cribl Lake · Parquet',
  lakehouse: 'Cribl Search Lakehouse Engine',
})

/**
 * THE DEFAULT IS JSON, AND IT IS GATED RATHER THAN CHOSEN.
 *
 * Parquet is not the default, and on the evidence in hand no dataset setting
 * would make it one. Shipping it would put fabricated numbers on a new tenant's
 * first screen rather than slow ones.
 *
 * A Parquet Lake dataset reads an ABSENT field back as `""` (string) or `0`
 * (numeric). Five classes of aggregate change meaning under that (parity.ts
 * header), and the worst is unfixable by any query rewrite in general: a
 * `percentile` over a sparse numeric cannot exclude the synthetic zeros without
 * also excluding the real ones. A technique counter measured **18 against
 * 43,338** on the same window.
 *
 * WHAT DOES NOT FLIP IT (corrected 2026-09-25). This used to say that
 * `automaticSchema: false` with an explicit `parquetSchema` marking every field
 * optional would make every class disappear with no query changes. Proof (g),
 * 2026-09-24, refuted that: an explicit schema had no observable effect, and an
 * absent field became `""` in BOTH schema modes. There is no dataset setting
 * known to preserve nullability.
 *
 * WHAT MOVES A QUERY INSTEAD — PLANNED (Phase 8 design, revision 2, §4 8.1):
 * routing is per QUERY, not per install. A query may read Parquet only when its
 * own text is class-free for the field types it touches (or carries a portable
 * rewrite), and a recorded parity run over both datasets agreed for it. That
 * makes a move a data change backed by evidence, never an edit to this
 * constant. Until the first such run exists, every query resolves to JSON.
 *
 * A tenant can still CHOOSE Parquet in the picker; they are simply not defaulted
 * into it. `SAFE_WITHOUT_MEASUREMENT` is what the UI reads to say so.
 */
export const DEFAULT_TARGET: QueryTarget = 'lake-json'
export const SAFE_WITHOUT_MEASUREMENT: readonly QueryTarget[] = Object.freeze(['lake-json'])

/** Why a query cannot follow the install's chosen target. */
export type PinReason = 'presence' | 'evidence'

export const PIN_WORDS: Readonly<Record<PinReason, string>> = Object.freeze({
  presence:
    'This panel asks which fields the feed actually carries. A Parquet dataset with an automatic schema materialises every column, so every field would read back as present — the opposite of what this panel is for. It always reads the JSON archive.',
  evidence:
    'This opens the underlying records as they arrived. The Parquet copy reads a field a record never had back as an empty value, and may later drop `_raw`, so a drill-down there would not show the row that led to the number. It always reads the JSON archive.',
})

export interface Routing {
  /** The store that will actually answer. */
  target: QueryTarget
  /** The dataset name to address. */
  dataset: string
  /** Set when the query could not follow the chosen target. */
  pinned: PinReason | null
}

export interface TargetDatasets {
  /** The JSON archive. Always present — it is what Guided Setup creates first. */
  json: string
  /** The Parquet copy (not curated yet: see the header), when one exists. */
  parquet?: string
  /** The engine dataset, when one is configured. */
  lakehouse?: string
}

export const DEFAULT_DATASETS: TargetDatasets = Object.freeze({ json: LAKE_DATASET })

/**
 * Where one query actually runs.
 *
 * FALLS BACK RATHER THAN FAILS, and says so in the returned value. A tenant who
 * picks Parquet and has not provisioned it gets the archive and a `pinned`
 * reason, not an error and not an empty panel — the same rule the rest of this
 * app follows when an object is absent.
 */
export function routeQuery(chosen: QueryTarget, pin: PinReason | null, datasets: TargetDatasets = DEFAULT_DATASETS): Routing {
  if (pin !== null) return { target: 'lake-json', dataset: datasets.json, pinned: pin }

  if (chosen === 'lake-parquet' && datasets.parquet) {
    return { target: 'lake-parquet', dataset: datasets.parquet, pinned: null }
  }
  if (chosen === 'lakehouse' && datasets.lakehouse) {
    return { target: 'lakehouse', dataset: datasets.lakehouse, pinned: null }
  }
  // Chosen but not provisioned. The archive always exists.
  return { target: 'lake-json', dataset: datasets.json, pinned: null }
}

/** Which targets this install can actually offer, in display order. */
export function availableTargets(datasets: TargetDatasets = DEFAULT_DATASETS): QueryTarget[] {
  const out: QueryTarget[] = ['lake-json']
  if (datasets.parquet) out.push('lake-parquet')
  if (datasets.lakehouse) out.push('lakehouse')
  return out
}

/**
 * The sentence the target picker shows under an option.
 *
 * Corrected 2026-09-25: the Parquet sentence said "A curated columnar copy —
 * `_raw` and the unused fields dropped, so a scan reads far less." Neither half
 * held. The copy is not curated today (header), and D-10 measured flat Parquet
 * at ≈4.7 CPU-s per MB read against ≈0.16 on JSON, so reading fewer bytes is not
 * known to make a scan cheaper. No screen renders this today and it is outside
 * the display freeze; it was corrected before one does. `PIN_WORDS.evidence`
 * made the same "curated and drops `_raw`" claim and was corrected with it.
 *
 * Says what it costs as well as what it is. An engine is provisioned compute, so
 * its queries are sunk; a Lake query bills billable CPU-seconds every time. A
 * picker that offered three lanes without saying which are metered would be
 * quietly misleading.
 */
export function targetNote(target: QueryTarget, datasets: TargetDatasets = DEFAULT_DATASETS): string {
  switch (target) {
    case 'lake-json':
      return 'The full archive, every field and the original record. Billed per query. Always available, and the only store the field-coverage and drill-down panels read.'
    case 'lake-parquet':
      return datasets.parquet
        ? 'A columnar copy of the same records, written beside the archive. Billed per query. Not yet the default: see the note about absent fields.'
        : 'Not provisioned on this workspace. Guided Setup can create it alongside the archive.'
    case 'lakehouse':
      return datasets.lakehouse
        ? 'Queries run on an engine you have already provisioned, so they cost nothing beyond its tier.'
        : 'No Cribl Search Lakehouse engine is configured for this app.'
  }
}
