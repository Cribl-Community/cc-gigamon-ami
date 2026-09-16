// Where a frozen query goes when a customer clicks it.
//
// display.json freezes the string handed to searchUiUrl(); this pins what
// searchUiUrl() then builds out of it. The parameters are a contract with the
// Cribl Search UI — `q` is the query, `et`/`lt` are the window it runs over —
// and dropping or renaming one opens Search on a different question with every
// frozen string unchanged.

import { describe, expect, it } from 'vitest'
import { criblInvestigateUrl, criblUiUrl, LAKE_DATASET, searchUiUrl, searchUrl, SEARCH_GROUP } from './config'

const QUERY = 'dataset="gigamon_ami" app_name="dns" | limit 5'

describe('searchUiUrl', () => {
  it('carries the query and the window the panel was showing', () => {
    const url = new URL(searchUiUrl(QUERY, '-24h'), 'https://cribl.example')
    expect(url.searchParams.get('q'), 'the deep link would open Search on a different query').toBe(QUERY)
    expect([url.searchParams.get('et'), url.searchParams.get('lt'), url.searchParams.get('tz')])
      .toEqual(['-24h', 'now', 'local'])
  })

  it('takes an explicit latest when one is given', () => {
    const url = new URL(searchUiUrl(QUERY, '-1h', '-30m'), 'https://cribl.example')
    expect([url.searchParams.get('et'), url.searchParams.get('lt')]).toEqual(['-1h', '-30m'])
  })

  it('addresses Search root-relative, under a placeholder job id', () => {
    // Cribl reads `q` only when a job path segment is present, and reassigns a
    // real id on arrival. Installed, root-relative resolves to the Leader host.
    const href = searchUiUrl(QUERY, '-15m')
    expect(href.startsWith('/search/link-'), `expected /search/link-…, got ${href}`).toBe(true)
  })

  it('mints a fresh job id per link, so two panels do not collide', () => {
    const a = new URL(searchUiUrl(QUERY, '-15m'), 'https://cribl.example').pathname
    const b = new URL(searchUiUrl(QUERY, '-15m'), 'https://cribl.example').pathname
    expect(a).not.toBe(b)
  })
})

describe('criblInvestigateUrl', () => {
  it('hands the whole brief to the Copilot agent as one submitted prompt', () => {
    // The 17 briefs in display.json are frozen as text; this is the only step
    // between that text and the agent.
    const brief = 'Investigate a "TLS interception" finding in dataset="gigamon_ami" & report back.'
    const url = new URL(criblInvestigateUrl(brief), 'https://cribl.example')
    expect(url.pathname).toBe('/search/agent')
    expect(url.searchParams.get('q')).toBe(brief)
  })
})

describe('Cribl addressing', () => {
  it('runs every search in the dedicated search group', () => {
    expect(SEARCH_GROUP).toBe('default_search')
    // Dev (no window.CRIBL_API_URL): API_BASE is the Vite proxy prefix.
    expect(searchUrl('/search/jobs')).toBe('/capi/m/default_search/search/jobs')
  })

  it('names one Lake dataset, which every q() query quotes', () => {
    expect(LAKE_DATASET).toBe('gigamon_ami')
  })

  it('leaves a Cribl UI path root-relative when no dev origin is injected', () => {
    expect(criblUiUrl('/lake/datasets')).toBe('/lake/datasets')
  })
})
