// The command line for the pinned pack release check: `npm run pack:release-check`.
//
// A separate file so that main() runs unconditionally, as asset-budget-cli.mjs
// does: scripts/check-pack-release.mjs is also imported by its tests, so it must
// not run anything on import. What the check does is at the top of that file.
// It downloads from GitHub, so it needs the network.
import { main } from './check-pack-release.mjs'

await main()
