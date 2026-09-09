/**
 * "The Gigamon Deep Observability Pipeline" — the Data Flow tab's hero diagram.
 *
 * Composition follows the Gigamon x Cribl architecture slide: traffic origins →
 * the Gigamon Deep Observability pipe → the Cribl platform. Presentation follows
 * the house Cribl dataflow standard (claude-kit standards/cribl-dataflow-diagram.md):
 * hand-written SVG (no React Flow, so the host palette wins), cards with centred
 * content / radius 12 / 1.4px border, tier conveyed by BADGE COLOUR rather than an
 * accent bar, labels wrapped rather than truncated, edges anchored to each card's
 * own mid-height, the dashed pipe animated in CSS (not SMIL — Firefox needs
 * unsafe-inline for a SMIL stroke-dashoffset) and packets riding the exact path
 * via <animateMotion>. Only live edges animate; prefers-reduced-motion stops all.
 *
 * Product icons are the real ones from `@capra/icons` (Stream / Search / Lake) and
 * `@capra/icons/logos` (Gigamon) — never redrawn by hand. Every card stacks
 * icon → title → config id → metric on one centre line, so nothing is optically
 * off-axis. Source, processing and destination additionally sit inside a subdued
 * group box, because all three are one product: Cribl Stream. That is also why the
 * processing card is titled "Processing" and not "Cribl Stream" — the group box
 * already says it.
 *
 * Geometry is authored, not solved: this is a fixed brand composition rather than
 * a config-derived graph, so there is no dagre pass. The component is pure — it
 * takes already-computed strings and renders them.
 */
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { AppsOutlined, Lake, Search, Stream } from '@capra/icons'


export type HopState = 'on' | 'idle' | 'blocked'

export type Tier = 'gigamon' | 'cribl' | 'app'

/** Which real product mark a card carries, if any. */
export type IconKey = 'stream' | 'search' | 'lake' | 'apps'

export interface DopNode {
  /** Stage id selected when this node is clicked. */
  id: string
  /** The card's primary label — large, bold, brand-coloured. */
  title: string[]
  tier: Tier
  icon?: IconKey
  /** Config ids, monospace — pre-wrapped so long ids break rather than truncate. */
  sub?: string[]
  /** Fine print under the title, body font rather than monospace. */
  caption?: string[]
  /** Omit all three when the node has no meaningful figure of its own. */
  value?: string
  /** Pre-wrapped metric caption lines. */
  label?: string[]
  from?: 'cribl' | 'records'
}

export type SlotId = 'sources' | 'stream' | 'destinations' | 'search' | 'lake' | 'app'
export type HopId = 'wire' | 'enriched' | 'ingest' | 'process' | 'store' | 'query' | 'render'

/**
 * A Gigamon-side figure. Neither Gigamon nor AMX reports telemetry to this app,
 * so both of these are computed from the AMI records after they land in Lake —
 * hence they always carry the "from records" provenance, same as a card.
 */
export interface DopFlowFigure {
  value: string
  label: string
}

export interface DopDiagramProps {
  nodes: Record<SlotId, DopNode>
  wire: DopFlowFigure
  enriched: DopFlowFigure
  hops: Record<HopId, HopState>
  selected: string
  onSelect: (id: string) => void
  loading: boolean
}

/* ---------- geometry (authored) ---------- */

const VB = { w: 1725, h: 785 }

/** The spine everything on the Gigamon side is centred on. */
const AXIS = 440

/** Traffic origins on the left rail. */
const ORIGINS = [
  { label: 'Data Center', y: 210, icon: 'rack' },
  { label: 'Private Cloud', y: 330, icon: 'cloud-lock' },
  { label: 'Public Cloud', y: 450, icon: 'cloud' },
  { label: 'Containers', y: 570, icon: 'cube' },
] as const

/** Gigamon's four in-pipe functions, straight off the slide. */
const PIPE_FNS = [
  { label: 'ACCESS', x: 420, icon: 'shield' },
  { label: 'BROKER', x: 510, icon: 'broker' },
  { label: 'TRANSFORM', x: 600, icon: 'transform' },
  { label: 'ENRICH', x: 690, icon: 'enrich' },
] as const

const GIGAMON_BULLETS = [
  'Acquires Raw Packets — No Blind Spots',
  'Deep Packet Inspection — Layers 2–7',
  'Encrypted Traffic Visibility',
  'Transforms Packets into Rich Logs',
]

const PIPE = { x0: 350, x1: 760, cy: AXIS, ry: 125, capRx: 27 }
/** The Cribl platform boundary. */
const BOX = { x: 940, y: 250, w: 765, h: 500 }
/** Source + processing + destination are all one product, so they get a group box. */
const STREAM_BOX = { x: 965, y: 340, w: 665, h: 200 }
/** Right-hand corridor Lake uses to climb back to Search. */
const RISER_X = 1668

/** The product mark's box. Cards without an icon simply close the gap. */
const ICON = 30

const CARDS: Record<SlotId, { x: number; y: number; w: number; h: number }> = {
  sources: { x: 985, y: 381, w: 185, h: 118 },
  stream: { x: 1202, y: 364, w: 196, h: 152 },
  destinations: { x: 1425, y: 381, w: 185, h: 118 },
  lake: { x: 1370, y: 570, w: 220, h: 152 },
  search: { x: 1175, y: 200, w: 250, h: 136 },
  app: { x: 1195, y: 72, w: 210, h: 100 },
}

const midY = (s: SlotId) => CARDS[s].y + CARDS[s].h / 2
const midX = (s: SlotId) => CARDS[s].x + CARDS[s].w / 2
const right = (s: SlotId) => CARDS[s].x + CARDS[s].w
const bottom = (s: SlotId) => CARDS[s].y + CARDS[s].h

/** Edge paths, anchored to each card's own mid-height. */
const HOP_PATHS: Record<HopId, string> = {
  wire: `M189,${AXIS} H315`,
  enriched: `M798,${AXIS} H${BOX.x}`,
  ingest: `M${BOX.x},${midY('sources')} H${CARDS.sources.x}`,
  process: `M${right('sources')},${midY('sources')} H${CARDS.stream.x}`,
  store: `M${right('stream')},${midY('stream')} H${CARDS.destinations.x}`,
  // Down out of the Cribl Stream group and across into Lake.
  query: `M${midX('destinations')},${bottom('destinations')} V555 H${midX('lake')} V${CARDS.lake.y}`,
  // Out of Lake's right side, up the right-hand corridor, into Search's right edge.
  render: `M${right('lake')},${midY('lake')} H${RISER_X} V262 H${right('search')}`,
}

/** Search → this app, which sits above Search rather than inside the platform. */
const APP_PATH = `M${midX('search')},${CARDS.search.y} V${bottom('app')}`

/* ---------- reduced motion ---------- */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return reduced
}

/* ---------- small pieces ---------- */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function Icon({ name, x, y, s = 1 }: { name: string; x: number; y: number; s?: number }) {
  const paths: Record<string, ReactNode> = {
    rack: (
      <>
        <rect x="-11" y="-10" width="22" height="8" rx="1.6" {...STROKE} />
        <rect x="-11" y="2" width="22" height="8" rx="1.6" {...STROKE} />
        <circle cx="-6" cy="-6" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="-6" cy="6" r="1.1" fill="currentColor" stroke="none" />
        <path d="M-1 -6 H7 M-1 6 H7" {...STROKE} />
      </>
    ),
    'cloud-lock': (
      <>
        <path d="M-11 4 a5 5 0 0 1 1.2 -9.8 a7.5 7.5 0 0 1 14.4 -1.2 a5.2 5.2 0 0 1 1.1 10.3 z" {...STROKE} />
        <rect x="-3.6" y="1.4" width="7.2" height="6" rx="1.2" {...STROKE} />
        <path d="M-1.6 1.4 v-1.8 a1.6 1.6 0 0 1 3.2 0 v1.8" {...STROKE} />
      </>
    ),
    cloud: <path d="M-11 5 a5 5 0 0 1 1.2 -9.8 a7.5 7.5 0 0 1 14.4 -1.2 a5.2 5.2 0 0 1 1.1 11 z" {...STROKE} />,
    cube: (
      <>
        <path d="M0 -11 L10 -5.5 V5.5 L0 11 L-10 5.5 V-5.5 Z" {...STROKE} />
        <path d="M-10 -5.5 L0 0 l10 -5.5 M0 0 V11" {...STROKE} />
      </>
    ),
    shield: (
      <>
        <path d="M0 -13 l10 4 v7 c0 6 -4.4 9.8 -10 11.6 C-5.6 7.8 -10 4 -10 -2 v-7 z" {...STROKE} />
        <path d="M-4.4 0 l3 3.2 l6 -6.6" {...STROKE} />
      </>
    ),
    broker: (
      <>
        <circle cx="0" cy="0" r="3" {...STROKE} />
        <path d="M0 -4.6 V-12 M0 4.6 V12 M-4.6 0 H-12 M4.6 0 H12" {...STROKE} />
        <path d="M-9 -9 l3.4 3.4 M9 -9 l-3.4 3.4 M-9 9 l3.4 -3.4 M9 9 l-3.4 -3.4" {...STROKE} />
      </>
    ),
    transform: (
      <>
        <circle cx="0" cy="0" r="4" {...STROKE} />
        <path d="M-11 -3 a11 11 0 0 1 18 -5" {...STROKE} />
        <path d="M11 3 a11 11 0 0 1 -18 5" {...STROKE} />
        <path d="M7 -11.4 l0.4 3.8 l-3.8 0.4 M-7 11.4 l-0.4 -3.8 l3.8 -0.4" {...STROKE} />
      </>
    ),
    enrich: (
      <>
        <path d="M-11 -1.6 l7.6 -7.6 h7.8 v7.8 l-7.6 7.6 z" {...STROKE} />
        <circle cx="1.2" cy="-4.4" r="1.5" {...STROKE} />
        <path d="M-3.4 3 l7.6 -7.6 h7.8 v7.8 l-7.6 7.6" {...STROKE} />
      </>
    ),
  }
  return <g transform={`translate(${x} ${y}) scale(${s})`}>{paths[name]}</g>
}

/**
 * The real product mark, nested as its own SVG viewport so it scales with the
 * diagram. Capra sizes its icons from an inline `--_size`, which would override
 * anything passed here, so `.dop-prod-icon > svg` in App.css pins the box —
 * a wrapper rule, not a dependency on Capra's generated class names.
 *
 * The Gigamon logo is fixed black artwork, so on a dark card it rides a light
 * chip rather than being recoloured.
 */
const MARKS = { stream: Stream, search: Search, lake: Lake, apps: AppsOutlined } as const

function ProductMark({ icon, cx, y }: { icon: IconKey; cx: number; y: number }) {
  const Mark = MARKS[icon]
  return (
    <g className="dop-prod-icon dop-prod-icon-cribl">
      <Mark x={cx - ICON / 2} y={y} width={ICON} height={ICON} />
    </g>
  )
}

/**
 * Where a number came from. Every figure on the diagram carries one, including
 * the two Gigamon-side ones — those are derived from the AMI records at rest in
 * Lake, not measured at the tap, and the diagram must not imply otherwise.
 */
function ProvChip({ x, y, from, tone }: { x: number; y: number; from: 'cribl' | 'records'; tone: 'card' | 'canvas' }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="-37" y="-9" width="74" height="14" rx="7"
        className={`dop-prov-bg ${tone === 'card' ? `dop-prov-${from}` : 'dop-prov-canvas'}`} />
      <text x="0" y="1.5" className={`dop-prov ${tone === 'card' ? `dop-prov-t-${from}` : 'dop-prov-t-canvas'}`}>
        {from === 'cribl' ? 'Cribl metrics' : 'from records'}
      </text>
    </g>
  )
}

/** Animated packets riding the exact edge path. SMIL animateMotion is CSP-safe. */
function Packets({ id, state, reduced }: { id: string; state: HopState; reduced: boolean }) {
  if (state !== 'on' || reduced) return null
  return (
    <>
      {[0, 1.1, 2.2].map((begin) => (
        <circle key={begin} r="3.6" className="dop-packet">
          <animateMotion dur="3.3s" begin={`${begin}s`} repeatCount="indefinite">
            <mpath href={`#${id}`} />
          </animateMotion>
        </circle>
      ))}
    </>
  )
}

/** Marks the hop that actually broke, rather than dimming the whole diagram. */
function HopFlag({ d, state }: { d: string; state: HopState }) {
  const m = d.match(/M(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (!m) return null
  return (
    <text x={Number(m[1]) + 16} y={Number(m[2]) - 10} className={`dop-flag dop-flag-${state}`}>
      {state === 'blocked' ? 'blocked' : 'no data'}
    </text>
  )
}

function Hop({ id, d, state, reduced, brand = 'teal', arrow }: {
  id: HopId | 'app'; d: string; state: HopState; reduced: boolean; brand?: 'orange' | 'teal' | 'ink'; arrow?: boolean
}) {
  const pathId = `dop-hop-${id}`
  return (
    <g className={`dop-hop dop-hop-${state} dop-hop-${brand}`}>
      <path
        id={pathId}
        d={d}
        className={`dop-edge dop-edge-${brand}`}
        markerEnd={arrow ? `url(#dop-arrow-${brand === 'orange' ? 'orange' : 'ink'})` : undefined}
      />
      <path d={d} className={`dop-edge-dash ${state === 'on' && !reduced ? 'dop-edge-live' : ''}`} />
      <Packets id={pathId} state={state} reduced={reduced} />
      {state !== 'on' && <HopFlag d={d} state={state} />}
    </g>
  )
}

function Card({ slot, n, selected, onSelect, loading }: {
  slot: SlotId; n: DopNode; selected: boolean; onSelect: (id: string) => void; loading: boolean
}) {
  const { x, y, w, h } = CARDS[slot]
  const cx = x + w / 2

  // One centre line, walked top to bottom, so a card with no icon or no config
  // id simply closes the gap instead of leaving a hole.
  let cursor = y + 14
  const iconY = cursor
  if (n.icon) cursor += ICON + 4
  const titleYs = n.title.map((_, i) => cursor + 16 + i * 21)
  cursor = titleYs[titleYs.length - 1]
  const subYs = (n.sub ?? []).map((_, i) => cursor + 16 + i * 12)
  if (subYs.length) cursor = subYs[subYs.length - 1]
  const capYs = (n.caption ?? []).map((_, i) => cursor + 15 + i * 12)
  if (capYs.length) cursor = capYs[capYs.length - 1]
  const hasMetric = n.value !== undefined
  const ruleY = cursor + 10
  const valueY = ruleY + 20
  const labelYs = (n.label ?? []).map((_, i) => valueY + 14 + i * 12)

  return (
    <g
      className={`dop-card dop-card-${n.tier} ${selected ? 'dop-card-sel' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${n.title.join(' ')} ${(n.caption ?? []).join(' ')} ${(n.sub ?? []).join(' ')}${hasMetric ? ` — ${n.value} ${(n.label ?? []).join(' ')}` : ''}`}
      onClick={() => onSelect(n.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(n.id)
        }
      }}
    >
      <rect x={x} y={y} width={w} height={h} rx="12" className="dop-card-bg" />
      {n.icon && <ProductMark icon={n.icon} cx={cx} y={iconY} />}
      {n.title.map((t, i) => (
        <text key={t} x={cx} y={titleYs[i]} className={`dop-title dop-title-${n.tier}`}>{t}</text>
      ))}
      {(n.sub ?? []).map((s, i) => (
        <text key={s} x={cx} y={subYs[i]} className="dop-card-sub">{s}</text>
      ))}
      {(n.caption ?? []).map((c, i) => (
        <text key={c} x={cx} y={capYs[i]} className="dop-card-caption">{c}</text>
      ))}
      {hasMetric && <line x1={x + 14} y1={ruleY} x2={x + w - 14} y2={ruleY} className="dop-card-rule" />}
      {hasMetric && (loading ? (
        <text x={cx} y={valueY} className="dop-value dop-value-idle">…</text>
      ) : (
        <>
          <text x={cx} y={valueY} className="dop-value">{n.value}</text>
          {(n.label ?? []).map((l, i) => (
            <text key={l} x={cx} y={labelYs[i]} className="dop-card-label">{l}</text>
          ))}
          <ProvChip x={cx} y={y + h - 13} from={n.from ?? 'records'} tone="card" />
        </>
      ))}
    </g>
  )
}

/* ---------- the diagram ---------- */

export function DopDiagram({ nodes, wire, enriched, hops, selected, onSelect, loading }: DopDiagramProps) {
  const reduced = usePrefersReducedMotion()
  const activate = (id: string) => (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(id)
    }
  }

  return (
    <div className="dop-wrap" data-tour="data-flow">
      <svg
        viewBox={`0 0 ${VB.w} ${VB.h}`}
        className="dop-svg"
        role="img"
        aria-label="The Gigamon Deep Observability Pipeline feeding the Cribl platform"
      >
        <defs>
          <linearGradient id="dop-pipe" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--dop-pipe-1)" />
            <stop offset="22%" stopColor="var(--dop-pipe-2)" />
            <stop offset="55%" stopColor="var(--dop-pipe-3)" />
            <stop offset="82%" stopColor="var(--dop-pipe-2)" />
            <stop offset="100%" stopColor="var(--dop-pipe-1)" />
          </linearGradient>
          <linearGradient id="dop-cap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff9142" />
            <stop offset="55%" stopColor="#f60" />
            <stop offset="100%" stopColor="#d24a00" />
          </linearGradient>
          <marker id="dop-arrow-ink" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="dop-arrowhead-ink" />
          </marker>
          <marker id="dop-arrow-orange" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#f60" />
          </marker>
        </defs>

        {/* ---- left rail: where the traffic comes from ---- */}
        <g className="dop-origins">
          {ORIGINS.map((o) => (
            <g key={o.label}>
              <g className="dop-origin-icon"><Icon name={o.icon} x={85} y={o.y} s={1.35} /></g>
              <text x={85} y={o.y + 40} className="dop-origin-label">{o.label}</text>
            </g>
          ))}
          <path d="M165,190 H187 V610 H165" className="dop-bracket" />
        </g>

        {/* ---- network traffic → the pipe ---- */}
        <Hop id="wire" d={HOP_PATHS.wire} state={hops.wire} reduced={reduced} brand="ink" arrow />
        <text x={252} y={AXIS - 28} className="dop-flow-title">Network Traffic</text>
        {!loading && (
          <>
            <text x={252} y={AXIS + 26} className="dop-flow-value">{wire.value}</text>
            <text x={252} y={AXIS + 40} className="dop-flow-label">{wire.label}</text>
            <ProvChip x={252} y={AXIS + 58} from="records" tone="canvas" />
          </>
        )}

        {/* ---- Gigamon's claim, above the pipe ---- */}
        <text x={400} y={106} className="dop-bullets-h">Gigamon</text>
        {GIGAMON_BULLETS.map((b, i) => (
          <g key={b}>
            <circle cx={408} cy={138 + i * 32} r="2.6" className="dop-bullet-dot" />
            <text x={422} y={142 + i * 32} className="dop-bullet">{b}</text>
          </g>
        ))}

        {/* ---- the Deep Observability pipe (= GigaVUE / GigaSMART) ---- */}
        <g
          className={`dop-pipe ${selected === 'gigasmart' ? 'dop-pipe-sel' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Gigamon Deep Observability Pipeline — GigaVUE and GigaSMART"
          onClick={() => onSelect('gigasmart')}
          onKeyDown={activate('gigasmart')}
        >
          {/* Body first, then each rim concentrically on top of it: painting the
              body over a rim is what made the far end read as an orange slab
              rather than an opening seen down the bore. */}
          <rect x={PIPE.x0} y={PIPE.cy - PIPE.ry} width={PIPE.x1 - PIPE.x0} height={PIPE.ry * 2} fill="url(#dop-pipe)" />
          <line x1={PIPE.x0} y1={PIPE.cy - PIPE.ry} x2={PIPE.x1} y2={PIPE.cy - PIPE.ry} className="dop-pipe-edge" />
          <line x1={PIPE.x0} y1={PIPE.cy + PIPE.ry} x2={PIPE.x1} y2={PIPE.cy + PIPE.ry} className="dop-pipe-edge" />
          {/* far rim + the orange bore */}
          <ellipse cx={PIPE.x1} cy={PIPE.cy} rx={PIPE.capRx + 4} ry={PIPE.ry + 9} className="dop-pipe-collar" />
          <ellipse cx={PIPE.x1} cy={PIPE.cy} rx={PIPE.capRx - 6} ry={PIPE.ry - 8} fill="url(#dop-cap)" className="dop-pipe-bore" />
          {/* near rim, closed */}
          <ellipse cx={PIPE.x0} cy={PIPE.cy} rx={PIPE.capRx + 4} ry={PIPE.ry + 9} className="dop-pipe-collar" />
          <ellipse cx={PIPE.x0} cy={PIPE.cy} rx={PIPE.capRx - 6} ry={PIPE.ry - 8} className="dop-pipe-mouth" />

          <rect x={485} y={348} width={140} height={30} rx="4" fill="#f60" />
          <text x={555} y={369} className="dop-gg-mark">
            Gigamon<tspan className="dop-gg-r" dy="-6">®</tspan>
          </text>
          <text x={555} y={416} className="dop-pipe-h">Deep Observability</text>
          <line x1={427} y1={438} x2={477} y2={438} className="dop-pipe-rule" />
          <line x1={633} y1={438} x2={683} y2={438} className="dop-pipe-rule" />
          <text x={555} y={444} className="dop-pipe-sub">PIPELINE</text>
          {PIPE_FNS.map((f) => (
            <g key={f.label}>
              <g className="dop-pipe-icon"><Icon name={f.icon} x={f.x} y={498} s={1.15} /></g>
              <text x={f.x} y={544} className="dop-pipe-fn">{f.label}</text>
            </g>
          ))}
        </g>

        {/* ---- enriched metadata → Cribl (= the AMX exporter) ---- */}
        <g
          className={`dop-amx ${selected === 'amx' ? 'dop-amx-sel' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Application Metadata Exporter — enriched metadata into Cribl"
          onClick={() => onSelect('amx')}
          onKeyDown={activate('amx')}
        >
          <rect x={798} y={395} width={142} height={90} rx="10" className="dop-amx-hit" />
          <Hop id="enriched" d={HOP_PATHS.enriched} state={hops.enriched} reduced={reduced} brand="orange" arrow />
          <text x={855} y={AXIS - 28} className="dop-flow-title dop-flow-orange">Enriched Metadata</text>
          {!loading && (
            <>
              <text x={855} y={AXIS + 26} className="dop-flow-value dop-flow-orange">{enriched.value}</text>
              <text x={855} y={AXIS + 40} className="dop-flow-label">{enriched.label}</text>
              <ProvChip x={855} y={AXIS + 58} from="records" tone="canvas" />
            </>
          )}
        </g>

        {/* ---- the Cribl platform ---- */}
        <rect x={BOX.x} y={BOX.y} width={BOX.w} height={BOX.h} rx="22" className="dop-box" />
        <text x={BOX.x + 22} y={BOX.y + BOX.h - 18} className="dop-box-label">CRIBL PLATFORM</text>

        {/* Source, processing and destination are one product — say so once, here. */}
        <rect x={STREAM_BOX.x} y={STREAM_BOX.y} width={STREAM_BOX.w} height={STREAM_BOX.h} rx="16" className="dop-group" />
        <text x={STREAM_BOX.x + 20} y={STREAM_BOX.y + 24} className="dop-group-label">CRIBL STREAM</text>

        <Hop id="ingest" d={HOP_PATHS.ingest} state={hops.ingest} reduced={reduced} />
        <Hop id="process" d={HOP_PATHS.process} state={hops.process} reduced={reduced} />
        <Hop id="store" d={HOP_PATHS.store} state={hops.store} reduced={reduced} />
        <Hop id="query" d={HOP_PATHS.query} state={hops.query} reduced={reduced} />
        <Hop id="render" d={HOP_PATHS.render} state={hops.render} reduced={reduced} />
        <Hop id="app" d={APP_PATH} state={hops.render} reduced={reduced} />

        {(Object.keys(CARDS) as SlotId[]).map((slot) => (
          <Card
            key={slot}
            slot={slot}
            n={nodes[slot]}
            selected={selected === nodes[slot].id}
            onSelect={onSelect}
            loading={loading}
          />
        ))}
      </svg>
    </div>
  )
}
