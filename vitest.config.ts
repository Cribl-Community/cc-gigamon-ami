import { defineConfig } from 'vitest/config'

// Standalone on purpose: vite.config.ts reads .dev/cribl.json and fires a real
// OAuth request from its configureServer hook, and pins strictPort 5173 (the dev
// server). Tests must not touch either, so they get their own config.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
