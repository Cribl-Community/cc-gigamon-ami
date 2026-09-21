// What actually gets SUBMITTED, as opposed to what display.json froze.
//
// Every frozen query string passes through this module on its way to Cribl, and
// nothing between the two was checked. `q()` builds all but two of the 37 call
// sites' queries, so one edited line there rewrites what every one of them runs
// while every string in display.json stays byte-identical; `withExecPrefix()`
// then prepends a running-time cap that the ⓘ deliberately never shows.
//
// So this pins the seam, not the whole file: the shape `q()` produces, the cap
// table `capSecondsFor()` implements, and the exact body `runSearch` POSTs. The
// last one goes through the real code path with `fetch` stubbed, because the
// claim worth testing is "this is the query the platform receives", and
// `withExecPrefix` is private for good reason.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_CAP_SECONDS, MIN_CAP_SECONDS, POLL_MAX_MS, REUSE_WINDOW, REUSE_WINDOW_SECONDS, capSecondsFor, parseCapTiers, pollDelayMs, q, runSearch } from './search'
import { LAKE_DATASET } from './config'

describe('q', () => {
  it('prefixes the Lake dataset in the exact shape every panel shows', () => {
    // The ⓘ shows this string verbatim and the Copy button hands it to Cribl
    // Search, so the spacing and the quoting are customer-visible, not internal.
    expect(q('| summarize c=count()')).toBe('dataset="gigamon_ami" | summarize c=count()')
    expect(q('app_name="dns" | limit 5')).toBe('dataset="gigamon_ami" app_name="dns" | limit 5')
  })

  it('names the dataset from config rather than a second copy of the string', () => {
    expect(q('| limit 1')).toBe(`dataset="${LAKE_DATASET}" | limit 1`)
    expect(LAKE_DATASET).toBe('gigamon_ami')
  })
})

describe('capSecondsFor', () => {
  it('scales the server-side cap by the window the query reads', () => {
    // A flat cap would cut off the long-range panels; these are the measured
    // steps, and withExecPrefix writes whichever one applies into every job.
    expect(capSecondsFor('-5m')).toBe(120)
    expect(capSecondsFor('-1h')).toBe(120)
    expect(capSecondsFor('-4h')).toBe(300)
    expect(capSecondsFor('-24h')).toBe(600)
    expect(capSecondsFor('-30d')).toBe(900)
  })

  it('treats a bound it cannot parse as the shortest window, not the longest', () => {
    // An unparseable bound spans 0 seconds, so it caps at 120 — the cheap end.
    expect(capSecondsFor('whenever')).toBe(120)
  })
})

/**
 * The gate between an installer's typing (or a hand-edited KV document) and the
 * table every query is submitted under. `setCapTiers` checks that a table is a
 * table; this is where "well-formed and absurd" is caught, and the failure it
 * exists to stop is silent in both directions — a limit too low stops panels
 * that were only slow, one too high lets a runaway query bill for its window.
 */
describe('parseCapTiers', () => {
  it('accepts a table and sorts it, whatever order it arrives in', () => {
    expect(parseCapTiers([{ upToSeconds: 86400, capSeconds: 900 }, { upToSeconds: 3600, capSeconds: 240 }])).toEqual([
      { upToSeconds: 3600, capSeconds: 240 },
      { upToSeconds: 86400, capSeconds: 900 },
    ])
  })

  it('reads a JSON null bound as the unbounded tier', () => {
    // JSON.stringify(Infinity) is null, so this is the shape every stored table
    // comes back in. Read as anything else, the widest band matches nothing.
    expect(parseCapTiers([{ upToSeconds: null, capSeconds: 600 }])).toEqual([{ upToSeconds: Infinity, capSeconds: 600 }])
  })

  it('refuses a limit that is not a limit, at either end', () => {
    expect(parseCapTiers([{ upToSeconds: null, capSeconds: 86400 }])).toBe(null)
    expect(parseCapTiers([{ upToSeconds: null, capSeconds: MAX_CAP_SECONDS + 1 }])).toBe(null)
    expect(parseCapTiers([{ upToSeconds: null, capSeconds: MIN_CAP_SECONDS - 1 }])).toBe(null)
    expect(parseCapTiers([{ upToSeconds: null, capSeconds: 0 }])).toBe(null)
    expect(parseCapTiers([{ upToSeconds: null, capSeconds: -300 }])).toBe(null)
  })

  it('refuses the WHOLE table when one row is bad, rather than quietly dropping it', () => {
    // Dropping the bad row would leave a table nobody wrote, with a different
    // band answering for the missing one. Refusing leaves the table in force.
    expect(parseCapTiers([{ upToSeconds: 3600, capSeconds: 120 }, { upToSeconds: null, capSeconds: 86400 }])).toBe(null)
  })

  it('refuses everything that is not a table of tiers at all', () => {
    for (const value of [null, undefined, 'PT600S', 600, {}, [], [null], ['600'], [{ capSeconds: 600 }, 'x']]) {
      expect(parseCapTiers(value), `parseCapTiers accepted ${JSON.stringify(value) ?? 'undefined'}`).toBe(null)
    }
  })

  it('keeps a shorter limit on a wider window, because that is a position, not corruption', () => {
    // "Anything over an hour fails fast, I only care about the live panels" is a
    // choice an installer is allowed to make.
    expect(parseCapTiers([{ upToSeconds: 3600, capSeconds: 600 }, { upToSeconds: null, capSeconds: 60 }])).toEqual([
      { upToSeconds: 3600, capSeconds: 600 },
      { upToSeconds: Infinity, capSeconds: 60 },
    ])
  })
})

/** The three responses one runSearch makes, in order: submit, poll, read. */
function stubSearch(rows: string[]): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/search/jobs')) return json({ items: [{ id: 'job-test' }] })
    if (String(url).includes('/status')) return json({ items: [{ status: 'completed' }] })
    return { ok: true, status: 200, statusText: 'OK', text: async () => rows.join('\n'), json: async () => ({}) }
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('the query as submitted', () => {
  it('sends the running-time cap in the job body, and the query itself unaltered', async () => {
    const calls = stubSearch(['{"totalEventCount":2,"job":"job-test"}', '{"c":2}'])
    const query = q('| summarize c=count()')
    const res = await runSearch(query, { earliest: '-15m' })

    const submit = calls.find((c) => c.url.endsWith('/search/jobs'))
    expect(submit, 'runSearch did not POST a job').toBeDefined()
    expect(submit!.init.method).toBe('POST')
    const body = JSON.parse(String(submit!.init.body)) as { query: string; earliest: string; latest: string }
    // Spelled out rather than rebuilt from withExecPrefix: this is the string
    // Cribl receives, and the ⓘ shows the half after the semicolon.
    expect(body.query).toBe('set max_running_time_per_search=120; dataset="gigamon_ami" | summarize c=count()')
    expect(body.query.endsWith(query), 'the cap prefix altered the query instead of preceding it').toBe(true)
    expect([body.earliest, body.latest]).toEqual(['-15m', 'now'])
    // The header line is not a result row; the panel must not count it.
    expect(res.rows).toEqual([{ c: 2 }])
    expect(res.totalEventCount).toBe(2)
  })

  it('raises the cap for a pinned long window, exactly as the cap table says', async () => {
    // Data Flow's Lake total pins -30d; a 120 s cap would kill it every time.
    const calls = stubSearch(['{"totalEventCount":0,"job":"job-test"}'])
    await runSearch(q('| summarize c=count()'), { earliest: '-30d' })
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/search/jobs'))!.init.body)) as { query: string }
    expect(body.query.startsWith('set max_running_time_per_search=900; ')).toBe(true)
  })
})

/**
 * Letting Cribl answer from a result it already has.
 *
 * MEASURED (A-SP21): 30.92 s → 0.95 s, zero billed, on a repeat of the same
 * query at the same relative range. What has to be pinned is not the saving —
 * it is WHEN the directive is allowed on a job, because the two ways of getting
 * this wrong are both silent. Sent on a `$vt_results` read it breaks A-D15 and
 * the stored-result path starts negotiating about results with the results
 * table. Sent on a measurement, or on the refresh a viewer just pressed, it
 * answers a question about NOW with an answer from up to two minutes ago.
 */
describe('reusing a result Cribl already has', () => {
  it('asks for it only when the caller says so, and the window is the one A-D15 set', async () => {
    const calls = stubSearch(['{"totalEventCount":0,"job":"job-test"}'])
    await runSearch(q('| limit 1'), { earliest: '-15m', reuse: true })
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/search/jobs'))!.init.body)) as { query: string }
    // Cap first, then the reuse directive, then the query the ⓘ shows. Spelled
    // out rather than rebuilt, because this is the string Cribl receives.
    expect(body.query).toBe(`set max_running_time_per_search=120; set allow_previous_results="${REUSE_WINDOW}"; dataset="gigamon_ami" | limit 1`)
    expect(REUSE_WINDOW).toBe('2min')
    expect(REUSE_WINDOW_SECONDS).toBe(120)
  })

  it('is off unless asked, so a caller that submits a job to MEASURE something still measures', async () => {
    // LakeLandingPanel's landing-lag probe is the case: a reused answer there
    // would report how fresh the Lake was two minutes ago, as a measurement of
    // how fresh it is now.
    const calls = stubSearch(['{"totalEventCount":0,"job":"job-test"}'])
    await runSearch(q('| limit 1'), { earliest: '-15m' })
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/search/jobs'))!.init.body)) as { query: string }
    expect(body.query).not.toContain('allow_previous_results')
  })

  it('refuses it on a $vt_results read even when the caller asks for it (A-D15)', async () => {
    // accel/read.ts passes no `reuse`, so this can only happen through a future
    // call site — which is exactly why the refusal lives in the prefix builder
    // and not in a convention every caller has to remember.
    const calls = stubSearch(['{"totalEventCount":0,"job":"job-test"}'])
    await runSearch('dataset="$vt_results" jobName="gno_lake_30d_c1d"', { earliest: '-7d', reuse: true })
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/search/jobs'))!.init.body)) as { query: string }
    expect(body.query).toBe('set max_running_time_per_search=900; dataset="$vt_results" jobName="gno_lake_30d_c1d"')
    expect(body.query).not.toContain('allow_previous_results')
  })
})

/**
 * How often a running job is asked whether it has finished.
 *
 * The flat 700 ms this replaced was undocumented and every panel paid it. The
 * claim worth pinning is the SHAPE: quick enough that a 0.3 s stored read and a
 * 0.95 s reused result are not rounded up to the next interval, backing off far
 * enough that a half-minute scan is not polled forty-three times.
 */
describe('the poll ramp', () => {
  it('starts fast, backs off, and settles at a ceiling', () => {
    expect([0, 1, 2, 3, 4, 5].map(pollDelayMs)).toEqual([100, 150, 250, 400, 600, 900])
    expect(pollDelayMs(6)).toBe(POLL_MAX_MS)
    expect(pollDelayMs(400)).toBe(POLL_MAX_MS)
    // The first answer is available 100 ms after the first check, not 700.
    expect(pollDelayMs(0)).toBeLessThan(700)
    // And the ramp is monotonic — a job does not get asked more often the
    // longer it runs.
    const steps = [0, 1, 2, 3, 4, 5, 6, 7].map(pollDelayMs)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
  })

  it('is what a real wait actually uses, in order', async () => {
    // Through waitForJob rather than against the table, because the bug this
    // catches is a loop that computes the ramp and then sleeps a constant.
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return realSetTimeout(fn, 0)
    }) as typeof globalThis.setTimeout)
    let checks = 0
    const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) })
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url)
      if (u.endsWith('/search/jobs')) return json({ items: [{ id: 'job-test' }] })
      if (u.includes('/status')) return json({ items: [{ status: ++checks > 3 ? 'completed' : 'running' }] })
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{"totalEventCount":0,"job":"job-test"}', json: async () => ({}) }
    })
    await runSearch(q('| limit 1'), { earliest: '-15m' })
    expect(delays).toEqual([100, 150, 250])
  })

  it('still honours a caller that fixes the interval', async () => {
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return realSetTimeout(fn, 0)
    }) as typeof globalThis.setTimeout)
    let checks = 0
    const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) })
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url)
      if (u.endsWith('/search/jobs')) return json({ items: [{ id: 'job-test' }] })
      if (u.includes('/status')) return json({ items: [{ status: ++checks > 2 ? 'completed' : 'running' }] })
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{"totalEventCount":0,"job":"job-test"}', json: async () => ({}) }
    })
    await runSearch(q('| limit 1'), { earliest: '-15m', pollMs: 42 })
    expect(delays).toEqual([42, 42])
  })
})

// ── What this file could not assert ─────────────────────────────────────────
//  * That the reuse directive actually reuses anything. A-SP21 measured that
//    against the live workspace; `fetch` is stubbed here, so all this proves is
//    which bytes leave the browser.
//  * That the ramp is faster in wall-clock terms. The delays are recorded and
//    then fired immediately, because a test that really waited 2.4 s per case
//    would be paid for on every run by everybody.
