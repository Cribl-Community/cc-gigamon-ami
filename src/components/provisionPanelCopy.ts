// What Guided Setup's confirmations say about reach, pure and DOM-free.
//
// The same split components/lakeLandingCopy.ts and components/accelPanelCopy.ts
// make, for the same reason: what this screen can get wrong is not its markup,
// it is whether a sentence about somebody else's configuration is true. A pure
// function of a context object can be asserted directly; the same sentence read
// back out of a rendered dialog can only be matched as a substring of one long
// string.
//
// ── THE SENTENCE THIS MODULE EXISTS TO RETIRE ───────────────────────────────
//
// `Nothing else in ${group} is touched, including the demo DataGen source.`
//
// It shipped. It is in the installed 1.0.20. It is TRUE about what this app
// WRITES — `ensureSource` PATCHes one object, `ensurePipeline` one pipeline,
// `ensureRoute` splices or replaces one entry and carries the rest of the table
// back out untouched — and FALSE about what the commit CARRIES.
//
// `POST /version/commit` takes FILE PATHS. openapi.json, GitCommitBody.files:
// "Array of file paths to include in the commit… If omitted, all pending
// changes are committed." Paths, never hunks. And a worker group's sources all
// live in ONE file:
//
//   groups/<g>/local/cribl/inputs.yml    every Source in the group, INCLUDING
//                                        the demo DataGen one this sentence
//                                        promised was untouched
//   groups/<g>/local/cribl/pipelines/route.yml    THE routing table — one ordered array,
//                                        so another admin's pending work and
//                                        this app's edit are the same YAML node
//   groups/<g>/local/cribl/outputs.yml   every Destination in the group
//
// So the press commits, and the deploy pushes to running Workers, whatever
// anybody else had left uncommitted in those files. No ordering, no re-read and
// no narrower write fixes that — it is a property of the commit API and of the
// file layout — which is why this is a copy change and not a behaviour change.
//
// THE MODEL IS cribl/landing.ts's DEPLOY_CONSEQUENCES, which has stated this
// correctly for the Lake landing panel since Phase 3 and is reused verbatim
// below rather than paraphrased into a second vocabulary for the same fact.
//
// TWO SENTENCES, NOT ONE. What this app writes and what the commit reaches are
// different claims and the old copy collapsed them. The first stays — narrowed
// to "writes" — because it is true and it is what somebody is actually asking.
//
// WHAT IS LEFT (2026-09-25). The Raw HTTP deploy and its dialog, picker, port
// field and endpoint card were withdrawn when the onboarding collapsed into the
// pack's, and their words went with them (`deployConsequences`, `deployNote`,
// `PROVISION_LEAD`, `GROUP_TIP`, `PORT_TIP`, `ENDPOINT_TIP`,
// `ENDPOINT_INCOMPLETE`, `TOKEN_ELSEWHERE`, `SETUP_FACTS`, `setupFacts`). What
// stays is the teardown's copy, the reach sentences the onboarding plan reuses,
// the pack's endpoint-card words and the page's "What gets created" list.
//
// WHAT IS LEFT (2026-09-26, `chore/remove-global-stacks`). The teardown of the
// global Raw HTTP and Syslog stacks went with its panel (owner decision: new
// installs never have them), and its words with it (`removeConsequences`,
// `removalPendingSentence`, `leftAloneSentence`, `legacyNote`, `LEGACY_TIP`,
// `LEGACY_ONLY_LEAD`, `LEGACY_ONLY_TIP`, `REMOVE_UNDO`, `behindNote`,
// `behindTip`). What stays is what the onboarding plan's dialogs reuse, the
// pack's endpoint-card words and the page's "What gets created" list.

import { CLOUD_PORT_RANGE, type CommitScope } from '../cribl/provision'
import {
  PACK_BREAKER_ID, PACK_HTTP_INPUT_ID, PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_ID, PACK_LAKE_DATASET_ID,
  PACK_PARQUET_DATASET_ID, PACK_PARQUET_PIPELINE_ID, PACK_PIPELINE_ID,
} from '../cribl/pack'

export interface ProvisionConfirmContext {
  group: string
  /** What the commit can carry and what is already uncommitted in it. Null
   *  while the status check is still running, or when it failed — the copy says
   *  which rather than implying a clean tree. */
  scope: CommitScope | null
  /** A commit this group has not deployed, from `pendingDeploy`. */
  undeployed: string | null
  /** True when `pendingDeploy` had not answered yet as the dialog opened —
   *  `undeployed` is then no answer at all, and the copy says so. */
  undeployedChecking?: boolean
}

/**
 * What the dialog says about a commit the group has not deployed, or null when
 * there is none.
 *
 * FROZEN AT OPEN. `pendingDeploy` reads `/version/files` once per commit the
 * group is behind, so it can still be out when somebody opens a dialog — and a
 * sentence that appeared while the reader was already reading would be a claim
 * changing underneath them. The onboarding panel captures the answer as the
 * dialog opens and passes that; "still checking" is worded about the moment of opening
 * so it stays true however long the dialog is left open.
 *
 * Every dialog gets it, removals included: a removal commits and deploys too,
 * and a deploy moves the group to a commit, carrying everything before it.
 */
export function undeployedSentence(ctx: ProvisionConfirmContext): string | null {
  const { group, undeployed } = ctx
  if (ctx.undeployedChecking) {
    return (
      `When this dialog opened, this app was still checking whether ${group} is behind a commit that touches it. If it is, this ` +
      'press moves the group to the commit it creates, so that one and everything else committed since go live with it.'
    )
  }
  // NOT "it also deploys commit #X", which was the old wording and denied by
  // its own grammar what the deploy actually does. `pendingDeploy` returns the
  // Leader's HEAD, and a deploy moves the group to it.
  if (!undeployed) return null
  return (
    `${group} is behind commit #${undeployed.slice(0, 10)}, this Leader’s current HEAD, which it has never deployed. This press moves ` +
    'the group to the commit it creates, so that one and everything else committed since go live with it.'
  )
}

/**
 * What Git already holds in the files this commit names.
 *
 * THE CONDITION IS CHECKED, not warned about unconditionally. A warning that
 * fires when nothing is pending is the one people learn to click past, and this
 * app can actually ask: `GET /version/status` is already granted and already
 * read on every status check. The three answers are genuinely different and get
 * genuinely different sentences — and "could not tell" is never rendered as
 * "nothing is pending", which is the failure mode of a single boolean.
 *
 * THE OPPOSITE FAILURE ALSO SHIPPED, and it was worse. `pendingConfigPaths`
 * answered `null` for an EMPTY list as well as for a failed read, so on a
 * healthy workspace — the common case — every one of these dialogs rendered the
 * "could not tell… Assume it may be" branch. A warning that always fires is the
 * one people learn to click past, and it carried the two that mean something
 * with it. The fix is in cribl/provision.ts: `[]` is now an answer.
 */
export function pendingSentence(ctx: ProvisionConfirmContext): string {
  const { scope, group } = ctx
  if (scope === null || scope.unknown) {
    return (
      `Cribl did not report what is already uncommitted in ${group}, so this app cannot tell you whether anybody else’s unfinished work is ` +
      'sitting in those files. Assume it may be.'
    )
  }
  if (scope.alreadyDirty.length === 0) {
    return (
      `Cribl reports nothing already uncommitted in those files, so this commit carries only what this run changes. That was read when this ` +
      'dialog opened, and anybody can save a change in Cribl while it is open.'
    )
  }
  return (
    `Cribl reports ${scope.alreadyDirty.length} of those file${scope.alreadyDirty.length === 1 ? '' : 's'} already carrying uncommitted changes — ` +
    `somebody else’s unfinished work, which this press commits and deploys along with this run’s: ${scope.alreadyDirty.join(', ')}.`
  )
}

/**
 * The files the commit CAN name, said as whole files. `scope` is null only
 * before the first status check lands, and the dialog cannot open before then.
 *
 * "CAN", NOT "WILL", AND THE FILES ARE STILL NAMED. `scope.carries` is built
 * from every resource key the dialog was given, but `deployAll` commits
 * `touchedKeys` — only the resources that actually came back `created` or
 * `updated`. On a settled stack that is one file, or none, where this sentence
 * named four. The true set is not knowable here: the dialog is shown BEFORE the
 * run, and which objects drift is decided by the reads inside it. So the
 * sentence says the knowable thing — the set the commit is drawn from — rather
 * than retreating to "some configuration files", which would cost the reader
 * the one fact they need: that `inputs.yml` is in the set at all.
 */
export function carriesSentence(ctx: ProvisionConfirmContext, verb: string): string {
  const files = ctx.scope?.carries ?? []
  if (files.length === 0) return `The change is committed and deployed to ${ctx.group}.`
  return (
    `The ${verb} is committed and deployed to ${ctx.group}. The commit names whole files, not single objects, and it names only the ` +
    `files this run actually changes — drawn from these: ${files.join(', ')}.`
  )
}

/**
 * What a Raw HTTP source may do while the Worker Processes restart. Said in the
 * onboarding plan's dialogs, and NOT in DEPLOY_CONSEQUENCES, which the
 * Lake landing panel shares and where no such source need exist. Worded as a
 * precaution because it is one: whether the source refuses a POST mid-restart,
 * or holds the connection, has not been measured.
 */
export const HTTP_RESTART_PRECAUTION =
  'While the Worker Processes restart, a Raw HTTP source can briefly fail to accept a POST, so set Gigamon AMX to retry a failed POST.'

// ── The endpoint card ────────────────────────────────────────────────────────

/** The one line on "Point Gigamon AMX here". */
export const ENDPOINT_LEAD = 'Configure Gigamon AMX to POST AMI records, as JSON arrays, to this URL with this token.'

/**
 * The header AMX must send, exactly. openapi.json (InputHttpRaw.authTokensExt):
 * "Shared secrets to be provided by any client (Authorization: <token>)" — the
 * token is the whole header value. NOT CHECKED against a live source: that takes
 * a POST to one, which is a write this app's reviewers may not make.
 */
export const AUTH_HEADER = 'Authorization: <token>'

/** Shown beside the token, the one time it is shown. */
export const TOKEN_ONCE =
  'Shown once. Copy it now: this app keeps no copy, and reloading the page clears it. Cribl keeps it in the source’s authentication settings.'

/** On a hybrid group, whose source starts without TLS. Plain on purpose. */
export const UNENCRYPTED_WARNING =
  'Unencrypted: this source has no TLS certificate, so AMI records and the token cross the network in plain text until you add one to the source in Cribl.'

/** One line of "What gets created & things to know": a short label and its ⓘ. */
export interface SetupFact {
  label: string
  tip: string
}

/**
 * "What gets created & things to know": the onboarding pack's own objects,
 * never the global stack's. Shown whatever the release says, because the pack
 * is the only onboarding (2026-09-25). *(Until then a build whose pack could
 * not be installed showed `SETUP_FACTS`, the global Raw HTTP stack's list,
 * chosen by `setupFacts(onboardingPath(…).mode)`; both are gone.)*
 */
export const PACK_SETUP_FACTS: readonly SetupFact[] = Object.freeze([
  {
    label: `Pack ${PACK_ID} — installed from its release`,
    tip:
      'Installed from the release this app version pins, with custom functions refused. Its sources, breaker, pipelines, routes and ' +
      'destinations live inside the pack, apart from the rest of the group’s configuration.',
  },
  {
    label: `Source ${PACK_HTTP_INPUT_ID} — a new token, shown once`,
    tip:
      `Ships switched off with no token. Onboarding picks a free port, generates a token, sets TLS for the group and starts it in one change. ` +
      `The breaker ${PACK_BREAKER_ID} splits each POSTed JSON array into one event per record.`,
  },
  {
    label: `Pipeline ${PACK_PIPELINE_ID} — same fields as the demo feed`,
    tip:
      'Applies the same numeric casts and derived fields (http_server_ms, tcp_reset, subnets, l4_proto, byte and packet totals) as the demo gigamon_ami pipeline, so every dashboard reads the same fields.',
  },
  {
    label: `Every record lands twice: JSON and Parquet`,
    tip:
      `Route ${PACK_HTTP_JSON_ROUTE_ID} writes each record to ${PACK_LAKE_DATASET_ID}, which the dashboards read, and passes it on; ` +
      `route ${PACK_HTTP_PARQUET_ROUTE_ID} writes the same record to ${PACK_PARQUET_DATASET_ID} through pipeline ${PACK_PARQUET_PIPELINE_ID}, the same fields without _raw, the record’s original text, which only the JSON copy keeps. ` +
      'Both datasets are created before the pack is installed, and neither is ever deleted by this app.',
  },
  {
    label: `Cribl-managed groups use ports ${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max}`,
    tip:
      `Cribl.Cloud exposes only ${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max} on a managed group, with TLS on Cribl’s certificate. A hybrid group takes any port, but its source starts without TLS until you add a certificate.`,
  },
])

