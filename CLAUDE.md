# s2-server — operator notes for Claude

NixOS home server. Everything is declared in `/etc/nixos/`. Read these
rules before touching anything.

## ⛔ Hard rules

### 1. Never mutate OS state imperatively

NixOS *is* its configuration. Runtime changes (sysctls, systemd unit
edits, `useradd`, `iptables`, `/etc/*` outside the nix-managed paths,
`chmod`/`chown` on nix-managed paths, network config, `nix-env -i`)
are **discarded on the next reboot or `nixos-rebuild switch`**. The
loop is always:

1. Edit a file under `/etc/nixos/`.
2. `git add` it — **this repo is a flake; the build only sees
   git-tracked files.** An un-added file fails eval with "file not
   found". Use **plain `git`, never `sudo git`**: the repo is
   `santiago:users`, and one root-owned object makes the next push fail
   ("unable to open loose object") while `git status` sits permanently
   "ahead by 1". `sudo` is only for `nixos-rebuild`, which just reads.
3. `sudo nixos-rebuild test` — try the config without making it the
   next boot.
4. Verify.
5. `sudo nixos-rebuild switch` — commit as the next boot generation.
6. `git commit && git push` when confirmed good.

Every input (nixpkgs 25.11, nixpkgs-unstable, sops-nix) is pinned in
`flake.lock`; any checkout rebuilds this exact system. There is **no
nixos channel** — `nix-shell -p` / `nix run` resolve from the flake
registry pin. Upgrade with `nix flake update` (or the weekly
`flake-autoupgrade.timer`, which commits/pushes as santiago via
`setpriv`), never `nix-channel`.

If a real imperative bootstrap is unavoidable (rare), flag it, get
confirmation, and queue the declarative version as the next step.

Claude's own context lives in this repo too — `CLAUDE.md`, `.claude/`
(skills, commands, rules, tracked settings), the sops-encrypted
`.mcp.json` source — and follows the same `git add` rule: untracked
means invisible to a fresh checkout, and an untracked `*.sops` fails
eval outright.

### 2. Never mutate app state through the CLI

Rule 1 is OS state; this is the state *inside* an app — its SQLite
file, Postgres tables, config store (`wg-easy.db`, `grafana.db`,
`gravity.db`, n8n's tables). Those live outside the rebuild trail: a
`sqlite3`/`psql`/`sed` write leaves no record of how the value came to
be and dies on a fresh bootstrap.

Two sanctioned paths, in order: **make it declarative** (env var,
converge oneshot, `ExecStartPost` — a rebuild then reproduces it), or
**use the app's own API/UI** — the discoverable surface, and how
Cleanuparr, Pocket ID, the *arrs and Jellyfin were all configured here.
Reading is always fine; writes are what's fenced. If neither fits,
report the exact values and let the operator enter them — never reach
into a database to work around a missing scope or an awkward UI.

### 3. Confirm before destructive or system-wide actions

This is a single-machine home server. There is no staging. Pause and
confirm before:

- `rm -rf` outside `/tmp` or a known scratch dir
- `zfs destroy` / `zpool destroy` / `zfs rollback`
- Wide `chown -R` / `chmod -R` outside a single stack's directory
- Bringing services down others depend on (Pi-hole especially — kills
  LAN DNS)
- Rebuilds that change boot config, kernel params, or filesystems
- Edits to `/etc/nixos/` files Claude can't see (anything under
  `**/secrets/`)
- Editing `acme.json` directly (Traefik's cert store)

### 4. Critical shared infrastructure to keep in mind

- LAN DNS (Pi-hole) — every device in the house resolves through it
- Cloudflare DDNS — public hostname `s2.toscanini.me` points here
- Nextcloud — file sync (photos moved to Immich; not monitored)
- Media (Jellyfin / *arrs) — actively used
- Factorio server — has live players
- Home Assistant (`stacks/home-assistant`, `homeassistant.toscanini.me`)
  — home automation. Runs in the **host netns** (`--network=host`) so
  mDNS/zeroconf + SSDP discovery works; traefik dials it at
  `host.containers.internal:8123` and :8123 itself is firewall-closed.
  Recorder is on the shared pg cluster (`fleet.appDatabases.home_assistant`),
  reached at `127.0.0.1:5433` because the host netns can't resolve `pg`.
  `configuration.yaml` is nix-generated and read-only; secrets reach it
  via HA's `!env_var` YAML tag, never the store
- Apps platform (`stacks/apps` + `stacks/app-db`) — self-built apps,
  shared Postgres, auto-deploy from the box's own registry (current:
  `anansi`, `argus`, `daedalus`, `voyra`). CI runs on this box too
  (`stacks/gha-runner` → `stacks/registry`, a zot at
  `registry.toscanini.me`); nothing leaves the house
- Plane (`stacks/plane`, `plane.toscanini.me`) — issue tracker, 12
  containers. The one web UI deliberately NOT behind the SSO gate
- Minecraft (`stacks/minecraft`) — Paper server on a router-forwarded
  port; the whitelist is empty on purpose (see operator decisions)
- AI stack — LiteLLM gateway (`stacks/litellm`) + Open WebUI
  (`stacks/open-webui`, `chat.toscanini.me`) front the **Lemonade**
  model server on the gaming PC (chat / embeddings / STT / TTS /
  image). Lemonade has a full REST API reachable from this box — drive
  it directly, not the GUI; see `lemonade.md`. RAG vectors:
  `stacks/litellm-pgvector` fronts pgvector on the shared cluster
  behind LiteLLM's vector-store API; stores are DB state registered via
  `/vector_store/new` (STORE_MODEL_IN_DB drops the config registry), so
  ingest via the connector's REST API, not the LiteLLM UI.

Ask what depends on a thing before touching it. The answers that cost
real downtime to learn are in **Cross-cutting container gotchas**; the
pg → pocket-id cascade is the one that surprises people.

---

## Operator decisions — do not re-propose

These were decided deliberately, with reasons. Re-suggesting them wastes
a turn and reads as not having looked. Any of them can be revisited if
the operator raises it — but don't open the topic unprompted.

**Architecture / infra**

- **No off-site backup.** Declined on monthly cost; local syncoid
  replication only. Fire/theft/ransomware risk consciously accepted.
  The "NOT in any backup tree" list below is a *statement of fact*, not
  an invitation to pitch restic/B2/rsync.net again.
- **Keep Google as the DNS upstream.** Don't propose unbound or DoT.
- **Rejected in audits, don't re-raise:** quadlet migration, native
  NixOS Nextcloud/Immich modules, distributed tracing, impermanence,
  disko, lanzaboote, deploy-rs, CI flake builds, Renovate, VLANs, ZFS
  encryption retrofit.
- **Immich keeps its own postgres** — it needs a VectorChord/pgvecto.rs
  image, so it cannot join the shared cluster.

**Identity**

- **Jellyfin stays on native auth** — never forward-auth its hostname.
  TV and device logins can't do an OIDC redirect.
- **Plane is deliberately not gated.** Community Edition has no OIDC, so
  a forward-auth gate in front of it would create two unrelated identity
  namespaces rather than SSO. Its magic-link login *is* the
  authentication; exposure is LAN + WireGuard only. Re-read the auth
  section of `stacks/plane/plane.nix` before re-adding a gate.
- **Break-glass logins are kept on purpose** — grafana admin basic-auth,
  n8n owner password, Open WebUI's `/auth?form=true`. They sit *behind*
  the gate (defense in depth), not beside it. Don't "harden" them away.

**Monitoring**

- **Home Assistant alerting is muted indefinitely** (since 2026-08-03).
  `grep -rn HA-MUTED /etc/nixos` finds the complete set. HA silence is
  NOT evidence of health, and the mutes are not a bug to fix. The
  operator will re-arm them when HA work resumes.
- **The security dashboard's port-scan and SSH panels were built, then
  deliberately deleted.** The router forwards so little that host-side
  scan panels are *structurally* blind, not merely quiet. Don't rebuild
  them without a router-forwarding change.
- **No IP geolocation database** (MaxMind/DB-IP declined); country comes
  only from Cloudflare's header.

**Media**

- **Minecraft's whitelist is empty on purpose.** The server runs and
  refuses every login, which is the correct resting state for a
  router-forwarded port — it fails closed. Never invent a username to
  "test" it: names resolve against Mojang at startup and a bad one is
  fatal.
- **Janitorr and Cleanuparr both run in dry-run**, by choice, until the
  operator reviews a cycle of logs.

---

## The network edge

Worth knowing before reasoning about exposure: **the TP-Link router
forwards only three ports** — `51820/udp` (WireGuard), `34197/udp`
(Factorio) and `25565/tcp` (Minecraft). A Wake-on-LAN rule exists but is
off.

Consequences that are easy to get wrong:

- 22, 80, 443, 53 and postgres are **LAN-only**. Public HTTP arrives
  **exclusively** through the Cloudflare tunnel.
- Internet port scans are absorbed by the router and never reach the
  host firewall. Internet SSH brute force is impossible; sshd sees
  LAN/VPN only.
- `fleet.wanHost` (`s2.toscanini.me`) is **split-horizon**: pi-hole
  answers it with the LAN IP while Cloudflare's A record carries the WAN
  address, so one address works on the sofa and in a hotel. It must stay
  **DNS-only (grey cloud)** — proxying it would break remote Minecraft
  and mask the LAN override.

---

## System overview

| Field      | Value                                             |
|------------|---------------------------------------------------|
| Hostname   | `s2-server`                                       |
| OS         | NixOS 25.11 (`system.stateVersion` pinned, do NOT bump) |
| Static IP  | `192.168.0.2` on `enp3s0`                         |
| Public DNS | `s2.toscanini.me` (Cloudflare DDNS, 5-min poll)   |
| User       | `santiago` — sole non-root admin, UID 1000, locked password |
| SSH        | Key-only; `AllowUsers = santiago`, root disabled  |
| Sudo       | NOPASSWD on `wheel`                               |
| RAM        | 64 GiB; `zramSwap` enabled, no disk swap          |
| Containers | Rootless podman, declared via `oci-containers`    |
| Reverse proxy | Traefik (file provider; rules generated from nix) |
| LAN DNS+DHCP | Native NixOS pi-hole 6                         |

---

## File layout

```
/etc/nixos/
├── flake.nix                      # inputs (nixpkgs/unstable/sops-nix) + the s2-server system
├── flake.lock                     # exact pinned commits — reproducibility anchor
├── .sops.yaml                     # sops recipients (host key + santiago's age key)
├── configuration.nix              # host config (auto-imports platform/ + stacks/)
├── hardware-configuration.nix     # auto-generated
├── README.md                      # one-screen orientation
├── CLAUDE.md                      # this file — cross-cutting / platform / "why"
├── AUTH.md                        # per-service SSO migration plan
├── FUTURE.md                      # deferred work + open follow-ups
├── HARDWARE.md                    # dated hardware event log (journald only keeps ~11d)
├── lemonade.md                    # the GPU box's model server
│
├── .claude/                       # Claude Code's project config — TRACKED
│   ├── settings.json              # durable permission allowlist + enabled MCP servers
│   ├── settings.local.json        # per-machine accumulation (gitignored)
│   ├── commands/                  # slash commands (update-images)
│   ├── skills/                    # skills (log-audit)
│   └── mcp.json.sops              # encrypted source of .mcp.json
├── .mcp.json                      # SYMLINK to /run/secrets, made at activation (gitignored)
│
├── platform/                      # OS-level infra (not stacks)
│   ├── claude.nix                 # materializes .mcp.json from .claude/mcp.json.sops
│   ├── podman.nix                 # container runtime: bridgeMemberships/statePaths + every mk* helper (_module.args single-owner)
│   ├── publishing.nix             # publish layer: webApps + traefik/CF/dns/observability registries
│   ├── gluetun-lib.nix            # mkGluetunInstance — by-path library (excluded from auto-import)
│   ├── sops.nix                   # sops-nix: decrypt via SSH host key at activation
│   ├── zfs.nix                    # all ZFS: boot, datasets, snapshots, mounts
│   ├── git/                       # git config + GitHub SSH identity (github-key.sops)
│   ├── mail/                      # msmtp relay + fleet.mail options + smtp-app-password.sops
│   ├── hc-ping/                   # healthchecks.io-style dead-man pings + ping-key.sops
│   └── ddclient/                  # dynamic DNS
│       ├── ddclient.nix
│       └── cloudflare-token.sops  # sops-encrypted, tracked
│
└── stacks/<stack>/                # one folder per stack
    ├── <stack>.nix                # the module
    ├── assets/                    # tracked: non-secret config files
    ├── env.sops                   # sops-encrypted secrets (dotenv), tracked
    └── secrets/                   # ONLY machine-generated state (gitignored)
```

Every stack is a folder, even single-file ones. `assets/` is for
tracked non-secret files (configs, dashboards, templates, bind-mounted
YAML/JSON).

**Container state lives under `fleet.stateRoot`**
(`/home/santiago/selfhost` — interpolate the option, never the
literal). Grouped stacks nest one level; the taxonomy is documented on
the option in `platform/podman.nix` and enforced by review, not
assertion:

- `ai/` — lemonade-logs, litellm, open-webui
- `apps/` — the apps platform: `apps/<name>/data`, plus app-adjacent
  state other stacks own (argus's `gluetun/`, daedalus's `apply/`)
- `books/` — calibre-web, shelfmark
- `tv/` — the media fleet and its janitors (cleanuparr, janitorr,
  recyclarr, seerr)
- everything else — `<stateRoot>/<stack>`

A new stack that serves an existing group joins the group's directory.

**Two secret classes — never conflate them (see the Secrets section):**
- **Operator-managed** secrets are `*.sops` files (age-encrypted,
  tracked in git, edited with `sops <file>`). They live at the stack
  root, NOT in `secrets/`.
- **Machine-generated** state (app-db cluster/per-app passwords, per-app
  `AUTH_SECRET`s) still lives in `secrets/`, gitignored via `**/secrets/`
  — born on the box by bootstrap oneshots, rotated by deletion.

Each module's header comment is the canonical doc for that stack's
quirks. CLAUDE.md is the cross-cutting / platform / "why" doc.

---

## The module system

### `fleet.*` options (`platform/podman.nix`)

Per-stack modules contribute to these option sets. NixOS module
merging combines all contributions; there is no central registry.
Runtime options (`bridgeMemberships`, `bridgeSubnets`, `statePaths`)
live in `platform/podman.nix`; the publish layer (`webApps` and
everything it materializes into) in `platform/publishing.nix`;
`appDatabases`, `logStacks`, `monitoredJobs`, `mail`,
`sso.issuerUrl` and `sso.discoveryConsumers` are declared in their
owning modules (`stacks/app-db`, `stacks/logging`, `platform/mail`,
`stacks/pocket-id`).

The table below documents the options a *stack author* contributes to.
`grep -rhoE 'fleet\.[a-zA-Z0-9_.]+' platform/ stacks/ --include=*.nix`
is the authoritative list if this drifts.

| Option | Type | What it does |
|---|---|---|
| `bridgeMemberships` | `attrsOf (listOf str)` | **The single source of bridge membership.** Container → list of bridge short names (`"traefik"` → `traefik-net`), each optionally carrying a podman network suffix (`"nextcloud:alias=redis"`). podman.nix injects the `--network=` flags itself (stacks must NOT write them in `extraOptions`), orders the unit after every listed bridge, and creates each bridge. `[ ]` = pasta. Non-bridge networking (`--network=host`, `--network=container:X`) stays in `extraOptions`, paired with a `[ ]` entry here. Lists merge across modules (e.g. app-db appends `"pg-wire"` to traefik's list). A stale key with no matching container fails eval (missing image). |
| `bridgeSubnets` | `attrsOf str` | Bridge short name → CIDR pin, passed as `--subnet` at bridge creation. `traefik-net` is pinned to `10.89.7.0/24` in `stacks/traefik`; consumed by nextcloud/immich `TRUSTED_PROXIES`. |
| `statePaths` | `attrsOf submodule` | Path → `{ uid, gid, mode, type }` (`uid`/`gid` are CONTAINER ids — 0 = santiago; `type` is `"d"` or `"f"`). Applied by the root `state-paths.service` oneshot with the subuid mapping (NOT tmpfiles — systemd-tmpfiles skips rules under the santiago-owned /home prefix as "unsafe path transition"; every podman unit orders after the oneshot) — the fleet convention for pre-creating bind-mount sources (fresh-restore safety; guards the 70-vs-105 postgres ownership trap). `acme.json` is pre-created as an `f` 0600 entry. |
| `appDatabases` | `attrsOf submodule` | Per-app database + login role on the shared pg cluster (`stacks/app-db`). A bootstrap oneshot materializes role/db and writes an env file with `DATABASE_URL` + `POSTGRES_*` (password also emitted as `DB_POSTGRESDB_PASSWORD` so n8n-style images work unmodified). Tenants join `app-db-net`. `consumers` (container names, default `[ "app-<name>" ]` — fits the apps platform) are auto-ordered after the bootstrap AND directly after `podman-pg.service` (transaction-proof: a mass restart re-queues consumers without the already-active bootstrap), whose unit gates on `pg_isready` before dependents start. Read-only `envFile` exposes the bootstrap env file's path — reference it, never hardcode the path. |
| **`webApps`** | `attrsOf submodule` | **Primary publishing interface.** Fields: `hostname` (default `<name>.<baseDomain>`), `port` (only with `serviceName`), `serviceName?`, `serviceUrl?`, `traefikService?`, `exposeRemotely?` (default false), `auth?` (`"none"`/`"oidc"`), `authBypassRule?`, `authHeaders?`, `healthPath?`, `healthHeaders?`, `authGroups?`, `extraMiddlewares?`, `isolated?`, `metrics?`. **Exactly one of `serviceName` / `serviceUrl` / `traefikService` is required** (assertion). `serviceName` is the preferred bridge-routed shape — traefik dials `http://${serviceName}:${port}` over `traefik-net`. `serviceUrl` is an explicit full URL — for stacks that can't ride `traefik-net` (gluetun-netns containers, pi-hole as a native service) and TLS-internal upstreams. `traefikService` is a named traefik service (`api@internal` — the dashboard). `auth = "oidc"` gates the router(s) behind the generated Pocket ID forward-auth middleware. `healthPath` makes gatus probe `https://<hostname><healthPath>` (real upstream, not the IdP) and is appended to the oidc bypass rule — **mandatory for `auth = "oidc"` apps** (assertion); `healthHeaders` adds probe headers so the probe asserts authenticated health. `isolated = true` puts the app on a private `iso-<name>-net` bridge with traefik as the only other member — for header-trusting apps (grocy, calibre-web, healthchecks); requires `serviceName`, and an assertion rejects a stray `"traefik"` membership. `metrics.enable` emits the prometheus scrape (`metrics.port`/`metrics.path` narrow it). Materializes into `traefikRoutes` (websecure router, plus a `<name>-cf` cfweb router when `exposeRemotely`), `dnsHosts` (pi-hole short-circuit to 192.168.0.2), and `cloudflareRoutes` (when `exposeRemotely`). Always exposes on the LAN; off-LAN is opt-in. |
| `traefikRoutes` | `attrsOf submodule` | Lower-level `Host(...)` routes. Fields: `host`, `serviceUrl` XOR `service` (no implicit fallback), `middlewares?`, `entrypoint?` (`websecure` default, `cfweb` for CF-tunnel). The single entrypoint-level wildcard covers every router — no per-route cert options exist. Use directly only when `webApps` doesn't fit. |
| `traefikRawRules` | `attrsOf str` | Raw YAML for routes that don't fit the simple shape. |
| `dnsHosts` | `listOf str` | Lines appended to pi-hole's `dns.hosts`, format `"<IP> <fqdn>"`. Most stacks contribute via `webApps` indirectly. |
| `cloudflareRoutes` | `attrsOf submodule` | Ingress rules for the local-managed CF tunnel (consumed by stacks/cloudflared and the `cloudflared-route-sync` oneshot that upserts CNAMEs). Most stacks contribute via `webApps` indirectly. |
| `prometheusScrapes` | `listOf attrs` | Merged into the generated prometheus.yml. |
| `grafanaDashboardsByFolder` | `attrsOf (attrsOf lines)` | `<folder>` → `<name>` → JSON, rendered as Grafana sidebar folders (e.g. the apps platform's "Apps" folder). |
| `logStacks` | `attrsOf (listOf str)` | Stack → container names — alloy's Loki `stack` label map, nix-rendered into the alloy config. Unregistered containers fall back to `stack=<container-name>`. Declared in `stacks/logging`. |
| `monitoredJobs` | `attrsOf submodule` | Scheduled-job monitoring registry: `<unit> = { email ? true; slug ? null }`. `email` adds `OnFailure` mail (notify-email@), `slug` adds healthchecks dead-man pings (platform/hc-ping). Declared in `platform/mail`; an assertion rejects names with no real unit. |
| `litellmKeys` | `attrsOf submodule` | Per-consumer **virtual keys** on the LLM gateway (`stacks/litellm/keys.nix`), shaped like `ssoClients`. Attr name = the key alias the ledger/metrics/dashboard show. The key value is generated on the box (`/key/generate` takes a caller-supplied `key`), stored in `stacks/litellm/secrets/virtual-keys.env` (gitignored, rotate by deleting the line), and converged by `litellm-keys-sync.service` via `podman exec` — never through traefik, so convergence doesn't depend on ingress. Fields: `models` (empty = unrestricted), `mcpServers`, `searchTools`, `consumers`, `consumerEnv` (list — one image often reads the same credential under six names). **`mcpServers` is not optional**: a virtual key reaches no MCP server by default and `tools/list` answers with an empty array rather than an error, so omitting it silently removes a caller's tools. A master key bypasses all of these, which is why nothing noticed before. No `passthroughRoutes` option exists — `allowed_passthrough_routes` is LiteLLM Enterprise-only, so `/reranking` is unauthenticated instead (argued in `stacks/litellm/assets/config.yaml`). |
| `sso.discoveryConsumers` | `listOf str` | Container names that fetch the OIDC discovery document **while starting up** and can't recover if it isn't served yet — they either panic (gatus, zot) or come up with OIDC login silently broken (verdaccio, wealthfolio); under `--rm` the crash leaves a green oneshot unit with no container. Each listed container is ordered behind traefik + pocket-id AND gated by a bounded `ExecStartPre` probe of the real discovery URL. Ordering alone is NOT enough: it only proves `podman run -d` returned, and the path that matters runs through traefik. Declared in `stacks/pocket-id` (alongside `sso.issuerUrl`); an assertion rejects `pocket-id` itself. **If a new stack panics on OIDC discovery at boot, add one line here — do not hand-roll another ExecStartPre.** |

### Constants and self-registering registries

The table above is what a stack *contributes to*. These are the rest of
the `fleet.*` namespace — the shared constants a stack should read
instead of restating, and the registries that write themselves.

| Option | Owner | What it is |
|---|---|---|
| `lanIp` | `platform/publishing.nix` | `192.168.0.2`. Read it; the literal appeared ~15× before it existed. |
| `baseDomain` | `platform/publishing.nix` | `toscanini.me`. Every published host is **exactly one label** under it — the wildcard cert matches one label, so `a.b.toscanini.me` routes fine and then serves a cert no browser accepts. Asserted. |
| `wanHost` | `platform/publishing.nix` | `s2.toscanini.me`. Split-horizon (see **The network edge**); `platform/ddclient` declares the CF record and the pi-hole override from this one binding so they cannot drift. |
| `mail` | `platform/mail` | `{ sender, alertTo, smtpHost, smtpPort }` — the one mail identity, consumed by msmtp, smartd, ZED and every `OnFailure` hook. |
| `apps` | `stacks/apps/declarations.nix` | **The apps platform.** Not hand-written: `declarations.nix` reads `stacks/apps/apps.json`, which is an export of daedalus's `apps` table. DB = editing surface, JSON = contract (nix eval is pure and can never query Postgres). Sub-options include `auth.mode`, `source.mode`, `stage`, `resources`, `presentation`, `deploy.enable`, `egress`, `prometheus.enable`. |
| `ssoClients` | `stacks/pocket-id/clients.nix` | Declarative Pocket ID OIDC clients. Forward-auth clients are **auto-derived** from `webApps.<n>.auth = "oidc"` — never write those out. Only `displayName`/`description` have no mechanical source, so each stack sets its own consent copy. The sync converges but **never prunes**: deleting a stack leaves its client live at the IdP until deleted by hand. |
| `gluetunTenants` | `stacks/downloads` | Container → ports/UIs, merged across stacks (tv and shelfmark both contribute). The downloads stack publishes the sorted union on gluetun's container, since only the netns owner can publish. |
| `vpnEgress` | `platform/publishing.nix` | Written by `mkGluetunInstance` **itself**, so a third tunnel appears on daedalus's Network page by existing. Both derived facts stay derived: the control port is read out of the instance's own `ports` list, and "which containers ride this tunnel" is computed by filtering for `--network=container:<owner>` — a parallel list could only disagree. |
| `directIngress` | `platform/publishing.nix` | The services reachable at the WAN address rather than through the tunnel, each with a `note` explaining why it can't ride it. Currently WireGuard, Factorio, Minecraft. |
| `cloudflare` | `stacks/cloudflared` | `{ accountId, tunnelId, zoneId }` — read by the route-sync oneshot and daedalus. |
| `factorio` / `minecraft` | their stacks | Game-server version + roster options (Minecraft's `whitelist`/`ops`). |
| `rebuildLock` | `platform/autoupgrade` | A lockfile path shared by the weekly autoupgrade and daedalus's Apply, so two rebuild triggers can't run at once. |

### `mkRootlessContainer` helper

Exposed via `_module.args`. Decorator that injects:

- `autoStart = true`
- `podman.user = "santiago"`
- `environment` merged with `{ TZ = config.time.timeZone; }`

Used by every container declaration:

```nix
virtualisation.oci-containers.containers.foo = mkRootlessContainer {
  image = "...";
  ports = [ ... ];
  volumes = [ ... ];
};
```

Sibling helpers on `_module.args`: `hostUid` (container uid → host
uid, N ≥ 1 only), `mkDotenvSecret` (sops boilerplate),
`mkSecretRender` (boot-render oneshots for derived secrets — the
fleet's answer to duplicated/re-exported secrets), and
`mkLocalImage { name, tagPrefix, contextDir, gates }` → `{ image,
service }` — locally-built images (nextcloud-ffmpeg,
verdaccio-openid) get tags embedding the
build-context store hash, so a context change produces a new tag and
restarts the consumer.

ALL `_module.args` live in podman.nix — a module that defines
`_module.args` cannot itself consume a custom arg (the args option
evaluation recurses through the module call). For the same reason the
gluetun family (`mkGluetunInstance`, `mkGluetunExporter`) is a
BY-PATH library, `platform/gluetun-lib.nix`: its consumers (downloads,
argus-vpn) force it inside a top-level `config = lib.mkMerge [...]`,
where a module arg would recurse. `*-lib.nix` files are excluded from
the auto-import.

### Auto-generated systemd units

For each `bridgeMemberships` entry, `podman.nix` emits a
`podman-<name>.service` override with:

- `Type = lib.mkForce "oneshot"` + `RemainAfterExit = true`
- `Restart = "on-failure"`, `RestartSec = "15s"`
- `StartLimitBurst = 20` / `StartLimitIntervalSec = 600` — first-boot
  races (app-db tenants waiting on pg) trip systemd's
  5-in-10s default; 20 retries over 10 min lets them converge.
- `RequiresMountsFor` — auto-extracted for EVERY absolute host path
  in the volumes. Without this, a container binding `/s2/foo` can
  start before its ZFS dataset mounts, write into the empty underlay,
  then the dataset mounts on top and the data is in a hidden inode.
  Silent loss.
- The `--network=` flags for every listed bridge (injected — stacks
  never write them), plus `after`/`wants` on each
  `podman-network-<bridge>-net.service`.

For each unique bridge named in any list, a oneshot
`podman-network-<bridge>-net.service` runs `podman network create
--ignore <bridge>-net` at boot (with `--subnet` when the bridge is
pinned in `bridgeSubnets`).

**Why `Type=oneshot`** — rootless podman + system units don't play
nice with `Type=notify`. `podman run -d` exits in milliseconds (so
systemd sees the parent gone before READY arrives) and conmon
migrates into santiago's user-cgroup hierarchy. Treating
the start as fire-and-forget setup is the workaround. Trade-off:
mid-life crashes leave the unit `active (exited)` while the container
is dead. Acceptable for stable images.

**Do NOT set `podman.sdnotify = "healthy"`** despite NixOS's nag.
`--sdnotify=healthy` blocks `podman run -d` waiting for a HEALTHCHECK
that most images don't ship. The eval warnings are cosmetic.

---

## Adding a stack

Short form (see `README.md` for the full recipe):

```bash
mkdir -p /etc/nixos/stacks/<stack>/assets
$EDITOR /etc/nixos/stacks/<stack>/<stack>.nix
# secrets, if needed — encrypt with sops (see the Secrets section):
$EDITOR /tmp/env && sops -e --input-type dotenv --output-type dotenv \
  /tmp/env > /etc/nixos/stacks/<stack>/env.sops && shred -u /tmp/env
# no import line needed — configuration.nix auto-imports stacks/**.nix
git -C /etc/nixos add -A            # flake only sees tracked files
sudo nixos-rebuild test    # verify
sudo nixos-rebuild switch
```

Stack module template (default — joins `traefik-net`, no host port):

```nix
{ mkRootlessContainer, ... }: {
  # Single source of bridge membership — podman.nix injects the
  # --network= flags; never write them in extraOptions.
  fleet.bridgeMemberships.<name> = [ "traefik" ];

  # `webApps` is the one-line "publish this HTTP service" interface.
  # `serviceName + port` make traefik dial the upstream by container
  # DNS on traefik-net (`http://<name>:<in-container-port>`) — no host
  # port needed. LAN HTTPS is always set up; `exposeRemotely = true`
  # adds the Cloudflare-tunnel cfweb router + the public CNAME.
  fleet.webApps.<name> = {
    hostname    = "<name>.toscanini.me";
    serviceName = "<name>";           # container name on traefik-net
    port        = <in-container-port>;
    # exposeRemotely = true;          # if also via CF tunnel
  };

  virtualisation.oci-containers.containers.<name> = mkRootlessContainer {
    image = "<registry>/<repo>:<tag>";   # qualify registry; podman is strict
    volumes = [ ... ];
    environmentFiles = [ config.sops.secrets."<name>-env".path ];
  };
}
```

Variants:

- **Multi-bridge** (stack has its own private bridge, e.g. for inter-
  container DNS) — list both, private bridge first:
  `fleet.bridgeMemberships.<name> = [ "mybridge" "traefik" ]`. Used
  by nextcloud, monitoring (grafana + prometheus), immich, app-db.
  litellm and n8n instead use `app-db` as their primary bridge —
  their DBs live on the shared cluster.
- **Multi-port** (e.g. immich exposes 2283 + 8081 + 8082) — declare
  one `webApps` entry per port with distinct hostnames; all point at
  the same `serviceName` with different `port`s.
- **Host port required** (must-keep table above) — omit `serviceName`,
  set `port` to the host port, keep the `ports = [ "host:container" ]`
  line, declare `bridgeMemberships.<name> = [ ]` (pasta), and open the
  firewall port in the same module. Non-bridge networking
  (`--network=host`, `--network=container:X`) also pairs a `[ ]` entry
  with the flag in `extraOptions`.

### Rollback

`sudo nixos-rebuild list-generations` (kept: 10). Reboot, pick a
previous generation from the systemd-boot menu. No compose fallback.

---

## Rootless UID mapping

Rootless podman with `podman.user = "santiago"` (UID 1000) and
subuid range `100000:65536`:

| Container UID | Host UID  | Notes |
|---|---|---|
| 0 (root)      | 1000 (santiago) | Linuxserver.io images set `PUID=0` to map here. |
| N ≥ 1         | 99999 + N | e.g. 33 → 100032 (www-data), 70 → 100069 (Alpine postgres), 105 → 100104 (Debian postgres), 911 → 100910 (linuxserver default). |

Files on disk under `fleet.stateRoot` (`/home/santiago/selfhost/`)
need host-UID ownership matching the container UID:

- `1000:100` (santiago:users) — container root (UID 0)
- `100032:100032` — www-data
- `100069:100069` — Alpine postgres (UID 70)
- `100104:100105` — Debian postgres (UID 105)
- `100910:100910` — linuxserver `abc` user (UID 911, e.g. grocy)

**The 70-vs-105 postgres trap**: if you swap a postgres container
between Alpine and Debian images, the data dir ownership stops
matching. `state-paths.service` re-enforces ownership at every boot
and will silently re-chown the data dir to whatever the declaration
says, breaking postgres until the statePaths uid matches the image.

### `PUID/PGID = 0` means "run as the user that owns the data"

Linuxserver.io's s6-overlay drops to `PUID:PGID` before starting the
app. Under rootless podman, container UID 0 → host santiago (1000),
which is what owns the data dirs. Setting the intuitive `PUID=1000`
would map to host 100999 — owner of nothing.

Exception: PHP-FPM images (grocy) refuse UID 0. Those keep the
linuxserver default `PUID=911`, and the data dir is chowned
`100910:100910`.

---

## ZFS layout

Two pools. Everything ZFS-related (boot config, mounts, snapshot timers,
per-dataset properties) lives in `platform/zfs.nix`. The `datasets`
attrset there is the single source of truth — adding a property or
enrolling a dataset in snapshots is a one-line change.
`zfs-converge.service` diffs current state against the declaration on
every rebuild and `zfs set`s only when something differs.

### `rpool` — OS pool (NVMe, 4 TB)

| Dataset           | Mount                          | Recordsize | Snapshot tiers |
|---|---|---|---|
| `rpool/root`      | `/`                            | 128K       | none (opted out) |
| `rpool/nix`       | `/nix`                         | 128K       | none (opted out) |
| `rpool/home`      | `/home`                        | 128K       | frequent + hourly + daily |
| `rpool/selfhost`  | `/home/santiago/selfhost`      | **16K**    | frequent + hourly + daily |

`rpool/selfhost` is the one to watch for snapshot growth. 16K
recordsize + high DB churn (every container's postgres / redis cluster
lives here) can produce bigger-than-intuition deltas. After a week of
normal operation, check `zfs list -t snapshot -o name,used
rpool/selfhost`; if total snapshot usage is materially bigger than
expected, drop the daily tier in `platform/zfs.nix` and keep only
frequent + hourly.

### `s2-pool` — data pool (2× 16 TB HDD mirror)

Children declared in `platform/zfs.nix` (`datasets` attrset). Adding a
child is a one-line edit there — `fileSystems."/s2/<name>"` is emitted
automatically. Dataset CREATION is not automated; if the pool is fresh
after a rebuild, run `zfs create -o mountpoint=legacy s2-pool/<name>`
once per missing child (the list in `datasets` documents which).

| Path | Use | Snapshot tiers |
|---|---|---|
| `/s2/santi`, `/s2/sofi`, `/s2/shared` | Personal files | hourly + daily + weekly |
| `/s2/tv`               | Media library (Jellyfin source + *arrs)   | none (re-downloadable) |
| `/s2/immich`           | Immich photo/video                        | hourly + daily + weekly |

`s2-pool` reports "Some features not enabled" — the pool was created
on an older ZFS. `zpool upgrade s2-pool` would enable them but locks
out older ZFS versions; don't do it without a rollback plan.

### Snapshot policy

Per-dataset enrollment via `com.sun:auto-snapshot=true` (set in
`datasets` above). Per-tier opt-out via
`com.sun:auto-snapshot:<tier>=false`. Tier counts are global on
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

### Maintenance

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

---

## Traefik

`stacks/traefik/traefik.nix`. The rule-generator details + ACME
config live in the module's header.

### Entrypoints

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

### ACME (DNS-01 via Cloudflare)

One entrypoint-level wildcard: `toscanini.me` + `*.toscanini.me`.
Every published hostname is one level under `toscanini.me`, so the
single wildcard covers everything with no per-route ACME work.

Creds: `CF_DNS_API_TOKEN` in `stacks/traefik/env.sops` (the one
variable lego's cloudflare provider reads; the same token value also
lives in cloudflared's env.sops — rotate both together). Cert store at `/home/santiago/selfhost/traefik/acme.json`
(mode 0600). Back it up before risky pool work — Let's Encrypt
rate-limits new issuances (5 duplicates / 50 new per week per
registered domain).

**Traefik 3.x quirk**: adding new wildcards to
`entrypoint.tls.domains` after the first run does NOT auto-trigger
ACME issuance — Traefik only renews existing certs.

### Reaching upstreams from Traefik

Every route declares its upstream **explicitly** — there is no
implicit `host.containers.internal` fallback. The webApps option
exposes two ways to say "where does traefik dial":

**Preferred — bridge-routed (`serviceName`, no host port):** the
stack joins the shared `traefik-net` bridge and traefik dials it by
container DNS (aardvark-dns):

```nix
fleet.bridgeMemberships.metube = [ "traefik" ];
fleet.webApps.metube = {
  hostname    = "metube.toscanini.me";
  serviceName = "metube";  # container name on traefik-net
  port        = 8081;      # in-container port
};
```

The generated rule's upstream is `http://metube:8081` (the
`--network=traefik-net` flag is injected from `bridgeMemberships`).
Stacks that already live on a private bridge (litellm, n8n,
nextcloud, immich, monitoring) list `"traefik"` as a **secondary**
element in their `bridgeMemberships` list; their primary bridge stays
for internal stack comms.

**Isolated variant (`isolated = true`)** — header-trusting apps
(grocy, calibre-web, healthchecks) get a private `iso-<name>-net`
bridge whose only other member is traefik, so nothing else on
`traefik-net` can dial them directly. Requires `serviceName`; the
stack must NOT also list `"traefik"` in `bridgeMemberships` (the
iso-bridge membership comes from `webApps.isolated`).

Container names attached to `traefik-net` must be globally unique on
that bridge — avoid generic names like `web`, `app`, `api`.

**Escape hatch — explicit URL (`serviceUrl`, for must-keep stacks):**
for upstreams that can't join `traefik-net`, declare the full URL:

```nix
fleet.webApps.sonarr = {
  hostname   = "sonarr.toscanini.me";
  port       = 8989;
  # gluetun owns the netns — only it can publish ports — and putting
  # gluetun on traefik-net would mix VPN-exit traffic with non-VPN.
  serviceUrl = "http://host.containers.internal:8989";
};
```

This pattern is reserved for: the entire TV stack (gluetun-shared
netns); pi-hole (a native NixOS service, not a container); the rare
image that listens TLS internally (`https://name:port`).

An assertion fails the build if a webApp sets neither (or both) of
`serviceName` / `serviceUrl`.

### Must-keep host ports

These stay host-published for structural reasons — not leftovers:

| Reason | Ports / services |
|---|---|
| **Wrong protocol** (not HTTP) | sshd 22 TCP; pi-hole 53 TCP+UDP + DHCP 67 UDP; wg-easy 51820 UDP; factorio 34197 UDP; app-db postgres 5432 TCP (traefik TCP/SNI TLS, LAN-only) + 5433 TCP (plain-TCP host port on pg — for gluetun-netns tenants whose clients can't do direct-TLS) |
| **Host network stats** | node-exporter 9100 — reads host `/proc`, `/sys`, real NICs; lives on `--network=host`, not traefik-net |
| **Multicast / discovery** | home-assistant — whole container on `--network=host` (mDNS 5353 + SSDP 1900 UDP opened on enp3s0 only); a bridge netns sees no multicast, so every IoT integration would need hand-typed IPs. Its own :8123 stays firewall-closed — traefik reaches it via `host.containers.internal`. jellyfin SSDP 1900 / autodiscover 7359 UDP **if configured** (not currently configured; the HTTP UI on 8096 rides traefik-net) |
| **Shared netns (gluetun trap)** | The entire TV stack — qbittorrent, nzbget, flaresolverr, prowlarr, radarr, sonarr, bazarr, subgen, gluetun-exporter all share gluetun's netns. Only gluetun can publish ports; putting gluetun on traefik-net mixes VPN-exit traffic with non-VPN. Do NOT migrate. |
| **Traefik ingress** | 80, 443 TCP (LAN HTTPS) — traefik IS the proxy. cfweb :8888 is bridge-only (cloudflared dials it over `traefik-net`), not host-published |

Every host-bound port above is opened by its **owning stack module**
(grep `networking.firewall.allowed*Ports` in `stacks/*/`); there is
no centralized list in `configuration.nix`.

### Smoke test

```
curl -sk --resolve pihole.toscanini.me:443:192.168.0.2 \
     -o /dev/null -w "%{http_code}\n" \
     https://pihole.toscanini.me/
# expect: 302
```

---

## Pi-hole

Native NixOS service (NOT a container). Module: `stacks/pihole/pihole.nix`.

### Config vs state

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

### Pi-hole down → no DNS for the box

The s2-server resolves through `127.0.0.1`. If pi-hole is down: no
DNS, including for the SSH client trying to reach the box.
Mitigation: SSH by IP, `systemctl restart pihole-ftl`.

### Web UI

The embedded web server listens on `:8080` plain HTTP; Traefik fronts
it. The admin password is blanked (`api.pwhash = ""`) — browser access
rides the Pocket ID forward-auth gate instead.

### Every container is DNS client `127.0.0.1` — one shared rate limit

aardvark-dns forwards container queries to the host resolver, so all
~75 containers **plus** the host share one per-client budget: FTL's
default `1000 queries / 60s`. One busy container (a CI `pnpm install`
did it) exhausts it for the whole house. While limited, pi-hole answers
`REFUSED` — Go renders that as `server misbehaving`, so the symptom
never looks like DNS: traefik shows **"Failed to exchange auth code"**
on every gated app, pocket-id fails to send mail. `id.toscanini.me` is
a *local* `fleet.dnsHosts` record, so failing to resolve it proves
pi-hole is refusing rather than an upstream problem. Confirm in
`/var/log/pihole/FTL.log` (**not** journald): `Rate-limiting 127.0.0.1
…`. The fix (`misc.rateLimit` up) restarts pihole-ftl = brief LAN DNS
outage — ask first; tracked in FUTURE.md. Different mechanism, same
symptom: myspeed's `:00` speedtest blackhole (gotchas section).

---

## Monitoring (prometheus + grafana)

`stacks/monitoring/monitoring.nix`. Both prometheus.yml and the
dashboards dir are now **nix-generated**:

- `prometheus.yml` is built from `baseScrapes` (prometheus self +
  node-exporter) + every stack's `fleet.prometheusScrapes`
  contribution.
- Dashboards dir is a `runCommand` derivation combining
  `stacks/monitoring/assets/dashboards/*.json` (OS-generic: cpu,
  memory, network, storage, home-server) + each stack's
  `fleet.grafanaDashboards` (root-level) + `grafanaDashboardsByFolder`
  (organized into sidebar folders, e.g. the "Apps" folder).

Both bind-mount /nix/store paths into the container; container
restarts automatically on any rebuild that changes the derivation
(volume bind path changes → systemd unit changes → restart).

Prometheus publishes no host port and runs without
`--web.enable-lifecycle`; reach it via `https://prometheus.toscanini.me`
or by container DNS on its bridge. Per-app scraping on the apps
platform is opt-in: `prometheus.enable` defaults to false — enable it
when the app ships `/metrics` (the scrape and the per-app dashboard
are both gated on it).

### Provisioning vs UI

Provisioned via `disableDeletion: true` + `allowUiUpdates: false` — UI
changes are temporary; the JSON files are source of truth. Grafana's
own state (UI-added dashboards, users, service accounts, alert-rule
history) lives in the `grafana` database on the shared app-db cluster
— covered by the cluster's backup story, but NOT in the rebuild trail.
Alert rules + contact points are file-provisioned from
`assets/provisioning/alerting/`. Coverage: failed systemd units (via
a `systemd_failed_units` textfile gauge), `up == 0`, zpool state,
gluetun VPN down / port-forward lost, traefik cert expiry, and
`container_up` staleness. Gatus additionally probes each webApp's
`healthPath` — the real upstream, not the IdP.

Editing anything under `stacks/monitoring/assets/` has its own traps
(provisioning ghosts, mandatory `instant: true` on alert rules) —
`.claude/rules/monitoring-assets.md` loads them when you touch those
files.

### Per-container metrics

Rootless podman puts container cgroups under
`user.slice/user@1000.service/...`, which no *packaged* cgroup exporter
can see — cadvisor walks the system cgroup tree and never descends into
`user@1000.service`. `host-liveness-exporter` reads those cgroup files
directly instead (one `podman ps` for the id→name map, the numbers from
`/sys/fs/cgroup/.../libpod-<id>.scope`), so per-container metrics DO
exist here, for all ~75 containers:

| Series | Notes |
|---|---|
| `container_cpu_usage_seconds_total{name}` | counter — use `rate()`; podman stats' percentage is a lifetime average |
| `container_memory_usage_bytes{name}` | `memory.current`, **page cache included** |
| `container_memory_limit_bytes{name}` | omitted entirely when uncapped |
| `container_cpu_limit_cores{name}` | omitted entirely when uncapped |
| `container_pids{name}` / `container_pids_limit{name}` | podman's own default cap is 2048 |
| `container_oom_kills_total{name}` | the signal a memory cap is too tight |

Resolution is 60s (the timer), so short rate windows are quantisation
noise. Memory sitting **at** its limit is normal — page cache is charged
there and reclaimed under pressure; read the OOM counter, not usage.
Liveness still comes from `container_up`; per-app application metrics
still live in each service's own `/metrics` endpoint.

### Container resource limits

`fleet.apps.<name>.resources` (`cpus` / `memoryMb` / `pids`) caps an app
container; other stacks pass the same flags via `extraOptions` (`pg`,
`app-db-exporter`, `janitorr`, the gha-runners). Editable in daedalus →
app → Settings. All null by default — a silently-capped app is one that
dies at 3am for a reason nobody wrote down.

These work rootless **only** because systemd delegates `cpu io memory
pids` to `user@1000.service`; verify with `cat /sys/fs/cgroup/user.slice/
user-1000.slice/user@1000.service/cgroup.controllers`. Without
delegation podman accepts the flags and the kernel ignores them.

**The `--memory-swap` trap**: podman 5.7 + crun 1.24 write it into
`memory.swap.max` **verbatim** — they do NOT subtract `--memory` the way
the docker docs describe, and they default it to `2*memory` when unset.
So `--memory=N` alone means an OOM kill at `3N`. The module always emits
`--memory-swap` equal to `--memory`, making the resident cap `N` with
`N` of zram overflow and the kill at `2N`. `--memory-swap` below
`--memory` is rejected outright, so `2N` is the floor.

---

## Stacks with cross-cutting quirks

**Each module's header comment is the canonical doc for its own stack.**
This file only carries what spans stacks. What follows is the index of
which headers are worth reading before touching something, and the one
fact from each that reaches beyond its own module.

| Stack | Read its header before… | The cross-stack fact |
|---|---|---|
| `stacks/downloads` | touching gluetun, the VPN, or any *arr | **Owns the shared netns.** Ten containers ride `--network=container:gluetun` (the tv stack's downloaders + *arrs + subgen, shelfmark, flaresolverr, the exporter). Only the netns owner can publish ports, so every tenant's host port is declared on gluetun. Any change that recreates gluetun bounces all ten. |
| `stacks/tv` | media, hardlinks, Jellyfin | Content only — the *arrs, downloaders and Jellyfin. Jellyfin is deliberately **outside** the VPN (LAN streaming shouldn't burn paid bandwidth) and is the only one on `traefik-net`. |
| `stacks/argus-vpn` | the second tunnel | A second `mkGluetunInstance`. Each further instance takes the same in-netns ports **+2** (`8000/8001` → `8002/8003`). |
| `stacks/nextcloud` | upgrades, redis, previews | Two containers on `nextcloud-net`; DB on the shared cluster, and post-install the image reads **only `config.php`**, never `POSTGRES_*`. Its `nextcloud-ffmpeg` image is the reference `mkLocalImage` use, and its redis is the reference "one sops secret, two consumers" use (`mkSecretRender` writes a `redis.conf` owned by the container redis uid, so the stock entrypoint's privilege drop still works). A version bump needs manual `occ` chores — they're in the header. |
| `stacks/app-db` | anything touching postgres | 16 databases share one cluster. A restart is a **fleet event** — see the pg cascade below. |
| `stacks/plane` | its auth | 12 containers; the one UI not behind the SSO gate, deliberately. |
| `stacks/minecraft` | the game server | itzg image traps (a `--cap-drop=ALL` kills its privilege drop silently); backups must run as root or they lose `level.dat`. |

Two facts from the VPN stacks that genuinely belong here, because they
bite outside their own modules:

- **Reaching the host from a netns tenant is `host.containers.internal`,
  never the LAN IP.** Under pasta the host is `169.254.1.2`; `192.168.0.2`
  refers back to the container itself. Gluetun's
  `FIREWALL_OUTBOUND_SUBNETS = 169.254.1.2/32` opens the kill switch for
  exactly that and nothing else, which is how the *arrs reach pg on
  :5433 without leaving the tunnel.
- **iGPU transcoding** is `--device=/dev/dri/renderD128` (mode 0666 on
  the host so rootless needs no `--group-add=render`); the i915 driver is
  force-probed in `platform/gpu.nix`.

---

## Cross-cutting container gotchas

### A moving tag is never re-pulled (`--pull missing`)

`oci-containers` generates `podman run --pull missing`, and `missing`
matches on **tag, not digest**. Once `foo:latest` is in local storage it
is never re-fetched again:

- `systemctl restart podman-<name>` re-runs the **stale cached image**.
- `nixos-rebuild switch` doesn't help either — the ExecStart string
  embeds the literal tag, which doesn't change when the registry moves,
  so systemd sees no reason to restart the unit.

So every stack pinned to `:latest` (immich, jellyfin, the *arrs, …) is
frozen on whatever was pulled the day it was first started. That's
mostly fine — a pinned image is a stable image — but it means **a
container is never "automatically up to date"**, and updating one is
always an explicit `podman pull` + `systemctl restart`.

Do NOT "fix" this with `pull = "newer"` on the container. It makes every
container start — including at boot — depend on the registry being
reachable and the credentials being valid. Pull out-of-band instead.

`stacks/apps/` does exactly that, and it's the one subsystem here that
*is* continuously deployed: see below.

### App hostnames

`fleet.apps.<name>.hostname` overrides the derived
`<name>.<fleet.baseDomain>`; null keeps the default. An **assertion
requires exactly one label under `baseDomain`** — traefik serves a single
entrypoint-level wildcard (`sans=*.toscanini.me`), which matches one
label, so `a.b.toscanini.me` would route fine and then serve a cert no
browser accepts. The CF tunnel's CNAMEs and pi-hole's short-circuit make
the same assumption. A second apex domain needs its own cert, tunnel
config and DNS.

Renaming moves the traefik router, pi-hole record, gatus probe, CF route
and `AUTH_URL`/`APP_PUBLIC_URL`. The container, postgres role/database,
sops file and GitHub repo stay keyed by the attribute name. An SSO app
cannot complete a login between the rebuild and Pocket ID picking up the
new redirect URI.

Collisions are caught twice: `fleet.traefikRoutes` asserts no two routers
share an entrypoint+host, and daedalus rejects a taken hostname while
it's being typed (the manifest carries every published hostname) — the
nix assertion fires mid-Apply, after the commit, which costs a revert.

### Apps auto-deploy from the box's own registry (the Vercel loop)

Every `fleet.apps.<name>` gets `app-<name>-deploy.timer` (every 2 min,
`deploy.enable` defaults to true). The oneshot it fires pulls the image,
and **only if the digest actually moved** restarts the container and
health-checks it through traefik. So: push to main → a self-hosted
runner on this box builds and pushes `registry.toscanini.me/<name>:latest`
(zot, `stacks/registry`) → the box picks it up within ~2 min, unattended.
No manual pull, no rebuild, and nothing leaves the house.

- Watch a deploy: `journalctl -fu app-<name>-deploy.service`
- Last result per app: `/var/lib/app-deploy/<name>` (`<digest> ok|failed`; a sibling `<name>.pull` marker = pulls currently failing)
- Freeze an app: `deploy.enable = false` (pair with a `sha-`pinned `image`)

**Deploy-and-report, not auto-rollback.** A new image that doesn't answer
within 90s keeps running, and the unit stays `failed` — persistently, via
the state file, so a later quiet tick can't bury the report. Check
`systemctl --failed`.

The unit runs as **root** (it must restart a system unit) and drops to
santiago with `setpriv` for the podman calls, because the images live in
santiago's rootless store. `setpriv`, not `runuser`/`sudo` — those open a
PAM session per call and would log thousands of lines a day into
journald/Loki at a 2-minute tick.

The default images live on the local registry and ride its anonymous-read
policy, so the ordinary path needs no credential at all. An `--authfile`
is still passed on every pull (`stacks/apps/ghcr-auth.json.sops`,
sops-managed) and is **inert** unless an `image` override points at a
private GHCR package — which accepts **only a classic PAT** with
`read:packages`, since fine-grained PATs and GitHub App tokens are
rejected there. So a token expiry no longer stops deploys; if apps
quietly stop updating, look at the runner and at zot first.

### NixOS doesn't expose `/lib/modules`

Modules live at `/run/booted-system/kernel-modules/lib/modules/<ver>/`.
Containers that want `/lib/modules` need an explicit bind mount.

### Kernel modules don't auto-load in rootless

Anything that wanted `--cap-add=SYS_MODULE` must be done host-side via
`boot.kernelModules` (rootless can't grant SYS_MODULE). Current
contributors: `stacks/wg-easy/` and the gluetun instances declare wireguard +
iptables modules (and `tun` for tv).

### iptables-legacy needs `NET_ADMIN` AND `NET_RAW`

`NET_ADMIN` alone errors with "Permission denied (you must be root)" —
iptables-legacy uses raw sockets for netfilter state queries.

### In-container sysctls are netns-scoped

`--sysctl=net.ipv4.ip_forward=1` and friends are network-namespaced.
Safe; doesn't bleed onto the host.

### Inter-container DNS needs a user-defined bridge

Pasta doesn't do inter-container DNS. Stacks that dial each other by
name attach to a custom bridge in `fleet.bridgeMemberships`
(nextcloud, monitoring, immich, app-db + its tenants).
aardvark-dns resolves container names automatically.
`host.containers.internal` still works on bridges.

### `:alias` for expected hostnames

A bridge membership can carry a podman network suffix
(`"immich:alias=database"`) so an image reaches a sibling by the
hostname it expects. Current users: immich (`alias=database`,
`alias=redis` — the upstream compose's names).

### Pi-hole sinkholes some registries

`docker.litellm.ai` and `docker.n8n.io` resolve to `192.168.0.2` (pi-hole
sinkhole) → traefik's default cert → `podman pull` fails with cert
mismatch. Use `docker.io` / `ghcr.io` instead. Verify with `getent
hosts <registry>`.

### cfweb + websecure on one router = 404

Traefik applies `tls:` per-router, not per-entrypoint. A single router
with both entrypoints forces TLS on cfweb too, which CF's tunnel
(plain HTTP) breaks. `webApps.exposeRemotely` generates the split pair
(websecure router + `<name>-cf` cfweb router) automatically.

### When an image wants a secret under a different name

Do NOT re-export in an entrypoint shell wrapper — render a derived
file with `mkSecretRender` instead (one sops source, a boot oneshot
writes the shape the consumer wants). Fifteen stacks use it; the
representative cases are litellm's prometheus bearer token, n8n +
healthchecks SMTP env, and nextcloud-redis's redis.conf.

For DB passwords from the shared cluster, neither is needed — the
generated env file already carries the password under both
POSTGRES_PASSWORD and DB_POSTGRESDB_PASSWORD (how n8n runs the stock
entrypoint). If a future image wants yet another name, add it to the
always-emitted list in `stacks/app-db/assets/bootstrap.sh`.

Two silent traps come with `mkSecretRender`:

**Never render into `/run/<container-name>`.** oci-containers gives each
podman unit `RuntimeDirectory=<container-name>` with Preserve=no, so
systemd **deletes that dir every time the container stops** — and the
render unit is `RemainAfterExit`, so a plain container restart doesn't
re-run it. The file is just gone; the container crash-loops on a missing
config (hours of Nextcloud 500s). Pick a `dir` whose basename matches no
container: `/run/nextcloud-redis-conf`, not `/run/nextcloud-redis`.

**A rotated secret does not reach the box on a rebuild.** New ciphertext
doesn't change the render unit's text, so nothing restarts — and the
consumer read the old file as `--env-file` at start anyway. Activation
prints `modifying secret: …` and `/run/secrets/…` IS correct, which is
what makes the stale render so convincing. After any rotation:

```
sudo systemctl restart <the-render>.service && sudo systemctl restart podman-<consumer>.service
```

Plain `sops.secrets.<n>` are immune — sops-nix re-decrypts every
activation (why `platform/claude.nix` uses one directly). The
declarative fix (derived `restartTriggers`) is in FUTURE.md.

### Redis wants `vm.overcommit_memory=1`

Declared host-wide in `configuration.nix` (a global sysctl, not
netns-scoped); serves nextcloud-redis + immich-redis, which log
background-save warnings without it.

### Privileged port binding (80, 443)

Pasta doesn't grant `CAP_NET_BIND_SERVICE` to rootless containers.
Fix is declarative in `configuration.nix`:

```nix
boot.kernel.sysctl."net.ipv4.ip_unprivileged_port_start" = 80;
```

Trade-off: any unprivileged process can bind to ports ≥ 80. Single-user
home server, acceptable.

### Published ports rewrite the client source IP — and are load-bearing

A rootless bridge-networked container's `-p host:container` goes
through **rootlessport**, which proxies the connection and replaces the
client address with a podman bridge address. Traefik's access log
therefore shows every LAN and WireGuard client as `10.89.x.x`; only
cfweb requests carry real IPs, because cloudflared forwards
`X-Forwarded-For` and the entrypoint trusts it.

**Do not "fix" this by handing traefik systemd-activated sockets.** It
works on the traefik side — podman propagates `LISTEN_FDS`/
`LISTEN_FDNAMES` into the container and traefik ≥ 3.2 matches a
descriptor to an entrypoint by `FileDescriptorName` — but dropping
`-p 80:80 -p 443:443` also drops the DNAT rule that publishing installs
**inside the rootless network namespace**. Pi-hole answers every
`*.toscanini.me` with 192.168.0.2, and under pasta that address is the
namespace's own, so container→traefik loopback depends on that rule:
removing it broke every gatus probe and traefik's own OIDC discovery
call (tried and reverted 2026-07-30). Real LAN client IPs would require
containers to resolve those hostnames over `traefik-net` instead.

### Named volumes are outside the backup tree

A named volume lives at `~santiago/.local/share/containers/storage/...`
— outside `/home/santiago/selfhost/`. Use **bind mounts** by default,
with the source pre-created via `fleet.statePaths`. If the image's
path needs seeding from the image itself, add a `podman run --rm cp`
oneshot ordered before the actual container starts.

### A pg restart is a fleet event

Any change that restarts `podman-pg.service` — a one-line edit to
`stacks/app-db/app-db.nix` counts — bounces the shared cluster
**mid-life**. Fifteen tenants reconnect gracefully; **pocket-id does
not**: pg's DNS name briefly vanishes from the bridge, pocket-id's
health check is fatal (`lookup pg … no such host` exits the process),
and `Type=oneshot` leaves a green unit with a dead container.
`id.toscanini.me` → 502, then everything gated by it fails, and apps
that validate OIDC at startup (wealthfolio) hard-exit and stay down.
The consumer→pg ordering and `pg_isready` gate cover **boot** races
only, not mid-life restarts.

**After any pg bounce:** `systemctl restart podman-pocket-id`, then
anything still down, then verify:

```
curl -sk --resolve id.toscanini.me:443:192.168.0.2 \
  https://id.toscanini.me/.well-known/openid-configuration   # expect 200
```

### The first connection to a rootless-published port stalls

A **new** TCP connection from a container to a port published out of
the rootless netns (`host.containers.internal:<port>` — the
gluetun-netns services, home-assistant) hangs on the SYN **20–50% of
the time** and fails only after the kernel's ~10.5 s retransmit ladder;
the SYN dies in pasta's userspace before reaching the target namespace.
Refuted, don't re-derive: not load (reproduces at concurrency 1), not
staleness (back-to-back probes stall *more* than spaced ones).

**Never raise the timeout** — a flat 10 s timeout is a 10 s page. Use an
**escalating** ladder (`[400, 800, 1_500, 2_500]` ms), retrying only a
*thrown* request — a 4xx/5xx is the service answering. Escalating,
because a stalled *connection* wants abandoning fast while a slow
*response* wants waiting out. The inverse rule also holds: **never
retry an upstream that is slow because it is busy** (Loki runs few
concurrent queries — a retry just queues another behind the first; it
gets one patient attempt).

### Never schedule network-heavy jobs on the hour

myspeed speedtests at `:00:00` (schedule in its own DB, not nix),
saturating the uplink and dropping DNS **wholesale for 1–2 minutes**
house-wide. This silently broke the RSS digest for three days: its
04:00:15 trigger landed in the blackout, 29/35 feeds failed to resolve,
and the workflow still reported `success`. Corollary: collapsing a job
from every-6h to daily removes the accidental redundancy that covered a
starved run — pair the change with an explicit retry.

### Bridge → host-netns traffic arrives as the host's LAN IP

A container on `traefik-net` dialing `host.containers.internal:<port>`
reaches a `--network=host` listener with source address **192.168.0.2**
— pasta SNATs to the host address; the bridge subnet never appears. So
a trust list on a host-netns app (Home Assistant's `trusted_proxies`)
must name `${fleet.lanIp}/32`, **not** `fleet.bridgeSubnets.traefik` —
the intuitive answer silently rejects every proxied request. For
bridge-routed upstreams the subnet IS correct (immich). Inverse of the
rootlessport rewrite above.

### A gated app's icons need an auth bypass

A forward-auth'd app serves its favicon and apple-touch-icon **through
the gate**, so any fetch outside an authenticated page load gets a 302
to Pocket ID. iOS does exactly that on add-to-home-screen: it reads the
IdP's HTML where it expected a PNG and renders a generic letter tile —
broken-looking icon, correct on disk. Add the icon paths to
`authBypassRule` (same class as gatus needing `healthPath` bypassed);
iOS caches per site, so remove and re-add the bookmark after fixing.

---

## Debugging protocol

Four ways this box lies to you. Each one returns a confident, wrong
answer rather than an error.

**1. Container logs are not in the unit journal.**
`journalctl -u podman-<name>` holds ~5 systemd start/stop lines and
none of the container's output (oneshot `podman run -d` → stdout goes
to podman's log driver, shipped to Loki by alloy). Grepping it for
errors returns a meaningless zero — if `| wc -l` says ~5, you're
measuring nothing. Use `podman logs --since 12m <container>`, or Loki
for history beyond the container's lifetime ("is this error new or
pre-existing?"). Query Loki **through Grafana's datasource proxy** —
the loki image has no wget/curl and :3100 isn't host-reachable:

```
GF_USER=$(sudo grep '^GF_SECURITY_ADMIN_USER=' /run/secrets/grafana-env | cut -d= -f2-)
GF_PASS=$(sudo grep '^GF_SECURITY_ADMIN_PASSWORD=' /run/secrets/grafana-env | cut -d= -f2-)
curl -sk -u "$GF_USER:$GF_PASS" --resolve grafana.toscanini.me:443:192.168.0.2 \
  -G "https://grafana.toscanini.me/api/datasources/proxy/uid/loki-default/loki/api/v1/query_range" \
  --data-urlencode '{stack="<stack>"} |= "<needle>"' --data-urlencode 'limit=3'
```

Stack labels come from `fleet.logStacks`; ad-hoc `podman run`s collapse
to `stack=adhoc`. `jq` and `python3` are not on PATH.

**2. `systemctl is-active` cannot tell you a container is alive.**
`Type=oneshot` + `RemainAfterExit` + `--rm`: a container that dies
seconds after start leaves a **green** unit and no corpse. The single
most repeated failure mode on this box — gatus (OIDC discovery panic),
minecraft (guessed username; `--cap-drop=ALL`), searxng (bad config),
pocket-id (pg bounce), grocy-mcp (invalid YAML). Always confirm with
the container, not the unit:

```
sudo -u santiago env XDG_RUNTIME_DIR=/run/user/1000 \
  podman ps --filter name=<x> --format '{{.Names}}\t{{.Status}}'
```

If a stack fetches OIDC discovery at startup, add it to
`fleet.sso.discoveryConsumers` — don't hand-roll an `ExecStartPre`.

**3. A gatus probe passing means "something answered", not "it works".**
`healthPath` passes on any status `< 500`, so a **404 passes** —
Argus's healthPath 404'd through an entire framework migration while
reporting healthy. Prefer a path whose absence is a 5xx; a static asset
may have been synthesised by the old framework and absent from `git`.

**4. A wedged gluetun reads as perfectly healthy.**
A tunnel that can't establish restarts in a tight loop (seen: 145
restarts/15 min) while `podman ps` says `Up 4 days` **with port
mappings listed** — yet `ss -lntp` shows no listener and the whole
netns 502s. Check gluetun's logs, not the app's; the tell is
`restarting VPN because it failed to pass the healthcheck`. Fix:
`systemctl restart podman-gluetun-<name>`.

---

## Secrets

Managed by **sops-nix** (age encryption). Two classes:

### Operator-managed — `*.sops`, encrypted, tracked in git

Encrypted files (dotenv or binary) live at the **stack root**, end in
`.sops`, and decrypt at activation to `/run/secrets/<name>` (tmpfs,
never on disk) with the owner/mode set by `sops.secrets.<name>`.
Recipients (`.sops.yaml`): the **host key** (`ssh-to-age` of
`/etc/ssh/ssh_host_ed25519_key`) and **santiago's personal age key**
(`~/.config/sops/age/keys.txt` + password manager, the recovery path).

```nix
# in a stack module:
sops.secrets."<stack>-env" = {
  sopsFile = ./env.sops;
  format   = "dotenv";       # or "binary" for keys/certs/wg0.conf
  key      = "";             # whole file; a dotenv key name extracts one var
  owner    = "santiago";     # rootless podman reads it pre-userns-remap
};
# ...
environmentFiles = [ config.sops.secrets."<stack>-env".path ];
```

- **Edit:** `sops stacks/<stack>/env.sops` (decrypts to `$EDITOR`,
  re-encrypts on save). Then `nixos-rebuild switch`.
- **⚠ Rebuilding is not enough if a `mkSecretRender` unit reads that
  secret.** The rebuild updates `/run/secrets/*` but the render unit and
  its consumer both keep serving the old value — restart both by hand.
  See "When an image wants a secret under a different name" above; this
  is the most convincing false-success in the repo.
- **Add a recipient / rotate the host key:** edit `.sops.yaml`, then
  `sops updatekeys` every `*.sops` file **before** destroying the old key.
- **`sops` needs an identity** when run by hand, and is not on PATH:
  `SOPS_AGE_KEY_FILE=~santiago/.config/sops/age/keys.txt nix run nixpkgs#sops -- -d …`
  (or run as santiago). Root has no default age key. Editing a `.sops`
  dotenv in place needs `--input-type dotenv --output-type dotenv` —
  the name isn't `.env`, so auto-detect assumes JSON.
- **`.sops.yaml` is one catch-all rule**, so a new `*.sops` anywhere in
  the repo gets both recipients with no config change. Encrypt from
  inside `/etc/nixos` (or pass `--config`) or the rule isn't found and
  the host key is missing — activation then can't decrypt.
- **litellm master key** has one encrypted source of truth
  (`stacks/litellm/env.sops`). Every other consumer — the prometheus
  bearer token (`litellm-prom-token`), daedalus's `LITELLM_API_KEY` — is
  a `mkSecretRender` boot oneshot reading it; rotation touches only
  env.sops.
- **Cloudflare DNS token** is the one remaining rotate-together set:
  the same value lives in traefik's and cloudflared's env.sops and in
  `stacks/daedalus/service-keys.sops`.
- **Per-service read-only API keys** (Jellyfin token, *arr keys, CF
  token — the credentials daedalus reads numbers off) live together in
  `stacks/daedalus/service-keys.sops`, rendered as `DASH_<n>`. Two are
  deliberately NOT duplicated there: pocket-id's `STATIC_API_KEY` and
  plane's `PLANE_API_KEY` are grepped out of their own stacks' secrets.
  Nothing in this box's secret tree exists twice.
- **Argus's operator secrets** (Shodan key + peppers) live in tracked
  `stacks/apps/argus-env.sops`; the machine-generated
  `stacks/apps/secrets/argus/env` carries only `AUTH_SECRET`.

Encrypted `*.sops` files are `0644` (they're ciphertext — safe to
commit and world-read). Never commit plaintext; `**/secrets/` stays
gitignored as the safety net.

### Machine-generated — `**/secrets/`, gitignored, NOT in sops

Born on the box by bootstrap oneshots; rotate by deleting the file +
rebuild. Durability is a **backup** concern, not git.

| Path | Owner | Used by |
|---|---|---|
| `stacks/app-db/secrets/cluster/env` + `<name>/env` | `santiago:users` | shared pg cluster + per-app DATABASE_URL |
| `stacks/apps/secrets/<name>/env` | `santiago:users` | per-app `AUTH_SECRET` |

The GHCR fallback authfile is operator-managed sops
(`stacks/apps/ghcr-auth.json.sops`), not machine-generated — and inert
while every app pulls from the box's own registry.

### Pi-hole auth

Pi-hole's own admin password is blanked (`api.pwhash = ""` in
`stacks/pihole/pihole.nix`); the web UI is gated by the Pocket ID
forward-auth middleware at the traefik layer instead, like every other
admin UI.

---

## Recovery paths

- **The repo IS the system**: clone `nixos-s2`, restore a decryption
  identity (old host SSH key, or santiago's age key from the password
  manager), `nixos-rebuild switch --flake /etc/nixos#s2-server`. Full
  runbook in `README.md`. Secrets included — only machine-generated
  `secrets/` state and app data need the backups below.
- **NixOS generations** — systemd-boot menu keeps the last 10
  (`boot.loader.systemd-boot.configurationLimit = 10`). Reboot, pick.
- **ZFS snapshots** — every enrolled dataset (see "Snapshot policy"
  above). Restore via `<mount>/.zfs/snapshot/<snap>/` for selective
  `cp`-back, or `zfs rollback` if you want the dataset entirely
  reverted (destructive — discards everything newer).
- **`s2-pool` datasets** — NOT auto-created. After a fresh install
  with `zpool import s2-pool`, each missing child needs a one-time
  `zfs create -o mountpoint=legacy s2-pool/<name>`. The `datasets`
  attrset in `platform/zfs.nix` lists every child.

### NOT in any backup tree

These survive `zfs destroy` only if you backed them up by hand:

- `/var/lib/pihole/gravity.db` — UI-added blocklists / DNS entries
- `/home/santiago/selfhost/traefik/acme.json` — LE cert store
- grafana UI state (users, service accounts) — in the `grafana` DB on
  the app-db cluster, so covered by its snapshots, not by git
- Podman volumes. No stack *declares* one — bind mounts are the
  convention — but eleven ANONYMOUS volumes exist anyway (13 MB), minted
  by images whose Dockerfile `VOLUME` is not covered by a bind mount.
  They live under `~santiago/.local/share/containers/storage/volumes`,
  outside the backup tree, and `podman volume ls` shows them as
  hash-named. Check that list before assuming a container's state is all
  in `/home/santiago/selfhost/<stack>/`.

No off-site backup currently. `s2-pool` is the source of truth for
`/s2/*`; if both mirror drives fail together, anything not in
`/home/santiago/selfhost/.../config` is gone. Biggest gap on the box.
