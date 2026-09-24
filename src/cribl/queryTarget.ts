// Which store answers a given query — and the queries that may never leave JSON.
//
// Pure. No network, no React. The routing rule is data so the exceptions are
// structural rather than remembered, and so a test can read them.
//
// ── THE SHAPE, decided 2026-09-22 ───────────────────────────────────────────
// Guided Setup provisions TWO Lake datasets rather than one:
//
//   gigamon_ami      JSON, keeps `_raw`, 30-day archive. Drill-downs, Field
//                    Explorer and Copilot read it. Nothing about it changes.
//   gigamon_ami_pq   Parquet, CURATED — `_raw` dropped, ~60 columns instead of
//                    ~319. The analytics copy the dashboards aggregate.
//
// `_raw` is on 100 % of events and is ≈40 % of the bytes Search reads (337 MB
// of ~850 MB per 15 min), and NO dashboard query touches it. Dropping it from
// the analytics copy while keeping it in the archive is the whole argument for
// two stores in one sentence.
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
 * The intended default is Parquet — that is the point of provisioning a curated
 * copy. It is not the default yet because of one unmeasured question, and
 * shipping it before that answer would put fabricated numbers on a new tenant's
 * first screen rather than slow ones.
 *
 * Under `automaticSchema: true` an absent field reads back as `""` or `0`. Five
 * classes of aggregate break, three of them never measured, and the worst is
 * unfixable by any query rewrite: a `percentile` over a sparse numeric cannot
 * exclude the synthetic zeros without also excluding the real ones. A technique
 * counter measured **18 against 43,338** on the same window.
 *
 * WHAT FLIPS IT: `automaticSchema: false` with an explicit `parquetSchema`
 * marking every field optional. That was rejected at ~319 sparse fields as a
 * silent-data-loss surface — but the curated copy is ~60 columns whose types the
 * pipeline already guarantees, which is what makes it tractable. If nullability
 * survives, every class disappears with no query changes at all and this
 * constant becomes `'lake-parquet'`.
 *
 * Until then a tenant can still CHOOSE Parquet; they are simply not defaulted
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
    'This opens the underlying records. The analytics copy is curated and drops `_raw`, so a drill-down there would show a narrower row than the number that led to it. It always reads the JSON archive.',
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
  /** The curated Parquet copy, when one has been provisioned. */
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
        ? 'A curated columnar copy — `_raw` and the unused fields dropped, so a scan reads far less. Billed per query. Not yet the default: see the note about absent fields.'
        : 'Not provisioned on this workspace. Guided Setup can create it alongside the archive.'
    case 'lakehouse':
      return datasets.lakehouse
        ? 'Queries run on an engine you have already provisioned, so they cost nothing beyond its tier.'
        : 'No Cribl Search Lakehouse engine is configured for this app.'
  }
}
