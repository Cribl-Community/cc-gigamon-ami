// Fetch a released app bundle into build/: `npm run release:fetch`
// (scripts/fetch-release-cli.mjs), or `npm run release:fetch -- --tag v1.1.1`.
//
// WHY THIS EXISTS. Releases are built in CI: a `v*` tag runs
// .github/workflows/release.yml, which runs `npm run package` there and attaches
// `cc-gigamon-ami-<version>.tgz` and `cc-gigamon-ami-latest.tgz` to the GitHub
// release. The local build/ folder is NOT refreshed by that, so its tracked
// `cc-gigamon-ami-latest.tgz` is whatever someone last packaged by hand — on
// 2026-09-25 a hand upload of it installed 1.0.20 while 1.1.1 was released.
// This downloads the release's own two bundles instead, and reads the version
// out of each before it trusts it.
//
// WHAT IT DOES:
//   * with no `--tag`, picks the newest non-draft, non-prerelease release whose
//     tag is `vX.Y.Z` (never a `gigamon-pack-v*` pack release, never
//     `-staging`, never the moving `latest` tag). `--tag vX.Y.Z[-staging]`
//     names one;
//   * downloads both bundles with the gh CLI (`gh release download`, which
//     uses the viewer's own gh login) into a fresh temporary directory, NOT
//     into build/;
//   * opens each .tgz, reads its `./package.json`, and prints name, version and
//     author. It fails — and build/ is left exactly as it was — when either
//     bundle is missing, is not a readable tgz, has no package.json, names
//     another app, or carries a version other than the tag's (the tag less its
//     `v` and any `-staging`, as release.yml computes it);
//   * only when both pass does it copy them into build/, replacing
//     `cc-gigamon-ami-latest.tgz` (the one tracked file there).
//
// NETWORK-DEPENDENT (GitHub only; it never talks to Cribl) and not part of
// `npm test`. The unit tests (src/fetchRelease.test.ts) cover the pure parts —
// tag parsing and choice, the version check, reading package.json out of a tgz
// built in the test — and drive `fetchRelease` with a fake `gh`, so they make no
// request. This module runs nothing on import; the CLI file calls `main()`.

import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const APP_NAME = 'cc-gigamon-ami'
export const BUILD_DIR = join(import.meta.dirname, '..', 'build')

const TAG_SHAPE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-staging)?$/

/**
 * A release tag's version, as release.yml computes it (`${GITHUB_REF_NAME#v}`
 * less `-staging`). Null for anything that is not an app release tag — a pack
 * tag (`gigamon-pack-v0.2.2`), the moving `latest` tag, a bare version. Pure.
 * @returns {{ tag: string, version: string, staging: boolean, rank: number[] } | null}
 */
export function parseReleaseTag(tag) {
  const m = typeof tag === 'string' ? TAG_SHAPE.exec(tag) : null
  if (!m) return null
  return { tag, version: `${m[1]}.${m[2]}.${m[3]}`, staging: m[4] !== undefined, rank: [Number(m[1]), Number(m[2]), Number(m[3])] }
}

/** The two asset names a release carries for a version. Pure. */
export function assetNames(version) {
  return [`${APP_NAME}-${version}.tgz`, `${APP_NAME}-latest.tgz`]
}

/**
 * The release to fetch when no tag was named: the highest `vX.Y.Z` by semver
 * among releases that are neither drafts nor prereleases, staging tags left
 * out. Not "the release GitHub marks Latest", which a person can move. Pure.
 * @param {Array<{ tagName: string, isDraft?: boolean, isPrerelease?: boolean }>} releases
 */
export function pickLatestRelease(releases) {
  let best = null
  for (const r of releases ?? []) {
    if (r?.isDraft || r?.isPrerelease) continue
    const t = parseReleaseTag(r?.tagName)
    if (!t || t.staging) continue
    if (!best || compareRank(t.rank, best.rank) > 0) best = t
  }
  return best
}

function compareRank(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * Read one file out of a tar archive (ustar, GNU or pax; a leading `./` and the
 * ustar prefix field are both honoured). Every header's checksum is checked.
 * Answers the file's bytes, or null when the archive has no such file. Pure.
 */
export function readTarFile(tar, wanted) {
  const want = normalise(wanted)
  let off = 0
  let longName = null
  let paxPath = null
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every((x) => x === 0)) return null
    const str = (a, n) => h.toString('utf8', a, a + n).split('\0')[0]
    const num = (a, n) => parseInt(str(a, n).trim() || '0', 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]
    if (sum !== num(148, 8)) throw new Error(`bad tar header checksum at offset ${off}`)
    const size = num(124, 12)
    const type = str(156, 1)
    const data = tar.subarray(off + 512, off + 512 + size)
    if (data.length < size) throw new Error(`tar entry at offset ${off} is cut short`)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = data.toString('utf8').split('\0')[0]; continue }
    if (type === 'x') { paxPath = paxField(data, 'path'); continue }
    if (type === 'g') continue
    const prefix = str(257, 6) === 'ustar' ? str(345, 155) : ''
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100))
    longName = null
    paxPath = null
    if ((type === '0' || type === '') && normalise(name) === want) return Buffer.from(data)
  }
  return null
}

function normalise(name) {
  return String(name).replace(/^(\.\/)+/, '').replace(/^\/+/, '')
}

function paxField(data, key) {
  for (const line of data.toString('utf8').split('\n')) {
    const m = /^\d+ ([^=]+)=(.*)$/.exec(line)
    if (m && m[1] === key) return m[2]
  }
  return null
}

/**
 * The package.json inside an app bundle (.tgz). Throws with a sentence when the
 * bytes are not a gzip, hold no package.json, or it is not JSON. Pure.
 */
export function readBundlePackageJson(tgz) {
  let tar
  try {
    tar = gunzipSync(tgz)
  } catch (e) {
    throw new Error(`not a gzip archive (${e.message})`)
  }
  const bytes = readTarFile(tar, 'package.json')
  if (!bytes) throw new Error('the archive holds no ./package.json')
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (e) {
    throw new Error(`its package.json is not JSON (${e.message})`)
  }
}

/**
 * Whether a bundle's package.json is this app at the tag's version. Pure.
 * @returns {{ ok: boolean, message: string }}
 */
export function checkBundle(file, pkg, expectedVersion) {
  const who = `${file}: ${pkg?.name ?? '(no name)'} ${pkg?.version ?? '(no version)'}, author ${pkg?.author ?? '(none)'}`
  if (pkg?.name !== APP_NAME) return { ok: false, message: `${who} — MISMATCH: the name is not ${APP_NAME}` }
  if (pkg?.version !== expectedVersion) return { ok: false, message: `${who} — MISMATCH: the tag says ${expectedVersion}` }
  return { ok: true, message: `${who} — ok` }
}

/** Parse the command line. Pure. @returns {{ tag: string | null } | { error: string }} */
export function parseArgs(argv) {
  let tag = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tag') {
      tag = argv[++i] ?? ''
    } else if (a.startsWith('--tag=')) {
      tag = a.slice('--tag='.length)
    } else {
      return { error: `unknown argument ${JSON.stringify(a)}; usage: npm run release:fetch [-- --tag vX.Y.Z]` }
    }
  }
  if (tag !== null && !parseReleaseTag(tag)) return { error: `--tag ${JSON.stringify(tag)} is not an app release tag (vX.Y.Z or vX.Y.Z-staging)` }
  return { tag }
}

/** Run gh, answering `{ code, stdout, stderr }`; never throws. */
export function runGh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      // A gh that is not installed never writes stderr; its spawn error says so.
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err?.message ?? '') })
    })
  })
}

/**
 * Resolve the tag, download both bundles to a temporary directory, check each,
 * and only then copy them into `buildDir`. `gh`, `buildDir` and `tmp` are
 * injectable, so tests make no request and touch no real build/.
 * @returns {Promise<{ code: number, lines: string[] }>}
 */
export async function fetchRelease({ tag = null, gh = runGh, buildDir = BUILD_DIR, tmp = () => mkdtempSync(join(tmpdir(), 'release-fetch-')) } = {}) {
  const lines = []
  let chosen = tag ? parseReleaseTag(tag) : null
  if (tag && !chosen) return { code: 2, lines: [`${tag} is not an app release tag`] }
  if (!chosen) {
    const list = await gh(['release', 'list', '--limit', '100', '--json', 'tagName,isDraft,isPrerelease'])
    if (list.code !== 0) return { code: 1, lines: [`gh release list failed: ${list.stderr.trim() || `exit ${list.code}`}`] }
    let releases
    try {
      releases = JSON.parse(list.stdout)
    } catch {
      return { code: 1, lines: ['gh release list did not answer JSON'] }
    }
    chosen = pickLatestRelease(releases)
    if (!chosen) return { code: 1, lines: ['no vX.Y.Z release found (drafts, prereleases, -staging and pack releases are not counted)'] }
    lines.push(`newest app release: ${chosen.tag}`)
  }

  const names = assetNames(chosen.version)
  const dir = tmp()
  try {
    const args = ['release', 'download', chosen.tag, '--dir', dir]
    for (const n of names) args.push('--pattern', n)
    const dl = await gh(args)
    if (dl.code !== 0) return { code: 1, lines: [...lines, `gh release download ${chosen.tag} failed: ${dl.stderr.trim() || `exit ${dl.code}`}`, 'build/ was not changed'] }

    let ok = true
    for (const n of names) {
      const path = join(dir, n)
      if (!existsSync(path)) {
        lines.push(`${n}: not attached to ${chosen.tag}`)
        ok = false
        continue
      }
      let pkg
      try {
        pkg = readBundlePackageJson(readFileSync(path))
      } catch (e) {
        lines.push(`${n}: ${e.message}`)
        ok = false
        continue
      }
      const r = checkBundle(n, pkg, chosen.version)
      lines.push(r.message)
      if (!r.ok) ok = false
    }
    if (!ok) return { code: 1, lines: [...lines, 'build/ was not changed'] }

    mkdirSync(buildDir, { recursive: true })
    for (const n of names) copyFileSync(join(dir, n), join(buildDir, n))
    lines.push(`wrote ${names.map((n) => join(buildDir, n)).join(' and ')} from ${chosen.tag}`)
    return { code: 0, lines }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function main() {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    process.stderr.write(`${args.error}\n`)
    process.exit(2)
  }
  const { code, lines } = await fetchRelease({ tag: args.tag })
  const out = code === 0 ? process.stdout : process.stderr
  for (const l of lines) out.write(`${l}\n`)
  process.exit(code)
}
