import { useState, type ReactNode } from 'react'
import { useAccelEnabled, useSearch, type UseSearchState } from '../cribl/useSearch'
import { VOLUME_QUERY, METRICS_QUERY, LAKE_TOTAL_QUERY } from '../queries/dataFlow'
import { criblUiUrl, STREAM_GROUP, LAKE_DATASET } from '../cribl/config'
import { capSecondsFor } from '../cribl/search'
import type { AccelId } from '../cribl/accel/manifest'
import { useDashboard, TIME_RANGES } from '../app/DashboardContext'
import { asOf, PanelInfo, type ComputedFrom } from '../components/PanelInfo'
import { DopDiagram, type DopNode, type HopId, type HopState, type InfoKey, type SlotId } from '../components/DopDiagram'
import { toNum, fmtCount, fmtBytes, windowSeconds } from '../lib/format'

/**
 * The scheduled search that serves the Cribl Lake card, and the window it reads.
 *
 * THE MOST EXPENSIVE QUERY IN THIS APP: 9,297.7 billable CPU-s a run, 15–24 runs
 * a day, for a figure that changes once a day at most. Phase 2 points the card at
 * a daily scheduled run of the SAME query string instead — 0.2 CPU-s to read —
 * and falls back to running it live whenever that run is missing, unfinished or
 * too old to date. The fallback is normal on a fresh install: nothing has been
 * scheduled yet, and the card behaves exactly as it did before.
 */
const LAKE_ACCEL: AccelId = 'gno_lake_30d_c1d'
/** Pinned, and NOT the page's range: this card reports what the dataset holds
 *  over its retention period. The scheduled run reads the same window. */
const LAKE_EARLIEST = '-30d'
/** The schedule in words, for the card's ⓘ. DataFlow.test.tsx holds this against
 *  the manifest's own cron, so changing one forces the other. */
export const LAKE_CADENCE = 'once a day, at 00:10 UTC'

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
  /** False when the retention query returned no row — not the same as zero. */
  lakeTotalKnown: boolean
  /** Epoch ms the scheduled run that produced this total finished; null when the
   *  query ran live for this page. A figure from a stored run is never shown
   *  undated — that is the whole safety argument for reading one. */
  lakeTotalAt: number | null
  /** That run is older than its schedule promises. */
  lakeTotalStale: boolean
}

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
    id: 'gigasmart', name: 'GigaVUE · GigaSMART', kind: 'gigamon', short: 'Deep Observability Pipeline',
    purpose:
      'The packet broker — the Deep Observability Pipeline itself. GigaSMART accesses, brokers, transforms and enriches mirrored traffic, extracting application-layer metadata. No agent runs on the workloads, so it sees east-west traffic that host-based tooling misses. This is where every field in this app originates.',
    detail: [
      'ACCESS · BROKER · TRANSFORM · ENRICH — acquires raw packets with no blind spots and inspects layers 2–7, including encrypted traffic.',
      'Extracts app-layer metadata from mirrored network traffic (up to ~6000 attributes across 4000+ apps).',
      'No agents on the workloads — visibility comes from the packet broker.',
    ],
    links: [{ href: 'https://docs.gigamon.com/', label: 'Gigamon docs ↗' }],
  },
  {
    id: 'amx', name: 'Application Metadata Exporter (AMX)', kind: 'gigamon', short: 'enriched metadata · CEF → JSON',
    purpose:
      'Gigamon exports AMI records as IPFIX/CEF. AMX converts them to JSON and ships that enriched metadata downstream into Cribl — that JSON is exactly the shape of the sample data this app replays.',
    detail: [
      'Converts AMI records (IPFIX/CEF) to JSON and exports to downstream tools.',
      'This is exactly the shape of the sample data: {vendor:"Gigamon", version:"6.13.00", ...}.',
    ],
    links: [{ href: 'https://docs.gigamon.com/', label: 'Gigamon docs ↗' }],
  },
  {
    id: 'datagen', name: 'Cribl Stream · Source', kind: 'cribl', short: 'in_gigamon_datagen',
    purpose:
      'Stands in for a live Gigamon feed. 73 sample files replay a diversity-maximized slice of the real AMI capture, covering all 319 fields and every distinct resolver. Rate is 2 events/sec per file per worker node — with 2 workers that is ~290/s. It stamps _time = now, so a "last 15 minutes" window is always populated.',
    detail: [
      '73 sample files replay a diversity-maximized slice of the AMI capture — 2 EPS per file per worker node, ~290 events/sec across 2 workers.',
      'Stamps _time = now, so the dashboards stay live on a "last 15 minutes" window.',
    ],
    links: [{ href: criblUiUrl(`/stream/m/${G}/inputs/datagen/in_gigamon_datagen`), label: 'DataGen source' }],
  },
  {
    id: 'pipeline', name: 'Cribl Stream · Pipeline gigamon_ami', kind: 'cribl', short: 'cast + derive',
    purpose:
      'Shapes the raw AMI JSON for analytics. Gigamon exports everything as strings, so the pipeline casts numerics and derives the fields the dashboards need but the feed does not carry directly.',
    detail: [
      'Casts numeric strings (bytes, packets, ports, RTT) to numbers.',
      'Derives src_subnet / dst_subnet / total_bytes / total_packets / l4_proto, plus http_server_ms and tcp_reset.',
    ],
    links: [{ href: criblUiUrl(`/stream/m/${G}/pipelines/gigamon_ami`), label: 'Pipeline editor' }],
  },
  {
    id: 'lake', name: `Cribl Lake · ${LAKE_DATASET}`, kind: 'cribl', short: 'destination + dataset',
    purpose:
      'Durable, queryable storage. The gigamon_lake destination writes the shaped JSON into the gigamon_ami Lake dataset on a ~60s flush, so Search sees data almost immediately while keeping 30 days of history. The diagram splits the two halves: the Destinations plate reports what the selected window wrote, the Cribl Lake card reports what the dataset HOLDS (summed writes over the retention period, independent of the range picker). Those coincide today because no data has aged out yet — once the feed passes 30 days, the held figure becomes "written" rather than "held".',
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
    id: 'app', name: 'This App · Gigamon Network Observability', kind: 'app', short: 'dashboards',
    purpose:
      'The presentation layer you are looking at. It runs inside Cribl as a sandboxed app and calls Cribl Search through the platform fetch proxy — no separate credentials, no data leaving the workspace.',
    detail: [
      'Service Map · Capacity · TCP Health · DNS Health · TLS Posture · Shadow AI · Field Explorer.',
      'Runs inside Cribl (sandboxed iframe) and calls Cribl Search via the platform fetch proxy.',
    ],
    links: [{ href: criblUiUrl('/apps'), label: 'Cribl Apps' }],
  },
]

/**
 * The line under the Lake total — and, once that total can come from yesterday's
 * scheduled run, the place its date has to appear.
 *
 * ONE LINE, not two. The card's label band is 12px per line and the provenance
 * chip sits 15px under the first one, so a second label line is drawn on top of
 * the chip. The "30d retention" it gives up when dated is still on this page
 * twice — in the toolbar note and in the stage's own ⓘ — while "as of" is a fact
 * about THIS number that appears nowhere else.
 */
export function lakeHeldLabel(
  v: Pick<Volume, 'lakeTotalEvents' | 'lakeTotalAt' | 'lakeTotalStale'>,
  now?: number,
): string {
  const held = `${fmtCount(v.lakeTotalEvents)} events held`
  const when = asOf(v.lakeTotalAt, now)
  if (!when) return `${held} · 30d retention`
  return `${held} · as of ${when}${v.lakeTotalStale ? ' (overdue)' : ''}`
}

/**
 * Block 4 of the Cribl Lake card's ⓘ: which run produced the figure on it.
 *
 * "Open in Search" is deliberately the answer to "how do I get a live one"
 * rather than a button on this page. A live run of this query bills 9,297.7
 * CPU-s; offering that as a click beside the card would hand every viewer the
 * cost this phase exists to remove, and Cribl Search is where a person who
 * really wants it can see what it is doing and stop it.
 */
export function lakeComputed(lakeTotal: Pick<UseSearchState, 'source' | 'at' | 'stale' | 'note'>): ComputedFrom {
  return {
    source: lakeTotal.source,
    at: lakeTotal.at,
    stale: lakeTotal.stale,
    cadence: LAKE_CADENCE,
    window: 'the last 30 days',
    fallback: lakeTotal.note,
    live: 'use “Open in Search” above — a live 30-day total is this app’s most expensive query, so it runs in Cribl Search where you can watch it and stop it',
    capSeconds: capSecondsFor(LAKE_EARLIEST),
  }
}

/**
 * Diagram nodes. The Cribl stages deliberately report the same event count —
 * that IS the point: nothing is dropped between source, pipeline, Lake and
 * Search. Only the framing changes per node. Title and label lines are authored
 * as arrays so long Cribl ids wrap inside the card rather than truncating.
 */
function buildNodes(v: Volume): Record<SlotId, DopNode> {
  return {
    // Source and destination are the artwork's label plates — no product mark,
    // since the group box around them already says Cribl Stream.
    sources: {
      id: 'datagen', title: ['Sources'], tier: 'cribl',
      sub: ['in_gigamon_datagen'],
      value: fmtCount(v.srcEvents),
      label: [`events out · ${Math.round(v.srcEvents / Math.max(1, v.windowSec))}/s`],
      from: 'cribl',
    },
    stream: {
      id: 'pipeline', title: ['Processing'], tier: 'cribl', icon: 'stream',
      sub: ['pipeline · gigamon_ami'],
      value: fmtCount(v.pipeEvents),
      label: [`events out · ${v.fields} fields`],
      from: 'cribl',
    },
    destinations: {
      id: 'lake', title: ['Destinations'], tier: 'cribl',
      sub: ['gigamon_lake'],
      value: fmtBytes(v.dstBytes),
      label: [`written this window · ${fmtCount(v.dstEvents)} events`],
      from: 'cribl',
    },
    lake: {
      id: 'lake', title: ['Cribl Lake'], tier: 'cribl', icon: 'lake',
      sub: [`${LAKE_DATASET} dataset`],
      value: v.lakeTotalLoading ? '…' : v.lakeTotalKnown ? fmtBytes(v.lakeTotalBytes) : '—',
      label: v.lakeTotalLoading
        ? ['totalling dataset… · 30d retention']
        : v.lakeTotalKnown
          ? [lakeHeldLabel(v)]
          : ['retention total unavailable'],
      from: 'cribl',
    },
    search: {
      id: 'search', title: ['Cribl Search'], tier: 'cribl', icon: 'search',
      value: fmtCount(v.events),
      label: ['events scanned by this app'],
      from: 'records',
    },
    app: {
      id: 'app', title: ['Cribl Apps'], tier: 'cribl', icon: 'apps',
      caption: ['Gigamon Network Observability'],
      // No figure: the app renders what Search already returned, and costs
      // nothing of its own. "events visualized" only restated Search's number.
    },
  }
}

/**
 * An ⓘ per node, so "what is this stage and where does it live in Cribl" is one
 * click away on the diagram itself rather than only on the selected stage below.
 * Destinations and Cribl Lake are two halves of the same stage, so they share one.
 */
function stageInfo(lake: ComputedFrom): Partial<Record<InfoKey, ReactNode>> {
  const of = (id: string, computed?: ComputedFrom) => {
    const s = STAGES.find((x) => x.id === id)!
    return <PanelInfo about={s.purpose} aboutHeading="What this stage does" links={s.links} computed={computed} />
  }
  return {
    gigasmart: of('gigasmart'),
    amx: of('amx'),
    sources: of('datagen'),
    stream: of('pipeline'),
    // Only the Cribl Lake card carries a figure that may come from a scheduled
    // run; Destinations shares this stage's prose but reports what the selected
    // window wrote, live, so it gets no "how this was computed" block.
    destinations: of('lake'),
    lake: of('lake', lake),
    search: of('search'),
    app: of('app'),
  }
}

/**
 * State of each connector, so a break shows up on the hop that actually broke
 * rather than dimming the whole diagram.
 */
function hopStates(v: Volume): Record<HopId, HopState> {
  const on = (n: number): HopState => (n > 0 ? 'on' : 'idle')
  return {
    wire: on(v.events),        // origins → the Gigamon pipe (inferred from records arriving)
    enriched: on(v.events),    // pipe → Cribl, via AMX
    ingest: on(v.srcEvents),   // into the platform → source
    process: on(v.srcEvents),  // source → pipeline
    store: on(v.pipeEvents),   // pipeline → Lake destination
    // Destination → dataset is where a blocked output or backpressure shows up.
    query: v.blocked > 0 || v.backpressure > 0 ? 'blocked' : on(v.dstEvents),
    render: on(v.events),      // dataset → Search → this app
  }
}

export function DataFlow() {
  const [sel, setSel] = useState<string>('datagen')
  const { range, setRange } = useDashboard()
  // Per-viewer: a reader who has turned acceleration off pays for the live
  // 30-day scan on every visit, which is the price stated beside that switch.
  const accelEnabled = useAccelEnabled()
  // Record-derived volume (what the AMI data itself says).
  const agg = useSearch(VOLUME_QUERY)
  // Cribl's own component telemetry for the Cribl stages.
  const met = useSearch(METRICS_QUERY)
  // Lake total is deliberately pinned to the retention period, NOT the page
  // range, and loads independently so its ~17s scan never blocks the diagram.
  // It is served by a daily scheduled run of this same string where there is one
  // (LAKE_ACCEL) and runs live where there is not — see the header.
  const lakeTotal = useSearch(LAKE_TOTAL_QUERY, { earliest: LAKE_EARLIEST, accel: LAKE_ACCEL, accelEnabled })
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
    lakeTotalKnown: !!lrow,
    lakeTotalAt: lakeTotal.at,
    lakeTotalStale: lakeTotal.stale,
  }
  const loading = agg.loading || met.loading
  const selected = STAGES.find((s) => s.id === sel)!

  return (
    <div className="tab">
      <div className="tab-intro dop-intro">
        <h2 className="tab-h dop-h">The Gigamon Deep Observability Pipeline</h2>
        <p className="dop-kicker">Transforming network traffic into trusted, network-derived intelligence</p>
        <p className="tab-sub">
          How Gigamon AMI data reaches these dashboards — from the packet broker, through Cribl Stream into
          Cribl Lake, and out via Cribl Search. Every node carries its live volume for the window below;
          click one for detail, or use its <strong>ⓘ</strong> to jump straight to that object in Cribl.
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
          AMI data itself. Every figure is scoped to the range above, except the <em>Cribl Lake</em> card, which reports
          the full 30-day retention{lakeTotal.source === 'schedule'
            ? <> from a scheduled daily run — the card says when that run finished, and its <strong>ⓘ</strong> says why</>
            : <> by totalling thirty days now</>}.
        </span>
      </div>

      <DopDiagram
        nodes={buildNodes(vol)}
        // Neither Gigamon nor AMX reports telemetry here, so both figures are
        // read back off the AMI records in Lake. Say what they actually count.
        wire={{ value: fmtBytes(vol.bytes), label: 'bytes in AMI flows' }}
        enriched={{ value: fmtCount(vol.events), label: 'AMI records received' }}
        hops={hopStates(vol)}
        selected={sel}
        onSelect={setSel}
        loading={loading}
        info={stageInfo(lakeComputed(lakeTotal))}
      />

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
          <p className="dop-stage-kicker">{selected.short}</p>
          <ul className="flow-detail">
            {selected.detail.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="dop-footer">
        <span className="dop-footer-brand">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden className="dop-cribl-mark">
            <path d="M4 5 L16 12 L4 19 Z" />
            <path d="M17.5 8.5 L21.5 12 L17.5 15.5 Z" />
          </svg>
          <strong>Cribl</strong>
          <span className="dop-footer-tag">The AI platform for telemetry</span>
        </span>
        <span className="dop-footer-sep" />
        <span className="dop-footer-brand">
          <span className="dop-footer-gg">Gigamon</span>
          <span className="dop-footer-tag">Deep Observability Pipeline</span>
        </span>
      </footer>
    </div>
  )
}
