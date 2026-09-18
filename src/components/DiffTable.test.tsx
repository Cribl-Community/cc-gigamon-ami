// What a customer can actually read off a before→after, measured on the DOM.
//
// The happy path — three keys, three rows — is the case that cannot go wrong
// unnoticed: it is the one every screenshot shows. So most of what is below is
// the other cases, which is where this component earns its existence:
//
//   * the EMPTY diff, which is a sentence and not an empty table, because a
//     no-op 30 → 30 retention Apply must say nothing changes;
//   * a key that only exists on one side, where a blank cell would leave
//     "absent" and "empty string" looking identical;
//   * a pair that is equal, which the caller is not allowed to have labelled
//     `changed` — the state is derived, so it cannot be;
//   * a value long enough to be worth clipping, which is not clipped.
//
// The full list of what could not be asserted in this environment, and why, is
// at the bottom of the file.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiffTable, type DiffRow } from './DiffTable'
// The classification, read directly rather than through rendered text — see
// diffRow.ts's header for why it is not in the component file.
import { diffState } from './diffRow'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (rows: DiffRow[], props: { caption?: string; emptyNote?: string } = {}) => {
  act(() => {
    root.render(<DiffTable caption={props.caption ?? 'Cribl Lake dataset gigamon_ami'} rows={rows} emptyNote={props.emptyNote} />)
  })
}

const table = () => container.querySelector('table')
const bodyRows = () => [...container.querySelectorAll('tbody tr')]
const cells = (i: number) => [...bodyRows()[i].querySelectorAll('th, td')].map((c) => c.textContent ?? '')

const RETENTION: DiffRow[] = [{ key: 'retentionPeriodInDays', before: '30', after: '7' }]

describe('DiffTable — the empty diff', () => {
  it('says nothing changes instead of drawing a table with no rows', () => {
    render([])
    // The state this component exists for. An empty <table> under a "Before and
    // after" heading is a dialog claiming a change it is not about to make, and
    // the 30 → 30 retention Apply is a deliberate probe that produces exactly
    // that diff.
    expect(table(), 'an empty diff drew an empty table').toBeNull()
    expect(container.textContent).toContain('Nothing changes')
  })

  it('still names the object nothing is happening to', () => {
    render([], { caption: 'Cribl Lake dataset gigamon_ami' })
    // "Nothing changes" on its own is unattributed in a dialog that may be
    // showing two other tables that DO change something.
    expect(container.textContent).toContain('Cribl Lake dataset gigamon_ami')
  })

  it('lets the caller say it in the terms of the field they just edited', () => {
    render([], { emptyNote: 'Retention is already 30 days.' })
    expect(container.textContent).toContain('Retention is already 30 days.')
    expect(container.textContent, 'the default fired as well as the caller’s note').not.toContain('Nothing changes')
  })
})

describe('DiffTable — the change is a word', () => {
  it('derives the state rather than taking it from the caller', () => {
    // There is no `state` prop, and this is why: a caller that computed a diff
    // from a live GET cannot mislabel a removal as an addition, because it does
    // not get to label anything.
    expect(diffState({ key: 'k', before: null, after: 'v' })).toBe('added')
    expect(diffState({ key: 'k', before: 'v', after: null })).toBe('removed')
    expect(diffState({ key: 'k', before: 'v', after: 'w' })).toBe('changed')
    expect(diffState({ key: 'k', before: 'v', after: 'v' })).toBe('unchanged')
    // Absent and null are the same claim — the key is not on that side — so a
    // caller building rows with an optional field gets the same answer as one
    // writing the null out.
    expect(diffState({ key: 'k', after: 'v' })).toBe('added')
    expect(diffState({ key: 'k', before: 'v' })).toBe('removed')
    // Two absences are not a change. This is the row a `!==` comparison would
    // have called `changed`.
    expect(diffState({ key: 'k' })).toBe('unchanged')
  })

  it('renders a pair that turned out equal as unchanged, not as changed', () => {
    render([{ key: 'format', before: 'json', after: 'json' }])
    // A caller computing a diff over a whole body can hand over a key that did
    // not move. Calling it `changed` would tell a customer something is about to
    // happen to a field nothing is about to happen to.
    // On the class, not on the text: "unchanged" contains "changed", so a
    // substring check here passes either way and proves nothing.
    expect(bodyRows()[0].querySelector('.kvd-unchanged')?.textContent).toContain('unchanged')
    expect(bodyRows()[0].querySelector('.kvd-changed'), 'an equal pair was reported as a change').toBeNull()
  })

  it('states every change in words, not in colour alone', () => {
    render([
      { key: 'retentionPeriodInDays', before: '30', after: '7' },
      { key: 'description', after: 'Gigamon AMI flow records' },
      { key: 'acceleratedFields', before: 'src_ip' },
    ])
    // SC 1.4.1. A green row and a red row are the same row to anyone who cannot
    // tell them apart, and this table is the last thing between a customer and a
    // PATCH on a dataset with no version history.
    expect(cells(0).join(' ')).toContain('changed')
    expect(cells(1).join(' ')).toContain('added')
    expect(cells(2).join(' ')).toContain('removed')
  })

  it('hides the glyph from assistive technology, because the word is already there', () => {
    render(RETENTION)
    const glyph = bodyRows()[0].querySelector('[aria-hidden="true"]')
    expect(glyph, 'the glyph is announced as well as the word it duplicates').toBeTruthy()
    expect(glyph!.textContent).toBe('→')
  })

  it('carries the state in a class so the ink can differ from the neighbouring cell', () => {
    render([{ key: 'k', before: 'a', after: 'b' }])
    // Named rather than implied: App.css colours `.kvd-changed`, and a rename
    // here with no rule there is markup rendering unstyled with nothing to say
    // so — the defect src/app/retiredClasses.test.ts exists to catch.
    expect(bodyRows()[0].querySelector('.kvd-state.kvd-changed')).toBeTruthy()
  })
})

describe('DiffTable — absent is not blank', () => {
  it('says "not set" where a key does not exist on that side', () => {
    render([{ key: 'description', after: 'Gigamon AMI flow records' }])
    const [, , before, after] = cells(0)
    // A blank cell here would be read as "this field is empty", which on a
    // destination body has a different consequence from "this field is absent".
    expect(before, 'the absent side rendered as nothing at all').toContain('not set')
    expect(after).toContain('Gigamon AMI flow records')
  })

  it('distinguishes an empty string from an absent key', () => {
    render([
      { key: 'absent', after: 'x' },
      { key: 'blank', before: '', after: 'x' },
    ])
    expect(cells(0)[2]).toContain('not set')
    expect(cells(1)[2], 'an empty string was reported as an absent key').toContain('empty')
    // …and it is still a change, not an addition: the key was there.
    expect(cells(1).join(' ')).toContain('changed')
  })
})

describe('DiffTable — the table itself', () => {
  it('is a real table with a caption and scoped headers', () => {
    render(RETENTION, { caption: 'Cribl Lake dataset gigamon_ami' })
    const t = table()!
    // `.dtable`'s contract, and §2.4 is explicit about it for this phase: a
    // <table>, not a div grid with visual alignment.
    expect(t.querySelector('caption')?.textContent).toBe('Cribl Lake dataset gigamon_ami')
    expect([...t.querySelectorAll('thead th')].map((h) => h.getAttribute('scope')))
      .toEqual(['col', 'col', 'col', 'col'])
    expect([...t.querySelectorAll('thead th')].map((h) => h.textContent))
      .toEqual(['Field', 'Change', 'Before', 'After'])
    const rowHeader = bodyRows()[0].querySelector('th')
    expect(rowHeader?.getAttribute('scope'), 'the field name is not the row header').toBe('row')
    expect(rowHeader?.textContent).toBe('retentionPeriodInDays')
  })

  it('shows the caption rather than hiding it', () => {
    render(RETENTION)
    // The one departure from `.dtable`'s `<caption class="sr-only">`, and it is
    // load-bearing: a three-object PATCH stacks three of these in one dialog,
    // and a sighted reader with no visible caption cannot tell which values
    // belong to which object either.
    expect(table()!.querySelector('caption')!.className).not.toContain('sr-only')
    expect(table()!.querySelector('caption')!.className).toContain('kvd-cap')
  })

  it('reuses the one data-table family instead of a second one', () => {
    render(RETENTION)
    expect(table()!.className).toContain('dtable')
  })

  it('keeps a long value whole, in a container that can scroll', () => {
    const long = 'a'.repeat(400)
    render([{ key: 'pathExpression', before: long, after: 'b'.repeat(400) }])
    // Clipped text in a confirmation is somebody approving a change they could
    // not read. `.dtable` sets `white-space: nowrap`; `.kvd-val` puts wrapping
    // back and `.kvd-wrap` scrolls whatever still will not fit.
    expect(cells(0)[2], 'the value was truncated before it reached the DOM').toContain(long)
    expect(container.querySelector('.kvd-wrap'), 'nothing can scroll, so an over-wide value clips').toBeTruthy()
    expect(bodyRows()[0].querySelectorAll('td.kvd-val').length).toBe(2)
  })

  it('renders a value as text, whatever it contains', () => {
    render([{ key: 'filter', before: '<b>x</b> && y', after: "source=='syslog'" }])
    expect(cells(0)[2]).toBe('<b>x</b> && y')
    expect(bodyRows()[0].querySelector('b'), 'a configuration value was parsed as markup').toBeNull()
  })

  it('draws one row per key, in the order the caller gave them', () => {
    render([
      { key: 'c', before: '1', after: '2' },
      { key: 'a', before: '1', after: '2' },
      { key: 'b', before: '1', after: '2' },
    ])
    // Not sorted: a diff computed from a body is in the order the module that
    // knows the object decided to walk it, and re-ordering it here would be this
    // component overruling that with an alphabet.
    expect(bodyRows().map((r) => r.querySelector('th')!.textContent)).toEqual(['c', 'a', 'b'])
  })
})

// ── WHAT THIS FILE DOES NOT ASSERT, AND WHY ──────────────────────────────────
//
//   * THAT A LONG VALUE ACTUALLY WRAPS, OR THAT THE CONTAINER SCROLLS. happy-dom
//     does no layout: every element is 0×0, `overflow-x: auto` scrolls nothing
//     and `overflow-wrap: anywhere` breaks nothing. What is asserted above is
//     that the full string reaches the DOM and that the two elements carrying
//     those rules are present. Preview check 7.7 (200 % zoom, ~400 px) is the
//     outcome.
//   * THAT THE THREE STATE INKS ARE LEGIBLE. Colour is not resolved here.
//     src/app/contrast.test.ts computes the ratios from the shipped token
//     values, in both themes — and note that these three pairings are measured
//     there under the ACTION PILL rows, because `.kvd-added` / `-removed` /
//     `-changed` paint the same three `color.foreground.*.default` on the same
//     modal surface. A failure will name the pill rule, not this table.
//   * THAT THE CAPTION IS ANNOUNCED AS THE TABLE'S NAME. That a `<caption>`
//     becomes the accessible name is a claim about NVDA, JAWS and VoiceOver;
//     no DOM assertion reaches it. Preview check 7.4 reads the tree.
//   * THAT THE COLUMNS LINE UP, or that four columns fit in a dialog at 400 px.
//     No layout, no paint.
