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
// NOTHING IMPORTS THIS YET. Slice 1 ships the pack content and its gates only;
// no query, tab, grant or write changes. That is deliberate, and it is why this
// file makes no network call and names no API path: the paths arrive with the
// code that calls them, and with their `config/policies.yml` grants.
//
// DISTINCT IDS, NOT THE GLOBAL ONES. The group's global config already holds
// objects with the old names — the syslog source, its pipeline and route, the
// `gigamon_lake` destination, and the demo DataGen. A pack that reused those
// names would make every place that matches on an id (a route filter on
// `__inputId`, a `cribl_metrics` dimension, an operator reading the UI)
// ambiguous about which of the two it meant. Every object in the pack carries a
// `gno_` prefix instead, and `GLOBAL_TO_PACK` records which global object each
// one replaces.

/** The pack's id on the Leader. Never starts with `v` — see the tag note below. */
export const PACK_ID = 'cc-network-gigamon-ami'

/**
 * The pack version this app build installs.
 *
 * A PLACEHOLDER UNTIL THE FIRST PACK RELEASE EXISTS. No `gigamon-pack-v0.1.0`
 * release has been published, so `PACK_URL` below is a 404 today. Nothing calls
 * it in this slice. Bumping this constant is how the app ships a pack update;
 * `packs/cc-network-gigamon-ami/package.json` may run ahead of it, never behind.
 */
export const PACK_VERSION = '0.1.0'

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
export const PACK_URL: string =
  `https://github.com/Cribl-Community/cc-gigamon-ami/releases/download/${packTag(PACK_VERSION)}/${packAssetName(PACK_VERSION)}`

/** Objects inside the pack. Each is referenced by these ids in the pack's YAML. */
export const PACK_SYSLOG_INPUT_ID = 'in_gno_syslog'
export const PACK_SAMPLE_INPUT_ID = 'in_gno_sample'
/** Parse + normalize: the four functions of provision.ts's `PIPELINE_SPEC`. */
export const PACK_SYSLOG_PIPELINE_ID = 'gno_syslog'
/** Shape only (cast + derive) for the DataGen, whose events are already objects. */
export const PACK_SAMPLE_PIPELINE_ID = 'gno_sample'
export const PACK_SYSLOG_ROUTE_ID = 'gno_syslog'
export const PACK_SAMPLE_ROUTE_ID = 'gno_sample'
export const PACK_LAKE_OUTPUT_ID = 'out_gno_lake'
export const PACK_SAMPLE_OUTPUT_ID = 'out_gno_sample_lake'

/** The customer's dataset. Outside the pack: Cribl has no pack-scoped dataset. */
export const PACK_LAKE_DATASET_ID = 'gigamon_ami'
/**
 * Where the sample DataGen writes. NEVER `gigamon_ami`: Lake has no row delete,
 * so a generated flow written into the customer's dataset could not be taken
 * back out before retention expired. Also outside the pack, created by the app.
 */
export const PACK_SAMPLE_DATASET_ID = 'gigamon_ami_sample'

/**
 * The port the pack's syslog input ships with, inside the 20000–20010 range a
 * Cribl-managed worker group exposes. A placeholder: Guided Setup sets the real
 * port at install (a later slice). It is not 5514, which a Cloud tenant's
 * exporter cannot reach.
 */
export const PACK_SYSLOG_PLACEHOLDER_PORT = 20005
/** The ports a Cribl-managed (Cloud) worker group exposes for syslog. */
export const CLOUD_SYSLOG_PORT_RANGE = Object.freeze({ min: 20000, max: 20010 })

/**
 * The field every sample event carries, set by the DataGen's `metadata` and
 * written into each sample event as well. Not `source`: Search uses that for
 * the file path on object-store datasets.
 */
export const SAMPLE_ORIGIN_FIELD = 'gno_origin'
export const SAMPLE_ORIGIN_VALUE = 'sample'

/**
 * Which global object each pack object replaces. Keys are the ids the app's
 * global stack (provision.ts) and the demo feed use today; values are the pack's.
 *
 * `in_gigamon_datagen` is the workspace's demo DataGen, which this app did not
 * create; the pack's `in_gno_sample` is its own sample feed, into its own
 * dataset, and replaces nothing on the Leader.
 */
export const GLOBAL_TO_PACK = Object.freeze({
  in_gigamon_syslog: PACK_SYSLOG_INPUT_ID,
  gigamon_syslog: PACK_SYSLOG_PIPELINE_ID,
  gigamon_ami: PACK_SAMPLE_PIPELINE_ID,
  gigamon_ami_syslog: PACK_SYSLOG_ROUTE_ID,
  gigamon_lake: PACK_LAKE_OUTPUT_ID,
  in_gigamon_datagen: PACK_SAMPLE_INPUT_ID,
} as const)
