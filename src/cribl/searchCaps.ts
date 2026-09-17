// The one search setting an installer can change without a code change.
//
// cribl/search.ts caps how long each query may run, scaled by the window it
// reads. Those seconds are sized against the demo feed and are the weakest
// numbers in that file: the same panel on a production tenant reads more data in
// the same wall time, so a cap that looks generous here can stop a panel that
// was working — and a stopped panel reads to a customer as a broken app, not as
// a budget decision. Decision A-D30 is that the customer gets to move them.
//
// INSTALL-WIDE, NOT PER-USER, at `app/settings/search_caps`. That is the whole
// point: the person raising the cap is fixing a broken-looking dashboard, and a
// per-user override would fix it for them while every other viewer carried on
// looking at the broken version. It also means one document rather than one per
// seat, and a GET that does not need to know who is signed in — so this works on
// a platform build where `window.getCriblUser()` names nobody.
//
// FROM THE NEXT QUERY, NOT THE FIRST. `loadSearchCaps()` is fired unawaited at
// startup (src/main.tsx) and applies whenever it lands. Awaiting it before first
// render would put a KV round trip in front of every cold load of every tab, to
// change a number that matters to the rare install that has changed it; the
// panels that run in that window run under the defaults, which is exactly what
// they did before this file existed.
//
// NOTHING HERE WRITES ON LOAD. A stored value that is absent, corrupt (the
// `[object Object]` a JSON content type used to store — see kv.ts) or absurd
// (a cap of a day) is read as "no setting", and the defaults stay in force. The
// obvious tidy-up — rewrite the corrupt key with something valid — is a write on
// load, which AGENTS.md forbids, and it would be a write nobody asked for. The
// next real Save overwrites it.

import { appendLog, getDoc, putDoc } from './kv'
import {
  MAX_CAP_SECONDS, MIN_CAP_SECONDS, capTiersInForce, parseCapTiers, setCapTiers, type CapTier,
} from './search'

/** The bounds as a sentence, interpolated from the bounds themselves so that
 *  moving one cannot leave a screen quoting the old number. */
export const CAP_RANGE_TEXT = `a whole number of seconds from ${MIN_CAP_SECONDS} up to ${MAX_CAP_SECONDS}`

/** Install-wide setting, under the `app/settings/<name>` key shape from the plan. */
export const SEARCH_CAPS_KEY = 'app/settings/search_caps'

/** Audit-trail namespace. One per feature area; this app writes `gigamon/log/…`. */
export const LOG_NAMESPACE = 'gigamon'

/**
 * The stored shape. `upToSeconds` is `number | null` rather than `number`
 * because the widest tier has no upper bound and JSON has no Infinity —
 * `JSON.stringify(Infinity)` is `null`. Writing the null deliberately, rather
 * than letting the serializer produce it, keeps the round trip legible to
 * whoever reads the raw document: `parseCapTiers` turns it back into Infinity.
 */
interface StoredTier {
  upToSeconds: number | null
  capSeconds: number
}

const toStored = (tiers: readonly CapTier[]): StoredTier[] =>
  tiers.map((t) => ({
    upToSeconds: Number.isFinite(t.upToSeconds) ? t.upToSeconds : null,
    capSeconds: t.capSeconds,
  }))

/**
 * Where the table in force came from — the settings panel says this out loud,
 * because "600" means something different depending on the answer.
 *
 * `page` is the honest third state: the Save was applied to this page and the
 * store refused to keep it (the localhost dev page always refuses, by design).
 * Calling that "stored" would be a lie the customer finds out about on reload.
 */
export type CapsSource = 'default' | 'stored' | 'page'

let source: CapsSource = 'default'

/** Where the caps currently in force came from. */
export function capsSource(): CapsSource {
  return source
}

let started: Promise<CapsSource> | null = null

/**
 * Read the stored caps once per page and apply them if they are usable.
 *
 * Fired at module scope in main.tsx and NOT awaited — see the header. Memoized,
 * so the settings panel can call it again to wait for the same read rather than
 * starting a second one, and so a re-render cannot fire a third.
 *
 * A GET needs no confirmation (AGENTS.md) and this writes nothing at all, which
 * is the property that matters on a load path.
 */
export function loadSearchCaps(): Promise<CapsSource> {
  started ??= (async () => {
    const tiers = parseCapTiers(await getDoc<unknown>(SEARCH_CAPS_KEY))
    if (tiers) {
      setCapTiers(tiers)
      source = 'stored'
    }
    return source
  })()
  return started
}

export interface SaveResult {
  /** True only when the store took the write. False means this page and nowhere else. */
  ok: boolean
  /** The table now in force, whatever happened — what the form should show. */
  tiers: readonly CapTier[]
  /** Why the table was refused outright, when it was. */
  refused?: string
}

/**
 * Save the caps, and say what really happened.
 *
 * NOT A VOLATILE OPERATION, and therefore no confirmation prompt — a decision
 * worth writing down rather than re-litigating. AGENTS.md guards calls that
 * "remove or irreversibly overwrite" real customer configuration or data: every
 * DELETE, and the PUT/POST/PATCH that replace a pipeline definition or bulk-edit
 * routes. This replaces one field of this app's own document, in this app's own
 * scoped store, which the app created and nothing else reads. It removes
 * nothing, and it is not irreversible: the defaults are printed beside every
 * input on the panel, Reset fills them back in, and the values being replaced go
 * into the audit entry below as `replaced`.
 *
 * The two things AGENTS.md does require are both already here rather than in a
 * modal: the operation starts from a deliberate click (Save, which is the only
 * caller), and the thing affected is named exactly — a settings panel whose four
 * labelled inputs and install-wide warning ARE the prompt. A confirmation step
 * on top would be theatre, and the cost of theatre is not zero: it is what
 * teaches somebody to click through the Remove-the-syslog-stack confirmation
 * that genuinely needs reading.
 *
 * The caps are applied to this page BEFORE the write, so the next query uses
 * what the customer just set even if the store is unreachable. `ok: false` then
 * says the value lives in this page's memory and nowhere else, which the panel
 * has to print instead of "Saved" — a setting that silently did not save is
 * worse than one that admits it, because you find out by losing it.
 */
export async function saveSearchCaps(tiers: readonly CapTier[]): Promise<SaveResult> {
  const valid = parseCapTiers(tiers)
  if (!valid) {
    return {
      ok: false,
      tiers: capTiersInForce(),
      refused: `Every limit has to be ${CAP_RANGE_TEXT}.`,
    }
  }
  const replaced = toStored(capTiersInForce())
  setCapTiers(valid)
  const stored = toStored(valid)
  const ok = await putDoc(SEARCH_CAPS_KEY, stored)
  source = ok ? 'stored' : 'page'
  // A user-triggered write to install-wide state, which is exactly what the
  // trail is for: who widened the caps, when, and what the numbers were before.
  // Only on success, because the trail lives in the store that just refused, and
  // an entry recording a save that did not happen is worse than no entry. Not
  // awaited: the customer is waiting on their setting, not on the audit copy,
  // and kv.ts already warns once per session when the store is unreachable.
  if (ok) void appendLog(LOG_NAMESPACE, { action: 'settings.search_caps.saved', caps: stored, replaced })
  return { ok, tiers: capTiersInForce() }
}
