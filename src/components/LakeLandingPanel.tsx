// "How is my data landing, and let me change it" — one more Panel on Guided
// Setup's single page, a sibling of <ProvisionPanel> and <AccelPanel>.
//
// THERE IS NO SECTION SHELL AND NO `/setup/<section>` ROUTE. The owner withdrew
// the four-section design on 2026-09-17 (I-D2), so the dataset-absent state
// points at the ingest panel ABOVE THIS ONE ON THE SAME PAGE, through an
// in-page anchor whose id is one string — `INGEST_ANCHOR_ID` in
// lakeLandingCopy.ts, put on the wrapper in src/tabs/GuidedSetup.tsx. A link to
// `/setup/storage` is a rejected design leaking back in, and Preview check 1.8
// reads for exactly that.
//
// ── WHAT THIS PANEL IS FOR, AND WHY IT IS THE MOST DANGEROUS ONE IN THE APP ──
// It PATCHes the live Cribl Lake dataset every dashboard here reads, PATCHes the
// one destination BOTH feeds write through, commits on the Leader, and deploys —
// which restarts that worker group's Worker Processes. Phase 2's worst outcome
// was a schedule that stopped saving. This one's are a destination that stops
// delivering and a dataset twenty-nine days lighter than it was this morning.
// Everything below follows from that, and none of it is style:
//
//   * EVERY WRITE GOES THROUGH A WRITER IN cribl/lakeLanding.ts THAT TAKES A
//     `confirm` AND SENDS NOTHING BEFORE IT ANSWERS TRUE. This file never calls
//     `capi`. The dialog IS the `confirm`, so the diff a customer approves is
//     computed from the read the writer itself just made — not from the state
//     this panel was rendered with a minute ago.
//   * NOTHING WRITES ON LOAD, ON RENDER OR ON A TIMER, and nothing SPENDS on one
//     either. The two measurements are buttons. There is no `setInterval`
//     anywhere in this file — not even to re-tick the "measured 4 minutes ago"
//     label, which is computed from `Date.now()` at render instead. A timer that
//     spends credits on an idle tab is discovered by a bill, not by a test
//     (Preview 2.5 leaves the tab open for thirty minutes and watches).
//   * A RETENTION DECREASE IS THE ONE IRREVERSIBLE EDIT, and its dialog is
//     deliberately harder than the others: `irreversible.why`, the tenant's own
//     size and metrics date, and type-to-confirm on the dataset id. An increase
//     gets `undo` and NO type-to-confirm. If the two look the same the label is
//     decoration — that asymmetry is asserted in this file's test, because
//     Preview check 4.5 is the only other thing that would catch it.
//
// ── TWO <GatedControl>s PER WRITE, AND WHICH ONE IS THE GATE ────────────────
// AccelPanel's shape — a plain outer trigger that only opens the dialog, and the
// dialog's <GatedControl> doing the write — cannot be used here, because these
// writers READ LIVE INSIDE THEMSELVES to build what the dialog shows. So the
// OUTER control is the real gate: its `run` is the whole writer, so a refusal
// recorded while that writer ran is attributed to it and latches it closed, and
// it is the one <GateNote> reports under. The control inside the dialog is a
// <GatedControl> for the SAME id whose `run` only answers the writer's
// `confirm` — it is there because <ConfirmDialog> requires one (it clones
// `blockedUntil` onto it, which is how type-to-confirm reaches a button at all)
// and because after a refusal both should be closed, which sharing the id gives
// for free.
//
// ── WHAT IS NOT BUILT, AND IT IS A DELIVERABLE RATHER THAN A TODO ───────────
// No reader toggle and no partitions editor. Both are gated on spikes that have
// not run (P-S5, P-S7, P-S9). Their rows render the LIVE value read-only with
// `spikeGateNote()` naming what has to be measured first — the same refusal
// Phase 1 made of <DiffTable> and <Unavailable> rather than guess, in the same
// voice. `SPIKE_GATED` in cribl/landing.ts is the single source of those
// sentences, so the panel and the module cannot drift.
//
// ── CSS: EVERY CLASS HERE HAS A RULE ────────────────────────────────────────
// This file was written while another agent owned src/App.css, so it invented no
// class name and borrowed three whose `.ac-` prefix named a panel it is not. The
// settling pass took the rename the handoff asked for: `.ac-tablewrap` and
// `.ac-noterow` are now `.gs-tablewrap` and `.gs-noterow` (both Guided Setup
// tables use them, and both are listed in src/app/retiredClasses.test.ts), and
// the stale-measurement ink is its own `.ll-stale` rather than a HEALTH class
// that happened to be the right grey. What has not changed is the rule that
// produced the borrowing: an unstyled class is markup rendering with nothing to
// say so, which is the defect retiredClasses.test.ts exists to catch.

import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Checkbox, Collapse, NumberField, RadioGroup, RadioTile, Skeleton, TextField } from '@capra/core'
import { ConfirmDialog, type DiffEntry } from './ConfirmDialog'
import { GateNote, GatedControl } from './GatedControl'
import { InfoTip } from './InfoTip'
import { Panel } from './Panel'
import { pushToast } from './Toast'
// Every word and unit this panel prints lives next door, pure and DOM-free, so a
// test can read a sentence without rendering a screen — see that file's header.
import {
  INGEST_ANCHOR_ID,
  LAG_CPU_SECONDS,
  PARTITION_CPU_SECONDS,
  PARTITION_GATE,
  READER_GATE,
  STALE_AFTER_MS,
  costLabel,
  destinationConsequences,
  destinationResources,
  flushOf,
  flushWords,
  formatLag,
  printValue,
  relativeAge,
  sizeSentence,
} from './lakeLandingCopy'
import { fmtBytes, toNum } from '../lib/format'
import { runSearch } from '../cribl/search'
import {
  LANDING_LAG_EARLIEST,
  LANDING_LAG_QUERY,
  PARTITION_CANDIDATES_QUERY,
} from '../queries/lakeLanding'
import {
  DATASET_DESCRIPTION,
  DEFAULT_PROFILE,
  DEPLOY_CONSEQUENCES,
  DESTINATION_UNDO,
  FLUSH_PRESETS,
  LANDING_TERMS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  NO_CHANGE_NOTE,
  PREP_PIPELINE_ID,
  destinationSpec,
  flushPresetOf,
  partitionStats,
  retentionChange,
  spikeGateNote,
  type DiffRow as LandingDiffRow,
  type FlushPresetId,
  type LandingFormat,
  type LandingProfile,
  type Measurement,
  type PartitionStat,
} from '../cribl/landing'
import {
  getDataset,
  getDestination,
  getLakeConfig,
  getLocalSearch,
  getSearchDataset,
  listDatasets,
  listInputs,
  listRoutes,
  listStreamGroupsCurrent,
  type ReadResult,
} from '../cribl/lake'
import {
  commitAndDeployDestination,
  commitScopeAfterConfirm,
  destinationCommitFiles,
  destinationCommitMessage,
  loadingLanding,
  pendingConfigFiles,
  readLanding,
  readLandingProfile,
  resolveFeeds,
  saveLandingProfile,
  setDescription,
  setRetention,
  toRow,
  updateDestination,
  type DescriptionConfirmContext,
  type DestinationConfirmContext,
  type LandingRow,
  type LandingState,
  type RetentionConfirmContext,
  type RowKey,
  type WriteOutcome,
  type WriteStep,
} from '../cribl/lakeLanding'
import { DEFAULT_STREAM_GROUP } from '../cribl/provision'
import { loadSetupGroup } from '../cribl/setupMemory'
import { getDoc, listKeys, type LoggedEntry } from '../cribl/kv'

// ── Identity of the things this panel talks about ───────────────────────────

const DATASET_ID = 'gigamon_ami'
const DESTINATION_ID = 'gigamon_lake'

// ── Per-row retry ───────────────────────────────────────────────────────────

/**
 * One GET per row, so Retry re-issues exactly that row's read and not all nine.
 *
 * This table is the whole of Preview check 1.5, and it is a table rather than a
 * re-run of `readLanding` for a reason that costs the customer in the other
 * direction: nine reads to recover one row is eight requests nobody asked for,
 * on a panel whose commonest failure is a refused object that will go on being
 * refused.
 */
const REREAD: Record<RowKey, (group: string) => Promise<ReadResult<unknown>>> = {
  lakeConfig: () => getLakeConfig(),
  datasets: () => listDatasets(),
  dataset: () => getDataset(),
  searchDataset: () => getSearchDataset(),
  destination: (group) => getDestination(group),
  inputs: (group) => listInputs(group),
  routes: (group) => listRoutes(group),
  localSearch: () => getLocalSearch(),
  groups: () => listStreamGroupsCurrent(),
}

// ── One row of the grid ─────────────────────────────────────────────────────

/**
 * A row in its own state — four of them, and the ROW is the unit (§2.4).
 *
 * AT MODULE SCOPE, not inside the panel. A component declared inside a render is
 * a new component type on every render, so React unmounts and remounts its
 * subtree: the retention box would lose focus on every keystroke, and nobody
 * would find out from a test.
 *
 * The `note` rides on a second `<tr>` rather than in the value cell because
 * `.dtable` sets `white-space: nowrap` on every cell, and the sentence naming
 * the object an admin has to grant is both the longest thing on the row and the
 * only actionable one.
 */
function LandingRowView({
  rowKey,
  label,
  tip,
  row,
  value,
  action,
  extraNote,
  onRetry,
}: {
  rowKey: RowKey
  label: string
  tip?: string
  row: LandingRow<unknown>
  value: ReactNode
  action?: ReactNode
  extraNote?: ReactNode
  onRetry: (key: RowKey) => void
}) {
  const note = row.state === 'value' ? null : row.note
  const recoverable = row.state === 'failed' || row.state === 'unreadable'
  return (
    <Fragment>
      <tr>
        <th scope="row" className="dtable-id">
          {label}
          {tip && <InfoTip text={tip} />}
        </th>
        <td aria-busy={row.state === 'loading' ? true : undefined}>
          {row.state === 'loading' ? (
            <Skeleton title={{ width: 120 }} paragraph={false} />
          ) : row.state === 'value' ? (
            value
          ) : (
            <span className="ac-noaction">—</span>
          )}
        </td>
        <td className="dtable-actions">
          {row.state === 'value' && action}
          {recoverable && (
            <button
              type="button"
              className="btn btn-ghost"
              // The row's own name in the accessible name: `.dtable`'s contract,
              // and the reason is that a screen reader reading a column of
              // buttons all called "Retry" names nothing. Offered on a refusal
              // as well as on a failure, because the thing that fixes a refusal
              // is an admin granting the object this row just named, and the
              // next thing that person wants is this button.
              aria-label={`Retry the read behind ${label}`}
              onClick={() => onRetry(rowKey)}
            >
              Retry
            </button>
          )}
        </td>
      </tr>
      {(note || extraNote) && (
        <tr className="gs-noterow">
          <td colSpan={3}>
            {note}
            {note && extraNote ? ' ' : null}
            {extraNote}
          </td>
        </tr>
      )}
    </Fragment>
  )
}

// ── What a confirmation is being asked about ────────────────────────────────

type Asking =
  | { kind: 'retention'; ctx: RetentionConfirmContext }
  | { kind: 'description'; ctx: DescriptionConfirmContext }
  | { kind: 'destination'; ctx: DestinationConfirmContext }
  | { kind: 'redeploy'; group: string; files: string[] }

type RunningWrite = 'retention' | 'description' | 'destination' | null

export type LandingMode = 'create' | 'edit'

export interface LakeLandingPanelProps {
  /**
   * Force a mode. Left out — which is how GuidedSetup mounts it — the panel
   * derives it from the live dataset read: no dataset yet is `create`, a dataset
   * is `edit`. A prop as well as a derivation so a test can hold one mode still
   * without stubbing a workspace into the shape that produces it.
   */
  mode?: LandingMode
}

export function LakeLandingPanel({ mode }: LakeLandingPanelProps = {}) {
  const [group, setGroup] = useState<string>(DEFAULT_STREAM_GROUP)
  const [rows, setRows] = useState<LandingState>(loadingLanding)
  const [profile, setProfile] = useState<LandingProfile>(DEFAULT_PROFILE)
  const [descDraft, setDescDraft] = useState<string | null>(null)
  const [storeRefused, setStoreRefused] = useState(false)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [running, setRunning] = useState<RunningWrite>(null)
  const [steps, setSteps] = useState<WriteStep[]>([])
  const [lastDiff, setLastDiff] = useState<readonly LandingDiffRow[]>([])
  const [measuring, setMeasuring] = useState<'lag' | 'partitions' | null>(null)
  const [measureError, setMeasureError] = useState<string | null>(null)
  const [audit, setAudit] = useState<LoggedEntry[] | null>(null)

  const alive = useRef(true)
  /** The pending `confirm` promise's resolver. Answering it is the only thing
   *  that lets a writer past its own gate. */
  const answer = useRef<((ok: boolean) => void) | null>(null)
  /** Whether the editors have been seeded from the live reads yet. Seeding once
   *  is what stops a slow read overwriting a number somebody has typed. */
  const seeded = useRef(false)

  const formatName = useId()
  const flushName = useId()

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * Read all nine, and paint each row AS IT RESOLVES.
   *
   * `onRow` rather than awaiting the whole thing, and that is the difference
   * between a per-row panel and a per-panel one wearing nine fields: awaiting
   * holds nine rows behind the slowest, which is what §2.4 forbids and what
   * Preview check 1.4 throttles one endpoint to catch. On a healthy workspace
   * the two are indistinguishable, which is exactly why it is written down.
   */
  const readAll = useCallback(async (g: string) => {
    setRows(loadingLanding())
    await readLanding(g, {
      onRow: (key, row) => {
        if (!alive.current) return
        setRows((prev) => ({ ...prev, [key]: row }) as LandingState)
      },
    })
  }, [])

  useEffect(() => {
    alive.current = true
    void (async () => {
      // The group this viewer last picked in the panel above, so the two agree
      // about which worker group's destination is on screen. A refused or empty
      // store answers null and the shipped default stands.
      const picked = (await loadSetupGroup()) ?? DEFAULT_STREAM_GROUP
      if (!alive.current) return
      setGroup(picked)
      const stored = await readLandingProfile()
      if (!alive.current) return
      // A corrupt or absent document reads as null and is deliberately NOT
      // repaired: the repair would be a write on load. The next press rewrites
      // it whole.
      if (stored) setProfile((p) => ({ ...p, ...stored, version: DEFAULT_PROFILE.version }))
      await readAll(picked)
    })()
    return () => {
      alive.current = false
      // A dialog that unmounts with a writer waiting on it would leave that
      // writer awaiting forever. `false` is the only honest answer.
      answer.current?.(false)
      answer.current = null
    }
  }, [readAll])

  const dataset = rows.dataset.value
  const searchDataset = rows.searchDataset.value
  const destination = rows.destination.value
  const localSearch = rows.localSearch.value
  const lakeConfig = rows.lakeConfig.value

  // Seed the editors from what Cribl actually says, once. The live objects are
  // authoritative; the stored profile only pre-fills what they cannot answer.
  useEffect(() => {
    if (seeded.current) return
    if (rows.dataset.state === 'loading' || rows.destination.state === 'loading') return
    seeded.current = true
    const live = flushOf(destination)
    const pipeline = (destination?.raw as Record<string, unknown> | undefined)?.pipeline
    setProfile((p) => ({
      ...p,
      datasetId: DATASET_ID,
      group,
      retentionDays: dataset?.retentionPeriodInDays ?? p.retentionDays,
      format: (dataset?.format as LandingFormat | undefined) ?? p.format,
      partitions: dataset?.acceleratedFields ?? p.partitions,
      flush: live ?? p.flush,
      dropRaw: pipeline === PREP_PIPELINE_ID,
      searchVersion: searchDataset?.searchVersion === 'v2' ? 'v2' : p.searchVersion,
    }))
    setDescDraft(dataset?.description ?? DATASET_DESCRIPTION)
  }, [rows.dataset.state, rows.destination.state, dataset, destination, searchDataset, group])

  const derivedMode: LandingMode = rows.dataset.state === 'value' ? 'edit' : 'create'
  const effectiveMode = mode ?? derivedMode

  /** The audit trail, newest first. Reads only — it is this app's own record of
   *  presses, and reading it costs nothing and writes nothing. */
  const loadAudit = useCallback(async () => {
    const keys = await listKeys('gigamon/log/')
    const newest = [...keys].sort().reverse().slice(0, 5)
    const entries = await Promise.all(newest.map((k) => getDoc<LoggedEntry>(k)))
    if (!alive.current) return
    setAudit(entries.filter((e): e is LoggedEntry => e !== null))
  }, [])

  useEffect(() => {
    if (effectiveMode !== 'edit') return
    void loadAudit()
  }, [effectiveMode, loadAudit])

  // ── Asking ────────────────────────────────────────────────────────────────

  /** Open the dialog for one intent and hand the writer a promise that answers
   *  only when somebody presses a button in it. */
  const askFor =
    <T,>(build: (ctx: T) => Asking) =>
    (ctx: T): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        answer.current = resolve
        setAsking(build(ctx))
      })

  const settleAsk = (ok: boolean) => {
    const resolve = answer.current
    answer.current = null
    setAsking(null)
    resolve?.(ok)
  }

  /** What every writer does with its result: show the steps, say so once, and
   *  re-read what the panel claims about the objects it just touched. */
  const afterWrite = async (what: string, result: WriteOutcome) => {
    setSteps(result.steps)
    if (result.cancelled) return
    if (result.noop) {
      pushToast({ kind: 'done', text: `${what}: nothing to change.` })
      return
    }
    if (result.ok) {
      pushToast({ kind: 'done', text: `${what} applied.` })
    } else {
      const failed = result.steps.find((s) => s.status === 'error')
      pushToast({ kind: 'error', text: `${what} did not complete — ${failed?.detail ?? 'Cribl refused it.'}` })
    }
    await readAll(group)
    if (effectiveMode === 'edit') await loadAudit()
  }

  // ── The three writes ──────────────────────────────────────────────────────

  const applyRetention = async () => {
    setRunning('retention')
    setSteps([])
    try {
      const result = await setRetention(profile.retentionDays, {
        current: dataset?.retentionPeriodInDays ?? profile.retentionDays,
        dataset,
        confirm: askFor<RetentionConfirmContext>((ctx) => ({ kind: 'retention', ctx })),
      })
      await afterWrite('Retention', result)
    } finally {
      if (alive.current) setRunning(null)
    }
  }

  const applyDescription = async () => {
    setRunning('description')
    setSteps([])
    try {
      const result = await setDescription(descDraft ?? DATASET_DESCRIPTION, {
        current: dataset?.description ?? null,
        confirm: askFor<DescriptionConfirmContext>((ctx) => ({ kind: 'description', ctx })),
      })
      await afterWrite('The dataset description', result)
    } finally {
      if (alive.current) setRunning(null)
    }
  }

  const applyDestination = async () => {
    setRunning('destination')
    setSteps([])
    try {
      const result = await updateDestination(group, destinationSpec(profile), {
        confirm: askFor<DestinationConfirmContext>((ctx) => {
          // Kept so a half-applied run can rebuild the commit message it would
          // have had. The diff itself is the writer's, from the writer's read.
          setLastDiff(ctx.diff)
          return { kind: 'destination', ctx }
        }),
      })
      await afterWrite('The Cribl Lake destination', result)
    } finally {
      if (alive.current) setRunning(null)
    }
  }

  /**
   * Commit and deploy a destination change that already landed.
   *
   * §1.5 rule 9's "Retry failed only", and it exists because of the state the
   * gate in this app cannot prevent: the PATCH succeeds, the commit or the
   * deploy is refused, and the object is changed while the Workers go on running
   * the old configuration. Re-opening the destination editor would NOT fix it —
   * the diff would come back empty and the writer would answer "nothing to
   * change", leaving the commit undone forever.
   */
  const retryCommit = async () => {
    setRunning('destination')
    try {
      const pending = await pendingConfigFiles()
      const files = destinationCommitFiles(group, pending)
      const proceed = await askFor<{ group: string; files: string[] }>((c) => ({
        kind: 'redeploy',
        group: c.group,
        files: c.files,
      }))({ group, files })
      if (!proceed) {
        setSteps((prev) => [...prev, { key: 'commit', status: 'cancelled' }])
        return
      }
      // The list above crossed a user-paced dialog, so it is as old as that
      // dialog was open — another admin committing in that window leaves it
      // naming a path Git no longer reports. Re-read and refuse if it moved,
      // for the same reason the destination body is re-read after its own
      // confirmation: what is sent has to be what was read.
      const scope = await commitScopeAfterConfirm(group, files)
      if ('stop' in scope) {
        setSteps((prev) => [...prev, scope.stop])
        return
      }
      // `trail` on: this call is its own intent, so nothing else writes the
      // audit entry for it. The whole reason this button exists is that the
      // PATCH landed and the commit did not, which is the state most worth a
      // record — see commitAndDeployDestination's header.
      const next = await commitAndDeployDestination(group, scope.files, destinationCommitMessage(group, lastDiff), {}, true)
      await afterWrite('The commit and deploy', {
        ok: next.every((s) => s.status === 'applied' || s.status === 'skipped'),
        cancelled: false,
        noop: false,
        steps: [...steps.filter((s) => s.key === 'destination'), ...next],
      })
    } finally {
      if (alive.current) setRunning(null)
    }
  }

  // ── The two measurements ──────────────────────────────────────────────────

  /**
   * Store the profile after a press, whole.
   *
   * ONE WRITER for `app/settings/lake_landing` — this function — because
   * `saveLandingProfile` rewrites the document entirely, and cribl/prefs.ts
   * already demonstrates what a second writer's field costs. Persisting a
   * measurement is what stops a reload re-spending the credits (Preview 2.4);
   * `false` back from the store means this page is the only thing holding it,
   * which the panel says out loud rather than showing a value the next reload
   * deletes.
   */
  const persist = async (next: LandingProfile) => {
    setProfile(next)
    const kept = await saveLandingProfile(next)
    if (alive.current) setStoreRefused(!kept)
    return kept
  }

  const measureLag = async () => {
    setMeasuring('lag')
    setMeasureError(null)
    try {
      // No cap is written into the body: cribl/search.ts prefixes
      // `set max_running_time_per_search=` sized by the window, and `-5m` lands
      // in the 120-second tier (Preview 2.2). A second cap here would put an
      // execution directive inside a customer-facing provenance claim.
      // Named, and named differently from the partition run's variable, because
      // the display freeze keys a search call site by the name it is assigned to
      // and two `result`s would hide one another in the snapshot.
      const lagRun = await runSearch(LANDING_LAG_QUERY, { earliest: LANDING_LAG_EARLIEST })
      const row = lagRun.rows[0]
      if (!row || toNum(row.n) === 0) {
        // An empty window is not a lag of zero, and rendering one would report a
        // dead feed as the healthiest reading there is. That is the whole reason
        // the query carries `n=count()` alongside the lag.
        setMeasureError(
          `Nothing landed in ${DATASET_ID} in the last five minutes, so there is no newest record to measure against.`,
        )
        return
      }
      const measurement: Measurement<number> = { value: toNum(row.lag_s), at: Date.now(), jobId: lagRun.jobId }
      await persist({ ...profile, lastLagSeconds: measurement })
    } catch (err) {
      setMeasureError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setMeasuring(null)
    }
  }

  const measurePartitions = async () => {
    setMeasuring('partitions')
    setMeasureError(null)
    try {
      const candidateRun = await runSearch(PARTITION_CANDIDATES_QUERY)
      const stats = partitionStats(candidateRun.rows[0] as Record<string, unknown> | undefined)
      if (stats.length === 0) {
        setMeasureError('The partition-candidate measurement came back with no candidate columns in it.')
        return
      }
      const measurement: Measurement<readonly PartitionStat[]> = {
        value: stats,
        at: Date.now(),
        jobId: candidateRun.jobId,
      }
      await persist({ ...profile, lastPartitionStats: measurement })
    } catch (err) {
      setMeasureError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setMeasuring(null)
    }
  }

  // ── Per-row retry ─────────────────────────────────────────────────────────

  const retryRow = useCallback(
    (key: RowKey) => {
      void (async () => {
        const result = await REREAD[key](group)
        if (!alive.current) return
        setRows((prev) => ({ ...prev, [key]: toRow(key, result) }) as LandingState)
      })()
    },
    [group],
  )

  // ── Derived display values ────────────────────────────────────────────────

  const now = Date.now()
  const allRows = Object.values(rows) as LandingRow<unknown>[]
  const stillLoading = allRows.some((r) => r.state === 'loading')
  const unreadable = allRows.filter((r) => r.state === 'unreadable').length
  const failedReads = allRows.filter((r) => r.state === 'failed').length
  const statusNote = stillLoading
    ? 'reading…'
    : unreadable + failedReads === 0
      ? `${allRows.length} reads · all readable`
      : `${allRows.length} reads · ${unreadable} not readable · ${failedReads} failed`

  const lag = profile.lastLagSeconds ?? null
  const lagStale = lag !== null && now - lag.at > STALE_AFTER_MS
  const partitionStatsMeasured = profile.lastPartitionStats ?? null
  const partitionsStale = partitionStatsMeasured !== null && now - partitionStatsMeasured.at > STALE_AFTER_MS

  const liveRetention = dataset?.retentionPeriodInDays ?? null
  const retentionMove = liveRetention === null ? null : retentionChange(liveRetention, profile.retentionDays)
  const liveDescription = dataset?.description ?? null
  const description = descDraft ?? liveDescription ?? DATASET_DESCRIPTION
  const liveFlush = flushOf(destination)
  const flushChanged = liveFlush !== null && flushPresetOf(liveFlush) !== flushPresetOf(profile.flush)

  const busy = running !== null ? 'Another change to this stack is already being applied.' : null

  const failedSteps = steps.filter((s) => s.status === 'error')
  const destinationApplied = steps.some((s) => s.key === 'destination' && s.status === 'applied')
  // NOT `failedSteps.some(...)`, which is what this was. That tested for
  // `status === 'error'`, and the half-applied state this recovery path exists
  // for used to arrive as `skipped` — the commit file list was read before the
  // PATCH, matched nothing, and the commit was quietly skipped. So the one case
  // the button was built for was exactly the case it did not render in. The
  // list read after the PATCH now reports that contradiction as an error, and
  // this no longer depends on it doing so: once the destination is applied,
  // ANY commit or deploy step that did not apply — error, skipped, cancelled —
  // leaves the Workers on the old configuration, which is what the strip says.
  const commitIncomplete =
    destinationApplied && steps.some((s) => (s.key === 'commit' || s.key === 'deploy') && s.status !== 'applied')

  const feeds = resolveFeeds(rows.inputs.value ?? [], rows.routes.value ?? [], DESTINATION_ID)
  const thisGroup = rows.groups.value?.find((g) => g.id === group) ?? null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Panel
      title="How data lands in Cribl Lake"
      note={statusNote}
      tourId="lake-landing"
      info="Every value on this panel and the endpoint it came from. Dataset, retention, description, object format and partitions: GET /products/lake/lakes/default/datasets/gigamon_ami?includeMetrics=true. Datasets in this lake: GET /products/lake/lakes/default/datasets?excludeDeleted=false&includeMetrics=true. Storage location and the partition-field limit: GET /products/lake/lakes/default/config. Search reader: GET /m/default_search/search/datasets/gigamon_ami. Acceleration tier: GET /m/default_search/search/local_search, with its engine count from the same path's /engines. How objects are written, and destination health: GET /m/{gid}/system/outputs/gigamon_lake. Feeds writing through it: GET /m/{gid}/system/inputs and GET /m/{gid}/routes. Worker group and the commit its Workers are running: GET /products/stream/groups. Landing lag and the partition-candidate statistics are NOT reads — each is a Cribl Search job started by its own Measure button, and what you see afterwards comes back from this app's own store, app/settings/lake_landing, with the time it was taken, so reloading the page does not spend the credits again."
      infoLabel="Where every value on this panel came from"
      infoDialogLabel="The read map for “How data lands in Cribl Lake”"
    >
      <p className="gs-intro">
        This panel reports the live Cribl Lake objects the dashboards read, and lets you change three
        of them. Nothing is written until you press Apply and read the before-and-after in the
        confirmation. <strong>A retention decrease is the one change that cannot be undone</strong> —
        Cribl Lake datasets are under no version control, so unlike a destination edit there is no
        commit to revert.
      </p>

      {rows.dataset.state === 'absent' && (
        <p className="gs-action-note gs-action-warn">
          The <code>{DATASET_ID}</code> dataset does not exist yet, so most rows below have nothing to
          report.{' '}
          <a href={`#${INGEST_ANCHOR_ID}`}>Create it from the onboarding panel at the top of this page</a>
          {' '}— this panel changes objects, it does not create them.
        </p>
      )}

      {effectiveMode === 'create' && (
        <CreateChoices
          profile={profile}
          formatName={formatName}
          flushName={flushName}
          onProfile={setProfile}
          onSave={() => void persist(profile)}
          storeRefused={storeRefused}
        />
      )}

      <div className="gs-tablewrap">
        <table className="dtable">
          <caption className="sr-only">
            How the {DATASET_ID} dataset and the {DESTINATION_ID} destination are configured — one row
            per setting, each with what this app could read and what it can change.
          </caption>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Live value</th>
              <th scope="col" className="dtable-actions">Change</th>
            </tr>
          </thead>
          <tbody>
            <LandingRowView
              rowKey="dataset"
              label="Dataset"
              row={rows.dataset}
              onRetry={retryRow}
              value={
                <span className="ac-serves">
                  <span className="ac-serves-name">{dataset?.id ?? DATASET_ID}</span>
                  <span className="ac-serves-id">
                    {dataset?.metrics?.currentSizeBytes != null
                      ? `${fmtBytes(dataset.metrics.currentSizeBytes)}${dataset.metrics.metricsDate ? `, as Cribl measured it on ${dataset.metrics.metricsDate}` : ', at Cribl’s last measurement'}`
                      : 'Cribl Lake reported no size for this dataset'}
                  </span>
                </span>
              }
            />

            <LandingRowView
              rowKey="dataset"
              label="Retention"
              row={rows.dataset}
              onRetry={retryRow}
              value={<>{liveRetention === null ? 'not reported' : `${liveRetention} days`}</>}
              action={
                effectiveMode === 'edit' ? (
                  <span className="sl-input-wrap">
                    <NumberField
                      label="Retention, in days"
                      layout="horizontal"
                      value={profile.retentionDays}
                      min={MIN_RETENTION_DAYS}
                      max={MAX_RETENTION_DAYS}
                      onChange={(v) => setProfile((p) => ({ ...p, retentionDays: v }))}
                    />
                    <GatedControl
                      write="lake_landing.retention"
                      label="Apply"
                      busyLabel="Applying…"
                      className="btn"
                      unavailable={
                        busy ??
                        (retentionMove === null
                          ? 'This app could not read the current retention, so it will not overwrite it.'
                          : retentionMove.problems.length > 0
                            ? retentionMove.problems.join(' ')
                            : retentionMove.direction === 'none'
                              ? `Retention is already ${profile.retentionDays} days.`
                              : null)
                      }
                      run={applyRetention}
                    />
                  </span>
                ) : null
              }
              extraNote={
                effectiveMode === 'edit' && retentionMove?.direction === 'decrease' ? (
                  <span>
                    Lowering retention deletes everything in this dataset older than the new window —
                    immediately, for everyone reading it, and with nothing to revert.
                  </span>
                ) : null
              }
            />

            {effectiveMode === 'edit' && (
              <LandingRowView
                rowKey="dataset"
                label="Description"
                row={rows.dataset}
                onRetry={retryRow}
                value={<>{liveDescription ?? 'not set'}</>}
                action={
                  <span className="sl-input-wrap">
                    <TextField
                      label="Dataset description"
                      layout="horizontal"
                      value={description}
                      onChange={setDescDraft}
                    />
                    <GatedControl
                      write="lake_landing.description"
                      label="Apply"
                      busyLabel="Applying…"
                      className="btn"
                      unavailable={
                        busy ??
                        (description.trim() === ''
                          ? 'A description with no text in it.'
                          : description === (liveDescription ?? '')
                            ? 'The description already says this.'
                            : null)
                      }
                      run={applyDescription}
                    />
                  </span>
                }
              />
            )}

            <LandingRowView
              rowKey="dataset"
              label="Object format"
              row={rows.dataset}
              onRetry={retryRow}
              value={<>{dataset?.format ?? 'not reported'}</>}
              extraNote={
                <span>
                  Not editable here: this release always lands JSON. Changing the format moves a month
                  of history and is Phase 4’s migration, which is a different kind of change from
                  anything on this panel.
                </span>
              }
            />

            <LandingRowView
              rowKey="dataset"
              label="Partitions"
              row={rows.dataset}
              onRetry={retryRow}
              value={
                <>
                  {dataset?.acceleratedFields === null
                    ? 'the dataset carries no acceleratedFields field at all'
                    : dataset?.acceleratedFields?.length
                      ? dataset.acceleratedFields.join(', ')
                      : 'none'}
                </>
              }
              action={
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Measure the partition candidates for ${DATASET_ID} — ${costLabel(PARTITION_CPU_SECONDS)}`}
                  onClick={() => void measurePartitions()}
                  disabled={measuring !== null}
                >
                  {measuring === 'partitions'
                    ? 'Measuring…'
                    : `${partitionStatsMeasured ? 'Re-measure' : 'Measure'} — ${costLabel(PARTITION_CPU_SECONDS)}`}
                </button>
              }
              extraNote={
                <>
                  {PARTITION_GATE && <span>{spikeGateNote(PARTITION_GATE)}</span>}
                  {partitionStatsMeasured ? (
                    <span>
                      {' '}
                      Candidates, measured{' '}
                      <span className={partitionsStale ? 'll-stale' : undefined}>
                        {relativeAge(partitionStatsMeasured.at, now)}
                      </span>
                      :{' '}
                      {partitionStatsMeasured.value
                        .map(
                          (s) =>
                            `${s.field} — ${s.fill === null ? 'fill unknown' : `${Math.round(s.fill * 100)}% filled`}, ${s.distinct} distinct`,
                        )
                        .join(' · ')}
                      .
                    </span>
                  ) : (
                    <span> Candidates: not measured.</span>
                  )}
                </>
              }
            />

            <LandingRowView
              rowKey="lakeConfig"
              label="Storage location"
              row={rows.lakeConfig}
              onRetry={retryRow}
              value={<>Cribl Lake, managed by Cribl</>}
              extraNote={
                <span>
                  Not a setting: a Cribl-managed Lake dataset exposes no storage location and no
                  storage class to change, so there is nothing here to edit and no disabled box
                  pretending otherwise.{' '}
                  {lakeConfig?.maxAcceleratedFieldsCount != null
                    ? `This tenant allows ${lakeConfig.maxAcceleratedFieldsCount} partition field${lakeConfig.maxAcceleratedFieldsCount === 1 ? '' : 's'} on a dataset.`
                    : 'This tenant did not report a partition-field limit.'}
                </span>
              }
            />

            <LandingRowView
              rowKey="datasets"
              label="Datasets in this lake"
              row={rows.datasets}
              onRetry={retryRow}
              value={<>{rows.datasets.value?.length ?? 0}</>}
            />

            <LandingRowView
              rowKey="searchDataset"
              label="Search reader"
              tip={LANDING_TERMS.searchV2}
              row={rows.searchDataset}
              onRetry={retryRow}
              value={<>{searchDataset?.searchVersion ?? 'not reported'}</>}
              extraNote={READER_GATE ? <span>{spikeGateNote(READER_GATE)}</span> : null}
            />

            <LandingRowView
              rowKey="localSearch"
              label="Acceleration tier"
              tip={LANDING_TERMS.accelerationTier}
              row={rows.localSearch}
              onRetry={retryRow}
              value={
                <>
                  {localSearch?.enabled
                    ? localSearch.engines === null
                      ? 'local search enabled; this account could not read the engine list'
                      : `local search enabled · ${localSearch.engines} engine${localSearch.engines === 1 ? '' : 's'}`
                    : 'no local search engines'}
                </>
              }
            />

            <LandingRowView
              rowKey="dataset"
              label="Landing lag"
              tip={LANDING_TERMS.landingLag}
              row={rows.dataset}
              onRetry={retryRow}
              value={
                lag === null ? (
                  // Never `0 s` and never a bare `—`, either of which reads as
                  // "the feed is perfectly current" (I-D20, Preview 2.1).
                  <span className="ac-noaction">not measured</span>
                ) : (
                  <span className="ac-serves">
                    <span className={lagStale ? 'll-stale' : 'ac-serves-name'}>{formatLag(lag.value)}</span>
                    <span className="ac-serves-id">measured {relativeAge(lag.at, now)}</span>
                  </span>
                )
              }
              action={
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Measure the landing lag for ${DATASET_ID} — ${costLabel(LAG_CPU_SECONDS)}`}
                  onClick={() => void measureLag()}
                  disabled={measuring !== null}
                >
                  {measuring === 'lag'
                    ? 'Measuring…'
                    : `${lag ? 'Re-measure' : 'Measure'} — ${costLabel(LAG_CPU_SECONDS)}`}
                </button>
              }
            />

            <LandingRowView
              rowKey="destination"
              label="How objects are written"
              row={rows.destination}
              onRetry={retryRow}
              value={
                <span className="ac-serves">
                  <span className="ac-serves-name">
                    {liveFlush ? flushWords(liveFlush) : 'this destination did not report all three flush settings'}
                  </span>
                  <span className="ac-serves-id">
                    {destination?.health ? `health ${destination.health}` : 'health not reported'}
                  </span>
                </span>
              }
              action={
                effectiveMode === 'edit' ? (
                  <span className="sl-input-wrap">
                    <GatedControl
                      write="lake_landing.destination"
                      label="Change…"
                      busyLabel="Applying…"
                      className="btn"
                      unavailable={busy ?? (flushChanged ? null : NO_CHANGE_NOTE)}
                      run={applyDestination}
                    />
                  </span>
                ) : null
              }
              extraNote={
                effectiveMode === 'edit' ? (
                  <span>
                    Pick a flush setting under “Adjust how objects are written” below, then press
                    Change. Applying it commits this group’s <code>outputs.yml</code> and deploys,
                    which restarts the group’s Worker Processes.
                  </span>
                ) : null
              }
            />

            <LandingRowView
              rowKey="inputs"
              label="Feeds writing through it"
              row={rows.inputs}
              onRetry={retryRow}
              value={<>{feeds.length === 0 ? 'nothing writes through it' : feeds.map((f) => f.label).join(', ')}</>}
              extraNote={
                rows.routes.state !== 'value' ? (
                  <span>
                    The routing table could not be read, so this list is built from the sources alone
                    and may be short. {rows.routes.note}
                  </span>
                ) : null
              }
            />

            <LandingRowView
              rowKey="groups"
              label="Worker group"
              row={rows.groups}
              onRetry={retryRow}
              value={
                <span className="ac-serves">
                  <span className="ac-serves-name">{group}</span>
                  <span className="ac-serves-id">
                    {thisGroup?.configVersion
                      ? `Workers are running commit ${thisGroup.configVersion.slice(0, 10)}`
                      : 'this Leader did not report which commit the Workers are running'}
                  </span>
                </span>
              }
            />
          </tbody>
        </table>
      </div>

      {measureError && (
        <p className="sl-note sl-note-warn" role="status">
          {measureError}
        </p>
      )}
      {storeRefused && (
        <p className="sl-note sl-note-warn" role="status">
          The app store would not keep the last measurement, so it is held on this page only and will
          be gone after a reload. Inside Cribl that usually means the store is unreachable; on the
          localhost dev page it always happens and is expected.
        </p>
      )}

      {effectiveMode === 'edit' && (
        <Collapse title="Adjust how objects are written">
          <div className="ac-presets">
            <RadioGroup
              name={flushName}
              layout="vertical"
              value={flushPresetOf(profile.flush) === 'custom' ? null : flushPresetOf(profile.flush)}
              onChange={(e) => {
                const id = e.target.value as FlushPresetId
                setProfile((p) => ({ ...p, flush: { ...FLUSH_PRESETS[id] } }))
              }}
              aria-label="How often an object is closed"
            >
              {(Object.keys(FLUSH_PRESETS) as FlushPresetId[]).map((id) => (
                <RadioTile key={id} value={id} description={FLUSH_PRESETS[id].why}>
                  {FLUSH_PRESETS[id].label}
                </RadioTile>
              ))}
            </RadioGroup>
            <Checkbox
              checked={profile.dropRaw}
              onChange={(e) => setProfile((p) => ({ ...p, dropRaw: e.target.checked }))}
            >
              Drop the raw copy of each event before it is written (pipeline {PREP_PIPELINE_ID})
            </Checkbox>
            <p className="ac-note">
              Nothing here is applied until you press Change on the “How objects are written” row
              above and read the before-and-after. That confirmation names every feed writing through
              the destination and says that deploying restarts this group’s Worker Processes.
            </p>
          </div>
        </Collapse>
      )}

      <div className="gs-actions ac-actions">
        <button type="button" className="btn btn-ghost" onClick={() => void readAll(group)} disabled={stillLoading}>
          {stillLoading ? 'Reading…' : 'Re-read everything'}
        </button>
        {/* The confirmations close before their write finishes, so the button
            that was refused can be gone by the time there is anything to say.
            The note belongs on the screen the reader is looking at. */}
        <GateNote write="lake_landing.retention" />
        <GateNote write="lake_landing.description" />
        <GateNote write="lake_landing.destination" />
      </div>

      {steps.length > 0 && (
        <div className="gs-steps">
          {steps.map((s, i) => (
            <div
              key={`${s.key}-${i}`}
              className={`gs-step gs-step-${s.status === 'error' ? 'err' : s.status === 'applied' ? 'ok' : 'skip'}`}
            >
              <span className="gs-step-icon">{s.status === 'error' ? '✕' : s.status === 'applied' ? '✓' : '⤼'}</span>
              <span className="gs-step-label">{s.key}</span>
              <span className="gs-step-action">
                {s.status}
                {s.detail ? ` — ${s.detail}` : ''}
              </span>
            </div>
          ))}
          {/* The terminal line §1.5 rule 9 asks for. A step list without one
              leaves a reader counting ticks to find out whether it worked. */}
          <p className="gs-action-note" role="status">
            {steps.filter((s) => s.status === 'applied').length} of {steps.length} applied
            {failedSteps.length > 0 ? ` · ${failedSteps.length} failed` : ''}. This run is also in this
            app’s audit trail, which survives a reload.
          </p>
        </div>
      )}

      {commitIncomplete && (
        <div className="gs-actions">
          <p className="ac-note ac-note-bad" role="status">
            The destination was changed and the commit or the deploy did not complete, so this group’s
            Workers are still running the old configuration. Retrying below commits and deploys that
            change; it does not send the destination body again.
          </p>
          <GatedControl
            write="lake_landing.destination"
            label="Retry the commit and deploy"
            busyLabel="Deploying…"
            className="btn"
            unavailable={busy}
            run={retryCommit}
          />
        </div>
      )}

      {effectiveMode === 'edit' && audit !== null && (
        <div className="ac-left">
          <h4 className="ac-estimate-head">Recent changes this app made</h4>
          {audit.length === 0 ? (
            <p className="ac-note">Nothing yet — this app has written nothing to this workspace.</p>
          ) : (
            <ul className="ac-left-rows">
              {audit.map((entry) => (
                <li key={`${entry.at}-${entry.action}`}>
                  <code>{entry.action}</code> — {new Date(entry.at).toLocaleString()}
                  {entry.by ? ` by ${entry.by}` : ' (the platform named no user)'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── The confirmations ─────────────────────────────────────────────── */}

      {asking?.kind === 'retention' && (
        <RetentionDialog ctx={asking.ctx} onCancel={() => settleAsk(false)} onConfirm={() => settleAsk(true)} />
      )}

      {asking?.kind === 'description' && (
        <ConfirmDialog
          isOpen
          title={`Change the description of Cribl Lake dataset ${asking.ctx.datasetId}`}
          resources={[
            {
              action: 'replace',
              kind: 'Cribl Lake dataset',
              id: asking.ctx.datasetId,
              detail:
                'Only the description changes. Nothing about the data, the retention or the way objects are written is touched.',
            },
          ]}
          diff={[
            {
              resourceId: asking.ctx.datasetId,
              key: 'description',
              before: asking.ctx.before,
              after: asking.ctx.after,
            },
          ]}
          undo="Reversible: set the description back in this same editor."
          onCancel={() => settleAsk(false)}
          confirm={
            <GatedControl
              write="lake_landing.description"
              label="Yes, change it"
              busyLabel="Changing…"
              run={async () => settleAsk(true)}
            />
          }
        />
      )}

      {asking?.kind === 'destination' && (
        <ConfirmDialog
          isOpen
          title={`Change how objects are written to Cribl Lake — destination ${asking.ctx.destinationId} in group ${asking.ctx.group}`}
          resources={destinationResources(asking.ctx)}
          diff={asking.ctx.diff.map(
            (d): DiffEntry => ({
              resourceId: asking.ctx.destinationId,
              key: d.key,
              before: printValue(d.before),
              after: printValue(d.after),
            }),
          )}
          consequences={destinationConsequences(asking.ctx)}
          undo={DESTINATION_UNDO}
          onCancel={() => settleAsk(false)}
          confirm={
            <GatedControl
              write="lake_landing.destination"
              label="Yes, apply and deploy"
              busyLabel="Applying…"
              run={async () => settleAsk(true)}
            />
          }
        />
      )}

      {asking?.kind === 'redeploy' && (
        <ConfirmDialog
          isOpen
          title={`Commit and deploy the destination change already made in group ${asking.group}`}
          resources={[
            {
              action: 'deploy',
              kind: 'Cribl worker group',
              id: asking.group,
              detail:
                'The destination body was already changed. This commits that change and pushes it to the running Workers.',
            },
          ]}
          consequences={[
            asking.files.length === 0
              ? 'Cribl reports no pending change to this group’s outputs.yml, so there may be nothing left to commit — somebody may have committed it in Cribl already.'
              : `The commit carries ${asking.files.join(', ')} — that one file holds every destination in ${asking.group}.`,
            ...DEPLOY_CONSEQUENCES,
          ]}
          undo={DESTINATION_UNDO}
          onCancel={() => settleAsk(false)}
          confirm={
            <GatedControl
              write="lake_landing.destination"
              label="Yes, commit and deploy"
              busyLabel="Deploying…"
              run={async () => settleAsk(true)}
            />
          }
        />
      )}
    </Panel>
  )
}

// ── The retention confirmation, which is the one that is different ──────────

/**
 * The retention dialog, and the asymmetry that is the whole point of it.
 *
 * A DECREASE gets `irreversible.why`, the tenant's own size and metrics date,
 * and type-to-confirm on the dataset id. An INCREASE gets `undo` and NO
 * type-to-confirm. <ConfirmDialog> does not enforce that pairing — its own test
 * file records that `irreversible` and `typeToConfirm` are two independent props
 * and that nothing checks the literal is the resource id — so it is enforced
 * here, in one place, and asserted in this file's test. If both paths look the
 * same, "labelled as irreversible" is decoration and Preview check 4.5 fails.
 */
function RetentionDialog({
  ctx,
  onCancel,
  onConfirm,
}: {
  ctx: RetentionConfirmContext
  onCancel: () => void
  onConfirm: () => void
}) {
  const { change, datasetId } = ctx
  const decrease = change.direction === 'decrease'
  return (
    <ConfirmDialog
      isOpen
      title={
        decrease
          ? `Delete data: lower retention on Cribl Lake dataset ${datasetId} from ${change.from} to ${change.to} days`
          : `Raise retention on Cribl Lake dataset ${datasetId} from ${change.from} to ${change.to} days`
      }
      resources={[
        {
          action: 'replace',
          kind: 'Cribl Lake dataset',
          id: datasetId,
          detail: decrease
            ? 'Everything older than the new window is deleted, for everyone reading this dataset.'
            : 'Data already aged out does not come back; this only changes what is kept from now on.',
        },
      ]}
      diff={[
        {
          resourceId: datasetId,
          key: 'retentionPeriodInDays',
          before: String(change.from),
          after: String(change.to),
        },
      ]}
      irreversible={decrease && change.why ? { why: change.why } : undefined}
      consequences={decrease ? [sizeSentence(ctx)] : undefined}
      undo={change.undo ?? undefined}
      typeToConfirm={decrease ? { value: datasetId, label: `To confirm, type ${datasetId}` } : undefined}
      onCancel={onCancel}
      confirm={
        <GatedControl
          write="lake_landing.retention"
          label={decrease ? 'Yes, delete the older data' : 'Yes, raise it'}
          busyLabel="Changing…"
          className={decrease ? 'btn btn-danger' : 'btn btn-primary'}
          run={async () => onConfirm()}
        />
      }
    />
  )
}


// ── Create mode ─────────────────────────────────────────────────────────────

/**
 * The one decision an install with no dataset yet is asked to make, plus the
 * rest behind a disclosure.
 *
 * §2.4 is explicit that this is NOT a separate component file: on every install
 * past day one a create-mode block of its own is a dead read-only panel sitting
 * above the live one. It is a function in this file, rendered by this panel,
 * behind one mode check.
 *
 * WHAT IT DOES NOT CLAIM. Choosing Parquet here records an intention and changes
 * nothing today: this release always lands JSON, and whether a Cribl Lake
 * destination set to Parquet even writes Parquet objects into a dataset still
 * labelled `format:json` is P-S1's and P-S5's to answer
 * (`CAPABILITIES.destinationWritesParquetIntoJsonDataset` is `null` for exactly
 * that reason). Saying so on the tile is the difference between an option and a
 * promise.
 */
function CreateChoices({
  profile,
  formatName,
  flushName,
  onProfile,
  onSave,
  storeRefused,
}: {
  profile: LandingProfile
  formatName: string
  flushName: string
  onProfile: (next: (p: LandingProfile) => LandingProfile) => void
  onSave: () => void
  storeRefused: boolean
}) {
  return (
    <div className="ac-presets">
      <p className="ac-note">
        Nothing exists yet, so this is a set of choices rather than an editor. They are stored for
        this install at <code>app/settings/lake_landing</code>; the onboarding panel above is what
        creates the dataset and the destination.
      </p>

      <RadioGroup
        name={formatName}
        layout="vertical"
        value={profile.format}
        onChange={(e) => onProfile((p) => ({ ...p, format: e.target.value as LandingFormat }))}
        aria-label="How objects are written into the dataset"
      >
        <RadioTile
          value="json"
          description="One JSON record per line, gzipped. Every Cribl Search query reads whole objects, so a query that needs three fields still pays for all of them — and it is what every measurement in this app was taken against. This is what this release writes."
        >
          JSON, gzipped
        </RadioTile>
        <RadioTile
          value="parquet"
          description="Columnar, so a query reads only the columns it names — the search saving this whole plan exists for. It costs storage: Cribl’s automatic schema writes PLAIN with SNAPPY, and an uncompressed-encoding column store can be several times the size of the gzipped JSON it replaces, so the storage bill can grow while the search bill falls. Choosing it here records the intention and changes nothing today; this release still writes JSON, and the migration that applies it is Phase 4’s, waiting on P-S1 and P-S5."
        >
          Parquet
        </RadioTile>
      </RadioGroup>

      <p className="ac-note">
        Everything else starts at: {profile.retentionDays} days retention · {flushWords(profile.flush)} ·
        no partitions · raw copy kept · read with Federated Search v1.
      </p>

      <Collapse title="Adjust defaults">
        <div className="ac-presets">
          <NumberField
            label="Retention, in days"
            value={profile.retentionDays}
            min={MIN_RETENTION_DAYS}
            max={MAX_RETENTION_DAYS}
            helperText={`Cribl Lake accepts ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} days. The clock runs from the date data was uploaded, not from the timestamp on the event.`}
            onChange={(v) => onProfile((p) => ({ ...p, retentionDays: v }))}
          />
          <RadioGroup
            name={flushName}
            layout="vertical"
            value={flushPresetOf(profile.flush) === 'custom' ? null : flushPresetOf(profile.flush)}
            onChange={(e) => {
              const id = e.target.value as FlushPresetId
              onProfile((p) => ({ ...p, flush: { ...FLUSH_PRESETS[id] } }))
            }}
            aria-label="How often an object is closed"
          >
            {(Object.keys(FLUSH_PRESETS) as FlushPresetId[]).map((id) => (
              <RadioTile key={id} value={id} description={FLUSH_PRESETS[id].why}>
                {FLUSH_PRESETS[id].label}
              </RadioTile>
            ))}
          </RadioGroup>
          <Checkbox
            checked={profile.dropRaw}
            onChange={(e) => onProfile((p) => ({ ...p, dropRaw: e.target.checked }))}
          >
            Drop the raw copy of each event before it is written (pipeline {PREP_PIPELINE_ID})
          </Checkbox>
          <p className="ac-note">
            Partitions and the Federated Search reader are not offered here.{' '}
            {PARTITION_GATE ? spikeGateNote(PARTITION_GATE) : ''} {READER_GATE ? spikeGateNote(READER_GATE) : ''}
          </p>
        </div>
      </Collapse>

      <div className="gs-actions ac-actions">
        <button type="button" className="btn" onClick={onSave}>
          Save these choices
        </button>
        <span className="ac-note">
          This writes one document in this app’s own store. It creates nothing in Cribl and changes no
          Cribl configuration.
        </span>
      </div>
      {storeRefused && (
        <p className="sl-note sl-note-warn" role="status">
          The app store would not keep these choices, so they are held on this page only and will be
          gone after a reload.
        </p>
      )}
    </div>
  )
}
