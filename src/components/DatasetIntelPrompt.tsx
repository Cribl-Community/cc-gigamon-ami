import { useEffect, useRef, useState } from 'react'
import { LAKE_DATASET } from '../cribl/config'
import { aiEnabled, generateDatasetIntel, getDatasetIntel, type IntelStatus } from '../cribl/datasetIntel'

const DISMISS_KEY = 'gigamon-npm-intel-dismissed'

/**
 * Offers to generate Cribl dataset intelligence when it's absent, so the
 * "AI investigate" action lands on a grounded agent instead of one that has to
 * rediscover a 319-field schema first.
 *
 * Deliberately quiet: it renders nothing unless the tenant has AI enabled AND
 * intelligence is genuinely missing or failed. Once generated (or dismissed) it
 * never comes back.
 */
export function DatasetIntelPrompt() {
  const [status, setStatus] = useState<IntelStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  const poll = useRef<number | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    let cancelled = false
    void (async () => {
      if (!(await aiEnabled(ctrl.signal))) return
      if (cancelled) return
      try {
        const intel = await getDatasetIntel(ctrl.signal)
        if (!cancelled) setStatus(intel.status)
      } catch {
        /* not fatal — the prompt simply stays hidden */
      }
    })()
    return () => { cancelled = true; ctrl.abort(); if (poll.current) window.clearInterval(poll.current) }
  }, [])

  // While generating, poll until the agent settles.
  useEffect(() => {
    if (status !== 'processing') return
    poll.current = window.setInterval(() => {
      void getDatasetIntel().then((i) => {
        setStatus(i.status)
        if (i.status !== 'processing' && poll.current) window.clearInterval(poll.current)
      }).catch(() => {})
    }, 15000)
    return () => { if (poll.current) window.clearInterval(poll.current) }
  }, [status])

  const start = async () => {
    setBusy(true); setError(null)
    try {
      await generateDatasetIntel()
      setStatus('processing')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const dismiss = () => {
    setDismissed(true)
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* non-fatal */ }
  }

  if (dismissed || status === null) return null
  if (status === 'complete' || status === 'partial' || status === 'unknown') return null

  if (status === 'processing') {
    return (
      <div className="intel-note intel-working" role="status">
        <span className="spinner spinner-sm" aria-hidden />
        <span>
          <strong>Generating dataset intelligence for <code>{LAKE_DATASET}</code>…</strong> This takes a few
          minutes. AI investigations started before it finishes still work — they just spend a step discovering
          the schema themselves.
        </span>
      </div>
    )
  }

  return (
    <div className="intel-note" role="note">
      <span>
        <strong>AI investigations aren’t grounded yet.</strong> Cribl has no dataset intelligence for{' '}
        <code>{LAKE_DATASET}</code>, so Copilot rediscovers this 319-field schema on every investigation before it
        can start. Generating it once makes every <strong>✦ AI investigate</strong> faster and better grounded.
        {error && <span className="intel-err"> — {error}</span>}
      </span>
      <span className="intel-actions">
        <button type="button" className="tour-btn tour-btn-primary" onClick={() => void start()} disabled={busy}>
          {busy ? 'Starting…' : 'Generate'}
        </button>
        <button type="button" className="tour-btn" onClick={dismiss}>Dismiss</button>
      </span>
    </div>
  )
}
