// The Parquet completeness check, against modelled cribl_metrics rows.
//
// A check that has never refused has not been shown to work (Phase 8 design,
// 8.1 exit criteria), so the seeded gap is the point of this file.

import { afterEach, describe, expect, it } from 'vitest'
import { PACK_ID, PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID } from '../pack'
import {
  COMPLETENESS_BUCKET_SECONDS,
  COMPLETENESS_QUERY,
  PACK_JSON_OUTPUT_LABEL,
  PACK_PARQUET_OUTPUT_LABEL,
} from '../../queries/routing'
import { bucketVerdict, forgetCompleteness, recordCompleteness, resolveWindow, windowCompleteness } from './completeness'

const B = COMPLETENESS_BUCKET_SECONDS
const T0 = 1_790_157_600 // a bucket boundary: 1_790_157_600 % 300 === 0
const bucket = (i: number, json: number, pq: number) => ({ _time: T0 + i * B, json_events: json, pq_events: pq })
/** Three full buckets, 15 minutes, both destinations writing the same. */
const WHOLE = [bucket(0, 87_000, 87_000), bucket(1, 86_500, 86_500), bucket(2, 88_100, 88_090)]
const WINDOW = { earliest: T0, latest: T0 + 3 * B }
const AFTER = T0 + 3 * B + 60

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
    expect(windowCompleteness(WINDOW, AFTER).why).toContain('checked before the window ended')
  })

  it('refuses a window ending now, whose last bucket nobody can have closed', () => {
    recordCompleteness(WHOLE, AFTER)
    expect(windowCompleteness({ earliest: '-15m', latest: 'now' }, AFTER).complete).toBe(false)
  })

  it('refuses a window it cannot resolve rather than guessing', () => {
    expect(windowCompleteness({ earliest: '-1h@h', latest: 'now' }, AFTER).complete).toBe(false)
    expect(resolveWindow({ earliest: '-15m', latest: 'now' }, 1000)).toEqual({ earliest: 100, latest: 1000 })
  })

  it('is empty on a fresh page: nothing runs the check today', () => {
    expect(windowCompleteness(WINDOW, AFTER).complete).toBe(false)
  })

  it('keeps the newer check of a bucket, not the older', () => {
    recordCompleteness([bucket(1, 86_500, 80_000)], AFTER)
    recordCompleteness(WHOLE, AFTER + 60)
    expect(windowCompleteness(WINDOW, AFTER + 60).complete).toBe(true)
  })
})
