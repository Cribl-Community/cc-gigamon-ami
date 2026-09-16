import { noteDenial } from './authz'
import { API_BASE, LAKE_DATASET } from './config'

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
 * Kick off generation. Returns immediately — the caller should poll.
 *
 * This module talks to `fetch` directly rather than through cribl/capi.ts, so a
 * refusal has to be reported to cribl/authz.ts here: without it the control that
 * asked for this would only ever learn "Could not start generation (403)", which
 * names neither the object nor what anybody could do about it.
 */
export async function generateDatasetIntel(dataset = LAKE_DATASET): Promise<void> {
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
