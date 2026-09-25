// scripts/fetch-release.mjs: `npm run release:fetch`, which downloads a released
// app bundle into build/ and reads the version out of it before trusting it.
//
// NO NETWORK. Every gh call goes to a fake that writes fixture bundles; the
// bundles are tar archives built here and gzipped with zlib, and build/ is a
// temporary directory. What GitHub actually holds is the command's to find out.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_NAME, assetNames, checkBundle, fetchRelease, parseArgs, parseReleaseTag, pickLatestRelease,
  readBundlePackageJson, readTarFile, type GhResult,
} from '../scripts/fetch-release.mjs'

// ── A minimal tar writer, for fixtures ────────────────────────────────────────

function octal(b: Buffer, off: number, len: number, v: number) {
  b.write(v.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii')
}
function tarHeader(name: string, size: number, type = '0', prefix = '') {
  const b = Buffer.alloc(512)
  b.write(name, 0, 100, 'utf8')
  octal(b, 100, 8, 0o644)
  octal(b, 108, 8, 0)
  octal(b, 116, 8, 0)
  octal(b, 124, 12, size)
  octal(b, 136, 12, 0)
  b.fill(0x20, 148, 156)
  b.write(type, 156, 1, 'ascii')
  b.write('ustar\0', 257, 6, 'ascii')
  b.write('00', 263, 2, 'ascii')
  if (prefix) b.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const x of b) sum += x
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return b
}
type Entry = { name: string; data?: string; type?: string; prefix?: string }
function tar(entries: Entry[]) {
  const parts: Buffer[] = []
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'utf8')
    parts.push(tarHeader(e.name, data.length, e.type ?? '0', e.prefix))
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
/** An app bundle as `npm run package` lays it out: `./package.json` beside `./static/`. */
function bundle(pkg: Record<string, unknown>) {
  return gzipSync(tar([
    { name: './', type: '5' },
    { name: './default/', type: '5' },
    { name: './default/policies.yml', data: 'policies: []\n' },
    { name: './package.json', data: JSON.stringify(pkg, null, 2) },
    { name: './static/', type: '5' },
  ]))
}
const PKG = (version: string) => ({ name: APP_NAME, version, author: 'Gigamon Alliances - alliances@gigamon.com' })

describe('release tags', () => {
  it('reads a vX.Y.Z tag as release.yml does, staging suffix dropped', () => {
    expect(parseReleaseTag('v1.1.1')).toMatchObject({ version: '1.1.1', staging: false })
    expect(parseReleaseTag('v1.2.0-staging')).toMatchObject({ version: '1.2.0', staging: true })
  })

  it('refuses a pack tag, the moving latest tag, a bare version and leading zeros', () => {
    for (const t of ['gigamon-pack-v0.2.2', 'latest', '1.1.1', 'v1.1', 'v01.1.1', 'v1.1.1-rc1', '', null]) {
      expect(parseReleaseTag(t), String(t)).toBeNull()
    }
  })

  it('names the two assets a release carries', () => {
    expect(assetNames('1.1.1')).toEqual(['cc-gigamon-ami-1.1.1.tgz', 'cc-gigamon-ami-latest.tgz'])
  })

  it('picks the highest app release by semver, never a draft, prerelease, staging or pack release', () => {
    const picked = pickLatestRelease([
      { tagName: 'gigamon-pack-v9.9.9' },
      { tagName: 'v1.9.0' },
      { tagName: 'v1.10.0' },
      { tagName: 'v2.0.0', isDraft: true },
      { tagName: 'v2.1.0', isPrerelease: true },
      { tagName: 'v3.0.0-staging' },
      { tagName: 'latest' },
    ])
    expect(picked?.tag).toBe('v1.10.0')
    expect(pickLatestRelease([{ tagName: 'gigamon-pack-v0.2.2' }])).toBeNull()
    expect(pickLatestRelease([])).toBeNull()
  })
})

describe('the command line', () => {
  it('takes --tag in both spellings, and nothing else', () => {
    expect(parseArgs([])).toEqual({ tag: null })
    expect(parseArgs(['--tag', 'v1.1.1'])).toEqual({ tag: 'v1.1.1' })
    expect(parseArgs(['--tag=v1.1.1'])).toEqual({ tag: 'v1.1.1' })
    expect(parseArgs(['--tag', 'gigamon-pack-v0.2.2'])).toHaveProperty('error')
    expect(parseArgs(['--tag'])).toHaveProperty('error')
    expect(parseArgs(['--force'])).toHaveProperty('error')
  })
})

describe('reading package.json out of a bundle', () => {
  it('finds ./package.json among other entries', () => {
    expect(readBundlePackageJson(bundle(PKG('1.1.1')))).toMatchObject({ version: '1.1.1', author: PKG('1.1.1').author })
  })

  it('honours a bare name, the ustar prefix field, a GNU long name and a pax path', () => {
    const raw = JSON.stringify(PKG('1.0.0'))
    expect(readTarFile(tar([{ name: 'package.json', data: raw }]), 'package.json')?.toString()).toBe(raw)
    expect(readTarFile(tar([{ name: 'package.json', data: raw, prefix: 'x' }]), 'x/package.json')?.toString()).toBe(raw)
    expect(readTarFile(tar([{ name: '././@LongLink', type: 'L', data: './package.json\0' }, { name: 'trunc', data: raw }]), 'package.json')?.toString()).toBe(raw)
    expect(readTarFile(tar([{ name: 'PaxHeader', type: 'x', data: '23 path=./package.json\n' }, { name: 'p', data: raw }]), 'package.json')?.toString()).toBe(raw)
  })

  it('does not take a nested package.json for the bundle\'s own', () => {
    const t = tar([{ name: './static/package.json', data: '{"version":"0.0.1"}' }])
    expect(readTarFile(t, 'package.json')).toBeNull()
  })

  it('fails with a sentence on a non-gzip, a bundle with no package.json, and a corrupt header', () => {
    expect(() => readBundlePackageJson(Buffer.from('not a gzip'))).toThrow(/not a gzip/)
    expect(() => readBundlePackageJson(gzipSync(tar([{ name: './README.md', data: 'x' }])))).toThrow(/no \.\/package\.json/)
    expect(() => readBundlePackageJson(gzipSync(tar([{ name: './package.json', data: '{' }])))).toThrow(/not JSON/)
    const bad = tar([{ name: './package.json', data: '{}' }])
    bad[0] ^= 1
    expect(() => readTarFile(bad, 'package.json')).toThrow(/checksum/)
  })
})

describe('the version check', () => {
  it('passes this app at the tag\'s version, and prints name, version and author', () => {
    const r = checkBundle('a.tgz', PKG('1.1.1'), '1.1.1')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('1.1.1')
    expect(r.message).toContain('Gigamon Alliances')
  })

  it('fails another version (the stale 1.0.20 case) and another app, naming both sides', () => {
    const stale = checkBundle('cc-gigamon-ami-latest.tgz', PKG('1.0.20'), '1.1.1')
    expect(stale.ok).toBe(false)
    expect(stale.message).toMatch(/1\.0\.20.*MISMATCH.*1\.1\.1/)
    expect(checkBundle('a.tgz', { ...PKG('1.1.1'), name: '__dev__cc-gigamon-ami' }, '1.1.1').ok).toBe(false)
    expect(checkBundle('a.tgz', null, '1.1.1').ok).toBe(false)
  })
})

describe('fetchRelease, against a fake gh', () => {
  const dirs: string[] = []
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'fetch-release-test-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** A gh that lists `releases` and, on download, writes `assets` into --dir. */
  function fakeGh(releases: unknown[], assets: Record<string, Buffer>) {
    const calls: string[][] = []
    const gh = async (args: string[]): Promise<GhResult> => {
      calls.push(args)
      if (args[0] === 'release' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(releases), stderr: '' }
      if (args[0] === 'release' && args[1] === 'download') {
        const dir = args[args.indexOf('--dir') + 1]
        mkdirSync(dir, { recursive: true })
        for (const [name, bytes] of Object.entries(assets)) writeFileSync(join(dir, name), bytes)
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
    }
    return { gh, calls }
  }

  it('resolves the newest app release, downloads both bundles, checks them and copies them into build/', async () => {
    const good = bundle(PKG('1.1.1'))
    const { gh, calls } = fakeGh([{ tagName: 'v1.1.0' }, { tagName: 'v1.1.1' }, { tagName: 'gigamon-pack-v0.2.2' }], {
      'cc-gigamon-ami-1.1.1.tgz': good, 'cc-gigamon-ami-latest.tgz': good,
    })
    const buildDir = tempDir()
    const r = await fetchRelease({ gh, buildDir, tmp: tempDir })
    expect(r.code, r.lines.join('\n')).toBe(0)
    expect(calls[1]).toEqual(expect.arrayContaining(['download', 'v1.1.1', '--pattern', 'cc-gigamon-ami-1.1.1.tgz', 'cc-gigamon-ami-latest.tgz']))
    expect(readFileSync(join(buildDir, 'cc-gigamon-ami-latest.tgz')).equals(good)).toBe(true)
    expect(existsSync(join(buildDir, 'cc-gigamon-ami-1.1.1.tgz'))).toBe(true)
    expect(r.lines.join('\n')).toContain('Gigamon Alliances')
  })

  it('with --tag, lists nothing and downloads that tag', async () => {
    const good = bundle(PKG('1.1.0'))
    const { gh, calls } = fakeGh([], { 'cc-gigamon-ami-1.1.0.tgz': good, 'cc-gigamon-ami-latest.tgz': good })
    const r = await fetchRelease({ tag: 'v1.1.0', gh, buildDir: tempDir(), tmp: tempDir })
    expect(r.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 3)).toEqual(['release', 'download', 'v1.1.0'])
  })

  it('leaves build/ untouched when a bundle carries another version', async () => {
    const buildDir = tempDir()
    writeFileSync(join(buildDir, 'cc-gigamon-ami-latest.tgz'), 'the old one')
    const { gh } = fakeGh([{ tagName: 'v1.1.1' }], {
      'cc-gigamon-ami-1.1.1.tgz': bundle(PKG('1.1.1')), 'cc-gigamon-ami-latest.tgz': bundle(PKG('1.0.20')),
    })
    const r = await fetchRelease({ gh, buildDir, tmp: tempDir })
    expect(r.code).toBe(1)
    expect(r.lines.join('\n')).toMatch(/MISMATCH[\s\S]*build\/ was not changed/)
    expect(readFileSync(join(buildDir, 'cc-gigamon-ami-latest.tgz'), 'utf8')).toBe('the old one')
    expect(existsSync(join(buildDir, 'cc-gigamon-ami-1.1.1.tgz'))).toBe(false)
  })

  it('fails when an asset is missing or unreadable, and when gh fails', async () => {
    const one = fakeGh([{ tagName: 'v1.1.1' }], { 'cc-gigamon-ami-1.1.1.tgz': bundle(PKG('1.1.1')) })
    const missing = await fetchRelease({ gh: one.gh, buildDir: tempDir(), tmp: tempDir })
    expect(missing.code).toBe(1)
    expect(missing.lines.join('\n')).toContain('cc-gigamon-ami-latest.tgz: not attached to v1.1.1')

    const junk = fakeGh([{ tagName: 'v1.1.1' }], { 'cc-gigamon-ami-1.1.1.tgz': Buffer.from('x'), 'cc-gigamon-ami-latest.tgz': Buffer.from('x') })
    expect((await fetchRelease({ gh: junk.gh, buildDir: tempDir(), tmp: tempDir })).code).toBe(1)

    const refused = async (): Promise<GhResult> => ({ code: 4, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login' })
    const r = await fetchRelease({ gh: refused, buildDir: tempDir(), tmp: tempDir })
    expect(r.code).toBe(1)
    expect(r.lines[0]).toMatch(/gh release list failed: gh: To get started/)
  })

  it('fails, downloading nothing, when no app release exists', async () => {
    const { gh, calls } = fakeGh([{ tagName: 'gigamon-pack-v0.2.2' }, { tagName: 'v9.0.0', isDraft: true }], {})
    const r = await fetchRelease({ gh, buildDir: tempDir(), tmp: tempDir })
    expect(r.code).toBe(1)
    expect(calls).toHaveLength(1)
  })
})

describe('the wiring', () => {
  it('is the npm script release:fetch, and is in no workflow (it is for a person, and needs the network)', () => {
    const root = join(import.meta.dirname, '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['release:fetch']).toBe('node scripts/fetch-release-cli.mjs')
    for (const wf of ['ci.yml', 'release.yml', 'pack-release.yml']) {
      expect(readFileSync(join(root, '.github', 'workflows', wf), 'utf8'), wf).not.toContain('release:fetch')
    }
  })
})
