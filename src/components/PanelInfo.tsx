import { useEffect, useRef, useState } from 'react'
import { searchUiUrl } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'

interface Props {
  /** Plain-English "what this shows". */
  about?: string
  /** The exact Cribl Search (KQL) query behind the visualization. */
  query?: string
  /** Deep links to the corresponding Cribl pages (Stream / Lake / Search). */
  links?: Array<{ href: string; label: string }>
  /** Heading above `about` (defaults to "What this shows"). */
  aboutHeading?: string
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

const POP_W = 400

/** Pretty-print a one-line KQL query: one pipeline clause per line. */
function pretty(q: string): string {
  return q.replace(/\s*\|\s*/g, '\n| ')
}

/**
 * Click-to-open ⓘ popover attached to a visualization. Shows what the panel
 * means AND the exact Cribl Search query, with a Copy button. Positioned
 * fixed so it escapes the panel's overflow clipping and viewport edges.
 */
export function PanelInfo({ about, query, links, aboutHeading = 'What this shows' }: Props) {
  const { range } = useDashboard()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [copied, setCopied] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const left = Math.max(12, Math.min(r.left, window.innerWidth - POP_W - 12))
      setPos({ top: r.bottom + 8, left })
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
        aria-label="What this shows and the query behind it"
        aria-expanded={open}
        onClick={toggle}
      >
        <IIcon />
      </button>
      {open && (
        <div className="pinfo-pop" role="dialog" style={{ top: pos.top, left: pos.left, width: POP_W }}>
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
                title="Open this query in Cribl Search (new tab)"
              >
                <pre className="pinfo-code">{pretty(query)}</pre>
              </a>
            </div>
          )}
        </div>
      )}
    </span>
  )
}
