// The before→after a customer reads before approving a change to their
// configuration — the one thing in a confirmation that is not prose.
//
// WHY IT EXISTS. A confirmation that names an object but not its values asks for
// consent to something unreadable. Guided Setup's Re-apply dialog has always
// said *"Pipeline `gigamon_syslog` — created, or its function list overwritten if
// it already exists"* and has never said what that function list is about to
// become; nobody noticed, because a re-apply writes back roughly what was there.
// Phase 3 makes the same gap expensive. It PATCHes a live Cribl Lake dataset
// that is in no version control at all — no history, no ETag, no undo — and one
// of its edits deletes data. This is what the person reads instead.
//
// WHAT IT IS NOT: a text diff. No line-level or character-level highlighting,
// because the thing being changed is a keyed configuration body and the unit a
// reader acts on is the key. Four columns, one row per key.
//
// THE EMPTY DIFF IS A REAL STATE, and getting it right is half of why this is a
// component and not four lines of JSX in the dialog. A no-op edit — the 30 → 30
// retention Apply that Phase 3's Preview list uses to probe whether the Lake
// PATCH is partial at all — has to SAY that nothing changes. An empty <table>
// under a heading is a dialog claiming a change it is not making, which is the
// precise failure a confirmation exists to stop.
//
// COLOUR IS NEVER THE ONLY SIGNAL. Every row renders its change as a WORD —
// added / removed / changed / unchanged — with the glyph second and the ink
// third; the glyph is `aria-hidden` because the word is already there and a
// screen reader announcing "plus added" is reading the decoration out loud.
// src/app/contrast.test.ts measures the inks on the surface this is drawn on.
//
// THE STATE IS DERIVED, NEVER PASSED. A caller cannot label a removal `added`,
// because it does not get to label anything — `diffState()` reads the two
// values. What the caller does own is how a value PRINTS: a boolean, a nested
// object, a count of days. The module that computed the diff is the one that
// knows what the field means, so both sides arrive here as strings that are
// already what a reader should see, and `null` means the key is not present on
// that side — a different fact from an empty string, and rendered as a different
// word rather than as the same blank cell.
//
// IT IS A `.dtable`. The caption, `scope="col"` on every head, `scope="row"` on
// the field name and the 10px column heads are that family's contract and are
// not re-derived here. The one departure — a VISIBLE caption — is argued in
// App.css beside the rule.

// `DiffRow`, `DiffState` and `diffState` live in ./diffRow.ts — the pair and
// what it means, with no DOM. Re-exported as TYPES so every existing importer
// of `DiffRow` from this file keeps working; `diffState` is imported from
// there directly, because re-exporting the function would put the
// only-export-components warning straight back.
import { diffState, type DiffRow, type DiffState } from './diffRow'
export type { DiffRow, DiffState } from './diffRow'

export interface DiffTableProps {
  /**
   * Which object's body this is — `Cribl Lake dataset gigamon_ami`. It becomes
   * the table's `<caption>`, which is both its accessible name and on screen,
   * because a three-object PATCH stacks three of these in one dialog and the
   * first thing anybody needs is which is which.
   */
  caption: string
  /** The changed keys. Empty is a state, not an absence — see the header. */
  rows: DiffRow[]
  /**
   * What an empty `rows` says, when the caller can say it better than the
   * default can. *"Retention is already 30 days."* beats *"nothing changes"* at
   * the one moment somebody is wondering whether the form took their input.
   */
  emptyNote?: string
}

const NOTHING_CHANGES = 'Nothing changes — every value is already what this would set it to.'

/**
 * A second signal for the word, not a replacement for it. `−` is U+2212, not a
 * hyphen: at 12px a hyphen beside a `+` reads as a gap.
 */
const GLYPH: Record<DiffState, string> = {
  added: '+',
  removed: '−',
  changed: '→',
  unchanged: '=',
}

/**
 * One value cell's content. Absent and empty are different facts about a
 * configuration key and a blank cell states neither — which matters most in the
 * column that says what a field is TODAY, since "this key is not set" and "this
 * key is set to nothing" have different consequences on a destination body.
 */
function Value({ text }: { text?: string | null }) {
  if (text === null || text === undefined) return <span className="kvd-absent">not set</span>
  if (text === '') return <span className="kvd-absent">empty</span>
  return <>{text}</>
}

export function DiffTable({ caption, rows, emptyNote }: DiffTableProps) {
  if (rows.length === 0) {
    // A sentence, not a table with no rows. The caption is kept because the
    // reader still has to know which object nothing is happening to.
    return <p className="kvd-empty">{caption} — {emptyNote ?? NOTHING_CHANGES}</p>
  }

  return (
    // The wrapper scrolls rather than the page. Value cells wrap (see App.css),
    // so this only ever engages on a single unbroken token wider than the
    // dialog — a base64 blob, a long URL — which is exactly the case where
    // clipping it would hide the part that differs.
    <div className="kvd-wrap">
      <table className="dtable">
        <caption className="kvd-cap">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Change</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const state = diffState(row)
            return (
              <tr key={row.key}>
                {/* The field name is what a reader quotes back and what they
                    check against their own config, so it is the row header and
                    it is mono. */}
                <th scope="row" className="dtable-id dtable-mono">{row.key}</th>
                <td className={`kvd-state kvd-${state}`}>
                  <span aria-hidden="true">{GLYPH[state]}</span> {state}
                </td>
                <td className="kvd-val"><Value text={row.before} /></td>
                <td className="kvd-val"><Value text={row.after} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
