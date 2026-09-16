// Cribl Search (KQL) queries behind the TLS posture tab.
//
// The strings here are customer-visible — every tile and panel shows its query
// verbatim in the ⓘ popover, as the provenance of the number on screen, and a
// snapshot test fails when one drifts. Edit the text only when the number it
// produces is meant to change.
//
// Nothing in this directory may import from a .tsx: the snapshot is regenerated
// by plain Node, which cannot load JSX.

import { q } from '../cribl/search'
import { PQC_GROUP_CODES } from '../data/pqc'

const PQC_IN = `(${PQC_GROUP_CODES.map((c) => `"${c}"`).join(', ')})`

export const SERVERS = q(
  'ssl_server_name=* | summarize flows=count(), ver=max(ssl_protocol_version), ' +
    'issuer=max(ssl_issuer), notafter=max(ssl_validity_not_after), cn=max(ssl_common_name) ' +
    'by ssl_server_name | sort by flows desc | limit 60',
)

// PQC capability is a separate, cheap query — it only touches the sparse set of
// records that offered a hybrid ML-KEM group, so it stays fast. Folding it into
// the SERVERS query (5 max() aggregations) timed the search out.
export const PQC_BY_SERVER = q(`ssl_ext_ec_supported_groups_type in ${PQC_IN} | summarize pqc=count() by ssl_server_name | limit 200`)

/** The row drill-down: one server's TLS / cert records, opened in Cribl Search. */
export function serverDrill(server: string): string {
  return q(`ssl_server_name="${server}" | summarize flows=count(), ver=max(ssl_protocol_version), issuer=max(ssl_issuer), notafter=max(ssl_validity_not_after), notbefore=max(ssl_validity_not_before), subject=max(ssl_common_name), cipher=max(ssl_cipher_suite_id) by ssl_server_name`)
}
