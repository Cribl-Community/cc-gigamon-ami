# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Gigamon Network Observability" — a **Cribl App Platform app**: a React + TypeScript + Vite SPA that runs inside the Cribl UI (a sandboxed iframe) as a network-observability dashboard. It runs **Cribl Search** (KQL) jobs against the Cribl Lake dataset `gigamon_ami` (Gigamon Application Metadata Intelligence flow records) and renders the results across a set of tabs.

Read **`AGENTS.md`** first — it is the authoritative Cribl App Platform developer guide (fetch proxy, KV store, `proxies.yml`/`policies.yml`, navigation, Capra UI rules, versioning). This file covers what's specific to *this* app.

## Commands

```bash
npm run dev             # Vite dev server on port 5173 (strict) — see dev proxy note below
npm run build           # tsc -b + vite build → dist/
npm test                # vitest run — the whole suite, once
npm run lint            # oxlint (config in .oxlintrc.json)
npm run queries:extract # regenerate src/queries/__frozen__/display.json from src/
npm run preview         # preview the production build
npm run package         # test + build + bundle into build/<name>-<version>.tgz (bumps version)
```

### The gates, and what each one catches

`.github/workflows/ci.yml` runs `npm run lint`, `npm run build` and `npm test` on **every push and
every pull request** — not only at release, because a reviewer needs them red before approving, not
weeks later at publish time. `npm run package` runs the suite *before* it writes the new version, so
a failing test can never leave a bumped `package.json` behind for someone to commit by accident.

Don't count the tests. Know what they hold still:

| Gate | What it catches |
|---|---|
| `src/queries/display-freeze.test.ts` | Any change to a customer-visible KQL string, to the ⓘ prose beside a number, or to **which** query a panel's ⓘ points at. An ⓘ is a factual claim about where a number came from; this is what stops that claim drifting from the query that actually ran. Regenerate deliberately with `npm run queries:extract`, then read the diff. |
| `src/cribl/policyCoverage.test.ts` | Both directions of `config/policies.yml`. A Cribl path the code calls and the file does not declare is a 403 that only non-admins ever see (it has already happened once: `PATCH` on the syslog source). A path the file declares that nothing calls asks an admin to grant more than the app uses. It also fails on anything the app creates but cannot remove, and on an app-scoped `/kvstore/…` path being declared at all. |
| `src/components/gatedWrites.test.ts` | Every `config`-surface write registered in `src/cribl/authz.ts` is reached through a `<GatedControl write="…">`, so a denied write says which object it needed instead of failing silently. |
| `src/app/contrast.test.ts` | Resolves each `token()` chain the way a browser does — through `@capra/theme`'s `base.css`, alpha-compositing the translucent surfaces — and computes the WCAG ratio in both themes. "We fixed the contrast" is a claim that otherwise rots in silence. |
| `npm run build` | Type errors across three TypeScript projects (`tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.test.json` — tests get Node types, app code does not). |
| `npm run lint` | oxlint's default `correctness` set plus `react/rules-of-hooks`. |

The rest of the suite pins behaviour a reader would otherwise have to take on trust: the KV
envelope and its content type, the search cap tiers and the cancel path, the watchdog's
own-jobs-only rule, the confirmation dialog's `aria-describedby` wiring.

**A green run is not an accessibility result.** `happy-dom` implements no sequential focus
navigation and no layout, so a test that presses Tab and asserts focus stayed in the dialog passes
against an empty document. The files that would like to assert focus containment or hit-area size
assert the *mechanism* instead (the dialog portals outside `#root`; `#root` carries `inert`) and
each carries a list at the bottom of what it could not assert and why. Read that list before
claiming an outcome from a passing suite.

*Corrected in PR #4 (2026-09-16), PR #6 (2026-09-16) and PR #7 (2026-09-16). This section used to
say: "There is **no test suite**. `npm run lint` and `npm run build` (type-check) are the
verification gates."*

Versioning happens in `npm run package`: it runs the tests, bumps the version in `package.json`
(patch by default; `-- --minor`, `-- --major`, or `-- --version X.Y.Z`), writes a versioned `.tgz`
to `build/`, prunes to the newest `KEEP_BUNDLES` (default 5), and refreshes `build/<name>-latest.tgz`.

## Runtime environments (critical)

The app runs in two modes, detected in `src/cribl/config.ts`:

- **Installed in Cribl** (`IS_INSTALLED`): `window.CRIBL_API_URL` is set and the platform fetch-proxy injects auth automatically. `API_BASE` = that URL.
- **`npm run dev`**: no platform globals. `API_BASE` = `/capi`, which `vite.config.ts` proxies to the real Cribl API, injecting an OAuth token fetched from the **gitignored `.dev/cribl.json`** client credentials. Without that file the dev proxy is inert (search calls will fail).

Just call `fetch()` normally — never handle auth. All API calls go through `${API_BASE}/...`, and
everything that is not Search goes through `src/cribl/capi.ts`.

**The app-scoped KV store does not work on the localhost dev page.** That proxy rewrites `/capi` →
`/api/v1` without the `/a/{appId}/` scope, and `__dev__<name>` is not a registered app, so every
`/kvstore/…` call 404s. Anything persistent is therefore verifiable only **installed**, or in the
in-UI Live Preview where the platform proxy adds the scope. `src/cribl/kv.ts` keeps a
session-lifetime shadow of refused writes so a developer isn't re-dismissing the same banner all
afternoon — it is not persistence, and `putDoc` answers `false` when only the shadow holds a value.

Key constants in `config.ts`: `SEARCH_GROUP = 'default_search'` (search **always** runs here), `LAKE_DATASET = 'gigamon_ami'`, `STREAM_GROUP = 'default'` (re-exported by `provision.ts` as `DEFAULT_STREAM_GROUP` — the worker group Guided Setup's picker starts on, not the only one it can write to). Deep-link helpers (`searchUiUrl`, `criblInvestigateUrl`, `criblUiUrl`) build root-relative links installed, and prefix `window.__CRIBL_SEARCH_ORIGIN` (dev-injected) in dev preview.

## Architecture

**Data flow: KQL from `src/queries/` → job → poll → NDJSON rows → hook → tab.**

- `src/queries/<tab>.ts` — **every KQL string and query builder the app runs or shows.** They are
  not in the tab files. A panel's ⓘ shows the exact query behind its number, so the string *is* the
  provenance of the figure on screen; `scripts/extract-queries.mjs` regenerates
  `src/queries/__frozen__/display.json` from these modules and `display-freeze.test.ts` diffs it.
  Nothing here may import a `.tsx` or anything that reaches one (`../cribl/useSearch`, `../app/*`,
  `../components/*`), because the extractor loads these modules under plain Node. Static reference
  data that *generates* queries (`FINDINGS`, `TECHNIQUES`, `AI_APPS`) lives in `src/data/` for the
  same reason; the rest of `src/data/` is display reference (`amiFields`, `pqc`).
  *Corrected in PR #4 (2026-09-16). This section used to say each tab "define[s] KQL query constants
  at module scope".*
- `src/cribl/search.ts` — the Search client. `runSearch(query, opts)` POSTs a job to `/m/default_search/search/jobs`, polls `/status` to completion, then reads `/results` (NDJSON: a header line with `totalEventCount`, then one JSON row per line). Retries 429/5xx with backoff. `q(pipeline)` prefixes `dataset="gigamon_ami"` onto a pipeline. `withExecPrefix` prefixes `set max_running_time_per_search=` from the cap tiers, scaled by the window the query reads — **execution only, never in an ⓘ**. A job the cap stops ends `failed` and surfaces as `SearchTimeLimitError`, which panels render as *Search stopped*; `cancelJob` stops an abandoned or over-running job on the server. `runFieldSummaries` uses the `/field-summaries` endpoint. **KQL reminders live in the header comment** — e.g. use `count_distinct()`/`dcount()` not `dc()`, `sort by <col> desc`.
- `src/cribl/capi.ts` — one transport for every Cribl call that is *not* Search: `capi(method, path, body, init)` answers with `{ status, body }` rather than throwing, because its callers read the status as data (a 404 from provisioning means "not created yet"; a 404 from the KV store means "nobody has written this key"). Search keeps its own client on purpose — retry-on-429, cancellation and abort semantics are the product there, and bolting them onto a provisioning call would retry writes.
- `src/cribl/useSearch.ts` — the `useSearch(query, opts)` hook every tab uses. Re-runs when the query text, the global time range, the global refresh nonce, per-panel refetch, or `deps` change; aborts stale requests via `AbortController` + a request-id guard, and cancels the abandoned job server-side. **A hook that pins its own `earliest` opts out of the global range and of auto-refresh ticks** — only an explicit refresh re-runs it. Data Flow's 30-day tile, the most expensive query in the app, used to re-run on every range change that could not affect it.
- `src/cribl/inflight.ts` — a `useSyncExternalStore` counter of in-flight queries, incremented inside `runSearch`/`runFieldSummaries` (not in the hook), so the header spinner reflects *all* callers.
- `src/app/DashboardContext.tsx` — global `range` (time window) + `refreshNonce` + `manualRefreshNonce` + auto-refresh interval. `refresh()` bumps the nonces to re-run every query at once. Sub-minute refresh intervals are **not** offered; `WITHHELD_REFRESH_SECONDS` feeds the ⓘ that explains why.

**UI shell:** `src/main.tsx` mounts `<BrowserRouter basename={BASE_PATH}>` → `DashboardProvider` → `App` + `<ToastProvider/>`, and fires `loadSearchCaps()` unawaited (a read; never blocks first paint). `src/App.tsx` defines the `TABS` array (route + label + element) — **adding a tab means adding one entry here** — and hosts the one page-level banner slot (`<AppBanners/>`, below the tab bar, severity-ordered) and the long-running-search indicator. Each tab lives in `src/tabs/*.tsx` and follows the same shape: import its queries from `src/queries/<tab>.ts`, call `useSearch`, render `KpiTile` rows + `Panel`s wrapped in `<QueryBoundary>`, and offer row/tile drill-downs that `window.open(searchUiUrl(...))` into the real Cribl Search UI.

Shared building blocks are in `src/components/`. Use the existing one rather than a thirteenth
variant of it:

| Need | Component |
|---|---|
| A state shown as a word | `<StatusPill>` — one `{present\|absent\|failed\|paused\|…} → Capra Pill` map. Every state keeps its word and adds a glyph; colour is never the only signal. |
| Something the reader must act on or dismiss | `<AppBanners>` (page-level, below the tab bar) or a status strip inside the section. Three treatments exist — banner, status strip, toast — and a fourth idea is a panel. |
| "It worked" / "it failed" | `pushToast(phase)` → Capra `Toast`. Error toasts do not auto-dismiss. |
| A confirmation before a write | `<ConfirmDialog>` on Capra `Modal` — see the conventions below. |
| A control the user may not be allowed to use | `<GatedControl write="…">` — renders `aria-disabled` (still focusable) with the reason as visible text, never the HTML `disabled` attribute and never a bare `title=`. |
| Provisioning chrome (rows, status, actions) | `<ProvisionPanel>` |
| Charts and layout | `Panel`, `KpiTile`, `QueryBoundary`, `BarList`, `Donut`, `Heatmap`, `TimeChart`, `DopDiagram` |
| The ⓘ beside a number | `<PanelInfo>` / `<InfoTip>` |

Formatting helpers are in `src/lib/format.ts`.

**Guided Setup / provisioning** (`src/cribl/provision.ts`, `src/tabs/GuidedSetup.tsx`, `src/components/ProvisionPanel.tsx`): the one place the app writes **Cribl configuration**. It idempotently and additively provisions a real Gigamon AMI syslog onboarding stack (Syslog source → parse/normalize pipeline → route → Cribl Lake dataset) in a worker group the user picks, then commits + deploys. It never edits the demo DataGen source or existing shared resources; the route is prepended above the catch-all with a source-scoped filter. `removeSyslogStack` tears down only what it added — not the Lake dataset (it holds the customer's ingested data) and not the `gigamon_lake` destination (it usually pre-existed). Both Deploy and Remove go through one `<ConfirmDialog>` naming the objects. The tab also hosts `<SearchLimitsPanel>`, the install-wide search running-time settings.

**Dataset intelligence** (`src/cribl/datasetIntel.ts`): reads/generates the Cribl Search AI schema summary for `gigamon_ami` so the Copilot agent doesn't rediscover the ~319-field schema each investigation. GET 404 = "never generated" (normal), POST kicks off async generation, poll GET until complete. The offer surfaces as a dismissible app-level banner, so it reaches an admin who never opens Findings.

**Hang control** (`src/cribl/jobWatchdog.ts`, `src/components/JobWatchdog.tsx`): every query this app submits carries a running-time cap and is cancelled when abandoned, so a job *this app started* should already be dead. The watchdog is for the other two populations — jobs the cap did not stop, and searches this app never submitted (deep links, Copilot, ad-hoc investigation). It reads `GET /m/default_search/search/jobs`, which is a config-plane read: it bills nothing and **creates no job**. The `dataset="$vt_jobs"` polling search it was specified as would have done both — measured at ~2.5 billable CPU-s a poll, and adding roughly 288 jobs/day per open session to a search history that holds 1,000. A watchdog that evicts the history you'd investigate the thing it found with is not a watchdog. It **lists** every long-running search of `gigamon_ami` the account can see, and offers **Cancel only on the signed-in user's own**, behind `<GatedControl>` and a `<ConfirmDialog>` naming the job id and its age. Never cancels on a render or a timer.

## App-specific conventions

- **The dashboards are read-only against Search data: they submit Cribl Search jobs and read the
  results. The app does write, in four places, and each is deliberate.** (1) Guided Setup
  provisioning — Stream config, a Git commit on the Leader, and a deploy that restarts that group's
  Worker Processes. (2) The app-scoped Cribl KV store — per-viewer preferences (`app/prefs/<userId>`),
  the install-wide search-cap table (`app/settings/search_caps`), Guided Setup's commit memory and
  per-viewer group pick, and an append-only audit trail (`gigamon/log/<epochMs>`). (3) `POST` to
  Cribl's dataset-intelligence endpoint, from the banner's Generate button. (4) `POST …/cancel` on a
  search job — this session's own abandoned or over-running job, and, from the watchdog, a
  long-running job **belonging to the signed-in user**.
  **The rule that actually matters: nothing writes on load, on render, or on a timer.** A corrupt KV
  value is read as absent and deliberately *not* repaired, because the repair would be a write on
  load. Per `AGENTS.md`, any new DELETE or overwriting PUT/POST/PATCH must be behind an explicit user
  confirmation that names the affected resource — use `<ConfirmDialog>`, and register the write in
  `src/cribl/authz.ts` so `gatedWrites.test.ts` can see it.
  *Corrected in PR #5 (2026-09-16), PR #9 (2026-09-16), PR #10 (2026-09-16) and slice 1.8 (branch
  `feat/phase-1.8-hang-control`, 2026-09-17). This bullet used to say: "**This app is read-only
  against Search data.** The only writes are in Guided Setup provisioning, which are deliberate,
  idempotent, and user-triggered."*
- **Persistence:** go through `src/cribl/kv.ts` — never `localStorage`/`sessionStorage`/`IndexedDB`/cookies (unreliable in the sandbox, and never shared across users, devices or sessions). Documents are PUT as **`text/plain`**: given a JSON content type the store parses the body, persists the literal `[object Object]`, and still answers 200. Key shapes: `app/settings/<name>` install-wide, `<ns>/prefs/<userId>` per user, `<ns>/log/<epochMs>` append-only. One writer per document — `prefs.ts` rewrites its whole document on every flag change, so a second writer's field would be dropped. Theme is the one client-side exception, a per-device display preference in `src/app/theme.ts`.
- **UI:** use the Capra design system (`@capra/core`, `@capra/icons`, `@capra/theme`). In CSS reference design tokens via the `token()` function, never raw CSS variables — and check what a token resolves to: `border.default` is the *shorthand* `1px solid var(…)`, not a colour, which is why 55 sites once shipped `1px solid 1px solid #cdced6` — invalid at computed-value time, so `border-style` computed to `none` and the app rendered **no borders at all**. Use `--gm-border`, which is `color.border.neutral.default`. Spacing and font sizes come from the `--gm-sp-*` / `--gm-fs-*` scales at the top of `src/App.css`; a bare px in a padding, margin, gap or font-size is a missing *step*, not a shortcut — add the step, with a line saying what forced it. Don't attach classes to Capra components or depend on their internals; do spacing with wrappers. Capra's `Modal` gives you the role, the label, the portal, the `inert` app root and Escape — it does **not** give you initial focus or `aria-describedby`; `<ConfirmDialog>` supplies both, so build on it rather than on `Modal` directly.
- **New external domains** must be declared in `config/proxies.yml`; **every Cribl product API path the app calls** must be declared in `config/policies.yml` and mirrored in `src/cribl/paths.ts`, with the reason written beside it. That file is not documentation — it is a *grant*, given to every user an admin shares the app with, so a missing entry is a 403 and an extra entry is asking for trust the app does not need. **Declare no wildcards**: `AGENTS.md` never defines whether `*` matches one path segment or many, so every object names each segment it needs and uses `:name` for a variable one. `policyCoverage.test.ts` enforces both directions. Editing these or `package.json` during `npm run dev` hot-reloads the app.
  *Corrected in PR #6 (2026-09-16). This bullet used to say `policies.yml` held "currently only
  search-job and AI/dataset-intelligence paths". It now declares the Guided Setup Stream writes and
  deletes, the Git commit and deploy paths, and the job-list, cancel and metrics reads as well —
  read the file, don't trust a count written here.*
- The default route redirects to `/service-map`; unknown routes fall back there too.
