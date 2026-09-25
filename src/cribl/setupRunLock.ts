// One Guided Setup run at a time, across every panel on the page.
//
// Two panels on Guided Setup commit and deploy a worker group: the Raw HTTP
// stack's (ProvisionPanel) and the onboarding pack's (OnboardingPanel). Each
// used to guard only its own `running` state, so nothing stopped a Remove on
// one panel from committing and deploying while an Onboard on the other was
// half way through its own commit. Two commits racing on one Leader can each
// carry the other's files, and two deploys restart the group's Worker
// Processes twice. So the lock is module state that both panels read, and a
// run takes it before its first write and gives it back when it ends.
//
// ONE LOCK FOR THE PAGE, NOT ONE PER GROUP. Per group would be the narrower
// rule, and the page only ever works on one group (useSetupGroup), so the two
// are the same thing here; the wider one cannot be wrong if that ever changes.
//
// Session memory only: nothing writes it anywhere, and a reload clears it —
// which is right, because a run does not survive a reload either.

import { useSyncExternalStore } from 'react'

/** Who holds the lock: a word for the step log, never shown as a reason alone. */
export type SetupRunHolder = 'onboarding_stack' | 'onboarding_pack'

let holder: SetupRunHolder | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/**
 * Take the lock for a run. Answers the function that gives it back, or null
 * when another run holds it — in which case the caller writes nothing.
 * Giving it back twice is harmless.
 */
export function acquireSetupRun(who: SetupRunHolder): (() => void) | null {
  if (holder !== null) return null
  holder = who
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    holder = null
    emit()
  }
}

/** Who holds the lock right now, for code that is not a component. */
export function setupRunHolder(): SetupRunHolder | null {
  return holder
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Who holds the lock, in a component. */
export function useSetupRunHolder(): SetupRunHolder | null {
  return useSyncExternalStore(subscribe, setupRunHolder, setupRunHolder)
}

/** The sentence beside a control that cannot run because another one is. */
export const SETUP_RUN_BUSY = 'Another run is already in progress.'

/** Tests only. */
export function resetSetupRunLock(): void {
  holder = null
  emit()
}
