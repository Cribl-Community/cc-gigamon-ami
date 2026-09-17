// What the watch has to get right, pinned against the shape the live API
// actually returns.
//
// The fixtures below are trimmed copies of real `output=short` rows from this
// workspace — same field names, same identity strings, same `datasetIds` — so
// what is tested is the parse the app will really do, not a convenient
// invention. Three of the assertions exist because the failure they catch is
// silent:
//
//   * an empty list means nothing on its own. A refusal, a rejected filter and a
//     quiet workspace all return zero rows, and only `error` separates them.
//   * a text match on the query string is wrong: 55 of 1,000 jobs in the live
//     history mention `gigamon_ami` while reading something else, one of them a
//     `$vt_jobs` watchdog probe matching itself. `datasetIds` is the field that
//     answers the question.
//   * `capi()` builds the path from a literal here because policyCoverage
//     resolves call sites from the source text. Nothing but a test keeps that
//     literal in step with SEARCH_GROUP.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { denialMark, denialSince, resetDenials } from './authz'
import { SEARCH_GROUP } from './config'
import { DEFAULT_CAP_TIERS, capTiersInForce, setCapTiers } from './search'
import {
  HUNG_FLOOR_SECONDS,
  HUNG_MARGIN,
  JOBS_PATH,
  POLL_MS,
  cancelHungJob,
  checkNow,
  dismissJob,
  hungAfterSeconds,
  resetJobWatchdog,
  restoreDismissed,
  setHungAfterSeconds,
  subscribeToWatchdog,
  watchdogState as snapshot,
} from './jobWatchdog'

const NOW = 1_789_600_000_000

/**
 * The signed-in user, for every case about whose job a row is.
 *
 * ONE VALUE FOR THE WHOLE FILE, and not by preference: cribl/user.ts memoises
 * the platform lookup for the life of the module, so the first test to resolve
 * it decides for the rest. Fixtures pick a side with their `user` field instead
 * — `ME` is one of ours, anything else is a colleague's, and a row Cribl
 * recorded no owner for is the case where the app cannot say.
 */
const ME = 'auth0|me'

/** A running job, in the shape `GET /search/jobs?output=short` returns. */
function running(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '1789395843210.fxAzHG',
    type: 'standard',
    query: 'dataset="gigamon_ami" | summarize c=dcount(src_ip) by app_name',
    earliest: '-24h',
    latest: 'now',
    timeCreated: NOW - 19 * 3600_000,
    timeStarted: NOW - 19 * 3600_000,
    status: 'running',
    user: 'auth0|user06',
    displayUsername: 'User 06',
    isPrivate: true,
    datasetIds: ['gigamon_ami'],
    userDetails: { type: 'user' },
    ...over,
  }
}

interface Sent { url: string; method: string }

/** Stub the transport with a queue of canned responses; returns what was sent. */
function stub(...responses: Array<{ status: number; body: unknown }>): Sent[] {
  const sent: Sent[] = []
  let i = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), method: String(init.method ?? 'GET') })
    const r = responses[Math.min(i++, responses.length - 1)]
    return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }
  })
  return sent
}

/** One poll's worth of list response. */
const list = (items: unknown[], totalCount = items.length) => ({
  status: 200,
  body: { items, count: items.length, offset: 0, limit: 200, totalCount },
})

beforeEach(() => {
  vi.stubGlobal('getCriblUser', async () => ({ id: ME, username: 'me' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetJobWatchdog()
  resetDenials()
  setCapTiers(DEFAULT_CAP_TIERS)
})

describe('the path it calls', () => {
  it('names the search group Cribl Search actually runs in', () => {
    // JOBS_PATH is a literal because policyCoverage.test.ts reads call-site
    // paths out of the source and cannot resolve an imported constant through a
    // template. This is the only thing stopping the two from drifting.
    expect(JOBS_PATH).toBe(`/m/${SEARCH_GROUP}/search/jobs`)
  })

  it('asks Cribl for the running jobs only, and pages the way the API demands', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const sent = stub(list([]))
    await checkNow()
    const url = sent[0].url
    expect(sent[0].method).toBe('GET')
    // `limit` without `offset` is a live 400 — "missing 'offset' parameter" —
    // although the spec marks offset optional.
    expect(url).toContain('offset=0')
    expect(url).toContain('limit=200')
    expect(url).toContain('output=short')
    // One field, whose values are a documented enum. Everything else is matched
    // client-side, because a filterExp naming a field that does not exist
    // returns an empty list with a 200 — a silent zero.
    expect(decodeURIComponent(url)).toContain("filterExp=status=='running'")
  })
})

describe('the threshold', () => {
  it('leaves real room above the longest query this app permits itself', () => {
    // THE DEFECT THIS PINS: the threshold used to be max(900, widest cap), and
    // 900 s IS the widest tier of DEFAULT_CAP_TIERS — so the app's own pinned
    // 30-day query tripped the loudest surface in the product at the exact
    // second it became slow, while search.ts was still waiting out `cap + 30 s`
    // before cancelling it. A threshold level with the limit reports the app's
    // own well-governed work as a hang.
    const widest = Math.max(...DEFAULT_CAP_TIERS.map((t) => t.capSeconds))
    expect(widest).toBe(900)
    expect(hungAfterSeconds()).toBeGreaterThan(widest)
    expect(HUNG_FLOOR_SECONDS).toBe(widest * HUNG_MARGIN)
    expect(hungAfterSeconds()).toBe(1800)
  })

  it('keeps that margin relative, because an installer can raise the caps', () => {
    // A-D30: SearchLimitsPanel lets a tenant whose panels legitimately need
    // longer go up to MAX_CAP_SECONDS. A margin written as a second literal
    // would be generous against 900 s and a rounding error against 3600.
    setCapTiers([{ upToSeconds: Infinity, capSeconds: 1800 }])
    expect(capTiersInForce()[0].capSeconds).toBe(1800)
    expect(hungAfterSeconds()).toBe(3600)
    setCapTiers([{ upToSeconds: Infinity, capSeconds: 3600 }])
    expect(hungAfterSeconds()).toBe(7200)
  })

  it('does not follow them down, because other people are not governed by our caps', () => {
    // An installer who tightens every cap to two minutes has said something
    // about this app's panels, not about a colleague's ad-hoc investigation.
    // Reporting a four-minute search as hung is how a badge becomes wallpaper.
    setCapTiers([{ upToSeconds: Infinity, capSeconds: 120 }])
    expect(hungAfterSeconds()).toBe(HUNG_FLOOR_SECONDS)
  })

  it('can be lowered for a Preview check that cannot wait half an hour', () => {
    setHungAfterSeconds(30)
    expect(hungAfterSeconds()).toBe(30)
    setHungAfterSeconds(null)
    expect(hungAfterSeconds()).toBe(1800)
  })
})

describe('which jobs it reports', () => {
  it('lists a job running past the threshold, oldest first, with its owner and age', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ id: 'young', timeStarted: NOW - 40 * 60_000 }), running()]))
    await checkNow()
    const { jobs } = snapshot()
    expect(jobs.map((j) => j.id)).toEqual(['1789395843210.fxAzHG', 'young'])
    expect(jobs[0].owner).toBe('User 06')
    expect(jobs[0].ownerId).toBe('auth0|user06')
    expect(jobs[0].elapsedMs).toBe(19 * 3600_000)
  })

  it('ignores a job that has not been running long enough', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // 51 s is the slowest gigamon_ami job that ever COMPLETED in this
    // workspace's 1,000-job history; p99 was 15.4 s. Ordinary work must never
    // reach the badge.
    stub(list([running({ timeStarted: NOW - 51_000 })]))
    await checkNow()
    expect(snapshot().jobs).toEqual([])
    expect(snapshot().error, 'and an empty list after a good poll is not an error').toBeNull()
  })

  it('matches the dataset Cribl resolved, not the text of the query', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // The exact false positive §1.8's `query contains "gigamon_ami"` filter
    // produces — and the exact shape of a watchdog query matching itself.
    stub(
      list([
        running({
          id: 'selfmatch',
          query: 'dataset="$vt_jobs" | where status=="running" and query contains "gigamon_ami"',
          datasetIds: ['$vt_jobs'],
        }),
      ]),
    )
    await checkNow()
    expect(snapshot().jobs).toEqual([])
    // Counted rather than listed: the watch is scoped to this app's dataset and
    // says so instead of implying it watches everything.
    expect(snapshot().otherDatasetsOverThreshold).toBe(1)
  })

  it('says whether a job carried this app’s running-time cap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(
      list([
        running({ id: 'ours', query: 'set max_running_time_per_search=600; dataset="gigamon_ami" | limit 1' }),
        running({ id: 'theirs' }),
      ]),
    )
    await checkNow()
    const by = Object.fromEntries(snapshot().jobs.map((j) => [j.id, j.carriesRunningTimeCap]))
    // Ours means the cap did not hold. Theirs means it was never capped — a
    // deep link, the Search UI, or Copilot. Different problems, same badge.
    expect(by).toEqual({ ours: true, theirs: false })
  })

  it('falls back to the creation time when Cribl recorded no start, and says so', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ timeStarted: undefined })]))
    await checkNow()
    expect(snapshot().jobs[0].startedAtIsCreation).toBe(true)
  })

  it('reports only running jobs, even if the server-side filter went missing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // The selection rests on one query parameter surviving the platform's fetch
    // proxy, which this app has only exercised through the dev server. If it
    // were dropped the list would arrive full of finished jobs, every one of
    // them started hours ago — so the status is checked on the row as well.
    stub(list([running({ status: 'completed' }), running({ id: 'live' })]))
    await checkNow()
    expect(snapshot().jobs.map((j) => j.id)).toEqual(['live'])
  })

  it('keeps the rest of a poll when one row is unreadable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([{ nonsense: true }, running()]))
    await checkNow()
    expect(snapshot().jobs).toHaveLength(1)
    expect(snapshot().error).toBeNull()
  })
})

describe('an empty list is not the same as nothing wrong', () => {
  it('reports a refusal instead of an all-clear', async () => {
    stub({ status: 403, body: { message: 'Not authorized or licensed to perform this action.' } })
    await checkNow()
    const s = snapshot()
    expect(s.jobs).toEqual([])
    expect(s.denied).toBe(true)
    // The sentence matters less than the fact that `error` is non-null: a
    // caller rendering jobs.length alone would print "no long-running
    // searches" to somebody who is not allowed to know.
    expect(s.error).toContain('cannot list')
    expect(s.lastCheckedAt, 'a refused poll checked nothing').toBeNull()
  })

  it('keeps a background refusal out of the ledger every gated control reads', async () => {
    // THE DEFECT THIS PINS: capi() records 401/403 into cribl/authz.ts's ledger,
    // and <GatedControl> treats anything recorded while its write ran as its own
    // refusal. This poll fires every five minutes with nobody watching, so
    // without the `background` flag a refused watch marks whatever button
    // happened to be running as denied — measured on a provisioning POST that
    // succeeded and still came back refused.
    stub({ status: 403, body: { message: 'Not authorized or licensed to perform this action.' } })
    const mark = denialMark()
    await checkNow()
    expect(snapshot().denied, 'the watch stopped noticing the refusal at all').toBe(true)
    expect(denialSince(mark), 'the poll’s 403 was attributed to somebody’s click').toBeNull()
  })

  it('reports a rejected filter expression rather than swallowing the 500', async () => {
    stub({ status: 500, body: { status: 'error', message: "Unexpected identifier 'is'" } })
    await checkNow()
    expect(snapshot().error).toContain('Unexpected identifier')
    expect(snapshot().denied).toBe(false)
  })

  it('survives a body that is not a job list', async () => {
    stub({ status: 200, body: '<html>Bad Gateway</html>' })
    await checkNow()
    expect(snapshot().error).toContain('could not read')
  })

  it('never throws at its caller, whatever the network does', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    await expect(checkNow()).resolves.toBeUndefined()
    expect(snapshot().error).toBe('network down')
  })
})

describe('announcements', () => {
  it('moves the id-set counter only when the set of jobs changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running()]))
    await checkNow()
    const first = snapshot().idSetSeq
    expect(first).toBeGreaterThan(0)
    await checkNow()
    // Same job, still running. A role="status" keyed on this must not repeat a
    // colleague's nineteen-hour job at somebody twelve times an hour.
    expect(snapshot().idSetSeq).toBe(first)
    vi.unstubAllGlobals()
    stub(list([running(), running({ id: 'another' })]))
    await checkNow()
    expect(snapshot().idSetSeq).toBe(first + 1)
  })
})

describe('dismissal', () => {
  it('is per job id, in memory, and reversible', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running()]))
    await checkNow()
    dismissJob('1789395843210.fxAzHG')
    expect(snapshot().dismissedIds).toEqual(['1789395843210.fxAzHG'])
    // The job is still listed — dismissal silences the escalation, never the
    // badge. §1.8: the badge never disappears while any job is hung.
    expect(snapshot().jobs).toHaveLength(1)
    restoreDismissed()
    expect(snapshot().dismissedIds).toEqual([])
  })

  it('forgets a dismissal once the job is gone, so a recycled id is not pre-dismissed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running()]))
    await checkNow()
    dismissJob('1789395843210.fxAzHG')
    vi.unstubAllGlobals()
    stub(list([]))
    await checkNow()
    expect(snapshot().dismissedIds).toEqual([])
  })
})

describe('cancel', () => {
  it('sends the cancel for one of your own jobs, and reports what Cribl said', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const sent = stub(
      list([running({ user: ME })]),
      { status: 200, body: { items: [{ id: '1789395843210.fxAzHG', status: 'canceled' }], count: 1 } },
      list([]),
    )
    await checkNow()
    const result = await cancelHungJob(snapshot().jobs[0])
    expect(result.ok).toBe(true)
    expect(result.reportedStatus).toBe('canceled')
    expect(sent[1].method).toBe('POST')
    expect(sent[1].url).toContain('/search/jobs/1789395843210.fxAzHG/cancel')
  })

  it('drops the row at once rather than leaving it on screen for five minutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ user: ME })]), { status: 200, body: { items: [{ status: 'canceled' }] } }, list([]))
    await checkNow()
    await cancelHungJob(snapshot().jobs[0])
    expect(snapshot().jobs).toEqual([])
  })

  it('will not cancel a search somebody else started, and sends nothing', async () => {
    // THE SCOPE DECISION, at the layer that cannot be got round: the drawer does
    // not render a Cancel on a row that is not yours, and if it ever did, the
    // store still refuses. Cancelling a colleague's search destroys work in
    // progress whose value cannot be seen from here.
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ user: 'auth0|user06' })]))
    await checkNow()
    const job = snapshot().jobs[0]
    expect(job.mine).toBe(false)
    const after = stub(list([running({ user: 'auth0|user06' })]))
    const result = await cancelHungJob(job)
    expect(result.declined).toBe('not-yours')
    expect(after, 'a cancel left the app for a job it does not own').toEqual([])
    expect(snapshot().jobs, 'the row went as though it had been cancelled').toHaveLength(1)
  })

  it('will not cancel a job it cannot show is yours', async () => {
    // Cribl recorded no owner on the row — the same shape as `npm run dev` and
    // as a platform build that names nobody, where there is no signed-in id to
    // compare against either. `mine` is null rather than false: "not yours" is a
    // claim the app has nothing to base on, and neither is "yours". Only `true`
    // earns the button.
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ user: undefined })]))
    await checkNow()
    const job = snapshot().jobs[0]
    expect(job.mine).toBeNull()
    expect((await cancelHungJob(job)).declined).toBe('not-yours')
  })

  it('declines a job the watch is no longer listing, as a fact rather than a failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ user: ME })]))
    await checkNow()
    const job = snapshot().jobs[0]
    const after = stub(list([]))
    await checkNow()
    const result = await cancelHungJob(job)
    // Not a general-purpose "cancel any job in the workspace" primitive, and a
    // job that finished between the render and the click is correctly declined.
    // `declined` rather than a sentence: the words are the copy module's, and
    // this one is not an error — the search the person wanted stopped is
    // stopped.
    expect(result.ok).toBe(false)
    expect(result.declined).toBe('gone')
    expect(after.map((s) => s.method), 'only the poll was sent').toEqual(['GET'])
  })

  it('declines while the list is stale, instead of acting on a poll that failed', async () => {
    // THE DEFECT THIS PINS, from the other end of the same lie as the header's:
    // after a refused poll `jobs` is whatever the last good one found, so
    // "still listed" is not something this app knows. Sending a cancel on that
    // basis is acting on a list it has just admitted it cannot see.
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ user: ME })]))
    await checkNow()
    const job = snapshot().jobs[0]
    const after = stub({ status: 403, body: { message: 'no' } })
    await checkNow()
    expect(snapshot().jobs, 'the rows are kept, dated, and no longer current').toHaveLength(1)
    const result = await cancelHungJob(job)
    expect(result.declined).toBe('unverified')
    expect(after.filter((s) => s.method === 'POST')).toEqual([])
  })

  it('reports a refused cancel with the status and Cribl’s own sentence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    stub(list([running({ user: ME })]), { status: 403, body: { message: 'Not authorized or licensed to perform this action.' } })
    await checkNow()
    const result = await cancelHungJob(snapshot().jobs[0])
    expect(result.ok).toBe(false)
    expect(result.declined, 'this one really was sent and really was refused').toBeNull()
    expect(result.httpStatus).toBe(403)
    expect(result.detail).toContain('Not authorized')
    // It is still running, and the row must still say so.
    expect(snapshot().jobs).toHaveLength(1)
  })
})

describe('the poll loop', () => {
  it('is five minutes', () => {
    // Stated as a test because the number is a judgement about how long a
    // problem may sit unnoticed, not about cost: one poll is a 61-byte GET that
    // submits no search and adds no job to the search history.
    expect(POLL_MS).toBe(5 * 60 * 1000)
  })

  it('checks once when the first consumer arrives, and nothing before that', async () => {
    const sent = stub(list([]))
    expect(sent, 'an app nobody is looking at asks Cribl nothing').toHaveLength(0)
    const off = subscribeToWatchdog(() => {})
    await flush()
    expect(sent).toHaveLength(1)
    off()
  })

  it('does not poll again just because somebody alt-tabbed back', async () => {
    // tick() runs on the timer, on every return to the tab, and on the first
    // subscriber. Without the minimum gap, switching between this app and Cribl
    // Search while investigating would be a poll per switch.
    const sent = stub(list([]))
    const off = subscribeToWatchdog(() => {})
    await flush()
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(sent).toHaveLength(1)
    off()
  })

  it('keeps that gap when the polls are failing, which is when it matters most', async () => {
    // THE DEFECT THIS PINS: the gap used to be measured from `lastCheckedAt`,
    // which is written only by a poll that came back with a list. A 401, a 403,
    // an unreadable body or a dropped connection left it null forever, so the
    // guard never engaged and every return to the tab fired another request —
    // at the workspace that had just refused the last one.
    const sent = stub({ status: 403, body: { message: 'Not authorized.' } })
    const off = subscribeToWatchdog(() => {})
    // try/finally rather than a trailing off(): a failure here would otherwise
    // leave the loop subscribed and poll into the next test's request log.
    try {
      await flush()
      expect(sent).toHaveLength(1)
      expect(snapshot().lastCheckedAt, 'a refused poll still checked nothing').toBeNull()
      for (let i = 0; i < 3; i++) {
        document.dispatchEvent(new Event('visibilitychange'))
        await flush()
      }
      expect(sent, 'a refusing workspace got a burst of polls per alt-tab').toHaveLength(1)
    } finally {
      off()
    }
  })

  it('does not talk to Cribl while the document is hidden', async () => {
    const sent = stub(list([]))
    const off = subscribeToWatchdog(() => {})
    await flush()
    hide(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(snapshot().paused, 'and the badge can say its count is stale').toBe(true)
    expect(sent).toHaveLength(1)
    hide(false)
    off()
  })
})

/** Let the poll's promises settle. Real timers only — the loop's own 5-minute
 *  timeout is cleared by unsubscribing, not by advancing the clock. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** happy-dom exposes `visibilityState` as a plain property. */
function hide(value: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (value ? 'hidden' : 'visible'),
  })
}

