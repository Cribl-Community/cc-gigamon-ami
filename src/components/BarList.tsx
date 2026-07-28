export interface BarItem {
  label: string
  value: number
  /** Right-aligned formatted value (defaults to value). */
  display?: string
  /** Optional secondary note (e.g. % of link). */
  note?: string
}

interface BarListProps {
  items: BarItem[]
  accent?: 'success' | 'info' | 'accent'
  onSelect?: (item: BarItem) => void
}

/** Horizontal bar list, bars scaled to the max value in the set. */
export function BarList({ items, accent = 'success', onSelect }: BarListProps) {
  const max = items.reduce((m, it) => Math.max(m, it.value), 0) || 1
  return (
    <div className="barlist">
      {items.map((it, i) => (
        <button
          type="button"
          key={`${it.label}-${i}`}
          className={`barrow ${onSelect ? 'barrow-click' : ''}`}
          onClick={onSelect ? () => onSelect(it) : undefined}
          disabled={!onSelect}
        >
          <span className="barrow-label" title={it.label}>{it.label}</span>
          <span className="barrow-track">
            <span className={`barrow-fill barrow-${accent}`} style={{ width: `${(it.value / max) * 100}%` }} />
          </span>
          <span className="barrow-value">
            {it.display ?? it.value.toLocaleString()}
            {it.note && <span className="barrow-note"> · {it.note}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}
