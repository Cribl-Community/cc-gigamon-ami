// Who is signed in — one answer, for the whole page.
//
// The platform sets `window.getCriblUser()` when the app runs inside Cribl and
// resolves it to the signed-in user (AGENTS.md); it memoises the result itself,
// and it is read-only, so nothing here defines or polyfills it. This module
// memoises anyway, not to save the round trip but so the app has a single answer
// to "who is this?", including a single answer for "nobody said".
//
// It is absent on the localhost dev page, and could be absent inside Cribl on an
// older platform build, so `currentUserId()` answers `string | null` and every
// caller handles the null. What a caller must NOT do is invent an id for that
// case: a shared stand-in like `anonymous` would file every unidentified viewer
// into the same per-user document, and the first one to dismiss a banner would
// dismiss it for all of them — the exact failure per-user preferences exist to
// avoid. Null means "do not personalise": read the defaults, and skip the write.

import type { CriblUser } from './config'

let cached: Promise<CriblUser | null> | null = null

/** The signed-in Cribl user, or null when the platform does not name one. */
export function currentUser(): Promise<CriblUser | null> {
  if (!cached) cached = read()
  return cached
}

async function read(): Promise<CriblUser | null> {
  const w = typeof window === 'undefined' ? undefined : window
  // Called off `window` rather than through a local alias: it is the platform's
  // function, and it is entitled to its own `this`.
  if (typeof w?.getCriblUser !== 'function') return null
  try {
    const user = await w.getCriblUser()
    // An id is the only field the platform always sends, and the only one this
    // app keys anything on; a user without one is no better than no user.
    return user && typeof user.id === 'string' && user.id.length > 0 ? user : null
  } catch (err) {
    // One failure is the answer. The global is memoised platform-side, so a
    // retry returns the same rejected promise — but a silent null reads exactly
    // like "no platform here", which is a different problem with a different fix.
    console.warn('Cribl: could not read the signed-in user', err)
    return null
  }
}

/** Id of the signed-in user, or null. Callers key per-user documents on this and
 *  fall back to defaults when it is null. */
export async function currentUserId(): Promise<string | null> {
  const user = await currentUser()
  return user ? user.id : null
}
