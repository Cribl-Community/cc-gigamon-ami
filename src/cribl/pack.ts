// The Gigamon AMI onboarding pack: its id, the version this build pins, and the
// id of every object inside it.
//
// ONE MODULE, BECAUSE THE IDS ARE THE CONTRACT. The pack's source is text under
// packs/cc-network-gigamon-ami/, and the later slices (Guided Setup install,
// the port picker, the Lake landing panel, the Data Flow metrics queries) all
// have to name the same objects that text defines. src/cribl/pack.test.ts
// parses that YAML and fails if an id here and an id there disagree, so neither
// side can be renamed alone.
//
// PURE DATA. This file makes no network call and names no API path: the paths
// arrive with the code that calls them, and with their `config/policies.yml`
// grants. The query extractor may load it under plain Node. Its importers are
// src/queries/stackIds.ts (the Data Flow counters, METRICS_QUERY and
// LAKE_TOTAL_QUERY, built from these ids), src/cribl/packClient.ts (the pack
// install/upgrade client) and src/cribl/paths.ts (the grants that client needs).
//
// ── 0.2.0: RAW HTTP, DUAL-WRITTEN AS JSON AND PARQUET ───────────────────────
//
// Gigamon AMX delivers AMI records by HTTP POST, not syslog (owner, 2026-09-24),
// so 0.2.0 replaces 0.1.0's syslog input with an `http_raw` input and its event
// breaker. That input fans out through two routes: one to the JSON dataset
// every dashboard reads, one to a Parquet copy. The sample DataGen keeps its
// own route to its own dataset. One cast/derive pipeline serves all three,
// because after the breaker an HTTP record is an object exactly as a sample
// event is.
//
// NAMES SAY WHAT THINGS DO. The `gno_` prefix is RESERVED for the acceleration
// schedules (src/cribl/accel/manifest.ts); no pack object may carry it, and
// `npm run pack:check` refuses one.
//
// DISTINCT IDS, NOT THE GLOBAL ONES. The group's global config holds Guided
// Setup's own Raw HTTP stack (provision.ts: `in_gigamon_http`,
// `gigamon_http_normalize`, `gigamon_ami_http`, the `gigamon_ami_json_array`
// breaker), possibly the older Syslog stack, the `gigamon_lake` destination and
// the demo DataGen. A pack object with one of those names would make every place
// that matches on an id (a route filter on `__inputId`, a `cribl_metrics`
// dimension, an operator reading the UI) ambiguous about which of the two it
// meant, and would stop the pack being installed beside the global stack for a
// side-by-side migration. `REPLACED_BY_PACK` records the global objects the
// migration removes and what takes their place; `KEPT_BESIDE_PACK` records the
// ones it deliberately leaves alone, and why.
//
// NOT VERIFIED, AND LEFT FOR THE PROOF INSTALL (on a real Leader):
//   - the value of `__inputId` for an input inside a pack. The pack's route
//     filters assume `<type>:<id>`, as for a global input; a wrong filter
//     drops the data silently.
//   - that a pack's event breaker rulesets live in `default/breakers.yml`, and
//     that a pack input's `breakerRulesets` resolves against them. No pack with
//     a breaker has been read back from a Leader in this project; the path is
//     the one another Cribl Community pack ships, and the global file's
//     `default/cribl/breakers.yml` without the `cribl/` segment, as every other
//     pack file drops it. See `PACK_BREAKERS_FILE`.
//   - unknown (f): whether a DataGen sample replays with `_time` as now. Every sample in
//     default/samples.yml ships `isTemplate: false` (set in
//     scripts/gen-pack-samples.mjs), while every live DataGen sample observed
//     on a Leader is `isTemplate: true`. The value is left as it is until an
//     install shows which one stamps the current time on replay; do not
//     change it on a guess.
//   - what an in-place upgrade from 0.1.0 leaves behind. 0.1.0 is published
//     (`PACK_0_1_0` below) and shipped a syslog input; `PATCH /packs/<id>
//     {source}` upgrades in place, and nobody has read back what then remains
//     under the pack's `local/` (an override on `in_gno_syslog`, such as a port
//     set after install, could survive as a listener no route reads). The proof
//     install upgrades a 0.1.0 install with a local override and lists
//     `local/` afterwards, by the ids in `PACK_0_1_0`.
//   - that the Parquet destination's `onBackpressure: drop` keeps gigamon_ami
//     flowing while gigamon_ami_pq does not exist or cannot be written.

/** The pack's id on the Leader. Never starts with `v` — see the tag note below. */
export const PACK_ID = 'cc-network-gigamon-ami'

/**
 * The pack version this app build installs.
 *
 * A PLACEHOLDER UNTIL ITS RELEASE EXISTS. No `gigamon-pack-v0.2.0` release has
 * been published, so `PACK_URL` below is a 404 today. Bumping this constant is
 * how the app ships a pack update; `packs/cc-network-gigamon-ami/package.json`
 * may run ahead of it, never behind.
 */
export const PACK_VERSION = '0.2.0'

/**
 * Whether `PACK_VERSION`'s release exists on GitHub. False: no 0.2.0 release has
 * been published. Set it to true in the same change that sets `PACK_SHA256`;
 * pack.test.ts fails if one moves without the other, and fails while
 * `PACK_PENDING` below still holds anything.
 */
export const PACK_PUBLISHED: boolean = false

/**
 * The sha256 of `PACK_VERSION`'s released `.crbl`, as pack-release.yml's
 * summary prints it. MUST BE SET before any code installs from `PACK_URL`:
 * packClient.ts `installRefusal` refuses to install or upgrade while it is
 * null. That is a record, not a check of the bytes: the Leader downloads
 * `PACK_URL` itself and `POST /packs` takes no digest, so nothing in this app
 * sees the asset to hash it. Null only while no release exists
 * (`PACK_PUBLISHED` false).
 */
export const PACK_SHA256: string | null = null

/**
 * Where a pack keeps its routes, relative to the pack root. Measured on a
 * Leader: every bundled pack lists `<pack>/default/pipelines/route.yml`, and no
 * `routes.yml` exists anywhere. scripts/pack.mjs refuses a `default/routes.yml`.
 */
export const PACK_ROUTES_FILE = 'default/pipelines/route.yml'

/**
 * Where a pack keeps its event breaker rulesets, relative to the pack root.
 * NOT MEASURED — see the header. Cribl keeps the global library in
 * `(default|local)/cribl/breakers.yml`; a pack keeps every other kind of object
 * one level up (`default/inputs.yml`, not `default/cribl/inputs.yml`), and
 * another Cribl Community pack ships its breakers here and references them from
 * its own sources. The proof install has to read it back.
 */
export const PACK_BREAKERS_FILE = 'default/breakers.yml'

/**
 * The GitHub release tag for a pack version.
 *
 * `gigamon-pack-v…`, never `v…`: the app's marketplace publish fires on any tag
 * matching `v*` (.github/workflows/release.yml), and a pack tag must not.
 */
export const packTag = (version: string): string => `gigamon-pack-v${version}`

/** The asset's file name. On a GitHub release the asset NAME forms the URL, not its label. */
export const packAssetName = (version: string): string => `${PACK_ID}-${version}.crbl`

/**
 * Where the Leader downloads the pinned pack from.
 *
 * A string, never a `URL` object: the platform fetch proxy throws on a `URL`
 * (measured 2026-09-23). The Leader makes this request, not the app, so no
 * `config/proxies.yml` entry is needed for it.
 */
export const PACK_URL: string = packReleaseUrl(PACK_VERSION)

/**
 * The release asset URL of one version of this pack. `PACK_URL` is this for
 * `PACK_VERSION`; packClient.ts compares an installed copy's `source` with it,
 * as the second sign that this app installed that copy. The 0.1.0 asset is at
 * exactly this URL (read from the release, 2026-09-24).
 */
export function packReleaseUrl(version: string): string {
  return `https://github.com/Cribl-Community/cc-gigamon-ami/releases/download/${packTag(version)}/${packAssetName(version)}`
}

/**
 * EVERY VERSION OF THIS PACK THAT HAS BEEN RELEASED, KEPT BY HAND. The only
 * versions packClient.ts will upgrade from or remove.
 *
 * APPEND-ONLY. A version that leaves this list becomes "a version this app did
 * not publish" on every tenant still running it: Remove keeps it and Upgrade
 * refuses it. That is why it is not derived from `PACK_VERSION` — moving
 * `PACK_VERSION` to the next release must not drop the one before it. Add
 * `PACK_VERSION` here in the same change that sets `PACK_PUBLISHED` and
 * `PACK_SHA256`; pack.test.ts fails if the list and `PACK_PUBLISHED` disagree,
 * and if any version it has ever held is missing.
 */
export const PACK_PUBLISHED_VERSIONS: readonly string[] = Object.freeze(['0.1.0'])

// ── Objects inside the pack. Each is referenced by these ids in the pack's YAML.

/**
 * Where Gigamon AMX POSTs. SHIPS DISABLED with a placeholder port and NO auth
 * token: the app generates a token at install, writes it into this input only,
 * and enables it in the same whole-body PATCH. A token in the pack would be one
 * token shared by every tenant that installed it.
 */
export const PACK_HTTP_INPUT_ID = 'in_gigamon_ami_http'
/** Synthetic sample flows. SHIPS DISABLED; starting it is an opt-in. */
export const PACK_SAMPLE_INPUT_ID = 'in_gigamon_ami_sample'
/** Splits a POSTed JSON array into one event per record, fields extracted. */
export const PACK_BREAKER_ID = 'gigamon_ami_http_json_array'
/** Cast + derive only, for all three routes: provision.ts's `PIPELINE_SPEC`. */
export const PACK_PIPELINE_ID = 'gigamon_ami_normalize'
/** HTTP → the JSON dataset the dashboards read. NOT final: the event goes on
 *  to the Parquet route as well. */
export const PACK_HTTP_JSON_ROUTE_ID = 'gigamon_ami_http_to_json'
/** HTTP → the Parquet copy. Final. */
export const PACK_HTTP_PARQUET_ROUTE_ID = 'gigamon_ami_http_to_parquet'
/** Sample DataGen → the sample dataset. Final. */
export const PACK_SAMPLE_ROUTE_ID = 'gigamon_ami_sample'
export const PACK_JSON_OUTPUT_ID = 'gigamon_ami_json_lake'
export const PACK_PARQUET_OUTPUT_ID = 'gigamon_ami_parquet_lake'
export const PACK_SAMPLE_OUTPUT_ID = 'gigamon_ami_sample_lake'

/** The customer's dataset, which every dashboard reads. Outside the pack:
 *  Cribl has no pack-scoped dataset. Guided Setup's `ensureDataset` creates
 *  this one; see `PACK_DATASETS_NOT_CREATED` for the other two. */
export const PACK_LAKE_DATASET_ID = 'gigamon_ami'
/** The Parquet copy of the same records. Dashboards do not read it (yet). */
export const PACK_PARQUET_DATASET_ID = 'gigamon_ami_pq'
/**
 * Where the sample DataGen writes. NEVER `gigamon_ami` (or its Parquet copy):
 * Lake has no row delete, so a generated flow written into the customer's
 * dataset could not be taken back out before retention expired.
 */
export const PACK_SAMPLE_DATASET_ID = 'gigamon_ami_sample'

/**
 * The datasets the pack writes to that NO RELEASE OF THIS APP CREATES YET. Only
 * `gigamon_ami` has a creator (provision.ts `ensureDataset`). Until one exists:
 *   - gigamon_ami_pq: the pack's Parquet route ships enabled, so once the HTTP
 *     source is started every Parquet copy is dropped (`onBackpressure: drop`)
 *     with no signal, while gigamon_ami keeps flowing. provision.ts
 *     `PARQUET_DATASET_SPEC` is the body to create it with.
 *   - gigamon_ami_sample: packClient.ts refuses to start the sample source.
 * The pack README ships inside the .crbl and says the same; pack.test.ts fails
 * when a dataset POST is added to src and this list and the README are not
 * changed with it.
 */
export const PACK_DATASETS_NOT_CREATED: readonly string[] = Object.freeze([PACK_PARQUET_DATASET_ID, PACK_SAMPLE_DATASET_ID])

/** The ports a Cribl-managed (Cloud) worker group exposes for a source.
 *  pack.test.ts holds it equal to provision.ts's `CLOUD_PORT_RANGE`. */
export const PACK_CLOUD_PORT_RANGE = Object.freeze({ min: 20000, max: 20010 })
/**
 * The port the pack's HTTP input ships with, inside `PACK_CLOUD_PORT_RANGE`.
 * A placeholder: Guided Setup picks a free one at install.
 */
export const PACK_HTTP_PLACEHOLDER_PORT = 20005

/**
 * The field every sample event carries, set by the DataGen's `metadata` and
 * written into each sample event as well. Not `source`: Search uses that for
 * the file path on object-store datasets. Not `gno_origin` (0.1.0's name): the
 * `gno_` prefix is reserved for acceleration. No query in src/ reads it.
 */
export const SAMPLE_ORIGIN_FIELD = 'gigamon_origin'
export const SAMPLE_ORIGIN_VALUE = 'sample'

/**
 * DECISIONS NOT TAKEN YET, and shipped as a placeholder. Each key is a setting
 * the pack (or a dataset it writes to) carries today only so the
 * pack is complete; each value says what it is waiting for. EMPTY since
 * 2026-09-24: both of 0.2.0's entries were decided, and moved to
 * `PACK_DECISIONS` below with their evidence.
 *
 * A release must not freeze a guess into every tenant that installs it, and
 * three things refuse one. `scripts/pack.mjs` under `--expect-version` (what
 * pack-release.yml builds with) refuses any pack file that carries the marker
 * word: this is the guard that runs when a tag is pushed, because
 * `PACK_PUBLISHED` is still false then. pack.test.ts fails on a
 * `gigamon-pack-v*` GITHUB_REF_NAME while this holds anything, and fails if
 * `PACK_PUBLISHED` is true while it does. Add an entry, and the marker in the
 * pack file concerned, whenever a future pack ships a placeholder; resolve it by
 * deciding it, changing the pack to match, and moving it to `PACK_DECISIONS`.
 */
export const PACK_PENDING: Readonly<Record<string, string>> = Object.freeze({})

/**
 * What used to be `PACK_PENDING`, as decided, one sentence of evidence each.
 * Both were measured and owner-approved on 2026-09-24. The pack's README and
 * default/outputs.yml say the same; pack.test.ts holds the pack and
 * provision.ts `PARQUET_DATASET_SPEC` to them.
 */
export const PACK_DECISIONS: Readonly<Record<string, string>> = Object.freeze({
  parquet_schema_mode:
    `${PACK_PARQUET_OUTPUT_ID} keeps automaticSchema: true, because on 2026-09-24 an explicit parquetSchema had no observable effect: absent fields got the same "" fill, a field it did not list was still kept, and strings were stored in a column it declared INT64.`,
  parquet_partitions:
    `${PACK_PARQUET_DATASET_ID} is to be created with no partition fields (nothing creates it yet: PACK_DATASETS_NOT_CREATED), because on 2026-09-24 a protocol partition on Search v2 pruned nothing (a protocol=6 search read the same 63,249 events and 2.69 MB from the partitioned and the flat twin) while costing 172% of the flat twin unfiltered and 197% under other filters.`,
})

/** One path an event takes through a pack: the shape Data Flow's stack list uses. */
export interface PackPath {
  readonly route: string
  /** `<type>:<id>`, as `__inputId` and cribl_metrics name a source. */
  readonly input: string
  readonly pipeline: string
  /** `<type>:<id>`, as cribl_metrics names a destination. */
  readonly output: string
  readonly dataset: string
}

/**
 * THE PUBLISHED 0.1.0 PACK, AS SHIPPED. Released as `gigamon-pack-v0.1.0` on
 * 2026-09-24 (the release's publishedAt and asset digest are below), with a
 * syslog input and a sample DataGen. Every id is a literal read from that tag's
 * pack source, not derived from the constants above: those name 0.2.0, and
 * several kept their names while their values changed.
 *
 * WHY IT IS KEPT. A tenant that installed 0.1.0 can upgrade in place to 0.2.0.
 * Anything the upgrade leaves under the pack's `local/` (see the header's
 * proof-install list) can only be found, and removed, by these ids; Data Flow's
 * stack list names 0.1.0's paths from `paths` here, never from the 0.2.0
 * constants. Frozen, and pinned whole by pack.test.ts.
 */
export const PACK_0_1_0 = Object.freeze({
  version: '0.1.0',
  tag: 'gigamon-pack-v0.1.0',
  publishedAt: '2026-09-24T16:00:09Z',
  sha256: '1fff07438e1974853ec9dfbbf570d8afad1136a3453741aeec7acae08af178ca',
  inputs: Object.freeze({ syslog: 'in_gno_syslog', sample: 'in_gno_sample' }),
  pipelines: Object.freeze({ syslog: 'gno_syslog', sample: 'gno_sample' }),
  routes: Object.freeze({ syslog: 'gno_syslog', sample: 'gno_sample' }),
  outputs: Object.freeze({ lake: 'out_gno_lake', sample: 'out_gno_sample_lake' }),
  samples: Object.freeze(['gno_dns', 'gno_security', 'gno_services', 'gno_tls_apps', 'gno_web_api']),
  sampleOriginField: 'gno_origin',
  paths: Object.freeze([
    Object.freeze({ route: 'gno_syslog', input: 'syslog:in_gno_syslog', pipeline: 'gno_syslog', output: 'cribl_lake:out_gno_lake', dataset: 'gigamon_ami' }),
    Object.freeze({ route: 'gno_sample', input: 'datagen:in_gno_sample', pipeline: 'gno_sample', output: 'cribl_lake:out_gno_sample_lake', dataset: 'gigamon_ami_sample' }),
  ] as const satisfies readonly PackPath[]),
})

/**
 * The GLOBAL objects the migration to the pack REMOVES, each with the pack
 * object that takes its place: Guided Setup's Raw HTTP stack (provision.ts's
 * `HTTP_SOURCE_ID`, `HTTP_PIPELINE_ID`, `HTTP_ROUTE_ID`, `HTTP_BREAKER_ID`) and
 * the Syslog stack earlier releases created (`LEGACY_SYSLOG_*`).
 */
export const REPLACED_BY_PACK: Readonly<Record<string, { readonly by: string; readonly why: string }>> = Object.freeze({
  in_gigamon_http: {
    by: PACK_HTTP_INPUT_ID,
    why: 'The pack input receives the same exporter POSTs; two listeners for one feed would split or double it.',
  },
  gigamon_http_normalize: {
    by: PACK_PIPELINE_ID,
    why: 'The same two functions, value for value; only the pack routes use the pack copy.',
  },
  gigamon_ami_http: {
    by: PACK_HTTP_JSON_ROUTE_ID,
    why: 'Its filter names the global source, which the migration removes; the pack routes its own input.',
  },
  gigamon_ami_json_array: {
    by: PACK_BREAKER_ID,
    why: 'The same rule, value for value, carried inside the pack so the pack input does not depend on a global ruleset.',
  },
  in_gigamon_syslog: {
    by: PACK_HTTP_INPUT_ID,
    why: 'Gigamon AMX sends over HTTP, not syslog; the pack input replaces the old listener.',
  },
  gigamon_syslog: {
    by: PACK_PIPELINE_ID,
    why: 'Its cast and derive functions are the pack pipeline; its syslog parse step has no HTTP equivalent.',
  },
  gigamon_ami_syslog: {
    by: PACK_HTTP_JSON_ROUTE_ID,
    why: 'Its filter names the old syslog source, which the migration removes.',
  },
})

/**
 * The global objects the migration deliberately KEEPS beside the pack. Nothing
 * in the pack replaces them, and removing one would break something the pack
 * does not own.
 */
export const KEPT_BESIDE_PACK: Readonly<Record<string, string>> = Object.freeze({
  in_gigamon_datagen: 'The workspace\'s demo feed, which this app did not create and never edits; the pack\'s in_gigamon_ami_sample is a separate feed into a separate dataset.',
  gigamon_ami: 'The global pipeline the demo feed is processed by (provision.ts copied its two Evals from it); removing it would break a feed the pack does not own.',
  gigamon_lake: 'The global Lake destination usually pre-dates the app and other routes may use it; Guided Setup\'s teardown already leaves it in place.',
})
