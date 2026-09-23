// Route-level code splitting: how a tab becomes its own chunk, and what the
// app says when that chunk does not arrive.
//
// WHY. Every tab used to be in the one initial chunk (1,186 kB minified,
// measured 2026-09-23), so the landing tab paid to parse Guided Setup, Field
// Explorer and eleven others before it could paint. The landing tab stays
// EAGER (src/app/tabs.tsx): splitting it would put a chunk round trip in front
// of first paint, which is the opposite of the point.
//
// WHY A TAGGED ERROR. A failed dynamic import has no portable shape — Chrome
// says "Failed to fetch dynamically imported module", Firefox "error loading
// dynamically imported module", Safari "Importing a module script failed", and
// Vite's CSS preload helper throws its own. Matching on those strings would be
// a guess that rots. Wrapping the importer is exact: anything the import
// promise rejects with IS a chunk that did not load, so it is re-thrown as
// `ChunkLoadError` and `<ErrorBoundary>` tells it apart by class.
//
// WHY RELOAD, AND ONLY ON A CLICK. `React.lazy` caches the rejected promise and
// the browser's module map caches the failed URL, so an in-place "Try again"
// would re-throw the same error. A page reload is the one thing that fetches
// the chunk again. It is offered as a button and never fired automatically —
// an automatic reload on a chunk that is genuinely missing (an app update that
// removed it, a proxy that refuses it) is an infinite reload loop.

import { lazy, type ComponentType } from 'react'

/** A tab's code did not download. `cause` is whatever the import rejected with. */
export class ChunkLoadError extends Error {
  override name = 'ChunkLoadError'
  constructor(tab: string, cause: unknown) {
    super(`The code for ${tab} did not load.`, { cause })
  }
}

/**
 * `React.lazy` over a module with a NAMED export — the tabs export by name, and
 * tests and the query extractor import them that way, so the tab files do not
 * change. Keep the `import('./tabs/X')` literal at the call site: that literal
 * is what Vite splits on.
 */
export function lazyTab<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  exportName: K,
) {
  return lazy(async () => {
    let mod: Record<K, ComponentType>
    try {
      mod = await load()
    } catch (e) {
      throw new ChunkLoadError(exportName, e)
    }
    return { default: mod[exportName] }
  })
}
