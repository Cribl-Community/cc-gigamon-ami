// Every Cribl Search query the Field explorer tab runs.
//
// These strings are customer-visible: the ⓘ popover on each panel shows the exact
// query behind the numbers, and "open in Cribl Search" runs this text unchanged.
// A committed snapshot is regenerated from this directory and compared by a test,
// so any edit here is a change to what we tell customers a number came from.
//
// Nothing under src/queries may import a .tsx, directly or transitively — the
// snapshot extractor runs under plain Node, which cannot load one. ../cribl/search
// and src/data/* are the building blocks; components and hooks are not.

import { q } from '../cribl/search'
import { AMI_CATALOG } from '../data/amiFields'

// Presence is checked with count(field) over the WHOLE window (accurate for
// rare fields like ssl_issuer that a sampled field-summaries would miss).
export const CHECK_FIELDS = Array.from(
  new Set([...AMI_CATALOG.map((f) => f.name), ...AMI_CATALOG.map((f) => f.derivedField).filter((x): x is string => !!x)]),
)
export const PRESENCE_QUERY = q('| summarize ' + CHECK_FIELDS.map((n, i) => `c${i}=count(${n})`).join(', '))

// The readable presence query behind a section (family / use case) — one
// count(field) per field. Powers the ⓘ "open in Cribl Search" for the section.
export const sectionQuery = (fields: string[]) => q('| summarize ' + fields.map((n) => `${n}=count(${n})`).join(', '))

// The sample the "In feed" browser reads: field-summaries runs it, and the
// panel's ⓘ shows it, so both must be the same string.
export const FEED_SAMPLE_QUERY = q('| limit 5000')

// Which family a field belongs to. It groups the live field-summaries results
// into the family chips rather than assembling a query itself, but it lives here
// so the snapshot freezes the grouping next to the queries it sits beside.
export function familyOf(name: string): string {
  if (name.startsWith('src_aws') || name.startsWith('dst_aws') || name.endsWith('workload_platform')) return 'AWS enrichment'
  if (name.startsWith('dns_')) return 'DNS'
  if (name.startsWith('snmp_')) return 'SNMP'
  if (name.startsWith('ssl_')) return 'SSL / TLS'
  if (name.startsWith('http_') || name.startsWith('http2_')) return 'HTTP'
  if (name.startsWith('tcp_') || name.startsWith('udp_')) return 'TCP / UDP'
  if (/^(ssh|rtp|rtcp|dhcp|icmp|ntp|krb5|dcerpc|ftp|sip|gtp|whatsapp|upnp)_/.test(name)) return 'Other protocols'
  return 'Core / 5-tuple'
}
