// Every Cribl product API path this app calls, with its method, in one place.
//
// WHY THIS FILE EXISTS. `config/policies.yml` is not documentation — AGENTS.md
// is explicit that when an admin shares this app, every path declared there is
// granted to the user for the duration of a request made through the app. So the
// file is two things at once: the app's honest statement of what it will touch,
// and the thing that decides whether a non-admin's click works. Until this slice
// nothing checked either claim against the code, and in slice 1.3 the check was
// overdue: `PATCH /m/:gid/system/inputs/*` was missing while provision.ts PATCHed
// exactly that path on every re-apply. A human found it by reading. A non-admin
// would have found it by deploying a stack fine and then hitting a 403 on every
// re-apply afterwards, reported as a failed provisioning step with no hint that
// it was a permission.
//
// This list plus `policyCoverage.test.ts` is what turns that into a test failure.
//
// ── MANIFEST, NOT SOURCE, AND WHY ───────────────────────────────────────────
// The other option was to make these constants the only way to build a URL and
// have every call site import them. That cannot drift, which is the whole
// attraction, and it was rejected for two reasons.
//
// First, it moves the risk rather than removing it. Nearly every path here
// carries a runtime value — the worker group the user picked, a job id, the
// routing table's own id — so the "constant" would be a function per endpoint,
// and a caller that builds a URL by hand instead of calling one is exactly as
// invisible as a caller that forgets to update a manifest. Nothing about
// `searchUrl(pathFor.jobStatus(id))` makes `searchUrl('/search/jobs/x/status')`
// impossible to write next to it.
//
// Second, and this is the load-bearing one: a manifest only drifts if nothing
// checks it. `policyCoverage.test.ts` reads the source of every module that can
// reach the API, resolves the path each call site actually builds, and fails when
// the source and this list disagree — in BOTH directions, so a new call with no
// entry fails, and an entry whose call has been deleted fails too. That gives the
// same no-drift guarantee as the import-everywhere version, without threading a
// helper through four transports that each have their own retry, abort and
// cancellation behaviour for good reasons.
//
// What this file therefore is: facts about the app. The checks, and the
// exceptions that are about the checking rather than about the app, live in
// policyCoverage.test.ts next door.
//
// ── THE IDS ARE IMPORTED, NOT TYPED OUT ─────────────────────────────────────
// The paths below interpolate the same constants provision.ts and config.ts call
// with, so renaming `HTTP_SOURCE_ID` moves this list, which then no longer
// matches config/policies.yml, which fails the test and makes somebody update the
// declaration. The one value not bound that way is the Cribl Lake id `default`
// (provision.ts keeps `LAKE_ID` private); the source scan resolves it from
// provision.ts's own text, so a change there still fails this list rather than
// passing silently.

import { SEARCH_GROUP } from './config'
import {
  PACK_BREAKER_ID,
  PACK_HTTP_INPUT_ID,
  PACK_ID,
  PACK_SAMPLE_DATASET_ID,
  PACK_SAMPLE_INPUT_ID,
} from './pack'
import {
  HTTP_BREAKER_ID,
  HTTP_PIPELINE_ID,
  HTTP_SOURCE_ID,
  LAKE_DATASET_ID,
  LAKE_DESTINATION_ID,
  LEGACY_SYSLOG_PIPELINE_ID,
  LEGACY_SYSLOG_SOURCE_ID,
  type ResourceKey,
} from './provision'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Where a call's path has to be declared — if anywhere. */
export type Scope =
  /** A Cribl product API path. Needs a `config/policies.yml` grant, or the
   *  platform rejects the call for anyone who does not already hold the
   *  permission themselves. */
  | 'product'
  /**
   * App-scoped (`/kvstore/…`). Granted with the app itself via the AppUser role
   * when an admin shares it, and AGENTS.md says in as many words: "do not
   * redeclare them here". Declaring one is not a harmless belt-and-braces — it
   * asks an admin to approve a grant the platform already made, which is the
   * over-declaration problem pointing the other way.
   */
  | 'app'

/**
 * A resource this app can bring into existence in a customer's Cribl. The six
 * provisioned objects share provision.ts's own vocabulary so the two cannot
 * drift apart; `commit` is the sixth thing a deploy leaves behind, and
 * `accel_saved_search` the seventh.
 *
 * WIDENED HERE RATHER THAN IN `ResourceKey`, deliberately. `ResourceKey` is the
 * five Stream objects Guided Setup provisions, and several surfaces render a
 * `Record<ResourceKey, …>` — a status pill per row, a commit-memory entry per
 * row, a label per row. Adding a sixth member there would push a phantom row
 * into every one of them, for an object Guided Setup does not create and cannot
 * deploy. Phase 2's scheduled saved searches are a different lifecycle in a
 * different group with a different teardown; what they share with the five is
 * only this: the app creates them, so it has to be able to remove them.
 */
export type Provisioned = ResourceKey | 'commit' | 'accel_saved_search' | 'pack'

export interface ApiCall {
  method: Method
  /**
   * The path as a policy object: literal where the app only ever calls one
   * value, `:name` for a segment that genuinely varies at runtime. Never `*` —
   * see the note on wildcards at the bottom of this file.
   */
  path: string
  scope: Scope
  /** `<file> <function>` — where to read the call. The test checks the file. */
  site: string
  /** Why the app makes this call, in the terms an admin approving it cares
   *  about. These are the sentences config/policies.yml's comments are made of. */
  why: string
  /** The resource this call brings into existence, for the paired-teardown check. */
  creates?: Provisioned
  /** …and the one it takes away. A single call may do both: the routing table is
   *  edited in place, so the same PATCH adds our route and removes it. */
  removes?: Provisioned
}

/**
 * A module whose calls are written but that nothing on screen reaches yet —
 * no module `src/main.tsx` imports imports it.
 *
 * ITS CALLS ARE NAMED IN `API_CALLS` AND NOT GRANTED. The source scan still
 * has to prove this list complete, so every call is here with its reason; but
 * config/policies.yml is a grant an admin gives every user the app is shared
 * with, and a grant for a button that does not exist is trust the app cannot
 * use. policyCoverage.test.ts ("calls nothing reaches yet") fails if any of
 * these calls is granted early, and fails the moment the running app imports a
 * module still on this list — which is when the grants become due, in the same
 * change as the UI.
 */
export interface Unreached {
  /** Repo-relative path of the module. */
  file: string
  reason: string
}

export const UNREACHED_MODULES: readonly Unreached[] = [
  {
    file: 'src/cribl/packClient.ts',
    reason:
      'The onboarding pack client (install, upgrade, remove, and the pack source’s port, token, TLS and enable, then commit and deploy) is built a slice ahead of the Guided Setup UI that calls it. Until that UI lands nothing can press any of it, so none of its pack-scoped calls is asked of an admin yet.',
  },
]

/**
 * THE CALL SURFACE. Every entry is reachable from a click in this app, except
 * those in `UNREACHED_MODULES`, which are written and not yet reachable —
 * nothing here is otherwise speculative, and nothing the app calls is missing
 * from it. The test proves all three against the source.
 */
export const API_CALLS: readonly ApiCall[] = [
  // ── Cribl Search: what every dashboard panel does ─────────────────────────
  // Search always runs in the dedicated search group (AGENTS.md, "Config Group
  // Context"), so `default_search` is a literal segment here and in the
  // declaration rather than a `:gid` placeholder. That narrowing is deliberate:
  // it grants the app nothing at all in any other group.
  {
    method: 'POST',
    path: `/m/${SEARCH_GROUP}/search/jobs`,
    scope: 'product',
    site: 'search.ts submitJob',
    why: 'Run a panel’s KQL query — every dashboard figure in the app starts here.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/jobs`,
    scope: 'product',
    site: 'jobWatchdog.ts pollOnce (also accel/status.ts fetchHistoryPage)',
    why: 'List the search jobs currently running, to surface one that has been running far longer than any query this app permits itself. It is a config-plane READ, of other people’s searches as well as the viewer’s own where their role already allows it: it submits no search, bills nothing, and — unlike the `$vt_jobs` query it replaces — adds no job to the workspace’s own search history. What the app does with somebody else’s row is show it; only the viewer’s own rows get a Cancel.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/jobs/:jobId`,
    scope: 'product',
    site: 'search.ts stoppedByTimeLimit (also accel/status.ts runMeta)',
    why: 'Read a failed job’s errors, to tell a query stopped by its running-time cap (which the panel says plainly) from one that failed for some other reason.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/jobs/:jobId/status`,
    scope: 'product',
    site: 'search.ts waitForJob',
    why: 'Poll a submitted job until it completes. Without this every panel in the app hangs at "loading" forever.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/jobs/:jobId/results`,
    scope: 'product',
    site: 'search.ts runSearchInner',
    why: 'Read the rows a completed job produced — the data every chart and table on every tab is drawn from.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/jobs/:jobId/field-summaries`,
    scope: 'product',
    site: 'search.ts runFieldSummariesInner',
    why: 'Per-field fill, cardinality and top values for the Field Explorer tab.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/jobs/:jobId/metrics`,
    scope: 'product',
    site: 'jobCost.ts readBillableCpuSeconds (also accel/status.ts lastRunCost)',
    why: 'Read a completed job’s billable CPU-seconds for the header’s auto-refresh cost label. Denied, the app shows a cost figure that is wrong rather than an error, so it is declared like any other read.',
  },
  {
    method: 'POST',
    path: `/m/${SEARCH_GROUP}/search/jobs/:jobId/cancel`,
    scope: 'product',
    site: 'search.ts cancelJob (also jobWatchdog.ts cancelHungJob)',
    why: 'Stop a job this session started when the search is abandoned (range change, tab switch, unmount) or outlives its client timeout, so it stops billing instead of running to its cap. It is the user’s own job, seconds old, and no configuration — which is why that POST needs no confirmation dialog. The watchdog reuses the same grant for a job this session did not start but the SAME USER owns; it never cancels anybody else’s, and that one is confirmed because of its age: see cribl/jobWatchdog.ts cancelHungJob.',
  },

  // ── Phase 2: the two scheduled saved searches ─────────────────────────────
  // Same `default_search` literal as the job paths above, for the same reason:
  // these searches run where search runs, and the declaration grants nothing in
  // any other group.
  //
  // WHAT AN ADMIN IS REALLY APPROVING HERE, said plainly rather than left to be
  // discovered: POST, PATCH and DELETE on `/search/saved` are granted to EVERY
  // user this app is shared with, for the duration of a request made through the
  // app. A Member who could not otherwise create a scheduled search can create
  // one through this app's Apply button — and a scheduled search spends credits,
  // on a cron, until somebody stops it. Decision I-D4: the owner accepted that
  // deliberately, because the alternative is an acceleration feature only an
  // admin can switch on, in an app whose whole point is lowering the bill. What
  // narrows it is the app rather than the grant: it writes only the ids in
  // src/cribl/accel/manifest.ts — that list is the authority and the count is
  // not restated here, because "the two ids" was true of Phase 2 and quietly
  // stopped being true as the manifest grew — each behind a confirmation that
  // names them, and it deletes only an object carrying its own `GNO …` stamp.
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/saved`,
    scope: 'product',
    site: 'accel/provision.ts readAccelState',
    why: 'List the workspace’s saved searches, to tell whether this app’s two scheduled searches exist, are running or are paused — and to spot one an older release left behind that is still firing on a cron. It reads other people’s saved searches too, wherever the caller’s own role already allows that: their names, queries and schedules. The app shows none of them; it picks out its own ids and counts the rest as "there may be more than one page".',
  },
  {
    method: 'POST',
    path: `/m/${SEARCH_GROUP}/search/saved`,
    scope: 'product',
    site: 'accel/provision.ts createSaved',
    why: 'Create one of this app’s two scheduled searches, from the confirmed Apply button. This is the grant that lets the app put a recurring, credit-spending job into the workspace, so it is the one to read hardest: it creates only the fixed ids `gno_lake_30d_c1d` and `gno_sample_2m_c1h`, on the crons and windows in src/cribl/accel/manifest.ts, and the confirmation names both before anything is sent.',
    creates: 'accel_saved_search',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/saved/:id`,
    scope: 'product',
    site: 'accel/provision.ts readSaved',
    why: 'Read one saved search whole, immediately before rewriting it. Measured (A-SP23): a PATCH deletes every field it omits, so the only safe way to change one setting is to read the entire object and send it all back — which makes this GET part of every write below, not a separate convenience.',
  },
  {
    method: 'PATCH',
    path: `/m/${SEARCH_GROUP}/search/saved/:id`,
    scope: 'product',
    site: 'accel/provision.ts patchSaved',
    why: 'Pause or resume one of this app’s scheduled searches, or bring one that has been edited back into line with what this release runs. It overwrites that object wholesale — there is no partial write on this endpoint — so it is behind a confirmation that names the search, and it only ever addresses an id this app owns.',
  },
  {
    method: 'DELETE',
    path: `/m/${SEARCH_GROUP}/search/saved/:id`,
    scope: 'product',
    site: 'accel/provision.ts deleteSaved',
    why: 'Remove one of this app’s scheduled searches again, from the confirmed Remove button. The per-dashboard and master switches PAUSE the recurring spend (a PATCH, above); Remove is what deletes the scheduled searches themselves, and uninstalling the app leaves them in place either way. It deletes only an id matching `gno_` that is in this release’s manifest AND carries this app’s own stamp; a saved search with the same name that this app did not create is reported and left alone.',
    removes: 'accel_saved_search',
  },

  // ── Cribl Search AI: dataset intelligence ─────────────────────────────────
  {
    method: 'GET',
    path: '/ai/settings/features',
    scope: 'product',
    site: 'datasetIntel.ts aiEnabled',
    why: 'Ask whether the tenant has AI features switched on at all, so the app offers them only where they exist.',
  },
  {
    method: 'GET',
    path: '/ai/settings/dataset-intelligence/:dataset',
    scope: 'product',
    site: 'datasetIntel.ts getDatasetIntel',
    why: `Read the generated schema summary for the ${LAKE_DATASET_ID} dataset. A 404 here is the normal "never generated" answer, not a failure.`,
  },
  {
    method: 'POST',
    path: '/ai/settings/dataset-intelligence/:dataset',
    scope: 'product',
    site: 'datasetIntel.ts generateDatasetIntel',
    why: `Generate that summary once, from a button the user presses. Without it the Copilot agent rediscovers the ~319-field ${LAKE_DATASET_ID} schema on every investigation.`,
  },

  // ── Guided Setup: the worker group the stack is applied to ────────────────
  // /products/stream/… is the current path family and /master/groups the
  // deprecated one. Both are called, and both are declared, because provision.ts
  // falls back to the old path on a 404 — which is how an older Leader answers
  // the new one.
  {
    method: 'GET',
    path: '/master/groups',
    scope: 'product',
    site: 'provision.ts listStreamGroups',
    why: 'List the Stream worker groups Guided Setup offers in its picker.',
  },
  {
    method: 'GET',
    path: '/products/stream/groups/:gid',
    scope: 'product',
    site: 'provision.ts deployedVersion',
    why: 'Read which commit a group’s Workers are running, so a commit an earlier run left undeployed can be found and finished.',
  },
  {
    method: 'GET',
    path: '/master/groups/:gid',
    scope: 'product',
    site: 'provision.ts deployedVersion',
    why: 'The same read on an older Leader that does not answer the /products/stream path.',
  },
  {
    method: 'PATCH',
    path: '/products/stream/groups/:gid/deploy',
    scope: 'product',
    site: 'provision.ts deployGroup (also lakeLanding.ts deployGroupConfig)',
    why: 'Push the committed config to the group’s running Workers. This is the step that makes a deploy real, and it RESTARTS THAT GROUP’S WORKER PROCESSES — a source set to block on backpressure can lose seconds of data across the restart. Two confirmed buttons reach it: Guided Setup’s Deploy and Remove, and the Lake landing panel’s destination edit, which says the restart is coming before the press rather than in a toast afterwards.',
  },
  {
    method: 'PATCH',
    path: '/master/groups/:gid/deploy',
    scope: 'product',
    site: 'provision.ts deployGroup (also lakeLanding.ts deployGroupConfig)',
    why: 'The same deploy on an older Leader that does not answer the /products/stream path. Tried ONLY on a 404, which is the single status meaning "this Leader has no such route": a 403 cannot be granted by a second path, and a 5xx deploy may already have started server-side, so a blind retry would be a second deploy.',
  },

  // ── Guided Setup: the Cribl Lake dataset ──────────────────────────────────
  // `default` is the lake, not a placeholder: provision.ts holds it as LAKE_ID
  // and the app never addresses another one.
  {
    method: 'GET',
    path: '/products/lake/lakes/default/datasets',
    scope: 'product',
    site: 'provision.ts ensureLakeDataset (also lake.ts listDatasets)',
    why: `See whether the ${LAKE_DATASET_ID} dataset exists yet. Also the first thing the status check reads, so the tab can say what is already there, and what the Lake landing panel reads to tell "this tenant has no such dataset" from "this tenant has no Cribl Lake".`,
  },
  {
    method: 'POST',
    path: '/products/lake/lakes/default/datasets',
    scope: 'product',
    site: 'provision.ts ensureLakeDataset',
    why: `Create the ${LAKE_DATASET_ID} dataset when it is absent. Additive: an existing dataset is left exactly as it is.`,
    creates: 'dataset',
  },

  // ── Phase 3: the Lake landing panel ───────────────────────────────────────
  // Nine reads and two write surfaces, all from the one panel appended to
  // Guided Setup's page. NOTHING HERE CREATES ANYTHING: every call either reads,
  // or edits an object the customer already owns. So no entry below carries
  // `creates` or `removes`, and the paired-teardown check is SILENT about this
  // whole phase rather than passing it — what guards reversibility here is the
  // rollback story (each edit reversible through the same editor; destination
  // edits are Git commits that can be reverted and redeployed) and the fact that
  // a retention DECREASE is labelled as the one thing that cannot be undone.
  //
  // Two paths that were specified and are deliberately NOT declared:
  // `PATCH /m/default_search/search/datasets/gigamon_ami`, which is one of two
  // candidate shapes for the reader toggle (P-S5 has not said which, and
  // declaring a write before the spike says it is needed asks for trust the app
  // cannot use), and any DELETE anywhere in Cribl Lake.
  {
    method: 'GET',
    path: '/products/lake/lakes/default/config',
    scope: 'product',
    site: 'lake.ts getLakeConfig',
    why: 'Read this tenant’s Cribl Lake limits — chiefly how many partition fields a dataset may have — so the panel checks a proposed setting against the tenant rather than against a number this app remembered. A 404 here is how an on-prem Leader says Cribl Lake is a Cloud-only product, which is a whole-panel state and not a failure.',
  },
  {
    method: 'GET',
    path: `/products/lake/lakes/default/datasets/${LAKE_DATASET_ID}`,
    scope: 'product',
    site: 'lake.ts getDataset',
    why: `Read the ${LAKE_DATASET_ID} dataset itself with its size: retention, partitions, format, description, the search configuration, and the stored size with the DAY it was computed. This is the row the retention editor edits and the capture that makes a retention change reversible — Lake datasets are under no version control, so this read is the only record of what a value was before.`,
  },
  {
    method: 'PATCH',
    path: `/products/lake/lakes/default/datasets/${LAKE_DATASET_ID}`,
    scope: 'product',
    site: 'lakeLanding.ts setRetention (also setDescription)',
    why: `Change how long Cribl Lake keeps the ${LAKE_DATASET_ID} dataset, or its description, from a confirmation naming the dataset and the change. A retention DECREASE deletes everything older than the new window immediately and cannot be undone — there is no commit to revert and no snapshot to restore — so that one is labelled irreversible, states the current size and the day it was measured, and asks for the dataset id to be typed. This grant is the sharpest edge in the file: it is granted to every user the app is shared with.`,
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/datasets/${LAKE_DATASET_ID}`,
    scope: 'product',
    site: 'lake.ts getSearchDataset',
    why: `Read how Cribl Search sees the ${LAKE_DATASET_ID} dataset — which reader version it uses, and what storage format it believes the objects are in. Read separately from the Lake-side object rather than derived from it, because whether the two agree is exactly what nobody has verified (P-S5), and a panel that assumed they did could not show a disagreement.`,
  },
  {
    method: 'PATCH',
    path: `/m/:gid/system/outputs/${LAKE_DESTINATION_ID}`,
    scope: 'product',
    site: 'lakeLanding.ts updateDestination',
    why: `Change how the '${LAKE_DESTINATION_ID}' destination writes objects — how big they get and how long they stay open — from a confirmation that shows the exact before→after, names every feed writing through it, and says the commit carries every pending change to this group's outputs.yml. A destination PATCH replaces the object wholesale, so the app sends back the body it just read with only the edited keys changed. It edits a delivery point this app usually did not create, which is why the confirmation says so and why the only way back is this same editor or the group's Git history. Like every action here it is granted to EVERY user an admin shares this app with (I-D4), including one whose own role would refuse it — and ':gid' is a placeholder, so the grant covers every worker group on the Leader and not only the one the picker is on.`,
  },
  {
    method: 'GET',
    path: '/m/:gid/system/inputs',
    scope: 'product',
    site: 'lake.ts listInputs',
    why: `List the group's sources, to work out what actually writes through the '${LAKE_DESTINATION_ID}' destination. The routing table is not the whole answer: on the workspace this was measured against, a source reaches Cribl Lake through a QuickConnect binding on the source itself and appears in no route at all — so a confirmation built on routes alone would under-report the feeds a destination change affects. Guided Setup reads the same list for the ports the group's sources already listen on, so it offers a free port for the Raw HTTP source and checks it again just before creating it.`,
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/local_search`,
    scope: 'product',
    site: 'lake.ts getLocalSearch',
    why: 'Ask whether this workspace has Cribl Search local engines, which is the acceleration tier the panel reports. A 404 answers "local search is not enabled", which is the ordinary state of most tenants and is reported as a value, not as a fault.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/local_search/engines`,
    scope: 'product',
    site: 'lake.ts listLocalEngines',
    why: 'Count the local search engines provisioned, once local search says it exists. Zero engines with local search enabled is a real state and a different one from local search being absent, and the panel says which.',
  },
  {
    method: 'GET',
    path: '/products/stream/groups',
    scope: 'product',
    site: 'lake.ts listStreamGroupsCurrent',
    why: 'List the worker groups from the current path family, for the commit each group is running. A rollback needs a target: "redeploy the previous version" is not a plan until the previous version has a name, and this is where that name comes from. Guided Setup also reads `onPrem` here: it decides the new source’s port range and whether it terminates TLS on Cribl’s certificate. Its picker still reads the deprecated /master/groups.',
  },

  // ── Guided Setup: the group-scoped config objects ─────────────────────────
  // Everything below is addressed under the /m/:gid prefix that every
  // non-/system/ endpoint takes. The group is the one the user picked, so :gid
  // has to stay a placeholder — see the README for what that costs.
  //
  // The child paths name the object, rather than taking a wildcard. The app only
  // ever touches the objects it created, and a declaration that says so is both
  // narrower and more useful to the admin reading it: "may delete the input
  // in_gigamon_http" rather than "may delete any input".
  {
    method: 'GET',
    path: '/m/:gid/packs',
    scope: 'product',
    site: 'lake.ts listPackInputs (also packClient.ts readInstalled)',
    why: 'List the packs installed in the worker group, so Guided Setup can read the sources inside them. A pack source listens on a port like any other — the onboarding pack’s own Raw HTTP source uses the same 20000–20010 range a Cribl-managed group allows — and a pack’s sources have their own endpoint (openapi.json lists `/p/{pack}/system/inputs` apart from the group’s list). Read only.',
  },
  {
    method: 'GET',
    path: '/m/:gid/p/:pack/system/inputs',
    scope: 'product',
    site: 'lake.ts listPackInputs',
    why: 'Read the sources inside each installed pack: their ports, so the new Raw HTTP source is not given one a pack source already listens on, and the event breaker rulesets they name, so Remove never deletes this app’s ruleset while a pack source still uses it. Read only; `:pack` is any installed pack’s id, because the port check has to see all of them.',
  },
  // ── The onboarding pack (src/cribl/packClient.ts) — NOT YET GRANTED ───────
  // Every entry below sits in a module on UNREACHED_MODULES: written, tested,
  // and reached by nothing on screen until Guided Setup's pack UI lands. They
  // are not in config/policies.yml, and must not be until then — see
  // UNREACHED_MODULES. Each pack-scoped path names this app's pack by its id
  // and, where one object is meant, that object, so the grant when it comes is
  // "this pack's two sources", never "any source in any pack".
  {
    method: 'POST',
    path: '/m/:gid/packs',
    scope: 'product',
    site: 'packClient.ts installPack',
    why: `Install the Gigamon AMI onboarding pack '${PACK_ID}' from its GitHub release into the worker group picked in Guided Setup, from a confirmation naming the pack, its version and the group. The Leader downloads the release itself; custom functions are refused. Only this pack id and only the release URL this app build pins.`,
    creates: 'pack',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/packs/${PACK_ID}`,
    scope: 'product',
    site: 'packClient.ts upgradePack',
    why: `Upgrade the installed '${PACK_ID}' in place to the version this app build pins — only from a version this app published and installed from its own release, and never downward. Custom functions stay refused.`,
  },
  {
    method: 'DELETE',
    path: `/m/:gid/packs/${PACK_ID}`,
    scope: 'product',
    site: 'packClient.ts removePack',
    why: `Uninstall '${PACK_ID}' again, from a confirmed Remove — only when the installed pack is this app's id, at a version this app published, installed from that version's own GitHub release. The Lake datasets it wrote to are outside the pack and stay.`,
    removes: 'pack',
  },
  {
    method: 'GET',
    path: `/m/:gid/p/${PACK_ID}/system/inputs`,
    scope: 'product',
    site: 'packClient.ts readPackState',
    why: 'Read the pack’s two sources — whether each is there and enabled, the Raw HTTP source’s port and TLS, and whether it has a token (never the token itself) — for the status Guided Setup shows.',
  },
  {
    method: 'GET',
    path: `/m/:gid/p/${PACK_ID}/lib/breakers/${PACK_BREAKER_ID}`,
    scope: 'product',
    site: 'packClient.ts readPackState',
    why: 'Ask whether the pack’s event breaker ruleset is installed, since the Raw HTTP source splits nothing into events without it.',
  },
  {
    method: 'GET',
    path: `/m/:gid/p/${PACK_ID}/pipelines`,
    scope: 'product',
    site: 'packClient.ts readPackState',
    why: 'Ask whether the pack’s normalize pipeline is installed, for the pack’s status. Read only.',
  },
  {
    method: 'GET',
    path: `/m/:gid/p/${PACK_ID}/routes`,
    scope: 'product',
    site: 'packClient.ts readPackState',
    why: 'Ask whether the pack’s three routes are installed — the two that send HTTP data to the JSON and Parquet datasets, and the sample’s. Read only.',
  },
  {
    method: 'GET',
    path: `/m/:gid/p/${PACK_ID}/system/outputs`,
    scope: 'product',
    site: 'packClient.ts readPackState',
    why: 'Ask whether the pack’s three Cribl Lake destinations are installed. Read only.',
  },
  {
    method: 'GET',
    path: `/m/:gid/p/${PACK_ID}/system/inputs/${PACK_HTTP_INPUT_ID}`,
    scope: 'product',
    site: 'packClient.ts readLive (also verifyInstalled)',
    why: 'Read the pack’s Raw HTTP source whole before changing it, because its PATCH replaces the whole object; and read it back after an install, as proof the pack arrived.',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/p/${PACK_ID}/system/inputs/${PACK_HTTP_INPUT_ID}`,
    scope: 'product',
    site: 'packClient.ts patchPackInput',
    why: 'Set what only an install can know on the pack’s Raw HTTP source — a free port, the auth token this app generates, TLS for the group’s hosting — and enable it. The body is the whole live source with those keys changed, because this endpoint deletes any field a PATCH omits.',
  },
  {
    method: 'GET',
    path: `/m/:gid/p/${PACK_ID}/system/inputs/${PACK_SAMPLE_INPUT_ID}`,
    scope: 'product',
    site: 'packClient.ts readLive',
    why: 'Read the pack’s sample DataGen whole before starting or stopping it, because its PATCH replaces the whole object.',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/p/${PACK_ID}/system/inputs/${PACK_SAMPLE_INPUT_ID}`,
    scope: 'product',
    site: 'packClient.ts patchPackInput',
    why: `Start or stop the pack’s sample DataGen, an opt-in: it writes synthetic flows to ${PACK_SAMPLE_DATASET_ID}, never to the customer’s dataset. Only its \`disabled\` flag changes.`,
  },
  {
    method: 'POST',
    path: '/m/:gid/system/inputs',
    scope: 'product',
    site: 'provision.ts ensureSource',
    why: `Create the Gigamon Raw HTTP source '${HTTP_SOURCE_ID}' that AMX POSTs its records to, with the port picked in Guided Setup, TLS on a Cribl-managed group, and an auth token this app generates and shows once.`,
    creates: 'source',
  },
  {
    method: 'GET',
    path: `/m/:gid/system/inputs/${HTTP_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts ensureSource (also checkStatus, readHttpEndpoint)',
    why: 'Ask whether that source exists yet — the answer decides create versus re-apply and drives the status pill — and read the port and TLS state the endpoint card prints.',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/system/inputs/${HTTP_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts ensureSource',
    why: 'Re-apply the spec to a source that already exists, only when the live source does not already say what the spec says. The body is the whole live source with the spec asserted on it, because this endpoint deletes any field a PATCH omits; its port, TLS and auth token are never changed by it.',
  },
  {
    method: 'DELETE',
    path: `/m/:gid/system/inputs/${HTTP_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts removeOnboardingStack',
    why: 'Remove that source again, from the confirmed Remove button. Without it a customer can install the stack and not uninstall it.',
    removes: 'source',
  },
  // The Syslog source an earlier release created. Read so the teardown can name
  // it, and deleted by that teardown — never created or edited any more, so no
  // POST or PATCH is asked for it.
  {
    method: 'GET',
    path: `/m/:gid/system/inputs/${LEGACY_SYSLOG_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts checkLegacyStatus',
    why: 'Ask whether the Syslog source an earlier release of this app created is still in the group, so Remove can name it.',
  },
  {
    method: 'DELETE',
    path: `/m/:gid/system/inputs/${LEGACY_SYSLOG_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts removeOnboardingStack',
    why: 'Remove that old Syslog source, from the confirmed Remove button that names it.',
  },
  {
    method: 'POST',
    path: '/m/:gid/lib/breakers',
    scope: 'product',
    site: 'provision.ts ensureBreaker',
    why: `Create the event breaker ruleset '${HTTP_BREAKER_ID}' the Raw HTTP source names, which splits each POSTed JSON array into one event per AMI record.`,
    creates: 'breaker',
  },
  {
    method: 'GET',
    path: `/m/:gid/lib/breakers/${HTTP_BREAKER_ID}`,
    scope: 'product',
    site: 'provision.ts ensureBreaker (also checkStatus)',
    why: 'Ask whether that ruleset exists yet — create versus re-apply, and the status pill.',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/lib/breakers/${HTTP_BREAKER_ID}`,
    scope: 'product',
    site: 'provision.ts ensureBreaker',
    why: 'Re-apply the rules to a ruleset that already exists, only when they differ — as the whole live object with the spec asserted on it, because this endpoint deletes any field a PATCH omits.',
  },
  {
    method: 'DELETE',
    path: `/m/:gid/lib/breakers/${HTTP_BREAKER_ID}`,
    scope: 'product',
    site: 'provision.ts removeOnboardingStack',
    why: 'Remove that ruleset again, from the confirmed Remove button, after the source that names it.',
    removes: 'breaker',
  },
  {
    method: 'POST',
    path: '/m/:gid/system/outputs',
    scope: 'product',
    site: 'provision.ts ensureDestination',
    why: `Create the Cribl Lake destination '${LAKE_DESTINATION_ID}' on a tenant that does not already have one. Where it exists it is left untouched.`,
    creates: 'destination',
  },
  {
    method: 'GET',
    path: `/m/:gid/system/outputs/${LAKE_DESTINATION_ID}`,
    scope: 'product',
    site: 'provision.ts ensureDestination (also lake.ts getDestination)',
    why: 'Ask whether that destination exists, which is what stops the app creating a second one.',
  },
  {
    method: 'POST',
    path: '/m/:gid/pipelines',
    scope: 'product',
    site: 'provision.ts ensurePipeline',
    why: `Create the '${HTTP_PIPELINE_ID}' pipeline that normalizes Gigamon AMI fields — the same casts and derived fields the demo feed gets.`,
    creates: 'pipeline',
  },
  {
    method: 'GET',
    path: `/m/:gid/pipelines/${HTTP_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts ensurePipeline (also checkStatus)',
    why: 'Ask whether that pipeline exists yet — create versus re-apply, and the status pill.',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/pipelines/${HTTP_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts ensurePipeline',
    why: 'Re-apply the function list to a pipeline that already exists. Overwrites that one pipeline’s definition, which is why it is behind the confirmation — and, since Phase 3, is sent only when the live function list differs, so a re-apply of a settled stack writes nothing and cannot reach the deploy that restarts Worker Processes.',
  },
  {
    method: 'DELETE',
    path: `/m/:gid/pipelines/${HTTP_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts removeOnboardingStack',
    why: 'Remove that pipeline again, from the confirmed Remove button.',
    removes: 'pipeline',
  },
  {
    method: 'GET',
    path: `/m/:gid/pipelines/${LEGACY_SYSLOG_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts checkLegacyStatus',
    why: 'Ask whether the Syslog pipeline an earlier release of this app created is still in the group, so Remove can name it.',
  },
  {
    method: 'DELETE',
    path: `/m/:gid/pipelines/${LEGACY_SYSLOG_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts removeOnboardingStack',
    why: 'Remove that old Syslog pipeline, from the confirmed Remove button that names it.',
  },
  {
    method: 'GET',
    path: '/m/:gid/routes',
    scope: 'product',
    site: 'provision.ts readRoutes (also lake.ts listRoutes)',
    why: `Read the group’s routing table. Every change to it below is an edit of the array this returns, never a table composed from scratch. The Lake landing panel reads the same table for a second purpose: to name every route writing into the '${LAKE_DESTINATION_ID}' destination before a confirmation offers to change it.`,
  },
  {
    method: 'PATCH',
    path: '/m/:gid/routes/:tableId',
    scope: 'product',
    site: 'provision.ts ensureRoute (also removeOnboardingStack)',
    why: 'Add our route above the catch-all, or take it out again — along with the Syslog route an earlier release added. A group has one routing table and this replaces it wholesale, so it is the most consequential grant in the file — and the reason both halves of it are one entry: the same call installs the route and uninstalls it.',
    creates: 'route',
    removes: 'route',
  },

  // ── Guided Setup: Git versioning on the Leader ────────────────────────────
  {
    method: 'GET',
    path: '/version',
    scope: 'product',
    site: 'provision.ts commitHistory',
    why: 'Read the recent commit history of the Leader’s config repo: its HEAD, to tell whether the group is running it, and the commits between the group’s running commit and HEAD, which are the ones a deploy would put live.',
  },
  {
    method: 'GET',
    path: '/version/status',
    scope: 'product',
    site: 'provision.ts pendingFiles (also lakeLanding.ts pendingConfigFiles)',
    why: 'Read which config files are pending, so the commit can name exactly ours and leave anybody else’s uncommitted work alone. The Lake landing panel also shows the count in its confirmation, because a commit of this group’s outputs.yml carries whatever else is pending in that file — including somebody else’s edit — and that is worth saying before the press rather than after it.',
  },
  {
    method: 'GET',
    path: '/version/files',
    scope: 'product',
    site: 'provision.ts filesInCommit',
    why: 'Read which files each commit this group has not deployed moved — the endpoint answers for one commit, not a range — so "there is a commit to deploy" means one touching this group and not somebody else’s work on another group.',
  },
  {
    method: 'POST',
    path: '/version/commit',
    scope: 'product',
    site: 'provision.ts commitAndDeploy (also lakeLanding.ts commitAndDeployDestination)',
    why: 'Commit exactly the files the run touched — Guided Setup’s objects, or the Lake landing panel’s one outputs.yml. Always with an explicit file list: the API commits every pending change in the repository when given none, which would sweep up whatever anybody else had left uncommitted anywhere on the Leader.',
    creates: 'commit',
  },

  // ── The app-scoped KV store ───────────────────────────────────────────────
  // Here because this file claims to name every Cribl API call the app makes,
  // and these are calls. They are `scope: 'app'` and the test asserts they are
  // NOT in config/policies.yml — see the note on Scope above.
  {
    method: 'GET',
    path: '/kvstore/:key',
    scope: 'app',
    site: 'kv.ts getDoc',
    why: 'Read one of this app’s own documents: the install-wide search caps, a viewer’s dismissed banners, Guided Setup’s commit memory.',
  },
  {
    method: 'PUT',
    path: '/kvstore/:key',
    scope: 'app',
    site: 'kv.ts putDoc',
    why: 'Write one of those documents, always from a click.',
  },
  {
    method: 'DELETE',
    path: '/kvstore/:key',
    scope: 'app',
    site: 'kv.ts deleteDoc',
    why: 'Remove one. Reachable code with no caller in the UI today — see the note in LEFT_BEHIND about the audit trail.',
  },
  {
    method: 'POST',
    path: '/kvstore/keys',
    scope: 'app',
    site: 'kv.ts listKeys',
    why: 'List the keys under a prefix. A POST that reads and changes nothing — the store takes the prefix in a body rather than in the URL.',
  },
]

/**
 * THE PAIRED-TEARDOWN EXCEPTIONS: things this app creates in a customer's Cribl
 * and cannot take away again.
 *
 * The test pairs every `creates` with a `removes` and fails on anything left
 * over, because "installs but cannot uninstall" is a thing a customer discovers
 * at the worst moment. An entry here is a decision that it should stay that way,
 * and the reason is the entry — an exception without one is how this test
 * becomes decoration.
 */
export interface LeftBehind {
  resource: Provisioned
  reason: string
}

export const LEFT_BEHIND: readonly LeftBehind[] = [
  {
    resource: 'dataset',
    reason:
      `The ${LAKE_DATASET_ID} Lake dataset holds the customer's ingested flow records. A DELETE grant here would let this app destroy that data, and an uninstall that silently took the data with it is far worse than one that leaves a dataset behind. Removing it is a Cribl Lake operation the customer performs deliberately, in Cribl Lake, on a dataset they can see the size of.`,
  },
  {
    resource: 'destination',
    reason:
      `DECIDED, NOT DEFERRED. The app creates the '${LAKE_DESTINATION_ID}' destination only on a tenant that lacks one, so on those tenants an uninstall leaves one unreferenced Cribl Lake destination behind — say so rather than pretend otherwise. It stays because the app cannot prove it made it: the destination is named after the dataset, not after this app, it already exists on many tenants, and anything else in the customer's config may route to it. Teardown runs from a confirmation that names five objects; deleting a shared delivery point that predates the app, and breaking whatever else writes through it, is not one of the five. An unreferenced destination costs nothing, holds no data and breaks nothing, and the customer removes it in Stream in one click. If this ever matters, the fix is not a DELETE grant on its own — it is recording at create time that this app created it, and offering the teardown step only then.

PHASE 3 NOW EDITS THIS OBJECT, and this entry is deliberately NOT widened by that. "The app cannot prove it made it" is a reason not to DELETE it; it is not a reason not to change a setting on it, and the two do not have the same worst case — a deleted destination stops delivery for everything wired to it, a changed one keeps delivering differently. What it does oblige is the confirmation: components/LakeLandingPanel.tsx names it as a replace on an object this app probably did not create, lists every feed writing through it, and says the only way back is that same editor or the group's Git history. It stays out of the teardown.`,
  },
  {
    resource: 'commit',
    reason:
      'A Git commit in the Leader\'s config repo is meant to be permanent — it is the record that the change happened, and the customer\'s own history. Cribl has /version/revert and /version/undo; this app deliberately calls neither, because "undo my commit" on a shared repo can just as easily undo somebody else\'s work that landed on top of it.',
  },
]

// ── ON WILDCARDS, AND WHY THERE ARE NONE ────────────────────────────────────
//
// AGENTS.md settles two things about policy paths and leaves one open. It
// settles that `*` does not match zero segments ("Declaring
// `/products/stream/groups` covers that exact collection path only"), and that
// `*` and `:name` are interchangeable for a single child segment ("include
// `/products/stream/groups/*` or `/products/stream/groups/:gid`"). It never says
// whether `*` matches one segment or many. The only evidence either way is its
// own example, `/m/:gid/system/projects/*`, commented "all methods for matching
// project paths" — which is only true if `*` is multi-segment, since that API is
// two and three segments deep. That is an inference from an example, not a rule,
// and openapi.json does not describe path matching at all.
//
// This workspace cannot settle it either: provisioning here works because the
// caller is org_admin + ws_admin, and AGENTS.md says a user with the permission
// already reaches the path without any grant — so an admin never exercises the
// matcher.
//
// So the question is removed rather than answered. Every path above and in
// config/policies.yml names each segment it needs, and the file contains no `*`
// at all. That costs a few more lines of YAML and buys a declaration that means
// the same thing under both readings — where a `*` entry means one of two
// different grants depending on an answer nobody has. The cost of guessing wrong
// is not symmetrical: read `*` as multi-segment and today's file passes a
// coverage test unchanged while a non-admin 403s on the very first status poll,
// which is precisely the failure this slice exists to prevent.
