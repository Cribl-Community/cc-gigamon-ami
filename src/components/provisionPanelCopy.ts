// What Guided Setup's two confirmations say about reach, pure and DOM-free.
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

import {
  CLOUD_PORT_RANGE, HTTP_BREAKER_ID, HTTP_PIPELINE_ID, HTTP_ROUTE_ID, HTTP_SOURCE_ID, LAKE_DATASET_ID,
  LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID, LEGACY_SYSLOG_SOURCE_ID,
  type CommitScope,
} from '../cribl/provision'
import { DEPLOY_CONSEQUENCES } from '../cribl/landing'

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
 * changing underneath them. ProvisionPanel captures the answer as the dialog
 * opens and passes that; "still checking" is worded about the moment of opening
 * so it stays true however long the dialog is left open.
 *
 * Every dialog gets it, teardowns included: a removal commits and deploys too,
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
 * The one line beside Deploy when `pendingDeploy` proved something. All it
 * proves is that SOME commit after the one this group runs moved one of its
 * files — this app's failed deploy, or another admin's commit made in Cribl —
 * so it says that and no more. It used to say "an earlier deploy did not
 * finish", which names a cause nothing here established.
 */
export const behindNote = (group: string): string => `${group} is behind a commit that touches it.`

/** The rest, one ⓘ away. `head` is what `pendingDeploy` returns: HEAD. */
export const behindTip = (group: string, head: string): string =>
  `A commit made on this Leader since ${group} was last deployed changes one of ${group}’s files — made by this app or by somebody ` +
  `else in Cribl. Deploying moves the group to the commit this run creates on top of HEAD (#${head.slice(0, 10)}), so every commit ` +
  'since the last deploy goes live with it.'

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
 * Deploy: what this run writes, what its commit reaches, and what a deploy is.
 *
 * The first sentence is the narrowed survivor of the retired one. The second
 * and third are the halves it hid. Then DEPLOY_CONSEQUENCES verbatim, which
 * carries the Worker Process restart, the whole-file rule, the fact that a
 * deploy moves the group to a COMMIT rather than applying one change, and the
 * `onBackpressure: block` data loss — one constant, every deploy site.
 */
/**
 * What a Raw HTTP source may do while the Worker Processes restart. Said here,
 * in Guided Setup's own two dialogs, and NOT in DEPLOY_CONSEQUENCES, which the
 * Lake landing panel shares and where no such source need exist. Worded as a
 * precaution because it is one: whether the source refuses a POST mid-restart,
 * or holds the connection, has not been measured.
 */
export const HTTP_RESTART_PRECAUTION =
  'While the Worker Processes restart, a Raw HTTP source can briefly fail to accept a POST, so set Gigamon AMX to retry a failed POST.'

/**
 * The objects a teardown will NOT delete because this app could not see them,
 * as one sentence, or null when there are none. The teardown deletes only what
 * the status check found present, which is also exactly what the dialog lists —
 * so an object it could not read is left alone, and this is the dialog saying so
 * rather than leaving the reader to infer it from an absence.
 */
export function leftAloneSentence(group: string, objects: readonly string[]): string | null {
  if (objects.length === 0) return null
  return (
    `This app could not tell whether ${objects.join(', ')} ${objects.length === 1 ? 'is' : 'are'} in ${group}, so ` +
    `${objects.length === 1 ? 'it is' : 'they are'} not deleted. Check in Cribl, and remove ${objects.length === 1 ? 'it' : 'them'} there if needed.`
  )
}

const withUndeployed = (ctx: ProvisionConfirmContext): string[] => {
  const line = undeployedSentence(ctx)
  return line ? [line] : []
}

export function deployConsequences(ctx: ProvisionConfirmContext): string[] {
  const { group } = ctx
  return [
    `This app writes only its own objects in ${group}: event breaker ruleset ${HTTP_BREAKER_ID}, pipeline ${HTTP_PIPELINE_ID}, Raw HTTP ` +
      `source ${HTTP_SOURCE_ID}, and the one ${HTTP_ROUTE_ID} entry in the routing table. It does not edit the demo DataGen source, and every other route keeps its place.`,
    carriesSentence(ctx, 'change'),
    pendingSentence(ctx),
    ...withUndeployed(ctx),
    ...DEPLOY_CONSEQUENCES,
    HTTP_RESTART_PRECAUTION,
  ]
}

/**
 * Teardown: the same three facts, for a run that deletes.
 *
 * The teardown dialog had no counterpart to the deploy dialog's reach sentence
 * at all — the same defect stated by omission — so this is the first time it
 * says what its commit carries. It never names `outputs.yml`: `removeOnboardingStack`
 * never touches the destination, so naming it here would be the over-naming half
 * of the same class.
 */
export function removeConsequences(ctx: ProvisionConfirmContext, keptDestination: string, keptDataset: string): string[] {
  return [
    `Cribl Lake destination ${keptDestination} and dataset ${keptDataset} are kept — they are shared, and the dashboards read that dataset.`,
    carriesSentence(ctx, 'removal'),
    pendingSentence(ctx),
    ...withUndeployed(ctx),
    ...DEPLOY_CONSEQUENCES,
    HTTP_RESTART_PRECAUTION,
  ]
}

// ── What the panel says before anybody presses anything ─────────────────────
//
// The page used to open on a 120-word paragraph, a three-sentence hint under
// the group picker and five long bullets. The owner's call (2026-09-24): one
// short lead line per panel, and the rest behind an ⓘ on the thing it
// explains. None of these is a confirmation — the dialogs still say everything
// a write needs said, and nothing here replaces them.

/** The one line under the panel title. */
export const PROVISION_LEAD =
  `Creates a Raw HTTP source, pipeline and route in the worker group below, landing Gigamon AMX data in the Cribl Lake dataset ${LAKE_DATASET_ID}.`

/** The rest of what the old intro said, behind the ⓘ at the end of the lead. */
export const PROVISION_LEAD_TIP =
  'Only this app’s own objects are written: whatever is missing is created, and its breaker ruleset, pipeline, source and route entry are overwritten where they differ from this release. The demo DataGen feed is never edited. ' +
  'The commit that follows takes whole files — inputs.yml, breakers.yml, pipelines/route.yml and outputs.yml each hold every object of their kind in the group — and the confirmation names them and anything already uncommitted in them.'

/** Beside the "Worker group" label; replaces the hint that sat after the picker. */
export const GROUP_TIP =
  `The source, pipeline, route and destination are created, committed and deployed in this group. The Lake dataset ${LAKE_DATASET_ID} is shared and belongs to no group. Your pick is remembered, so this tab opens on it next time.`

/** Beside the port picker. */
export const PORT_TIP =
  `Set once, when the source is created. A Cribl-managed group only exposes ports ${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max} and its source uses Cribl’s TLS certificate; ` +
  'a hybrid group takes any free port and starts without TLS. Ports other sources in the group already use are refused.'

/** Under the Deploy button. Short, because the confirmation says the rest. */
export const deployNote = (group: string): string => `Commits and deploys to ${group}. You review every change first.`

/** Beside the actions, when the group still has the Syslog stack an earlier release created. */
export const legacyNote = (group: string): string =>
  `${group} still has the Syslog objects an earlier release created. Remove them on their own, or with the HTTP stack.`

export const LEGACY_TIP =
  `Syslog source ${LEGACY_SYSLOG_SOURCE_ID}, pipeline ${LEGACY_SYSLOG_PIPELINE_ID} and route ${LEGACY_SYSLOG_ROUTE_ID}. This release no longer creates or edits them; ` +
  'they keep running until they are removed, and the confirmation names each one before anything is deleted.'

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

export const ENDPOINT_TIP =
  `Send the token as the whole header value — ${AUTH_HEADER}, with no "Bearer" prefix. The source splits each POSTed array into one event per record, and the pipeline gives them the same fields as the demo feed.`

/** On the endpoint card when the token was just made but the stack is not whole. */
export const ENDPOINT_INCOMPLETE =
  'The source exists, but the run stopped before the rest of the stack was in place, so nothing it receives reaches Cribl Lake yet. Copy the token now, then deploy again.'

/** Shown beside the token, the one time it is shown. */
export const TOKEN_ONCE =
  'Shown once. Copy it now: this app keeps no copy, and reloading the page clears it. Cribl keeps it in the source’s authentication settings.'

/** Where the token line is when it is not being shown. */
export const TOKEN_ELSEWHERE =
  'The token was shown once, when this app created the source. It is in the source’s authentication settings in Cribl.'

/** On a hybrid group, whose source starts without TLS. Plain on purpose. */
export const UNENCRYPTED_WARNING =
  'Unencrypted: this source has no TLS certificate, so AMI records and the token cross the network in plain text until you add one to the source in Cribl.'

/** One line of "What gets created & things to know": a short label and its ⓘ. */
export interface SetupFact {
  label: string
  tip: string
}

export const SETUP_FACTS: readonly SetupFact[] = Object.freeze([
  {
    label: `Breaker ${HTTP_BREAKER_ID} — one event per record`,
    tip:
      'Each POST body is a JSON array of AMI records. The ruleset splits it into one event per record and extracts every field, so no parse step is needed. ' +
      'If your AMX exports CEF instead, this ruleset and pipeline will not read it.',
  },
  {
    label: `Pipeline ${HTTP_PIPELINE_ID} — same fields as the demo feed`,
    tip:
      'Applies the same numeric casts and derived fields (http_server_ms, tcp_reset, subnets, l4_proto, byte and packet totals) as the demo gigamon_ami pipeline, so every dashboard reads the same fields.',
  },
  {
    label: `Route ${HTTP_ROUTE_ID} — this source only`,
    tip:
      `Inserted above the catch-all default route, filtered to __inputId=='http_raw:${HTTP_SOURCE_ID}' and marked final, so it only touches this source’s data and no other route changes.`,
  },
  {
    label: `Cribl-managed groups use ports ${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max}`,
    tip:
      `Cribl.Cloud exposes only ${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max} on a managed group, with TLS on Cribl’s certificate. A hybrid group takes any port, but its source starts without TLS until you add a certificate.`,
  },
  {
    label: 'Idle until Gigamon sends to it',
    tip:
      'With nothing pointed at it, the source shows healthy at 0 events per second. The DataGen demo keeps the dashboards populated meanwhile.',
  },
])
