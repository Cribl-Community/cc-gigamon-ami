import { useState } from 'react'
import { useSearch } from '../cribl/useSearch'
import { q } from '../cribl/search'
import { criblUiUrl, STREAM_GROUP, LAKE_DATASET } from '../cribl/config'
import { useDashboard, TIME_RANGES } from '../app/DashboardContext'
import { PanelInfo } from '../components/PanelInfo'
import { toNum, fmtCount, fmtBytes, windowSeconds } from '../lib/format'

/** Volume figures for the current window, shared by every stage. */
interface Volume {
  // From the AMI records themselves (dataset="gigamon_ami").
  events: number
  bytes: number
  packets: number
  fields: number
  // From Cribl's own component telemetry (dataset="cribl_metrics").
  srcEvents: number
  pipeEvents: number
  dstEvents: number
  dstBytes: number
  blocked: number
  backpressure: number
  windowSec: number
  // Range-INDEPENDENT: what is actually sitting in the Lake dataset.
  lakeTotalEvents: number
  lakeTotalBytes: number
  lakeTotalLoading: boolean
}

/** Where a stage's number comes from — surfaced in the UI so it's unambiguous. */
type Provenance = 'cribl' | 'records'

/**
 * Real Cribl component telemetry, scoped to THIS data path.
 *
 * cribl_metrics carries the same counter at several aggregation levels, so the
 * namespace/dimension filters matter: without `namespace=="data_insights"` plus
 * the id/from_input/output dimension you double-count (total.in_events with a
 * null namespace reports 2x). Verified against this workspace.
 */
const METRICS_QUERY =
  'dataset="cribl_metrics" | summarize ' +
  'src_events=sum(iif(metric=="pipe.in_events" and namespace=="data_insights" and from_input=="datagen:in_gigamon_datagen", value, 0)), ' +
  'pipe_events=sum(iif(metric=="pipe.out_events" and namespace=="data_insights" and id=="gigamon_ami", value, 0)), ' +
  'dst_events=sum(iif(metric=="total.out_events" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0)), ' +
  'dst_bytes=sum(iif(metric=="total.out_bytes" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0)), ' +
  'blocked=sum(iif(metric=="blocked.outputs", value, 0)), ' +
  'backpressure=sum(iif(metric=="backpressure.outputs", value, 0))'

/**
 * What is actually held in the Lake dataset, independent of the page's range —
 * a storage stage should report what it stores, not just the window's inflow.
 *
 * Summing the write counters over the retention period is ~4x faster than
 * counting the dataset directly (17s vs 64s) and agrees within 0.3%
 * (18.24M vs 18.30M). They match only because nothing has aged out yet; once
 * data exceeds 30 days this becomes "written", not "retained".
 */
const LAKE_TOTAL_QUERY =
  'dataset="cribl_metrics" | summarize ' +
  'total_events=sum(iif(metric=="total.out_events" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0)), ' +
  'total_bytes=sum(iif(metric=="total.out_bytes" and namespace=="data_insights" and output=="cribl_lake:gigamon_lake", value, 0))'

interface StageLink {
  href: string
  label: string
}

interface Stage {
  id: string
  name: string
  kind: 'gigamon' | 'cribl' | 'app'
  short: string
  /** One-paragraph "what this stage is for", shown in the ⓘ popover. */
  purpose: string
  detail: string[]
  links?: StageLink[]
}

const G = STREAM_GROUP

const STAGES: Stage[] = [
  {
    id: 'gigasmart', name: 'GigaVUE · GigaSMART', kind: 'gigamon', short: 'Application Metadata Intelligence',
    purpose:
      'The packet broker. GigaSMART inspects mirrored traffic and extracts application-layer metadata — no agent runs on the workloads, so it sees east-west traffic that host-based tooling misses. This is where every field in this app originates.',
    detail: [
      'Extracts app-layer metadata from mirrored network traffic (up to ~6000 attributes across 4000+ apps).',
      'No agents on the workloads — visibility comes from the packet broker.',
    ],
    links: [{ href: 'https://docs.gigamon.com/', label: 'Gigamon docs ↗' }],
  },
  {
    id: 'amx', name: 'Application Metadata Exporter (AMX)', kind: 'gigamon', short: 'CEF → JSON',
    purpose:
      'Gigamon exports AMI records as IPFIX/CEF. AMX converts them to JSON and ships them downstream — that JSON is exactly the shape of the sample data this app replays.',
    detail: [
      'Converts AMI records (IPFIX/CEF) to JSON and exports to downstream tools.',
      'This is exactly the shape of the sample data: {vendor:"Gigamon", version:"6.13.00", ...}.',
    ],
    links: [{ href: 'https://docs.gigamon.com/', label: 'Gigamon docs ↗' }],
  },
  {
    id: 'datagen', name: 'Cribl Stream · DataGen Source', kind: 'cribl', short: 'in_gigamon_datagen',
    purpose:
      'Stands in for a live Gigamon feed. 73 sample files replay a diversity-maximized slice of the real AMI capture, covering all 319 fields and every distinct resolver. Rate is 2 events/sec per file per worker node — with 2 workers that is ~290/s. It stamps _time = now, so a "last 15 minutes" window is always populated.',
    detail: [
      '73 sample files replay a diversity-maximized slice of the AMI capture — 2 EPS per file per worker node, ~290 events/sec across 2 workers.',
      'Stamps _time = now, so the dashboards stay live on a "last 15 minutes" window.',
    ],
    links: [{ href: criblUiUrl(`/stream/m/${G}/inputs/datagen/in_gigamon_datagen`), label: 'DataGen source' }],
  },
  {
    id: 'pipeline', name: 'Pipeline · gigamon_ami', kind: 'cribl', short: 'cast + derive',
    purpose:
      'Shapes the raw AMI JSON for analytics. Gigamon exports everything as strings, so the pipeline casts numerics and derives the fields the dashboards need but the feed does not carry directly.',
    detail: [
      'Casts numeric strings (bytes, packets, ports, RTT) to numbers.',
      'Derives src_subnet / dst_subnet / total_bytes / total_packets / l4_proto, plus http_server_ms and tcp_reset.',
    ],
    links: [{ href: criblUiUrl(`/stream/m/${G}/pipelines/gigamon_ami`), label: 'Pipeline editor' }],
  },
  {
    id: 'lake', name: `Cribl Lake · ${LAKE_DATASET}`, kind: 'cribl', short: 'dataset',
    purpose:
      'Durable, queryable storage. The gigamon_lake destination writes the shaped JSON into the gigamon_ami Lake dataset on a ~60s flush, so Search sees data almost immediately while keeping 30 days of history. The headline figure is what the dataset HOLDS (summed writes over the retention period, independent of the range picker); the line under it is what the selected window added. Those coincide today because no data has aged out yet — once the feed passes 30 days, the headline becomes "written" rather than "held".',
    detail: [
      'Destination gigamon_lake (type cribl_lake) writes JSON to the gigamon_ami Lake dataset.',
      '30-day retention; flushes every ~60s for near-live queries.',
    ],
    links: [
      { href: criblUiUrl(`/stream/m/${G}/outputs/cribl_lake/gigamon_lake`), label: 'Lake destination' },
      { href: criblUiUrl('/lake/datasets'), label: 'Lake datasets' },
    ],
  },
  {
    id: 'search', name: 'Cribl Search', kind: 'cribl', short: 'KQL over Lake',
    purpose:
      'The query engine behind every panel. Each visualization submits a KQL job against dataset="gigamon_ami" and polls for results — the same query you can open yourself from any panel\'s ⓘ.',
    detail: [
      'Every panel submits a KQL job against dataset="gigamon_ami" and polls for results.',
      'Runs in the default_search group; all AMI fields are top-level queryable.',
    ],
    links: [{ href: criblUiUrl('/search'), label: 'Cribl Search' }],
  },
  {
    id: 'app', name: 'This App · Gigamon NPM', kind: 'app', short: 'dashboards',
    purpose:
      'The presentation layer you are looking at. It runs inside Cribl as a sandboxed app and calls Cribl Search through the platform fetch proxy — no separate credentials, no data leaving the workspace.',
    detail: [
      'Service Map · Capacity · TCP Health · DNS Health · TLS Posture · AI & SaaS · Field Explorer.',
      'Runs inside Cribl (sandboxed iframe) and calls Cribl Search via the platform fetch proxy.',
    ],
    links: [{ href: criblUiUrl('/apps'), label: 'Cribl Apps' }],
  },
]

/**
 * Volume shown on each stage. The Cribl stages deliberately report the same
 * event count — that IS the point: nothing is dropped between source, pipeline,
 * Lake and Search. Only the framing changes per stage.
 */
const METRIC: Record<string, (v: Volume) => { value: string; label: string; from: Provenance; sub?: string }> = {
  // Upstream of Cribl — no Cribl telemetry exists, so these come from the
  // contents of the AMI records themselves.
  gigasmart: (v) => ({ value: fmtBytes(v.bytes), label: 'network observed on the wire', from: 'records' }),
  amx: (v) => ({ value: fmtCount(v.events), label: 'AMI records exported', from: 'records' }),
  // Cribl components — real component telemetry from cribl_metrics.
  datagen: (v) => ({
    value: fmtCount(v.srcEvents),
    label: `events out · ${Math.round(v.srcEvents / Math.max(1, v.windowSec))}/s`,
    from: 'cribl',
  }),
  pipeline: (v) => ({ value: fmtCount(v.pipeEvents), label: `events out · ${v.fields} fields`, from: 'cribl' }),
  // Storage stage: headline what the Lake HOLDS, with the window's inflow below.
  lake: (v) => ({
    value: v.lakeTotalLoading ? '…' : fmtBytes(v.lakeTotalBytes),
    label: v.lakeTotalLoading ? 'totalling dataset…' : `${fmtCount(v.lakeTotalEvents)} events held · 30d retention`,
    sub: `+${fmtBytes(v.dstBytes)} · ${fmtCount(v.dstEvents)} events this window`,
    from: 'cribl',
  }),
  // Search/app volume is what OUR queries scan, which Cribl's component
  // counters don't describe — so this stays record-derived and says so.
  search: (v) => ({ value: fmtCount(v.events), label: 'events scanned by this app', from: 'records' }),
  app: (v) => ({ value: fmtCount(v.events), label: 'events visualized', from: 'records' }),
}

type HopState = 'on' | 'idle' | 'blocked'

/**
 * State of each connector, so a break shows up on the hop that actually broke
 * rather than dimming the whole diagram.
 */
function hopStates(v: Volume): HopState[] {
  const on = (n: number): HopState => (n > 0 ? 'on' : 'idle')
  const lakeHop: HopState = v.blocked > 0 || v.backpressure > 0 ? 'blocked' : on(v.dstEvents)
  return [
    on(v.events),      // GigaSMART → AMX   (upstream; inferred from records arriving)
    on(v.events),      // AMX → DataGen
    on(v.srcEvents),   // DataGen → Pipeline
    on(v.pipeEvents),  // Pipeline → Lake
    lakeHop,           // Lake → Search     (blocked/backpressure surfaces here)
    on(v.events),      // Search → App
  ]
}

/** Animated connector — dots travel along the link to show data moving. */
function FlowLink({ state }: { state: HopState }) {
  const title =
    state === 'on' ? 'Data flowing' : state === 'blocked' ? 'Destination blocked / backpressure' : 'No data in this window'
  return (
    <span className={`flow-link flow-link-${state}`} title={title}>
      <span className="flow-dot" />
      <span className="flow-dot" />
      <span className="flow-dot" />
      {state !== 'on' && <span className="flow-link-flag">{state === 'blocked' ? 'blocked' : 'no data'}</span>}
    </span>
  )
}

export function DataFlow() {
  const [sel, setSel] = useState<string>('datagen')
  const { range, setRange } = useDashboard()
  // Record-derived volume (what the AMI data itself says).
  const agg = useSearch(q('| summarize events=count(), bytes=sum(total_bytes), packets=sum(total_packets)'))
  // Cribl's own component telemetry for the Cribl stages.
  const met = useSearch(METRICS_QUERY)
  // Lake total is deliberately pinned to the retention period, NOT the page
  // range, and loads independently so its ~17s scan never blocks the diagram.
  const lakeTotal = useSearch(LAKE_TOTAL_QUERY, { earliest: '-30d' })
  const row = agg.rows[0]
  const mrow = met.rows[0]
  const lrow = lakeTotal.rows[0]
  const events = toNum(row?.events)
  const vol: Volume = {
    events,
    bytes: toNum(row?.bytes),
    packets: toNum(row?.packets),
    fields: 319,
    srcEvents: toNum(mrow?.src_events),
    pipeEvents: toNum(mrow?.pipe_events),
    dstEvents: toNum(mrow?.dst_events),
    dstBytes: toNum(mrow?.dst_bytes),
    blocked: toNum(mrow?.blocked),
    backpressure: toNum(mrow?.backpressure),
    windowSec: windowSeconds(range.earliest),
    lakeTotalEvents: toNum(lrow?.total_events),
    lakeTotalBytes: toNum(lrow?.total_bytes),
    lakeTotalLoading: lakeTotal.loading,
  }
  const loading = agg.loading || met.loading
  const hops = hopStates(vol)
  const selected = STAGES.find((s) => s.id === sel)!

  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Data flow</h2>
        <p className="tab-sub">
          How Gigamon AMI data reaches these dashboards — from the packet broker, through Cribl Stream into
          Cribl Lake, and out via Cribl Search. Click a stage for detail, or use its{' '}
          <strong>ⓘ</strong> to read what the stage does and jump straight to that object in Cribl.
        </p>
      </div>

      <div className="flow-toolbar">
        <span className="flow-tb-label">Volumes for</span>
        <select
          className="range-select"
          value={range.label}
          aria-label="Time range for data-flow volumes"
          onChange={(e) => { const next = TIME_RANGES.find((r) => r.label === e.target.value); if (next) setRange(next) }}
        >
          {TIME_RANGES.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
        </select>
        <button type="button" className={`panel-refresh ${loading ? 'panel-refresh-on' : ''}`}
          onClick={() => { agg.refetch(); met.refetch(); lakeTotal.refetch() }}
          aria-label="Refresh data-flow volumes" title="Refresh data-flow volumes">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
        </button>
        <span className="flow-tb-note">
          <span className="prov prov-cribl">Cribl metrics</span> = live component telemetry from{' '}
          <code>cribl_metrics</code>; <span className="prov prov-records">from records</span> = computed from the
          AMI data itself. Every figure is scoped to the range above.
        </span>
      </div>

      <div className="flow flow-vert" data-tour="data-flow">
        {STAGES.map((s, i) => {
          const m = METRIC[s.id](vol)
          return (
            <div className="flow-row-item" key={s.id}>
              <div className={`flow-node-wrap ${sel === s.id ? 'flow-sel-wrap' : ''}`}>
                <button
                  type="button"
                  className={`flow-node flow-${s.kind} ${sel === s.id ? 'flow-sel' : ''}`}
                  onClick={() => setSel(s.id)}
                >
                  <span className="flow-node-main">
                    <span className="flow-kind">{s.kind === 'gigamon' ? 'Gigamon' : s.kind === 'cribl' ? 'Cribl' : 'App'}</span>
                    <span className="flow-name">{s.name}</span>
                    <span className="flow-short">{s.short}</span>
                  </span>
                  <span className="flow-metric">
                    {loading ? (
                      <span className="flow-metric-v flow-metric-idle">…</span>
                    ) : (
                      <>
                        <span className="flow-metric-v">{m.value}</span>
                        <span className="flow-metric-l">{m.label}</span>
                        {m.sub && <span className="flow-metric-sub">{m.sub}</span>}
                        <span className={`prov prov-${m.from}`}>{m.from === 'cribl' ? 'Cribl metrics' : 'from records'}</span>
                      </>
                    )}
                  </span>
                </button>
                <span className="flow-info">
                  <PanelInfo about={s.purpose} aboutHeading="What this stage does" links={s.links} />
                </span>
              </div>
              {i < STAGES.length - 1 && <FlowLink state={loading ? 'on' : hops[i]} />}
            </div>
          )
        })}
      </div>

      <section className="panel">
        <header className="panel-head">
          <h3 className="panel-title">
            {selected.name}
            <PanelInfo about={selected.purpose} aboutHeading="What this stage does" links={selected.links} />
          </h3>
          <span className="panel-note">
            {loading
              ? 'querying…'
              : <><span className={`flow-pulse ${vol.dstEvents > 0 ? 'flow-pulse-on' : ''}`} />{fmtCount(vol.dstEvents)} events into Lake · {range.label.toLowerCase()}</>}
          </span>
        </header>
        <div className="panel-body">
          <ul className="flow-detail">
            {selected.detail.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}
