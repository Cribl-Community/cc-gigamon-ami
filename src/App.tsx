import { Suspense, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AUTO_REFRESH, TIME_RANGES, WITHHELD_REFRESH_SECONDS, useDashboard } from './app/DashboardContext'
import { APP_VERSION, IS_INSTALLED } from './cribl/config'
import { applyTheme, readStoredTheme, storeTheme, type Theme } from './app/theme'
import { useInflight } from './cribl/inflight'
import { CPU_SECONDS_PER_CREDIT, useMountedSearchCost } from './cribl/jobCost'
import { formatCost, formatRecurringCost } from './lib/format'
import { PanelInfo } from './components/PanelInfo'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TopProgress } from './components/TopProgress'
import { TourProvider } from './app/TourContext'
import { TourLauncher, TourPicker, TourStrip } from './components/Tour'
import { AppBanners } from './components/AppBanners'
import { ModeToggle } from './components/ModeToggle'
import { SnapshotPicker } from './components/SnapshotPicker'
import { useDataMode } from './cribl/dataMode'
import { JobWatchdogIndicator } from './components/JobWatchdog'
import { LANDING_ROUTE, TABS } from './app/tabs'
import { TabLoading } from './components/TabLoading'

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

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

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)
  useEffect(() => {
    applyTheme(theme)
    storeTheme(theme)
  }, [theme])
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

function LastUpdated({ ts, busy, inflight }: { ts: number; busy: boolean; inflight: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [])
  if (busy) {
    return (
      <span className="last-updated last-updated-busy" title={`${inflight} search${inflight === 1 ? '' : 'es'} running`}>
        running {inflight} search{inflight === 1 ? '' : 'es'}…
      </span>
    )
  }
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  const label = sec < 5 ? 'just now' : sec < 60 ? `${sec}s ago` : `${Math.round(sec / 60)}m ago`
  return <span className="last-updated" title="Time since the last query refresh">updated {label}</span>
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * THE TAB-CHANGE AUTO-REFRESH WARNING IS NOT BUILT, AND THIS IS WHY.
 *
 * S6 and §2.2's slice 1.8 row both specify one: on a tab change, if the
 * already-selected interval crosses a threshold on the newly-mounted panels,
 * render a one-time inline `Alert` offering **Switch to off** / **Keep**. It was
 * re-checked before building and four separate things have moved out from under
 * it since it was written. Recorded here rather than dropped silently, because
 * the next reader will look for it and should find the argument, not a gap.
 *
 * 1. ITS HEADLINE CASE IS FIXED. The spec's whole example is Data Flow's pinned
 *    30-day tile re-running on every tick — "≈12.3 M CPU-s/day ≈ 3,400
 *    credits/day". Slice 0.5's pinned-window fix landed: `useSearch` keys a
 *    pinned hook on `manualRefreshNonce`, and `useCostSlot(enabled && !pinned)`
 *    keeps it out of the tick cost entirely. Counting the hooks that still
 *    re-run on a tick, Data Flow is now 2 — the second-cheapest tab in the app.
 *    Web & API is the worst at 6, Capacity, Flow Map and TCP Health 4.
 *    (Flow Map read 5 here until 2026-09-22; it has four `useSearch` hooks, two
 *    of which only mount once a service is selected. These are TICK counts —
 *    every mounted hook re-runs — so they are deliberately larger than the
 *    on-MOUNT counts in components/nearViewport.ts, which are 3 / 2 / 1.)
 *
 * 2. THERE IS NO LONGER A THRESHOLD TO CROSS. A-D29 removed 15 s and 30 s from
 *    the menu, so AUTO_REFRESH is `Off` and `1m` and nothing else. "The
 *    already-selected interval crosses a threshold" reduces to "auto-refresh is
 *    on, and this tab is dearer than the last one" — and no threshold value
 *    exists anywhere in the plan's evidence. Picking one would be inventing the
 *    basis for a number the app then quotes, which is the one thing the cost
 *    rules forbid.
 *
 * 3. THE FACT IS ALREADY ON SCREEN, ON THE CONTROL THAT CAUSES IT. `optionLabel`
 *    below puts the measured cost in the visible option text, and it is computed
 *    from `useMountedSearchCost()` — the panels mounted right now. The Header is
 *    outside `<Routes>`, so a tab change recomputes it: arriving on Web & API
 *    with 1m selected changes the selected option's own text. A banner would be
 *    a second, louder statement of a fact 40 px away.
 *
 * 4. IT CANNOT FIRE WHEN THE SPEC SAYS IT SHOULD. A cost slot starts at
 *    `cpuSeconds: null` and is only counted once its search has completed and
 *    `GET /jobs/{id}/metrics` has answered. At the instant of a tab change the
 *    new tab's cost is therefore unknown — `panels` is 0 — so a guard "on tab
 *    change" would either quote nothing or appear several seconds after arrival,
 *    reading as an interruption rather than a warning.
 *
 * WHAT IS STILL TRUE, so that reopening this is a decision and not a discovery:
 * the mechanism survives. An interval chosen on Findings (1 hook) carries to
 * Web & API (6), and at the plan's own measured ≈130 CPU-s per hook that is
 * 6 × 130 × 1,440 ≈ 1.12 M CPU-s/day ≈ 312 credits/day — real money, and about
 * a ninth of the case the spec argued from. If it is built later, the trigger
 * that fits what the app can actually measure is a change in the MEASURED tick
 * cost after the new tab's panels have run, not the moment of the tab change.
 */

/** What auto-refresh costs on this tab: a short cost on each option, and the
 *  detail behind the ⓘ beside the menu. Every figure is computed from the
 *  mounted searches' measured cost; nothing is a literal. */
function useAutoRefreshCopy(tabName: string) {
  const { panels, cpuSeconds } = useMountedSearchCost()
  const measured = panels > 0
  const creditsPerHourAt = (seconds: number) => (cpuSeconds / CPU_SECONDS_PER_CREDIT) * (3600 / seconds)

  // PER HOUR, and deliberately not the per-day-and-per-month pair that
  // formatRecurringCost gives a standing charge. Auto-refresh only spends while
  // a person is looking at this tab, so an hour is the longest span the figure
  // is honest over — quoting a month would price a tab nobody leaves open
  // overnight as if it were a scheduled search. The one figure below that IS
  // extrapolated to a standing charge says so and uses the pair.
  const optionLabel = (a: (typeof AUTO_REFRESH)[number]) => {
    if (a.seconds === 0) return 'Auto: off'
    return measured ? `Auto: ${a.label} — ${formatCost(creditsPerHourAt(a.seconds), 'credits/hour')}` : `Auto: ${a.label}`
  }

  // The withheld intervals are priced at the fastest one — the menu does not
  // list them, so this is the only place their absence is accounted for.
  const fastestOff = Math.min(...WITHHELD_REFRESH_SECONDS)
  const about = measured
    ? `Each refresh re-runs the ${plural(panels, 'panel', 'panels')} on ${tabName} that follow the time range: ` +
      `${Math.round(cpuSeconds).toLocaleString('en-US')} billable CPU-seconds at their last run, so every 1 minute costs ` +
      `${formatCost(creditsPerHourAt(60), 'credits/hour')}. ` +
      `Faster intervals are not offered: left running at ${fastestOff} s this tab would cost ` +
      `${formatRecurringCost(creditsPerHourAt(fastestOff) * 24)}, ` +
      'and this feed lands in minutes, so they would show nothing new.'
    : 'Faster intervals than 1 minute are not offered: every refresh re-runs each panel as a full Lake scan, ' +
      'and this feed lands in minutes. The cost of 1 minute appears here once this tab’s panels have run.'
  return { optionLabel, about }
}

function Header({ tabName }: { tabName: string }) {
  const { range, setRange, refresh, autoSeconds, setAutoSeconds, lastRefresh } = useDashboard()
  const autoRefresh = useAutoRefreshCopy(tabName)
  const mode = useDataMode()
  // Spin for exactly as long as work is actually happening, rather than a fixed
  // timeout that finishes while queries are still running (reads as a stall).
  const inflight = useInflight()
  const busy = inflight > 0
  const doRefresh = () => refresh()
  return (
    /* TWO ROWS, SPLIT BY HOW OFTEN YOU TOUCH THEM.
       Everything used to sit in one flex row, so the identity and nine controls
       competed for the same horizontal space and the <h1> lost — "Gigamon
       Network Observability" wrapped onto two lines while three sentences of
       explanatory prose sat beside it.

       Row 1 is identity plus the chrome you press once a session (tour, theme).
       Row 2 is the data-state toolbar: what am I looking at, and refresh it.
       The split is what gives the title a full row to itself, and gives the
       explanatory lines room to sit without squeezing anything. */
    <header className="app-header">
      <div className="app-idbar">
        <div className="app-id">
          <h1 className="app-title">
            <span className="title-bar" />
            {/* Its own element so `white-space: nowrap` lands on the NAME and not
                on the flex container, which would not stop it wrapping. */}
            <span className="app-title-name">Gigamon Network Observability</span>
            <span className="title-preview">(Preview)</span>
          </h1>
          {/* Beside the title now, not stacked under it: two chips on their own
              line cost a row of height and read as a second heading. */}
          <p className="app-subtitle">
            {/* Kept dev-only: in the installed app it just says "Cribl", but on the
                dev server it is the one cue that this is not the installed app. */}
            {!IS_INSTALLED && <span className="env-chip env-dev">dev preview</span>}
            <span className="version-chip" title="App version (from package.json)">v{APP_VERSION}</span>
          </p>
        </div>
        <div className="app-chrome">
          <TourLauncher />
          <ThemeToggle />
        </div>
      </div>
      <div className="app-controls">
        {/* First, so a warning is the leftmost thing in this cluster — and
            rendering nothing at all the rest of the time, which is the whole
            design (components/JobWatchdog.tsx). Mounted here rather than on a
            tab because that is what keeps the watch running for as long as the
            app is open. */}
        <JobWatchdogIndicator />
        {/* ONE FRESHNESS STATEMENT AT A TIME. "updated 12s ago" is a claim about
            when the queries on screen last ran, and in Snapshot mode most of
            them did not run at all — the honest answer is the census line the
            mode control carries ("3 of 6 panels · oldest 08:20"). While searches
            are actually in flight this stays, in both modes, because that is a
            statement about right now rather than about the data's age. */}
        {(busy || mode === 'live') && <LastUpdated ts={lastRefresh} busy={busy} inflight={inflight} />}
        {/* ONE TIME CONTROL, TWO MEANINGS BY MODE. In Live it asks how far back
            from now; in Snapshot it asks which stored run, because a stored
            result ignores the range picker entirely (accel/read.ts) and a
            control that changes nothing is worse than one that is absent.
            Rendering both would put two time controls in one header with only
            one of them connected to anything. */}
        {mode === 'live' ? (
          <>
            <label className="range-label" htmlFor="time-range">Range</label>
            <select id="time-range" className="range-select" value={range.label} aria-label="Time range"
              onChange={(e) => { const next = TIME_RANGES.find((r) => r.label === e.target.value); if (next) setRange(next) }}>
              {TIME_RANGES.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
            </select>
          </>
        ) : (
          <SnapshotPicker />
        )}
        <span className="auto-refresh">
          <select id="auto-refresh" className="range-select" value={autoSeconds} aria-label="Auto-refresh interval"
            aria-describedby="auto-refresh-note" onChange={(e) => setAutoSeconds(Number(e.target.value))}>
            {AUTO_REFRESH.map((a) => (
              <option key={a.label} value={a.seconds}>{autoRefresh.optionLabel(a)}</option>
            ))}
          </select>
          <span id="auto-refresh-note" className="sr-only">
            15 and 30 second refreshes are switched off to limit search cost. The information button next to this menu explains the cost.
          </span>
          <PanelInfo aboutHeading="What auto-refresh costs" about={autoRefresh.about} label="What auto-refresh costs on this tab" />
        </span>
        {/* Between auto-refresh and Refresh: the owner's "the logical place is
            the refresh button", honoured by adjacency rather than by hiding the
            state inside it. See components/ModeToggle.tsx. */}
        {/* Still immediately left of Refresh — the owner's "the logical place is
            the refresh button", honoured by adjacency. The tour and theme
            buttons moved up to row 1 rather than this one moving, because they
            are session chrome and this is data state. */}
        <ModeToggle tabName={tabName} />
        <button type="button" className="btn" onClick={doRefresh} aria-busy={busy}>
          <span className={`refresh-ic ${busy ? 'spin' : ''}`}><RefreshIcon /></span> {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </header>
  )
}

/**
 * THE PENDING TAB, AND WHY THE TAB BAR TRACKS IT ITSELF.
 *
 * `BrowserRouter` runs every navigation inside `startTransition`. On a first
 * click to a lazy tab that means React keeps the old tab on screen and never
 * shows `<TabLoading>` — correct for a fast chunk, and for a slow one nothing
 * on screen changes until it arrives, which reads as a dead click.
 * `useNavigation()` would answer this, but only under a data router; this app
 * uses `BrowserRouter`. So the click itself records which tab it asked for, in
 * an URGENT state update (the handler runs outside the router's transition),
 * and the record is cleared the moment the router's location commits —
 * whichever tab that turns out to be, so a superseded click can never leave a
 * spinner behind.
 *
 * Preloading is the other half: hovering or focusing a link starts its chunk,
 * so by the click it is usually in flight or done and the pending state lasts
 * a frame.
 */
function TabBar() {
  const { pathname } = useLocation()
  const [pendingTo, setPendingTo] = useState<string | null>(null)
  // Cleared by the commit of ANY location, not only the one asked for.
  useEffect(() => {
    setPendingTo(null)
  }, [pathname])
  const pendingLabel = TABS.find((t) => t.to === pendingTo)?.label
  return (
    <nav className="tab-bar">
      {TABS.map((t) => {
        const pending = t.to === pendingTo
        return (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => `tab ${isActive ? 'tab-active' : ''} ${pending ? 'tab-pending' : ''}`}
            aria-busy={pending || undefined}
            onPointerEnter={t.preload}
            onFocus={t.preload}
            onClick={(e) => {
              // A modified click opens a new browser tab; this page does not navigate.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
              if (!pathname.startsWith(t.to)) setPendingTo(t.to)
            }}
          >
            {t.label}
            {pending && <span className="spinner spinner-sm" aria-hidden />}
          </NavLink>
        )
      })}
      <span className="sr-only" role="status">{pendingLabel ? `Loading ${pendingLabel}…` : ''}</span>
    </nav>
  )
}

export default function App() {
  const location = useLocation()
  const tabName = TABS.find((t) => location.pathname.startsWith(t.to))?.label ?? 'this tab'
  return (
    <TourProvider>
      <div className="app">
        <TopProgress />
        <Header tabName={tabName} />
        <TabBar />
        {/* Below the tab bar and never sticky, so a banner can never stop
            someone leaving the page it is complaining about. */}
        <AppBanners />
        <main className="app-main">
          <ErrorBoundary resetKey={location.pathname}>
            {/* Inside the boundary, so a tab whose chunk fails to download
                lands on the boundary's Reload message (app/lazyTab.ts) rather
                than taking the header and tab bar down with it. */}
            <Suspense fallback={<TabLoading />}>
            <Routes>
              <Route path="/" element={<Navigate to={LANDING_ROUTE} replace />} />
              {/* The Flow Map was called the Service Map until 2026-09-21, and
                  /service-map was the DEFAULT route — so it is what every
                  bookmark, every guided-tour anchor and every link anybody has
                  shared points at. The catch-all below would already send it to
                  /flow-map, but only by accident: it sends EVERYTHING there. If
                  the default route ever moves, an old Service Map link would
                  silently land on whatever became the default instead of on the
                  tab it names. This says where it goes, and why. */}
              <Route path="/service-map" element={<Navigate to={LANDING_ROUTE} replace />} />
              {TABS.map((t) => (
                <Route key={t.to} path={t.to} element={t.el} />
              ))}
              <Route path="*" element={<Navigate to={LANDING_ROUTE} replace />} />
            </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
        <TourPicker />
        <TourStrip />
      </div>
    </TourProvider>
  )
}
