// The screen for searches that will not stop, and the one control that stops
// one of your own.
//
// cribl/jobWatchdog.ts is the half that knows; this is the half that shows. Read
// that file's header first — it carries the measurements behind the five-minute
// poll, the threshold and its margin over the app's own caps, the own-jobs-only
// scope of Cancel, and the three things §1.8 asked for that are deliberately
// absent. What follows is only the decisions this file makes.
//
// ── QUIET WHEN THERE IS NOTHING WRONG MEANS NOTHING AT ALL ──────────────────
// This sits in a header a customer looks at all day, across fourteen tabs. The
// obvious design — a small green "watch OK · last checked 12:04" — was rejected:
//
//   * ambient means "appears when there is something to say". A permanent chip
//     that is healthy 364 days a year is decoration, and the eye learns to skip
//     exactly the spot the warning has to appear in;
//   * the header right side is already seven items in a flex-wrap row that wraps
//     at 1240 px (the UX pass measured it). An eighth permanent item makes a
//     crowded row wrap sooner in order to say nothing;
//   * the healthy line is not lost. It is the drawer's empty state — and when
//     nothing is hung there is nothing to open the drawer FOR.
//
// The one thing silence must never mean is "we cannot tell", and that case is
// exactly the one that is NOT silent: a refused or failed poll renders its own
// muted indicator (`blind` below), because zero rows from a 403 and zero rows
// from a quiet workspace are the same number and only one of them is good news.
// That asymmetry is the whole argument for rendering nothing the rest of the
// time.
//
// ── WHAT EACH COLUMN IS FOR ────────────────────────────────────────────────
// There is no credits figure to show — `billableCPUSeconds` reads 0 while a job
// runs, recorded twice in this plan's own evidence — so the columns have to
// carry the argument themselves. Each one answers a different question, and a
// reader who only looks at one should still be able to act:
//
//   Search       the id, and nothing else: what you quote to Cribl support or
//                paste into Search History. Identity, not judgement.
//   Running for  the case. 725 completed gigamon_ami jobs in this workspace had
//                a median of 5.1 s and a p99 of 15.4 s, and the slowest that
//                ever finished took 51 s. Every row here has been running for at
//                least twice the longest this app permits one of its own queries
//                — half an hour at the shipped caps — so this column does not
//                mean "slow", it means "not going to finish".
//   Owner        whose search it is, and therefore whether there is a Cancel in
//                the row at all. On the workspace this was measured against
//                every hung job belonged to a colleague, so this is the column
//                that most often explains why the Action cell says a word
//                instead of offering a button.
//   Reads        a `-30d` ad-hoc search explains itself; a `-15m` search three
//                hours in does not, and is the more alarming row. This is the
//                column that separates expensive-but-reasonable from broken.
//   Time limit   which of the two populations this is. "Capped" means a query
//                carrying this app's own `set max_running_time_per_search=`
//                outlived it — the cap mechanism failed, which is a defect worth
//                reporting. "Uncapped" means it came from somewhere that does
//                not cap: the Search UI, one of the seventeen deep links, or
//                Copilot. Different problems, different next step, same badge.
//
// The query text is behind a per-row disclosure and never a `title=`. It is
// diagnostic rather than scannable, and it is somebody else's investigation.
//
// ── A WIDE LIST AND A NARROW BUTTON, AND NO TOGGLE BETWEEN THEM ────────────
// S9 specifies a default of "your searches" with a Switch for everyone's. What
// shipped is neither, and the reason is the scope decision in the store's header
// (cribl/jobWatchdog.ts): the drawer LISTS every long-running search this
// account can see, and Cancel acts only on the viewer's own.
//
//   * a list filtered to "mine" would have been EMPTY during the incident this
//     slice exists for — ten jobs, 10.7 to 19.1 hours old, seven of them one
//     colleague's — while the header said 10. A count in the header that does
//     not match the rows in the drawer is an indicator that lies.
//   * a Switch is a promise this app cannot keep. Every job it creates is
//     `isPrivate: true`, and the research listed other people's jobs only
//     because the tester was org_admin + ws_admin; no non-admin has been tried
//     (V-S11). "Show everyone's searches" may be a control that changes nothing
//     for precisely the account that most needs it to work.
//   * and with Cancel scoped to own jobs there is nothing for a toggle to
//     decide. A row of somebody else's is context — it says the workspace has a
//     runaway search in it and who to go and ask — not something to act on here.
//
// SO THE ACTION CELL IS THE FILTER A TOGGLE WOULD HAVE BEEN, and it says which
// of the two reasons applies: "Not yours" where the row is a colleague's, "Owner
// unknown" where the platform named nobody (dev), "Unverified" where the last
// poll failed. Never a disabled button: `disabled` is unreachable by keyboard
// and announces as unavailable without ever saying why.
//
// WHAT IS SAID INSTEAD OF A TOGGLE, IN EVERY STATE INCLUDING THE EMPTY ONE.
// A Cribl role that scopes search history to your own jobs answers a 200 with
// zero rows, not a 403 — so `error` is null and an empty drawer is what a
// restricted account sees, reading as "nothing is wrong" when the truth is "this
// is all this app is shown". `COVERAGE_NOTE` is the sentence that says so, and
// it is rendered whether or not there are rows. It names what the list covers
// and claims nothing at all about what it cannot see.
//
// ── WHAT A FAILED POLL DOES TO THE ROWS THAT ARE STILL ON SCREEN ───────────
// They stay, and they stop being current. `jobs` is whatever the last good poll
// found; `error` says that poll has since been contradicted. So the header goes
// `blind` (the count is a claim about now, and there is no "now" to claim), the
// rows are kept with the time they came from and marked as unconfirmed, and
// every Cancel in the table is withdrawn — pressing one would be acting on a
// list this app has just admitted it cannot see.
//
// ── ANNOUNCEMENTS ──────────────────────────────────────────────────────────
// The live region is mounted on every render, empty, and filled by an effect —
// never rendered already-populated. That is the bug slice 1.6 found in the old
// toast stack: a generic live region that enters the DOM with its first message
// is commonly not announced at all, because there was no region for assistive
// technology to be watching when the content "changed".
//
// What is announced is keyed on `idSetSeq`, which the store moves only when the
// SET of job ids changes. Keyed on the poll instead, a colleague's nineteen-hour
// job would interrupt somebody twelve times an hour to say it is still running.
// The limit of that, stated rather than hidden: the sentence names a count, so
// one job ending as another begins changes the id set without changing the text,
// and nothing is announced. Adding a counter to force a re-announcement would be
// reading out a number that means nothing.
//
// Errors are deliberately NOT in the live region. A refusal is a standing state,
// not an event — it is visible in the indicator and explained in the drawer —
// and a poll that alternates between failing and working would otherwise speak
// every five minutes.
//
// ── WHAT CAPRA'S DRAWER DOES NOT DO ────────────────────────────────────────
// Measured on `@capra/core@1.8.2` rather than assumed. `Drawer` portals to
// `document.body`, renders `role="dialog"` + `aria-modal`, locks page scroll and
// closes on Escape, the scrim and the header ✕. It does NOT move focus into the
// sheet, does not contain focus, and does not mark the page behind it inert the
// way `Modal` marks `#root`. So:
//
//   * this file moves focus into the sheet on open and hands it back to the
//     trigger on close;
//   * focus CONTAINMENT is not fixed here, and saying so is better than implying
//     otherwise: a keyboard user can tab out of the open drawer into the page
//     behind the scrim. Fixing it properly means marking `#root` inert, which
//     collides with `Modal` doing the same thing for the confirmation nested
//     inside — one of them would remove the attribute the other still needs.
//     What IS fixed is the direction that matters: while the confirmation is up,
//     the drawer sheet itself is marked inert, so the page behind the dialog is
//     inert (Modal's doing) and so is the drawer (this file's).
//   * Escape is handled by the Drawer on the CAPTURE phase of `document`, with
//     `stopPropagation`, so a nested Modal never sees it. Left alone, pressing
//     Escape in the confirmation would close the drawer underneath it and leave
//     the dialog standing. `onClose` therefore routes to whichever surface is on
//     top.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Drawer } from '@capra/core'
import { ConfirmDialog, type ConfirmResource } from './ConfirmDialog'
import { GatedControl } from './GatedControl'
import { PanelInfo } from './PanelInfo'
import { pushToast } from './Toast'
import type { AppBanner } from './AppBanners'
// Every sentence this screen says lives next door, pure and DOM-free. See that
// file's header for why it is not in here.
import {
  COVERAGE_NOTE,
  announcementFor,
  cancelOutcome,
  cancelUnavailable,
  elapsedInWords,
  formatElapsed,
  indicatorName,
  indicatorTone,
  ownerLabel,
  plural,
  thresholdMinutes,
  timeLimitLabel,
  windowLabel,
} from './jobWatchdogCopy'
import { LAKE_DATASET, SEARCH_GROUP, criblUiUrl } from '../cribl/config'
import {
  POLL_MS,
  cancelHungJob,
  checkNow,
  dismissJob,
  restoreDismissed,
  useJobWatchdog,
  type HungJob,
  type WatchdogState,
} from '../cribl/jobWatchdog'

const POLL_MINUTES = Math.round(POLL_MS / 60_000)

// ── Whether the drawer is open ──────────────────────────────────────────────
//
// Module scope rather than component state because two unrelated places open it:
// the header indicator, and the banner's "Review searches" button, which is
// rendered by <AppBanners> under the tab bar. Lifting the flag into App.tsx
// would make every consumer of the dashboard re-render on it; this is the same
// useSyncExternalStore shape authz.ts, inflight.ts and jobWatchdog.ts already
// use, so it is not a new idea in this codebase.

let drawerOpen = false
const drawerListeners = new Set<() => void>()

function setDrawerOpen(next: boolean): void {
  if (drawerOpen === next) return
  drawerOpen = next
  for (const l of drawerListeners) l()
}

/** Open the long-running-search list. The banner's action, and nothing else. */
export function openWatchdogDrawer(): void {
  setDrawerOpen(true)
}

function subscribeDrawer(l: () => void): () => void {
  drawerListeners.add(l)
  return () => { drawerListeners.delete(l) }
}

const drawerSnapshot = () => drawerOpen

function useWatchdogDrawerOpen(): boolean {
  return useSyncExternalStore(subscribeDrawer, drawerSnapshot, drawerSnapshot)
}

/** Only for tests: put the drawer back to shut. */
export function resetWatchdogDrawer(): void {
  setDrawerOpen(false)
}

// ── The banner, for the one escalation that survived ────────────────────────

/**
 * A long-running search of the signed-in user's own.
 *
 * This is the ONLY escalation left of the three S9 specifies. The spend
 * threshold is gone with the credits column — `billableCPUSeconds` reads 0 while
 * a job runs, so a spend-based trigger would have fired on a number that does
 * not exist. Ownership survives, and it is the sharper trigger anyway: a hung
 * job of yours means either this app's own running-time cap failed on your
 * query, or you left an ad-hoc search running in Cribl Search. Both are yours to
 * fix and neither needs anybody's permission.
 *
 * `warning`, never `danger`: Capra's `Alert appearance="danger"` renders no
 * dismiss button by design, and §1.8 requires this one to be dismissible.
 * Dismissal silences the banner and never the badge — the header keeps counting
 * while any job is hung.
 */
export function useJobWatchdogBanner(): AppBanner | null {
  const watch = useJobWatchdog()
  // Nothing while the watch is blind. A banner is the loudest surface in the
  // app and this one says a search of YOURS is running right now — a claim the
  // last poll is no longer evidence for. The `blind` indicator and the drawer
  // carry the same rows honestly; this one cannot be made honest, so it goes.
  const mine = watch.error !== null ? [] : watch.jobs.filter((j) => j.mine === true && !watch.dismissedIds.includes(j.id))
  if (mine.length === 0) return null
  // `jobs` arrives sorted by elapsed time descending, so this is the oldest.
  const oldest = mine[0]
  return {
    id: 'hung-jobs',
    appearance: 'warning',
    title: `${plural(mine.length, 'search', 'searches')} of yours ${mine.length === 1 ? 'has' : 'have'} been running for more than ${thresholdMinutes(watch)} minutes.`,
    body:
      `They keep billing until they finish or are cancelled; the oldest started ${elapsedInWords(oldest.elapsedMs)} ago. ` +
      `This app checks every ${POLL_MINUTES} minutes while it is open.`,
    action: (
      <button type="button" className="btn" onClick={openWatchdogDrawer}>
        Review searches
      </button>
    ),
    onDismiss: () => { for (const j of mine) dismissJob(j.id) },
  }
}

// ── The header indicator ────────────────────────────────────────────────────

/**
 * The ambient badge, and the drawer it opens.
 *
 * Mounted in the header rather than on a tab so the watch runs for as long as
 * the app is open — the store starts polling on its first subscriber and stops
 * on its last, so an app nobody is looking at asks Cribl nothing.
 *
 * The wrapper is `display: contents`, so when there is nothing to say this
 * contributes no box and no flex gap to a header row that already wraps at
 * 1240 px. It still renders: the live region has to exist before it has
 * anything to announce, and the drawer has to survive the badge going away
 * under it when the last job is cancelled.
 */
export function JobWatchdogIndicator() {
  const watch = useJobWatchdog()
  const open = useWatchdogDrawerOpen()
  const tone = indicatorTone(watch)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [announcement, setAnnouncement] = useState('')

  // An effect, not a render-time value: this guarantees the region is in the
  // document, empty, for at least one commit before it carries a sentence.
  // `idSetSeq` is 0 until the set of ids has actually changed once, so a first
  // poll that finds nothing says nothing.
  useEffect(() => {
    if (watch.idSetSeq === 0) return
    setAnnouncement(announcementFor(watch))
    // Only the id-set counter. Re-running on every poll is the failure mode this
    // whole mechanism exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch.idSetSeq])

  // Closing the drawer hands focus back to the badge that opened it. Capra's
  // Drawer does not do this (its header ✕ is inside the sheet it unmounts), and
  // without it a keyboard user is returned to the top of the document.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus()
    wasOpen.current = open
  }, [open])

  return (
    <span className="jw">
      <span className="sr-only" role="status">{announcement}</span>
      {/* Kept on screen while the drawer is open even if the last job has just
          been cancelled, so the control focus returns to still exists. */}
      {(tone !== null || open) && (
        <button
          type="button"
          ref={buttonRef}
          className={`jw-badge jw-badge-${tone ?? 'hung'}`}
          aria-label={indicatorName(watch, tone ?? 'hung')}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setDrawerOpen(true)}
        >
          <WarnIcon />
          <span aria-hidden="true">
            {tone === 'blind'
              ? 'Search watch unavailable'
              /* `tone === null` here is the one transient case: the drawer is
                 open and the last job has just been cancelled. "0 long-running
                 searches" would be a true sentence that reads as a broken
                 counter, so it says the thing instead of counting it. */
              : tone === null
                ? 'No long-running searches'
                : plural(watch.jobs.length, 'long-running search', 'long-running searches')}
          </span>
        </button>
      )}
      <WatchdogDrawer isOpen={open} onClose={() => setDrawerOpen(false)} watch={watch} />
    </span>
  )
}

function WarnIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

// ── The drawer ──────────────────────────────────────────────────────────────

interface DrawerProps {
  isOpen: boolean
  onClose: () => void
  watch: WatchdogState
}

function WatchdogDrawer({ isOpen, onClose, watch }: DrawerProps) {
  const [confirming, setConfirming] = useState<HungJob | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const minutes = thresholdMinutes(watch)

  // A closed drawer must not keep a job selected: the row it belonged to is
  // gone, and reopening onto a confirmation nobody asked for would be a dialog
  // that appeared by itself.
  useEffect(() => {
    if (!isOpen) setConfirming(null)
  }, [isOpen])

  // Focus into the sheet, and hold the sheet inert while the confirmation is up.
  // Both reach the sheet through `role="dialog"` — a public contract — rather
  // than through a Capra class name, which is not. See the header for what this
  // does and does not fix.
  useEffect(() => {
    if (!isOpen) return
    const sheet = bodyRef.current?.closest('[role="dialog"]') as HTMLElement | null
    if (!sheet) return
    if (confirming) {
      sheet.setAttribute('inert', '')
    } else {
      sheet.removeAttribute('inert')
      sheet.focus({ preventScroll: true })
    }
    return () => sheet.removeAttribute('inert')
  }, [isOpen, confirming])

  const onCancelConfirmed = useCallback(async () => {
    const job = confirming
    if (!job) return
    // Closed BEFORE the request, not after: the store drops the row on success
    // and a dialog still sitting over a table that no longer has that row reads
    // as a hung dialog. The outcome arrives as a toast, which is where an
    // outcome belongs.
    setConfirming(null)
    pushToast(cancelOutcome(job, await cancelHungJob(job)))
  }, [confirming])

  return (
    <Drawer
      isOpen={isOpen}
      // Escape is swallowed by the Drawer on document capture, so the nested
      // confirmation never sees it. Route it to whichever surface is on top.
      onClose={() => { if (confirming) setConfirming(null); else onClose() }}
      placement="right"
      width={760}
      title="Long-running searches"
    >
      <div className="jw-body" ref={bodyRef}>
        <p className="jw-scope">
          This watch lists searches of <code>{LAKE_DATASET}</code> that have been running for more than{' '}
          {minutes} minutes and are still running. It checks every {POLL_MINUTES} minutes while this app is
          open and pauses when the tab is in the background.
          {/* Written as one literal and carrying no runtime number, on purpose.
              src/queries/display-freeze.test.ts freezes ⓘ prose WHERE IT IS
              WRITTEN: an inline literal is pinned word for word, while an
              interpolated expression is recorded as its own source text and a
              hoisted constant leaves the freeze altogether. The one figure that
              could change at runtime — the threshold — is in the visible
              sentence this button sits at the end of, in the empty state, and in
              the announcement, so repeating it here would buy an unfrozen
              paragraph in exchange for saying it a fourth time. */}
          <PanelInfo
            label="What the long-running search watch costs and how it decides"
            dialogLabel="About the long-running search watch"
            aboutHeading="What this watch costs, and what it looks at"
            about="It reads Cribl's list of running jobs: one ordinary GET. It submits no search, bills nothing, and takes no place in the workspace's 1,000-job search history. The design this replaced polled with a dataset=$vt_jobs search instead, which measured 2.534 billable CPU-seconds per poll — about 730 a day for every open session — and added 288 jobs a day to that history, evicting the very searches you would use to investigate what it found. A job is listed once it has been running for twice the longest time this app ever allows one of its own queries, which is the figure in the sentence above. The doubling is there so that a query still being wound up at its own time limit is never reported as a hang, and it costs nothing: across 725 completed gigamon_ami searches in this workspace the median was 5.1 seconds and the slowest that ever finished took 51, while the searches this was built for had been running between ten and nineteen hours. There is no cost column because Cribl reports 0 billable CPU-seconds while a job is still running — elapsed time is the figure that can honestly be shown."
          />
        </p>

        {watch.error && (
          <p className="jw-note jw-note-bad" role="status">
            {watch.error}{' '}
            {watch.denied &&
              'An admin can grant GET on /m/' + SEARCH_GROUP + '/search/jobs, or share this app, which grants it for the duration of a request made through the app. '}
            {/* Said whichever way the poll failed, because the rows below are
                stale in both cases — a refusal and a dropped connection leave
                exactly the same out-of-date table on screen. */}
            {watch.jobs.length > 0
              ? 'Nothing below is current: those rows are what the last poll that worked found, and they cannot be acted on until a poll succeeds.'
              : 'The last poll that worked found nothing running long. That was then, not now — an empty table here is not a statement that the workspace is quiet.'}
          </p>
        )}

        {/* In every state, including the empty one — which is what a role-scoped
            account sees, and it is a 200 rather than a refusal. See the header. */}
        {!watch.error && <p className="jw-note">{COVERAGE_NOTE}</p>}

        {watch.jobs.length === 0 && !watch.error ? (
          <p className="jw-note">No search has been running longer than {minutes} minutes.</p>
        ) : (
          watch.jobs.length > 0 && (
            <div className="jw-tablewrap">
              <table className="dtable">
                <caption className="sr-only">
                  Searches of {LAKE_DATASET} running longer than {minutes} minutes, oldest first
                  {watch.error && ', as of the last poll that worked'}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Search</th>
                    <th scope="col" className="dtable-num">Running for</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Reads</th>
                    <th scope="col">Time limit</th>
                    <th scope="col" className="dtable-actions">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {watch.jobs.map((job) => (
                    <JobRows key={job.id} watch={watch} job={job} onCancel={() => setConfirming(job)} />
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {watch.truncated && (
          <p className="jw-note">
            Cribl returned as many running searches as this app asked for, so there may be more than are
            listed.
          </p>
        )}
        {watch.otherDatasetsOverThreshold > 0 && (
          <p className="jw-note">
            {plural(watch.otherDatasetsOverThreshold, 'other search', 'other searches')} in this workspace
            {watch.otherDatasetsOverThreshold === 1 ? ' is' : ' are'} also running past {minutes} minutes on a
            different dataset. This app watches only <code>{LAKE_DATASET}</code> and cannot explain those.
          </p>
        )}

        <p className="jw-foot">
          {/* "successful" in both states rather than only when something has
              failed: this timestamp is the age of the rows above, and a poll
              that was refused at 12:09 did not check anything at 12:09. */}
          {watch.lastCheckedAt === null
            ? 'Not checked yet.'
            : `Last successful check ${new Date(watch.lastCheckedAt).toLocaleTimeString()}.`}
          {watch.paused && ' Paused while this tab is in the background.'}
          {watch.checking && ' Checking…'}
        </p>
        <div className="jw-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void checkNow()} disabled={watch.checking}>
            Check again
          </button>
          {watch.dismissedIds.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={restoreDismissed}>
              Show the warning again
            </button>
          )}
          <a className="jw-link" href={criblUiUrl('/search')} target="_blank" rel="noopener noreferrer">
            Open Cribl Search ↗
          </a>
        </div>
      </div>

      {confirming && <CancelConfirm job={confirming} onCancel={() => setConfirming(null)} onConfirm={onCancelConfirmed} />}
    </Drawer>
  )
}

/**
 * One job: the row, and the disclosure holding its query.
 *
 * Two `<tr>`s rather than a cell, because `.dtable` sets `white-space: nowrap`
 * on every cell — a query in one of them would push the table sideways past the
 * drawer. The disclosure is `<details>`, which is a real control: it is
 * reachable, it announces its state, and it is not a `title=` nobody on a
 * keyboard can reach.
 */
function JobRows({ watch, job, onCancel }: { watch: WatchdogState; job: HungJob; onCancel: () => void }) {
  // The same rule the store applies at the moment of the click, applied here at
  // render so the button is not offered and then refused.
  const unavailable = cancelUnavailable(watch, job)
  return (
    <>
      <tr>
        <th scope="row" className="dtable-id dtable-mono">{job.id}</th>
        <td className="dtable-num">
          {formatElapsed(job.elapsedMs)}
          {/* A job Cribl recorded no start time for — one that never left the
              queue — is aged from its creation, and the row says which. */}
          {job.startedAtIsCreation && <span className="jw-since"> since created</span>}
        </td>
        <td className={job.mine === true ? 'jw-owner-mine' : undefined}>{ownerLabel(job)}</td>
        <td className="dtable-mono">{windowLabel(job)}</td>
        <td>{timeLimitLabel(job)}</td>
        <td className="dtable-actions">
          {unavailable ? (
            // A word, not a disabled button: `disabled` drops out of the
            // keyboard order and announces "unavailable" without ever saying
            // why. COVERAGE_NOTE above the table says the rule once; this says
            // which half of it this row failed.
            <span className="jw-noaction">{unavailable}</span>
          ) : (
            /* The visible label stays one word; the accessible name carries the
               job and its age, so "Cancel" is never the whole announcement of a
               control that discards hours of work. */
            <button
              type="button"
              className="btn btn-ghost btn-danger-text"
              aria-label={`Cancel search ${job.id}, running for ${elapsedInWords(job.elapsedMs)}, started by ${ownerLabel(job)}`}
              onClick={onCancel}
            >
              Cancel…
            </button>
          )}
        </td>
      </tr>
      <tr className="jw-qrow">
        <td colSpan={6}>
          <details>
            <summary>Show query</summary>
            <pre className="jw-query">{job.query || '(Cribl recorded no query text for this job.)'}</pre>
          </details>
        </td>
      </tr>
    </>
  )
}

/**
 * The confirmation in front of the one write on this screen.
 *
 * It is `<ConfirmDialog>` — the app's one dialog — with one thing added to it:
 * a `stop` action word. The four that existed are `create`, `replace`, `deploy`
 * and `delete`, and none of them is true here. A cancelled job is not deleted:
 * it moves to `canceled` and stays in the search history, where it can still be
 * found. Labelling the row `delete` would tell a reader the search record itself
 * was about to be removed. `stop` is also the word that does not collide with
 * the dialog's own Cancel button, which means the opposite thing.
 *
 * IT IS THE VIEWER'S OWN SEARCH — that is now guaranteed twice over, by the row
 * that offered the button and by the store at the moment of the click — and it
 * still gets a confirmation. Ownership is not what made this dangerous: the age
 * is. Every row here is at least the threshold old and the ones this exists for
 * ran ten to nineteen hours, so what is being discarded is however much of that
 * work had been done, with no way to resume it.
 *
 * NO type-to-confirm, and the reason is not that this action is safe. It is that
 * the literal available to type is a job id like `1789395843210.fxAzHG`, which
 * nobody transcribes — it would be copied and pasted, which proves nothing, and
 * it would be demanded during exactly the incident where somebody is in a hurry.
 *
 * S8's contract asks for the query text in a scrollable code block here. It is
 * NOT here: the row this dialog was opened from already carries it behind a
 * disclosure, and a raw query inside a modal that also holds a destructive
 * button is one more thing to read in the second before pressing it. The dialog
 * points at it instead.
 */
function CancelConfirm({ job, onCancel, onConfirm }: { job: HungJob; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const resources: ConfirmResource[] = [
    {
      action: 'stop',
      kind: 'Cribl Search job',
      id: job.id,
      group: SEARCH_GROUP,
      detail: `Reads ${windowLabel(job)} · ${timeLimitLabel(job).toLowerCase()}`,
    },
  ]
  const consequences = [
    `You started this search ${elapsedInWords(job.elapsedMs)} ago and it is still running. ` +
      'Cancelling stops it now and discards whatever it has produced so far.',
    'The query it is running is in the row behind this dialog, under “Show query”.',
  ]
  return (
    <ConfirmDialog
      isOpen
      title={`Cancel search ${job.id}, running for ${elapsedInWords(job.elapsedMs)} and started by ${ownerLabel(job)}`}
      resources={resources}
      irreversible={{
        why: 'A cancelled search cannot be resumed — it has to be run again from the beginning.',
      }}
      costLine={
        'Stops the charge from here. Nothing already billed is refunded, and Cribl reports 0 billable ' +
        'CPU-seconds while a job is running, so this app cannot say what it has cost so far.'
      }
      consequences={consequences}
      undo="Nothing here puts it back. The same query can be run again from Cribl Search."
      onCancel={onCancel}
      confirm={
        <GatedControl
          write="hung_job.cancel"
          label="Cancel this search"
          busyLabel="Cancelling…"
          className="btn btn-danger"
          run={onConfirm}
        />
      }
    />
  )
}
