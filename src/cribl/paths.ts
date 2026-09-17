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
// with, so renaming `SYSLOG_SOURCE_ID` moves this list, which then no longer
// matches config/policies.yml, which fails the test and makes somebody update the
// declaration. The one value not bound that way is the Cribl Lake id `default`
// (provision.ts keeps `LAKE_ID` private); the source scan resolves it from
// provision.ts's own text, so a change there still fails this list rather than
// passing silently.

import { SEARCH_GROUP } from './config'
import {
  LAKE_DATASET_ID,
  LAKE_DESTINATION_ID,
  SYSLOG_PIPELINE_ID,
  SYSLOG_SOURCE_ID,
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
 * A resource this app can bring into existence in a customer's Cribl. The five
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
export type Provisioned = ResourceKey | 'commit' | 'accel_saved_search'

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
 * THE CALL SURFACE. Every entry is reachable from a click in this app; nothing
 * here is speculative, and nothing the app calls is missing from it — the test
 * proves both against the source.
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
    site: 'jobWatchdog.ts pollOnce',
    why: 'List the search jobs currently running, to surface one that has been running far longer than any query this app permits itself. It is a config-plane READ, of other people’s searches as well as the viewer’s own where their role already allows it: it submits no search, bills nothing, and — unlike the `$vt_jobs` query it replaces — adds no job to the workspace’s own search history. What the app does with somebody else’s row is show it; only the viewer’s own rows get a Cancel.',
  },
  {
    method: 'GET',
    path: `/m/${SEARCH_GROUP}/search/jobs/:jobId`,
    scope: 'product',
    site: 'search.ts stoppedByTimeLimit',
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
    site: 'jobCost.ts readBillableCpuSeconds',
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
  // narrows it is the app rather than the grant: it writes only the two ids in
  // src/cribl/accel/manifest.ts, both behind a confirmation that names them, and
  // it deletes only an object carrying its own `GNO …` stamp.
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
    why: 'Remove one of this app’s scheduled searches again, from the confirmed Remove button — the only way a customer can stop the recurring spend this app started, since uninstalling the app leaves the schedules running. It deletes only an id matching `gno_` that is in this release’s manifest AND carries this app’s own stamp; a saved search with the same name that this app did not create is reported and left alone.',
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
    site: 'provision.ts deployGroup',
    why: 'Push the committed config to the group’s running Workers. This is the step that makes a deploy real, and it restarts Worker Processes — it runs only from the confirmed Deploy button.',
  },
  {
    method: 'PATCH',
    path: '/master/groups/:gid/deploy',
    scope: 'product',
    site: 'provision.ts deployGroup',
    why: 'The same deploy on an older Leader that does not answer the /products/stream path.',
  },

  // ── Guided Setup: the Cribl Lake dataset ──────────────────────────────────
  // `default` is the lake, not a placeholder: provision.ts holds it as LAKE_ID
  // and the app never addresses another one.
  {
    method: 'GET',
    path: '/products/lake/lakes/default/datasets',
    scope: 'product',
    site: 'provision.ts ensureDataset',
    why: `See whether the ${LAKE_DATASET_ID} dataset exists yet. Also the first thing the status check reads, so the tab can say what is already there.`,
  },
  {
    method: 'POST',
    path: '/products/lake/lakes/default/datasets',
    scope: 'product',
    site: 'provision.ts ensureDataset',
    why: `Create the ${LAKE_DATASET_ID} dataset when it is absent. Additive: an existing dataset is left exactly as it is.`,
    creates: 'dataset',
  },

  // ── Guided Setup: the group-scoped config objects ─────────────────────────
  // Everything below is addressed under the /m/:gid prefix that every
  // non-/system/ endpoint takes. The group is the one the user picked, so :gid
  // has to stay a placeholder — see the README for what that costs.
  //
  // The child paths name the object, rather than taking a wildcard. The app only
  // ever touches the three objects it created, and a declaration that says so is
  // both narrower and more useful to the admin reading it: "may delete the input
  // in_gigamon_syslog" rather than "may delete any input".
  {
    method: 'POST',
    path: '/m/:gid/system/inputs',
    scope: 'product',
    site: 'provision.ts ensureSource',
    why: `Create the Gigamon Syslog source '${SYSLOG_SOURCE_ID}' that AMX exports arrive on.`,
    creates: 'source',
  },
  {
    method: 'GET',
    path: `/m/:gid/system/inputs/${SYSLOG_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts ensureSource',
    why: 'Ask whether that source exists yet — the answer decides create versus re-apply, and drives the status pill on the tab.',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/system/inputs/${SYSLOG_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts ensureSource',
    why: 'Re-apply the spec to a source that already exists. This is the grant slice 1.3 shipped without: deploying a fresh stack worked, and every re-apply afterwards 403ed.',
  },
  {
    method: 'DELETE',
    path: `/m/:gid/system/inputs/${SYSLOG_SOURCE_ID}`,
    scope: 'product',
    site: 'provision.ts removeSyslogStack',
    why: 'Remove that source again, from the confirmed Remove button. Without it a customer can install the stack and not uninstall it.',
    removes: 'source',
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
    site: 'provision.ts ensureDestination',
    why: 'Ask whether that destination exists, which is what stops the app creating a second one.',
  },
  {
    method: 'POST',
    path: '/m/:gid/pipelines',
    scope: 'product',
    site: 'provision.ts ensurePipeline',
    why: `Create the '${SYSLOG_PIPELINE_ID}' pipeline that parses Gigamon AMI JSON out of the syslog message and normalizes its fields.`,
    creates: 'pipeline',
  },
  {
    method: 'GET',
    path: `/m/:gid/pipelines/${SYSLOG_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts ensurePipeline',
    why: 'Ask whether that pipeline exists yet — create versus re-apply, and the status pill.',
  },
  {
    method: 'PATCH',
    path: `/m/:gid/pipelines/${SYSLOG_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts ensurePipeline',
    why: 'Re-apply the function list to a pipeline that already exists. Overwrites that one pipeline’s definition, which is why it is behind the confirmation.',
  },
  {
    method: 'DELETE',
    path: `/m/:gid/pipelines/${SYSLOG_PIPELINE_ID}`,
    scope: 'product',
    site: 'provision.ts removeSyslogStack',
    why: 'Remove that pipeline again, from the confirmed Remove button.',
    removes: 'pipeline',
  },
  {
    method: 'GET',
    path: '/m/:gid/routes',
    scope: 'product',
    site: 'provision.ts readRoutes',
    why: 'Read the group’s routing table. Every change to it below is an edit of the array this returns, never a table composed from scratch.',
  },
  {
    method: 'PATCH',
    path: '/m/:gid/routes/:tableId',
    scope: 'product',
    site: 'provision.ts ensureRoute',
    why: 'Add our route above the catch-all, or take it out again. A group has one routing table and this replaces it wholesale, so it is the most consequential grant in the file — and the reason both halves of it are one entry: the same call installs the route and uninstalls it.',
    creates: 'route',
    removes: 'route',
  },

  // ── Guided Setup: Git versioning on the Leader ────────────────────────────
  {
    method: 'GET',
    path: '/version',
    scope: 'product',
    site: 'provision.ts headCommit',
    why: 'Read the newest commit in the Leader’s config repo, to tell whether the group is running it.',
  },
  {
    method: 'GET',
    path: '/version/status',
    scope: 'product',
    site: 'provision.ts pendingFiles',
    why: 'Read which config files are pending, so the commit can name exactly ours and leave anybody else’s uncommitted work alone.',
  },
  {
    method: 'GET',
    path: '/version/files',
    scope: 'product',
    site: 'provision.ts filesChangedSince',
    why: 'Read which files moved since the commit this group is running, so "there is a commit to deploy" means one of ours and not somebody else’s work on another group.',
  },
  {
    method: 'POST',
    path: '/version/commit',
    scope: 'product',
    site: 'provision.ts commitAndDeploy',
    why: 'Commit exactly the files the run touched. Always with an explicit file list: the API commits every pending change when given none.',
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
      `DECIDED, NOT DEFERRED. The app creates the '${LAKE_DESTINATION_ID}' destination only on a tenant that lacks one, so on those tenants an uninstall leaves one unreferenced Cribl Lake destination behind — say so rather than pretend otherwise. It stays because the app cannot prove it made it: the destination is named after the dataset, not after this app, it already exists on many tenants, and anything else in the customer's config may route to it. Teardown runs from a confirmation that names five objects; deleting a shared delivery point that predates the app, and breaking whatever else writes through it, is not one of the five. An unreferenced destination costs nothing, holds no data and breaks nothing, and the customer removes it in Stream in one click. If this ever matters, the fix is not a DELETE grant on its own — it is recording at create time that this app created it, and offering the teardown step only then.`,
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
