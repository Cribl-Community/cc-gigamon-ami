// The samples' deterministic PRNG: mulberry32, seeded per label through FNV-1a.
// Shared by scripts/gen-pack-samples.mjs and scripts/pack-lookalike.mjs, and by
// src/cribl/packSamples.test.ts, which draws lookalike events with it. No
// Math.random and no Date.now: the same label gives the same draws everywhere.

export function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** `rng(label)`: a generator that depends only on `seed` and its label. */
export function seededRng(seed) {
  return function rng(label) {
    let a = (seed ^ fnv1a(label)) >>> 0
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return {
      next,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      chance: (p) => next() < p,
      /** [[value, weight], ...] */
      weighted: (pairs) => {
        const total = pairs.reduce((s, [, w]) => s + w, 0)
        let x = next() * total
        for (const [v, w] of pairs) {
          if ((x -= w) < 0) return v
        }
        return pairs[pairs.length - 1][0]
      },
      /** Lognormal with the given median, by Box-Muller over this generator. */
      lognormal: (median, sigma) => {
        const u1 = next() || 1e-12
        const u2 = next()
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        return median * Math.exp(sigma * z)
      },
      hex: (n) => {
        let s = ''
        for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(next() * 16)]
        return s
      },
      shuffle: (arr) => {
        const out = [...arr]
        for (let i = out.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1))
          ;[out[i], out[j]] = [out[j], out[i]]
        }
        return out
      },
    }
  }
}
