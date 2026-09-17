import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@capra/theme/base.css'
import '@capra/core/styles.css'
import '@capra/icons/styles.css'
import App from './App'
import { ToastProvider } from './components/Toast'
import './App.css'
import { BASE_PATH } from './cribl/config'
import { DashboardProvider } from './app/DashboardContext'
import { applyTheme, readStoredTheme } from './app/theme'
import { loadSearchCaps } from './cribl/searchCaps'

// Applied before React mounts so there's no flash of the wrong theme. Defaults
// to dark (the reference dashboards are dark) unless the user or OS says light.
applyTheme(readStoredTheme())

// The install-wide search running-time limits, if this install has changed them
// (cribl/searchCaps.ts). Fired here and DELIBERATELY NOT AWAITED: blocking first
// render on a KV round trip would cost every cold load of every tab a trip, to
// change a number that most installs never touch. Anything that runs before it
// lands runs under DEFAULT_CAP_TIERS, which is what the app did before this
// setting existed; the stored limits apply from the next query after that. It
// only ever reads — a corrupt or absent value leaves the defaults in force and
// is not repaired, because a repair would be a write on load (AGENTS.md).
void loadSearchCaps()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={BASE_PATH}>
      <DashboardProvider>
        <App />
        {/* Mounted once, at the root, and NOT inside the tab that pushes toasts
            — a toast reporting a write has to outlive a route change, and
            `pushToast` is a plain module function with no component to live in.
            It portals its container to document.body, so it draws nothing here.
            Why it is Capra's and not the hand-rolled stack it replaces:
            src/components/Toast.tsx. */}
        <ToastProvider />
      </DashboardProvider>
    </BrowserRouter>
  </StrictMode>,
)
