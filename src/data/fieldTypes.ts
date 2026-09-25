// What each AMI field holds, string or number — the TYPE table the Phase 8
// query router reads (cribl/routing/eligibility.ts).
//
// EMPTY, ON PURPOSE, UNTIL IT IS MEASURED. Phase 8 design §1.2 / §8.0b: the
// table is filled from one `gettype` census on the JSON dataset, never from the
// pipeline's cast list alone ("not cast" does not mean "string": a raw JSON
// number stays a number, and `http_code` was assumed numeric and is a string).
// A field that is not here has an UNKNOWN type, and a query reading it is not
// eligible to leave JSON — the router refuses rather than guesses.
//
// `mixed` means some Parquet files hold the field as a string: a file holding a
// string makes the whole column STRING (measured 2026-09-24), `dcount` then
// splits 10 from "10", and that query is class T.
//
// It lives in src/data because it is data that moves a number without ever
// appearing in a query string (it decides which dataset answers), so the
// display freeze holds it as a catalog. An entry is added with the census's
// date and window in the commit that adds it.
//
// A type-only import, erased before the extractor loads this under plain Node.
import type { FieldType } from '../cribl/parity'

export const FIELD_TYPES: Readonly<Record<string, FieldType>> = Object.freeze({})
