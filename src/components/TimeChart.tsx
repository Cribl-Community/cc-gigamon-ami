export interface Series {
  name: string
  color: string
  points: { t: number; v: number }[]
  /** Optional min–max band shaded behind the line. */
  band?: { t: number; lo: number; hi: number }[]
}

interface TimeChartProps {
  series: Series[]
  height?: number
  unit?: string
  fmt?: (v: number) => string
  /** Use a log Y axis (good for latency spanning orders of magnitude). */
  log?: boolean
}

/** Lightweight multi-series SVG line chart with optional log axis + min–max band. */
export function TimeChart({ series, height = 160, unit = '', fmt, log = false }: TimeChartProps) {
  const all = series.flatMap((s) => s.points)
  const bandVals = series.flatMap((s) => s.band ?? []).flatMap((b) => [b.lo, b.hi])
  if (all.length === 0) return <div className="qb-msg" style={{ padding: 20 }}>No data</div>
  const ts = all.map((p) => p.t)
  const vs = [...all.map((p) => p.v), ...bandVals]
  const tMin = Math.min(...ts)
  const tMax = Math.max(...ts)
  const vMax = Math.max(...vs, 1)
  const floor = Math.max(0.1, Math.min(...vs.filter((v) => v > 0), vMax) / 1000)
  const W = 1000
  const H = height
  const pad = { l: 8, r: 8, t: 8, b: 8 }
  const x = (t: number) => (tMax === tMin ? W / 2 : pad.l + ((t - tMin) / (tMax - tMin)) * (W - pad.l - pad.r))
  const y = (v: number) => {
    const inner = H - pad.t - pad.b
    if (log) {
      const lv = Math.log10(Math.max(v, floor))
      const lmin = Math.log10(floor)
      const lmax = Math.log10(vMax)
      return pad.t + (1 - (lv - lmin) / (lmax - lmin || 1)) * inner
    }
    return pad.t + (1 - v / vMax) * inner
  }
  const label = fmt ? fmt(vMax) : `${Math.round(vMax)}${unit}`

  return (
    <div className="timechart">
      <div className="tc-head">
        <span className="tc-ymax">peak {label}{log ? ' · log axis' : ''}</span>
        <span className="tc-legend">
          {series.map((s) => (
            <span key={s.name} className="tc-key">
              <span className="tc-swatch" style={{ background: s.color }} /> {s.name}
            </span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="tc-svg" role="img">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={pad.t + g * (H - pad.t - pad.b)} y2={pad.t + g * (H - pad.t - pad.b)} className="tc-grid" />
        ))}
        {series.map((s) =>
          s.band && s.band.length > 1 ? (
            <path
              key={`${s.name}-band`}
              d={
                [...s.band].sort((a, b) => a.t - b.t).map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b.t).toFixed(1)},${y(b.hi).toFixed(1)}`).join(' ') +
                ' ' +
                [...s.band].sort((a, b) => b.t - a.t).map((b) => `L${x(b.t).toFixed(1)},${y(b.lo).toFixed(1)}`).join(' ') +
                ' Z'
              }
              fill={s.color}
              opacity={0.14}
              stroke="none"
            />
          ) : null,
        )}
        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => a.t - b.t)
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
          return <path key={s.name} d={d} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        })}
      </svg>
    </div>
  )
}
