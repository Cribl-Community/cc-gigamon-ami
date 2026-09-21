import { useMemo } from 'react'
import { useSearch } from '../cribl/useSearch'
import { searchUiUrl, criblInvestigateUrl, LAKE_DATASET } from '../cribl/config'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { SnapshotCaption } from '../components/SnapshotCaption'
import { OVERVIEW_CADENCE, OVERVIEW_WINDOW } from '../cribl/accel/words'
import { StatusPill } from '../components/StatusPill'
import { toNum, fmtCount, fmtPct } from '../lib/format'
import { FINDINGS, type Finding, type Severity } from '../data/findings'
import { FINDINGS_QUERY, findingFlowsQuery } from '../queries/findings'

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * Brief for the Copilot investigation. We already know what fired, how often
 * and by which field — handing all of it over means the agent spends its first
 * step investigating rather than rediscovering the finding.
 */
function investigationPrompt(f: Finding & { count: number }, total: number, window: string): string {
  const rate = total > 0 ? `${((f.count / total) * 100).toFixed(2)}% of ${total.toLocaleString()} flows` : 'unknown share of flows'
  return [
    `Investigate a "${f.title}" finding in the Cribl Lake dataset "${LAKE_DATASET}" over the ${window}.`,
    `Detection: ${f.count.toLocaleString()} matching flows (${rate}).`,
    `Evidence field: ${f.field}. Matching filter: dataset="${LAKE_DATASET}" ${f.filter}`,
    `Why it matters: ${f.why}`,
    'This is Gigamon Application Metadata Intelligence (AMI) network-flow metadata — one record per flow, no payload.',
    'Please determine: which src_ip, dst_ip, ssl_server_name and app_name values are involved; whether the activity is concentrated on a few hosts or spread widely; whether it is steady or bursty over the window; and whether this looks expected or genuinely suspicious. Finish with a short recommendation.',
  ].join(' ')
}

export function Findings() {
  const { range } = useDashboard()
  const res = useSearch(FINDINGS_QUERY, { accel: 'gno_overview_c1h', accelPanel: 'findings-counts' })
  const row = res.rows[0]

  const { hits, total, bySev } = useMemo(() => {
    // `total` live, `findings_total` from the hourly snapshot — and the two
    // names are not interchangeable decoration. The shared body cannot call this
    // `total`, because the Capacity tiles reading the same row mean
    // sum(total_bytes) by that name; a body defining it once would hand one of
    // the two panels the other's number, correctly formatted and wrong by ten
    // orders of magnitude. The snapshot's tail projects only `findings_total`,
    // so `total` is not a column this row can even carry. See
    // src/queries/snapshots.ts.
    const total = toNum(row?.total ?? row?.findings_total)
    const hits = FINDINGS
      .map((f, i) => ({ ...f, count: toNum(row?.[`f${i}`]) }))
      .filter((f) => f.count > 0)
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count)
    const bySev = (s: Severity) => hits.filter((h) => h.severity === s).length
    return { hits, total, bySev }
  }, [row])

  const findingsSnapshot = { source: res.source, outcome: res.outcome, at: res.at, stale: res.stale, nearestAt: res.nearestAt }
  const findingsComputed = { ...findingsSnapshot, cadence: OVERVIEW_CADENCE, window: OVERVIEW_WINDOW, fallback: res.note }

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Findings</h2>
        <p className="tab-sub">
          Everything the feed says is wrong right now, ranked by severity — security exposures, wire faults and
          service failures in one pass. Each row names the AMI field that evidences it and drills straight into
          the matching flows in Cribl Search. Findings that match nothing are hidden, so this list is only ever
          things that are actually happening.
        </p>
      </div>

      {/* The dataset-intelligence offer used to sit here, in its own `.intel-note`
          box. It is now one of the page-level banners under the tab bar, so the
          app has one banner treatment and an admin who never opens this tab is
          still offered it. See components/AppBanners.tsx. */}

      <div className="kpi-row-head">
        <SnapshotCaption state={findingsSnapshot} />
      </div>
      <div className="kpi-row kpi-row-4">
        <KpiTile label="Critical" value={res.loading ? '…' : String(bySev('critical'))} accent="danger"
          sub="immediate exposure" info="Findings judged to warrant immediate action — cleartext credentials or possible interception." query={FINDINGS_QUERY} computed={findingsComputed} />
        <KpiTile label="High" value={res.loading ? '…' : String(bySev('high'))} accent="warning"
          sub="investigate today" info="Covert channels, lateral-movement protocols, session theft risk and wire corruption." query={FINDINGS_QUERY} computed={findingsComputed} />
        <KpiTile label="Medium / low" value={res.loading ? '…' : String(bySev('medium') + bySev('low'))} accent="info"
          sub="baseline & monitor" info="Worth baselining — benign in many environments but the signal you need when it changes." query={FINDINGS_QUERY} computed={findingsComputed} />
        <KpiTile label="Flows analysed" value={res.loading ? '…' : fmtCount(total)} accent="neutral"
          sub="in the selected window" info="Total AMI flow records evaluated for every detection on this page." query={FINDINGS_QUERY} computed={findingsComputed} />
      </div>

      <Panel tourId="findings-list" title="Detections" query={FINDINGS_QUERY} onRefresh={res.refetch} refreshing={res.loading}
        snapshot={findingsSnapshot} computed={findingsComputed}
        info="Each detection is one aggregation over the window. Counts are flows matching the condition (for resets, the summed reset count). Severity is a fixed judgement about the class of issue, not a function of volume — a single cleartext-credential flow still matters."
        note={`${hits.length} of ${FINDINGS.length} detections firing`}>
        <QueryBoundary state={res} emptyLabel="No findings in this window">
          <ul className="find-list">
            {hits.map((f) => (
              <li key={f.id} className={`find-row find-${f.severity}`}>
                <StatusPill state={f.severity} />
                <span className="find-main">
                  <span className="find-title">{f.title}</span>
                  <span className="find-why">{f.why}</span>
                  <span className="find-meta">
                    <code>{f.field}</code>
                    <span className="find-cat">{f.category}</span>
                  </span>
                </span>
                <span className="find-right">
                  <span className="find-count">{fmtCount(f.count)}</span>
                  <span className="find-rate">{total > 0 ? `${fmtPct((f.count / total) * 100, 2)} of flows` : ''}</span>
                  <span className="find-actions">
                    <a className="find-ai" href={criblInvestigateUrl(investigationPrompt(f, total, range.label.toLowerCase()))}
                      target="_blank" rel="noopener noreferrer"
                      title="Open Cribl Search Copilot with this finding already briefed">✦ AI investigate</a>
                    <a className="find-open" href={searchUiUrl(findingFlowsQuery(f), range.earliest)}
                      target="_blank" rel="noopener noreferrer" title="Open the matching flows in Cribl Search">Flows ↗</a>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </Panel>
    </div>
  )
}
