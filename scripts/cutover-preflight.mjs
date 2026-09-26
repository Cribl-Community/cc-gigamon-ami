// Runbook 4c: is a worker group ready for Gigamon AMX to be re-pointed from the
// old global Raw HTTP source to the onboarding pack's — READ-ONLY.
//
//   npm run cutover:preflight                      the `default` group
//   npm run cutover:preflight -- --group <id>      another worker group
//
// Options:
//   --group <id>     the worker group (default: default)
//   --base <url>     API base (default http://localhost:5173/capi, the `npm run dev` proxy)
//   --leader <url>   the Cribl Leader's origin, e.g. https://main-<org>.cribl.cloud. Decides
//                    "Cribl-managed" and the `default` group's ingress host. Default: read from
//                    the dev page (vite.config.ts injects it as window.__CRIBL_SEARCH_ORIGIN).
//   --json           print the facts and the verdict as JSON instead of the report
//
// Exit status: 0 ready, 1 not ready, 2 the preflight itself failed.
//
// WHAT IT NEEDS. `npm run dev` running, with `.dev/cribl.json` in place: the Vite
// proxy at /capi injects the OAuth token. This script never reads that file and
// never handles a credential.
//
// WHAT IT DOES NOT DO. It writes nothing and submits no Search job. Every read
// is one Guided Setup already makes — the functions in src/cribl/cutoverPreflight.ts
// `LIVE_READERS` — and it installs, as the global fetch those modules use, a
// transport that refuses anything but a GET, any `/search/` path and anything
// outside /capi (scripts/cutover-preflight-fetch.mjs). No token is printed:
// the pack source's state carries only whether one is set.
//
// THE PATHS IT READS, every one a GET that config/policies.yml already grants
// (src/cribl/cutoverPreflight.test.ts runs the real readers over a fake
// transport and holds each request to a GET entry of src/cribl/paths.ts):
//   /m/:gid/packs
//   /m/:gid/p/cc-network-gigamon-ami/system/inputs
//   /m/:gid/p/cc-network-gigamon-ami/system/outputs
//   /m/:gid/p/cc-network-gigamon-ami/pipelines
//   /m/:gid/p/cc-network-gigamon-ami/routes    (also: which pipeline each route into gigamon_ami_pq runs)
//   /m/:gid/p/cc-network-gigamon-ami/lib/breakers/gigamon_ami_http_json_array
//   /m/:gid/p/:pack/system/inputs              (every installed pack's sources, for ports)
//   /m/:gid/system/inputs                      (the group's own sources, for ports)
//   /m/:gid/system/inputs/in_gigamon_http, /m/:gid/system/inputs/in_gigamon_syslog
//   /m/:gid/pipelines/gigamon_http_normalize, /m/:gid/pipelines/gigamon_syslog
//   /m/:gid/lib/breakers/gigamon_ami_json_array
//   /m/:gid/routes
//   /products/lake/lakes/default/datasets
//   /products/stream/groups, /products/stream/groups/:gid (/master/groups/:gid on an old Leader)
//   /version/status, /version, /version/files
//
// NOT MEASURED. Built 2026-09-25 and tested only against fakes; it has not been
// run against a Leader.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import nodeModule from 'node:module'

// src/ imports are extensionless; Node strips the types but wants the file's
// real name. Same hook as extract-queries.mjs and parquet-audit.mjs.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context)
      throw err
    }
  },
})

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const G = await import(pathToFileURL(join(ROOT, 'scripts/cutover-preflight-fetch.mjs')).href)

function parseArgs(argv) {
  const out = { group: 'default', base: 'http://localhost:5173/capi', leader: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--group') out.group = next()
    else if (a === '--base') out.base = next().replace(/\/$/, '')
    else if (a === '--leader') out.leader = next().replace(/\/$/, '')
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
      console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).join('\n'))
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(out.group)) throw new Error('--group must be a worker group id')
  if (out.leader && !/^https?:\/\//.test(out.leader)) throw new Error('--leader must be an http(s) origin')
  return out
}

try {
  const args = parseArgs(process.argv.slice(2))
  const realFetch = globalThis.fetch

  // The Leader's origin: given, or read off the dev page (a GET of localhost,
  // not of Cribl). Without it, "Cribl-managed" and the ingress host stay unknown.
  let leader = args.leader
  if (!leader) {
    try {
      const page = await realFetch(`${new URL(args.base).origin}/`, { method: 'GET' })
      leader = G.searchOriginFromDevPage(await page.text())
    } catch {
      leader = null
    }
  }
  // provision.ts reads the Leader's host off `window` (leaderHostname,
  // suggestedIngressHost). A two-field stand-in, set only when it is known;
  // config.ts reads neither field, so API_BASE stays `/capi`.
  if (leader) globalThis.window = { __CRIBL_SEARCH_ORIGIN: leader, location: { origin: leader } }

  const sent = []
  globalThis.fetch = G.readOnlyFetch({ base: args.base, fetch: realFetch, record: (r) => sent.push(r) })

  const P = await import(pathToFileURL(join(ROOT, 'src/cribl/cutoverPreflight.ts')).href)
  const facts = await P.gatherPreflight(args.group)
  const verdict = P.preflightVerdict(facts)
  if (args.json) console.log(JSON.stringify({ facts, verdict, requests: sent.length }, null, 2))
  else {
    for (const line of P.preflightReport(facts, verdict)) console.log(line)
    console.log('')
    console.log(`${sent.length} GET requests through ${args.base}; nothing written, no Search job submitted.`)
    if (!leader) console.log('The Leader origin was not known (no --leader, and the dev page did not name one).')
  }
  // exitCode, not exit(): exiting with fetch's keep-alive sockets still open
  // aborts Node on Windows (a libuv assertion), observed on this runner.
  process.exitCode = verdict.ready ? 0 : 1
} catch (err) {
  const why = err instanceof Error ? err.message : String(err)
  console.error(`cutover preflight failed: ${why}`)
  if (/fetch failed|ECONNREFUSED/i.test(why)) console.error('Is `npm run dev` running, with .dev/cribl.json in place? (see --base)')
  process.exitCode = 2
}
