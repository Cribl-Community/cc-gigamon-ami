// Guided Setup persistence — the last Git commit that touched each provisioned
// artifact, per worker group. Shown on each resource row until a newer commit
// for that artifact supersedes it, and durable across reloads and sign-out/in.
//
// Stored in the app-scoped Cribl KV store. `CRIBL_API_URL + '/kvstore/<key>'`
// is rewritten by the platform proxy to `/api/v1/a/{appId}/kvstore/<key>` with
// the app's identity + auth, so it's server-side, per-app, and shared across
// sessions and users. App-scoped kvstore paths need no policies.yml entry (see
// AGENTS.md). We use the KV store exclusively — never browser storage, which is
// unreliable in the sandbox.
//
// Where this works: anywhere the app runs inside Cribl — including the in-UI
// "Preview" — because there `window.CRIBL_API_URL` is set and the platform proxy
// injects the `/a/{appId}/` scope. The ONLY place it's inert is the local
// `npm run dev` server (localhost:5173): that Vite proxy just rewrites
// `/capi` → `/api/v1` (see vite.config.ts) without the app-scope segment, and the
// dev `CRIBL_APP_ID` (`__dev__<name>`) isn't a registered app — so app-scoped
// kvstore calls 404 there. In-session React state still shows commits during
// localhost dev; use Cribl's Preview to verify real KV durability.

import { API_BASE } from './config'

export interface CommitInfo {
  hash: string
  message: string
}

/** group id → resource key → last commit that touched it. */
export type CommitMemory = Record<string, Record<string, CommitInfo>>

const KV_KEY = 'guided_setup_memory/commits'

function coerce(raw: unknown): CommitMemory {
  // Some KV backends wrap the stored value as `{ value: ... }` — unwrap if so.
  const obj = (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>))
    ? (raw as { value: unknown }).value
    : raw
  return obj && typeof obj === 'object' ? (obj as CommitMemory) : {}
}

/** Load the persisted commit memory from the app KV store. Returns {} when the
 *  key is absent or the store is unavailable. */
export async function loadCommitMemory(): Promise<CommitMemory> {
  try {
    const res = await fetch(`${API_BASE}/kvstore/${KV_KEY}`)
    if (!res.ok) return {}
    const text = await res.text()
    if (!text) return {}
    return coerce(JSON.parse(text))
  } catch {
    return {}
  }
}

/** Persist the full commit memory to the app KV store. Best-effort — failures
 *  are swallowed so provisioning is never blocked by a persistence hiccup. */
export async function saveCommitMemory(mem: CommitMemory): Promise<void> {
  try {
    await fetch(`${API_BASE}/kvstore/${KV_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mem),
    })
  } catch {
    /* best-effort; in-session state still holds the value */
  }
}
