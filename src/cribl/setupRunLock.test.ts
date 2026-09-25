// One Guided Setup run at a time: the lock both panels take before their
// first write. What is held: a second taker gets nothing, the lock comes back
// once, and giving it back twice cannot free somebody else's hold.

import { afterEach, describe, expect, it } from 'vitest'
import { acquireSetupRun, resetSetupRunLock, setupRunHolder } from './setupRunLock'

afterEach(() => resetSetupRunLock())

describe('setupRunLock', () => {
  it('lets one run hold it, and refuses the other panel while it does', () => {
    const release = acquireSetupRun('onboarding_pack')
    expect(release).not.toBeNull()
    expect(setupRunHolder()).toBe('onboarding_pack')
    expect(acquireSetupRun('onboarding_stack')).toBeNull()
    expect(acquireSetupRun('onboarding_pack')).toBeNull()
    release!()
    expect(setupRunHolder()).toBeNull()
  })

  it('a second release of an old hold does not free the next one', () => {
    const first = acquireSetupRun('onboarding_stack')!
    first()
    const second = acquireSetupRun('onboarding_pack')!
    first()
    expect(setupRunHolder()).toBe('onboarding_pack')
    second()
    expect(setupRunHolder()).toBeNull()
  })
})

// What this file could not assert: that each panel takes the lock before its
// first write — OnboardingPanel.test.tsx and ProvisionPanel.test.tsx press the
// buttons while it is held.
