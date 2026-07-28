import { useEffect, useState } from 'react'
import { useInflight } from '../cribl/inflight'

/**
 * Indeterminate progress bar pinned to the top of the app, shown whenever any
 * Cribl Search query is in flight. Cribl Search reports no incremental
 * progress, so this is a motion cue ("working") rather than a real percentage.
 *
 * It lingers briefly after the last query settles so a burst of queries reads
 * as one continuous update instead of flickering on and off between panels.
 */
export function TopProgress() {
  const inflight = useInflight()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (inflight > 0) {
      setVisible(true)
      return
    }
    const t = setTimeout(() => setVisible(false), 350)
    return () => clearTimeout(t)
  }, [inflight])

  if (!visible) return null
  return (
    <div className="topbar-progress" role="progressbar" aria-busy="true"
      aria-label={`Running ${inflight} search${inflight === 1 ? '' : 'es'}`}>
      <div className="topbar-progress-bar" />
    </div>
  )
}
