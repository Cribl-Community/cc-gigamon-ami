// The shape of the accel manifest, pinned — because four other modules trust it.
//
// This file is not testing logic; there is barely any. It is testing a
// declaration, and it exists because everything Phase 2 does to a customer's
// workspace is derived from that declaration:
//
//   • the apply path POSTs `accelPostBody(entry, …)` verbatim;
//   • the teardown DELETEs by id, and decides what is ours from the `gno_`
//     prefix alone;
//   • the read path asks `$vt_results` for a run BY NAME, so the id is the join
//     key between a stored result and the panel that shows it;
//   • the panel's ⓘ keeps showing the query from src/queries, so the body here
//     being the SAME STRING is the whole reason that ⓘ is still true.
//
// A typo in an id here does not fail anything at runtime. It creates a scheduled
// search under a name nothing reads, bills the customer hourly for it, and
// leaves the teardown unable to find it. So the ids are asserted literally, and
// the bodies by identity against the modules they came from.
//
// Nothing here touches the network, and nothing here creates a saved search. The
// first real Apply is a human's click in Preview.

import { describe, expect, it } from 'vitest'
import { LAKE_TOTAL_QUERY } from '../../queries/dataFlow'
import { FEED_SAMPLE_QUERY } from '../../queries/fieldExplorer'
import { APP_VERSION } from '../config'
import {
  MANIFEST,
  MANIFEST_VERSION,
  accelDescription,
  accelEntry,
  accelPostBody,
  accelSavedSearch,
  isAccelId,
  shortSha256,
  type AccelEntry,
} from './manifest'

const lake = accelEntry('gno_lake_30d_c1d')
const sample = accelEntry('gno_sample_2m_c1h')

describe('the manifest', () => {
  it('holds exactly the two entries Phase 2 schedules', () => {
    // Literal, not a count. A third entry is a decision about a customer's bill
    // and about what the teardown will delete, so it changes this line too.
    expect(MANIFEST.map((e) => e.id)).toEqual(['gno_lake_30d_c1d', 'gno_sample_2m_c1h'])
  })

  it('gives every entry an id the teardown can recognise as ours', () => {
    // `/search/saved` is a flat shared namespace with no owning-app field. This
    // prefix is the only thing between an uninstall and somebody else's saved
    // search, so it is checked on every entry rather than on the two that exist.
    for (const e of MANIFEST) {
      expect(e.id, `${e.id} does not match /^gno_[a-z0-9_]+$/`).toMatch(/^gno_[a-z0-9_]+$/)
      expect(isAccelId(e.id)).toBe(true)
    }
  })

  it('does not claim somebody else\'s saved search', () => {
    expect(isAccelId('daily_rollup')).toBe(false)
    expect(isAccelId('GNO_lake_30d')).toBe(false)
    expect(isAccelId('my_gno_copy')).toBe(false)
    // A prefix is not a namespace: `gno` alone is not one of ours either.
    expect(isAccelId('gno_')).toBe(false)
    expect(isAccelId('gno')).toBe(false)
  })

  it('uses each id once', () => {
    // Two entries sharing an id means the second POST overwrites the first and
    // one panel reads the other's results — a wrong number, not an error.
    expect(new Set(MANIFEST.map((e) => e.id)).size).toBe(MANIFEST.length)
  })

  it('is frozen, entries included', () => {
    // The manifest is imported by the apply path, the teardown, the status table
    // and the read path. One of them sorting it in place, or "fixing" a cron on
    // the object, would change what the others do from a distance.
    expect(Object.isFrozen(MANIFEST)).toBe(true)
    for (const e of MANIFEST) expect(Object.isFrozen(e)).toBe(true)
  })

  it('says what each entry serves and why, in words an admin would recognise', () => {
    for (const e of MANIFEST) {
      expect(e.serves.trim().length, `${e.id} does not say which panel goes dark if it is paused`).toBeGreaterThan(10)
      expect(e.why.trim().length, `${e.id}: a justification that is not written down is not a justification`).toBeGreaterThan(80)
      expect(e.name.startsWith('GNO'), `${e.id}: the name is what an operator scans a shared list by`).toBe(true)
    }
  })
})

describe('the bodies', () => {
  it('schedules the identical string the panel shows — not a copy of it', () => {
    // The point of the phase in one assertion. `toBe` on a string is value
    // equality, which is the strongest identity JS has here; what it rules out
    // is the failure that matters — a literal retyped into this file that starts
    // equal and stops being equal the first time somebody edits one of them.
    expect(lake.body).toBe(LAKE_TOTAL_QUERY)
    expect(sample.body).toBe(FEED_SAMPLE_QUERY)
  })

  it('shows what it scheduled, today', () => {
    // Allowed to diverge one day — that is why there are two fields and two
    // digests. It has not diverged yet, and an accidental divergence should be
    // a failing test rather than a silent change to what an ⓘ claims.
    for (const e of MANIFEST) expect(e.display).toBe(e.body)
  })

  it('names its own dataset, because a schedule has no q() around it', () => {
    // src/queries builds most strings through q(), which prefixes the dataset.
    // A saved search runs the text as stored, so a body that arrived here
    // without that prefix would run against nothing.
    for (const e of MANIFEST) expect(e.body.startsWith('dataset="')).toBe(true)
  })

  it('keeps the schedule window out of the query text', () => {
    // The sample runs over -4m…-2m while the live panel reads the page range.
    // That difference belongs in the job's earliest/latest, never in the string,
    // because the string is what the ⓘ tells the customer produced the number.
    expect(sample.body).toBe(FEED_SAMPLE_QUERY)
    expect(sample.earliest).toBe('-4m')
    expect(sample.latest).toBe('-2m')
    expect(lake.earliest).toBe('-30d')
    expect(lake.latest).toBe('now')
  })
})

describe('the schedules', () => {
  it('runs each one on the cron the plan specifies, in UTC', () => {
    expect(lake.cron).toBe('10 0 * * *')
    expect(sample.cron).toBe('7 * * * *')
    // Never a local zone: a cron read in one moves twice a year, and a 30-day
    // total that skips or repeats an hour cannot be reconciled against the Lake.
    for (const e of MANIFEST) expect(e.tz).toBe('UTC')
  })

  it('keeps enough past runs for the read path to have something to read', () => {
    // A running job's results are not readable. keepLastN is the whole margin
    // between "the daily run is in progress" and a blank tile.
    expect(lake.keepLastN).toBe(2)
    expect(sample.keepLastN).toBe(3)
    for (const e of MANIFEST) expect(e.keepLastN).toBeGreaterThan(1)
  })
})

describe('the POST body', () => {
  it('is exactly this, for the Lake total', async () => {
    const description = await accelDescription(lake)
    expect(accelPostBody(lake, description)).toEqual({
      id: 'gno_lake_30d_c1d',
      name: 'GNO Lake total 30 days',
      query: LAKE_TOTAL_QUERY,
      description,
      earliest: '-30d',
      latest: 'now',
      isPrivate: false,
      schedule: {
        enabled: true,
        cronSchedule: '10 0 * * *',
        tz: 'UTC',
        keepLastN: 2,
        jitterPercent: 0,
        resumeMissed: false,
        resumeOnBoot: true,
        notifications: { disabled: true, items: [] },
      },
    })
  })

  it('is exactly this, for the feed sample', async () => {
    const description = await accelDescription(sample)
    expect(accelPostBody(sample, description)).toEqual({
      id: 'gno_sample_2m_c1h',
      name: 'GNO Feed sample 2 minutes',
      query: FEED_SAMPLE_QUERY,
      description,
      earliest: '-4m',
      latest: '-2m',
      isPrivate: false,
      schedule: {
        enabled: true,
        cronSchedule: '7 * * * *',
        tz: 'UTC',
        keepLastN: 3,
        jitterPercent: 0,
        resumeMissed: false,
        resumeOnBoot: true,
        notifications: { disabled: true, items: [] },
      },
    })
  })

  it('always carries all four schedule sub-fields, and never relies on a default', () => {
    // A-SP23, measured 2026-09-17: the `schedule` object is REPLACED, not merged.
    // A PATCH carrying `{enabled, cronSchedule}` returned 200 and silently
    // dropped `tz` and `keepLastN`; a PATCH carrying only the three required
    // top-level fields deleted `schedule`, `earliest`, `latest` and
    // `description` outright and unscheduled the search forever. On this
    // endpoint an omitted field is a deleted field — so every writer sends the
    // whole object, and this is the assertion that says so out loud.
    for (const e of MANIFEST) {
      const { schedule } = accelPostBody(e, 'desc')
      expect(Object.keys(schedule).sort()).toEqual([
        'cronSchedule',
        'enabled',
        'jitterPercent',
        'keepLastN',
        'notifications',
        'resumeMissed',
        'resumeOnBoot',
        'tz',
      ])
      expect(schedule.tz).toBe(e.tz)
      expect(schedule.keepLastN).toBe(e.keepLastN)
      expect(schedule.enabled).toBe(true)
    }
  })

  it('starts every schedule enabled, and applies no jitter', () => {
    // jitterPercent 0 rather than unset: unset lets the Leader apply its global
    // jitter, which moves the submit minute — and the submit minute is the
    // variable A-SP0's cost model is a function of.
    for (const e of MANIFEST) {
      const { schedule } = accelPostBody(e, 'desc')
      expect(schedule.jitterPercent).toBe(0)
      expect(schedule.resumeMissed).toBe(false)
      expect(schedule.resumeOnBoot).toBe(true)
      expect(schedule.notifications).toEqual({ disabled: true, items: [] })
    }
  })

  it('carries the three fields the schema requires, and does not try to set the owner', () => {
    // POST /search/saved requires id, name, query. `user` and `displayUsername`
    // are server-controlled (A-SP23): POST stamps them and a later PATCH cannot
    // move them, so sending either would be the app claiming something it cannot
    // do.
    const body = accelPostBody(lake, 'desc') as unknown as Record<string, unknown>
    expect(body.id).toBeTruthy()
    expect(body.name).toBeTruthy()
    expect(body.query).toBeTruthy()
    expect('user' in body).toBe(false)
    expect('displayUsername' in body).toBe(false)
  })

  it('is a pure function of its inputs', () => {
    expect(accelPostBody(lake, 'desc')).toEqual(accelPostBody(lake, 'desc'))
    // …and hands back a fresh object each time, so a caller that mutates the
    // body before POSTing cannot reach into the next caller's.
    expect(accelPostBody(lake, 'desc')).not.toBe(accelPostBody(lake, 'desc'))
  })

  it('computes the description for the caller that does not want to', async () => {
    expect(await accelSavedSearch(lake)).toEqual(accelPostBody(lake, await accelDescription(lake)))
  })
})

describe('the description digest', () => {
  it('reads the way the plan writes it', async () => {
    // Read by a human in Cribl's own UI, with the app nowhere in front of them:
    // which app and release wrote this, which entry it is, and whether the query
    // it runs is still the one that app intends to run and to show.
    expect(await accelDescription(lake)).toMatch(
      /^GNO \S+ · manifest v1 · serves gno_lake_30d_c1d · body-sha256:[0-9a-f]{12} · display-sha256:[0-9a-f]{12}$/,
    )
    expect(await accelDescription(sample)).toContain('serves gno_sample_2m_c1h')
  })

  it('names the running app version and the manifest version, not a copy of either', async () => {
    // APP_VERSION is 'dev' under test, because __APP_VERSION__ is a build-time
    // define. Asserting against the import rather than a literal is what stops
    // this test passing while the description reports a version that was true
    // when somebody typed it.
    const description = await accelDescription(lake)
    expect(description.startsWith(`GNO ${APP_VERSION} · manifest v${MANIFEST_VERSION} ·`)).toBe(true)
  })

  it('hashes the same on a CRLF checkout and an LF one', async () => {
    // core.autocrlf=true on this machine. A digest that moved with the checkout
    // would report every scheduled search as drifted from the app that owns it,
    // on Windows only — the exact shape of the bug that cost six CI runs in
    // Phase 1.
    const crlf = { ...lake, body: 'a\r\nb', display: 'c\r\nd' } satisfies AccelEntry
    const lfOnly = { ...lake, body: 'a\nb', display: 'c\nd' } satisfies AccelEntry
    expect(await accelDescription(crlf)).toBe(await accelDescription(lfOnly))
    expect(await shortSha256('a\r\nb')).toBe(await shortSha256('a\nb'))
  })

  it('still notices a real change', async () => {
    // The normalisation must not be so broad that it hides an edit.
    expect(await shortSha256('a\nb')).not.toBe(await shortSha256('ab'))
    expect(await shortSha256(LAKE_TOTAL_QUERY)).not.toBe(await shortSha256(FEED_SAMPLE_QUERY))
  })

  it('is a real SHA-256, truncated — not something home-made', async () => {
    // FIPS 180-4's own vector: SHA-256('abc') = ba7816bf8f01cfea414140de5dae…
    expect(await shortSha256('abc')).toBe('ba7816bf8f01')
    expect(await shortSha256('')).toMatch(/^[0-9a-f]{12}$/)
  })

  it('distinguishes the two digests when body and display differ', async () => {
    // Today they are equal for both entries, so the pair looks redundant. This
    // is the case the pair exists for: a body wider than what the ⓘ shows is
    // visible to an operator reading the description, and the two fields are
    // what make it visible.
    const split = { ...lake, body: 'dataset="x" | limit 1', display: 'dataset="x" | limit 2' } satisfies AccelEntry
    const [, , body, display] = /body-sha256:([0-9a-f]{12}) · display-sha256:([0-9a-f]{12})/.exec(
      `x ${await accelDescription(split)}`,
    ) as RegExpExecArray
    expect(body).not.toBe(display)
  })
})

describe('looking an entry up', () => {
  it('finds each one', () => {
    expect(accelEntry('gno_lake_30d_c1d').serves).toContain('Data Flow')
    expect(accelEntry('gno_sample_2m_c1h').serves).toContain('Field Explorer')
  })

  it('throws rather than handing back undefined', () => {
    // Every caller is asking about a search this app claims to own. An absent
    // entry is a programming error; returning undefined would push it into a
    // panel as a blank number.
    expect(() => accelEntry('gno_not_a_thing' as never)).toThrow(/gno_not_a_thing/)
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT ──────────────────────────────────────────
//
// Read this before treating a green run as evidence about the customer's
// workspace.
//
//  • That the cron expressions mean what the comments say. Nothing here parses
//    `10 0 * * *`; the Leader does, in a zone this file only declares.
//  • That `keepLastN: 2` is enough. It depends on how long the 30-day run takes
//    and how often the tile is read — both measured on one workspace, neither
//    re-measured here.
//  • That the POST body is accepted. The shape is checked against the schema in
//    openapi.json by a human reading it, not by this test; the first real POST
//    is the owner's Apply in Preview.
//  • That the bodies are still the strings the panels' ⓘ shows. This file
//    asserts they are the same STRING as the exports in src/queries; that those
//    exports are what the ⓘ renders is src/queries/display-freeze.test.ts's job,
//    and neither test proves the number on screen was computed by either one.
//  • Anything about `$vt_results`. The read path is a different module and a
//    different set of failure modes — a run that does not exist yet, one that
//    failed, one that is still going.
