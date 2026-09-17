// The last stretch of the promise: what the ⓘ actually PUTS ON SCREEN.
//
// display.json freezes the query string each surface points at. This freezes
// what happens to that string on the way to the customer's eyes. PanelInfo runs
// every query through pretty() before rendering it, before the Copy button
// writes it, and before "Open in Search" links it — so one line changed in this
// component rewrites what all 61 ⓘ popovers show while display.json stays
// byte-identical. Phase 1 rewrites this exact component.
//
// The transformation is documented, singular and deliberate: one pipeline clause
// per line, nothing else. So the expected text below is written out in full
// rather than computed with the same regex the component uses — a test that
// reimplements the code it checks agrees with the bug.
//
// Both halves of the popover are checked, because display.json freezes both and
// only one of them used to be verified here: the QUERY (the code block, the copy
// payload, and the `q` the deep link carries) and the PROSE (the `info=` words,
// which reach the screen through the same component and could stop rendering
// with every frozen string still byte-identical). The deep link's TIME BOUND is
// asserted too — `et` is half of what a query means, and nothing checked it.
//
// What this file does NOT establish: that the query handed to PanelInfo is the
// one that produced the number beside it. See the header of
// src/queries/display-freeze.test.ts — that is a human review question.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { PanelInfo } from './PanelInfo'

// A query with every shape the pretty-printer touches: a leading filter with no
// pipe, three pipeline clauses, and a trailing `| limit` — the clause a "tidy
// up" is most likely to drop.
const QUERY =
  'dataset="gigamon_ami" app_name="dns" dns_host=* | summarize p50=percentile(dns_response_time,50), total=count() by dns_host | sort by total desc | limit 500'

const AS_SHOWN = [
  'dataset="gigamon_ami" app_name="dns" dns_host=*',
  '| summarize p50=percentile(dns_response_time,50), total=count() by dns_host',
  '| sort by total desc',
  '| limit 500',
].join('\n')

let container: HTMLDivElement
let root: Root
let copied: string | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  copied = null
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { copied = t; return Promise.resolve() } },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const ABOUT = 'Per-resolver p50 latency.'
/** DashboardProvider's own default range — what a customer's first click carries. */
const DEFAULT_EARLIEST = '-15m'

/** Render one ⓘ and open its popover, the way a customer does. */
function openPopover(query: string) {
  act(() => {
    root.render(
      <DashboardProvider>
        <PanelInfo about={ABOUT} query={query} />
      </DashboardProvider>,
    )
  })
  const btn = container.querySelector<HTMLButtonElement>('.pinfo-btn')
  expect(btn, 'PanelInfo rendered no ⓘ button').not.toBeNull()
  act(() => btn!.click())
}

describe('PanelInfo', () => {
  it('shows the query under its one documented transformation, clause per line', () => {
    openPopover(QUERY)
    const code = container.querySelector('.pinfo-code')
    expect(code, 'the popover rendered no query block').not.toBeNull()
    expect(
      code!.textContent,
      'The ⓘ is showing the customer something other than the frozen query, one clause per line. ' +
        'display.json cannot see this: it freezes the query going in, not what this component renders.',
    ).toBe(AS_SHOWN)
  })

  it('copies exactly what it displays', async () => {
    openPopover(QUERY)
    const copy = container.querySelector<HTMLButtonElement>('.pinfo-copy')
    expect(copy, 'the popover rendered no Copy button').not.toBeNull()
    await act(async () => { copy!.click() })
    expect(copied, 'Copy wrote something other than the query on screen.').toBe(AS_SHOWN)
  })

  it('still shows the words as well as the query', () => {
    // display.json freezes the `info=` prose of every surface, and this is the
    // one component that renders it. One deleted line here and 77 popovers stop
    // explaining anything while the snapshot stays byte-identical — the prose
    // half of the promise was never checked on the screen until now.
    openPopover(QUERY)
    expect(
      container.querySelector('.pinfo-about')?.textContent,
      'The ⓘ rendered its query but not the words that say what the number means.',
    ).toBe(ABOUT)
  })

  it('links to Cribl Search with the query unmodified, over the range on screen', () => {
    // The deep link must carry the query Cribl Search will actually run, which
    // is the one-line original — not the display form. And the TIME BOUND is
    // half of what the query means: the same KQL over -15m and over -24h are two
    // different claims, so `et` is pinned here too.
    openPopover(QUERY)
    const link = container.querySelector<HTMLAnchorElement>('.pinfo-code-link')
    expect(link, 'the query block is not a link into Cribl Search').not.toBeNull()
    const url = new URL(link!.getAttribute('href')!, 'https://cribl.example')
    expect(url.searchParams.get('q'), 'The "Open in Search" link carries a different query from the one on screen.').toBe(QUERY)
    expect(
      [url.searchParams.get('et'), url.searchParams.get('lt')],
      'The "Open in Search" link opens over a different window from the dashboard, so it answers a different question.',
    ).toEqual([DEFAULT_EARLIEST, 'now'])
  })

  it('renders no query block at all when a panel has only prose', () => {
    // An ⓘ with no query must not invent one — several diagram nodes and the
    // "not observable in this feed" panel carry explanation only.
    act(() => {
      root.render(
        <DashboardProvider>
          <PanelInfo about="Techniques this feed has no signal for." />
        </DashboardProvider>,
      )
    })
    act(() => container.querySelector<HTMLButtonElement>('.pinfo-btn')!.click())
    expect(container.querySelector('.pinfo-about')?.textContent).toBe('Techniques this feed has no signal for.')
    expect(container.querySelector('.pinfo-code'), 'a query block appeared for an ⓘ with no query').toBeNull()
  })
})
