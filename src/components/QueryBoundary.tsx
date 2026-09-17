// The four answers a panel can give about its own query, and the component that
// was going to be a fifth.
//
// WHAT THIS DISTINGUISHES. Running (nothing on screen yet) · failed, with a
// heading that names a known cause where there is one · succeeded and returned
// nothing · has data, optionally re-running over it. Failed and empty are
// already separate branches, with different words, a different colour and a
// different heading — "Search failed" over the reason, against a plain
// `emptyLabel`. That distinction is the whole of what this file exists to keep.
//
// `<Unavailable>` WAS SPECIFIED AND IS NOT BUILT. It was to be a wrapper over
// Capra's `EmptyState`, wiring `theme` from src/app/theme.ts. Reading the two
// together is what settled it:
//
//   • `EmptyState` distinguishes nothing. It is a layout — illustration, title,
//     description, an optional action — with no notion of why a region is
//     blank. Whatever tells unavailable from empty has to be the caller.
//   • This file is that caller, and it already does. So a wrapper here would
//     have changed the drawing of a state, not the set of states — a rename,
//     and one that swaps a compact in-panel message for an illustrated blank
//     slate at exactly the moment a panel is trying to keep its other panels
//     company.
//
// The screens it was specified FOR are whole-tab blank slates — a workspace the
// app cannot run against at all, a settings page for a feature this tenant does
// not have. Those are `EmptyState`'s size and shape, and none of them exists in
// the app yet. Building the wrapper before its first caller would have meant
// guessing the caller.
//
// THE PQC TILE IS NOT THAT CALLER EITHER, which is the test that decided it. It
// was offered as one: TLS Posture's "Classical KEX" tile, when the search behind
// it fails. A KPI tile is four to a row and about eighty pixels tall, and an
// `EmptyState` is an illustration with a heading — it does not fit, and would
// not be right if it did. What that tile needed was an em dash, a caption and a
// dropped colour claim; what its table rows needed was `<StatusPill>`; what its
// panel needed was a Capra `Alert`. Three sizes of "unavailable", none of them
// a blank slate. See src/tabs/TlsPosture.tsx.
//
// FOR WHOEVER BUILDS THE FIRST WHOLE-TAB ONE: `EmptyState`'s `theme` prop
// defaults to `'light'` and this app defaults to dark, so the illustration
// arrives wrong unless the theme is passed. That is the one thing the wrapper
// was really for, and it is one line at the call site until there are two.

import type { ReactNode } from 'react'
import { IS_INSTALLED } from '../cribl/config'

interface Props {
  /** `errorTitle` names a known cause (e.g. "Search stopped"); without it the heading is "Search failed". */
  state: { loading: boolean; error: string | null; errorTitle?: string | null; rows: readonly unknown[] }
  children: ReactNode
  /** Message when the query returns no rows. */
  emptyLabel?: string
  /** Compact spinner (for small panels). */
  compact?: boolean
}

/** Renders loading / error / empty states around a query's content. */
export function QueryBoundary({ state, children, emptyLabel = 'No results', compact }: Props) {
  if (state.loading && state.rows.length === 0) {
    return (
      <div className={`qb-center ${compact ? 'qb-compact' : ''}`}>
        <span className="spinner" aria-hidden />
        <span className="qb-msg">Running search…</span>
      </div>
    )
  }
  if (state.error) {
    // The dev-proxy hint only helps with an unexplained failure, not a known cause.
    const hint = !IS_INSTALLED && !state.errorTitle
      ? ' Dev preview needs the Vite proxy + a valid Cribl token (check the terminal).'
      : ''
    return (
      <div className={`qb-center qb-error ${compact ? 'qb-compact' : ''}`}>
        <span className="qb-error-title">{state.errorTitle ?? 'Search failed'}</span>
        <span className="qb-msg">{state.error}{hint}</span>
      </div>
    )
  }
  if (state.rows.length === 0) {
    return (
      <div className={`qb-center qb-empty ${compact ? 'qb-compact' : ''}`}>
        <span className="qb-msg">{emptyLabel}</span>
      </div>
    )
  }
  // Data is on screen. While a re-run is in flight (range change / refresh /
  // auto-refresh) keep the previous result visible and mark it as updating —
  // blanking to a spinner loses context and reads as a stall.
  //
  // The wrapper is rendered in BOTH states on purpose. Returning a bare
  // fragment when idle and a wrapped tree when loading changes the element
  // structure, which makes React unmount and remount every child on each
  // refresh — that discarded scroll anchors, guided-tour highlights and any
  // DOM state inside the panels. Same shape either way; only classes change.
  return (
    <div className={`qb-live ${state.loading ? 'qb-updating' : ''}`}>
      <div className="qb-refreshing-content" aria-busy={state.loading || undefined}>{children}</div>
      <div className="qb-refreshing-badge" aria-hidden={!state.loading}>
        <span className="spinner spinner-sm" aria-hidden />
        <span>Updating…</span>
      </div>
    </div>
  )
}
