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
import { AI_FILTER, aiOverallQuery, aiUsersQuery, appsQuery } from '../../queries/shadowAi'
import { APP_SRC_SNAPSHOT_QUERY, SERVICE_EDGES_SNAPSHOT_QUERY } from '../../queries/snapshots'
import { APP_VERSION } from '../config'
import { APP_SRC_CADENCE, APP_SRC_WINDOW, OVERVIEW_CADENCE, OVERVIEW_WINDOW } from './words'
import {
  MANIFEST,
  MANIFEST_VERSION,
  accelDescription,
  accelEntry,
  accelPostBody,
  accelSavedSearch,
  isAccelId,
  columnsOf,
  shortSha256,
  type AccelEntry,
} from './manifest'

const lake = accelEntry('gno_lake_30d_c1d')
const sample = accelEntry('gno_sample_2m_c1h')
const overview = accelEntry('gno_overview_c1h')
const nodes = accelEntry('gno_svc_nodes_c1h')
const edges = accelEntry('gno_svc_edges_c1h')
const appSrc = accelEntry('gno_app_src_c1h')

describe('the manifest', () => {
  it('holds exactly these nine', () => {
    // Literal, not a count. An entry is a decision about a customer's bill and
    // about what the teardown will delete, so adding one changes this line too.
    expect(MANIFEST.map((e) => e.id)).toEqual([
      'gno_lake_30d_c1d',
      'gno_sample_2m_c1h',
      'gno_overview_c1h',
      'gno_svc_nodes_c1h',
      'gno_svc_edges_c1h',
      'gno_presence_c1h',
      'gno_app_src_c1h',
      'gno_dns_resolver_c1h',
      'gno_pipeline_c1h',
    ])
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
      expect(e.panels.length, `${e.id} serves nothing`).toBeGreaterThan(0)
      for (const panel of e.panels) {
        expect(e.serves, `${e.id}: the prose an admin reads left out ${panel.queryId}`).toContain(panel.what)
      }
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

  // ── WHAT REPLACED `expect(e.display).toBe(e.body)` ──────────────────────
  //
  // That assertion was the only thing stopping a scheduled body drifting from
  // the query a panel claims produced its number, and it held for both Phase 2
  // entries. No union body can satisfy it: the hourly overview scan carries five
  // panels' aggregates and each of those panels shows its own narrower query.
  //
  // It was loosened deliberately, and these cases are what it was loosened INTO.
  // They walk the chain a shared body creates rather than one link of it —
  // body → tail → the columns the panel reads — which is strictly more than the
  // old line checked: it said nothing whatever about tails, and read.ts has
  // accepted a `tail` since Phase 2 with nothing digesting it.
  //
  // What none of this can check is that the body's `total` MEANS what a panel's
  // `total` means. That argument is written beside the strings it is about, in
  // src/queries/snapshots.ts.

  it('schedules the same string the ⓘ shows, wherever one search serves one panel', () => {
    // The old assertion, kept exactly where it still applies. An entry with one
    // panel and no tail is making the Phase 2 promise and still has to keep it.
    for (const e of MANIFEST) {
      if (e.panels.length === 1 && e.panels[0].tail === undefined) {
        expect(e.panels[0].display, `${e.id} serves one panel and does not run that panel's query`).toBe(e.body)
      }
    }
  })

  it('cuts every served panel out of the body with a tail naming only columns the body defines', () => {
    // The failure this catches is silent and is a WRONG NUMBER. A tail
    // projecting an alias the body does not define renders nothing; a tail
    // projecting a DIFFERENT alias renders another panel's figure under this
    // panel's ⓘ. Neither raises an error, and neither falls back to live.
    for (const e of MANIFEST) {
      const body = columnsOf(e.body)
      expect(body.outputs, `${e.id}: this test cannot read what its body emits`).not.toBeNull()
      const produced = [...(body.outputs as Set<string>)]
      for (const panel of e.panels) {
        if (panel.tail === undefined) continue
        const tail = columnsOf(panel.tail, body.outputs as Set<string>)
        for (const needed of tail.inputs) {
          expect(produced, `${e.id}/${panel.queryId}: the tail reads '${needed}', which the body does not produce`).toContain(needed)
        }
        expect(tail.outputs, `${e.id}/${panel.queryId}: this test cannot read what the tail emits`).not.toBeNull()
        const emitted = [...(tail.outputs as Set<string>)]
        for (const column of panel.reads) {
          expect(emitted, `${e.id}/${panel.queryId}: the panel reads '${column}', which its tail does not emit`).toContain(column)
        }
      }
    }
  })

  it('never hands a panel a column that means something else', () => {
    // The Capacity tiles call sum(total_bytes) `total`; Findings calls count()
    // `total`. They share the overview body, so one of them has to read a
    // different name — and the tail is what makes that safe rather than merely
    // documented, because the column it does not project is a column the panel
    // cannot read. If `total` ever reappears in what Findings is handed, this
    // fails.
    const findings = overview.panels.find((p) => p.queryId === 'findings-counts')
    const capacity = overview.panels.find((p) => p.queryId === 'capacity-kpi')
    expect(findings?.tail).toBeDefined()
    expect(columnsOf(findings?.tail as string, columnsOf(overview.body).outputs as Set<string>).outputs).not.toContain('total')
    expect(columnsOf(capacity?.tail as string, columnsOf(overview.body).outputs as Set<string>).outputs).toContain('total')
  })

  it('keeps the untagged destination as a group of its own, for the view that sums across it', () => {
    // Service map's client-only totals are every flow OUT of a source service,
    // including flows to peers carrying no AWS name tag. Whether a `summarize`
    // keeps a null group key is not something this app has measured, and if it
    // drops them that number comes back short with nothing on screen to say so.
    // The body coalesces the null into a sentinel before grouping, so both
    // derivations are exact by construction: this pins the mechanism, because
    // removing the `extend` would leave the panel still rendering.
    expect(edges.body).toContain('extend dst_svc=iif(isnotnull(dst_aws_flat_tags_name)')
  })

  it('reads the service graph once, un-tailed, because two panels meant two stored reads', () => {
    // WHAT THIS REPLACES, AND WHY THE ASSERTION MOVED. This entry used to carry
    // `service-map-edges` and `service-map-sources`: two panel records, two
    // tails, and therefore two `$vt_results` jobs for one stored result, on the
    // route the app opens on. read.ts submits one read per served panel and its
    // memo caches the read key rather than the rows, so the second was never
    // going to be free. ServiceMap.tsx now filters, sorts and sums over the rows
    // of a single un-tailed read.
    //
    // The tail being ABSENT is the thing worth pinning: bring one back and the
    // tab silently goes back to two reads, or — worse — one panel starts reading
    // the other panel's tailed view.
    expect(edges.panels.map((p) => p.queryId)).toEqual(['service-map-edges'])
    expect(edges.panels[0].tail, 'a tail here is a second read, or a wrong row').toBeUndefined()
    // One panel, no tail, so the Phase 2 promise applies again: the ⓘ shows the
    // string that produced the number. The generic case above enforces it; this
    // says out loud which string that now is.
    expect(edges.panels[0].display).toBe(SERVICE_EDGES_SNAPSHOT_QUERY)
    expect(edges.body).toBe(SERVICE_EDGES_SNAPSHOT_QUERY)
    // Both client-side derivations read these three and nothing else.
    expect([...edges.panels[0].reads].sort()).toEqual(['dst_svc', 'flows', 'src_aws_flat_tags_name'])
  })

  it('serves all three of Shadow AI from one grouping, each ⓘ still its own query', () => {
    // The tab fired three unfiltered whole-window scans on mount and none was
    // served. These are the three, by identity against the modules the panels'
    // ⓘ renders from — a retyped copy here would agree on the day it was written
    // and drift the first time somebody edited one of them.
    expect(appSrc.body).toBe(APP_SRC_SNAPSHOT_QUERY)
    expect(appSrc.panels.map((p) => p.queryId)).toEqual(['shadow-ai-apps', 'shadow-ai-overall', 'shadow-ai-users'])
    expect(appSrc.panels.find((p) => p.queryId === 'shadow-ai-apps')?.display).toBe(appsQuery)
    expect(appSrc.panels.find((p) => p.queryId === 'shadow-ai-overall')?.display).toBe(aiOverallQuery)
    expect(appSrc.panels.find((p) => p.queryId === 'shadow-ai-users')?.display).toBe(aiUsersQuery)
  })

  it('groups Shadow AI by application AND source, because summing per-app dcounts double-counts', () => {
    // THE CORRECTNESS OF THE ENTRY IN ONE TEST. A body grouped by app_name alone
    // stores a distinct-user count per app; the "AI users" tile would then add
    // those up and count anybody using two AI apps twice — high, plausible, and
    // in the one direction a viewer cannot check. Grouped on the pair, the tile
    // RECOMPUTES the distinct count over stored rows instead of summing one.
    expect(appSrc.body).toContain('by app_name, src_ip')
    const overall = appSrc.panels.find((p) => p.queryId === 'shadow-ai-overall')
    expect(overall?.tail, 'the AI users tile must recount distinct sources, never sum stored counts').toContain(
      'users=dcount(src_ip)',
    )
    expect(overall?.tail).not.toContain('sum(users)')
    // Same argument for the per-source app-diversity badge.
    expect(appSrc.panels.find((p) => p.queryId === 'shadow-ai-users')?.tail).toContain('aiapps=dcount(app_name)')
  })

  it('filters the AI tails with the same predicate the live queries embed', () => {
    // Two of the three tails select the AI apps out of the shared grouping, and
    // they have to select exactly what the live query selects. AI_FILTER is
    // imported by both sides for that reason: adding a vendor to AI_APPS has to
    // move the schedule's tails and the panels' own queries together.
    for (const id of ['shadow-ai-overall', 'shadow-ai-users']) {
      expect(appSrc.panels.find((p) => p.queryId === id)?.tail, `${id} does not filter to the AI apps`).toContain(
        AI_FILTER,
      )
    }
    expect(aiOverallQuery).toContain(AI_FILTER)
    expect(aiUsersQuery).toContain(AI_FILTER)
  })

  it('gives every panel of a shared body its own tail', () => {
    // A hook naming a multi-panel entry without naming its panel reads the whole
    // shared row, every other panel's columns included. useSearch sends that
    // case live rather than guessing; this is the other half — an entry sharing
    // a body has to give each panel a way to be cut out of it.
    for (const e of MANIFEST) {
      if (e.panels.length === 1) continue
      for (const panel of e.panels) {
        expect(panel.tail, `${e.id}/${panel.queryId} shares a body with others and has no tail`).toBeDefined()
      }
    }
  })

  it('gives every served panel a distinct id, because the digest is keyed on it', () => {
    for (const e of MANIFEST) {
      const ids = e.panels.map((p) => p.queryId)
      expect(new Set(ids).size, `${e.id} uses a queryId twice`).toBe(ids.length)
    }
  })

  it('names its own dataset, because a schedule has no q() around it', () => {
    // src/queries builds most strings through q(), which prefixes the dataset.
    // A saved search runs the text as stored, so a body that arrived here
    // without that prefix would run against nothing.
    for (const e of MANIFEST) expect(e.body.startsWith('dataset="')).toBe(true)
  })

  it('keeps the schedule window out of the query text', () => {
    // The sample runs over a settled window while the live panel reads the page
    // range. That difference belongs in the job's earliest/latest, never in the
    // string, because the string is what the ⓘ tells the customer produced the
    // number.
    expect(sample.body).toBe(FEED_SAMPLE_QUERY)
    expect(lake.earliest).toBe('-30d')
    expect(lake.latest).toBe('now')
  })

  it('ends every window clear of the file flush, never at now', () => {
    // -3m, and this is a correctness fix rather than a preference. The Lake
    // landing profile this app provisions holds a file open for up to 120
    // seconds before it flushes, so a window running to `now` reads a
    // part-written file as a whole one. On the sample entry that under-reported
    // which fields are arriving — the one question that panel exists to answer,
    // wrong in the direction nobody can see.
    expect(sample.earliest).toBe('-5m')
    expect(sample.latest).toBe('-3m')
    for (const e of [overview, nodes, edges]) {
      expect(e.earliest, `${e.id} does not read fifteen minutes`).toBe('-18m')
      expect(e.latest, `${e.id} reads up to a minute that is still landing`).toBe('-3m')
    }
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

  it('retains a day of runs on the hourly entries, because the picker reads them', () => {
    // Phase 2's rule was that a keepLastN larger than what the code READS is a
    // promise the code does not keep, and the code read exactly one run. The
    // snapshot picker reads any of them, so twenty-four hourly runs are a day of
    // past states a viewer can move between rather than a number nothing uses.
    // It also has to stay inside Cribl's own seven-day result retention, or the
    // picker would offer times whose results the platform had already reaped.
    for (const e of [overview, nodes, edges]) {
      expect(e.keepLastN, `${e.id} does not retain a day of hourly runs`).toBe(24)
      expect(e.cron, `${e.id} is not hourly, so keepLastN: 24 is not a day`).toMatch(/^2[0-2] \* \* \* \*$/)
    }
  })

  it('describes itself to a reader in words that match the cron it runs on', () => {
    // Block 4 of an ⓘ is prose, not a cron expression, and five tabs quote the
    // same sentence. Nothing derives it — turning `20 * * * *` into English is a
    // cron formatter, which this codebase deliberately does not have — so this
    // is the pin: move the schedule without moving the sentence and it fails.
    expect(overview.cron).toBe('20 * * * *')
    expect(OVERVIEW_CADENCE).toContain('20 past the hour')
    expect(OVERVIEW_WINDOW).toContain('fifteen minutes')
    expect(OVERVIEW_WINDOW).toContain('three minutes')
    // Shadow AI's three panels quote their own sentence, because this entry
    // fires at :36 rather than :20 — one more place a cron can move without the
    // words moving with it.
    expect(appSrc.cron).toBe('36 * * * *')
    expect(APP_SRC_CADENCE).toContain('36 past the hour')
    expect(APP_SRC_WINDOW).toContain('fifteen minutes')
  })

  it('gives the Shadow AI scan a cron minute nothing else is using', () => {
    // Concurrent jobs from one account are admitted about 1.6 s apart, so two
    // entries on one minute queue behind each other instead of running. This is
    // the cheap version of that rule: every hourly entry on its own minute.
    const minutes = MANIFEST.filter((e) => /^\d+ \* \* \* \*$/.test(e.cron)).map((e) => e.cron.split(' ')[0])
    expect(new Set(minutes).size, 'two hourly entries share a submit minute').toBe(minutes.length)
    expect(appSrc.keepLastN).toBe(24)
    expect(appSrc.earliest).toBe('-18m')
    expect(appSrc.latest).toBe('-3m')
  })

  it('submits the hourly entries a minute apart', () => {
    // Concurrent jobs from one account are admitted about 1.6 s apart, so one
    // cron minute would start all three against each other. :20 is also the only
    // submit minute inside the cost model's measured domain.
    expect([overview.cron, nodes.cron, edges.cron]).toEqual(['20 * * * *', '21 * * * *', '22 * * * *'])
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
      earliest: '-5m',
      latest: '-3m',
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
      /^GNO \S+ · manifest v2 · serves gno_lake_30d_c1d · body-sha256:[0-9a-f]{12} · display-sha256:[0-9a-f]{12}$/,
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
    const crlf = { ...lake, body: 'a\r\nb', panels: [{ ...lake.panels[0], display: 'c\r\nd' }] } satisfies AccelEntry
    const lfOnly = { ...lake, body: 'a\nb', panels: [{ ...lake.panels[0], display: 'c\nd' }] } satisfies AccelEntry
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
    const split = {
      ...lake,
      body: 'dataset="x" | limit 1',
      panels: [{ ...lake.panels[0], display: 'dataset="x" | limit 2' }],
    } satisfies AccelEntry
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
