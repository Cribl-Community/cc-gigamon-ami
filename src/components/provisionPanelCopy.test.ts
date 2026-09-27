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
//
// *(Corrected 2026-09-26, `chore/remove-global-stacks`: this file also held the
// teardown dialog of the global Raw HTTP and Syslog stacks — `removeConsequences`,
// `removalPendingSentence`, `leftAloneSentence`, the Syslog tips, `REMOVE_UNDO`,
// `behindNote` — which went with that panel. The sentences the onboarding
// plan's dialogs reuse are asserted here over a scope of whole group files.)*

import { describe, expect, it } from 'vitest'
import {
  AUTH_HEADER, ENDPOINT_LEAD, HTTP_RESTART_PRECAUTION, PACK_SETUP_FACTS, TOKEN_ONCE, UNENCRYPTED_WARNING,
  carriesSentence, pendingSentence, undeployedSentence,
} from './provisionPanelCopy'
import * as copy from './provisionPanelCopy'
import { DEPLOY_CONSEQUENCES } from '../cribl/landing'
import {
  PACK_BREAKER_ID, PACK_HTTP_INPUT_ID, PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_ID, PACK_PARQUET_DATASET_ID,
  PACK_PIPELINE_ID,
} from '../cribl/pack'
import { commitScopeFor, CLOUD_PORT_RANGE } from '../cribl/provision'

const GROUP = 'default'
const INPUTS = `groups/${GROUP}/local/cribl/inputs.yml`
const ROUTES = `groups/${GROUP}/local/cribl/pipelines/route.yml`
const BREAKERS = `groups/${GROUP}/local/cribl/breakers.yml`
/** A commit that names three whole files a group shares with everything else in it. */
const CARRIES = [INPUTS, ROUTES, BREAKERS]
const MARKERS = ['local/cribl/inputs.yml', 'local/cribl/pipelines/route.yml', 'local/cribl/breakers.yml']

const ctx = (pending: string[] | null, undeployed: string | null = null) => ({
  group: GROUP,
  scope: commitScopeFor(GROUP, CARRIES, MARKERS, pending),
  undeployed,
})

describe('what a confirmation claims about reach', () => {
  it('names the files the commit carries, rather than softening into "other configuration"', () => {
    const line = carriesSentence(ctx([]), 'change')
    for (const f of CARRIES) expect(line).toContain(f)
    expect(line).toContain('whole files, not single objects')
    expect(line).toContain('drawn from')
    expect(line).not.toContain('Nothing else in')
  })

  it('says the commit carries somebody else’s work only when it actually does', () => {
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
    const clean = pendingSentence(ctx([]))
    const dirty = pendingSentence(ctx([INPUTS]))
    const failed = pendingSentence(ctx(null))
    expect(new Set([clean, dirty, failed]).size, 'two of the three states read the same').toBe(3)
    expect(clean).not.toContain('Assume it may be')
    expect(dirty).not.toContain('Assume it may be')
    expect(failed).toContain('Assume it may be')
  })
})

describe('what a Raw HTTP source does across the restart', () => {
  it('is a precaution of its own, not in the sentences every deploy dialog shares', () => {
    // DEPLOY_CONSEQUENCES is also the Lake landing panel's, where no Raw HTTP
    // source need exist — and "refuses POSTs" was never measured.
    for (const line of DEPLOY_CONSEQUENCES) {
      expect(line).not.toMatch(/Raw HTTP|POST/)
    }
    expect(HTTP_RESTART_PRECAUTION).toMatch(/retry/)
    expect(HTTP_RESTART_PRECAUTION).not.toMatch(/refuses/)
  })
})

describe('what a confirmation says about an undeployed commit', () => {
  const HEAD = 'aaaa1111cccc2222'
  const at = (undeployed: string | null, undeployedChecking = false) => ({ ...ctx([]), undeployed, undeployedChecking })

  it('names the commit, and that everything since goes live with it', () => {
    const line = undeployedSentence(at(HEAD)) ?? ''
    expect(line).toContain(`${GROUP} is behind commit #${HEAD.slice(0, 10)}`)
    expect(line).toContain('everything else committed since')
    expect(line).not.toContain('It also deploys commit')
    expect(undeployedSentence(at(null))).toBeNull()
  })

  it('says the check was still running, rather than saying nothing', () => {
    const text = undeployedSentence(at(null, true)) ?? ''
    expect(text).toContain(`still checking whether ${GROUP} is behind a commit that touches it`)
    expect(text).not.toContain('is behind commit #')
  })

  it('says it about when the dialog opened, so the sentence stays true while it is open', () => {
    expect(undeployedSentence(at(null, true))).toContain('When this dialog opened')
  })
})

describe('the endpoint card', () => {
  it('says the token is shown once and kept nowhere by this app', () => {
    expect(TOKEN_ONCE).toContain('Shown once')
    expect(TOKEN_ONCE).toContain('keeps no copy')
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
  })
})

describe('no word of the global stacks’ teardown is left', () => {
  it('exports none of the Remove panel’s sentences', () => {
    for (const gone of [
      'removeConsequences', 'removalPendingSentence', 'leftAloneSentence', 'legacyNote', 'LEGACY_TIP',
      'LEGACY_ONLY_LEAD', 'LEGACY_ONLY_TIP', 'REMOVE_UNDO', 'behindNote', 'behindTip',
    ]) expect(Object.keys(copy), gone).not.toContain(gone)
  })
})

// ── What this file does not establish ───────────────────────────────────────
//
//   * THAT THE DIALOG RENDERS THESE. <ConfirmDialog> takes `consequences` and
//     prints them; that it does is asserted in ConfirmDialog's own tests, and
//     the onboarding plan's tests hold which of these its dialogs carry.
//   * THAT `POST /version/commit` STAGES WHOLE FILES. Every sentence here rests
//     on it. It comes from GitCommitBody.files ("Array of file paths") and from
//     ordinary Git semantics; the spec does not say "whole file" in those
//     words, and the only thing that could refute it is Cribl's implementation,
//     which these tests deliberately never reach. If it ever turned out to
//     stage per-object, these sentences would be over-naming and the fix would
//     move from copy to behaviour.

// "What gets created" describes what the PACK creates (design 2026-09-24, §2
// item 5): its own ids, never the global stack's, and the two datasets it
// writes, one of them the Parquet copy. Since 2026-09-25 it is the only list:
// the pack is the only onboarding, whatever the pinned release says.
describe('“What gets created” is the pack’s list, always', () => {
  it('has no global-stack list and no chooser left to fall back to', () => {
    // `SETUP_FACTS` and `setupFacts(mode)` made the page describe the global
    // Raw HTTP stack while the pack could not be installed.
    expect(Object.keys(copy)).not.toContain('SETUP_FACTS')
    expect(Object.keys(copy)).not.toContain('setupFacts')
  })

  it('names the pack’s objects, not the global ones', () => {
    const text = PACK_SETUP_FACTS.map((f) => `${f.label} ${f.tip}`).join(' ')
    for (const id of [PACK_ID, PACK_HTTP_INPUT_ID, PACK_BREAKER_ID, PACK_PIPELINE_ID, PACK_HTTP_JSON_ROUTE_ID, PACK_HTTP_PARQUET_ROUTE_ID, PACK_PARQUET_DATASET_ID]) {
      expect(text, id).toContain(id)
    }
    // The ids the global stack earlier releases created carried.
    for (const id of ['in_gigamon_http', 'gigamon_http_normalize', 'gigamon_ami_json_array']) expect(text, id).not.toContain(id)
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
