// "Could this workspace hold long-term metrics, and does it?" — one more Panel
// on Guided Setup's single page, below <AccelPanel>.
//
// ── WHAT THIS PANEL IS, AND THE THING IT IS CAREFUL NOT TO SAY ──────────────
// It REPORTS. It writes nothing, creates nothing, and offers no control that
// would. The metrics store is not published by this app yet, and a card that
// implied otherwise would be the same defect the Acceleration-tier row was just
// repaired for: a sentence that is true of the workspace read as a claim about
// this dashboard.
//
// AND IT IS NOT AN ACCELERATION FEATURE. A metrics store would serve long-term
// retention and alerting — Lake retention here is 30 days, and ~13,500 series
// is cheap to keep for a year. It would NOT make these dashboards faster: the
// panels it could serve are already served by scheduled snapshots at 0.2
// billable CPU-seconds, and the expensive queries (every `dcount` tile, top
// talkers by `src_ip`, the subnet-pair heatmap) cannot be expressed as bounded
// metric series at all. `gateWords` carries that distinction and this panel
// prints it rather than re-deriving it.
//
// ── NO POLL, AND THAT IS A DECISION RATHER THAN AN OMISSION ─────────────────
// `getLocalSearch` is TWO requests. At the 60 s the plan proposed, that is
// ~2,880 requests a day per open tab — roughly ten times the job watchdog — to
// answer a question whose answer changes when a human provisions an engine.
// jobWatchdog.ts:139 already prices this kind of read and refuses to call it
// free. So: once on mount, and again only when somebody presses Re-check.
// Nothing here runs on a timer.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pill, Skeleton } from '@capra/core'
import { Panel } from './Panel'
import { StatusPill, type StatusState } from './StatusPill'
import { getLocalSearch } from '../cribl/lake'
import { gateState, gateWords, gateIsReady, servesWords, type MetricsGate } from '../cribl/landing'

const DATASET_ID = 'gigamon_ami'

/**
 * The chip word for each gate state.
 *
 * Every state keeps its WORD and adds a glyph through `<StatusPill>`; colour is
 * never the only signal. These map onto the pill vocabulary that already exists
 * rather than inventing a second one.
 */
const PILL: Readonly<Record<MetricsGate, StatusState>> = Object.freeze({
  ready: 'present',
  // Being built, and nothing has gone wrong — which is what `checking` means
  // here and in TLS Posture. NOT `paused`: nobody paused anything.
  provisioning: 'checking',
  // `absent` and not `failed`: a tenant without local search is the ordinary
  // state, and the repo already learned this lesson once — painting the
  // expected state red opened Guided Setup on five failures before anybody had
  // done anything wrong.
  'not-available': 'absent',
  'no-engine': 'absent',
  // "The app tried to find out and cannot say" — the exact meaning `unreadable`
  // already carries, so it is that word rather than a second one meaning it.
  'engines-unreadable': 'unreadable',
  'no-permission': 'unreadable',
  unreadable: 'unreadable',
  // Something IS there and this app cannot vouch for it. `differs` is the
  // reserved word for that, and it is not `failed`: nothing failed.
  degraded: 'differs',
})

interface State {
  loading: boolean
  gate: MetricsGate | null
  serves: string | null
}

export function MetricsStorePanel() {
  const [state, setState] = useState<State>({ loading: true, gate: null, serves: null })
  /** Guards against a re-entrant Re-check and against setting state after
   *  unmount — the same request-id shape `useSearch` uses. */
  const req = useRef(0)

  const read = useCallback(async () => {
    const id = ++req.current
    setState((s) => ({ ...s, loading: true }))
    const r = await getLocalSearch()
    if (id !== req.current) return
    const v = r.value
    const gate = gateState({
      outcome: r.outcome,
      enabled: v?.enabled ?? false,
      engines: v?.engines ?? null,
      records: v?.records ?? [],
    })
    setState({
      loading: false,
      gate,
      // Only when there is an engine to describe. On every other state this
      // sentence would be describing nothing.
      serves: v && v.records.length > 0 ? servesWords(v.records, DATASET_ID) : null,
    })
  }, [])

  useEffect(() => {
    void read()
    return () => { req.current++ }
  }, [read])

  const { loading, gate, serves } = state

  return (
    <Panel
      title={
        <span className="ms-title">
          Metrics — long-term retention and alerting
          <Pill appearance="highlight" variant="muted">Preview</Pill>
        </span>
      }
      note={gate ? <StatusPill state={PILL[gate]} /> : null}
      onRefresh={() => { void read() }}
      refreshing={loading}
      info="Whether this workspace has a Cribl Search engine that could hold a long-term metrics store. Read once when this page opens and again when you press Refresh — nothing here runs on a timer, and nothing here writes."
    >
      {loading && !gate ? (
        <Skeleton title={{ width: 220 }} paragraph={false} />
      ) : (
        <div className="ms-body">
          <p className="ms-status">{gate ? gateWords(gate) : ''}</p>
          {serves ? <p className="ms-serves">{serves}</p> : null}

          {/* THE BINDING SENTENCE, and it says what is true today rather than
              what the plan expected. There is no Metrics tab: the owner's call
              on 2026-09-22 was a Guided Setup card only, until there is
              something on a tab worth a route. */}
          <p className="ms-footer">
            Nothing publishes metrics yet. This card only reports whether the workspace could hold
            them{gateIsReady(gate ?? 'unreadable') ? ' — and it could' : ''}.
          </p>
        </div>
      )}
    </Panel>
  )
}
