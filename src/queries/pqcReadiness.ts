// Every Cribl Search query the PQC readiness tab runs.
//
// These strings are customer-visible: the ⓘ popover on each tile and panel shows
// the exact query behind the number, and the worklist links open it in Cribl
// Search. A committed snapshot is regenerated from this directory and compared by
// a test, so any edit here is a change to what we tell customers a number came from.
//
// Nothing under src/queries may import a .tsx, directly or transitively — the
// snapshot extractor runs under plain Node, which cannot load one. ../cribl/search
// and src/data/* are the building blocks; components and hooks are not.

import { q } from '../cribl/search'
import { PQC_GROUP_CODES } from '../data/pqc'

const PQC_IN = `(${PQC_GROUP_CODES.map((c) => `"${c}"`).join(', ')})`

// Per-server capability: sessions, how many were TLS 1.3, how many OFFERED a
// hybrid ML-KEM group. Grouped with issuer (near-1:1 with SNI; merged in JS).
export const SERVERS_Q = q(
  'ssl_server_name=* | summarize sessions=count(), ' +
  'tls13=sum(iif(ssl_server_supported_version=="772",1,0)), ' +
  `pqc=sum(iif(ssl_ext_ec_supported_groups_type in ${PQC_IN},1,0)) ` +
  'by ssl_server_name, ssl_issuer | sort by sessions desc | limit 300',
)

// Which named key-exchange groups appear, and on how many servers.
export const GROUPS_Q = q(
  'ssl_ext_ec_supported_groups_type=* | summarize sessions=count(), servers=dcount(ssl_server_name) ' +
  'by ssl_ext_ec_supported_groups_type | sort by sessions desc | limit 40',
)

// The row drill-down: whatever filter the row carries, capped for a readable
// Search UI landing. Opened in Cribl Search, not run by the app.
export const drillQuery = (filter: string) => q(`${filter} | limit 200`)

// The filter one worklist row drills into — that server's sessions.
export const serverFilter = (sni: string) => `ssl_server_name="${sni}"`
