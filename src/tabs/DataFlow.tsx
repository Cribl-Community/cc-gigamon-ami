import { useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { criblUiUrl, LAKE_DATASET } from '../cribl/config'
import { DATASET_RECORDS_QUERY, METRICS_QUERY, onboardedMetricsQueryFor } from '../queries/dataFlow'
import { useDashboard, TIME_RANGES } from '../app/DashboardContext'
import { useOnboardedFlow, type OnboardedFlow } from '../components/useOnboardedFlow'
import { PanelInfo } from '../components/PanelInfo'
import { DopDiagram, type DopNode, type HopId, type HopState, type InfoKey, type SlotId } from '../components/DopDiagram'
import { useSnapshotSlot } from '../components/snapshotCensus'
import { fmtCount, fmtBytes, toNum, windowSeconds } from '../lib/format'

interface Stage {
  id: string
  name: string
  short: string
  purpose: string
  links: Array<{ href: string; label: string }>
}

const STAGES: Stage[] = [
  {
    id: 'gigasmart', name: 'GigaVUE · GigaSMART', short: 'Deep Observability Pipeline',
    purpose: 'Network Traffic is src_bytes + dst_bytes and src_packets + dst_packets summed over every AMI record in gigamon_ami during the selected event-time window. These are record-derived totals, not measured physical-link throughput. Only records with numeric, nonnegative values in both directions are summed; the coverage line says how many records that is. Every writer to gigamon_ami is included.',
    links: [{ href: 'https://docs.gigamon.com/', label: 'Gigamon docs' }],
  },
  {
    id: 'amx', name: 'Application Metadata Exporter (AMX)', short: 'AMI records exported to Raw HTTP',
    purpose: 'Enriched Metadata counts every AMI record searchable in gigamon_ami during the selected event-time window. It is the same population counted in Lake and Search, not an AMX delivery acknowledgment or a separate upstream measurement. Every writer to gigamon_ami is included, not only the onboarded source.',
    links: [{ href: 'https://docs.gigamon.com/', label: 'Gigamon docs' }],
  },
  {
    id: 'datagen', name: 'Cribl Stream · Source', short: 'Onboarded Raw HTTP source',
    purpose: 'Counts events received by the source shown in Guided Setup’s Onboard page. Demo sources, pack sources and other Raw HTTP sources are excluded. A missing telemetry series is unavailable, not zero.',
    links: [],
  },
  {
    id: 'pipeline', name: 'Cribl Stream · Processing', short: 'Onboarded QuickConnect pipeline',
    purpose: 'Counts events leaving the named pipeline in the selected worker group, from default_metrics raw Stream counters. Includes all traffic using this pipeline, not only the onboarded source. Processing can change event counts; equal counts are not assumed.',
    links: [],
  },
  {
    id: 'destination', name: 'Cribl Stream · Destination', short: 'Onboarded Cribl Lake destination',
    purpose: 'Counts events and bytes written by the named destination in the selected worker group, from default_metrics raw Stream counters. Includes all sources using this destination. These are Stream write counters, not retained Lake records or compressed storage size.',
    links: [],
  },
  {
    id: 'lake', name: `Cribl Lake · ${LAKE_DATASET}`, short: 'Events in the dataset · selected window',
    purpose: 'Counts every searchable record in gigamon_ami within the selected event-time window, from every writer to the dataset, not only the onboarded source. This is not a lifetime count or a Stream write counter, and records still being written to Lake may not be searchable yet. Compressed storage size is not shown.',
    links: [{ href: criblUiUrl('/lake/datasets'), label: 'Lake datasets' }],
  },
  {
    id: 'search', name: 'Cribl Search', short: 'Searchable events · selected window',
    purpose: 'Uses the same gigamon_ami record count and event-time window as the Lake card: what Cribl Search can read from the dataset. Every writer to gigamon_ami is included, not only the onboarded source.',
    links: [{ href: criblUiUrl('/search'), label: 'Cribl Search' }],
  },
  {
    id: 'app', name: 'Gigamon Network Observability', short: 'Connection telemetry',
    purpose: 'Displays the same connected source, pipeline and destination that Guided Setup’s Onboard page identifies. Refresh re-reads that connection. Two live queries read Stream telemetry and the gigamon_ami records for the selected range; combined demo and pack snapshots are not used. These searches consume Search credits; this dashboard never changes ingestion configuration.',
    links: [{ href: criblUiUrl('/apps'), label: 'Cribl Apps' }],
  },
]

function stagesFor(flow: OnboardedFlow | null): Stage[] {
  if (!flow) return STAGES
  const group = encodeURIComponent(flow.group)
  return STAGES.map((s) => {
    if (s.id === 'datagen') return {
      ...s, short: flow.sourceId,
      purpose: `${flow.sourceId} in worker group ${flow.group}. ${s.purpose}`,
      links: [{ href: criblUiUrl(`/stream/m/${group}/inputs/http_raw/${encodeURIComponent(flow.sourceId)}`), label: `${flow.sourceId} source` }],
    }
    if (s.id === 'pipeline') return {
      ...s, short: flow.pipeline,
      links: [{ href: criblUiUrl(`/stream/m/${group}/pipelines/${encodeURIComponent(flow.pipeline)}`), label: `${flow.pipeline} pipeline` }],
    }
    if (s.id === 'destination') return {
      ...s, short: flow.destination,
      links: [{ href: criblUiUrl(`/stream/m/${group}/outputs/cribl_lake/${encodeURIComponent(flow.destination)}`), label: `${flow.destination} destination` }],
    }
    return s
  })
}

export function DataFlow() {
  const [sel, setSel] = useState('datagen')
  const { range, setRange, refreshNonce } = useDashboard()
  const connection = useOnboardedFlow(refreshNonce)
  const flow = connection.flow
  // The disabled hook still needs a query string; it never submits without a connection.
  const metricsQuery = flow ? onboardedMetricsQueryFor(flow) : METRICS_QUERY
  const met = useSearch(metricsQuery, { enabled: flow !== null, deferred: connection.loading, asWritten: true })
  const recordsQuery = DATASET_RECORDS_QUERY
  const records = useSearch(recordsQuery, { asWritten: true })
  useSnapshotSlot({
    source: met.source, outcome: met.outcome, at: met.at, stale: met.stale, nearestAt: met.nearestAt,
  })
  useSnapshotSlot({
    source: records.source, outcome: records.outcome, at: records.at, stale: records.stale, nearestAt: records.nearestAt,
  })
  const loading = connection.loading || records.loading || (flow !== null && met.loading)
  const row = flow && !met.loading && !met.error ? met.rows[0] : undefined
  const counter = (samples: string, value: string): number | null =>
    row && toNum(row[samples]) > 0 && typeof row[value] === 'number' && Number.isFinite(row[value])
      ? row[value] : null
  const src = counter('src_samples', 'src_events')
  const pipe = counter('pipe_samples', 'pipe_events')
  const dst = counter('dst_samples', 'dst_events')
  const bytes = counter('dst_byte_samples', 'dst_bytes')
  const recordRow = !records.loading && !records.error ? records.rows[0] : undefined
  const numberAt = (key: string): number | null => {
    const n = recordRow?.[key]
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
  }
  const events = numberAt('events')
  const byteRecords = numberAt('byte_records')
  const packetRecords = numberAt('packet_records')
  // Cribl returns null sums when summarize sees no matching records.
  const validVolume = (key: string) => events === 0
    ? recordRow?.[key] === null || numberAt(key) === 0
    : numberAt(key) !== null
  const validRecords = events !== null && Number.isInteger(events) &&
    byteRecords !== null && Number.isInteger(byteRecords) && byteRecords <= events &&
    packetRecords !== null && Number.isInteger(packetRecords) && packetRecords <= events &&
    validVolume('bytes') && validVolume('packets')
  const landed = validRecords ? events : null
  // Summed over the records that carry both directions; coverage is shown when partial.
  const trafficBytes = landed === null || (landed > 0 && byteRecords === 0) ? null : numberAt('bytes') ?? 0
  const packets = landed === null || (landed > 0 && packetRecords === 0) ? null : numberAt('packets') ?? 0
  const count = (n: number | null) => n === null ? '—' : fmtCount(n)
  const sourceRate = src === null ? null : src / Math.max(1, windowSeconds(range.earliest))
  const rateLabel = sourceRate === null ? '—' : sourceRate > 0 && sourceRate < 0.01
    ? '<0.01' : sourceRate.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const stages = stagesFor(flow)
  const selected = stages.find((s) => s.id === sel)!
  const nodes: Record<SlotId, DopNode> = {
    sources: {
      id: 'datagen', title: ['Sources'], tier: 'cribl', sub: [flow?.sourceId ?? 'No onboarded source'],
      value: count(src), label: [src === null ? 'intake unavailable' : `events in · avg ${rateLabel}/s`], from: 'cribl',
    },
    stream: {
      id: 'pipeline', title: ['Processing'], tier: 'cribl', icon: 'stream', sub: [flow ? `pipeline · ${flow.pipeline}` : 'No onboarded pipeline'],
      value: count(pipe), label: [pipe === null ? 'processing unavailable' : 'events out · whole pipeline'], from: 'cribl',
    },
    destinations: {
      id: 'destination', title: ['Destinations'], tier: 'cribl', sub: [flow?.destination ?? 'No onboarded destination'],
      value: bytes === null ? '—' : fmtBytes(bytes),
      label: [dst === null ? 'writes unavailable' : `${fmtCount(dst)} events written this window`], from: 'cribl',
    },
    lake: {
      id: 'lake', title: ['Cribl Lake'], tier: 'cribl', icon: 'lake', sub: [`${LAKE_DATASET} dataset`],
      value: count(landed), label: ['events in dataset · this window'], from: landed === null ? 'unavailable' : 'records',
    },
    search: {
      id: 'search', title: ['Cribl Search'], tier: 'cribl', icon: 'search',
      value: count(landed), label: ['same events as Lake'], from: landed === null ? 'unavailable' : 'records',
    },
    app: { id: 'app', title: ['Cribl Apps'], tier: 'cribl', icon: 'apps', caption: ['Gigamon Network Observability'] },
  }
  const on = (n: number | null): HopState => n === null ? 'unavailable' : n > 0 ? 'on' : 'idle'
  const hops: Record<HopId, HopState> = {
    wire: on(trafficBytes ?? packets), enriched: on(landed), ingest: on(src), process: on(src), store: on(pipe), query: on(dst), render: on(landed),
  }
  const stageInfo = (s: Stage) =>
    <PanelInfo label={s.name} about={s.purpose} aboutHeading="What this stage does" links={s.links} />
  const telemetryInfo = (t: Stage) =>
    <PanelInfo label={t.name} about={t.purpose} aboutHeading="What this stage does" links={t.links} query={metricsQuery} asWritten />
  const recordsInfo = (r: Stage) =>
    <PanelInfo label={r.name} about={r.purpose} aboutHeading="What this stage does" links={r.links} query={recordsQuery} asWritten />
  const infoOf = (id: string) => {
    const stage = stages.find((s) => s.id === id)!
    if (flow && ['datagen', 'pipeline', 'destination'].includes(id)) return telemetryInfo(stage)
    if (['gigasmart', 'amx', 'lake', 'search'].includes(id)) return recordsInfo(stage)
    return stageInfo(stage)
  }
  const info: Record<InfoKey, ReturnType<typeof stageInfo>> = {
    gigasmart: infoOf('gigasmart'), amx: infoOf('amx'), sources: infoOf('datagen'),
    stream: infoOf('pipeline'), destinations: infoOf('destination'),
    lake: infoOf('lake'), search: infoOf('search'), app: infoOf('app'),
  }
  const unavailable = !loading && flow && !met.error && [src, pipe, dst, bytes].some((n) => n === null)

  return (
    <div className="tab">
      <div className="tab-intro dop-intro">
        <h2 className="tab-h dop-h">The Gigamon Deep Observability Pipeline</h2>
        <p className="dop-kicker">Transforming network traffic into trusted, network-derived intelligence</p>
        <p className="tab-sub">Each named object’s own counter in the selected worker group. Processing and Destinations include other traffic sharing those objects, not just this source.</p>
      </div>
      <div className="flow-toolbar">
        <span className="flow-tb-label">Volumes for</span>
        <select className="range-select" value={range.label} aria-label="Time range for data-flow volumes"
          onChange={(e) => { const next = TIME_RANGES.find((r) => r.label === e.target.value); if (next) setRange(next) }}>
          {TIME_RANGES.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
        </select>
        <button type="button" className={`panel-refresh ${loading ? 'panel-refresh-on' : ''}`}
          onClick={() => { connection.refresh(); met.refetch(); records.refetch() }} aria-label="Refresh data-flow volumes" title="Refresh data-flow volumes">
          Refresh
        </button>
        <span className="flow-tb-note">
          Raw object counters from default_metrics · {connection.group}. Lake, Search and AMI figures count all of gigamon_ami; storage size not shown. Searches consume credits.
        </span>
      </div>
      {connection.error && <p role="alert">{connection.error}</p>}
      {!loading && !connection.error && !flow && <p role="status">No onboarded Raw HTTP connection found in {connection.group}. Open Guided Setup and run Onboard.</p>}
      {met.error && flow && <p role="alert">{met.errorTitle ?? 'Could not read connection telemetry'}: {met.error}</p>}
      {records.error && <p role="alert">{records.errorTitle ?? 'Could not read gigamon_ami records'}: {records.error}</p>}
      {!records.loading && !records.error && !validRecords && <p role="alert">The gigamon_ami record query returned an incomplete or invalid summary. Record-derived figures are unavailable.</p>}
      {landed !== null && landed > 0 && (byteRecords !== landed || packetRecords !== landed) &&
        <p role="status">Network Traffic coverage: {fmtCount(byteRecords)} of {fmtCount(landed)} records carry bytes in both directions and {fmtCount(packetRecords)} carry packets; the totals sum those records only.</p>}
      {unavailable && <p role="status">Some named-object counters have no matching telemetry in default_metrics for this group and window. Unavailable does not mean zero.</p>}
      <DopDiagram nodes={nodes} wire={{
        value: trafficBytes === null ? '—' : fmtBytes(trafficBytes),
        label: packets === null ? 'packets unavailable · from AMI' : `${fmtCount(packets)} packets · from AMI`,
        from: trafficBytes === null && packets === null ? 'unavailable' : 'records',
      }}
        enriched={{ value: count(landed), label: 'AMI records · gigamon_ami', from: landed === null ? 'unavailable' : 'records' }}
        hops={hops} selected={sel} onSelect={setSel} loading={loading} info={info} />
      <section className="panel">
        <header className="panel-head">
          <h3 className="panel-title">{selected.name}<PanelInfo about={selected.purpose} links={selected.links} /></h3>
          <span className="panel-note">{loading ? 'querying…' : `${count(landed)} events in gigamon_ami · ${range.label.toLowerCase()}`}</span>
        </header>
        <div className="panel-body"><p className="dop-stage-kicker">{selected.short}</p><p>{selected.purpose}</p></div>
      </section>
      <footer className="dop-footer">
        <span className="dop-footer-brand">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden className="dop-cribl-mark">
            <path d="M4 5 L16 12 L4 19 Z" />
            <path d="M17.5 8.5 L21.5 12 L17.5 15.5 Z" />
          </svg>
          <strong>Cribl</strong><span className="dop-footer-tag">The AI platform for telemetry</span>
        </span>
        <span className="dop-footer-sep" />
        <span className="dop-footer-brand"><span className="dop-footer-gg">Gigamon</span><span className="dop-footer-tag">Deep Observability Pipeline</span></span>
      </footer>
    </div>
  )
}
