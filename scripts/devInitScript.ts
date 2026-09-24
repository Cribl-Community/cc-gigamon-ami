// DEV-ONLY: which Cribl bridge script `npm run dev` injects into index.html.
//
// The Cribl UI loads the dev server as `/?init=https://<workspace>/app-ui/__local__/init.js?…`,
// and vite.config.ts injects that URL as a <script src>. Vite also renders index.html for requests
// that carry no query at all (its own internal index requests), and those still need the bridge,
// so the last init seen is remembered for them.
//
// This used to be `cached || requested` — the FIRST workspace's init won forever, so a second
// workspace's Live Preview loaded the first one's bridge (observed 2026-09-24: a reload loop).
// The rule now:
//   - a request that carries an init gets exactly that init, and it becomes the remembered one;
//   - a request that carries an init we refuse gets NO bridge — never the remembered one, which
//     may be another workspace's;
//   - only a request with no init at all falls back to the remembered (most recent) one.
//
// Pure, and free of Node types, so tsconfig.node.json (vite.config.ts) and the vitest project can
// both import it without either reaching the app project.

export type InitDecision = {
  /** The script URL to inject, or null to inject none. */
  src: string | null
  /** What to remember for the next request that carries no init. */
  cache: string | null
}

/**
 * Normalises an init URL for use as a script src, or null if it is not an absolute http(s) URL.
 * The WHATWG serialisation percent-encodes `"`, `<`, `>`, whitespace (and `'` in the query), so
 * the value cannot leave a quoted attribute even before Vite's own attribute escaping (escape-html
 * in serializeAttrs, vite 8.1.5) turns `&` into `&amp;`.
 */
export function safeInitSrc(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  return u.href
}

export function decideInitScript(originalUrl: string | undefined, cached: string | null): InitDecision {
  const requested = new URL(originalUrl ?? '/', 'https://localhost').searchParams.get('init')
  // `?init=` with nothing after it is treated as no init, as the old `||` did.
  if (!requested) return { src: cached, cache: cached }
  const src = safeInitSrc(requested)
  if (src === null) return { src: null, cache: cached }
  return { src, cache: src }
}
