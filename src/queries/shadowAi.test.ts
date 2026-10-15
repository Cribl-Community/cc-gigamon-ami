import { describe, expect, it } from 'vitest'
import { appsQuery, aiOverallQuery, aiUsersQuery, AI_FILTER } from './shadowAi'
import { AI_APPS } from '../data/aiApps'
import { APP_SRC_SNAPSHOT_QUERY } from './snapshots'
import { accelEntry } from '../cribl/accel/manifest'
import { evaluateTail } from '../cribl/accel/tail'

describe('Shadow AI apps byte totals', () => {
  it('derives total bytes before grouping apps, preserving sort and limit', () => {
    expect(appsQuery).toBe(
      'dataset="gigamon_ami" | extend total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0) | summarize flows=count(), bytes=sum(total_bytes), users=dcount(src_ip) by app_name | sort by flows desc | limit 90',
    )
  })

  it('calculates bytes for AI totals and users while preserving their filters and grouping', () => {
    const head = `dataset="gigamon_ami" | where ${AI_FILTER} | extend total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0)`
    expect(aiOverallQuery).toBe(`${head} | summarize users=dcount(src_ip), flows=count(), bytes=sum(total_bytes)`)
    expect(aiUsersQuery).toBe(`${head} | summarize aiflows=count(), aiapps=dcount(app_name), bytes=sum(total_bytes) by src_ip | sort by aiflows desc | limit 15`)
  })

  it('serves the same calculated bytes to all three snapshot reads', () => {
    const entry = accelEntry('gno_app_src_c1h')
    expect(entry.body).toBe(APP_SRC_SNAPSHOT_QUERY)
    expect(entry.body).toBe('dataset="gigamon_ami" | extend total_bytes = coalesce(src_bytes, 0) + coalesce(dst_bytes, 0) | summarize flows=count(), bytes=sum(total_bytes) by app_name, src_ip')
    const panel = entry.panels.find((p) => p.queryId === 'shadow-ai-apps')!
    expect(panel.display).toBe(appsQuery)
    const rows = [
      { app_name: AI_APPS[0], src_ip: '10.20.0.1', flows: 2, bytes: 30 },
      { app_name: AI_APPS[0], src_ip: '10.20.0.2', flows: 1, bytes: 20 },
    ]
    expect(evaluateTail(panel.tail!, rows, { complete: true })).toEqual([
      { app_name: AI_APPS[0], flows: 3, bytes: 50, users: 2 },
    ])
    const overall = entry.panels.find((p) => p.queryId === 'shadow-ai-overall')!
    const users = entry.panels.find((p) => p.queryId === 'shadow-ai-users')!
    expect(overall.display).toBe(aiOverallQuery)
    expect(users.display).toBe(aiUsersQuery)
    expect(evaluateTail(overall.tail!, rows, { complete: true })).toEqual([
      { users: 2, flows: 3, bytes: 50 },
    ])
    expect(evaluateTail(users.tail!, rows, { complete: true })).toEqual([
      { src_ip: '10.20.0.1', aiflows: 2, aiapps: 1, bytes: 30 },
      { src_ip: '10.20.0.2', aiflows: 1, aiapps: 1, bytes: 20 },
    ])
  })
})
