// Cribl environment detection + constants.
//
// Installed in Cribl: `window.CRIBL_API_URL` is set (e.g. https://localhost:9000/api/v1)
// and the platform fetch-proxy injects auth. `npm run dev`: no such global, so we
// route through the Vite dev proxy at `/capi` (see vite.config.ts) which injects a
// dev OAuth token. Either way the app just calls `fetch()` normally.

import { retargetQuery } from '../queries/datasets'

declare global {
  interface Window {
    CRIBL_API_URL?: string
    CRIBL_BASE_PATH?: string
    getCriblUser?: () => Promise<CriblUser>
    /** Dev-only: the Cribl UI origin, injected by vite.config.ts so the
     *  "Open in Cribl Search" deep link works during `npm run dev`. */
    __CRIBL_SEARCH_ORIGIN?: string
  }
}

export interface CriblUser {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  initials?: string
}

/** True when running inside the Cribl platform (installed app). */
export const IS_INSTALLED =
  typeof window !== 'undefined' && typeof window.CRIBL_API_URL === 'string' && window.CRIBL_API_URL.length > 0

/** Base for all Cribl API calls. Installed → platform URL; dev → Vite proxy. */
export const API_BASE = IS_INSTALLED ? (window.CRIBL_API_URL as string) : '/capi'

/** Base path the app is mounted at (for the router basename). */
export const BASE_PATH = (typeof window !== 'undefined' && window.CRIBL_BASE_PATH) || undefined

// App version, injected at build time from package.json (see vite.config.ts).
declare const __APP_VERSION__: string
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

// Cribl Search always runs in the dedicated search group.
export const SEARCH_GROUP = 'default_search'
// The Cribl Lake dataset the Gigamon AMI data lands in.
export const LAKE_DATASET = 'gigamon_ami'
// Worker group that holds the Gigamon Stream config (source/pipeline/destination).
export const STREAM_GROUP = 'default'

/**
 * The Lake dataset the app is reading right now: `LAKE_DATASET`, or the pack's
 * sample dataset while the customer's holds no data.
 *
 * STATE, IN A MODULE OF CONSTANTS, ON PURPOSE. Everything that sends a query out
 * of the app — the job body (search.ts), the deep link and the Copilot brief
 * (below) — already imports this module and nothing lower. cribl/datasetTarget.ts
 * owns the decision and is the only caller of `setActiveDataset`; this holds its
 * answer where every exit can read it without importing the decision (which
 * imports search.ts, which imports this). Starts on the customer's dataset,
 * which is what the app did before sample data existed.
 */
let active: string = LAKE_DATASET

/** Only cribl/datasetTarget.ts calls this. */
export function setActiveDataset(dataset: string): void {
  active = dataset
}

/** The dataset queries are being sent to. */
export function activeDataset(): string {
  return active
}

/** A query or brief written against `LAKE_DATASET`, addressed to the active dataset. */
export function toActiveDataset(text: string): string {
  return retargetQuery(text, active)
}

/**
 * Deep link to any Cribl UI page (Stream / Lake / Search), with the same origin
 * handling as searchUiUrl: installed → root-relative so it resolves to the
 * Leader host; dev preview → prefixed with the injected Cribl origin.
 *
 * Path shapes verified against this workspace:
 *   /stream/m/{group}/inputs/{type}/{id}     source config
 *   /stream/m/{group}/pipelines/{id}         pipeline editor
 *   /stream/m/{group}/outputs/{type}/{id}    destination config
 *   /lake/datasets                           Lake dataset list
 */
export function criblUiUrl(path: string): string {
  const origin = (typeof window !== 'undefined' && window.__CRIBL_SEARCH_ORIGIN) || ''
  return `${origin}${path}`
}

/**
 * Deep link that opens Cribl Search's Copilot Investigation with `prompt`
 * already submitted, so the agent starts working on arrival.
 *
 * Verified against this workspace: `/search/agent?q=<prompt>` mints a new
 * session, posts the prompt as the first user message and kicks off the agent
 * (the UI's own "Run Investigation" button does NOT carry a typed prompt across
 * that navigation — this does). No API write and no extra policy grant needed,
 * unlike pre-creating a session via POST /ai/sessions/local_search.
 */
export function criblInvestigateUrl(prompt: string): string {
  const origin = (typeof window !== 'undefined' && window.__CRIBL_SEARCH_ORIGIN) || ''
  // The brief names the dataset in prose and in KQL; both follow the one the
  // numbers came from, or the agent would investigate an empty dataset.
  return `${origin}/search/agent?${new URLSearchParams({ q: toActiveDataset(prompt) }).toString()}`
}

/** Fully-qualified URL for a Cribl Search sub-path, e.g. `/search/jobs`. */
export function searchUrl(path: string): string {
  return `${API_BASE}/m/${SEARCH_GROUP}${path}`
}

/**
 * Build a deep link that opens the Cribl Search UI with `query` pre-filled and
 * auto-run over the given time range. Cribl reads the query from `q` when a job
 * path segment is present, so we mint a placeholder id (it reassigns a real one).
 *
 * Installed: root-relative `/search/...` resolves to the Leader host (open with
 * target="_blank"). Dev preview: prefixed with the injected Cribl origin so it
 * still reaches the real Search UI.
 */
export function searchUiUrl(query: string, earliest: string, latest = 'now'): string {
  const origin = (typeof window !== 'undefined' && window.__CRIBL_SEARCH_ORIGIN) || ''
  const jobId = `link-${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  // The Search UI opens on the dataset the panel actually read — see `toActiveDataset`.
  const params = new URLSearchParams({ q: toActiveDataset(query), et: earliest, lt: latest, tz: 'local' })
  return `${origin}/search/${jobId}?${params.toString()}`
}

export {}
