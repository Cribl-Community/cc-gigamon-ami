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

//
//   AND THE TABLE ITSELF (added in Phase 3, which nearly doubled it). What
//   gatedWrites.test.ts checks is the CHAIN — every write named, every config
//   write gated, every gate rendered. What nothing checked is whether the rows
//   say true things: that a `does` is a noun phrase the sentence can finish, that
//   a control and the write it owns agree about which surface they are on, and
//   that the two controls this release deliberately does NOT have are still
//   absent. Those are the three below.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GATED_WRITES, WRITE_SITES,
  denialMark, denialReason, denialSince, isDenial, noteDenial, resetDenials,
  type Denial, type WriteId,
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
    noteDenial('GET', '/version?offset=0&limit=5', 403)
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
    const text = denialReason('onboarding_stack.apply', denial)
    expect(text).toContain('PATCH /m/default/system/inputs/in_gigamon_syslog')
    expect(text).toContain('HTTP 403')
  })

  it('does not claim to know it was a permission, because Cribl does not say', () => {
    // Cribl answers the same status for "not authorized" and "not licensed", on
    // 42 endpoints of the 4.19.0 spec, in one sentence that covers both.
    const text = denialReason('onboarding_stack.apply', denial)
    expect(text).toContain('usually a permission')
    expect(text).toContain('licensing limit')
  })

  it('quotes what Cribl actually said', () => {
    expect(denialReason('onboarding_stack.apply', denial)).toContain('Not authorized or licensed to perform this action.')
  })

  it('does not send somebody to an admin for the app’s own store', () => {
    const text = denialReason('search_caps.save', { ...denial, method: 'PUT', path: '/kvstore/app/settings/search_caps' })
    expect(text).toContain('granted with the app itself')
    expect(text, 'a refusal from the app-scoped store is not something an admin grants').not.toContain('usually a permission')
  })

  it('reads as one sentence for every control, not only for the one somebody tried', () => {
    // `does` is a fragment: the sentence is "…so <does> did not complete". A row
    // that wrote "Changing retention." instead of "changing how long Cribl Lake
    // keeps this dataset" produces "…so Changing retention. did not complete",
    // which nothing else in the suite would ever notice.
    for (const [id, w] of Object.entries(GATED_WRITES)) {
      expect(w.does[0], `${id}: \`does\` is mid-sentence, so it starts lower case`).toBe(w.does[0].toLowerCase())
      expect(w.does.endsWith('.'), `${id}: \`does\` ends the sentence for you — drop the full stop`).toBe(false)
      expect(denialReason(id as WriteId, denial)).toContain(`so ${w.does} did not complete`)
    }
  })

  it('names the Cribl call in Phase 3’s sentences, because those are the grants an admin has to add', () => {
    // The Lake landing panel's three are the likeliest refusals in the app: they
    // are the newest grants and the ones a Member is most plausibly short of.
    const lake: Denial = { ...denial, path: '/products/lake/lakes/default/datasets/gigamon_ami' }
    for (const id of ['lake_landing.retention', 'lake_landing.description', 'lake_landing.destination'] as WriteId[]) {
      const text = denialReason(id, lake)
      expect(text).toContain('PATCH /products/lake/lakes/default/datasets/gigamon_ami')
      expect(text, `${id} is a Cribl config write, so the sentence must send somebody to an admin`).toContain('usually a permission')
    }
  })
})

describe('the writes table', () => {
  it('has each control on the same surface as the write it owns', () => {
    // A `config` write gated by an `app`-surface control tells a customer that
    // THE APP'S OWN STORE refused them, when Cribl did — so they go looking at
    // an install nobody can change instead of at a policy an admin can grant.
    // The chain test next door checks that a gate EXISTS; this checks it agrees.
    const wrong = WRITE_SITES.flatMap((s) =>
      s.gates.filter((g) => GATED_WRITES[g].surface !== s.surface).map((g) => `${s.at} (${s.surface}) → ${g} (${GATED_WRITES[g].surface})`),
    )
    expect(wrong).toEqual([])
  })

  it('still has no control for the two editors the spikes gate', () => {
    // DELIBERATE ABSENCE, RECORDED AS ONE. The Search v1→v2 toggle waits on P-S5
    // and P-S7; the partitions / acceleratedFields editor waits on P-S9. There is
    // no writer for either, so there is no WriteId for either — an id with no
    // writer is a control this table promises and nothing performs, and
    // gatedWrites.test.ts would then be waiting for a button that is absent on
    // purpose. cribl/landing.ts's SPIKE_GATED says what each one would have
    // needed to know.
    //
    // WHEN A SPIKE REPORTS AND THE EDITOR IS BUILT, delete this assertion in the
    // same commit as the new id. A stale guard against a thing that has since
    // become correct is worse than no guard.
    const ids = Object.keys(GATED_WRITES)
    expect(ids.filter((id) => /search_version|partitions|accelerated/i.test(id))).toEqual([])
  })

  it('writes down why each ungated write is ungated, in more than a word', () => {
    // gatedWrites.test.ts asserts 20 characters. The point of the exception is
    // the reason, and every one of these is a claim somebody has to be able to
    // check: "app-scoped store, granted with the app" is checkable; "n/a" is not.
    for (const s of WRITE_SITES.filter((x) => x.gates.length === 0)) {
      expect(s.why.trim().length, `${s.at}: an ungated write with a reason too short to check`).toBeGreaterThan(60)
    }
  })
})
