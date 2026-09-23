/** Suspense fallback while a tab's chunk downloads — the same spinner and
 *  message shape as `<QueryBoundary>`'s "Running search…", so a tab arriving
 *  reads like a panel arriving rather than a new kind of wait. */
export function TabLoading() {
  return (
    <div className="qb-center" role="status">
      <span className="spinner" aria-hidden />
      <span className="qb-msg">Loading tab…</span>
    </div>
  )
}
