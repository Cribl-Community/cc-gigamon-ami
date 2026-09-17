// The one status label in the app, and the measurement that decided how it looks.
//
// WHAT IT REPLACES. Three families of near-identical CSS did the same job: the
// Guided Setup resource rows (`.gs-pill` + `.gs-ok|missing|unknown|err|skip`, 6
// selectors), the AMI coverage badges (`.cov-badge` + 3) and the Findings
// severity tags (`.find-sev` + 4). Fifteen selectors, three paddings, three font
// sizes, two letter-spacings and two completely different visual treatments
// (`.gs-pill` outlined, the other two tinted) — for one idea: a word that says
// what state a thing is in. They are gone; this is what draws all of them.
//
// THE REST OF THE COUNT, because it is the argument and not just these three.
// The stylesheet this slice opened carried 13 pill-shaped label families over 44
// selectors — `.pill*` (9), `.pqc-sens*` (7), `.gs-pill*` (6), `.find-sev*` (5),
// `.cov-badge*` (4), `.env-chip*` (3), `.prov*` (3), `.find-ai` (2),
// `.tour-look-tag`, `.pqc-count`, `.stub-badge`, `.version-chip`,
// `.qb-refreshing-badge` — and every one of them is one of exactly THREE
// treatments: a solid fill with contrast ink, a subtle tint with same-hue ink,
// or a transparent outline. Thirteen names for three ideas is what a second
// visual language looks like while it is forming. This retires three of them.
// `.env-chip` and `.title-preview` were in this slice's brief and are NOT
// retired — they are still declared in App.css and still used in App.tsx, and
// `<Unavailable>` was not built at all. Saying so here rather than leaving the
// brief to imply otherwise: the next person reads this file, not the plan. Ten
// families remain, and each one converted should come here rather than growing
// a fourteenth.
//
// WHY IT IS NOT `variant="bold"`, WHICH IS WHAT CAPRA DEFAULTS TO AND WHAT THE
// UX SPEC ASKS FOR. A bold Pill paints `color.foreground.<kind>.contrast` on
// `color.background.<kind>.solid.default`, and Capra draws a Pill at 12px normal
// weight — nowhere near the 18.66px-bold / 24px that would let WCAG's 3:1
// large-text threshold apply, so it owes 4.5:1. Measured off the shipped token
// values, in both themes:
//
//     bold info      3.26:1      bold success   3.16:1      bold danger  3.91:1
//
// Three of the five appearances fail AA, identically in light and dark, because
// the pairing is a fixed white-on-solid in both. So bold is not available to us
// as a uniform treatment, and a component that offered it would be offering a
// trap. `muted` — the spec's other variant — is closer but does not survive
// either: its tint darkens the light panel just enough to cost the margin.
//
//     muted info (light)  4.47:1      muted warning (light)  4.46:1
//
// Both under 4.5, by 0.03 and 0.04. That is Capra's own subtle-background
// pairing, not something this app assembled.
//
// WHAT IT IS. `variant="outline"`: no fill, a faint border, and
// `color.foreground.<kind>.default` drawn straight onto the panel. Removing the
// tint is what buys the margin back — the same ink measures 4.71 (info) and 4.64
// (warning) with nothing under it — and every appearance clears 4.5:1 in both
// themes, worst case 4.64. src/app/contrast.test.ts computes all twelve of those
// (six pairings × two themes) from the token values and fails if one moves. It
// also asserts that bold and muted still FAIL, so nobody restores them on the
// strength of a comment.
//
// It is also not a new look: `.gs-pill` was already an outline, so Guided Setup
// is unchanged in kind, and it is the two tinted lists that move.
//
// THE BORDER IS NOT LOAD-BEARING and is not asserted. Capra's
// `color.border.<kind>.subtle` measures 1.4–2.3:1 against the panel, well under
// the 3:1 SC 1.4.11 would want of a meaningful graphical object. It is a shape
// cue, nothing more — which is fine, because the rule this component exists to
// keep is "word + glyph + colour, never colour alone": the word is always
// rendered, and Capra supplies a glyph for every appearance except `default`,
// where there is no colour claim to disambiguate.

import { Pill } from '@capra/core'

/**
 * Every state the app labels today. One word per state, and the word is what the
 * pill says — a caller that wants different words wants a different state, not a
 * `label` prop, or the vocabulary stops being shared.
 *
 * The UX spec's section 0 map carries six more words for screens that do not
 * exist yet (`current`/`live` → success, `not-created`/`paused` → default,
 * `differs`/`orphan`/`stale`/`row-budget`/`degraded` → warning, `failing`/`over`
 * → danger, `preview` → highlight). They are deliberately absent until something
 * renders them; each is one line in STATES when its screen lands, and `highlight`
 * is the only appearance this file does not already use.
 */
export type StatusState =
  // Guided Setup, one per provisioned resource.
  | 'present'
  | 'absent'
  | 'failed'
  | 'skipped'
  | 'unreadable'
  | 'checking'
  // Field Explorer, AMI field coverage.
  | 'derived'
  | 'missing'
  // Findings, detection severity.
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'

type Appearance = 'success' | 'warning' | 'danger' | 'info' | 'default'

/**
 * The one map. `absent` is the one assignment that is NOT what the app shipped:
 * `.gs-missing` painted it danger, so a fresh install opened Guided Setup on
 * five red rows before anybody had done anything wrong — the expected state of a
 * stack nobody has deployed yet, reported as five failures. The UX spec's map
 * puts `absent` on `default`, and that is the reading the Deploy button below it
 * supports. `failed` — a write Cribl actually refused — keeps danger.
 */
const STATES: Record<StatusState, Appearance> = {
  present: 'success',
  absent: 'default',
  failed: 'danger',
  skipped: 'warning',
  // Cribl refused the read, so the app cannot say whether the resource is there.
  // Warning, not danger: nothing is broken, something is unknown — and the row
  // says so in words underneath.
  unreadable: 'warning',
  checking: 'default',
  derived: 'warning',
  missing: 'danger',
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'default',
}

export interface StatusPillProps {
  state: StatusState
}

export function StatusPill({ state }: StatusPillProps) {
  return (
    <Pill appearance={STATES[state]} variant="outline">
      {state}
    </Pill>
  )
}
