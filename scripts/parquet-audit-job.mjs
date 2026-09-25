// One Phase 8.0b/8.0c audit job: submit, poll, read its one summary row, read
// what it billed. Split out of scripts/parquet-audit.mjs so the failure paths
// can be tested with a fake transport: this module never calls fetch itself.
// `makeApi` is handed fetch by the runner; the tests hand it a stub.
//
// Two rules the tests hold:
//  - A job this runner submitted is never left running. If the poll or the
//    results read fails after a job id exists, the job is cancelled (POST
//    .../cancel) and the failure and the cancel are both recorded on the job.
//  - Only reads are retried (429 and 5xx, a few times with backoff, like
//    src/cribl/search.ts). A job POST is never retried: a retry after a lost
//    answer would submit, and bill, a second job.

export const SEARCH_GROUP = 'default_search'
export const RETRY_DELAYS_MS = [1000, 3000, 6000]
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

/** An HTTP status worth asking again for: rate-limited or a server/proxy error. */
export function isRetryable(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

export class HttpError extends Error {
  constructor(method, path, status, text) {
    super(`${method} ${path} → ${status} ${String(text).slice(0, 200)}`)
    this.status = status
  }
}

/**
 * `api(method, path, body?)` against `${base}/m/default_search${path}`. GETs are
 * retried on 429/5xx and on a network error; nothing else is.
 */
export function makeApi({ base, fetch, sleep }) {
  return async function api(method, path, body) {
    const retries = method === 'GET' ? RETRY_DELAYS_MS : []
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetch(`${base}/m/${SEARCH_GROUP}${path}`, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (err) {
        if (attempt < retries.length) {
          await sleep(retries[attempt])
          continue
        }
        throw err
      }
      const text = await res.text()
      if (res.ok) return text
      if (isRetryable(res.status) && attempt < retries.length) {
        await sleep(retries[attempt])
        continue
      }
      throw new HttpError(method, path, res.status, text)
    }
  }
}

/**
 * Run one job to the end. Answers `{ job, row }`; `row` is the one summary row,
 * or null when none was read. Never throws: every failure lands in `job.error`.
 *
 * deps: { api, sleep, now: () => epoch ms, log: (line) => void, cap: seconds }
 */
export async function runAuditJob(deps, purpose, window, query) {
  const { job, value } = await runSearchJob(deps, purpose, window, query, {
    limit: 10,
    accept: (rows) => {
      if (rows.length !== 1) throw new Error(`expected one summary row, got ${rows.length}`)
      return rows[0]
    },
  })
  return { job, row: value }
}

/**
 * The job loop both runners share (this one and scripts/parity-run-job.mjs):
 * submit once, poll, read up to `limit` result rows, and hand them — with the
 * NDJSON header `{ totalEventCount, job, … }` when there is one — to `accept`,
 * whose answer is `value` and whose throw is the job's error. Then read what it
 * billed. Never throws; a job that may still be running after a failure is
 * cancelled, never abandoned.
 */
export async function runSearchJob(deps, purpose, window, query, { limit, accept }) {
  const { api, sleep, now, log, cap } = deps
  const executed = `set max_running_time_per_search=${cap}; ${query}`
  const job = {
    purpose,
    window,
    query: executed,
    jobId: null,
    submittedAt: null,
    status: 'not submitted',
    billableCPUSeconds: null,
    costRead: null,
    elapsedMs: null,
    error: null,
    cancel: null,
  }
  const t0 = now()
  const jobPath = () => `/search/jobs/${encodeURIComponent(job.jobId)}`
  let value = null
  try {
    job.submittedAt = new Date(t0).toISOString()
    const created = JSON.parse(await api('POST', '/search/jobs', { query: executed, earliest: window.earliest, latest: window.latest }))
    job.jobId = created.items?.[0]?.id ?? null
    if (!job.jobId) throw new Error('the job was not created (no id in the answer)')
    job.status = 'submitted'
    log(`  ${purpose}: job ${job.jobId} submitted`)
    const deadline = t0 + (cap + 60) * 1000
    let wait = 250
    for (;;) {
      const st = JSON.parse(await api('GET', `${jobPath()}/status`))
      job.status = st.items?.[0]?.status ?? 'unknown'
      if (TERMINAL.has(job.status)) break
      if (now() > deadline) {
        job.cancel = await sendCancel(api, jobPath())
        job.status = 'canceled by the runner (past cap + 60 s)'
        break
      }
      await sleep(wait)
      wait = Math.min(wait * 1.5, 2000)
    }
    job.elapsedMs = now() - t0
    if (job.status === 'completed') {
      const text = await api('GET', `${jobPath()}/results?limit=${limit}`)
      const all = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
      const isHeader = (o) => typeof o.totalEventCount === 'number' && 'job' in o
      value = accept(all.filter((o) => !isHeader(o)), all.find(isHeader) ?? null)
    }
  } catch (err) {
    job.error = String(err?.message ?? err)
    if (job.elapsedMs === null) job.elapsedMs = now() - t0
    // A job that may still be running on the server is cancelled, never abandoned.
    if (job.jobId && !TERMINAL.has(job.status) && job.cancel === null) {
      job.cancel = await sendCancel(api, jobPath())
      job.status = `${job.status}; canceled by the runner after the error`
    }
  }
  if (job.jobId) {
    const cost = await readBilledCpu(api, sleep, jobPath())
    job.billableCPUSeconds = cost.value
    job.costRead = cost.note
  }
  const billed = job.billableCPUSeconds ?? (job.jobId ? 'not yet available' : 'none (no job)')
  log(`  ${purpose}: ${job.status}${job.error ? ` — ${job.error}` : ''}${job.cancel ? ` (cancel ${job.cancel})` : ''}; billable CPU-s ${billed}${job.costRead ? ` (${job.costRead})` : ''}`)
  return { job, value }
}

/**
 * Waits between reads of a finished job's metrics: 2, 4, 8, then 15 s at a
 * time, 89 s in all. The first real run (2026-09-25) read three times over ~9 s
 * and printed "unknown" for every job, while the figures were readable about a
 * minute later.
 */
export const COST_READ_DELAYS_MS = [2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000]

/**
 * A finished job's billable CPU-s, from `GET /search/jobs/:id/metrics` — the
 * endpoint the app itself reads (src/cribl/jobCost.ts, accel/status.ts); the
 * first runner read the job record instead. `billableCPUSeconds` reads 0 on a
 * job not billed yet, so only a positive number is taken; a read that fails is
 * tried again like a 0. Answers `{ value: null, note: 'not yet available …' }`
 * when the figure never appears — never 0.
 */
export async function readBilledCpu(api, sleep, path, delays = COST_READ_DELAYS_MS) {
  let waited = 0
  for (let i = 0; ; i++) {
    try {
      const j = JSON.parse(await api('GET', `${path}/metrics`))
      const v = j.items?.[0]?.metrics?.cpuMetrics?.billableCPUSeconds
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return { value: v, note: `read after ${Math.round(waited / 1000)} s` }
    } catch { /* read again after the next wait */ }
    if (i >= delays.length) break
    await sleep(delays[i])
    waited += delays[i]
  }
  return { value: null, note: `not yet available after ${Math.round(waited / 1000)} s of reads` }
}

/** Cancel a job a runner submitted: 'sent', or 'failed: …'. Never throws. */
export async function sendCancel(api, path) {
  try {
    await api('POST', `${path}/cancel`)
    return 'sent'
  } catch (err) {
    return `failed: ${String(err?.message ?? err)}`
  }
}
