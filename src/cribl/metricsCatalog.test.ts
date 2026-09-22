// What this file holds still, and what it deliberately cannot.
//
// HOLDS: that no metric name can reach the wire in a shape Prometheus rejects;
// that the three histogram bucket arrays can answer the percentile questions
// the panels ask of them; that F9 stays bound to the two arrays the Security
// and Findings tabs are built from; and that the series arithmetic reproduces
// the figures §2.3 recorded, including the three factors a first pass gets
// wrong (P, the histogram's three names, and measured-not-multiplied keys).
//
// CANNOT: say whether any of this is true ON THE WIRE. Whether `_bucket` is
// cumulative, whether `+Inf` equals `_count`, whether the store accepts
// `histogram_quantile` on classic buckets — all unverified (U2, U3), all spike
// S3. A green run here means the catalogue is internally consistent and the
// arithmetic is right; it is not evidence that a series ever existed.
import { describe, expect, it } from 'vitest'

import { FINDINGS } from '../data/findings'
import { TECHNIQUES } from '../data/techniques'
import {
  BUCKETS,
  CARDINALITY_BANDS,
  DEFAULT_PROCESSES,
  FAMILIES,
  FINDING_METRICS,
  LABELS,
  MEASURED,
  METRIC_NAME_RE,
  PREFIX,
  REFUSE_AT,
  SIGNAL_METRICS,
  allMetrics,
  bandOf,
  bracketsAll,
  budgetSeries,
  guardFor,
  inInteriorBucket,
  keyCeiling,
  labelsOf,
  largestMetric,
  metricSafe,
  seriesByMetric,
  unknownLabels,
} from './metricsCatalog'

/** Every name that would actually reach the store, histogram expansions included. */
const emittedNames = () => FAMILIES.flatMap((f) => seriesByMetric(f).map((s) => s.name))
const family = (id: string) => FAMILIES.find((f) => f.id === id)!

describe('metric names', () => {
  it('every catalogue entry is a legal, prefixed name', () => {
    for (const m of allMetrics()) {
      expect(m.name, m.name).toMatch(METRIC_NAME_RE)
      expect(m.name.startsWith(PREFIX), m.name).toBe(true)
    }
  })

  // The expansions are what a PromQL query actually spells, and `_bucket` is
  // appended to a name this file never validates directly.
  it('every EMITTED name is legal too', () => {
    for (const name of emittedNames()) expect(name, name).toMatch(METRIC_NAME_RE)
  })

  it('no two metrics share a name', () => {
    const names = emittedNames()
    expect([...new Set(names)]).toHaveLength(names.length)
  })

  it('every metric says what it serves', () => {
    for (const m of allMetrics()) expect(m.serves.length, m.name).toBeGreaterThan(0)
  })

  it('a histogram names a bucket array and nothing else does', () => {
    for (const m of allMetrics()) {
      if (m.kind === 'histogram') expect(m.buckets, m.name).toBeTruthy()
      else expect(m.buckets, m.name).toBeUndefined()
    }
  })
})

describe('metricSafe', () => {
  // T1021.b is real and in TECHNIQUES today. It is `behaviour`, so it produces
  // no metric — which is exactly why this has to be tested directly: every
  // other test in this file would pass with a lowercase-only derivation.
  it('survives the dotted id the repo already contains', () => {
    expect(metricSafe('T1021.b')).toBe('t1021_b')
    expect(`${PREFIX}signal_${metricSafe('T1021.b')}`).toMatch(METRIC_NAME_RE)
  })

  it('every id in either source array yields a legal name, whatever its kind', () => {
    for (const id of [...TECHNIQUES.map((t) => t.id), ...FINDINGS.map((f) => f.id)]) {
      expect(`${PREFIX}signal_${metricSafe(id)}`, id).toMatch(METRIC_NAME_RE)
    }
  })
})

describe('histogram buckets', () => {
  it.each(Object.keys(BUCKETS) as (keyof typeof BUCKETS)[])('%s is strictly increasing and positive', (key) => {
    const b = BUCKETS[key]
    expect(b.length).toBeGreaterThan(1)
    for (let i = 0; i < b.length; i++) {
      expect(b[i], `${key}[${i}]`).toBeGreaterThan(0)
      if (i > 0) expect(b[i], `${key}[${i}]`).toBeGreaterThan(b[i - 1])
    }
  })

  // The defect the Phase 2 judges found in two of the three source designs: a
  // first bucket that already contains the median, so the median is
  // unmeasurable and the histogram answers nothing anyone asked it.
  it.each(Object.entries(MEASURED))('%s: p50/p95/p99 land in three distinct interior buckets', (name, d) => {
    expect(bracketsAll(BUCKETS[d.buckets], d), `${name} against BUCKETS.${d.buckets}`).toBe(true)
  })

  it.each(Object.entries(MEASURED))('%s: the observed max is inside the range, not in overflow', (name, d) => {
    expect(inInteriorBucket(BUCKETS[d.buckets], d.max), name).toBe(true)
  })

  it.each(Object.entries(MEASURED))('%s: p50 is not in the first bucket', (name, d) => {
    expect(d.p50, name).toBeGreaterThan(BUCKETS[d.buckets][0])
  })

  it('every bucket array is reachable from some histogram', () => {
    const used = new Set(allMetrics().map((m) => m.buckets).filter(Boolean))
    expect([...used].sort()).toEqual(Object.keys(BUCKETS).sort())
  })
})

// ── The binding rule ────────────────────────────────────────────────────────
//
// This is the section slice 6.1 exists for. Each of these recomputes the
// expected set from the tab's own constant, so it fails the moment a technique
// or a finding is added, removed or re-kinded without the catalogue following.
describe('F9 is derived from the tabs, not retyped', () => {
  it('one signal metric per FLOW technique, and none for a behaviour one', () => {
    const flow = TECHNIQUES.filter((t) => t.kind === 'flow')
    expect(SIGNAL_METRICS).toHaveLength(flow.length)
    const names = SIGNAL_METRICS.map((m) => m.name)
    for (const t of flow) expect(names).toContain(`${PREFIX}signal_${metricSafe(t.id)}`)
    for (const t of TECHNIQUES.filter((t) => t.kind === 'behaviour')) {
      expect(names).not.toContain(`${PREFIX}signal_${metricSafe(t.id)}`)
    }
  })

  it('one finding metric per FINDING, plus exactly one total', () => {
    expect(FINDING_METRICS).toHaveLength(FINDINGS.length + 1)
    const names = FINDING_METRICS.map((m) => m.name)
    for (const f of FINDINGS) expect(names).toContain(`${PREFIX}finding_${metricSafe(f.id)}`)
    expect(names).toContain(`${PREFIX}finding_total`)
  })

  it('F9 contains both sets and nothing else', () => {
    expect(family('F9').metrics.map((m) => m.name).sort()).toEqual(
      [...SIGNAL_METRICS, ...FINDING_METRICS].map((m) => m.name).sort(),
    )
  })

  // The `serves` string is how someone reading a metric in the store finds the
  // tile it mirrors. A derived name with a hand-written `serves` is half-bound.
  it('every signal metric names its technique id in serves', () => {
    for (const t of TECHNIQUES.filter((t) => t.kind === 'flow')) {
      const met = SIGNAL_METRICS.find((m) => m.name.endsWith(metricSafe(t.id)))!
      expect(met.serves, t.id).toContain(t.id)
    }
  })
})

describe('labels', () => {
  it('every label any metric names is a declared label', () => {
    expect(unknownLabels()).toEqual([])
  })

  it('no two label declarations share a name', () => {
    const names = LABELS.map((l) => l.name)
    expect([...new Set(names)]).toHaveLength(names.length)
  })

  it('every label has a positive measured cardinality', () => {
    for (const l of LABELS) expect(l.cardinality, l.name).toBeGreaterThan(0)
  })

  // R9/`dst_service`: a label with no fallback drops the sample from the
  // group-by when the field is absent. `install` is the one that is always
  // present, so it is the only one allowed a null fallback.
  it('only always-present labels may have no fallback', () => {
    for (const l of LABELS) if (l.fallback === null) expect(l.name).toBe('install')
  })

  it('every metric carries install, so two installs stay separable (R10)', () => {
    for (const f of FAMILIES) for (const met of f.metrics) expect(labelsOf(f, met), met.name).toContain('install')
  })
})

// ── Measured keys, not multiplied cardinality ───────────────────────────────
describe('keys are measured, and the product is only a ceiling', () => {
  // The consistency check the two numbers make possible: a key count above the
  // product of its own labels means one of them was mis-measured.
  it('no metric records more keys than its labels could produce', () => {
    for (const f of FAMILIES) {
      for (const met of f.metrics) {
        expect(met.keys, `${met.name} keys vs ceiling`).toBeLessThanOrEqual(keyCeiling(f, met))
      }
    }
  })

  it('every metric has at least one key', () => {
    for (const met of allMetrics()) expect(met.keys, met.name).toBeGreaterThanOrEqual(1)
  })

  // The three worst offenders, named. These are why the product cannot be the
  // estimate: labels in a real feed are functionally dependent, not free.
  it.each([
    ['F1', 'gigamon_flows', 69, 360],
    ['F2', 'gigamon_app_flows', 120, 810],
    ['F7', 'gigamon_tls_sessions_by_server', 122, 1624],
  ])('%s %s: measured %i against a ceiling of %i', (fid, name, keys, ceiling) => {
    const f = family(fid)
    const met = f.metrics.find((x) => x.name === name)!
    expect(met.keys).toBe(keys)
    expect(keyCeiling(f, met)).toBe(ceiling)
  })

  // The number that made this correction necessary. Using the ceiling as the
  // estimate inflates the catalogue 4.7x and refuses a family that is fine.
  it('the ceiling inflates the catalogue 4.7x', () => {
    expect(budgetSeries({ useCeiling: true })).toBe(63_234)
    expect(budgetSeries({ useCeiling: true }) / budgetSeries()).toBeGreaterThan(4.5)
  })

  it('F3b is fine on measured keys and would be REFUSED on the ceiling', () => {
    expect(guardFor(family('F3b')).verdict).toBe('ok')
    expect(guardFor(family('F3b'), { useCeiling: true }).verdict).toBe('refuse')
  })
})

describe('series arithmetic', () => {
  // The numbers §2.3 recorded, reproduced from the constants rather than
  // restated. If a bucket boundary is added, 1,224 changes and this fails —
  // which is the point: the budget is a consequence of the catalogue.
  const f3 = family('F3')

  it("F3's widest metric is the recorded 1,224, and it is a _bucket", () => {
    const worst = largestMetric(f3)
    expect(worst.name).toBe(`${PREFIX}tcp_rtt_seconds_bucket`)
    // 12 keys x 17 `le` (16 boundaries + +Inf) x P=6
    expect(worst.series).toBe(12 * (BUCKETS.rtt.length + 1) * DEFAULT_PROCESSES)
    expect(worst.series).toBe(1224)
  })

  it('_sum and _count are separate names at the recorded 72 each', () => {
    const rows = seriesByMetric(f3)
    expect(rows.find((r) => r.name.endsWith('_sum'))!.series).toBe(72)
    expect(rows.find((r) => r.name.endsWith('_count'))!.series).toBe(72)
  })

  it('a histogram expands to exactly three names', () => {
    const rows = seriesByMetric(f3).filter((r) => r.metric.name === `${PREFIX}tcp_rtt_seconds`)
    expect(rows.map((r) => r.name.replace(`${PREFIX}tcp_rtt_seconds`, ''))).toEqual(['_bucket', '_sum', '_count'])
  })

  it('P multiplies every series — omitting it under-counts by 6x', () => {
    expect(largestMetric(f3, { processes: 1 }).series * DEFAULT_PROCESSES).toBe(largestMetric(f3).series)
  })

  // §2.3's own per-family figures, reproduced.
  it.each([
    ['F3b', `${PREFIX}http_server_seconds_bucket`, 1260],
    ['F4', `${PREFIX}dns_response_seconds_bucket`, 360],
    ['F5', `${PREFIX}http_requests`, 360],
    ['F5c', `${PREFIX}http2_requests`, 240],
    ['F6', `${PREFIX}tls_sessions`, 1152],
    ['F7', `${PREFIX}tls_sessions_by_server`, 732],
  ])('%s: %s is the recorded %i', (fid, name, series) => {
    expect(seriesByMetric(family(fid)).find((r) => r.name === name)!.series).toBe(series)
  })

  // F4's counter keeps dst_service and its histogram drops it. If both took the
  // family set, the histogram would be 12x wider for a percentile nobody reads
  // per service — so this is the assertion that keeps the two apart.
  it('a metric may carry fewer labels than its family', () => {
    const f4 = family('F4')
    const hist = f4.metrics.find((x) => x.kind === 'histogram')!
    expect(labelsOf(f4, hist)).not.toContain('dst_service')
    expect(f4.labels).toContain('dst_service')
    expect(labelsOf(f4, f4.metrics.find((x) => x.kind === 'counter')!)).toContain('dst_service')
  })
})

describe('the band guard', () => {
  it('classifies per metric, on the floors the engine published', () => {
    expect(bandOf(CARDINALITY_BANDS.medium - 1)).toBe('low')
    expect(bandOf(CARDINALITY_BANDS.medium)).toBe('medium')
    expect(bandOf(CARDINALITY_BANDS.high)).toBe('high')
    expect(bandOf(CARDINALITY_BANDS.extreme)).toBe('extreme')
  })

  // §2.3's exit condition for S6: "every metric `low`" at demo cardinality.
  it('every family passes at demo cardinality, and every metric is low', () => {
    for (const f of FAMILIES) {
      const { verdict, band, worst } = guardFor(f)
      expect(verdict, `${f.id} worst=${worst.name}@${worst.series}`).toBe('ok')
      expect(band, f.id).toBe('low')
    }
  })

  // The reason F7 is `guarded: true`. 10,000 SNIs is the real-network figure
  // §2.3 uses; if this ever stops refusing, the guard has stopped working.
  it('F7 refuses at real-network SNI cardinality', () => {
    const { verdict, worst } = guardFor(family('F7'), {
      useCeiling: true,
      cardinality: { ssl_server_name: 10_000 },
    })
    expect(verdict).toBe('refuse')
    expect(worst.series).toBeGreaterThan(1_000_000)
  })

  it('the refusal threshold is the medium floor, not a second opinion', () => {
    expect(REFUSE_AT).toBe(CARDINALITY_BANDS.medium)
  })

  // Both open-ended labels must sit behind a guard, because they are the only
  // ones a real network can blow up without the catalogue changing at all.
  it.each(['ssl_server_name', 'http_host'])('%s appears only in guarded families', (label) => {
    for (const f of FAMILIES) {
      const uses = f.metrics.some((met) => labelsOf(f, met).includes(label))
      if (uses) expect(f.guarded, `${f.id} uses ${label}`).toBe(true)
    }
  })
})

describe('the budget line', () => {
  // §2.3 records ~13,500; summing its own per-family column gives 13,572.
  it('reproduces the recorded catalogue total', () => {
    expect(budgetSeries()).toBe(13_572)
  })

  it('is never what the guard reads', () => {
    // Every family's own worst metric is far below the total, which is why
    // comparing the total to a band would be wrong in both directions.
    const worst = Math.max(...FAMILIES.map((f) => largestMetric(f).series))
    expect(budgetSeries()).toBeGreaterThan(worst)
    expect(bandOf(worst)).toBe('low')
  })

  // §2.3 calls F3's bucket "the largest single metric in the catalogue" at
  // 1,224 — but its own F3b line records 1,260, which is larger. The claim
  // holds only for the UNGUARDED catalogue, which is what ships by default.
  it('F3 is the largest UNGUARDED metric; F3b beats it when enabled', () => {
    const unguarded = Math.max(...FAMILIES.filter((f) => !f.guarded).map((f) => largestMetric(f).series))
    expect(unguarded).toBe(1224)
    expect(largestMetric(family('F3b')).series).toBe(1260)
  })

  it('names about 45 metrics, as the budget says', () => {
    expect(allMetrics().length).toBeGreaterThanOrEqual(40)
    expect(allMetrics().length).toBeLessThanOrEqual(50)
  })
})
