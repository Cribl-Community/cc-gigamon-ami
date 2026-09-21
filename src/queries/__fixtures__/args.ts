// What the query freeze binds a builder's arguments to.
//
// Two declarations, for two different jobs:
//
//   FIXTURES  stands in for a value that only exists at runtime — the resolver
//             row the customer clicked, the server name in a drill link. There
//             is no domain to enumerate for those: one documented example is the
//             honest freeze, and it is frozen too, so editing it moves the
//             snapshot. Where there IS a domain — a panel rendered once per
//             family, a link rendered once per finding — `$each` names it and
//             the surface is frozen once per rendered row, not once.
//
//   VARIANTS  names the DOMAIN of every builder exported by src/queries, so the
//             freeze covers every branch rather than one sampled argument tuple.
//             A fixture pinned pivot='app_name' while the tab's own default is
//             'src_ip' — the first screen every customer sees was outside the
//             freeze, and so was every untaken ternary inside a builder and
//             sixteen of seventeen catalog filters. The domains already exist
//             next to the builders (PIVOTS, METRICS, Mask, FINDINGS, TECHNIQUES,
//             AMI_FAMILIES, AMI_USE_CASES); these expressions read them.
//
// The arguments a tab runs on FIRST PAINT are not declared here at all: the
// extractor reads each tab's `useState(<literal>)` defaults and binds those, so
// the frozen surface is the screen the customer actually lands on. A fixture
// still wins over a default, for the values a default cannot supply (a selected
// heatmap cell starts as null, and null renders no panel).
//
// NEVER TRANSCRIBE AN IMPORTABLE DATUM. A hand-copied catalog row drifts from
// the catalog it claims to sample and the snapshot keeps insisting it is fine,
// so anything that exists in src/data is read from there with `$expr`.
//
// Nothing here may import a .tsx: the extractor loads this module under plain
// Node. Plain data and expression strings only.

/** Call an exported builder to produce the fixture, rather than inlining its output. */
export interface CallFixture {
  $call: string
  args: unknown[]
}

/** Read the real catalog, in the tab's own scope, rather than transcribing a row of it. */
export interface ExprFixture {
  $expr: string
}

/**
 * Name the whole DOMAIN a surface is rendered over, rather than one row of it.
 *
 * A panel inside a `.map()` is one component in the source and seven panels on
 * the screen, and freezing it once froze one of the seven. Everything that
 * depends on an `$each` fixture — the ⓘ, the search, the deep link, the Copilot
 * brief — is frozen once per case, keyed by the case's own label. Same idea as
 * VARIANTS, applied to what is RENDERED rather than to what is exported.
 */
export interface EachFixture {
  /** An expression yielding `[{ label, value }]`, evaluated in the tab's scope. */
  $each: string
}

/** How a builder's arguments are enumerated, so every branch is frozen. */
export interface VariantSpec {
  /** One expression per parameter, each resolving to an array: the cross-product is frozen. */
  over?: string[]
  /** …or one expression yielding `[{ label, args }]`, where a domain has to be derived. */
  cases?: string
  /** Freeze the cases as a single digest — for a domain too large to read line by line. */
  digest?: boolean
}

export const FIXTURES: Record<string, Record<string, unknown>> = {
  'src/tabs/DnsHealth.tsx': {
    // The resolver row the customer clicked, drilled into Cribl Search.
    host: '10.0.0.53',
  },

  'src/tabs/DataFlow.tsx': {
    // Every stage of the Deep Observability Pipeline. Each diagram node's ⓘ is
    // built as <PanelInfo about={s.purpose} links={s.links} /> inside a helper,
    // so without this the whole tab froze no customer-facing words at all.
    // Read from STAGES itself, so editing a stage's purpose moves the snapshot.
    s: { $each: 'STAGES.map((x) => ({ label: x.id, value: x }))' } satisfies EachFixture,
  },

  'src/tabs/FieldExplorer.tsx': {
    // Every coverage section, not one of them: the family panels are rendered
    // inside AMI_FAMILIES.map(), so one frozen entry left six unguarded.
    // sectionQuery() reads only `.f.name`; the rows come from the catalog, so
    // adding a DNS field moves this too.
    rows: {
      $each: 'AMI_FAMILIES.map((fam) => ({ label: fam, value: AMI_CATALOG.filter((f) => f.family === fam).map((f) => ({ f })) }))',
    } satisfies EachFixture,
    // Every use case, each carrying its own field list.
    uc: { $each: 'AMI_USE_CASES.map((x) => ({ label: x.name, value: x }))' } satisfies EachFixture,
  },

  'src/tabs/Findings.tsx': {
    // Every finding a customer can launch, not just the first: each row renders
    // its own "Flows ↗" deep link and its own Copilot brief, and sixteen of the
    // seventeen briefs were outside the freeze. Keyed by id, the same treatment
    // findingFlowsQuery gets from VARIANTS.
    f: { $each: 'FINDINGS.map((x) => ({ label: x.id, value: { ...x, count: 4210 } }))' } satisfies EachFixture,
    // Window totals the brief quotes back to the agent.
    total: 1284000,
    range: { label: 'Last 15 minutes', earliest: '-15m' },
  },

  'src/tabs/PqcReadiness.tsx': {
    // The worklist row's filter, built the way the tab builds it — through the
    // exported fragment, so serverFilter's text is frozen here too.
    filter: { $call: 'serverFilter', args: ['login.example.com'] } satisfies CallFixture,
  },

  'src/tabs/Security.tsx': {
    // The selected ATT&CK technique. Only flow-signal techniques run a query;
    // drillQueryFor() reads `.kind` and `.filter`. Every technique is frozen by
    // VARIANTS; this is the one the drill panel renders with.
    sel: { $expr: "TECHNIQUES.find((t) => t.kind === 'flow')" } satisfies ExprFixture,
  },

  'src/tabs/FlowMap.tsx': {
    // The service selected on the dependency graph.
    service: 'donot_delete_Postgres_Sql_GEM',
  },

  'src/tabs/TcpHealth.tsx': {
    // The heatmap cell selected: one src subnet × dst subnet pair. `metric` and
    // `mask` are NOT here — they come from the tab's own useState defaults, so
    // the frozen panels are the ones a customer lands on.
    sel: { row: '10.0.0', col: '10.1.1' },
  },

  'src/tabs/TlsPosture.tsx': {
    // The server row drilled into Cribl Search.
    server: 'login.example.com',
  },
}

/** Every pivot × filtered and unfiltered — the unfiltered branch is the default screen. */
const PIVOT_AND_FILTER = ['PIVOTS.map((p) => p.key)', "['', 'openai']"]
/** Every wire-error metric the toggle offers. */
const EVERY_METRIC = 'METRICS.map((m) => m.key)'
/** Both subnet masks — the untaken side of `mask === "24" ? … : …` is a query too. */
const EVERY_MASK = "['24', '16']"

export const VARIANTS: Record<string, Record<string, VariantSpec>> = {
  'src/queries/capacityTopTalkers.ts': {
    pivotFor: { over: ['PIVOTS.map((p) => p.key)'] },
    buildKpiQuery: { over: PIVOT_AND_FILTER },
    buildTalkersQuery: { over: PIVOT_AND_FILTER },
    buildAppmixQuery: { over: PIVOT_AND_FILTER },
    buildL4Query: { over: PIVOT_AND_FILTER },
  },

  'src/queries/dnsHealth.ts': {
    // A resolver name is runtime input; one documented example.
    resolverDrillQuery: { over: ["['10.0.0.53']"] },
  },

  'src/queries/fieldExplorer.ts': {
    // Every coverage section AND every use case — these are what a customer
    // opens from a section's ⓘ, and each has its own field list.
    sectionQuery: {
      cases:
        'AMI_FAMILIES.map((fam) => ({ label: fam, args: [AMI_CATALOG.filter((f) => f.family === fam).map((f) => f.name)] }))' +
        '.concat(AMI_USE_CASES.map((uc) => ({ label: uc.name, args: [uc.fields] })))',
    },
    // Grouping, not a query: every catalog field at once, frozen as one digest.
    familyOf: { over: ['CHECK_FIELDS'], digest: true },
  },

  'src/queries/findings.ts': {
    // All seventeen detections: each `filter` is what "Flows ↗" opens.
    findingFlowsQuery: { over: ['FINDINGS'] },
  },

  'src/queries/pqcReadiness.ts': {
    serverFilter: { over: ["['login.example.com']"] },
    drillQuery: { cases: "[{ label: 'one server', args: [serverFilter('login.example.com')] }]" },
  },

  'src/queries/security.ts': {
    // Every technique, flow-signal and behaviour alike — a behaviour technique
    // runs no query, and that empty string is part of the promise.
    drillQueryFor: { over: ['TECHNIQUES'] },
  },

  'src/queries/flowMap.ts': {
    buildDomainsQuery: { over: ["['donot_delete_Postgres_Sql_GEM']"] },
    buildTrendQuery: { over: ["['donot_delete_Postgres_Sql_GEM']"] },
  },

  'src/queries/tcpHealth.ts': {
    metricFor: { over: [EVERY_METRIC] },
    subnetFields: { over: [EVERY_MASK] },
    buildHeatQuery: { over: [EVERY_METRIC, EVERY_MASK] },
    buildTrendQuery: { over: [EVERY_METRIC] },
    // A selected cell is runtime input, but the mask is not, and neither is the
    // unselected state — which is the branch that renders no panel at all.
    buildDrillQuery: {
      cases:
        "['24', '16'].flatMap((mask) => [" +
        "{ label: `10.0.0→10.1.1 · /${mask}`, args: [{ row: '10.0.0', col: '10.1.1' }, mask] }," +
        '{ label: `no cell selected · /${mask}`, args: [null, mask] }])',
    },
  },

  'src/queries/tlsPosture.ts': {
    serverDrill: { over: ["['login.example.com']"] },
  },
}
