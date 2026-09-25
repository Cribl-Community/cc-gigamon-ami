import { noteDenial } from './authz'
import { API_BASE, LAKE_DATASET } from './config'
import { datasetTarget, type DatasetTarget, type TargetReason } from './datasetTarget'
import { SAMPLE_DATASET } from '../queries/datasets'

/**
 * Cribl Search "dataset intelligence" — a generated schema/semantics summary the
 * Copilot agent reads before investigating a dataset.
 *
 * Without it the agent burns a reasoning step rediscovering the shape of the
 * data. Observed verbatim in an investigation against this dataset:
 *   "The schema summary wasn't available for this dataset, so I'll inspect a
 *    small set of representative AMI records to confirm the field names…"
 *
 * Contract (verified): POST kicks off an async agent run and returns 201 with
 * status=processing; poll GET until status is complete | partial | failed.
 * A GET before any run has happened returns 404.
 */
export type IntelStatus = 'missing' | 'processing' | 'partial' | 'complete' | 'failed' | 'unknown'

export interface DatasetIntel {
  status: IntelStatus
  content?: string
  generatedAt?: number
  updatedAt?: number
}

const url = (dataset = LAKE_DATASET) => `${API_BASE}/ai/settings/dataset-intelligence/${encodeURIComponent(dataset)}`

/** Current state. A 404 means "never generated", which is a normal state, not an error. */
export async function getDatasetIntel(signal?: AbortSignal, dataset = LAKE_DATASET): Promise<DatasetIntel> {
  const res = await fetch(url(dataset), { signal })
  if (res.status === 404) return { status: 'missing' }
  if (!res.ok) return { status: 'unknown' }
  const body = (await res.json()) as { status?: string; content?: string; generatedAt?: number; updatedAt?: number }
  const s = body.status
  const status: IntelStatus =
    s === 'processing' || s === 'partial' || s === 'complete' || s === 'failed' ? s : 'unknown'
  return { status, content: body.content, generatedAt: body.generatedAt, updatedAt: body.updatedAt }
}

/**
 * The verdicts on which a summary of `gigamon_ami` may be offered and started.
 *
 * Stricter than `realDataConfirmed` (the rule for turning a schedule on), which
 * also passes `unreadable` and `probe-failed`: those are REAL because nothing
 * is known, the answer that never shows sample data over a customer's own — not
 * evidence that `gigamon_ami` holds anything. `probe-failed` happens only when
 * the sample dataset exists beside a `gigamon_ami` whose size figure is zero or
 * missing, exactly the doubtful case a summary would describe as empty. The
 * three kept are `has-data` and `probe-found` (data seen) and `no-sample` (no
 * sample dataset at all, so the question this rule asks does not arise: the
 * banner behaves as it did before sample data existed). Corrected 2026-09-25,
 * `fix/sample-data-known-gaps`, after review: this used `realDataConfirmed`.
 */
const INTEL_REASONS: readonly TargetReason[] = ['no-sample', 'has-data', 'probe-found']

export function intelAllowed(t: DatasetTarget): boolean {
  return t.known && !t.sample && INTEL_REASONS.includes(t.reason)
}

/**
 * Why generation would be refused for `dataset` now, or null when it may go.
 *
 * Two refusals, both about WHAT a summary would describe, never about who may
 * write it (that is the gate's job):
 *   * the sample dataset, always: its records are synthetic, and a summary the
 *     Copilot agent reads as the shape of real traffic would describe the
 *     pack's generator instead;
 *   * `gigamon_ami` unless the dataset verdict is one `intelAllowed` passes:
 *     while the app reads the sample, the customer's dataset holds nothing to
 *     summarise; while the verdict is still out or only past its hold deadline
 *     it may yet say so; and on a real verdict reached only by doubt (an
 *     unreadable listing, a failed probe) nothing says it holds anything.
 * The banner does not offer either (components/DatasetIntelPrompt.tsx); this is
 * the same rule held at the write, so a click that raced a verdict sends nothing.
 */
export function intelRefusal(dataset: string = LAKE_DATASET): string | null {
  if (dataset === SAMPLE_DATASET) return INTEL_REFUSED_SAMPLE
  if (!intelAllowed(datasetTarget())) return INTEL_REFUSED_NO_DATA
  return null
}

export const INTEL_REFUSED_SAMPLE = `Not started: ${SAMPLE_DATASET} holds synthetic sample data, so a summary of it would describe the generator, not your traffic.`
export const INTEL_REFUSED_NO_DATA = `Not started: ${LAKE_DATASET} has no data confirmed yet, so there is nothing to summarise.`

/**
 * Kick off generation. Returns immediately — the caller should poll.
 *
 * This module talks to `fetch` directly rather than through cribl/capi.ts, so a
 * refusal has to be reported to cribl/authz.ts here: without it the control that
 * asked for this would only ever learn "Could not start generation (403)", which
 * names neither the object nor what anybody could do about it.
 */
export async function generateDatasetIntel(dataset = LAKE_DATASET): Promise<void> {
  const refused = intelRefusal(dataset)
  if (refused !== null) throw new Error(refused)
  const path = `/ai/settings/dataset-intelligence/${encodeURIComponent(dataset)}`
  const res = await fetch(url(dataset), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok && res.status !== 201) {
    noteDenial('POST', path, res.status)
    throw new Error(`Could not start generation (${res.status})`)
  }
}

/** Whether the tenant has AI features switched on at all. */
export async function aiEnabled(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/ai/settings/features`, { signal })
    if (!res.ok) return false
    const f = (await res.json()) as Record<string, boolean>
    return Boolean(f.copilot_chatbot || f.agentic_search)
  } catch {
    return false
  }
}
