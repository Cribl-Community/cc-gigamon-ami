// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Plugin } from 'vite'
import { createInitTracker, injectedInitSrc, refererOrigin, resolveInitUrl, type InitRequest } from '../scripts/devInitScript.ts'

// The Cribl UI loads the dev server as `/?init=https://<workspace>/app-ui/__local__/init.js?…`,
// and vite.config.ts injects that URL as a <script src>. It used to cache the FIRST init forever,
// so a second workspace's Live Preview got the first workspace's bridge (observed 2026-09-24: a
// reload loop in the second workspace).
//
// The request that carries NO init is not a Vite internal: `src/App.tsx` redirects `/` to
// `/flow-map` with `replace`, so the page drops its `?init=` as soon as it mounts, and every reload
// after that — F5, Vite's full reload, the config-changed bridge's `location.reload()` — asks for
// `/flow-map` with no init. Only the Referer says which workspace's tab is asking.
const WS_A = 'https://ws-a.example.cribl.cloud'
const WS_B = 'https://ws-b.example.cribl.cloud'
const A = `${WS_A}/app-ui/__local__/init.js?appId=__dev__x&v=1`
const B = `${WS_B}/app-ui/__local__/init.js?appId=__dev__x&v=1`
const withInit = (init: string, path = '/') => `${path}?init=${encodeURIComponent(init)}`
const initOf = (url: string | undefined) => (url === undefined ? null : new URL(url, 'http://localhost').searchParams.get('init'))

describe('resolveInitUrl (pure)', () => {
  it('a request that carries its own init keeps it, and records it under its referer origin', () => {
    const cache = new Map<string, string>()
    expect(resolveInitUrl(withInit(A), WS_A, cache)).toBe(withInit(A))
    expect([...cache]).toEqual([[WS_A, A]])
  })

  it("a request that carries B's init gets B, never the remembered A", () => {
    const cache = new Map([[WS_A, A]])
    expect(initOf(resolveInitUrl(withInit(B), WS_B, cache))).toBe(B)
  })

  it("A, then B, then A's tab reloads /flow-map with no init: it gets A, not the most recent B", () => {
    const cache = new Map<string, string>()
    resolveInitUrl(withInit(A), WS_A, cache)
    resolveInitUrl(withInit(B), WS_B, cache)
    expect(initOf(resolveInitUrl('/flow-map', WS_A, cache))).toBe(A)
    expect(initOf(resolveInitUrl('/flow-map', WS_B, cache))).toBe(B)
  })

  it('unknown referer with two workspaces seen: injects nothing rather than guess', () => {
    const cache = new Map([[WS_A, A], [WS_B, B]])
    expect(resolveInitUrl('/flow-map', null, cache)).toBe('/flow-map')
    expect(resolveInitUrl('/flow-map', 'https://ws-c.example.cribl.cloud', cache)).toBe('/flow-map')
  })

  it('unknown referer with ONE workspace ever seen: one-workspace behaviour is unchanged', () => {
    const cache = new Map([[WS_A, A]])
    expect(initOf(resolveInitUrl('/flow-map', null, cache))).toBe(A)
    expect(initOf(resolveInitUrl('/', 'http://localhost:5173', cache))).toBe(A)
  })

  it('same workspace, new init: the latest for that workspace wins', () => {
    const A2 = A.replace('v=1', 'v=2')
    const cache = new Map<string, string>()
    resolveInitUrl(withInit(A), WS_A, cache)
    resolveInitUrl(withInit(A2), WS_A, cache)
    expect(initOf(resolveInitUrl('/flow-map', WS_A, cache))).toBe(A2)
  })

  it('no referer on the init request: recorded under the init URL\'s own origin', () => {
    const cache = new Map<string, string>()
    resolveInitUrl(withInit(A), null, cache)
    expect([...cache]).toEqual([[WS_A, A]])
  })

  it('no init ever seen: the url is untouched', () => {
    expect(resolveInitUrl('/flow-map', WS_A, new Map())).toBe('/flow-map')
    expect(resolveInitUrl('/?init=', WS_A, new Map())).toBe('/?init=')
  })

  it('an empty ?init= is no init: it falls back like one', () => {
    expect(initOf(resolveInitUrl('/?init=', WS_A, new Map([[WS_A, A]])))).toBe(A)
  })

  it('an init we refuse is not recorded, and the request is left for the transform to refuse', () => {
    const cache = new Map([[WS_A, A]])
    for (const bad of ['javascript:alert(1)', 'data:text/javascript,alert(1)', '//ws-b.example/init.js', '/init.js', 'not a url']) {
      expect(resolveInitUrl(withInit(bad), WS_B, cache)).toBe(withInit(bad))
    }
    expect([...cache]).toEqual([[WS_A, A]])
  })

  it('keeps the rest of the query when it adds an init', () => {
    expect(initOf(resolveInitUrl('/flow-map?x=1', WS_A, new Map([[WS_A, A]])))).toBe(A)
    expect(resolveInitUrl('/flow-map?x=1', WS_A, new Map([[WS_A, A]]))).toMatch(/^\/flow-map\?x=1&init=/)
  })
})

describe('refererOrigin', () => {
  it('reads the Referer origin, falls back to Origin, and never answers "null"', () => {
    expect(refererOrigin({ referer: `${WS_A}/app-ui/x?y=1` })).toBe(WS_A)
    expect(refererOrigin({ origin: WS_B })).toBe(WS_B)
    expect(refererOrigin({ origin: 'null' })).toBeNull()
    // An opaque-origin referer (sandboxed or data: page) parses, and its origin is the string "null".
    expect(refererOrigin({ referer: 'data:text/html,x' })).toBeNull()
    expect(refererOrigin({ referer: 'not a url' })).toBeNull()
    expect(refererOrigin({})).toBeNull()
  })
})

describe('createInitTracker().middleware — the state vite.config.ts holds', () => {
  const html = (url: string, referer?: string): InitRequest => ({
    url,
    originalUrl: url,
    headers: { accept: 'text/html,application/xhtml+xml', ...(referer ? { referer } : {}) },
  })
  const run = (t: ReturnType<typeof createInitTracker>, req: InitRequest) => {
    const next = vi.fn()
    t.middleware(req, {}, next)
    expect(next).toHaveBeenCalledOnce()
    return req
  }

  it("the two-workspace reload: A's /flow-map reload after B loaded carries A's init to the transform", () => {
    const t = createInitTracker()
    run(t, html(withInit(A), `${WS_A}/app-ui/`))
    run(t, html(withInit(B), `${WS_B}/app-ui/`))
    const reloadA = run(t, html('/flow-map', `${WS_A}/app-ui/`))
    expect(injectedInitSrc(reloadA.originalUrl)).toBe(A)
    const reloadB = run(t, html('/flow-map', `${WS_B}/app-ui/`))
    expect(injectedInitSrc(reloadB.originalUrl)).toBe(B)
  })

  it('a refused init does not clear what the tracker remembers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = createInitTracker()
    run(t, html(withInit(A), `${WS_A}/`))
    const bad = run(t, html(withInit('javascript:alert(1)'), `${WS_A}/`))
    expect(injectedInitSrc(bad.originalUrl)).toBeNull()
    expect(injectedInitSrc(run(t, html('/flow-map', `${WS_A}/`)).originalUrl)).toBe(A)
    warn.mockRestore()
  })

  it('rewrites only originalUrl (what Vite hands transformIndexHtml), never req.url', () => {
    const t = createInitTracker()
    run(t, html(withInit(A), `${WS_A}/`))
    const req = run(t, html('/flow-map', `${WS_A}/`))
    expect(req.url).toBe('/flow-map')
    expect(initOf(req.originalUrl)).toBe(A)
  })

  it('leaves non-HTML requests alone', () => {
    const t = createInitTracker()
    run(t, html(withInit(A), `${WS_A}/`))
    const req: InitRequest = { url: '/src/main.tsx', originalUrl: '/src/main.tsx', headers: { accept: '*/*', referer: `${WS_A}/` } }
    run(t, req)
    expect(req.originalUrl).toBe('/src/main.tsx')
  })
})

describe('injectedInitSrc', () => {
  afterEach(() => vi.restoreAllMocks())

  it('injects the init string exactly as the Cribl UI gave it — no re-serialisation', () => {
    const odd = 'https://WS-A.example.cribl.cloud:443/app-ui/./__local__/init.js?q=a b&r=\''
    expect(injectedInitSrc(withInit(odd))).toBe(odd)
  })

  it('no init, an empty init, or no url: injects nothing, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(injectedInitSrc(undefined)).toBeNull()
    expect(injectedInitSrc('/flow-map')).toBeNull()
    expect(injectedInitSrc('/?init=')).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses anything but an absolute http(s) URL, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = ['javascript:alert(1)', 'data:text/javascript,alert(1)', '//ws-b.example/init.js', '/init.js', 'https:ws-b.example/init.js', ' https://ws-b.example/init.js', 'not a url']
    for (const b of bad) expect(injectedInitSrc(withInit(b))).toBeNull()
    expect(warn).toHaveBeenCalledTimes(bad.length)
    expect(warn.mock.calls[0]).toEqual(['[inject-script-from-query] refused init', 'javascript:alert(1)'])
  })
})

describe("the raw src is safe because Vite escapes attributes (vite's own serializer, not ours)", () => {
  it('a hostile init cannot leave the src attribute', async () => {
    const hostile = `${WS_A}/init.js?x="><script>alert(1)</script>&y='1'`
    const plugin: Plugin = {
      name: 'probe',
      transformIndexHtml: (html, ctx) => {
        const src = injectedInitSrc(ctx.originalUrl)
        return { html, tags: src ? [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }] : [] }
      },
    }
    const server = await createServer({ configFile: false, logLevel: 'silent', plugins: [plugin], server: { middlewareMode: true, hmr: false, ws: false } })
    try {
      const out = await server.transformIndexHtml('/index.html', '<html><head></head><body></body></html>', withInit(hostile))
      expect(out).not.toContain('<script>alert(1)</script>')
      expect(out).toContain('src="https://ws-a.example.cribl.cloud/init.js?x=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;y=&#39;1&#39;"')
    } finally {
      await server.close()
    }
  })
})

describe('vite.config.ts wiring', () => {
  // vitest does not load vite.config.ts (vitest.config.ts says why), so the two lines that connect
  // the tracker to Vite are held here as text. Everything they call is tested above.
  const src = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf-8')

  it('installs the tracker as a PRE middleware (inside configureServer, not a returned post hook)', () => {
    const body = src.slice(src.indexOf('configureServer(server: ViteDevServer) {\n      startDevTokenRefresh()'))
    const hookEnd = body.indexOf('\n    },')
    expect(body.slice(0, hookEnd)).toContain('server.middlewares.use(initTracker.middleware)')
    expect(body.slice(0, hookEnd)).not.toMatch(/return\s*\(\)\s*=>/)
  })

  it('the transform reads only the request it is given — no module-level init state', () => {
    expect(src).toContain('const initSrc = injectedInitSrc(ctx.originalUrl)')
    expect(src).not.toMatch(/initScriptUrl/)
  })
})
