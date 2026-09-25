/// <reference types="vite/client" />
// The in-place upgrade of the onboarding pack: its confirmation (pure) and its
// run, against a fake Leader stubbed at `fetch`, so what is asserted is what a
// Leader would receive, in order.
//
// What is held still (design §5 and §8 item 11, the Upgrade half):
//   * the dialog lists the objects the new version adds, and names (never as a
//     delete) the ones it no longer ships, by the
//     installed version's own ids (0.1.0's from PACK_0_1_0), the commit's scope
//     and its consequences, and says plainly that settings made after install
//     are NOT verified to survive an upgrade;
//   * a copy this app did not install from its own release, a copy newer than
//     this build installs (a downgrade), and a build with no release recorded
//     are each refused before anything is sent;
//   * after the PATCH the Raw HTTP source is read back, and when it lost its
//     token, port, on state or TLS, NOTHING is committed or deployed, and the
//     step says another admin's commit and deploy would push the reset;
//   * otherwise the pack's own files, and only those, are committed and
//     deployed;
//   * something that moved between the dialog and the run writes nothing;
//   * a pack source list that cannot be read is never "no source": refused
//     before the dialog, at the run, and after the PATCH (nothing committed);
//   * a group's own TLS certificate put back to the pack's is a reset;
//   * a copy that became current before the PATCH, and a PATCH whose version
//     did not move, commit nothing (the second says so in a held step).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PACK_0_1_0, PACK_HTTP_INPUT_ID, PACK_ID, PACK_OBJECTS, PACK_SAMPLE_INPUT_ID, PACK_URL, PACK_VERSION, packRelease, packReleaseUrl } from '../pack'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SHIPPED = (parse(readFileSync(join(ROOT, 'packs', PACK_ID, 'default', 'inputs.yml'), 'utf8')) as {
  inputs: Record<string, Record<string, unknown>>
}).inputs

const GROUP = 'default'
const HASH = 'dddd000011112222dddd000011112222dddd0000'
const OLD_TOKEN = 'e'.repeat(64)
const P = `/m/${GROUP}/p/${PACK_ID}`
const PACK_ITEM = `/m/${GROUP}/packs/${PACK_ID}`
/** A version this app "published" in these tests only, holding 0.2.0's objects,
 *  so an upgrade from a copy whose Raw HTTP source was configured can be run. */
const MID = '0.1.9'
/** A later release than this build installs, from its own release: a downgrade to refuse. */
const NEWER = '9.0.0'

interface Call { method: string; path: string; body: unknown }
let calls: Call[] = []

interface World {
  packs: Array<Record<string, unknown>>
  inputs: Record<string, Record<string, unknown>>
  pending: string[]
  committed: string[][]
}
let world: World

interface Opts {
  /** The installed copy: its version and where the pack list says it came from. */
  copy: { version: string; source: string }
  /** The copy's Raw HTTP source, over the shipped one (null: none, as in 0.1.0). */
  http?: Record<string, unknown> | null
  /** What the upgrade does to local settings on the Raw HTTP source.
   *  `resetsTls`: everything kept but the TLS block, which goes back to the
   *  pack's shipped one. `unverified`: the PATCH answers 200 and the pack list
   *  still names the old version, so the install check fails. */
  upgrade?: 'keeps' | 'resets' | 'resetsTls' | 'fails' | 'unverified'
  failCommit?: boolean
  /** The pack's source list answers 503 from this read on (1-based): 1 is
   *  prepare's, 2 the run's re-read, 3 the read-back after the PATCH. */
  inputsFailFrom?: number
  /** The pack list names this build's version from this read on (1-based):
   *  somebody else upgraded the copy while the run was in flight. */
  currentFrom?: number
  /** With `http: null` (0.1.0): 0.1.0's own sample DataGen, `in_gno_sample`,
   *  is in the pack, running (`true`) or stopped (`false`). */
  sample010?: boolean
}

const shipped = (id: string) => ({ id, ...structuredClone(SHIPPED[id]) })
const CONFIGURED = { disabled: false, port: 20007, authTokensExt: [{ token: OLD_TOKEN, authType: 'manual' }] }

function reply(status: number, value?: unknown) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown } as unknown as Response
}

function leader(o: Opts): void {
  calls = []
  const w: World = {
    packs: [{ id: PACK_ID, ...o.copy }],
    inputs: o.http === null
      ? {
        in_gno_syslog: { id: 'in_gno_syslog', type: 'syslog', port: 20003 },
        ...(o.sample010 === undefined ? {} : { [PACK_0_1_0.inputs.sample]: { id: PACK_0_1_0.inputs.sample, type: 'datagen', disabled: !o.sample010 } }),
      }
      : { [PACK_HTTP_INPUT_ID]: { ...shipped(PACK_HTTP_INPUT_ID), ...(o.http ?? CONFIGURED) }, [PACK_SAMPLE_INPUT_ID]: shipped(PACK_SAMPLE_INPUT_ID) },
    pending: [],
    committed: [],
  }
  world = w
  let inputReads = 0
  let packReads = 0
  window.__CRIBL_SEARCH_ORIGIN = 'https://main-acme.cribl.cloud'
  vi.stubGlobal('getCriblUser', async () => ({ id: 'auth0|me', username: 'me' }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url).replace(/^\/capi/, '').split('?')[0]
    const raw = init.body == null ? undefined : String(init.body)
    let body: unknown = raw
    try { body = raw === undefined ? undefined : JSON.parse(raw) } catch { /* text */ }
    calls.push({ method, path, body })
    const at = (m: string, p: string) => method === m && path === p

    if (path.startsWith('/kvstore')) return method === 'GET' ? reply(404, '') : reply(200, '')
    if (at('GET', '/products/stream/groups')) return reply(200, { items: [{ id: GROUP, name: GROUP, onPrem: false, configVersion: 'aaaa1111' }] })
    if (at('GET', `/products/stream/groups/${GROUP}`)) return reply(200, { items: [{ id: GROUP, configVersion: 'aaaa1111' }] })
    if (at('GET', '/version')) return reply(200, { items: [{ hash: 'aaaa1111', refs: 'HEAD -> main' }] })
    if (at('GET', `/m/${GROUP}/packs`)) {
      packReads++
      if (o.currentFrom !== undefined && packReads >= o.currentFrom) w.packs = [{ id: PACK_ID, version: PACK_VERSION, source: PACK_URL }]
      return reply(200, { items: w.packs })
    }
    if (at('PATCH', PACK_ITEM)) {
      if (o.upgrade === 'fails') return reply(500, { message: 'the Leader could not fetch the release' })
      if (o.upgrade === 'unverified') return reply(200, { items: [{ id: PACK_ID }] })
      const http = w.inputs[PACK_HTTP_INPUT_ID]
      w.packs = [{ id: PACK_ID, version: PACK_VERSION, source: (body as { source: string }).source }]
      w.inputs = {
        [PACK_HTTP_INPUT_ID]: o.upgrade === 'keeps' && http ? http
          : o.upgrade === 'resetsTls' && http ? { ...http, tls: (shipped(PACK_HTTP_INPUT_ID) as Record<string, unknown>).tls }
            : shipped(PACK_HTTP_INPUT_ID),
        [PACK_SAMPLE_INPUT_ID]: shipped(PACK_SAMPLE_INPUT_ID),
      }
      w.pending.push(`groups/${GROUP}/default/${PACK_ID}/package.json`)
      return reply(200, { items: [{ id: PACK_ID }] })
    }
    if (at('GET', `${P}/system/inputs`)) {
      inputReads++
      if (o.inputsFailFrom !== undefined && inputReads >= o.inputsFailFrom) return reply(503, { message: 'unavailable' })
      return reply(200, { items: Object.values(w.inputs) })
    }
    for (const id of [PACK_HTTP_INPUT_ID, PACK_SAMPLE_INPUT_ID]) {
      if (at('GET', `${P}/system/inputs/${id}`)) return w.inputs[id] ? reply(200, { items: [w.inputs[id]] }) : reply(404, {})
    }
    if (method === 'GET' && path.startsWith(`${P}/`)) return reply(200, { items: [] })
    if (at('GET', '/version/status')) return reply(200, { items: [{ files: w.pending.map((f) => ({ path: f })) }] })
    if (at('POST', '/version/commit')) {
      if (o.failCommit) return reply(500, { message: 'commit refused' })
      const files = (body as { files: string[] }).files
      w.committed.push(files)
      w.pending = w.pending.filter((f) => !files.includes(f))
      return reply(200, { items: [{ commit: HASH }] })
    }
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(200, { items: [] })
    return reply(599, { message: `no route for ${method} ${path}` })
  })
}

const writes = () => calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))
const writeWords = () => writes().map((c) =>
  c.path === PACK_ITEM ? 'upgrade' : c.path === '/version/commit' ? 'commit' : c.path.endsWith('/deploy') ? 'deploy' : `${c.method} ${c.path}`)

type Run = typeof import('./run')
type Plan = typeof import('./plan')

async function load(opts: { published?: boolean } = {}): Promise<{ run: Run; plan: Plan }> {
  vi.resetModules()
  if (opts.published === false) {
    // A build that pins a version before its release, as this one pinned
    // 0.2.1 until 2026-09-25: the constants a release moves, moved back.
    vi.doMock('../pack', async (orig) => {
      const real = await orig<typeof import('../pack')>()
      return {
        ...real,
        PACK_PUBLISHED: false, PACK_SHA256: null,
        PACK_PUBLISHED_VERSIONS: Object.freeze(real.PACK_PUBLISHED_VERSIONS.filter((v) => v !== real.PACK_VERSION)),
      }
    })
  } else {
    vi.doMock('../pack', async (orig) => ({
      ...(await orig<typeof import('../pack')>()),
      PACK_PUBLISHED: true, PACK_SHA256: 'ab'.repeat(32), PACK_PUBLISHED_VERSIONS: Object.freeze(['0.1.0', MID, '0.2.0', PACK_VERSION, NEWER]),
    }))
  }
  const [run, plan] = await Promise.all([import('./run'), import('./plan')])
  return { run, plan }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../pack')
  vi.resetModules()
  delete window.__CRIBL_SEARCH_ORIGIN
})

/** Prepare, build the dialog, optionally move the world, then run. */
async function upgrade(o: { between?: () => void; published?: boolean } = {}) {
  const { run, plan } = await load({ published: o.published })
  const prepared = await run.prepareUpgrade(GROUP, { undeployed: null, undeployedChecking: false })
  if (!prepared.ok) return { prepared, out: null, dialog: null }
  const dialog = plan.packUpgradeDialog(prepared.ctx)
  o.between?.()
  const records: string[] = []
  const steps: Array<{ key: string; action: string; detail?: string }> = []
  const out = await run.runPackUpgrade(prepared.ctx, dialog, { onStep: (s) => { steps.push(s) }, record: async (h) => { records.push(h) } })
  return { prepared, out, dialog, records, steps }
}

// ── The confirmation ────────────────────────────────────────────────────────

describe('the Upgrade confirmation', () => {
  it('0.1.0 → this build: 0.1.0’s own objects are dropped (not claimed removed) and every current one is added, by id', async () => {
    const { plan } = await load()
    const changes = plan.upgradeObjectChanges('0.1.0')
    expect(changes.dropped.map((c) => c.id).sort()).toEqual([
      ...Object.values(PACK_0_1_0.inputs), ...Object.values(PACK_0_1_0.pipelines),
      ...Object.values(PACK_0_1_0.routes), ...Object.values(PACK_0_1_0.outputs),
    ].sort())
    expect(changes.added.map((c) => c.id).sort()).toEqual(Object.values(PACK_OBJECTS).flat().sort())
    expect(changes.kept).toEqual([])
  })

  it('names the pack, each object added or no longer shipped, the deploy, the commit’s scope, and that settings are not verified to survive', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null })
    const { run, plan } = await load()
    const prepared = await run.prepareUpgrade(GROUP, { undeployed: null, undeployedChecking: false })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const d = plan.packUpgradeDialog(prepared.ctx)
    expect(d.title).toBe(`Upgrade the Gigamon AMI pack in ${GROUP} to ${PACK_VERSION}`)
    expect(d.resources[0]).toMatchObject({ action: 'replace', kind: 'Pack', id: PACK_ID, group: GROUP })
    expect(d.resources[0].detail).toContain(`0.1.0 → ${PACK_VERSION}`)
    expect(d.resources[0].detail).toContain('custom functions refused')
    const rows = (action: string) => d.resources.filter((r) => r.action === action).map((r) => r.id)
    // An object 0.1.0 shipped and this build does not is NOT a delete row: a
    // copy the tenant changed after install survives the upgrade, as an orphan
    // (measured on a Leader). It is named in a sentence that says so.
    expect(rows('delete')).toEqual([])
    for (const id of [...Object.values(PACK_0_1_0.inputs), ...Object.values(PACK_0_1_0.pipelines), ...Object.values(PACK_0_1_0.routes), ...Object.values(PACK_0_1_0.outputs)]) {
      expect(d.resources.map((r) => r.id), id).not.toContain(id)
    }
    expect(rows('create')).toContain(PACK_HTTP_INPUT_ID)
    expect(rows('create')).toContain('gigamon_ami_http_to_parquet')
    expect(rows('deploy')).toEqual([GROUP])
    const said = d.consequences.join(' ')
    expect(said).toContain('have not been verified to survive an upgrade')
    expect(said).toContain('commits and deploys nothing')
    expect(said).toContain(`The change is committed and deployed to ${GROUP}`)
    expect(said).toContain('Deploying restarts this worker group’s Worker Processes.')
    // 0.1.0 has no Raw HTTP source: the new one arrives off, without a token.
    expect(said).toContain(`${PACK_HTTP_INPUT_ID} arrives switched off and without an auth token`)
    expect(said).toContain(`${PACK_VERSION} no longer ships in_gno_syslog, in_gno_sample, gno_syslog, gno_sample`)
    expect(said).toContain('out_gno_lake')
    expect(said).toContain('stays in the pack’s local settings, left over')
    expect(said).toContain('This upgrade does not remove leftovers.')
    // The sources it no longer ships: they stop listening only if unchanged.
    expect(said).toContain('After the deploy, in_gno_syslog, in_gno_sample stop listening — unless one was changed after install')
    expect(d.undo).toMatch(/does not downgrade/)
    expect(writes()).toEqual([])
  })

  it('upgradeReadBack: a lost token, port, on state or TLS is a reset; a source that was not there has nothing to lose', async () => {
    const { plan } = await load()
    const on = { port: 20007, tokenSet: true, disabled: false, tls: true, tlsCert: '$CRIBL_CLOUD_CRT $CRIBL_CLOUD_KEY' }
    expect(plan.upgradeReadBack({ http: on, sample: null }, { http: on, sample: null }).reset).toEqual([])
    expect(plan.upgradeReadBack({ http: on, sample: null }, { http: { ...on, tokenSet: false }, sample: null }).reset).toEqual(['its auth token'])
    expect(plan.upgradeReadBack({ http: on, sample: null }, { http: { ...on, port: 20005 }, sample: null }).reset).toEqual(['its port (20007, now 20005)'])
    expect(plan.upgradeReadBack({ http: on, sample: null }, { http: { ...on, disabled: true }, sample: null }).reset).toEqual(['its on state'])
    expect(plan.upgradeReadBack({ http: on, sample: null }, { http: { ...on, tls: false }, sample: null }).reset).toEqual(['its TLS'])
    expect(plan.upgradeReadBack({ http: on, sample: null }, { http: null, sample: null }).reset).toEqual([`${PACK_HTTP_INPUT_ID} itself`])
    // A stopped source that stays stopped lost nothing.
    const off = { ...on, disabled: true }
    expect(plan.upgradeReadBack({ http: off, sample: null }, { http: off, sample: null }).reset).toEqual([])
    // 0.1.0 had no Raw HTTP source: nothing to lose, whatever arrives.
    expect(plan.upgradeReadBack({ http: null, sample: null }, { http: { ...on, port: 20005, tokenSet: false, disabled: true }, sample: null }).reset).toEqual([])
    // TLS on both sides, but the group's own certificate replaced by the pack's.
    const own = { ...on, tlsCert: '/opt/certs/gno.crt /opt/certs/gno.key' }
    expect(plan.upgradeReadBack({ http: own, sample: null }, { http: on, sample: null }).reset).toEqual(['its TLS certificate'])
    // A sample that was running and is now stopped is said, and does not block.
    const s = plan.upgradeReadBack({ http: null, sample: { id: PACK_SAMPLE_INPUT_ID, disabled: false } }, { http: null, sample: { id: PACK_SAMPLE_INPUT_ID, disabled: true } })
    expect(s.reset).toEqual([])
    expect(s.notes.join(' ')).toContain(`${PACK_SAMPLE_INPUT_ID} was running and is not now`)
    // …by the id each side had: 0.1.0's sample before, this build's after.
    const moved = plan.upgradeReadBack(
      { http: null, sample: { id: PACK_0_1_0.inputs.sample, disabled: false } },
      { http: null, sample: { id: PACK_SAMPLE_INPUT_ID, disabled: true } },
    )
    expect(moved.notes.join(' ')).toContain(`${PACK_0_1_0.inputs.sample} was running before the upgrade, and ${PACK_SAMPLE_INPUT_ID}`)
  })
})

// ── 0.1.0's own sample source ───────────────────────────────────────────────

describe('a 0.1.0 copy whose sample DataGen was running', () => {
  // 0.1.0's sample source is `in_gno_sample` (PACK_0_1_0), not this build's
  // `in_gigamon_ami_sample`. The before-state has to be read by the INSTALLED
  // version's id, or a running 0.1.0 sample reads as "no sample source" and
  // the upgrade that stops it says nothing.
  it('is read by 0.1.0’s own id before the upgrade, and the read-back says it is not running now', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null, sample010: true })
    const r = await upgrade()
    expect(r.prepared.ok).toBe(true)
    if (!r.prepared.ok) return
    expect(r.prepared.ctx.before.sample).toEqual({ id: PACK_0_1_0.inputs.sample, disabled: false })
    expect(r.out?.stopped).toBeNull()
    const warned = r.steps!.filter((s) => s.key === 'readback' && (s as { warning?: boolean }).warning)
    expect(warned.map((s) => s.detail).join(' ')).toContain(`${PACK_0_1_0.inputs.sample} was running`)
    expect(warned.map((s) => s.detail).join(' ')).toContain(PACK_SAMPLE_INPUT_ID)
    // Said, not blocking: the upgrade is committed and deployed.
    expect(writeWords()).toEqual(['upgrade', 'commit', 'deploy'])
  })

  it('stopped before the upgrade: nothing to say', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null, sample010: false })
    const r = await upgrade()
    expect(r.out?.stopped).toBeNull()
    expect(r.steps!.some((s) => s.key === 'readback' && (s as { warning?: boolean }).warning)).toBe(false)
  })
})

// ── What prepare refuses ────────────────────────────────────────────────────

describe('refused before anything is sent', () => {
  it('a copy this app did not install from its own release', async () => {
    leader({ copy: { version: '0.1.0', source: 'https://elsewhere.example.com/fork.crbl' } })
    const { prepared } = await upgrade()
    expect(prepared.ok).toBe(false)
    expect(writes()).toEqual([])
  })

  it('a copy newer than this build installs: no downgrade', async () => {
    leader({ copy: { version: NEWER, source: packReleaseUrl(NEWER) } })
    const { prepared } = await upgrade()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.why).toMatch(/newer than the .* this app installs/)
    expect(writes()).toEqual([])
  })

  it('a copy already current', async () => {
    leader({ copy: { version: PACK_VERSION, source: PACK_URL } })
    const { prepared } = await upgrade()
    expect(prepared.ok).toBe(false)
    expect(writes()).toEqual([])
  })

  it('while this build records no release: the release’s own sentence, and nothing sent', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null })
    const { prepared } = await upgrade({ published: false })
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.why).toBe(packRelease({ published: false, sha256: null, version: PACK_VERSION }).refusal)
    expect(writes()).toEqual([])
  })

  it('a run handed a dialog anyway, in a build with no release: step 0 re-reads the release, zero writes', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null })
    const { run: published, plan } = await load()
    const prepared = await published.prepareUpgrade(GROUP, { undeployed: null, undeployedChecking: false })
    if (!prepared.ok) throw new Error(prepared.why)
    const dialog = plan.packUpgradeDialog(prepared.ctx)
    const { run } = await load({ published: false })
    const out = await run.runPackUpgrade(prepared.ctx, dialog, { onStep: () => {}, record: async () => {} })
    expect(out.stopped?.key).toBe('precheck')
    expect(writes()).toEqual([])
  })
})

// ── The run ─────────────────────────────────────────────────────────────────

describe('the run', () => {
  it('0.1.0 → current: PATCH the pack, read back, then commit the pack’s files and deploy', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null })
    const r = await upgrade()
    expect(r.out?.stopped).toBeNull()
    expect(writeWords()).toEqual(['upgrade', 'commit', 'deploy'])
    expect(writes()[0].body).toEqual({ source: PACK_URL, allowCustomFunctions: false })
    for (const f of world.committed[0]) expect(f).toContain(`/${PACK_ID}/`)
    expect(r.records).toEqual([HASH])
  })

  it('a configured source that keeps its token, port and state: committed and deployed', async () => {
    leader({ copy: { version: MID, source: packReleaseUrl(MID) }, upgrade: 'keeps' })
    const r = await upgrade()
    expect(r.out?.stopped).toBeNull()
    expect(writeWords()).toEqual(['upgrade', 'commit', 'deploy'])
  })

  it('a configured source the upgrade reset: NO commit and NO deploy, and the step says who could push it', async () => {
    leader({ copy: { version: MID, source: packReleaseUrl(MID) }, upgrade: 'resets' })
    const r = await upgrade()
    expect(writeWords()).toEqual(['upgrade'])
    expect(r.out?.stopped?.action).toBe('error')
    const said = r.out?.stopped?.detail ?? ''
    expect(said).toContain('Nothing was committed or deployed')
    expect(said).toContain('its auth token')
    expect(said).toContain('its port (20007, now 20005)')
    expect(said).toContain('its on state')
    expect(said).toMatch(/another admin’s commit and deploy of default would push the reset/)
    expect(said).not.toContain(OLD_TOKEN)
    expect(r.records).toEqual([])
  })

  it('a failed PATCH: no commit, no deploy', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null, upgrade: 'fails' })
    const r = await upgrade()
    expect(writeWords()).toEqual(['upgrade'])
    expect(r.out?.stopped?.key).toBe('pack')
  })

  it('a failed commit: nothing deployed', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null, failCommit: true })
    const r = await upgrade()
    expect(writeWords()).toEqual(['upgrade', 'commit'])
    expect(r.out?.stopped?.key).toBe('commit')
  })

  it('the copy was replaced by a foreign one after the dialog: zero writes', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null })
    const r = await upgrade({ between: () => { world.packs = [{ id: PACK_ID, version: '0.1.0', source: 'https://elsewhere.example.com/x.crbl' }] } })
    expect(r.out?.stopped?.key).toBe('precheck')
    expect(writes()).toEqual([])
  })

  it('the source list cannot be read: refused before a dialog opens, because "no source" is not known', async () => {
    leader({ copy: { version: MID, source: packReleaseUrl(MID) }, upgrade: 'resets', inputsFailFrom: 1 })
    const r = await upgrade()
    expect(r.prepared.ok).toBe(false)
    if (!r.prepared.ok) expect(r.prepared.why).toMatch(/could not be read/)
    expect(writes()).toEqual([])
  })

  it('the source list cannot be read again at the run: zero writes', async () => {
    leader({ copy: { version: MID, source: packReleaseUrl(MID) }, upgrade: 'resets', inputsFailFrom: 2 })
    const r = await upgrade()
    expect(r.out?.stopped?.key).toBe('precheck')
    expect(writes()).toEqual([])
  })

  it('from 0.1.0, the source list cannot be read back after the upgrade: nothing committed or deployed', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null, inputsFailFrom: 3 })
    const r = await upgrade()
    expect(writeWords()).toEqual(['upgrade'])
    expect(r.out?.stopped?.key).toBe('readback')
    expect(r.out?.stopped?.detail).toContain('Nothing was committed or deployed')
  })

  it('a hybrid group’s own certificate put back to the pack’s shipped one: NO commit and NO deploy', async () => {
    const own = { disabled: false, minVersion: 'TLSv1.2', certPath: '/opt/certs/gno.crt', privKeyPath: '/opt/certs/gno.key' }
    leader({ copy: { version: MID, source: packReleaseUrl(MID) }, http: { ...CONFIGURED, tls: own }, upgrade: 'resetsTls' })
    const r = await upgrade()
    expect(writeWords()).toEqual(['upgrade'])
    expect(r.out?.stopped?.detail).toContain('its TLS certificate')
  })

  it('the copy became current before the upgrade was sent: nothing sent, nothing committed', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null, currentFrom: 3 })
    const r = await upgrade()
    expect(r.out?.stopped?.key).toBe('pack')
    expect(writes()).toEqual([])
  })

  it('the PATCH answered but the version did not move: the held step says nothing was committed, and nothing is', async () => {
    leader({ copy: { version: '0.1.0', source: packReleaseUrl('0.1.0') }, http: null, upgrade: 'unverified' })
    const r = await upgrade()
    expect(writeWords()).toEqual(['upgrade'])
    const held = r.steps?.find((s) => s.key === 'readback' && s.action === 'error')
    expect(held?.detail).toContain('Nothing was committed or deployed')
    expect(held?.detail).toContain('the upgrade could not be checked')
  })

  it('the Raw HTTP source changed after the dialog: zero writes, because the read-back would compare against the wrong "before"', async () => {
    leader({ copy: { version: MID, source: packReleaseUrl(MID) }, upgrade: 'keeps' })
    const r = await upgrade({ between: () => { world.inputs[PACK_HTTP_INPUT_ID] = { ...world.inputs[PACK_HTTP_INPUT_ID], port: 20009 } } })
    expect(r.out?.stopped?.key).toBe('precheck')
    expect(writes()).toEqual([])
  })
})

// What this file could not assert: what a real Leader keeps under the pack's
// `local/` across an in-place upgrade — the fake keeps or resets the source as
// told, and the run's read-back is what decides; that is the proof install's
// question. Nor whether `allowCustomFunctions: false` is accepted on a PATCH
// (a Leader that refuses it fails the step, which is asserted as a failed
// PATCH). Nothing here is a DOM test.
