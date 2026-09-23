// Where a panel's time goes, measured in a real browser. DEV ONLY.
//
// Phase 7's items were sized against a ~1.6 s admission stagger and a
// round-trip figure nobody had traced end to end. This records, per page load,
// every Cribl request by kind and every panel's start → data → paint, so the
// remaining latency can be split into "Cribl" and "this app" from evidence.
//
// OFF UNLESS ASKED FOR. Installed only when `import.meta.env.DEV` and the URL
// carries `?trace`, so a production build carries none of it (Vite drops the
// branch) and an ordinary dev session is untouched. `?trace` also turns React's
// StrictMode off (main.tsx): StrictMode mounts every effect twice in dev, which
// would submit, cancel and resubmit jobs the production app never does, and the
// trace would count them.
//
// READ FROM THE CONSOLE: `__gnoTrace.summary()`, or `__gnoTrace.reset()` before
// a measured action. Nothing here is sent anywhere.

export type RequestKind =
  | 'history'
  | 'artifact'
  | 'job-submit'
  | 'job-status'
  | 'job-results'
  | 'job-cancel'
  | 'field-summaries'
  | 'kv'
  | 'other'

export interface TracedRequest {
  kind: RequestKind
  /** Path only, never a query string's values beyond the path — no ids leave. */
  path: string
  start: number
  end: number | null
  status: number | null
  bytes: number | null
}

export interface PanelMarks {
  start: number
  data: number | null
  paint: number | null
  /** Where the rows came from, as useSearch reports it. */
  source: string | null
}

interface Trace {
  requests: TracedRequest[]
  panels: Map<string, PanelMarks>
}

let trace: Trace | null = null

/** True when tracing is on for this page. */
export function tracing(): boolean {
  return trace !== null
}

export function classify(url: string, method: string): RequestKind {
  const path = url.split('?')[0]
  if (/\/kvstore\//.test(path)) return 'kv'
  if (/\/search\/jobs$/.test(path)) return method === 'POST' ? 'job-submit' : 'history'
  if (/\/search\/jobs\/[^/]+\/cancel$/.test(path)) return 'job-cancel'
  if (/\/search\/jobs\/[^/]+\/status$/.test(path)) return 'job-status'
  if (/\/search\/jobs\/[^/]+\/field-summaries$/.test(path)) return 'field-summaries'
  // A scheduled run's id carries its saved search's id (`gno_…`); an app job's
  // does not. The first is an artifact read, the second the tail of a job.
  if (/\/search\/jobs\/gno_[^/]+\/results$/.test(path)) return 'artifact'
  if (/\/search\/jobs\/[^/]+\/results$/.test(path)) return 'job-results'
  return 'other'
}

/** Wrap `fetch` so every request is recorded. Call once, before first render. */
export function installTrace(win: Window & { __gnoTrace?: unknown } = window): void {
  if (trace !== null) return
  trace = { requests: [], panels: new Map() }
  const inner = win.fetch.bind(win)
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const rec: TracedRequest = {
      kind: classify(url, method),
      path: url.split('?')[0],
      start: performance.now(),
      end: null,
      status: null,
      bytes: null,
    }
    trace?.requests.push(rec)
    const res = await inner(input, init)
    rec.status = res.status
    // Timed to the last byte, which is what the app waits for: it reads text().
    res.clone().text().then(
      (t) => { rec.end = performance.now(); rec.bytes = t.length },
      () => { rec.end = performance.now() },
    )
    return res
  }
  win.__gnoTrace = { summary, reset, raw: () => trace }
}

/** A panel began loading. Keyed by the panel's query id, or its query text. */
export function markStart(panel: string): void {
  if (!trace) return
  trace.panels.set(panel, { start: performance.now(), data: null, paint: null, source: null })
}

/** A panel's rows arrived; paint is the next animation frame after the commit. */
export function markData(panel: string, source: string | null): void {
  const m = trace?.panels.get(panel)
  if (!m || m.data !== null) return
  m.data = performance.now()
  m.source = source
  // "Paint" is the next task after React commits the rows — a MessageChannel
  // tick, not requestAnimationFrame, which never fires in a background tab and
  // left every panel `pending` on the first trace. It bounds commit, not pixels.
  const ch = new MessageChannel()
  ch.port1.onmessage = () => { m.paint = performance.now() }
  ch.port2.postMessage(null)
}

export function reset(): void {
  if (!trace) return
  trace.requests.length = 0
  trace.panels.clear()
}

const ms = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round(b - a))

/** The page's numbers, shaped to paste into a table. */
export function summary(): unknown {
  if (!trace) return null
  const byKind: Record<string, { n: number; bytes: number; p50ms: number | null }> = {}
  for (const r of trace.requests) {
    const k = (byKind[r.kind] ??= { n: 0, bytes: 0, p50ms: null })
    k.n++
    k.bytes += r.bytes ?? 0
  }
  for (const kind of Object.keys(byKind)) {
    const d = trace.requests.filter((r) => r.kind === kind && r.end !== null).map((r) => (r.end as number) - r.start).sort((a, b) => a - b)
    byKind[kind].p50ms = d.length ? Math.round(d[Math.floor(d.length / 2)]) : null
  }
  const panels = [...trace.panels.entries()].map(([panel, m]) => ({
    panel,
    source: m.source,
    startMs: Math.round(m.start),
    toDataMs: ms(m.start, m.data),
    toPaintMs: ms(m.start, m.paint),
  }))
  const paints = panels.map((p) => (p.toPaintMs === null ? null : p.startMs + p.toPaintMs)).filter((x): x is number => x !== null)
  const timeline = [...trace.requests]
    .sort((a, b) => a.start - b.start)
    .map((r) => ({ kind: r.kind, startMs: Math.round(r.start), durMs: ms(r.start, r.end), kB: r.bytes === null ? null : Math.round(r.bytes / 1024) }))
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  return {
    // Page milestones, ms from navigation start.
    page: nav ? { domInteractive: Math.round(nav.domInteractive), domContentLoaded: Math.round(nav.domContentLoadedEventEnd) } : null,
    requests: byKind,
    timeline,
    panels,
    lastPaintMs: paints.length ? Math.max(...paints) : null,
    pending: panels.filter((p) => p.toPaintMs === null).map((p) => p.panel),
  }
}
