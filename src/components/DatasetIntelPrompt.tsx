import { useEffect, useRef, useState } from 'react'
import { useWriteGate } from '../cribl/authz'
import { LAKE_DATASET } from '../cribl/config'
import { aiEnabled, generateDatasetIntel, getDatasetIntel, type IntelStatus } from '../cribl/datasetIntel'
import { usePref } from '../cribl/prefs'
import { GatedControl } from './GatedControl'

/**
 * Offers to generate Cribl dataset intelligence when it's absent, so the
 * "AI investigate" action lands on a grounded agent instead of one that has to
 * rediscover a 319-field schema first.
 *
 * Deliberately quiet: it renders nothing unless the tenant has AI enabled AND
 * intelligence is genuinely missing or failed. Once generated (or dismissed) it
 * never comes back for that viewer — the dismissal is per-user and lives in the
 * app-scoped Cribl KV store, so it survives a reload and a change of browser.
 */
export function DatasetIntelPrompt() {
  const [status, setStatus] = useState<IntelStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = usePref('intelPromptDismissed')
  const poll = useRef<number | null>(null)
  // Generation is a write to Cribl under a declared policy path, so it can be
  // refused. When it is, the gate has the sentence that names the object; the
  // bare `Could not start generation (403)` below would be saying the same thing
  // twice and worse.
  const gate = useWriteGate('dataset_intel.generate')

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
    setError(null)
    try {
      await generateDatasetIntel()
      setStatus('processing')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // `dismissed` is three-valued: undefined until the stored preference lands
  // (cribl/prefs.ts). Only a definite `false` shows the note, so a viewer who
  // dismissed it once does not watch it appear and vanish on every load.
  if (dismissed !== false || status === null) return null
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
        {error && !gate.denied && <span className="intel-err"> — {error}</span>}
      </span>
      <span className="intel-actions">
        <GatedControl
          write="dataset_intel.generate"
          label="Generate"
          busyLabel="Starting…"
          className="tour-btn tour-btn-primary"
          run={start}
        />
        <button type="button" className="tour-btn" onClick={() => setDismissed(true)}>Dismiss</button>
      </span>
    </div>
  )
}
