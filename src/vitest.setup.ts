// Module-level caches that must not outlive a test.
//
// The run-history page and the per-run artifact cache are shared across every
// caller on purpose (accel/status.ts, accel/read.ts). In the app a run id names
// one immutable result; in the tests every fixture reuses ids like
// `<entry>.run-1` with different rows, so a cache carried from one test into
// the next would answer with the previous test's data.
//
// Imported DYNAMICALLY, inside the hook: a static import here would load
// read.ts before a test file's `vi.mock` of one of its dependencies was
// registered, and that test would silently run against the real module.
import { afterAll, afterEach, beforeEach, expect } from 'vitest'

// THE HTML "CLICK IN PROGRESS" FLAG, which happy-dom does not implement.
//
// The spec's `click()` returns at once when the same element's `click()` is
// already running (the HTML spec's "click in progress flag"); every browser does
// this. Capra's RadioTile depends on it: the tile's onClick calls its input's
// `click()`, and that click bubbles back up to the tile. In a browser the inner
// `click()` is a no-op. In happy-dom 20.14.5 (`HTMLElement.click` dispatches
// unconditionally) it recursed until the stack ran out, React caught the
// RangeError in its event handler and printed it, and LakeLandingPanel.test.tsx
// passed with a stack overflow on stderr in nine tests. This is the environment
// being made to behave like the browser, not the app being worked around;
// src/harness.test.tsx holds it.
//
// Only where there is a DOM: a file under `@vitest-environment node`
// (devInitScript.test.ts) has no HTMLElement to patch.
if (typeof HTMLElement !== 'undefined') {
  const clicking = new WeakSet<HTMLElement>()
  const click = HTMLElement.prototype.click
  HTMLElement.prototype.click = function (this: HTMLElement) {
    if (clicking.has(this)) return
    clicking.add(this)
    try {
      click.call(this)
    } finally {
      clicking.delete(this)
    }
  }
}

// NO NETWORK. A DOM test's `fetch` is refused unless the test stubbed it.
//
// happy-dom's own `fetch` opens a real socket to its page origin
// (localhost:3000). A test never means to reach it — every test that fetches
// installs a stub — so a call that gets here is a stub missing or already
// taken away, and it used to show up only when a window's teardown aborted the
// socket and printed a `DOMException [AbortError]` beside a green run (a panel's
// cost re-read, three seconds after sampleData.test.tsx had removed its stub).
// Now the call is refused at once and recorded; the test it happened in fails,
// and one that lands between tests fails the next test's setup or the file's
// last hook. One made after that last hook is still refused — no socket, nothing
// on stderr — but there is nothing left for it to fail.
// `vi.stubGlobal('fetch', …)` still wins, and `vi.unstubAllGlobals()` puts this
// back. src/harness.test.tsx holds it.
if (typeof window !== 'undefined') {
  const record: string[] = []
  ;(globalThis as { __unstubbedFetches?: string[] }).__unstubbedFetches = record
  const refuse = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    record.push(url)
    throw new TypeError(`fetch that no test stubbed: ${url}`)
  }
  globalThis.fetch = refuse as typeof fetch
  const check = (when: string) => {
    const seen = record.splice(0)
    expect(seen, `fetch that no test stubbed, ${when}`).toEqual([])
  }
  beforeEach(() => check('after the previous test had finished'))
  afterEach(() => check('in this test'))
  afterAll(async () => {
    // One turn first, so a call the last test queued lands while this listens.
    await new Promise((r) => setTimeout(r, 0))
    check('after the last test in this file')
  })
}

beforeEach(async () => {
  const [
    { forgetRunHistory },
    { forgetArtifacts },
    { forgetLakeFacts },
    { settleDatasetTarget },
    { forgetAccelServing },
  ] = await Promise.all([
    import('./cribl/accel/status'),
    import('./cribl/accel/read'),
    import('./cribl/lakeWindowRead'),
    import('./cribl/datasetTarget'),
    // The saved-search verdicts (accel/serving.ts): AccelPanel publishes the
    // state it read, and a Pause in one test must not send the next test's
    // panels live.
    import('./cribl/accel/serving'),
  ])
  forgetRunHistory()
  forgetArtifacts()
  forgetLakeFacts()
  // WHICH DATASET THE APP READS, settled as an install with no sample dataset —
  // every install before sample data existed, and the one every other test in
  // the suite was written against. Without it every panel would hold its first
  // submit for the dataset verdict, and every fetch stub would have to answer a
  // Lake listing it never heard of. The verdict itself is tested from a reset
  // (`resetDatasetTarget`) in cribl/datasetTarget.test.ts and
  // tabs/sampleData.test.tsx, against the real read path.
  settleDatasetTarget(false)
  forgetAccelServing()
})
