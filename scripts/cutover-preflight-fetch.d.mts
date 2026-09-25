// Types for scripts/cutover-preflight-fetch.mjs, for src/cribl/cutoverPreflight.test.ts.
export class PreflightRefusal extends Error {}
export function refusalOf(method: string | undefined, url: string): string | null
export function readOnlyFetch(deps: {
  base: string
  fetch: (url: string, init: { method: string; signal?: AbortSignal | null }) => Promise<Response>
  record?: (req: { method: string; url: string }) => void
}): (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export function searchOriginFromDevPage(html: string | null | undefined): string | null
