/// <reference types="vite/client" />
// The pack sources' own settings outside an onboarding run — Rotate token, Move
// port, Start and Stop sample data — against a fake Leader stubbed at `fetch`.
//
// What is held still:
//   * each is ONE whole-body PATCH of the source: the live object, minus what
//     the server owns, with only the changed key moved;
//   * the change sent is the change the dialog showed (`approved`): a source
//     that moved after the dialog sends nothing;
//   * Rotate's token is generated inside the run, not the one the dialog's
//     preview used; it is handed to the caller once, only after the PATCH
//     answered `updated`, and is in no step, log entry or error text;
//   * the dialog names the source and says Gigamon AMX must be given the new
//     token, and shows the token only as "a new token (not shown)";
//   * Start sample data is refused until gigamon_ami_sample exists; Stop is
//     not;
//   * a change that landed is committed (the pack's files only) and deployed;
//     one that failed is not;
//   * preparing a dialog sends nothing but GETs.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PACK_HTTP_INPUT_ID, PACK_ID, PACK_SAMPLE_DATASET_ID, PACK_SAMPLE_INPUT_ID, PACK_URL, PACK_VERSION } from '../pack'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SHIPPED = (parse(readFileSync(join(ROOT, 'packs', PACK_ID, 'default', 'inputs.yml'), 'utf8')) as {
  inputs: Record<string, Record<string, unknown>>
}).inputs

const GROUP = 'default'
const HASH = 'dddd000011112222dddd000011112222dddd0000'
const OLD_TOKEN = 'e'.repeat(64)
const P = `/m/${GROUP}/p/${PACK_ID}`
const HTTP_INPUT = `${P}/system/inputs/${PACK_HTTP_INPUT_ID}`
const SAMPLE_INPUT = `${P}/system/inputs/${PACK_SAMPLE_INPUT_ID}`
const DATASETS = '/products/lake/lakes/default/datasets'

/** Each token the generator hands out, in order: the first is the dialog's
 *  preview (thrown away), the second the run's. */
let minted: string[] = []
const mint = () => {
  const t = (minted.length + 1).toString(16).padStart(2, '0').repeat(32)
  minted.push(t)
  return t
}

interface Call { method: string; path: string; body: unknown }
let calls: Call[] = []
let inputs: Record<string, Record<string, unknown>> = {}
let committed: string[][] = []

function reply(status: number, value?: unknown) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown } as unknown as Response
}

const CONFIGURED = {
  disabled: false, port: 20007, authTokensExt: [{ token: OLD_TOKEN, authType: 'manual' }], criblSourceProvenance: { by: 'server' },
}

function leader(o: { sampleDataset?: boolean; sampleOn?: boolean; failPatch?: boolean; takenPort?: number } = {}): void {
  calls = []
  committed = []
  minted = []
  const pending: string[] = []
  inputs = {
    [PACK_HTTP_INPUT_ID]: { id: PACK_HTTP_INPUT_ID, ...structuredClone(SHIPPED[PACK_HTTP_INPUT_ID]), ...CONFIGURED },
    [PACK_SAMPLE_INPUT_ID]: { id: PACK_SAMPLE_INPUT_ID, ...structuredClone(SHIPPED[PACK_SAMPLE_INPUT_ID]), disabled: !o.sampleOn },
  }
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
    if (at('GET', DATASETS)) return reply(200, { items: o.sampleDataset ? [{ id: PACK_SAMPLE_DATASET_ID, format: 'json' }] : [] })
    if (at('GET', `/m/${GROUP}/system/inputs`)) return reply(200, { items: o.takenPort ? [{ id: 'in_other', type: 'http', port: o.takenPort }] : [] })
    if (at('GET', `/m/${GROUP}/packs`)) return reply(200, { items: [{ id: PACK_ID, version: PACK_VERSION, source: PACK_URL }] })
    if (at('GET', `${P}/system/inputs`)) return reply(200, { items: Object.values(inputs) })
    for (const [id, item] of [[PACK_HTTP_INPUT_ID, HTTP_INPUT], [PACK_SAMPLE_INPUT_ID, SAMPLE_INPUT]] as const) {
      if (at('GET', item)) return reply(200, { items: [inputs[id]] })
      if (at('PATCH', item)) {
        if (o.failPatch) return reply(500, { message: 'the Leader refused the source' })
        inputs[id] = body as Record<string, unknown>
        pending.push(`groups/${GROUP}/local/${PACK_ID}/inputs.yml`)
        return reply(200, { items: [body] })
      }
    }
    if (method === 'GET' && path.startsWith(`${P}/`)) return reply(200, { items: [] })
    if (at('GET', '/version/status')) return reply(200, { items: [{ files: pending.map((f) => ({ path: f })) }] })
    if (at('POST', '/version/commit')) {
      const files = (body as { files: string[] }).files
      committed.push(files)
      pending.splice(0, pending.length, ...pending.filter((f) => !files.includes(f)))
      return reply(200, { items: [{ commit: HASH }] })
    }
    if (at('PATCH', `/products/stream/groups/${GROUP}/deploy`)) return reply(200, { items: [] })
    return reply(599, { message: `no route for ${method} ${path}` })
  })
}

const writes = () => calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/kvstore'))
const kvPuts = () => calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/kvstore'))

type Run = typeof import('./run')
type Plan = typeof import('./plan')
type Change = import('./plan').SourceChange

async function load(): Promise<{ run: Run; plan: Plan }> {
  vi.resetModules()
  vi.doMock('../provision', async (orig) => ({ ...(await orig<typeof import('../provision')>()), generateToken: mint }))
  vi.doMock('../pack', async (orig) => ({
    ...(await orig<typeof import('../pack')>()),
    PACK_PUBLISHED: true, PACK_SHA256: 'ab'.repeat(32), PACK_PUBLISHED_VERSIONS: Object.freeze(['0.1.0', PACK_VERSION]),
  }))
  const [run, plan] = await Promise.all([import('./run'), import('./plan')])
  return { run, plan }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../pack')
  vi.doUnmock('../provision')
  vi.resetModules()
  delete window.__CRIBL_SEARCH_ORIGIN
})

async function change(c: Change, between?: () => void) {
  const { run, plan } = await load()
  const prepared = await run.prepareSourceChange(GROUP, c, { undeployed: null, undeployedChecking: false })
  if (!prepared.ok) return { prepared, dialog: null, out: null, tokens: [] as string[], steps: [] as string[] }
  const dialog = plan.sourceChangeDialog(prepared.ctx)
  const afterPrepare = writes().length
  between?.()
  const tokens: string[] = []
  const steps: string[] = []
  const out = await run.runSourceChange(prepared.ctx, dialog, {
    onStep: (s) => steps.push(JSON.stringify(s)),
    onToken: (t) => tokens.push(t),
    record: async () => {},
  })
  return { prepared, dialog, out, tokens, steps, afterPrepare }
}

describe('Rotate token', () => {
  it('the dialog names the source, says the exporter must be given the new token, and shows no token value', async () => {
    leader()
    const r = await change({ kind: 'token' })
    expect(r.afterPrepare).toBe(0)
    const d = r.dialog!
    expect(d.title).toBe(`Rotate the auth token of ${PACK_HTTP_INPUT_ID} in ${GROUP}`)
    expect(d.resources.find((x) => x.id === PACK_HTTP_INPUT_ID)).toMatchObject({ action: 'replace', group: GROUP })
    expect(d.resources.some((x) => x.action === 'deploy' && x.id === GROUP)).toBe(true)
    expect(d.consequences.join(' ')).toMatch(/Gigamon AMX has to be given the new token/)
    expect(d.diff).toEqual([{ resourceId: PACK_HTTP_INPUT_ID, key: 'authTokensExt', before: 'a token is set (not shown)', after: 'a new token (not shown)' }])
    expect(JSON.stringify(d)).not.toMatch(/[0-9a-f]{64}/)
  })

  it('one whole-body PATCH with the run’s own new token, handed over once, then commit and deploy', async () => {
    leader()
    const r = await change({ kind: 'token' })
    expect(r.out?.stopped).toBeNull()
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${HTTP_INPUT}`, 'POST /version/commit', `PATCH /products/stream/groups/${GROUP}/deploy`,
    ])
    // The run's token, not the preview's.
    expect(minted).toHaveLength(2)
    const sent = writes()[0].body as Record<string, unknown>
    expect(sent.authTokensExt).toEqual([{ token: minted[1], authType: 'manual' }])
    // Whole body: every live key but the server-owned one, the rest unchanged.
    const { criblSourceProvenance: _owned, ...rest } = { id: PACK_HTTP_INPUT_ID, ...structuredClone(SHIPPED[PACK_HTTP_INPUT_ID]), ...CONFIGURED }
    expect(sent).toEqual({ ...rest, authTokensExt: [{ token: minted[1], authType: 'manual' }] })
    expect(r.tokens).toEqual([minted[1]])
    for (const t of minted) {
      expect(r.steps.join(' ')).not.toContain(t)
      for (const p of kvPuts()) expect(String(p.body)).not.toContain(t)
    }
    for (const f of committed[0]) expect(f).toContain(`/${PACK_ID}/`)
  })

  it('a failed PATCH: no token shown, nothing committed or deployed, and the step says to rotate again', async () => {
    leader({ failPatch: true })
    const r = await change({ kind: 'token' })
    expect(r.tokens).toEqual([])
    expect(writes().map((c) => c.path)).toEqual([HTTP_INPUT])
    expect(r.out?.stopped?.detail).toMatch(/Rotate again/)
    for (const t of minted) expect(r.steps.join(' ')).not.toContain(t)
  })
})

describe('Move port', () => {
  it('sends exactly the live source with the new port, and says the exporter must follow', async () => {
    leader()
    const r = await change({ kind: 'port', port: 20008 })
    expect(r.dialog?.diff).toEqual([{ resourceId: PACK_HTTP_INPUT_ID, key: 'port', before: '20007', after: '20008' }])
    expect(r.dialog?.consequences.join(' ')).toMatch(/listens on 20008 and no longer on 20007/)
    expect(r.out?.stopped).toBeNull()
    const sent = writes()[0].body as Record<string, unknown>
    const { criblSourceProvenance: _owned, ...rest } = { id: PACK_HTTP_INPUT_ID, ...structuredClone(SHIPPED[PACK_HTTP_INPUT_ID]), ...CONFIGURED }
    expect(sent).toEqual({ ...rest, port: 20008 })
    expect(r.tokens).toEqual([])
  })

  it('a port another source holds is refused before a dialog opens', async () => {
    leader({ takenPort: 20008 })
    const r = await change({ kind: 'port', port: 20008 })
    expect(r.prepared.ok).toBe(false)
    expect(writes()).toEqual([])
  })

  it('a source that moved after the dialog sends nothing: the confirmed change is not what would be sent', async () => {
    leader()
    const r = await change({ kind: 'port', port: 20008 }, () => { inputs[PACK_HTTP_INPUT_ID] = { ...inputs[PACK_HTTP_INPUT_ID], port: 20009 } })
    expect(writes()).toEqual([])
    expect(r.out?.stopped?.detail).toMatch(/changed after this change was shown/)
  })
})

describe('Start and Stop sample data', () => {
  it('Start is refused until gigamon_ami_sample exists', async () => {
    leader({ sampleDataset: false })
    const r = await change({ kind: 'sample', enabled: true })
    expect(r.prepared.ok).toBe(false)
    if (!r.prepared.ok) expect(r.prepared.why).toContain(PACK_SAMPLE_DATASET_ID)
    expect(writes()).toEqual([])
  })

  it('Start, with the dataset there: disabled true → false, the volume stated, committed and deployed', async () => {
    leader({ sampleDataset: true })
    const r = await change({ kind: 'sample', enabled: true })
    expect(r.dialog?.diff).toEqual([{ resourceId: PACK_SAMPLE_INPUT_ID, key: 'disabled', before: 'true', after: 'false' }])
    expect(r.dialog?.costLine).toMatch(/Sample data: about 432,000 events a day/)
    expect(r.out?.stopped).toBeNull()
    expect(writes().map((c) => c.path)).toEqual([SAMPLE_INPUT, '/version/commit', `/products/stream/groups/${GROUP}/deploy`])
    expect((writes()[0].body as { disabled: boolean }).disabled).toBe(false)
  })

  it('Stop is allowed whether or not the dataset exists, and keeps what was written', async () => {
    leader({ sampleDataset: false, sampleOn: true })
    const r = await change({ kind: 'sample', enabled: false })
    expect(r.prepared.ok).toBe(true)
    expect(r.dialog?.consequences.join(' ')).toContain(`stay in ${PACK_SAMPLE_DATASET_ID}`)
    expect(r.out?.stopped).toBeNull()
    expect((writes()[0].body as { disabled: boolean }).disabled).toBe(true)
  })

  it('nothing to change (already started) opens no dialog', async () => {
    leader({ sampleDataset: true, sampleOn: true })
    const r = await change({ kind: 'sample', enabled: true })
    expect(r.prepared.ok).toBe(false)
    expect(writes()).toEqual([])
  })

  it('started by somebody else after the dialog: nothing sent, nothing committed', async () => {
    leader({ sampleDataset: true })
    const r = await change({ kind: 'sample', enabled: true }, () => { inputs[PACK_SAMPLE_INPUT_ID] = { ...inputs[PACK_SAMPLE_INPUT_ID], disabled: false } })
    expect(writes()).toEqual([])
    expect(r.out?.stopped).toBeNull()
  })
})

// What this file could not assert: where a real Leader records a PATCH of a
// pack source in Git (the fake names a `/cc-network-gigamon-ami/` path; the
// commit reports an error when nothing of the pack's is pending after a write),
// and whether Gigamon AMX picks up a rotated token or a moved port — that is the
// exporter's side. Nothing here is a DOM test.
