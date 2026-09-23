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
import { beforeEach } from 'vitest'

beforeEach(async () => {
  const [{ forgetRunHistory }, { forgetArtifacts }] = await Promise.all([
    import('./cribl/accel/status'),
    import('./cribl/accel/read'),
  ])
  forgetRunHistory()
  forgetArtifacts()
})
