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
