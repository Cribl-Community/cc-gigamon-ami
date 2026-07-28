export interface HeatCell {
  value: number
  display: string
}

interface HeatmapProps {
  rows: string[]
  cols: string[]
  /** cell(row, col) → value/display, or null when the pair has no data. */
  cell: (row: string, col: string) => HeatCell | null
  max: number
  onSelect?: (row: string, col: string) => void
  /** Currently drilled cell, outlined to show what the drill below refers to. */
  selected?: { row: string; col: string } | null
}

/** Relative cool→hot color: 0 → green, max → red. Dark-theme friendly. */
function heatColor(v: number, max: number): string {
  const n = max > 0 ? Math.min(1, v / max) : 0
  const hue = 140 - 140 * n // 140 green → 0 red
  const light = 34 + 12 * n
  return `hsl(${hue}, 62%, ${light}%)`
}

/** Src-subnet × dst-subnet error heatmap. */
export function Heatmap({ rows, cols, cell, max, onSelect, selected }: HeatmapProps) {
  return (
    <div className="heatmap-wrap">
      <table className="heatmap">
        <thead>
          <tr>
            <th className="heat-corner">SRC ↓ / DST →</th>
            {cols.map((c) => (
              <th key={c} className="heat-colh">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th className="heat-rowh">{r}</th>
              {cols.map((c) => {
                const hc = cell(r, c)
                if (!hc) return <td key={c} className="heat-cell heat-empty">·</td>
                const isSel = selected?.row === r && selected?.col === c
                return (
                  <td key={c} className="heat-cell">
                    <button
                      type="button"
                      className={`heat-btn ${isSel ? 'heat-btn-sel' : ''}`}
                      style={{ background: heatColor(hc.value, max) }}
                      onClick={onSelect ? () => onSelect(r, c) : undefined}
                      disabled={!onSelect}
                      title={`${r} → ${c}: ${hc.display}`}
                    >
                      {hc.display}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
