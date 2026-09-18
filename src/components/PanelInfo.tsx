import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { AccelSource } from '../cribl/accel/read'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'

/**
 * The clock a panel dates a stored result by: `14:07`, or `17 Sep 00:10` when
 * the run is not from today.
 *
 * The date is not decoration. The Lake total's schedule fires once a day at
 * 00:10 UTC, so "as of 00:10" read at ten at night is ambiguous by exactly the
 * amount that matters — and a schedule that stopped firing a week ago would
 * otherwise show a plausible time of day forever. Same calendar day: the time
 * alone, which is what a reader glancing at an hourly sample wants.
 *
 * It lives here, beside the ⓘ block that renders it, rather than in
 * cribl/useSearch.ts, so that a tab test which mocks the hook still gets the
 * real formatter — and so the two panels and the popover cannot drift into two
 * spellings of the same timestamp.
 */
export function asOf(at: number | null, now: number = Date.now()): string | null {
  if (at === null || !Number.isFinite(at)) return null
  const then = new Date(at)
  // 24-hour, in the viewer's own zone. The zone is theirs because "as of" is a
  // question about their clock; the 24-hour form is fixed because the cadence
  // beside it is stated in UTC ("at 00:10 UTC"), and one of the two reading
  // "12:10 AM" is an invitation to compare them wrongly.
  const clock = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const today = new Date(now)
  const sameDay =
    then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate()
  return sameDay ? clock : `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock}`
}

interface Props {
  /** Plain-English "what this shows". */
  about?: string
  /** The exact Cribl Search (KQL) query behind the visualization. */
  query?: string
  /** Deep links to the corresponding Cribl pages (Stream / Lake / Search). */
  links?: Array<{ href: string; label: string }>
  /** Heading above `about` (defaults to "What this shows"). */
  aboutHeading?: string
  /** Accessible name for the ⓘ button, when there is no query behind it. */
  label?: string
  /**
   * Accessible name for the popover itself, e.g. `How “Service dependencies”
   * was computed`. Defaults to `label` so every popover has a name today;
   * a caller that knows the panel's title should pass the better one.
   */
  dialogLabel?: string
  /** When the figure was produced, and by which run — see `ComputedFrom`. */
  computed?: ComputedFrom
}

/**
 * Block 4: where the number actually came from, for a panel served by a
 * scheduled search.
 *
 * WHY THIS IS A BLOCK OF ITS OWN AND NOT A SENTENCE IN `about`. The other three
 * blocks are fixed: they say what the panel shows and hand over the query. This
 * one is the only part of an ⓘ whose truth changes between two page loads —
 * the same panel, the same query, answered on Tuesday by a stored run and on
 * Wednesday by a live one because the schedule had not fired yet. Written into
 * `about` it would be prose claiming something that is sometimes false.
 *
 * THE QUERY ABOVE IT DOES NOT CHANGE, and that is the point. A scheduled search
 * runs the panel's own query string, character for character (accel/manifest.ts
 * imports it from src/queries rather than restating it), so the ⓘ's provenance
 * claim survives Phase 2 intact. What acceleration changes is WHEN the string
 * ran — so that is what this block says, in the reader's own terms: not a run
 * you triggered, here is when it happened, and here is how to get one you did.
 *
 * It is also where the running-time cap gets its plain-language line (Phase
 * 0.5). The cap is a `set …` prefix the job body carries and the ⓘ deliberately
 * never shows, so a panel that reports "Search stopped" is otherwise
 * unexplainable without putting a second, unfrozen query fragment beside the
 * frozen KQL. In words it explains the stop and shows no syntax at all.
 */
export interface ComputedFrom {
  /** Where the figure beside this ⓘ came from on THIS page load. `'none'` is a
   *  panel showing nothing because the past moment the viewer picked has no
   *  stored run for it — see accel/read.ts's AccelSource. */
  source: AccelSource
  /** Epoch ms the answering run finished. Null on a live read. */
  at?: number | null
  /** That stored run is older than its schedule promises. */
  stale?: boolean
  /** How often the scheduled run fires, in words: `once a day, at 00:10 UTC`. */
  cadence: string
  /** The window the query reads, in words: `the last 30 days`. */
  window: string
  /** Why the stored run was not used, when it was not — one of
   *  accel/read.ts's own sentences, which are written to be read by a customer.
   *  An API response never reaches this prop. */
  fallback?: string | null
  /** How to get a figure computed right now, named after the control that does
   *  it: `use “Open in Search” above`. */
  live?: string
  /** Seconds a live run of this query is allowed before Cribl stops it. */
  capSeconds?: number
}

/** The cap as a reader would say it, never as the `set …` syntax that carries it. */
function capWords(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'its time limit'
  // An installer may set a cap as low as MIN_CAP_SECONDS (30), so seconds are a
  // real answer here, not a hypothetical one.
  if (seconds < 60) return `${Math.round(seconds)} seconds`
  const minutes = Math.round(seconds / 60)
  return minutes === 1 ? 'a minute' : `${minutes} minutes`
}

/**
 * The sentences of block 4, in order.
 *
 * Exported as a pure function because this is the one part of an ⓘ that the
 * display freeze cannot hold: scripts/extract-queries.mjs freezes prose where it
 * is WRITTEN (an `info=` or `about=` attribute at the call site), and these
 * words are written here, in the component. A test pins them instead.
 */
export function computedLines(c: ComputedFrom, now: number = Date.now()): string[] {
  const lines: string[] = []
  if (c.source === 'schedule') {
    lines.push(
      `This figure did not come from a query run when the page loaded. Cribl runs the query above on a schedule — ${c.cadence} — over ${c.window}, and this panel read the result that run stored.`,
    )
    const when = asOf(c.at ?? null, now)
    lines.push(
      when
        ? `The run it read finished at ${when}.`
        : 'This app could not tell when that run finished.',
    )
    if (c.stale) {
      lines.push(
        'That is older than this schedule promises, so the schedule may have stopped firing — check the acceleration status in Guided Setup.',
      )
    }
  } else if (c.source === 'none') {
    // No figure, and deliberately none. The live query would have answered about
    // the present under a heading naming a past time, so this panel is empty on
    // purpose and the sentence has to say that rather than apologise for a gap.
    if (c.fallback) lines.push(c.fallback)
  } else {
    if (c.fallback) lines.push(c.fallback)
    lines.push(`The query above ran over ${c.window} when the page loaded, so this figure is as new as the page.`)
  }
  if (c.live) lines.push(`To see the figure computed against live data, ${c.live}.`)
  if (c.capSeconds !== undefined) {
    lines.push(
      `Cribl stops a live run of this query if it is still going after ${capWords(c.capSeconds)}; a panel whose query was stopped says so instead of showing a number.`,
    )
  }
  return lines
}

function OpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  )
}

function IIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Popover width. The height is whatever the content comes to — which is the
 *  whole reason the vertical placement has to be measured rather than assumed. */
const POP_W = 400
/** Gap between the trigger and the popover, on whichever side it lands. */
const GAP = 8
/** Keep this much clear of every viewport edge. */
const EDGE = 12
/** Below this, a side is not worth using: clamping into a 40px band is not a
 *  reading experience, so the popover overlays the anchor instead. */
const MIN_SIDE = 160

/** The part of the trigger's rect that placement depends on. */
export interface AnchorBox {
  top: number
  bottom: number
  left: number
}

export interface Placement {
  top: number
  left: number
  /** Set only when the popover had to be clamped — it drives the scroll region. */
  maxHeight?: number
  /** Which branch was taken. Exposed so a test can name the case it is pinning. */
  side: 'below' | 'above' | 'clamped-below' | 'clamped-above' | 'overlay'
}

/**
 * Where the popover goes, given the anchor, the popover's natural height and
 * the viewport. Pure, and exported for exactly that reason: happy-dom reports
 * every rectangle as 0×0, so this arithmetic is the only part of the placement
 * that can be tested against real numbers.
 *
 * The app runs inside a Cribl iframe that is routinely 600–720px tall, so
 * "flip above" is not an edge case — a 390px popover hanging off a panel two
 * thirds down the page has nowhere below to go, and the block it loses is
 * always the KQL, because the KQL is last.
 */
export function placePopover(anchor: AnchorBox, popHeight: number, viewportW: number, viewportH: number): Placement {
  const left = Math.max(EDGE, Math.min(anchor.left, viewportW - POP_W - EDGE))
  const below = viewportH - anchor.bottom - GAP - EDGE
  const above = anchor.top - GAP - EDGE
  if (popHeight <= below) return { top: anchor.bottom + GAP, left, side: 'below' }
  if (popHeight <= above) return { top: anchor.top - GAP - popHeight, left, side: 'above' }
  // Neither side fits whole. Take the roomier one and let the popover scroll,
  // rather than letting it run off the bottom where nothing can reach it.
  if (above > below && above >= MIN_SIDE) return { top: EDGE, left, maxHeight: above, side: 'clamped-above' }
  if (below >= MIN_SIDE) return { top: anchor.bottom + GAP, left, maxHeight: below, side: 'clamped-below' }
  // A short iframe with the anchor in the middle of it: no usable band either
  // side, so cover the anchor and use the whole viewport.
  return { top: EDGE, left, maxHeight: Math.max(MIN_SIDE, viewportH - EDGE * 2), side: 'overlay' }
}

function samePlace(a: Placement, b: Placement): boolean {
  return a.top === b.top && a.left === b.left && a.maxHeight === b.maxHeight && a.side === b.side
}

/** Pretty-print a one-line KQL query: one pipeline clause per line. */
function pretty(q: string): string {
  return q.replace(/\s*\|\s*/g, '\n| ')
}

/**
 * Click-to-open ⓘ popover attached to a visualization. Shows what the panel
 * means AND the exact Cribl Search query, with a Copy button. Positioned
 * fixed so it escapes the panel's overflow clipping and viewport edges.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 * 1. The placement is measured after layout and flipped above the anchor when
 *    it would overflow the bottom. Clamping horizontally but not vertically is
 *    a named anti-pattern in the house info-affordances standard, and the half
 *    that goes unreachable is the half this component exists for.
 * 2. Scrolling *inside* the popover must not dismiss it. `scroll` does not
 *    bubble, but a capture listener on `window` still sees a nested element's
 *    scroll — so the naive listener turned the query block's own scrollbar
 *    into a self-destruct button, and the tail of a long query was unreadable.
 * 3. The anchor can move with no scroll and no resize event: a diagram canvas
 *    transform, the Cribl shell's nav collapsing, a panel above finishing its
 *    query. Nothing dispatches for those, so the popover follows the anchor on
 *    an animation frame instead of waiting to be told.
 */
export function PanelInfo({ about, query, links, aboutHeading = 'What this shows', label = 'What this shows and the query behind it', dialogLabel, computed }: Props) {
  const { range } = useDashboard()
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<Placement>({ top: 0, left: 0, side: 'below' })
  const [copied, setCopied] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  /** Geometry the last placement was computed from; skips redundant work. */
  const geomRef = useRef('')
  const titleId = useId()

  /** Re-place the popover from live geometry. Idempotent, and cheap when
   *  nothing moved — which, on an animation frame, is nearly always. */
  const measure = useCallback(() => {
    const btn = btnRef.current
    const pop = popRef.current
    if (!btn || !pop) return
    const r = btn.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const geom = `${r.top}|${r.bottom}|${r.left}|${vw}|${vh}`
    if (geom === geomRef.current) return
    geomRef.current = geom
    // scrollHeight is the popover's NATURAL height whether or not a max-height
    // is already applied, so re-placing an already-clamped popover cannot feed
    // its own clamped height back in and oscillate between two placements.
    const borders = (pop.offsetHeight || 0) - (pop.clientHeight || 0)
    const natural = (pop.scrollHeight || 0) + borders
    const next = placePopover(r, natural, vw, vh)
    setPlace((prev) => (samePlace(prev, next) ? prev : next))
  }, [])

  // Measure before paint, then move focus into the popover so the Copy button
  // and the links are one Tab away rather than at the end of the page.
  useLayoutEffect(() => {
    if (!open) return
    measure()
    popRef.current?.focus({ preventScroll: true })
  }, [open, measure])

  // The anchor can move with no event at all (see note 3 above). Following it
  // beats listening for the handful of causes we happen to know about.
  useEffect(() => {
    if (!open) return
    let frame = requestAnimationFrame(function tick() {
      measure()
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [open, measure])

  useEffect(() => {
    if (!open) return
    const inside = (n: Node | null) => !!n && !!wrapRef.current && wrapRef.current.contains(n)
    /** Close, handing focus back to the trigger if we still hold it. Guarded so
     *  dismissing by clicking some other control does not yank focus back. */
    const close = () => {
      if (inside(document.activeElement)) btnRef.current?.focus()
      setOpen(false)
    }
    const onDoc = (e: MouseEvent) => { if (!inside(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onScroll = (e: Event) => {
      // The popover's own scrollbars, and the browser scrolling a focused link
      // into view, are not the page moving out from under the anchor. Either
      // way the animation-frame watch keeps it attached, so there is nothing to
      // dismiss. A page scroll while the reader is elsewhere still dismisses.
      if (inside(e.target as Node) || inside(document.activeElement)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const toggle = () => {
    if (open) {
      // Closing by pressing the trigger again. Safari does not focus a button
      // on click, so focus can still be inside the dialog we are about to
      // unmount; hand it back rather than letting it fall to <body>.
      if (wrapRef.current?.contains(document.activeElement)) btnRef.current?.focus()
    } else if (btnRef.current) {
      // A first guess so the popover paints in roughly the right place; the
      // layout effect refines it with the measured height before paint.
      const r = btnRef.current.getBoundingClientRect()
      geomRef.current = ''
      setPlace({ top: r.bottom + GAP, left: Math.max(EDGE, Math.min(r.left, window.innerWidth - POP_W - EDGE)), side: 'below' })
    }
    setOpen((v) => !v)
  }

  const copy = () => {
    if (!query) return
    navigator.clipboard?.writeText(pretty(query)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <span className="pinfo" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className={`pinfo-btn ${open ? 'pinfo-btn-on' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <IIcon />
      </button>
      {open && (
        <div
          className="pinfo-pop"
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          ref={popRef}
          style={{ top: place.top, left: place.left, width: POP_W, maxHeight: place.maxHeight }}
        >
          {/* The dialog's accessible name. Visually hidden because the panel it
              belongs to is directly behind it; without it, screen readers
              announce ~70 nameless dialogs. */}
          <span id={titleId} className="sr-only">{dialogLabel ?? label}</span>
          {about && (
            <div className="pinfo-block">
              <div className="pinfo-h">{aboutHeading}</div>
              <p className="pinfo-about">{about}</p>
            </div>
          )}
          {links && links.length > 0 && (
            <div className="pinfo-block">
              <div className="pinfo-h">Open in Cribl</div>
              <div className="pinfo-links">
                {links.map((l) => (
                  <a key={l.href} className="pinfo-open" href={l.href} target="_blank" rel="noopener noreferrer">
                    <OpenIcon /> {l.label}
                  </a>
                ))}
              </div>
            </div>
          )}
          {query && (
            <div className="pinfo-block">
              <div className="pinfo-h-row">
                <span className="pinfo-h">Cribl Search · KQL</span>
                <span className="pinfo-actions">
                  <a
                    className="pinfo-open"
                    href={searchUiUrl(query, range.earliest)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <OpenIcon /> Open in Search
                  </a>
                  <button type="button" className="pinfo-copy" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
                </span>
              </div>
              <a
                className="pinfo-code-link"
                href={searchUiUrl(query, range.earliest)}
                target="_blank"
                rel="noopener noreferrer"
                /* Without this the link's accessible name is the whole query —
                   up to 2,638 characters in one entry of a screen reader's
                   link list. The query stays on screen; only the name is short. */
                aria-label="Open this query in Cribl Search"
                title="Open this query in Cribl Search (new tab)"
              >
                <pre className="pinfo-code">{pretty(query)}</pre>
              </a>
            </div>
          )}
          {computed && (
            /* Last, under the KQL, because every sentence in it is about "the
               query above". The popover scrolls when it has to clamp, so nothing
               here is unreachable — see placePopover. */
            <div className="pinfo-block">
              <div className="pinfo-h">How this was computed</div>
              {computedLines(computed).map((line) => (
                <p key={line} className="pinfo-about">{line}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
