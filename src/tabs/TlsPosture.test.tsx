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
import { accelEntry } from '../cribl/accel/manifest'
import { PQC_BY_SERVER, SERVERS } from '../queries/tlsPosture'
import { TlsPosture, TLS_PQC_CADENCE, TLS_SERVERS_CADENCE, TLS_WINDOW } from './TlsPosture'

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
    // from, and when. These defaults are an ordinary live answer; the stored-read
    // cases at the bottom override them (both searches are accelerated since
    // 2026-09-27).
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
    // The panel note is out of the display freeze now that it is conditional
    // (captions freeze only as literal text), so its wording is held here.
    expect(container.querySelector('.panel-note')?.textContent).toBe('3 of 3 shown · worst first')
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

// ── A STORED READ OF THE KEY-EXCHANGE RUN ───────────────────────────────────
// Since 2026-09-27 (`feat/accel-tls-pqc`) both searches read hourly scheduled
// runs in Snapshot mode. A stored read fails in ways a live one cannot — a run
// flagged stale rather than replaced, a picked moment with no run, a miss that
// falls back to the live query — and each of them hands the tab either old
// rows or none, both of which `?? 0` would read as "classical". These hold that
// none of them prints a quantum-unsafe count as if it were known.

describe('TLS Posture, with the key-exchange run read from its schedule', () => {
  const AT = Date.parse('2026-09-27T04:28:00Z')
  const fromRun = (over: Partial<UseSearchState> = {}) =>
    result({ source: 'schedule', outcome: 'fresh', at: AT, ...over })

  it('counts from a fresh run exactly as from a live answer', () => {
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: PQC_ROWS }))
    expect(kpi(KEX).value).toBe('2')
    expect(kexTags().sort()).toEqual(['PQC', 'classical', 'classical'])
  })

  it('prints no count from a STALE key-exchange run beside the server list', () => {
    // The stale run's rows are real, but every server that appeared since it
    // ran is absent from them — and absent reads as classical.
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: PQC_ROWS, outcome: 'stale', stale: true }))
    expect(kpi(KEX).value).toBe('—')
    expect(kpi(KEX).sub).toContain('out of date')
    expect(kpi(KEX).classes).not.toContain('kpi-warning')
    expect(kexTags()).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(container.textContent).toContain('Key exchange could not be read')
    expect(container.textContent).toContain('older than its schedule promises')
    expect(filterButton().getAttribute('aria-disabled')).toBe('true')
  })

  it('does not empty the filtered table into a false all-clear on a stale run', () => {
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: PQC_ROWS }))
    click(filterButton())
    expect(rows()).toHaveLength(2)
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: [], outcome: 'stale', stale: true }))
    expect(rows()).toHaveLength(3)
    expect(container.textContent).not.toContain('every server offered PQC key exchange')
  })

  it('prints no count for a picked moment the key-exchange entry has no run for', () => {
    // `source: 'none'`: no rows, no error, not loading — the very shape a
    // failure used to have, and a moment never falls back to live.
    show(fromRun({ rows: SERVER_ROWS }), result({ source: 'none', outcome: 'aged-out', nearestAt: AT - 3_600_000 }))
    expect(kpi(KEX).value).toBe('—')
    expect(kpi(KEX).sub).toContain('no key-exchange run')
    expect(kexTags()).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(container.textContent).toContain('No key-exchange run exists for the moment picked')
  })

  it('prints no count when the SERVER list has no run for the moment', () => {
    // Nothing to count over. 0 would be a confident all-clear.
    show(result({ source: 'none', outcome: 'aged-out' }), fromRun({ rows: PQC_ROWS }))
    expect(kpi(KEX).value).toBe('—')
    expect(kpi(KEX).classes).not.toContain('kpi-success')
  })

  it('waits, rather than counting, while a missed run falls back to the live query', () => {
    // A miss (no run yet, failed, aged out, paused, drifted) goes live: the
    // first-load gap the header already covers, now reached from a schedule.
    show(fromRun({ rows: SERVER_ROWS }), result({ loading: true, outcome: 'no-run', note: 'no run yet' }))
    expect(kpi(KEX).value).toBe('…')
    expect(kexTags()).toEqual(['checking', 'checking', 'checking'])
  })

  it('prints no count when the missed run’s live fallback fails too', () => {
    show(fromRun({ rows: SERVER_ROWS }), result({ outcome: 'run-failed', error: 'Cribl API 500 Internal Server Error' }))
    expect(kpi(KEX).value).toBe('—')
    expect(kpi(KEX).sub).toContain('search failed')
    expect(kexTags()).toEqual(['unreadable', 'unreadable', 'unreadable'])
  })

  it('counts once both searches have fallen back live, over the same range', () => {
    show(result({ rows: SERVER_ROWS, outcome: 'no-run', note: 'no run yet' }),
      result({ rows: PQC_ROWS, outcome: 'no-run', note: 'no run yet' }))
    expect(kpi(KEX).value).toBe('2')
  })
})

// ── THE TWO ANSWERS MUST DESCRIBE THE SAME WINDOW ───────────────────────────
// The join is by server name, so a server missing from the key-exchange answer
// reads as classical. That is only true when both answers cover the same
// fifteen minutes. A stored run from another hour, a stored run beside a live
// fallback over the picker's range, or a stale server list beside a fresh
// key-exchange run each join two windows — and every server seen only in the
// server list's window would be counted quantum-unsafe, with full confidence.

describe('TLS Posture, with the two answers from different windows', () => {
  const AT = Date.parse('2026-09-27T04:27:40Z')
  const fromRun = (over: Partial<UseSearchState> = {}) =>
    result({ source: 'schedule', outcome: 'fresh', at: AT, ...over })

  const expectNoKexClaim = () => {
    expect(kpi(KEX).value).toBe('—')
    expect(kpi(KEX).classes).not.toContain('kpi-warning')
    expect(kpi(KEX).classes).not.toContain('kpi-success')
    expect(kpi(KEX).sub).toContain('another window')
    expect(kexTags()).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(container.querySelector('.pill-kex')).toBeNull()
    expect(container.textContent).toContain('describe different windows')
    expect(filterButton().getAttribute('aria-disabled')).toBe('true')
  }

  it('prints no count from a fresh key-exchange run of the PREVIOUS hour', () => {
    // H:27–H:28: the server list's run is done, the key-exchange run is not, and
    // the newest key-exchange run is an hour old — under the stale threshold.
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: PQC_ROWS, at: AT - 59 * 60_000 }))
    expectNoKexClaim()
  })

  it('counts when the paired runs finished about a minute apart', () => {
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: PQC_ROWS, at: AT + 55_000 }))
    expect(kpi(KEX).value).toBe('2')
  })

  it('prints no count when the server list is a stored run and key exchange ran live', () => {
    show(fromRun({ rows: SERVER_ROWS }), result({ rows: PQC_ROWS, outcome: 'no-run', note: 'no run yet' }))
    expectNoKexClaim()
  })

  it('prints no count when the server list ran live and key exchange is a stored run', () => {
    show(result({ rows: SERVER_ROWS, outcome: 'run-failed', note: 'its run failed' }), fromRun({ rows: PQC_ROWS }))
    expectNoKexClaim()
  })

  it('prints no count from a STALE server list beside a fresh key-exchange run', () => {
    show(fromRun({ rows: SERVER_ROWS, outcome: 'stale', stale: true, at: AT - 5 * 3_600_000 }), fromRun({ rows: PQC_ROWS }))
    expectNoKexClaim()
  })

  it('does not empty the filtered table into a false all-clear', () => {
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: PQC_ROWS }))
    click(filterButton())
    expect(rows()).toHaveLength(2)
    show(fromRun({ rows: SERVER_ROWS }), fromRun({ rows: [], at: AT - 59 * 60_000 }))
    expect(rows()).toHaveLength(3)
    expect(container.textContent).not.toContain('every server offered PQC key exchange')
  })

  it('still waits, rather than calling it misaligned, while the fallback is running', () => {
    show(fromRun({ rows: SERVER_ROWS }), result({ loading: true, outcome: 'no-run', note: 'no run yet' }))
    expect(kpi(KEX).value).toBe('…')
    expect(kexTags()).toEqual(['checking', 'checking', 'checking'])
  })
})

// ── NO SERVER ANSWER: NO TILE ON THIS TAB MAY PRINT A COUNT ─────────────────

describe('TLS Posture, with no server-list answer', () => {
  const CERT_TILES = ['Distinct servers', 'At-risk certs / protocols', 'Weak protocol']

  it('prints no certificate or protocol count for a picked moment with no run', () => {
    show(result({ source: 'none', outcome: 'aged-out' }), result({ rows: PQC_ROWS, source: 'schedule', outcome: 'fresh', at: 1 }))
    for (const label of [...CERT_TILES, KEX]) {
      expect(kpi(label).value, label).toBe('—')
      expect(kpi(label).classes, label).not.toContain('kpi-success')
      expect(kpi(label).classes, label).not.toContain('kpi-warning')
      expect(kpi(label).classes, label).not.toContain('kpi-danger')
      expect(kpi(label).sub, label).not.toMatch(/[0-9]/)
    }
  })

  it('prints no count from rows that survived a failed server-list search', () => {
    show(result({ rows: SERVER_ROWS, error: 'Cribl API 500 Internal Server Error' }), result({ rows: PQC_ROWS }))
    for (const label of [...CERT_TILES, KEX]) {
      expect(kpi(label).value, label).toBe('—')
      expect(kpi(label).classes, label).not.toContain('kpi-success')
      expect(kpi(label).sub, label).not.toMatch(/[0-9]/)
    }
  })
})

describe('TLS Posture’s schedules, in the words its ⓘ uses', () => {
  it('quotes the crons and the window this app actually writes', () => {
    const servers = accelEntry('gno_tls_servers_c1h')
    const pqc = accelEntry('gno_tls_pqc_c1h')
    expect(servers.cron).toBe('27 * * * *')
    expect(TLS_SERVERS_CADENCE).toContain('27 minutes past')
    expect(pqc.cron).toBe('28 * * * *')
    expect(TLS_PQC_CADENCE).toContain('28 minutes past')
    for (const e of [servers, pqc]) expect([e.earliest, e.latest]).toEqual(['-18m', '-3m'])
    expect(TLS_WINDOW).toContain('fifteen minutes')
  })

  it('serves each query from its own entry', () => {
    expect(accelEntry('gno_tls_servers_c1h').body).toBe(SERVERS)
    expect(accelEntry('gno_tls_pqc_c1h').body).toBe(PQC_BY_SERVER)
  })
})
