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

describe('userKeySegment', () => {
  it('leaves a plain id as it is, and turns anything else into _hex, never a percent-escape', async () => {
    const { userKeySegment } = await loadUser()
    expect(userKeySegment('u-42')).toBe('u-42')
    expect(userKeySegment('auth0|0123456789abcdef01234567')).toBe('auth0_7c0123456789abcdef01234567')
    expect(userKeySegment('a.b/c')).toBe('a_2eb_2fc')
    expect(userKeySegment('é')).toBe('_e9')
    expect(userKeySegment('名')).toBe('_u540d')
    for (const id of ['auth0|x', 'a b', 'q?r#s', 'x/y']) expect(encodeURIComponent(userKeySegment(id)), id).toBe(userKeySegment(id))
  })

  it('never maps two ids to one document', async () => {
    const { userKeySegment } = await loadUser()
    // `_` is escaped too, so an id that already looks escaped cannot collide.
    expect(userKeySegment('a|b')).not.toBe(userKeySegment('a_7cb'))
    const ids = ['a|b', 'a_7cb', 'a_b', 'a-b', 'aB', 'ab', 'a.b', 'a_2eb']
    expect(new Set(ids.map(userKeySegment)).size).toBe(ids.length)
  })
})
