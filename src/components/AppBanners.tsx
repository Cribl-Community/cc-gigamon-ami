// The one place a page-level banner is allowed to appear.
//
// WHAT THIS REPLACES. Two banners had grown their own markup and their own CSS
// family — `.tour-nudge` (blue, in App.tsx under the tab bar) and `.intel-note`
// (amber, inside the Findings tab, between the intro and the KPI row). Nothing
// but the tint distinguished them, and each carried its own flex row, its own
// border, its own pair of buttons and its own rules in App.css. A third one
// would have grown a third. Both are now DESCRIPTIONS — severity, title, body,
// one action, one dismissal — rendered through Capra's `Alert`, which already
// owns the tint, the icon, the role, the live region and the close button.
//
// WHY DESCRIPTORS AND NOT COMPONENTS. Rendering `<TourNudgeBanner/>` and
// `<DatasetIntelBanner/>` as siblings would look simpler and would give up the
// one rule this slot exists to keep: the banner a reader must not miss is above
// the one they can ignore. Severity is a value each source computes for itself
// at render — the S4 migration banner is a warning while it runs and a danger
// when it fails — so it is a property of the SET, not of anybody's position in
// the markup. A collected list can be sorted; a tree of siblings cannot be.
//
// The first two sources are both info, so for two slices the sort did nothing.
// The third — a long-running search of the viewer's own, slice 1.8 — is a
// `warning`, and it is the one that proves the point: it goes above an offer of
// a guided tour no matter where its `useJobWatchdogBanner()` call happens to sit
// in the list below.
//
// INDEPENDENCE IS THE POINT, and it is the thing to preserve when adding a
// banner here. Every source answers for itself and answers `null` when it has
// nothing to say — including while it is still finding out. `collectBanners`
// drops the nulls; it never treats one source's silence as a reason to hold
// back another's. Concretely: the guided-tour nudge cannot be delayed by the
// dataset-intelligence probe, which is two network round trips (`aiEnabled`,
// then `getDatasetIntel`) and can take seconds or never answer at all.
//
// The two sources happen to SHARE one asynchronous gate today — both read their
// dismissal from the same per-user preferences document, one GET for the pair
// (cribl/prefs.ts) — so in practice their preferences resolve together. That is
// an accident of there being two of them, not a contract, and the S4/S5/S9
// banners this slot was built for arrive with gates of their own.
//
// NEVER STICKY, and mounted below the tab bar rather than above it: a banner
// that covers the tab bar is a banner that can stop someone leaving the page it
// is complaining about.

import type { ReactElement, ReactNode } from 'react'
import { Alert } from '@capra/core'
import { useTour } from '../app/TourContext'
import { useDatasetIntelBanner } from './DatasetIntelPrompt'
import { useJobWatchdogBanner } from './JobWatchdog'

/**
 * One page-level banner, as its source describes it.
 *
 * `appearance` is three of Capra's four. There is no `success`: a banner is
 * something the reader has to act on or dismiss, and "it worked" is a toast,
 * which says so and then takes itself away.
 */
export interface AppBanner {
  /** Stable across re-renders and unique in the slot — React's key, and the
   *  reason a banner that changes severity is not remounted from scratch. */
  id: string
  appearance: 'danger' | 'warning' | 'info'
  /** The sentence that makes the banner worth reading, in the accessible name. */
  title: string
  /** Inline content only: Capra renders it inside a `<span>`. */
  body: ReactNode
  /**
   * The one thing to do about it, as an element.
   *
   * Capra's `Alert` also accepts `{label, onClick}` and renders its own
   * `Button` from it, which is tempting and is not used here: this app draws
   * every button with its own classes, so a Capra Button in one banner would be
   * the only one in the app — the second visual language this slice exists to
   * remove. An element also lets the control be a `GatedControl`, which is what
   * an action Cribl may refuse has to be (slice 1.4).
   */
  action?: ReactElement
  /** Omitted when the banner cannot be dismissed. Capra hides it on the click;
   *  this is where the source records that, so it stays hidden next load. */
  onDismiss?: () => void
}

/** Most urgent first. The order is fixed rather than per-screen so that the
 *  banner a reader must not miss is never below one they can ignore. */
const SEVERITY: Record<AppBanner['appearance'], number> = { danger: 0, warning: 1, info: 2 }

/**
 * The sources' answers, in the order they are shown.
 *
 * Exported so the ordering can be tested without a DOM, a router or a KV store
 * — the rule this enforces is worth more than the arrangement of any one
 * banner. `sort` is stable (ES2019), so two banners of equal severity keep the
 * order their sources are listed in below.
 */
export function collectBanners(answers: Array<AppBanner | null>): AppBanner[] {
  const present = answers.filter((b): b is AppBanner => b !== null)
  return present.sort((a, b) => SEVERITY[a.appearance] - SEVERITY[b.appearance])
}

/**
 * The first-run guided-tour offer.
 *
 * `offerNudge` is already the three-state read done properly: TourContext turns
 * `usePref('tourSeen')` into a boolean that is only true on a definite "not
 * seen", so the nudge stays away while the store is still answering instead of
 * appearing and being snatched back from someone who dismissed it months ago.
 */
function useTourNudgeBanner(): AppBanner | null {
  const { offerNudge, persona, openPicker, markSeen } = useTour()
  if (!offerNudge || persona) return null
  return {
    id: 'tour-nudge',
    appearance: 'info',
    title: 'First time here?',
    body: 'Take a 5-minute guided tour tailored to your role — NetOps, Security, AI governance or Compliance.',
    action: <button type="button" className="btn" onClick={openPicker}>Choose a role</button>,
    onDismiss: markSeen,
  }
}

export function AppBanners() {
  // Every source is called on every render, unconditionally and in a fixed
  // order — they are hooks, and a source that stopped being called because an
  // earlier one had something to say would break the rules of hooks and lose
  // its own state at the same time.
  // The watchdog's is the first banner in this slot that is not `info`, so it is
  // also the first time the sort does anything: a long-running search of the
  // viewer's own goes above an offer of a guided tour, whatever order the
  // sources are listed in here.
  const banners = collectBanners([useTourNudgeBanner(), useDatasetIntelBanner(), useJobWatchdogBanner()])
  if (banners.length === 0) return null
  return (
    <div className="appbanners">
      {banners.map((b) => (
        <Alert
          key={b.id}
          layout="section"
          appearance={b.appearance}
          title={b.title}
          action={b.action}
          onDismiss={b.onDismiss}
        >
          {b.body}
        </Alert>
      ))}
    </div>
  )
}
