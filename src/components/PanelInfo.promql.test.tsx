// The ⓘ's PromQL block — slice 6.8.
//
// A cookbook card's point is the expression itself, not a number on the page,
// so the block is ADDITIVE: `query` behaviour is untouched, nothing here is
// submitted anywhere, and a card that carries both is saying "here is the
// search this app ran, and here is the PromQL you would write against the
// metrics store".
//
// WHAT THIS FILE CANNOT ESTABLISH. happy-dom has no layout and no clipboard, so
// `cursor` is asserted through the CSS selector that carries it rather than by
// measuring a rendered element, and the Copy handlers are asserted to be
// independent rather than to have written anything. Neither is a claim that a
// customer's clipboard received the right bytes.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DashboardProvider } from '../app/DashboardContext'
import { PanelInfo } from './PanelInfo'

const KQL = 'dataset="gigamon_ami" | summarize flows=count()'
/**
 * THE EXPRESSION THAT DECIDED THE DESIGN. `|` is a pipeline separator in KQL and
 * alternation inside a PromQL label matcher, so running this through the KQL
 * pretty-printer would split one valid expression into two broken lines.
 */
const PROMQL = 'sum by (dst_service) (rate(gigamon_flows{l4=~"tcp|udp"}[5m]))'

let host: HTMLDivElement
let root: Root
let container: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  host.id = 'root'
  document.body.appendChild(host)
  root = createRoot(host)
  container = document.body
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function open(props: { promql?: string; promqlHref?: string; query?: string }) {
  act(() => {
    root.render(
      <DashboardProvider>
        <PanelInfo about="What this shows." query={props.query ?? KQL} promql={props.promql} promqlHref={props.promqlHref} />
      </DashboardProvider>,
    )
  })
  act(() => container.querySelector<HTMLButtonElement>('.pinfo-btn')!.click())
}

const blocks = () => [...container.querySelectorAll('.pinfo-h')].map((h) => h.textContent)
const codes = () => [...container.querySelectorAll('.pinfo-code')].map((c) => c.textContent)

describe('the PromQL block', () => {
  it('adds a second block UNDER the KQL, never instead of it', () => {
    // Order is load-bearing: three existing assertions elsewhere reach the KQL
    // block with querySelector, which takes the FIRST match. A PromQL block
    // above it would silently re-point all three at the wrong expression.
    open({ promql: PROMQL })
    expect(blocks()).toEqual(['What this shows', 'Cribl Search · KQL', 'Cribl Search · PromQL'])
    expect(codes()[0], 'the first code block must still be the KQL').toContain('dataset="gigamon_ami"')
  })

  it('grows no block on the ⓘ that pass no promql — which is all of them today', () => {
    open({})
    expect(blocks()).toEqual(['What this shows', 'Cribl Search · KQL'])
  })

  it('renders the expression VERBATIM, because pretty() would break it', () => {
    // The KQL block shows the pretty form and is asserted to elsewhere. This one
    // must not: `tcp|udp` is one label matcher, not two pipeline stages.
    open({ promql: PROMQL })
    expect(codes()[1]).toBe(PROMQL)
    expect(codes()[1], 'the alternation was split as if it were a KQL pipe').not.toContain('\n')
  })

  it('leaves the KQL block pretty-printed, so the two rules do not bleed', () => {
    open({ promql: PROMQL })
    expect(codes()[0]).toBe(KQL.replace(' | ', '\n| '))
  })
})

describe('the link, when there is somewhere to go', () => {
  it('links the expression and names the link something other than the expression', () => {
    open({ promql: PROMQL, promqlHref: 'https://example.invalid/metrics' })
    const link = [...container.querySelectorAll<HTMLAnchorElement>('.pinfo-code-link')].at(-1)!
    expect(link.getAttribute('href')).toBe('https://example.invalid/metrics')
    // Without this the accessible name is the whole expression read aloud.
    expect(link.getAttribute('aria-label')).toBe('Open this PromQL expression in Cribl')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('renders plain text with no link when there is nowhere to open it', () => {
    open({ promql: PROMQL })
    // One link only — the KQL block's. The PromQL block contributes none.
    expect(container.querySelectorAll('.pinfo-code-link')).toHaveLength(1)
  })

  it('never promises a click the block cannot honour', () => {
    // A hand cursor on un-linked text is an affordance making a false promise.
    // happy-dom computes no styles, so this reads the rule that carries it.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.css'), 'utf8')
    expect(css, 'cursor:pointer must hang off the LINK, not off .pinfo-code').toContain(
      '.pinfo-code-link .pinfo-code { cursor: pointer; }',
    )
  })
})

describe('the two Copy buttons', () => {
  it('are two, and are independent', () => {
    // One shared flag makes pressing either tick BOTH, which is a claim about
    // what is on the clipboard that would be wrong half the time.
    open({ promql: PROMQL })
    const copies = [...container.querySelectorAll<HTMLButtonElement>('.pinfo-copy')]
    expect(copies).toHaveLength(2)
    expect(copies.every((b) => b.textContent === 'Copy')).toBe(true)
  })
})
