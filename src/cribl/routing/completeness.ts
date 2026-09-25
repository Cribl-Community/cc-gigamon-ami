// Whether the Parquet copy is COMPLETE over a window — the check a live panel
// needs before it reads `gigamon_ami_pq` (Phase 8 design §4, 8.1; risk R1).
//
// The query is src/queries/routing.ts's COMPLETENESS_QUERY: Stream's own
// `total.out_events` for the pack's Parquet destination against its JSON one,
// per five-minute bucket. This module turns its rows into a verdict per bucket,
// keeps the verdicts for the page, and answers "is every bucket of this window
// proven complete?".
//
// ── NOT WIRED TO RUN ────────────────────────────────────────────────────────
// Nothing submits the query today, because no query is routed. So the cache is
// always empty, and every window answers "not proven" — which the router reads
// as JSON. The first routing change must also decide when the check runs (it is
// a second job with the ~5 s floor, cost unmeasured), and nothing here runs it
// on a load, a render or a timer.
//
// ── EVERY DOUBT REFUSES ─────────────────────────────────────────────────────
// A bucket is `complete` only when the JSON destination wrote something AND the
// Parquet one wrote the same within COMPLETENESS_TOLERANCE. No row for a bucket,
// a bucket where JSON wrote nothing (nothing to be complete about, or the pack
// is not what feeds `gigamon_ami`), a bucket that had not SETTLED when it was
// checked (below), and a window this cannot resolve to absolute seconds all
// refuse. Refusing costs a JSON read, which is always right; routing wrongly
// costs a wrong number.
//
// ── SETTLED, NOT MERELY CLOSED ──────────────────────────────────────────────
// A bucket proves something only when it was checked at least
// COMPLETENESS_SETTLE_SECONDS after it ENDED — not after the window ended, and
// not merely after it ended. A counter row says an event reached the
// destination; the event is queryable only once its file closes, up to the
// destination's `maxFileOpenTimeSec` later (R8). So a window that ends at "now"
// always refuses: its last bucket is still open, whatever second the check ran
// in. *(Corrected 2026-09-25, review of `feat/phase8-1-router`: the rule
// compared the check with `min(bucket end, window end)` using `<`, so a check
// made in the same epoch second as a window ending "now" passed an open bucket,
// and the test that claimed to prove refusal refused for a missing record.)*
//
// ── WHAT THIS CANNOT PROVE ──────────────────────────────────────────────────
// * That a counted event is queryable: Parquet files close on an interval, so an
//   event written to the destination may not be in Lake yet (R8). The settle
//   margin is the only allowance for that, and for the delay before Stream's
//   own counter rows reach `cribl_metrics`, which is unmeasured.
// * That `total.out_events` excludes a dropped event (unmeasured).
// * That the pack's JSON output is the only writer of `gigamon_ami` (see
//   src/queries/routing.ts).

import { COMPLETENESS_BUCKET_SECONDS as BUCKET } from '../../queries/routing'

/**
 * The relative difference a bucket may carry and still count as complete. The
 * two destinations sit on the same route set and should count the same events;
 * 0.1 % allows a counter row landing either side of a bucket edge and no real
 * hole. Judgement, not measurement.
 */
export const COMPLETENESS_TOLERANCE = 0.001

/**
 * How long after a bucket ENDS it must have been checked to count: 360 s.
 *
 * WHERE IT COMES FROM. The one landing lag this project has measured is the
 * file-open time: a two-minute sample window ending two minutes back came up
 * roughly half empty under a 120 s open time, and ending three minutes back —
 * the 120 s plus a minute — fixed it (accel/manifest.ts, `gno_sample_2m_c1h`;
 * every schedule's `-3m` end keeps the same margin). The pack's Parquet
 * destination ships with 60 s, but a tenant can override it, and the longest
 * open time any flush preset this app offers is Cribl's own default, 300 s
 * (landing.ts `FLUSH_PRESETS`). So: the longest open time a destination here
 * may carry, plus the same minute of spare. completeness.test.ts holds it at
 * or above that sum, read from the pack's outputs.yml and the presets.
 *
 * NOT MEASURED: how late `total.out_events` rows arrive in `cribl_metrics`.
 * The minute of spare is the only allowance for it.
 */
export const COMPLETENESS_SETTLE_SECONDS = 360

export type BucketVerdict = 'complete' | 'gap' | 'empty'

export interface BucketRecord {
  /** Bucket start, epoch seconds. */
  start: number
  json: number
  parquet: number
  verdict: BucketVerdict
  /** When the rows were read, epoch seconds. A bucket still open then proves only its past. */
  checkedAt: number
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** One bucket's verdict from its two counters. */
export function bucketVerdict(json: number, parquet: number): BucketVerdict {
  if (!(json > 0)) return 'empty'
  return Math.abs(parquet - json) <= COMPLETENESS_TOLERANCE * json ? 'complete' : 'gap'
}

/** The rows of one COMPLETENESS_QUERY run, as bucket records. Rows without a usable `_time` are dropped. */
export function bucketRecords(rows: ReadonlyArray<Readonly<Record<string, unknown>>>, checkedAt: number): BucketRecord[] {
  const out: BucketRecord[] = []
  for (const r of rows) {
    const t = Number(r._time)
    if (!Number.isFinite(t)) continue
    const start = Math.floor(t / BUCKET) * BUCKET
    const json = num(r.json_events)
    const parquet = num(r.pq_events)
    out.push({ start, json, parquet, verdict: bucketVerdict(json, parquet), checkedAt })
  }
  return out
}

// ── The page's verdicts ─────────────────────────────────────────────────────
// Page-lifetime, never stored: a verdict about a window is about data that
// retention will delete, and a stored "complete" would outlive what it proved.

const cache = new Map<number, BucketRecord>()

/** Keep one run's verdicts. A newer check of a bucket replaces an older one. */
export function recordCompleteness(rows: ReadonlyArray<Readonly<Record<string, unknown>>>, checkedAt: number): void {
  for (const rec of bucketRecords(rows, checkedAt)) {
    const had = cache.get(rec.start)
    if (!had || had.checkedAt <= rec.checkedAt) cache.set(rec.start, rec)
  }
}

/** Tests only. */
export function forgetCompleteness(): void {
  cache.clear()
}

export interface WindowSpan {
  earliest: string | number
  latest: string | number
}

/**
 * A search window as absolute epoch seconds: a number is taken as epoch
 * seconds, `now` as `now`, and `-<n><s|m|h|d>` relative to it. Anything else —
 * a snap (`-1h@h`), a date string — is null: this does not guess.
 */
export function resolveWindow(w: WindowSpan, now: number): { earliest: number; latest: number } | null {
  const at = (v: string | number): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    const s = v.trim()
    if (s === 'now') return now
    const m = /^-(\d+)([smhd])$/.exec(s)
    return m ? now - Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'] : null
  }
  const earliest = at(w.earliest)
  const latest = at(w.latest)
  return earliest !== null && latest !== null && latest > earliest ? { earliest, latest } : null
}

export interface WindowVerdict {
  complete: boolean
  /** Why not, in words; null when complete. */
  why: string | null
}

/**
 * Whether every bucket the window touches was checked at least
 * COMPLETENESS_SETTLE_SECONDS after that bucket ended, and found complete.
 * `now` is epoch seconds; a record dated after `now` counts as checked at `now`,
 * since a clock this cannot check is not evidence.
 */
export function windowCompleteness(w: WindowSpan, now: number, records: ReadonlyMap<number, BucketRecord> = cache): WindowVerdict {
  const abs = resolveWindow(w, now)
  if (!abs) return { complete: false, why: 'the window is not one this can resolve to absolute times' }
  for (let start = Math.floor(abs.earliest / BUCKET) * BUCKET; start < abs.latest; start += BUCKET) {
    const rec = records.get(start)
    const when = new Date(start * 1000).toISOString()
    if (!rec) return { complete: false, why: `no completeness check covers the bucket from ${when}` }
    if (rec.verdict === 'gap') return { complete: false, why: `the Parquet copy is missing records in the bucket from ${when} (${rec.parquet} of ${rec.json})` }
    if (rec.verdict === 'empty') return { complete: false, why: `the JSON destination wrote nothing in the bucket from ${when}, so there was nothing to compare` }
    const settledAt = start + BUCKET + COMPLETENESS_SETTLE_SECONDS
    if (Math.min(rec.checkedAt, now) < settledAt) {
      return {
        complete: false,
        why: `the bucket from ${when} had not settled when it was checked: it ends at ${new Date((start + BUCKET) * 1000).toISOString()}, and its files and counters can land up to ${COMPLETENESS_SETTLE_SECONDS} s after that`,
      }
    }
  }
  return { complete: true, why: null }
}
