# FUTURE.md — deferred improvements

Items consciously deferred from the 2026-07-15 gap-to-SOTA audit.

## 1. Adopt native OIDC for wg-easy + seerr when upstream ships it

The box-wide Pocket ID SSO migration (2026-07) is done — every web UI
authenticates through Pocket ID (passkeys) except two, which keep their
current local login to avoid a second login prompt until each ships
native OIDC. Full per-service auth map, group access model, and the
recipe to onboard a service/user live in `/etc/nixos/AUTH.md`.

- **seerr** — Jellyfin-credential login today. Native OIDC merged in
  [PR #2715](https://github.com/seerr-team/seerr/pull/2715), milestoned
  v3.5.0 (testing: [discussion #2721](https://github.com/seerr-team/seerr/discussions/2721)).
  When released: create a Pocket ID client, enable OIDC in Seerr, add it
  to the `family` group.
- **wg-easy** — v15 local account (+TOTP). Native OIDC requested in
  [issue #1923](https://github.com/wg-easy/wg-easy/issues/1923) (also
  #2374), unshipped. When it lands: Pocket ID client, keep in `admins`.

Not candidates (no viable OIDC path — stay on their own auth, documented
in AUTH.md "Out of scope"): **jellyfin** (native TV/mobile clients can't
do OIDC) and **factorio-admin** (OFSM unmaintained, login can't be
disabled → would force a double login, explicitly not wanted).

Trigger to revisit: either seerr or wg-easy cuts a release with OIDC.

## 2. Off-site ZFS sync to an external service

Local replication (rpool → s2-pool mirror, see platform/backup.nix) covers
disk failure but NOT fire, theft, or ransomware — all copies live in
one house. Deferred for cost reasons (2026-07-15).

Plan when picked up, either of:
- `zfs send` / syncoid to a ZFS-capable target (rsync.net, or a
  relative's box with a mirror pair), or
- declarative `services.restic.backups` → Backblaze B2 for the
  irreplaceable set (~700 GB: /s2/immich, /s2/santi, /s2/sofi,
  /s2/shared, replicated selfhost) — ~USD 4–5/month.

Trigger to revisit: budget available, or any close call with the data.

## 3. PgBouncer in front of the shared app-db cluster

`max_connections = 200` is shared by every ORM-pooled app on the
cluster (see the TODO in `stacks/app-db/app-db.nix`). Fine at the
current app count; a transaction-mode PgBouncer between `pg` and the
apps would lift the ceiling without per-app pool tuning.

Trigger to revisit: connection-refused errors in app logs, or the
cluster approaching ~150 concurrent connections
(`pg_stat_activity` count in grafana).

## 4. Logical Postgres backups (pg_dump timers)

The shared app-db cluster is protected only by crash-consistent ZFS
snapshots + syncoid (immich runs its own built-in dumps). Snapshots
faithfully preserve logical corruption — a bad app migration survives
restore, and the daily ring buffer recycles past the last good state
in 7 days.

Plan when picked up: a weekly `pg_dump -Fc` per database (systemd
timer, output under `/home/santiago/selfhost/<stack>/dumps/` so dumps
ride the existing snapshot + syncoid machinery), pruned to N copies,
with an hc-ping.

## 5. Memory caps on heavy containers

Only janitorr and app-db's pg set `--memory`. Uncapped heavy hitters:
immich-machine-learning (multi-GB OpenVINO), jellyfin (transcode),
subgen (~1 GB resident whisper model × 2 concurrent jobs),
nextcloud-app (PHP_MEMORY_LIMIT=2G but no container cap), and the
redis/postgres sidecars. A runaway can OOM the box that runs LAN DNS.

Plan when picked up: `--memory` (and maybe `--memory-swap`) per heavy
container, sized from grafana's per-service RSS history; consider a
`memoryLimit` passthrough arg on `mkRootlessContainer`.
