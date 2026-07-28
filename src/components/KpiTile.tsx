import { PanelInfo } from './PanelInfo'

export type Accent = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

interface KpiTileProps {
  label: string
  value: string
  unit?: string
  sub?: string
  accent?: Accent
  /** Small status pill under the value (e.g. Healthy / Breaching). */
  badge?: { text: string; accent: Accent }
  /** Plain-English explanation, shown in the ⓘ popover. */
  info?: string
  /** Cribl Search query backing this stat, revealed in the ⓘ popover. */
  query?: string
}

/** A KPI stat tile with a colored top border, optional status badge, and an
 *  ⓘ popover explaining the stat and revealing the query behind it. */
export function KpiTile({ label, value, unit, sub, accent = 'neutral', badge, info, query }: KpiTileProps) {
  return (
    <div className={`kpi kpi-${accent}`}>
      <div className="kpi-label">
        {label}
        {(info || query) && <PanelInfo about={info} query={query} />}
      </div>
      <div className="kpi-value">
        {value}
        {unit && <span className="kpi-unit">{unit}</span>}
      </div>
      {badge && <span className={`pill pill-${badge.accent}`}>{badge.text}</span>}
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}
