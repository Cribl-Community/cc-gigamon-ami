import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@capra/theme/base.css'
import '@capra/core/styles.css'
import '@capra/icons/styles.css'
import App from './App'
import './App.css'
import { BASE_PATH } from './cribl/config'
import { DashboardProvider } from './app/DashboardContext'
import { applyTheme, readStoredTheme } from './app/theme'

// Applied before React mounts so there's no flash of the wrong theme. Defaults
// to dark (the reference dashboards are dark) unless the user or OS says light.
applyTheme(readStoredTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={BASE_PATH}>
      <DashboardProvider>
        <App />
      </DashboardProvider>
    </BrowserRouter>
  </StrictMode>,
)
