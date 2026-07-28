import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { BarList, type BarItem } from '../components/BarList'
import { toNum, str, fmtCount, fmtBytes } from '../lib/format'

// GenAI / LLM apps AMI can identify from the wire.
const AI_APPS = [
  'openai', 'chatgpt', 'claude', 'anthropic', 'perplexity-ai', 'midjourney', 'elevenlabs-io', 'stability-ai',
  'runway', 'descript', 'copy-ai', 'jasper-ai', 'writesonic', 'poe', 'bard', 'meta-ai', 'ms-copilot',
  'codewhisperer', 'mistral-ai', 'deepseek', 'deepseek-net', 'google-gen', 'notebooklm', 'personal-ai',
  'inflection-ai', 'muse-ai', 'mem-ai', 'aiva', 'lasco-ai', 'emailtree-ai', 'murf-ai', 'llm-stats',
  'swe-bench', 'anyword', 'pixlr',
]
// Sanctioned/common SaaS (for the shadow-vs-known split).
const SAAS_APPS = new Set([
  'office365', 'microsoft', 'google', 'facebook', 'instagram', 'whatsapp', 'spotify', 'zoom', 'webex',
  'gotomeeting', 'discord', 'notion', 'splunk', 'datadog', 'launchpad', 'quantcast', 'disqus', 'yahoo',
  'amazon-cognito', 'google-ads', 'gstatic', 'amazon-aws', 'gcp', 'alibaba-cloud', 'docker', 'capcut',
  'wondershare', 'filmora',
])
const AI_SET = new Set(AI_APPS)
const AI_IN = AI_APPS.map((a) => `"${a}"`).join(',')

export function ShadowAi() {
  const appsQuery = q('| summarize flows=count(), bytes=sum(total_bytes), users=dcount(src_ip) by app_name | sort by flows desc | limit 90')
  const apps = useSearch(appsQuery)
  const aiOverallQuery = q(`| where app_name in (${AI_IN}) | summarize users=dcount(src_ip), flows=count(), bytes=sum(total_bytes)`)
  const aiOverall = useSearch(aiOverallQuery)
  const aiUsersQuery = q(`| where app_name in (${AI_IN}) | summarize aiflows=count(), aiapps=dcount(app_name), bytes=sum(total_bytes) by src_ip | sort by aiflows desc | limit 15`)
  const aiUsers = useSearch(aiUsersQuery)

  const aiApps = apps.rows.filter((r) => AI_SET.has(str(r, 'app_name')))
  const saasApps = apps.rows.filter((r) => SAAS_APPS.has(str(r, 'app_name')))
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
        <h2 className="tab-h">AI &amp; SaaS discovery</h2>
        <p className="tab-sub">
          Application Metadata Intelligence names the apps on the wire — so shadow AI and unsanctioned SaaS show
          up with <strong>no endpoint agents and no TLS decryption</strong>. This view pivots <code>app_name</code>
          to surface GenAI/LLM usage and who is driving it — a core Gigamon AMI SecOps use case.
        </p>
      </div>

      <div className="kpi-row kpi-row-4">
        <KpiTile label="AI / LLM apps detected" value={apps.loading ? '…' : String(aiApps.length)} accent="warning"
          sub="distinct GenAI app_names" info="How many distinct GenAI/LLM applications AMI classified in the window (from a curated app_name list). Derived from the per-app query below." query={appsQuery} />
        <KpiTile label="AI users" value={aiOverall.loading ? '…' : fmtCount(o.users)} accent="warning"
          sub="distinct src_ip → AI" info="Distinct internal source IPs that talked to any AI app — your shadow-AI footprint." query={aiOverallQuery} />
        <KpiTile label="AI flows" value={aiOverall.loading ? '…' : fmtCount(o.flows)} accent="info"
          sub={aiOverall.loading ? '' : `${fmtBytes(o.bytes)} moved`} info="Total AI/LLM flows and bytes observed." query={aiOverallQuery} />
        <KpiTile label="Top AI app" value={apps.loading ? '…' : topAi} accent="neutral"
          sub="most flows" info="The busiest GenAI application by flow count. Derived from the per-app query below." query={appsQuery} />
      </div>

      <div className="grid-2">
        <Panel tourId="ai-apps" onRefresh={apps.refetch} refreshing={apps.loading} title="AI & LLM applications" info="GenAI/LLM apps ranked by flow count; the right-hand figure is the number of distinct internal source IPs using each. Filtered client-side to a curated GenAI app_name list." query={appsQuery} note="app_name · GenAI only · by flows">
          <QueryBoundary state={apps} emptyLabel="No AI apps in this window">
            {aiItems.length ? <BarList items={aiItems} accent="accent" /> : <div className="qb-msg" style={{ padding: 20 }}>No GenAI apps seen in this window.</div>}
          </QueryBoundary>
        </Panel>

        <Panel tourId="ai-users" onRefresh={aiUsers.refetch} refreshing={aiUsers.loading} title="Top AI users" info="Internal source IPs driving the most AI traffic, with how many distinct AI apps each one reached — high app-diversity is a shadow-AI signal." query={aiUsersQuery} note="src_ip · by AI flows">
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

      <Panel onRefresh={apps.refetch} refreshing={apps.loading} title="SaaS applications" info="Common/sanctioned SaaS seen on the wire (Microsoft 365, Google, Zoom, etc.) for context alongside the AI footprint. Filtered client-side to a known-SaaS app_name list." query={appsQuery} note="app_name · known SaaS · by flows">
        <QueryBoundary state={apps} emptyLabel="No SaaS apps in this window">
          {saasItems.length ? <BarList items={saasItems} accent="info" /> : <div className="qb-msg" style={{ padding: 20 }}>No known SaaS apps in this window.</div>}
        </QueryBoundary>
      </Panel>
    </div>
  )
}
