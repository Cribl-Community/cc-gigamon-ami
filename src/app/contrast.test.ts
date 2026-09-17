// The gate on every colour pairing this app's own stylesheet decides.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A COMPUTATION AND NOT A LIST OF EXPECTED HEXES.
//
// "We fixed the contrast" is a claim that rots in silence. The colours it is
// about live behind four indirections — token('…') is rewritten to a cds2 CSS
// variable at build time, that variable is defined in @capra/theme's base.css,
// its value is usually another variable, and the surface underneath is
// translucent (color.background.surface is #ffffffd9 in light and #00000040 in
// dark, so a panel is not the colour its token says). Anyone can move any link
// in that chain — us by editing App.css, Capra by shipping a minor — and a
// table of expected hexes here would either go stale or be "fixed" to match
// whatever the new value happens to be.
//
// So this resolves the chain the way a browser does and computes the ratio:
// parse base.css and src/App.css, rewrite token('a.b.c') to var(--cds2-a-b-c)
// exactly as @capra/dx-tokens-postcss-plugin does, build a light map from the
// :root blocks and a dark map by layering .dark and :root.dark over it in
// source order, resolve var() recursively, alpha-composite each translucent
// layer onto the opaque thing beneath it, then apply the WCAG 2.1 relative
// luminance formula. A failure prints the resolved hexes and the measured
// ratio, so it names what moved instead of saying "expected true".
//
// WHAT IT PROVES: that each pair in PAIRS, as the app resolves it in the theme
// named, clears its threshold.
//
// WHAT IT DOES NOT PROVE: that a pair the table does not list is legible; that
// the class named in `where` is still the one that draws the pair; or that the
// browser paints what base.css declares (Capra ships some values as display-p3
// in its source data — base.css itself carries only sRGB hex, which is what is
// measured here and what a non-P3 display shows).
//
// THRESHOLDS. 4.5:1 for text (SC 1.4.3 AA — every site listed here renders at
// 10–14px, well under the 18.66px bold / 24px that would make it "large"), and
// 3:1 for a graphical object or a focus indicator (SC 1.4.11, SC 2.4.11).
// Those two numbers are the standard's, not ours.
//
// HEADROOM IS DELIBERATE, AND UNEVEN. The two light values this suite was
// written for were picked at about 5.0:1 rather than at the 4.5 line, because
// half of each pair is a Capra token that can move underneath us and a value
// sitting 0.05 above the line turns their patch release into our red build.
// The focus ring has no such luxury: at 3.04:1 on --dop-canvas it clears 3:1 by
// 0.04, and both halves are fixed — ours and Capra's. If THAT row is what
// fails, read it as Capra having moved color.background.info.solid.default,
// and re-measure the ring against every surface in SURFACES before changing it.
//
// IF THIS TEST FAILS: the message names the pair, both resolved colours, the
// measured ratio and the threshold. Do not raise the threshold, and do not
// delete the row. Either the colour moved and should move back, or the pairing
// is genuinely new and needs a value that passes.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { allTokens } from '@capra/theme/dx/tokens-minimal'

type Theme = 'light' | 'dark'

/** A colour as the app resolves it, in the order it is painted: top layer first. */
interface Pair {
  /** What the pairing is, in the words a reviewer would use. */
  what: string
  /** The foreground, written the way App.css writes it. */
  fg: string
  /** Every layer under it, topmost first. The last one must be opaque. */
  bg: string[]
  /** 4.5 for text, 3 for a graphical object or focus indicator. */
  threshold: number
  /** The rules that draw this pairing, so a failure can be found by grep. */
  where: string
  /** Omit to check both themes. */
  themes?: Theme[]
}

/** The page itself — the bottom of every stack, and the only opaque layer. */
const PAGE = "token('color.background.application')"

/**
 * Every surface a control can sit on, for the focus ring. Derived by reading
 * the rules the ring applies to, not assumed: a control inside .pivot-toggle
 * sits on neutral.subtle, a diagram ⓘ on --dop-canvas or --cribl-card.
 */
const SURFACES: Array<[string, string[]]> = [
  ['the page', [PAGE]],
  ['a panel', ['var(--gm-panel)', PAGE]],
  ['a solid panel', ['var(--gm-panel-2)', PAGE]],
  ['the diagram canvas', ['var(--dop-canvas)', PAGE]],
  ['a Cribl product card', ['var(--cribl-card)', PAGE]],
  ['inside .pivot-toggle', ["token('color.background.neutral.subtle')", 'var(--gm-panel)', PAGE]],
]

const FOCUS_RING = "token('color.background.info.solid.default')"

/**
 * The table. A new pairing is one row.
 *
 * It is not — and is not trying to be — every colour pair in App.css: the file
 * carries 60 distinct literal hexes, and several of them (the MITRE tiles, the
 * Gigamon brand orange, the heatmap cell labels, the four triage domain
 * colours) fail 4.5:1 today in one theme or both. Those are a palette decision
 * with an owner, not a token fix, and listing them here as expected-to-fail
 * would make this file lie. What IS here is every pairing the --gm-st-* status
 * family draws, the ink that family puts on a filled pill, and the focus ring —
 * the surfaces this slice changed or introduced.
 */
const PAIRS: Pair[] = [
  {
    what: 'status: success',
    fg: 'var(--gm-st-success)',
    bg: ['var(--gm-panel)', PAGE],
    threshold: 4.5,
    where: '.svc-status-success (11.5px), .gs-ok (11px), .gs-step-ok (12.5px), .gs-res-commit code (11px)',
  },
  {
    what: 'status: success, on the solid panel',
    fg: 'var(--gm-st-success)',
    bg: ['var(--gm-panel-2)', PAGE],
    threshold: 4.5,
    where: '.gs-ok inside .gs-checklist-head / .gs-endpoint-main',
  },
  {
    what: 'status: warning',
    fg: 'var(--gm-st-warning)',
    bg: ['var(--gm-panel)', PAGE],
    threshold: 4.5,
    where: '.svc-status-warning (11.5px), .gs-skip (11px), .gs-res-skip (11.5px), .gs-step-skip (12.5px)',
  },
  {
    what: 'status: warning, on the solid panel',
    fg: 'var(--gm-st-warning)',
    bg: ['var(--gm-panel-2)', PAGE],
    threshold: 4.5,
    where: '.gs-skip inside .gs-checklist-head',
  },
  {
    what: 'status: danger',
    fg: 'var(--gm-st-danger)',
    bg: ['var(--gm-panel)', PAGE],
    threshold: 4.5,
    where: '.svc-status-danger, .gs-missing, .gs-res-error, .gs-step-err, .gs-btn-danger-text',
  },
  {
    what: 'status: danger, on the solid panel',
    fg: 'var(--gm-st-danger)',
    bg: ['var(--gm-panel-2)', PAGE],
    threshold: 4.5,
    where: '.gs-missing inside .gs-checklist-head',
  },
  {
    what: 'status: unknown',
    fg: 'var(--gm-st-unknown)',
    bg: ['var(--gm-panel)', PAGE],
    threshold: 4.5,
    where: '.svc-status-unknown, .gs-unknown, .tab-sub .d-grey',
  },
  {
    // The one member of the family used as a FILL rather than as ink, which is
    // why it needs its own ink. White works on the light red and is 2.32:1 on
    // the dark one, and Capra's color.foreground.danger.contrast is white in
    // both modes — so no token swap repairs this pairing; only a per-mode ink.
    what: 'the ink on the filled danger pill',
    fg: 'var(--gm-st-danger-contrast)',
    bg: ['var(--gm-st-danger)', PAGE],
    threshold: 4.5,
    where: '.gs-err',
  },
  {
    what: 'the live throughput figure on the diagram canvas',
    fg: 'var(--gm-flow-metric)',
    bg: ['var(--dop-canvas)', PAGE],
    threshold: 4.5,
    where: '.dop-flow-value (14px semibold — under 18.66px, so AA wants 4.5 not 3)',
  },
  {
    what: 'the commit toast’s left rail',
    fg: 'var(--gm-st-info)',
    bg: ['var(--gm-panel)', PAGE],
    threshold: 3,
    where: '.gs-toast-commit (a 3px rail — a graphical object, SC 1.4.11)',
  },
]

// ── Everything below is the machinery. The table above is the contract. ──────

const require_ = createRequire(import.meta.url)
const BASE_CSS = require_.resolve('@capra/theme/base.css')
const APP_CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'App.css')

const stripComments = (css: string) => css.replace(/\/\*[^]*?\*\//g, '')

/** Top-level `selector { … }` blocks, by brace depth. */
function blocks(css: string): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = []
  let depth = 0
  let selStart = 0
  let bodyStart = 0
  let sel = ''
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '{') {
      if (depth === 0) {
        sel = css.slice(selStart, i).trim()
        bodyStart = i + 1
      }
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        out.push({ sel, body: css.slice(bodyStart, i) })
        selStart = i + 1
      }
    }
  }
  return out
}

/** `prop: value` pairs, splitting on `;` outside parentheses. */
function declarations(body: string): Array<[string, string]> {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ';' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
    .map((p) => p.trim())
    .filter((p) => p.includes(':'))
    .map((p) => [p.slice(0, p.indexOf(':')).trim(), p.slice(p.indexOf(':') + 1).trim()] as [string, string])
}

/**
 * The same rewrite @capra/dx-tokens-postcss-plugin performs at build time, off
 * the same token data it is configured with in .postcssrc.ts. An unknown key
 * throws here for the same reason it throws there: a typo must not resolve to
 * something, it must stop.
 */
function rewriteTokens(value: string): string {
  return value.replace(/token\(\s*['"]([^'"]+)['"]\s*\)/g, (_all, key: string) => {
    const t = (allTokens as Record<string, { cv: string } | undefined>)[key]
    if (!t) throw new Error(`No such Capra token: token('${key}')`)
    return `var(${t.cv})`
  })
}

/**
 * One custom-property map per theme.
 *
 * `:root` and `.dark` have equal specificity, so which wins is decided by
 * source order — hence a single pass in file order rather than "light, then
 * overlay dark". base.css declares each block twice and a later :root could in
 * principle undo an earlier .dark; walking in order is the only reading that
 * matches the browser.
 */
function themeMaps(): Record<Theme, Map<string, string>> {
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  const feed = (css: string, transform: (v: string) => string) => {
    for (const { sel, body } of blocks(css)) {
      const selectors = sel.split(',').map((s) => s.trim())
      const inLight = selectors.includes(':root')
      const inDark = inLight || selectors.includes(':root.dark') || selectors.includes('.dark')
      if (!inLight && !inDark) continue
      for (const [prop, value] of declarations(body)) {
        if (!prop.startsWith('--')) continue
        const v = transform(value)
        if (inLight) light.set(prop, v)
        if (inDark) dark.set(prop, v)
      }
    }
  }
  feed(stripComments(readFileSync(BASE_CSS, 'utf8')), (v) => v)
  feed(stripComments(readFileSync(APP_CSS, 'utf8')), rewriteTokens)
  return { light, dark }
}

/** Substitute var() until none is left, honouring the fallback argument. */
function resolveVars(map: Map<string, string>, value: string, depth = 0): string {
  if (depth > 50) throw new Error(`var() cycle while resolving: ${value}`)
  const m = /var\(\s*(--[\w-]+)\s*(?:,([^]*))?\)/.exec(value)
  if (!m) return value.trim()
  const replacement = map.has(m[1]) ? (map.get(m[1]) as string) : (m[2] ?? '')
  const next = value.slice(0, m.index) + replacement + value.slice(m.index + m[0].length)
  return resolveVars(map, next, depth + 1)
}

interface Rgba { r: number; g: number; b: number; a: number }

function parseColor(value: string): Rgba | null {
  const v = value.trim()
  const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(v)
  if (hexMatch) {
    let h = hexMatch[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    const byte = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16)
    return { r: byte(0), g: byte(1), b: byte(2), a: h.length === 8 ? byte(3) / 255 : 1 }
  }
  const fnMatch = /^rgba?\(([^)]+)\)$/i.exec(v)
  if (fnMatch) {
    const n = fnMatch[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    if (n.length < 3 || n.some(Number.isNaN)) return null
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 }
  }
  return null
}

const composite = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
})

/** WCAG 2.1 relative luminance, with the 0.03928 / 12.92 piecewise transfer. */
function luminance(c: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const toHex = (c: Rgba) =>
  '#' + [c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')

/**
 * One colour, resolved. The error is the interesting part: --gm-border is
 * declared as token('border.default'), which resolves to the SHORTHAND
 * `1px solid #cdced6`, not to a colour — and every rule that writes
 * `border: 1px solid var(--gm-border)` is therefore invalid at computed-value
 * time. Anyone who adds a border pair to the table above deserves to be told
 * that, not to see a parse failure.
 */
function colorOf(map: Map<string, string>, expression: string, label: string): Rgba {
  const resolved = resolveVars(map, rewriteTokens(expression))
  const parsed = parseColor(resolved)
  if (!parsed) {
    throw new Error(
      `${label}: ${expression} resolves to "${resolved}", which is not a colour.\n` +
        'If it looks like a border shorthand ("1px solid #…"), that is the bug, not the test: ' +
        'a CSS-wide shorthand token used in a paint slot makes the whole declaration ' +
        'invalid at computed-value time, so nothing is painted at all. Point the row at the ' +
        'colour token (color.border.neutral.default) rather than at border.default.',
    )
  }
  return parsed
}

/** A background stack, flattened to the single opaque colour it paints as. */
function flatten(map: Map<string, string>, layers: string[], label: string): Rgba {
  let out = colorOf(map, layers[layers.length - 1], label)
  for (let i = layers.length - 2; i >= 0; i--) out = composite(colorOf(map, layers[i], label), out)
  return out
}

const maps = themeMaps()
const THEMES: Theme[] = ['light', 'dark']

describe('contrast of the colours App.css decides', () => {
  it('computes a ratio the same way WCAG 2.1 does', () => {
    // The arithmetic has to be checked by something other than itself, or a
    // broken luminance function would pass every row in the table silently.
    const black = { r: 0, g: 0, b: 0, a: 1 }
    const white = { r: 255, g: 255, b: 255, a: 1 }
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5)
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5)
    // #767676 on white is the canonical 4.5:1 boundary case in the spec.
    expect(contrastRatio({ r: 118, g: 118, b: 118, a: 1 }, white)).toBeCloseTo(4.54, 2)
    // …and compositing has to actually happen: color.background.surface is
    // translucent, so a panel measured without it is measured wrong.
    const surface = colorOf(maps.light, "token('color.background.surface')", 'self-check')
    expect(surface.a, 'color.background.surface stopped being translucent — re-read the header').toBeLessThan(1)
  })

  for (const theme of THEMES) {
    describe(theme, () => {
      for (const pair of PAIRS) {
        if (pair.themes && !pair.themes.includes(theme)) continue
        it(`${pair.what} clears ${pair.threshold}:1`, () => {
          const map = maps[theme]
          const label = `${pair.what} (${theme})`
          const fg = colorOf(map, pair.fg, label)
          const bg = flatten(map, pair.bg, label)
          const painted = fg.a < 1 ? composite(fg, bg) : fg
          const ratio = contrastRatio(painted, bg)
          expect(
            Number(ratio.toFixed(2)),
            `${pair.what} — ${theme} theme — measured ${ratio.toFixed(2)}:1, needs ${pair.threshold}:1\n` +
              `  foreground  ${pair.fg}  →  ${toHex(painted)}\n` +
              `  background  ${pair.bg.join(' over ')}  →  ${toHex(bg)}\n` +
              `  drawn by    ${pair.where}\n` +
              '  Raising the threshold or deleting this row is not the fix. Read the file header.',
          ).toBeGreaterThanOrEqual(pair.threshold)
        })
      }

      // The ring is one colour against many surfaces, so it is a loop rather
      // than eleven near-identical rows. `outline-offset: 2px` is why the
      // surface — and not the control's own fill — is the right thing to
      // measure against: against a .gs-btn-primary or a .seg-active the ring is
      // the same blue as the button, 1.00:1, and only the gap makes it visible.
      for (const [where, layers] of SURFACES) {
        it(`the focus ring is visible on ${where}`, () => {
          const map = maps[theme]
          const label = `focus ring on ${where} (${theme})`
          const ring = colorOf(map, FOCUS_RING, label)
          const bg = flatten(map, layers, label)
          const ratio = contrastRatio(ring, bg)
          expect(
            Number(ratio.toFixed(2)),
            `The global :focus-visible ring on ${where} — ${theme} theme — measured ` +
              `${ratio.toFixed(2)}:1, needs 3:1 (SC 1.4.11 / SC 2.4.11)\n` +
              `  ring        ${FOCUS_RING}  →  ${toHex(ring)}\n` +
              `  surface     ${layers.join(' over ')}  →  ${toHex(bg)}\n` +
              '  Capra’s own color.border.focus is NOT a fix: it measures 2.33:1 on the light page.',
          ).toBeGreaterThanOrEqual(3)
        })
      }
    })
  }

  it('reads the token values from @capra/theme, not from a copy of them', () => {
    // If the resolver ever stopped finding base.css it would fall back to
    // unresolved var() text, parseColor would return null and every row would
    // throw — but a future refactor could make it fail softer than that. This
    // pins one value that only base.css can supply.
    expect(maps.light.get('--cds2-color-background-application')).toBeDefined()
    expect(maps.dark.get('--cds2-color-background-application')).toBeDefined()
    expect(
      toHex(colorOf(maps.dark, PAGE, 'base.css sanity')),
      'The dark page is no longer dark, so base.css is not being read as the browser reads it.',
    ).not.toEqual(toHex(colorOf(maps.light, PAGE, 'base.css sanity')))
  })
})
