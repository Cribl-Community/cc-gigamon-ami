// The worker group Guided Setup is working on — ONE per page, shared by every
// panel that writes to a group.
//
// Extracted from ProvisionPanel, where it was three useStates and two effects,
// because the onboarding panel needs the same group: two pickers on one page
// that could disagree would let one panel's confirmation name a group the other
// panel is not showing. So the state lives here, in a module-level store read
// through `useSyncExternalStore`, and every panel reads the same answer.
//
// WHAT IT KEEPS FROM THE ORIGINAL, line for line in behaviour:
//   * the selectable groups, read once (best-effort: on failure the default
//     group alone, so the page still works);
//   * the viewer's remembered pick, read once from the KV store — a READ, never
//     a write, on mount; `groupReady` flips whatever comes back, because a slow
//     or absent store leaving the page stuck on "Checking…" is the worse bug;
//   * picking writes one field of this viewer's own preference document, from
//     the change event only, and a refused write is reported as a toast.
//
// LIFETIME. The store starts reading when its first panel mounts and forgets
// everything when its last one unmounts, so leaving Guided Setup and coming
// back reads the remembered group again — exactly what a remount of the old
// ProvisionPanel did. A read still out when the last panel unmounts is ignored
// (`generation`), so it cannot land on the next visit.

import { useCallback, useSyncExternalStore } from 'react'
import { pushToast } from './Toast'
import { DEFAULT_STREAM_GROUP, listStreamGroups, type StreamGroup } from '../cribl/provision'
import { loadSetupGroup, saveSetupGroup } from '../cribl/setupMemory'

export interface SetupGroupState {
  /** The group every Guided Setup panel is working on. */
  group: string
  /** The Stream worker groups the picker offers. */
  groups: readonly StreamGroup[]
  /** Whether the viewer's remembered group has been read yet. A panel's first
   *  status check waits on it, so it checks the group the viewer works in. */
  groupReady: boolean
}

const INITIAL: SetupGroupState = Object.freeze({
  group: DEFAULT_STREAM_GROUP,
  groups: Object.freeze([{ id: DEFAULT_STREAM_GROUP, name: DEFAULT_STREAM_GROUP }]),
  groupReady: false,
})

let state: SetupGroupState = INITIAL
let subscribers = 0
let generation = 0
const listeners = new Set<() => void>()

function set(next: Partial<SetupGroupState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

/** The two reads, once per visit. */
function start(): void {
  const gen = ++generation
  void listStreamGroups()
    .then((gs) => { if (gen === generation && gs.length) set({ groups: gs }) })
    .catch(() => { /* keep the default-only list */ })
  const apply = (saved: string | null) => {
    if (gen !== generation) return
    set(saved ? { group: saved, groupReady: true } : { groupReady: true })
  }
  void loadSetupGroup().then(apply, () => apply(null))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (subscribers++ === 0) start()
  return () => {
    listeners.delete(listener)
    if (--subscribers === 0) {
      generation++
      state = INITIAL
    }
  }
}

const getState = () => state

/**
 * Pick a group. A deliberate user action, which is what makes it the place a
 * screen may write from: one field of this viewer's own preferences, no
 * customer configuration. Answers whether it was remembered.
 */
export async function pickSetupGroup(gid: string): Promise<boolean> {
  set({ group: gid })
  if (await saveSetupGroup(gid)) return true
  pushToast({
    kind: 'error',
    text: `Could not remember ${gid} as your worker group — this tab will open on ${DEFAULT_STREAM_GROUP} next time.`,
  })
  return false
}

/** The page's worker group, and the picker's change handler. */
export function useSetupGroup(): SetupGroupState & { pickGroup: (gid: string) => Promise<boolean> } {
  const s = useSyncExternalStore(subscribe, getState, getState)
  const pickGroup = useCallback((gid: string) => pickSetupGroup(gid), [])
  return { ...s, pickGroup }
}
