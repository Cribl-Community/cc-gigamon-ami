// The onboarding pack's clean-up after an in-place upgrade: put the route table
// this version ships back, and delete the sources and destinations an earlier
// version shipped that the upgrade left behind.
//
// ── WHAT WAS MEASURED, AND WHAT EACH WRITE HERE RESTS ON ────────────────────
// On 2026-09-26, on the workspace Leader, with a scratch copy of this pack
// upgraded in place from 0.1.0 to 0.2.2 (pack.ts's header has M1–M6 in full;
// one Leader, one scratch pack):
//   * an edited route table survives an upgrade WHOLE (M1), and the only write
//     that puts one back is `PATCH /p/<pack>/routes/default` with the whole
//     table object and `routes` = the shipped rows (M6; a DELETE answers 500).
//     So `restorePackRoutes` sends exactly that: the table as it reads now, with
//     only `routes` replaced, because a Cribl PATCH resets what it omits.
//     The local override file stays, so a later upgrade keeps this table too —
//     the upgrade's read-back (onboarding/run.ts) is what catches that.
//   * a leftover source deletes (M3); a leftover destination deletes only once
//     no route names it (M4: 409 while the old table stands), so destinations
//     go after the routes, and only when the routes step did not fail.
//   * a pipeline DELETE inside a pack answers 200 and deletes nothing (M5), so
//     nothing here sends one: the dialog names the leftover pipelines as left
//     listed, unused once the routes are restored.
//
// ── ONE LITERAL PATH PER LEFTOVER, AND WHY ──────────────────────────────────
// config/policies.yml grants each DELETE by the object's own id (owner
// decision, 2026-09-26: no `:id` segment), so a grant never covers a tenant's
// own object. policyCoverage.test.ts reads each call site's path from its
// literal text, so every id below has its own `capi(…)` with its own constant
// — a path built from a variable would read as `:x` and be refused. Which ids
// are leftovers at all is pure (onboarding/plan.ts `leftoverCandidates`, from
// the published versions' records); `DELETABLE_LEFTOVERS` is what this module
// can send, and plan.test.ts holds the two equal, so a release that drops
// another object fails until its call and its exact grant are added.
//
// ── WHO REACHES THIS ────────────────────────────────────────────────────────
// onboarding/run.ts `runPackCleanup`, from the "Yes" inside Guided Setup's
// "Restore the pack's routes and remove leftovers" confirmation, gated by
// `onboarding_pack.cleanup`, under the page's run lock. Nothing here runs on
// load, render or a timer.

import { capi, type ApiResp } from './capi'
import { PACK_0_1_0, PACK_ROUTES, PACK_ROUTE_TABLE_ID, routeIdOf, routeTableMatches } from './pack'
import { packPath, readPackRouteTable } from './packClient'
import { sameValue, scrubbedErrText } from './provision'

// 0.1.0's objects that 0.2.x no longer ships (PACK_0_1_0, pinned whole by
// pack.test.ts; packCleanup.test.ts holds these equal to it). Literals, so each
// call below names its path in text.
const LEFTOVER_SYSLOG_INPUT = 'in_gno_syslog'
const LEFTOVER_SAMPLE_INPUT = 'in_gno_sample'
const LEFTOVER_LAKE_OUTPUT = 'out_gno_lake'
const LEFTOVER_SAMPLE_OUTPUT = 'out_gno_sample_lake'

/** The leftovers this module can delete, by kind — each with its own literal
 *  DELETE and GET below, and its own exact grant. */
export const DELETABLE_LEFTOVERS: Readonly<Record<'inputs' | 'outputs', readonly string[]>> = Object.freeze({
  inputs: Object.freeze([LEFTOVER_SYSLOG_INPUT, LEFTOVER_SAMPLE_INPUT]),
  outputs: Object.freeze([LEFTOVER_LAKE_OUTPUT, LEFTOVER_SAMPLE_OUTPUT]),
})

/** The same ids, as PACK_0_1_0 records them — for the test that holds them equal. */
export const LEFTOVERS_FROM_0_1_0 = Object.freeze({
  inputs: [PACK_0_1_0.inputs.syslog, PACK_0_1_0.inputs.sample],
  outputs: [PACK_0_1_0.outputs.lake, PACK_0_1_0.outputs.sample],
})

export type CleanupStepKey = 'routes' | 'input' | 'output'

/** One thing the clean-up did, or refused to do. */
export interface CleanupStep {
  key: CleanupStepKey
  /** The object's id: the table's, or the source's or destination's. */
  id: string
  action: 'updated' | 'deleted' | 'exists' | 'error'
  detail?: string
}

// ── The route table ─────────────────────────────────────────────────────────

/**
 * Put the route table this version ships back: read the table, and — only when
 * it is the one table, `PACK_ROUTE_TABLE_ID`, and its route ids are still
 * `before` (what the confirmation showed) — PATCH it whole with `routes` =
 * `PACK_ROUTES`, then read it back and require the shipped table. A table that
 * moved, or answers under another id, is refused and nothing is sent.
 */
export async function restorePackRoutes(group: string, before: readonly (string | null)[]): Promise<CleanupStep> {
  const id = PACK_ROUTE_TABLE_ID
  const now = await readPackRouteTable(group)
  if (now === 'unreadable') return { key: 'routes', id, action: 'error', detail: 'not changed — the pack’s route table could not be read' }
  if (now.tables !== 1 || now.id !== PACK_ROUTE_TABLE_ID || now.raw === null) {
    return {
      key: 'routes', id, action: 'error',
      detail: `not changed — the pack answered ${now.tables} route table${now.tables === 1 ? '' : 's'}${now.id ? `, “${now.id}”` : ''}, ` +
        `and this app only ever writes the one table “${PACK_ROUTE_TABLE_ID}”`,
    }
  }
  const ids = now.routes.map(routeIdOf)
  if (!sameValue(ids, [...before])) {
    return {
      key: 'routes', id, action: 'error',
      detail: `not changed — the route table changed after the confirmation was shown (it now lists ${ids.map((x) => x ?? 'an unnamed route').join(', ') || 'no route'})`,
    }
  }
  if (routeTableMatches(now)) return { key: 'routes', id, action: 'exists', detail: 'already the routes this version ships' }
  const body: Record<string, unknown> = { ...now.raw, routes: PACK_ROUTES.map((r) => structuredClone({ ...r, clones: [...r.clones] })) }
  const r = await capi('PATCH', packPath(group, `/routes/${PACK_ROUTE_TABLE_ID}`), body)
  if (r.status < 200 || r.status >= 300) return { key: 'routes', id, action: 'error', detail: scrubbedErrText(r, []) }
  const back = await readPackRouteTable(group)
  if (back === 'unreadable') {
    return { key: 'routes', id, action: 'error', detail: 'the change was answered, but the route table could not be read back to check it' }
  }
  if (!routeTableMatches(back)) {
    return { key: 'routes', id, action: 'error', detail: 'the change was answered, but the route table read back is still not the one this version ships' }
  }
  return { key: 'routes', id, action: 'updated', detail: `now ${PACK_ROUTES.map((x) => x.id).join(', ')}` }
}

// ── The leftovers ───────────────────────────────────────────────────────────

/** The DELETE for one leftover, by its own literal path; null for an id this
 *  module has no call (and so no grant) for. */
async function deleteLeftoverRequest(group: string, id: string): Promise<ApiResp | null> {
  switch (id) {
    case LEFTOVER_SYSLOG_INPUT: return capi('DELETE', packPath(group, `/system/inputs/${LEFTOVER_SYSLOG_INPUT}`))
    case LEFTOVER_SAMPLE_INPUT: return capi('DELETE', packPath(group, `/system/inputs/${LEFTOVER_SAMPLE_INPUT}`))
    case LEFTOVER_LAKE_OUTPUT: return capi('DELETE', packPath(group, `/system/outputs/${LEFTOVER_LAKE_OUTPUT}`))
    case LEFTOVER_SAMPLE_OUTPUT: return capi('DELETE', packPath(group, `/system/outputs/${LEFTOVER_SAMPLE_OUTPUT}`))
  }
  return null
}

/** The read-back GET for one leftover, by the same literal path. */
async function readLeftoverRequest(group: string, id: string): Promise<ApiResp | null> {
  switch (id) {
    case LEFTOVER_SYSLOG_INPUT: return capi('GET', packPath(group, `/system/inputs/${LEFTOVER_SYSLOG_INPUT}`))
    case LEFTOVER_SAMPLE_INPUT: return capi('GET', packPath(group, `/system/inputs/${LEFTOVER_SAMPLE_INPUT}`))
    case LEFTOVER_LAKE_OUTPUT: return capi('GET', packPath(group, `/system/outputs/${LEFTOVER_LAKE_OUTPUT}`))
    case LEFTOVER_SAMPLE_OUTPUT: return capi('GET', packPath(group, `/system/outputs/${LEFTOVER_SAMPLE_OUTPUT}`))
  }
  return null
}

/**
 * Delete one leftover source or destination, then read it back: a 404 is gone,
 * anything else is not — "still present" after a DELETE that answered is a
 * failure, as is a read-back that could not tell (M3, M4). A DELETE answered 404
 * is "already gone". A refusal (a destination a route still names answers 409)
 * is the Leader's own words, scrubbed.
 */
export async function deleteLeftover(group: string, kind: 'inputs' | 'outputs', id: string): Promise<CleanupStep> {
  const key: CleanupStepKey = kind === 'inputs' ? 'input' : 'output'
  if (!DELETABLE_LEFTOVERS[kind].includes(id)) {
    return { key, id, action: 'error', detail: 'not sent — this app has no grant to delete an object by that id' }
  }
  const del = await deleteLeftoverRequest(group, id)
  if (del === null) return { key, id, action: 'error', detail: 'not sent — this app has no grant to delete an object by that id' }
  if (del.status === 404) return { key, id, action: 'exists', detail: 'already gone' }
  if (del.status < 200 || del.status >= 300) return { key, id, action: 'error', detail: scrubbedErrText(del, []) }
  const back = await readLeftoverRequest(group, id)
  if (back === null || back.status === 404) return { key, id, action: 'deleted' }
  if (back.status === 200) return { key, id, action: 'error', detail: 'still present: the delete was answered, and the object reads back as there' }
  return { key, id, action: 'error', detail: `the delete was answered, but whether it is gone could not be read back (HTTP ${back.status})` }
}
