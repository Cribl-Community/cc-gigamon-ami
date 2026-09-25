// `ensureLakeDataset(spec)`: create a Lake dataset that is missing, and never
// edit one that is there.
//
// Generalised from Guided Setup's private `ensureDataset`, which was hard-coded
// to `gigamon_ami`, so the onboarding run can create the pack's Parquet copy and
// the sample dataset the same way. The rules it has to keep are the old one's
// plus one the old one did not have:
//   * present → no write at all, whatever the spec says. Retention on a live
//     dataset is the Lake landing panel's to change, behind a dialog that can
//     say what a decrease deletes; format and partitions are fixed at creation
//     and a PATCH of them answers 200 and does nothing.
//   * present but different in format or partitions → still no write, and the
//     answer says what differs, so the caller can report it.
//   * a listing it could not read → no write. The old function read a refused
//     listing as an empty one and POSTed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATASET_SPEC, PARQUET_DATASET_SPEC, deployAll, ensureLakeDataset } from './provision'

interface Call { method: string; path: string; body?: unknown }

const DATASETS = '/products/lake/lakes/default/datasets'
let calls: Call[] = []
let listed: unknown[] = []
let listStatus = 200
let postStatus = 200

beforeEach(() => {
  calls = []
  listed = []
  listStatus = 200
  postStatus = 200
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '')
    const body = init.body == null ? undefined : (JSON.parse(String(init.body)) as unknown)
    calls.push({ method, path, body })
    const reply = (status: number, value: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'x',
      text: async () => JSON.stringify(value),
      json: async () => value,
    })
    if (method === 'GET' && path === DATASETS) return reply(listStatus, listStatus === 200 ? { items: listed } : { message: 'no' })
    if (method === 'POST' && path === DATASETS) return reply(postStatus, postStatus < 300 ? { items: [body] } : { message: 'refused' })
    return reply(404, {})
  })
})
afterEach(() => vi.unstubAllGlobals())

const writes = () => calls.filter((c) => c.method !== 'GET')

describe('ensureLakeDataset', () => {
  it('creates a missing dataset with exactly the spec it was given', async () => {
    listed = [{ id: 'gigamon_ami', format: 'json' }]
    const r = await ensureLakeDataset(PARQUET_DATASET_SPEC)
    expect(r).toEqual({ id: 'gigamon_ami_pq', action: 'created' })
    expect(writes()).toEqual([{ method: 'POST', path: DATASETS, body: JSON.parse(JSON.stringify(PARQUET_DATASET_SPEC)) }])
  })

  it('never writes to a dataset that exists — not even when its retention differs from the spec', async () => {
    listed = [{ id: 'gigamon_ami', format: 'json', retentionPeriodInDays: 365 }]
    const r = await ensureLakeDataset(DATASET_SPEC as { id: string })
    expect(r).toEqual({ id: 'gigamon_ami', action: 'exists' })
    expect(writes()).toEqual([])
  })

  it('reports, and leaves alone, a dataset with the right id and the wrong shape', async () => {
    listed = [{ id: 'gigamon_ami_pq', format: 'json', acceleratedFields: ['protocol'] }]
    const r = await ensureLakeDataset(PARQUET_DATASET_SPEC)
    expect(r.action).toBe('exists')
    expect(r.differs).toEqual(['format json, not parquet', 'partitions protocol, not none'])
    expect(writes()).toEqual([])
  })

  it('writes nothing when the listing cannot be read — "could not tell" is never "absent"', async () => {
    listStatus = 403
    const r = await ensureLakeDataset(PARQUET_DATASET_SPEC)
    expect(r.action).toBe('error')
    expect(r.detail).toMatch(/could not be read/)
    expect(writes()).toEqual([])
  })

  it('asks before creating, and a no is a skip with nothing sent', async () => {
    const r = await ensureLakeDataset(PARQUET_DATASET_SPEC, { confirm: async () => false })
    expect(r.action).toBe('skipped')
    expect(writes()).toEqual([])
  })

  it('reports a refused create as an error', async () => {
    postStatus = 409
    const r = await ensureLakeDataset(PARQUET_DATASET_SPEC)
    expect(r.action).toBe('error')
  })
})

describe('Guided Setup’s dataset step goes through it', () => {
  it('a refused listing stops the stack at the dataset, with no dataset POST', async () => {
    listStatus = 403
    const steps = await deployAll(() => {}, 'default')
    expect(steps[0]).toMatchObject({ key: 'dataset', action: 'error' })
    expect(writes().filter((c) => c.path === DATASETS)).toEqual([])
  })

  it('an existing gigamon_ami whose shape differs says so in the step, and is still left alone', async () => {
    listed = [{ id: 'gigamon_ami', format: 'parquet', acceleratedFields: ['protocol'] }]
    const steps = await deployAll(() => {}, 'default')
    expect(steps[0]).toMatchObject({ key: 'dataset', action: 'exists' })
    expect(steps[0].detail).toContain('format parquet, not json')
    expect(steps[0].detail).toContain('partitions protocol, not none')
    expect(steps[0].detail).toMatch(/fixed at creation/)
    expect(writes().filter((c) => c.path === DATASETS)).toEqual([])
  })

  it('an existing gigamon_ami of the right shape is a plain "exists"', async () => {
    listed = [{ id: 'gigamon_ami', format: 'json' }]
    const steps = await deployAll(() => {}, 'default')
    expect(steps[0]).toEqual({ key: 'dataset', action: 'exists' })
  })
})

// What this file could not assert: that Cribl Lake answers a POST for an id
// whose deletion has started with an error rather than a success; the listing
// here is the default one (deleted datasets excluded), as Guided Setup has
// always read it, so such an id reads as absent and the POST's answer decides.
