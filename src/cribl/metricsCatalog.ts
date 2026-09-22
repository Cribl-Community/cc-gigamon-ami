// The metric catalogue: what the metrics store would hold, as data.
//
// Pure data and pure functions. No network, no React, no route — so the tab,
// the wizard, the estimator and the tests all read ONE description of the
// catalogue instead of four that drift.
//
// THE RULE THIS FILE EXISTS TO ENFORCE. A metric that mirrors a dashboard tile
// is DERIVED from the same constant the tile is built from, never retyped. F9
// mirrors the Security tab's techniques and the Findings tab's detections, so
// its metric names come from `TECHNIQUES` and `FINDINGS` themselves. Retyping
// them would let a metric keep reporting a signal the tab had stopped
// evaluating — the one failure nobody would see, because both halves would look
// internally consistent.
//
// Source: designs/t3-metrics-final.md §2.3 (the catalogue), and the live engine
// read on 2026-09-22 for the bands.
import { FINDINGS } from '../data/findings'
import { TECHNIQUES } from '../data/techniques'

/**
 * Prometheus metric-name grammar, as this catalogue applies it.
 *
 * Prometheus itself allows `[a-zA-Z_:][a-zA-Z0-9_:]*`, so uppercase is legal.
 * This catalogue is stricter on purpose: lowercase snake_case is the convention
 * every exporter follows, and a mixed-case name is the kind of thing that reads
 * fine in a design document and then has to be renamed after the first series
 * exists — at which point the old series live on until retention.
 *
 * THE DESIGN'S OWN EXAMPLES VIOLATE THIS. §2.3 writes the technique metrics as
 * `gigamon_signal_T1572` and the same section's test rule as
 * `^[a-z_][a-z0-9_]*$`. Both cannot hold. The name is lowercased here and the
 * technique id is kept intact in the `serves` field, so the mapping back to
 * T1572 is still one lookup and nothing is lost.
 */
export const METRIC_NAME_RE = /^[a-z_][a-z0-9_]*$/

/** Prefix every metric in this catalogue carries. */
export const PREFIX = 'gigamon_'

/**
 * A repo id, as a metric-name segment.
 *
 * Lowercases, and replaces everything outside the grammar with `_`. The second
 * half is not hypothetical: `TECHNIQUES` already contains `T1021.b`, whose dot
 * would make `gigamon_signal_t1021.b` — a name Prometheus rejects. It is a
 * `behaviour` technique today and so carries no counter, which means a
 * lowercase-only derivation would pass every test in this file and break the
 * day someone gave that technique a per-flow predicate. Deriving names is only
 * safe if the derivation handles ids the source array is allowed to contain.
 */
export function metricSafe(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

// ── Cardinality bands ───────────────────────────────────────────────────────
//
// READ FROM THE LIVE ENGINE on 2026-09-22, not chosen here:
// `GET /products/lakehouse_engine_metrics/catalog-settings` answers
// `{"cardinality":{"medium":10000,"high":100000,"extreme":1000000},
//   "scrapeIntervalSeconds":15}`.
//
// They are duplicated as constants because the guard has to run in the wizard
// before any engine call, and a band that arrives late is a band that cannot
// stop a bad choice. `metricsStore.ts` re-reads them live and reports a
// mismatch rather than silently preferring either copy.
export const CARDINALITY_BANDS = Object.freeze({ medium: 10_000, high: 100_000, extreme: 1_000_000 })
export const SCRAPE_INTERVAL_SECONDS = 15

/**
 * Which band a single metric's series count falls in.
 *
 * PER METRIC, never the catalogue total — §2.3 is explicit: "the catalogue
 * total is never compared to a band". The largest single metric at demo
 * cardinality is `gigamon_tcp_rtt_seconds_bucket` at 1,224, which is `low`
 * against a medium floor of 10,000.
 */
export type Band = 'low' | 'medium' | 'high' | 'extreme'
export function bandOf(series: number): Band {
  if (series >= CARDINALITY_BANDS.extreme) return 'extreme'
  if (series >= CARDINALITY_BANDS.high) return 'high'
  if (series >= CARDINALITY_BANDS.medium) return 'medium'
  return 'low'
}

// ── Histogram buckets ───────────────────────────────────────────────────────
//
// In SECONDS, Prometheus convention. Chosen so p50, p95 and p99 each land in a
// DISTINCT interior bucket — a histogram whose first bucket already contains
// the median cannot answer anything about the median, which is the defect the
// Phase 2 judges found in two of the three source designs.
//
// `bracketsAll` below is what holds that true; the measured distributions it
// checks against are recorded beside it so the arrays can be re-tuned against a
// real network without re-deriving where the numbers came from.
export const BUCKETS = Object.freeze({
  /** `tcp_rtt`, `tcp_rtt_app` */
  rtt: Object.freeze([1e-5, 2.5e-5, 5e-5, 1e-4, 2.5e-4, 5e-4, 1e-3, 2.5e-3, 5e-3, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]),
  /** `http_server_s` — the pipeline's `(resp_ts − req_ts) × 1000`, divided by 1000 in the Eval */
  http: Object.freeze([1e-5, 2.5e-5, 5e-5, 1e-4, 2.5e-4, 5e-4, 1e-3, 2.5e-3, 5e-3, 0.01, 0.025, 0.05, 0.1, 0.25]),
  /** `dns_response_time` */
  dns: Object.freeze([5e-6, 1e-5, 2.5e-5, 5e-5, 1e-4, 2.5e-4, 5e-4, 1e-3, 2.5e-3, 5e-3, 0.01, 0.025, 0.05, 0.1]),
})

/**
 * The DEMO distributions the arrays above were cut against (seconds), measured
 * 2026-09-15. These are this workspace's, not a real network's — §2.3 says so
 * and the wizard repeats it, because a bucket set tuned to a DataGen replay is
 * a starting point and not an answer.
 */
export const MEASURED = Object.freeze({
  tcp_rtt: Object.freeze({ p50: 3.3e-5, p95: 0.015, p99: 0.0879, max: 0.169, buckets: 'rtt' as const }),
  tcp_rtt_app: Object.freeze({ p50: 8.8e-5, p95: 0.015, p99: 0.0879, max: 0.179, buckets: 'rtt' as const }),
  dns_response_time: Object.freeze({ p50: 1.9e-5, p95: 7.0e-4, p99: 5e-3, max: 0.0117, buckets: 'dns' as const }),
  http_server_s: Object.freeze({ p50: 9.8e-5, p95: 1.25e-3, p99: 0.01, max: 0.1, buckets: 'http' as const }),
})

/** Is `v` inside an INTERIOR bucket — neither below the first boundary nor at
 *  or above the last? A value in the overflow bucket is unmeasurable. */
export function inInteriorBucket(buckets: readonly number[], v: number): boolean {
  return v > buckets[0] && v < buckets[buckets.length - 1]
}

/** Do p50, p95 and p99 land in three DISTINCT interior buckets? */
export function bracketsAll(buckets: readonly number[], d: { p50: number; p95: number; p99: number }): boolean {
  const idx = (v: number) => buckets.findIndex((b) => v <= b)
  if (![d.p50, d.p95, d.p99].every((v) => inInteriorBucket(buckets, v))) return false
  const [a, b, c] = [idx(d.p50), idx(d.p95), idx(d.p99)]
  return a !== b && b !== c && a !== c
}


// ── Labels ──────────────────────────────────────────────────────────────────
//
// Every label is a STRING and null-safe: the Eval supplies a default rather
// than omitting the key, because a missing key drops the sample from the
// group-by entirely. `dst_service` is the clearest case — it is present on only
// 6.7% of events, so without the `untagged` default the histogram would
// describe 6.7% of the traffic while looking like it described all of it.
export interface MetricLabel {
  name: string
  /** The AMI field it derives from, or null when it is computed. */
  from: string | null
  /** What a row with no value gets. Null means the label is always present. */
  fallback: string | null
  /**
   * Distinct values measured on the demo feed.
   *
   * NOT a factor to multiply — see `keyCeiling`. It is the per-label figure,
   * useful for the real-network what-if and for spotting a label that is
   * open-ended; the demo estimate uses each metric's measured `keys`.
   */
  cardinality: number
  note?: string
}

export const LABELS: readonly MetricLabel[] = Object.freeze([
  { name: 'install', from: null, fallback: null, cardinality: 1, note: 'the app instance id, so two installs against one engine stay separable' },
  { name: 'dst_service', from: 'dst_aws_flat_tags_name', fallback: 'untagged', cardinality: 12, note: 'present on 6.7% of events' },
  { name: 'src_service', from: 'src_aws_flat_tags_name', fallback: 'untagged', cardinality: 10, note: 'present on 7.6% of events' },
  { name: 'l4', from: 'l4_proto', fallback: 'unknown', cardinality: 3 },
  { name: 'app', from: 'app_name', fallback: 'unknown', cardinality: 90 },
  { name: 'app_class', from: null, fallback: 'other', cardinality: 3, note: 'ai | saas | other, from the repo AI_APPS and SAAS_APPS lists — a FUNCTION of app, not independent of it' },
  { name: 'http_class', from: 'http_code', fallback: 'unknown', cardinality: 5, note: '1xx..5xx' },
  { name: 'http_host', from: 'http_host', fallback: 'unknown', cardinality: 14, note: 'guarded' },
  { name: 'http2_host', from: 'http2_host', fallback: 'unknown', cardinality: 40, note: 'guarded' },
  { name: 'dns_rcode', from: 'dns_reply_code', fallback: 'other', cardinality: 4, note: '0 | 2 | 3 | other' },
  { name: 'tls_neg', from: 'ssl_protocol_version', fallback: 'older', cardinality: 2, note: 'tls13 | older — a FUNCTION of ssl_ver' },
  { name: 'kex', from: null, fallback: 'other', cardinality: 4, note: 'pqc | classical | grease | other — the FOUR-way split of data/pqc.ts classifyGroup, not a two-way one' },
  { name: 'ssl_ver', from: 'ssl_protocol_version', fallback: 'unknown', cardinality: 2 },
  { name: 'ssl_server_name', from: 'ssl_server_name', fallback: 'unknown', cardinality: 58, note: 'guarded; 10k+ in a real network' },
  { name: 'ssl_issuer', from: 'ssl_issuer', fallback: 'unknown', cardinality: 7 },
  { name: 'feed', from: null, fallback: 'unknown', cardinality: 2, note: 'datagen | syslog — records family only' },
])

const LABEL_NAMES = new Set(LABELS.map((l) => l.name))
const cardOf = (name: string) => LABELS.find((l) => l.name === name)?.cardinality ?? 1

// ── Families ────────────────────────────────────────────────────────────────

export type MetricKind = 'counter' | 'gauge' | 'histogram'

export interface CatalogMetric {
  name: string
  kind: MetricKind
  /** Which bucket array, for histograms only. */
  buckets?: keyof typeof BUCKETS
  /**
   * The labels THIS metric carries.
   *
   * Per metric, NOT per family, because two metrics in one family legitimately
   * differ: F4's DNS counter is keyed by `dns_rcode, dst_service` while its
   * latency histogram is keyed by `dns_rcode` alone (a histogram costs 15x a
   * counter per key, so dropping a label buys back the width), and F7's
   * cert-expiry gauge drops the `ssl_issuer` and `kex` its session counter
   * keeps. Omitted means "the family's own set".
   */
  labels?: readonly string[]
  /**
   * MEASURED distinct label-key combinations on the demo feed.
   *
   * The number that actually decides cost, and it is NOT the product of the
   * label cardinalities — see `keyCeiling`.
   */
  keys: number
  /** What this mirrors, in the dashboard's own vocabulary. */
  serves: string
}

export interface MetricFamily {
  id: string
  metrics: readonly CatalogMetric[]
  /** Default label set for metrics that do not name their own. */
  labels: readonly string[]
  /** Off by default outside the demo workspace until its estimate passes. */
  guarded: boolean
  fit: 'GOOD' | 'MID'
  note?: string
}

/**
 * F9, derived rather than written.
 *
 * The Security tab counts one `c_<id>` column per FLOW technique and the
 * Findings tab one aggregate per finding. Both are generated from the arrays
 * below, so a technique that is added, removed or reordered moves the metric
 * set with it. `kind: 'behaviour'` techniques are excluded because they are
 * per-source computations, not per-flow predicates, and have no counter.
 *
 * Every one is keyed by `install` alone, so `keys` is 1 across the board.
 */
export const SIGNAL_METRICS: readonly CatalogMetric[] = Object.freeze(
  TECHNIQUES.filter((t) => t.kind === 'flow').map((t) => ({
    name: `${PREFIX}signal_${metricSafe(t.id)}`,
    kind: 'counter' as const,
    keys: 1,
    serves: `Security tab, ${t.id} ${t.name}`,
  })),
)

export const FINDING_METRICS: readonly CatalogMetric[] = Object.freeze([
  ...FINDINGS.map((f) => ({
    name: `${PREFIX}finding_${metricSafe(f.id)}`,
    kind: 'counter' as const,
    keys: 1,
    serves: `Findings tab, ${f.id}`,
  })),
  { name: `${PREFIX}finding_total`, kind: 'counter' as const, keys: 1, serves: 'Findings tab, total' },
])

const m = (
  name: string,
  kind: MetricKind,
  keys: number,
  serves: string,
  extra: { buckets?: keyof typeof BUCKETS; labels?: readonly string[] } = {},
): CatalogMetric => ({ name: PREFIX + name, kind, keys, serves, ...extra })

export const FAMILIES: readonly MetricFamily[] = Object.freeze([
  {
    id: 'F1', guarded: false, fit: 'GOOD', labels: ['install', 'dst_service', 'src_service', 'l4'],
    note: 'keys 69 = the MEASURED 23 distinct service pairs x l4 <= 3, not 12x10x3 = 360 — only 23 of 120 possible pairs ever occur',
    metrics: [
      m('flows', 'counter', 69, 'Capacity flows'), m('bytes', 'counter', 69, 'Capacity bytes'),
      m('bytes_src', 'counter', 69, 'Data Flow src bytes'), m('bytes_dst', 'counter', 69, 'Data Flow dst bytes'),
      m('packets', 'counter', 69, 'Capacity packets'), m('tcp_resets', 'counter', 69, 'Flow Map resets'),
      m('tcp_dup_ack', 'counter', 69, 'TCP Health dup-ack'), m('tcp_wrong_crc', 'counter', 69, 'TCP Health CRC'),
      m('tcp_loss', 'counter', 69, 'TCP Health loss'),
    ],
  },
  {
    id: 'F2', guarded: false, fit: 'GOOD', labels: ['install', 'app', 'app_class', 'l4'],
    note: 'keys ~120, not 90x3x3 = 810 — app_class is a function of app, so the two never vary independently',
    metrics: [m('app_flows', 'counter', 120, 'Capacity app mix'), m('app_bytes', 'counter', 120, 'Capacity app bytes')],
  },
  {
    id: 'F3', guarded: false, fit: 'GOOD', labels: ['install', 'dst_service'],
    note: 'the largest UNGUARDED metric in the catalogue',
    metrics: [
      m('tcp_rtt_seconds', 'histogram', 12, 'TCP Health network latency', { buckets: 'rtt' }),
      m('tcp_rtt_app_seconds', 'histogram', 12, 'TCP Health app latency', { buckets: 'rtt' }),
    ],
  },
  {
    id: 'F3b', guarded: true, fit: 'MID', labels: ['install', 'dst_service', 'http_host'],
    note: 'guarded on dcount(http_host) <= 100; keys 14 = the hosts, because an HTTP host resolves to essentially one service',
    metrics: [m('http_server_seconds', 'histogram', 14, 'Web & API server p95', { buckets: 'http' })],
  },
  {
    id: 'F4', guarded: false, fit: 'GOOD', labels: ['install', 'dns_rcode', 'dst_service'],
    note: 'the histogram drops dst_service — at 15 series per key it would cost 12x the counter for a percentile nobody reads per service',
    metrics: [
      m('dns_queries', 'counter', 48, 'DNS Health counts'),
      m('dns_response_seconds', 'histogram', 4, 'DNS Health latency', { buckets: 'dns', labels: ['install', 'dns_rcode'] }),
    ],
  },
  {
    id: 'F5', guarded: false, fit: 'GOOD', labels: ['install', 'http_class', 'dst_service'],
    metrics: [m('http_requests', 'counter', 60, 'Web & API requests and errors')],
  },
  {
    id: 'F5b', guarded: true, fit: 'MID', labels: ['install', 'http_host', 'http_class'],
    note: 'guarded <= 500; keys 22, not 14x5 = 70 — most hosts only ever answer 2xx',
    metrics: [m('http_requests_by_host', 'counter', 22, 'Web & API by host')],
  },
  {
    id: 'F5c', guarded: false, fit: 'GOOD', labels: ['install', 'http2_host'],
    note: 'a SEPARATE family: HTTP/2 rows carry no http_code and HTTP/1 rows no http2_host, so one shared group-by set would emit half-null label sets on both',
    metrics: [m('http2_requests', 'counter', 40, 'Web & API HTTP/2')],
  },
  {
    id: 'F6', guarded: false, fit: 'GOOD', labels: ['install', 'tls_neg', 'kex', 'ssl_ver', 'dst_service'],
    metrics: [m('tls_sessions', 'counter', 192, 'TLS Posture and PQC Readiness')],
  },
  {
    id: 'F7', guarded: true, fit: 'MID', labels: ['install', 'ssl_server_name', 'ssl_issuer', 'kex'],
    note: 'guarded on dcount(ssl_server_name) <= 500; keys 122, not 58x7x4 = 1624 — a server presents one issuer and one kex',
    metrics: [
      m('tls_sessions_by_server', 'counter', 122, 'TLS Posture by server'),
      m('tls_cert_not_after_seconds', 'gauge', 58, 'TLS Posture certificate expiry', { labels: ['install', 'ssl_server_name'] }),
    ],
  },
  {
    id: 'F8', guarded: false, fit: 'GOOD', labels: ['install', 'app'],
    note: 'the AI_APPS list only — 35 of the 90 apps',
    metrics: [m('ai_flows', 'counter', 35, 'Shadow AI flows'), m('ai_bytes', 'counter', 35, 'Shadow AI bytes')],
  },
  {
    id: 'F9', guarded: false, fit: 'GOOD', labels: ['install'],
    note: 'DERIVED from TECHNIQUES and FINDINGS — see SIGNAL_METRICS and FINDING_METRICS',
    metrics: [...SIGNAL_METRICS, ...FINDING_METRICS],
  },
  {
    id: 'F10', guarded: false, fit: 'GOOD', labels: ['install', 'feed'],
    metrics: [m('records', 'counter', 2, 'Field Explorer record count'), m('records_bytes', 'counter', 2, 'Field Explorer bytes')],
  },
])

/** Every metric in the catalogue, flattened. */
export function allMetrics(): CatalogMetric[] {
  return FAMILIES.flatMap((f) => [...f.metrics])
}

/** The labels a metric carries, falling back to its family's set. */
export function labelsOf(family: MetricFamily, metric: CatalogMetric): readonly string[] {
  return metric.labels ?? family.labels
}

/** Every label any metric names that is not in `LABELS` — empty when consistent. */
export function unknownLabels(): string[] {
  const used = FAMILIES.flatMap((f) => [...f.labels, ...f.metrics.flatMap((met) => met.labels ?? [])])
  return [...new Set(used.filter((l) => !LABEL_NAMES.has(l)))]
}

// ── Series arithmetic ───────────────────────────────────────────────────────
//
// THE COUNT IS PER METRIC NAME, NOT PER FAMILY. `catalog-settings` classifies
// one metric's `activeSeriesCount`, so a family total compared to a band would
// refuse a wide, cheap family and admit a narrow, expensive one. §2.3: "the
// catalogue total is never compared to a band".
//
// Three things a first pass gets wrong, and each moves the answer by multiples:
//
//  1. **P, the Worker Process count.** Every process flushes its own partial
//     under its own `cribl_wp`, so the store holds P copies of every series.
//     P = 6 on this workspace (N1). Leaving it out under-counts by 6x.
//  2. **A histogram is THREE metric names**, not one: `_bucket` (one series per
//     boundary PLUS `+Inf`), `_sum` and `_count`. Only `_bucket` carries the
//     `le` multiplier, so summing them into one number both over-counts `_sum`
//     and hides which name the guard should be looking at.
//  3. **Keys are MEASURED, not multiplied.** This is the one that bites, and it
//     over-counts rather than under-counts: multiplying label cardinalities puts
//     this catalogue at 63,234 series against a measured 13,572 — 4.7x — because
//     real labels correlate hard. Only 23 of 12x10 possible service pairs ever
//     appear, `app_class` is a function of `app`, `tls_neg` is a function of
//     `ssl_ver`, and a TLS server presents one issuer and one kex rather than
//     all 28 combinations. An estimator built on the product would refuse F3b on
//     the demo feed (15,120 against its real 1,260) and quote a customer a
//     number nearly 5x too high. `keyCeiling` keeps the product available as
//     what it honestly is — an upper bound — and nothing costs it as an estimate.

/** Worker Processes in the group the feed runs in — N1 measured 6 here. */
export const DEFAULT_PROCESSES = 6

/**
 * The guard's two thresholds, from §2.3's cardinality policy.
 *
 * `REFUSE_AT` is deliberately the same number as the medium band floor: a
 * metric the store would call `medium` is one this app will not emit.
 */
export const REFUSE_AT = 10_000
export const WARN_AT = 5_000

/**
 * The PRODUCT of a metric's label cardinalities — an upper bound on `keys`.
 *
 * Never an estimate. It is what `keys` could be if every label varied freely,
 * which no real feed does; it is here for the real-network what-if (where the
 * measured number does not exist yet) and as the consistency check that a
 * recorded `keys` never exceeds it.
 */
export function keyCeiling(
  family: MetricFamily,
  metric: CatalogMetric,
  cardinality: Record<string, number> = {},
): number {
  return labelsOf(family, metric).reduce((n, name) => n * (cardinality[name] ?? cardOf(name)), 1)
}

export interface SeriesOpts {
  /**
   * Per-metric key-count overrides, by metric name — what a real tenant's
   * 15-minute estimate window measures.
   */
  keys?: Record<string, number>
  /**
   * Per-label cardinality overrides. Applies only through `keyCeiling`, so a
   * caller asking "what if this tenant had 10,000 SNIs" gets the bound.
   */
  cardinality?: Record<string, number>
  /** Use the ceiling instead of the measured keys. The real-network what-if. */
  useCeiling?: boolean
  /** Worker Processes. Defaults to `DEFAULT_PROCESSES`. */
  processes?: number
}

/** The key count this estimate should use for one metric. */
export function keysFor(family: MetricFamily, metric: CatalogMetric, opts: SeriesOpts = {}): number {
  const override = opts.keys?.[metric.name]
  if (override !== undefined) return override
  if (opts.useCeiling) return keyCeiling(family, metric, opts.cardinality ?? {})
  return metric.keys
}

/** One emitted metric NAME and the series it would hold. */
export interface MetricSeries {
  name: string
  series: number
  /** The catalogue entry it came from — a histogram yields three of these. */
  metric: CatalogMetric
}

/**
 * Every metric name a family emits, with its series count.
 *
 * A histogram expands into the three names Prometheus actually stores, because
 * those are the names `catalog-settings` bands and the names a query has to
 * spell. One catalogue entry, three rows.
 */
export function seriesByMetric(family: MetricFamily, opts: SeriesOpts = {}): MetricSeries[] {
  const p = opts.processes ?? DEFAULT_PROCESSES
  return family.metrics.flatMap((metric) => {
    const keys = keysFor(family, metric, opts)
    if (metric.kind !== 'histogram') return [{ name: metric.name, series: keys * p, metric }]
    // +1 for `+Inf`, which is a real series and is the one that equals `_count`.
    const le = (metric.buckets ? BUCKETS[metric.buckets].length : 0) + 1
    return [
      { name: `${metric.name}_bucket`, series: keys * le * p, metric },
      { name: `${metric.name}_sum`, series: keys * p, metric },
      { name: `${metric.name}_count`, series: keys * p, metric },
    ]
  })
}

/** The single widest metric name in a family — what the band guard reads. */
export function largestMetric(family: MetricFamily, opts: SeriesOpts = {}): MetricSeries {
  return seriesByMetric(family, opts).reduce((a, b) => (b.series > a.series ? b : a))
}

/**
 * What the wizard should do with a family, at the given cardinality.
 *
 * Returns the metric that decided it, so the refusal can name the metric rather
 * than the family — a family is refused because of ONE name, and saying which
 * is the difference between "turn off F7" and "turn off the SNI label".
 */
export function guardFor(
  family: MetricFamily,
  opts: SeriesOpts = {},
): { verdict: 'ok' | 'warn' | 'refuse'; worst: MetricSeries; band: Band } {
  const worst = largestMetric(family, opts)
  const verdict = worst.series >= REFUSE_AT ? 'refuse' : worst.series >= WARN_AT ? 'warn' : 'ok'
  return { verdict, worst, band: bandOf(worst.series) }
}

/**
 * The catalogue's total series count.
 *
 * For the budget line in the wizard and NOTHING ELSE — it is never compared to
 * a band. Named `budget` rather than `total` so a caller reaching for a number
 * to band has to notice it picked the wrong one.
 */
export function budgetSeries(opts: SeriesOpts = {}): number {
  return FAMILIES.reduce((n, f) => n + seriesByMetric(f, opts).reduce((s, r) => s + r.series, 0), 0)
}
