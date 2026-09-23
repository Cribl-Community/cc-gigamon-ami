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
| `src/cribl/policyCoverage.test.ts` | Both directions of `config/policies.yml`. A Cribl path the code calls and the file does not declare is a 403 that only non-admins ever see (it has already happened once: `PATCH` on the syslog source). A path the file declares that nothing calls asks an admin to grant more than the app uses. It also fails on anything the app creates but cannot remove, on an app-scoped `/kvstore/…` path being declared at all, on a `*` in any path or method (the no-wildcard rule below), and on a module outside the four transports reaching the network — a raw `fetch` anywhere else is a call the coverage scan cannot see, so it would not be checked against the grant at all. `src/cribl/paths.ts` is held to the same two directions, plus a reason on every entry. |
| `src/components/gatedWrites.test.ts` | Every `config`-surface write registered in `src/cribl/authz.ts` is reached through a `<GatedControl write="…">`, so a denied write says which object it needed instead of failing silently. |
| `src/app/contrast.test.ts` | Resolves each `token()` chain the way a browser does — through `@capra/theme`'s `base.css`, alpha-compositing the translucent surfaces — and computes the WCAG ratio in both themes. "We fixed the contrast" is a claim that otherwise rots in silence. |
| `npm run build` | Type errors across three TypeScript projects (`tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.test.json` — tests get Node types, app code does not). |
| `npm run lint` | oxlint's default `correctness` set plus `react/rules-of-hooks`. |

The rest of the suite pins behaviour a reader would otherwise have to take on trust: the KV
envelope and its content type, the search cap tiers and the cancel path, the watchdog's
own-jobs-only rule, the confirmation dialog's `aria-describedby` wiring, and — for acceleration —
that a `PATCH` sends the whole body back, that a stored result is never returned undated, and that a
`DELETE` needs both ownership signals.

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
  same reason; the rest of `src/data/` is display reference (`amiFields`, `pqc`) and **client-side
  classifiers** (`SAAS_APPS`) — a list that appears in no query string but decides which rows land
  in a panel. The extractor's own word for why the third kind belongs here is the `catalogs` bucket:
  *"data that moves a number without ever appearing in a query string"*. **Export them as arrays,
  never as `Set`s** — the digest is `JSON.stringify(value)`, every `Set` stringifies to `"{}"`, so a
  `Set` here freezes to a constant that an empty one would also produce, and the gate is dead while
  still looking live. Build the `Set` in the tab, as `ShadowAi.tsx` does.
  *Corrected in PR #4 (2026-09-16). This section used to say each tab "define[s] KQL query constants
  at module scope".*
- `src/cribl/search.ts` — the Search client. `runSearch(query, opts)` POSTs a job to `/m/default_search/search/jobs`, polls `/status` to completion, then reads `/results` (NDJSON: a header line with `totalEventCount`, then one JSON row per line). Retries 429/5xx with backoff. `q(pipeline)` prefixes `dataset="gigamon_ami"` onto a pipeline. `withExecPrefix` prefixes `set max_running_time_per_search=` from the cap tiers, scaled by the window the query reads — **execution only, never in an ⓘ**. It also prefixes `set allow_previous_results="2min"` (`REUSE_WINDOW`) when the caller passes `reuse` — measured 30.92 s → 0.95 s and zero billed on a repeat of the same query at the same relative range (A-SP21), matched on the *relative* range spec. It is off by default, and refused outright on a `$vt_results` read (A-D15), so a caller that submits a job to measure something still measures. Job status is polled on a ramp (`POLL_RAMP_MS`: 100 ms rising to a 1.5 s ceiling), not the flat 700 ms it used to be. A job the cap stops ends `failed` and surfaces as `SearchTimeLimitError`, which panels render as *Search stopped*; `cancelJob` stops an abandoned or over-running job on the server. `runFieldSummaries` uses the `/field-summaries` endpoint. **KQL reminders live in the header comment** — e.g. use `count_distinct()`/`dcount()` not `dc()`, `sort by <col> desc`.
- `src/cribl/capi.ts` — one transport for every Cribl call that is *not* Search: `capi(method, path, body, init)` answers with `{ status, body }` rather than throwing, because its callers read the status as data (a 404 from provisioning means "not created yet"; a 404 from the KV store means "nobody has written this key"). Search keeps its own client on purpose — retry-on-429, cancellation and abort semantics are the product there, and bolting them onto a provisioning call would retry writes.
- `src/cribl/useSearch.ts` — the `useSearch(query, opts)` hook every tab uses. Re-runs when the query text, the global time range, the global refresh nonce, per-panel refetch, or `deps` change; aborts stale requests via `AbortController` + a request-id guard, and cancels the abandoned job server-side. **A hook that pins its own `earliest` opts out of the global range and of auto-refresh ticks** — only an explicit refresh re-runs it. Data Flow's 30-day tile, the most expensive query in the app, used to re-run on every range change that could not affect it. A panel may also name a scheduled search (`accel`), in which case the hook asks `src/cribl/accel/read.ts` for that schedule's stored result and only runs the query live when the read cannot answer — see **Acceleration** below. It also takes `deferred`, set by `useNearViewport()` in `src/components/nearViewport.ts` for a panel below the fold: concurrent jobs from one user are admitted ~1.6 s apart, so a tab firing six on mount does not start its sixth for ~8 s, and holding the below-the-fold ones back is the only lever on that. A deferred hook reports `loading`, never an empty result — `enabled: false` ("nothing is selected") and `deferred` ("not asked yet") are deliberately different states. Every submit from this hook also carries `set allow_previous_results` (see `search.ts`) unless the viewer asked for fresh data.
- `src/cribl/inflight.ts` — a `useSyncExternalStore` counter of in-flight queries, incremented inside `runSearch`/`runFieldSummaries` (not in the hook), so the header spinner reflects *all* callers.
- `src/app/DashboardContext.tsx` — global `range` (time window) + `refreshNonce` + `manualRefreshNonce` + auto-refresh interval. `refresh()` bumps the nonces to re-run every query at once. Sub-minute refresh intervals are **not** offered; `WITHHELD_REFRESH_SECONDS` feeds the ⓘ that explains why.

**UI shell:** `src/main.tsx` mounts `<BrowserRouter basename={BASE_PATH}>` → `DashboardProvider` → `App` + `<ToastProvider/>`, fires `loadSearchCaps()` unawaited (a read; never blocks first paint), and fires `prefetchRunHistory()` (`src/cribl/accel/status.ts`) — config-plane GETs of the small head run-history page and of each entry that runs less often than hourly, so accelerated panels are not waiting on the history when they mount. Both bill nothing and write nothing; the prefetch also fires in Live mode, where it is one small unused request. `src/App.tsx` defines the `TABS` array (route + label + element) — **adding a tab means adding one entry here** — and hosts the one page-level banner slot (`<AppBanners/>`, below the tab bar, severity-ordered) and the long-running-search indicator. Each tab lives in `src/tabs/*.tsx` and follows the same shape: import its queries from `src/queries/<tab>.ts`, call `useSearch`, render `KpiTile` rows + `Panel`s wrapped in `<QueryBoundary>`, and offer row/tile drill-downs that `window.open(searchUiUrl(...))` into the real Cribl Search UI.

Shared building blocks are in `src/components/`. Use the existing one rather than a thirteenth
variant of it:

| Need | Component |
|---|---|
| A state shown as a word | `<StatusPill>` — one `{present\|absent\|failed\|paused\|…} → Capra Pill` map. Every state keeps its word and adds a glyph; colour is never the only signal. |
| Something the reader must act on or dismiss | `<AppBanners>` (page-level, below the tab bar) or a status strip inside the section. Three treatments exist — banner, status strip, toast — and a fourth idea is a panel. |
| "It worked" / "it failed" | `pushToast(phase)` → Capra `Toast`. Error toasts do not auto-dismiss. |
| A confirmation before a write | `<ConfirmDialog>` on Capra `Modal` — see the conventions below. |
| The before→after inside that confirmation | `<DiffTable>` — pass `ConfirmDialog`'s `diff` prop, which is structured (`{resourceId, key, before, after}[]`), never a node. `diff: []` is a real state and renders *"nothing changes"*; omitting `diff` is a different thing. The change word is **derived** by `diffState()`, so a caller cannot label a removal `added`. |
| A control the user may not be allowed to use | `<GatedControl write="…">` — renders `aria-disabled` (still focusable) with the reason as visible text, never the HTML `disabled` attribute and never a bare `title=`. |
| Provisioning chrome (rows, status, actions) | `<ProvisionPanel>` |
| Charts and layout | `Panel`, `KpiTile`, `QueryBoundary`, `BarList`, `Donut`, `Heatmap`, `TimeChart`, `DopDiagram` |
| The ⓘ beside a number | `<PanelInfo>` / `<InfoTip>` |

Formatting helpers are in `src/lib/format.ts`.

**Guided Setup / provisioning** (`src/cribl/provision.ts`, `src/tabs/GuidedSetup.tsx`, `src/components/ProvisionPanel.tsx`): one of the **two** places the app writes **Cribl configuration** (the other is acceleration, below). It idempotently and additively provisions a real Gigamon AMI syslog onboarding stack (Syslog source → parse/normalize pipeline → route → Cribl Lake dataset) in a worker group the user picks, then commits + deploys. It never edits the demo DataGen source or existing shared resources; the route is prepended above the catch-all with a source-scoped filter. `removeSyslogStack` tears down only what it added — not the Lake dataset (it holds the customer's ingested data) and not the `gigamon_lake` destination (it usually pre-existed). Both Deploy and Remove go through one `<ConfirmDialog>` naming the objects. The tab also hosts `<SearchLimitsPanel>`, the install-wide search running-time settings, and `<AccelPanel>`, below.

**Acceleration** (`src/cribl/accel/*`, `src/components/AccelPanel.tsx`, `src/components/accelPanelCopy.ts`): the second place the app writes **Cribl configuration**, and the only one whose effect keeps costing money after the click. Two panels stopped running their query live and read a scheduled run's stored result instead — `dataset="$vt_results" jobName="…"`, measured at **0.2 billable CPU-s against 127 live**. The subsystem is six modules, and the split is the point:

- `manifest.ts` — **the list is the object.** **Eighteen** entries serving **33** panel records: the two Phase 2 entries (`gno_lake_30d_c1d` on `10 0 * * *` — **whose window is the `gigamon_ami` dataset's actual retention, not 30 days**: `src/queries/lakeWindow.ts` picks the window from the Lake API and the method from how it compares with `cribl_metrics`' own retention — Stream's write counters while they cover it, a direct count of the dataset past it (measured 2026-09-23: 525 s for 30 days, so it only runs where it must). `readAccelState` resolves the manifest against that window (`resolveEntry`), so a retention change reads as drift — "the window it reads" — and Re-apply writes the new one; the card states the window its own stored run read, and the size is the Lake API's dated on-disk figure, not bytes written. The id keeps its `30d` so stored runs and this app's write record survive; `gno_sample_2m_c1h`, whose window is `-5m…-3m` because the Lake landing profile holds a file open for 120 s and the old `-4m…-2m` sampled data that had not arrived), plus sixteen hourly snapshots with `keepLastN: 24` — `gno_overview_c1h` (one scan for the Capacity, Web, Security, Findings and Data Flow opening tiles), `gno_svc_nodes_c1h`, `gno_svc_edges_c1h`, `gno_presence_c1h`, `gno_app_src_c1h`, `gno_dns_resolver_c1h` (the resolver table only — it stored all 12,153 resolvers, 1.3 MB, until the 2026-09-23 split), `gno_dns_overall_c1h` (the DNS tiles, `OVERALL` itself), `gno_pipeline_c1h`, `gno_web_host_c1h`, `gno_web_code_c1h`, `gno_web_trend_c1h`, `gno_web_h2_c1h`, `gno_tcp_subnet24_c1h`, `gno_tcp_subnet16_c1h`, `gno_app_l4_c1h` and `gno_talkers_src_c1h` (Capacity's default source-IP bar list, which was the tab's one live panel). **Don't trust that count either — `grep -c '  entry({' src/cribl/accel/manifest.ts` is the answer, and `manifest.test.ts` pins the literal list in order.** *(This sentence said "Five records now" until 2026-09-22, eleven entries after that stopped being true; the number is the thing in this file most likely to be stale.)*

  **Coverage, measured 2026-09-22:** of **34** `useSearch` call sites, **23** are accelerated and **11** run live, plus two panels that read a snapshot without `useSearch` at all (`FieldExplorer.tsx` calls `readAccelFieldSummaries`/`readAccelRows` directly). Two things make "served" conditional even on an accelerated panel: **Live mode reads no snapshot, by design** (`useSearch.ts` — `snapshotServed` requires `mode === 'snapshot'`) — **with one opt-in exception, `snapshotInLive`, used only by Data Flow's Lake card**: a retention total that live re-scanned for 33.5 s on every Refresh to move by minutes of data (measured 2026-09-23); it reads the daily run in both modes, dated, and is left out of the Live price. *(Corrected 2026-09-23. This sentence used to say "Live mode reads no snapshot at all".)* Also, four of Capacity's sites carry `accelEnabled: applied === ''` so they drop to live the moment a filter is typed. Apply, teardown, status and the read path all iterate it, so a new entry is one record rather than five hand-kept lists. **The bodies are imported from `src/queries/*`, never retyped** — a panel's ⓘ stays truthful only while the thing that ran *is* the string the ⓘ shows; the union bodies in `src/queries/snapshots.ts` are composed from the same exported aggregate fragments the panels' own queries are built from. The dependency points one way: `src/queries/*` must not import this.

  **`display === body` is gone, deliberately.** One scan serving five panels cannot satisfy it. `serves` is now `panels: AccelServed[]` — `{ queryId, what, display, tail, reads }` — the display digest covers all of it (tails included, which nothing digested before), and `manifest.test.ts` walks body → tail → the columns the panel reads with `columnsOf`. That is strictly more than the old line checked. What it still cannot check is that a shared alias MEANS the same thing in both places; that argument is prose in `src/queries/snapshots.ts`, and it is why the body defines `findings_total` rather than a second `total`.
- `selection.ts` — which past state the app is showing (`useSyncExternalStore`, like `dataMode.ts`). Null means "follow the newest run". **Not persisted, and dropped when the mode goes Live**: a stored moment would come back the next morning as a silent claim about the present, and a moment kept while the range picker is on screen is state nothing mentions.
- `provision.ts` — the four entry points that write (`applyAcceleration`, `pauseAcceleration`, `resumeAcceleration`, `removeAcceleration`), each reached from a confirmed click and nowhere else. **Every `PATCH` is a read-modify-write of the whole body**: A-SP23 measured that this endpoint deletes any field a `PATCH` omits, which silently unschedules a search forever and returns 200. `applyPlan()`/`removalPlan()` hand the dialog the sentences it needs, including what will deliberately be left alone.
- `read.ts` — the stored-result read. Never returns a result it cannot date, because the panel is required to say "as of HH:MM" and the label is the whole safety argument; a **stale** result comes back flagged rather than replaced, since falling back to live on staleness reinstates the 9,297 CPU-s query at the exact moment the schedule breaks. Tries the run id, then the display name, before believing `diagnose()`. No Cribl error text reaches a returned string. **`asOf` reads one named past run by `jobId`, and is the one path here that never falls back to live** — the live query answers about now, the panel would be headed 04:20, and a panel with no run from that moment shows nothing plus its `nearestAt` instead.
- `status.ts` — also owns the timeline: `snapshotTimeline()`, `runAtOrBefore()` (**at or before, never the nearest** — a run that finished at 09:20 did not exist at 08:40), `nearestRun()` and `timelineHorizon()`, which says whether `keepLastN × cadence` or Cribl's 7-day result retention is what ends the list.
- `status.ts` — whether a schedule is *still* firing, from `GET /search/jobs` (config-plane: no search submitted, nothing billed). Never throws; **read `error` before `runs.length`**, because a refusal and "never ran" both produce zero rows. **The history is read at three sizes** (2026-09-23): a panel's newest run comes from a 48-row *head* page (`listRuns(id, { newest: true })`); an entry the head page does not reach, or one that runs less often than hourly, gets its own server-filtered page (`filterExp` `id.startsWith('<entry>.')`); the snapshot picker, the status table and a picked moment read the full 405-row page. An empty filtered page is never trusted (the endpoint answers 200 with no rows for a filter it cannot evaluate), an HTTP error on it falls through to the full page, and a timeout on any small page is answered as a failure rather than waited out twice. Measured in the browser: the history read left every accelerated panel's critical path — Flow Map 1.63–2.02 s → 1.27 s.
- `store.ts` — what this install wrote, in the app-scoped KV store; the second of the two ownership signals the teardown needs (the first is the `GNO …` stamp in the object's own description). Writes are serialised and re-read inside the turn, which is the `prefs.ts` bug not repeated.
- `estimate.ts` — the savings figures, and **nothing here returns a bare number**: every estimate carries its band, its basis and the sentence the UI must render beside it, because a screenshot of a bare number ends up in a procurement conversation.

**Dataset intelligence** (`src/cribl/datasetIntel.ts`): reads/generates the Cribl Search AI schema summary for `gigamon_ami` so the Copilot agent doesn't rediscover the ~319-field schema each investigation. GET 404 = "never generated" (normal), POST kicks off async generation, poll GET until complete. The offer surfaces as a dismissible app-level banner, so it reaches an admin who never opens Findings.

**Snapshot / Live, and the snapshot timeline** (`src/cribl/dataMode.ts`, `src/cribl/accel/mode.ts`, `src/cribl/accel/selection.ts`, `src/components/ModeToggle.tsx`, `src/components/SnapshotPicker.tsx`): the header carries a two-segment `Snapshot` / `Live` group, defaulting to Snapshot, with the viewer's `Live` choice expiring at local midnight. **In Snapshot mode the range picker is replaced by the snapshot picker**, not joined by it — one time control, two meanings, because a `$vt_results` read ignores the range picker entirely and a control that changes nothing is worse than one that is absent. The picker's options are real runs read from the job history, and the line under it says how far back the list goes and how many entry sets have a run from the moment picked, because the schedules do not align. A tab forwards `useSearch`'s `{ source, outcome, at, stale, nearestAt }` to `<Panel snapshot>`; `mergeSnapshotStates()` reduces a multi-hook card to the worst of its parts, so a graph half from 04:20 and half from now is impossible to render as normal.

**Hang control** (`src/cribl/jobWatchdog.ts`, `src/components/JobWatchdog.tsx`): every query this app submits carries a running-time cap and is cancelled when abandoned, so a job *this app started* should already be dead. The watchdog is for the other two populations — jobs the cap did not stop, and searches this app never submitted (deep links, Copilot, ad-hoc investigation). It reads `GET /m/default_search/search/jobs`, which is a config-plane read: it bills nothing and **creates no job**. The `dataset="$vt_jobs"` polling search it was specified as would have done both — measured at ~2.5 billable CPU-s a poll, and adding roughly 288 jobs/day per open session to a search history that holds 1,000. A watchdog that evicts the history you'd investigate the thing it found with is not a watchdog. It **lists** every long-running search of `gigamon_ami` the account can see, and offers **Cancel only on the signed-in user's own**, behind `<GatedControl>` and a `<ConfirmDialog>` naming the job id and its age. Never cancels on a render or a timer.

## App-specific conventions

- **The dashboards are read-only against Search data: they submit Cribl Search jobs and read the
  results. The app does write, in six places, and each is deliberate.** (1) Guided Setup
  provisioning — Stream config, a Git commit on the Leader, and a deploy that restarts that group's
  Worker Processes. (2) **Scheduled saved searches** — `POST`/`PATCH`/`DELETE` on
  `/m/default_search/search/saved[/:id]`, from the Acceleration panel's confirmed Apply, Pause,
  Resume and Remove. Only the fixed ids in `src/cribl/accel/manifest.ts`, and `DELETE` only where
  the id is in that manifest *and* carries this app's own stamp. This is the one write that keeps
  costing money after the click, and uninstalling the app does not stop it (I-D28) — the Remove
  button is the only off switch. (3) **Guided Setup's "How data lands in Cribl Lake" panel** — a
  second panel on the same page (`src/components/LakeLandingPanel.tsx`): `PATCH` on the live
  `gigamon_ami` Lake dataset for retention and description, `PATCH` on the live `gigamon_lake`
  destination, and the Git commit and deploy that make the second one real. It holds the app's only
  **irreversible** write: a retention *decrease* deletes data, and a Lake dataset is in no version
  control, so there is no commit to revert. That one dialog is deliberately harder than the others
  (`irreversible.why`, the tenant's own size and metrics date, type-to-confirm on the dataset id);
  an *increase* gets `undo` and no type-to-confirm, and if the two ever look the same the label has
  become decoration. The Search-reader (v1→v2) toggle and the partitions editor are **deliberately
  not built** — they are gated on spikes P-S5/P-S7/P-S9, and `SPIKE_GATED` in `src/cribl/landing.ts`
  is the single source of the sentence each read-only row shows instead. (4) The app-scoped Cribl KV store — per-viewer preferences
  (`app/prefs/<userId>`, `accel/prefs/<userId>`), the install-wide search-cap table
  (`app/settings/search_caps`), Guided Setup's commit memory and per-viewer group pick, what this
  install wrote to `/search/saved` (`accel/state`), and append-only audit trails
  (`gigamon/log/<epochMs>`, `accel/log/<epochMs>`), and the Lake landing profile
  (`app/settings/lake_landing`, which also holds each measurement so a reload does not re-spend the
  credits). (5) `POST` to Cribl's dataset-intelligence
  endpoint, from the banner's Generate button. (6) `POST …/cancel` on a search job — this session's
  own abandoned or over-running job, and, from the watchdog, a long-running job **belonging to the
  signed-in user**.
  **The rule that actually matters: nothing writes on load, on render, or on a timer.** A corrupt KV
  value is read as absent and deliberately *not* repaired, because the repair would be a write on
  load. Per `AGENTS.md`, any new DELETE or overwriting PUT/POST/PATCH must be behind an explicit user
  confirmation that names the affected resource — use `<ConfirmDialog>`, and register the write in
  `src/cribl/authz.ts` so `gatedWrites.test.ts` can see it.
  *Corrected in PR #5 (2026-09-16), PR #9 (2026-09-16), PR #10 (2026-09-16), slice 1.8 (branch
  `feat/phase-1.8-hang-control`, 2026-09-17), Phase 2 (branch `feat/phase-2-savings-schedules`,
  2026-09-17) and Phase 3 (branch `feat/phase-3-storage-surface`, 2026-09-17). This bullet used to
  say "in **five** places" and mentioned no write to Cribl Lake but the dataset's creation — while
  the app had already gained the single most consequential write in it. Before that it said "in
  **four** places" and listed no saved-search write and no
  `accel/…` KV key; before that it said: "**This app is read-only against Search data.** The only
  writes are in Guided Setup provisioning, which are deliberate, idempotent, and user-triggered."*
- **Persistence:** go through `src/cribl/kv.ts` — never `localStorage`/`sessionStorage`/`IndexedDB`/cookies (unreliable in the sandbox, and never shared across users, devices or sessions). Documents are PUT as **`text/plain`**: given a JSON content type the store parses the body, persists the literal `[object Object]`, and still answers 200. Key shapes: `app/settings/<name>` install-wide, `<ns>/prefs/<userId>` per user, `<ns>/log/<epochMs>` append-only. `accel/state` is install-wide but deliberately *not* under `app/settings/` — a setting is a value a human chose and may edit; that document is the app's own record of its own writes, and it sits beside `accel/prefs/…` and `accel/log/…` so one `listKeys('accel/')` enumerates everything Phase 2 stored. One writer per document — `prefs.ts` rewrites its whole document on every flag change, so a second writer's field would be dropped. Theme is the one client-side exception, a per-device display preference in `src/app/theme.ts`.
- **UI:** use the Capra design system (`@capra/core`, `@capra/icons`, `@capra/theme`). In CSS reference design tokens via the `token()` function, never raw CSS variables — and check what a token resolves to: `border.default` is the *shorthand* `1px solid var(…)`, not a colour, which is why 55 sites once shipped `1px solid 1px solid #cdced6` — invalid at computed-value time, so `border-style` computed to `none` and the app rendered **no borders at all**. Use `--gm-border`, which is `color.border.neutral.default`. Spacing and font sizes come from the `--gm-sp-*` / `--gm-fs-*` scales at the top of `src/App.css`; a bare px in a padding, margin, gap or font-size is a missing *step*, not a shortcut — add the step, with a line saying what forced it. Don't attach classes to Capra components or depend on their internals; do spacing with wrappers. Capra's `Modal` gives you the role, the label, the portal, the `inert` app root and Escape — it does **not** give you initial focus or `aria-describedby`; `<ConfirmDialog>` supplies both, so build on it rather than on `Modal` directly.
- **New external domains** must be declared in `config/proxies.yml`; **every Cribl product API path the app calls** must be declared in `config/policies.yml` and mirrored in `src/cribl/paths.ts`, with the reason written beside it. That file is not documentation — it is a *grant*, given to every user an admin shares the app with, so a missing entry is a 403 and an extra entry is asking for trust the app does not need. **Declare no wildcards**: `AGENTS.md` never defines whether `*` matches one path segment or many, so every object names each segment it needs and uses `:name` for a variable one. `policyCoverage.test.ts` enforces both directions. Editing these or `package.json` during `npm run dev` hot-reloads the app.
  *Corrected in PR #6 (2026-09-16). This bullet used to say `policies.yml` held "currently only
  search-job and AI/dataset-intelligence paths". It now declares the Guided Setup Stream writes and
  deletes, the Git commit and deploy paths, and the job-list, cancel and metrics reads as well —
  read the file, don't trust a count written here.*
- The default route redirects to `/flow-map`; unknown routes fall back there too.
