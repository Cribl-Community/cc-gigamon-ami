// What PQC readiness says when its server answer is not a fact.
//
// Since 2026-09-27 (`feat/accel-tls-pqc`) both of this tab's searches read
// hourly scheduled runs in Snapshot mode (`gno_pqc_servers_c1h`,
// `gno_pqc_groups_c1h`). A server's PQC count and its session count arrive on
// one row here, so no join can call a missing answer "classical" — the defect
// TlsPosture.test.tsx exists for. What can still happen is four tiles summed
// over NO servers: a failed search, or a picked moment the entry has no run
// for, each of which would print a readiness score of 0 and a harvest-now
// exposure of 0 as if they had been measured.
//
// The searches are replaced rather than faked at the network, as in
// TlsPosture.test.tsx: what is under test is how the tab reads two results.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardProvider } from '../app/DashboardContext'
import { accelEntry } from '../cribl/accel/manifest'
import type { Row } from '../cribl/search'
import type { UseSearchState } from '../cribl/useSearch'
import { GROUPS_Q, SERVERS_Q } from '../queries/pqcReadiness'
import { PqcReadiness, PQC_GROUPS_CADENCE, PQC_SERVERS_CADENCE, PQC_WINDOW } from './PqcReadiness'

const answers = vi.hoisted(() => ({ byQuery: new Map<string, unknown>(), opts: new Map<string, unknown>() }))

vi.mock('../cribl/useSearch', () => ({
  useSearch: (query: string, opts: unknown) => {
    const answer = answers.byQuery.get(query)
    if (!answer) throw new Error(`the tab ran a query this test did not stub: ${query}`)
    answers.opts.set(query, opts)
    return answer
  },
}))

const AT = Date.parse('2026-09-27T04:57:00Z')

function result(over: Partial<UseSearchState> = {}): UseSearchState {
  return {
    rows: [],
    totalEventCount: 0,
    loading: false,
    error: null,
    errorTitle: null,
    elapsedMs: null,
    refetch: () => {},
    source: 'schedule',
    outcome: 'fresh',
    at: AT,
    stale: false,
    note: null,
    ...over,
  }
}

/** Two servers, one sensitive and classical-only. */
const SERVER_ROWS: Row[] = [
  { ssl_server_name: 'login.example.com', ssl_issuer: 'DigiCert Inc', sessions: 40, tls13: 30, pqc: 0 },
  { ssl_server_name: 'www.example.com', ssl_issuer: 'DigiCert Inc', sessions: 20, tls13: 20, pqc: 10 },
]
const GROUP_ROWS: Row[] = [{ ssl_ext_ec_supported_groups_type: '29', sessions: 50, servers: 2 }]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  answers.byQuery.clear()
  answers.opts.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function show(servers: UseSearchState, groups: UseSearchState = result({ rows: GROUP_ROWS })) {
  answers.byQuery.set(SERVERS_Q, servers)
  answers.byQuery.set(GROUPS_Q, groups)
  act(() => {
    root.render(
      <DashboardProvider>
        <PqcReadiness />
      </DashboardProvider>,
    )
  })
}

function kpi(label: string) {
  const tile = [...container.querySelectorAll<HTMLElement>('.kpi')]
    .find((el) => el.querySelector('.kpi-label')?.textContent?.includes(label))
  if (!tile) throw new Error(`no KPI tile labelled "${label}"`)
  return {
    value: tile.querySelector('.kpi-value')?.textContent?.trim() ?? '',
    classes: tile.className,
  }
}

const TILES = ['PQC readiness score', 'TLS 1.3 adoption', 'PQC key exchange offered', 'Harvest-now exposure']

describe('PQC readiness, served from its schedules', () => {
  it('names each query’s own schedule and panel', () => {
    show(result({ rows: SERVER_ROWS }))
    expect(answers.opts.get(SERVERS_Q)).toMatchObject({ accel: 'gno_pqc_servers_c1h', accelPanel: 'pqc-servers' })
    expect(answers.opts.get(GROUPS_Q)).toMatchObject({ accel: 'gno_pqc_groups_c1h', accelPanel: 'pqc-groups' })
  })

  it('computes the tiles from a fresh run', () => {
    show(result({ rows: SERVER_ROWS }))
    expect(kpi('Harvest-now exposure').value).toBe('40')
    for (const t of TILES) expect(kpi(t).value, t).not.toBe('—')
  })

  it('shows a stale run as the dated answer it is — one row carries both counts, so nothing is joined', () => {
    show(result({ rows: SERVER_ROWS, outcome: 'stale', stale: true }))
    expect(kpi('Harvest-now exposure').value).toBe('40')
  })

  it('prints no tile for a picked moment the entry has no run for', () => {
    // No rows, no error, not loading: summed over nothing, every tile would be
    // a confident 0 — a readiness score of 0, a harvest-now exposure of 0.
    show(result({ source: 'none', outcome: 'aged-out', at: null, nearestAt: AT - 3_600_000 }))
    for (const t of TILES) expect(kpi(t).value, t).toBe('—')
    expect(kpi('Harvest-now exposure').classes).not.toContain('kpi-danger')
  })

  it('prints no tile when the search failed, whatever rows survive it', () => {
    show(result({ rows: SERVER_ROWS, source: 'live', outcome: 'run-failed', at: null, error: 'Cribl API 500 Internal Server Error' }))
    for (const t of TILES) expect(kpi(t).value, t).toBe('—')
  })

  it('waits while a missed run falls back to the live query', () => {
    show(result({ source: 'live', outcome: 'no-run', at: null, loading: true }))
    // The score tile keeps its "/100" unit while it waits, as it always has.
    for (const t of TILES) expect(kpi(t).value.startsWith('…'), t).toBe(true)
  })
})

describe('PQC readiness’s schedules, in the words its ⓘ uses', () => {
  it('quotes the crons and the window this app actually writes', () => {
    const servers = accelEntry('gno_pqc_servers_c1h')
    const groups = accelEntry('gno_pqc_groups_c1h')
    expect(servers.cron).toBe('57 * * * *')
    expect(PQC_SERVERS_CADENCE).toContain('57 minutes past')
    expect(groups.cron).toBe('58 * * * *')
    expect(PQC_GROUPS_CADENCE).toContain('58 minutes past')
    for (const e of [servers, groups]) expect([e.earliest, e.latest]).toEqual(['-18m', '-3m'])
    expect(PQC_WINDOW).toContain('fifteen minutes')
    expect(servers.body).toBe(SERVERS_Q)
    expect(groups.body).toBe(GROUPS_Q)
  })
})
