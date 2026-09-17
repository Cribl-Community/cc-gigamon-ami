// The ux-spec's "Classes to retire" list, as a gate rather than as a list.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS.
//
// Phase 1 retired four families of CSS across four slices, and every one of them
// was verified the same way: somebody ran a grep once, on the day. That is a
// verification with a shelf life of one commit. The specific failure it invites
// is the one slice 1.6 shipped — a class deleted from App.css while a `className`
// somewhere still names it, so the markup renders unstyled and nothing says so,
// because an unknown class is not an error in CSS, in TypeScript, or in a build.
//
// WHAT IT PROVES. For every name below: App.css declares no rule that selects it,
// and no `className` in src/ mentions it. Those two together are the whole of
// "retired" — one without the other is either dead CSS or dead markup.
//
// WHAT IT DOES NOT PROVE. That the replacement looks right. Nothing in this
// repository can prove that; the call-site audit in the slice report and the
// Preview check are what cover it. It also says nothing about a class that was
// never on the list.
//
// HOW TO CHANGE IT. Retiring another class means adding its name here in the
// same commit that deletes its rule. RESURRECTING one means deleting its line
// here and saying why in the rule you re-add — which is the point: bringing back
// `.gs-btn` should cost an argument, not a paste.
//
// COMMENTS ARE STRIPPED FIRST, deliberately and at some cost in machinery.
// App.css and the components document what each family used to be and where it
// went — `.btn-incident` was here, `.gs-btn` is the house button now — and that
// prose is the most valuable thing the retirement produced. A gate that made
// people delete their own explanation to keep the build green would be trading
// the record for the check.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every class name Phase 1 took out of App.css, with the slice that did it.
 *
 * The three families slice 1.6 retired (`.gs-pill*`, `.cov-badge*`, `.find-sev*`)
 * are here alongside 1.9's, because the list is about what this stylesheet has
 * decided, not about who decided it — and 1.6's are exactly as re-addable.
 */
const RETIRED: Array<{ name: string; slice: string; wentTo: string }> = [
  // 1.6 — three pill families onto <StatusPill>, two boxes onto <AppBanners>,
  //       the toasts onto Capra's Toast.
  { name: 'gs-pill', slice: '1.6', wentTo: '<StatusPill>' },
  { name: 'gs-ok', slice: '1.6', wentTo: '<StatusPill state="present">' },
  { name: 'gs-missing', slice: '1.6', wentTo: '<StatusPill state="absent">' },
  { name: 'gs-unknown', slice: '1.6', wentTo: '<StatusPill state="unreadable">' },
  { name: 'gs-err', slice: '1.6', wentTo: '<StatusPill state="failed">' },
  { name: 'gs-skip', slice: '1.6', wentTo: '<StatusPill state="skipped">' },
  { name: 'cov-badge', slice: '1.6', wentTo: '<StatusPill>' },
  { name: 'find-sev', slice: '1.6', wentTo: '<StatusPill>' },
  { name: 'tour-nudge', slice: '1.6', wentTo: '<AppBanners> → Capra Alert' },
  { name: 'intel-note', slice: '1.6', wentTo: '<AppBanners> → Capra Alert' },
  { name: 'gs-toasts', slice: '1.6', wentTo: 'Capra Toast' },
  { name: 'gs-toast', slice: '1.6', wentTo: 'Capra Toast' },
  // 1.7 — the inline confirmation onto <ConfirmDialog>.
  { name: 'gs-confirm', slice: '1.7', wentTo: '<ConfirmDialog> → Capra Modal' },
  // 1.9 — five button families into one, and the second modal onto Capra's.
  { name: 'gs-btn', slice: '1.9', wentTo: '.btn' },
  { name: 'gs-btn-primary', slice: '1.9', wentTo: '.btn-primary' },
  { name: 'gs-btn-ghost', slice: '1.9', wentTo: '.btn-ghost' },
  { name: 'gs-btn-danger', slice: '1.9', wentTo: '.btn-danger' },
  { name: 'gs-btn-danger-text', slice: '1.9', wentTo: '.btn-danger-text' },
  { name: 'tour-btn', slice: '1.9', wentTo: '.btn' },
  { name: 'tour-btn-primary', slice: '1.9', wentTo: '.btn-primary' },
  { name: 'btn-tour', slice: '1.9', wentTo: '.btn (the base already sets the gap)' },
  { name: 'btn-tour-txt', slice: '1.9', wentTo: '.btn (the base already sets the weight)' },
  { name: 'btn-refresh', slice: '1.9', wentTo: '.btn' },
  { name: 'btn-incident', slice: '1.9', wentTo: '.btn-primary' },
  { name: 'modal', slice: '1.9', wentTo: 'Capra Modal' },
  { name: 'modal-scrim', slice: '1.9', wentTo: 'Capra Modal (its own overlay)' },
  { name: 'modal-head', slice: '1.9', wentTo: 'Capra Modal (its own header)' },
  { name: 'modal-title', slice: '1.9', wentTo: 'Capra Modal `title`' },
  { name: 'modal-x', slice: '1.9', wentTo: 'Capra Modal (its own close button)' },
  { name: 'modal-body', slice: '1.9', wentTo: 'Capra Modal (its own content box)' },
  { name: 'modal-actions', slice: '1.9', wentTo: 'Modal.FooterActions' },
  { name: 'modal-done', slice: '1.9', wentTo: '.sn-done' },
  { name: 'modal-note', slice: '1.9', wentTo: '.sn-note' },
  { name: 'tour-modal', slice: '1.9', wentTo: 'Capra Modal size="md"' },
]

/**
 * Custom properties renamed rather than retired. Same gate, different reason:
 * a `var(--cribl-teal)` left behind resolves to nothing and the declaration is
 * dropped, which is the exact failure mode `--gm-border` had before slice 1.5.
 */
const RENAMED: Array<{ from: string; to: string }> = [
  { from: '--cribl-teal', to: '--gm-brand-teal' },
  { from: '--cribl-cyan', to: '--gm-brand-cyan' },
  { from: '--cribl-card', to: '--gm-brand-card' },
  { from: '--cribl-card-2', to: '--gm-brand-card-2' },
  { from: '--cribl-ink', to: '--gm-brand-ink' },
  { from: '--cribl-ink-sub', to: '--gm-brand-ink-sub' },
  { from: '--gg-orange', to: '--gm-brand-orange' },
  { from: '--gg-orange-soft', to: '--gm-brand-orange-soft' },
]

// ── Machinery. The tables above are the contract. ───────────────────────────

/** Every .ts/.tsx/.css under src/, path-relative for readable failures. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Block and line comments removed, and string literals left alone — a `//` inside
 * `'https://…'` is not a comment, and eating the rest of that line would hide
 * real code from the scan below. This walks the text in one pass with a tiny
 * state machine rather than trusting a regex to know the difference.
 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      out += ' '
      continue
    }
    if (two === '//') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      continue
    }
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < text.length) {
        if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue }
        out += text[i]
        if (text[i] === quote) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const FILES = sources(SRC).map((path) => ({
  path: relative(SRC, path).replace(/\\/g, '/'),
  code: stripComments(readFileSync(path, 'utf8')),
}))

/** This file's own tables name every retired class; it cannot scan itself. */
const SCANNED = FILES.filter((f) => f.path !== 'app/retiredClasses.test.ts')

/**
 * The value of every `className` in a file — the attribute, and the default
 * parameter `GatedControl` gives callers. A class name reaching the DOM has to
 * pass through one of the two.
 */
function classNameValues(code: string): string[] {
  const out: string[] = []
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** Selector-position occurrences of `.name` in a stylesheet. */
const declaresSelector = (css: string, name: string) =>
  new RegExp(`\\.${name.replace(/[-]/g, '\\-')}(?![\\w-])`).test(css)

describe('the classes Phase 1 retired', () => {
  it('reads real source files', () => {
    // If the walk ever stopped finding anything, every assertion below would
    // pass by scanning nothing at all.
    expect(SCANNED.length).toBeGreaterThan(30)
    expect(SCANNED.some((f) => f.path === 'App.css')).toBe(true)
  })

  it('strips comments without eating the code around them', () => {
    expect(stripComments('a /* .gs-btn */ b')).toBe('a   b')
    expect(stripComments('a // .gs-btn\nb')).toBe('a \nb')
    expect(stripComments(`const u = 'https://x/y' // .gs-btn`)).toBe(`const u = 'https://x/y' `)
  })

  for (const { name, slice, wentTo } of RETIRED) {
    it(`.${name} is gone from App.css (slice ${slice} → ${wentTo})`, () => {
      const css = SCANNED.find((f) => f.path === 'App.css')!.code
      expect(
        declaresSelector(css, name),
        `App.css still has a rule selecting .${name}. Slice ${slice} retired it in favour of ` +
          `${wentTo}. Two rules for one idea is what the ux-spec's retire list exists to stop — ` +
          'if this one genuinely has to come back, delete its row in RETIRED and say why in the rule.',
      ).toBe(false)
    })

    it(`.${name} is named by no className (slice ${slice} → ${wentTo})`, () => {
      const offenders = SCANNED.flatMap((f) =>
        classNameValues(f.code)
          .filter((v) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(v))
          .map((v) => `${f.path}: className contains "${v}"`),
      )
      expect(
        offenders,
        `.${name} has no rule in App.css any more, so this markup renders unstyled and ` +
          `nothing else will say so. It should be ${wentTo}.\n  ${offenders.join('\n  ')}`,
      ).toEqual([])
    })
  }

  for (const { from, to } of RENAMED) {
    it(`${from} is ${to} everywhere`, () => {
      const offenders = SCANNED.filter((f) =>
        new RegExp(`${from.replace(/-/g, '\\-')}(?![\\w-])`).test(f.code),
      ).map((f) => f.path)
      expect(
        offenders,
        `${from} was renamed to ${to}. A var() naming a property nothing declares resolves to ` +
          'nothing, and the whole declaration is dropped — silently, which is how this app once ' +
          `shipped with no borders at all.\n  ${offenders.join('\n  ')}`,
      ).toEqual([])
    })
  }
})
