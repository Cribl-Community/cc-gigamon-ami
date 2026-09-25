// The Parquet completeness check, against modelled cribl_metrics rows.
//
// A check that has never refused has not been shown to work (Phase 8 design,
// 8.1 exit criteria), so the seeded gap is the point of this file.

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { FLUSH_PRESETS } from '../landing'
import { PACK_ID, PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID } from '../pack'
import {
  COMPLETENESS_BUCKET_SECONDS,
  COMPLETENESS_QUERY,
  PACK_JSON_OUTPUT_LABEL,
  PACK_PARQUET_OUTPUT_LABEL,
} from '../../queries/routing'
import {
  COMPLETENESS_BUCKET_COLUMN,
  COMPLETENESS_SETTLE_SECONDS as SETTLE,
  bucketRecords,
  bucketVerdict,
  forgetCompleteness,
  recordCompleteness,
  resolveWindow,
  windowCompleteness,
} from './completeness'

const B = COMPLETENESS_BUCKET_SECONDS
const T0 = 1_790_157_600 // a bucket boundary: 1_790_157_600 % 300 === 0
// A live row names a `bin(_time, 5m)` key `bin_time_5m`, never `_time`.
const bucket = (i: number, json: number, pq: number) => ({ bin_time_5m: T0 + i * B, json_events: json, pq_events: pq })
/** Three full buckets, 15 minutes, both destinations writing the same. */
const WHOLE = [bucket(0, 87_000, 87_000), bucket(1, 86_500, 86_500), bucket(2, 88_100, 88_090)]
const WINDOW = { earliest: T0, latest: T0 + 3 * B }
/** Checked once the window's last bucket had closed AND settled. */
const AFTER = T0 + 3 * B + SETTLE + 60

afterEach(() => forgetCompleteness())

describe('the query', () => {
  it('names the pack outputs the way cribl_metrics labels them inside a pack', () => {
    // Measured: `cribl_lake:<packId>.<outputId>`. Ids imported, never retyped.
    expect(PACK_PARQUET_OUTPUT_LABEL).toBe('cribl_lake:cc-network-gigamon-ami.gigamon_ami_parquet_lake')
    expect(PACK_JSON_OUTPUT_LABEL).toBe(`cribl_lake:${PACK_ID}.${PACK_JSON_OUTPUT_ID}`)
    expect(PACK_PARQUET_OUTPUT_LABEL).toBe(`cribl_lake:${PACK_ID}.${PACK_PARQUET_OUTPUT_ID}`)
    expect(COMPLETENESS_QUERY).toContain(`output=="${PACK_JSON_OUTPUT_LABEL}"`)
    expect(COMPLETENESS_QUERY).toContain(`output=="${PACK_PARQUET_OUTPUT_LABEL}"`)
  })

  it('compares destination counters only — pipeline labels inside a pack are unmeasured', () => {
    expect(COMPLETENESS_QUERY).toContain('metric=="total.out_events"')
    expect(COMPLETENESS_QUERY).not.toMatch(/pipe\.|\bid==|pipeline/)
  })

  it('bins by the bucket size the verdicts are kept at', () => {
    expect(COMPLETENESS_QUERY).toContain(`bin(_time, ${B / 60}m)`)
  })

  it('reads the bucket start from the column Cribl names a bin key, bin_time_<span>', () => {
    expect(COMPLETENESS_BUCKET_COLUMN).toBe(`bin_time_${B / 60}m`)
    // A live row: no `_time` at all. Before 2026-09-25 this row was dropped.
    expect(bucketRecords([{ bin_time_5m: T0, json_events: 10, pq_events: 10 }], AFTER)).toEqual([
      { start: T0, json: 10, parquet: 10, verdict: 'complete', checkedAt: AFTER },
    ])
    // `_time` is still read when the bin column is not there; a row with neither is dropped.
    expect(bucketRecords([{ _time: T0 + B, json_events: 1, pq_events: 1 }], AFTER).map((r) => r.start)).toEqual([T0 + B])
    expect(bucketRecords([{ json_events: 1, pq_events: 1 }], AFTER)).toEqual([])
  })
})

describe('one bucket', () => {
  it('is complete when Parquet wrote what JSON wrote, within 0.1 %', () => {
    expect(bucketVerdict(88_100, 88_090)).toBe('complete')
  })
  it('is a gap when Parquet wrote less', () => {
    expect(bucketVerdict(87_000, 82_650)).toBe('gap')
  })
  it('is a gap when Parquet wrote MORE — a double count is not completeness', () => {
    expect(bucketVerdict(87_000, 90_000)).toBe('gap')
  })
  it('proves nothing when JSON wrote nothing', () => {
    expect(bucketVerdict(0, 0)).toBe('empty')
  })
})

describe('a window', () => {
  it('is complete when every bucket in it was checked after it ended and agreed', () => {
    recordCompleteness(WHOLE, AFTER)
    expect(windowCompleteness(WINDOW, AFTER)).toEqual({ complete: true, why: null })
  })

  it('REFUSES on a seeded gap in one bucket', () => {
    recordCompleteness([bucket(0, 87_000, 87_000), bucket(1, 86_500, 82_175), bucket(2, 88_100, 88_100)], AFTER)
    const v = windowCompleteness(WINDOW, AFTER)
    expect(v.complete).toBe(false)
    expect(v.why).toContain('missing records')
    expect(v.why).toContain('82175 of 86500')
  })

  it('refuses a bucket no check covered', () => {
    recordCompleteness([WHOLE[0], WHOLE[2]], AFTER)
    expect(windowCompleteness(WINDOW, AFTER).why).toContain('no completeness check covers')
  })

  it('refuses a bucket that was still open when it was checked', () => {
    recordCompleteness(WHOLE, T0 + 2 * B + 30)
    expect(windowCompleteness(WINDOW, AFTER).why).toContain('had not settled')
  })

  it('refuses a window ending now, whose last bucket nobody can have closed — even checked this very second', () => {
    // A record for EVERY bucket the window touches, the open one included, all
    // `complete`, all checked at `now`. The only thing left to refuse on is
    // that the last bucket is still open: this is the open-bucket rule itself,
    // not a missing record.
    const now = T0 + 3 * B + 100
    recordCompleteness([...WHOLE, bucket(3, 30_000, 30_000)], now)
    const v = windowCompleteness({ earliest: '-15m', latest: 'now' }, now)
    expect(v.complete).toBe(false)
    expect(v.why).not.toContain('no completeness check covers')
    expect(v.why).toContain('had not settled')
  })

  it('refuses a bucket that closed less than the settle margin before it was checked', () => {
    // Every bucket ended before the check, but the last one only 30 s before:
    // its Parquet files and its counter rows may not have landed.
    recordCompleteness(WHOLE, T0 + 3 * B + 30)
    const v = windowCompleteness(WINDOW, T0 + 3 * B + 30)
    expect(v.complete).toBe(false)
    expect(v.why).toContain('had not settled')
  })

  it('accepts the same records once the settle margin has passed', () => {
    recordCompleteness(WHOLE, T0 + 3 * B + SETTLE)
    expect(windowCompleteness(WINDOW, T0 + 3 * B + SETTLE).complete).toBe(true)
  })

  it('refuses a record dated after now rather than trusting a clock it cannot check', () => {
    recordCompleteness(WHOLE, AFTER)
    expect(windowCompleteness(WINDOW, T0 + 3 * B + 30).complete).toBe(false)
  })

  it('refuses a window it cannot resolve rather than guessing', () => {
    expect(windowCompleteness({ earliest: '-1h@h', latest: 'now' }, AFTER).complete).toBe(false)
    expect(resolveWindow({ earliest: '-15m', latest: 'now' }, 1000)).toEqual({ earliest: 100, latest: 1000 })
  })

  it('is empty on a fresh page: nothing runs the check today', () => {
    expect(windowCompleteness(WINDOW, AFTER).complete).toBe(false)
  })

  it('settles for at least as long as any file this app lets a Lake destination hold open, plus a minute', () => {
    // The pack's Parquet destination as shipped, and every flush preset the
    // Lake landing panel offers (a tenant may give the pack's destination any
    // of them): a counted event is not queryable until its file closes.
    const outputs = readFileSync('packs/cc-network-gigamon-ami/default/outputs.yml', 'utf8')
    const pq = /gigamon_ami_parquet_lake:[\s\S]*?maxFileOpenTimeSec:\s*(\d+)/.exec(outputs)
    expect(pq, 'the pack names its Parquet destination and its open time').not.toBeNull()
    const longest = Math.max(Number(pq![1]), ...Object.values(FLUSH_PRESETS).map((p) => p.maxFileOpenTimeSec))
    expect(SETTLE).toBeGreaterThanOrEqual(longest + 60)
  })

  it('keeps the newer check of a bucket, not the older', () => {
    recordCompleteness([bucket(1, 86_500, 80_000)], AFTER)
    recordCompleteness(WHOLE, AFTER + 60)
    expect(windowCompleteness(WINDOW, AFTER + 60).complete).toBe(true)
  })
})
