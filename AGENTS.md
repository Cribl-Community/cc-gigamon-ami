# Cribl App Platform Developer Guide

> **How to read the added notes.** This guide ships with the app scaffold. Building this app turned
> up platform behaviour it does not cover, and those notes are folded in below under
> **“Measured, not documented”** headings. They are labelled that way because the distinction is the
> value: everything else here is Cribl's own statement of the contract, whereas a measured note is
> what **one** Cribl.Cloud workspace did on **one** date. Code against it, re-check it after a
> platform upgrade, and do not quote it back to anyone as a guarantee. Where a measured note
> contradicts nothing above it, it is filling a silence — and a silence is the thing most likely to
> be misread as "so it works the obvious way".

## Versioning

`npm run package` increments your app version before creating the archive. By default, it increments the patch version, for example `1.0.0` to `1.0.1`.

Use these flags to choose a different version bump:

- `npm run package -- --minor` increments the minor version and resets patch to `0`.
- `npm run package -- --major` increments the major version and resets minor and patch to `0`.
- `npm run package -- --version X.Y.Z` sets the exact version.


## Global Variables

The following are set on `window` automatically when your app runs inside Cribl. They are read-only and always present — do **NOT** define, assign, or polyfill them in your app code, Vite config, or environment files.

| Variable | Example | Description |
|---|---|---|
| `CRIBL_API_URL` | `https://localhost:9000/api/v1` | Base URL for all Cribl API calls |
| `CRIBL_BASE_PATH` | `/app-ui/my-app` | The base path your app is mounted at |

## How to Get User Info

Your app can read basic identity and profile info for the currently signed-in Cribl user via `window.getCriblUser()`. It returns a Promise that resolves to:

| Field | Type | Always present? |
|---|---|---|
| `id` | `string` | yes |
| `username` | `string` | yes |
| `email` | `string` | no |
| `firstName` | `string` | no |
| `lastName` | `string` | no |
| `initials` | `string` | no |

Example:

```js
const user = await window.getCriblUser();
console.log(`Hello, ${user.firstName ?? user.username}!`);
```

The result is memoized — subsequent calls return the same resolved Promise. `getCriblUser` is read-only; do not redefine it.

## How API Calls Work (Fetch Proxy)

Your app runs inside a sandboxed iframe. The platform **automatically intercepts all `fetch()` calls** to `CRIBL_API_URL` and proxies them through the parent window. This is transparent to your code — just use `fetch()` normally.

**What the proxy does for you:**
- Injects authentication headers (your app never sees or handles auth tokens)
- Rewrites URLs to scope requests to your app
- Streams responses back to your app

**What this means for your code:**
- Use `fetch()` as normal — it just works
- You do NOT need to handle authentication
- You cannot override or replace `window.fetch` (it is locked)
- Requests that don't target `CRIBL_API_URL` are passed through directly (no proxy)

### URL Rewriting Rules

The proxy applies these rewrites automatically:

| What you call | What actually happens | Why |
|---|---|---|
| `fetch(CRIBL_API_URL + '/kvstore/my-key')` | Rewritten to `/api/v1/a/{yourAppId}/kvstore/my-key` | Scopes KV store access to your app |
| `fetch(CRIBL_API_URL + '/proxy/some/path')` | Rewritten to `/api/v1/a/{yourAppId}/proxy/some/path` | Scopes proxy calls to your app |
| `fetch('https://api.example.com/data')` | Rewritten to `/api/v1/a/{yourAppId}/proxy/api.example.com/data` | External calls are routed through the platform proxy |
| `fetch(CRIBL_API_URL + '/search/jobs')` | Passed through as-is | Standard API calls are not rewritten |

**Important:** Your app cannot access other apps' resources. Any request targeting a different app ID will be rejected.

### Request Timeout

Proxied requests time out after **30 seconds** if no response is received. Use `AbortController` if you need to cancel requests earlier.

## Confirming Destructive Operations

Cribl API calls act on real customer configuration and data. Some are **volatile** — they remove or irreversibly overwrite state — and have caused apps to delete things users did not expect. **Always confirm with the user before performing a volatile operation, and never trigger one automatically (e.g. on page load, render, or a background timer).**

**Volatile operations that require confirmation:**
- **`DELETE` requests** — always. This includes deleting KV store keys, config resources (inputs, outputs, pipelines, routes, lookups, etc.), and any collection or child resource.
- **`PUT` / `POST` / `PATCH` requests that overwrite or replace** existing configuration or data (e.g. replacing a pipeline definition, bulk-updating routes).

**How to confirm:**
- Require an explicit, deliberate user action (a button click) to start the operation — do not act on implicit signals.
- Before calling the API, show a confirmation prompt that names **exactly what will be affected** (the resource name/id and the action) and warns when the action cannot be undone.
- After the operation, report the outcome (success or failure) back to the user.

Read-only operations (`GET`) never need confirmation.

## Platform APIs

API endpoint definitions are available in `openapi.json` (if downloaded during project setup).

### Key-Value Store

**Do NOT use browser storage — `localStorage`, `sessionStorage`, `IndexedDB`, or cookies — for app data.** Your app runs in a sandboxed iframe where browser storage is unreliable (it can be partitioned, cleared, or blocked by the browser or platform) and is never shared across users, devices, or sessions. **Use the app-scoped KV store below for all persistence** — user preferences, app state, cached results, and any data that must survive a reload.

Each app has a scoped KV store. Use `CRIBL_API_URL` as the base — the proxy handles scoping.

| Operation | Method | URL | Body |
|---|---|---|---|
| Get | GET | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | — |
| Set | PUT | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | value |
| Delete | DELETE | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | — |
| List keys | POST | `CRIBL_API_URL + '/kvstore/keys'` | `{ prefix: 'my/key/prefix' }` |

#### Measured, not documented — the content type decides whether your write survives

Measured on a live Cribl.Cloud workspace (2026-07-31, and again on a second app and workspace on
2026-09-15 with the same result) by PUTting the same document twice:

| `Content-Type` on the PUT | What the store persisted |
|---|---|
| `application/json` | the 15-byte literal **`[object Object]`** |
| `text/plain` | the JSON verbatim — round-trips correctly |

The store parses a JSON body and then persists `String(obj)`. **The PUT answers `200` either way**,
so the app reports success and every later read is garbage. Nothing surfaces the cause unless you
inspect the stored bytes, and the symptom — settings that quietly revert — reads as a persistence
bug rather than as a header bug.

- **Write** `PUT` with `Content-Type: text/plain` and a `JSON.stringify(doc)` body.
- **Read** with `res.text()` then `JSON.parse`, *not* `res.json()`: a stored document and the
  `[object Object]` corruption are only distinguishable as bytes. `404` is "first run", not an error.
- **Treat a corrupt value as absent and leave it where it is.** The repair is one line, and it is a
  write — on load, which "Confirming Destructive Operations" above forbids. The next genuine
  user-triggered write overwrites it.
- **Per-user state takes the user id in the key** (`<ns>/prefs/<userId>`), from
  `window.getCriblUser()`. One shared document means every user overwrites the last one.

#### Measured, not documented — `POST /kvstore/keys` answers a bare array

Measured on a live workspace (2026-09-15): the call answers `200` with a **bare JSON array of key
names** — no `{ items: [...] }` envelope, though nearly every other Cribl collection endpoint has
one.

Take that as an observation rather than a contract, because there is nothing to hold it to. **The
`/kvstore/…` family does not appear in `openapi.json` at all** — checked against the copy in this
repo, spec version `4.19.0`, which carries zero `/kvstore` paths: the four rows in the table above
are documented here in this guide and nowhere in the machine-readable spec. So nothing states the
response shape, and nothing promises a later release will not wrap it the way the rest of the API
wraps collections.

Parse both shapes. The failure this avoids is the quiet one: code that reaches for `.items` on a
bare array gets `undefined`, returns an empty list, and reports **"the store is empty"** — which
looks like a normal answer, not an error, so nobody investigates it.

```js
const list = Array.isArray(body) ? body : (body?.items ?? body?.keys);
if (!Array.isArray(list)) return [];
```

### Config Group Context

Cribl REST API endpoints that don't begin with `/system/` are contextual and can be called in the context of a config group using the prefix `/m/:groupId`. Config groups can be listed using the `/master/groups` endpoint.

Endpoints beginning with `/search/` should ALWAYS use `groupId` set to `default_search` — for example: `/m/default_search/search/jobs`. Never use any other group ID for search endpoints.

When asked to build a feature, always inspect Cribl REST APIs and understand the context of the request before starting to build.

### External API Calls

To call external APIs, just use `fetch()` with the full URL. The platform will automatically route these through your app's proxy endpoint. The external domain must be declared in your app's `config/proxies.yml`.

### proxies.yml — External Domain Configuration

Your app must declare every external domain it needs to access in `config/proxies.yml`. This file lives in your project's `config/` directory and gets packaged with your app. Admins can see exactly which external endpoints your app communicates with at install time.

**Schema:**

```yaml
# config/proxies.yml
# Top-level keys are domain:port pairs (port optional, defaults to 443)

api.openai.com:
  timeout: 10000          # Optional: request timeout in ms (1000–120000, default 30000)

  # Optional: verify the upstream TLS certificate chain. Defaults to `true`.
  # Set to `false` only when targeting trusted internal endpoints that present
  # self-signed or otherwise untrusted certificates.
  rejectUnauthorized: true

  paths:                   # Optional: control which URL paths are allowed
    allowlist:             # Prefix match — request path must start with one of these
      - /v1/chat/
      - /v1/models
    blocklist:             # Prefix match — these paths are always blocked (takes precedence over allowlist)
      - /v1/admin/

  headers:                 # Optional: control header forwarding and injection
    inject:                # Headers to add to every outgoing request to this domain
      x-api-key: "'static-key'"
      Authorization: "'Bearer ' + kv.openaiApiKey"
      x-custom: kv.myHeaderValue
    allowlist:             # Only forward these headers from the original request (supports wildcards)
      - content-type
      - accept
      - x-custom-*
    blocklist:             # Never forward these headers (takes precedence, supports wildcards)
      - x-internal-*
```

**Header injection expressions** support:
- String literals: `"'my-static-value'"`
- KV store lookups: `kv.mySecretKey` (resolves encrypted KV values at request time)
- Concatenation: `"'Bearer ' + kv.apiToken"`

**Security notes:**
- Sensitive headers (`cookie`, `authorization`, `proxy-authorization`, `host`, `connection`, `transfer-encoding`) are always stripped from the original request before forwarding — use `headers.inject` to set auth headers instead
- The platform validates target domains against SSRF protections (private/reserved IPs are blocked)
- Requests are rate-limited per app (100 requests/minute)
- All proxied requests use HTTPS
- Upstream TLS certificates are verified by default (`rejectUnauthorized: true`). Disable only for trusted internal endpoints with self-signed certs.

**Example — minimal config for a single API:**

```yaml
# config/proxies.yml
api.example.com:
  headers:
    inject:
      Authorization: "'Bearer ' + kv.apiKey"
```

**Example — multiple domains with path restrictions:**

```yaml
# config/proxies.yml
api.openai.com:
  timeout: 60000
  paths:
    allowlist:
      - /v1/chat/completions
      - /v1/embeddings
  headers:
    inject:
      Authorization: "'Bearer ' + kv.openaiKey"

hooks.slack.com:
  paths:
    allowlist:
      - /services/
  headers:
    inject:
      Content-Type: "'application/json'"
```

**How it connects to fetch:** When your app calls `fetch('https://api.openai.com/v1/chat/completions', ...)`, the platform rewrites this to `/api/v1/a/{yourAppId}/proxy/api.openai.com/v1/chat/completions`, looks up `api.openai.com` in your `proxies.yml`, validates the path, injects headers, and forwards the request.

### policies.yml — Product API Access Configuration

Your app can declare which Cribl product API paths it needs to access in `config/policies.yml`. This file lives in your project's `config/` directory and gets packaged with your app. Admins can see exactly which platform resources your app requires at install time.

When an admin shares your app with a user, the declared policies are automatically granted to that user for the duration of any request made through your app. Users with existing role permissions can also access those paths through your app without needing an explicit grant.

**Schema:**

```yaml
# config/policies.yml
policies:
  - object: '/system/lookups'       # Cribl product API path
    actions: ['GET']                 # HTTP methods: GET, POST, PUT, PATCH, DELETE, or ['*'] for all
  - object: '/products/stream/groups'
    actions: ['GET']
```

**Rules:**
- Only declare paths your app genuinely needs — admins review these at install time
- App-scoped paths (`/a/${appId}/kvstore/*`, `/a/${appId}/proxy/*`) are granted automatically via the AppUser role when an admin shares your app — do not redeclare them here

**Worker (`/w/:wid`) vs group (`/m/:gid`) paths:** Some APIs are available at both `/w/:wid/...` and `/m/:gid/...`. Each prefix is a separate policy `object`.

- **App calls `/m/:gid/...`:** Declare those paths only.
- **App calls `/w/:wid/...`:** Declare those paths **and** the matching `/m/:gid/...` paths. Worker API requests are authorized against the group-equivalent path.

**Example:**

```yaml
# config/policies.yml
policies:
  - object: '/system/lookups'
    actions: ['GET']
  - object: '/products/stream/groups'
    actions: ['GET']
  - object: '/products/stream/groups/*'
    actions: ['GET'] # Required for matching child group paths
  - object: '/m/:gid/system/projects/*'
    actions: ['*'] # Wildcard: all methods for matching project paths
```

**Path matching:** Declaring `/products/stream/groups` covers that exact collection path only. If your app reads individual groups, include `/products/stream/groups/*` or `/products/stream/groups/:gid`; otherwise group results can be empty.

**How it works:** When your app calls `fetch('/api/v1/system/lookups')`, the platform rewrites this to `/api/v1/a/{yourAppId}/system/lookups`, checks that `GET /system/lookups` is declared in your `policies.yml`, and grants access if the requesting user was shared the app by an admin.

**Live preview:** editing `config/policies.yml`, `config/proxies.yml`, or `package.json` while running `npm run dev` reloads the app automatically so your changes take effect without a manual refresh.

#### Undefined, and therefore avoidable — what `*` matches

This guide offers `*` and `:name` as interchangeable ways to cover a child path, and **never says
whether `*` matches one path segment or many.** `/m/:gid/system/inputs/*` is either "every input in
the group" or "every input and everything beneath one", and those are different grants.

A live workspace cannot settle it for you either, and that is worth knowing before you go looking:
the rule above says a user who already holds a permission reaches the path without any grant, so an
**admin never exercises the matcher at all**. Testing as yourself proves nothing unless you are a
non-admin the app was shared with.

So do not guess — **name every segment**, and use `:name` for a variable one. `:name` is a single
variable segment and is what this guide itself offers as the equivalent of `*` for a child path. A
declaration with no `*` in it means the same thing under either reading, which is the only way to be
sure an admin is approving what you think you are asking for. Prefer a literal wherever the app only
ever calls one value: `/m/:gid/system/inputs/in_my_app_syslog` asks an admin for "may delete the
input this app made" rather than "may delete any input".

This is also the entry most worth a test. A path the app calls and the file does not declare is a
403 that **only non-admins ever see**, so it ships green and fails at the customer;
`src/cribl/policyCoverage.test.ts` in this repo checks this file against the source in both
directions, and asserts that no declaration contains a `*`.

## React Router

When using React Router, set the basename to `window.CRIBL_BASE_PATH`:

```jsx
<BrowserRouter basename={window.CRIBL_BASE_PATH}>
```

## Navigation

The platform synchronizes navigation between your app and the parent Cribl UI. If you use `history.pushState()` or `history.replaceState()`, the parent URL bar will update to reflect your app's current route. Navigation changes from the parent are also forwarded to your app as `popstate` events.

### Linking Out of Your App

Your app runs in a sandboxed iframe, so to leave the app, set `target="_top"` (current tab) or `target="_blank"` (new tab) explicitly.

**Recommended for internal navigation: use a client-side router** (React Router, Vue Router, TanStack Router, etc.) configured with `basename={window.CRIBL_BASE_PATH}`, and navigate with the router's `<Link>` (or equivalent). You get SPA-style transitions, automatic integration with the platform's URL sync, and no risk of the absolute-path pitfall in **Avoid** plain `<a>` tags.

| Intent | Markup |
|---|---|
| Stay inside your app (recommended) | `<Link to="/page">` from your router, with `basename={window.CRIBL_BASE_PATH}` |
| Leader UI, current tab | `<a href="/search/jobs/123" target="_top">` |
| Leader UI, new tab | `<a href="/search/jobs/123" target="_blank">` |
| External URL, current tab | `<a href="https://docs.cribl.io/..." target="_top">` |
| External URL, new tab | `<a href="https://docs.cribl.io/..." target="_blank">` |

**Live preview (`npm run dev`):** absolute paths resolve against your dev server, not the Leader UI, so `target="_top"` won't reach Cribl. Test those in installed mode.

## UI/UX

Unless the user specifies otherwise, use the Capra design system for all UI code as documentated at https://capra.cribl.io/llms.txt.

**Best Practices**

- In CSS, always use design tokens when available. Always use the custom `token()` function to reference design tokens. Never use a CSS variable directly.
- React components, both from `@capra/core` and `@capra/icons`, should rarely have CSS classes applied. Adding margins or spacing should happen outside the component with wrappers.
- Don't write CSS selectors that depend on Capra component internals, classes, or HTML structure.

### Measured, not documented — what Capra's `Modal` does not do

Measured on `@capra/core@1.8.2` / `@capra/theme@1.3.1` (2026-09) by mounting the component and
reading the DOM. Capra documents none of it, so re-measure after a minor.

**Using a design system is not an accessibility result.** It is a good start and a poor finish:
"we use Capra" is a statement about a dependency, not about what a user can read or reach.

What `Modal` already gives you, so you don't rebuild it: a `<section role="dialog" aria-labelledby>`
pointing at the `<h2>` it builds from `title`; the dialog portalled to `document.body` **outside the
app root**, with the app root marked `inert` while it is open (that is the focus trap); scroll
locked on `<html>` and released on close; overlay at `z-index: 10000`; Escape and the header ✕ both
close, and focus is restored to whatever held it before. Check the last two with a *custom* footer if
you write one — Capra's own Cancel carries a `slot="close"` that yours will not.

The two gaps to close yourself:

| Gap | What actually happens | Close it with |
|---|---|---|
| **Initial focus** | No prop controls it. Capra focuses the dialog `<section>` itself. | `autoFocus` on the button that should hold it — the mechanism verified to win. On a destructive dialog that is **Cancel**, never the destructive action. |
| **`aria-describedby`** | `ModalProps` has no such prop, and Capra does not wire `slot="description"` for `Modal` the way it does for `Drawer`. The dialog announces its title and **nothing else** on open. | One id'd container around the body, and an effect that hangs the attribute on the dialog by hand. |

Reach the dialog element through `closest('[role="dialog"]')`, not through a Capra class name — a
role is a public contract, a class name moves in a patch release.

This is the gap that makes a confirmation dialog only *look* like one. "Confirming Destructive
Operations" above requires a prompt naming exactly what will be affected and a warning when the
action cannot be undone; without `aria-describedby`, a screen-reader user hears the title and then
the buttons, and none of that text is read at all. (`ModalProps` also has no `isConfirmDisabled`,
which is why a type-to-confirm dialog needs a custom footer — prefer `aria-disabled` to `disabled`
there, so the control keeps its place in the tab order and can still explain why it is blocked.)

### Measured, not documented — a headless DOM cannot check the above

Measured on `happy-dom` 20.x (2026-09). Neither limitation is documented; both are simply absent.

- **No sequential focus navigation.** `Tab` is a `KeyboardEvent` that nothing in the environment
  interprets, so dispatching it moves focus nowhere.
- **`inert` is stored, not enforced.** It is an attribute sitting on an element; it removes nothing
  from the tab order.

So the obvious test for a dialog — press Tab repeatedly and prove focus never leaves it — **passes
against an empty document**. It passes if you delete the dialog. A green tick there is a claim that
the behaviour works, made by a runtime that never looked, and it is self-concealing: the only way to
find it is to break the code and watch the test still pass. The same shape recurs — no layout engine,
so every `getBoundingClientRect()` is zero and any "it does not overflow" or hit-area assertion is
vacuous; no resolved colour, so no contrast assertion is possible from a rendered node.

What to do instead: **assert the mechanism, and say that is what you did.** The dialog renders
outside the app root, and the app root carries `inert` while it is open and loses it on close — if
Capra stops portalling or stops marking the page inert, those fail for the right reason. Then write
the disclaimer beside them, and keep a list at the bottom of each test file of what it could **not**
assert and why. The gap between "this dialog is accessible" and "these tests pass" is exactly that
list, and it is what needs a real browser pass with a date on it.

One timing note that will otherwise make a test assert the opposite of the truth: focus management,
`inert` marking and scroll locking land a **turn after** the render that opens a dialog
(react-aria's `FocusScope`, not React). Flush a turn before measuring any of them.

