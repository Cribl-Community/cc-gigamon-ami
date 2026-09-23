# Gigamon Network Observability

[![Release](https://github.com/Cribl-Community/cc-gigamon-ami/actions/workflows/release.yml/badge.svg)](https://github.com/Cribl-Community/cc-gigamon-ami/actions/workflows/release.yml)

> **Preview.** This app is published as a preview — Gigamon AMI ingest, storage,
> visualizations, and workflows. Expect ongoing changes.

A Cribl App that turns **Gigamon Application Metadata Intelligence (AMI)** flow records into a
network-observability dashboard. It runs [Cribl Search](https://docs.cribl.io/search/)
(KQL) jobs against the `gigamon_ami` dataset in [Cribl Lake](https://docs.cribl.io/lake/) and
renders the results across focused tabs — service dependencies, TCP/DNS/TLS health, capacity and
top talkers, security findings, and more — without moving the data anywhere.

![The Flow Map tab: a service-to-service dependency graph built from Gigamon AMI flow metadata, sized by flow volume and colored by reset/latency health](./docs/screenshot-flow-map.png)

## Why

Gigamon AMI emits rich Layer 4–7 metadata (hundreds of fields per flow: service names, TCP/DNS/TLS
attributes, byte and latency counters, application identities). That firehose is only useful if you
can *ask questions of it*. This app ships a set of purpose-built, drill-down dashboards on top of
Cribl Search so you can explore AMI data where it already lives in Cribl Lake — and jump straight
into the raw Cribl Search UI whenever you want to go deeper.

## What it does

1. **Onboard the data (Guided Setup).** Idempotently provisions a real-world Gigamon syslog
   onboarding stack — a Syslog source, a parse/normalize pipeline, a route, and the `gigamon_ami`
   Cribl Lake dataset — in a Stream worker group you pick (`default` unless you change it), then
   commits and deploys it. It only *adds* resources (never edits shared ones) and can tear down
   exactly what it added.
2. **Query on demand.** Each tab issues KQL jobs against `dataset="gigamon_ami"`, polls to
   completion, and streams the result rows into the view. A global time range and auto-refresh
   interval drive every panel at once.
3. **Explore and drill down.** Rows and tiles deep-link into the real Cribl Search UI (and Cribl
   Investigate) so any dashboard number is one click away from the underlying events.
4. **Watch for searches that never finish.** Every query the app submits carries a running-time
   limit and is cancelled when you navigate away from it. The app also watches for searches of
   `gigamon_ami` that have been running far longer than anything should be — including ones it never
   started — and offers **Cancel on the ones you own**, from a click, with a dialog naming the job
   and its age.
5. **Write rarely, and only when you ask.** The dashboards read: they submit Search jobs and read
   the results. The app writes in four places — Guided Setup provisioning, its own app-scoped
   preferences and settings, generating Cribl's dataset intelligence for `gigamon_ami`, and
   cancelling a search. **Nothing writes on load, on render, or on a timer**, and nothing that
   changes your Cribl configuration happens without a confirmation that names the objects.

   *Corrected 2026-09-17. Items 4 and 5 replace one that read "**Stay read-only.** Apart from Guided
   Setup provisioning (deliberate, idempotent, and user-triggered), the app never writes to your
   Cribl config or data." The job list and the cancel arrived with the long-running-search watch
   (slice 1.8, branch `feat/phase-1.8-hang-control`); the app's own preferences and settings store
   arrived in [PR #5](https://github.com/Cribl-Community/cc-gigamon-ami/pull/5).*

![The Findings tab: severity-ranked detections — security exposures, wire faults, and service failures — each naming the AMI field that evidences it and drilling into the matching flows in Cribl Search](./docs/screenshot-findings.png)

## Features

The dashboard is organized into tabs, each answering a different operational question:

- **Flow Map** — service-to-service dependencies and traffic relationships (default landing tab)
- **Capacity & Top Talkers** — throughput, byte volumes, and the busiest hosts/services
- **TCP Health** — retransmits, resets, and connection-quality signals
- **DNS Health** — query volumes, response codes, and latency
- **Web & API** — HTTP/API activity and status-code distributions
- **TLS Posture** — protocol versions, cipher suites, and certificate signals
- **PQC Readiness** — post-quantum cryptography readiness of observed TLS
- **Shadow AI** — shadow-AI and unsanctioned SaaS application usage
- **Data Flow** — end-to-end flow-level view of the traffic
- **Security** & **Findings** — security-relevant observations surfaced from the metadata
- **Field Explorer** — browse the AMI field schema and per-field summaries
- **AMI Reference** — reference documentation for the Gigamon AMI dataset
- **Guided Setup** — provision (or tear down) the syslog → Lake onboarding stack

## Installation

> **Install from the packaged release, not from Git.** This repository holds the app's
> **source code**. Cribl's "Import from Git" only works when the repo contains the *built bundle* —
> importing a source repo installs the app record but leaves it unable to load ("App not found").
> Use the release `.tgz` instead.

1. Download the latest `cc-gigamon-ami-<version>.tgz` from the
   [Releases page](https://github.com/Cribl-Community/cc-gigamon-ami/releases/latest).
2. Log in to Cribl and click **Apps → View All**.
3. Click **Add App → Upload package** and select the downloaded `.tgz`.
4. Click **Install**.

Once installed, open the app and start on the **Guided Setup** tab if the `gigamon_ami` dataset
does not yet exist in your environment.

### What installing this app grants

The list of API paths you approve at install time (`config/policies.yml`) is not a description of
the app — it is a grant. When you share the app with a user, Cribl gives **that user** those
permissions for the duration of any request they make **through this app**. It does not widen what
they can do anywhere else in Cribl, and it does not let the app act while nobody is using it: every
call is made as the person clicking, from a click.

Most of the list is reading. The dashboards submit Cribl Search jobs in the `default_search` group,
poll them, and read their results and their billable CPU-seconds. That is what every tab except
Guided Setup spends its time doing, and none of those calls reads or changes any Cribl configuration.

**Three grants are not panel queries, and are worth naming.** They are why "the dashboards are
read-only" is not the whole sentence.

*Listing searches.* The app watches for searches of `gigamon_ami` that have been running far longer
than anything should be — its own, if the running-time limit it sets on them ever fails, and the
ones it never started (a deep link into Cribl Search, a Copilot investigation, someone's ad-hoc
query). To find them it lists the search jobs **your account can already see**
(`GET …/search/jobs`). That is a configuration-plane read: it submits no search, bills nothing, and
adds no job to the workspace's search history. It does mean the app can read the id, owner, status
and **query text** of other people's searches wherever your own role already allows that. That is
the point — a hung job is usually somebody else's — and it is worth knowing before you approve it.

*Cancelling one.* The app cancels searches **it started and you abandoned** (a range change, a tab
switch, closing the page), so they stop billing instead of running to their limit; that is your own
job, seconds old, not configuration, and it needs no dialog. The same grant lets the watch cancel a
long-running job it did **not** start — still one of your own. It lists every long-running search
the account can see and offers Cancel only where you own the job: the app does not stop work you did
not start, and nothing granted here lets it. That cancel is confirmed because of the job's *age*
rather than its owner — a deliberate click, a dialog naming the job id and how long it has been
running, and the outcome reported afterwards.

*Dataset intelligence.* The app asks whether the tenant has AI features enabled and whether Cribl
has generated a schema summary for `gigamon_ami`. If it has not, a dismissible banner offers to
generate one — a POST, from your click, that asks Cribl to store a summary of the dataset's ~319
fields so the Copilot agent does not rediscover it on every investigation.

*Added 2026-09-17. This paragraph used to end "that is all any tab except Guided Setup ever does,
and none of it touches configuration", which the long-running-search watch (slice 1.8, branch
`feat/phase-1.8-hang-control`) falsified.*

**The writes are worth reading properly.** Guided Setup can create a Syslog source, a pipeline, a
route and a Cribl Lake destination and dataset, commit them to your Leader's config repo, and deploy
that commit to a worker group — which restarts that group's Worker Processes. It only ever runs
from a button press with a confirmation that names the objects it will change, it only touches
objects it created, and it can remove the source, the pipeline and the route again. Two things it
creates it does **not** remove: the `gigamon_ami` Lake dataset, because that holds your ingested
data and deleting it is a Cribl Lake decision you should make deliberately, and the `gigamon_lake`
destination, because on most tenants it already existed and other things may route through it — so
on a tenant that lacked one, an uninstall leaves an unreferenced destination behind for you to
delete in Stream. The Git commit is permanent by design; the app never calls revert or undo.

**The one thing the app cannot narrow, and you should know about:** Guided Setup lets the user pick
which worker group to onboard into, so the group is a variable in the granted path
(`/m/:gid/...`). That means the write grants — create, update and delete of inputs and pipelines,
and replacing the routing table — apply in **every** worker group on the Leader, not only the one
the picker selects. A group has a single routing table and the API replaces it wholesale, so "this
app may rewrite the routing table of any worker group" is a fair reading of what you are approving.
What the app actually does is narrower (it edits the array it just read, leaving every other route
at its own index, and its own route carries a filter scoped to its own source), but that is the
app's behaviour, not a limit the platform enforces on it. If that is more than you want to grant,
share the app only with people you would give those permissions to anyway — the dashboards work
without Guided Setup once the dataset exists.

**One thing is deliberately absent from that file: the app's own key–value store.** `policies.yml`
declares Cribl *product* API paths; app-scoped paths (`/kvstore/…`) are granted with the app itself
when an admin shares it, and Cribl's own guidance is not to redeclare them. That store is where the
app keeps the banners you have dismissed, the worker group you last picked, the search
running-time limits an installer has raised, and an append-only log of the provisioning actions it
took. It is scoped to this app; nothing else can read it, and it holds no search results.

**The file declares no wildcards, on purpose.** Cribl's developer guide offers `*` and `:name` as
ways to cover a child path and never says whether `*` matches one path segment or many — and an
admin can never find out by testing, because a user who already holds a permission reaches the path
without any grant. So every object names each segment it needs, and uses a literal wherever the app
only ever calls one value: the entry is `/m/:gid/system/inputs/in_gigamon_syslog`, so what you
approve is "may delete the input this app made" rather than "may delete any input".

Everything in that file is checked against the code: `src/cribl/policyCoverage.test.ts` fails if the
app calls a path the file does not declare, and equally if the file declares a path the app never
calls — including per *action*, so a declared `DELETE` nothing performs fails the build. It also
fails if the app creates something it cannot remove, and if an app-scoped `/kvstore/…` path is ever
declared here.

## Development

```bash
npm install
npm run dev      # start the Vite dev server (port 5173)
npm run lint     # oxlint
npm run build    # type-check + production build
npm test         # vitest run
npm run package  # test + build + create build/<name>-<version>.tgz
```

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs the lint, the build and the tests on
every push and every pull request, and `npm run package` runs the tests before it writes a version.
Two of those tests are worth knowing about before you send a PR: one fails if any customer-visible
query string, or the ⓘ prose beside a number, or *which* query a panel's ⓘ points at has moved
(regenerate the snapshot deliberately with `npm run queries:extract` and read the diff), and one
fails if `config/policies.yml` and the code disagree in either direction. [`CLAUDE.md`](./CLAUDE.md)
lists them and what each one catches.

`npm run dev` talks to a real Cribl API through the Vite proxy using client credentials in the
gitignored `.dev/cribl.json`; without that file, Search calls are inert. The app-scoped KV store is
inert there too — it needs the platform's own proxy, so anything persistent is only verifiable
installed or in the in-UI Live Preview. See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md)
for the full developer guide (runtime detection, fetch proxy, KV store, `proxies.yml` /
`policies.yml`, and Capra UI rules).

## Releasing

Releases are cut by pushing a `v*` tag. The workflow at
[`.github/workflows/release.yml`](./.github/workflows/release.yml) runs `npm ci`, lints, runs the
tests, packages the app at the tag's version (`v1.0.17` → `1.0.17` via `--version`), publishes a
GitHub Release with the built `cc-gigamon-ami-<version>.tgz` attached, and uploads the pack to the
Cribl Packs Dispensary.

**Test on staging first.** Append `-staging` to the tag to publish to the staging dispensary only;
a clean tag publishes to prod.

```bash
# 1. Bump package.json (+ lockfile) and commit it to main.
npm version 1.0.17 --no-git-tag-version
git commit -am "Release v1.0.17"
git push origin main

# 2. Sanity-check the package build locally.
npm ci && npm run lint && npm run package -- --version 1.0.17
ls build/*.tgz

# 3a. Staging dry run — uploads to the staging dispensary only.
git tag v1.0.17-staging
git push origin v1.0.17-staging

# 3b. Once verified, cut the prod release.
git tag v1.0.17
git push origin v1.0.17
```

`package.json` version and the `v*` tag should agree so the packaged app reports the right version.
To retag, delete the bad tag locally and on the remote first:

```bash
git tag -d v1.0.17
git push origin :refs/tags/v1.0.17
```

### Pack releases (the onboarding pack, not the app)

Guided Setup will install a Cribl Stream pack, `cc-network-gigamon-ami`, whose source is text under
[`packs/cc-network-gigamon-ami/`](./packs/cc-network-gigamon-ami/). Its version is in that
directory's `package.json` and is independent of the app's. No `.crbl` is ever committed.

- A **`gigamon-pack-v<X.Y.Z>`** tag runs
  [`.github/workflows/pack-release.yml`](./.github/workflows/pack-release.yml). It validates and
  builds the `.crbl`, then attaches it to a GitHub release **that is never marked Latest**, so
  `releases/latest` above still means the app.
- A pack release never packages the app, never touches a `v*` tag or `latest`, and never reaches
  the Packs Dispensary.
- **Never start a pack tag with `v`**: `release.yml` would publish it as the app.
- A published pack asset is never replaced. A fix is a new pack version.
- The app installs the version pinned by `PACK_VERSION` in `src/cribl/pack.ts`. Bumping that
  constant, in a normal PR, is how the app ships a pack update.

```bash
npm run pack:samples   # regenerate the synthetic samples and default/samples.yml
npm run pack:check     # the samples reproduce, and the pack validates (CI runs this)
npm run pack:build     # write build/packs/cc-network-gigamon-ami-<version>.crbl
```

## Authors

- **[jpederson@cribl.io](mailto:jpederson@cribl.io)** — original author and creator of the Gigamon AMI
  app: the dashboards, Cribl Search integration, and the Guided Setup provisioning workflow.
- **[bwooden@cribl.io](mailto:bwooden@cribl.io)** — Guided Setup provisioning UX improvements and the
  Cribl Marketplace release/packaging setup.

## License

Licensed under the [Apache License 2.0](./LICENSE).
