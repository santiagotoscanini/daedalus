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
