// What this tab says when only one of its two searches came back.
//
// The defect these assertions exist for is a silent one, which is why it
// survived a slice that was looking for it: with the PQC search failed, every
// number and tag on the tab still rendered, still looked computed, and was
// wrong in the reassuring direction — `pqcMap.get(name) ?? 0` reads a missing
// answer as "offered nothing post-quantum". Nothing threw, nothing spun, and
// the tab's QueryBoundary spoke only for the OTHER search. So the tests below
// are mostly about what is NOT on screen: no count, no "classical", no empty
// table under a sentence claiming every server is safe.
//
// The searches are replaced rather than faked at the network: what is under test
// is how this tab combines two `useSearch` results, and running the real hook
// would only add a fetch nobody is asserting anything about.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import type { Row } from '../cribl/search'
import type { UseSearchState } from '../cribl/useSearch'
import { PQC_BY_SERVER, SERVERS } from '../queries/tlsPosture'
import { TlsPosture } from './TlsPosture'

/** Keyed by query text, so the mock answers whichever search the tab runs. */
const answers = vi.hoisted(() => ({ byQuery: new Map<string, unknown>() }))

vi.mock('../cribl/useSearch', () => ({
  useSearch: (query: string) => {
    const answer = answers.byQuery.get(query)
    if (!answer) throw new Error(`the tab ran a query this test did not stub: ${query}`)
    return answer
  },
}))

function result(over: Partial<UseSearchState> = {}): UseSearchState {
  return {
    rows: [],
    totalEventCount: 0,
    loading: false,
    error: null,
    errorTitle: null,
    elapsedMs: null,
    refetch: () => {},
    // Phase 2 added the provenance half of a search result: where the rows came
    // from, and when. Neither of this tab's searches is accelerated, so these
    // are the values the hook returns for an ordinary live query.
    source: 'live',
    outcome: null,
    at: null,
    stale: false,
    note: null,
    ...over,
  }
}

/** Three servers, one of which offered a post-quantum group. */
const SERVER_ROWS: Row[] = [
  { ssl_server_name: 'a.example.com', flows: 30, ver: 'TLS_1_3', issuer: 'DigiCert Inc', notafter: '', cn: 'a.example.com' },
  { ssl_server_name: 'b.example.com', flows: 20, ver: 'TLS_1_3', issuer: 'DigiCert Inc', notafter: '', cn: 'b.example.com' },
  { ssl_server_name: 'c.example.com', flows: 10, ver: 'TLS_1_3', issuer: 'DigiCert Inc', notafter: '', cn: 'c.example.com' },
]
const PQC_ROWS: Row[] = [{ ssl_server_name: 'a.example.com', pqc: 7 }]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  answers.byQuery.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Render the tab with the two searches in the given states. */
function show(servers: UseSearchState, pqc: UseSearchState) {
  answers.byQuery.set(SERVERS, servers)
  answers.byQuery.set(PQC_BY_SERVER, pqc)
  act(() => {
    root.render(
      <DashboardProvider>
        <TlsPosture />
      </DashboardProvider>,
    )
  })
}

/** The KPI tile whose label starts with `label`, as a customer reads it. */
function kpi(label: string) {
  const tile = [...container.querySelectorAll<HTMLElement>('.kpi')]
    .find((el) => el.querySelector('.kpi-label')?.textContent?.includes(label))
  if (!tile) throw new Error(`no KPI tile labelled "${label}"`)
  return {
    value: tile.querySelector('.kpi-value')?.textContent?.trim() ?? '',
    sub: tile.querySelector('.kpi-sub')?.textContent?.trim() ?? '',
    classes: tile.className,
  }
}

const KEX = 'Classical KEX'
const rows = () => [...container.querySelectorAll<HTMLElement>('.resolver-row-tls')]
const kexTags = () => rows().map((r) => r.querySelector('.pill-kex')?.textContent?.trim() ?? r.querySelector('[data-appearance]')?.textContent?.trim() ?? '')
const filterButton = () => [...container.querySelectorAll('button')]
  .find((b) => b.textContent?.includes('Quantum-unsafe KEX only'))!
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

describe('TLS Posture, with both searches answering', () => {
  it('counts the servers that offered no post-quantum group', () => {
    show(result({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS }))
    expect(kpi(KEX).value).toBe('2')
    expect(kpi(KEX).sub).toBe('no hybrid ML-KEM offered')
    expect(kexTags().sort()).toEqual(['PQC', 'classical', 'classical'])
  })

  it('filters the table to the quantum-unsafe servers on request', () => {
    show(result({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS }))
    expect(rows()).toHaveLength(3)
    click(filterButton())
    expect(rows()).toHaveLength(2)
  })
})

describe('TLS Posture, with the key-exchange search failed', () => {
  const failed = () => result({ error: 'Cribl API 500 Internal Server Error' })

  it('prints no count at all, rather than a count of everything', () => {
    // The defect, stated as the assertion: 3 was the old answer — every server
    // read as classical because none of them was in a result that never came.
    show(result({ rows: SERVER_ROWS }), failed())
    expect(kpi(KEX).value).not.toBe('3')
    expect(kpi(KEX).value).toBe('—')
  })

  it('says in the tile why there is no number', () => {
    show(result({ rows: SERVER_ROWS }), failed())
    expect(kpi(KEX).sub).toContain('search failed')
  })

  it('drops the tile\'s colour claim, because it is not making one', () => {
    // warning vs success is a judgement about a count. With no count there is no
    // judgement, and a green or amber rule over an em dash would still read as one.
    show(result({ rows: SERVER_ROWS }), failed())
    expect(kpi(KEX).classes).not.toContain('kpi-warning')
    expect(kpi(KEX).classes).not.toContain('kpi-success')
  })

  it('surfaces the failure on the tab, with the reason Cribl gave', () => {
    show(result({ rows: SERVER_ROWS }), failed())
    const text = container.textContent ?? ''
    expect(text).toContain('Key exchange could not be read')
    expect(text).toContain('Cribl API 500 Internal Server Error')
  })

  it('names a known cause when there is one', () => {
    show(result({ rows: SERVER_ROWS }), result({ error: 'ran past 60s', errorTitle: 'Search stopped' }))
    expect(container.textContent).toContain('Search stopped')
  })

  it('offers a retry that re-runs only the search that failed', () => {
    const refetch = vi.fn()
    show(result({ rows: SERVER_ROWS }), result({ error: 'boom', refetch }))
    const again = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try again')!
    expect(again).toBeTruthy()
    click(again)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('calls no row classical', () => {
    show(result({ rows: SERVER_ROWS }), failed())
    expect(kexTags()).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(container.querySelector('.pill-kex')).toBeNull()
  })

  it('does not apply the filter, so the table cannot empty into a false all-clear', () => {
    // The worst outcome available here: filtering on nothing leaves zero rows,
    // and the message under an empty filtered table reads "every server offered
    // PQC key exchange".
    show(result({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS }))
    click(filterButton())
    expect(rows()).toHaveLength(2)

    show(result({ rows: SERVER_ROWS }), failed())
    expect(rows()).toHaveLength(3)
    expect(container.textContent).not.toContain('every server offered PQC key exchange')
  })

  it('leaves the filter reachable and says why it will not fire', () => {
    // aria-disabled, never disabled: see GatedControl.tsx. A `disabled` button
    // leaves the keyboard order and announces nothing, so the explanation above
    // it would exist only for people who can see it.
    show(result({ rows: SERVER_ROWS }), failed())
    const button = filterButton()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    const described = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(described?.textContent).toContain('the filter is unavailable')
  })

  it('prefers no answer to the last one, when rows survive the failure', () => {
    // `useSearch` keeps the previous rows on a failure, and a range change is
    // one of the things that re-runs the query — so the surviving rows may be
    // measured over a window that is no longer the one on screen.
    show(result({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS, error: 'Cribl API 429 Too Many Requests' }))
    expect(kpi(KEX).value).toBe('—')
    expect(kexTags()).toEqual(['unreadable', 'unreadable', 'unreadable'])
  })

  it('leaves the certificate and protocol tiles alone', () => {
    // The point of not binding this panel's QueryBoundary to both searches: the
    // cert data is good, and blanking it would be its own false statement.
    show(result({ rows: SERVER_ROWS }), failed())
    expect(kpi('Distinct servers').value).toBe('3')
    expect(kpi('Weak protocol').value).toBe('0')
  })

  it('applies the kept filter again once the search recovers', () => {
    show(result({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS }))
    click(filterButton())
    show(result({ rows: SERVER_ROWS }), failed())
    expect(rows()).toHaveLength(3)
    show(result({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS }))
    expect(rows()).toHaveLength(2)
  })
})

describe('TLS Posture, with the key-exchange search still running', () => {
  // The same gap without a failure: SERVERS back, PQC_BY_SERVER not yet. An
  // empty pqcMap reads as "offered nothing post-quantum" exactly the way a
  // failed one does, so the rows have to say so — and say something different
  // from what they say about a failure, because nothing is wrong yet.
  const pending = () => result({ loading: true })

  it('calls no row classical before the answer arrives', () => {
    show(result({ rows: SERVER_ROWS }), pending())
    expect(kexTags()).toEqual(['checking', 'checking', 'checking'])
    expect(container.querySelector('.pill-kex')).toBeNull()
  })

  it('does not report a failure that has not happened', () => {
    show(result({ rows: SERVER_ROWS }), pending())
    expect(container.textContent).not.toContain('Key exchange could not be read')
    expect(kexTags()).not.toContain('unreadable')
    expect(kpi(KEX).value).toBe('…')
  })

  it('keeps the last answer on a re-run instead of blanking every row', () => {
    // A range change re-runs both queries and `useSearch` keeps the previous
    // rows, so this is a refresh, not a first load. Flickering sixty rows to
    // `checking` on every range change would be its own kind of noise.
    show(result({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS, loading: true }))
    expect(kexTags().sort()).toEqual(['PQC', 'classical', 'classical'])
  })
})
