// The transport the cutover preflight runs on: GETs through the `npm run dev`
// proxy, and nothing else.
//
// scripts/cutover-preflight.mjs installs `readOnlyFetch(...)` as the global
// `fetch` before it imports src/cribl, so every read the app's own modules make
// (capi.ts builds `/capi<path>`) goes through here. It:
//   - refuses any method but GET, before anything is sent;
//   - refuses any path with a `/search/` segment — the preflight has no reason
//     to touch Search, and a job submit is the one call here that would bill;
//   - refuses any URL that is not `/capi/…` (nothing else may leave);
//   - rewrites `/capi/…` onto `base` (default http://localhost:5173/capi).
// A refusal throws before anything is sent. capi.ts does not catch it; a reader
// that catches (lake.ts, `pendingConfigPaths`) reports it as unreadable, never
// as absent, and one that does not fails the whole run (exit 2).
//
// src/cribl/cutoverPreflight.test.ts holds all of it against a fake transport.

export class PreflightRefusal extends Error {}

/** Why this request may not be sent, or null. `path` is the part after `/capi`. */
export function refusalOf(method, url) {
  const m = String(method || 'GET').toUpperCase()
  if (m !== 'GET') return `refused ${m} ${url}: the cutover preflight sends GETs only`
  if (typeof url !== 'string' || !url.startsWith('/capi/')) return `refused ${url}: only /capi/… paths may be read`
  const path = url.slice('/capi'.length).split('?')[0]
  if (/(^|\/)search(\/|$)/.test(path)) return `refused GET ${url}: the cutover preflight never touches Cribl Search`
  return null
}

/**
 * A `fetch` for the app's modules that only ever sends GETs to `base`.
 * `record` (optional) receives `{ method, url }` for every request actually sent.
 */
export function readOnlyFetch({ base, fetch, record }) {
  const root = String(base).replace(/\/$/, '')
  return async function guardedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    const method = init.method ?? (typeof input === 'object' && input?.method) ?? 'GET'
    const why = refusalOf(method, url)
    if (why) throw new PreflightRefusal(why)
    const target = `${root}${url.slice('/capi'.length)}`
    record?.({ method: 'GET', url: target })
    // No body, ever; only the signal is carried over.
    return fetch(target, { method: 'GET', signal: init.signal })
  }
}

/**
 * The Cribl origin the dev page carries (vite.config.ts injects
 * `window.__CRIBL_SEARCH_ORIGIN = "<origin>"` into the page it serves), or null.
 * How the runner learns the Leader's host without reading `.dev/cribl.json`.
 */
export function searchOriginFromDevPage(html) {
  const m = /window\.__CRIBL_SEARCH_ORIGIN\s*=\s*("(?:[^"\\]|\\.)*")/.exec(String(html ?? ''))
  if (!m) return null
  try {
    const v = JSON.parse(m[1])
    return typeof v === 'string' && /^https?:\/\//.test(v) ? v : null
  } catch {
    return null
  }
}
