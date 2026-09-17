// What Guided Setup's confirmations claim about reach, asserted as sentences.
//
// ── THE CLAIM THIS FILE EXISTS TO HOLD DOWN ─────────────────────────────────
//
// `Nothing else in ${group} is touched, including the demo DataGen source.`
//
// It shipped, it is in the installed 1.0.20, and it is false. Git commits FILES
// (openapi.json, GitCommitBody.files: "Array of file paths to include in the
// commit"), and `groups/<g>/local/cribl/inputs.yml` holds every Source in the
// group — the app's syslog source and the demo DataGen source are two entries
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
import { deployConsequences, pendingSentence, removeConsequences } from './provisionPanelCopy'
import { DEPLOY_CONSEQUENCES } from '../cribl/landing'
import { commitScope, SYSLOG_PIPELINE_ID, SYSLOG_SOURCE_ID, type ResourceKey } from '../cribl/provision'

const GROUP = 'default'
const ALL: ResourceKey[] = ['source', 'pipeline', 'route', 'destination']
const INPUTS = `groups/${GROUP}/local/cribl/inputs.yml`
const ROUTES = `groups/${GROUP}/local/cribl/routes.yml`
const OUTPUTS = `groups/${GROUP}/local/cribl/outputs.yml`

const ctx = (pending: string[] | null, keys: ResourceKey[] = ALL, undeployed: string | null = null) => ({
  group: GROUP,
  scope: commitScope(GROUP, keys, pending),
  undeployed,
})

const all = (lines: string[]) => lines.join('\n')

describe('what the deploy confirmation claims about reach', () => {
  it('never says nothing else in the group is touched', () => {
    // The retired sentence, in every state the dialog can be in.
    for (const pending of [null, [], [INPUTS], ['groups/other/local/cribl/routes.yml']]) {
      expect(all(deployConsequences(ctx(pending)))).not.toContain('Nothing else in')
    }
  })

  it('still says what is true about the write, because that is what somebody is asking', () => {
    const line = deployConsequences(ctx([]))[0]
    expect(line).toContain(SYSLOG_PIPELINE_ID)
    expect(line).toContain(SYSLOG_SOURCE_ID)
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
    // Over-naming is the same class of untruth as hiding: `removeSyslogStack`
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
