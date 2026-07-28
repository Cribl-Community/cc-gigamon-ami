import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { PERSONAS, type Persona, type TourStep } from './tour'

const SEEN_KEY = 'gigamon-npm-tour-seen'
/**
 * Marked with an ATTRIBUTE, not a class: React owns `className` on these panels,
 * so a re-render (every panel re-renders when its search resolves) silently
 * wiped an imperatively-added class. React never touches an attribute it did
 * not render, so this survives.
 */
const HL_ATTR = 'data-tour-hl'

interface TourState {
  persona: Persona | null
  index: number
  step: TourStep | null
  /** True once the user has completed or dismissed a tour at least once. */
  seen: boolean
  pickerOpen: boolean
  start: (id: string) => void
  openPicker: () => void
  closePicker: () => void
  next: () => void
  back: () => void
  exit: () => void
  markSeen: () => void
}

const Ctx = createContext<TourState | null>(null)

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Non-fatal — the tour still works, it just may offer itself again.
  }
}

export function TourProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const [persona, setPersona] = useState<Persona | null>(null)
  const [index, setIndex] = useState(0)
  const [seen, setSeen] = useState(readSeen)
  const [pickerOpen, setPickerOpen] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  const step = persona ? (persona.steps[index] ?? null) : null

  const markSeen = useCallback(() => {
    setSeen(true)
    writeSeen()
  }, [])

  const exit = useCallback(() => {
    setPersona(null)
    setIndex(0)
    markSeen()
  }, [markSeen])

  const start = useCallback((id: string) => {
    const p = PERSONAS.find((x) => x.id === id)
    if (!p) return
    setPersona(p)
    setIndex(0)
    setPickerOpen(false)
  }, [])

  const next = useCallback(() => {
    setIndex((i) => {
      if (!persona) return i
      if (i + 1 >= persona.steps.length) {
        // Finished — close out and remember, so it stays hidden by default.
        setPersona(null)
        markSeen()
        return 0
      }
      return i + 1
    })
  }, [persona, markSeen])

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  // Navigate to the step's tab, then scroll to + outline its anchor. Panels
  // render asynchronously (each runs its own search), so poll briefly for the
  // element rather than assuming it exists the moment the route changes.
  useEffect(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
    if (!step) return

    navigate(step.route)
    if (!step.target) return

    let cancelled = false
    const timers: number[] = []
    const deadline = Date.now() + 4000

    const tick = () => {
      if (cancelled) return
      const found = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      if (found) {
        found.setAttribute(HL_ATTR, '1')
        found.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // Panels grow when their query resolves, which shifts the target out of
        // view — re-centre once the content has had a chance to settle.
        timers.push(window.setTimeout(() => {
          if (cancelled) return
          document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 1400))
        return
      }
      if (Date.now() < deadline) timers.push(window.setTimeout(tick, 120))
    }
    timers.push(window.setTimeout(tick, 60))

    cleanupRef.current = () => {
      cancelled = true
      timers.forEach(window.clearTimeout)
      document.querySelectorAll<HTMLElement>(`[${HL_ATTR}]`).forEach((n) => n.removeAttribute(HL_ATTR))
    }
    return () => cleanupRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.route, step?.target, persona?.id, index])

  const value = useMemo<TourState>(
    () => ({
      persona, index, step, seen, pickerOpen,
      start, openPicker: () => setPickerOpen(true), closePicker: () => setPickerOpen(false),
      next, back, exit, markSeen,
    }),
    [persona, index, step, seen, pickerOpen, start, next, back, exit, markSeen],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTour(): TourState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTour must be used inside TourProvider')
  return v
}
