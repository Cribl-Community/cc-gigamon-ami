# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Gigamon NPM" — a **Cribl App Platform app**: a React + TypeScript + Vite SPA that runs inside the Cribl UI (a sandboxed iframe) as a network-performance-monitoring dashboard. It runs **Cribl Search** (KQL) jobs against the Cribl Lake dataset `gigamon_ami` (Gigamon Application Metadata Intelligence flow records) and renders the results across a set of tabs.

Read **`AGENTS.md`** first — it is the authoritative Cribl App Platform developer guide (fetch proxy, KV store, `proxies.yml`/`policies.yml`, navigation, Capra UI rules, versioning). This file covers what's specific to *this* app.

## Commands

```bash
npm run dev       # Vite dev server on port 5173 (strict) — see dev proxy note below
npm run build     # tsc -b + vite build → dist/
npm run lint      # oxlint (config in .oxlintrc.json)
npm run preview   # preview the production build
npm run package   # build + bundle into build/<name>-<version>.tgz (bumps version)
```

There is **no test suite**. `npm run lint` and `npm run build` (type-check) are the verification gates.

Versioning happens in `npm run package`: it bumps the version in `package.json` (patch by default; `-- --minor`, `-- --major`, or `-- --version X.Y.Z`), writes a versioned `.tgz` to `build/`, prunes to the newest `KEEP_BUNDLES` (default 5), and refreshes `build/<name>-latest.tgz`.

## Runtime environments (critical)

The app runs in two modes, detected in `src/cribl/config.ts`:

- **Installed in Cribl** (`IS_INSTALLED`): `window.CRIBL_API_URL` is set and the platform fetch-proxy injects auth automatically. `API_BASE` = that URL.
- **`npm run dev`**: no platform globals. `API_BASE` = `/capi`, which `vite.config.ts` proxies to the real Cribl API, injecting an OAuth token fetched from the **gitignored `.dev/cribl.json`** client credentials. Without that file the dev proxy is inert (search calls will fail).

Just call `fetch()` normally — never handle auth. All API calls go through `${API_BASE}/...`.

Key constants in `config.ts`: `SEARCH_GROUP = 'default_search'` (search **always** runs here), `LAKE_DATASET = 'gigamon_ami'`, `STREAM_GROUP = 'default'` (holds the Stream config). Deep-link helpers (`searchUiUrl`, `criblInvestigateUrl`, `criblUiUrl`) build root-relative links installed, and prefix `window.__CRIBL_SEARCH_ORIGIN` (dev-injected) in dev preview.

## Architecture

**Data flow: KQL → job → poll → NDJSON rows → hook → tab.**

- `src/cribl/search.ts` — the Search client. `runSearch(query, opts)` POSTs a job to `/m/default_search/search/jobs`, polls `/status` to completion, then reads `/results` (NDJSON: a header line with `totalEventCount`, then one JSON row per line). Retries 429/5xx with backoff. `q(pipeline)` prefixes `dataset="gigamon_ami"` onto a pipeline. `runFieldSummaries` uses the `/field-summaries` endpoint. **KQL reminders live in the header comment** — e.g. use `count_distinct()`/`dcount()` not `dc()`, `sort by <col> desc`.
- `src/cribl/useSearch.ts` — the `useSearch(query, opts)` hook every tab uses. Re-runs when the query text, the global time range, the global refresh nonce, per-panel refetch, or `deps` change; aborts stale requests via `AbortController` + a request-id guard.
- `src/cribl/inflight.ts` — a `useSyncExternalStore` counter of in-flight queries, incremented inside `runSearch`/`runFieldSummaries` (not in the hook), so the header spinner reflects *all* callers.
- `src/app/DashboardContext.tsx` — global `range` (time window) + `refreshNonce` + auto-refresh interval. `refresh()` bumps the nonce to re-run every query at once.

**UI shell:** `src/main.tsx` mounts `<BrowserRouter basename={BASE_PATH}>` → `DashboardProvider` → `App`. `src/App.tsx` defines the `TABS` array (route + label + element) — **adding a tab means adding one entry here**. Each tab lives in `src/tabs/*.tsx` and follows the same shape: define KQL query constants at module scope, call `useSearch`, render `KpiTile` rows + `Panel`s wrapped in `<QueryBoundary>`, and offer row/tile drill-downs that `window.open(searchUiUrl(...))` into the real Cribl Search UI. Shared building blocks are in `src/components/` (`Panel`, `KpiTile`, `QueryBoundary`, `BarList`, `Donut`, `Heatmap`, `TimeChart`, …); formatting helpers in `src/lib/format.ts`; static reference data in `src/data/`.

**Guided Setup / provisioning** (`src/cribl/provision.ts`, `src/tabs/GuidedSetup.tsx`): the one place the app **writes** Cribl config. It idempotently and additively provisions a real Gigamon AMI syslog onboarding stack (Syslog source → parse/normalize pipeline → route → Cribl Lake dataset) in the `default` Stream group, then commits + deploys. It never edits the demo DataGen source or existing shared resources; the route is prepended above the catch-all with a source-scoped filter. `removeSyslogStack` tears down only what it added.

**Dataset intelligence** (`src/cribl/datasetIntel.ts`): reads/generates the Cribl Search AI schema summary for `gigamon_ami` so the Copilot agent doesn't rediscover the ~319-field schema each investigation. GET 404 = "never generated" (normal), POST kicks off async generation, poll GET until complete.

## App-specific conventions

- **This app is read-only against Search data.** The only writes are in Guided Setup provisioning, which are deliberate, idempotent, and user-triggered. Per `AGENTS.md`, any new DELETE / overwriting PUT/POST/PATCH must be behind an explicit user confirmation that names the affected resource — never on load/render/timer.
- **Persistence:** use the app-scoped Cribl KV store (via `CRIBL_API_URL`), never `localStorage`/`sessionStorage`/`IndexedDB`/cookies (unreliable in the sandbox). Theme is the current exception, stored client-side in `src/app/theme.ts`.
- **UI:** use the Capra design system (`@capra/core`, `@capra/icons`, `@capra/theme`). In CSS reference design tokens via the `token()` function, never raw CSS variables. Don't attach classes to Capra components or depend on their internals; do spacing with wrappers.
- **New external domains** must be declared in `config/proxies.yml`; **new Cribl product API paths** the app calls must be declared in `config/policies.yml` (currently only search-job and AI/dataset-intelligence paths). Editing these or `package.json` during `npm run dev` hot-reloads the app.
- The default route redirects to `/service-map`; unknown routes fall back there too.
