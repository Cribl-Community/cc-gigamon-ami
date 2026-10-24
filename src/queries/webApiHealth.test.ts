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

  it('ranks hosts by numeric HTTP RTT in milliseconds without a derived ingestion field', () => {
    expect(SLOW).toBe('dataset="gigamon_ami" http_rtt=* http_host=* | where isnotnull(toreal(http_rtt)) | summarize p95=percentile(toreal(http_rtt),95)*1000, n=count() by http_host | sort by p95 desc | limit 10')
    const body = accelEntry('gno_web_host_c1h').body
    expect(body).toContain('p95=percentile(toreal(http_rtt),95)*1000, srv_n=countif(isnotnull(toreal(http_rtt)))')
    expect(SLOW).not.toContain('tonumber(')
    expect(body).not.toContain('tonumber(')
    expect(body).not.toContain('http_server_ms')
  })

  it('filters HTTP/2 hosts by application and uses the same query for its schedule', () => {
    expect(H2).toBe('dataset="gigamon_ami" app_name="http2" http_host=* | summarize n=count() by http_host | sort by n desc | limit 10')
    const entry = accelEntry('gno_web_h2_c1h')
    expect(entry.body).toBe(H2)
    expect(entry.panels[0].display).toBe(H2)
  })
})
