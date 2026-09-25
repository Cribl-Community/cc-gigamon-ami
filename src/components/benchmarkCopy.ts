// Every sentence <BenchmarkPanel> says that is not computed from a result.
// Pure and DOM-free, like the other panels' copy modules, so a test can hold the
// words without rendering anything.
//
// Guided Setup's convention: one short lead line on screen, the rest behind an
// ⓘ on the heading, row label or column it explains; no internal project
// history (no spike, phase or decision ids, no measurement dates) in visible
// text or in a tip. The evidence for each claim lives in the code comments of
// cribl/benchmark.ts and cribl/benchmarkPlan.ts.

import { PARQUET_DATASET } from '../cribl/benchmarkPlan'
import { REAL_DATASET } from '../queries/datasets'

export const BENCH_TITLE = 'Store benchmark'

export const BENCH_LEAD = 'Times the same searches against each Cribl Lake copy of the data — one minute first.'

export const BENCH_LEAD_TIP =
  `Runs a set of this app’s own searches against ${REAL_DATASET} and, when it exists and holds data, its Parquet copy ` +
  `${PARQUET_DATASET} — one at a time, with result reuse off. The one-minute stage runs each search once and shows the ` +
  'work it did. Only then is the 15-minute stage offered: each search four times per store, the first discarded as a ' +
  'warm-up, reporting median server time, client wall time, the gap between them, and the work done. A fastest store is ' +
  'named only when the stores answered the same question — the same rows, value for value, for the row count and the ' +
  'duplicate-ACK trend (whose number of rows matches whatever the stores hold); the same number of rows for the ' +
  'application-by-source scan — and not on a tie. The opening-tiles scan is never given one. Nothing is saved — the results stay on this page ' +
  'until you leave it — and nothing here changes which dataset any dashboard reads.'

export const SEARCHES_LEGEND = 'Searches'
export const SEARCHES_TIP =
  'Each is the exact query a panel or scheduled search of this app runs; the ⓘ beside it shows the text. On the Parquet ' +
  'copy the same text runs with only its dataset changed.'

export const PARQUET_QUERY_ABOUT =
  `The same search on the Parquet copy, ${PARQUET_DATASET}: only the dataset it names changes.`

export const PARQUET_CHOICE = `Also measure the Parquet copy (${PARQUET_DATASET})`
export const STORE_LINE = `Store: Cribl Lake · JSON (${REAL_DATASET})`

export const CHECKING_STORES = 'Checking which stores exist…'
export const NO_SEARCH = 'Select at least one search.'

export const ONE_LABEL = 'Measure one minute'
export const FIFTEEN_LABEL = 'Run the 15-minute benchmark'
export const STOP_LABEL = 'Stop'

export const ONE_HEADING = 'One-minute stage'
export const FIFTEEN_HEADING = '15-minute benchmark'

export const ONE_STAGE_TIP =
  'One run of each search on each store, so its work can be seen before anything larger runs. A single cold run is not ' +
  'a timing result, so this stage names no fastest store.'

export const WINDOW_TIP =
  'An absolute window on whole minutes, ending ten minutes ago, so every store has landed every record in it. Every run ' +
  'of a stage reads the same window.'

export const COLUMN_TIPS = Object.freeze({
  rows:
    'Rows the search produced. Stores that return different numbers of rows did not answer the same question, so no ' +
    'fastest store is named. Equal row counts do not prove equal values: for the row count and the duplicate-ACK trend ' +
    'the values are compared as well.',
  work:
    'Billable CPU-seconds, as Cribl reports them for the job: the work the store did to answer. Reported, never used ' +
    'to pick a winner. “Not reported” means Cribl’s meter did not answer, not that the search was free.',
  server: 'The job’s own start-to-finish time, from its record in Cribl Search. The verdict is taken from this.',
  client:
    'From submitting the search to having its rows in this browser: the server time plus status checks, admission and ' +
    'the download.',
  overhead:
    'Client wall minus server time: what this app and the network add on top of the store. No storage format moves it.',
  runs: 'Measured runs that completed. Each store also ran one warm-up first, which is discarded.',
})

export const RESULTS_KEPT_TIP =
  'Nothing here is stored. Leaving the page drops these results, and running a stage again replaces that stage’s table.'

export const CONSEQUENCES = Object.freeze({
  sequential: 'Runs one search at a time, with result reuse off, so Cribl runs every one in full.',
  writesNothing: 'Writes nothing: no configuration, no saved search, nothing stored by this app.',
  stoppable: 'Stop, or leaving this page, cancels the search that is running.',
  warmup: 'The first run of each search on each store is a warm-up and is not reported.',
})

export const STOPPED_NOTE = 'Stopped before every run finished. Nothing is inferred from the runs that did not happen.'
export const STOPPED_VERDICT = 'No verdict: the stage was stopped before every run finished.'
export const RUNNING_VERDICT = 'Measuring — the verdict comes when every run has finished.'

export const NOT_REPORTED = 'not reported'

export function oneTitle(searches: number): string {
  return `Measure one minute: ${searches} search${searches === 1 ? '' : 'es'} on Cribl Search`
}

export function fifteenTitle(searches: number): string {
  return `Run the 15-minute benchmark: ${searches} searches on Cribl Search`
}

export function progressWords(done: number, total: number, label: string, dataset: string, warmup: boolean): string {
  return `Running ${done + 1} of ${total}: ${label} on ${dataset}${warmup ? ' (warm-up, not reported)' : ''}`
}

const hhmm = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function windowWords(w: { earliest: number; latest: number }): string {
  return `${hhmm(w.earliest)}–${hhmm(w.latest)}, local time`
}

export function disagreeWords(label: string): string {
  return `${label}: the stores returned different numbers of rows over this minute, so they did not answer the same question.`
}

export function valuesDisagreeWords(label: string): string {
  return `${label}: the stores returned the same number of rows but different values over this minute, so they did not answer the same question.`
}
