// One way to reach the Cribl API.
//
// Everything goes to `${API_BASE}${path}` — installed, that is the platform's
// fetch proxy; under `npm run dev` it is the Vite `/capi` proxy (see
// cribl/config.ts). Both inject authentication on the way past, which is why
// nothing in this app ever sees, stores or refreshes a token. A caller reaching
// for an `Authorization` header has misread the sandbox: the platform strips
// that header before forwarding, so setting one can only break the request it
// was meant to help. There is no token to pass, and no place to put one.
//
// `capi` answers with a status and a body instead of throwing, because its
// callers read the status as data rather than as failure: provisioning treats a
// 404 from a GET as "not created yet" and creates it, and the app-scoped KV
// store answers 404 for a key nobody has written. A helper that threw would
// make the normal case an exception.
//
// Cribl Search is deliberately NOT here. cribl/search.ts keeps its own client
// because its retry-on-429, job cancellation and abort behaviour are the
// product — folding them in would make this module about search, and bolting
// search's semantics onto a provisioning call would retry writes.

import { isDenial, noteDenial } from './authz'
import { API_BASE } from './config'

/** A Cribl response as the callers read it: the status, and whatever body came
 *  back — parsed when it is JSON, the raw text when it is not. */
export interface ApiResp {
  status: number
  body: unknown
}

/** The per-call knobs. Each exists because a caller in this app needs it; the
 *  default for all three is the behaviour provisioning has always had. */
export interface CapiInit {
  /**
   * Cancel the request. The dataset-intelligence poll already threads a
   * caller's signal through its own fetches so that leaving the tab stops the
   * poll; anything that moves onto `capi` has to keep that seam.
   */
  signal?: AbortSignal
  /**
   * Content type for the body. Defaults to `application/json`, which is right
   * for every config endpoint. The app-scoped KV store is the exception and
   * needs `text/plain`: given a JSON content type it parses the body, persists
   * `String(obj)` — the literal `[object Object]` — and still answers 200, so
   * the document is silently lost. Only `text/plain` round-trips.
   */
  contentType?: string
  /**
   * Hand back the response body as the exact text received, unparsed. The KV
   * reader has to tell a stored document from that `[object Object]`
   * corruption, and it can only do that on the bytes as they arrived — once
   * they have been through `JSON.parse` the two are both "a value".
   */
  text?: boolean
  /**
   * Nobody clicked anything to cause this call: it is a poll, a timer, a
   * refresh that runs on its own. A refusal of it is still recorded, and it is
   * marked so that `denialSince` never attributes it to a control.
   *
   * WHY THIS EXISTS. `<GatedControl>` marks the ledger, runs the write, and
   * treats any refusal recorded in between as ITS refusal — which is exactly
   * right when the only calls in flight were the ones the click made. The
   * long-running-search watch (cribl/jobWatchdog.ts) is the app's first
   * recurring background call, and without this flag its five-minute 403 lands
   * inside whichever window happens to be open and latches an unrelated button
   * as denied. Measured: a provisioning POST that succeeded came back marked
   * denied because a watchdog poll was refused while it ran.
   */
  background?: boolean
}

/**
 * Call the Cribl API. `body` is JSON-serialized whatever the content type: the
 * KV store wants a JSON document sent *as text*, not a different payload.
 */
export async function capi(method: string, path: string, body?: unknown, init: CapiInit = {}): Promise<ApiResp> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': init.contentType ?? 'application/json' },
    signal: init.signal,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown = null
  if (!init.text && text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  const resp: ApiResp = { status: res.status, body: init.text ? text : parsed }
  // Every configuration and KV call in this app leaves through here, so this is
  // the one place a refusal can be recorded without asking every caller to
  // remember. `capi` still does not throw and still reports the status as data —
  // the control that caused the refusal is the thing that decides what it means
  // (cribl/authz.ts), and a GET refused during a status check is not a failure
  // at all, just a fact the screen has to stop calling "absent".
  if (isDenial(resp.status)) {
    noteDenial(method, path, resp.status, criblMessage(resp), init.background ? 'background' : 'click')
  }
  return resp
}

/**
 * The sentence Cribl wrote, when it wrote one. Unlike `errText` this answers
 * `undefined` rather than manufacturing "HTTP 403": a denial notice quotes Cribl
 * only when there is something to quote, and quoting a status back at somebody
 * who can already see it is noise.
 */
function criblMessage(r: ApiResp): string | undefined {
  if (r.body && typeof r.body === 'object') {
    const m = (r.body as { message?: string; error?: string }).message || (r.body as { error?: string }).error
    return typeof m === 'string' && m ? m : undefined
  }
  return typeof r.body === 'string' && r.body.trim() ? r.body.slice(0, 200) : undefined
}

/**
 * The most useful sentence a failed Cribl response carries. Cribl reports
 * errors as `{ message }` or `{ error }`; anything else is truncated rather
 * than dropped, because a UI that says only "HTTP 400" sends the user to the
 * network tab, which the sandbox makes awkward to reach.
 */
export function errText(r: ApiResp): string {
  if (r.body && typeof r.body === 'object') {
    const m = (r.body as { message?: string; error?: string }).message || (r.body as { error?: string }).error
    if (m) return m
    return JSON.stringify(r.body).slice(0, 200)
  }
  return typeof r.body === 'string' ? r.body.slice(0, 200) : `HTTP ${r.status}`
}

/**
 * Address an endpoint inside a config group. Cribl endpoints that do not begin
 * with `/system/` are contextual and take a `/m/:groupId` prefix (AGENTS.md,
 * "Config Group Context"), so which group a call lands in is part of the path,
 * never a default. Search is the one caller that never needs this: it always
 * runs in `default_search`, and has `searchUrl` in config.ts for that.
 */
export const groupPath = (group: string, path: string) => `/m/${group}${path}`
