---
paths:
  - "platform/zfs.nix"
  - "platform/backup.nix"
  - "hardware-configuration.nix"
---

# ZFS — pools, snapshots, replication

Everything ZFS-related (boot config, mounts, snapshot timers, per-dataset
properties) lives in `platform/zfs.nix`. The `datasets` attrset there is
the single source of truth — adding a property or enrolling a dataset in
snapshots is a one-line change. `zfs-converge.service` diffs current
state against the declaration on every rebuild and `zfs set`s only when
something differs.

## `rpool` — OS pool (NVMe, 4 TB)

| Dataset           | Mount                          | Recordsize | Snapshot tiers |
|---|---|---|---|
| `rpool/root`      | `/`                            | 128K       | none (opted out) |
| `rpool/nix`       | `/nix`                         | 128K       | none (opted out) |
| `rpool/home`      | `/home`                        | 128K       | frequent + hourly + daily |
| `rpool/selfhost`  | `/home/santiago/selfhost`      | **16K**    | frequent + hourly + daily |
| `rpool/minecraft` | `/home/santiago/selfhost/minecraft` | 16K   | frequent + hourly + daily (own dataset so a griefing rollback can't roll back every other stack's DB) |

`rpool/selfhost` is the one to watch for snapshot growth. 16K
recordsize + high DB churn (every container's postgres / redis cluster
lives here) can produce bigger-than-intuition deltas. Check
`zfs list -t snapshot -o name,used rpool/selfhost`; if total snapshot
usage balloons, drop the daily tier in `platform/zfs.nix` and keep only
frequent + hourly.

## `s2-pool` — data pool (2× 16 TB HDD mirror)

Children declared in `platform/zfs.nix` (`datasets` attrset). Adding a
child is a one-line edit there — `fileSystems."/s2/<name>"` is emitted
automatically. Dataset CREATION is not automated; if the pool is fresh
after a rebuild, run `zfs create -o mountpoint=legacy s2-pool/<name>`
once per missing child (the list in `datasets` documents which).

| Path | Use | Snapshot tiers |
|---|---|---|
| `/s2/santi`, `/s2/sofi`, `/s2/shared` | Personal files | hourly + daily + weekly |
| `/s2/tv`               | Media library (Jellyfin source + *arrs)   | none (re-downloadable) |
| `/s2/books`            | Ebook library + ingest + torrents          | hourly + daily + weekly |
| `/s2/immich`           | Immich photo/video                        | hourly + daily + weekly |
| `/s2/minecraft`        | Nightly Minecraft archives                | none (files are already point-in-time copies) |

`s2-pool` reports "Some features not enabled" — the pool was created
on an older ZFS. `zpool upgrade s2-pool` would enable them but locks
out older ZFS versions; don't do it without a rollback plan.

## Snapshot policy

Per-dataset enrollment via `com.sun:auto-snapshot=true` (set in
`datasets`). Per-tier opt-out via `com.sun:auto-snapshot:<tier>=false`.
Tier counts are global on
`services.zfs.autoSnapshot.{frequent,hourly,daily,weekly}`:

| Tier     | Count | Cadence       | Window  |
|---|---|---|---|
| frequent | 4     | every 15 min  | 1 hour  |
| hourly   | 24    | every hour    | 24 hrs  |
| daily    | 7     | once per day  | 1 week  |
| weekly   | 4     | once per week | 1 month |

Each tier is a ring buffer — count × cadence IS the retention window.
Steady state per fully-enrolled dataset: 39 snapshots max. Browse
inside any snapshot via `<mount>/.zfs/snapshot/<snap>/` (hidden but
traversable). Prefer `cp` from there over `zfs rollback` for everyday
fat-finger recovery — rollback discards everything newer than the
target snapshot.

## Maintenance

- Monthly scrub (`services.zfs.autoScrub.enable`).
- Weekly TRIM (`services.zfs.trim.enable`).
- Snapshot timers (`zfs-snapshot-{frequent,hourly,daily,weekly}.timer`)
  fire on schedule; `zfs-converge.service` re-applies declared
  properties on every nixos-rebuild.
- syncoid (`platform/backup.nix`): `rpool/selfhost` + `rpool/home` →
  `s2-pool/backup/*` with `--no-sync-snap` +
  `--delete-target-snapshots` (plus the `localTargetAllow` destroy
  grant that makes the flag effective). The replica strictly
  **mirrors** the source snapshot set — a manual `pre-*` snapshot
  dies on the replica when its source copy is destroyed. It is a
  mirror, not an archive.
- smartd: short test Sat 02:00, long test 1st-of-month 03:00. Failure
  mail is wired in `platform/mail` — the only place smartd's mail
  block lives.
