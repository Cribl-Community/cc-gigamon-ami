// The dataset-intelligence offer, against the sample-data verdict.
//
// A known gap in CLAUDE.md ("Sample data") until 2026-09-25,
// `fix/sample-data-known-gaps`: while the app read the pack's sample, this
// banner still offered to generate an AI schema summary for `gigamon_ami` —
// a dataset with nothing in it. It must offer nothing for `gigamon_ami` until
// the verdict is a final real one, nothing for `gigamon_ami_sample` ever (the
// records are synthetic), come back on its own when the verdict turns real,
// and write nothing on load either way.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTEL_REFUSED_NO_DATA, INTEL_REFUSED_SAMPLE, generateDatasetIntel, intelRefusal } from '../cribl/datasetIntel'
import { settleDatasetTarget } from '../cribl/datasetTarget'
import { SAMPLE_DATASET } from '../queries/datasets'
import { useDatasetIntelBanner } from './DatasetIntelPrompt'

interface Call { method: string; url: string }
let calls: Call[] = []

function res(status: number, body: unknown) {
  return { ok: status < 400, status, statusText: 'x', headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }
}

/** Whether the Lake listing (the verdict's own re-read) never answers. */
let listingHangs = false

function stub(): void {
  calls = []
  listingHangs = false
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = init.method ?? 'GET'
    calls.push({ method, url: u })
    if (listingHangs && u.includes('/lakes/default/datasets')) return new Promise(() => {})
    if (u.endsWith('/ai/settings/features')) return res(200, { copilot_chatbot: true })
    if (u.includes('/ai/settings/dataset-intelligence/')) return method === 'POST' ? res(201, { status: 'processing' }) : res(404, {})
    return res(404, {})
  })
}

const intelCalls = () => calls.filter((c) => c.url.includes('/ai/settings/'))
const writes = () => calls.filter((c) => c.method !== 'GET')

function Probe() {
  const b = useDatasetIntelBanner()
  if (!b) return null
  return (
    <div data-testid="intel">
      <strong>{b.title}</strong>
      <div>{b.body}</div>
      {b.action}
    </div>
  )
}

let container: HTMLDivElement
let root: Root
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const shown = () => container.querySelector('[data-testid="intel"]')?.textContent ?? ''

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // No viewer: prefs.ts answers the defaults, so `intelPromptDismissed` is a definite false.
  vi.stubGlobal('getCriblUser', () => Promise.resolve(null))
  stub()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount() {
  await act(async () => { root.render(<Probe />) })
  await settle()
}

describe('the dataset-intelligence banner and the sample-data verdict', () => {
  it('offers generation for gigamon_ami on a real verdict (the discrimination check)', async () => {
    settleDatasetTarget(false, 'has-data')
    await mount()
    expect(shown()).toContain('AI investigations aren’t grounded yet')
    expect(shown()).toContain('gigamon_ami')
    expect(writes(), 'nothing written on load').toEqual([])
  })

  it('offers nothing — and asks nothing — while the app reads the sample', async () => {
    settleDatasetTarget(true, 'real-empty')
    await mount()
    expect(shown()).toBe('')
    expect(intelCalls(), 'no probe of an empty dataset').toEqual([])
    expect(writes()).toEqual([])
  })

  it('offers nothing while the verdict is only past its hold deadline', async () => {
    // A provisional verdict is re-read by the first subscriber; hold that read
    // in the air, as a slow Lake API would.
    listingHangs = true
    settleDatasetTarget(false, 'deadline')
    await mount()
    expect(shown()).toBe('')
    expect(writes()).toEqual([])
  })

  // Review 2026-09-25: `realDataConfirmed` passed these two, which are real
  // only because nothing is known — the banner probed and offered Generate
  // for a `gigamon_ami` the probe could not see into.
  it.each(['probe-failed', 'unreadable'] as const)('offers nothing, and asks nothing, on a real verdict reached only by doubt (%s)', async (reason) => {
    settleDatasetTarget(false, reason)
    await mount()
    expect(shown()).toBe('')
    expect(intelCalls(), 'no probe').toEqual([])
    expect(intelRefusal()).toBe(INTEL_REFUSED_NO_DATA)
    await expect(generateDatasetIntel()).rejects.toThrow(INTEL_REFUSED_NO_DATA)
    expect(writes()).toEqual([])
  })

  it('offers generation where there is no sample dataset at all, as before sample data existed', async () => {
    settleDatasetTarget(false, 'no-sample')
    await mount()
    expect(shown()).toContain('AI investigations aren’t grounded yet')
    expect(intelRefusal()).toBeNull()
  })

  it('comes back on its own when the verdict turns real, and goes when it turns sample', async () => {
    settleDatasetTarget(true, 'real-empty')
    await mount()
    expect(shown()).toBe('')
    await act(async () => { settleDatasetTarget(false, 'probe-found') })
    await settle()
    expect(shown()).toContain('AI investigations aren’t grounded yet')
    await act(async () => { settleDatasetTarget(true, 'real-empty') })
    await settle()
    expect(shown()).toBe('')
    expect(writes(), 'a verdict change is a read, never a write').toEqual([])
  })

  it('a verdict that turns sample after render takes Generate away, and nothing is sent', async () => {
    settleDatasetTarget(false, 'has-data')
    await mount()
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Generate'))
    expect(button).toBeDefined()
    // The verdict moves after the banner rendered, before the click lands.
    settleDatasetTarget(true, 'real-empty')
    await act(async () => { button?.click() })
    await settle()
    expect(writes()).toEqual([])
  })
})

describe('generateDatasetIntel refuses what a summary would misdescribe', () => {
  it('never the sample dataset, whatever the verdict', async () => {
    settleDatasetTarget(false, 'has-data')
    expect(intelRefusal(SAMPLE_DATASET)).toBe(INTEL_REFUSED_SAMPLE)
    await expect(generateDatasetIntel(SAMPLE_DATASET)).rejects.toThrow(INTEL_REFUSED_SAMPLE)
    expect(writes()).toEqual([])
  })

  it('not gigamon_ami until real data is confirmed', async () => {
    settleDatasetTarget(true, 'real-empty')
    expect(intelRefusal()).toBe(INTEL_REFUSED_NO_DATA)
    await expect(generateDatasetIntel()).rejects.toThrow(INTEL_REFUSED_NO_DATA)
    expect(writes()).toEqual([])
    settleDatasetTarget(false, 'has-data')
    expect(intelRefusal()).toBeNull()
    await generateDatasetIntel()
    expect(writes().map((c) => c.method)).toEqual(['POST'])
    expect(writes()[0].url).toMatch(/\/ai\/settings\/dataset-intelligence\/gigamon_ami$/)
  })
})
