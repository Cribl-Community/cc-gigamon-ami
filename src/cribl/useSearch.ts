// The hook every panel's query goes through, and the second way it can now be
// answered.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT PHASE 2 ADDED HERE. A panel may name a scheduled search (`accel`) beside
// its query. When it does, the hook asks accel/read.ts for that schedule's stored
// result instead of submitting the query — 0.2 billable CPU-s against 9,297.7 for
// Data Flow's 30-day total — and falls back to the live query whenever the stored
// one is missing, unfinished, failed or undatable. The fallback is NOT an error
// path: on a fresh install nothing has run yet, and the panel is simply doing
// what it always did, at the price it always cost.
//
// THE NUMBER DOES NOT CHANGE, ONLY WHEN IT WAS COMPUTED. The scheduled search
// runs the same string the panel's ⓘ shows (accel/manifest.ts imports it from
// src/queries rather than restating it), so the ⓘ's claim about provenance stays
// true. What the panel now owes the reader is the TIME: `at` and `stale` come
// back on every schedule-sourced read, and a panel that renders one of those
// numbers without rendering its date has broken the only safety argument this
// phase has. See <PanelInfo computed={…}> for the words.
//
// ── THE RANGE PICKER DOES NOT REACH AN ACCELERATED PANEL ────────────────────
// A `$vt_results` read ignores the time picker entirely: the rows are whatever
// the named run stored, over whatever window that run read. So an accelerated
// hook is treated exactly like one that pins its own `earliest` — it re-runs on
// an explicit refresh and never on a range change or an auto-refresh tick.
// Leaving the range in the dependency key would re-submit a job on every pick to
// receive the identical stored rows, and would make the live FALLBACK mean
// something different from the accelerated read it replaced.
//
// That is also why an accelerated hook with no `earliest` of its own borrows the
// manifest entry's window rather than the page's: whichever path answers, the
// number has to mean the same thing.
//
// ── TWO THINGS THAT CHANGED FOR EVERY PANEL, ACCELERATED OR NOT ─────────────
// WHEN A QUERY IS SUBMITTED. Concurrent jobs from one user are admitted ~1.6 s
// apart, so a tab firing six of them on mount does not START its sixth for
// ~8 s — a cost no per-query speed-up can touch. `deferred` lets a panel below
// the fold wait until the reader is near it (components/nearViewport.ts), which
// takes it out of the opening queue entirely. A deferred hook reports `loading`,
// never an empty result: see the option's comment.
//
// WHETHER CRIBL MAY ANSWER FROM A RESULT IT ALREADY HAS. Every submit from this
// hook carries `set allow_previous_results` — measured 30.92 s → 0.95 s and
// zero billed on a repeat of the same query at the same relative range (A-SP21)
// — EXCEPT when the viewer asked for fresh data. The two ways they ask are the
// page's Refresh and a panel's own, and there is a third case in the effect: an
// auto-refresh cadence faster than the reuse window, where reuse would re-serve
// the answer the previous tick produced.
//
// ── WHY THE TWO CALL SITES PASS A STRING, NOT A PanelQuery ──────────────────
// `useSearch` takes `string | PanelQuery` because the plan asked for it and
// because an accelerated source is a property of the panel, not of its options.
// Both of today's accelerated call sites still pass the query as a string and the
// id in `opts.accel`, and that is deliberate: scripts/extract-queries.mjs reads
// argument 0 of every `useSearch(…)` in src/**/*.tsx and REQUIRES it to resolve
// to a query string — an object literal there aborts the extraction and takes
// display-freeze.test.ts with it. The string form keeps the ⓘ's provenance claim
// resolvable from source text, which is the gate's whole job. Prefer it.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { runSearch, REUSE_WINDOW_SECONDS, SearchTimeLimitError, type Row } from './search'
import { useCostSlot } from './jobCost'
import { useDashboard } from '../app/DashboardContext'
import { accelEntry, type AccelId } from './accel/manifest'
import { readAccelRows, type AccelOutcome, type AccelSource } from './accel/read'
import { loadAccelPrefs } from './accel/store'

/** A panel's query together with the scheduled search that may serve it. */
export interface PanelQuery {
  /** The query text: what the ⓘ shows, and what runs when nothing else can. */
  readonly query: string
  /** The scheduled search whose stored result answers for this query. */
  readonly accel?: AccelId
}

export interface UseSearchState {
  rows: Row[]
  totalEventCount: number
  loading: boolean
  error: string | null
  /** Heading for the error when its cause is known (a time-limit stop), else null. */
  errorTitle: string | null
  /** Milliseconds the last successful query took. */
  elapsedMs: number | null
  /** Re-run just this query (per-panel refresh, no global page refresh). */
  refetch: () => void
  /** Where these rows came from. `live` for every unaccelerated panel. */
  source: AccelSource
  /** Why the accelerated read ended up where it did; null when nothing was
   *  accelerated, so "this panel never had a schedule" and "its schedule has
   *  never run" cannot be confused for each other. */
  outcome: AccelOutcome | null
  /** Epoch ms the answering run finished. **A panel rendering a number with an
   *  `at` must put that time on screen.** Null on every live read. */
  at: number | null
  /** The stored result is older than its schedule promises. Still shown, and
   *  still dated — falling back to live here would quietly reinstate the
   *  expensive query at the moment the schedule breaks. */
  stale: boolean
  /** One sentence a panel may render about the read. Never Cribl's words:
   *  accel/read.ts writes these, an API response never reaches one. */
  note: string | null
}

export interface UseSearchOptions {
  /** Skip execution (e.g. waiting on a required parameter). */
  enabled?: boolean
  /**
   * Hold this query back until the panel is worth running — set by
   * `useNearViewport()` for a panel below the fold.
   *
   * SEPARATE FROM `enabled`, and the difference is what the reader is told.
   * `enabled: false` means the query cannot be asked (nothing is selected), and
   * the panel correctly reports no rows; `deferred` means it has not been asked
   * YET, so the hook keeps reporting `loading` and <QueryBoundary> keeps its
   * spinner. Folding the two together would put "No results" under a panel
   * whose query is about to run, which is a wrong answer rather than a missing
   * one.
   *
   * WHY IT EXISTS AT ALL: concurrent jobs from one user are admitted ~1.6 s
   * apart, so the sixth query a tab fires on mount does not BEGIN for ~8 s. No
   * amount of per-query speed touches that; firing fewer at once is the only
   * lever, and it is worth more than anything else in this file.
   */
  deferred?: boolean
  /** Extra dependencies that should re-trigger the query. */
  deps?: unknown[]
  limit?: number
  /** Pin the query to its own earliest bound instead of the global time range. */
  earliest?: string
  /** Serve this panel from that scheduled search's stored result when it can. */
  accel?: AccelId
  /**
   * False sends the panel straight to its live query — the per-viewer escape
   * hatch (`useAccelEnabled`), and whatever per-panel control a tab offers.
   * It costs whatever the live query costs; on the Lake total that is the
   * 9,297.7 CPU-s this phase exists to stop paying 15–24 times a day.
   */
  accelEnabled?: boolean
}

/** What one read of either kind answers with, before it becomes panel state. */
interface PanelRead {
  data: Row[]
  source: AccelSource
  outcome: AccelOutcome | null
  at: number | null
  stale: boolean
  note: string | null
}

/**
 * Run a Cribl Search query, re-running when the query text, the global time
 * range, a refresh, or any provided deps change.
 *
 * A query pinned to its own `earliest` — or served by a scheduled search —
 * ignores the global range and auto-refresh ticks; only an explicit refresh
 * re-runs it. Otherwise Data Flow's 30-day total — the most expensive query in
 * the app — re-ran on every range change and every tick without its window
 * changing.
 */
export function useSearch(query: string | PanelQuery, opts: UseSearchOptions = {}): UseSearchState {
  const { enabled = true, deferred = false, deps = [], limit, earliest, accelEnabled = true } = opts
  const text = typeof query === 'string' ? query : query.query
  const accel = (typeof query === 'string' ? undefined : query.accel) ?? opts.accel ?? null
  const { range, refreshNonce, manualRefreshNonce, autoSeconds } = useDashboard()
  const pinned = earliest !== undefined || accel !== null
  // A panel that has not run yet still holds its cost slot: deferral is about
  // WHEN a query is submitted, not whether. The auto-refresh cost label answers
  // "what does a refresh of this tab cost", and every deferred panel will have
  // run by the first tick.
  const active = enabled && !deferred
  // An accelerated hook with no window of its own takes the scheduled run's, so
  // the live fallback reads the same window the schedule does.
  const effectiveEarliest = earliest ?? (accel !== null ? accelEntry(accel).earliest : range.earliest)
  const refreshKey = pinned ? manualRefreshNonce : refreshNonce
  const costSlot = useCostSlot(enabled && !pinned)
  // Local nonce for per-panel refresh — bumping it re-runs only this hook.
  const [localNonce, setLocalNonce] = useState(0)
  const refetch = useCallback(() => setLocalNonce((n) => n + 1), [])
  const [state, setState] = useState<Omit<UseSearchState, 'refetch'>>({
    rows: [],
    totalEventCount: 0,
    loading: enabled,
    error: null,
    errorTitle: null,
    elapsedMs: null,
    source: 'live',
    outcome: null,
    at: null,
    stale: false,
    note: null,
  })
  const reqId = useRef(0)

  // Whether THIS run of the effect was asked for by a person.
  //
  // Refresh — the page button and a panel's own — is the one control that means
  // "I do not want the number you already have", so it must not be answered out
  // of Cribl's result reuse (REUSE_WINDOW below). Both nonces are summed because
  // either one rising is the same request; the ref carries the value across
  // effect runs, so a range change or an auto tick, which move neither nonce,
  // stays eligible for reuse.
  const explicitKey = manualRefreshNonce + localNonce
  const lastExplicit = useRef(explicitKey)
  const lastTick = useRef(refreshNonce)

  useEffect(() => {
    const explicit = explicitKey !== lastExplicit.current
    const ticked = refreshNonce !== lastTick.current && !explicit
    lastExplicit.current = explicitKey
    lastTick.current = refreshNonce
    // Whether Cribl may answer this out of a result it already has — measured
    // 30.92 s → 0.95 s and zero billed on a repeat of the same query at the same
    // relative range (A-SP21). Two things take it away:
    //   * an explicit refresh, above: the one control that means "not that one".
    //   * an auto-refresh cadence faster than the reuse window. A tick every
    //     minute answered from a two-minute-old result is a refresh that is
    //     GUARANTEED to show the same number, and the header would date it
    //     "updated 0s ago" while doing it. A viewer who set a cadence has said
    //     how old they will accept, and it is shorter than this.
    // A range change, a remount and the first paint of a tab keep it, which is
    // where the whole win is: opening the app, and switching away and back.
    const reuse = !explicit && !(ticked && autoSeconds > 0 && autoSeconds < REUSE_WINDOW_SECONDS)
    if (!active) {
      // Deferred is not finished: keep reporting `loading` so the panel shows a
      // spinner rather than "No results" for a query nobody has asked yet.
      setState((s) => ({ ...s, loading: enabled && deferred }))
      return
    }
    const controller = new AbortController()
    const myReq = ++reqId.current
    setState((s) => ({ ...s, loading: true, error: null, errorTitle: null }))
    const t0 = performance.now()

    // The live query, written once so the accelerated path's fallback is the
    // same request, over the same window, billed to the same cost slot, as the
    // unaccelerated path. `liveTotal` is captured here because a stored read
    // answers with rows and nothing else — `$vt_results` does not carry the
    // original job's totalEventCount, so there is none to report unless the
    // live query is what ran.
    let liveTotal: number | null = null
    const live = async (): Promise<Row[]> => {
      const res = await runSearch(text, { earliest: effectiveEarliest, limit, signal: controller.signal, costSlot, reuse })
      liveTotal = res.totalEventCount
      return res.rows
    }

    // A panel with a schedule goes through accel/read.ts even when the viewer
    // has switched acceleration off, so that "off" comes back as an outcome with
    // its own sentence. A hook with no schedule at all answers `outcome: null`:
    // "this panel never had one" and "its schedule has never run" are different
    // states and must not be renderable as the same words.
    const read: Promise<PanelRead> =
      accel !== null
        ? readAccelRows(accel, { live, enabled: accelEnabled, limit, signal: controller.signal, costSlot })
        : live().then((rows) => ({ data: rows, source: 'live' as const, outcome: null, at: null, stale: false, note: null }))

    read
      .then((res) => {
        if (myReq !== reqId.current) return
        setState({
          rows: res.data,
          totalEventCount: liveTotal ?? res.data.length,
          loading: false,
          error: null,
          errorTitle: null,
          elapsedMs: Math.round(performance.now() - t0),
          source: res.source,
          outcome: res.outcome,
          at: res.at,
          stale: res.stale,
          note: res.note,
        })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || myReq !== reqId.current) return
        setState((s) => ({
          ...s,
          loading: false,
          error: (err as Error).message,
          errorTitle: err instanceof SearchTimeLimitError ? 'Search stopped' : null,
        }))
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, accel, accelEnabled, enabled, deferred, effectiveEarliest, refreshKey, localNonce, limit, ...deps])

  return { ...state, refetch }
}

/**
 * Whether this viewer wants accelerated reads at all.
 *
 * Reads the per-viewer preference once per mount (`accel/prefs/<userId>`), and
 * can only ever answer false — it starts true and stays true unless the stored
 * preference says otherwise. That asymmetry is deliberate: while the preference
 * is in flight the panel does the CHEAP thing. A viewer who has turned
 * `liveReads` on therefore pays for one 0.2 CPU-s stored read before their live
 * query runs, which is the right way round; the opposite default would make
 * every panel in the app wait on a KV round trip to find out that nothing was
 * stored, and would run the expensive query on a store that simply failed to
 * answer.
 *
 * It is a read, never a write, so it is allowed on mount (AGENTS.md).
 */
export function useAccelEnabled(): boolean {
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    let alive = true
    void loadAccelPrefs().then((prefs) => {
      if (alive && prefs.liveReads) setEnabled(false)
    })
    return () => {
      alive = false
    }
  }, [])
  return enabled
}
