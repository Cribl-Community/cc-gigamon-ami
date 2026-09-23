// The trace's one piece of logic that decides what a number MEANS: which
// request is an artifact read, which a job, which the run history. A
// misclassification would report the fast path as taken when it was not.
import { describe, expect, it } from 'vitest'
import { classify, markData, markStart, summary, tracing } from './devTrace'

describe('classify', () => {
  const J = '/capi/m/default_search/search/jobs'
  it.each([
    [`${J}?output=short&limit=405`, 'GET', 'history'],
    [J, 'POST', 'job-submit'],
    [`${J}/1790.abc/status`, 'GET', 'job-status'],
    [`${J}/1790.abc/results?limit=5000`, 'GET', 'job-results'],
    [`${J}/gno_app_src_c1h.1790159760164.QuCgzK/results?limit=20000`, 'GET', 'artifact'],
    [`${J}/1790.abc/cancel`, 'POST', 'job-cancel'],
    [`${J}/1790.abc/field-summaries`, 'GET', 'field-summaries'],
    ['/capi/a/app/kvstore/app/prefs/u1', 'GET', 'kv'],
  ])('%s %s -> %s', (url, method, kind) => {
    expect(classify(url, method)).toBe(kind)
  })
})

describe('off unless installed', () => {
  it('records nothing and reports nothing when the page was not opened with ?trace', () => {
    expect(tracing()).toBe(false)
    markStart('p')
    markData('p', 'schedule')
    expect(summary()).toBeNull()
  })
})
