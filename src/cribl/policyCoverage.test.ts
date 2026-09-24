// The gate on what this app asks an admin to grant it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. `config/policies.yml` is not a description of the app — it is
// the grant. AGENTS.md: when an admin shares this app with a user, every path
// declared there is granted to that user for the duration of a request made
// through the app. So the file decides two things at once, and can be wrong in
// two directions:
//
//   MISSING  a path the app calls → the platform rejects the call, and only for
//            the users the declaration exists to serve. Slice 1.3 shipped without
//            PATCH on the syslog source while provision.ts PATCHed it on every
//            re-apply: a non-admin deployed a fresh stack fine and then 403ed on
//            every re-apply afterwards, reported as a failed provisioning step
//            with no hint that it was a permission. A human found it by reading.
//            THIS TEST IS THE THING THAT SHOULD HAVE CAUGHT IT.
//
//   EXTRA    a path the app does not call → nothing breaks, which is why it goes
//            unnoticed, and an admin is asked to trust the app with more than it
//            uses. That is a trust problem rather than a bug, and in a file whose
//            whole purpose is an honest statement it is the same class of defect
//            as the missing PATCH, pointing the other way.
//
// And one more, which is neither: anything the app CREATES in a customer's Cribl
// it must be able to REMOVE, or a customer can install the stack and not
// uninstall it.
//
// WHAT THIS PROVES. That src/cribl/paths.ts names exactly the Cribl API calls the
// source actually makes — resolved from the source text, not from a list somebody
// remembered to update — and that config/policies.yml grants exactly those, no
// more.
//
// WHAT IT DOES NOT PROVE. That the platform's matcher agrees with this one.
// Nothing here can: every caller on this workspace is org_admin + ws_admin, and
// AGENTS.md says a user who already holds a permission reaches the path without
// any grant, so an admin never exercises the matcher at all. What this test does
// instead is remove the dependency — it matches conservatively (`:name` and `*`
// each cover exactly ONE segment) and asserts the declaration contains no `*`, so
// the file means the same thing under every reading of a rule AGENTS.md does not
// state. See the wildcard note at the bottom of paths.ts.
//
// IT ALSO DOES NOT PROVE that a granted call succeeds. Declaring a write does not
// make a denied write loud: that is what src/cribl/authz.ts and <GatedControl>
// are for.
//
// IF THIS TEST FAILS, read which check it is:
//   • transports        — a new way to reach the network appeared in src/
//   • unresolved        — a call site whose path this test cannot work out
//   • scan ↔ manifest   — the code calls something paths.ts does not name, or
//                         paths.ts names something the code no longer calls
//   • undeclared        — a call with no grant: the 403 class
//   • over-declared     — a grant with no call: the trust class
//   • app-scoped        — a `/kvstore/…` path was declared; AGENTS.md says not to
//   • teardown          — something the app creates and cannot remove
// Every one of them has a named, reasoned exception list in this file or in
// paths.ts. An exception without a reason is how a test like this becomes
// decoration, so the reasons are asserted too.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SEARCH_GROUP } from './config'
import { API_CALLS, LEFT_BEHIND, type ApiCall, type Method, type Provisioned } from './paths'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const POLICIES = 'config/policies.yml'

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// ── Exceptions that are about the CHECKING, not about the app ───────────────
// (The ones that are about the app — the app-scoped KV paths, and the resources
// the teardown deliberately leaves behind — live in paths.ts, because they are
// facts about the app whether or not anybody tests them.)

/**
 * Call sites whose path argument is an expression this test cannot resolve, and
 * why that is correct rather than a gap. `resolvesTo` says what the endpoint
 * really is when the expression names one; omitted means the site names no
 * endpoint at all.
 *
 * Anything NOT on this list fails, which is the point: a new call built through
 * a helper this test does not understand stops the build instead of quietly
 * escaping the coverage check.
 */
const UNRESOLVED_CALL_SITES: ReadonlyArray<{ file: string; expr: string; reason: string; resolvesTo?: string }> = [
  {
    file: 'src/cribl/capi.ts',
    expr: '`${API_BASE}${path}`',
    reason:
      'This is the transport itself. The whole path is its parameter, so there is no endpoint here to declare — the endpoints are at the call sites that pass one in, and this test resolves them there.',
  },
  {
    file: 'src/cribl/search.ts',
    expr: 'url',
    reason:
      'The parameter of search.ts\'s own fetchRetry/api helpers, which every search call goes through. Same as capi above: the endpoint belongs to the caller that built the URL, and searchUrl() makes those resolvable.',
  },
  {
    file: 'src/cribl/kv.ts',
    expr: 'path',
    reason:
      'keyPath() turns a KV key into `/kvstore/<encoded segments>`; the key is chosen by the caller at runtime, so the path cannot be read off the call site. It is app-scoped either way — AGENTS.md grants /kvstore/* with the app and forbids declaring it.',
    resolvesTo: '/kvstore/:key',
  },
]

/**
 * Grants that are deliberately declared although nothing calls them.
 *
 * EMPTY, AND MEANT TO STAY THAT WAY. An over-declaration is nearly always a call
 * that was deleted and a grant that was not, and the fix is to delete the grant.
 * The list exists so that a real exception has somewhere to go WITH its reason,
 * not as a place to silence this check.
 */
const DECLARED_BUT_NOT_CALLED: ReadonlyArray<{ object: string; action: Method; reason: string }> = []

// ── Reading config/policies.yml ─────────────────────────────────────────────

interface Declared {
  object: string
  actions: string[]
  /** `config/policies.yml:<line>` — so a failure says where to edit. */
  at: string
}

/**
 * Parse the declaration. Strict on purpose, and it is not a YAML parser: it reads
 * exactly the shape this file is written in and throws on anything else. A real
 * parser would quietly accept a form the test then mis-reads — a flow sequence, a
 * folded string, an anchor — and a policy file this test cannot read is a policy
 * file this test is not checking. Failing loudly is the honest answer; the fix is
 * to write the entry in the shape above it, or to teach this function the new one
 * deliberately.
 */
function parsePolicies(text: string): Declared[] {
  const out: Declared[] = []
  let inPolicies = false
  let current: Declared | null = null
  text.split(/\r?\n/).forEach((raw, i) => {
    const at = `${POLICIES}:${i + 1}`
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) return
    if (line === 'policies:') {
      inPolicies = true
      return
    }
    if (!inPolicies) throw new Error(`${at}: expected the file to start with a \`policies:\` key`)
    const object = /^ {2}- object: '([^']+)'$/.exec(line)
    if (object) {
      if (current) throw new Error(`${current.at}: this entry has no \`actions:\` line`)
      current = { object: object[1], actions: [], at }
      out.push(current)
      return
    }
    const actions = /^ {4}actions: \[([^\]]*)\]$/.exec(line)
    if (actions) {
      if (!current) throw new Error(`${at}: \`actions:\` with no \`- object:\` above it`)
      current.actions = actions[1]
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
        .map((a) => {
          const m = /^'([^']*)'$/.exec(a)
          if (!m) throw new Error(`${at}: expected a single-quoted method, got ${a}`)
          return m[1]
        })
      if (!current.actions.length) throw new Error(`${at}: an entry with no methods grants nothing`)
      current = null
      return
    }
    throw new Error(`${at}: this test cannot read this line — ${JSON.stringify(line)}`)
  })
  if (current) throw new Error(`${(current as Declared).at}: this entry has no \`actions:\` line`)
  return out
}

const DECLARED = parsePolicies(readFileSync(join(ROOT, POLICIES), 'utf8'))

// ── Path matching, done the conservative way ────────────────────────────────

/** A segment that stands for a value rather than being one. */
const isPlaceholder = (seg: string) => seg === '*' || seg.startsWith(':')

/**
 * A path as segments, with the query string dropped.
 *
 * The query is dropped deliberately rather than by accident of how the paths
 * happen to be written: three calls carry one (`/version?limit=5`,
 * `/version/files?commit=…`, `/search/jobs/:id/results?limit=…`) and AGENTS.md
 * describes a policy `object` as a path throughout, never as a URL. Treating
 * `?limit=5` as part of the object would declare a grant that only covers the
 * query string this release happens to send.
 */
function segments(path: string): string[] {
  return path.split('?')[0].split('/').filter(Boolean)
}

/**
 * Does `object` (as declared) cover `path` (as called)?
 *
 * ONE SEGMENT PER PLACEHOLDER, both for `:name` and for `*`. AGENTS.md never says
 * whether `*` spans one segment or many; its own `/m/:gid/system/projects/*`
 * example only makes sense if it spans many, but that is an inference from an
 * example and it is the permissive reading. Encoding the permissive reading here
 * would pass a declaration that 403s in production — the exact failure this test
 * exists to prevent — so the strict reading is the one implemented, and the
 * declaration is written without any `*` so the difference cannot matter.
 *
 * A placeholder in the CALL is not covered by a literal in the declaration: if
 * the app can call any value there, a grant for one value is not a grant.
 */
function covers(object: string, path: string): boolean {
  const o = segments(object)
  const p = segments(path)
  if (o.length !== p.length) return false
  return o.every((seg, i) => seg === p[i] || isPlaceholder(seg))
}

/** Two paths the scan and the manifest wrote independently, compared shape-wise:
 *  a placeholder matches a placeholder, a literal must match that literal. */
function sameShape(a: string, b: string): boolean {
  const x = segments(a)
  const y = segments(b)
  if (x.length !== y.length) return false
  return x.every((seg, i) => seg === y[i] || (isPlaceholder(seg) && isPlaceholder(y[i])))
}

// ── Reading the source ──────────────────────────────────────────────────────

/** Every non-test source file, as a repo-relative POSIX path. */
function sourceFiles(dir = join(ROOT, 'src')): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(relative(ROOT, full).split('\\').join('/'))
    }
  }
  return out
}

/**
 * Remove comments, leaving string and template literals intact.
 *
 * Deliberately a scanner rather than a parser: it tracks quotes so a `//` inside
 * a string survives, and it does not understand regex literals — which is safe
 * only because no regex in src/ contains a quote or a `//`. If one ever does,
 * this is the line that will start lying.
 */
function stripComments(src: string): string {
  let out = ''
  for (let i = 0; i < src.length; ) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(src, i)
      if (end < 0) return out + src.slice(i)
      out += src.slice(i, end + 1)
      i = end + 1
      continue
    }
    out += c
    i++
  }
  return out
}

/** Index of the quote that closes the one at `i`, or -1. */
function skipString(src: string, i: number): number {
  const quote = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') {
      j++
      continue
    }
    if (src[j] === quote) return j
  }
  return -1
}

/** The arguments of the call whose `(` is at `open`, unparsed, trimmed. Balanced
 *  across nested calls, objects and arrays; strings are skipped whole so a comma
 *  inside one never splits an argument. */
function readArgs(src: string, open: number): string[] | null {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(src, i)
      if (end < 0) return null
      i = end
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        args.push(src.slice(start, i))
        const trimmed = args.map((a) => a.trim())
        return trimmed.length === 1 && trimmed[0] === '' ? [] : trimmed
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i))
      start = i + 1
    }
  }
  return null
}

/** What a module says at its top level, as far as this test needs to know it. */
interface ModuleConsts {
  /** `const NAME = 'literal'` / `` `template` `` — the raw right-hand side. */
  values: Map<string, string>
  /** `const NAME = (args) => `template`` — the template it returns. */
  arrows: Map<string, string>
  /** `const NAME = otherName` — so `g = groupPath` resolves to groupPath. */
  aliases: Map<string, string>
}

function moduleConsts(src: string): ModuleConsts {
  const values = new Map<string, string>()
  const arrows = new Map<string, string>()
  const aliases = new Map<string, string>()
  const decl = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s*$/gm
  for (const m of src.matchAll(decl)) {
    const [, name, rhs] = m
    if (/^('[^']*'|`[^`]*`)$/.test(rhs)) values.set(name, rhs)
    else if (/^[A-Za-z_$][\w$]*$/.test(rhs)) aliases.set(name, rhs)
    else {
      const arrow = /^\([^)]*\)\s*=>\s*('[^']*'|`[^`]*`)$/.exec(rhs)
      if (arrow) arrows.set(name, arrow[1])
    }
  }
  return { values, arrows, aliases }
}

/** A call expression, with its callee resolved through any local alias. */
function asCall(expr: string, consts: ModuleConsts): { callee: string; args: string[] } | null {
  const head = /^([A-Za-z_$][\w$]*)\s*(?:<[\s\S]*?>)?\s*\(/.exec(expr)
  if (!head) return null
  const args = readArgs(expr, head[0].length - 1)
  if (!args) return null
  const callee = head[1]
  return { callee: consts.aliases.get(callee) ?? callee, args }
}

/** `${…}` → the constant it names, or `:x` for anything that varies. `API_BASE`
 *  is the base URL the transports prefix, so it contributes no segment. */
function expandTemplate(body: string, consts: ModuleConsts): string {
  return body.replace(/\$\{([^}]*)\}/g, (_, raw: string) => {
    const name = raw.trim()
    if (name === 'API_BASE') return ''
    const value = consts.values.get(name)
    return value && value.startsWith("'") ? value.slice(1, -1) : ':x'
  })
}

/**
 * The API path a call-site expression builds, or null when this test cannot tell.
 *
 * Understands: a string or template literal; a module-level constant holding one;
 * `groupPath(group, …)` (and its `g` alias), which prefixes the chosen worker
 * group; `searchUrl(…)`, which prefixes the dedicated search group; and a
 * module-level arrow function that returns a template.
 */
function resolvePath(expr: string, consts: ModuleConsts): string | null {
  const e = expr.trim()
  if (/^'[^']*'$/.test(e)) return e.slice(1, -1)
  if (/^`[^`]*`$/.test(e)) return expandTemplate(e.slice(1, -1), consts)
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const value = consts.values.get(e)
    return value === undefined ? null : resolvePath(value, consts)
  }
  const call = asCall(e, consts)
  if (!call) return null
  if (call.callee === 'groupPath' && call.args.length >= 2) {
    const tail = resolvePath(call.args[1], consts)
    // The group is whichever one the user picked in Guided Setup, so it is a
    // placeholder here and in the declaration. See the README for what that
    // breadth costs.
    return tail === null ? null : `/m/:gid${tail}`
  }
  if (call.callee === 'searchUrl' && call.args.length === 1) {
    const tail = resolvePath(call.args[0], consts)
    return tail === null ? null : `/m/${SEARCH_GROUP}${tail}`
  }
  const arrow = consts.arrows.get(call.callee)
  return arrow ? resolvePath(arrow, consts) : null
}

interface Hit {
  file: string
  method: Method | null
  path: string
}

interface Unresolved {
  file: string
  expr: string
}

/** A call that leaves Cribl entirely. There are none today — config/proxies.yml
 *  is commented out end to end — and one appearing is a different conversation
 *  from this file's, so it gets its own answer rather than a confusing one. */
interface External {
  file: string
  url: string
}

/** The callees that take a URL or an API path as an argument. Everything the app
 *  sends leaves through one of them. */
const CALL_SITES = /(?<![A-Za-z0-9_$.])(capi|fetchRetry|fetch|api)\s*(?:<[\s\S]*?>)?\s*\(/g

/** Anything that can put bytes on the network. The app has exactly one of them. */
const NETWORK_PRIMITIVES = /(?<![A-Za-z0-9_$.])(fetch\s*\(|XMLHttpRequest|EventSource|WebSocket|sendBeacon|axios)/

function scanFile(file: string): { hits: Hit[]; unresolved: Unresolved[]; external: External[] } {
  const src = stripComments(readFileSync(join(ROOT, file), 'utf8'))
  const consts = moduleConsts(src)
  const hits: Hit[] = []
  const unresolved: Unresolved[] = []
  const external: External[] = []

  for (const m of src.matchAll(CALL_SITES)) {
    const start = m.index
    // `async function api<T>(url, …)` is a declaration, not a call.
    if (/\b(function|class)\s*$/.test(src.slice(Math.max(0, start - 24), start))) continue
    const args = readArgs(src, start + m[0].length - 1)
    if (!args || !args.length) continue

    // capi() takes its method first and its path second; everything else takes
    // the URL first and an optional RequestInit second.
    const viaCapi = m[1] === 'capi'
    const methodExpr = viaCapi ? args[0] : (args[1] ?? '')
    const pathExpr = viaCapi ? (args[1] ?? '') : args[0]

    const literalMethod = /^'([A-Z]+)'$/.exec(methodExpr.trim())
    const initMethod = /\bmethod:\s*'([A-Z]+)'/.exec(methodExpr)
    const named = viaCapi ? literalMethod?.[1] : initMethod?.[1]
    // No `method` in a RequestInit means GET; an unreadable method on capi()
    // means this test does not know what the call does, and says so.
    const method = named ?? (viaCapi ? null : 'GET')

    const path = resolvePath(pathExpr, consts)
    if (path !== null && /^https?:/i.test(path)) {
      external.push({ file, url: path })
      continue
    }
    // A path that does not begin with `/` is not an endpoint: it is a base URL
    // whose path is somebody else's argument (capi's own fetch), or an
    // expression this test only half read. Either way it is unresolved, not a
    // call — reporting it as `GET :x` would be a fact about the scanner.
    if (path === null || !path.startsWith('/') || !METHODS.includes(method ?? '')) {
      unresolved.push({ file, expr: pathExpr.replace(/\s+/g, ' ').trim() })
      continue
    }
    hits.push({ file, method: method as Method, path })
  }
  return { hits, unresolved, external }
}

/** Files that can reach the Cribl API at all: everything else has no way to
 *  build a URL, which the transports check below pins. */
const REACHERS = sourceFiles().filter((f) => {
  const src = stripComments(readFileSync(join(ROOT, f), 'utf8'))
  return /\bcapi\(|\bsearchUrl\(|\bAPI_BASE\b/.test(src)
})

const SCAN = REACHERS.map(scanFile)
const HITS: Hit[] = SCAN.flatMap((s) => s.hits).concat(
  // The sites this test cannot read, resolved by their named exception instead —
  // so an allow-listed site is still covered by every check below.
  UNRESOLVED_CALL_SITES.flatMap((x) =>
    x.resolvesTo
      ? SCAN.flatMap((s) => s.unresolved)
          .filter((u) => u.file === x.file && u.expr === x.expr)
          .map(() => ({ file: x.file, method: null, path: x.resolvesTo as string }))
      : [],
  ),
)
const UNRESOLVED: Unresolved[] = SCAN.flatMap((s) => s.unresolved)
const EXTERNAL: External[] = SCAN.flatMap((s) => s.external)

const PRODUCT_CALLS = API_CALLS.filter((c) => c.scope === 'product')
const APP_CALLS = API_CALLS.filter((c) => c.scope === 'app')

const describeCall = (c: ApiCall) => `${c.method} ${c.path} (${c.site})`

// ── The checks ──────────────────────────────────────────────────────────────

describe('transports', () => {
  it('has exactly one way to reach the network, so nothing can call the API off the books', () => {
    // Every check in this file starts from the four transports in src/cribl. A
    // fifth — a raw fetch in a tab, an EventSource, a copied XHR helper — would
    // make a call nothing here ever sees. The fix when this fails is not to add
    // the file to a list: route it through capi() or searchUrl().
    const withNetwork = sourceFiles().filter((f) =>
      NETWORK_PRIMITIVES.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))),
    )
    expect(withNetwork.sort()).toEqual([
      'src/cribl/capi.ts',
      'src/cribl/datasetIntel.ts',
      'src/cribl/jobCost.ts',
      'src/cribl/search.ts',
    ])
  })

  it('scans every module that can build a Cribl URL', () => {
    // Deliberately NOT a pinned list of filenames. Which modules make calls is
    // allowed to change — a new module that calls capi() should be scanned the
    // day it is written, without anybody updating a list here — so what is
    // asserted is the property that matters: every file that can put bytes on
    // the network, and every file paths.ts says a call lives in, is a file this
    // test actually read.
    const reached = new Set(REACHERS)
    for (const file of sourceFiles()) {
      if (!NETWORK_PRIMITIVES.test(stripComments(readFileSync(join(ROOT, file), 'utf8')))) continue
      expect(reached.has(file), `${file} calls the network and this test never scanned it`).toBe(true)
    }
    for (const c of API_CALLS) {
      const named = c.site.split(' ')[0]
      expect(
        REACHERS.some((f) => f.endsWith(`/${named}`)),
        `paths.ts says ${describeCall(c)} lives in ${named}, which this test never scanned`,
      ).toBe(true)
    }
  })

  it('can work out the path of every call site, or says which one it cannot', () => {
    const unexplained = UNRESOLVED.filter(
      (u) => !UNRESOLVED_CALL_SITES.some((x) => x.file === u.file && x.expr === u.expr),
    )
    expect(
      unexplained,
      'this test could not tell which endpoint these call sites reach, so it is not checking them. ' +
        'Build the path from a literal, a module constant, groupPath() or searchUrl() — or add it to ' +
        'UNRESOLVED_CALL_SITES with the reason it cannot be read and, if it names an endpoint, what it resolves to.',
    ).toEqual([])
  })

  it('calls nothing outside Cribl', () => {
    // A different file governs this one: an external domain has to be declared in
    // config/proxies.yml, which is commented out end to end today because the app
    // makes no such call. This is here so that adding one is a decision somebody
    // makes rather than a thing that happens.
    expect(
      EXTERNAL,
      'this call leaves Cribl. config/policies.yml does not cover it — declare the domain in ' +
        'config/proxies.yml, and say here why the app talks to it.',
    ).toEqual([])
  })

  it('keeps a reason on every unresolved-site exception, and drops the ones that are no longer needed', () => {
    for (const x of UNRESOLVED_CALL_SITES) {
      expect(x.reason.trim().length, `${x.file} ${x.expr}: an exception without a reason is decoration`).toBeGreaterThan(40)
      expect(
        UNRESOLVED.some((u) => u.file === x.file && u.expr === x.expr),
        `${x.file} no longer has an unresolved \`${x.expr}\` — delete this exception`,
      ).toBe(true)
    }
  })
})

describe('paths.ts against the source', () => {
  it('names every Cribl API call the source makes', () => {
    const missing = HITS.filter(
      (h) => !API_CALLS.some((c) => sameShape(c.path, h.path) && (h.method === null || c.method === h.method)),
    ).map((h) => `${h.method ?? '?'} ${h.path} — called in ${h.file}`)
    expect(
      [...new Set(missing)],
      'the app calls these and src/cribl/paths.ts does not name them, so nothing checks them against ' +
        'config/policies.yml. Add an entry with its method, its call site and why the app needs it.',
    ).toEqual([])
  })

  it('names nothing the source no longer calls', () => {
    const stale = API_CALLS.filter(
      (c) => !HITS.some((h) => sameShape(c.path, h.path) && (h.method === null || c.method === h.method)),
    ).map(describeCall)
    expect(
      stale,
      'src/cribl/paths.ts names these and no call site builds them any more. A manifest that outlives its ' +
        'calls is how config/policies.yml grows grants nobody uses — delete the entry, and the grant with it.',
    ).toEqual([])
  })

  it('points at the file the call is really in', () => {
    // `site` is what a reader follows to check this list by eye. The file half of
    // it is checkable, so it is checked; the function half is not.
    const wrong = API_CALLS.filter((c) => {
      const file = c.site.split(' ')[0]
      const seen = HITS.filter((h) => sameShape(c.path, h.path) && (h.method === null || c.method === h.method))
      return seen.length > 0 && !seen.some((h) => h.file.endsWith(`/${file}`))
    }).map((c) => `${describeCall(c)} — found instead in ${HITS.filter((h) => sameShape(c.path, h.path)).map((h) => h.file).join(', ')}`)
    expect(wrong).toEqual([])
  })

  it('explains every call in terms an admin approving it would recognise', () => {
    for (const c of API_CALLS) {
      expect(c.why.trim().length, `${describeCall(c)} has no real reason written against it`).toBeGreaterThan(40)
    }
  })
})

describe('config/policies.yml', () => {
  it('declares every path the app calls, with the method it calls', () => {
    const undeclared = PRODUCT_CALLS.filter(
      (c) => !DECLARED.some((d) => covers(d.object, c.path) && d.actions.includes(c.method)),
    ).map(describeCall)
    expect(
      undeclared,
      'the app calls these and config/policies.yml does not grant them. Installed, the platform rejects the ' +
        'call for every user who does not already hold the permission — which is everyone the declaration ' +
        'exists to serve. This is the shape of the bug slice 1.3 shipped.',
    ).toEqual([])
  })

  it('declares nothing the app does not call', () => {
    const extra: string[] = []
    for (const d of DECLARED) {
      for (const action of d.actions) {
        if (PRODUCT_CALLS.some((c) => c.method === action && covers(d.object, c.path))) continue
        if (DECLARED_BUT_NOT_CALLED.some((x) => x.object === d.object && x.action === action)) continue
        extra.push(`${action} ${d.object} (${d.at})`)
      }
    }
    expect(
      extra,
      'config/policies.yml grants these and nothing in the app uses them. Nothing breaks, which is why this ' +
        'goes unnoticed — but an admin is being asked to approve more than the app needs, in a file whose only ' +
        'job is to say what it needs. Delete the grant, or make the app call it.',
    ).toEqual([])
  })

  it('does not declare the app-scoped KV paths', () => {
    // AGENTS.md: "App-scoped paths (`/a/${appId}/kvstore/*`, `/a/${appId}/proxy/*`)
    // are granted automatically via the AppUser role when an admin shares your
    // app — do not redeclare them here."
    const redeclared = APP_CALLS.filter((c) => DECLARED.some((d) => covers(d.object, c.path))).map(describeCall)
    expect(redeclared, 'the platform already grants these with the app; declaring one asks an admin to approve a grant they cannot withhold').toEqual([])
  })

  it('uses no wildcard, in a path or in a method', () => {
    // The point of the rule is at the top of this file and at the bottom of
    // paths.ts: AGENTS.md does not say how deep `*` reaches, and a declaration
    // whose meaning depends on an unanswered question cannot be checked or
    // honestly reviewed. `actions: ['*']` has the same problem with methods —
    // it grants DELETE on a path the app only reads.
    for (const d of DECLARED) {
      expect(d.object, `${d.at}: name each segment instead — \`:name\` covers exactly one`).not.toContain('*')
      expect(d.actions, `${d.at}: list the methods the app actually uses`).not.toContain('*')
      for (const action of d.actions) {
        expect(METHODS, `${d.at}: ${action} is not an HTTP method`).toContain(action)
      }
    }
  })

  it('declares each object once', () => {
    const seen = new Map<string, string>()
    for (const d of DECLARED) {
      const first = seen.get(d.object)
      expect(first, `${d.at}: '${d.object}' is already declared at ${first} — merge the methods into one entry`).toBeUndefined()
      seen.set(d.object, d.at)
    }
  })

  it('keeps a reason on every over-declaration exception', () => {
    for (const x of DECLARED_BUT_NOT_CALLED) {
      expect(x.reason.trim().length, `${x.action} ${x.object}: an exception without a reason is decoration`).toBeGreaterThan(40)
    }
  })
})

describe('paired teardown', () => {
  it('can remove everything it creates', () => {
    const created = new Set(API_CALLS.map((c) => c.creates).filter(Boolean) as Provisioned[])
    const removable = new Set(API_CALLS.map((c) => c.removes).filter(Boolean) as Provisioned[])
    const excused = new Set(LEFT_BEHIND.map((x) => x.resource))
    const stranded = [...created].filter((r) => !removable.has(r) && !excused.has(r))
    expect(
      stranded,
      'the app creates these in a customer\'s Cribl and has no way to take them away again, so a customer ' +
        'can install the stack and not uninstall it. Either add the removing call (and the grant it needs), ' +
        'or add the resource to LEFT_BEHIND in paths.ts with the reason it stays.',
    ).toEqual([])
  })

  it('keeps a reason on every thing it leaves behind, and drops the ones it can now remove', () => {
    const removable = new Set(API_CALLS.map((c) => c.removes).filter(Boolean) as Provisioned[])
    for (const x of LEFT_BEHIND) {
      expect(x.reason.trim().length, `${x.resource}: an exception without a reason is decoration`).toBeGreaterThan(80)
      expect(
        removable.has(x.resource),
        `${x.resource} can be removed now — delete this exception rather than leaving a stale excuse in place`,
      ).toBe(false)
    }
  })

  it('pairs the routing table by resource rather than by method, because one call does both', () => {
    // The route is added and taken away by the same PATCH of the group's one
    // routing table (provision.ts ensureRoute / removeOnboardingStack). A teardown
    // check keyed on "a POST needs a DELETE" would report this forever and miss
    // the two that genuinely have no teardown.
    const route = API_CALLS.find((c) => c.creates === 'route')
    expect(route?.removes).toBe('route')
    expect(route?.method).toBe('PATCH')
  })
})

describe('how paths are matched', () => {
  it('drops the query string before comparing', () => {
    // Three calls carry one. A declaration is a path, so `?limit=5` is not part
    // of the object being granted.
    expect(segments('/version?limit=5')).toEqual(['version'])
    expect(covers('/version', '/version?limit=5')).toBe(true)
  })

  it('lets a placeholder stand for exactly one segment', () => {
    expect(covers('/m/:gid/routes/:tableId', '/m/default/routes/default')).toBe(true)
    expect(covers('/m/:gid/system/inputs/*', '/m/default/system/inputs/in_gigamon_syslog')).toBe(true)
  })

  it('does not let a placeholder swallow a deeper path', () => {
    // The whole reason the declaration avoids `*`: read permissively, this is
    // true and the app 403s in production anyway.
    expect(covers('/m/default_search/search/jobs/*', '/m/default_search/search/jobs/abc/status')).toBe(false)
    expect(covers('/products/stream/groups/*', '/products/stream/groups/default/deploy')).toBe(false)
  })

  it('does not let a grant for one value cover a call that can send any', () => {
    expect(covers('/products/lake/lakes/default/datasets', '/products/lake/lakes/:lakeId/datasets')).toBe(false)
  })
})
