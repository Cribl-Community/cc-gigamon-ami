// Formatting helpers for the dashboards.

export function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Human-readable bytes (1 KB = 1024). */
export function fmtBytes(v: unknown, digits = 1): string {
  let n = toNum(v)
  if (n === 0) return '0 B'
  const neg = n < 0
  n = Math.abs(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const val = n / Math.pow(1024, i)
  return `${neg ? '-' : ''}${val.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

/** Compact number, e.g. 15.5M, 1.2K. */
export function fmtCount(v: unknown, digits = 1): string {
  const n = toNum(v)
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  const units = [
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
  ]
  for (const u of units) {
    if (abs >= u.v) return `${(n / u.v).toFixed(digits)}${u.s}`
  }
  return String(n)
}

/** Milliseconds with unit, promoting to s when large. */
export function fmtMs(v: unknown): string {
  const n = toNum(v)
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`
  return `${Math.round(n)} ms`
}

export function fmtPct(v: unknown, digits = 1): string {
  return `${toNum(v).toFixed(digits)}%`
}

/** Get a string field from a row, with a fallback. */
export function str(row: Record<string, unknown>, key: string, fallback = ''): string {
  const v = row[key]
  return v == null ? fallback : String(v)
}

/** Seconds spanned by a relative earliest bound like '-15m', '-1h', '-24h'. */
export function windowSeconds(earliest: string): number {
  const m = /^-(\d+)\s*([smhd])$/.exec(earliest.trim())
  if (!m) return 900
  const n = Number(m[1])
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2]] ?? 60)
}
