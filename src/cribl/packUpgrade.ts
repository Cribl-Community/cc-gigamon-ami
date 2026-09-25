// The onboarding pack's in-place upgrade.
//
// WHY A MODULE OF ITS OWN. config/policies.yml is a grant an admin gives every
// user the app is shared with, and policyCoverage.test.ts grants every call a
// reachable module makes. While `upgradePack` sat in packClient.ts — which the
// onboarding panel imports — its `PATCH /m/:gid/packs/cc-network-gigamon-ami`
// had to be granted although no control could send it, so it was split out
// here, onto paths.ts `UNREACHED_MODULES`, ungranted. Guided Setup's Upgrade
// (components/OnboardingPanel.tsx, through cribl/onboarding/run.ts
// `runPackUpgrade`) now offers it, with the read-back the design asks for: the
// pack's Raw HTTP source is read after the upgrade, and nothing is committed or
// deployed when its port, token, TLS or state was reset. So the module is
// reached, off the list, its PATCH granted and `onboarding_pack.upgrade`
// rendered. *(Corrected 2026-09-24, `feat/pack-onboarding-slice3`: this module
// was unreached, and its PATCH ungranted, until that read-back existed.)*
//
// This function checks the release, ownership and direction, and the version
// and source afterwards (`verifyInstalled`); what an upgrade does to settings
// made after install is the run's to check, not this function's.

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
