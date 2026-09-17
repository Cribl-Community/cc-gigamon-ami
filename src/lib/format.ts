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

/**
 * A cost in credits as operator copy: always hedged, and never more precise
 * than the estimate behind it. `formatCost(12.7, 'credits/hour')` → "about 13
 * credits/hour"; anything below 0.1 → "under 0.1 credits/hour".
 *
 * TWO SIGNIFICANT FIGURES, because that is all any of these numbers have. Every
 * caller's input is a model: measured CPU-seconds divided by a credit divisor,
 * extrapolated to an hour or a day. The cost model behind those extrapolations
 * is known to over-predict, so "about 1,235 credits" — which is what the older
 * `Math.round` produced — advertised four figures of precision for a number
 * with two, and a customer reading it is entitled to hold us to all four.
 * `toPrecision(2)` first, then a form that suits the magnitude: grouped integer
 * at 10 and above ("1,200"), one decimal from 1 to 10 ("5.0"), and the rounded
 * value itself below 1 ("0.15"), where a single decimal would throw away the
 * second figure.
 */
export function formatCost(credits: number, unit = 'credits'): string {
  if (!Number.isFinite(credits) || credits < 0.1) return `under 0.1 ${unit}`
  // Round first, then decide the form from the ROUNDED value: 9.99 rounds to 10
  // and must read "10", not "10.0", which would be three figures again.
  const n = Number(credits.toPrecision(2))
  const figure = n >= 10 ? n.toLocaleString('en-US') : n < 1 ? String(n) : n.toFixed(1)
  return `about ${figure} ${unit}`
}

/** Days in the month a recurring cost is quoted against. Not a calendar month:
 *  a figure that changed with February would read as a price change. */
const DAYS_PER_MONTH = 30

/**
 * A cost that keeps being charged, stated per day AND per month in one breath.
 *
 * WHY BOTH. A per-day figure is the one that can be checked against a single
 * day's usage, and the one every estimate in this app is actually computed in.
 * A per-month figure is the one the decision is made in: a Cribl admin holds an
 * entitlement per month, and "0.4 credits a day" and "12 credits a month" feel
 * like different sizes of number to the same person. Quoting only the day rate
 * is how a recurring cost gets waved through.
 *
 * It also rescues the floor. `formatCost` refuses to print more precision than
 * an estimate has, so anything under 0.1 credits reads "under 0.1" — true, and
 * on its own it reads as "free". Multiplied by a month it stops being: "under
 * 0.1 credits/day (about 1.5 credits a month)" is the same measurement telling
 * the truth at the scale the reader budgets in.
 *
 * The month is parenthesised rather than joined with a dash so the whole phrase
 * drops into the middle of a sentence without colliding with its punctuation,
 * and each half carries its own "about" because each is rounded on its own.
 */
export function formatRecurringCost(creditsPerDay: number): string {
  const perDay = formatCost(creditsPerDay, 'credits/day')
  const perMonth = formatCost(creditsPerDay * DAYS_PER_MONTH, 'credits a month')
  return `${perDay} (${perMonth})`
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
