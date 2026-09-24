import { useEffect, useState } from 'react'
import { GatedControl } from './GatedControl'
import { InfoTip } from './InfoTip'
import { Panel } from './Panel'
import {
  DEFAULT_CAP_TIERS, MAX_CAP_SECONDS, MIN_CAP_SECONDS, capTiersInForce, type CapTier,
} from '../cribl/search'
import { CAP_RANGE_TEXT, capsSource, loadSearchCaps, saveSearchCaps, type CapsSource } from '../cribl/searchCaps'

/**
 * Where an installer raises (or lowers) the running-time limit on every query
 * this app submits — decision A-D30.
 *
 * WHY THIS EXISTS AT ALL. Every panel's job is submitted with
 * `set max_running_time_per_search=<n>` in front of it, and `n` is picked from a
 * table in cribl/search.ts by the window the panel reads. Those seconds were
 * sized against the demo feed. The same panel on a production tenant reads more
 * data in the same wall time, so a limit that is generous here can stop a panel
 * that was working fine — and a stopped panel reads to a customer as a broken
 * app, not as a budget decision. Without this screen the only fix is a code
 * change, a repackage and a reinstall.
 *
 * INSTALL-WIDE. The limits saved here apply to everyone who opens the app, which
 * is the point: the person raising them is fixing a dashboard that looks broken,
 * and a per-viewer override would fix it for them alone while everyone else went
 * on looking at the broken version. The panel says so beside the button rather
 * than in a modal after it.
 *
 * THE RISK RUNS BOTH WAYS and the ⓘ on the lead line says both, because an input box
 * with a number in it invites exactly one of the two mistakes: too low stops
 * panels that were merely slow, too high lets one runaway query bill for its
 * whole window.
 */

/**
 * A span in the words the range picker uses: 3600 → "1 hour", 900 → "15
 * minutes", 86400 → "24 hours" and not "1 day", because "Last 24 hours" is what
 * the Range control beside it calls that window. A band label has to use the
 * same words as the control it describes, or it reads as a different setting.
 */
function spanLabel(seconds: number): string {
  const units: Array<[size: number, name: string]> = seconds > 86400
    ? [[86400, 'day'], [3600, 'hour'], [60, 'minute']]
    : [[3600, 'hour'], [60, 'minute']]
  const [size, name] = units.find(([s]) => seconds >= s && seconds % s === 0) ?? [1, 'second']
  const n = seconds / size
  return `${n} ${name}${n === 1 ? '' : 's'}`
}

/**
 * The window band one tier covers, given the band below it — read off the tier
 * bounds rather than written out, so a table whose bands are not the shipped
 * ones still labels its own rows correctly.
 */
function bandLabel(upToSeconds: number, below: number): string {
  if (!Number.isFinite(upToSeconds)) return below === 0 ? 'Any time range' : `Longer than ${spanLabel(below)}`
  if (below === 0) return `Up to ${spanLabel(upToSeconds)}`
  return `${spanLabel(below)} to ${spanLabel(upToSeconds)}`
}

/**
 * The shipped default for a band, looked up by the band's own bound rather than
 * by position. A stored table is free to have different bounds from
 * DEFAULT_CAP_TIERS — nothing in this form can produce one, but a hand-edited
 * document can — and a default printed beside the wrong band is worse than none.
 */
function defaultCapFor(upToSeconds: number): number {
  const tier = DEFAULT_CAP_TIERS.find((t) => upToSeconds <= t.upToSeconds)
  return (tier ?? DEFAULT_CAP_TIERS[DEFAULT_CAP_TIERS.length - 1]).capSeconds
}

/** What a typed value is wrong about, or null when it is fine. */
function fieldError(text: string): string | null {
  const n = Number(text.trim())
  if (!text.trim() || !Number.isFinite(n)) return 'Enter a number of seconds.'
  if (!Number.isInteger(n)) return 'Whole seconds only.'
  if (n < MIN_CAP_SECONDS) return `Too low — ${MIN_CAP_SECONDS} s is the smallest limit that can still tell a runaway query from a normal one.`
  if (n > MAX_CAP_SECONDS) return `Too high — ${MAX_CAP_SECONDS} s is the most this app will set; past about an hour a limit stops being one.`
  return null
}

// The panel's standing words. One lead line on screen; the rest behind an ⓘ
// (Guided Setup's declutter, 2026-09-24). The shipped caps were sized against
// the demo feed, which is what "a small feed" below means.
const LIMITS_LEAD =
  'Cribl stops each of this app’s queries after the seconds below, chosen by the time range the panel reads.'

const LIMITS_LEAD_TIP =
  'The defaults suit a small feed: on a busier tenant a panel reads more data in the same time, so one that keeps reporting its time limit needs a bigger number here, not a bug fix. ' +
  'Too low and slow panels stop returning anything; too high and one runaway query bills for its whole window, in CPU-seconds that run well ahead of wall-clock seconds.'

const SAVE_SCOPE_TIP =
  'Saving replaces this app’s own setting, app/settings/search_caps. It changes nothing in your Cribl configuration and touches no source, pipeline, route or dataset.'

const RESET_TIP = 'Reset to defaults only fills the boxes in. Nothing is saved until you press Save for everyone.'

const SOURCE_TEXT: Record<CapsSource, string> = {
  default: 'the built-in defaults — nothing is saved for this install yet',
  stored: 'the limits saved for this install',
  page: 'a change made on this page that the app store would not keep — it will be gone after a reload',
}

export function SearchLimitsPanel() {
  // The in-force table, once the startup read has settled. Null means the read
  // is still in flight: this panel seeds its inputs from what is ACTUALLY in
  // force, so showing the defaults first and swapping them under the cursor a
  // moment later would be showing a number that was never true.
  const [inForce, setInForce] = useState<readonly CapTier[] | null>(null)
  const [source, setSource] = useState<CapsSource>('default')
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    // Memoized in searchCaps.ts: this waits on the read main.tsx already
    // started rather than starting a second one.
    void loadSearchCaps().then((from) => {
      if (!alive) return
      const tiers = capTiersInForce()
      setInForce(tiers)
      setSource(from)
      setDraft(tiers.map((t) => String(t.capSeconds)))
    })
    return () => { alive = false }
  }, [])

  if (!inForce) return <Panel title="Search running-time limits">Reading the saved limits…</Panel>

  const errors = draft.map(fieldError)
  const dirty = draft.some((v, i) => Number(v) !== inForce[i].capSeconds)
  const blocked = errors.some(Boolean)
  // `source === 'page'` keeps Save live after a refused write, so a store that
  // was briefly unreachable can be retried. Without it the page holds the new
  // value, nothing is dirty, and the only way to try again is to retype a number
  // you can already see.
  const canSave = !blocked && (dirty || source === 'page')

  const onSave = async () => {
    setSaving(true)
    setNote(null)
    const tiers: CapTier[] = inForce.map((t, i) => ({ upToSeconds: t.upToSeconds, capSeconds: Number(draft[i]) }))
    const res = await saveSearchCaps(tiers)
    if (res.refused) {
      // Unreachable from this form — every field is validated before Save goes
      // live — so this is the backstop, and it must not throw away typing the
      // customer can still fix.
      setNote({ kind: 'err', text: res.refused })
      setSaving(false)
      return
    }
    setInForce(res.tiers)
    setDraft(res.tiers.map((t) => String(t.capSeconds)))
    setSource(capsSource())
    setNote(res.ok
      ? { kind: 'ok', text: 'Saved. Every viewer of this app gets these limits, from each panel’s next query — the queries already running keep the limit they were submitted with.' }
      : { kind: 'warn', text: 'Could not save: the app store refused the write. The new limits are in force on this page only and will be gone after a reload. Inside Cribl that usually means the store is unreachable; on the localhost dev page it always happens and is expected.' })
    setSaving(false)
  }

  const onReset = () => {
    const next = inForce.map((t) => String(defaultCapFor(t.upToSeconds)))
    setDraft(next)
    setNote(next.every((v, i) => Number(v) === inForce[i].capSeconds)
      ? { kind: 'warn', text: 'These already are the defaults — nothing to change.' }
      : { kind: 'warn', text: 'Defaults filled in. Nothing has been saved yet — press Save to apply them for everyone.' })
  }

  return (
    <Panel
      title="Search running-time limits"
      info="Every query this app submits is prefixed with set max_running_time_per_search=<seconds>, chosen from this table by the time range the panel reads. Cribl stops the job when it reaches that, and the panel names the limit rather than reporting a plain failure. Nothing here changes what a query returns — only how long Cribl lets it run before stopping it."
    >
      {/* One lead line; the rest is behind the ⓘ. */}
      <p className="gs-intro">
        {LIMITS_LEAD}
        <InfoTip text={LIMITS_LEAD_TIP} />
      </p>

      <div className="sl-rows">
        {inForce.map((tier, i) => {
          const below = i === 0 ? 0 : inForce[i - 1].upToSeconds
          const id = `sl-cap-${i}`
          return (
            <div key={`${tier.upToSeconds}-${i}`} className="sl-row">
              <label className="sl-band" htmlFor={id}>{bandLabel(tier.upToSeconds, below)}</label>
              <span className="sl-input-wrap">
                <input
                  id={id}
                  className={`sl-input ${errors[i] ? 'sl-input-bad' : ''}`}
                  type="number"
                  inputMode="numeric"
                  min={MIN_CAP_SECONDS}
                  max={MAX_CAP_SECONDS}
                  step={10}
                  value={draft[i]}
                  disabled={saving}
                  aria-describedby={errors[i] ? `${id}-hint ${id}-err` : `${id}-hint`}
                  aria-invalid={errors[i] ? true : undefined}
                  onChange={(e) => setDraft((d) => d.map((v, j) => (j === i ? e.target.value : v)))}
                />
                <span className="sl-unit">seconds</span>
              </span>
              <span className="sl-default" id={`${id}-hint`}>
                default {defaultCapFor(tier.upToSeconds)} s
                {Number(draft[i]) !== tier.capSeconds && <> · in force {tier.capSeconds} s</>}
              </span>
              {errors[i] && <span className="sl-field-err" id={`${id}-err`}>{errors[i]}</span>}
            </div>
          )
        })}
      </div>

      <p className="gs-action-note">
        In force now: {inForce.map((t) => `${t.capSeconds} s`).join(' · ')} — {SOURCE_TEXT[source]}.
        <InfoTip text={SAVE_SCOPE_TIP} />
      </p>

      <div className="sl-actions">
        {/* Gated even though this writes only the app's own document. The store
            is app-scoped and granted with the app (AGENTS.md), so it cannot be
            refused for lack of a role — but if the platform ever does refuse
            this app's own calls, "Could not save" is not the sentence somebody
            needs, and the gate's is. The gate closes only on a refusal, never on
            the ordinary unreachable-store case the panel already explains below,
            so Save stays live for the retry it was deliberately kept live for. */}
        <GatedControl
          write="search_caps.save"
          label="Save for everyone"
          busyLabel="Saving…"
          unavailable={
            blocked
              ? `Each limit must be ${CAP_RANGE_TEXT}.`
              : canSave
                ? null
                : 'These are the limits already in force — nothing to save.'
          }
          run={onSave}
        />
        <button type="button" className="btn btn-ghost" onClick={onReset} disabled={saving}>
          Reset to defaults
        </button>
        {/* The standing explanation, and ONLY that. Since <GatedControl> started
            rendering `unavailable` as a visible sentence under the button
            (2026-09-17), this line printing the out-of-range reason as well put
            the same sentence on screen twice, a few pixels apart, about the same
            button. The reason belongs under the control it is about; this says
            the thing that is true whether or not the numbers are valid. */}
        <span className="sl-actions-note">
          Applies to every viewer of this app.
          <InfoTip text={RESET_TIP} />
        </span>
      </div>

      {note && <p className={`sl-note sl-note-${note.kind}`} role="status">{note.text}</p>}
    </Panel>
  )
}
