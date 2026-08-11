---
paths:
  - "stacks/pihole/**"
---

# Pi-hole — config vs state

Native NixOS service (NOT a container). Module: `stacks/pihole/pihole.nix`.
It is LAN DNS + DHCP for the whole house — treat every restart as a
brief house-wide DNS outage (see CLAUDE.md hard rule 3).

## Config vs state

| | Config (declarative) | State (mutable) |
|---|---|---|
| Where | `pihole.toml` (forced to be a `/nix/store` symlink) | `/var/lib/pihole/{gravity,pihole-FTL,macvendor}.db` |
| Contains | Upstream resolvers, DHCP scope + static reservations, `dns.hosts`, CSP, `misc.readOnly=true` | Blocklists, allow/deny domains added via UI, query log |
| Survives reinstall | Yes (in nix) | No (not in rebuild trail) |
| Survives reboot | Yes | Yes |

UI-added DNS entries land in `gravity.db` — they survive restarts
but die on a fresh install. Anything you want persisted goes in
`fleet.dnsHosts` (any stack's nix module) or — for non-stack hosts
like `gaming-pc.local.toscanini.me` — in the literal list inside
`stacks/pihole/pihole.nix`.

## Web UI

The embedded web server listens on `:8080` plain HTTP; Traefik fronts
it. The admin password is blanked (`api.pwhash = ""`) — browser access
rides the Pocket ID forward-auth gate instead.

## Operator decisions that touch this stack

- Google stays the DNS upstream (don't propose unbound/DoT).
- `fleet.wanHost` split-horizon: pi-hole answers `s2.toscanini.me`
  with the LAN IP; the Cloudflare A record carries the WAN address.
  Declared from one binding in `platform/ddclient` so they can't drift.

The runtime failure modes (pi-hole down → box has no DNS; the shared
FTL rate limit whose symptom looks like broken SSO) live in CLAUDE.md's
Pi-hole section — they matter when debugging, not only when editing
this stack.
