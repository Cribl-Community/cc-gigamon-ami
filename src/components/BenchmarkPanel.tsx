// "How fast is each Cribl Lake copy of the data, on the same question?" — the
// store benchmark, one Panel at the bottom of Guided Setup.
//
// ── WHY GUIDED SETUP, AND WHY LAST ──────────────────────────────────────────
// It is an install-level tool, not a dashboard. The person who decides which
// store the dashboards may read is the installer, and Guided Setup is the page
// that already hosts the install-wide tools (search limits, acceleration, the
// Lake landing profile). A tab of its own would put a control that submits
// dozens of full scans in front of every viewer of the app, and would add a
// route, a job budget and a tour stop for a page used a handful of times. It is
// last on the page because the page descends from "what exists" to "what runs
// on its own": this panel runs nothing unless somebody presses a button, and it
// changes nothing about the install either way.
//
// ── THE RULES IT KEEPS ──────────────────────────────────────────────────────
//   * NO SUBMIT ON LOAD, RENDER OR TIMER. The only request on mount is the free
//     Cribl Lake dataset listing (a config-plane GET, no search), which decides
//     whether the Parquet copy is offered. Every search starts from a confirmed
//     click on a <ConfirmDialog>.
//   * ONE MINUTE FIRST. No 15-minute control is rendered until a one-minute stage
//     exists for the exact searches and stores selected, and it stays refused —
//     with the reason on screen — until that stage's work was read for every
//     search (`fifteenRefusal`). Its confirmation quotes that measured work,
//     multiplied out, as its cost line.
//   * THE VERDICT IS benchmark.ts's `compare`, which refuses a winner when the
//     stores returned different row counts or tied, and `benchReport` on top of
//     it: a search whose answer is a handful of rows (the count, the per-minute
//     trend) is compared on its VALUES, since its row count matches whatever
//     the stores hold, and the opening-tiles scan never names a winner.
//   * "STOPPED" ONLY ONCE A STAGE HAS ENDED. Mid-run every stage is short of
//     runs; that is progress, not a stop (`stageStopped`).
//   * A REFUSED SUBMIT CLOSES THE GATE. The dialog's <GatedControl> is gone
//     before the first search is sent (the dialog closes as the stage starts),
//     so when Cribl answers the job submit with 401/403 the runner stops the
//     plan and this panel latches 'benchmark.run' itself; both outer triggers
//     then read that gate and say which call was refused.
//   * NOTHING PERSISTS. Results live in this component's state; leaving the page
//     drops them, and unmounting cancels the search in flight.
//   * NOTHING ROUTES. A result here is a measurement on screen. Moving any query
//     to the Parquet copy is the routing table's evidence, a separate step.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Checkbox } from '@capra/core'
import { Panel } from './Panel'
import { PanelInfo } from './PanelInfo'
import { InfoTip } from './InfoTip'
import { ConfirmDialog, type ConfirmResource } from './ConfirmDialog'
import { GateNote, GatedControl } from './GatedControl'
import {
  FIFTEEN_RUNS_PER_PAIR,
  benchReport,
  benchTargets,
  cpuWords,
  fifteenCostLine,
  fifteenRefusal,
  oneMinuteCostLine,
  parquetState,
  planFor,
  probeDisagreement,
  projectFifteen,
  queryById,
  selectionKey,
  stageStopped,
  stageWindow,
  stageWorkWords,
  type BenchQueryId,
  type BenchRun,
  type PlannedBenchRun,
  type Stage,
  type StageRecord,
} from '../cribl/benchmarkPlan'
import { BENCH_PARQUET_DATASET, BENCH_QUERIES, onParquet } from '../queries/benchmark'
import { STORE_WORDS, type BenchTarget } from '../cribl/benchmark'
import { runPlan } from '../cribl/benchmarkRun'
import { listDatasets, type LakeDataset, type ReadResult } from '../cribl/lake'
import { useDatasetTarget } from '../cribl/datasetTarget'
import { denialMark, latchDenial, useWriteGate } from '../cribl/authz'
import { fmtMs } from '../lib/format'
import {
  BENCH_LEAD,
  BENCH_LEAD_TIP,
  BENCH_TITLE,
  CHECKING_STORES,
  COLUMN_TIPS,
  CONSEQUENCES,
  FIFTEEN_HEADING,
  FIFTEEN_LABEL,
  NOT_REPORTED,
  NO_SEARCH,
  ONE_HEADING,
  PARQUET_QUERY_ABOUT,
  ONE_LABEL,
  ONE_STAGE_TIP,
  PARQUET_CHOICE,
  RESULTS_KEPT_TIP,
  RUNNING_VERDICT,
  SEARCHES_LEGEND,
  SEARCHES_TIP,
  STOPPED_NOTE,
  STOPPED_VERDICT,
  STOP_LABEL,
  STORE_LINE,
  WINDOW_TIP,
  disagreeWords,
  valuesDisagreeWords,
  fifteenTitle,
  oneTitle,
  progressWords,
  windowWords,
} from './benchmarkCopy'

interface Progress {
  stage: Stage
  done: number
  total: number
  next: PlannedBenchRun | null
}

const DEFAULT_QUERIES: readonly BenchQueryId[] = BENCH_QUERIES.filter((q) => q.defaultOn).map((q) => q.id)

const datasetOf = (targets: readonly BenchTarget[], id: string) => targets.find((t) => t.id === id)?.dataset ?? id

const cpuCell = (cpu: number | null) => (cpu === null ? NOT_REPORTED : cpuWords(cpu))
const msCell = (ms: number | null) => (ms === null ? '—' : fmtMs(ms))
const rowsCell = (rows: number | null) => (rows === null ? '—' : rows.toLocaleString('en-US'))

export function BenchmarkPanel() {
  const target = useDatasetTarget()
  const sampleOnly = target.known && target.sample

  const [listing, setListing] = useState<ReadResult<LakeDataset[]> | null>(null)
  const [reading, setReading] = useState(true)
  const [chosen, setChosen] = useState<readonly BenchQueryId[]>(DEFAULT_QUERIES)
  const [includeParquet, setIncludeParquet] = useState(true)
  const [dialog, setDialog] = useState<Stage | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [probe, setProbe] = useState<StageRecord | null>(null)
  const [bench, setBench] = useState<StageRecord | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const readReq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const oneReasonId = useId()
  const fifteenReasonId = useId()
  const refusalId = useId()
  // The refusal of a job submit, latched by this panel (see the header). Both
  // outer triggers read it, so nobody is walked into a confirmation whose
  // searches Cribl has just refused.
  const gate = useWriteGate('benchmark.run')

  // The one request on mount: the Lake listing, which bills nothing and starts
  // no search. Refresh reads it again; nothing reads it on a timer.
  const readListing = useCallback(async () => {
    const id = ++readReq.current
    setReading(true)
    const r = await listDatasets({ background: true })
    if (id !== readReq.current) return
    setListing(r)
    setReading(false)
  }, [])

  useEffect(() => {
    void readListing()
    // The ref objects themselves, not their values: the controller that has to
    // be aborted is whichever one is running when the page is left, which is
    // exactly what `.current` holds at that moment.
    const reads = readReq
    const aborts = abortRef
    return () => {
      reads.current++
      // Leaving the page stops the benchmark, and runSearch cancels the job in
      // flight on the server.
      aborts.current?.abort()
    }
  }, [readListing])

  const pq = parquetState(listing)
  const parquetOffered = pq === 'holds-data' && !sampleOnly
  const targets = useMemo(
    () => benchTargets(listing, { sampleOnly, includeParquet }),
    [listing, sampleOnly, includeParquet],
  )
  const liveTargets = targets.filter((t) => t.available)
  const key = selectionKey(chosen, targets)
  const running = progress !== null

  const oneReason =
    liveTargets.length === 0
      ? (targets[0].absentNote ?? 'No store can be measured.')
      : chosen.length === 0
        ? NO_SEARCH
        : null
  const fifteenReason = oneReason ?? fifteenRefusal(probe, key)
  // The 15-minute control exists only once a one-minute stage exists for THIS
  // selection. Before that there is nothing on screen to judge it against.
  const offerFifteen = probe !== null && probe.key === key

  /** An outer trigger's aria wiring: its own reason, and the gate's refusal. */
  const describe = (reason: string | null, reasonId: string) => {
    const ids = [gate.denied ? refusalId : null, reason ? reasonId : null].filter((x): x is string => x !== null)
    return {
      'aria-disabled': ids.length > 0 ? true : undefined,
      'aria-describedby': ids.length > 0 ? ids.join(' ') : undefined,
    } as const
  }
  const blocked = (reason: string | null) => reason !== null || gate.denied !== null

  const toggle = (id: BenchQueryId, on: boolean) =>
    setChosen((was) => BENCH_QUERIES.map((q) => q.id).filter((x) => (x === id ? on : was.includes(x))))

  /** Start a confirmed stage. Called from the dialog's confirm, and only there. */
  const start = async (stage: Stage) => {
    // Re-checked at the click: the dialog stated a plan, and a plan the page no
    // longer holds is not the one somebody said yes to.
    if (stage === 'fifteen' && fifteenRefusal(probe, key) !== null) {
      setDialog(null)
      return
    }
    const plan = planFor(stage, chosen, targets)
    if (plan.length === 0) {
      setDialog(null)
      return
    }
    const window = stageWindow(stage, Date.now())
    const ctl = new AbortController()
    abortRef.current = ctl
    const record: StageRecord = { stage, key, window, queryIds: [...chosen], targets, runs: [], planned: plan.length, ended: false }
    const runs: BenchRun[] = []
    const publish = (ended = false) => {
      const next = { ...record, runs: [...runs], ended }
      if (stage === 'one') setProbe(next)
      else setBench(next)
    }
    setDialog(null)
    setFailure(null)
    // A new one-minute stage replaces the old one, and with it any 15-minute
    // result that was judged against it.
    if (stage === 'one') setBench(null)
    publish()
    setProgress({ stage, done: 0, total: plan.length, next: plan[0] })
    try {
      await runPlan(
        plan,
        window,
        (run, done) => {
          runs.push(run)
          publish()
          setProgress((p) => (p ? { ...p, done } : p))
          // Cribl refused the submit itself. The runner stops the plan here;
          // the gate is latched so both triggers say which call was refused.
          if (run.refused) {
            latchDenial('benchmark.run', { ...run.refused, seq: denialMark(), origin: 'click' })
          }
        },
        (next, index) => setProgress((p) => (p ? { ...p, done: index, next } : p)),
        ctl.signal,
      )
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The benchmark stopped on an error.')
    } finally {
      if (abortRef.current === ctl) abortRef.current = null
      publish(true)
      setProgress(null)
    }
  }

  const stop = () => abortRef.current?.abort()

  return (
    <Panel title={BENCH_TITLE} onRefresh={() => { void readListing() }} refreshing={reading}>
      <p className="gs-intro">
        {BENCH_LEAD}
        <InfoTip text={BENCH_LEAD_TIP} />
      </p>

      <fieldset className="bm-choices" disabled={running}>
        <legend className="bm-legend">
          {SEARCHES_LEGEND}
          <InfoTip text={SEARCHES_TIP} />
        </legend>
        {/* Each search's ⓘ is the exact text it submits — on the JSON dataset,
            and, where the Parquet copy is offered, on that too. */}
        {BENCH_QUERIES.map((q) => (
          <span key={q.id} className="bm-choice">
            <Checkbox checked={chosen.includes(q.id)} disabled={running} onChange={(e) => toggle(q.id, e.target.checked)}>
              {q.label}
            </Checkbox>
            <PanelInfo label={`${q.label}: what it measures, and its query`} about={q.why} query={q.query} />
            {parquetOffered && (
              <PanelInfo
                label={`${q.label}: the query it runs on ${BENCH_PARQUET_DATASET}`}
                about={PARQUET_QUERY_ABOUT}
                query={onParquet(q.query)}
              />
            )}
          </span>
        ))}
      </fieldset>

      {/* The store choice exists only where there is a choice: the Parquet copy
          is offered when the Lake listing shows it exists and holds data. */}
      {reading && listing === null ? (
        <p className="gs-action-note">{CHECKING_STORES}</p>
      ) : parquetOffered ? (
        <span className="bm-choice">
          <Checkbox checked={includeParquet} disabled={running} onChange={(e) => setIncludeParquet(e.target.checked)}>
            {PARQUET_CHOICE}
          </Checkbox>
        </span>
      ) : (
        <p className="gs-action-note">
          {STORE_LINE}
          <InfoTip text={sampleOnly ? (targets[0].absentNote ?? '') : (targets[1].absentNote ?? '')} />
        </p>
      )}

      <div className="sl-actions">
        {running ? (
          <button type="button" className="btn" onClick={stop}>
            {STOP_LABEL}
          </button>
        ) : (
          <>
            <span className="gate">
              <button
                type="button"
                className="btn btn-primary"
                {...describe(oneReason, oneReasonId)}
                onClick={() => { if (!blocked(oneReason)) setDialog('one') }}
              >
                {ONE_LABEL}
              </button>
              {oneReason && <span id={oneReasonId}>{oneReason}</span>}
            </span>
            {offerFifteen && (
              <span className="gate">
                <button
                  type="button"
                  className="btn"
                  {...describe(fifteenReason, fifteenReasonId)}
                  onClick={() => { if (!blocked(fifteenReason)) setDialog('fifteen') }}
                >
                  {FIFTEEN_LABEL}
                </button>
                {fifteenReason && <span id={fifteenReasonId}>{fifteenReason}</span>}
              </span>
            )}
            <GateNote write="benchmark.run" textId={refusalId} />
          </>
        )}
        <span className="sl-actions-note">
          Nothing is stored.
          <InfoTip text={RESULTS_KEPT_TIP} />
        </span>
      </div>

      {progress && (
        <p className="gs-action-note" role="status">
          {progress.next
            ? progressWords(
                progress.done,
                progress.total,
                queryById(progress.next.queryId).label,
                progress.next.target.dataset,
                progress.next.warmup,
              )
            : `Finishing ${progress.total} of ${progress.total}…`}
        </p>
      )}
      {failure && <p className="sl-note sl-note-warn" role="status">{failure}</p>}

      {probe && <ProbeTable probe={probe} />}
      {bench && <BenchTable bench={bench} />}

      {dialog === 'one' && (
        <ConfirmDialog
          isOpen
          title={oneTitle(planFor('one', chosen, targets).length)}
          resources={resourcesFor(planFor('one', chosen, targets), 'one', null)}
          costLine={oneMinuteCostLine(planFor('one', chosen, targets).length)}
          consequences={[CONSEQUENCES.sequential, CONSEQUENCES.writesNothing, CONSEQUENCES.stoppable]}
          onCancel={() => setDialog(null)}
          confirm={
            <GatedControl
              write="benchmark.run"
              label={`Run ${planFor('one', chosen, targets).length} searches`}
              busyLabel="Starting…"
              unavailable={oneReason}
              run={async () => { void start('one') }}
            />
          }
        />
      )}
      {dialog === 'fifteen' && probe && (
        <ConfirmDialog
          isOpen
          title={fifteenTitle(planFor('fifteen', chosen, targets).length)}
          resources={resourcesFor(planFor('fifteen', chosen, targets), 'fifteen', probe)}
          costLine={fifteenReason === null ? fifteenCostLine(probe) : fifteenReason}
          consequences={[CONSEQUENCES.sequential, CONSEQUENCES.warmup, CONSEQUENCES.writesNothing, CONSEQUENCES.stoppable]}
          onCancel={() => setDialog(null)}
          confirm={
            <GatedControl
              write="benchmark.run"
              label={`Run ${planFor('fifteen', chosen, targets).length} searches`}
              busyLabel="Starting…"
              unavailable={fifteenReason}
              run={async () => { void start('fifteen') }}
            />
          }
        />
      )}
    </Panel>
  )
}

/**
 * One row per search and store — not per run: a dialog listing sixty identical
 * jobs is a dialog nobody reads. The detail says how many runs and, for the
 * 15-minute stage, what the one-minute stage measured for that pair.
 */
function resourcesFor(plan: readonly PlannedBenchRun[], stage: Stage, probe: StageRecord | null): ConfirmResource[] {
  const seen = new Set<string>()
  const projection = probe ? projectFifteen(probe) : null
  const out: ConfirmResource[] = []
  for (const p of plan) {
    const k = `${p.queryId}|${p.target.id}`
    if (seen.has(k)) continue
    seen.add(k)
    const pair = projection?.pairs.find((x) => x.queryId === p.queryId && x.targetId === p.target.id)
    out.push({
      action: 'create',
      kind: 'Search job',
      id: `${queryById(p.queryId).label} — ${p.target.dataset}`,
      detail:
        stage === 'one'
          ? 'one run over one minute, reuse off'
          : `${FIFTEEN_RUNS_PER_PAIR} runs over 15 minutes, the first a discarded warm-up${
              pair ? `; one minute measured ${cpuWords(pair.measured)}, so about ${cpuWords(pair.projected)} for these runs` : ''
            }`,
    })
  }
  return out
}

function ColumnHead({ label, tip, num = true }: { label: string; tip: string; num?: boolean }) {
  return (
    <th scope="col" className={num ? 'dtable-num' : undefined}>
      {label}
      <InfoTip text={tip} />
    </th>
  )
}

function ProbeTable({ probe }: { probe: StageRecord }) {
  const stopped = stageStopped(probe)
  const disagree = probe.queryIds.flatMap((id) => {
    const how = probeDisagreement(probe, id)
    return how ? [{ id, how }] : []
  })
  return (
    <section className="bm-stage" aria-label={ONE_HEADING}>
      <h4 className="bm-h">
        {ONE_HEADING}
        <InfoTip text={ONE_STAGE_TIP} />
        <span className="bm-window">
          {windowWords(probe.window)}
          <InfoTip text={WINDOW_TIP} />
        </span>
      </h4>
      <div className="gs-tablewrap">
        <table className="dtable">
          <caption className="sr-only">Each search of the one-minute stage: rows, work, server time and client wall time</caption>
          <thead>
            <tr>
              <th scope="col">Search</th>
              <th scope="col">Store</th>
              <ColumnHead label="Rows" tip={COLUMN_TIPS.rows} />
              <ColumnHead label="Work" tip={COLUMN_TIPS.work} />
              <ColumnHead label="Server time" tip={COLUMN_TIPS.server} />
              <ColumnHead label="Client wall" tip={COLUMN_TIPS.client} />
            </tr>
          </thead>
          <tbody>
            {probe.runs.map((r) => (
              <tr key={`${r.queryId}|${r.targetId}`}>
                <th scope="row" className="dtable-id">{queryById(r.queryId).label}</th>
                <td>{datasetOf(probe.targets, r.targetId)}</td>
                {r.error ? (
                  <td colSpan={4} className="bm-error">{r.error}</td>
                ) : (
                  <>
                    <td className="dtable-num">{rowsCell(r.rows)}</td>
                    <td className="dtable-num">{cpuCell(r.cpuSeconds)}</td>
                    <td className="dtable-num">{msCell(r.serverMs)}</td>
                    <td className="dtable-num">{msCell(r.clientMs)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="gs-action-note">{stageWorkWords(probe.runs)}</p>
      {disagree.map(({ id, how }) => (
        <p key={id} className="sl-note sl-note-warn">
          {how === 'rows' ? disagreeWords(queryById(id).label) : valuesDisagreeWords(queryById(id).label)}
        </p>
      ))}
      {stopped && <p className="sl-note sl-note-warn">{STOPPED_NOTE}</p>}
    </section>
  )
}

function BenchTable({ bench }: { bench: StageRecord }) {
  const stopped = stageStopped(bench)
  const running = !bench.ended
  const reports = benchReport(bench)
  return (
    <section className="bm-stage" aria-label={FIFTEEN_HEADING}>
      <h4 className="bm-h">
        {FIFTEEN_HEADING}
        <span className="bm-window">
          {windowWords(bench.window)}
          <InfoTip text={WINDOW_TIP} />
        </span>
      </h4>
      <div className="gs-tablewrap">
        <table className="dtable">
          <caption className="sr-only">
            Each search of the 15-minute benchmark, per store: medians of the measured runs, and the verdict or why there is none
          </caption>
          <thead>
            <tr>
              <th scope="col">Search</th>
              <th scope="col">Store</th>
              <ColumnHead label="Rows" tip={COLUMN_TIPS.rows} />
              <ColumnHead label="Server time" tip={COLUMN_TIPS.server} />
              <ColumnHead label="Client wall" tip={COLUMN_TIPS.client} />
              <ColumnHead label="Overhead" tip={COLUMN_TIPS.overhead} />
              <ColumnHead label="Work" tip={COLUMN_TIPS.work} />
              <ColumnHead label="Runs" tip={COLUMN_TIPS.runs} />
            </tr>
          </thead>
          {reports.map((rep) => (
            <tbody key={rep.query.id}>
              {rep.comparison.summaries.map((s) => {
                return (
                  <tr key={s.target.id}>
                    <th scope="row" className="dtable-id">{rep.query.label}</th>
                    <td>{STORE_WORDS[s.target.kind]}</td>
                    <td className="dtable-num">{rowsCell(s.rows)}</td>
                    <td className="dtable-num">{msCell(s.serverMs)}</td>
                    <td className="dtable-num">{msCell(s.clientMs)}</td>
                    <td className="dtable-num">{msCell(s.overheadMs)}</td>
                    <td className="dtable-num">{cpuCell(s.cpuSeconds)}</td>
                    <td className="dtable-num">{`${s.ran - s.failed} of ${s.ran}`}</td>
                  </tr>
                )
              })}
              <tr>
                <td colSpan={8} className={rep.decided && !stopped && !running ? 'bm-verdict' : 'bm-verdict bm-verdict-none'}>
                  {running
                    ? RUNNING_VERDICT
                    : stopped
                      ? STOPPED_VERDICT
                      : rep.decided
                        ? `Verdict: ${rep.verdict}`
                        : `No verdict: ${rep.verdict}`}
                </td>
              </tr>
            </tbody>
          ))}
        </table>
      </div>
      {bench.runs.some((r) => r.error) && (
        <ul className="bm-errors">
          {bench.runs
            .filter((r) => r.error)
            .map((r, i) => (
              <li key={i} className="bm-error">
                {queryById(r.queryId).label} on {datasetOf(bench.targets, r.targetId)}
                {r.warmup ? ' (warm-up)' : ''}: {r.error}
              </li>
            ))}
        </ul>
      )}
    </section>
  )
}
