import { useSearch, type UseSearchState } from '../cribl/useSearch'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { type PanelSnapshotState } from '../components/snapshotCensus'
import { type ComputedFrom } from '../components/PanelInfo'
import { APP_SRC_CADENCE, APP_SRC_WINDOW } from '../cribl/accel/words'
import { toNum, str, fmtCount, fmtBytes } from '../lib/format'
import { AI_APPS } from '../data/aiApps'
import { SAAS_APPS } from '../data/saasApps'
import { appsQuery, aiOverallQuery, aiUsersQuery } from '../queries/shadowAi'

// Both lists arrive as arrays and become Sets here. They are arrays in
// `src/data/` because the query freeze digests `JSON.stringify(value)`, and
// every Set stringifies to `"{}"` — so a Set there would freeze to a constant
// and stop catching edits. The Set is what the filter wants; this is where it
// belongs.
const SAAS_SET = new Set(SAAS_APPS)
const AI_SET = new Set(AI_APPS)

/**
 * Where this figure came from, for the ⓘ's fourth block.
 *
 * All three hooks on this tab are served by one scheduled scan, so all three
 * quote the same cadence and window — and none of them may render a number from
 * a stored run without rendering the time that run finished. `fallback` carries
 * accel/read.ts's own sentence for the visit where the schedule could not
 * answer; it is never built from an API response.
 */
const computedFrom = (s: UseSearchState): ComputedFrom => ({
  source: s.source,
  at: s.at,
  stale: s.stale,
  cadence: APP_SRC_CADENCE,
  window: APP_SRC_WINDOW,
  fallback: s.note,
})

/** The same read, as the caption a `<Panel>` puts in its header. */
const snapshotOf = (s: UseSearchState): PanelSnapshotState => ({
  source: s.source,
  outcome: s.outcome,
  at: s.at,
  stale: s.stale,
  nearestAt: s.nearestAt,
})

export function ShadowAi() {
  // THE WHOLE TAB FROM ONE SCAN. These were three unfiltered whole-window
  // queries fired on mount, none of them served, which made this the slowest tab
  // in the app — and most of the wait was not any one query but the ~1.6 s the
  // platform leaves between admitting concurrent jobs from one account.
  //
  // `gno_app_src_c1h` groups by (app_name, src_ip) and each panel re-aggregates
  // the columns it needs out of the stored pairs. The finer grouping is the
  // correctness of it, not an optimisation: a body grouped by app_name alone
  // would store per-app distinct-user counts, and the "AI users" tile below
  // would have to add them up — double-counting anybody using two AI apps. See
  // src/queries/snapshots.ts.
  const apps = useSearch(appsQuery, { accel: 'gno_app_src_c1h', accelPanel: 'shadow-ai-apps' })
  const aiOverall = useSearch(aiOverallQuery, { accel: 'gno_app_src_c1h', accelPanel: 'shadow-ai-overall' })
  const aiUsers = useSearch(aiUsersQuery, { accel: 'gno_app_src_c1h', accelPanel: 'shadow-ai-users' })

  const appsComputed = computedFrom(apps)
  const overallComputed = computedFrom(aiOverall)
  const usersComputed = computedFrom(aiUsers)

  const aiApps = apps.rows.filter((r) => AI_SET.has(str(r, 'app_name')))
  const saasApps = apps.rows.filter((r) => SAAS_SET.has(str(r, 'app_name')))
  const o = aiOverall.rows[0] ?? {}
  const topAi = aiApps[0] ? str(aiApps[0], 'app_name') : '—'

  const aiItems: BarItem[] = aiApps.slice(0, 12).map((r) => ({
    label: str(r, 'app_name'),
    value: toNum(r.flows),
    display: fmtCount(r.flows),
    note: `${fmtCount(r.users)} src`,
  }))
  const saasItems: BarItem[] = saasApps.slice(0, 12).map((r) => ({
    label: str(r, 'app_name'),
    value: toNum(r.flows),
    display: fmtCount(r.flows),
    note: `${fmtCount(r.users)} src`,
  }))

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Shadow AI discovery</h2>
        <p className="tab-sub">
          Application Metadata Intelligence names the apps on the wire — so shadow AI and unsanctioned SaaS show
          up with <strong>no endpoint agents and no TLS decryption</strong>. This view pivots <code>app_name</code>
          to surface GenAI/LLM usage and who is driving it — a core Gigamon AMI SecOps use case.
        </p>
      </div>

      <div className="kpi-row kpi-row-4">
        <KpiTile label="AI / LLM apps detected" value={apps.loading ? '…' : String(aiApps.length)} accent="warning"
          sub="distinct GenAI app_names" info="How many distinct GenAI/LLM applications AMI classified in the window (from a curated app_name list). Derived from the per-app query below." query={appsQuery} computed={appsComputed} />
        <KpiTile label="AI users" value={aiOverall.loading ? '…' : fmtCount(o.users)} accent="warning"
          sub="distinct src_ip → AI" info="Distinct internal source IPs that talked to any AI app — your shadow-AI footprint." query={aiOverallQuery} computed={overallComputed} />
        <KpiTile label="AI flows" value={aiOverall.loading ? '…' : fmtCount(o.flows)} accent="info"
          sub={aiOverall.loading ? '' : `${fmtBytes(o.bytes)} moved`} info="Total AI/LLM flows and bytes observed." query={aiOverallQuery} computed={overallComputed} />
        <KpiTile label="Top AI app" value={apps.loading ? '…' : topAi} accent="neutral"
          sub="most flows" info="The busiest GenAI application by flow count. Derived from the per-app query below." query={appsQuery} computed={appsComputed} />
      </div>

      <div className="grid-2">
        <Panel tourId="ai-apps" snapshot={snapshotOf(apps)} computed={appsComputed} onRefresh={apps.refetch} refreshing={apps.loading} title="AI & LLM applications" info="GenAI/LLM apps ranked by flow count; the right-hand figure is the number of distinct internal source IPs using each. Filtered client-side to a curated GenAI app_name list." query={appsQuery} note="app_name · GenAI only · by flows">
          <QueryBoundary state={apps} emptyLabel="No AI apps in this window">
            {aiItems.length ? <BarList items={aiItems} accent="accent" /> : <div className="qb-msg" style={{ padding: 20 }}>No GenAI apps seen in this window.</div>}
          </QueryBoundary>
        </Panel>

        <Panel tourId="ai-users" snapshot={snapshotOf(aiUsers)} computed={usersComputed} onRefresh={aiUsers.refetch} refreshing={aiUsers.loading} title="Top AI users" info="Internal source IPs driving the most AI traffic, with how many distinct AI apps each one reached — high app-diversity is a shadow-AI signal." query={aiUsersQuery} note="src_ip · by AI flows">
          <QueryBoundary state={aiUsers} emptyLabel="No AI traffic in this window">
            <ul className="resolver-list">
              {aiUsers.rows.map((r, i) => {
                const ip = str(r, 'src_ip', '(none)')
                const nApps = toNum(r.aiapps)
                return (
                  <li className="resolver-row" key={`${ip}-${i}`}>
                    <span className={`dot ${nApps >= 4 ? 'dot-danger' : nApps >= 2 ? 'dot-warning' : 'dot-info'}`} />
                    <span className="resolver-name" title={ip}>{ip}</span>
                    <span className="resolver-stats">{fmtCount(r.aiflows)} flows · {fmtBytes(r.bytes)}</span>
                    <span className={`pill pill-${nApps >= 4 ? 'danger' : nApps >= 2 ? 'warning' : 'info'}`}>{nApps} AI app{nApps === 1 ? '' : 's'}</span>
                  </li>
                )
              })}
            </ul>
          </QueryBoundary>
        </Panel>
      </div>

      <Panel snapshot={snapshotOf(apps)} computed={appsComputed} onRefresh={apps.refetch} refreshing={apps.loading} title="SaaS applications" info="Common/sanctioned SaaS seen on the wire (Microsoft 365, Google, Zoom, etc.) for context alongside the AI footprint. Filtered client-side to a known-SaaS app_name list." query={appsQuery} note="app_name · known SaaS · by flows">
        <QueryBoundary state={apps} emptyLabel="No SaaS apps in this window">
          {saasItems.length ? <BarList items={saasItems} accent="info" /> : <div className="qb-msg" style={{ padding: 20 }}>No known SaaS apps in this window.</div>}
        </QueryBoundary>
      </Panel>
    </div>
  )
}
