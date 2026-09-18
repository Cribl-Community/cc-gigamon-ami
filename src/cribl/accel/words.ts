// The hourly snapshots described in the words a reader gets, in one place.
//
// `<PanelInfo computed>` asks each panel for a `cadence` and a `window` in
// English — "once a day, at 00:10 UTC", "the last 30 days" — because block 4 of
// an ⓘ is prose, not a cron expression. The overview entry feeds five panels on
// five tabs, and five copies of that sentence is five chances for one of them to
// keep saying "every 15 minutes" after the schedule moved.
//
// Not derived from the cron: turning `20 * * * *` into "at 20 minutes past every
// hour, UTC" is a cron formatter, and manifest.ts already explains why this
// codebase does not have one. The pinning is a test that fails when the cron
// moves and this sentence does not.

/** How often the overview and service-map scans fire. All three are hourly. */
export const HOURLY_CADENCE = 'once an hour, at 20 past the hour UTC'

/**
 * The window they read.
 *
 * Both halves matter to a reader comparing the number with the range picker:
 * how much data, and that it stops short of now. The three minutes are not
 * rounding — a window running up to `now` reports a partial minute and a
 * part-flushed file as whole ones.
 */
export const SNAPSHOT_WINDOW = 'fifteen minutes, ending three minutes before the run'

/** The overview entry's cadence sentence, pinned to the entry it describes. */
export const OVERVIEW_CADENCE = HOURLY_CADENCE
export const OVERVIEW_WINDOW = SNAPSHOT_WINDOW
