import { useEffect, useRef, useState } from 'react'
import { useWriteGate } from '../cribl/authz'
import { LAKE_DATASET } from '../cribl/config'
import { aiEnabled, generateDatasetIntel, getDatasetIntel, type IntelStatus } from '../cribl/datasetIntel'
import { usePref } from '../cribl/prefs'
import type { AppBanner } from './AppBanners'
import { GatedControl } from './GatedControl'

/**
 * Offers to generate Cribl dataset intelligence when it's absent, so the
 * "AI investigate" action lands on a grounded agent instead of one that has to
 * rediscover a 319-field schema first.
 *
 * Deliberately quiet: it says nothing unless the tenant has AI enabled AND
 * intelligence is genuinely missing or failed. Once generated (or dismissed) it
 * never comes back for that viewer — the dismissal is per-user and lives in the
 * app-scoped Cribl KV store, so it survives a reload and a change of browser.
 *
 * WHY IT IS A HOOK AND NOT A COMPONENT. It used to render its own `.intel-note`
 * inside the Findings tab, which is where ✦ AI investigate lives. It now
 * describes a banner and `AppBanners` draws it, in the one page-level slot
 * under the tab bar — so the app has one banner treatment rather than two, and
 * the offer reaches an admin who never opens Findings. See AppBanners.tsx for
 * why the sources describe rather than render.
 *
 * WHAT THAT COST, and why it is paid here: the probe now runs on every load
 * rather than only on Findings. So it is gated on the dismissal instead of
 * racing it — a viewer who has said no costs the platform nothing at all, and
 * an undismissed one costs the same two GETs it always did.
 */
export function useDatasetIntelBanner(): AppBanner | null {
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
    // `undefined` is the preference still in flight and `true` is a viewer who
    // has already said no — neither is a reason to ask Cribl anything. Only a
    // definite `false` starts the probe, and flipping to `true` on the dismissal
    // aborts whatever it had in the air.
    if (dismissed !== false) return
    const ctrl = new AbortController()
    let cancelled = false
    void (async () => {
      if (!(await aiEnabled(ctrl.signal))) return
      if (cancelled) return
      try {
        const intel = await getDatasetIntel(ctrl.signal)
        if (!cancelled) setStatus(intel.status)
      } catch {
        /* not fatal — the banner simply stays hidden */
      }
    })()
    return () => { cancelled = true; ctrl.abort(); if (poll.current) window.clearInterval(poll.current) }
  }, [dismissed])

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
  // (cribl/prefs.ts). Only a definite `false` shows the banner, so a viewer who
  // dismissed it once does not watch it appear and vanish on every load.
  if (dismissed !== false || status === null) return null
  if (status === 'complete' || status === 'partial' || status === 'unknown') return null

  if (status === 'processing') {
    // No dismissal on purpose: this is the receipt for a generation this viewer
    // started, and it clears itself within one 15-second poll of Cribl
    // finishing. A dismissal here would also hide the failure if it failed.
    return {
      id: 'dataset-intel',
      appearance: 'info',
      title: `Generating dataset intelligence for ${LAKE_DATASET}…`,
      body: 'This takes a few minutes. AI investigations started before it finishes still work — they just spend a step discovering the schema themselves.',
    }
  }

  // INFO, THOUGH `.intel-note` WAS AMBER, and the change is deliberate twice
  // over. Nothing here is wrong: dataset intelligence has simply never been
  // generated, and this is an offer to improve something, which is Capra's
  // definition of info and not of warning. And Capra derives the ARIA role from
  // the appearance and does not let a caller override it — warning and danger
  // are `role="alert"` with `aria-live="assertive"`. This banner is inserted
  // after load, on every load, for every viewer who has neither dismissed it
  // nor generated the thing; as a warning it would interrupt a screen-reader
  // user each time, where the `.intel-note` it replaces was `role="note"` and
  // announced nothing at all. Info is `role="status"`, polite, which is what an
  // offer is owed. Change the word here and that changes with it.
  return {
    id: 'dataset-intel',
    appearance: 'info',
    title: 'AI investigations aren’t grounded yet',
    body: (
      <>
        Cribl has no dataset intelligence for <code>{LAKE_DATASET}</code>, so Copilot rediscovers this 319-field
        schema on every investigation before it can start. Generating it once makes every{' '}
        <strong>✦ AI investigate</strong> faster and better grounded.
        {error && !gate.denied && <> — {error}</>}
      </>
    ),
    // The gate stays: generation is a write, Cribl can refuse it, and the
    // refusal has to be readable at the button that was refused (slice 1.4).
    // `btn` and not `btn-primary`, and the reason has changed since slice 1.6
    // wrote this line. It used to be a contrast fix: `.gs-btn-primary` painted
    // #fff on Capra's solid accent, 3.26:1, which does not clear AA at this
    // size. Slice 1.9 fixed that at the source — `.btn-primary` is
    // --gm-btn-primary now and measures 5.02:1, asserted in
    // src/app/contrast.test.ts. What is left is the ordinary reason: this button
    // is inside a dismissible banner offering something optional, and a filled
    // primary would give it the weight of the page's main action.
    action: (
      <GatedControl
        write="dataset_intel.generate"
        label="Generate"
        busyLabel="Starting…"
        className="btn"
        run={start}
      />
    ),
    onDismiss: () => setDismissed(true),
  }
}
