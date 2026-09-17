// The words the long-running-search screen says, and nothing that renders.
//
// Split out of components/JobWatchdog.tsx rather than living beside the markup,
// for the reason oxlint's `react(only-export-components)` gives: a .tsx that
// exports a dozen plain functions breaks Vite's fast refresh for the components
// in it. It is also where these belong. Every function here is pure and every
// one of them is a sentence a customer reads or an assistive technology speaks,
// so the argument about the WORDS can be tested — and reviewed — without a DOM,
// a router, a store or a Capra portal anywhere near it.
//
// None of this is frozen by src/queries/display-freeze.test.ts: that gate covers
// the `about` / `info` / `sub` prose of an ⓘ surface, written inline in a .tsx,
// and these are accessible names, a live-region sentence and a toast. They are
// pinned by components/JobWatchdog.test.tsx instead.
//
// The design behind each of them — why the columns are what they are, what the
// live region says and does not say — is in components/JobWatchdog.tsx's header.
// This file is the implementation of that argument, not the argument.

import { LAKE_DATASET } from '../cribl/config'
import type { Phase } from '../cribl/provision'
import type { CancelResult, HungJob, WatchdogState } from '../cribl/jobWatchdog'

/**
 * What the list covers, said in every state including the empty one.
 *
 * THE SILENT CASE THIS EXISTS FOR. A Cribl role that scopes search history to
 * the caller's own jobs answers a **200 with zero rows** — not a 403 — so
 * `error` is null, the drawer has nothing to show, and silence reads as
 * "nothing is wrong" to precisely the account that is being shown least. The
 * refusal case is loud already; this one had no words at all.
 *
 * What it may and may not say is the difference between this sentence and the
 * three-state probe it replaced: it names what the list COVERS and what Cancel
 * does, and it does not claim to know what is being withheld. Nothing this app
 * can observe distinguishes a role-scoped list from a quiet workspace, so it
 * says that rather than guessing which one you are looking at.
 */
export const COVERAGE_NOTE =
  'This lists the long-running searches your Cribl role lets this app see. If your role shows you only ' +
  'your own searches, only your own can appear here — an empty list and a quiet workspace look the same ' +
  'from inside this app, and it cannot tell you which one this is. Cancel is offered only on searches ' +
  'you started: this app never stops work it did not start.'

/**
 * An age in a table cell: `19h 4m`, `47m`, `2d 3h`.
 *
 * Minutes are dropped past a day because at that point they are noise — the
 * jobs this exists for ran 10.7 to 19.1 hours and nobody reads the minute.
 */
export function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * The same age in prose, for a sentence a person reads once — a dialog title, a
 * banner. One unit only: "19 hours", not "19 hours and 4 minutes", because the
 * precision is not what the sentence is about.
 */
export function elapsedInWords(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} hours`
  return `${Math.floor(hours / 24)} days`
}

/**
 * The owner, as a cell.
 *
 * `mine === null` is the case worth care: the platform named nobody (always so
 * under `npm run dev`), so the name is shown and the possessive judgement is
 * withheld. Rendering null as "someone else" would be a claim with nothing
 * behind it, and it is the claim that gets a colleague's job cancelled.
 */
export function ownerLabel(job: HungJob): string {
  return job.mine === true ? 'you' : job.owner
}

/**
 * What the Action cell says when there is no Cancel button in it, or null when
 * the button belongs there.
 *
 * The rule, in one place because the drawer and the store both have to apply
 * it: Cancel exists only for a row that is provably the signed-in user's, on a
 * list this app currently believes. Everything else gets a word saying which of
 * those two is missing — never a disabled button, which announces as unavailable
 * without ever saying why, and never an enabled one on a row the app cannot
 * stand behind.
 *
 * `mine === null` is the case worth care: the platform named nobody (always so
 * under `npm run dev`). Treating that as "not yours" would be a claim with
 * nothing behind it, and treating it as yours is how somebody else's
 * investigation gets cancelled — so it says the honest third thing.
 */
export function cancelUnavailable(s: WatchdogState, job: HungJob): string | null {
  if (s.error !== null) return 'Unverified'
  if (job.mine === true) return null
  return job.mine === false ? 'Not yours' : 'Owner unknown'
}

/**
 * Which population this row is, in the words the reader acts on.
 *
 * `carriesRunningTimeCap` reads the `set max_running_time_per_search=` prefix
 * search.ts stamps on every query the app submits. It cannot prove authorship —
 * anyone may type the same prefix — but its presence does prove a running-time
 * limit was set and the job outlived it, which is the finding either way.
 */
export function timeLimitLabel(job: HungJob): string {
  if (job.carriesRunningTimeCap) return 'Capped, still running'
  if (job.type === 'agentic') return 'Uncapped · Copilot'
  if (job.type === 'scheduled') return 'Uncapped · scheduled'
  return 'Uncapped'
}

/** The window the query reads. `-24h → now`. */
export function windowLabel(job: HungJob): string {
  if (!job.earliest && !job.latest) return 'not recorded'
  return `${job.earliest ?? '?'} → ${job.latest ?? 'now'}`
}

/** What the indicator has to say, or null when it has nothing. */
export type IndicatorTone = 'hung' | 'blind'

/**
 * `error` IS READ FIRST, AND THE ORDER IS THE POINT.
 *
 * It used to read `jobs.length` first, which meant `blind` could only ever win
 * on a workspace that had nothing wrong with it — the one case where nobody
 * needed it. Measured: poll 1 returns a nineteen-hour job, poll 2 is refused,
 * and the header went on saying "1 search has been running…", from a poll that
 * had already been contradicted, with a live Cancel on the row underneath.
 *
 * A count is a claim about NOW. The moment a poll fails, the rows are the last
 * good poll's and the honest header is the one that says it has stopped
 * watching — the drawer still holds the stale rows, dated and with their Cancel
 * withdrawn, which is where a fact of that age belongs.
 */
export function indicatorTone(s: WatchdogState): IndicatorTone | null {
  if (s.error !== null) return 'blind'
  if (s.jobs.length > 0) return 'hung'
  return null
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Minutes, for every sentence that quotes the threshold. */
export const thresholdMinutes = (s: WatchdogState) => Math.max(1, Math.round(s.thresholdSeconds / 60))

/** The sentence the live region carries. See the header on what is NOT here. */
export function announcementFor(s: WatchdogState): string {
  const minutes = thresholdMinutes(s)
  if (s.jobs.length === 0) return `No search of ${LAKE_DATASET} is running longer than ${minutes} minutes now.`
  return (
    `${plural(s.jobs.length, 'search', 'searches')} of ${LAKE_DATASET} ` +
    `${s.jobs.length === 1 ? 'has' : 'have'} been running for more than ${minutes} minutes.`
  )
}

/** The indicator's accessible name — the state in words, plus what pressing it does. */
export function indicatorName(s: WatchdogState, tone: IndicatorTone): string {
  if (tone === 'blind') return 'This app could not check for long-running searches — open the details'
  return `${announcementFor(s)} Open the list.`
}

/**
 * The outcome of a cancel, as the one toast the customer gets.
 *
 * FOUR CASES, AND THE ONE THAT WAS WRONG IS THE THIRD. A cancel this app
 * declined — the job had already finished, or been cancelled by somebody else,
 * between the render and the click — used to report “…nothing was cancelled..
 * It is still running.”: the opposite of what happened, in a `role="alert"` that
 * never auto-dismisses, with a stray second full stop. It is not a failure at
 * all. The search the person wanted stopped is stopped, so it is reported the
 * way a success is and takes itself off the screen.
 *
 * The two real failures stay `error`, which Toast.tsx renders with
 * `role="alert"` and no auto-dismiss: in both of those the job IS still running
 * and still billing, which is not something to let slide away after five
 * seconds.
 */
/** Cribl's error text sometimes ends in a full stop and sometimes does not, and
 *  every branch below puts a sentence after it. Trimming here rather than in
 *  each branch is why "nothing was cancelled.. It is still running." reached a
 *  customer once already. */
const trimStop = (t: string) => t.replace(/s*[.!?]+s*$/, '')

export function cancelOutcome(job: HungJob, r: CancelResult): Phase {
  if (r.ok) {
    return {
      kind: 'done',
      text: `Cancelled ${job.id}.${r.reportedStatus ? ` Cribl reported ${r.reportedStatus}.` : ''}`,
    }
  }
  if (r.declined) return declinedOutcome(job, r.declined)
  if (r.httpStatus === 0) {
    return {
      kind: 'error',
      text: `Could not cancel ${job.id} — ${trimStop(r.detail ?? 'the request did not reach Cribl')}. It is still running.`,
    }
  }
  return {
    kind: 'error',
    text:
      `Could not cancel ${job.id} — Cribl answered ${r.httpStatus}. It is still running; ` +
      `it can be cancelled from Cribl Search.${r.detail ? ` Cribl said: “${trimStop(r.detail)}”.` : ''}`,
  }
}

/** The three ways this app declines before asking Cribl. Nothing was sent, so
 *  none of them quotes a status — and only one of them is bad news. */
function declinedOutcome(job: HungJob, why: NonNullable<CancelResult['declined']>): Phase {
  switch (why) {
    case 'gone':
      // The outcome somebody wanted, reached without this app. Saying "nothing
      // was cancelled" to them is technically true and reads as a failure.
      return {
        kind: 'done',
        text: `${job.id} is no longer running — it finished, or it had already been cancelled. Nothing was sent.`,
      }
    case 'not-yours':
      return {
        kind: 'error',
        text:
          `Nothing was sent: ${job.id} was started by ${job.owner}, and this app only cancels searches you ` +
          'started. It can be stopped by its owner, or from Cribl Search by an admin.',
      }
    case 'unverified':
      return {
        kind: 'error',
        text:
          `Nothing was sent: the last check of Cribl's job list did not work, so this app cannot tell ` +
          `whether ${job.id} is still running. Use “Check again” first.`,
      }
  }
}
