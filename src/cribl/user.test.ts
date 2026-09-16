// Null is an answer here, and it has to stay one.
//
// Per-user documents are keyed on the id this module returns. The tempting
// shortcut — a stand-in id when the platform names nobody — would file every
// unidentified viewer into one document, so one person's dismissed banner would
// be dismissed for all of them. So: no platform, no id, and the caller decides
// what to do about it.
//
// The memo is module state, so each test loads its own copy of the module rather
// than trying to unsay the previous test's answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadUser() {
  vi.resetModules()
  return import('./user')
}

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('currentUserId', () => {
  it('answers null where the platform names nobody — the localhost dev page', async () => {
    const { currentUserId } = await loadUser()
    expect(await currentUserId()).toBe(null)
  })

  it('reads the signed-in id from the platform global', async () => {
    vi.stubGlobal('getCriblUser', async () => ({ id: 'u-42', username: 'jpederson' }))
    const { currentUser, currentUserId } = await loadUser()
    expect(await currentUserId()).toBe('u-42')
    expect((await currentUser())?.username).toBe('jpederson')
  })

  it('asks the platform once, however many callers ask it', async () => {
    const getCriblUser = vi.fn(async () => ({ id: 'u-42', username: 'jpederson' }))
    vi.stubGlobal('getCriblUser', getCriblUser)
    const { currentUser, currentUserId } = await loadUser()
    await Promise.all([currentUser(), currentUserId(), currentUserId()])
    expect(getCriblUser).toHaveBeenCalledTimes(1)
  })

  it('treats a user with no id as no user', async () => {
    // Everything per-user is keyed on the id; a user without one is not a key.
    vi.stubGlobal('getCriblUser', async () => ({ username: 'jpederson' }))
    const { currentUserId } = await loadUser()
    expect(await currentUserId()).toBe(null)
  })

  it('answers null when the platform call fails, rather than failing its caller', async () => {
    vi.stubGlobal('getCriblUser', async () => {
      throw new Error('no session')
    })
    const { currentUserId } = await loadUser()
    expect(await currentUserId()).toBe(null)
  })
})
