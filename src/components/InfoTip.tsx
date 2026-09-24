import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

interface InfoTipProps {
  text: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/** Gap between the icon and the pop, and the least margin kept to the viewport edge. */
const GAP = 8
const EDGE = 12

/**
 * Small "ⓘ" icon with an accessible tooltip explaining an item.
 *
 * The icon itself carries the text (`role="note"` + `aria-label`), so a screen
 * reader gets the definition on focus and the pop is presentation only.
 *
 * WHY THE POP IS `position: fixed` AND POSITIONED HERE. It used to be an
 * `absolute` child revealed by `:hover`/`:focus-visible` in CSS, which is fine
 * for a one-line definition in a table header. Guided Setup moved whole
 * paragraphs into these tips, many of them on the first line of a `.panel` —
 * and `.panel` is `overflow: hidden`, so an absolute pop above the icon was cut
 * off at the card's top edge. Fixed positioning escapes the card; the rect is
 * read at open time, the pop flips to the other side when it would leave the
 * viewport, is clamped horizontally, and closes on scroll and resize because a
 * fixed pop does not follow its anchor (claude-kit standards/info-affordances.md).
 *
 * WHY IT IS STATEFUL. Hover and focus open it as before; a click or tap toggles
 * it too, which is the only reveal that works on a touch screen. Escape closes it.
 */
export function InfoTip({ text, side = 'top' }: InfoTipProps) {
  const iconRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  // Two independent reasons to be open: the pointer is over it, or it was
  // pinned open by focus or a click. Hover leaving must not close a pinned tip.
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<CSSProperties | null>(null)
  // A pointer press focuses the icon and then clicks it. Without this, focus
  // would open the tip and the click in the same gesture would close it again.
  const focusedByPress = useRef(false)
  const open = hover || pinned

  const close = useCallback(() => {
    setHover(false)
    setPinned(false)
  }, [])

  // Measure after the pop is in the open state, so its real size is known.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const icon = iconRef.current
    const pop = popRef.current
    if (!icon || !pop) return
    const r = icon.getBoundingClientRect()
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const clampX = (x: number) => Math.max(EDGE, Math.min(x, vw - w - EDGE))
    const clampY = (y: number) => Math.max(EDGE, Math.min(y, vh - h - EDGE))
    const above = r.top - GAP - h
    const below = r.bottom + GAP
    let top: number
    let left: number
    if (side === 'left' || side === 'right') {
      const leftOf = r.left - GAP - w
      const rightOf = r.right + GAP
      const fitsLeft = leftOf >= EDGE
      const fitsRight = rightOf + w <= vw - EDGE
      left = side === 'left' ? (fitsLeft || !fitsRight ? leftOf : rightOf) : (fitsRight || !fitsLeft ? rightOf : leftOf)
      left = clampX(left)
      top = clampY(r.top + r.height / 2 - h / 2)
    } else {
      const fitsAbove = above >= EDGE
      const fitsBelow = below + h <= vh - EDGE
      top = side === 'top' ? (fitsAbove || !fitsBelow ? above : below) : (fitsBelow || !fitsAbove ? below : above)
      top = clampY(top)
      left = clampX(r.left + r.width / 2 - w / 2)
    }
    setPos({ top, left })
  }, [open, side, text])

  // A fixed pop is placed from a rect read once, so anything that moves the
  // page detaches it. Capture-phase so a scroll inside a nested container counts.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (iconRef.current && !iconRef.current.contains(e.target as Node)) close()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open, close])

  return (
    <span
      ref={iconRef}
      className={`infotip${open ? ' infotip-open' : ''}`}
      tabIndex={0}
      role="note"
      aria-label={text}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={() => { focusedByPress.current = document.activeElement !== iconRef.current }}
      onFocus={() => setPinned(true)}
      onBlur={close}
      onClick={(e) => {
        // Inside a clickable row or a <label>, the tip must not also activate
        // the thing it explains.
        e.preventDefault()
        e.stopPropagation()
        if (focusedByPress.current) {
          focusedByPress.current = false
          setPinned(true)
          return
        }
        setPinned((p) => !p)
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
      </svg>
      <span
        ref={popRef}
        className="infotip-pop"
        role="tooltip"
        style={pos ?? undefined}
      >
        {text}
      </span>
    </span>
  )
}
