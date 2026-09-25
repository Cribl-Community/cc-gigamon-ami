// Route-level code splitting: how a tab becomes its own chunk, how its chunk is
// fetched before the click that needs it, and what the app says when the
// tab's module does not load.
//
// WHY. Every tab used to be in the one initial chunk (1,186 kB minified,
// measured 2026-09-23), so the landing tab paid to parse Guided Setup, Field
// Explorer and eleven others before it could paint. The landing tab stays
// EAGER (src/app/tabs.tsx): splitting it would put a chunk round trip in front
// of first paint, which is the opposite of the point.
//
// WHY A TAGGED ERROR, AND WHY IT DOES NOT SAY "DOWNLOAD". A failed dynamic
// import has no portable shape — Chrome says "Failed to fetch dynamically
// imported module", Firefox "error loading dynamically imported module",
// Safari "Importing a module script failed", and Vite's CSS preload helper
// throws its own. Matching on those strings would be a guess that rots.
// Wrapping the importer is exact about WHERE the failure happened — the import
// promise rejected — but not about WHY: the same rejection carries a module
// that threw while it evaluated (a TypeError at module scope, a TDZ read of a
// circular import) and, on the dev server, a transform error. A reload fixes
// the first kind and not the other two. So `ChunkLoadError` means "this tab's
// module did not load", `<ErrorBoundary>` says exactly that, and it shows the
// underlying cause beneath it rather than asserting a dropped connection it
// cannot know about.
//
// WHY RELOAD, AND ONLY ON A CLICK. `React.lazy` caches the rejected promise and
// the browser's module map caches the failed URL, so an in-place "Try again"
// would re-throw the same error. A page reload is the one thing that fetches
// the chunk again. It is offered as a button and never fired automatically —
// an automatic reload on a chunk that is genuinely missing (an app update that
// removed it, a proxy that refuses it) is an infinite reload loop.
//
// WHY PRELOAD. `BrowserRouter` wraps every navigation in `startTransition`, so
// on a first click to a lazy tab React keeps the OLD tab on screen until the
// chunk arrives — the Suspense fallback never shows. `preload()` starts that
// fetch on hover or focus of the tab link (src/App.tsx), and it is the same
// promise the lazy component awaits, so the click finds it already in flight
// or done. A failed preload is swallowed and forgotten, not cached: it may
// have been a blip, and the click that actually needs the tab gets its own
// attempt and its own error.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** A tab's module did not load. `cause` is whatever the import rejected with —
 *  a network failure, or an error the module threw while it evaluated. */
export class ChunkLoadError extends Error {
  override name = 'ChunkLoadError'
  constructor(tab: string, cause: unknown) {
    super(`The code for ${tab} did not load.`, { cause })
  }
}

/** A lazy tab, plus a way to start fetching its chunk before it renders. */
export type LazyTab = LazyExoticComponent<ComponentType> & {
  /** Start the import now. Never rejects; calling it again is free. */
  preload: () => Promise<void>
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
): LazyTab {
  let pending: Promise<ComponentType> | null = null
  const get = () => {
    pending ??= load().then(
      (mod) => mod[exportName],
      (e: unknown) => {
        pending = null
        throw new ChunkLoadError(exportName, e)
      },
    )
    return pending
  }
  const Tab = lazy(async () => ({ default: await get() })) as LazyTab
  Tab.preload = () => get().then(() => undefined, () => undefined)
  return Tab
}
