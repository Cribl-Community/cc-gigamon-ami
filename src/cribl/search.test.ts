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
import { capSecondsFor, q, runSearch } from './search'
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
