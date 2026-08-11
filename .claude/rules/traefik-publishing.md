---
paths:
  - "stacks/traefik/**"
  - "stacks/cloudflared/**"
  - "platform/publishing.nix"
---

# Traefik + the publish layer

`stacks/traefik/traefik.nix`. The rule-generator details + ACME config
live in the module's header; `platform/publishing.nix` owns `webApps`
and everything it materializes into.

## Entrypoints

- `web` (:80) — HTTP → redirects to `websecure`.
- `websecure` (:443) — HTTPS with `tls-opts@file` (minVersion TLS12 +
  sniStrict; Go defaults cover the rest, X25519 included) and the
  `sec-headers` middleware as entrypoint default (HSTS 1y incl.
  subdomains, nosniff, strict referrer-policy).
- `cfweb` (:8888, NOT host-published — cloudflared reaches it over
  `traefik-net` only) — plain HTTP for Cloudflare-tunnel routes (CF
  terminates TLS at the edge; double-TLS would 404).
- `traefik` (:8080, bridge-only — NOT host-published) — internal API +
  Prometheus metrics; the dashboard rides it as a `traefikService =
  "api@internal"` webApp at traefik.toscanini.me (Pocket ID gated).

**cfweb + websecure on one router = 404.** Traefik applies `tls:`
per-router, not per-entrypoint; a single router with both entrypoints
forces TLS on cfweb, which CF's plain-HTTP tunnel breaks.
`webApps.exposeRemotely` generates the split pair (websecure router +
`<name>-cf` cfweb router) automatically — don't hand-write one.

## ACME (DNS-01 via Cloudflare)

One entrypoint-level wildcard: `toscanini.me` + `*.toscanini.me`.
Every published hostname is one level under `toscanini.me`, so the
single wildcard covers everything with no per-route ACME work.

Creds: `CF_DNS_API_TOKEN` in `stacks/traefik/env.sops` (the one
variable lego's cloudflare provider reads; the same token value also
lives in cloudflared's env.sops — rotate both together). Cert store at
`/home/santiago/selfhost/traefik/acme.json` (mode 0600, contains
private keys — never read or hand-edit it). Back it up before risky
pool work — Let's Encrypt rate-limits new issuances (5 duplicates /
50 new per week per registered domain).

**Traefik 3.x quirk**: adding new wildcards to
`entrypoint.tls.domains` after the first run does NOT auto-trigger
ACME issuance — Traefik only renews existing certs.

## Reaching upstreams

Every route declares its upstream **explicitly** — no implicit
fallback. Three shapes on `webApps` (exactly one required, asserted):

**Preferred — bridge-routed (`serviceName` + `port`, no host port):**
the stack joins `traefik-net` and traefik dials container DNS:

```nix
fleet.bridgeMemberships.metube = [ "traefik" ];
fleet.webApps.metube = {
  hostname    = "metube.toscanini.me";
  serviceName = "metube";  # container name on traefik-net
  port        = 8081;      # in-container port
};
```

Stacks that already live on a private bridge (litellm, n8n, nextcloud,
immich, monitoring) list `"traefik"` as a **secondary** element in
`bridgeMemberships`. Container names on `traefik-net` must be globally
unique — avoid generic names like `web`, `app`, `api`.

**Isolated variant (`isolated = true`)** — header-trusting apps
(grocy, calibre-web, healthchecks, daedalus) get a private
`iso-<name>-net` bridge whose only other member is traefik. Requires
`serviceName`; the stack must NOT also list `"traefik"` in
`bridgeMemberships` (asserted).

**Escape hatch — `serviceUrl`** for upstreams that can't join
`traefik-net`: the gluetun-netns stacks
(`http://host.containers.internal:<hostport>`), pi-hole (native
service), and rare TLS-internal images.

## Must-keep host ports

These stay host-published for structural reasons — not leftovers:

| Reason | Ports / services |
|---|---|
| **Wrong protocol** (not HTTP) | sshd 22 TCP; pi-hole 53 TCP+UDP + DHCP 67 UDP; wg-easy 51820 UDP; factorio 34197 UDP; app-db postgres 5432 TCP (traefik TCP/SNI TLS, LAN-only) + 5433 TCP (plain-TCP host port on pg — for gluetun-netns tenants whose clients can't do direct-TLS) |
| **Host network stats** | node-exporter 9100 — reads host `/proc`, `/sys`, real NICs; lives on `--network=host` |
| **Multicast / discovery** | home-assistant — whole container on `--network=host` (mDNS 5353 + SSDP 1900 UDP on enp3s0 only); its :8123 stays firewall-closed — traefik dials `host.containers.internal:8123` |
| **Shared netns (gluetun trap)** | the entire TV stack — see `.claude/rules/vpn-netns.md`. Do NOT migrate |
| **Traefik ingress** | 80, 443 TCP — traefik IS the proxy. cfweb :8888 is bridge-only |

Every host-bound port is opened by its **owning stack module** (grep
`networking.firewall.allowed*Ports` in `stacks/*/`); there is no
centralized list.

## Client IPs are rewritten — and the publishing is load-bearing

Rootless `-p host:container` goes through **rootlessport**, which
replaces the client address with a podman bridge address: traefik's
access log shows every LAN/WireGuard client as `10.89.x.x`; only cfweb
requests carry real IPs (cloudflared forwards `X-Forwarded-For`).

**Do not "fix" this with systemd socket activation.** Dropping
`-p 80:80 -p 443:443` also drops the DNAT rule publishing installs
inside the rootless netns — container→traefik loopback (gatus probes,
traefik's own OIDC discovery) depends on it. Tried and reverted
2026-07-30.

## A gated app's icons need an auth bypass

A forward-auth'd app serves favicon/apple-touch-icon **through the
gate**; iOS add-to-home-screen fetches them without the session cookie,
reads IdP HTML where it expected a PNG, and renders a letter tile. Add
the icon paths to `authBypassRule` (same class as gatus needing
`healthPath` bypassed); iOS caches per site — remove and re-add the
bookmark after fixing.
