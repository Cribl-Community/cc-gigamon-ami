// DEV-ONLY: which Cribl bridge script `npm run dev` injects into index.html.
//
// The Cribl UI loads the dev server as `/?init=https://<workspace>/app-ui/__local__/init.js?…`,
// and vite.config.ts injects that URL as a <script src>.
//
// Most HTML requests do NOT carry an init, and they are not Vite internals. `src/App.tsx` redirects
// `/` to `/flow-map` with `replace`, so a Live Preview page drops its `?init=` from the URL as soon
// as it mounts. Every reload after that asks for `/flow-map` with no init: F5, Vite's own full
// reload, and the config-changed bridge's `window.location.reload()` in vite.config.ts (which fires
// in every open tab at once when package.json or config/*.yml changes). Those pages still need the
// bridge — THEIR workspace's bridge. What says which workspace a tab belongs to is the Referer: the
// iframe's navigation carries the Cribl workspace origin, and a reload keeps it.
//
// History: this was `cached || requested`, so the FIRST workspace's init won forever and a second
// workspace's Live Preview loaded the first one's bridge (observed 2026-09-24: a reload loop).
// "Latest wins" only moves that bug to the first workspace's next reload. The rule now:
//   - a request that carries an init gets exactly that init, and it is remembered under the
//     requesting page's origin (Referer, else Origin, else the init URL's own origin);
//   - a request with no init gets the init remembered for ITS referer origin;
//   - with an unknown referer it gets the one remembered init only while a single origin has ever
//     been seen (one workspace behaves as before), and NOTHING once two have — never a guess;
//   - an init that is not an absolute http(s) URL is never remembered and is never injected; the
//     transform says so on the console rather than dropping it silently.
//
// The injected src is the init string exactly as the Cribl UI sent it, not a re-serialised URL:
// the bridge may read its own script.src, and attribute safety is Vite's job — its serializeAttrs
// runs every attribute value through escape-html (vite 8.1.5), which the test file checks against
// Vite itself.
//
// Free of Node types (structural request/headers types instead), so tsconfig.node.json
// (vite.config.ts) and the vitest project can both import it without either reaching the app
// project.

type HeaderValue = string | string[] | undefined

/** The slice of a Node/connect request the middleware reads and writes. */
export type InitRequest = {
  url?: string
  originalUrl?: string
  headers: Record<string, HeaderValue>
}

const BASE = 'http://localhost'
const first = (v: HeaderValue) => (Array.isArray(v) ? v[0] : v)

/** The init string in a request URL, or null when there is none (`?init=` with nothing is none). */
function initParam(url: string | undefined): string | null {
  if (url === undefined) return null
  let u: URL
  try {
    u = new URL(url, BASE)
  } catch {
    return null
  }
  return u.searchParams.get('init') || null
}

/** Whether an init may be injected as a script src: an absolute http(s) URL, written as one. */
function isAcceptableInit(raw: string): boolean {
  // The prefix check refuses what the WHATWG parser would quietly repair — `https:host/x`,
  // leading whitespace — so what is injected is what was checked.
  if (!/^https?:\/\//i.test(raw)) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** The origin of the page that made the request, or null when it cannot be told. */
export function refererOrigin(headers: Record<string, HeaderValue>): string | null {
  for (const raw of [first(headers.referer), first(headers.origin)]) {
    if (!raw) continue
    try {
      const o = new URL(raw).origin
      if (o && o !== 'null') return o
    } catch {
      /* not a URL — try the next header */
    }
  }
  return null
}

/**
 * The URL the index-html transform should see for this request. A request carrying an acceptable
 * init is returned unchanged and its init recorded in `cache` (origin → latest init). A request
 * with no init gets the init remembered for its origin appended, or the url back unchanged when
 * there is none it can safely name. Mutates `cache`; nothing else.
 */
export function resolveInitUrl(url: string, origin: string | null, cache: Map<string, string>): string {
  const requested = initParam(url)
  if (requested !== null) {
    if (isAcceptableInit(requested)) cache.set(origin ?? new URL(requested).origin, requested)
    return url
  }
  const known = origin !== null ? cache.get(origin) : undefined
  const init = known ?? (cache.size === 1 ? [...cache.values()][0] : undefined)
  if (init === undefined) return url
  const u = new URL(url, BASE)
  u.searchParams.set('init', init)
  return u.pathname + u.search + u.hash
}

/**
 * The script src to inject for a request, read from the URL Vite hands transformIndexHtml
 * (`ctx.originalUrl`). Stateless: whatever fallback applies was already written into that URL by
 * the tracker's middleware.
 */
export function injectedInitSrc(originalUrl: string | undefined): string | null {
  const requested = initParam(originalUrl)
  if (requested === null) return null
  if (isAcceptableInit(requested)) return requested
  // eslint-disable-next-line no-console
  console.warn('[inject-script-from-query] refused init', requested)
  return null
}

const acceptsHtml = (req: InitRequest) => (first(req.headers.accept) ?? '').includes('text/html')

/**
 * The dev server's only init state. `middleware` must run before Vite's own middlewares (install
 * it inside `configureServer`, not from a returned post hook): it records each page's init under
 * the page's origin and, on an init-less HTML request, writes the remembered one into
 * `req.originalUrl` — which is what Vite passes to transformIndexHtml. `req.url` is left alone so
 * Vite's routing and SPA fallback see the request exactly as it came.
 */
export function createInitTracker() {
  const cache = new Map<string, string>()
  return {
    middleware(req: InitRequest, _res: unknown, next: () => void): void {
      if (acceptsHtml(req)) {
        const url = req.originalUrl ?? req.url
        if (url !== undefined) req.originalUrl = resolveInitUrl(url, refererOrigin(req.headers), cache)
      }
      next()
    },
  }
}
