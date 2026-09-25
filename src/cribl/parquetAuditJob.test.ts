// scripts/parquet-audit-job.mjs against a fake transport: the runner never
// leaves a job it submitted running, and retries reads but never a submit.
// Nothing here reaches the network: every call goes to the stub below.
import { describe, expect, it } from 'vitest'
import { isRetryable, makeApi, runAuditJob, type Api } from '../../scripts/parquet-audit-job.mjs'

const WINDOW = { earliest: 1000, latest: 2000, label: 'w' }

type Reply = string | Error
/** An `api` that answers each `METHOD path` from a queue, and records every call. */
function fakeApi(routes: Record<string, Reply[]>) {
  const calls: string[] = []
  const api: Api = async (method, path) => {
    const key = `${method} ${path}`
    calls.push(key)
    const q = routes[key]
    if (!q || q.length === 0) throw new Error(`unexpected ${key}`)
    const r = q.length > 1 ? q.shift()! : q[0]
    if (r instanceof Error) throw r
    return r
  }
  return { api, calls }
}

function deps(api: Api) {
  let t = 0
  return { api, sleep: async () => {}, now: () => (t += 10), log: () => {}, cap: 300 }
}

const J = '/search/jobs/job1'
const created = JSON.stringify({ items: [{ id: 'job1' }] })
const status = (s: string) => JSON.stringify({ items: [{ status: s }] })
const billed = JSON.stringify({ items: [{ metrics: { cpuMetrics: { billableCPUSeconds: 12.5 } } }] })

describe('runAuditJob', () => {
  it('cancels its job and records why when a status poll fails', async () => {
    const { api, calls } = fakeApi({
      'POST /search/jobs': [created],
      [`GET ${J}/status`]: [status('running'), new Error('GET status → 502 bad gateway')],
      [`POST ${J}/cancel`]: ['{}'],
      [`GET ${J}`]: [billed],
    })
    const { job, row } = await runAuditJob(deps(api), 'p', WINDOW, 'q')
    expect(row).toBeNull()
    expect(calls).toContain(`POST ${J}/cancel`)
    expect(job.cancel).toBe('sent')
    expect(job.error).toContain('502')
    expect(job.status).toBe('running; canceled by the runner after the error')
    expect(job.billableCPUSeconds).toBe(12.5)
    expect(job.submittedAt).toMatch(/^1970-01-01T/)
  })

  it('records a cancel that itself failed, rather than hiding it', async () => {
    const { api } = fakeApi({
      'POST /search/jobs': [created],
      [`GET ${J}/status`]: [new Error('network down')],
      [`POST ${J}/cancel`]: [new Error('POST cancel → 503')],
      [`GET ${J}`]: [new Error('still down')],
    })
    const { job } = await runAuditJob(deps(api), 'p', WINDOW, 'q')
    expect(job.error).toBe('network down')
    expect(job.cancel).toBe('failed: POST cancel → 503')
    expect(job.billableCPUSeconds).toBeNull()
  })

  it('records a failed results read on a completed job, with nothing left running to cancel', async () => {
    const { api, calls } = fakeApi({
      'POST /search/jobs': [created],
      [`GET ${J}/status`]: [status('completed')],
      [`GET ${J}/results?limit=10`]: [new Error('GET results → 500')],
      [`GET ${J}`]: [billed],
    })
    const { job, row } = await runAuditJob(deps(api), 'p', WINDOW, 'q')
    expect(row).toBeNull()
    expect(job.status).toBe('completed')
    expect(job.error).toContain('500')
    expect(job.cancel).toBeNull()
    expect(calls).not.toContain(`POST ${J}/cancel`)
  })

  it('answers the one summary row, prefixes the cap, and cancels nothing on success', async () => {
    const posted: unknown[] = []
    const { api: base, calls } = fakeApi({
      'POST /search/jobs': [created],
      [`GET ${J}/status`]: [status('running'), status('completed')],
      [`GET ${J}/results?limit=10`]: ['{"totalEventCount":1,"job":{}}\n{"rows":7}\n'],
      [`GET ${J}`]: [billed],
    })
    const api: Api = (m, p, b) => {
      if (b !== undefined) posted.push(b)
      return base(m, p, b)
    }
    const { job, row } = await runAuditJob(deps(api), 'p', WINDOW, 'q')
    expect(row).toEqual({ rows: 7 })
    expect(job).toMatchObject({ status: 'completed', error: null, cancel: null, jobId: 'job1' })
    expect(posted[0]).toEqual({ query: 'set max_running_time_per_search=300; q', earliest: 1000, latest: 2000 })
    expect(calls.filter((c) => c.endsWith('/cancel'))).toEqual([])
  })

  it('sends no cancel when the submit itself failed: there is no job to cancel', async () => {
    const { api, calls } = fakeApi({ 'POST /search/jobs': [new Error('POST → 429')] })
    const { job } = await runAuditJob(deps(api), 'p', WINDOW, 'q')
    expect(job.jobId).toBeNull()
    expect(job.cancel).toBeNull()
    expect(calls).toEqual(['POST /search/jobs'])
  })
})

describe('makeApi', () => {
  function fakeFetch(statuses: number[]) {
    const seen: string[] = []
    const fetch = async (url: string, init: { method: string }) => {
      seen.push(`${init.method} ${url}`)
      const s = statuses.shift() ?? 200
      return { ok: s >= 200 && s < 300, status: s, text: async () => `body ${s}` }
    }
    return { fetch, seen }
  }

  it('retries a read on 429 and 5xx', async () => {
    const { fetch, seen } = fakeFetch([502, 429, 200])
    const api = makeApi({ base: 'http://x/capi', fetch, sleep: async () => {} })
    expect(await api('GET', '/search/jobs/a/status')).toBe('body 200')
    expect(seen).toEqual(Array(3).fill('GET http://x/capi/m/default_search/search/jobs/a/status'))
  })

  it('never retries a submit: a lost answer would bill a second job', async () => {
    const { fetch, seen } = fakeFetch([502, 200])
    const api = makeApi({ base: 'http://x/capi', fetch, sleep: async () => {} })
    await expect(api('POST', '/search/jobs', {})).rejects.toThrow('502')
    expect(seen).toHaveLength(1)
  })

  it('does not retry a 4xx other than 429', async () => {
    const { fetch, seen } = fakeFetch([404, 200])
    const api = makeApi({ base: 'http://x/capi', fetch, sleep: async () => {} })
    await expect(api('GET', '/search/jobs/a')).rejects.toThrow('404')
    expect(seen).toHaveLength(1)
    expect([429, 500, 503].every(isRetryable)).toBe(true)
    expect([400, 401, 403, 404].some(isRetryable)).toBe(false)
  })
})
