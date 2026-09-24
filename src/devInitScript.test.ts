import { describe, expect, it } from 'vitest'
import { decideInitScript } from '../scripts/devInitScript.ts'

// The Cribl UI loads the dev server as `/?init=https://<workspace>/app-ui/__local__/init.js?…`.
// The plugin in vite.config.ts injects that URL as a <script src>; it used to cache the FIRST one
// forever, so a second workspace's Live Preview got the first workspace's bridge (observed
// 2026-09-24: a reload loop in the second workspace).
const A = 'https://ws-a.example.cribl.cloud/app-ui/__local__/init.js?appId=__dev__x&v=1'
const B = 'https://ws-b.example.cribl.cloud/app-ui/__local__/init.js?appId=__dev__x&v=1'
const req = (init?: string) => (init === undefined ? '/' : `/?init=${encodeURIComponent(init)}`)

describe('decideInitScript', () => {
  it('first request: injects and remembers the init it carries', () => {
    expect(decideInitScript(req(A), null)).toEqual({ src: A, cache: A })
  })

  it("second workspace: injects B's init, never the cached A", () => {
    const d = decideInitScript(req(B), A)
    expect(d.src).toBe(B)
    expect(d.cache).toBe(B)
  })

  it('request without init (Vite internal index request): falls back to the cached init', () => {
    expect(decideInitScript(req(), A)).toEqual({ src: A, cache: A })
    expect(decideInitScript(undefined, A)).toEqual({ src: A, cache: A })
    expect(decideInitScript(req(''), A)).toEqual({ src: A, cache: A })
  })

  it('request without init after B was seen: falls back to B, the most recent, not the first', () => {
    const afterA = decideInitScript(req(A), null)
    const afterB = decideInitScript(req(B), afterA.cache)
    expect(decideInitScript(req(), afterB.cache).src).toBe(B)
  })

  it('same workspace repeat: stable', () => {
    const first = decideInitScript(req(A), null)
    expect(decideInitScript(req(A), first.cache)).toEqual({ src: A, cache: A })
  })

  it('no init ever seen: injects nothing', () => {
    expect(decideInitScript(req(), null)).toEqual({ src: null, cache: null })
  })

  it('an init that is not an http(s) URL is refused, and does not fall back to the cached one', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/javascript,alert(1)', '//ws-b.example/init.js', 'not a url']) {
      expect(decideInitScript(req(bad), A)).toEqual({ src: null, cache: A })
    }
  })

  it('the src it returns cannot break out of a double-quoted attribute', () => {
    const hostile = 'https://ws-a.example.cribl.cloud/init.js?x="><script>alert(1)</script>&y=\'1\''
    const { src } = decideInitScript(req(hostile), null)
    expect(src).not.toBeNull()
    expect(src).not.toMatch(/["'<>\s]/)
    expect(src!.startsWith('https://ws-a.example.cribl.cloud/init.js?')).toBe(true)
  })
})
