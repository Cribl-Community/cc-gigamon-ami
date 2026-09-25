// Does the pack release this app build pins still resolve, to the bytes it
// recorded? `npm run pack:release-check` (scripts/check-pack-release-cli.mjs);
// CI runs it on every push and pull request.
//
// WHY THIS EXISTS. src/cribl/pack.ts pins `PACK_VERSION` and records the
// sha256 of its released `.crbl` (`PACK_SHA256`). Nothing in the app can check
// that record: the Leader downloads `PACK_URL` itself and `POST /packs` takes no
// digest, so the app never sees the bytes. A deleted or replaced release asset,
// a typo in the digest, or a `PACK_VERSION` bump whose tag was never pushed
// would all surface only on a customer's Leader, as an install that fails or
// installs something else. This downloads the pinned URL, as the Leader would
// (following GitHub's redirect to its object store), and compares.
//
// WHAT IT DOES:
//   * `PACK_PUBLISHED` false: prints why and exits 0 — there is no release to
//     check, and pack.test.ts already holds that `PACK_SHA256` is null then;
//   * otherwise GETs `packReleaseUrl(PACK_VERSION)`, following redirects. A
//     200 whose sha256 is `PACK_SHA256` passes; any other status, or any other
//     digest, exits 1;
//   * a network error (the request threw) and a 429 or 5xx are retried, up to
//     `ATTEMPTS` in all with a growing pause, because they say nothing about
//     the release. A 404 is not retried (the asset is not there), and a digest
//     mismatch is NEVER retried: the bytes were downloaded, and they are not
//     the ones recorded.
//
// NETWORK-DEPENDENT, so it is its own CI step, named as such, and not part of
// `npm test`: the unit tests (src/cribl/packReleaseCheck.test.ts) cover the
// pure parts here with a fake fetch and make no request. It is not in
// pack-release.yml, whose own rules already download and hash the asset before
// a release is published.
//
// This module runs nothing on import; the CLI file calls `main()`.

import { createHash } from 'node:crypto'

/** Attempts in all, for a request that failed for reasons of transport. */
export const ATTEMPTS = 3
/** The pause before retry n (1-based) is n × this. */
export const RETRY_PAUSE_MS = 3000

const SHA256_SHAPE = /^[0-9a-f]{64}$/

/** The lowercase hex sha256 of some bytes. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * What to check, from pack.ts's release facts. Pure.
 * @returns {{ skip: true, message: string } | { skip: false, url: string, expected: string, version: string } | { skip: false, error: string }}
 */
export function releaseCheckPlan({ published, sha256, version, url }) {
  if (!published) {
    return { skip: true, message: `skipped: pack ${version} is not recorded as published (src/cribl/pack.ts PACK_PUBLISHED is false), so there is no release to check` }
  }
  if (typeof sha256 !== 'string' || !SHA256_SHAPE.test(sha256)) {
    return { skip: false, error: `pack ${version} is recorded as published but PACK_SHA256 is ${JSON.stringify(sha256)}, not 64 lowercase hex characters` }
  }
  return { skip: false, url, expected: sha256, version }
}

/** Whether downloaded bytes are the recorded ones. Pure. */
export function compareDigest(expected, actual) {
  return expected === actual
    ? { ok: true, message: `ok: sha256 ${actual} matches PACK_SHA256` }
    : { ok: false, message: `MISMATCH: the release asset's sha256 is ${actual}, but src/cribl/pack.ts PACK_SHA256 records ${expected}` }
}

/** Whether a response status is worth asking again. Pure. */
export function retryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

/**
 * GET `url`, following redirects, with retries on transport failures only.
 * Answers `{ status, bytes }` for the last response, or `{ error }` when every
 * attempt threw. `fetchImpl` and `sleep` are injectable so tests make no request
 * and wait for nothing.
 */
export async function download(url, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = ATTEMPTS, log = () => {} } = {}) {
  let last = null
  for (let n = 1; n <= attempts; n++) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow' })
      if (res.status === 200) return { status: 200, bytes: Buffer.from(await res.arrayBuffer()) }
      last = { status: res.status }
      if (!retryableStatus(res.status)) return last
      log(`attempt ${n}/${attempts}: HTTP ${res.status}`)
    } catch (e) {
      last = { error: e instanceof Error ? e.message : String(e) }
      log(`attempt ${n}/${attempts}: ${last.error}`)
    }
    if (n < attempts) await sleep(n * RETRY_PAUSE_MS)
  }
  return last
}

/**
 * The whole check, given the release facts. Answers an exit code and the lines
 * to print. Never throws.
 */
export async function checkPackRelease(facts, opts = {}) {
  const plan = releaseCheckPlan(facts)
  if (plan.skip) return { code: 0, lines: [plan.message] }
  if ('error' in plan) return { code: 1, lines: [plan.error] }
  const lines = [`pack ${plan.version}: GET ${plan.url}`]
  const got = await download(plan.url, { ...opts, log: (l) => lines.push(l) })
  if ('error' in got) {
    lines.push(`FAILED: the release asset could not be downloaded after ${opts.attempts ?? ATTEMPTS} attempts: ${got.error}`)
    return { code: 1, lines }
  }
  if (got.status !== 200) {
    lines.push(`FAILED: the release asset answered HTTP ${got.status}, not 200 — the pinned release does not resolve`)
    return { code: 1, lines }
  }
  const verdict = compareDigest(plan.expected, sha256Hex(got.bytes))
  lines.push(`${got.bytes.length} bytes`, verdict.message)
  return { code: verdict.ok ? 0 : 1, lines }
}

/** Reads this build's pack.ts (Node strips its types) and runs the check. */
export async function main() {
  const pack = await import('../src/cribl/pack.ts')
  const out = await checkPackRelease({
    published: pack.PACK_PUBLISHED,
    sha256: pack.PACK_SHA256,
    version: pack.PACK_VERSION,
    url: pack.packReleaseUrl(pack.PACK_VERSION),
  })
  for (const l of out.lines) (out.code === 0 ? console.log : console.error)(l)
  process.exitCode = out.code
}
