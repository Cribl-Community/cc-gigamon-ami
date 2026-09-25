# Gigamon AMI onboarding pack

The Cribl Stream pack that the Gigamon Network Observability app installs from Guided Setup. It
receives Gigamon Application Metadata Intelligence (AMI) records from Gigamon AMX over Raw HTTP and
lands them in Cribl Lake twice: as JSON in `gigamon_ami`, which every dashboard reads, and as a
Parquet copy in `gigamon_ami_pq`.

| Object | Id | What it does |
|---|---|---|
| Source | `in_gigamon_ami_http` | Raw HTTP (`http_raw`). Gigamon AMX POSTs a JSON array of records. **Ships disabled, with no auth token.** |
| Source | `in_gigamon_ami_sample` | DataGen of synthetic sample flows. **Ships disabled.** |
| Event breaker | `gigamon_ami_http_json_array` | One event per record of the POSTed array, every field extracted. |
| Pipeline | `gigamon_ami_normalize` | Casts numeric fields and derives helper fields. No parse step: the breaker has already extracted the fields. The JSON and sample routes use it, and keep `_raw`. |
| Pipeline | `gigamon_ami_normalize_parquet` | The same casts and derived fields, then removes `_raw`. Only the Parquet route uses it. |
| Route | `gigamon_ami_http_to_json` | HTTP → `gigamon_ami_normalize` → `gigamon_ami_json_lake`. **Not final**, so each event goes on to the next route too. |
| Route | `gigamon_ami_http_to_parquet` | HTTP → `gigamon_ami_normalize_parquet` → `gigamon_ami_parquet_lake`. |
| Route | `gigamon_ami_sample` | Sample DataGen → `gigamon_ami_sample_lake`. |
| Destination | `gigamon_ami_json_lake` | Cribl Lake → `gigamon_ami` (JSON) |
| Destination | `gigamon_ami_parquet_lake` | Cribl Lake → `gigamon_ami_pq` (Parquet). Drops events rather than blocking under backpressure, so it can never stop the JSON copy. |
| Destination | `gigamon_ami_sample_lake` | Cribl Lake → `gigamon_ami_sample` (JSON) |

No dataset is part of the pack, because Cribl has no pack-scoped dataset, and removing the pack
deletes none of them. The app's onboarding run creates `gigamon_ami`, `gigamon_ami_pq` and, only
when sample data is ticked, `gigamon_ami_sample`, each only if it is missing, and never edits or
deletes any of them.

**If `gigamon_ami_pq` is missing anyway**, because it could not be created or was deleted later, the
Parquet route still runs once the HTTP source is started, and its destination drops every event
it cannot write, with no error shown: `gigamon_ami` keeps flowing, and `gigamon_ami_pq` stays
empty. Guided Setup refuses to start the sample source until `gigamon_ami_sample` exists.

**Each route names its source as `<type>:cc-network-gigamon-ami.<id>`**, for example
`__inputId=='http_raw:cc-network-gigamon-ami.in_gigamon_ami_http'`. Inside a pack an event's
`__inputId` carries the pack id before the source id; this was measured on a Cribl.Cloud Leader on
2026-09-25. A filter in the global form, `http_raw:in_gigamon_ami_http`, never matches inside a
pack, and `npm run pack:check` refuses one.

**`_raw` is kept in the JSON copy and dropped from the Parquet copy.** After the breaker, every
field of a record is already its own field, and `_raw` holds the record's whole JSON text again. A
0.2.1 Parquet row carried that full `_raw` beside its 48 columns (measured on 2026-09-25). So the
Parquet route runs `gigamon_ami_normalize_parquet`, which removes `_raw` with an Eval after the same
cast and derive steps. The JSON route and the sample route keep `_raw`, because the app's evidence
drill-downs, its field presence view and its Copilot briefs read `_raw`, and they always read
`gigamon_ami`. What this saves is storage: the Parquet copy no longer holds a second copy of each
record. It is not a claim that Parquet queries run faster. A columnar read skips a column it does
not read, so `_raw` never cost a query that did not ask for it. `npm run pack:check` refuses a route
into a Parquet destination whose pipeline keeps `_raw`, and a route into a JSON destination whose
pipeline removes it.

Object names say what each object does. The `gno_` prefix is reserved for the app's acceleration
schedules, and `npm run pack:check` refuses a pack object that carries it.

## Security of the HTTP source

The source ships **disabled**, and with **no auth token**. A port in 20000–20010 on a Cribl-managed
worker group can be reached from the internet. A token written into the pack would be one secret
shared by every tenant that installed it. So Guided Setup does three things in one write when you
confirm the source:

1. It picks a free port.
2. It generates a random token, which is written only into this source and shown to you once.
3. It enables the source.

Gigamon AMX sends that token in the `Authorization` header.

**The port shipped here (20005) is a placeholder** inside 20000–20010, the range a Cribl-managed
worker group exposes. TLS ships in the form a Cribl-managed group needs: Cribl's own certificate
(`$CRIBL_CLOUD_CRT` / `$CRIBL_CLOUD_KEY`). A hybrid group has no such certificate, so on a hybrid
group Guided Setup turns TLS off. It then tells you the traffic is unencrypted until you add a
certificate.

## Decided on 2026-09-24

Both settings below were placeholders until owner-approved measurements settled them.

- **The Parquet schema mode is automatic.** `gigamon_ami_parquet_lake` ships
  `automaticSchema: true`. An explicit schema had no effect that could be observed: absent fields
  got the same `""` fill, a field the schema did not list was still kept, and strings were stored in
  a column the schema declared `INT64`.
- **`gigamon_ami_pq` is created with no partition fields.** A Lake dataset's layout is fixed
  when it is created, and the app's onboarding run creates this one that way (see above). A partition on `protocol` pruned nothing on Search v2: a
  `protocol=6` search read the same 63,249 events and 2.69 MB from the partitioned copy as from the
  flat one. It also cost 172% of the flat copy with no filter, and 197% with other filters.

## Sample data

The samples are **synthetic**. `scripts/gen-pack-samples.mjs` in the app's repository generates
them from a fixed seed. Internal hosts are in `10.20.0.0/16` (private address space). External peers
are only in the documentation ranges `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`.
Hostnames are only under `example.com`, `example.net` and `example.org`.

Sample events go to their own dataset, `gigamon_ami_sample`, and never to `gigamon_ami` or
`gigamon_ami_pq`. Each event carries `gigamon_origin=sample`. The DataGen replays five samples at
one event per second each.

`data/samples/*.json` and `default/samples.yml` are generated. Do not edit them by hand. Run
`npm run pack:samples` to regenerate them, and `npm run pack:check` to validate the pack.

## Measured on a Leader

- **Inside a pack, `__inputId` is `<type>:<packId>.<inputId>`**, for example
  `datagen:cc-network-gigamon-ami.in_gigamon_ami_sample`. The routes here filter on that form.
- **The samples replay with `_time` as now**, with `isTemplate: false`, whatever time a sample
  record carries.
- **An in-place upgrade keeps the pack's `local/` settings.** That includes a setting made on a
  source the new version no longer ships. Upgrading from 0.1.0 after changing `in_gno_syslog` leaves
  that source behind in `local/`, disabled and read by no route. Delete it in Cribl if you changed it.

## Not verified yet

These are left for a later install on a real Leader:

- **Where a pack keeps event breakers.** This pack puts them in `default/breakers.yml`, the global
  file's path without `cribl/`, as for every other pack file. Another Cribl Community pack does the
  same, but no pack breaker has yet been read back from a Leader.
- **That the Parquet copy cannot stall the JSON feed.** `gigamon_ami_parquet_lake` drops events
  under backpressure rather than blocking. It shares its source with `gigamon_ami_json_lake`, and a
  blocked Parquet writer would otherwise stop the data every dashboard reads. The install has to show
  `gigamon_ami` still filling while `gigamon_ami_pq` is missing.
- **That removing `_raw` on the Parquet route leaves the JSON copy whole.** Cribl documents that a
  route that is not final hands its pipeline a copy of the event, so the Parquet pipeline cannot
  change what the JSON route already wrote. This pack relies on that, and it has not been measured
  here. The 0.2.2 install has to show `gigamon_ami` rows that still carry `_raw` and `gigamon_ami_pq`
  rows that carry none.

## Releases

The pack is released on its own, from a `gigamon-pack-v<version>` tag, as a GitHub release asset
named `cc-network-gigamon-ami-<version>.crbl`. The version is in this directory's `package.json`
and is independent of the app's version. Version 0.1.0 received Syslog. From 0.2.0 on, the pack
receives Raw HTTP only. **Versions 0.1.0 and 0.2.0 deliver nothing**: their route filters used the
global form of `__inputId`, which never matches inside a pack, so each dropped every event from both
its sources. Version 0.2.1 fixes the filters and changes nothing else; upgrade from either.

- **0.2.2** adds the pipeline `gigamon_ami_normalize_parquet`, and the Parquet route
  `gigamon_ami_http_to_parquet` now uses it, so rows written to `gigamon_ami_pq` no longer carry
  `_raw`. Nothing else changed: the JSON and sample routes, the sources, the breaker and the
  destinations are as they were in 0.2.1. Rows already in `gigamon_ami_pq` keep their `_raw`, since
  Lake rewrites nothing. An in-place upgrade from 0.2.1 adds the new pipeline; it keeps the pack's
  `local/` settings, as measured above for an upgrade from 0.1.0.
