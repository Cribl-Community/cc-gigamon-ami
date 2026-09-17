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
//   groups/<g>/local/cribl/routes.yml    THE routing table — one ordered array,
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
  SYSLOG_PIPELINE_ID, SYSLOG_ROUTE_ID, SYSLOG_SOURCE_ID,
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

/** The files the commit names, said as whole files. `scope` is null only before
 *  the first status check lands, and the dialog cannot open before then. */
function carriesSentence(ctx: ProvisionConfirmContext, verb: string): string {
  const files = ctx.scope?.carries ?? []
  if (files.length === 0) return `The change is committed and deployed to ${ctx.group}.`
  return `The ${verb} is committed and deployed to ${ctx.group}. The commit names whole files, not single objects: ${files.join(', ')}.`
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
export function deployConsequences(ctx: ProvisionConfirmContext): string[] {
  const { group, undeployed } = ctx
  return [
    `This app writes only its own objects in ${group}: pipeline ${SYSLOG_PIPELINE_ID}, Syslog source ${SYSLOG_SOURCE_ID}, and the one ` +
      `${SYSLOG_ROUTE_ID} entry in the routing table. It does not edit the demo DataGen source, and every other route keeps its place.`,
    carriesSentence(ctx, 'change'),
    pendingSentence(ctx),
    ...(undeployed
      // NOT "it also deploys commit #X", which was the old wording and denied
      // by its own grammar what the deploy actually does. `pendingDeploy`
      // returns the Leader's HEAD, and a deploy moves the group to it.
      ? [
          `${group} is behind commit #${undeployed.slice(0, 10)}, this Leader’s current HEAD, which it has never deployed. This press moves ` +
            'the group to the commit it creates, so that one and everything else committed since go live with it.',
        ]
      : []),
    ...DEPLOY_CONSEQUENCES,
  ]
}

/**
 * Teardown: the same three facts, for a run that deletes.
 *
 * The teardown dialog had no counterpart to the deploy dialog's reach sentence
 * at all — the same defect stated by omission — so this is the first time it
 * says what its commit carries. It names three files, not four: `removeSyslogStack`
 * never touches the destination, so naming `outputs.yml` here would be the
 * over-naming half of the same class.
 */
export function removeConsequences(ctx: ProvisionConfirmContext, keptDestination: string, keptDataset: string): string[] {
  return [
    `Cribl Lake destination ${keptDestination} and dataset ${keptDataset} are kept — they are shared, and the dashboards read that dataset.`,
    carriesSentence(ctx, 'removal'),
    pendingSentence(ctx),
    ...DEPLOY_CONSEQUENCES,
  ]
}
