// The sanctioned/common SaaS `app_name` values the Shadow AI tab pivots on.
//
// It lives here for the reason `aiApps.ts` next door does, but not quite the
// same one. AI_APPS *generates* a query (`app_name in (…)`); this list never
// appears in any query text at all — `appsQuery` returns the same 90 rows
// whatever is in here. It is applied client-side, in the tab, to split those
// rows into "shadow" and "known".
//
// That is exactly why it belongs here: `scripts/extract-queries.mjs` freezes
// every export of `src/data/*.ts` as a `catalogs` digest, described in its own
// header as "data that moves a number without ever appearing in a query
// string". While this list sat in `ShadowAi.tsx` it moved the "SaaS
// applications" panel's contents with no diff in any gate.
//
// EXPORTED AS AN ARRAY, AND THAT IS LOAD-BEARING. The digest is
// `JSON.stringify(value)`, and `JSON.stringify(new Set([…]))` is `"{}"` for
// every Set ever written — an empty one and this one hash identically. Exported
// as a `Set`, this module would produce a `catalogs` row that can never move
// again: a dead gate that looks exactly like a live one. The tab builds its own
// `Set` from this array, the way `ShadowAi.tsx` already does for `AI_APPS`.
export const SAAS_APPS = [
  'office365', 'microsoft', 'google', 'facebook', 'instagram', 'whatsapp', 'spotify', 'zoom', 'webex',
  'gotomeeting', 'discord', 'notion', 'splunk', 'datadog', 'launchpad', 'quantcast', 'disqus', 'yahoo',
  'amazon-cognito', 'google-ads', 'gstatic', 'amazon-aws', 'gcp', 'alibaba-cloud', 'docker', 'capcut',
  'wondershare', 'filmora',
]
