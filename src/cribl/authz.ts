// What this app knows about what the person using it is allowed to do — which
// is less than the phrase "permission gate" suggests, so the honest answer is
// written down here once rather than guessed at each button.
//
// THE SHORT VERSION: the app cannot tell, BEFORE a click, whether the person
// pressing a button may perform the write behind it. Three things say so.
//
//   * `window.getCriblUser()` carries id, username, email, first/last name and
//     initials and nothing else (AGENTS.md, "How to Get User Info"; the same six
//     fields are typed in cribl/config.ts). No roles, no permissions. A control
//     that greys itself out on identity alone would be inventing its reason.
//   * A real "what may I do" API does exist — `GET /authorize/policy` answers
//     with `{ object, actions[] }` entries in the same grammar as
//     config/policies.yml, and `GET /authorize/roles` with the caller's roles.
//     It is deliberately NOT called here, and the reason is decisive rather than
//     fastidious: AGENTS.md says the app's declared policies are granted to the
//     user "for the duration of any request made through your app", and nothing
//     documents whether /authorize/policy answers the user's BASE policy or that
//     AUGMENTED one. If it answers base-only, gating on it disables Deploy for
//     exactly the non-admins config/policies.yml was extended to serve — and it
//     disables it silently, producing no 403 for anyone to debug. That is the
//     slice-1.3 bug run again from the other end. Answering the question needs
//     the app installed and a non-admin account; until somebody has that, this
//     module does not pretend.
//   * Hardcoding `org_admin` / `ws_admin` is not a fallback either. Customers
//     define their own roles, and it is the app's own grant rather than the role
//     that decides whether a call through the app succeeds.
//
// SO THE GATE IS RETROSPECTIVE, NOT PREDICTIVE. It attempts; if Cribl refuses,
// it turns the refusal into a sentence that names the method and the path, and
// it holds the control closed until the person says try again. The cost, stated
// plainly rather than buried: the first non-admin to press Deploy still gets a
// failure rather than a disabled button, and may be left with a partly-applied
// stack, because the app only learns the boundary by touching it. That is
// accepted because the alternative fails in the worse direction — a predictive
// gate built on an unverified matcher and an unresolved base-vs-augmented
// question breaks the feature for the people the grants exist to serve, and it
// fails invisibly. This failure is loud, self-correcting on the second click,
// and leaves something a support engineer can read.
//
// 401 AND 403 ARE THE SAME EVENT HERE. The Cribl endpoints provisioning writes
// through document 401 and not 403 (POST /system/inputs answers 200/401/409/500,
// for instance), and the app fetch-proxy's own status for a path missing from
// policies.yml — the exact slice-1.3 failure — is documented nowhere at all. A
// classifier that only knew 403 would miss the bug this slice exists to catch.
//
// WHAT THE SENTENCE MAY NOT SAY. Cribl's own wording for this status, on 42
// endpoints of the 4.19.0 spec, is "Not authorized or licensed to perform this
// action." — authorization and licensing in one breath. So even a perfectly
// detected refusal cannot honestly be rendered as "you do not have permission".
// The copy below says "usually a permission, and sometimes a licensing limit",
// because that is what is actually known.
//
// THE LEDGER IS SESSION MEMORY AND NEVER LEAVES THE PAGE. It is deliberately not
// in the KV store: an install-wide "you cannot" would outlive the grant that
// fixed it, and would be shown to viewers it was never about. A reload clears
// it, which is the right default — the next attempt is cheap and truthful.

import { useSyncExternalStore } from 'react'

// --- What a write touches -------------------------------------------------

/**
 * Which authorization story a write belongs to. The three are governed by
 * different things, so a refusal means something different in each and the
 * sentence a customer reads has to differ too.
 */
export type WriteSurface =
  /** Customer configuration in Cribl, governed by config/policies.yml and by the
   *  caller's own role. This is the surface a non-admin can be refused on. */
  | 'config'
  /** This app's own app-scoped KV store. AGENTS.md: app-scoped paths are granted
   *  automatically with the app and must not be declared — so a refusal here is
   *  not a permission an admin grants separately. */
  | 'app'
  /**
   * A Cribl Search job and its cancel. Not configuration: nothing is created
   * that outlives the query, and gating the submit would gate every panel.
   *
   * Every write on this surface is the signed-in user's own job, including the
   * long-running-search watch's — it lists every search the account can see and
   * cancels only `mine === true`, because the app does not stop work it did not
   * start. What separates `jobWatchdog.ts#cancelHungJob` from the other two is
   * not the owner but the age: search.ts cancels a job this session submitted
   * seconds ago and has already walked away from, and that one ends a search
   * somebody may have been waiting hours on. So it is the one `search` write
   * with a confirmation and a gate.
   */
  | 'search'

/** Every control in this app that performs a write. One id per control, because
 *  the id is what a `<GatedControl>` carries and what a denial is latched to. */
export type WriteId =
  | 'onboarding_stack.apply'
  | 'onboarding_stack.remove'
  | 'search_caps.save'
  | 'dataset_intel.generate'
  | 'hung_job.cancel'
  | 'accel.apply'
  | 'accel.pause'
  | 'accel.remove'
  | 'lake_landing.retention'
  | 'lake_landing.description'
  | 'lake_landing.destination'
  | 'onboarding_pack.install'
  | 'onboarding_pack.upgrade'
  | 'onboarding_pack.remove'
  | 'onboarding_pack.configure'

export interface GatedWrite {
  surface: WriteSurface
  /**
   * What the control does, as a noun phrase the denial sentence finishes: "…so
   * <does> did not complete". Written here rather than passed by the caller so
   * two controls cannot describe the same write differently.
   */
  does: string
  /**
   * Set only while NO control renders this id yet, and why: the write is built
   * a slice ahead of its UI. gatedWrites.test.ts accepts a missing
   * `<GatedControl>` for it only while every write it gates sits in a module on
   * paths.ts `UNREACHED_MODULES` (nothing on screen can reach it), and fails as
   * soon as a control renders the id with this still set.
   */
  unrendered?: string
}

/** The controls, and what each one is. */
export const GATED_WRITES: Record<WriteId, GatedWrite> = {
  'onboarding_stack.apply': {
    surface: 'config',
    does: 'applying the Gigamon AMI onboarding stack',
  },
  'onboarding_stack.remove': {
    surface: 'config',
    does: 'removing the Gigamon AMI onboarding stack',
  },
  'search_caps.save': {
    surface: 'app',
    does: 'saving the search running-time limits',
  },
  'dataset_intel.generate': {
    surface: 'config',
    does: 'generating dataset intelligence',
  },
  // The only `search` write with a gate, and the reason is in WriteSurface
  // above: it ends a search that may be hours old rather than seconds. Whether a
  // non-admin can cancel even their OWN job through this app is unverified
  // (V-66/V-S11 — every account this was tried on was an admin), so the gate
  // earns its place: when Cribl refuses, the sentence names POST and the path an
  // admin has to grant instead of leaving a button that does nothing.
  'hung_job.cancel': {
    surface: 'search',
    does: 'cancelling one of your own long-running searches',
  },
  // Phase 2's three. They are `config` and not `search`, and the distinction is
  // not a formality: a saved search is an object in the workspace that outlives
  // the page, fires on a cron whether or not anybody is looking, and bills for
  // it. Every other `search` write in this table ends a job or starts one that
  // dies with the query. These create, edit and delete configuration, so they
  // are governed by config/policies.yml and can be refused for a non-admin.
  'accel.apply': {
    surface: 'config',
    does: 'creating the scheduled searches that precompute the slow panels',
  },
  // Pause and resume are one control and therefore one id: both are the same
  // PATCH of the same object, differing only in one boolean, and splitting them
  // would mean a refusal latched on Pause left Resume looking available. The
  // per-dashboard and master switches (2026-09-24) are the same PATCH on a
  // subset of the same objects, so they share the id for the same reason: a
  // refusal on a switch must not leave the row's Pause looking available.
  'accel.pause': {
    surface: 'config',
    does: 'pausing or resuming scheduled searches',
  },
  'accel.remove': {
    surface: 'config',
    does: 'removing the scheduled searches this app created',
  },
  // Phase 3's three. All `config`: they edit objects in the customer's Cribl
  // that outlive the page, and every one of them can be refused for a non-admin.
  //
  // THREE AND NOT FIVE. The reader toggle and the partitions editor were
  // specified and are not built — they are gated on spikes that have not run
  // (P-S5, P-S7, P-S9; see SPIKE_GATED in cribl/landing.ts) — so there is no id
  // for either. An id with no writer behind it would be a control this table
  // promises and nothing performs, and gatedWrites.test.ts would be waiting for
  // a button that is deliberately absent.
  'lake_landing.retention': {
    surface: 'config',
    does: 'changing how long Cribl Lake keeps this dataset',
  },
  'lake_landing.description': {
    surface: 'config',
    does: 'changing the dataset description',
  },
  // ONE ID FOR THREE CALLS, and that is the honest shape rather than a shortcut:
  // the PATCH, the commit and the deploy are one user intent — a flush change
  // that is not committed and deployed has not happened — so splitting them
  // would leave a refusal latched on one control while the other two still
  // looked available for a change that can no longer complete.
  'lake_landing.destination': {
    surface: 'config',
    does: 'changing how objects are written to Cribl Lake, and deploying it',
  },
  // The onboarding pack's four (cribl/packClient.ts). All `config`: each
  // installs, edits or removes objects in a worker group and ends in a commit
  // and a deploy. The UI is the next slice; until it renders them, each is
  // `unrendered`, and the module is on paths.ts `UNREACHED_MODULES`.
  'onboarding_pack.install': {
    surface: 'config',
    does: 'installing the Gigamon AMI onboarding pack',
    unrendered: 'Guided Setup’s pack UI is the next slice; packClient.ts is built ahead of it and nothing on screen reaches it yet.',
  },
  'onboarding_pack.upgrade': {
    surface: 'config',
    does: 'upgrading the Gigamon AMI onboarding pack',
    unrendered: 'Guided Setup’s pack UI is the next slice; packClient.ts is built ahead of it and nothing on screen reaches it yet.',
  },
  'onboarding_pack.remove': {
    surface: 'config',
    does: 'removing the Gigamon AMI onboarding pack',
    unrendered: 'Guided Setup’s pack UI is the next slice; packClient.ts is built ahead of it and nothing on screen reaches it yet.',
  },
  // ONE ID FOR THE PACK SOURCES' SETTINGS: port, token, TLS, enable and the
  // sample's opt-in are all the same whole-body PATCH of a pack source, so a
  // refusal of one is a refusal of all of them.
  'onboarding_pack.configure': {
    surface: 'config',
    does: 'changing the onboarding pack’s sources',
    unrendered: 'Guided Setup’s pack UI is the next slice; packClient.ts is built ahead of it and nothing on screen reaches it yet.',
  },
}

// --- Where the writes actually are ----------------------------------------

/**
 * One function in this app that issues a write request, and how it is governed.
 *
 * This table is the subject of src/components/gatedWrites.test.ts, which finds
 * the write calls in the source and refuses to pass until every one of them is
 * named here. That is the whole point: a new write cannot arrive without
 * somebody writing down which control owns it, and a `config` write cannot
 * arrive without a `<GatedControl>` existing for it. The alternative — grepping
 * markup for buttons whose label contains a verb — produces false positives
 * forever and gets switched off within a month.
 */
export interface WriteSite {
  /** `<path under src/>#<function>` — where the write call is. */
  at: string
  /**
   * The controls that can reach this write. A `config` write must name at least
   * one; `app` and `search` writes may name none, with the reason in `why`.
   * Shared plumbing (the commit, the deploy) legitimately names two.
   */
  gates: readonly WriteId[]
  surface: WriteSurface
  /** Why it is classified this way. Read by a human, quoted by the test. */
  why: string
}

export const WRITE_SITES: readonly WriteSite[] = [
  // --- Guided Setup: the only customer configuration this app writes --------
  {
    at: 'cribl/provision.ts#ensureDataset',
    gates: ['onboarding_stack.apply'],
    surface: 'config',
    why: 'POST creates the Cribl Lake dataset the dashboards read, when the tenant has none.',
  },
  {
    at: 'cribl/provision.ts#ensureDestination',
    gates: ['onboarding_stack.apply'],
    surface: 'config',
    why: 'POST creates the Cribl Lake destination on a tenant that lacks it.',
  },
  {
    at: 'cribl/provision.ts#ensureBreaker',
    gates: ['onboarding_stack.apply'],
    surface: 'config',
    why: 'POST creates the event breaker ruleset the Raw HTTP source names, in the group library; PATCH overwrites its rules on a re-apply, only when the live ruleset differs, and as a read-modify-write of the whole object because the endpoint deletes any field a PATCH omits.',
  },
  {
    at: 'cribl/provision.ts#ensurePipeline',
    gates: ['onboarding_stack.apply'],
    surface: 'config',
    why: 'POST creates the parse/normalize pipeline; PATCH overwrites its function list on a re-apply — but only when the live list does not already say what the spec says. Until Phase 3 it PATCHed whenever the object existed, so a re-apply of a settled stack wrote twice, dirtied the group\'s Git status and carried the run on into a deploy that restarts Worker Processes.',
  },
  {
    at: 'cribl/provision.ts#ensureSource',
    gates: ['onboarding_stack.apply'],
    surface: 'config',
    why: 'POST creates the Raw HTTP source, with the port, TLS mode and app-generated auth token chosen at creation; PATCH overwrites its other settings on a re-apply, only when the live source differs, and never its port, TLS or token. Both writes are behind the same confirmation as the rest of the stack, and additionally behind the per-object `confirm` this function takes, which is where a caller can be shown what is about to change rather than only which object.',
  },
  {
    at: 'cribl/provision.ts#ensureRoute',
    gates: ['onboarding_stack.apply'],
    surface: 'config',
    why: 'PATCH replaces the group routing table wholesale — the most consequential write in the app.',
  },
  {
    at: 'cribl/provision.ts#deployGroup',
    gates: ['onboarding_stack.apply', 'onboarding_stack.remove', 'onboarding_pack.install', 'onboarding_pack.upgrade', 'onboarding_pack.remove', 'onboarding_pack.configure'],
    surface: 'config',
    why: 'PATCH .../deploy restarts the group Workers on the new configuration. Both Guided Setup controls end here, and so does every onboarding-pack write, through packClient.ts commitAndDeployPack.',
  },
  {
    at: 'cribl/provision.ts#commitAndDeploy',
    gates: ['onboarding_stack.apply', 'onboarding_stack.remove', 'onboarding_pack.install', 'onboarding_pack.upgrade', 'onboarding_pack.remove', 'onboarding_pack.configure'],
    surface: 'config',
    why: 'POST /version/commit writes a Git commit on the Leader. Both Guided Setup controls end here, and so does every onboarding-pack write (packClient.ts commitAndDeployPack, via commitMatchingAndDeploy), scoped to the pack’s own directories.',
  },
  {
    at: 'cribl/provision.ts#removeOnboardingStack',
    gates: ['onboarding_stack.remove'],
    surface: 'config',
    why: 'PATCH drops our routes from the table — this release’s, the Syslog route an earlier release created, or both; DELETE removes the Raw HTTP source and the pipeline, and the old Syslog source and pipeline. Only what the status check found present, which is exactly what the confirmation names. The same control also removes the old Syslog objects alone.',
  },
  {
    at: 'cribl/provision.ts#removeBreaker',
    gates: ['onboarding_stack.remove'],
    surface: 'config',
    why: 'DELETE removes the breaker ruleset in the teardown — only once its source is gone, only when it carries this app’s description, and only when no other source in the group, or in a pack, names it.',
  },

  // --- The onboarding pack (not yet reachable from any screen) -------------
  {
    at: 'cribl/packClient.ts#installPack',
    gates: ['onboarding_pack.install'],
    surface: 'config',
    why: 'POST /packs installs the pack from its pinned GitHub release into the picked group — refused until that release exists and its sha256 is recorded, and refused when the pack is already there.',
  },
  {
    at: 'cribl/packClient.ts#upgradePack',
    gates: ['onboarding_pack.upgrade'],
    surface: 'config',
    why: 'PATCH /packs/<id> upgrades the installed pack in place — only from a version this app published and installed from that version’s release, never downward.',
  },
  {
    at: 'cribl/packClient.ts#removePack',
    gates: ['onboarding_pack.remove'],
    surface: 'config',
    why: 'DELETE /packs/<id> uninstalls the pack — only when the installed id is this app’s, its version is one this app published, and the pack list names that version’s release as where it came from.',
  },
  {
    at: 'cribl/packClient.ts#patchPackInput',
    gates: ['onboarding_pack.install', 'onboarding_pack.configure'],
    surface: 'config',
    why: 'PATCH replaces one of the pack’s two sources WHOLESALE, so the body is the live source re-read in the same call (readLive) with only the port, token, TLS or disabled flag changed — and nothing is sent when that read no longer gives the diff the confirmation showed. Install ends here too: a freshly installed Raw HTTP source is disabled with no token until this sets them.',
  },

  // --- Phase 2 acceleration: the scheduled searches this app owns ----------
  {
    at: 'cribl/accel/provision.ts#createSaved',
    gates: ['accel.apply'],
    surface: 'config',
    why: 'POST creates a scheduled saved search in the shared /search/saved namespace. It runs on a cron and bills whether or not anybody opens the panel it feeds, so the confirmation in components/AccelPanel.tsx states the recurring cost before the click.',
  },
  {
    at: 'cribl/accel/provision.ts#patchSaved',
    gates: ['accel.apply', 'accel.pause'],
    surface: 'config',
    why: 'PATCH replaces a saved search WHOLESALE — A-SP23 measured that an omitted field is a deleted field on this endpoint, which is how a search silently loses its schedule. Three controls end here: Apply, correcting one that has drifted; Pause/Resume in a row, flipping schedule.enabled; and the per-dashboard and master switches, flipping it on exactly the subset their confirmation names (setAccelSchedules), each refused if it changed since the dialog opened.',
  },
  {
    at: 'cribl/accel/provision.ts#deleteSaved',
    gates: ['accel.remove'],
    surface: 'config',
    why: 'DELETE removes a saved search. The namespace is flat and shared, so the call is guarded by the gno_ prefix, membership in the manifest and an ownership stamp before it is sent; the confirmation names both ids and warns that uninstalling the app does not remove them.',
  },

  // --- Phase 3: the Lake landing panel ------------------------------------
  {
    at: 'cribl/lakeLanding.ts#setRetention',
    gates: ['lake_landing.retention'],
    surface: 'config',
    why: 'PATCH changes retentionPeriodInDays on the live Cribl Lake dataset. A DECREASE deletes everything older than the new window immediately, and unlike every other write in this app there is nothing to revert — Lake datasets are under no version control, so there is no commit and no snapshot. The confirmation for a decrease states that, names the current size and the day it was measured, and requires the dataset id to be typed.',
  },
  {
    at: 'cribl/lakeLanding.ts#setDescription',
    gates: ['lake_landing.description'],
    surface: 'config',
    why: 'PATCH changes the dataset description. The smallest write in the phase and the only Lake field whose worst outcome is cosmetic, which is what makes it the one an admin can use to find out whether they may write to Lake at all before they try it on retention. Still confirmed: it still overwrites a field on an object everybody reads.',
  },
  {
    at: 'cribl/lakeLanding.ts#updateDestination',
    gates: ['lake_landing.destination'],
    surface: 'config',
    why: 'PATCH replaces the gigamon_lake destination WHOLESALE, so the body sent is the live object re-read inside this function with only the edited keys changed. One confirmation covers the whole intent: it shows the exact before→after, names every feed writing through the destination (resolved from the sources and the routing table, because a QuickConnect binding appears in neither the routes nor any hard-coded list), and states the pending-file count the commit will carry.',
  },
  {
    at: 'cribl/lakeLanding.ts#commitAndDeployDestination',
    gates: ['lake_landing.destination'],
    surface: 'config',
    why: 'POST /version/commit writes a Git commit on the Leader for exactly this group\'s outputs.yml — never an empty file list, which would sweep up every pending change anywhere in the repository. Declared separately from the PATCH because the gate is retrospective: a Member can be refused here having succeeded there, leaving a destination changed and not deployed, and the step list this returns is the only thing that says so.',
  },
  {
    at: 'cribl/lakeLanding.ts#deployGroupConfig',
    gates: ['lake_landing.destination'],
    surface: 'config',
    why: 'PATCH .../deploy pushes the commit to the group\'s running Workers, WHICH RESTARTS ITS WORKER PROCESSES — the dialog says so before the press, not in a toast afterwards. The 404 fallback to the deprecated /master path is only on 404: a 403 cannot be granted by a second path, and a 5xx deploy may already have started server-side, so a blind retry would be a second deploy.',
  },

  // --- Cribl Search AI -----------------------------------------------------
  {
    at: 'cribl/datasetIntel.ts#generateDatasetIntel',
    gates: ['dataset_intel.generate'],
    surface: 'config',
    why: 'POST asks Cribl to generate and store the AI schema summary for the Lake dataset — a Cribl-side write under a declared policy path, so it can be refused.',
  },

  // --- This app's own store ------------------------------------------------
  {
    at: 'cribl/kv.ts#putDoc',
    gates: [],
    surface: 'app',
    why:
      'Writes one of this app\'s own documents in the app-scoped store, which AGENTS.md grants with the app itself. Its ' +
      'callers report their own refusal in their own words (searchCaps.ts, prefs.ts, setupMemory.ts, and accel/mode.ts ' +
      'for the Snapshot / Live choice, whose refusal surfaces as the line beside the control). Only the one a customer ' +
      'pressed Save for is gated, as search_caps.save. THE SNAPSHOT / LIVE MODE DELIBERATELY GETS NO WriteId OF ITS OWN, ' +
      'against the handoff note that asked for one: a WriteId is the id a GatedControl carries, and the ' +
      '"every gate is actually rendered" case in gatedWrites.test.ts fails any GATED_WRITES entry nothing renders a ' +
      'control for — for EVERY surface, not only config, which is what that note misread. The control it would force is ' +
      'a dialog asking permission to remember a display preference, and a fourth confirmation pattern makes the three ' +
      'that guard Worker Process restarts cheaper. The reasoning in full is in cribl/dataMode.ts\'s header.',
  },
  {
    at: 'cribl/kv.ts#deleteDoc',
    gates: [],
    surface: 'app',
    why: 'Reachable code with no production caller — nothing in the UI removes a stored document. If one ever does, it needs a confirmation naming the key and an entry here.',
  },
  {
    at: 'cribl/kv.ts#listKeys',
    gates: [],
    surface: 'app',
    why: 'A POST that reads: the store takes the key prefix in a body rather than in the URL. The method makes it look volatile; it changes nothing.',
  },

  // --- Cribl Search jobs ---------------------------------------------------
  {
    at: 'cribl/search.ts#submitJob',
    gates: [],
    surface: 'search',
    why: 'POST creates a search job for this same user. Not configuration, and gating it would gate every panel on the dashboard.',
  },
  {
    at: 'cribl/search.ts#cancelJob',
    gates: [],
    surface: 'search',
    why: 'POST cancels a job this session created seconds earlier, so an abandoned search stops billing. Never user-triggered, and it stops work rather than starting it.',
  },
  {
    at: 'cribl/jobWatchdog.ts#cancelHungJob',
    gates: ['hung_job.cancel'],
    surface: 'search',
    why:
      'POST cancels a long-running search of the SIGNED-IN USER\'S OWN that this session did not start — one left running in Cribl Search, or one of this app\'s own queries the running-time cap failed to stop. The drawer lists every long-running search the account can see and offers Cancel only where `mine === true`; the store refuses the rest again at the moment of the click. It is gated because it ends a search that may be hours old rather than seconds: a deliberate click on a row in components/JobWatchdog.tsx, a ConfirmDialog naming the job id and its age, and the outcome reported as a toast. Never from a render, a timer or a retry.',
  },
]

// --- The ledger of refusals actually observed ------------------------------

/**
 * What caused a call, which decides whether a control may be blamed for its
 * refusal.
 *
 * `click` is the assumption every caller had until slice 1.8: the app only
 * talked to Cribl because somebody pressed something, so a refusal recorded
 * while a write ran belonged to that write. The long-running-search watch broke
 * it — a GET every five minutes, on a timer, forever. Its 403 is a real refusal
 * and is still recorded, but attributing it to whatever button happened to be
 * running is a lie about the user's own click, and a latched button is
 * expensive: it tells somebody they may not do a thing they may in fact do.
 */
export type DenialOrigin = 'click' | 'background'

/** One call the platform refused, as a control needs to describe it. */
export interface Denial {
  /** The HTTP method Cribl refused. */
  method: string
  /** The path it refused, query string stripped — what an admin would grant. */
  path: string
  /** 401 or 403. */
  status: number
  /** Cribl's own sentence, when it sent one. */
  message?: string
  /** Position in this session's ledger, so a control can ask "since when". */
  seq: number
  /** What made the call. Only a `click` is ever attributed to a control. */
  origin: DenialOrigin
}

/**
 * Whether a status is the platform saying no.
 *
 * Both, always. See the header: the write endpoints document 401 rather than
 * 403, and the app fetch-proxy's status for an undeclared path is documented
 * nowhere — so treating only 403 as a refusal would miss the bug class this
 * whole slice was built around.
 */
export const isDenial = (status: number): boolean => status === 401 || status === 403

/** Refusals seen this page, newest last. Trimmed: a control only ever looks at
 *  the handful recorded during its own attempt. */
const ledger: Denial[] = []
const LEDGER_MAX = 50
let seq = 0

/**
 * Record that the platform refused a call.
 *
 * Called from cribl/capi.ts, which is the one transport every configuration and
 * KV call in this app leaves through — so the ledger is complete by
 * construction rather than by everyone remembering to report. A caller that
 * uses `fetch` directly (cribl/datasetIntel.ts) reports here itself.
 */
export function noteDenial(
  method: string,
  path: string,
  status: number,
  message?: string,
  origin: DenialOrigin = 'click',
): void {
  if (!isDenial(status)) return
  // The query string is not part of what an admin grants — `object` in
  // policies.yml is a path throughout — so it is dropped rather than shown back
  // to somebody who has to act on it.
  const bare = path.split('?')[0]
  seq += 1
  ledger.push({ method: method.toUpperCase(), path: bare, status, message, seq, origin })
  if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX)
}

/** Where the ledger stands right now. A control takes this before it attempts. */
export const denialMark = (): number => seq

/**
 * The FIRST refusal of the CALLER'S OWN work since `mark`, or null when there
 * was none.
 *
 * First, not last, on purpose: in a run of several calls the first refusal is
 * the one that stopped it, and anything after is a consequence of continuing.
 * The customer needs the object that actually has to be granted.
 *
 * Background refusals are skipped, and that is the whole reason `origin` exists.
 * This function answers "was the thing I just did refused?", and a poll that
 * runs on a timer is not something the person did — see DenialOrigin. It stays
 * in the ledger; it is simply never somebody's click.
 */
export function denialSince(mark: number): Denial | null {
  return ledger.find((d) => d.seq > mark && d.origin === 'click') ?? null
}

/** Only for tests: forget everything this page has observed. */
export function resetDenials(): void {
  ledger.length = 0
  seq = 0
  latched.clear()
  emit()
}

// --- What a control does with one ------------------------------------------

const latched = new Map<WriteId, Denial>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** Hold a control closed because this attempt was refused. */
export function latchDenial(id: WriteId, denial: Denial): void {
  latched.set(id, denial)
  emit()
}

/** Open it again — "Try again". The next click attempts for real. */
export function clearDenial(id: WriteId): void {
  if (latched.delete(id)) emit()
}

/**
 * The sentence a customer reads. It names the method and the path because that
 * pair is precisely what an admin needs in order to grant it; "you do not have
 * permission" names nothing and cannot be acted on.
 */
export function denialReason(id: WriteId, d: Denial): string {
  const { surface, does } = GATED_WRITES[id]
  const said = d.message ? ` Cribl said: “${d.message}”.` : ''
  if (surface === 'app') {
    return (
      `The app’s own store refused ${d.method} ${d.path} (HTTP ${d.status}), so ${does} did not complete. ` +
      `That store is scoped to this app and is granted with the app itself, so this is not a permission an ` +
      `admin grants separately — it means the platform is refusing this app’s own calls.${said}`
    )
  }
  return (
    `Cribl refused ${d.method} ${d.path} (HTTP ${d.status}), so ${does} did not complete. ` +
    `That is usually a permission this account does not have — an admin can grant it by sharing this app, ` +
    `or by granting that path to your role — and it can also be a licensing limit: Cribl answers the same ` +
    `status for both and does not say which.${said}`
  )
}

export interface WriteGate {
  /** The refusal holding this control closed, or null when it is open. */
  denied: Denial | null
  /** That refusal as a sentence, or null. */
  reason: string | null
  /** Open the control again. */
  clear: () => void
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/**
 * Read one control's gate.
 *
 * `<GatedControl>` uses this to disable itself; a screen that has a second,
 * outer trigger for the same write — Guided Setup's "Deploy onboarding stack"
 * button, which only opens a confirmation — uses it to disable that trigger too,
 * so nobody is walked into a confirmation they cannot complete.
 */
export function useWriteGate(id: WriteId): WriteGate {
  const denied = useSyncExternalStore(
    subscribe,
    () => latched.get(id) ?? null,
    () => null,
  )
  return {
    denied,
    reason: denied ? denialReason(id, denied) : null,
    clear: () => clearDenial(id),
  }
}
