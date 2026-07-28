interface InfoTipProps {
  text: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/** Small "ⓘ" icon with an accessible hover/focus tooltip explaining an item. */
export function InfoTip({ text, side = 'top' }: InfoTipProps) {
  return (
    <span className="infotip" tabIndex={0} role="note" aria-label={text}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
      </svg>
      <span className={`infotip-pop infotip-${side}`} role="tooltip">{text}</span>
    </span>
  )
}
