// What Guided Setup's confirmations claim about reach, asserted as sentences.
//
// ── THE CLAIM THIS FILE EXISTS TO HOLD DOWN ─────────────────────────────────
//
// `Nothing else in ${group} is touched, including the demo DataGen source.`
//
// It shipped, it is in the installed 1.0.20, and it is false. Git commits FILES
// (openapi.json, GitCommitBody.files: "Array of file paths to include in the
// commit"), and `groups/<g>/local/cribl/inputs.yml` holds every Source in the
// group — the app's own source and the demo DataGen source are two entries
// in one file. So the press that promised not to touch the DataGen source
// commits whatever anybody had left uncommitted in it and deploys the result to
// running Worker Processes.
//
// The sentence was true about what this app WRITES. The defect was that one
// sentence was carrying two claims, and only one of them was checked.
//
// These assertions are on the strings rather than on a rendered dialog, for the
// reason lakeLandingCopy.test and jobWatchdogCopy.test give: a dialog read back
// out of happy-dom is one long string, and "the honest sentence is in there
// somewhere" is exactly the assertion that passes while the sentence says the
// opposite of what it should.

import { describe, expect, it } from 'vitest'
import {
  AUTH_HEADER, ENDPOINT_LEAD, ENDPOINT_TIP, HTTP_RESTART_PRECAUTION, PACK_SETUP_FACTS, SETUP_FACTS, setupFacts, TOKEN_ELSEWHERE, TOKEN_ONCE, UNENCRYPTED_WARNING,
  behindNote, behindTip, deployConsequences, legacyNote, LEGACY_TIP, leftAloneSentence, pendingSentence, removeConsequences,
  undeployedSentence,
} from './provisionPanelCopy'
import { DEPLOY_CONSEQUENCES } from '../cribl/landing'
import {
  PACK_BREAKER_ID, PACK_HTTP_INPUT_ID, PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_ID, PACK_PARQUET_DATASET_ID,
  PACK_PIPELINE_ID,
} from '../cribl/pack'
import {
  commitScope, CLOUD_PORT_RANGE, HTTP_BREAKER_ID, HTTP_PIPELINE_ID, HTTP_SOURCE_ID,
  LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID, LEGACY_SYSLOG_SOURCE_ID, type CommitKey,
} from '../cribl/provision'

const GROUP = 'default'
const ALL: CommitKey[] = ['source', 'pipeline', 'route', 'destination']
const INPUTS = `groups/${GROUP}/local/cribl/inputs.yml`
const ROUTES = `groups/${GROUP}/local/cribl/pipelines/route.yml`
const OUTPUTS = `groups/${GROUP}/local/cribl/outputs.yml`

const ctx = (pending: string[] | null, keys: CommitKey[] = ALL, undeployed: string | null = null) => ({
  group: GROUP,
  scope: commitScope(GROUP, keys, pending),
  undeployed,
})

const all = (lines: string[]) => lines.join('\n')

describe('what the deploy confirmation claims about reach', () => {
  it('never says nothing else in the group is touched', () => {
    // The retired sentence, in every state the dialog can be in.
    for (const pending of [null, [], [INPUTS], ['groups/other/local/cribl/pipelines/route.yml']]) {
      expect(all(deployConsequences(ctx(pending)))).not.toContain('Nothing else in')
    }
  })

  it('still says what is true about the write, because that is what somebody is asking', () => {
    const line = deployConsequences(ctx([]))[0]
    expect(line).toContain(HTTP_PIPELINE_ID)
    expect(line).toContain(HTTP_SOURCE_ID)
    expect(line).toContain(HTTP_BREAKER_ID)
    expect(line).toContain('does not edit the demo DataGen source')
  })

  it('names the files the commit carries, rather than softening into "other configuration"', () => {
    const line = deployConsequences(ctx([]))[1]
    for (const f of [INPUTS, ROUTES, OUTPUTS]) expect(line).toContain(f)
    expect(line).toContain('whole files, not single objects')
  })

  it('names only three files for a teardown, because that run never touches the destination', () => {
    const lines = removeConsequences(ctx([], ['source', 'pipeline', 'route']), 'gigamon_lake', 'gigamon_ami')
    expect(all(lines)).toContain(INPUTS)
    expect(all(lines)).toContain(ROUTES)
    // Over-naming is the same class of untruth as hiding: `removeOnboardingStack`
    // never writes the destination, so its commit never carries outputs.yml.
    expect(all(lines)).not.toContain(OUTPUTS)
  })

  it('says the commit carries somebody else’s work only when it actually does', () => {
    // A warning that fires when nothing is pending is the one people learn to
    // click past, and this app can ask: /version/status is already granted and
    // already read on every status check.
    const dirty = pendingSentence(ctx([INPUTS]))
    expect(dirty).toContain(INPUTS)
    expect(dirty).toContain('somebody else’s unfinished work')

    const clean = pendingSentence(ctx([ROUTES.replace(`groups/${GROUP}/`, 'groups/other/')]))
    expect(clean).toContain('nothing already uncommitted')
    expect(clean).not.toContain('somebody else’s unfinished work')
  })

  it('says "could not tell" rather than "nothing is pending" when Git answered nothing', () => {
    const unknown = pendingSentence(ctx(null))
    expect(unknown).toContain('did not report')
    expect(unknown).toContain('Assume it may be')
    expect(unknown).not.toContain('nothing already uncommitted')
  })

  it('gives the three states three different sentences, and warns in only one', () => {
    // THE WARNING THAT ALWAYS FIRED. `pendingConfigPaths` used to answer `null`
    // for a clean tree as well as for a failed read, so on a healthy workspace
    // — the common case — every reader of both dialogs got the "could not tell…
    // Assume it may be" branch, unconditionally. That is the warning people
    // learn to click past, and it took the two informative states with it.
    // `[]` is now an answer (cribl/provision.ts), and these are the three
    // sentences it can produce.
    const clean = pendingSentence(ctx([]))
    const dirty = pendingSentence(ctx([INPUTS]))
    const failed = pendingSentence(ctx(null))

    expect(new Set([clean, dirty, failed]).size, 'two of the three states read the same').toBe(3)
    expect(clean).not.toContain('Assume it may be')
    expect(dirty).not.toContain('Assume it may be')
    expect(failed).toContain('Assume it may be')
  })

  it('says the files are what the commit is DRAWN FROM, because the run picks the subset', () => {
    // `scope.carries` is every file the dialog was given a key for; `deployAll`
    // commits `touchedKeys` — only what came back created or updated. On a
    // settled stack that is one file where this named four. The true set is not
    // knowable before the run, so the sentence stops claiming it — and still
    // names the files, because "some configuration files" would cost the reader
    // the one fact they need. The wording is asserted because the claim IS the
    // wording: there is no other observable.
    const line = deployConsequences(ctx([]))[1]
    for (const f of [INPUTS, ROUTES, OUTPUTS]) expect(line).toContain(f)
    expect(line).toContain('only the files this run actually changes')
    expect(line).toContain('drawn from')
  })

  it('carries every deploy consequence the rest of the app carries, verbatim', () => {
    // One constant, every deploy site — including the Worker Process restart and
    // the fact that a deploy moves the group to a COMMIT rather than applying
    // one change. Paraphrasing it here would be a second vocabulary for the
    // same fact, which is how the two halves drifted apart in the first place.
    const lines = deployConsequences(ctx([]))
    for (const owed of DEPLOY_CONSEQUENCES) expect(lines).toContain(owed)
    expect(removeConsequences(ctx([]), 'gigamon_lake', 'gigamon_ami')).toContain(DEPLOY_CONSEQUENCES[0])
  })

  it('stops claiming a stranded deploy puts exactly one commit live', () => {
    // "It also deploys commit #X, which is committed to <group> but was never
    // deployed" — singular, and a deploy takes a VERSION. Everything between
    // the group's configVersion and that hash goes live with it.
    const line = deployConsequences(ctx([], ALL, 'abcdef1234567890'))[3]
    expect(line).toContain('abcdef1234')
    expect(line).toContain('everything else committed since')
    expect(line).not.toContain('It also deploys commit')
  })

  it('says nothing about a stranded deploy when there is none', () => {
    expect(all(deployConsequences(ctx([])))).not.toContain('never deployed')
  })
})

describe('what a Raw HTTP source does across the restart', () => {
  it('is said in Guided Setup’s own dialogs, as a precaution, not in the sentences every deploy dialog shares', () => {
    // DEPLOY_CONSEQUENCES is also the Lake landing panel's, where no Raw HTTP
    // source need exist — and "refuses POSTs" was never measured.
    for (const line of DEPLOY_CONSEQUENCES) {
      expect(line).not.toMatch(/Raw HTTP|POST/)
    }
    expect(HTTP_RESTART_PRECAUTION).toMatch(/retry/)
    expect(HTTP_RESTART_PRECAUTION).not.toMatch(/refuses/)
    expect(deployConsequences(ctx([]))).toContain(HTTP_RESTART_PRECAUTION)
    expect(removeConsequences(ctx([]), 'gigamon_lake', 'gigamon_ami')).toContain(HTTP_RESTART_PRECAUTION)
  })
})

describe('what a teardown leaves alone because it could not see it', () => {
  it('names each object it will not delete, and says why', () => {
    const line = leftAloneSentence(GROUP, ['Syslog source in_gigamon_syslog', 'Raw HTTP source in_gigamon_http'])
    expect(line).toContain('in_gigamon_syslog')
    expect(line).toContain('in_gigamon_http')
    expect(line).toContain('could not')
    expect(line).toContain('not deleted')
  })

  it('says nothing when there is nothing it could not see', () => {
    expect(leftAloneSentence(GROUP, [])).toBeNull()
  })
})

describe('“What gets created & things to know”', () => {
  it('is five short labels, each with its explanation behind an ⓘ', () => {
    expect(SETUP_FACTS).toHaveLength(5)
    for (const fact of SETUP_FACTS) {
      expect(fact.label.split(/\s+/).length, fact.label).toBeLessThanOrEqual(10)
      expect(fact.tip.length, fact.label).toBeGreaterThan(40)
    }
  })

  it('still names the port range and the ids the stack creates', () => {
    const text = SETUP_FACTS.map((f) => `${f.label} ${f.tip}`).join(' ')
    expect(text).toContain(HTTP_PIPELINE_ID)
    expect(text).toContain(HTTP_BREAKER_ID)
    expect(text).toContain(`http_raw:${HTTP_SOURCE_ID}`)
    // The port range is the one constraint a Cloud customer cannot work
    // around, so it is a label, not only a tip.
    const range = `${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max}`
    expect(SETUP_FACTS.some((f) => f.label.includes(range))).toBe(true)
  })

  it('no longer tells anybody to open a Syslog port', () => {
    const text = SETUP_FACTS.map((f) => `${f.label} ${f.tip}`).join(' ')
    expect(text).not.toMatch(/syslog|5514|TCP\/UDP/i)
  })

  it('says nothing about "the lab" — that was our demo workspace, not the customer’s', () => {
    expect(SETUP_FACTS.map((f) => `${f.label} ${f.tip}`).join(' ')).not.toMatch(/\blab\b/i)
  })
})

describe('the endpoint card and the old Syslog stack', () => {
  it('says the token is shown once and kept nowhere by this app', () => {
    expect(TOKEN_ONCE).toContain('Shown once')
    expect(TOKEN_ONCE).toContain('keeps no copy')
    // And where to find it afterwards — never "lost".
    expect(TOKEN_ELSEWHERE).toContain('authentication settings')
  })

  it('says plainly, on a hybrid group, that the traffic is unencrypted', () => {
    expect(UNENCRYPTED_WARNING).toMatch(/^Unencrypted/)
    expect(UNENCRYPTED_WARNING).toContain('plain text')
    expect(UNENCRYPTED_WARNING).toContain('until you add')
  })

  it('keeps the endpoint card to one short lead line', () => {
    expect(ENDPOINT_LEAD.split(/\s+/).length).toBeLessThanOrEqual(20)
  })

  it('gives the exact header line, not just the header name', () => {
    // openapi.json, InputHttpRaw.authTokensExt: "Shared secrets to be provided
    // by any client (Authorization: <token>)" — the whole value, no scheme.
    expect(AUTH_HEADER).toBe('Authorization: <token>')
    expect(ENDPOINT_TIP).toContain(AUTH_HEADER)
    expect(ENDPOINT_TIP).toContain('Bearer')
    expect(ENDPOINT_TIP).toMatch(/no .?Bearer/)
  })

  it('names every old Syslog object the teardown will remove', () => {
    for (const id of [LEGACY_SYSLOG_SOURCE_ID, LEGACY_SYSLOG_PIPELINE_ID, LEGACY_SYSLOG_ROUTE_ID]) expect(LEGACY_TIP).toContain(id)
    expect(legacyNote(GROUP)).toContain(GROUP)
  })
})

describe('what the three confirmations say about an undeployed commit', () => {
  const HEAD = 'aaaa1111cccc2222'
  const at = (undeployed: string | null, undeployedChecking = false) => ({ ...ctx([]), undeployed, undeployedChecking })
  const removal = (c: ReturnType<typeof at>) => all(removeConsequences(c, 'gigamon_lake', 'gigamon_ami'))

  it('names the commit in the teardown dialogs too, because a teardown deploys as well', () => {
    // Both Remove dialogs commit and deploy (DEPLOY_CONSEQUENCES), so they move
    // the group to HEAD exactly as Deploy does. They used to say nothing.
    expect(removal(at(HEAD))).toContain(`${GROUP} is behind commit #${HEAD.slice(0, 10)}`)
    expect(all(deployConsequences(at(HEAD)))).toContain(`${GROUP} is behind commit #${HEAD.slice(0, 10)}`)
    expect(removal(at(null))).not.toContain('is behind')
  })

  it('says the check was still running, in every dialog, rather than saying nothing', () => {
    for (const text of [all(deployConsequences(at(null, true))), removal(at(null, true))]) {
      expect(text).toContain(`still checking whether ${GROUP} is behind a commit that touches it`)
      expect(text).not.toContain('is behind commit #')
    }
  })

  it('says it about when the dialog opened, so the sentence stays true while it is open', () => {
    expect(undeployedSentence(at(null, true))).toContain('When this dialog opened')
  })
})

describe('the undeployed-commit note beside Deploy', () => {
  it('claims only what pendingDeploy proves: a commit that touches the group, not a failed deploy', () => {
    expect(behindNote(GROUP)).toBe(`${GROUP} is behind a commit that touches it.`)
    const tip = behindTip(GROUP, 'aaaa1111cccc2222')
    expect(tip).toContain('#aaaa1111cc')
    expect(tip).toContain('somebody else')
    expect(`${behindNote(GROUP)} ${tip}`).not.toMatch(/did not finish|failed/)
  })
})

// ── What this file does not establish ───────────────────────────────────────
//
//   * THAT THE DIALOG RENDERS THESE. <ConfirmDialog> takes `consequences` and
//     prints them; that it does is asserted in ConfirmDialog's own tests, not
//     here, and ProvisionPanel passing these arrays rather than others is a
//     type-level fact only.
//   * THAT `POST /version/commit` STAGES WHOLE FILES. Every sentence here rests
//     on it. It comes from GitCommitBody.files ("Array of file paths") and from
//     ordinary Git semantics; the spec does not say "whole file" in those
//     words, and the only thing that could refute it is Cribl's implementation,
//     which these tests deliberately never reach. If it ever turned out to
//     stage per-object, these sentences would be over-naming and the fix would
//     move from copy to behaviour.

// With the pack available, "What gets created" describes what the PACK creates
// (design 2026-09-24, §2 item 5): its own ids, never the global stack's, and
// the two datasets it writes, one of them the Parquet copy.
describe('“What gets created” follows the onboarding path', () => {
  it('is the global stack’s list while the pack cannot be installed', () => {
    expect(setupFacts('global')).toBe(SETUP_FACTS)
  })

  it('names the pack’s objects, not the global ones, when the pack is the onboarding', () => {
    expect(setupFacts('pack')).toBe(PACK_SETUP_FACTS)
    const text = PACK_SETUP_FACTS.map((f) => `${f.label} ${f.tip}`).join(' ')
    for (const id of [PACK_ID, PACK_HTTP_INPUT_ID, PACK_BREAKER_ID, PACK_PIPELINE_ID, PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_PARQUET_DATASET_ID]) {
      expect(text, id).toContain(id)
    }
    for (const id of [HTTP_SOURCE_ID, HTTP_PIPELINE_ID, HTTP_BREAKER_ID]) expect(text, id).not.toContain(id)
    const range = `${CLOUD_PORT_RANGE.min}–${CLOUD_PORT_RANGE.max}`
    expect(PACK_SETUP_FACTS.some((f) => f.label.includes(range))).toBe(true)
  })

  it('keeps the page’s rules: short labels, the detail in the tip, no internal history', () => {
    for (const fact of PACK_SETUP_FACTS) {
      expect(fact.label.split(/\s+/).length, fact.label).toBeLessThanOrEqual(10)
      expect(fact.tip.length, fact.label).toBeGreaterThan(40)
      expect(`${fact.label} ${fact.tip}`).not.toMatch(/\b(spike|Phase \d|A-SP|I-D\d|P-S\d|slice|lab)\b|\b20\d\d-\d\d-\d\d\b|syslog/i)
    }
  })
})
