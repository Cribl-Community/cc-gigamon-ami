// The three things a caller of `capi` is trusting.
//
// Provisioning reads `status` as data — a 404 GET means "create it" — so the
// status and the body have to survive unchanged whatever came back on the
// wire. The KV store then adds two requirements that look like details and are
// not: a `text/plain` content type, without which the store persists the
// literal `[object Object]` while answering 200, and an unparsed body, without
// which that corruption is indistinguishable from a stored document. Both are
// measured facts about this platform, not preferences, so they are pinned here
// rather than left to a comment.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { capi, errText, groupPath } from './capi'

interface Sent { url: string; init: RequestInit }

/** Stub `fetch` with one canned response; returns the requests it received. */
function stub(status: number, body: string): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init })
    return { status, text: async () => body }
  })
  return sent
}

const ctype = (s: Sent) => (s.init.headers as Record<string, string>)['Content-Type']

afterEach(() => vi.unstubAllGlobals())

describe('capi', () => {
  it('reports the status and the parsed body, and does not throw on an error status', async () => {
    // A provisioning step asks "is it there?" with a GET and branches on 404.
    const sent = stub(404, '{"message":"not found"}')
    const r = await capi('GET', '/m/default/pipelines/gigamon_syslog')
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ message: 'not found' })
    expect(sent[0].url).toBe('/capi/m/default/pipelines/gigamon_syslog')
    expect(sent[0].init.method).toBe('GET')
    expect(sent[0].init.body, 'a GET must not carry a body').toBeUndefined()
  })

  it('keeps a body it cannot parse rather than dropping it', async () => {
    // Gateways and proxies answer with HTML; errText shows whatever this keeps.
    stub(502, '<html>Bad Gateway</html>')
    expect((await capi('GET', '/master/groups')).body).toBe('<html>Bad Gateway</html>')
  })

  it('answers an empty body with null', async () => {
    stub(204, '')
    expect((await capi('DELETE', '/m/default/pipelines/gigamon_syslog')).body).toBeNull()
  })

  it('sends config writes as JSON, which is what every config endpoint wants', async () => {
    const sent = stub(200, '{}')
    await capi('POST', '/m/default/pipelines', { id: 'gigamon_syslog' })
    expect(ctype(sent[0])).toBe('application/json')
    expect(sent[0].init.body).toBe('{"id":"gigamon_syslog"}')
  })

  it('sends a KV write as text/plain, still serialized as JSON', async () => {
    // The measured failure: with application/json the store persists
    // String(obj) — "[object Object]" — and answers 200, so the write looks
    // fine and the document is gone. Only the content type changes here; the
    // payload is the same JSON document either way.
    const sent = stub(200, '')
    await capi('PUT', '/kvstore/app/settings/search_caps', { capSeconds: 120 }, { contentType: 'text/plain' })
    expect(ctype(sent[0])).toBe('text/plain')
    expect(sent[0].init.body).toBe('{"capSeconds":120}')
  })

  it('hands back the exact bytes when asked, so corruption stays recognisable', async () => {
    stub(200, '[object Object]')
    const r = await capi('GET', '/kvstore/app/settings/search_caps', undefined, { text: true })
    expect(r.body, 'parsed, this is just a string among strings').toBe('[object Object]')
  })

  it('passes an abort signal through to fetch', async () => {
    const sent = stub(200, '{}')
    const ac = new AbortController()
    await capi('GET', '/ai/settings/features', undefined, { signal: ac.signal })
    expect(sent[0].init.signal).toBe(ac.signal)
  })
})

describe('errText', () => {
  it('prefers the sentence Cribl wrote', () => {
    expect(errText({ status: 400, body: { message: 'port 5514 already in use' } })).toBe('port 5514 already in use')
    expect(errText({ status: 403, body: { error: 'forbidden' } })).toBe('forbidden')
  })

  it('falls back to something a user can act on, never a bare status when there is more', () => {
    expect(errText({ status: 500, body: { detail: 'x' } })).toBe('{"detail":"x"}')
    expect(errText({ status: 502, body: 'Bad Gateway' })).toBe('Bad Gateway')
    expect(errText({ status: 500, body: null })).toBe('HTTP 500')
  })
})

describe('groupPath', () => {
  it('puts the group in the path, because that is what decides where a write lands', () => {
    expect(groupPath('default', '/system/inputs')).toBe('/m/default/system/inputs')
  })
})
