# FUTURE.md — deferred improvements

Items consciously deferred from the 2026-07-15 gap-to-SOTA audit.

## 1. Forward-auth SSO for admin UIs (Pocket-ID + traefik-forward-auth)

Admin surfaces (traefik dashboard, prometheus, *arrs, qbittorrent,
myspeed, stirling-pdf) are reachable by anything on the LAN, including
IoT devices — they're LAN-only, so the risk is accepted for now.

Plan when picked up: Pocket-ID (OIDC + passkeys, single container) as
a new stack + an opt-in `protect = true` flag on `myStack.webApps`
that attaches a forward-auth middleware. Admin UIs only — family apps
with their own auth (Jellyfin, Immich, Nextcloud) and public apps stay
untouched.

Trigger to revisit: any admin UI gets exposed off-LAN, or untrusted
devices join the network.

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

The shared cluster, litellm-db, and n8n-postgres are protected only by
crash-consistent ZFS snapshots + syncoid (immich runs its own built-in
dumps). Snapshots faithfully preserve logical corruption — a bad app
migration survives restore, and the daily ring buffer recycles past
the last good state in 7 days.

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
