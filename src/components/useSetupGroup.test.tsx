// One worker group per Guided Setup page, shared by every panel that reads it.
//
// What this holds still: two panels mounted together read the remembered group
// ONCE and show the same one; a pick in one moves the other; mounting writes
// nothing; the pick writes exactly one KV document; and the store forgets the
// visit when the last panel unmounts, so coming back reads the remembered group
// again, as a remount of the old ProvisionPanel did.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSetupGroup } from './useSetupGroup'

interface Call { method: string; url: string; body: string | null }
let calls: Call[] = []
let remembered: string | null = 'g2'

const envelope = (doc: unknown) => JSON.stringify({ version: 1, updatedAt: 0, doc })

function stub(): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, url: u, body: init.body == null ? null : String(init.body) })
    const reply = (status: number, text: string) => ({
      ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => text, json: async () => JSON.parse(text) as unknown,
    })
    if (u.includes('/kvstore/')) {
      if (method === 'PUT') return reply(200, '')
      return remembered ? reply(200, envelope({ setupGroup: remembered })) : reply(404, '')
    }
    if (u.endsWith('/master/groups')) {
      return reply(200, JSON.stringify({ items: ['default', 'g2', 'g3'].map((id) => ({ id, name: id, isFleet: false, isSearch: false, type: 'stream' })) }))
    }
    return reply(404, '{}')
  })
}

const seen: Record<string, ReturnType<typeof useSetupGroup>> = {}
function Probe({ name }: { name: string }) {
  seen[name] = useSetupGroup()
  return <span>{seen[name].group}</span>
}

let container: HTMLDivElement
let root: Root
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() }) }
const kvReads = () => calls.filter((c) => c.method === 'GET' && c.url.includes('/kvstore/'))
const nonGets = () => calls.filter((c) => c.method !== 'GET')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('getCriblUser', async () => ({ id: 'auth0|me', username: 'me' }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  calls = []
  remembered = 'g2'
  stub()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useSetupGroup — one group per page', () => {
  it('two panels read the remembered group once, show the same one, and write nothing', async () => {
    act(() => root.render(<><Probe name="a" /><Probe name="b" /></>))
    expect(seen.a.groupReady).toBe(false)
    await settle()
    expect(seen.a).toMatchObject({ group: 'g2', groupReady: true })
    expect(seen.b.group).toBe('g2')
    expect(seen.a.groups.map((g) => g.id)).toContain('g3')
    expect(kvReads()).toHaveLength(1)
    expect(nonGets(), 'nothing writes on mount').toEqual([])
  })

  it('a pick in one panel moves the other, and writes one preference document', async () => {
    act(() => root.render(<><Probe name="a" /><Probe name="b" /></>))
    await settle()
    await act(async () => { await seen.a.pickGroup('g3') })
    expect(seen.b.group).toBe('g3')
    const puts = nonGets()
    expect(puts).toHaveLength(1)
    expect(puts[0].method).toBe('PUT')
    expect(puts[0].body).toContain('g3')
  })

  it('is ready on the default group when nothing is remembered', async () => {
    remembered = null
    act(() => root.render(<Probe name="a" />))
    await settle()
    expect(seen.a).toMatchObject({ group: 'default', groupReady: true })
  })

  it('forgets the visit when the last panel unmounts, and reads again on the next one', async () => {
    act(() => root.render(<Probe name="a" />))
    await settle()
    await act(async () => { await seen.a.pickGroup('g3') })
    act(() => root.render(<></>))
    remembered = 'g2'
    act(() => root.render(<Probe name="a" />))
    expect(seen.a).toMatchObject({ group: 'default', groupReady: false })
    await settle()
    expect(seen.a.group).toBe('g2')
    expect(kvReads().length).toBeGreaterThanOrEqual(2)
  })
})

// What this file could not assert: that the two panels render the picker in
// the same place a person expects — layout is not something happy-dom has.
