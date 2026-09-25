/**
 * Light / dark theme handling.
 *
 * Capra's tokens (every `token('…')` in App.css) resolve to cds2 CSS vars that
 * flip automatically with the `.dark` class on <html>, so switching that class
 * re-themes almost the whole app. The exceptions are the few hand-picked graph
 * colors, which App.css defines as --gm-st-* / --gm-flow-* vars with light
 * defaults in :root and dark overrides under .dark.
 *
 * Where the choice is kept: this module is only the local first-paint cache
 * (localStorage, else the OS). The viewer's choice itself is a field of the
 * per-user KV preferences document (cribl/prefs.ts `useThemePref`), applied by
 * ThemeToggle when that document lands — because inside Cribl's sandboxed app
 * frame localStorage throws or is not kept across a reload.
 */
export type Theme = 'light' | 'dark'

const KEY = 'gigamon-npm-theme'

/** The locally cached choice, else the OS preference, else dark (the design
 *  baseline). A first guess only: the stored KV choice overrides it on landing. */
export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // localStorage can throw in the sandboxed Cribl iframe — fall through.
  }
  try {
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  } catch {
    // matchMedia unavailable — fall through.
  }
  return 'dark'
}

export function applyTheme(theme: Theme): void {
  const el = document.documentElement
  el.classList.toggle('dark', theme === 'dark')
  el.dataset.theme = theme
  el.style.colorScheme = theme
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Non-fatal: the toggle still works for this session, and the KV document
    // (cribl/prefs.ts) carries the choice to the next load.
  }
}
