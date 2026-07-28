export interface DonutSlice {
  label: string
  value: number
  color: string
}

interface DonutProps {
  slices: DonutSlice[]
  size?: number
  thickness?: number
}

/** SVG donut chart with slices scaled to the total. */
export function Donut({ slices, size = 150, thickness = 26 }: DonutProps) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1
  const r = (size - thickness) / 2
  const cx = size / 2
  const cy = size / 2
  const circ = 2 * Math.PI * r
  let offset = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="proportion donut">
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        {slices.map((s, i) => {
          const frac = s.value / total
          const dash = frac * circ
          const el = (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={-offset}
            />
          )
          offset += dash
          return el
        })}
      </g>
    </svg>
  )
}
