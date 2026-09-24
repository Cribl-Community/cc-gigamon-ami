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
// ONE IMPORTER SO FAR: src/queries/stackIds.ts, which builds the Data Flow
// counters (METRICS_QUERY, LAKE_TOTAL_QUERY) from these ids. No tab, grant or
// write uses this module yet, and it makes no network call and names no API
// path: the paths arrive with the code that calls them, and with their
// `config/policies.yml` grants.
//
// DISTINCT IDS, NOT THE GLOBAL ONES. The group's global config already holds
// objects with the old names — the syslog source, its pipeline and route, the
// `gigamon_lake` destination, and the demo DataGen. A pack that reused those
// names would make every place that matches on an id (a route filter on
// `__inputId`, a `cribl_metrics` dimension, an operator reading the UI)
// ambiguous about which of the two it meant. Every object in the pack carries a
// `gno_` prefix instead. `REPLACED_BY_PACK` records the global objects the
// migration removes and what takes their place; `KEPT_BESIDE_PACK` records the
// ones it deliberately leaves alone, and why.
//
// NOT VERIFIED, AND LEFT FOR THE PROOF SLICE (an install on a real Leader):
//   - the value of `__inputId` for an input inside a pack. The pack's route
//     filters assume `<type>:<id>`, as for a global input; a wrong filter
//     drops the data silently.
//   - unknown (f): whether a DataGen sample replays with `_time` as now. Every sample in
//     default/samples.yml ships `isTemplate: false` (set in
//     scripts/gen-pack-samples.mjs), while every live DataGen sample observed
//     on a Leader is `isTemplate: true`. The value is left as it is until an
//     install shows which one stamps the current time on replay; do not
//     change it on a guess.

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
 * Whether `PACK_VERSION`'s release exists on GitHub. False: no pack release has
 * been published. Set it to true in the same change that sets `PACK_SHA256`;
 * pack.test.ts fails if one moves without the other.
 */
export const PACK_PUBLISHED: boolean = false

/**
 * The sha256 of `PACK_VERSION`'s released `.crbl`, as pack-release.yml's
 * summary prints it. MUST BE SET before any code installs from `PACK_URL`:
 * the install path is to refuse bytes whose hash differs, so a replaced or
 * tampered asset cannot reach a Leader. Null only while no release exists
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
 *
 * The input ships `disabled: true`, unlike the global SOURCE_SPEC: a Cloud port
 * in this range is reachable from the internet and syslog is unauthenticated,
 * so nothing listens until the user confirms a port in Guided Setup, which
 * enables the input in the same write.
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
 * The global objects the migration to the pack REMOVES, each with the pack
 * object that takes its place. These are the three ids provision.ts's
 * `SOURCE_SPEC`, `PIPELINE_SPEC` and `ROUTE_SPEC` create today
 * (`SYSLOG_SOURCE_ID`, `SYSLOG_PIPELINE_ID`, `SYSLOG_ROUTE_ID`).
 */
export const REPLACED_BY_PACK: Readonly<Record<string, { readonly by: string; readonly why: string }>> = Object.freeze({
  in_gigamon_syslog: {
    by: PACK_SYSLOG_INPUT_ID,
    why: 'The pack input receives the same exporter traffic; two listeners for one feed would split or double it.',
  },
  gigamon_syslog: {
    by: PACK_SYSLOG_PIPELINE_ID,
    why: 'Same four functions, value for value; only the pack route uses the pack copy.',
  },
  gigamon_ami_syslog: {
    by: PACK_SYSLOG_ROUTE_ID,
    why: 'Its filter names the global source, which the migration removes; the pack routes its own input.',
  },
})

/**
 * The global objects the migration deliberately KEEPS beside the pack. Nothing
 * in the pack replaces them, and removing one would break something the pack
 * does not own.
 */
export const KEPT_BESIDE_PACK: Readonly<Record<string, string>> = Object.freeze({
  in_gigamon_datagen: 'The workspace\'s demo feed, which this app did not create and never edits; the pack\'s in_gno_sample is a separate feed into a separate dataset.',
  gigamon_ami: 'The global pipeline the demo feed is processed by (provision.ts copied its two Evals from it); removing it would break a feed the pack does not own.',
  gigamon_lake: 'The global Lake destination usually pre-dates the app and other routes may use it; removeSyslogStack already leaves it in place.',
})
