---
paths:
  - "stacks/downloads/**"
  - "stacks/tv/**"
  - "stacks/argus-vpn/**"
  - "stacks/shelfmark/**"
  - "platform/gluetun-lib.nix"
---

# VPN / shared-netns stacks — the gluetun trap

## Who owns what

- `stacks/downloads` **owns the shared netns**: ten containers ride
  `--network=container:gluetun` (the tv stack's downloaders + *arrs +
  subgen, shelfmark, flaresolverr, the exporter). Only the netns owner
  can publish ports, so every tenant's host port is declared on
  gluetun via `fleet.gluetunTenants` (merged across stacks — tv and
  shelfmark both contribute; downloads publishes the sorted union).
  **Any change that recreates gluetun bounces all ten tenants.**
- `stacks/tv` is content only — the *arrs, downloaders and Jellyfin.
  Jellyfin is deliberately **outside** the VPN (LAN streaming
  shouldn't burn paid bandwidth) and is the only one on `traefik-net`.
- `stacks/argus-vpn` is a second `mkGluetunInstance` (dedicated tunnel
  for app-argus). Each further instance takes the same in-netns ports
  **+2** (`8000/8001` → `8002/8003`; a third would take `8004/8005`).
  Deliberately NOT reusing the TV tunnel: same WireGuard key on two
  live tunnels conflicts, and it would mix argus traffic with the
  torrent exit.
- `mkGluetunInstance` lives in `platform/gluetun-lib.nix` — a BY-PATH
  library, not a module arg (its consumers force it inside a top-level
  `config = lib.mkMerge`, where a module arg would recurse). It
  declares the statePaths (`<stateRoot>/gluetun`), kernel modules,
  scrape target, key-expiry reminder mails, and writes
  `fleet.vpnEgress` itself.

## Facts that bite outside these modules

- **Reaching the host from a netns tenant is
  `host.containers.internal`, never the LAN IP.** Under pasta the host
  is `169.254.1.2`; `192.168.0.2` refers back to the container itself.
  Gluetun's `FIREWALL_OUTBOUND_SUBNETS = 169.254.1.2/32` opens the
  kill switch for exactly that and nothing else, which is how the
  *arrs reach pg on :5433 without leaving the tunnel.
- **Traefik reaches every netns tenant via
  `serviceUrl = "http://host.containers.internal:<hostport>"`** — they
  cannot join `traefik-net`, and putting gluetun there would mix
  VPN-exit traffic with non-VPN. Do NOT migrate.
- **iGPU transcoding** is `--device=/dev/dri/renderD128` (mode 0666 on
  the host so rootless needs no `--group-add=render`); the i915 driver
  is force-probed in `platform/gpu.nix`.
- **A wedged gluetun reads as healthy**: `podman ps` says `Up 4 days`
  with port mappings while the tunnel restart-loops internally and the
  whole netns 502s. The tell is `restarting VPN because it failed to
  pass the healthcheck` in gluetun's OWN logs. Fix:
  `systemctl restart podman-gluetun-<name>` — and remember that
  bounces every tenant.
- **Books stay out of /s2/tv**: shelfmark's torrents land in
  `/s2/books/torrents`, keeping janitorr's world exactly `/s2/tv`.
  The shelfmark↔calibre-web handoff is the shared `/s2/books/ingest`
  folder on disk — they never talk over the network.
