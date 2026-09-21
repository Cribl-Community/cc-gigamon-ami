// Not submitting a query for a panel nobody has looked at yet.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT THIS EXISTS FOR. Concurrent search jobs from one user are
// admitted about 1.6 s apart. Web & API fires six queries the moment it mounts,
// Service Map five, TCP Health four — so Web & API's last query does not BEGIN
// until roughly eight seconds in, and nothing about how fast a query runs
// touches that. The only lever is firing fewer at once, and the cheapest way to
// fire fewer is to notice that half of them are drawing charts below the fold
// that the reader has not scrolled to.
//
// So a deferred panel keeps its place in the layout, keeps its title and its ⓘ,
// and shows a spinner (`useSearch({ deferred })` reports `loading`, not "No
// results" — an unasked query has no answer, it does not have an empty one).
// Its query is submitted the moment the panel comes near the viewport, which
// moves it out of the opening scrum and into a queue of one.
//
// ── WHAT MUST NOT HAPPEN, AND HOW EACH IS PREVENTED ─────────────────────────
//   * THE FIRST PAINT MUST NOT GET SLOWER. Panels above the fold pass
//     `eager: true` and are never deferred at all — their hooks are enabled on
//     the first render, before this file does anything. And a panel that is
//     ALREADY on screen answers `near` synchronously in the ref callback, from
//     its own rect, during the same commit: no observer callback, no extra
//     frame, nothing to wait for. On a tall screen showing six panels, all six
//     start together exactly as they did before.
//   * A PANEL MUST NOT BECOME UNREACHABLE. Three ways in, not one: the observer
//     (any scroll, smooth or instant — `prefers-reduced-motion` changes how a
//     jump animates, never whether the element intersects afterwards), a
//     `focusin` on the panel, which covers keyboard tabbing and the guided
//     tour without waiting for the observer's frame, and the synchronous rect
//     check, which covers a panel that was on screen the whole time.
//   * NO `IntersectionObserver` MUST MEAN NO DEFERRAL. Where the API is absent
//     — happy-dom, and any browser old enough to matter — every panel arrives
//     immediately and this file is a no-op. Failing open is the only safe
//     direction: the cost of getting it wrong is a slower mount, and the cost
//     of failing closed is a blank panel forever.
//   * ARRIVAL IS ONE-WAY. Scrolling back up does not un-run a query. `near`
//     goes true once and stays true, so a hook's dependency key never flips
//     back and re-submits.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How far outside the viewport still counts as "near".
 *
 * Roughly one laptop viewport. The job here is to have the query IN FLIGHT
 * before the panel is read, and against a ~5 s floor for any query at all on
 * this dataset plus the admission stagger, a panel that starts loading when it
 * is one screen away is usually ready by the time it is looked at. Much larger
 * and every panel on the page is "near" on mount, which is the behaviour this
 * file exists to stop; much smaller and the reader watches the spinner.
 */
export const NEAR_MARGIN_PX = 800

export interface NearViewport {
  /** Attach to the panel — `<Panel anchorRef={…}>`. */
  ref: (el: Element | null) => void
  /** True once the panel has come near the viewport, and true from the first
   *  render when `eager`. Pass as `deferred: !near`. */
  near: boolean
}

export interface UseNearViewportOptions {
  /** Above the fold: never defer, never observe, run on the first render. */
  eager?: boolean
  /** Override the margin. Tests, and a panel that knows it is slow. */
  marginPx?: number
}

/**
 * Whether an element is close enough to the viewport to load now, answered from
 * its rect so it can be answered during the commit rather than a frame later.
 *
 * A DEGENERATE RECT COUNTS AS NEAR. An element with no box has not been laid
 * out (or the environment has no layout at all), and "I cannot tell" has to
 * resolve the same way every other uncertainty here does: load it.
 */
function nearNow(el: Element, marginPx: number): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return true
  const viewport = typeof window === 'undefined' ? 0 : window.innerHeight || 0
  if (viewport === 0) return true
  return r.top < viewport + marginPx && r.bottom > -marginPx
}

/** Defer a panel's query until the panel is near the viewport. See the header. */
export function useNearViewport(opts: UseNearViewportOptions = {}): NearViewport {
  const { eager = false, marginPx = NEAR_MARGIN_PX } = opts
  const [near, setNear] = useState(eager)
  // Mirrors `near` for the ref callback, which runs during a commit and cannot
  // read the state it is about to set.
  const arrived = useRef(eager)
  const detach = useRef<(() => void) | null>(null)

  const arrive = useCallback(() => {
    if (arrived.current) return
    arrived.current = true
    detach.current?.()
    detach.current = null
    setNear(true)
  }, [])

  const ref = useCallback(
    (el: Element | null) => {
      detach.current?.()
      detach.current = null
      if (!el || arrived.current) return
      if (typeof IntersectionObserver !== 'function') return arrive()
      if (nearNow(el, marginPx)) return arrive()

      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) arrive()
        },
        { rootMargin: `${marginPx}px` },
      )
      io.observe(el)
      // Keyboard and the guided tour: focus lands before the observer's frame,
      // and a panel the reader is standing in must not still be waiting.
      const onFocus = () => arrive()
      el.addEventListener('focusin', onFocus)
      detach.current = () => {
        io.disconnect()
        el.removeEventListener('focusin', onFocus)
      }
    },
    [arrive, marginPx],
  )

  useEffect(
    () => () => {
      detach.current?.()
      detach.current = null
    },
    [],
  )

  return { ref, near }
}
