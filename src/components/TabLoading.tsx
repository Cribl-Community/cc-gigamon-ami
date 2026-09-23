/** Suspense fallback while a tab's chunk downloads — the same spinner and
 *  message shape as `<QueryBoundary>`'s "Running search…", so a tab arriving
 *  reads like a panel arriving rather than a new kind of wait.
 *
 *  WHAT IT COVERS: a lazy tab rendered OUTSIDE a transition — a cold load or a
 *  deep link straight to that tab, where there is no previous tab to keep on
 *  screen. It does NOT cover a click in the tab bar: `BrowserRouter` wraps that
 *  navigation in `startTransition`, so React keeps the old tab up and this
 *  fallback never renders. That wait is covered by the tab bar's own pending
 *  indicator and by preloading the chunk on hover/focus (`TabBar` in
 *  src/App.tsx, `preload` in src/app/lazyTab.ts). */
export function TabLoading() {
  return (
    <div className="qb-center" role="status">
      <span className="spinner" aria-hidden />
      <span className="qb-msg">Loading tab…</span>
    </div>
  )
}
