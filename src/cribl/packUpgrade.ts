// The onboarding pack's in-place upgrade, apart from packClient.ts until a
// screen offers it.
//
// WHY A MODULE OF ITS OWN. config/policies.yml is a grant an admin gives every
// user the app is shared with, and policyCoverage.test.ts grants every call a
// reachable module makes. While `upgradePack` sat in packClient.ts — which the
// onboarding panel imports — its `PATCH /m/:gid/packs/cc-network-gigamon-ami`
// had to be granted, although the only control naming it rendered refused and
// could never send it. Here, on paths.ts `UNREACHED_MODULES`, the call is named
// in `API_CALLS` and NOT granted, and `onboarding_pack.upgrade` is `unrendered`.
// The slice that offers Upgrade (with the read-back of the Raw HTTP source's
// port, token and state the design asks for) imports this, takes it off the
// list, grants the PATCH and renders the control, in one change — which is
// what the tests make it do.

import { capi, groupPath } from './capi'
import { PACK_ID, PACK_URL, PACK_VERSION } from './pack'
import { compareVersions, installRefusal, notOurs, readInstalled, verifyInstalled, type PackStep } from './packClient'
import { scrubbedErrText } from './provision'

/**
 * Upgrade an installed copy to `PACK_VERSION` in place (`PATCH /packs/<id>
 * {source}`, measured; `allowCustomFunctions: false` is not — see packClient.ts's header).
 * Only from a copy that is this app's by both signals, and never down: a newer
 * copy than this build knows is left as it is.
 */
export async function upgradePack(group: string): Promise<PackStep[]> {
  const refusal = installRefusal()
  if (refusal) return [{ key: 'pack', action: 'skipped', detail: refusal }]
  const found = await readInstalled(group)
  if ('error' in found) return [{ key: 'pack', action: 'error', detail: found.error }]
  if (!found.pack) return [{ key: 'pack', action: 'error', detail: `${PACK_ID} is not installed in ${group} — install it instead` }]
  const kept = notOurs(found.pack)
  if (kept) return [{ key: 'pack', action: 'error', detail: kept }]
  const from = found.pack.version as string
  if (from === PACK_VERSION) return [{ key: 'pack', action: 'exists', detail: `${PACK_ID} is already ${PACK_VERSION}` }]
  if (compareVersions(from, PACK_VERSION) > 0) {
    return [{ key: 'pack', action: 'error', detail: `kept — the installed ${from} is newer than the ${PACK_VERSION} this app installs` }]
  }
  const r = await capi('PATCH', groupPath(group, `/packs/${PACK_ID}`), { source: PACK_URL, allowCustomFunctions: false })
  if (r.status < 200 || r.status >= 300) return [{ key: 'pack', action: 'error', detail: scrubbedErrText(r, []) }]
  return [{ key: 'pack', action: 'updated', detail: `${PACK_ID} ${from} → ${PACK_VERSION}` }, await verifyInstalled(group, PACK_VERSION)]
}
