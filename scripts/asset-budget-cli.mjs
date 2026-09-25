// The command line for the asset-size budget: `npm run assets:budget`.
//
// A separate file so that main() runs unconditionally. scripts/asset-budget.mjs
// is also imported by vite.config.ts and by the tests, so it must not run
// anything on import, and the "am I the entry point?" check it would need
// instead fails open. What the gate checks is described at the top of that file.
import { main } from './asset-budget.mjs'

main()
