import { useState, type ReactNode } from 'react'
import { useAccelEnabled, useSearch, type UseSearchState } from '../cribl/useSearch'
import { VOLUME_QUERY, METRICS_QUERY } from '../queries/dataFlow'
import { criblUiUrl, STREAM_GROUP, LAKE_DATASET } from '../cribl/config'
import { capSecondsFor } from '../cribl/search'
import { accelEntry, type AccelId } from '../cribl/accel/manifest'
import { LAKE_DEFAULT_WINDOW, windowDays } from '../queries/lakeWindow'
import { useLakeFacts } from '../cribl/lakeWindowRead'
import { windowMinutes } from '../cribl/accel/estimate'
import { SNAPSHOT_WINDOW } from '../cribl/accel/words'
import { useDashboard, TIME_RANGES } from '../app/DashboardContext'
import { asOf, PanelInfo, type ComputedFrom } from '../components/PanelInfo'
import { DopDiagram, type DopNode, type HopId, type HopState, type InfoKey, type SlotId } from '../components/DopDiagram'
import { mergeSnapshotStates, useSnapshotSlot } from '../components/snapshotCensus'
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
/** The window when the dataset's retention could not be read — the manifest's
 *  own default. Where it can be read, the window IS the retention
 *  (src/queries/lakeWindow.ts), and the card states whichever window its figure
 *  actually covers. Never the page's range. */
const LAKE_DEFAULT_EARLIEST = LAKE_DEFAULT_WINDOW.earliest
/** The schedule in words, for the card's ⓘ. DataFlow.test.tsx holds this against
 *  the manifest's own cron, so changing one forces the other. */
export const LAKE_CADENCE = 'once a day, at 00:10 UTC'

/**
 * The scheduled search behind the Cribl stage counters — the last live query on
 * this tab.
 *
 * The two figures beside it have been served since Phase 2: the record-derived
 * volumes read the hourly overview scan and the Lake total reads its own daily
 * run. This one query was what kept the whole diagram reporting LIVE, and an
 * undated diagram is the one thing the merge below could not fix.
 *
 * THE WINDOW IS THE POINT HERE, not the cost. METRICS_QUERY sums counters, so
 * the window is not a sample of a population — it IS the interval being counted,
 * and every figure on the diagram scales with it. The entry therefore reads the
 * same fifteen settled minutes the overview scan does, because the diagram's
 * whole claim is that the record-derived count and the telemetry count AGREE.
 * Served over different lengths they would not, and the shortfall would read as
 * data being dropped between two stages.
 */
const PIPELINE_ACCEL: AccelId = 'gno_pipeline_c1h'
const PIPELINE_ENTRY = accelEntry(PIPELINE_ACCEL)
/** The schedule in words, for the stage ⓘs. DataFlow.test.tsx holds these
 *  against the manifest's own cron and window, so moving one forces the other. */
export const PIPELINE_CADENCE = 'once an hour, at 24 minutes past, in UTC'
export const PIPELINE_WINDOW = SNAPSHOT_WINDOW
/**
 * How many seconds of data a served run of it covers.
 *
 * Read off the manifest and off BOTH bounds, which `windowSeconds('-18m')` would
 * not do: the window is -18m…-3m, so it is fifteen minutes and not eighteen.
 * The rate under the Sources plate divides an event count by this, and dividing
 * a fifteen-minute count by the picker's twenty-four hours would report a rate
 * ninety-six times too low — formatted exactly like a correct one.
 */
const PIPELINE_WINDOW_SECONDS = (windowMinutes(PIPELINE_ENTRY) ?? 15) * 60

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
  /** Days the event count covers — the run's own window, or the live query's.
   *  Null when neither can be read. */
  lakeWindowDays: number | null
  /** The dataset's retention today, from the Lake API. */
  lakeRetentionDays: number | null
  /** What Cribl Lake says the dataset occupies on disk, and the day it said so. */
  lakeStoredBytes: number | null
  lakeStoredAsOf: string | null
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
      'Durable, queryable storage. The gigamon_lake destination writes the shaped JSON into the gigamon_ami Lake dataset on a ~60s flush, so Search sees data almost immediately while keeping history for the dataset’s retention period. The diagram splits the two halves: the Destinations plate reports what the selected window wrote; the Cribl Lake card reports what the dataset HOLDS over its whole retention period, independent of the range picker — the events counted over that period, and the size Cribl Lake reports the dataset occupies on disk.',
    detail: [
      'Destination gigamon_lake (type cribl_lake) writes JSON to the gigamon_ami Lake dataset.',
      'Retention as set on the dataset (the Cribl Lake card states it); flushes every ~60s for near-live queries.',
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
      'Flow Map · Capacity · TCP Health · DNS Health · TLS Posture · Shadow AI · Field Explorer.',
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
  v: Pick<Volume, 'lakeTotalEvents' | 'lakeTotalAt' | 'lakeTotalStale' | 'lakeWindowDays' | 'lakeRetentionDays'>,
  now?: number,
): string {
  // The window the FIGURE covers — the run's own, or the live query's — not the
  // retention the dataset has today. They differ after a retention change until
  // the schedule is re-applied, and then the card says so rather than putting a
  // month's count under a year's label.
  const w = v.lakeWindowDays
  const over = w === null ? 'events held' : `events · ${w}d`
  const held = `${fmtCount(v.lakeTotalEvents)} ${over}`
  const moved = w !== null && v.lakeRetentionDays !== null && v.lakeRetentionDays !== w ? ` · retention now ${v.lakeRetentionDays}d` : ''
  const when = asOf(v.lakeTotalAt, now)
  if (!when) return `${held}${moved}`
  return `${held} · as of ${when}${v.lakeTotalStale ? ' (overdue)' : ''}${moved}`
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
export function lakeComputed(
  lakeTotal: Pick<UseSearchState, 'source' | 'at' | 'stale' | 'note'>,
  windowDays: number | null,
): ComputedFrom {
  const span = windowDays === null ? 'the retention period' : `the last ${windowDays} days`
  return {
    source: lakeTotal.source,
    at: lakeTotal.at,
    stale: lakeTotal.stale,
    cadence: LAKE_CADENCE,
    window: span,
    fallback: lakeTotal.note,
    live: `use “Open in Search” above — a live total over ${span} is this app’s most expensive query, so it runs in Cribl Search where you can watch it and stop it`,
    capSeconds: capSecondsFor(windowDays === null ? LAKE_DEFAULT_EARLIEST : `-${windowDays}d`),
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
      // The size is Cribl Lake's own daily metric — what the dataset occupies
      // on disk — dated by the day it was computed. It used to be the bytes
      // Stream WROTE, which is uncompressed: 1.01 TB against 110.5 GB stored,
      // measured 2026-09-23.
      sub: [v.lakeStoredAsOf ? `${LAKE_DATASET} · stored as of ${v.lakeStoredAsOf}` : `${LAKE_DATASET} dataset`],
      value: v.lakeStoredBytes !== null ? fmtBytes(v.lakeStoredBytes) : '—',
      label: v.lakeTotalLoading
        ? [v.lakeRetentionDays !== null ? `counting ${v.lakeRetentionDays}d retention…` : 'counting the retention period…']
        : v.lakeTotalKnown
          ? [lakeHeldLabel(v)]
          : ['event count unavailable'],
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
function stageInfo(lake: ComputedFrom, telemetry: ComputedFrom): Partial<Record<InfoKey, ReactNode>> {
  const of = (id: string, computed?: ComputedFrom) => {
    const s = STAGES.find((x) => x.id === id)!
    return <PanelInfo about={s.purpose} aboutHeading="What this stage does" links={s.links} computed={computed} />
  }
  return {
    // No "how this was computed" on these two: both figures are read back off
    // the AMI records rather than from any counter, and they follow the volume
    // query's own provenance, which the diagram's caption already carries.
    gigasmart: of('gigasmart'),
    amx: of('amx'),
    // The three plates that read cribl_metrics. Each one now carries where its
    // counter came from, because each can answer from the hourly run — a figure
    // from a stored run is never shown undated, and these have a title and an ⓘ
    // of their own inside the diagram.
    sources: of('datagen', telemetry),
    stream: of('pipeline', telemetry),
    // Destinations shares the Lake stage's prose but reports what the window
    // WROTE, which is a cribl_metrics counter — so it takes the telemetry
    // provenance, not the Lake card's daily one.
    destinations: of('lake', telemetry),
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
  // Served by the hourly overview scan, which carries these three aggregates
  // alongside four other panels' — one scan instead of five.
  const agg = useSearch(VOLUME_QUERY, { accel: 'gno_overview_c1h', accelPanel: 'data-flow-volume', accelEnabled })
  // Cribl's own component telemetry for the Cribl stages, served by its own
  // hourly run of the same string over the same fifteen minutes the volume
  // figures beside it read. See PIPELINE_ACCEL: this was the last live query on
  // the tab, and the reason the diagram reported LIVE with the two figures
  // either side of it already coming from stored runs.
  const met = useSearch(METRICS_QUERY, { accel: PIPELINE_ACCEL, accelEnabled })
  // Lake total is pinned to the DATASET'S RETENTION, NOT the page range, and
  // loads independently so its scan never blocks the diagram. The window and
  // the counting method come from the tenant (src/queries/lakeWindow.ts): the write
  // counters while the retention fits inside cribl_metrics' own, a direct count
  // of gigamon_ami beyond it. It waits for that read before its first run, so a
  // tenant on 365 days never briefly runs the 30-day default. It is served by a
  // daily scheduled run where there is one (LAKE_ACCEL) and runs live where
  // there is not — see the header. In LIVE mode too (`snapshotInLive`): a
  // retention total does not move between the daily run and now by anything
  // worth its scan on every Refresh. NOT given `accelEnabled`: that is
  // `mode === 'snapshot'` (accel/mode.ts), so passing it would switch the card
  // to live in exactly the mode this opts out of.
  const lake = useLakeFacts()
  const lakeWin = lake?.window ?? null
  const lakeRead = lakeWin ?? LAKE_DEFAULT_WINDOW
  const lakeEarliest = lakeRead.earliest
  const lakeTotal = useSearch(lakeRead.query, {
    earliest: lakeEarliest,
    accel: LAKE_ACCEL,
    snapshotInLive: true,
    deferred: lake === undefined,
  })
  // THE CENSUS, ON A TAB THAT RENDERS NO <Panel>. Registration normally happens
  // inside <Panel>, because that is the customer's unit — one card, one title,
  // one ⓘ. This tab draws a diagram and a stage-detail card instead, so nothing
  // registered and the header read `Snapshot · nothing on this tab reads a
  // query` on the tab that motivated the whole phase: three searches run here,
  // ALL THREE now served from schedules, one of them the 9,297.7 CPU-s Lake
  // total. (It said "two of them" until gno_pipeline_c1h landed.)
  //
  // Two slots, because the tab's own toolbar already tells the reader these are
  // two provenances and not one:
  //   * the diagram's volumes — record-derived (`agg`, hourly) beside Cribl's
  //     own telemetry (`met`, hourly since gno_pipeline_c1h). Still merged, and
  //     the merge is what makes the answer honest in BOTH directions: with both
  //     served it reports the older of the two runs, and the moment either one
  //     falls back to live it reports LIVE again, because a picture half of
  //     which ran a moment ago may not carry a snapshot date.
  //     mergeSnapshotStates's rule, and the same one Security's grid follows.
  //   * the Cribl Lake card, which has a title and an ⓘ of its own inside the
  //     diagram and is served by its own daily run. It is the figure a reader
  //     would be misled about, so it is counted separately rather than folded
  //     into a merge that would always drag it to live.
  //
  // The stage-detail card below is deliberately NOT a third: it re-reads the
  // same `met` figures the diagram node above it already carries, and counting
  // one query twice would inflate the denominator the header quotes.
  useSnapshotSlot(
    mergeSnapshotStates([
      { source: agg.source, outcome: agg.outcome, at: agg.at, stale: agg.stale, nearestAt: agg.nearestAt },
      { source: met.source, outcome: met.outcome, at: met.at, stale: met.stale, nearestAt: met.nearestAt },
    ]),
  )
  useSnapshotSlot({
    source: lakeTotal.source,
    outcome: lakeTotal.outcome,
    at: lakeTotal.at,
    stale: lakeTotal.stale,
    nearestAt: lakeTotal.nearestAt,
  })

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
    // The window the TELEMETRY was counted over, which is the only thing this
    // is used for (the events/second under the Sources plate). Once `met` can
    // answer from a stored run, that is the schedule's fifteen minutes and not
    // whatever the picker says — see PIPELINE_WINDOW_SECONDS.
    windowSec: met.source === 'schedule' ? PIPELINE_WINDOW_SECONDS : windowSeconds(range.earliest),
    lakeTotalEvents: toNum(lrow?.total_events),
    lakeTotalBytes: toNum(lrow?.total_bytes),
    lakeTotalLoading: lakeTotal.loading,
    lakeTotalKnown: !!lrow,
    lakeTotalAt: lakeTotal.at,
    lakeTotalStale: lakeTotal.stale,
    // The window the count covers: the stored run's own, or — on a live read —
    // the one this page asked for.
    lakeWindowDays: windowDays(lakeTotal.source === 'schedule' ? (lakeTotal.runWindow ?? null) : lakeEarliest),
    lakeRetentionDays: lakeWin?.retentionDays ?? null,
    lakeStoredBytes: lake?.storedBytes ?? null,
    lakeStoredAsOf: lake?.storedAsOf ?? null,
  }
  const loading = agg.loading || met.loading
  /** Where the three cribl_metrics plates got their counters, for block 4 of
   *  each one's ⓘ. */
  const metComputed: ComputedFrom = {
    source: met.source,
    at: met.at,
    stale: met.stale,
    cadence: PIPELINE_CADENCE,
    window: PIPELINE_WINDOW,
    fallback: met.note,
    live: 'switch the header to Live — this counter is cheap to run, unlike the Lake total below it',
    capSeconds: capSecondsFor(met.source === 'schedule' ? PIPELINE_ENTRY.earliest : range.earliest),
  }
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
        {/* THE RANGE SENTENCE USED TO SAY "every figure is scoped to the range
            above", and by the time the telemetry was served that was true of
            neither side of the diagram: the record-derived volumes read the
            hourly overview scan and the counters read their own hourly run.
            Both read the same fifteen settled minutes, which is what keeps the
            two sides comparable — and that is worth saying, because the whole
            diagram is an argument that they agree. */}
        <span className="flow-tb-note">
          <span className="prov prov-cribl">Cribl metrics</span> = component telemetry from{' '}
          <code>cribl_metrics</code>; <span className="prov prov-records">from records</span> = computed from the
          AMI data itself.{agg.source === 'schedule' || met.source === 'schedule'
            ? <> The diagram{agg.source === met.source ? "'s two sides both read" : ' reads'} the same settled fifteen
              minutes from an hourly run, so the stages still compare — each plate&apos;s <strong>ⓘ</strong> says
              which run it read. The range above applies to whatever is still running live.</>
            : <> Every figure is scoped to the range above.</>} The <em>Cribl Lake</em> card is separate either way: it
          reports the dataset’s full {lakeWin ? `${lakeWin.retentionDays}-day ` : ''}retention{lakeTotal.source === 'schedule'
            ? <> from a scheduled daily run — the card says when that run finished, and its <strong>ⓘ</strong> says why</>
            : <> by counting it now</>}.
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
        info={stageInfo(lakeComputed(lakeTotal, vol.lakeWindowDays), metComputed)}
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
              : <><span className={`flow-pulse ${vol.dstEvents > 0 ? 'flow-pulse-on' : ''}`} />{fmtCount(vol.dstEvents)} events into Lake · {
                  // This is a cribl_metrics counter, so it answers for the
                  // window that counted it. Labelling a fifteen-minute figure
                  // "last 24 hours" because the picker says so is the one
                  // mislabelling a reader cannot catch.
                  met.source === 'schedule' ? 'hourly snapshot · 15 min' : range.label.toLowerCase()
                }</>}
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
