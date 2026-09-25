import { defineConfig } from 'vitest/config'

// Standalone on purpose: vite.config.ts reads .dev/cribl.json and fires a real
// OAuth request from its configureServer hook, and pins strictPort 5173 (the dev
// server). Tests must not touch either, so they get their own config.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/vitest.setup.ts'],
    // TIMEOUTS SIZED FOR THE FULL SUITE, NOT FOR ONE FILE. Measured 2026-09-24
    // on a 22-core machine: a full run failed 8 of 2442 on the 5 s test timeout
    // (tabJobBudget, sampleData, ProvisionPanel) and, on another run, 1 on the
    // 10 s hook timeout in vitest.setup.ts; the same three files passed 62/62
    // run on their own. Nothing hung — whole-tab renders that settle their
    // reads take seconds each once every worker is rendering one. The setup's
    // imports stay dynamic: made static they load read.ts before a test's
    // `vi.mock('../inflight')` registers, and read.test.ts fails 2 (probed the
    // same day). A test that genuinely hangs still fails, at these bounds.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
