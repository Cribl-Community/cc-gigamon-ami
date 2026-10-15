import { describe, expect, it } from 'vitest'
import { H2, KPI, SLOW } from './webApiHealth'
import { OVERVIEW_SNAPSHOT_QUERY } from './snapshots'
import { PARITY_WEB_KPI_QUERY } from './lakeLanding'
import { accelEntry } from '../cribl/accel/manifest'

describe('Web KPI server timing', () => {
  const aggregates = 'txns=count(http_code), errors=sum(iif(http_code>=400,1,0)), server_p95_ms=percentile(http_rtt,95)*1000, hosts=dcount(http_host), h2=sum(iif(app_name=="http2",1,0))'

  it('runs the requested KPI query including the millisecond conversion and HTTP/2 count', () => {
    expect(KPI).toBe(`dataset="gigamon_ami" | summarize ${aggregates}`)
    expect(PARITY_WEB_KPI_QUERY).toBe(KPI)
  })

  it('uses the same calculation and output alias in the snapshot', () => {
    expect(OVERVIEW_SNAPSHOT_QUERY).toContain(aggregates)
    const entry = accelEntry('gno_overview_c1h')
    const panel = entry.panels.find((p) => p.display === KPI)
    expect(entry.body).toBe(OVERVIEW_SNAPSHOT_QUERY)
    expect(panel?.tail).toContain('server_p95_ms')
    expect(panel?.reads).toContain('server_p95_ms')
  })

  it('leaves the separate slowest-hosts query unchanged', () => {
    expect(SLOW).toBe('dataset="gigamon_ami" http_server_ms=* http_host=* | summarize p95=percentile(http_server_ms,95), n=count() by http_host | sort by p95 desc | limit 10')
  })

  it('filters HTTP/2 hosts by application and uses the same query for its schedule', () => {
    expect(H2).toBe('dataset="gigamon_ami" app_name="http2" http2_host=* | summarize n=count() by http2_host | sort by n desc | limit 10')
    const entry = accelEntry('gno_web_h2_c1h')
    expect(entry.body).toBe(H2)
    expect(entry.panels[0].display).toBe(H2)
  })
})
