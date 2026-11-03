// Which Raw HTTP source Guided Setup's Onboard connected to Cribl Lake, and
// through which pipeline — for the Data Flow tab, which names and counts them.
//
// READ, NEVER STORED: the onboarded source is the one in the viewer's Guided
// Setup worker group that carries the QuickConnect connection `gigamon` →
// `gigamon_lake` (globalHttp.ts `readGlobalHttp`, `isConnected`), so a source
// connected or disconnected in Cribl Stream is reflected on the next visit.
// GETs only, on mount, group change and Refresh; nothing writes.
// A failed read is reported explicitly, never replaced with the demo feed.

import { useCallback, useEffect, useState } from 'react'
import { useSetupGroup } from './useSetupGroup'
import { LAKE_CONNECTION, readGlobalHttp } from '../cribl/globalHttp'

export interface OnboardedFlow {
  group: string
  /** The Raw HTTP source's id, as Cribl names it. */
  sourceId: string
  /** The pipeline its connection runs. */
  pipeline: string
  destination: string
}

/** How long the tab waits for the read before it goes on without it. */
export const ONBOARDED_FLOW_DEADLINE_MS = 4000

/** Uses the same reader and selection rule as Onboard. */
export function useOnboardedFlow(refreshNonce: number) {
  const { group, groupReady } = useSetupGroup()
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{
    group: string; refreshNonce: number; retry: number; flow: OnboardedFlow | null; error: string | null
  } | null>(null)
  const refresh = useCallback(() => setRetry((n) => n + 1), [])
  useEffect(() => {
    if (!groupReady) return
    let live = true
    let settled = false
    const settle = (flow: OnboardedFlow | null, error: string | null) => {
      if (!live || settled) return
      settled = true
      setResult({ group, refreshNonce, retry, flow, error })
    }
    const timer = setTimeout(() => settle(null, `Could not read the onboarded connection in ${group}: the request timed out.`), ONBOARDED_FLOW_DEADLINE_MS)
    readGlobalHttp(group)
      .then((st) => {
        if (st.sources === null) {
          settle(null, `Could not read the Raw HTTP sources in ${group}. Re-check your access and refresh.`)
        } else if (st.sourceId) {
          settle({ group, sourceId: st.sourceId, pipeline: LAKE_CONNECTION.pipeline, destination: LAKE_CONNECTION.output }, null)
        } else {
          settle(null, null)
        }
      })
      .catch(() => settle(null, `Could not read the onboarded connection in ${group}. Refresh to try again.`))
      .finally(() => clearTimeout(timer))
    return () => { live = false; clearTimeout(timer) }
  }, [group, groupReady, refreshNonce, retry])
  const current = groupReady && result?.group === group && result.refreshNonce === refreshNonce && result.retry === retry
  return { group, flow: current ? result.flow : null, loading: !current, error: current ? result.error : null, refresh }
}
