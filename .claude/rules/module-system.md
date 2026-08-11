---
paths:
  - "platform/*.nix"
  - "stacks/**/*.nix"
  - "configuration.nix"
  - "flake.nix"
---

# The module system — full reference for stack authors

CLAUDE.md carries the one-line summary of each option; this is the
working detail. `grep -rhoE 'fleet\.[a-zA-Z0-9_.]+' platform/ stacks/
--include=*.nix` is the authoritative list if this drifts.

## `fleet.*` options a stack contributes to

Runtime options (`bridgeMemberships`, `bridgeSubnets`, `statePaths`,
`stateRoot`) live in `platform/podman.nix`; the publish layer
(`webApps` + what it materializes into) in `platform/publishing.nix`;
`appDatabases`, `logStacks`, `monitoredJobs`, `mail`, `sso.issuerUrl`
and `sso.discoveryConsumers` in their owning modules (`stacks/app-db`,
`stacks/logging`, `platform/mail`, `stacks/pocket-id`).

| Option | Type | What it does |
|---|---|---|
| `bridgeMemberships` | `attrsOf (listOf str)` | **The single source of bridge membership.** Container → list of bridge short names (`"traefik"` → `traefik-net`), each optionally carrying a podman network suffix (`"nextcloud:alias=redis"`). podman.nix injects the `--network=` flags itself (stacks must NOT write them in `extraOptions`), orders the unit after every listed bridge, and creates each bridge. `[ ]` = pasta. Non-bridge networking (`--network=host`, `--network=container:X`) stays in `extraOptions`, paired with a `[ ]` entry here. Lists merge across modules (e.g. app-db appends `"pg-wire"` to traefik's list). A stale key with no matching container fails eval (missing image). |
| `bridgeSubnets` | `attrsOf str` | Bridge short name → CIDR pin, passed as `--subnet` at bridge creation. `traefik-net` is pinned to `10.89.7.0/24` in `stacks/traefik`; consumed by nextcloud/immich `TRUSTED_PROXIES`. |
| `stateRoot` | `str` (read-only) | `/home/santiago/selfhost` — interpolate it, never restate the literal. The grouping taxonomy (ai/apps/books/tv/root) is documented on the option. |
| `statePaths` | `attrsOf submodule` | Path → `{ uid, gid, mode, type }` (`uid`/`gid` are CONTAINER ids — 0 = santiago; `type` is `"d"` or `"f"`). Applied by the root `state-paths.service` oneshot with the subuid mapping (NOT tmpfiles — systemd-tmpfiles skips rules under the santiago-owned /home prefix as "unsafe path transition"; every podman unit orders after the oneshot) — the fleet convention for pre-creating bind-mount sources (fresh-restore safety; guards the 70-vs-105 postgres ownership trap). `acme.json` is pre-created as an `f` 0600 entry. |
| `appDatabases` | `attrsOf submodule` | Per-app database + login role on the shared pg cluster (`stacks/app-db`). A bootstrap oneshot materializes role/db and writes an env file with `DATABASE_URL` + `POSTGRES_*` (password also emitted as `DB_POSTGRESDB_PASSWORD` so n8n-style images work unmodified). Tenants join `app-db-net`. `consumers` (container names, default `[ "app-<name>" ]`) are auto-ordered after the bootstrap AND directly after `podman-pg.service` (transaction-proof: a mass restart re-queues consumers without the already-active bootstrap), whose unit gates on `pg_isready`. Read-only `envFile` exposes the bootstrap env file's path — reference it, never hardcode. |
| `webApps` | `attrsOf submodule` | **Primary publishing interface.** Fields: `hostname` (default `<name>.<baseDomain>`), `port` (only with `serviceName`), `serviceName?`, `serviceUrl?`, `traefikService?`, `exposeRemotely?` (default false), `auth?` (`"none"`/`"oidc"`), `authBypassRule?`, `authHeaders?`, `healthPath?`, `healthHeaders?`, `authGroups?`, `extraMiddlewares?`, `isolated?`, `metrics?`. **Exactly one of `serviceName` / `serviceUrl` / `traefikService` is required** (assertion). `auth = "oidc"` gates the router(s) behind the generated Pocket ID forward-auth middleware; `healthPath` makes gatus probe the real upstream and is appended to the oidc bypass rule — **mandatory for `auth = "oidc"` apps** (assertion). `isolated = true` puts the app on a private `iso-<name>-net` bridge with traefik as the only other member (header-trusting apps); requires `serviceName`, and an assertion rejects a stray `"traefik"` membership. `metrics.enable` emits the prometheus scrape. Materializes into `traefikRoutes` (+ a `<name>-cf` cfweb router when `exposeRemotely`), `dnsHosts` (pi-hole short-circuit to 192.168.0.2), and `cloudflareRoutes` (when `exposeRemotely`). Always exposes on the LAN; off-LAN is opt-in. Upstream-shape details: `.claude/rules/traefik-publishing.md`. |
| `traefikRoutes` | `attrsOf submodule` | Lower-level `Host(...)` routes. Fields: `host`, `serviceUrl` XOR `service` (no implicit fallback), `middlewares?`, `entrypoint?` (`websecure` default, `cfweb` for CF-tunnel). Asserts no two routers share an entrypoint+host. Use directly only when `webApps` doesn't fit. |
| `traefikRawRules` | `attrsOf str` | Raw YAML for routes that don't fit the simple shape. |
| `dnsHosts` | `listOf str` | Lines appended to pi-hole's `dns.hosts`, format `"<IP> <fqdn>"`. Most stacks contribute via `webApps` indirectly. |
| `cloudflareRoutes` | `attrsOf submodule` | Ingress rules for the local-managed CF tunnel (consumed by stacks/cloudflared and the `cloudflared-route-sync` oneshot that upserts CNAMEs). Mostly via `webApps`. |
| `prometheusScrapes` | `listOf attrs` | Merged into the generated prometheus.yml. |
| `grafanaDashboardsByFolder` | `attrsOf (attrsOf lines)` | `<folder>` → `<name>` → JSON, rendered as Grafana sidebar folders. |
| `logStacks` | `attrsOf (listOf str)` | Stack → container names — alloy's Loki `stack` label map. Unregistered containers fall back to `stack=<container-name>`. Declared in `stacks/logging`. |
| `monitoredJobs` | `attrsOf submodule` | Scheduled-job monitoring registry: `<unit> = { email ? true; slug ? null }`. `email` adds `OnFailure` mail, `slug` adds healthchecks dead-man pings (platform/hc-ping). An assertion rejects names with no real unit. |
| `litellmKeys` | `attrsOf submodule` | Per-consumer **virtual keys** on the LLM gateway (`stacks/litellm/keys.nix`). Attr name = the ledger/dashboard alias. Key value generated on the box, stored in `stacks/litellm/secrets/virtual-keys.env` (gitignored, rotate by deleting the line), converged by `litellm-keys-sync.service` via `podman exec`. Fields: `models` (empty = unrestricted), `mcpServers`, `searchTools`, `consumers`, `consumerEnv`. **`mcpServers` is not optional**: a virtual key reaches no MCP server by default and `tools/list` answers with an empty array, silently removing a caller's tools. No `passthroughRoutes` option exists — `allowed_passthrough_routes` is LiteLLM Enterprise-only, so `/reranking` is unauthenticated instead (argued in `stacks/litellm/assets/config.yaml`). |
| `sso.discoveryConsumers` | `listOf str` | Containers that fetch the OIDC discovery document **while starting** and can't recover if it isn't served yet — they panic (gatus, zot) or come up silently broken (verdaccio, wealthfolio); under `--rm` the crash leaves a green oneshot with no container. Each listed container is ordered behind traefik + pocket-id AND gated by a bounded `ExecStartPre` probe of the real discovery URL. **If a new stack panics on OIDC discovery at boot, add one line here — do not hand-roll an ExecStartPre.** |

## Constants and self-registering registries

| Option | Owner | What it is |
|---|---|---|
| `lanIp` | `platform/publishing.nix` | `192.168.0.2`. Read it, never restate. |
| `baseDomain` | `platform/publishing.nix` | `toscanini.me`. Every published host is **exactly one label** under it (wildcard-cert constraint, asserted). |
| `wanHost` | `platform/publishing.nix` | `s2.toscanini.me`, split-horizon; `platform/ddclient` declares the CF record and pi-hole override from this one binding. |
| `mail` | `platform/mail` | `{ sender, alertTo, smtpHost, smtpPort }` — the one mail identity. |
| `apps` | `stacks/apps/declarations.nix` | The apps platform registry — see `.claude/rules/apps-platform.md`. |
| `ssoClients` | `stacks/pocket-id/clients.nix` | Declarative Pocket ID OIDC clients. Forward-auth clients are **auto-derived** from `webApps.<n>.auth = "oidc"` — never write those out. The sync converges but **never prunes**: a deleted stack's client stays live at the IdP until deleted by hand. |
| `gluetunTenants` | `stacks/downloads` | Container → ports/UIs, merged across stacks; the downloads stack publishes the sorted union on gluetun. |
| `vpnEgress` | `platform/publishing.nix` | Written by `mkGluetunInstance` itself; tenants computed from `--network=container:<owner>` flags. |
| `directIngress` | `platform/publishing.nix` | Services reachable at the WAN address (WireGuard, Factorio, Minecraft), each with a `note` on why it can't ride the tunnel. |
| `cloudflare` | `stacks/cloudflared` | `{ accountId, tunnelId, zoneId }`. |
| `factorio` / `minecraft` | their stacks | Game-server version + roster options. |
| `rebuildLock` | `platform/autoupgrade` | Lockfile shared by the weekly autoupgrade and daedalus's Apply, so two rebuilds can't race. |

## Helpers on `_module.args`

`mkRootlessContainer` — decorator every container declaration uses;
injects `autoStart = true`, `podman.user = "santiago"`, `TZ`, and
`--security-opt=no-new-privileges` (opt out per-container with
`noNewPrivileges = false`).

Siblings: `hostUid` (container uid → host uid, N ≥ 1 only),
`mkDotenvSecret` (sops boilerplate), `mkSecretRender` (boot-render
oneshots for derived secrets — see `.claude/rules/secrets-sops.md`),
`mkLocalImage { name, tagPrefix, contextDir, gates }` → `{ image,
service }` — locally-built images get tags embedding the build-context
store hash, so a context change produces a new tag and restarts the
consumer.

ALL `_module.args` live in podman.nix — a module that defines
`_module.args` cannot itself consume a custom arg (the args option
evaluation recurses through the module call). For the same reason the
gluetun family is a BY-PATH library (`platform/gluetun-lib.nix`);
`*-lib.nix` files are excluded from the auto-import.

## Auto-generated systemd units

For each `bridgeMemberships` entry, podman.nix emits a
`podman-<name>.service` override with:

- `Type = lib.mkForce "oneshot"` + `RemainAfterExit = true`
- `Restart = "on-failure"`, `RestartSec = "15s"`
- `StartLimitBurst = 20` / `StartLimitIntervalSec = 600` — first-boot
  races (app-db tenants waiting on pg) trip systemd's 5-in-10s
  default; 20 retries over 10 min lets them converge.
- `RequiresMountsFor` — auto-extracted for EVERY absolute host path in
  the volumes. Without it a container binding `/s2/foo` can start
  before the dataset mounts, write into the empty underlay, and the
  data lands in a hidden inode. Silent loss.
- The `--network=` flags for every listed bridge, plus `after`/`wants`
  on each `podman-network-<bridge>-net.service` (a oneshot running
  `podman network create --ignore`, with `--subnet` when pinned).

**Why `Type=oneshot`**: rootless podman + system units don't play nice
with `Type=notify` — `podman run -d` exits in milliseconds and conmon
migrates into santiago's user-cgroup hierarchy. Trade-off: mid-life
crashes leave the unit `active (exited)` while the container is dead
(the #1 debugging lie — see CLAUDE.md Debugging protocol).

**Do NOT set `podman.sdnotify = "healthy"`** despite NixOS's nag —
it blocks `podman run -d` waiting for a HEALTHCHECK most images don't
ship. The eval warnings are cosmetic.

## Stack module template

```nix
{ config, mkRootlessContainer, ... }: {
  # Single source of bridge membership — podman.nix injects the
  # --network= flags; never write them in extraOptions.
  fleet.bridgeMemberships.<name> = [ "traefik" ];

  fleet.webApps.<name> = {
    hostname    = "<name>.toscanini.me";
    serviceName = "<name>";           # container name on traefik-net
    port        = <in-container-port>;
    # exposeRemotely = true;          # if also via CF tunnel
  };

  virtualisation.oci-containers.containers.<name> = mkRootlessContainer {
    image = "<registry>/<repo>:<tag>";   # qualify registry; podman is strict
    volumes = [ "${config.fleet.stateRoot}/<group-or-name>:/config" ];
    environmentFiles = [ config.sops.secrets."<name>-env".path ];
  };
}
```

Variants:

- **Multi-bridge** (own private bridge for inter-container DNS —
  pasta doesn't do container DNS; a user-defined bridge with
  aardvark-dns does): list both, private bridge first:
  `[ "mybridge" "traefik" ]`. Used by nextcloud, monitoring, immich,
  app-db. litellm and n8n use `app-db` as their primary bridge. A
  membership can carry `:alias=` so an image reaches a sibling by the
  hostname it expects (immich: `alias=database`, `alias=redis`).
- **Multi-port** (immich: 2283 + 8081 + 8082) — one `webApps` entry
  per port with distinct hostnames, same `serviceName`.
- **Host port required** (must-keep table in
  `.claude/rules/traefik-publishing.md`) — omit `serviceName`, set
  `port` to the host port, keep `ports = [ "host:container" ]`,
  declare `bridgeMemberships.<name> = [ ]` (pasta), and open the
  firewall port in the same module.

## Rootless UID mapping (full)

Rootless podman as santiago (UID 1000), subuid range `100000:65536`:
container UID 0 → host 1000; container UID N≥1 → host 99999+N
(33 → 100032 www-data, 70 → 100069 Alpine postgres, 105 → 100104
Debian postgres, 911 → 100910 linuxserver default, 1000 → 100999).

Files under `fleet.stateRoot` need host-UID ownership matching the
container UID — declare it in `fleet.statePaths` with the CONTAINER
id. **The 70-vs-105 postgres trap**: swap a postgres container between
Alpine and Debian images and the data-dir ownership stops matching;
state-paths.service re-enforces the DECLARED owner at every boot and
will silently re-chown, breaking postgres until the statePaths uid
matches the image.

**`PUID/PGID = 0` means "run as the user that owns the data"** for
linuxserver.io images — container UID 0 → host santiago, which owns
the data dirs. The intuitive `PUID=1000` maps to host 100999, owner of
nothing. Exception: PHP-FPM images (grocy) refuse UID 0 and keep
`PUID=911` with `100910:100910` data dirs.

## Small facts that bite during authoring

- **NixOS doesn't expose `/lib/modules`** — modules live at
  `/run/booted-system/kernel-modules/lib/modules/<ver>/`; containers
  wanting `/lib/modules` need an explicit bind.
- **Kernel modules don't auto-load rootless** — anything that wanted
  `--cap-add=SYS_MODULE` is done host-side via `boot.kernelModules`
  (wg-easy + the gluetun instances declare wireguard/iptables/tun).
- **iptables-legacy needs `NET_ADMIN` AND `NET_RAW`** — NET_ADMIN
  alone errors "you must be root" (raw sockets for state queries).
- **In-container sysctls are netns-scoped** — `--sysctl=net.*` is safe,
  doesn't bleed onto the host. (Host-wide sysctls go in
  configuration.nix: `vm.overcommit_memory=1` serves both redises;
  `net.ipv4.ip_unprivileged_port_start=80` lets rootless traefik bind
  80/443 — pasta doesn't grant CAP_NET_BIND_SERVICE.)
- **Bridge → host-netns traffic arrives as the host's LAN IP** — pasta
  SNATs to 192.168.0.2; the bridge subnet never appears. A trust list
  on a host-netns app (Home Assistant's `trusted_proxies`) must name
  `${fleet.lanIp}/32`, NOT the bridge subnet. For bridge-routed
  upstreams the subnet IS correct (immich).
- **Named volumes are outside the backup tree** — use bind mounts with
  `fleet.statePaths` pre-creation. If the image's path needs seeding,
  add a `podman run --rm cp` oneshot ordered before the container.
