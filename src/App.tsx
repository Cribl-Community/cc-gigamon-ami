import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AUTO_REFRESH, TIME_RANGES, useDashboard } from './app/DashboardContext'
import { APP_VERSION, IS_INSTALLED } from './cribl/config'
import { applyTheme, readStoredTheme, storeTheme, type Theme } from './app/theme'
import { useInflight } from './cribl/inflight'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TopProgress } from './components/TopProgress'
import { TourProvider } from './app/TourContext'
import { TourLauncher, TourNudge, TourPicker, TourStrip } from './components/Tour'
import { Findings } from './tabs/Findings'
import { Security } from './tabs/Security'
import { WebApiHealth } from './tabs/WebApiHealth'
import { ServiceMap } from './tabs/ServiceMap'
import { CapacityTopTalkers } from './tabs/CapacityTopTalkers'
import { TcpHealth } from './tabs/TcpHealth'
import { DnsHealth } from './tabs/DnsHealth'
import { TlsPosture } from './tabs/TlsPosture'
import { PqcReadiness } from './tabs/PqcReadiness'
import { ShadowAi } from './tabs/ShadowAi'
import { DataFlow } from './tabs/DataFlow'
import { FieldExplorer } from './tabs/FieldExplorer'
import { AmiReference } from './tabs/AmiReference'
import { GuidedSetup } from './tabs/GuidedSetup'

const TABS = [
  { to: '/findings', label: 'Findings', el: <Findings /> },
  { to: '/security', label: 'Security', el: <Security /> },
  { to: '/service-map', label: 'Service Map', el: <ServiceMap /> },
  { to: '/capacity', label: 'Capacity & Top Talkers', el: <CapacityTopTalkers /> },
  { to: '/tcp-health', label: 'TCP Health', el: <TcpHealth /> },
  { to: '/dns-health', label: 'DNS Health', el: <DnsHealth /> },
  { to: '/web-api', label: 'Web & API', el: <WebApiHealth /> },
  { to: '/tls-posture', label: 'TLS Posture', el: <TlsPosture /> },
  { to: '/pqc', label: 'PQC Readiness', el: <PqcReadiness /> },
  { to: '/ai-saas', label: 'AI & SaaS', el: <ShadowAi /> },
  { to: '/data-flow', label: 'Data Flow', el: <DataFlow /> },
  { to: '/fields', label: 'Field Explorer', el: <FieldExplorer /> },
  { to: '/reference', label: 'AMI Reference', el: <AmiReference /> },
  { to: '/setup', label: 'Guided Setup', el: <GuidedSetup /> },
]

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
      className="btn-icon"
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

function Header() {
  const { range, setRange, refresh, autoSeconds, setAutoSeconds, lastRefresh } = useDashboard()
  // Spin for exactly as long as work is actually happening, rather than a fixed
  // timeout that finishes while queries are still running (reads as a stall).
  const inflight = useInflight()
  const busy = inflight > 0
  const doRefresh = () => refresh()
  return (
    <header className="app-header">
      <div className="app-title-block">
        <h1 className="app-title">
          <span className="title-bar" />Gigamon NPM
        </h1>
        <p className="app-subtitle">
          Network performance monitoring · Cribl Search · Gigamon AMI
          <span className={`env-chip ${IS_INSTALLED ? 'env-installed' : 'env-dev'}`}>
            {IS_INSTALLED ? 'Cribl' : 'dev preview'}
          </span>
          <span className="version-chip" title="App version (from package.json)">v{APP_VERSION}</span>
        </p>
      </div>
      <div className="app-controls">
        <LastUpdated ts={lastRefresh} busy={busy} inflight={inflight} />
        <label className="range-label">Range</label>
        <select className="range-select" value={range.label} aria-label="Time range"
          onChange={(e) => { const next = TIME_RANGES.find((r) => r.label === e.target.value); if (next) setRange(next) }}>
          {TIME_RANGES.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
        </select>
        <select className="range-select" value={autoSeconds} aria-label="Auto-refresh interval" title="Auto-refresh interval"
          onChange={(e) => setAutoSeconds(Number(e.target.value))}>
          {AUTO_REFRESH.map((a) => <option key={a.label} value={a.seconds}>{a.seconds === 0 ? 'Auto: off' : `Auto: ${a.label}`}</option>)}
        </select>
        <TourLauncher />
        <ThemeToggle />
        <button type="button" className="btn-refresh" onClick={doRefresh} aria-busy={busy}>
          <span className={`refresh-ic ${busy ? 'spin' : ''}`}><RefreshIcon /></span> {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </header>
  )
}

function TabBar() {
  return (
    <nav className="tab-bar">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => `tab ${isActive ? 'tab-active' : ''}`}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}

export default function App() {
  const location = useLocation()
  return (
    <TourProvider>
      <div className="app">
        <TopProgress />
        <Header />
        <TabBar />
        <TourNudge />
        <main className="app-main">
          <ErrorBoundary resetKey={location.pathname}>
            <Routes>
              <Route path="/" element={<Navigate to="/service-map" replace />} />
              {TABS.map((t) => (
                <Route key={t.to} path={t.to} element={t.el} />
              ))}
              <Route path="*" element={<Navigate to="/service-map" replace />} />
            </Routes>
          </ErrorBoundary>
        </main>
        <TourPicker />
        <TourStrip />
      </div>
    </TourProvider>
  )
}
