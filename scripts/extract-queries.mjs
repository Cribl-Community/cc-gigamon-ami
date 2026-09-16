// Regenerate src/queries/__frozen__/display.json — the committed snapshot of
// every Cribl Search (KQL) string this app puts in front of a customer, and of
// the words and the numbers each of those strings is attached to.
//
//   npm run queries:extract              rewrite the snapshot
//   node scripts/extract-queries.mjs --stdout   print it instead
//
// src/queries/display-freeze.test.ts runs the --stdout mode and diffs the
// result against the committed file, so the generator and the checker are
// literally this script. Nothing else may produce that JSON.
//
// WHAT AN ⓘ POPOVER PROMISES. Next to every number this app shows sits an ⓘ
// naming the query that produced it, in English and in KQL. That is a factual
// claim about provenance, and it is false the moment the number moves to a
// different query, the prose starts describing a different statistic, or the
// data behind the aggregation is reclassified. So a query string alone is not
// enough to freeze: each surface records what it points at AND what it reads.
//
// Seven kinds of entry, because a customer reaches a claim about a number seven ways:
//   surfaces  a `query=` prop — the ⓘ popover that says where the number came from
//   searches  a useSearch / runSearch / runFieldSummaries call site — what actually ran
//   links     a searchUiUrl(...) deep link — the query handed to the Search UI
//   briefs    a criblInvestigateUrl(...) prompt — the query handed to the Copilot agent
//   prose     an ⓘ with words but no query — still an explanation of a number
//   modules   every export of src/queries/*.ts, builders enumerated over their DOMAIN
//   catalogs  every export of src/data/*.ts, digested — data that moves a number
//             without ever appearing in a query string
// plus two supporting sections: `states` (the useState defaults that decide which
// query runs on first paint) and `passthrough` (components that forward their
// caller's query rather than naming one).
//
// Each surface stores the reference as written in the JSX, the resolved string,
// the search results that JSX element actually READS, its `value=` / `unit=` /
// `badge=` expressions, and its `info=` / `sub=` prose. References alone would not
// notice the constant's text changing; values alone would not notice a tile
// repointed at a different constant.
//
// WHAT THIS DOES NOT ESTABLISH — stated here because the snapshot is read as if
// it did. `reads` is a HINT, not a proof: it names the search variables an
// element mentions, and nothing more. It cannot show that the figure beside an
// ⓘ is computed from the query that ⓘ advertises. Where an element resolves to
// no search variable at all — a destructured result, one funnelled through
// useState, a component handed its search state as a prop — the entry says
// UNBOUND out loud rather than recording an empty list that reads like a pass.
// The full statement of scope is written into the snapshot as `$limits` (see
// LIMITS below) and repeated in the test's failure message.
//
// A surface inside a `.map()` is rendered once per row, so freezing it once is
// freezing one of seven panels. A fixture declared as `{ $each: … }` names the
// DOMAIN that map runs over, and every surface, call site, deep link and brief
// that depends on it is frozen once per case — the same treatment the builders
// in src/queries already get from VARIANTS. A fixture is a declaration, though,
// so `renderedOver` records the `.map()` receiver as the code writes it: narrow
// that receiver and four panels leave the screen, and the snapshot says so.
//
// HOW IT READS src/ — two mechanisms, deliberately kept apart:
//
//  VALUES come from importing src/queries/*.ts and src/data/*.ts under plain
//  Node, which strips the types itself. The resolve hook below appends '.ts' to
//  an extensionless relative specifier. It must NOT return `format: 'module'`:
//  that makes Node read the .ts as plain JS and throw a SyntaxError on the first
//  type annotation. Node cannot load .tsx at all, which is why nothing under
//  src/queries may import anything that reaches one.
//
//  SURFACES come from the TypeScript compiler API used ONLY as a parser over
//  src/**/*.tsx. Never transpiled as a whole, never executed — the .tsx files are
//  read for their shape (which component, which title, which expression), and
//  only the individual expressions a surface depends on are evaluated. Two
//  DataFlow queries name dataset="cribl_metrics" and never call q(), so call
//  sites and JSX attributes are the unit of discovery here, never q().
//
// SCOPE IS ALL OF src/, not just the tabs: Phase 1 extracts components, and a
// component carrying its own query constant must land in the snapshot the day it
// appears rather than the day someone notices. A component that only forwards a
// `query` PROP is recorded in `passthrough` instead — it names no query, so
// there is nothing to resolve, but a new forwarder is still a visible diff.
//
// An expression that cannot be resolved is a THROW, never a placeholder. A
// placeholder that reached the committed snapshot could never diff again, and
// the gate would be dead with nobody the wiser.

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, sep, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import nodeModule from 'node:module'
import ts from 'typescript'

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      // The source says './config'; the file is config.ts. Hand Node the real
      // name and let it detect the .ts — see the `format` trap in the header.
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context)
      throw err
    }
  },
})

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'src')
const QUERIES_DIR = join(SRC_DIR, 'queries')
const DATA_DIR = join(SRC_DIR, 'data')
const OUT_FILE = join(QUERIES_DIR, '__frozen__', 'display.json')
const FIXTURES_MODULE = join(QUERIES_DIR, '__fixtures__', 'args.ts')

/** Calls that submit a query to Cribl Search. */
const SEARCH_CALLS = new Set(['useSearch', 'runSearch', 'runFieldSummaries'])
/** The helper that builds a Cribl Search UI deep link. */
const LINK_CALL = 'searchUiUrl'
/** The helper that hands a dataset-qualified brief to the Copilot agent. */
const BRIEF_CALL = 'criblInvestigateUrl'
/** Where a component keeps its customer-facing name, most specific first. */
const LABEL_ATTRS = ['title', 'label']
/** The ⓘ prose and caption frozen beside each surface's query. */
const TEXT_ATTRS = ['info', 'sub']
/**
 * The figure, and the statements a customer reads in the same glance as it.
 *
 * `unit` turns 87 into 87/100 and `badge` prints WEAK PROTOCOL under the number;
 * both are claims about the figure exactly as much as `value` is, so an edit to
 * either has to move the snapshot.
 */
const FIGURE_ATTRS = ['value', 'unit', 'badge']
/** Directories under src/ that hold the freeze's own data, not components. */
const SKIP_DIRS = new Set(['__fixtures__', '__frozen__'])
/**
 * Captions frozen only where they are literal text.
 *
 * A panel's `note` is a customer-facing caption — "top 500 by volume" is a claim
 * about the number beside it — but several are whole JSX fragments of buttons
 * and links. Freezing those would churn on every unrelated edit and train
 * reviewers to regenerate the snapshot without reading it, which is how a gate
 * dies. So: literal captions yes, incidental JSX no.
 */
const CAPTION_ATTRS = ['note']
/**
 * Modules an expression may resolve a value from — all Node-loadable.
 *
 * Depth-agnostic on purpose: a component two directories down writes
 * `../../queries/findings` for the same module a tab reaches as
 * `../queries/findings`, and Phase 1 moves components around. The module set is
 * still exactly these four places.
 */
const LOADABLE_RE = /^(?:\.\.\/)+(?:queries|data)\/[A-Za-z0-9_]+$|^(?:\.\.\/)+cribl\/(?:config|search)$|^(?:\.\.\/)+lib\/format$/
/** Ambient names an expression may use without a binding. */
const GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'String', 'Number', 'Boolean', 'Math', 'JSON',
  'Object', 'Array', 'Date', 'Map', 'Set', 'RegExp', 'console',
])

/**
 * What the snapshot records where it could not check something.
 *
 * `reads: []` was the old spelling, and in review an empty list reads exactly
 * like a checked binding with nothing wrong. It is not: it means no search
 * variable was in scope to check against. Saying UNBOUND makes the gap visible
 * in the diff, and the test counts these, so the number only goes up when
 * somebody means it to.
 */
const UNBOUND = '(unbound)'

/**
 * The scope of this gate, written into the artefact a reviewer actually reads.
 *
 * Kept here rather than only in the test, because the file in the diff is where
 * someone decides whether a green build meant anything.
 */
const LIMITS = [
  'WHAT THIS FILE FREEZES: what each ⓘ tells a customer — the query strings, the expression each surface points at, the ⓘ prose and captions as written inline, the search options and deep-link time bounds, and the catalogs and first-paint useState defaults behind the numbers.',
  'BUILDER COVERAGE IS ONLY AS GOOD AS ITS DECLARED DOMAIN. Every exported builder must name a domain in src/queries/__fixtures__/args.ts or extraction throws, and every case of that domain is frozen — but nothing checks that the domain covers the builder. Add a parameter, or a branch the declared cases never reach, and it is unfrozen. The domain is a human\'s claim about the input space, not a proof.',
  'PROSE IS FROZEN WHERE IT IS WRITTEN, NOT WHERE IT IS READ. An info= or sub= written inline is frozen as text; hoist the same sentence into a module constant and the words behind that name move outside the freeze. Captions are covered only where they are literal text.',
  'WHAT IT DOES NOT PROVE: that the figure printed beside an ⓘ is produced by the query that ⓘ shows. Swap the definitions of two tab-local constants behind two tiles, or change the arithmetic between a search\'s rows and the number, and nothing here moves.',
  'That class is not checkable from source text without dataflow analysis of arbitrary React, and the Phase 1 refactor this gate exists to police breaks the binding by design: extracting a panel into a component that receives its search state as a prop is the CORRECT extraction, and it correctly leaves no search variable in that file. A heuristic that failed on that refactor would be worse than this limit, because a green tick would be read as proof of something it never checked.',
  `ATTRIBUTION IS THEREFORE A HUMAN REVIEW QUESTION: read the tile, read its ⓘ, check they agree — the way four mismatched tiles were found by eye in slice 1.1. "reads" is a hint at that binding, never a proof, and "${UNBOUND}" means no search variable was in scope, so nothing about that surface's figure was checked at all.`,
  'A runtime argument is frozen only through its fixture in src/queries/__fixtures__/args.ts. A drill-down handed a different row while the app runs — drillResolver(host) becoming drillResolver(shown[0].dns_host) — is a value no snapshot of src/ can see.',
  'A surface rendered once per row is frozen once per case of the domain DECLARED for it in that same fixtures file; "renderedOver" records the .map() the component really iterates, so narrowing that map is caught, but the two are tied by hand and a new one has to be declared by hand.',
  'Do not hand-edit: change src/, re-run `npm run queries:extract`, and review the diff.',
]

const flat = (s) => s.replace(/\s+/g, ' ').trim()
const rel = (p) => relative(ROOT, p).split(sep).join('/')
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/**
 * A one-line stand-in for a value that is data rather than a query.
 *
 * Catalog rows never appear in a query string — reclassifying a finding's
 * severity moves three KPI tiles while every ⓘ still shows the unchanged
 * FINDINGS_QUERY — so the data itself is frozen by digest. A digest is not a
 * placeholder: it cannot be read, but it changes whenever the value does.
 */
function digestOf(value) {
  if (typeof value === 'function') return `function · sha256 ${sha(value.toString())}`
  const json = JSON.stringify(value)
  if (json === undefined) return `${typeof value} · sha256 ${sha(String(value))}`
  if (Array.isArray(value)) return `${value.length} entries · sha256 ${sha(json)}`
  if (value && typeof value === 'object') return `${Object.keys(value).length} keys · sha256 ${sha(json)}`
  return `${typeof value} · sha256 ${sha(json)}`
}

// ---------------------------------------------------------------- parsing ---

/**
 * Free identifiers of a node: everything it needs bound from outside.
 *
 * `skip` drops a subtree — the `query=` attribute is skipped when working out
 * what a surface READS, because the query it advertises is exactly the thing
 * being checked against the figure it sits above.
 */
function freeIdentifiers(node, skip = () => false) {
  const free = new Map()
  const bindingNames = (name, into) => {
    if (ts.isIdentifier(name)) into.add(name.text)
    else ts.forEachChild(name, (c) => bindingNames(c, into))
  }
  const walk = (n, scope) => {
    if (skip(n)) return
    if (ts.isTypeNode(n)) return
    if (ts.isIdentifier(n)) {
      if (!scope.has(n.text) && !free.has(n.text)) free.set(n.text, n)
      return
    }
    if (ts.isPropertyAccessExpression(n)) return walk(n.expression, scope)
    if (ts.isPropertyAssignment(n)) {
      if (ts.isComputedPropertyName(n.name)) walk(n.name.expression, scope)
      return walk(n.initializer, scope)
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      if (!scope.has(n.name.text) && !free.has(n.name.text)) free.set(n.name.text, n.name)
      return
    }
    // `title` in title={x} is an attribute name, not a reference to a binding.
    if (ts.isJsxAttribute(n)) return n.initializer ? walk(n.initializer, scope) : undefined
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) return walk(n.attributes, scope)
    if (ts.isJsxClosingElement(n)) return
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) {
      const inner = new Set(scope)
      if (n.name && ts.isIdentifier(n.name)) inner.add(n.name.text)
      for (const p of n.parameters) bindingNames(p.name, inner)
      return n.body ? walk(n.body, inner) : undefined
    }
    ts.forEachChild(n, (c) => walk(c, scope))
  }
  walk(node, new Set())
  return free
}

/** True when an attribute is literal text rather than an expression or a JSX tree. */
function isLiteralText(el, name) {
  const a = el.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
  )
  if (!a || !a.initializer) return false
  const init = a.initializer
  if (ts.isStringLiteral(init)) return true
  if (!ts.isJsxExpression(init) || !init.expression) return false
  const e = init.expression
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)
}

/** Does this element carry a customer-facing name at all? */
const hasLabel = (el) => LABEL_ATTRS.some((want) => el.attributes.properties.some(
  (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === want && a.initializer,
))

/** The customer-facing name of a component, from whichever label attribute it carries. */
function labelOf(el, sf, where) {
  for (const want of LABEL_ATTRS) {
    const attr = el.attributes.properties.find(
      (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === want,
    )
    if (!attr || !attr.initializer) continue
    const init = attr.initializer
    if (ts.isStringLiteral(init)) return init.text
    if (!ts.isJsxExpression(init) || !init.expression) continue
    const e = init.expression
    if (ts.isStringLiteral(e)) return e.text
    if (ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return flat(e.getText(sf).slice(1, -1))
    if (ts.isJsxElement(e) || ts.isJsxFragment(e)) return jsxTextOf(e, sf)
    return flat(e.getText(sf))
  }
  throw new Error(`${where}: <${el.tagName.getText(sf)} query={…}> has no ${LABEL_ATTRS.join(' or ')} attribute, so the snapshot has nothing to key it by.`)
}

/** Readable text of a JSX title: its words, with interpolations left as written. */
function jsxTextOf(node, sf) {
  const parts = []
  const walk = (n) => {
    if (ts.isJsxText(n)) {
      const t = flat(n.text)
      if (t) parts.push(t)
      return
    }
    if (ts.isJsxExpression(n)) {
      if (n.expression) parts.push(`{${flat(n.expression.getText(sf))}}`)
      return
    }
    if (ts.isJsxElement(n)) return n.children.forEach(walk)
    if (ts.isJsxFragment(n)) return n.children.forEach(walk)
  }
  node.children.forEach(walk)
  return parts.join(' ')
}

/** The expression node behind one JSX attribute, or null when it carries none. */
function attrExpr(el, name) {
  const a = el.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
  )
  if (!a || !a.initializer) return null
  const init = a.initializer
  if (ts.isStringLiteral(init)) return init
  return ts.isJsxExpression(init) ? (init.expression ?? null) : null
}

/** One JSX attribute as written: the literal for a string, the expression text otherwise. */
function attrOf(el, name, sf) {
  const a = el.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
  )
  if (!a || !a.initializer) return undefined
  const init = a.initializer
  if (ts.isStringLiteral(init)) return init.text
  if (ts.isJsxExpression(init) && init.expression) return flat(init.expression.getText(sf))
  return undefined
}

/** One caption attribute, but only when it is literal text — see CAPTION_ATTRS. */
function captionOf(el, name, sf) {
  const a = el.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
  )
  if (!a || !a.initializer) return undefined
  const init = a.initializer
  if (ts.isStringLiteral(init)) return init.text
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return flat(e.getText(sf))
  }
  return undefined
}

/**
 * The `.map()` receivers a node is rendered inside, outermost first.
 *
 * A fixture's `$each` names the domain a surface is enumerated over, but a
 * fixture is a DECLARATION — narrowing the map in the JSX (AMI_FAMILIES →
 * AMI_FAMILIES.slice(0, 3)) silently drops four panels off the screen while the
 * declared domain, the query, the prose and the counts all stay put. Recording
 * the receiver as written ties the declaration back to the code: change what the
 * component actually iterates and the snapshot moves.
 */
function renderedOver(node, sf) {
  const out = []
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isCallExpression(cur) || !ts.isPropertyAccessExpression(cur.expression)) continue
    const method = cur.expression.name.text
    if (method !== 'map' && method !== 'flatMap') continue
    out.unshift(flat(cur.expression.expression.getText(sf)))
  }
  return out
}

/** The variable a search call's result is assigned to, or null if it is not assigned. */
function assignedName(call) {
  let cur = call.parent
  while (cur) {
    if (ts.isVariableDeclaration(cur)) return ts.isIdentifier(cur.name) ? cur.name.text : null
    if (ts.isExpressionStatement(cur) || ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isReturnStatement(cur)) return null
    cur = cur.parent
  }
  return null
}

/** True when `name` is a parameter of some function enclosing `node`. */
function isEnclosingParameter(node, name) {
  const declares = (fn) => {
    const found = new Set()
    // Never return a value from the visitor: ts.forEachChild stops at the first
    // truthy one, which would drop every parameter after the first.
    const bind = (n) => {
      if (ts.isIdentifier(n)) found.add(n.text)
      else ts.forEachChild(n, bind)
    }
    for (const p of fn.parameters) bind(p.name)
    return found.has(name)
  }
  for (let cur = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && declares(cur)) return true
  }
  return false
}

/**
 * Every .tsx under src/, tests and the freeze's own data directories excluded.
 *
 * The skip is BY EXACT NAME. It used to skip any directory whose name began with
 * `__`, meaning to catch __fixtures__ and __frozen__ — but that also made a
 * component under, say, src/components/__generated__ or src/tabs/__wip__
 * invisible to the freeze, query and all, with nothing anywhere saying so.
 */
function tsxFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...tsxFiles(p))
    } else if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) out.push(p)
  }
  return out
}

/** Everything one source file offers the snapshot, found by parsing alone. */
function readFile(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports = new Map()
  const locals = new Map()
  const funcs = new Map()
  const states = new Map()
  const surfaces = []
  const searches = []
  const links = []
  const briefs = []
  const prose = []
  const passthrough = []
  const at = (n) => `${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) funcs.set(st.name.text, st)
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const spec = st.moduleSpecifier.text
    const clause = st.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const el of clause.namedBindings.elements) {
      if (el.isTypeOnly) continue
      imports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text })
    }
  }

  /** A bare identifier that is a prop of the enclosing component forwards its caller's query. */
  const forwarded = (expr) => ts.isIdentifier(expr) && isEnclosingParameter(expr, expr.text)

  const walk = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const list = locals.get(n.name.text) ?? []
      list.push(n.initializer)
      locals.set(n.name.text, list)
    }
    // `const [metric, setMetric] = useState('resets')` decides which query runs
    // on first paint, so the default is as much a part of the frozen screen as
    // the query text. Only primitive defaults: an object initializer is
    // component bookkeeping, not a mode switch.
    if (
      ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer &&
      ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) &&
      n.initializer.expression.text === 'useState' && n.initializer.arguments.length === 1
    ) {
      const arg = n.initializer.arguments[0]
      const first = n.name.elements[0]
      const primitive =
        ts.isStringLiteral(arg) || ts.isNumericLiteral(arg) ||
        arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword ||
        arg.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isPrefixUnaryExpression(arg) && ts.isNumericLiteral(arg.operand))
      if (primitive && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
        states.set(first.name.text, { text: flat(arg.getText(sf)), node: arg })
      }
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const attr = n.attributes.properties.find(
        (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === 'query',
      )
      if (attr && attr.initializer) {
        const init = attr.initializer
        const expr = ts.isJsxExpression(init) ? init.expression : init
        if (!expr) throw new Error(`${at(n)}: <${n.tagName.getText(sf)} query={}> is empty.`)
        const component = n.tagName.getText(sf)
        if (forwarded(expr)) {
          passthrough.push({ key: `<${component} query={${expr.text}}>`, why: `\`${expr.text}\` is a prop of the enclosing component` })
        } else {
          // The whole element, so that what it renders counts as what it reads.
          const el = ts.isJsxOpeningElement(n) && ts.isJsxElement(n.parent) ? n.parent : n
          surfaces.push({ component, label: labelOf(n, sf, at(n)), expr, el, open: n, over: renderedOver(n, sf), where: at(n) })
        }
      } else if (isLiteralText(n, 'info') && hasLabel(n)) {
        // An ⓘ with words but no query still explains a number to a customer —
        // three coverage tiles and the "not observable in this feed" panel.
        // There is no provenance to resolve, so only the words are frozen.
        prose.push({ kind: 'info', component: n.tagName.getText(sf), label: labelOf(n, sf, at(n)), open: n, over: renderedOver(n, sf), where: at(n) })
      } else if (attrExpr(n, 'about')) {
        // An ⓘ whose words are an EXPRESSION rather than a literal: the Deep
        // Observability Pipeline builds every diagram-node popover as
        // <PanelInfo about={s.purpose} links={s.links} />, which carries no
        // query and no title, so that whole tab used to freeze nothing at all.
        // The words are resolved, not transcribed, and enumerated over the
        // stage data by the `s` fixture.
        prose.push({ kind: 'about', component: n.tagName.getText(sf), expr: attrExpr(n, 'about'), open: n, over: renderedOver(n, sf), where: at(n) })
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const callee = n.expression.text
      const arg = n.arguments[0]
      const opts = n.arguments[1]
      const optText = opts ? flat(opts.getText(sf)) : undefined
      if (SEARCH_CALLS.has(callee)) {
        if (!arg) throw new Error(`${at(n)}: ${callee}() was called with no query argument.`)
        if (forwarded(arg)) {
          passthrough.push({ key: `${callee}(${flat(n.arguments.map((a) => a.getText(sf)).join(', '))})`, why: `\`${arg.text}\` is a prop of the enclosing component` })
        } else {
          const name = assignedName(n)
          searches.push({ callee, assigned: name, key: name ?? `${callee}(${flat(arg.getText(sf))})`, expr: arg, options: optText, optionsNode: opts, over: renderedOver(n, sf), where: at(n) })
        }
      } else if (callee === LINK_CALL || callee === BRIEF_CALL) {
        if (!arg) throw new Error(`${at(n)}: ${callee}() was called with no query argument.`)
        if (forwarded(arg)) {
          passthrough.push({ key: `${callee}(${flat(n.arguments.map((a) => a.getText(sf)).join(', '))})`, why: `\`${arg.text}\` is a prop of the enclosing component` })
        } else if (callee === LINK_CALL) {
          links.push({ key: flat(arg.getText(sf)), expr: arg, window: optText, windowNode: opts, over: renderedOver(n, sf), where: at(n) })
        } else {
          briefs.push({ key: flat(arg.getText(sf)), expr: arg, over: renderedOver(n, sf), where: at(n) })
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(sf, walk)

  return { file, rel: rel(file), sf, imports, locals, funcs, states, surfaces, searches, links, briefs, prose, passthrough }
}

// -------------------------------------------------------------- resolving ---

/** A fixture that names a DOMAIN — everything reading it is frozen once per case. */
const isEachSpec = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && '$each' in v

const moduleCache = new Map()

async function loadModule(absNoExt) {
  if (!moduleCache.has(absNoExt)) moduleCache.set(absNoExt, await import(pathToFileURL(`${absNoExt}.ts`).href))
  return moduleCache.get(absNoExt)
}

/**
 * Compile one expression to a callable.
 *
 * The plain path handles the ordinary case; the TypeScript fallback exists for
 * the few expressions that carry annotations (a tab-level helper's signature),
 * and strips the types rather than guessing at them.
 */
function compile(text, names, where) {
  try {
    return new Function(...names, `'use strict'\nreturn (${text})`)
  } catch {
    try {
      const js = ts.transpileModule(`const __value = (${text});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
      }).outputText
      return new Function(...names, `'use strict'\n${js}\nreturn __value`)
    } catch (err) {
      throw new Error(`${where}: could not evaluate \`${flat(text)}\` as a plain JavaScript expression (${err.message}).`)
    }
  }
}

/**
 * Bind every free name an expression uses, then run it.
 *
 * Precedence is fixtures > useState defaults > tab locals / helpers > imports.
 * Fixtures win on purpose: a builder's argument is runtime input (a clicked row,
 * a filter) and the fixture is the frozen stand-in for it. useState defaults
 * come next because they are what the customer's FIRST SCREEN runs — the tab's
 * own answer to "which query, with which arguments", not a sample of it.
 */
function makeScope(tab, fixtures, usedFixtures) {
  const resolving = new Set()
  const done = new Map()

  const lookup = async (name, where) => {
    if (Object.hasOwn(fixtures, name)) {
      usedFixtures.add(name)
      if (isEachSpec(fixtures[name])) {
        throw new Error(`${where}: fixture \`${name}\` declares a DOMAIN with $each, so everything that reads it must be frozen once per case. This expression was evaluated with no case bound, which means the enumeration did not see the dependency.`)
      }
      return fixtureValue(name, where)
    }
    if (tab.states.has(name)) return evaluate(tab.states.get(name).node, tab.sf, `${tab.rel} useState default \`${name}\``)
    if (tab.locals.has(name)) {
      const inits = tab.locals.get(name)
      const texts = new Set(inits.map((i) => flat(i.getText(tab.sf))))
      if (texts.size > 1) {
        throw new Error(`${where}: \`${name}\` is declared ${inits.length} times in ${tab.rel} with different initializers (${[...texts].join(' | ')}), so the snapshot cannot tell which one this is. Pin it with a fixture in src/queries/__fixtures__/args.ts.`)
      }
      if (done.has(name)) return done.get(name)
      if (resolving.has(name)) throw new Error(`${where}: \`${name}\` is defined in terms of itself.`)
      resolving.add(name)
      const v = await evaluate(inits[0], tab.sf, `${tab.rel} local \`${name}\``)
      resolving.delete(name)
      done.set(name, v)
      return v
    }
    if (tab.funcs.has(name)) {
      if (done.has(name)) return done.get(name)
      const v = await evaluate(tab.funcs.get(name), tab.sf, `${tab.rel} function \`${name}\``)
      done.set(name, v)
      return v
    }
    if (tab.imports.has(name)) {
      const { spec, imported } = tab.imports.get(name)
      if (!LOADABLE_RE.test(spec)) {
        throw new Error(`${where}: \`${name}\` comes from ${spec}, which the freeze cannot load under plain Node. Pin it with a fixture in src/queries/__fixtures__/args.ts, or move the value into src/queries or src/data.`)
      }
      const mod = await loadModule(resolvePath(dirname(tab.file), spec))
      if (!(imported in mod)) throw new Error(`${where}: ${spec} does not export \`${imported}\`.`)
      return mod[imported]
    }
    throw new Error(`${where}: nothing binds \`${name}\`. It is neither imported from a loadable module, nor a resolvable local, nor a useState default, so the query behind this surface cannot be resolved. Add a fixture for it under FIXTURES['${tab.rel}'] in src/queries/__fixtures__/args.ts.`)
  }

  const fixtureValue = async (name, where) => {
    const raw = fixtures[name]
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // A fixture may name an exported builder instead of inlining its output,
      // so that a fragment like serverFilter() is exercised rather than
      // transcribed…
      if ('$call' in raw) {
        const fn = await lookup(raw.$call, where)
        if (typeof fn !== 'function') throw new Error(`${where}: fixture \`${name}\` calls \`${raw.$call}\`, which is not a function.`)
        return fn(...(raw.args ?? []))
      }
      // …or read the real catalog rather than transcribe a row of it. A
      // transcribed fixture drifts from the data it claims to sample, silently.
      if ('$expr' in raw) return evalText(raw.$expr, name, `FIXTURES['${tab.rel}'].${name}`)
      // …or name the whole DOMAIN the surface is rendered over, so a panel
      // inside a .map() is frozen once per row instead of once.
      if ('$each' in raw) {
        const cases = await evalText(raw.$each, name, `FIXTURES['${tab.rel}'].${name}`)
        const where = `FIXTURES['${tab.rel}'].${name}`
        if (!Array.isArray(cases) || cases.length === 0) {
          throw new Error(`${where}: $each produced no cases, so nothing that depends on \`${name}\` would be frozen at all.`)
        }
        for (const c of cases) {
          if (!c || typeof c !== 'object' || typeof c.label !== 'string' || !('value' in c)) {
            throw new Error(`${where}: $each must yield [{ label: <string>, value: <the binding> }]; got ${flat(JSON.stringify(c) ?? String(c))}.`)
          }
        }
        return cases
      }
    }
    return raw
  }

  /** Evaluate a fixture's expression TEXT in the tab's own scope. */
  const evalText = async (text, name, where) => {
    if (resolving.has(`$${name}`)) throw new Error(`${where}: fixture \`${name}\` is defined in terms of itself.`)
    resolving.add(`$${name}`)
    const exprSf = ts.createSourceFile(`fixture:${name}`, `(${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const v = await evaluate(exprSf.statements[0].expression, exprSf, where)
    resolving.delete(`$${name}`)
    return v
  }

  const evaluate = async (node, sf, where) => {
    const names = []
    const values = []
    for (const [name] of freeIdentifiers(node)) {
      if (GLOBALS.has(name)) continue
      names.push(name)
      values.push(await lookup(name, where))
    }
    return compile(node.getText(sf), names, where)(...values)
  }

  return { evaluate, fixtureValue, lookup }
}

/**
 * The search results a JSX element actually reads, resolved through tab locals.
 *
 * This is the binding the snapshot was missing: the ⓘ names a query, and this
 * names the hook whose rows the figure above it is computed from. Move the
 * figure to another hook and these disagree, which is the whole point — the
 * `query=` attribute itself is skipped, since it is the claim under test.
 */
function readsOf(el, tab, searchVars, skip) {
  const out = new Set()
  const seen = new Set()
  const expand = (names) => {
    for (const name of names) {
      if (seen.has(name)) continue
      seen.add(name)
      if (searchVars.has(name)) {
        out.add(name)
        continue
      }
      for (const init of tab.locals.get(name) ?? []) expand([...freeIdentifiers(init).keys()])
    }
  }
  expand([...freeIdentifiers(el, skip).keys()])
  return [...out].sort()
}

/**
 * Every name an expression needs, walked through the tab's own locals and
 * helpers — but STOPPING at a fixture, because a fixture short-circuits the
 * local of the same name when the expression is evaluated.
 *
 * This decides which $each domains a site is enumerated over. Stopping at
 * fixtures matters: FieldExplorer declares `rows` twice with different
 * initializers, and expanding through the one the fixture replaces would drag
 * the use-case domain into the coverage panels and freeze 7 × 11 phantom rows.
 */
function dependsOn(node, tab, fixtures) {
  const seen = new Set()
  const stack = [...freeIdentifiers(node).keys()]
  while (stack.length) {
    const name = stack.pop()
    if (seen.has(name) || GLOBALS.has(name)) continue
    seen.add(name)
    if (Object.hasOwn(fixtures, name) || tab.states.has(name)) continue
    for (const init of tab.locals.get(name) ?? []) stack.push(...freeIdentifiers(init).keys())
    const fn = tab.funcs.get(name)
    if (fn) stack.push(...freeIdentifiers(fn).keys())
  }
  return seen
}

/**
 * One binding set per rendered row: the cross-product of the $each domains a
 * site depends on, labelled the way the domain labelled itself.
 */
function caseCombos(over, domains) {
  let rows = [{ label: '', binds: {} }]
  for (const name of over) {
    rows = rows.flatMap((row) => domains[name].map((c) => ({
      label: row.label ? `${row.label} · ${c.label}` : c.label,
      binds: { ...row.binds, [name]: c.value },
    })))
  }
  return rows
}

/** True for a value a snapshot can print as itself rather than as a digest. */
const isLiteralValue = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

/**
 * A search call's options, resolved rather than transcribed.
 *
 * The source text alone is not a freeze: hoisting `{ earliest: '-30d' }` into a
 * named const would freeze the NAME and put the window — which decides what the
 * number means — outside the snapshot for good. So the expression is resolved
 * the way `query` is. Per KEY, though, and best-effort: `signal` is an
 * AbortSignal and `costSlot` a live cost slot, neither of which exists outside a
 * running app, and `earliest: range.earliest` is the page's range picker. Those
 * cannot resolve and are not meant to — every key that changes what the number
 * COUNTS is a literal, and every key's NAME still shows in the source text
 * beside this.
 */
async function resolveOptions(scope, node, sf, where) {
  const pick = (obj) => {
    const out = {}
    for (const [k, v] of Object.entries(obj)) if (isLiteralValue(v)) out[k] = v
    return Object.keys(out).length ? out : undefined
  }
  // The whole expression first, so `useSearch(Q, LAKE_WINDOW)` resolves to the
  // window rather than freezing the identifier LAKE_WINDOW.
  try {
    const v = await scope.evaluate(node, sf, where)
    if (v && typeof v === 'object') return pick(v)
  } catch { /* some key is runtime plumbing — fall through and take the rest */ }
  if (!ts.isObjectLiteralExpression(node)) return undefined
  const out = {}
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    if (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) continue
    try {
      const v = await scope.evaluate(p.initializer, sf, where)
      if (isLiteralValue(v)) out[p.name.text] = v
    } catch { /* runtime plumbing: an AbortSignal, a cost slot, the page's range */ }
  }
  return Object.keys(out).length ? out : undefined
}

/** A single literal argument resolved the same way — a deep link's time bound. */
async function resolveScalar(scope, node, sf, where) {
  try {
    const v = await scope.evaluate(node, sf, where)
    return isLiteralValue(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** The "Open in Cribl" links beside an ⓘ, as the customer reads and clicks them. */
async function resolveLinks(scope, node, sf, where) {
  let v
  try {
    v = await scope.evaluate(node, sf, where)
  } catch {
    return UNBOUND
  }
  if (!Array.isArray(v)) return UNBOUND
  return v.map((l) => `${l?.label} → ${l?.href}`)
}

/** One snapshot entry: what the JSX points at, and what that is. */
async function entryFor(scope, expr, sf, where) {
  const src = flat(expr.getText(sf))
  const value = await scope.evaluate(expr, sf, where)
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: \`${src}\` resolved to ${JSON.stringify(value)} rather than a query string. Every surface must resolve — a placeholder here would never diff again. Give its runtime argument a fixture in src/queries/__fixtures__/args.ts.`)
  }
  return { ref: src, shape: shapeOf(value), query: value }
}

/**
 * Whole query or fragment.
 *
 * Most exports are whole queries: q() has already prefixed the dataset. A few
 * are bare filters that something else wraps in q() later, and those resolve to
 * a string with no `dataset=` — correct, but it reads as malformed in a
 * snapshot unless it is labelled, so it is.
 */
const shapeOf = (s) => (/^dataset\s*=\s*"/.test(s) ? 'query' : 'fragment')

const put = (bucket, key, entry, where, kind) => {
  if (Object.hasOwn(bucket, key)) throw new Error(`${where}: two ${kind} entries share the key "${key}", so one would hide the other in the snapshot.`)
  bucket[key] = entry
}

const sorted = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)))

/**
 * Every field the snapshot marked UNBOUND, addressed the way a reviewer reads
 * it. The test re-counts these from the entries, so the two can never drift.
 */
function unboundFields(files) {
  const out = []
  for (const [file, buckets] of Object.entries(files)) {
    for (const [bucket, entries] of Object.entries(buckets)) {
      for (const [key, entry] of Object.entries(entries)) {
        for (const [field, value] of Object.entries(entry)) {
          if (value === UNBOUND) out.push(`${file} › ${bucket} › ${key} › ${field}`)
        }
      }
    }
  }
  return out.sort()
}

// ------------------------------------------------------ module enumeration ---

/**
 * Every export of every src/queries module, with each builder enumerated over
 * its DOMAIN rather than one sampled argument tuple.
 *
 * A fixture pins one tuple; every other branch is then unfrozen, which is how
 * an untaken ternary inside a builder, an unvisited pivot and sixteen of
 * seventeen catalog filters all stayed outside the freeze. The domains are
 * already exported next to the builders (PIVOTS, METRICS, Mask, FINDINGS,
 * TECHNIQUES, AMI_*), so VARIANTS names the domain expression and this
 * enumerates it. A builder with no spec is a THROW: "every export of
 * src/queries is frozen" has to stay true as builders are added.
 */
async function enumerateModules(VARIANTS) {
  const out = {}
  let count = 0
  const files = readdirSync(QUERIES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()
  const known = new Set(files.map((f) => rel(join(QUERIES_DIR, f))))
  const stale = Object.keys(VARIANTS).filter((k) => !known.has(k))
  if (stale.length) throw new Error(`src/queries/__fixtures__/args.ts: VARIANTS names ${stale.map((s) => `\`${s}\``).join(', ')}, which is not a module under src/queries. A spec nothing reads is rot — delete it, or fix the path.`)

  for (const f of files) {
    const abs = join(QUERIES_DIR, f)
    const key = rel(abs)
    const mod = await loadModule(abs.slice(0, -3))
    const specs = VARIANTS[key] ?? {}
    const entries = {}

    // Domain expressions read the module's own exports plus everything exported
    // by the modules it imports — the real catalogs, never a transcription.
    const scope = new Map(Object.entries(mod))
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
      const spec = st.moduleSpecifier.text
      if (!LOADABLE_RE.test(spec)) continue
      const imported = await loadModule(resolvePath(dirname(abs), spec))
      for (const [n, v] of Object.entries(imported)) if (!scope.has(n)) scope.set(n, v)
    }
    const names = [...scope.keys()]
    const values = [...scope.values()]
    const run = (text, where) => compile(text, names, where)(...values)

    for (const [name, value] of Object.entries(mod).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (typeof value === 'string') {
        entries[name] = value
        continue
      }
      if (typeof value !== 'function') {
        entries[name] = digestOf(value)
        continue
      }
      const spec = specs[name]
      if (!spec) {
        throw new Error(`${key} exports the builder \`${name}\`, but src/queries/__fixtures__/args.ts declares no domain for it under VARIANTS['${key}']. Freezing one sampled argument leaves every other branch unfrozen; name the domain (\`over\`) or the cases (\`cases\`) so all of them are frozen.`)
      }
      const where = `VARIANTS['${key}'].${name}`
      const cases = spec.cases
        ? run(spec.cases, where)
        : crossProduct((spec.over ?? []).map((text) => run(text, `${where} domain \`${text}\``)), where, name)
      if (!Array.isArray(cases) || cases.length === 0) throw new Error(`${where}: produced no cases, so \`${name}\` would not be frozen at all.`)
      for (const c of cases) {
        const label = `${name}(${c.label})`
        if (Object.hasOwn(entries, label)) throw new Error(`${where}: two cases share the label "${label}".`)
        const result = value(...c.args)
        entries[label] = typeof result === 'string' ? result : JSON.stringify(result)
      }
      if (spec.digest) {
        // A domain too large to read one line at a time still has to be frozen,
        // so it is frozen whole rather than sampled.
        const all = cases.map((c) => `${c.label} → ${JSON.stringify(value(...c.args))}`).join('\n')
        for (const c of cases) delete entries[`${name}(${c.label})`]
        entries[`${name}(…)`] = `${cases.length} cases · sha256 ${sha(all)}`
      }
    }
    const unknown = Object.keys(specs).filter((n) => typeof mod[n] !== 'function')
    if (unknown.length) throw new Error(`VARIANTS['${key}'] declares ${unknown.map((u) => `\`${u}\``).join(', ')}, which ${key} does not export as a function. A spec nothing reads is rot — delete it, or fix the name.`)

    out[key] = sorted(entries)
    count += Object.keys(entries).length
  }
  return { modules: out, count }
}

/** Cross-product of the declared domains, labelled by the arguments themselves. */
function crossProduct(domains, where, name) {
  const label = (v) => {
    if (v === null) return 'null'
    if (typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of ['id', 'key', 'name']) if (typeof v[k] === 'string') return `#${v[k]}`
    }
    throw new Error(`${where}: an argument to \`${name}\` has no readable label (${flat(JSON.stringify(v) ?? String(v))}). Give the domain explicit cases with \`cases\`, so the snapshot stays readable.`)
  }
  let rows = [{ label: '', args: [] }]
  for (const domain of domains) {
    if (!Array.isArray(domain)) throw new Error(`${where}: a domain resolved to ${typeof domain} rather than an array of values.`)
    rows = rows.flatMap((row) => domain.map((v) => ({
      label: row.label ? `${row.label}, ${label(v)}` : label(v),
      args: [...row.args, v],
    })))
  }
  return rows
}

// ----------------------------------------------------------------- driver ---

export async function extract() {
  const { FIXTURES, VARIANTS } = await import(pathToFileURL(FIXTURES_MODULE).href)
  const files = tsxFiles(SRC_DIR)
  const out = {}
  const fixturesUsed = {}
  const states = {}
  const passthrough = {}

  for (const file of files) {
    const tab = readFile(file)
    if (!tab.surfaces.length && !tab.searches.length && !tab.links.length && !tab.briefs.length && !tab.prose.length && !tab.passthrough.length) continue

    for (const p of tab.passthrough) {
      const key = `${tab.rel} › ${p.key}`
      passthrough[key] = (passthrough[key] ?? 0) + 1
    }
    if (!tab.surfaces.length && !tab.searches.length && !tab.links.length && !tab.briefs.length && !tab.prose.length) continue

    const fixtures = FIXTURES[tab.rel] ?? {}
    const used = new Set()
    const scope = makeScope(tab, fixtures, used)
    const searchVars = new Set(tab.searches.map((s) => s.assigned).filter(Boolean))
    const surfaces = {}
    const searches = {}
    const links = {}
    const briefs = {}
    const prose = {}

    // A fixture that names a DOMAIN makes one entry per rendered row, so a
    // panel inside a .map() is frozen seven times rather than once.
    const domains = {}
    for (const name of Object.keys(fixtures)) {
      if (isEachSpec(fixtures[name])) domains[name] = await scope.fixtureValue(name, `${tab.rel} fixture \`${name}\``)
    }
    const eachNames = Object.keys(domains).sort()
    const casesFor = (node) => {
      if (!eachNames.length) return [{ suffix: '', scope }]
      const deps = dependsOn(node, tab, fixtures)
      const over = eachNames.filter((n) => deps.has(n))
      if (!over.length) return [{ suffix: '', scope }]
      for (const name of over) used.add(name)
      return caseCombos(over, domains).map((c) => ({
        suffix: ` · ${c.label}`,
        scope: makeScope(tab, { ...fixtures, ...c.binds }, used),
      }))
    }

    for (const s of tab.surfaces) {
      // Skip the `query=` attribute when reading the element: everything else it
      // touches is the number the popover claims to explain. An element that
      // names no search variable at all is recorded UNBOUND, not `[]` — see the
      // LIMITS note; nothing about its figure was checked.
      const reads = readsOf(s.el, tab, searchVars, (n) => ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && n.name.text === 'query')
      for (const c of casesFor(s.expr)) {
        const where = `${s.where} <${s.component} title="${s.label}">${c.suffix}`
        const entry = await entryFor(c.scope, s.expr, tab.sf, where)
        if (s.over.length) entry.renderedOver = s.over
        entry.reads = reads.length ? reads : UNBOUND
        for (const a of FIGURE_ATTRS) {
          const text = attrOf(s.open, a, tab.sf)
          if (text !== undefined) entry[a] = text
        }
        for (const a of TEXT_ATTRS) {
          const text = attrOf(s.open, a, tab.sf)
          if (text !== undefined) entry[a] = text
        }
        for (const a of CAPTION_ATTRS) {
          const text = captionOf(s.open, a, tab.sf)
          if (text !== undefined) entry[a] = text
        }
        put(surfaces, `${s.component} · ${s.label}${c.suffix}`, entry, where, 'ⓘ surface')
      }
    }
    for (const s of tab.searches) {
      for (const c of casesFor(s.expr)) {
        const where = `${s.where} ${s.callee}() → ${s.key}${c.suffix}`
        const entry = await entryFor(c.scope, s.expr, tab.sf, where)
        if (s.over.length) entry.renderedOver = s.over
        // A pinned `earliest` decides what the number means — DataFlow's Lake
        // card counts 30 days while its ⓘ shows a query with no window in it.
        // Frozen as written AND as resolved: the text alone would freeze the
        // name of a hoisted const instead of the window inside it.
        if (s.options !== undefined) {
          entry.options = s.options
          const value = await resolveOptions(c.scope, s.optionsNode, tab.sf, where)
          if (value !== undefined) entry.optionsValue = value
        }
        put(searches, `${s.key}${c.suffix}`, entry, where, 'search call site')
      }
    }
    for (const l of tab.links) {
      for (const c of casesFor(l.expr)) {
        const where = `${l.where} ${LINK_CALL}(${l.key})${c.suffix}`
        const entry = await entryFor(c.scope, l.expr, tab.sf, where)
        if (l.over.length) entry.renderedOver = l.over
        if (l.window !== undefined) {
          entry.window = l.window
          const value = await resolveScalar(c.scope, l.windowNode, tab.sf, where)
          if (value !== undefined) entry.windowValue = value
        }
        put(links, `${l.key}${c.suffix}`, entry, where, 'deep link')
      }
    }
    for (const b of tab.briefs) {
      for (const c of casesFor(b.expr)) {
        const where = `${b.where} ${BRIEF_CALL}(${b.key})${c.suffix}`
        const text = await c.scope.evaluate(b.expr, tab.sf, where)
        if (typeof text !== 'string' || text.trim() === '') {
          throw new Error(`${where}: the Copilot brief resolved to ${JSON.stringify(text)} rather than text.`)
        }
        const entry = { ref: flat(b.expr.getText(tab.sf)), brief: text }
        if (b.over.length) entry.renderedOver = b.over
        put(briefs, `${b.key}${c.suffix}`, entry, where, 'Copilot brief')
      }
    }
    for (const p of tab.prose) {
      if (p.kind === 'about') {
        const ref = flat(p.expr.getText(tab.sf))
        for (const c of casesFor(p.expr)) {
          const where = `${p.where} <${p.component} about={${ref}}>${c.suffix}`
          const about = await resolveScalar(c.scope, p.expr, tab.sf, where)
          const entry = { ref, about: typeof about === 'string' && about.trim() ? about : UNBOUND }
          if (p.over.length) entry.renderedOver = p.over
          for (const a of ['aboutHeading', 'label']) {
            const text = attrOf(p.open, a, tab.sf)
            if (text !== undefined) entry[a] = text
          }
          const linksNode = attrExpr(p.open, 'links')
          if (linksNode) entry.links = await resolveLinks(c.scope, linksNode, tab.sf, where)
          put(prose, `${p.component} · ${ref}${c.suffix}`, entry, where, 'ⓘ without a query')
        }
        continue
      }
      const entry = {}
      if (p.over.length) entry.renderedOver = p.over
      for (const a of [...TEXT_ATTRS, ...FIGURE_ATTRS]) {
        const text = attrOf(p.open, a, tab.sf)
        if (text !== undefined) entry[a] = text
      }
      for (const a of CAPTION_ATTRS) {
        const text = captionOf(p.open, a, tab.sf)
        if (text !== undefined) entry[a] = text
      }
      put(prose, `${p.component} · ${p.label}`, entry, `${p.where} <${p.component} title="${p.label}">`, 'ⓘ without a query')
    }

    const unused = Object.keys(fixtures).filter((k) => !used.has(k))
    if (unused.length) throw new Error(`src/queries/__fixtures__/args.ts: FIXTURES['${tab.rel}'] declares ${unused.map((u) => `\`${u}\``).join(', ')}, which nothing in ${tab.rel} needs. A fixture nothing reads is rot — delete it, or fix the name.`)

    // The fixtures a tab consumed ride along in the snapshot, so editing one is
    // a visible diff even where its value does not survive into the query text.
    // A derived fixture records the expression AND a digest of what it produced:
    // the expression is what a reviewer reads, the digest is what notices the
    // catalog underneath it moving.
    if (used.size) {
      const resolved = {}
      for (const name of [...used].sort()) {
        const raw = fixtures[name]
        const v = await scope.fixtureValue(name, `${tab.rel} fixture \`${name}\``)
        const derived = raw && typeof raw === 'object' && ('$call' in raw || '$expr' in raw || '$each' in raw)
        const from = () => {
          if ('$call' in raw) return `${raw.$call}(${(raw.args ?? []).map((a) => JSON.stringify(a)).join(', ')})`
          return '$each' in raw ? raw.$each : raw.$expr
        }
        resolved[name] = derived
          ? { from: from(), value: typeof v === 'string' ? v : digestOf(v) }
          : v
      }
      fixturesUsed[tab.rel] = resolved
    }
    if (tab.states.size) {
      states[tab.rel] = sorted(Object.fromEntries([...tab.states].map(([k, v]) => [k, v.text])))
    }
    out[tab.rel] = { surfaces, searches, links, briefs, prose }
  }

  // Data that never reaches a query string still moves the numbers the ⓘ
  // explains: reclassify a finding's severity and three KPI tiles change while
  // every popover still shows the unchanged FINDINGS_QUERY.
  const catalogs = {}
  // `.test.ts` is excluded the same way the src/queries walk excludes it: a test
  // beside the data is not a catalog, and loading one here would run it.
  for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts')).sort()) {
    const abs = join(DATA_DIR, f)
    const mod = await loadModule(abs.slice(0, -3))
    for (const [name, value] of Object.entries(mod).sort(([a], [b]) => (a < b ? -1 : 1))) {
      catalogs[`${rel(abs)} › ${name}`] = digestOf(value)
    }
  }

  const orphaned = Object.keys(FIXTURES).filter((k) => !(k in out))
  if (orphaned.length) throw new Error(`src/queries/__fixtures__/args.ts: FIXTURES names ${orphaned.map((s) => `\`${s}\``).join(', ')}, which is not a file the freeze reads. A fixture nothing reads is rot — delete it, or fix the path.`)

  const { modules, count: moduleCount } = await enumerateModules(VARIANTS)

  const counts = { surfaces: 0, searches: 0, links: 0, briefs: 0, prose: 0 }
  for (const t of Object.values(out)) for (const k of Object.keys(counts)) counts[k] += Object.keys(t[k]).length
  counts.modules = moduleCount
  counts.catalogs = Object.keys(catalogs).length
  counts.states = Object.values(states).reduce((n, s) => n + Object.keys(s).length, 0)
  counts.passthrough = Object.keys(passthrough).length
  // Every place this file says out loud that it checked nothing. Counted so the
  // number can only grow when somebody decides it should.
  counts.unbound = unboundFields(out).length

  return {
    $comment: 'Frozen by `npm run queries:extract` (scripts/extract-queries.mjs). Every string here is shown to a customer as the provenance of a number, or is data that moves one. Do not hand-edit: change src/, re-run the extractor, and review the diff.',
    $limits: LIMITS,
    counts,
    fixtures: fixturesUsed,
    states,
    passthrough: sorted(passthrough),
    catalogs,
    modules,
    files: out,
  }
}

// A failure here is a message for a human mid-refactor, not a stack trace: the
// error already says which file, which surface, and what to do about it.
let snapshot
try {
  snapshot = await extract()
} catch (err) {
  process.stderr.write(`extract-queries: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

const json = `${JSON.stringify(snapshot, null, 2)}\n`
if (process.argv.includes('--stdout')) {
  process.stdout.write(json)
} else {
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, json)
  const c = snapshot.counts
  process.stderr.write(
    `froze ${c.surfaces} ⓘ surfaces, ${c.searches} search call sites, ${c.links} deep links, ${c.briefs} Copilot briefs ` +
    `and ${c.prose} query-less ⓘ from ${Object.keys(snapshot.files).length} files, plus ${c.modules} src/queries exports, ` +
    `${c.catalogs} src/data exports, ${c.states} useState defaults and ${c.passthrough} pass-through sites → ${OUT_FILE}\n` +
    `${c.unbound} of those entries are marked ${UNBOUND}: the freeze names the site but checked nothing about the figure beside it. ` +
    'It never proves the number came from the query its ⓘ shows — read $limits in the snapshot.\n',
  )
}
