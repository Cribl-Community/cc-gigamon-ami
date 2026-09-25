// The gate on the gate: a control that triggers a write cannot ship ungated.
//
// WHY IT IS NOT A MARKUP LINT. The obvious version of this greps the JSX for
// `onClick` next to a verb — Deploy, Remove, Save, Apply — and fails when one is
// not wrapped. That heuristic is wrong in both directions from the day it lands:
// it flags "Cancel", "Re-check" and "Copy", it misses a button called "Go", and
// the first week of false positives is the week somebody adds it to the ignore
// list. It reads the layer where the write is DESCRIBED rather than the layer
// where the write IS.
//
// SO IT READS THE WRITES INSTEAD. A write cannot hide: it is a `capi('POST'…)`
// or a `fetch` carrying `method: 'POST'`, and this test finds every one of them
// in src/ and refuses to pass until each is named in WRITE_SITES
// (cribl/authz.ts) with its surface and its reason. The chain that closes is:
//
//   a new write call        → must be declared in WRITE_SITES
//   declared `config`       → must name at least one WriteId
//   a WriteId               → must exist in GATED_WRITES
//   an entry in GATED_WRITES→ must be rendered by a <GatedControl write="…">
//
// Every link fails closed. The only way past it is to classify a Cribl
// configuration write as `app` or `search` — a visible, reviewable untruth in a
// file whose entire purpose is that classification, which is the best a test can
// do about somebody determined to lie to it.
//
// WHAT IT STILL CANNOT PROVE, stated rather than implied: that the button a
// customer actually presses is the gated one. If a `config` write has a
// GatedControl somewhere on the screen AND a second, plain button that calls the
// same handler, this passes. Deciding otherwise needs dataflow analysis of
// arbitrary React — the same wall src/queries/display-freeze.test.ts documents
// for query attribution — and a heuristic that guesses at it would go green on
// the case it was written for. Read the tab.
//
// IF THIS TEST FAILS, it names the file, the function and which link broke. None
// of the fixes is more than a few lines; all of them are a decision somebody
// should be making on purpose.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GATED_WRITES, WRITE_SITES, type WriteId } from '../cribl/authz'
import { UNREACHED_MODULES } from '../cribl/paths'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/** HTTP methods that change something. GET and HEAD are not this test's business. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

interface SourceFile { rel: string; text: string }

/**
 * The source with its full-line comments removed.
 *
 * Needed because this file's own subject matter gets written ABOUT in comments —
 * `<GatedControl>` appears in three module headers explaining the design, and a
 * scan that counted those would report controls nobody renders. Only whole-line
 * `//` comments and `/* *\/` blocks go, so nothing that could be code is
 * touched, and the line numbering is preserved for the messages.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length))
}

function sources(): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      // Tests are excluded, this one included: they are full of the literals
      // this scan looks for, and none of them ships.
      if (/\.test\.tsx?$/.test(entry.name)) continue
      out.push({ rel: relative(SRC, full).replace(/\\/g, '/'), text: withoutComments(readFileSync(full, 'utf-8')) })
    }
  }
  walk(SRC)
  return out
}

/**
 * The nearest top-level declaration above an offset — the function the call sits
 * in. Top-level only (column zero) on purpose: a write buried in a nested
 * closure would be attributed to something unhelpful, and this codebase does not
 * have one. If it ever does, this answers null and the test says so rather than
 * guessing.
 */
function enclosingFunction(text: string, index: number): string | null {
  const before = text.slice(0, index).split('\n')
  for (let i = before.length - 1; i >= 0; i--) {
    const m =
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(before[i]) ??
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(before[i])
    if (m) return m[1]
  }
  return null
}

interface Found { at: string; method: string; where: string }

/** Every write request the source makes, as `<file>#<function>`. */
function writeCalls(): { found: Found[]; unreadable: string[] } {
  const found: Found[] = []
  const unreadable: string[] = []

  for (const { rel, text } of sources()) {
    const site = (index: number, method: string) => {
      const fn = enclosingFunction(text, index)
      const line = text.slice(0, index).split('\n').length
      if (!fn) {
        unreadable.push(`${rel}:${line} — a ${method} outside any top-level function`)
        return
      }
      found.push({ at: `${rel.replace(/\.tsx?$/, '')}.ts#${fn}`, method, where: `${rel}:${line}` })
    }

    // cribl/capi.ts — the transport every configuration and KV call uses.
    for (const m of text.matchAll(/\bcapi\(\s*([^,)]*)/g)) {
      const i = m.index
      // Skip the declaration itself: `export async function capi(method, …)`.
      if (text.slice(Math.max(0, i - 9), i) === 'function ') continue
      const arg = m[1].trim()
      const literal = /^'([A-Za-z]+)'$/.exec(arg)
      if (!literal) {
        // A computed method makes the call invisible to this scan, and an
        // invisible write is exactly what this test exists to prevent.
        unreadable.push(`${rel}:${text.slice(0, i).split('\n').length} — capi() called with a method this scan cannot read (${arg || 'nothing'})`)
        continue
      }
      const method = literal[1].toUpperCase()
      if (WRITE_METHODS.has(method)) site(i, method)
    }

    // Raw fetch, and this app's own wrappers around it (cribl/search.ts builds
    // its init and hands it to `api` → `fetchRetry` → `fetch`, so the method
    // literal is several frames from the send). A `method:` literal therefore
    // counts anywhere in a file that CALLS fetch — but only in such a file,
    // because cribl/paths.ts is a table of every path and method the app uses
    // and a scan that took a data row for a call would report the entire API
    // surface as undeclared writes. The limit that leaves: a write in a module
    // that neither calls `fetch` nor `capi` is invisible here. Nothing can send
    // a request without one of them today, and exporting a new transport to get
    // around this would be a visible change that ought to update this file.
    if (text.includes('fetch(')) {
      for (const m of text.matchAll(/\bmethod:\s*'([A-Za-z]+)'/g)) {
        const method = m[1].toUpperCase()
        if (WRITE_METHODS.has(method)) site(m.index, method)
      }
    }
  }
  return { found, unreadable }
}

/** Every `<GatedControl write="…">` in the tree. `write` must be the first
 *  attribute — see the assertion below for why that is a rule and not a quirk. */
function gatedControls(): { declared: string[]; total: number } {
  const declared: string[] = []
  let total = 0
  for (const { text } of sources()) {
    // The component's own definition file names the prop in its type; only
    // element usages count.
    for (const _ of text.matchAll(/<GatedControl\b/g)) total++
    for (const m of text.matchAll(/<GatedControl\s+write="([^"]+)"/g)) declared.push(m[1])
  }
  return { declared, total }
}

const found = writeCalls()
const controls = gatedControls()
const declaredSites = new Set(WRITE_SITES.map((s) => s.at))

describe('every write is declared', () => {
  it('finds no write this scan cannot read', () => {
    expect(
      found.unreadable,
      'A write request was found that this scan cannot attribute to a function, or a capi() call whose method is not a literal. ' +
        'Either is a hole in the chain — write the method as a literal, or keep the call in a top-level function.',
    ).toEqual([])
  })

  it('names every write call in WRITE_SITES', () => {
    const undeclared = [...new Set(found.found.filter((f) => !declaredSites.has(f.at)).map((f) => `${f.method} at ${f.where} (${f.at})`))]
    expect(
      undeclared,
      'A new write arrived without anybody saying which control owns it. Add it to WRITE_SITES in src/cribl/authz.ts with ' +
        'its surface and the reason it exists; if its surface is "config", it also needs a WriteId and a <GatedControl> for it.',
    ).toEqual([])
  })

  it('keeps WRITE_SITES true — no entry for a write that is gone', () => {
    const live = new Set(found.found.map((f) => f.at))
    const stale = WRITE_SITES.map((s) => s.at).filter((at) => !live.has(at))
    expect(
      stale,
      'WRITE_SITES names a function that no longer writes anything. A declaration file that has drifted is worse than none, ' +
        'because the next person reads it as the inventory. Delete the entry with the code.',
    ).toEqual([])
  })
})

describe('every configuration write has a gate', () => {
  it('gives each config write at least one control', () => {
    const ungated = WRITE_SITES.filter((s) => s.surface === 'config' && s.gates.length === 0).map((s) => s.at)
    expect(
      ungated,
      'A write to customer configuration has no control that owns it. Either name the WriteId whose button reaches it, or — if ' +
        'nothing on screen triggers it — say so and classify it honestly.',
    ).toEqual([])
  })

  it('names only gates that exist', () => {
    const ids = new Set(Object.keys(GATED_WRITES))
    const unknown = WRITE_SITES.flatMap((s) => s.gates.filter((g) => !ids.has(g)).map((g) => `${s.at} → ${g}`))
    expect(unknown, 'WRITE_SITES names a WriteId that is not in GATED_WRITES.').toEqual([])
  })

  it('records why each ungated write is ungated', () => {
    const silent = WRITE_SITES.filter((s) => s.gates.length === 0 && s.why.trim().length < 20).map((s) => s.at)
    expect(
      silent,
      'An ungated write with no reason written down. The reason is the whole value of the exception — "app-scoped store, granted ' +
        'with the app" is a decision somebody can check; a blank is a decision nobody made.',
    ).toEqual([])
  })
})

describe('every gate is actually rendered', () => {
  it('puts a <GatedControl> on screen for each declared control', () => {
    const rendered = new Set(controls.declared)
    const missing = (Object.keys(GATED_WRITES) as WriteId[]).filter((id) => !rendered.has(id) && !GATED_WRITES[id].unrendered)
    expect(
      missing,
      'A control is declared in GATED_WRITES but nothing renders a <GatedControl write="…"> for it. This is the link that catches ' +
        'a new write control shipping ungated: the write forced the declaration, and the declaration is now waiting for the button.',
    ).toEqual([])
  })

  it('drops `unrendered` from an id the moment a control renders it', () => {
    const rendered = new Set(controls.declared)
    const stale = (Object.keys(GATED_WRITES) as WriteId[]).filter((id) => GATED_WRITES[id].unrendered && rendered.has(id))
    expect(stale, 'A <GatedControl> now renders these, so they are no longer unrendered — delete the marker.').toEqual([])
  })

  it('lets an id go unrendered only while nothing on screen reaches its writes', () => {
    // `unrendered` is the one way past "every gate is rendered", so it is held to
    // what makes it true: every write gated ONLY by unrendered ids lives in a
    // module paths.ts lists as unreached — which policyCoverage.test.ts proves
    // nothing the running app imports. A write a user can reach with no rendered
    // control is exactly the silent failure this file exists to stop.
    const unreached = (at: string) => UNREACHED_MODULES.some((u) => u.file === `src/${at.split('#')[0]}`)
    const loose = WRITE_SITES.filter(
      (s) => s.gates.length > 0 && s.gates.every((g) => GATED_WRITES[g]?.unrendered) && !unreached(s.at),
    ).map((s) => s.at)
    expect(loose, 'These writes are reachable and gated only by controls nobody renders.').toEqual([])
    // And the converse: a write in an unreached module names only unrendered
    // controls — a rendered one would be a button that cannot reach it.
    const misnamed = WRITE_SITES.filter((s) => unreached(s.at) && s.gates.some((g) => !GATED_WRITES[g]?.unrendered)).map((s) => s.at)
    expect(misnamed).toEqual([])
    for (const id of Object.keys(GATED_WRITES) as WriteId[]) {
      const why = GATED_WRITES[id].unrendered
      if (!why) continue
      expect(why.trim().length, `${id}: an unrendered control needs its reason`).toBeGreaterThan(40)
      expect(WRITE_SITES.some((s) => s.gates.includes(id)), `${id} is unrendered and gates no write — delete it`).toBe(true)
    }
  })

  it('accepts only declared ids on a <GatedControl>', () => {
    const ids = new Set(Object.keys(GATED_WRITES))
    expect(controls.declared.filter((w) => !ids.has(w)), 'A <GatedControl> names a write that is not declared.').toEqual([])
  })

  it('requires `write` to be the first attribute of every <GatedControl>', () => {
    // Not style. It is what lets this test read the markup at all: with the id
    // behind a variable or three attributes down, a control could name nothing
    // and still look gated.
    expect(
      controls.total - controls.declared.length,
      'A <GatedControl> was rendered without write="…" as its first attribute, so this test cannot tell which write it gates.',
    ).toBe(0)
  })
})

describe('the onboarding pack’s controls (Guided Setup’s onboarding panel)', () => {
  // The generic links above already hold these; this names the onboarding
  // run's own claims, so a site dropped from its gate reads as what it is.
  const pack = (Object.keys(GATED_WRITES) as WriteId[]).filter((id) => id.startsWith('onboarding_pack.'))

  it('renders Onboard and Remove, and not Upgrade until its write can be reached', () => {
    // Upgrade's write is in cribl/packUpgrade.ts, on UNREACHED_MODULES with its
    // PATCH ungranted; the checks above hold an unrendered id to exactly that.
    expect(pack.sort()).toEqual(['onboarding_pack.install', 'onboarding_pack.remove', 'onboarding_pack.upgrade'])
    const rendered = new Set(controls.declared)
    for (const id of ['onboarding_pack.install', 'onboarding_pack.remove'] as const) {
      expect(rendered.has(id), `${id} has no <GatedControl>`).toBe(true)
      expect(GATED_WRITES[id].unrendered, `${id} is still marked unrendered`).toBeUndefined()
    }
    expect(rendered.has('onboarding_pack.upgrade'), 'a control renders Upgrade, whose write nothing can reach').toBe(false)
  })

  it('names Onboard on every write the one run makes, and Remove on its own', () => {
    const gatesOf = (at: string) => WRITE_SITES.find((s) => s.at === at)?.gates ?? []
    for (const at of [
      'cribl/provision.ts#ensureLakeDataset', 'cribl/packClient.ts#installPack', 'cribl/packClient.ts#patchPackInput',
      'cribl/accel/provision.ts#createSaved', 'cribl/accel/provision.ts#patchSaved',
      'cribl/provision.ts#commitAndDeploy', 'cribl/provision.ts#deployGroup',
    ]) expect(gatesOf(at), at).toContain('onboarding_pack.install')
    for (const at of ['cribl/packClient.ts#removePack', 'cribl/provision.ts#commitAndDeploy', 'cribl/provision.ts#deployGroup']) {
      expect(gatesOf(at), at).toContain('onboarding_pack.remove')
    }
    expect(gatesOf('cribl/packUpgrade.ts#upgradePack')).toEqual(['onboarding_pack.upgrade'])
    // Upgrade has no control until it can run: its write is unreached, and so
    // is its id.
    expect(GATED_WRITES['onboarding_pack.upgrade'].unrendered).toBeTruthy()
    expect(GATED_WRITES['onboarding_pack.install'].does).toBe('onboarding Gigamon AMI (datasets, pack, scheduled searches)')
  })
})
