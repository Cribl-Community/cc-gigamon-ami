// The ids of the worker group's own Raw HTTP stack for Gigamon AMX (see
// globalHttp.ts for what it is and why). PURE — ids and words only — so the
// onboarding plan, which may reach no network module, and the Data Flow
// counters (src/queries/stackIds.ts, loaded under plain Node), can name them.
// It imports nothing.

/** provision.ts's `LAKE_DESTINATION_ID`, written out so this module imports
 *  nothing; globalHttp.test.ts holds the two equal. */
export const GLOBAL_LAKE_DESTINATION_ID = 'gigamon_lake'

export const GLOBAL_HTTP_INPUT_ID = 'in_gigamon_ami_http'
export const GLOBAL_HTTP_BREAKER_ID = 'gigamon_ami_http_json_array'
/** The pipeline every onboarded Raw HTTP source runs into Cribl Lake (owner
 *  decision 2026-10-24: "gigamon"). NOT `gigamon_ami_normalize`, the pack's
 *  pipeline id: Data Flow counts a global pipeline by its `id`, and a pack
 *  pipeline's label is unmeasured, so sharing the id could count one event
 *  twice. One already in the group is used as it is. */
export const GLOBAL_HTTP_PIPELINE_ID = 'gigamon'

/** The four objects, in the order the run creates them: the source last,
 *  because it names the other three. */
export type GlobalObject = 'breaker' | 'pipeline' | 'destination' | 'source'
export const GLOBAL_OBJECTS: readonly GlobalObject[] = Object.freeze(['breaker', 'pipeline', 'destination', 'source'])

export const GLOBAL_OBJECT_ID: Readonly<Record<GlobalObject, string>> = Object.freeze({
  breaker: GLOBAL_HTTP_BREAKER_ID,
  pipeline: GLOBAL_HTTP_PIPELINE_ID,
  destination: GLOBAL_LAKE_DESTINATION_ID,
  source: GLOBAL_HTTP_INPUT_ID,
})

export const GLOBAL_OBJECT_KIND: Readonly<Record<GlobalObject, string>> = Object.freeze({
  breaker: 'Event breaker ruleset',
  pipeline: 'Pipeline',
  destination: 'Cribl Lake destination',
  source: 'Raw HTTP source',
})
