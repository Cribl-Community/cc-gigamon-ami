// What the onboarding panel says, held to the Guided Setup page's rules:
//   * each panel's lead is ONE sentence (the detail goes behind an ⓘ);
//   * no internal project history anywhere a customer reads it — no spike,
//     phase, decision or slice ids, and no measurement dates;
//   * the token is never a value in any sentence.
// Every export is read, strings directly and functions called with plausible
// arguments, so a new sentence cannot join the module without being checked.

import { describe, expect, it } from 'vitest'
import * as copy from './onboardingCopy'
import { ENDPOINT_LEAD } from './provisionPanelCopy'
import { sampleVolume } from '../cribl/onboarding/plan'

const HISTORY = /\b(spike|Phase \d|A-SP\d*|I-D\d+|P-S\d+|slice)\b/i
const DATE = /\b20\d\d-\d\d-\d\d\b/

/** Every string the module can produce. */
function everything(): string[] {
  const out: string[] = []
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value === 'string') out.push(value)
    else if (value && typeof value === 'object') out.push(...Object.values(value as Record<string, unknown>).filter((v): v is string => typeof v === 'string'))
    else if (typeof value === 'function') {
      const fn = value as (...a: unknown[]) => unknown
      const tries: unknown[][] = {
        accelCostWords: [['running', 'about 1 CPU-s a day', { created: 3, keepRunning: 2 }], ['paused', null, { created: 3, keepRunning: 0 }]],
        sampleVolumeWords: [[sampleVolume()]],
        installedRefusal: [[{ version: '0.1.0', published: true, fromRelease: true, group: 'g1' }], [{ version: '9.9.9', published: false, fromRelease: false, group: 'g1' }], [{ version: '0.1.0', published: true, fromRelease: false, group: 'g1' }]],
        onboardLabel: [[{ installed: false, httpNeedsWork: true }], [{ installed: true, httpNeedsWork: true }], [{ installed: true, httpNeedsWork: false }]],
        packStatusWords: [[{ installed: true, version: '0.1.0', current: false, error: null }], [{ installed: false, version: null, current: false, error: null }]],
        datasetWords: [['gigamon_ami', { format: 'json', retentionPeriodInDays: 30 }], ['gigamon_ami_pq', null]],
        httpStatusWords: [[{ port: 20005, tls: true, tokenSet: true, disabled: false }], [null]],
        accelStatusWords: [[{ total: 18, installed: 18, running: 3, error: null }], [{ total: 18, installed: 0, running: 0, error: null }]],
        keptDatasetsSentence: [[['gigamon_ami', 'gigamon_ami_pq', 'gigamon_ami_sample']]],
      }[name] ?? [['g1']]
      for (const args of tries) {
        const r = fn(...args)
        if (typeof r === 'string') out.push(r)
      }
    }
  }
  return out
}

describe('onboarding copy', () => {
  it('says nothing about how it was built', () => {
    const all = everything()
    expect(all.length).toBeGreaterThan(30)
    for (const s of all) {
      expect(s, s).not.toMatch(HISTORY)
      expect(s, s).not.toMatch(DATE)
    }
  })

  it('leads are one sentence each', () => {
    for (const lead of [copy.ONBOARDING_LEAD, copy.REMOVE_ONLY_LEAD, ENDPOINT_LEAD]) {
      expect(lead.trim().endsWith('.'), lead).toBe(true)
      expect(lead.trim().slice(0, -1), lead).not.toMatch(/[.!?]\s/)
    }
  })

  it('never carries a token value: the only token words are "a new token (not shown)" and "token set"', () => {
    for (const s of everything()) expect(s, s).not.toMatch(/[0-9a-f]{32,}/i)
  })

  it('the card never claims data is arriving', () => {
    expect(copy.NOT_SEEN_YET).toBe('Configured and deployed. This app has not yet seen a record from this source.')
    for (const s of everything()) expect(s, s).not.toMatch(/\b(is|are) (receiving|arriving)\b/i)
  })
})

// What this file could not assert: that each tip is attached to the control it
// explains (OnboardingPanel.test.tsx reads the rendered page), and whether the
// words are clear to somebody setting up a Leader — which is a reading, not a
// test.
