import { PanelInfo, type ComputedFrom } from './PanelInfo'

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
  /** A PromQL expression shown as a second ⓘ block — cookbook cards only.
   *  @see PanelInfo */
  promql?: string
  /** Where that expression opens, when there is somewhere. @see PanelInfo */
  promqlHref?: string
  /**
   * Where this figure came from and when — the same prop `<Panel>` takes.
   *
   * A tile served from a stored run MUST carry it. accel/read.ts's rule is that
   * a number from a schedule is never shown undated, and a tile has no header to
   * put a caption in, so the ⓘ's block 4 is where the date lives. The visible
   * half is the one caption the tab renders above the row
   * (components/SnapshotCaption.tsx) — six tiles with six identical captions is
   * the same fact six times.
   */
  computed?: ComputedFrom
}

/** A KPI stat tile with a colored top border, optional status badge, and an
 *  ⓘ popover explaining the stat and revealing the query behind it. */
export function KpiTile({ label, value, unit, sub, accent = 'neutral', badge, info, query, promql, promqlHref, computed }: KpiTileProps) {
  return (
    <div className={`kpi kpi-${accent}`}>
      <div className="kpi-label">
        {label}
        {(info || query || promql) && <PanelInfo about={info} query={query} promql={promql} promqlHref={promqlHref} computed={computed} />}
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
