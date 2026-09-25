// The relay that lets Live Preview's frame report its trace (devTrace.ts
// `startRelay`). Its own file: installing the trace is module state, and
// devTrace.test.ts pins the uninstalled state.
//   * a post goes through the page's own fetch, from before the trace wrapped
//     it, so the relay never counts itself as a request;
//   * it posts only when the trace changed, and the post is the whole trace.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTrace, markData, markStart, startRelay } from './devTrace'

afterEach(() => { vi.useRealTimers() })

describe('startRelay', () => {
  it('posts the trace to the dev server through the untraced fetch, and only when it changed', async () => {
    // Only the relay's interval is faked: the traced request's body is read on a real task.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const posts: Array<{ url: string; body: string }> = []
    const inner = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/__trace') posts.push({ url, body: String(init.body) })
      return new Response('{}', { status: 200 })
    })
    const win = { fetch: inner, location: { pathname: '/flow-map' }, setInterval, clearInterval } as unknown as Window
    installTrace(win as Window & { __gnoTrace?: unknown })
    const stop = startRelay(win, '/__trace', 1000)

    await win.fetch('/capi/m/default_search/search/jobs?limit=48')
    markStart('flow-nodes')
    markData('flow-nodes', 'schedule')
    await new Promise((r) => setTimeout(r, 20)) // the request's end and the panel's paint land
    await vi.advanceTimersByTimeAsync(1000)
    expect(posts).toHaveLength(1)
    const sent = JSON.parse(posts[0].body) as { page: string; summary: { requests: Record<string, { n: number }> }; panels: Array<{ panel: string; source: string }> }
    expect(sent.page).toBe('/flow-map')
    expect(sent.panels.map((p) => [p.panel, p.source])).toEqual([['flow-nodes', 'schedule']])
    // The one traced request is the app's; the relay's own POST is not in it.
    expect(sent.summary.requests).toEqual({ history: expect.objectContaining({ n: 1 }) })

    // Nothing changed: nothing is sent.
    await vi.advanceTimersByTimeAsync(3000)
    expect(posts).toHaveLength(1)

    stop()
    await win.fetch('/capi/m/default_search/search/jobs?limit=48')
    await vi.advanceTimersByTimeAsync(3000)
    expect(posts).toHaveLength(1)
  })
})
