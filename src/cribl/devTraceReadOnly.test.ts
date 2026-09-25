// A host that makes `fetch` read-only (Cribl's Live Preview frame) must not stop
// the page from rendering: installing the trace threw there, before React
// mounted, and the frame stayed white. Its own file: the trace is module state.
import { describe, expect, it } from 'vitest'
import { installTrace, markData, markStart, summary, tracing } from './devTrace'

describe('installTrace on a read-only fetch', () => {
  it('does not throw, records panel marks, and says requests were not traced', () => {
    const native = async () => new Response('{}')
    const win = { location: { pathname: '/flow-map' } } as unknown as Window & { __gnoTrace?: unknown }
    Object.defineProperty(win, 'fetch', { value: native, writable: false, configurable: false })
    expect(() => installTrace(win)).not.toThrow()
    expect(tracing()).toBe(true)
    expect(win.fetch).toBe(native)
    markStart('flow-nodes')
    markData('flow-nodes', 'schedule')
    expect(summary()).toMatchObject({ requestsTraced: false, requests: {}, panels: [{ panel: 'flow-nodes', source: 'schedule' }] })
  })
})
