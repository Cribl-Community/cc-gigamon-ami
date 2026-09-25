// The command line for fetching a released app bundle: `npm run release:fetch`.
//
// A separate file so that main() runs unconditionally, as
// check-pack-release-cli.mjs does: scripts/fetch-release.mjs is also imported by
// its tests, so it must not run anything on import. What the fetch does is at
// the top of that file. It downloads from GitHub through the gh CLI.
import { main } from './fetch-release.mjs'

await main()
