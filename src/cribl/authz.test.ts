// The four things the gate gets wrong if nobody pins them.
//
//   401 IS A DENIAL TOO. Every Cribl endpoint provisioning writes through
//   documents 401 and not 403 — POST /system/inputs answers 200/401/409/500 —
//   and the app fetch-proxy's own status for a path missing from
//   config/policies.yml is documented nowhere. A 403-only classifier would sail
//   straight past the slice-1.3 bug this slice was built to catch.
//
//   THE FIRST REFUSAL IS THE ONE THAT MATTERS. A deploy is eight calls. The one
//   that stopped it names the object an admin has to grant; everything after is
//   a consequence of carrying on.
//
//   THE SENTENCE NAMES THE CALL. "You do not have permission" names nothing and
//   cannot be acted on. Method plus path is exactly what somebody types into a
//   policy, so that pair is asserted rather than the wording around it.
//
//   THE APP'S OWN STORE IS NOT A PERMISSION PROBLEM. The KV store is app-scoped
//   and granted with the app (AGENTS.md), so telling a customer to ask an admin
//   for it would send them somewhere with nothing to grant.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  denialMark, denialReason, denialSince, isDenial, noteDenial, resetDenials, type Denial,
} from './authz'
import { capi } from './capi'

afterEach(() => {
  resetDenials()
  vi.unstubAllGlobals()
})

describe('isDenial', () => {
  it('counts 401 as a refusal, not only 403', () => {
    expect([401, 403].map(isDenial)).toEqual([true, true])
  })

  it('leaves every other status alone', () => {
    // 404 is "not created yet" on this app's whole provisioning path, and 409 is
    // the syslog port already being in use. Neither is a permission.
    expect([200, 404, 409, 500, 502].map(isDenial)).toEqual([false, false, false, false, false])
  })
})

describe('the ledger', () => {
  it('hands a control the first refusal of its own attempt, not an earlier one', () => {
    noteDenial('GET', '/m/default/system/inputs/in_gigamon_syslog', 403)
    const mark = denialMark()
    noteDenial('PATCH', '/m/default/system/inputs/in_gigamon_syslog', 403)
    noteDenial('PATCH', '/m/default/routes/default', 403)

    const first = denialSince(mark)
    expect(first?.method, 'the refusal from before the attempt leaked into it').toBe('PATCH')
    expect(first?.path, 'the later refusal won — a consequence reported as the cause').toBe(
      '/m/default/system/inputs/in_gigamon_syslog',
    )
  })

  it('answers null when the attempt was refused nothing', () => {
    noteDenial('PATCH', '/m/default/routes/default', 403)
    expect(denialSince(denialMark())).toBeNull()
  })

  it('records nothing for a status that is not a refusal', () => {
    const mark = denialMark()
    noteDenial('POST', '/m/default/system/inputs', 409)
    expect(denialSince(mark)).toBeNull()
  })

  it('drops the query string, which is not part of what an admin grants', () => {
    const mark = denialMark()
    noteDenial('GET', '/version?limit=5', 403)
    expect(denialSince(mark)?.path).toBe('/version')
  })

  it('is filled by any call through capi, so a control does not have to be told', async () => {
    // capi is the one transport every configuration and KV call leaves through.
    // If this stops being true the gate goes quiet without failing anything
    // else, so it is pinned here rather than trusted.
    vi.stubGlobal('fetch', async () => ({ status: 403, text: async () => '{"message":"Not authorized or licensed to perform this action."}' }))
    const mark = denialMark()
    await capi('PATCH', '/m/default/system/inputs/in_gigamon_syslog', {})
    const d = denialSince(mark)
    expect(d?.status).toBe(403)
    expect(d?.message, 'Cribl wrote a sentence and the ledger dropped it').toBe(
      'Not authorized or licensed to perform this action.',
    )
  })

  it('quotes nothing when Cribl sent no body, rather than quoting the status back', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 403, text: async () => '' }))
    const mark = denialMark()
    await capi('DELETE', '/m/default/pipelines/gigamon_syslog')
    expect(denialSince(mark)?.message).toBeUndefined()
  })

  it('never blames a control for a refusal nobody clicked for', async () => {
    // The long-running-search watch is the app's first recurring background
    // call: a GET every five minutes, forever. Without an origin on the record,
    // its 403 lands inside whatever <GatedControl> window happens to be open and
    // latches that button as denied — measured on a provisioning POST that
    // SUCCEEDED and still came back refused.
    vi.stubGlobal('fetch', async () => ({ status: 403, text: async () => '{"message":"Not authorized."}' }))
    const mark = denialMark()
    await capi('GET', '/m/default_search/search/jobs?offset=0', undefined, { background: true })
    expect(denialSince(mark), 'a background poll told the UI the user’s click was refused').toBeNull()
    // Recorded all the same — it is a real refusal and the ledger stays complete
    // by construction; it is simply never attributed to anybody's click.
    expect(denialMark(), 'the refusal was dropped rather than marked').toBeGreaterThan(mark)
    // And the control's own refusal, in the same window, is still reported.
    noteDenial('POST', '/version/commit', 403)
    expect(denialSince(mark)?.path).toBe('/version/commit')
  })
})

describe('the sentence', () => {
  const denial: Denial = {
    method: 'PATCH',
    path: '/m/default/system/inputs/in_gigamon_syslog',
    status: 403,
    message: 'Not authorized or licensed to perform this action.',
    seq: 1,
    origin: 'click',
  }

  it('names the method and the path, which is what an admin would grant', () => {
    const text = denialReason('syslog_stack.apply', denial)
    expect(text).toContain('PATCH /m/default/system/inputs/in_gigamon_syslog')
    expect(text).toContain('HTTP 403')
  })

  it('does not claim to know it was a permission, because Cribl does not say', () => {
    // Cribl answers the same status for "not authorized" and "not licensed", on
    // 42 endpoints of the 4.19.0 spec, in one sentence that covers both.
    const text = denialReason('syslog_stack.apply', denial)
    expect(text).toContain('usually a permission')
    expect(text).toContain('licensing limit')
  })

  it('quotes what Cribl actually said', () => {
    expect(denialReason('syslog_stack.apply', denial)).toContain('Not authorized or licensed to perform this action.')
  })

  it('does not send somebody to an admin for the app’s own store', () => {
    const text = denialReason('search_caps.save', { ...denial, method: 'PUT', path: '/kvstore/app/settings/search_caps' })
    expect(text).toContain('granted with the app itself')
    expect(text, 'a refusal from the app-scoped store is not something an admin grants').not.toContain('usually a permission')
  })
})
