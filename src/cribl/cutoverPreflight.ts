// The 4c cutover preflight: is this worker group ready for Gigamon AMX to be
// re-pointed from the old global Raw HTTP source (`in_gigamon_http`) to the
// onboarding pack's Raw HTTP source — and what stands in the way if not.
//
// READ-ONLY, AND BUILT FROM THE APP'S OWN READERS. Every fact below comes from a
// function Guided Setup already calls — `readPackState` (packClient.ts),
// `checkStatus`/`checkLegacyStatus`, `pendingConfigPaths`, `deployState`
// (provision.ts — the reads `pendingDeploy` makes, without its null that means
// both "nothing pending" and "could not tell"), `listDatasets`/`listStreamGroupsCurrent`
// (lake.ts), `portsOfOthers` (packClient.ts) — so the preflight cannot disagree
// with the screen about what "owned", "present" or "behind" means, and every
// path it reads is one config/policies.yml already grants the app. Each of those
// is a GET; none submits a Search job. The runner (scripts/cutover-preflight.mjs)
// additionally installs a transport that refuses anything but a GET and any
// `/search/` path, so a reader that one day grew a write would fail here rather
// than send it; cutoverPreflight.test.ts holds both.
//
// This module has NO transport of its own (policyCoverage.test.ts allows four,
// in src/cribl): the readers are injected, `LIVE_READERS` names the real ones,
// and the tests pass fakes or run the real ones over a fake fetch.
//
// NOT MEASURED. Built 2026-09-25 (`feat/cutover-preflight`) and run only against
// fakes: it has not been run against a Leader, so no verdict it prints has yet
// been compared with what Guided Setup shows for the same group.

import { listDatasets, listStreamGroupsCurrent, type LakeDataset, type ReadResult, type StreamGroupInfo } from './lake'
import {
  PACK_ID,
  PACK_LAKE_DATASET_ID,
  PACK_PARQUET_DATASET_ID,
  PACK_SAMPLE_DATASET_ID,
  PACK_VERSION,
  type PackObjectKind,
} from './pack'
import { compareVersions, packCommitScope, portsOfOthers, readPackState, thisPackRelease, type PackState } from './packClient'
import { packObjectsOf } from './onboarding/plan'
import {
  HTTP_BREAKER_ID,
  HTTP_PIPELINE_ID,
  HTTP_ROUTE_ID,
  HTTP_SOURCE_ID,
  LEGACY_SYSLOG_PIPELINE_ID,
  LEGACY_SYSLOG_ROUTE_ID,
  LEGACY_SYSLOG_SOURCE_ID,
  checkLegacyStatus,
  checkStatus,
  commitScope,
  deployState,
  hostingOf,
  leaderHostname,
  pathInGroup,
  pendingConfigPaths,
  portProblem,
  postUrl,
  suggestedIngressHost,
  type CommitKey,
  type DeployState,
  type LegacyStatus,
  type ResourceState,
  type SetupStatus,
} from './provision'

/** Every read the preflight makes, injectable. `LIVE_READERS` is the app's own. */
export interface PreflightReaders {
  readPackState: (group: string) => Promise<PackState>
  checkStatus: (group: string) => Promise<SetupStatus>
  checkLegacyStatus: (group: string) => Promise<LegacyStatus>
  listDatasets: () => Promise<ReadResult<LakeDataset[]>>
  listStreamGroupsCurrent: () => Promise<ReadResult<StreamGroupInfo[]>>
  portsOfOthers: (group: string) => Promise<number[] | null>
  pendingConfigPaths: () => Promise<string[] | null>
  deployState: (group: string) => Promise<DeployState>
  /** Not a read: where this Leader answers (provision.ts, from `window`). */
  leaderHostname: () => string | null
  /** Not a read: the worker ingress host provision.ts would print. */
  suggestedIngressHost: (group: string, managed: boolean) => string | null
}

export const LIVE_READERS: PreflightReaders = Object.freeze({
  readPackState,
  checkStatus: (group: string) => checkStatus(group),
  checkLegacyStatus: (group: string) => checkLegacyStatus(group),
  listDatasets: () => listDatasets(),
  listStreamGroupsCurrent: () => listStreamGroupsCurrent(),
  portsOfOthers,
  pendingConfigPaths,
  deployState: (group: string) => deployState(group),
  leaderHostname,
  suggestedIngressHost,
})

/** The three datasets the pack writes, in the order the report names them. */
export const PREFLIGHT_DATASETS: readonly string[] = Object.freeze([
  PACK_LAKE_DATASET_ID,
  PACK_PARQUET_DATASET_ID,
  PACK_SAMPLE_DATASET_ID,
])

/**
 * Versions of this app's pack that deliver nothing into `gigamon_ami` from a Raw
 * HTTP POST: 0.1.0 has no Raw HTTP source (it was Syslog), and 0.1.0's and
 * 0.2.0's route filters use the global `<type>:<id>` form, which never matches
 * inside a pack (CLAUDE.md, measured 2026-09-25). Pointing AMX at either would
 * drop every event, so the preflight refuses them by name.
 */
export const NON_DELIVERING_VERSIONS: readonly string[] = Object.freeze(['0.1.0', '0.2.0'])

/**
 * What an owned, delivering copy older than this build's pin still lacks, by
 * installed version — the reason its blocker gives. Owner decision 2026-09-25
 * (`fix/preflight-block-021`): the cutover waits for `PACK_VERSION`, because
 * only 0.2.2 drops `_raw` from the Parquet copy and the owner wants no Parquet
 * row with `_raw` from the cutover on. Any owned published version older than
 * the pin blocks (`olderThanPin`); a version with no entry here gets the
 * generic sentence. 0.1.0 and 0.2.0 keep their own sentence (above).
 */
export const OLDER_VERSION_GAPS: Readonly<Record<string, string>> = Object.freeze({
  '0.2.1': `keeps _raw on every row of its Parquet copy (${PACK_PARQUET_DATASET_ID}), which 0.2.2’s Parquet pipeline removes`,
})

/** An owned (both ownership signals) copy older than this build's pin, that is
 *  not already refused by name as non-delivering. */
export function olderThanPin(p: Pick<PackState, 'version' | 'published' | 'fromRelease'>): boolean {
  return !!p.version && p.published && p.fromRelease &&
    !NON_DELIVERING_VERSIONS.includes(p.version) && compareVersions(p.version, PACK_VERSION) < 0
}

export type DatasetFact =
  | { id: string; state: 'present'; format: string | null; sizeBytes: number | null; metricsDate: string | null }
  | { id: string; state: 'absent' | 'deleting' }
  | { id: string; state: 'unreadable'; detail: string }

export interface GlobalObject {
  id: string
  kind: 'source' | 'pipeline' | 'route' | 'breaker'
  stack: 'raw-http' | 'syslog'
  state: ResourceState
}

export interface PreflightFacts {
  group: string
  /** This build's pinned pack version, and whether the build may install it. */
  pinned: { version: string; refusal: string | null }
  pack: PackState
  /** Objects the installed version ships that the group does not hold, or that
   *  could not be read — by the installed version's own ids. */
  packObjectsMissing: { kind: PackObjectKind; id: string; state: ResourceState }[]
  /** Ports the group's other sources listen on; null when unreadable. */
  otherPorts: number[] | null
  datasets: DatasetFact[]
  globalObjects: GlobalObject[]
  hosting: {
    /** Null when the group record was not found or could not be read. */
    onPrem: boolean | null
    groupRecord: 'found' | 'missing' | 'unreadable'
    leaderHost: string | null
    hosting: 'managed' | 'hybrid' | null
    ingressHost: string | null
  }
  git: {
    /** Every uncommitted path on the Leader; null when the status read failed. */
    pending: string[] | null
    /** Those that belong to this group (provision.ts `pathInGroup`: repo-wide
     *  files with no `groups/` segment count for every group). */
    inGroup: string[] | null
    /** Those of the pack's own directory in this group. */
    packFiles: string[] | null
    /** Those the global stacks' Remove would commit and refuse over — scoped,
     *  as `removeDirtyRefusal` scopes it, to the keys whose objects read
     *  `present` (none present: none). */
    globalStackFiles: string[] | null
    /** Whether the group's Workers run the Leader's HEAD, with "could not
     *  tell" kept apart from "up to date" (provision.ts `deployState`). */
    deploy: DeployState
  }
}

function datasetFacts(r: ReadResult<LakeDataset[]>): DatasetFact[] {
  if (r.outcome !== 'ok' || !r.value) {
    const detail = `the Lake dataset list (${r.object}) could not be read${r.status ? ` (HTTP ${r.status})` : ''}${r.detail ? `: ${r.detail}` : ''}`
    return PREFLIGHT_DATASETS.map((id) => ({ id, state: 'unreadable', detail }))
  }
  const list = r.value
  return PREFLIGHT_DATASETS.map((id): DatasetFact => {
    const d = list.find((x) => x.id === id)
    if (!d) return { id, state: 'absent' }
    if (d.deletionStartedAt) return { id, state: 'deleting' }
    return { id, state: 'present', format: d.format, sizeBytes: d.metrics?.currentSizeBytes ?? null, metricsDate: d.metrics?.metricsDate ?? null }
  })
}

/** The commit keys whose objects read `present` — exactly the keys Remove
 *  would delete and so commit (provision.ts `removeDirtyRefusal`). */
function presentKeys(http: SetupStatus, legacy: LegacyStatus): CommitKey[] {
  const all: [CommitKey, ResourceState][] = [
    ['source', http.source], ['pipeline', http.pipeline], ['route', http.route], ['breaker', http.breaker],
    ['legacy_source', legacy.legacy_source], ['legacy_pipeline', legacy.legacy_pipeline], ['legacy_route', legacy.legacy_route],
  ]
  return all.filter(([, st]) => st === 'present').map(([k]) => k)
}

function globalObjects(http: SetupStatus, legacy: LegacyStatus): GlobalObject[] {
  return [
    { id: HTTP_SOURCE_ID, kind: 'source', stack: 'raw-http', state: http.source },
    { id: HTTP_BREAKER_ID, kind: 'breaker', stack: 'raw-http', state: http.breaker },
    { id: HTTP_PIPELINE_ID, kind: 'pipeline', stack: 'raw-http', state: http.pipeline },
    { id: HTTP_ROUTE_ID, kind: 'route', stack: 'raw-http', state: http.route },
    { id: LEGACY_SYSLOG_SOURCE_ID, kind: 'source', stack: 'syslog', state: legacy.legacy_source },
    { id: LEGACY_SYSLOG_PIPELINE_ID, kind: 'pipeline', stack: 'syslog', state: legacy.legacy_pipeline },
    { id: LEGACY_SYSLOG_ROUTE_ID, kind: 'route', stack: 'syslog', state: legacy.legacy_route },
  ]
}

function missingObjects(pack: PackState): PreflightFacts['packObjectsMissing'] {
  if (!pack.installed) return []
  const shipped = packObjectsOf(pack.version)
  const out: PreflightFacts['packObjectsMissing'] = []
  for (const kind of Object.keys(shipped) as PackObjectKind[]) {
    for (const id of shipped[kind]) {
      // readPackState reads this build's ids; an id only an older version ships
      // (0.1.0's) was not read, and is not reported as missing.
      const state = pack.objects[kind][id]
      if (state && state !== 'present') out.push({ kind, id, state })
    }
  }
  return out
}

/** Read everything the verdict needs. GETs only — see the header. */
export async function gatherPreflight(group: string, readers: PreflightReaders = LIVE_READERS): Promise<PreflightFacts> {
  const [pack, http, legacy, datasets, groups, otherPorts, pending, deploy] = await Promise.all([
    readers.readPackState(group),
    readers.checkStatus(group),
    readers.checkLegacyStatus(group),
    readers.listDatasets(),
    readers.listStreamGroupsCurrent(),
    readers.portsOfOthers(group),
    readers.pendingConfigPaths(),
    readers.deployState(group),
  ])
  const removeKeys = presentKeys(http, legacy)
  const rec = groups.outcome === 'ok' ? (groups.value ?? []).find((x) => x.id === group) ?? null : null
  const leaderHost = readers.leaderHostname()
  const hosting = rec ? hostingOf(rec.onPrem, leaderHost) : null
  const release = thisPackRelease()
  return {
    group,
    pinned: { version: release.version, refusal: release.refusal },
    pack,
    packObjectsMissing: missingObjects(pack),
    otherPorts,
    datasets: datasetFacts(datasets),
    globalObjects: globalObjects(http, legacy),
    hosting: {
      onPrem: rec?.onPrem ?? null,
      groupRecord: groups.outcome !== 'ok' ? 'unreadable' : rec ? 'found' : 'missing',
      leaderHost,
      hosting,
      ingressHost: readers.suggestedIngressHost(group, hosting === 'managed'),
    },
    git: {
      pending,
      inGroup: pending === null ? null : pending.filter((p) => pathInGroup(p, group)),
      packFiles: pending === null ? null : packCommitScope(group, pending).alreadyDirty,
      globalStackFiles: pending === null ? null : removeKeys.length ? commitScope(group, removeKeys, pending).alreadyDirty : [],
      deploy,
    },
  }
}

// ── The verdict ─────────────────────────────────────────────────────────────

export interface PreflightVerdict {
  ready: boolean
  /** `host:port` to point Gigamon AMX at, when ready. The host is a placeholder
   *  sentence when it cannot be derived (a hybrid group, or a group other than
   *  `default`), never a guess. */
  target: string | null
  /** The URL AMX POSTs to, when the host is known. */
  url: string | null
  /** What stops the cutover, in plain words. Empty exactly when `ready`. */
  blockers: string[]
  /** True, and worth reading, but not blocking. */
  warnings: string[]
  /** What the cutover's last step (Remove in Guided Setup) will meet. */
  afterCutover: string[]
}

const UNKNOWN_HOST = '<this group’s worker ingress host>'
const list = (xs: readonly string[]) => xs.join(', ')

export function preflightVerdict(f: PreflightFacts): PreflightVerdict {
  const blockers: string[] = []
  const warnings: string[] = []
  const afterCutover: string[] = []
  const p = f.pack

  // The pack.
  if (p.error) blockers.push(`The pack list of ${f.group} could not be read (${p.error}), so nothing about the pack is known.`)
  else if (!p.installed) blockers.push(`${PACK_ID} is not installed in ${f.group}. Run Onboard in Guided Setup first.`)
  else {
    if (!p.published || !p.fromRelease) {
      blockers.push(
        `The installed ${PACK_ID} ${p.version ?? '(no version)'} is not this app’s: ` +
          (!p.published ? 'this app did not publish that version' : 'the pack list does not name this app’s release of that version as its source') +
          '. Guided Setup will neither upgrade nor remove it.',
      )
    }
    if (p.version && NON_DELIVERING_VERSIONS.includes(p.version)) {
      blockers.push(`${PACK_ID} ${p.version} delivers nothing from a Raw HTTP POST (its routes never match inside a pack). Upgrade it in Guided Setup first.`)
    } else if (olderThanPin(p)) {
      const gap = OLDER_VERSION_GAPS[p.version as string]
      blockers.push(
        `${PACK_ID} ${p.version} is installed; this build pins ${PACK_VERSION}` + (gap ? `, and ${p.version} ${gap}` : '') +
          `. Upgrade it to ${PACK_VERSION} from Guided Setup’s onboarding panel (Upgrade) before pointing AMX at it` +
          (f.pinned.refusal ? ` (Upgrade is not offered yet: ${f.pinned.refusal})` : '') + '.',
      )
    } else if (!p.current && p.published && p.fromRelease) {
      // Owned and not older, yet not current: a version newer than this build's
      // pin that this build also lists as published. The real readers cannot
      // produce it (a version newer than the pin is not on PACK_PUBLISHED_VERSIONS,
      // so it reads unpublished and is blocked above as not this app's); this
      // branch is kept as it was before the 0.2.1 decision.

      warnings.push(
        `${PACK_ID} ${p.version} is installed; this build pins ${PACK_VERSION}. It delivers, but Upgrade is offered in Guided Setup` +
          (f.pinned.refusal ? ` (not yet: ${f.pinned.refusal})` : '') + '.',
      )
    }
    for (const m of f.packObjectsMissing) {
      blockers.push(`The pack’s ${m.kind.replace(/s$/, '')} ${m.id} is ${m.state === 'absent' ? 'missing from' : 'unreadable in'} ${f.group}.`)
    }
  }

  // The pack's Raw HTTP source.
  const h = p.installed && !p.error ? p.http : null
  if (p.installed && !p.error) {
    if (!h) blockers.push(`The pack has no Raw HTTP source in ${f.group} (or its source list could not be read).`)
    else {
      if (!h.tokenSet) blockers.push('The pack’s Raw HTTP source has no auth token. Finish onboarding (Onboard) in Guided Setup to set one.')
      if (h.disabled) blockers.push('The pack’s Raw HTTP source is stopped (disabled). Onboard in Guided Setup starts it.')
      if (h.port === null) blockers.push('The pack’s Raw HTTP source has no port this preflight can read.')
      else {
        const clash = portProblem(h.port, f.hosting.hosting === 'managed', f.otherPorts)
        if (clash) blockers.push(`Port ${h.port}: ${clash}`)
      }
      if (f.hosting.hosting === 'managed' && !h.tls) {
        warnings.push('The group is Cribl-managed and the pack’s source does not terminate TLS; Cribl.Cloud ingress normally expects it to.')
      }
    }
  }
  if (p.sample && !p.sample.disabled) warnings.push(`The pack’s sample source is running; it writes only to ${PACK_SAMPLE_DATASET_ID}.`)

  // The datasets.
  const unreadable = f.datasets.find((d) => d.state === 'unreadable')
  if (unreadable && unreadable.state === 'unreadable') blockers.push(`The datasets are unknown: ${unreadable.detail}.`)
  for (const d of f.datasets) {
    const needed = d.id === PACK_LAKE_DATASET_ID || d.id === PACK_PARQUET_DATASET_ID
    if (d.state !== 'present' && d.state !== 'unreadable') {
      const words = d.state === 'deleting' ? 'is being deleted' : 'does not exist'
      if (needed) blockers.push(`Dataset ${d.id} ${words}; the pack’s destination for it would have nowhere to write. Onboard in Guided Setup creates it.`)
    }
  }

  // Git and deploy.
  if (f.git.pending === null) {
    blockers.push('Git’s status could not be read, so this preflight cannot tell whether the pack’s settings are committed.')
  } else if (f.git.packFiles && f.git.packFiles.length) {
    blockers.push(`The pack has uncommitted changes in ${f.group} (${list(f.git.packFiles)}); the Workers are not running them. Commit and deploy them first.`)
  }
  // Fails closed: "could not tell" is a blocker, exactly as an unreadable Git
  // status is above — a pack committed and never deployed has no Worker
  // listening on its port, and that is the case this check exists for.
  const d = f.git.deploy
  if (d.state === 'unreadable') {
    blockers.push(`Whether ${f.group}’s Workers run what the Leader holds could not be told: ${d.detail}. Check the group’s deploy state in Cribl Stream, then run this again.`)
  } else if (d.state === 'behind' && d.proof === 'touches') {
    blockers.push(`${f.group} is behind the Leader’s HEAD (${d.head}; it runs ${d.deployed}), and a commit in between touches it: its Workers are not running what the Leader holds. Deploy the group first.`)
  } else if (d.state === 'behind' && d.proof === 'unknown') {
    blockers.push(`${f.group} is not running the Leader’s HEAD (${d.head}; it runs ${d.deployed}), and whether a commit in between touches it could not be told: ${d.detail}. Deploy the group first, or check it in Cribl Stream.`)
  } else if (d.state === 'behind') {
    warnings.push(`${f.group} is not running the Leader’s HEAD (${d.head}; it runs ${d.deployed}); every commit in between was read and none touches this group.`)
  }
  if (f.git.inGroup && f.git.inGroup.length && !(f.git.packFiles ?? []).length) {
    warnings.push(`Uncommitted in ${f.group}: ${list(f.git.inGroup)}.`)
  }

  // Hosting — never a blocker, but it decides whether the host is known.
  if (f.hosting.groupRecord !== 'found') {
    warnings.push(`The group record for ${f.group} was ${f.hosting.groupRecord === 'missing' ? 'not found' : 'unreadable'}, so hosting (Cribl-managed or hybrid) is unknown.`)
  } else if (f.hosting.hosting === null) {
    warnings.push('Hosting could not be told (managed needs the group record’s onPrem=false and a Cribl.Cloud Leader host; pass --leader).')
  }

  // What Remove will meet after the cutover.
  const present = f.globalObjects.filter((o) => o.state === 'present')
  const unknown = f.globalObjects.filter((o) => o.state === 'unreadable')
  if (present.length) afterCutover.push(`Guided Setup’s Remove will find: ${list(present.map((o) => `${o.id} (${o.stack} ${o.kind})`))}.`)
  if (unknown.length) afterCutover.push(`Could not be read: ${list(unknown.map((o) => o.id))}.`)
  if (!present.length && !unknown.length) afterCutover.push('No global stack object is present: there is nothing for Remove to take.')
  if (f.git.globalStackFiles && f.git.globalStackFiles.length) {
    afterCutover.push(
      `Remove will refuse while these files it commits are already uncommitted (unless they are its own failed removal): ${list(f.git.globalStackFiles)}.`,
    )
  }
  if (present.some((o) => o.id === HTTP_SOURCE_ID)) {
    afterCutover.push(`Re-point Gigamon AMX before removing ${HTTP_SOURCE_ID}: while AMX still posts to it, Remove stops that feed.`)
  }

  const ready = blockers.length === 0
  const port = h?.port ?? null
  const host = f.hosting.ingressHost
  return {
    ready,
    target: ready && port !== null ? `${host ?? UNKNOWN_HOST}:${port}` : null,
    url: ready && port !== null && host && h ? postUrl(host, port, h.tls) : null,
    blockers,
    warnings,
    afterCutover,
  }
}

// ── The report ──────────────────────────────────────────────────────────────

function bytes(n: number | null): string {
  if (n === null) return 'size not reported'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

const yesNo = (b: boolean) => (b ? 'yes' : 'no')

/** The plain-text report. Carries no token: `PackState` holds only whether one
 *  is set, and nothing here reads a source body. */
export function preflightReport(f: PreflightFacts, v: PreflightVerdict): string[] {
  const out: string[] = []
  const p = f.pack
  out.push(`Cutover preflight — worker group "${f.group}" (read-only)`)
  out.push('')
  out.push('Pack')
  if (p.error) out.push(`  could not be read: ${p.error}`)
  else if (!p.installed) out.push(`  ${PACK_ID}: not installed`)
  else {
    out.push(`  ${PACK_ID} ${p.version ?? '(no version)'} — this build pins ${f.pinned.version}${f.pinned.refusal ? ` (${f.pinned.refusal})` : ''}`)
    out.push(`  owned: ${yesNo(p.published && p.fromRelease)} (published by this app: ${yesNo(p.published)}; installed from its release: ${yesNo(p.fromRelease)})`)
    out.push(`  current: ${yesNo(p.current)}`)
    if (f.packObjectsMissing.length) out.push(`  objects not present: ${list(f.packObjectsMissing.map((m) => `${m.id} (${m.state})`))}`)
    const h = p.http
    out.push(h
      ? `  Raw HTTP source: ${h.disabled ? 'stopped' : 'enabled'}, port ${h.port ?? 'unknown'}, TLS ${h.tls ? 'on' : 'off'}, token ${h.tokenSet ? 'set' : 'NOT set'}`
      : '  Raw HTTP source: none')
    out.push(p.sample ? `  sample source: ${p.sample.disabled ? 'stopped' : 'running'}` : '  sample source: none')
  }
  out.push('')
  out.push('Datasets (Lake listing; size is Lake’s dated on-disk figure)')
  for (const d of f.datasets) {
    if (d.state === 'present') out.push(`  ${d.id}: present, ${d.format ?? 'format not reported'}, ${bytes(d.sizeBytes)}${d.metricsDate ? ` as of ${d.metricsDate}` : ''}`)
    else if (d.state === 'unreadable') out.push(`  ${d.id}: unreadable`)
    else out.push(`  ${d.id}: ${d.state === 'deleting' ? 'being deleted' : 'absent'}`)
  }
  out.push('')
  out.push('Global stacks (earlier releases)')
  for (const o of f.globalObjects) out.push(`  ${o.id} (${o.stack} ${o.kind}): ${o.state}`)
  out.push('')
  out.push('Git and deploy')
  if (f.git.pending === null) out.push('  status: could not be read')
  else {
    out.push(`  uncommitted in ${f.group}: ${f.git.inGroup?.length ? list(f.git.inGroup) : 'none'}`)
    out.push(`  of which the pack’s: ${f.git.packFiles?.length ? list(f.git.packFiles) : 'none'}`)
  }
  const d = f.git.deploy
  out.push(
    d.state === 'unreadable' ? `  deployed: could not be told (${d.detail})`
      : d.state === 'current' ? `  deployed: runs the Leader’s HEAD (${d.head})`
        : `  deployed: runs ${d.deployed}, the Leader’s HEAD is ${d.head} — ` +
          (d.proof === 'touches' ? `a commit in between touches ${f.group}` : d.proof === 'clear' ? `no commit in between touches ${f.group}` : `could not tell whether a commit in between touches ${f.group} (${d.detail})`),
  )
  out.push('')
  out.push('Hosting')
  out.push(`  ${f.hosting.hosting ?? 'unknown'} (group record ${f.hosting.groupRecord}${f.hosting.onPrem === null ? '' : `, onPrem ${f.hosting.onPrem}`}; Leader host ${f.hosting.leaderHost ?? 'unknown'})`)
  out.push(`  worker ingress host: ${f.hosting.ingressHost ?? 'not derivable here'}`)
  out.push('')
  out.push('Verdict')
  if (v.ready) {
    out.push(`  Ready to point AMX at ${v.target}${v.url ? ` (${v.url})` : ''}.`)
    out.push('  Use the token Guided Setup showed once at onboarding; if it was not kept, Rotate token issues a new one.')
  } else {
    out.push('  NOT READY:')
    for (const b of v.blockers) out.push(`  - ${b}`)
  }
  if (v.warnings.length) {
    out.push('  Also:')
    for (const w of v.warnings) out.push(`  - ${w}`)
  }
  out.push('  After the cutover:')
  for (const a of v.afterCutover) out.push(`  - ${a}`)
  return out
}
