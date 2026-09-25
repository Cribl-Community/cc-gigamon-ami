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
| Pipeline | `gigamon_ami_normalize` | Casts numeric fields and derives helper fields. No parse step: the breaker has already extracted the fields. All three routes use it. |
| Route | `gigamon_ami_http_to_json` | HTTP → `gigamon_ami_json_lake`. **Not final**, so each event goes on to the next route too. |
| Route | `gigamon_ami_http_to_parquet` | HTTP → `gigamon_ami_parquet_lake`. |
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

## Not verified yet

These are left for the proof install on a real Leader:

- **Where a pack keeps event breakers.** This pack puts them in `default/breakers.yml`, the global
  file's path without `cribl/`, as for every other pack file. Another Cribl Community pack does the
  same, but no pack breaker has yet been read back from a Leader.
- **Whether the samples replay with `_time` as now.** Every sample in
  `default/samples.yml` has `isTemplate: false`, while every live DataGen sample seen on a Leader has
  `isTemplate: true`. The value stays as it is until the install shows which one is right.
- **What an upgrade from 0.1.0 leaves behind.** 0.1.0 shipped a Syslog source, `in_gno_syslog`. An
  in-place upgrade replaces the pack's `default/` files, but nobody has yet checked what stays in its
  `local/` folder. A port set on that source after install could survive as a listener that no route
  reads. The app keeps the 0.1.0 object ids so the install can find what is left.
- **That the Parquet copy cannot stall the JSON feed.** `gigamon_ami_parquet_lake` drops events
  under backpressure rather than blocking. It shares its source with `gigamon_ami_json_lake`, and a
  blocked Parquet writer would otherwise stop the data every dashboard reads. The install has to show
  `gigamon_ami` still filling while `gigamon_ami_pq` is missing.

## Releases

The pack is released on its own, from a `gigamon-pack-v<version>` tag, as a GitHub release asset
named `cc-network-gigamon-ami-<version>.crbl`. The version is in this directory's `package.json`
and is independent of the app's version. Version 0.1.0 received Syslog. From 0.2.0 on, the pack
receives Raw HTTP only. **Version 0.2.0 delivers nothing**: its route filters used the global form
of `__inputId`, which never matches inside a pack, so it dropped every event from both its sources.
Version 0.2.1 fixes the filters and changes nothing else.
