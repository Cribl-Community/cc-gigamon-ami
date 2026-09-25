// The header's light/dark toggle.
//
// Where the choice lives, in the order it is consulted:
//   1. localStorage, then the OS preference (readStoredTheme) — the first-paint
//      guess, applied by main.tsx before React mounts and used as this
//      component's initial state, so a browser that keeps localStorage never
//      flashes the wrong theme;
//   2. the viewer's KV preferences document (`app/prefs/<userId>`, through
//      cribl/prefs.ts), which wins once it lands if it holds a choice.
//
// (2) exists because (1) does not survive a reload inside Cribl's sandboxed app
// frame: localStorage there throws or is not kept, so every reload used to fall
// back to the OS preference (owner report 2026-09-25: "each time the app
// reloads it goes back to light mode").
//
// The KV document is written on the click and nowhere else — never on mount,
// and a localStorage value is never copied into it on load. With no user id
// (the localhost dev page) prefs.ts touches no key at all, and when the PUT is
// refused the choice holds for this page only: in both cases this is exactly
// the localStorage-only behaviour it replaced.

import { useEffect, useState } from 'react'
import { useThemePref } from '../cribl/prefs'
import { applyTheme, readStoredTheme, storeTheme, type Theme } from './theme'

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z" />
    </svg>
  )
}

export function ThemeToggle() {
  const [local, setLocal] = useState<Theme>(readStoredTheme)
  const [stored, saveTheme] = useThemePref()
  // Undefined (still reading) and null (no stored choice) both leave the local
  // guess in force.
  const theme: Theme = stored ?? local
  useEffect(() => {
    applyTheme(theme)
    // The fast cache for the next first paint, refreshed from the stored choice
    // too. A localStorage write, not a KV one: the load-path rule is about the
    // shared store.
    storeTheme(theme)
  }, [theme])
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={() => {
        setLocal(next)
        saveTheme(next)
      }}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
