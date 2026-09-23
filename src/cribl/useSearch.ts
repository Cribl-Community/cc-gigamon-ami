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
// ── THE RANGE PICKER DOES NOT REACH A SNAPSHOT-SERVED PANEL ─────────────────
// A `$vt_results` read ignores the time picker entirely: the rows are whatever
// the named run stored, over whatever window that run read. So a panel the
// schedule is actually answering is treated exactly like one that pins its own
// `earliest` — it re-runs on an explicit refresh and never on a range change or
// an auto-refresh tick. Leaving the range in the dependency key would re-submit
// a job on every pick to receive the identical stored rows, and would make the
// live FALLBACK mean something different from the accelerated read it replaced.
//
// That is also why such a hook with no `earliest` of its own borrows the
// manifest entry's window rather than the page's: whichever path answers, the
// number has to mean the same thing.
//
// IN LIVE MODE IT IS AN ORDINARY PANEL AGAIN. This used to key on "does this
// panel have a schedule" rather than "is the schedule answering it", so pressing
// Live gave a live query over the schedule's window that then ignored the picker
// and every tick. See `snapshotServed` below.
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
import { MEASURED } from './accel/estimate'
import { readAccelRows, type AccelOutcome, type AccelSource } from './accel/read'
import { useAccelModeHydrated } from './accel/mode'
import { useSelectedSnapshot } from './accel/selection'
import { forgetRunHistory } from './accel/status'
import { markData, markStart } from './devTrace'
import { useDataMode } from './dataMode'

// `useAccelEnabled` was this module's export for the whole of Phase 2 and the
// tabs import it from here. Same name, same boolean — it now reads
// cribl/dataMode.ts, so it is reactive.
export { useAccelEnabled, type AccelMode } from './accel/mode'

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
  /** When a past moment was picked and this panel has no run from it: the
   *  nearest stored run it does have, for the caption to offer.
   *
   *  Optional so the test fixtures that build a state by hand do not each have
   *  to carry a field about a feature they are not exercising; `useSearch`
   *  itself always answers with it. */
  nearestAt?: number | null
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
   * False sends the panel straight to its live query — whatever per-panel
   * control a tab offers, ANDed with the global mode this hook reads for itself
   * (accel/mode.ts). It costs whatever the live query costs; on the Lake total
   * that is the 9,297.7 CPU-s this phase exists to stop paying 15–24 times a
   * day, and it is why the control that flips it carries a price.
   */
  accelEnabled?: boolean
  /**
   * Which of that entry's served panels this hook is — the `queryId` in the
   * manifest.
   *
   * An hourly entry is ONE scan answering several panels, and each panel's rows
   * are cut out of the shared result by a `tail` the manifest holds. The tail
   * lives there and not here on purpose: it is inside the entry's display
   * digest, so an operator can tell whether the app is still reading the search
   * the way it says it is. A tab naming its own tail would put that string
   * outside everything that checks it.
   *
   * REQUIRED ON A MULTI-PANEL ENTRY. Left out, the hook runs LIVE rather than
   * reading the shared row whole: the un-tailed row carries every other panel's
   * columns too, and a panel reading a column it did not ask for is the exact
   * shape of a plausible wrong number. Falling back costs a scan and says so in
   * the panel's own caption; guessing costs nothing and is silent.
   */
  accelPanel?: string
}

/** What one read of either kind answers with, before it becomes panel state. */
interface PanelRead {
  data: Row[]
  source: AccelSource
  outcome: AccelOutcome | null
  at: number | null
  stale: boolean
  note: string | null
  nearestAt: number | null
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
  const { enabled = true, deferred = false, deps = [], limit, earliest, accelEnabled = true, accelPanel } = opts
  const text = typeof query === 'string' ? query : query.query
  const accel = (typeof query === 'string' ? undefined : query.accel) ?? opts.accel ?? null
  const { range, refreshNonce, manualRefreshNonce, autoSeconds } = useDashboard()
  const mode = useDataMode()
  const modeKnown = useAccelModeHydrated()
  // WHICH PAST STATE THIS PANEL IS ANSWERING FOR, or null for the newest.
  //
  // Only in Snapshot mode, and only on a panel a schedule serves. In Live mode
  // the header's time control IS the range picker and there is no moment to
  // honour; on a panel with no schedule there is no stored past to read, and
  // handing it a moment would mean running its live query and labelling the
  // answer with a time it does not describe.
  const moment = useSelectedSnapshot()

  // WHETHER THE SCHEDULE IS ACTUALLY GOING TO ANSWER THIS PANEL, which is a
  // different question from "does this panel have a schedule" — and confusing
  // the two is the bug this replaces. `pinned` used to key on `accel !== null`,
  // so a panel switched to Live still ignored the range picker and every
  // auto-refresh tick: the reader pressed Live and got a live query over the
  // SCHEDULE's window that then refused to follow anything they did next.
  //
  // In Live mode an accelerated panel is an ordinary live panel. The one thing
  // that does not change is a window the panel pinned for itself: Data Flow's
  // Lake tile passes `earliest: '-30d'` because the tile MEANS thirty days, and
  // handing it the picker's `-15m` in Live mode would change the number rather
  // than its freshness.
  // The tail that cuts this panel's columns out of a shared body, and whether
  // the entry can answer this hook at all. See `accelPanel`.
  const served = accel !== null ? accelEntry(accel).panels : null
  const servedPanel = served ? (accelPanel !== undefined ? served.find((p) => p.queryId === accelPanel) : served.length === 1 ? served[0] : undefined) : undefined
  const addressable = accel === null || servedPanel !== undefined
  const tail = servedPanel?.tail

  const snapshotServed = accel !== null && accelEnabled && addressable && mode === 'snapshot'
  // A MOMENT OVERRIDES THE PER-PANEL LIVE SWITCH, and read.ts says why in full:
  // there is no live answer to a question about 04:20, so "run this one now"
  // has nothing to mean. `snapshotServed` deliberately stays false in that case,
  // which keeps the panel pinned and out of the auto-refresh ticks — a panel
  // showing a past state must not re-run on a timer.
  const asOf = accel !== null && addressable && mode === 'snapshot' && moment !== null ? moment : undefined
  const atMoment = asOf !== undefined
  const pinned = earliest !== undefined || snapshotServed || atMoment
  // A snapshot-served hook with no window of its own takes the scheduled run's,
  // so the live fallback reads the same window the schedule does — whichever
  // path answers, the number means the same thing.
  const effectiveEarliest = earliest ?? (snapshotServed || atMoment ? accelEntry(accel as AccelId).earliest : range.earliest)
  const refreshKey = pinned ? manualRefreshNonce : refreshNonce

  // THE DOUBLE SUBMIT, AND WHY IT IS CURED BY WAITING RATHER THAN BY HYDRATING
  // EARLIER. The old `useAccelEnabled` started `true` and could only fall to
  // `false` once the KV round trip landed, so a panel in Live mode fired a
  // stored read and then re-fired live when its own preference arrived — two
  // jobs on every mount, for every viewer who had chosen Live.
  //
  // Hydrating before the first submit sounds cleaner and is not available: the
  // preference read is asynchronous however early it starts, so a panel mounting
  // in the same tick still has to decide something. Waiting is the honest
  // version of the same idea, and the machinery already exists — a panel whose
  // mode is not yet known reports `loading`, exactly as a deferred one does, so
  // <QueryBoundary> shows a spinner rather than a number from the wrong source.
  //
  // ONLY PANELS THE MODE CAN CHANGE WAIT. For a hook with no schedule the mode
  // changes neither the query, the window, nor the pin, so making it wait would
  // put one KV round trip in front of all thirty-seven of them for nothing —
  // against an app whose whole brief is to feel fast. accel/mode.ts caps the
  // wait at HYDRATE_DEADLINE_MS for the two that do.
  const waitingForMode = accel !== null && !modeKnown
  // A panel that has not run yet still holds its cost slot: deferral is about
  // WHEN a query is submitted, not whether. The auto-refresh cost label answers
  // "what does a refresh of this tab cost", and every deferred panel will have
  // run by the first tick.
  const active = enabled && !deferred && !waitingForMode
  const costSlot = useCostSlot({
    autoRefresh: enabled && !pinned,
    willRun: enabled,
    // What this panel's own query costs run live, for the session in which it
    // has only ever been served from its schedule and so has measured nothing
    // itself. Measured runs, not the regressor — see accel/estimate.ts.
    liveHint: accel !== null ? MEASURED[accel].liveRunCpuSeconds : null,
  })
  // Local nonce for per-panel refresh — bumping it re-runs only this hook.
  const [localNonce, setLocalNonce] = useState(0)
  // A per-panel refresh is a human asking too — see DashboardContext.refresh.
  const refetch = useCallback(() => {
    forgetRunHistory()
    setLocalNonce((n) => n + 1)
  }, [])
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
    nearestAt: null,
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
      // Deferred, or waiting on the mode, is not finished: keep reporting
      // `loading` so the panel shows a spinner rather than "No results" for a
      // query nobody has asked yet.
      setState((s) => ({ ...s, loading: enabled && (deferred || waitingForMode) }))
      return
    }
    const controller = new AbortController()
    const myReq = ++reqId.current
    setState((s) => ({ ...s, loading: true, error: null, errorTitle: null }))
    const t0 = performance.now()
    // Dev-only page trace (cribl/devTrace.ts); a no-op unless `?trace`.
    const traceKey = accelPanel ?? servedPanel?.queryId ?? text.slice(0, 80)
    markStart(traceKey)

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
        ? readAccelRows(accel, { live, enabled: snapshotServed, asOf, tail, limit, signal: controller.signal, costSlot })
        : live().then((rows) => ({ data: rows, source: 'live' as const, outcome: null, at: null, stale: false, note: null, nearestAt: null }))

    read
      .then((res) => {
        if (myReq !== reqId.current) return
        markData(traceKey, res.source)
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
          nearestAt: res.nearestAt,
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
    // `snapshotServed` rather than `accelEnabled`: it already folds in the global
    // mode, so a press of Snapshot / Live re-runs exactly the panels whose SOURCE
    // it changed, and none of the others.
    //
    // THE SUPPRESSION BELOW HAS TO BE THE LINE IMMEDIATELY ABOVE THE ARRAY.
    // `eslint-disable-next-line` covers exactly one line, and prose written
    // between it and the `}, [...]` silently moves the array out from under it —
    // which is how this effect started reporting two warnings again after the
    // snapshot work added the explanation above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, accel, snapshotServed, asOf, tail, waitingForMode, enabled, deferred, effectiveEarliest, refreshKey, localNonce, limit, ...deps])

  return { ...state, refetch }
}

// `useAccelEnabled` used to live here as `useState(true)` plus a one-way mount
// effect. It is now accel/mode.ts's reactive store and is re-exported at the top
// of this file under the same name.
