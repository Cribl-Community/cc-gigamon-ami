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
// ── 0.2.2: THE PARQUET COPY DROPS _raw ──────────────────────────────────────
//
// After the breaker every field of a record is its own field, and `_raw` is the
// record's whole JSON text again: a 0.2.1 Parquet row carried the full `_raw`
// beside 48 columns (measured 2026-09-25, a scratch HTTP test: 50 of 50 records
// in both datasets). Owner decision 2026-09-25: the Parquet route gets its own
// pipeline, `PACK_PARQUET_PIPELINE_ID` — `gigamon_ami_normalize`'s cast and
// derive plus an Eval that removes `_raw` (provision.ts
// `PARQUET_PIPELINE_SPEC`) — and the JSON and sample routes keep
// `PACK_PIPELINE_ID` and `_raw`, which the evidence drills, Field Explorer's
// presence view and the Copilot briefs read (all pinned to JSON,
// queryTarget.ts `PIN_WORDS`). The gain is storage, not a claimed latency win.
// A non-final route hands its pipeline a COPY of the event, so the removal
// cannot reach the JSON copy: Cribl's documented behaviour, UNMEASURED here, and
// the 0.2.2 proof install checks it. Nothing else changed from 0.2.1, whose
// objects are `PACK_0_2_1_OBJECTS` below. *(Corrected 2026-09-25,
// `feat/pack-022-parquet-pipeline`: one pipeline served all three routes.)*
//
// ── 0.2.1: THE ROUTE FILTERS NAME THE PACK ──────────────────────────────────
//
// Inside a pack an event's `__inputId` is `<type>:<packId>.<inputId>`, and
// cribl_metrics names the pack's objects the same way (measured 2026-09-25 on
// a Cribl.Cloud Leader, the Gigamon workspace's default group, with a test
// pack `cc-network-gigamon-ami-dgtest`: its DataGen `dg_asis` stamped
// `datagen:cc-network-gigamon-ami-dgtest.dg_asis` on every event, and its
// throughput rows carried input `datagen:cc-network-gigamon-ami-dgtest.dg_asis`,
// output `cribl_lake:cc-network-gigamon-ami-dgtest.dg_sample_lake` and route
// `cc-network-gigamon-ami-dgtest.dg_all_inputs`). 0.2.0 (and 0.1.0 before
// it) filtered on the global form `<type>:<inputId>`, which never matches
// inside a pack: with no catch-all route, both dropped every event of every
// source (observed for 0.2.0: sample DataGen running and Green, 0 rows in
// gigamon_ami_sample after six minutes). 0.2.1 is 0.2.0 with the filters built
// by `packInputFilter` below, and nothing else changed. `packInputLabel`,
// `packOutputLabel` and `packRouteLabel` are the metric labels
// src/queries/stackIds.ts counts by. A pipeline's label inside a pack is NOT
// measured (no `pipe.*` row appeared for the test pack's pipeline in 30
// minutes), so nothing here spells one.
//
// ── 0.2.0: RAW HTTP, DUAL-WRITTEN AS JSON AND PARQUET ───────────────────────
//
// Gigamon AMX delivers AMI records by HTTP POST, not syslog (owner, 2026-09-24),
// so 0.2.0 replaces 0.1.0's syslog input with an `http_raw` input and its event
// breaker. That input fans out through two routes: one to the JSON dataset
// every dashboard reads, one to a Parquet copy. The sample DataGen keeps its
// own route to its own dataset. One cast/derive pipeline served all three,
// because after the breaker an HTTP record is an object exactly as a sample
// event is (until 0.2.2, whose Parquet route runs its own copy that also
// removes `_raw`: see 0.2.2 above).
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
//   - (the value of `__inputId` for an input inside a pack was on this list
//     until 2026-09-25; it is measured now: see 0.2.1 above.)
//   - that a pack's event breaker rulesets live in `default/breakers.yml`, and
//     that a pack input's `breakerRulesets` resolves against them. No pack with
//     a breaker has been read back from a Leader in this project; the path is
//     the one another Cribl Community pack ships, and the global file's
//     `default/cribl/breakers.yml` without the `cribl/` segment, as every other
//     pack file drops it. See `PACK_BREAKERS_FILE`.
//   - (two more items were on this list until 2026-09-25, and were measured
//     then. Unknown (f): a DataGen inside a pack emitting 0.2.0's exact sample
//     format, `isTemplate: false` included, lands with `_time` as now. And
//     what an in-place upgrade from 0.1.0 leaves behind: every local override
//     survives the upgrade, including an override of an object the new version
//     removed, so 0.1.0's `in_gno_syslog` stayed behind as an orphan. CLAUDE.md's
//     onboarding section records what that means for the Upgrade dialog.)
//   - that the Parquet destination's `onBackpressure: drop` keeps gigamon_ami
//     flowing while gigamon_ami_pq does not exist or cannot be written. The
//     value is CONFIGURED [measured: packs/…/default/outputs.yml]; what it DOES
//     is unmeasured. If it behaves as intended, gigamon_ami_pq can have holes
//     by design, which is why the Phase 8 router checks completeness per window
//     before any live panel reads it (src/cribl/routing/completeness.ts).
//   - (the HTTP input path end to end inside a pack was on this list until
//     2026-09-25: a scratch test that day sent 50 records through the breaker
//     and both 0.2.1 routes, and all 50 landed in gigamon_ami and in
//     gigamon_ami_pq, the Parquet rows carrying the full _raw.)
//   - that removing _raw on the Parquet route (0.2.2) leaves the JSON copy's
//     _raw intact: a non-final route hands its pipeline a copy of the event
//     (Cribl's documented behaviour), never measured here. The proof install
//     must read a gigamon_ami row with _raw and a gigamon_ami_pq row without.
//   - that an in-place upgrade from 0.2.1 puts the Parquet route on the new
//     pipeline. The route table ships in default/; a tenant who edited the
//     pack's routes has a local/ copy, which the upgrade keeps (measured for
//     sources, 2026-09-25), so that tenant's Parquet route would still run
//     gigamon_ami_normalize. This app never writes the pack's routes.

/** The pack's id on the Leader. Never starts with `v` — see the tag note below. */
export const PACK_ID = 'cc-network-gigamon-ami'

/**
 * The pack version this app build installs.
 *
 * NOT RELEASED YET: 0.2.2 (the Parquet route's own pipeline, which removes
 * `_raw`) is built here and has no `gigamon-pack-v0.2.2` release, so
 * `PACK_PUBLISHED` is false and Onboard and Upgrade are refused with
 * `packRelease`'s sentence until the flip — a separate commit after the tag,
 * as for 0.2.1, that sets `PACK_PUBLISHED` and `PACK_SHA256` and appends 0.2.2
 * to `PACK_PUBLISHED_VERSIONS`. An installed 0.2.1 (or 0.2.0, or 0.1.0) stays
 * owned meanwhile: Remove works, and Upgrade to 0.2.2 is what the flip offers.
 * Bumping this constant is how the app ships a pack update;
 * `packs/cc-network-gigamon-ami/package.json` may run ahead of it, never
 * behind. *(0.2.1 until 2026-09-25, `feat/pack-022-parquet-pipeline`: 0.2.1 was
 * released that day, tag at a034641, and a fresh URL install of it landed
 * 1,372 sample rows in 2.5 minutes. Before that 0.2.0, which delivers
 * nothing.)*
 */
export const PACK_VERSION = '0.2.2'

/**
 * Whether `PACK_VERSION`'s release exists on GitHub. FALSE: 0.2.2 is not
 * released. (It was true for 0.2.1 from its release on 2026-09-25 until this
 * build moved the pin to 0.2.2, the same day.) It moves back in the same change
 * that sets `PACK_SHA256` and appends 0.2.2 to `PACK_PUBLISHED_VERSIONS`;
 * pack.test.ts fails if one moves without the others, and fails while
 * `PACK_PENDING` below still holds anything. While it is false
 * scripts/check-pack-release.mjs (CI) skips and says why; once true it
 * downloads `PACK_URL` and fails when its sha256 is not `PACK_SHA256`.
 */
export const PACK_PUBLISHED: boolean = false

/**
 * The sha256 of `PACK_VERSION`'s released `.crbl`, as pack-release.yml's
 * summary prints it. MUST BE SET before any code installs from `PACK_URL`:
 * `packRelease` below refuses while it is null, and so does packClient.ts's
 * `installRefusal`, which is that function bound to these constants. That is a record, not a check of the bytes: the Leader downloads
 * `PACK_URL` itself and `POST /packs` takes no digest, so nothing in this app
 * sees the asset to hash it. CI does, instead: scripts/check-pack-release.mjs
 * downloads `PACK_URL` on every push and fails when the bytes hash to anything
 * else. Null only while no release exists (`PACK_PUBLISHED` false) — as now,
 * since 0.2.2 is unreleased. (Until this build pinned 0.2.2 it held 0.2.1's
 * digest, which is recorded beside 0.2.1 in `PACK_PUBLISHED_VERSIONS`.)
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

/** A sha256 as pack-release.yml prints it: 64 lowercase hex characters. */
const SHA256_SHAPE = /^[0-9a-f]{64}$/

/** The three release facts `packRelease` judges. */
export interface PackReleaseFacts {
  published: boolean
  sha256: string | null
  version: string
}

/** The pinned release, and whether this build may install it. */
export interface PackRelease extends PackReleaseFacts {
  /** Where the Leader would download it from. */
  url: string
  /** Why this build may not install (or upgrade to) it, as a sentence a
   *  customer can read; null when it may. */
  refusal: string | null
  /** `refusal === null`. */
  installable: boolean
}

/**
 * The pinned release and whether this build may install it — pure, so the
 * Guided Setup page can say why Onboard is refused without importing
 * packClient.ts (which nothing on screen may reach until its grants are
 * declared). packClient.ts's `installRefusal` is this, bound to the constants
 * it imports, so the page and the client cannot give two answers.
 *
 * WHAT THIS GUARD IS, AND WHAT IT IS NOT. It refuses while no release of the
 * version exists (`published`) or while its digest is unrecorded or is not a
 * sha256 at all: the URL would be a 404, or would name bytes nobody wrote
 * down. It does NOT compare the downloaded bytes with the digest, because the
 * app never sees them — the Leader fetches the URL itself and `POST /packs`
 * has no digest field. After an install the version, the source and one known
 * object are read back (packClient.ts `verifyInstalled`).
 *
 * The argument defaults to this build's constants; tests pass their own.
 */
export function packRelease(
  facts: PackReleaseFacts = { published: PACK_PUBLISHED, sha256: PACK_SHA256, version: PACK_VERSION },
): PackRelease {
  const { published, sha256, version } = facts
  const refusal = !published
    ? `pack ${version} has not been released, so there is nothing to install yet`
    : !sha256
      ? `pack ${version} has no recorded sha256, so this app will not install it`
      : !SHA256_SHAPE.test(sha256)
        ? `pack ${version}’s recorded sha256 is not 64 lowercase hex characters, so this app will not install it`
        : null
  return Object.freeze({ published, sha256, version, url: packReleaseUrl(version), refusal, installable: refusal === null })
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
export const PACK_PUBLISHED_VERSIONS: readonly string[] = Object.freeze([
  '0.1.0',
  // gigamon-pack-v0.2.0, tag commit 0d93f9c, asset sha256
  // 978415d7b74d7217559800ac40f5e7ec893d5ae8df7d8ef9c394feb605e6bc6b. Released
  // on 2026-09-25 while this build still pinned it unpublished; its route
  // filters never match inside a pack, so it delivers nothing, but a tenant may
  // hold it and Remove and Upgrade must recognise it. Its objects are this
  // build's ids (`PACK_OBJECTS`): 0.2.1 renamed nothing.
  '0.2.0',
  // gigamon-pack-v0.2.1, tag commit a034641, asset sha256
  // 2a2a3c3650d0eb39029f18001840d5a13ef7a61f258478daff0947f35b769807 (the
  // `PACK_SHA256` until this build pinned 0.2.2). Released 2026-09-25. An
  // installed copy stays owned: Remove takes it, and Upgrade takes it to 0.2.2
  // once 0.2.2 is released and appended here.
  '0.2.1',
])

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
/** Cast + derive only, for the JSON and sample routes, which keep `_raw`:
 *  provision.ts's `PIPELINE_SPEC`. (All three routes ran it until 0.2.2.) */
export const PACK_PIPELINE_ID = 'gigamon_ami_normalize'
/** The Parquet route's pipeline (0.2.2 on): `PACK_PIPELINE_ID`'s cast and
 *  derive, then an Eval that removes `_raw` — provision.ts's
 *  `PARQUET_PIPELINE_SPEC`. */
export const PACK_PARQUET_PIPELINE_ID = 'gigamon_ami_normalize_parquet'
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
 *  Cribl has no pack-scoped dataset. Guided Setup creates it — its Raw HTTP
 *  deploy and its onboarding run, both through provision.ts
 *  `ensureLakeDataset`. */
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
 * The datasets the pack writes to that NO RELEASE OF THIS APP CREATES. EMPTY
 * since 2026-09-24: Guided Setup's onboarding run (cribl/onboarding/run.ts)
 * creates gigamon_ami_pq, and gigamon_ami_sample when sample data is ticked,
 * through provision.ts `ensureLakeDataset` — created when absent, never edited.
 * *(Until then it listed both, and the pack README said no release created
 * them.)*
 *
 * Kept, so a dataset a future pack writes to before anything creates it has a
 * place to be recorded. pack.test.ts holds this list, the callers of
 * `ensureLakeDataset` and the pack README's sentence about who creates what to
 * one another: a new creator, or a new dataset nothing creates, changes all
 * three together.
 */
export const PACK_DATASETS_NOT_CREATED: readonly string[] = Object.freeze([])

/**
 * Every object the pack ships, by the kind of list it appears in. Here rather
 * than in packClient.ts because the onboarding plan's confirmation names each
 * one, and the plan may not import the client (it is on paths.ts
 * `UNREACHED_MODULES`). packClient.ts re-exports it.
 */
export const PACK_OBJECTS = Object.freeze({
  inputs: Object.freeze([PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID]),
  breakers: Object.freeze([PACK_BREAKER_ID]),
  pipelines: Object.freeze([PACK_PIPELINE_ID, PACK_PARQUET_PIPELINE_ID]),
  routes: Object.freeze([PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_SAMPLE_ROUTE_ID]),
  outputs: Object.freeze([PACK_JSON_OUTPUT_ID, PACK_PARQUET_OUTPUT_ID, PACK_SAMPLE_OUTPUT_ID]),
})

export type PackObjectKind = keyof typeof PACK_OBJECTS

/**
 * THE OBJECTS 0.2.0 AND 0.2.1 SHIPPED, as published: `PACK_OBJECTS` without
 * `PACK_PARQUET_PIPELINE_ID`, which 0.2.2 added. Literals, like `PACK_0_1_0`,
 * because they describe bytes already released: Remove names exactly these
 * for an installed 0.2.0 or 0.2.1 (onboarding/plan.ts `packObjectsOf`), and an
 * upgrade from either shows the new pipeline as added. pack.test.ts pins it.
 * *(Added 2026-09-25, `feat/pack-022-parquet-pipeline`: `packObjectsOf`
 * answered 0.2.x with `PACK_OBJECTS`, right while those versions shipped this
 * build's ids.)*
 */
export const PACK_0_2_1_OBJECTS: Readonly<Record<PackObjectKind, readonly string[]>> = Object.freeze({
  inputs: Object.freeze(['in_gigamon_ami_http', 'in_gigamon_ami_sample']),
  breakers: Object.freeze(['gigamon_ami_http_json_array']),
  pipelines: Object.freeze(['gigamon_ami_normalize']),
  routes: Object.freeze(['gigamon_ami_http_to_json', 'gigamon_ami_http_to_parquet', 'gigamon_ami_sample']),
  outputs: Object.freeze(['gigamon_ami_json_lake', 'gigamon_ami_parquet_lake', 'gigamon_ami_sample_lake']),
})

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
    `${PACK_PARQUET_DATASET_ID} is created with no partition fields (by the onboarding run, onboarding/plan.ts parquetDatasetSpec), because on 2026-09-24 a protocol partition on Search v2 pruned nothing (a protocol=6 search read the same 63,249 events and 2.69 MB from the partitioned and the flat twin) while costing 172% of the flat twin unfiltered and 197% under other filters.`,
})

// ── How Cribl names an object inside this pack (measured 2026-09-25) ────────

/** `<type>:<packId>.<inputId>`: an in-pack source's `__inputId`, and its
 *  `input` label on cribl_metrics throughput and health rows. */
export const packInputLabel = (type: string, inputId: string): string => `${type}:${PACK_ID}.${inputId}`
/** `<type>:<packId>.<outputId>`: an in-pack destination's `output` label on
 *  cribl_metrics throughput rows. (Health, backpressure and blocked rows for
 *  one output were once seen without the pack id; throughput rows, measured
 *  directly, carry it.) */
export const packOutputLabel = (type: string, outputId: string): string => `${type}:${PACK_ID}.${outputId}`
/** `<packId>.<routeId>`: an in-pack route's `route` label on `route.*` rows. */
export const packRouteLabel = (routeId: string): string => `${PACK_ID}.${routeId}`
/** The route filter that selects one of this pack's own sources. The pack's
 *  default/pipelines/route.yml spells exactly this; pack.test.ts holds it. */
export const packInputFilter = (type: string, inputId: string): string => `__inputId=='${packInputLabel(type, inputId)}'`

/** One path an event takes through a pack: the shape Data Flow's stack list uses. */
export interface PackPath {
  /** `<packId>.<routeId>`, as cribl_metrics names a route in a pack. */
  readonly route: string
  /** `<type>:<packId>.<id>`, as `__inputId` and cribl_metrics name a source
   *  in a pack. */
  readonly input: string
  /** The pipeline's id inside the pack. NOT its cribl_metrics label, which is
   *  unmeasured for a pipeline in a pack: nothing may count by this. */
  readonly pipeline: string
  /** `<type>:<packId>.<id>`, as cribl_metrics names a destination in a pack. */
  readonly output: string
  readonly dataset: string
}

/**
 * THE PUBLISHED 0.1.0 PACK, AS SHIPPED. Released as `gigamon-pack-v0.1.0` on
 * 2026-09-24 (the release's publishedAt and asset digest are below), with a
 * syslog input and a sample DataGen. Every id is a literal read from that tag's
 * pack source, not derived from the constants above: those name the current
 * version (`PACK_VERSION`), and several kept their names while their values changed.
 *
 * WHY IT IS KEPT. A tenant that installed 0.1.0 can upgrade in place to the
 * current version. The upgrade keeps the pack's `local/` settings (measured
 * 2026-09-25), including a changed source this version no longer ships, which
 * can only be found, and removed, by these ids; Data Flow's stack list names
 * 0.1.0's paths from `paths` here, never from the current constants. Frozen, and pinned whole by pack.test.ts.
 *
 * `paths` CORRECTED 2026-09-25. They named the route, source and destination
 * by the global forms (`gno_syslog`, `syslog:in_gno_syslog`,
 * `cribl_lake:out_gno_lake`), an assumption; measured on a Leader, cribl_metrics
 * names an object inside a pack with the pack id before its own
 * (`packInputLabel` and the rest above), so the counters would never have
 * matched a 0.1.0 row. The object ids themselves are unchanged. 0.1.0's route
 * filters made the same assumption, so a 0.1.0 source receives events that
 * reach no destination.
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
    Object.freeze({ route: 'cc-network-gigamon-ami.gno_syslog', input: 'syslog:cc-network-gigamon-ami.in_gno_syslog', pipeline: 'gno_syslog', output: 'cribl_lake:cc-network-gigamon-ami.out_gno_lake', dataset: 'gigamon_ami' }),
    Object.freeze({ route: 'cc-network-gigamon-ami.gno_sample', input: 'datagen:cc-network-gigamon-ami.in_gno_sample', pipeline: 'gno_sample', output: 'cribl_lake:cc-network-gigamon-ami.out_gno_sample_lake', dataset: 'gigamon_ami_sample' }),
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
