import { Fragment, StrictMode } from 'react'
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
import { prefetchRunHistory } from './cribl/accel/status'
import { resolveDatasetTarget } from './cribl/datasetTarget'
import { loadAccelServing } from './cribl/accel/serving'
import { installTrace } from './cribl/devTrace'

// The dev-only page trace (cribl/devTrace.ts). `import.meta.env.DEV` is a
// build-time constant, so a production bundle drops this branch entirely.
// StrictMode is off while tracing: it mounts every effect twice in dev, which
// submits, cancels and resubmits jobs production never does.
const TRACE = import.meta.env.DEV && new URLSearchParams(window.location.search).has('trace')
if (TRACE) installTrace()

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

// The newest run of every schedule, which every accelerated panel needs before
// its stored result can be downloaded (cribl/accel/status.ts, HEAD_LIMIT).
// Started here so it overlaps module loading and first render rather than
// starting when the first panel mounts. A GET that bills and writes nothing.
prefetchRunHistory()

// Which dataset the dashboards read: the customer's, or the onboarding pack's
// sample while the customer's holds nothing (cribl/datasetTarget.ts). Every
// panel holds its first submit for this answer, so it starts here, overlapping
// module loading. One GET that bills nothing, and at most one tiny search on a
// sample-only install; it writes nothing.
void resolveDatasetTarget()

// Whether each schedule is on, and still runs the query its panels show
// (cribl/accel/serving.ts). The same config-plane GETs Guided Setup's table
// makes — nothing billed, nothing written — started here for the same reason as
// the history: accelerated panels hold their first read for it, up to a
// deadline, so that a paused schedule's panel runs live once rather than
// reading a stale run first and then running live.
void loadAccelServing()

const Strict = TRACE ? Fragment : StrictMode

createRoot(document.getElementById('root')!).render(
  <Strict>
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
  </Strict>,
)
