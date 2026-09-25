// The test environment behaving like a browser where the app relies on it.
//
// happy-dom is not a browser, and where it differs in a way a component depends
// on, a test can pass while the component it renders is throwing. This file
// holds the fixes src/vitest.setup.ts makes to the environment, so a happy-dom
// upgrade or a setup edit that drops one fails here, by name, rather than as a
// stack trace on stderr beside a green run.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RadioGroup, RadioTile } from '@capra/core'

describe('the click-in-progress flag', () => {
  it('a click() made while the same element is already clicking does nothing', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    let clicks = 0
    button.addEventListener('click', () => {
      clicks++
      button.click()
    })
    expect(() => button.click()).not.toThrow()
    expect(clicks).toBe(1)
    // …and the flag is cleared afterwards: a second, separate click fires.
    button.click()
    expect(clicks).toBe(2)
    button.remove()
  })

  describe("Capra's RadioTile, which re-clicks its own input from the tile", () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    })

    afterEach(() => {
      act(() => root.unmount())
      container.remove()
      vi.restoreAllMocks()
    })

    it('selects on a click without overflowing the stack', async () => {
      const errors: unknown[] = []
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
      const picked: string[] = []
      await act(async () => {
        root.render(
          <RadioGroup name="h" value="a" onChange={(e) => picked.push(e.target.value)}>
            <RadioTile value="a">A</RadioTile>
            <RadioTile value="b">B</RadioTile>
          </RadioGroup>,
        )
      })
      const b = container.querySelector<HTMLInputElement>('input[value="b"]')
      await act(async () => {
        b?.click()
      })
      expect(errors).toEqual([])
      expect(picked).toEqual(['b'])
    })
  })
})

describe('fetch that no test stubbed', () => {
  /** What src/vitest.setup.ts records for each such call, cleared here so this
   *  file's deliberate call does not fail its own teardown. */
  const unstubbed = () => (globalThis as { __unstubbedFetches?: string[] }).__unstubbedFetches

  it('is refused without reaching the network, and recorded by URL', async () => {
    // happy-dom's own fetch would open a real socket to its page origin. When
    // a test left one in flight, the window's teardown aborted it and printed
    // a DOMException [AbortError] beside a green run.
    await expect(fetch('/capi/m/default_search/search/jobs/x/metrics')).rejects.toThrow(/no test stubbed/)
    expect(unstubbed()).toEqual(['/capi/m/default_search/search/jobs/x/metrics'])
    unstubbed()!.length = 0
  })

  it('reaches a stub a test installs, and the refusal again once it is removed', async () => {
    vi.stubGlobal('fetch', async () => new Response('ok'))
    await expect((await fetch('/a')).text()).resolves.toBe('ok')
    vi.unstubAllGlobals()
    await expect(fetch('/b')).rejects.toThrow(/no test stubbed/)
    unstubbed()!.length = 0
  })
})
