// scripts/check-pack-release.mjs: the CI step that downloads the pack release
// this build pins and compares its sha256 with pack.ts `PACK_SHA256`.
//
// THE PURE PARTS ONLY. Every request below goes to a fake `fetchImpl`; nothing
// here reaches the network, and every pause goes to a fake `sleep`. What the
// real GitHub asset hashes to is the CI step's to find out, not this file's.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  ATTEMPTS, checkPackRelease, compareDigest, download, releaseCheckPlan, retryableStatus, sha256Hex,
} from '../../scripts/check-pack-release.mjs'
import { PACK_PUBLISHED, PACK_SHA256, PACK_URL, PACK_VERSION, packReleaseUrl } from './pack'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BYTES = new TextEncoder().encode('a pack, as released')
const DIGEST = sha256Hex(BYTES)
const FACTS = { published: true, sha256: DIGEST, version: '9.9.9', url: packReleaseUrl('9.9.9') }

type Reply = { status: number; bytes?: Uint8Array } | Error
/** A fetch that answers from a script, and counts. */
function fakeFetch(replies: Reply[]) {
  const seen: Array<{ url: string; redirect?: string }> = []
  const impl = async (url: string, init?: { redirect?: 'follow' }) => {
    seen.push({ url, redirect: init?.redirect })
    const r = replies[Math.min(seen.length - 1, replies.length - 1)]
    if (r instanceof Error) throw r
    const bytes = r.bytes ?? new Uint8Array()
    return { status: r.status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
  }
  return { impl, seen }
}
const noSleep = async () => {}

describe('the pure parts', () => {
  it('hashes as sha256sum does', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('compares digests exactly, and names both on a mismatch', () => {
    expect(compareDigest(DIGEST, DIGEST).ok).toBe(true)
    const bad = compareDigest(DIGEST, 'f'.repeat(64))
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain(DIGEST)
    expect(bad.message).toContain('f'.repeat(64))
    expect(compareDigest(DIGEST, DIGEST.toUpperCase()).ok).toBe(false)
  })

  it('skips, with a sentence that says why, while the release is not recorded as published', () => {
    const plan = releaseCheckPlan({ published: false, sha256: null, version: '9.9.9', url: packReleaseUrl('9.9.9') })
    expect(plan).toMatchObject({ skip: true, message: expect.stringMatching(/^skipped: pack 9\.9\.9 .*PACK_PUBLISHED is false/) })
  })

  it('fails, without downloading, a published release whose digest is missing or malformed', () => {
    for (const sha256 of [null, 'x', 'AB'.repeat(32)]) {
      expect(releaseCheckPlan({ ...FACTS, sha256 }), String(sha256)).toMatchObject({ skip: false, error: expect.stringMatching(/PACK_SHA256/) })
    }
  })

  it('retries 429 and 5xx, and nothing else', () => {
    for (const s of [429, 500, 502, 503, 599]) expect(retryableStatus(s), String(s)).toBe(true)
    for (const s of [200, 301, 403, 404, 410]) expect(retryableStatus(s), String(s)).toBe(false)
  })
})

describe('the check, against a fake fetch', () => {
  it('in a build with no release: exits 0 and makes no request', async () => {
    const f = fakeFetch([{ status: 200, bytes: BYTES }])
    const out = await checkPackRelease({ ...FACTS, published: false, sha256: null }, { fetchImpl: f.impl, sleep: noSleep })
    expect(out.code).toBe(0)
    expect(out.lines.join('\n')).toMatch(/^skipped/)
    expect(f.seen).toEqual([])
  })

  it('passes the recorded bytes, fetched once, following redirects', async () => {
    const f = fakeFetch([{ status: 200, bytes: BYTES }])
    const out = await checkPackRelease(FACTS, { fetchImpl: f.impl, sleep: noSleep })
    expect(out.code).toBe(0)
    expect(f.seen).toEqual([{ url: FACTS.url, redirect: 'follow' }])
  })

  it('fails other bytes, and never retries a mismatch', async () => {
    const f = fakeFetch([{ status: 200, bytes: new TextEncoder().encode('something else') }])
    const out = await checkPackRelease(FACTS, { fetchImpl: f.impl, sleep: noSleep })
    expect(out.code).toBe(1)
    expect(out.lines.join('\n')).toMatch(/MISMATCH/)
    expect(f.seen).toHaveLength(1)
  })

  it('fails a 404 at once: the pinned release does not resolve', async () => {
    const f = fakeFetch([{ status: 404 }])
    const out = await checkPackRelease(FACTS, { fetchImpl: f.impl, sleep: noSleep })
    expect(out.code).toBe(1)
    expect(out.lines.join('\n')).toMatch(/HTTP 404, not 200/)
    expect(f.seen).toHaveLength(1)
  })

  it('retries a network error, then passes when the download lands', async () => {
    const pauses: number[] = []
    const f = fakeFetch([new Error('ECONNRESET'), { status: 200, bytes: BYTES }])
    const out = await checkPackRelease(FACTS, { fetchImpl: f.impl, sleep: async (ms) => { pauses.push(ms) } })
    expect(out.code).toBe(0)
    expect(f.seen).toHaveLength(2)
    expect(pauses).toHaveLength(1)
  })

  it('gives up after ATTEMPTS network errors or 5xx answers, and fails', async () => {
    for (const reply of [new Error('ETIMEDOUT'), { status: 503 }] as Reply[]) {
      const f = fakeFetch([reply])
      const out = await checkPackRelease(FACTS, { fetchImpl: f.impl, sleep: noSleep })
      expect(out.code).toBe(1)
      expect(f.seen).toHaveLength(ATTEMPTS)
    }
    expect(ATTEMPTS).toBeGreaterThanOrEqual(2)
  })

  it('download answers the last status after a retried 5xx turns into a 404', async () => {
    const f = fakeFetch([{ status: 502 }, { status: 404 }])
    expect(await download(FACTS.url, { fetchImpl: f.impl, sleep: noSleep })).toEqual({ status: 404 })
    expect(f.seen).toHaveLength(2)
  })
})

describe('what the CI step checks, and where it runs', () => {
  it('reads this build’s pinned release: PACK_URL, and a digest that passes the plan', () => {
    const plan = releaseCheckPlan({ published: PACK_PUBLISHED, sha256: PACK_SHA256, version: PACK_VERSION, url: packReleaseUrl(PACK_VERSION) })
    if (PACK_PUBLISHED) expect(plan).toEqual({ skip: false, url: PACK_URL, expected: PACK_SHA256, version: PACK_VERSION })
    else expect(plan.skip).toBe(true)
  })

  it('is `npm run pack:release-check`, a CLI that runs main() unconditionally', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['pack:release-check']).toBe('node scripts/check-pack-release-cli.mjs')
    const cli = readFileSync(join(ROOT, 'scripts', 'check-pack-release-cli.mjs'), 'utf8')
    expect(cli).toMatch(/^await main\(\)\s*$/m)
    expect(cli).not.toMatch(/process\.argv|import\.meta\.url/)
  })

  it('is its own CI step, named as network-dependent, blocking, and last', () => {
    type Step = { name?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown }
    const ci = parse(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
    const steps = Object.values(ci.jobs).flatMap((j) => j.steps)
    const mine = steps.filter((s) => s.run === 'npm run pack:release-check')
    expect(mine).toHaveLength(1)
    expect(mine[0].name).toMatch(/network/i)
    expect(mine[0].if).toBeUndefined()
    expect(mine[0]['continue-on-error']).toBeUndefined()
    expect(steps.at(-1)).toBe(mine[0])
  })

  it('is not in pack-release.yml, whose seven rules stay as they are', () => {
    const rel = readFileSync(join(ROOT, '.github', 'workflows', 'pack-release.yml'), 'utf8')
    expect(rel).not.toMatch(/pack:release-check|check-pack-release/)
  })
})
