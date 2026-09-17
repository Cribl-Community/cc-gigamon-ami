// Guided Setup section 3: the two scheduled searches, what they save, and the
// four controls that turn them on, off and away again.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SCREEN IS ACTUALLY FOR, because it is not a feature.
//
// Phase 2 adds nothing a user asked for. It moves two numbers off a live query
// and onto a cron: Data Flow's 30-day Lake total (9,297.7 billable CPU-s a run,
// 15–24 runs a day) and Field Explorer's "In feed" sample (754.9 CPU-s a visit).
// Everything on this screen therefore answers one of three questions, and
// nothing else earns space here:
//
//   Is the number still correct?      → the State and Health columns.
//   Where did the number come from?   → the Serves column, and the estimate's
//                                       provenance, which is prose and not a
//                                       tooltip.
//   Can the customer turn it off?     → Pause, and Remove acceleration.
//
// ── WHY THE STATE COLUMN HAS SIX WORDS AND NOT TWO ──────────────────────────
// The tempting table has on/off. It is wrong in the one place it matters:
// "this app has never created this search" and "somebody edited this search in
// Cribl's UI" render identically under two states, and the right action is
// opposite — create it, versus look at what changed before overwriting somebody
// else's edit. `foreign` is the third of the same family: an object carrying one
// of our ids that this app did not write. Apply refuses it, the teardown refuses
// it, and a two-state pill would have offered to create it over the top.
// `unreadable` is the fourth: Cribl would not say, which is not "absent", and
// Guided Setup shipped that exact bug once (cribl/accel/provision.ts, header).
//
// STATE, HEALTH AND LAST RUN ARE THREE COLUMNS because they fail independently.
// A search can exist and be enabled (State: enabled) and not have fired for two
// days (Health: behind schedule), and its last run can have failed while the
// schedule is perfectly healthy. One pill reading "enabled but stale, last run
// failed" is a sentence, not a status.
//
// ── THE ESTIMATE IS PROSE, NOT A TOOLTIP ────────────────────────────────────
// Every figure here comes from cribl/accel/estimate.ts, which returns a band, a
// basis and a `provenance` sentence WITH each number precisely so that the
// number cannot be rendered alone. A saving is a projection from twelve search
// jobs on one workspace on one date; a screenshot of it ends up in a procurement
// conversation. So the provenance is visible text beside the figure rather than
// behind an ⓘ — an explanation a customer has to discover is one they can
// truthfully say they were never shown.
//
// There is deliberately NO <PanelInfo> on this panel, which is a departure from
// the house rule that every panel carries one, and the reason is worth writing
// down rather than leaving as an omission: an `info=` literal on a labelled
// element is extracted into src/queries/__frozen__/display.json, so adding one
// here forces a `npm run queries:extract` — and this section was built while
// another change was live in the two tab files that snapshot also covers.
// Regenerating would have baked half of somebody else's work into the freeze.
// The words are on the screen instead, which is where this particular panel
// wants them anyway. A follow-up may add an ⓘ with a deliberate regeneration.
//
// ── WHAT COST EACH CONFIRMATION HAS TO STATE ────────────────────────────────
// Apply's confirmation states the RECURRING CHARGE IT CREATES, not only what it
// saves. A schedule bills whether or not anybody opens the tab it feeds; a
// dialog that showed only the saving would be asking somebody to approve a
// subscription by showing them the discount. Remove's states the charge it puts
// back, for the same reason in the other direction.
//
// ── THE UNINSTALL WARNING IS THE MOST IMPORTANT SENTENCE ON THE SCREEN ──────
// Decision I-D28. Uninstalling this app does not remove its saved searches: the
// platform gives an app no uninstall hook, the app-scoped KV document naming
// what it created is deleted with the app, and a non-admin loses the grant that
// would let them delete the searches afterwards. So a customer who uninstalls
// without pressing Remove first is left with two cron jobs billing them, with
// nothing left in the workspace that knows what they were for. That is why
// Remove carries a type-to-confirm and says this in the dialog rather than in a
// release note.
//
// ── WHERE THE WORDS ARE ─────────────────────────────────────────────────────
// Not here. components/accelPanelCopy.ts holds every sentence and every figure
// this screen says, as pure functions of the state they describe — the same
// split components/jobWatchdogCopy.ts makes, and for the same reason: what a
// screen like this gets wrong is almost never its markup. It is calling a search
// nobody could read "absent", printing `0 CPU-s` because the meter has not
// caught up, or quoting a saving without the sentence that says it is a
// projection. Those are assertions about a function, not about a DOM.
//
// ── NOTHING HERE WRITES ON LOAD, ON RENDER OR ON A TIMER ────────────────────
// The mount effect makes two GETs and no more: `readAccelState()` (the
// saved-search list) and `allAccelStatus()` (the job history). Both pass
// `background`, so a refusal recorded during them is never attributed to a
// button somebody pressed (cribl/authz.ts, `denialSince`). Every write in this
// file is reached from a <ConfirmDialog>'s <GatedControl> and from nowhere else.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { GateNote, GatedControl } from './GatedControl'
import { Panel } from './Panel'
import { StatusPill } from './StatusPill'
import { pushToast } from './Toast'
// Every sentence and every figure this screen says lives next door, pure and
// DOM-free. See that file's header for why it is not in here.
import {
  PILL_STATE,
  REMOVE_LITERAL,
  SAVED_KIND,
  UNINSTALL_WARNING,
  applyCostLine,
  applyResources,
  creditSpanWords,
  entrySavingWords,
  healthOf,
  lastRunCostWords,
  lastRunWhen,
  ownerOf,
  removeCostLine,
  removeResources,
  rowAction,
  rowActionName,
  rowNote,
  scheduleCostLine,
  showOwnerColumn,
  type Health,
  type RowAction,
} from './accelPanelCopy'
import { useWriteGate } from '../cribl/authz'
import { SEARCH_GROUP, criblUiUrl } from '../cribl/config'
import { currentUserId } from '../cribl/user'
import { MANIFEST, type AccelId } from '../cribl/accel/manifest'
import {
  applyAcceleration,
  applyPlan,
  pauseAcceleration,
  readAccelState,
  removalPlan,
  removeAcceleration,
  resumeAcceleration,
  type AccelRow,
  type AccelState,
  type AccelStep,
  type RemoveResult,
} from '../cribl/accel/provision'
import { allAccelStatus, type AccelStatus } from '../cribl/accel/status'
import { estimateWorkspaceSaving } from '../cribl/accel/estimate'

// ── The screen ──────────────────────────────────────────────────────────────

const ACTION_TXT: Record<AccelStep['action'], string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  exists: 'already present',
  refused: 'refused',
  skipped: 'skipped',
  error: 'failed',
}

type Confirming =
  | { kind: 'apply' }
  | { kind: 'remove' }
  | { kind: 'schedule'; id: AccelId; enable: boolean }

export function AccelPanel() {
  const [state, setState] = useState<AccelState | null>(null)
  const [status, setStatus] = useState<AccelStatus[] | null>(null)
  const [me, setMe] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<'apply' | 'remove' | 'schedule' | null>(null)
  // One slot, like Guided Setup's: two prompts about the same searches with
  // opposite answers is how the wrong button gets pressed, and one slot cannot
  // hold both.
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [steps, setSteps] = useState<AccelStep[]>([])
  const [leftBehind, setLeftBehind] = useState<RemoveResult['left']>([])
  const [stillPresent, setStillPresent] = useState<readonly string[]>([])
  const alive = useRef(true)

  const applyGate = useWriteGate('accel.apply')
  const pauseGate = useWriteGate('accel.pause')
  const removeGate = useWriteGate('accel.remove')

  const presetName = useId()
  const savingsId = useId()
  const parquetId = useId()
  const parquetWhyId = useId()

  /** Just the run history — used after a write, where the saved-search list has
   *  already been re-read by the module that wrote it. */
  const loadStatus = useCallback(async () => {
    const runs = await allAccelStatus().catch(() => null)
    if (alive.current) setStatus(runs)
  }, [])

  /**
   * Read what is there. Two GETs and nothing else — it is called on mount and
   * from Re-check, and a write here would be a write on load.
   */
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      // Independent: a refused job-history read says nothing about whether the
      // saved searches exist, and vice versa, so neither failure may blank the
      // other's column.
      const [next, runs] = await Promise.all([
        readAccelState(),
        allAccelStatus().catch(() => null),
      ])
      if (!alive.current) return
      setState(next)
      setStatus(runs)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void currentUserId().then((id) => { if (alive.current) setMe(id) }, () => {})
    void refresh()
    return () => { alive.current = false }
  }, [refresh])

  const rows = state?.rows ?? null
  const saving = estimateWorkspaceSaving()
  const statusFor = (id: AccelId): AccelStatus | null => status?.find((s) => s.id === id) ?? null
  const withOwner = rows ? showOwnerColumn(rows, me) : false
  const columns = withOwner ? 6 : 5

  // Read BEFORE the rows, and it decides whether anything may be written: while
  // this is set, no row's state is a claim about the workspace.
  const readError = state?.error ?? null
  const plan = state && readError === null ? applyPlan(state) : null
  const teardown = state && readError === null ? removalPlan(state) : null
  const canApply = plan !== null && plan.willWrite.length > 0
  const canRemove = teardown !== null && teardown.willDelete.length > 0

  const applyBlocked = running !== null || loading || applyGate.denied !== null
  const removeBlocked = running !== null || loading || removeGate.denied !== null

  const onApply = async () => {
    setRunning('apply')
    setConfirming(null)
    setSteps([])
    setLeftBehind([])
    setStillPresent([])
    try {
      const result = await applyAcceleration((s) => setSteps((prev) => [...prev, s]))
      if (!alive.current) return
      setState(result.state)
      const failed = result.steps.filter((s) => s.action === 'error' || s.action === 'refused')
      if (failed.length) {
        pushToast({ kind: 'error', text: `Acceleration: ${failed.map((s) => `${s.id} ${ACTION_TXT[s.action]}${s.detail ? ` — ${s.detail}` : ''}`).join(' · ')}` })
      } else if (result.unchanged) {
        pushToast({ kind: 'done', text: 'Both scheduled searches were already exactly as this release defines them. Nothing was written.' })
      } else {
        pushToast({ kind: 'done', text: `Acceleration applied: ${result.steps.filter((s) => s.action === 'created' || s.action === 'updated').map((s) => `${s.id} ${ACTION_TXT[s.action]}`).join(', ')}.` })
      }
      // The job history is a separate read and a new search has no runs yet;
      // doing it after the write keeps the Health column from claiming
      // "never run" about a search that was created a second ago without saying
      // when it was checked.
      await loadStatus()
    } catch (err) {
      pushToast({ kind: 'error', text: `Acceleration could not be applied: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      if (alive.current) setRunning(null)
    }
  }

  const onRemove = async () => {
    setRunning('remove')
    setConfirming(null)
    setSteps([])
    setLeftBehind([])
    setStillPresent([])
    try {
      const result = await removeAcceleration((s) => setSteps((prev) => [...prev, s]))
      if (!alive.current) return
      setState(result.state)
      setLeftBehind(result.left)
      setStillPresent(result.stillPresent)
      if (result.stillPresent.length) {
        pushToast({ kind: 'error', text: `Cribl accepted the delete but still lists ${result.stillPresent.join(', ')}. They are still scheduled and still billing.` })
      } else if (result.steps.some((s) => s.action === 'error')) {
        pushToast({ kind: 'error', text: `Acceleration could not be fully removed: ${result.steps.filter((s) => s.action === 'error').map((s) => `${s.id} — ${s.detail ?? 'failed'}`).join(' · ')}` })
      } else {
        pushToast({ kind: 'done', text: 'The scheduled searches this app created were removed. Both panels run their own query again.' })
      }
      await loadStatus()
    } catch (err) {
      pushToast({ kind: 'error', text: `Acceleration could not be removed: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      if (alive.current) setRunning(null)
    }
  }

  const onSchedule = async (id: AccelId, enable: boolean) => {
    setRunning('schedule')
    setConfirming(null)
    setSteps([])
    try {
      const result = enable ? await resumeAcceleration(id) : await pauseAcceleration(id)
      if (!alive.current) return
      if (!result.ok) {
        pushToast({ kind: 'error', text: `${id} could not be ${enable ? 'resumed' : 'paused'}: ${result.detail ?? 'Cribl refused the change.'}` })
      } else if (result.raced) {
        // There is no ETag on this endpoint, so a lost update cannot be
        // prevented — only reported. The sentence is the module's.
        pushToast({ kind: 'error', text: `${id}: ${result.detail ?? 'somebody else wrote this saved search at the same time.'}` })
      } else {
        pushToast({ kind: 'done', text: `${id} is now ${enable ? 'running on its schedule' : 'paused'}.` })
      }
      await refresh()
    } catch (err) {
      pushToast({ kind: 'error', text: `${id} could not be changed: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      if (alive.current) setRunning(null)
    }
  }

  const scheduleTarget = confirming?.kind === 'schedule' ? MANIFEST.find((e) => e.id === confirming.id) ?? null : null

  return (
    <Panel title="Acceleration — precompute the slow panels">
      <p className="gs-intro">
        Two panels in this app run queries that dominate the workspace's Cribl Search bill: Data Flow's
        30-day Lake total and Field Explorer's <em>In feed</em> browser. Acceleration runs each of them{' '}
        <strong>once on a schedule</strong> and has the panel read that run's stored result instead.
        It adds no new number to any screen — it changes where two existing numbers come from, and each
        panel still shows the same query as the source of its figure, because that query is what ran.
      </p>

      <fieldset className="ac-presets">
        <legend className="ac-presets-legend">Preset</legend>

        <div className="ac-preset">
          <input
            id={savingsId}
            type="radio"
            name={presetName}
            value="savings"
            checked
            onChange={() => {}}
          />
          <label className="ac-preset-text" htmlFor={savingsId}>
            <span className="ac-preset-name">Savings only</span>
            <span className="ac-preset-why">
              Schedules only the two queries that were measured as expensive, at the cadence their answers
              actually change at — daily for the 30-day total, hourly for the feed sample. There is no
              cadence control in this release: a faster cron costs more and answers the same question.
            </span>
          </label>
        </div>

        <div className="ac-preset ac-preset-off">
          <input
            id={parquetId}
            type="radio"
            name={presetName}
            value="default-view"
            checked={false}
            /* aria-disabled and a controlled `checked={false}`, never the HTML
               `disabled` attribute: a disabled radio leaves the keyboard order
               and announces as unavailable without ever saying why, so the one
               thing this row exists to communicate — the reason — is exactly
               what a keyboard or screen-reader user would not get. */
            aria-disabled="true"
            aria-describedby={parquetWhyId}
            onChange={() => {}}
            onClick={(e) => e.preventDefault()}
          />
          <label className="ac-preset-text" htmlFor={parquetId}>
            <span className="ac-preset-name">Savings + the default view</span>
            <span className="ac-preset-why" id={parquetWhyId}>
              Not available yet — available after the Parquet migration, because it adds cost on today's
              JSON dataset. Scheduling the panels each tab opens on would bill for a precomputed answer
              far more often than the live queries it replaces, until the dataset is cheap to scan.
            </span>
          </label>
        </div>
      </fieldset>

      {readError !== null && (
        <p className="ac-note ac-note-bad" role="status">
          {readError}{' '}
          {state?.denied
            ? `An admin can grant GET on /m/${SEARCH_GROUP}/search/saved, or share this app, which grants it for the duration of a request made through the app. `
            : ''}
          Nothing below is a claim about this workspace, and this app will not create, change or delete
          anything while it cannot read what is there.
        </p>
      )}

      <div className="ac-tablewrap">
        <table className="dtable ac-table">
          <caption className="sr-only">
            The scheduled searches this app owns: which panel each one feeds, whether it exists, whether it
            is running to its schedule, and when it last ran
          </caption>
          <thead>
            <tr>
              <th scope="col">Serves</th>
              <th scope="col">State</th>
              <th scope="col">Health</th>
              <th scope="col">Last run</th>
              {withOwner && <th scope="col">Owner</th>}
              <th scope="col" className="dtable-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows === null
              ? MANIFEST.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row" className="dtable-id ac-serves">
                      <span className="ac-serves-name">{entry.serves}</span>
                      <span className="ac-serves-id">{entry.id}</span>
                    </th>
                    <td><StatusPill state="checking" /></td>
                    <td>Checking…</td>
                    <td>Checking…</td>
                    {withOwner && <td>—</td>}
                    <td className="dtable-actions"><span className="ac-noaction">Checking…</span></td>
                  </tr>
                ))
              : rows.map((row) => {
                  const st = statusFor(row.id)
                  const health = healthOf(row.state, st)
                  const action = rowAction(row)
                  const note = rowNote(row, health)
                  const owner = ownerOf(row)
                  return (
                    <ScheduleRows
                      key={row.id}
                      row={row}
                      status={st}
                      health={health}
                      action={action}
                      note={note}
                      ownerName={owner.name ?? owner.id ?? 'not recorded'}
                      withOwner={withOwner}
                      columns={columns}
                      blocked={running !== null || loading || pauseGate.denied !== null}
                      onSchedule={(enable) => setConfirming({ kind: 'schedule', id: row.id, enable })}
                    />
                  )
                })}
          </tbody>
        </table>
      </div>

      {state?.truncated && (
        <p className="ac-note">
          This workspace holds more saved searches than one page. The two rows above are still settled
          individually, but a search written by an older release of this app could be running past that
          page without appearing here.
        </p>
      )}

      {/* The estimate. Prose, with its provenance beside it rather than behind
          an icon — see the header. */}
      <div className="ac-estimate">
        <h4 className="ac-estimate-head">What this is estimated to save</h4>
        <p className="ac-estimate-figure">
          {creditSpanWords(saving.savedCredits)}
          {saving.assumedFrequency && <span className="ac-estimate-flag"> · part of this rests on an assumed viewing frequency</span>}
        </p>
        <ul className="ac-estimate-rows">
          {saving.entries.map((entry) => (
            <li key={entry.id}>
              <span className="ac-estimate-what">{entry.what}</span>
              <span className="ac-estimate-saved">saves {creditSpanWords(entry.savedCredits)}</span>
              <span className="ac-estimate-basis">{entrySavingWords(entry)}</span>
            </li>
          ))}
        </ul>
        <p className="ac-note">{saving.provenance}</p>
        <p className="ac-note">{applyCostLine(saving)}</p>
      </div>

      <div className="gs-actions ac-actions">
        {canApply && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              /* aria-disabled, never disabled: the trigger has to survive the
                 confirmation closing over it so focus has somewhere to return
                 to, and somebody the gate refused has to be able to reach it and
                 read why. Guided Setup's Deploy button carries the same note. */
              onClick={() => { if (applyBlocked) return; setConfirming({ kind: 'apply' }) }}
              aria-disabled={applyBlocked || undefined}
              title={applyGate.reason ?? undefined}
            >
              {running === 'apply' ? 'Applying…' : 'Review changes…'}
            </button>
            <GateNote write="accel.apply" />
          </>
        )}
        {plan !== null && plan.willWrite.length === 0 && (
          <p className="gs-action-note">
            Nothing to apply — every scheduled search this release defines is already exactly as it defines
            it. A paused one is left paused; use Resume in its row.
          </p>
        )}
        {canRemove && (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-danger-text"
              onClick={() => { if (removeBlocked) return; setConfirming({ kind: 'remove' }) }}
              aria-disabled={removeBlocked || undefined}
              title={removeGate.reason ?? undefined}
            >
              {running === 'remove' ? 'Removing…' : 'Remove acceleration…'}
            </button>
            <GateNote write="accel.remove" />
          </>
        )}
        {/* The pause/resume confirmation closes itself before the write runs, so
            by the time there is a refusal to report its button is gone. The note
            belongs on the screen the user is looking at. */}
        <GateNote write="accel.pause" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void refresh()}
          disabled={loading || running !== null}
        >
          {loading ? 'Checking…' : 'Re-check'}
        </button>
        {/* `/search` and not a saved-searches deep link: cribl/config.ts lists
            the path shapes that were verified against this workspace, and a
            saved-search route is not one of them. A link that 404s beside a
            teardown warning would be the worst place to guess. */}
        <a className="ac-link" href={criblUiUrl('/search')} target="_blank" rel="noopener noreferrer">
          Open Cribl Search ↗
        </a>
      </div>

      {(steps.length > 0 || leftBehind.length > 0) && (
        <div className="gs-steps">
          {steps.map((s, i) => (
            <div key={`${s.id}-${i}`} className={`gs-step gs-step-${s.action === 'error' || s.action === 'refused' ? 'err' : s.action === 'skipped' ? 'skip' : 'ok'}`}>
              <span className="gs-step-icon">{s.action === 'error' || s.action === 'refused' ? '✕' : s.action === 'skipped' ? '⤼' : '✓'}</span>
              <span className="gs-step-label">{s.id}</span>
              <span className="gs-step-action">{ACTION_TXT[s.action]}{s.detail ? ` — ${s.detail}` : ''}</span>
            </div>
          ))}
          {running !== null && <div className="gs-step gs-step-run"><span className="gs-step-icon">…</span> working…</div>}
        </div>
      )}

      {/* What was NOT removed, which is the half a customer otherwise finds out
          from an invoice. `left` includes searches from an older release that
          are still firing on a cron; this app will not delete those. */}
      {leftBehind.length > 0 && (
        <div className="ac-left" role="status">
          <h4 className="ac-estimate-head">Left in place</h4>
          <ul className="ac-left-rows">
            {leftBehind.map((l) => (
              <li key={l.id}>
                <code>{l.id}</code> — {l.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      {stillPresent.length > 0 && (
        <p className="ac-note ac-note-bad" role="status">
          Cribl accepted the delete for {stillPresent.join(', ')} and still lists {stillPresent.length === 1 ? 'it' : 'them'}.
          {' '}Remove {stillPresent.length === 1 ? 'it' : 'them'} in Cribl Search — until then {stillPresent.length === 1 ? 'it keeps' : 'they keep'} firing and billing.
        </p>
      )}

      {state !== null && (
        <ConfirmDialog
          isOpen={confirming?.kind === 'apply'}
          title={`Create ${applyResources(state).length === 1 ? 'a scheduled Cribl Search saved search' : `${applyResources(state).length} scheduled Cribl Search saved searches`} in ${SEARCH_GROUP}`}
          resources={applyResources(state)}
          costLine={applyCostLine(saving)}
          consequences={[
            'Cribl records whoever presses this as the owner of each saved search. That is server-controlled — this app cannot set it and cannot move it afterwards.',
            'Nothing else in this workspace’s saved searches is read, changed or removed.',
            ...(plan?.willLeave ?? []).map((l) => `Not changed: ${l.label} — ${l.why}.`),
          ]}
          undo={
            'Remove acceleration, on this tab, deletes them again. Pause, in a row above, stops one running ' +
            'without deleting it or its stored results.'
          }
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="accel.apply"
              label="Yes, create them"
              busyLabel="Applying…"
              unavailable={running !== null ? 'Another run is already in progress.' : null}
              run={onApply}
            />
          }
        />
      )}

      {state !== null && (
        <ConfirmDialog
          isOpen={confirming?.kind === 'remove'}
          title={`Delete the scheduled Cribl Search saved searches this app created in ${SEARCH_GROUP}`}
          resources={removeResources(state)}
          irreversible={{
            why: 'A deleted saved search takes its stored results with it. Re-creating it runs the schedule from scratch, so the panels it fed run their live query until the first new run completes.',
          }}
          costLine={removeCostLine(saving)}
          consequences={[
            UNINSTALL_WARNING,
            ...(teardown?.willLeave ?? []).map((l) => `Not deleted: ${l.label} — ${l.why}.`),
          ]}
          undo="Review changes, on this tab, creates them again — as this release defines them, not as they are now."
          typeToConfirm={{ value: REMOVE_LITERAL, label: `To confirm, type ${REMOVE_LITERAL}` }}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="accel.remove"
              label="Yes, delete them"
              busyLabel="Removing…"
              className="btn btn-danger"
              unavailable={running !== null ? 'Another run is already in progress.' : null}
              run={onRemove}
            />
          }
        />
      )}

      {scheduleTarget !== null && confirming?.kind === 'schedule' && (
        <ConfirmDialog
          isOpen
          title={`${confirming.enable ? 'Resume' : 'Pause'} the scheduled search ${scheduleTarget.name} (${scheduleTarget.id}) in ${SEARCH_GROUP}`}
          resources={[
            {
              action: 'replace',
              kind: SAVED_KIND,
              id: scheduleTarget.id,
              group: SEARCH_GROUP,
              detail: confirming.enable
                ? `Its schedule is turned back on: ${scheduleTarget.cron} ${scheduleTarget.tz}.`
                : 'Its schedule is turned off. The saved search and the runs it has already stored are kept.',
            },
          ]}
          costLine={scheduleCostLine(saving, confirming.id, confirming.enable)}
          consequences={[
            confirming.enable
              ? `${scheduleTarget.serves} goes back to reading this search's stored result.`
              : `${scheduleTarget.serves} keeps showing the last stored run until it ages out, and then runs its own query on every paint.`,
            'This endpoint carries no version to make a write conditional on, so if somebody edits this saved search at the same moment, one of the two changes is lost with no error. This app re-reads afterwards and says so if that happened.',
          ]}
          undo={`${confirming.enable ? 'Pause' : 'Resume'}, in the same row, puts it back.`}
          onCancel={() => setConfirming(null)}
          confirm={
            <GatedControl
              write="accel.pause"
              label={confirming.enable ? 'Yes, resume it' : 'Yes, pause it'}
              busyLabel={confirming.enable ? 'Resuming…' : 'Pausing…'}
              unavailable={running !== null ? 'Another run is already in progress.' : null}
              run={() => onSchedule(confirming.id, confirming.enable)}
            />
          }
        />
      )}
    </Panel>
  )
}

interface RowProps {
  row: AccelRow
  status: AccelStatus | null
  health: Health
  action: RowAction
  note: string | null
  ownerName: string
  withOwner: boolean
  columns: number
  blocked: boolean
  onSchedule: (enable: boolean) => void
}

/**
 * One scheduled search: the row, and the sentence under it.
 *
 * Two `<tr>`s rather than a wrapping cell, because `.dtable` sets
 * `white-space: nowrap` on every cell — the note in one of them would push the
 * table sideways. It is the same shape components/JobWatchdog.tsx uses for its
 * query disclosure, for the same reason.
 */
function ScheduleRows({ row, status, health, action, note, ownerName, withOwner, columns, blocked, onSchedule }: RowProps) {
  return (
    <>
      <tr>
        <th scope="row" className="dtable-id ac-serves">
          <span className="ac-serves-name">{row.entry.serves}</span>
          <span className="ac-serves-id">{row.id}</span>
        </th>
        <td><StatusPill state={PILL_STATE[row.state]} /></td>
        <td className={`ac-health ac-health-${health.tone}`}>{health.word}</td>
        <td className="ac-lastrun">
          <span>{lastRunWhen(status)}</span>
          <span className="ac-lastrun-cost">{lastRunCostWords(status)}</span>
        </td>
        {withOwner && <td>{ownerName}</td>}
        <td className="dtable-actions">
          {action.kind === 'none' ? (
            <span className="ac-noaction">{action.word}</span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              /* The visible label is one word; the accessible name carries the
                 search id and the panel it feeds, because "Pause" on its own is
                 meaningless to somebody hearing the third row of a table. */
              aria-label={rowActionName(action.kind, row.entry)}
              aria-disabled={blocked || undefined}
              onClick={() => { if (blocked) return; onSchedule(action.kind === 'resume') }}
            >
              {action.kind === 'pause' ? 'Pause…' : 'Resume…'}
            </button>
          )}
        </td>
      </tr>
      {note && (
        <tr className="ac-noterow">
          <td colSpan={columns}>{note}</td>
        </tr>
      )}
    </>
  )
}
