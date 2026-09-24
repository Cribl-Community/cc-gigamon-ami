// The two datasets a query can address, and the one rule that moves it between
// them.
//
// Sample data (owner decision, 2026-09-24) lands in its OWN Lake dataset and
// never in the customer's. The app reads it only while the customer's dataset
// holds nothing, and every number, ⓘ, deep link and Copilot brief has to name
// the dataset that actually answered — so the rewrite below is applied to all
// four, and this file holds it to the strings the app really ships.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LAKE_DATASET } from '../cribl/config'
import { PACK_SAMPLE_DATASET_ID } from '../cribl/pack'
import { q } from '../cribl/search'
import { REAL_DATASET, REAL_DATA_PROBE_QUERY, SAMPLE_DATASET, retargetQuery } from './datasets'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_SELECTOR = `dataset="${LAKE_DATASET}"`
const SAMPLE_SELECTOR = `dataset="${PACK_SAMPLE_DATASET_ID}"`

describe('the dataset names', () => {
  it('duplicate the pack and config constants, and cannot drift from them', () => {
    // Duplicated because src/queries is loaded under plain Node by the query
    // extractor and cannot import cribl/pack.ts, which the onboarding branch
    // owns. The duplication is the price; this is the check on it.
    expect(SAMPLE_DATASET).toBe(PACK_SAMPLE_DATASET_ID)
    expect(REAL_DATASET).toBe(LAKE_DATASET)
    expect(SAMPLE_DATASET).not.toBe(REAL_DATASET)
  })

  it('probes the real dataset with the same prefix every panel query carries', () => {
    expect(REAL_DATA_PROBE_QUERY).toBe(q('| limit 1'))
  })
})

describe('retargetQuery', () => {
  it('moves a panel query onto the sample dataset', () => {
    expect(retargetQuery(q('| summarize c=count()'), SAMPLE_DATASET)).toBe(`${SAMPLE_SELECTOR} | summarize c=count()`)
  })

  it('leaves a query alone when the real dataset is the target', () => {
    const text = q('| summarize c=count()')
    expect(retargetQuery(text, REAL_DATASET)).toBe(text)
  })

  it('moves a Copilot brief, which names the dataset in prose as well as in KQL', () => {
    const brief = `Investigate a finding in the Cribl Lake dataset "${LAKE_DATASET}" over the last hour. Matching filter: ${REAL_SELECTOR} tls_version<3`
    const moved = retargetQuery(brief, SAMPLE_DATASET)
    expect(moved).toContain(`dataset "${SAMPLE_DATASET}"`)
    expect(moved).toContain(`${SAMPLE_SELECTOR} tls_version<3`)
    expect(moved).not.toContain(`"${LAKE_DATASET}"`)
  })

  it('does not touch a pipeline id that merely starts with the dataset name', () => {
    // Data Flow's cribl_metrics counters name Stream objects such as
    // cribl_lake:gigamon_ami_json. Those describe the real pipeline and are
    // not a dataset selector.
    const metrics = 'dataset="cribl_metrics" | where output=="cribl_lake:gigamon_ami_json" and id=="gigamon_ami"'
    expect(retargetQuery(metrics, SAMPLE_DATASET)).toBe(metrics)
  })

  it('does not touch another dataset whose name starts with this one', () => {
    const pq = 'dataset="gigamon_ami_pq" | limit 1'
    expect(retargetQuery(pq, SAMPLE_DATASET)).toBe(pq)
  })

  it('does not touch a stored-result read', () => {
    const vt = 'dataset="$vt_results" jobName="gno_overview_c1h"'
    expect(retargetQuery(vt, SAMPLE_DATASET)).toBe(vt)
  })

  it('is idempotent, so the ⓘ and the deep link it hands on can both apply it', () => {
    const once = retargetQuery(q('| limit 5'), SAMPLE_DATASET)
    expect(retargetQuery(once, SAMPLE_DATASET)).toBe(once)
  })

  it('moves every dataset selector in every string the app shows or runs', () => {
    // The frozen display snapshot is every KQL string, deep link and Copilot
    // brief the app puts in front of a customer. Each selector of the real
    // dataset has to come out naming the sample one, and none may survive.
    const frozen = JSON.parse(readFileSync(join(HERE, '__frozen__', 'display.json'), 'utf8')) as unknown
    const strings: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(frozen)
    const selecting = strings.filter((s) => s.includes(REAL_SELECTOR))
    // A sweep over nothing would pass. There are well over a hundred.
    expect(selecting.length).toBeGreaterThan(100)
    for (const s of selecting) {
      const moved = retargetQuery(s, SAMPLE_DATASET)
      const before = s.split(REAL_SELECTOR).length - 1
      expect(moved.includes(REAL_SELECTOR), s.slice(0, 120)).toBe(false)
      expect(moved.split(SAMPLE_SELECTOR).length - 1, s.slice(0, 120)).toBeGreaterThanOrEqual(before)
    }
  })
})
