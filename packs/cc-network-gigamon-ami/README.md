# Gigamon AMI onboarding pack

The Cribl Stream pack that the Gigamon Network Observability app installs from Guided Setup. It
receives Gigamon Application Metadata Intelligence (AMI) records over syslog, parses them and lands
them in the Cribl Lake dataset `gigamon_ami`.

| Object | Id | What it does |
|---|---|---|
| Source | `in_gno_syslog` | Syslog, TCP and UDP. **The port shipped here (20005) is a placeholder** inside 20000–20010, the range a Cribl-managed worker group exposes. Guided Setup sets the real port when it installs the pack. |
| Source | `in_gno_sample` | DataGen of synthetic sample flows. **Ships disabled.** |
| Pipeline | `gno_syslog` | Takes the JSON record out of the syslog message, casts numeric fields, derives helper fields. |
| Pipeline | `gno_sample` | Casts and derives only; sample events arrive as objects. |
| Destination | `out_gno_lake` | Cribl Lake → `gigamon_ami` |
| Destination | `out_gno_sample_lake` | Cribl Lake → `gigamon_ami_sample` |

Neither dataset is part of the pack, because Cribl has no pack-scoped dataset. The app creates them,
and removing the pack deletes neither.

## Sample data

The samples are **synthetic**. `scripts/gen-pack-samples.mjs` in the app's repository generates
them from a fixed seed. Internal hosts are in `10.20.0.0/16` (private address space). External peers
are only in the documentation ranges `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`.
Hostnames are only under `example.com`, `example.net` and `example.org`.

Sample events go to their own dataset, `gigamon_ami_sample`, and never to `gigamon_ami`. Each event
carries `gno_origin=sample`. The DataGen replays five samples at one event per second each.

`data/samples/*.json` and `default/samples.yml` are generated. Do not edit them by hand. Run
`npm run pack:samples` to regenerate them, and `npm run pack:check` to validate the pack.

## Releases

The pack is released on its own, from a `gigamon-pack-v<version>` tag, as a GitHub release asset
named `cc-network-gigamon-ami-<version>.crbl`. The version is in this directory's `package.json`
and is independent of the app's version.
