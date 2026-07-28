import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { runFieldSummaries, runSearch, q, type FieldSummary } from '../cribl/search'
import { useDashboard } from '../app/DashboardContext'
import { Panel } from '../components/Panel'
import { KpiTile } from '../components/KpiTile'
import { QueryBoundary } from '../components/QueryBoundary'
import { fmtCount } from '../lib/format'
import { AMI_CATALOG, AMI_FAMILIES, AMI_USE_CASES, type AmiField } from '../data/amiFields'

const CATALOG_BY_NAME = new Map(AMI_CATALOG.map((f) => [f.name, f]))

// Presence is checked with count(field) over the WHOLE window (accurate for
// rare fields like ssl_issuer that a sampled field-summaries would miss).
const CHECK_FIELDS = Array.from(
  new Set([...AMI_CATALOG.map((f) => f.name), ...AMI_CATALOG.map((f) => f.derivedField).filter((x): x is string => !!x)]),
)
const PRESENCE_QUERY = q('| summarize ' + CHECK_FIELDS.map((n, i) => `c${i}=count(${n})`).join(', '))

// The readable presence query behind a section (family / use case) — one
// count(field) per field. Powers the ⓘ "open in Cribl Search" for the section.
const sectionQuery = (fields: string[]) => q('| summarize ' + fields.map((n) => `${n}=count(${n})`).join(', '))

const FAMILY_ORDER = ['Core / 5-tuple', 'DNS', 'SNMP', 'SSL / TLS', 'HTTP', 'TCP / UDP', 'AWS enrichment', 'Other protocols']

function familyOf(name: string): string {
  if (name.startsWith('src_aws') || name.startsWith('dst_aws') || name.endsWith('workload_platform')) return 'AWS enrichment'
  if (name.startsWith('dns_')) return 'DNS'
  if (name.startsWith('snmp_')) return 'SNMP'
  if (name.startsWith('ssl_')) return 'SSL / TLS'
  if (name.startsWith('http_') || name.startsWith('http2_')) return 'HTTP'
  if (name.startsWith('tcp_') || name.startsWith('udp_')) return 'TCP / UDP'
  if (/^(ssh|rtp|rtcp|dhcp|icmp|ntp|krb5|dcerpc|ftp|sip|gtp|whatsapp|upnp)_/.test(name)) return 'Other protocols'
  return 'Core / 5-tuple'
}

type Status = 'present' | 'derived' | 'missing'
function statusOf(f: AmiField, count: Record<string, number>): Status {
  if ((count[f.name] ?? 0) > 0) return 'present'
  if (f.derivedField && (count[f.derivedField] ?? 0) > 0) return 'derived'
  return 'missing'
}

export function FieldExplorer() {
  const { range, refreshNonce } = useDashboard()
  const [state, setState] = useState<{ loading: boolean; error: string | null; fields: FieldSummary[]; sampled: number }>({
    loading: true, error: null, fields: [], sampled: 0,
  })
  const [presence, setPresence] = useState<{ loading: boolean; error: string | null; count: Record<string, number> }>({
    loading: true, error: null, count: {},
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

  // Field-summaries (fill / cardinality / top values) for the "In feed" browser.
  useEffect(() => {
    const ctrl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    runFieldSummaries(q('| limit 5000'), { earliest: range.earliest, signal: ctrl.signal })
      .then((res) => setState({ loading: false, error: null, fields: res.fields, sampled: res.sampled }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setState((s) => ({ ...s, loading: false, error: (e as Error).message }))
      })
    return () => ctrl.abort()
  }, [range.earliest, refreshNonce, nonce])

  // Whole-window presence counts for the AMI coverage view (accurate for rare fields).
  useEffect(() => {
    const ctrl = new AbortController()
    setPresence((s) => ({ ...s, loading: true, error: null }))
    runSearch(PRESENCE_QUERY, { earliest: range.earliest, signal: ctrl.signal })
      .then((res) => {
        const row = (res.rows[0] ?? {}) as Record<string, unknown>
        const count: Record<string, number> = {}
        CHECK_FIELDS.forEach((n, i) => { count[n] = Number(row[`c${i}`]) || 0 })
        setPresence({ loading: false, error: null, count })
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setPresence((s) => ({ ...s, loading: false, error: (e as Error).message }))
      })
    return () => ctrl.abort()
  }, [range.earliest, refreshNonce, nonce])

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
          uncapped counts).
        </p>
        <div className="pivot-toggle">
          <button type="button" className={`seg ${view === 'coverage' ? 'seg-active' : ''}`} onClick={() => setView('coverage')}>AMI coverage</button>
          <button type="button" className={`seg ${view === 'usecase' ? 'seg-active' : ''}`} onClick={() => setView('usecase')}>By use case</button>
          <button type="button" className={`seg ${view === 'feed' ? 'seg-active' : ''}`} onClick={() => setView('feed')}>In feed</button>
        </div>
      </div>

      {view === 'coverage' ? (
        <QueryBoundary state={{ loading: presence.loading, error: presence.error, rows: CHECK_FIELDS }} emptyLabel="No data in this window">
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
                      <span className={`cov-badge cov-badge-${status}`}>{status === 'present' ? 'present' : status === 'derived' ? 'derived' : 'missing'}</span>
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
        <QueryBoundary state={{ loading: presence.loading, error: presence.error, rows: CHECK_FIELDS }} emptyLabel="No data in this window">
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
                      <span className={`cov-badge cov-badge-${r.status}`}>{r.status}</span>
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
          </div>
          <Panel onRefresh={refresh} refreshing={state.loading} title="Fields" info="The top 200 AMI fields by fill: type, fill rate (% of events carrying it), and distinct-value count. Cribl's field-summaries API returns at most 200 fields, so the ~110 rarest protocol fields (e.g. dcerpc_*, whatsapp_*) aren't listed here — the AMI coverage view uses uncapped count() checks instead. Click a field for its top values." query={q('| limit 5000')} note={`${visible.length} of ${state.fields.length} shown · top 200 (field-summaries cap; ~310 in feed)`}>
            <QueryBoundary state={{ loading: state.loading, error: state.error, rows: state.fields }} emptyLabel="No fields in this window">
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
