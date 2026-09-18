// ─────────────────────────────────────────────────────────────────────────────
// ONE TAB, TWO WINDOWS — the behaviour change Phase 2 made here, stated where
// anybody editing this file will read it.
//
// The "In feed" field list used to be a 5,000-row sample of whatever the global
// range picker was set to: 754.9 billable CPU-s every time somebody opened the
// tab. It now reads the result of an hourly scheduled run over a settled
// two-minute window, so THE FIELD LIST NO LONGER FOLLOWS THE PICKER while the
// AMI coverage counts on the other two views still do.
//
// That is a real behaviour change and the tab is required to say so out loud, in
// three places, because a reader who changes the range and sees nothing move
// will reasonably conclude the app is broken:
//
//   * the panel's note carries the time the sample was taken;
//   * the panel's ⓘ (block 4) says it is hourly, says over what window, and says
//     how to get a live one;
//   * the controls carry "Run live", which puts the list back on the picker's
//     window for this visit, and a line saying which control the range applies to.
//
// The picker is deliberately NOT disabled: it still governs the coverage counts,
// which are the other two views of this same tab.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { capSecondsFor, runFieldSummaries, runSearch, SearchTimeLimitError, type FieldSummary } from '../cribl/search'
import { useCostSlot } from '../cribl/jobCost'
import { accelEntry, type AccelId } from '../cribl/accel/manifest'
import { readAccelFieldSummaries, type AccelOutcome, type AccelSource } from '../cribl/accel/read'
import { useSelectedSnapshot } from '../cribl/accel/selection'
import { useAccelEnabled } from '../cribl/useSearch'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { type ComputedFrom } from '../components/PanelInfo'
import { QueryBoundary } from '../components/QueryBoundary'
import { StatusPill } from '../components/StatusPill'
import { fmtCount } from '../lib/format'
import { AMI_CATALOG, AMI_FAMILIES, AMI_USE_CASES, type AmiField } from '../data/amiFields'
import { CHECK_FIELDS, familyOf, FEED_SAMPLE_QUERY, PRESENCE_QUERY, sectionQuery } from '../queries/fieldExplorer'

const CATALOG_BY_NAME = new Map(AMI_CATALOG.map((f) => [f.name, f]))

const FAMILY_ORDER = ['Core / 5-tuple', 'DNS', 'SNMP', 'SSL / TLS', 'HTTP', 'TCP / UDP', 'AWS enrichment', 'Other protocols']

/** The scheduled search that serves the "In feed" list. */
const SAMPLE_ACCEL: AccelId = 'gno_sample_2m_c1h'
/** Its window and cadence, read from the manifest rather than restated: the live
 *  fallback has to sample the same two minutes the schedule does, or the panel
 *  means one thing on a workspace that has applied acceleration and another on
 *  one that has not. */
const SAMPLE_ENTRY = accelEntry(SAMPLE_ACCEL)
/** The schedule in words, for the panel's ⓘ. FieldExplorer.test.tsx holds this
 *  against the manifest's own cron, so changing one forces the other. */
export const SAMPLE_CADENCE = 'once an hour, at 7 minutes past, in UTC'
/** …and its window in words. Two minutes that have finished landing: the current
 *  minute is still arriving, and sampling it under-reports which fields exist. */
export const SAMPLE_WINDOW = 'a settled two-minute window'

/** The error heading for a search stopped by its time limit; null for any other failure. */
const stoppedTitle = (e: unknown) => (e instanceof SearchTimeLimitError ? 'Search stopped' : null)

/** The "In feed" panel's own state: the summaries, plus where they came from. */
interface FeedState {
  loading: boolean
  error: string | null
  errorTitle: string | null
  fields: FieldSummary[]
  sampled: number
  /** Which read answered — a stored scheduled run, or a live one. */
  source: AccelSource
  /** Why it ended up there. Null only before the first read finishes; this
   *  panel always names a schedule, so "never had one" cannot apply to it. */
  outcome: AccelOutcome | null
  /** When a past moment was picked and no run of this entry exists at or before
   *  it: the nearest run this entry does have, for the caption to offer. */
  nearestAt: number | null
  /** Epoch ms the sample was taken. Never null once a read has finished: a
   *  stored run carries its own time, and a live run was taken just now. */
  at: number | null
  /** The stored run is older than its schedule promises. */
  stale: boolean
  /** accel/read.ts's sentence about why a live query ran. Never Cribl's words. */
  note: string | null
}

/**
 * The caption above the field list: when this sample was taken, and how many
 * rows it holds.
 *
 * A LIST WITHOUT A TIME ON IT IS THE FAILURE MODE. Every other panel in this app
 * answers for the window in the picker, so a reader has no reason to suspect
 * this one does not — and a schedule that silently stopped firing leaves a
 * perfectly plausible field list on screen indefinitely. The time is what makes
 * that visible without anybody having to know the feature exists.
 */
export function sampleNote(
  s: { source: AccelSource; at: number | null; stale: boolean; sampled: number },
  picker: { following: boolean; label: string },
): string {
  const rows = s.sampled > 0 ? ` (${s.sampled.toLocaleString()} rows)` : ''
  // Nothing has answered yet. Not "taken just now": on first paint that would be
  // a claim about a sample that does not exist.
  if (s.at === null) return 'sampling…'
  if (s.source === 'schedule') {
    // WHICH sample, not WHEN it was taken. The panel header now carries a
    // `snapshotNote` caption of its own — `snapshot 08:20 · 42m ago`, and
    // `· schedule overdue` when it is late — because this panel is registered in
    // the header's census like every other. Repeating the clock six words later
    // is the same fact twice in the smallest type on the screen, and the two
    // would drift the first time one of them was edited.
    //
    // The rule the doc comment above states is unchanged and still met: the time
    // is on screen, in the one place that computes it for every panel in the app.
    return `hourly sample${rows}`
  }
  if (picker.following) return `live sample · ${picker.label.toLowerCase()}${rows}`
  return `sample taken just now${rows}`
}

/**
 * Block 4 of the panel's ⓘ. `fallback` is only passed when a live run happened
 * INSTEAD of the stored one — when the reader asked for live, the reason is that
 * they asked.
 */
export function feedComputed(
  s: Pick<FeedState, 'source' | 'at' | 'stale' | 'note'>,
  picker: { following: boolean; earliest: string; label: string },
): ComputedFrom {
  return {
    source: s.source,
    at: s.at,
    stale: s.stale,
    cadence: SAMPLE_CADENCE,
    window: picker.following ? picker.label.toLowerCase() : SAMPLE_WINDOW,
    fallback: s.source === 'live' && !picker.following ? s.note : null,
    live: 'press “Run live” above — it re-runs the sample over the time range on screen',
    capSeconds: capSecondsFor(picker.following ? picker.earliest : SAMPLE_ENTRY.earliest),
  }
}

type Status = 'present' | 'derived' | 'missing'
function statusOf(f: AmiField, count: Record<string, number>): Status {
  if ((count[f.name] ?? 0) > 0) return 'present'
  if (f.derivedField && (count[f.derivedField] ?? 0) > 0) return 'derived'
  return 'missing'
}

export function FieldExplorer() {
  const { range, refreshNonce, manualRefreshNonce } = useDashboard()
  const [state, setState] = useState<FeedState>({
    loading: true, error: null, errorTitle: null, fields: [], sampled: 0,
    source: 'live', outcome: null, at: null, stale: false, note: null, nearestAt: null,
  })
  const [presence, setPresence] = useState<{ loading: boolean; error: string | null; errorTitle: string | null; count: Record<string, number> }>({
    loading: true, error: null, errorTitle: null, count: {},
  })
  // View is URL-driven (?view=coverage|usecase|feed) so the guided tour — and
  // any shared link — can land directly on a specific view.
  const [params, setParams] = useSearchParams()
  const viewParam = params.get('view')
  const view: 'coverage' | 'usecase' | 'feed' =
    viewParam === 'usecase' || viewParam === 'feed' ? viewParam : 'coverage'
  const setView = (v: 'coverage' | 'usecase' | 'feed') => {
    const next = new URLSearchParams(params)
    if (v === 'coverage') next.delete('view')
    else next.set('view', v)
    setParams(next, { replace: true })
  }
  const [family, setFamily] = useState<string>('All')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // Local nonce for per-panel refresh (this tab uses runSearch directly, not useSearch).
  const [nonce, setNonce] = useState(0)
  const refresh = () => setNonce((n) => n + 1)
  // "Run live" for this visit: the field list goes back to the picker's window
  // and costs a full scan of it again. Session-only on purpose — this is a thing
  // to check a number with, not a setting to leave on. The install-wide switch
  // is the schedule itself, in Guided Setup.
  const [liveOnly, setLiveOnly] = useState(false)
  const accelOn = useAccelEnabled() && !liveOnly
  // WHICH PAST STATE THIS SAMPLE IS ANSWERING FOR. The header's snapshot picker
  // says it chooses "which stored run every panel reads", and until this was
  // threaded through, this panel was the exception that made the sentence false:
  // it kept showing the newest sample under a header naming 04:20.
  //
  // accel/read.ts answers a moment BEFORE it consults the off switch, so this
  // deliberately overrides `accelOn` — there is no live answer to a question
  // about 04:20, and the "Run live" chip is hidden while one is picked for the
  // same reason <Panel> hides its own.
  const moment = useSelectedSnapshot()
  // This panel's row in the header's census. It is a <Panel> like any other, but
  // it builds its state from readAccelFieldSummaries rather than from useSearch,
  // so the `snapshot` prop is assembled by hand here. Without it the In-feed
  // panel was in the census's DENOMINATOR — <Panel> registers unconditionally —
  // and never in its numerator, so the header read `0 of 2` on a tab where one
  // of the two is served from an hourly schedule. Wrong, rather than incomplete.
  const feedSnapshot = {
    source: state.source,
    outcome: state.outcome,
    at: state.at,
    stale: state.stale,
    nearestAt: state.nearestAt,
  }
  // Only the presence counts follow the global range and the auto-refresh tick
  // now, so only they are part of what a tick costs. An accelerated sample
  // re-reads its stored result on an explicit refresh and on nothing else.
  const summariesCost = useCostSlot(!accelOn)
  const presenceCost = useCostSlot(true)
  // What re-runs the sample, as two named values rather than expressions in the
  // dependency array — a `$vt_results` read ignores the picker, so an
  // accelerated sample carries no window in its key and re-runs on an explicit
  // refresh only. Both go back to following the page the moment it runs live.
  const sampleWindowKey = accelOn ? '' : range.earliest
  const sampleRefreshKey = accelOn ? manualRefreshNonce : refreshNonce

  // Field-summaries (fill / cardinality / top values) for the "In feed" browser.
  // Served by the hourly scheduled run where there is one; the live fallback
  // reads the SAME two settled minutes the schedule does, so acceleration
  // changes when the sample was taken and never what it means. The one exception
  // is "Run live", which is the reader asking for the picker's window back.
  useEffect(() => {
    const ctrl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null, errorTitle: null }))
    readAccelFieldSummaries(SAMPLE_ACCEL, {
      enabled: accelOn,
      asOf: moment ?? undefined,
      signal: ctrl.signal,
      live: () => runFieldSummaries(FEED_SAMPLE_QUERY, {
        earliest: accelOn ? SAMPLE_ENTRY.earliest : range.earliest,
        latest: accelOn ? SAMPLE_ENTRY.latest : 'now',
        signal: ctrl.signal,
        costSlot: summariesCost
      }),
    })
      .then((r) => setState({
        loading: false, error: null, errorTitle: null,
        fields: r.data.fields, sampled: r.data.sampled,
        // A live run was sampled now; a stored one carries the time its run
        // finished. A read for a moment nothing was stored for carries NEITHER,
        // and must stay null: `Date.now()` there would caption an empty list
        // "sample taken just now", which is the one reading that is false.
        source: r.source, outcome: r.outcome, at: r.at ?? (r.source === 'live' ? Date.now() : null),
        stale: r.stale, note: r.note, nearestAt: r.nearestAt,
      }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setState((s) => ({ ...s, loading: false, error: (e as Error).message, errorTitle: stoppedTitle(e) }))
      })
    return () => ctrl.abort()
    // `range.earliest` is read inside the effect and deliberately absent from
    // the key: while the sample is accelerated the picker cannot change what
    // comes back, so re-running on a range change would submit a job to receive
    // the identical stored rows. `sampleWindowKey` is what puts it back in the
    // key the moment the reader asks for live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accelOn, moment, sampleWindowKey, sampleRefreshKey, nonce, summariesCost])

  // Whole-window presence counts for the AMI coverage view (accurate for rare fields).
  useEffect(() => {
    const ctrl = new AbortController()
    setPresence((s) => ({ ...s, loading: true, error: null, errorTitle: null }))
    runSearch(PRESENCE_QUERY, { earliest: range.earliest, signal: ctrl.signal, costSlot: presenceCost })
      .then((res) => {
        const row = (res.rows[0] ?? {}) as Record<string, unknown>
        const count: Record<string, number> = {}
        CHECK_FIELDS.forEach((n, i) => { count[n] = Number(row[`c${i}`]) || 0 })
        setPresence({ loading: false, error: null, errorTitle: null, count })
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setPresence((s) => ({ ...s, loading: false, error: (e as Error).message, errorTitle: stoppedTitle(e) }))
      })
    return () => ctrl.abort()
  }, [range.earliest, refreshNonce, nonce, presenceCost])

  // ---- Coverage view: catalog vs feed ----
  const coverage = useMemo(() => {
    const rows = AMI_CATALOG.map((f) => ({ f, status: statusOf(f, presence.count) }))
    const present = rows.filter((r) => r.status === 'present').length
    const derived = rows.filter((r) => r.status === 'derived').length
    const missing = rows.filter((r) => r.status === 'missing').length
    return { rows, present, derived, missing }
  }, [presence.count])

  // ---- Feed view: actual fields ----
  const families = useMemo(() => {
    const set = new Set(state.fields.map((f) => familyOf(f.name)))
    return FAMILY_ORDER.filter((f) => set.has(f))
  }, [state.fields])
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    return state.fields
      .filter((f) => (family === 'All' || familyOf(f.name) === family) && (!term || f.name.toLowerCase().includes(term)))
      .sort((a, b) => b.count - a.count)
  }, [state.fields, family, search])
  const fillPct = (f: FieldSummary) => (state.sampled ? (f.count / state.sampled) * 100 : 0)

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Field explorer</h2>
        <p className="tab-sub">
          Learn the dataset and its gaps. <strong>AMI coverage</strong> checks a curated catalog of key Gigamon
          AMI attributes against this feed — flagging fields that are <strong className="d-danger">missing</strong>.
          <strong> By use case</strong> shows which analytics use cases the feed can support.{' '}
          <strong>In feed</strong> browses the top fields with fill rate, cardinality, and top values (Cribl's
          field-summaries API caps at 200; the feed carries ~310 distinct fields — the coverage checks above use
          uncapped counts). The time range applies to the coverage counts; <strong>In feed</strong> reads a sample
          taken on a schedule, and says when it was taken.
        </p>
        <div className="pivot-toggle">
          <button type="button" className={`seg ${view === 'coverage' ? 'seg-active' : ''}`} onClick={() => setView('coverage')}>AMI coverage</button>
          <button type="button" className={`seg ${view === 'usecase' ? 'seg-active' : ''}`} onClick={() => setView('usecase')}>By use case</button>
          <button type="button" className={`seg ${view === 'feed' ? 'seg-active' : ''}`} onClick={() => setView('feed')}>In feed</button>
        </div>
      </div>

      {view === 'coverage' ? (
        <QueryBoundary state={{ loading: presence.loading, error: presence.error, errorTitle: presence.errorTitle, rows: CHECK_FIELDS }} emptyLabel="No data in this window">
          <div className="kpi-row kpi-row-3">
            <KpiTile label="Present" value={String(coverage.present)} accent="success"
              sub={`of ${AMI_CATALOG.length} key AMI fields`} info="Documented AMI fields found in this feed by their canonical name." />
            <KpiTile label="Derived" value={String(coverage.derived)} accent="warning"
              sub="raw field absent, computed equivalent" info="The raw AMI field isn't in the feed, but the pipeline derives an equivalent (e.g. http_server_ms from http_request_ts/http_response_ts)." />
            <KpiTile label="Missing" value={String(coverage.missing)} accent="danger"
              sub="not in this feed" info="Documented AMI fields absent from this feed — features that depend on them can't be fully built." />
          </div>

          {AMI_FAMILIES.map((fam) => {
            const rows = coverage.rows.filter((r) => r.f.family === fam)
            if (rows.length === 0) return null
            return (
              <Panel key={fam} title={fam} onRefresh={refresh} refreshing={presence.loading}
                info={`Documented ${fam} AMI fields checked against this feed with count(field) over the whole window (not a sample, so rare fields are caught). Green = present, amber = derived from another field, red = missing.`}
                query={sectionQuery(rows.map((r) => r.f.name))}
                note={`${rows.filter((r) => r.status !== 'missing').length}/${rows.length} available`}>
                <ul className="cov-list">
                  {rows.map(({ f, status }) => (
                    <li key={f.name} className={`cov-row cov-${status}`}>
                      <StatusPill state={status} />
                      <span className="cov-name">{f.name}{f.requiresDecrypt && <span className="cov-lock" title="Requires decrypted traffic"> 🔒</span>}</span>
                      <span className="cov-desc">
                        {f.desc} <span className="cov-use">— {f.useCase}</span>
                        {status === 'derived' && <span className="cov-derived"> · derived as <code>{f.derivedField}</code></span>}
                        {status === 'missing' && <span className="cov-miss"> · not in this feed</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )
          })}

          <p className="cov-src">
            Catalog curated from Gigamon AMI documentation (docs.gigamon.com/ami · Application Metadata Intelligence
            datasheet) and the reference Gigamon NPM dashboard. AMI exports up to ~6,000 attributes; the full per-field
            spec lives in the GigaVUE-FM Application Protobook. 🔒 = requires decrypted traffic.
          </p>
        </QueryBoundary>
      ) : view === 'usecase' ? (
        <QueryBoundary state={{ loading: presence.loading, error: presence.error, errorTitle: presence.errorTitle, rows: CHECK_FIELDS }} emptyLabel="No data in this window">
          <p className="uc-lead">
            Each use case lists the AMI fields it draws on and whether this feed carries them —
            the core analytics first, then supporting cuts.
          </p>
          {AMI_USE_CASES.map((uc) => {
            const rows = uc.fields.map((n) => {
              const f = CATALOG_BY_NAME.get(n)
              const status: Status = f ? statusOf(f, presence.count) : 'missing'
              return { name: n, f, status }
            })
            const avail = rows.filter((r) => r.status !== 'missing').length
            const full = avail === rows.length
            return (
              <Panel key={uc.name} title={uc.name} onRefresh={refresh} refreshing={presence.loading}
                tourId={`uc-${uc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}
                info={`${uc.desc} Field presence is checked with count(field) over the whole window; open the query in Search to see the per-field counts.`}
                query={sectionQuery(uc.fields)}
                note={`${avail}/${rows.length} fields ${full ? '· fully supported' : '· partial'}`}>
                <p className="uc-desc">{uc.desc}</p>
                <div className="uc-bar" title={`${avail} of ${rows.length} fields available`}>
                  {rows.map((r, i) => <span key={i} className={`uc-seg uc-seg-${r.status}`} />)}
                </div>
                <ul className="cov-list">
                  {rows.map((r) => (
                    <li key={r.name} className={`cov-row cov-${r.status}`}>
                      <StatusPill state={r.status} />
                      <span className="cov-name">{r.name}</span>
                      <span className="cov-desc">
                        {r.f?.desc ?? '—'}
                        {r.status === 'derived' && <span className="cov-derived"> · derived as <code>{r.f?.derivedField}</code></span>}
                        {r.status === 'missing' && <span className="cov-miss"> · not in this feed</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )
          })}
        </QueryBoundary>
      ) : (
        <>
          <div className="fe-controls">
            <input className="fe-search" placeholder="Filter fields…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="fe-fams">
              {['All', ...families].map((f) => (
                <button key={f} type="button" className={`chip ${family === f ? 'chip-active' : ''}`} onClick={() => setFamily(f)}>{f}</button>
              ))}
            </div>
            {/* Not a <GatedControl>: this reads, it does not write, and nothing
                about it can be refused — it just costs a scan.

                HIDDEN WHILE A PAST MOMENT IS PICKED, which is the rule <Panel>
                applies to its own version: "sample the range on screen" has
                nothing to mean when the question is what the feed looked like at
                04:20, and accel/read.ts refuses the live path there anyway. A
                control that is present and does nothing is the worse of the two.

                It stays in the controls row rather than moving into <Panel
                onRunLive>: this one re-points the WINDOW as well as the source,
                and the paragraph below is the sentence that explains that. The
                generalised control in <Panel> only switches the source, and its
                one-line caption cannot say this. */}
            {moment === null && (
              <button
                type="button"
                className={`chip ${liveOnly ? 'chip-active' : ''}`}
                aria-pressed={liveOnly}
                onClick={() => setLiveOnly((v) => !v)}
                title={liveOnly ? 'Go back to the hourly sample' : 'Sample the time range on screen instead'}
              >
                {liveOnly ? 'Live · back to hourly sample' : 'Run live'}
              </button>
            )}
          </div>
          <p className="cov-src">
            {liveOnly ? (
              <>
                <strong>Running live.</strong> The field list is sampling {range.label.toLowerCase()} and follows the time
                range above; each run is a full scan of that window. Press <em>Live</em> again to go back to the hourly sample.
              </>
            ) : (
              <>
                The field list is {state.source === 'schedule' ? 'read from an hourly scheduled sample' : 'sampled'} of
                {' '}{SAMPLE_WINDOW}, so <strong>the time range above does not change it</strong> — up there, the range
                applies to the AMI coverage counts. <em>Run live</em> samples the selected range instead.
              </>
            )}
          </p>
          <Panel
            title="Fields"
            snapshot={feedSnapshot}
            liveOnly={liveOnly}
            onRefresh={refresh}
            refreshing={state.loading}
            query={FEED_SAMPLE_QUERY}
            info="The top 200 AMI fields by fill: type, fill rate (% of events carrying it), and distinct-value count. Cribl's field-summaries API returns at most 200 fields, so the ~110 rarest protocol fields (e.g. dcerpc_*, whatsapp_*) aren't listed here — the AMI coverage view uses uncapped count() checks instead. Click a field for its top values."
            infoLabel="What the field list shows, the query behind it, and when it was sampled"
            infoDialogLabel="How the In feed field list was computed"
            computed={feedComputed(state, { following: liveOnly, earliest: range.earliest, label: range.label })}
            note={`${sampleNote(state, { following: liveOnly, label: range.label })} · ${visible.length} of ${state.fields.length} shown · top 200 (field-summaries cap; ~310 in feed)`}>
            <QueryBoundary state={{ loading: state.loading, error: state.error, errorTitle: state.errorTitle, rows: state.fields }} emptyLabel="No fields in this window">
              <ul className="fe-list">
                {visible.map((f) => {
                  const isOpen = open === f.name
                  return (
                    <li key={f.name} className="fe-item">
                      <button type="button" className="fe-row" onClick={() => setOpen(isOpen ? null : f.name)}>
                        <span className="fe-caret">{isOpen ? '▾' : '▸'}</span>
                        <span className="fe-name">{f.name}</span>
                        <span className={`fe-type fe-type-${f.type}`}>{f.type}</span>
                        <span className="fe-fill">
                          <span className="fe-fill-track"><span className="fe-fill-bar" style={{ width: `${fillPct(f)}%` }} /></span>
                          <span className="fe-fill-lbl">{fillPct(f).toFixed(0)}%</span>
                        </span>
                        <span className="fe-distinct">{fmtCount(f.countDistinct)} distinct</span>
                      </button>
                      {isOpen && (
                        <div className="fe-detail">
                          {f.topValues.length === 0 ? (
                            <span className="qb-msg">No sampled values</span>
                          ) : (
                            <ul className="fe-values">
                              {f.topValues.slice(0, 10).map((v, i) => {
                                const max = f.topValues[0]?.count || 1
                                return (
                                  <li key={i} className="fe-val">
                                    <span className="fe-val-name" title={String(v.value)}>{String(v.value) || '(empty)'}</span>
                                    <span className="fe-val-track"><span className="fe-val-bar" style={{ width: `${(v.count / max) * 100}%` }} /></span>
                                    <span className="fe-val-count">{fmtCount(v.count)}</span>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </QueryBoundary>
          </Panel>
        </>
      )}
    </div>
  )
}
