// The one thing that stands between a customer's configuration and a write.
//
// AGENTS.md ("Confirming Destructive Operations") asks for three things before a
// DELETE or an overwriting PATCH: a deliberate click, a prompt naming exactly
// what will be affected, and a warning when it cannot be undone. Guided Setup
// already said all three — slice 1.3 wrote that text and it is right — but it
// said them inside a plain `<div class="gs-confirm">` with no role, no label, no
// focus management and no announcement. A sighted user read a warning; anybody
// else got a page that silently grew four paragraphs somewhere below the button
// they had just pressed. This is the same words on a real dialog.
//
// WHAT CAPRA'S `Modal` ALREADY DOES, measured rather than assumed (a bare one
// mounted under happy-dom, `@capra/core@1.8.2`):
//
//   * Renders a `<section role="dialog" aria-labelledby>` pointing at the `<h2>`
//     it builds from `title` — so rule 3 (the label names kind, id and group) is
//     a question about our string, not about Capra.
//   * Portals the whole thing to `document.body`, outside `#root`, and marks
//     `#root` `inert` while it is open. That is the focus trap, and it is why
//     this file does not implement one.
//   * Locks scrolling on `<html>` (`overflow: hidden; scrollbar-gutter: stable`),
//     releases it on close, and puts the overlay at `z-index: 10000` — clear of
//     everything App.css declares, the 100 of `.topprogress` included.
//   * Closes on Escape and on the header ✕, and restores focus to whatever was
//     focused before it opened. Both were checked with a custom footer, because
//     Capra's own Cancel carries a `slot="close"` that ours does not.
//
// WHAT IT DOES NOT DO, and therefore what is here:
//
//   * **Initial focus.** Left alone, Capra focuses the dialog `<section>` itself.
//     S8 rule 1 wants Cancel — never the destructive action — so Cancel is a
//     Capra `Button autoFocus`, which is the mechanism that was verified to win.
//   * **`aria-describedby`.** `ModalProps` has no such prop and Capra does not
//     wire `slot="description"` for Modal the way it does for Drawer, so the
//     dialog announces its title and nothing else on open. Rule 7 wants the
//     irreversibility line, the cost, the consequences and the object list read
//     BEFORE the buttons. So the body is one identified container and an effect
//     hangs it on the dialog by hand, reaching the element through
//     `closest('[role="dialog"]')` — a role, which is a public contract, and not
//     a Capra class name, which is not.
//   * **A confirm button that is `aria-disabled` rather than `disabled`.**
//     `ModalProps` has no `isConfirmDisabled` at all, which is why the footer is
//     custom; `blockedUntil` on `<GatedControl>` is the rest of it.
//
// ONE FOOTER PATH, NOT TWO. The plain case and the type-to-confirm case render
// the same footer, because the only difference between them is whether
// `blockedUntil` is null — and a component with two footer paths would be a
// component where the plain path is the one that gets tested.
//
// WHY THE CONFIRM BUTTON IS A PROP AND NOT SOMETHING THIS FILE BUILDS.
// src/components/gatedWrites.test.ts reads the source for
// `<GatedControl write="…">` with the id as a literal first attribute, and
// refuses to pass until every `config` write in cribl/authz.ts has one. A
// `<GatedControl write={props.write}>` in here matches `<GatedControl\b` but not
// the literal form, so it would both fail that test's "first attribute" rule and
// make the two writes it exists for invisible to it. The caller writes the
// literal; this file `cloneElement`s the gate onto it, so a caller cannot forget
// to thread the type-to-confirm block — which is the half that must not be
// optional.
//
// `<DiffTable>`, WHICH THIS BLOCK USED TO SAY WAS NOT BUILT. Until 2026-09-17 it
// read: *"NOT BUILT, deliberately … Phase 1 has no caller for it — Guided
// Setup's deploy is additive and idempotent and its teardown is a delete list,
// so neither has a before→after to show. Its first real caller is the Phase 3
// retention change. The prop is absent rather than present-and-ignored."* That
// caller arrived, so the component and the `diff` prop did too. The reasoning
// was right and is kept as the reason the prop has the shape it has: it was
// specified for four call sites in four different ways, and it exists once.
//
// `diff` IS STRUCTURED DATA, NOT A ReactNode, and that is a decision rather than
// an oversight. Every other prop here is structured — `resources`,
// `irreversible`, `costLine`, `consequences`, `undo`, `typeToConfirm` — because
// this dialog owes two things a caller cannot be trusted to supply: the reading
// ORDER of the described-by region, and the region itself. A node handed in
// could carry its own heading level, its own `<details>`, its own link — all of
// them flattened to text by `aria-describedby` and announced as one run with no
// way to reach them — and the dialog would have no way to know. Structured, it
// can key each table to a resource it is already naming three lines above, and
// it can render the EMPTY diff, which is the state every caller would otherwise
// have to remember on its own. The shape is §1.5's own contract,
// `{resourceId, key, before, after}[]`.

import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Button, Modal, Pill, TextField } from '@capra/core'
import { DiffTable, type DiffRow } from './DiffTable'
import type { GatedControlProps } from './GatedControl'

/**
 * What a confirmation does to one object. S8's four, kept whole even though
 * Guided Setup uses three — the word is rendered, so an action nothing renders
 * costs a line in a map rather than being a lie on screen.
 *
 * `stop` is the fifth, added by the long-running-search cancel (slice 1.8). It
 * is here rather than reusing `delete` because the word is on screen next to the
 * object: cancelling a Cribl Search job moves it to `canceled` and leaves it in
 * the search history, so `delete` would tell a reader their colleague's search
 * record was about to be removed. It also does not collide with the dialog's own
 * Cancel button, which means the opposite thing.
 */
export type ResourceAction = 'create' | 'replace' | 'delete' | 'deploy' | 'stop'

/** One object a confirmation names. `id` is what an operator checks against. */
export interface ConfirmResource {
  action: ResourceAction
  /** What kind of thing it is, in words: `Syslog source`, `Cribl Lake dataset`. */
  kind: string
  /** Its id, exactly as Cribl spells it. */
  id: string
  /** The worker group or dataset scope it lives in, when that is not obvious. */
  group?: string
  /** One clause about what happens to it, if the action word is not enough. */
  detail?: string
}

/**
 * One key of one resource's body, and what this write does to it. `resourceId`
 * matches a `ConfirmResource.id`, so a three-object PATCH draws three small
 * tables rather than one flat list a reader has to attribute by eye.
 */
export interface DiffEntry extends DiffRow {
  /** The `id` of the `ConfirmResource` this key belongs to. */
  resourceId: string
}

export interface ConfirmDialogProps {
  isOpen: boolean
  /** Kind, id and group in words. This becomes the `<h2>` the dialog is labelled by. */
  title: string
  /** Every object the intent touches, in dependency order. Deletes are moved last. */
  resources: ConfirmResource[]
  /**
   * The before→after of the bodies being overwritten, keyed to the resources
   * above. Rendered inside the described-by region, after the object list —
   * which names WHICH things change — and before `undo`.
   *
   * Three values, and all three mean something different. Absent: this intent
   * has no before→after to show (Guided Setup's teardown is a delete list; its
   * deploy is additive). Non-empty: these keys move. **Empty array: the caller
   * computed a diff and it came back with nothing in it** — a 30 → 30 retention
   * Apply — and the dialog says so in a sentence rather than drawing an empty
   * table, because a confirmation claiming a change it is not making is the
   * thing a confirmation is for. An empty array is not the same as no diff and
   * is deliberately not collapsed into it.
   */
  diff?: DiffEntry[]
  /** Why this cannot be undone. Read first, before anything else. */
  irreversible?: { why: string }
  /** What it costs, in credits. No Guided Setup caller: nothing here runs a search. */
  costLine?: string
  /** What else changes as a result. One sentence each. */
  consequences?: string[]
  /** What puts it back — rule 3's missing half, and the reason a reversible confirmation is safe to accept. */
  undo?: string
  /** The literal the person must type out. Only the teardown uses it. */
  typeToConfirm?: { value: string; label: string }
  /** The button that performs the write. See the header for why it is a prop. */
  confirm: ReactElement<GatedControlProps>
  onCancel: () => void
}

/**
 * The action word's colour. `<StatusPill>` is not reused because its states are
 * a status vocabulary (`present`, `failed`) and these are verbs — and adding
 * four verbs to that union would make the one status map mean two things.
 * Capra's `Pill variant="outline"` is the same treatment for the same reason
 * StatusPill picked it: every appearance clears 4.5:1, and `bold` does not.
 * src/app/contrast.test.ts measures all four against this dialog's surface.
 */
const ACTION_APPEARANCE: Record<ResourceAction, 'success' | 'warning' | 'danger' | 'info'> = {
  // Additive. Nothing that exists is touched.
  create: 'success',
  // Something that exists is written over.
  replace: 'warning',
  // Restarts running Workers on a new configuration.
  deploy: 'info',
  delete: 'danger',
  // Ends work that is in flight. Danger, like delete, because what it costs is
  // the same thing: somebody's results, gone, with nothing to recover them from.
  stop: 'danger',
}

/**
 * Deletes last (S8 rendering rules), and nothing else reordered: the caller
 * passes dependency order — a dataset before the destination that writes to it —
 * and a sort that also grouped creates ahead of replaces would throw that away
 * to enforce a rule nobody asked for.
 */
const DELETES_LAST: Record<ResourceAction, number> = { create: 0, replace: 0, deploy: 0, delete: 1, stop: 1 }

interface DiffGroup {
  resourceId: string
  caption: string
  rows: DiffRow[]
}

/**
 * The diff, split one table per resource, in the order the keys arrive.
 *
 * Two things here are deliberate and would be easy to "simplify" away:
 *
 *   * **An entry whose `resourceId` names no listed resource still renders**,
 *     captioned with the bare id. Dropping it would be the dialog silently
 *     hiding a change from somebody about to approve it, to punish the caller
 *     for a typo — and the caller's mistake is not the customer's to pay for.
 *     The bare id is also what makes the mistake visible in review.
 *   * **An empty `diff` produces one group with no rows**, so `<DiffTable>`
 *     renders its "nothing changes" sentence. Returning zero groups would make
 *     the no-op case indistinguishable from no diff at all, which is the one
 *     distinction this prop exists to carry.
 */
function groupDiff(diff: DiffEntry[], resources: ConfirmResource[]): DiffGroup[] {
  const name = (id: string) => {
    const r = resources.find((x) => x.id === id)
    return r ? `${r.kind} ${r.id}` : id
  }
  if (diff.length === 0) {
    return [{
      resourceId: '',
      // One object can be named; several cannot without repeating the list
      // directly above, so the sentence points at it instead.
      caption: resources.length === 1 ? name(resources[0].id) : 'Every object listed above',
      rows: [],
    }]
  }
  const groups: DiffGroup[] = []
  for (const entry of diff) {
    let group = groups.find((g) => g.resourceId === entry.resourceId)
    if (!group) {
      group = { resourceId: entry.resourceId, caption: name(entry.resourceId), rows: [] }
      groups.push(group)
    }
    group.rows.push({ key: entry.key, before: entry.before, after: entry.after })
  }
  return groups
}

export function ConfirmDialog({
  isOpen,
  title,
  resources,
  diff,
  irreversible,
  costLine,
  consequences,
  undo,
  typeToConfirm,
  confirm,
  onCancel,
}: ConfirmDialogProps) {
  const bodyId = useId()
  const requirementId = useId()
  const irreversibleId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState('')
  // Whether they have pressed the confirm button at least once. The field is not
  // marked invalid before that: an empty box on open is not a mistake anybody has
  // made yet, and announcing it as an error is how a dialog teaches people to
  // ignore its errors.
  const [attempted, setAttempted] = useState(false)

  // A reopened dialog is a fresh decision. Typing the group name once must not
  // leave the next teardown pre-confirmed, so the box empties on close rather
  // than on open — by open it is already the thing being announced.
  useEffect(() => {
    if (isOpen) return
    setTyped('')
    setAttempted(false)
  }, [isOpen])

  // Put focus back where it came from when the dialog closes.
  //
  // Capra's FocusScope restores focus itself when IT controls the unmount, but
  // this dialog is rendered conditionally by its caller, so on close the whole
  // subtree goes with the scope and the restore never runs — focus lands on
  // <body>, and a keyboard user is returned to the top of the document rather
  // than to the button they pressed. Measured in a real browser: happy-dom has
  // no sequential focus navigation, so the test asserting this passed while the
  // behaviour was broken. Hence the ref: remember the trigger on open, and put
  // focus back on it on close if nothing else has claimed it since.
  const restoreTo = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (isOpen) {
      restoreTo.current = document.activeElement as HTMLElement | null
      return
    }
    const el = restoreTo.current
    restoreTo.current = null
    // Only if focus fell to the body — if the caller moved it deliberately, or
    // the trigger has since left the page, leave it alone.
    if (el && el.isConnected && document.activeElement === document.body) el.focus()
  }, [isOpen])

  // Hang the body on the dialog as its description. Capra offers no prop for it
  // (see the header); the dialog element is found through its role rather than
  // its class, and Capra never writes this attribute itself, so nothing fights
  // over it. Re-runs on open because the dialog is a different DOM node each time.
  useEffect(() => {
    if (!isOpen) return
    bodyRef.current?.closest('[role="dialog"]')?.setAttribute('aria-describedby', bodyId)
  }, [isOpen, bodyId])

  const matched = typeToConfirm ? typed.trim() === typeToConfirm.value : true
  const ordered = [...resources].sort((a, b) => DELETES_LAST[a.action] - DELETES_LAST[b.action])

  return (
    <Modal
      isOpen={isOpen}
      title={title}
      // Escape and the header ✕ both land here, so cancelling is one path
      // whichever way they leave.
      onClose={onCancel}
      footer={
        <Modal.FooterActions>
          {/* Rule 1: focus opens on the way out, never on the destructive action.
              Capra focuses the dialog section when nothing claims focus, so this
              is the claim. */}
          <Button autoFocus onClick={onCancel}>Cancel</Button>
          {cloneElement(confirm, {
            blockedUntil: matched
              ? null
              : {
                  describedBy: requirementId,
                  onActivate: () => {
                    setAttempted(true)
                    inputRef.current?.focus()
                  },
                },
          })}
        </Modal.FooterActions>
      }
    >
      <div className="cdlg" id={bodyId} ref={bodyRef}>
        {/* This whole container is what the dialog announces on open, in this
            order: what cannot be taken back, what it costs, what else happens,
            the objects themselves, what their values become, and what puts them
            back. The object list is
            inside the announced region rather than after it because the list IS
            what AGENTS.md requires to be named before the call — S8's layout
            draws it below the described-by rule, and this is the one place that
            reading is widened rather than followed. */}
        {irreversible && (
          <p className="cdlg-warn" id={irreversibleId}>
            <strong>This cannot be undone.</strong> {irreversible.why}
          </p>
        )}
        {costLine && <p>{costLine}</p>}
        {consequences?.map((line) => <p key={line}>{line}</p>)}

        <h3 className="cdlg-head">What will change</h3>
        <ul className="cdlg-res">
          {ordered.map((r) => (
            <li key={`${r.action}:${r.kind}:${r.id}`} className="cdlg-res-row">
              {/* The action as a word, which is the point: a red row and a green
                  row are the same row to anyone who cannot tell them apart. */}
              <Pill appearance={ACTION_APPEARANCE[r.action]} variant="outline">{r.action}</Pill>
              <span className="cdlg-res-text">
                <span>
                  {r.kind} <code>{r.id}</code>
                  {r.group && <> in <code>{r.group}</code></>}
                </span>
                {r.detail && <span className="cdlg-res-detail">{r.detail}</span>}
              </span>
            </li>
          ))}
        </ul>

        {/* The object list says which things change; this says what they become.
            It is inside the described-by container on purpose — a value a
            customer is approving is not a detail they can be expected to go
            looking for, and the whole reason this dialog hangs
            `aria-describedby` on by hand is that Capra reads out the title and
            stops. `undo` stays last: it is what puts this back, and it only
            makes sense after the reader knows what "this" is. */}
        {diff && (
          <>
            <h3 className="cdlg-head">Before and after</h3>
            {groupDiff(diff, resources).map((g) => (
              <DiffTable key={g.resourceId} caption={g.caption} rows={g.rows} />
            ))}
          </>
        )}

        {undo && <p className="cdlg-undo">{undo}</p>}
      </div>

      {typeToConfirm && (
        <div className="cdlg-ttc">
          {/* The requirement is a sentence of its own, not a placeholder and not
              only the field's label: it is what the confirm button points at
              while it is unavailable, so it has to exist whether or not anybody
              has reached the field. */}
          <p className="cdlg-req" id={requirementId}>
            {matched
              ? `Matches ${typeToConfirm.value}. The button below is enabled.`
              : attempted
                ? `That is not ${typeToConfirm.value}. Type it exactly to enable the button.`
                : `Type ${typeToConfirm.value} to enable the button below.`}
          </p>
          <TextField
            ref={inputRef}
            label={typeToConfirm.label}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            spellCheck={false}
            appearance={attempted && !matched ? 'danger' : 'default'}
            aria-invalid={attempted && !matched ? 'true' : undefined}
            // BOTH sentences, in this order, and the irreversibility one first.
            // `.cdlg-ttc` sits OUTSIDE `.cdlg`, so the dialog's own
            // `aria-describedby` does not reach it — a deliberate decision
            // argued in App.css, on the grounds that a labelled control
            // announces itself on focus and repeating the whole body would
            // lengthen what is read on open. The cost of that decision is that
            // somebody who tabs straight to this field hears the requirement and
            // not the fact that what they are about to confirm DELETES DATA,
            // which is the one sentence this field exists to slow them down for.
            // Wired in the Phase 3 settling pass; two handoffs in a row recorded
            // it as not done because nobody had checked whether Capra's
            // TextField forwards the attribute. It does — it spreads the rest of
            // an `input`'s props — and ConfirmDialog.test.tsx now asserts the
            // attribute is on the real <input>, so this stops being true the
            // moment that changes rather than the next time somebody reads it.
            aria-describedby={irreversible ? `${irreversibleId} ${requirementId}` : requirementId}
          />
        </div>
      )}
    </Modal>
  )
}
