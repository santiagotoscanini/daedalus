# s2-server — operator notes for Claude

NixOS home server. Everything is declared in `/etc/nixos/`. Read these
rules before touching anything.

**How this context is organized.** This file carries the always-on
knowledge: hard rules, settled decisions, runtime behavior, debugging.
Authoring detail loads on demand from `.claude/rules/*.md` when you
touch matching files (module-system for any `.nix`, zfs-storage,
traefik-publishing, pihole-dns, monitoring, secrets-sops, vpn-netns,
apps-platform, daedalus-app). Recurring workflows are skills —
`/rebuild`, `/triage`, `/rotate-secret`, `/add-stack`,
`/update-images`, `/log-audit`. Each module's header comment is the
canonical doc for its own stack.

## ⛔ Hard rules

These are **mechanically enforced**: `.claude/settings.json` carries
the deny/ask/allow matrix and `.claude/hooks/bash-guard.sh` blocks
violating commands with the reason. A block from the guard is the rule
firing, not an obstacle to route around.

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
(settings, hooks, rules, skills, agents), the sops-encrypted
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
- **`daedalus.toscanini.me` is the public landing page, not the app.**
  It's a hand-managed grey-cloud CNAME to GitHub Pages (served from
  `website/` in this repo) and is deliberately NOT a fleet hostname —
  the app lives at `daedalus-app.toscanini.me` (the `hostname` override
  in `stacks/daedalus/self.json`) so the two never collide in pi-hole,
  traefik, or `cloudflared-route-sync`. Never give any fleet app the
  bare `daedalus` hostname: route-sync would overwrite the Pages CNAME.

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
├── README.md                      # the project front page (pitch + doc index)
├── docs/                          # per-topic runbooks: operations, secrets, adding-a-stack, recovery
├── CLAUDE.md                      # this file — always-on rules / runtime / "why"
├── AUTH.md                        # per-service SSO migration plan
├── FUTURE.md                      # deferred work + open follow-ups
├── HARDWARE.md                    # dated hardware event log (journald only keeps ~11d)
├── lemonade.md                    # the GPU box's model server
│
├── .claude/                       # Claude Code's project config — TRACKED
│   ├── settings.json              # permission matrix (deny/ask/allow) + hook wiring + MCP enablement
│   ├── settings.local.json        # per-machine accumulation (gitignored)
│   ├── hooks/                     # bash-guard.sh (PreToolUse enforcement) + its test suite
│   ├── rules/                     # path-scoped context — loads when you touch matching files
│   ├── skills/                    # workflows: rebuild, triage, rotate-secret, add-stack, update-images, log-audit
│   ├── agents/                    # subagents (nix-reviewer)
│   └── mcp.json.sops              # encrypted source of .mcp.json
├── .mcp.json                      # SYMLINK to /run/secrets, made at activation (gitignored)
│
├── platform/                      # OS-level infra (not stacks)
│   ├── claude.nix                 # materializes .mcp.json from .claude/mcp.json.sops
│   ├── podman.nix                 # container runtime: bridgeMemberships/statePaths/stateRoot + every mk* helper
│   ├── publishing.nix             # publish layer: webApps + traefik/CF/dns/observability registries
│   ├── gluetun-lib.nix            # mkGluetunInstance — by-path library (excluded from auto-import)
│   ├── sops.nix                   # sops-nix: decrypt via SSH host key at activation
│   ├── zfs.nix                    # all ZFS: boot, datasets, snapshots, mounts
│   ├── git/                       # git config + GitHub SSH identity (github-key.sops)
│   ├── mail/                      # msmtp relay + fleet.mail options + smtp-app-password.sops
│   ├── hc-ping/                   # healthchecks.io-style dead-man pings + ping-key.sops
│   └── ddclient/                  # dynamic DNS + cloudflare-token.sops
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

## The module system — summary

Full reference (option fields, helpers, unit generation, the stack
template): `.claude/rules/module-system.md`, which loads whenever you
edit a `.nix` file. The shape in one screen:

Per-stack modules contribute to `fleet.*` option sets; NixOS module
merging combines them — there is no central registry. What a stack
author touches:

- `bridgeMemberships.<container>` — THE single source of bridge
  membership; podman.nix injects the `--network=` flags (never write
  them in `extraOptions`). `[ ]` = pasta.
- `webApps.<name>` — the one-line "publish this HTTP service"
  interface (hostname, serviceName+port | serviceUrl, auth = "oidc",
  healthPath, isolated, exposeRemotely). Materializes traefik routes,
  pi-hole DNS, CF-tunnel routes, gatus probes.
- `statePaths."<path>"` — pre-create bind-mount sources with
  CONTAINER-side uid/gid (0 = santiago; N≥1 → host 99999+N).
- `appDatabases.<name>` — role + database on the shared pg cluster,
  env file with DATABASE_URL generated at bootstrap.
- `monitoredJobs`, `prometheusScrapes`, `logStacks`, `dnsHosts`,
  `litellmKeys`, `ssoClients`, `sso.discoveryConsumers` — the
  observability/identity registries.
- Constants to read, never restate: `fleet.lanIp`, `fleet.baseDomain`
  (every host is exactly ONE label under it — asserted),
  `fleet.wanHost`, `fleet.stateRoot`, `fleet.mail`.

Helpers on `_module.args`: `mkRootlessContainer` (every container),
`mkDotenvSecret`, `mkSecretRender`, `mkLocalImage`, `hostUid`.

Every container unit is generated as `Type=oneshot` +
`RemainAfterExit` (rootless podman can't do notify) — which is why a
green unit proves nothing about a container being alive; see the
Debugging protocol. Do NOT set `podman.sdnotify = "healthy"` despite
NixOS's nag.

---

## Adding a stack

`/add-stack` walks this. Short form:

```bash
mkdir -p /etc/nixos/stacks/<stack>/assets
$EDITOR /etc/nixos/stacks/<stack>/<stack>.nix   # template in module-system rule
# secrets, if needed — encrypt with sops (see the Secrets section):
$EDITOR /tmp/env && sops -e --input-type dotenv --output-type dotenv \
  /tmp/env > /etc/nixos/stacks/<stack>/env.sops && shred -u /tmp/env
# no import line needed — configuration.nix auto-imports stacks/**.nix
git -C /etc/nixos add -A            # flake only sees tracked files
sudo nixos-rebuild test    # verify
sudo nixos-rebuild switch
```

The module template + variants (multi-bridge, multi-port, host-port)
are in `.claude/rules/module-system.md`.

### Rollback

`sudo nixos-rebuild list-generations` (kept: 10). Reboot, pick a
previous generation from the systemd-boot menu. No compose fallback.

---

## Rootless UID mapping — essentials

Container UID 0 → host santiago (1000). Container UID N≥1 → host
99999+N (70 → 100069 Alpine postgres, 105 → 100104 Debian postgres,
911 → 100910 linuxserver, 1000 → 100999). Files under
`fleet.stateRoot` need host ownership matching the container UID —
declared via `fleet.statePaths` with the CONTAINER id.

**The 70-vs-105 postgres trap**: swap a postgres image between Alpine
and Debian and `state-paths.service` re-chowns the data dir to the
(now wrong) declaration at every boot, breaking postgres until the
statePaths uid matches the image.

**Linuxserver images: `PUID=0` is correct** ("run as the user that
owns the data"); the intuitive `PUID=1000` maps to host 100999, owner
of nothing. PHP-FPM images (grocy) are the exception (refuse UID 0,
keep 911). Full mapping detail: module-system rule.

---

## ZFS — essentials

Two pools, everything declared in `platform/zfs.nix` (`datasets`
attrset = single source of truth; `zfs-converge.service` re-applies on
every rebuild). `rpool` (NVMe): root/nix unsnapshotted, home +
selfhost snapshotted frequent+hourly+daily, selfhost at 16K recordsize
— watch its snapshot growth. `s2-pool` (2×16TB mirror): /s2/* data,
children NOT auto-created on a fresh pool. syncoid mirrors selfhost +
home → s2-pool/backup (a mirror, not an archive).

Recovery browsing: `<mount>/.zfs/snapshot/<snap>/` — prefer `cp` from
there over `zfs rollback` (rollback discards everything newer). Tables,
tiers, maintenance schedule: `.claude/rules/zfs-storage.md`.

---

## Traefik — essentials

Entrypoints: `web` :80 (redirect), `websecure` :443 (LAN HTTPS,
wildcard cert `toscanini.me` + `*.toscanini.me` via DNS-01 — every
published host must be exactly ONE label under the domain), `cfweb`
:8888 bridge-only (plain HTTP for the CF tunnel), `traefik` :8080
bridge-only (API + metrics). Upstreams are always explicit: bridge
`serviceName` on traefik-net (preferred), `serviceUrl =
host.containers.internal:<port>` for the gluetun/host-netns stacks,
`isolated = true` for header-trusting apps. Cert store
`selfhost/traefik/acme.json` (0600, never read/edit; LE rate-limits
reissuance). Details + must-keep host-port table:
`.claude/rules/traefik-publishing.md`.

Smoke test:

```
curl -sk --resolve pihole.toscanini.me:443:192.168.0.2 \
     -o /dev/null -w "%{http_code}\n" https://pihole.toscanini.me/
# expect: 302
```

---

## Pi-hole — runtime failure modes

Native NixOS service (not a container); config declarative in
`pihole.toml`, mutable state in `/var/lib/pihole/gravity.db`
(UI-added entries die on a fresh install — persist via
`fleet.dnsHosts`). Details: `.claude/rules/pihole-dns.md`.

**Pi-hole down → no DNS for the box itself** (it resolves through
127.0.0.1), including for the SSH client trying to reach it.
Mitigation: SSH by IP, `systemctl restart pihole-ftl`.

**Every container is DNS client `127.0.0.1` — one shared rate limit.**
aardvark-dns forwards container queries to the host resolver, so all
~75 containers plus the host share FTL's default `1000 queries / 60s`
budget. One busy container (a CI `pnpm install` did it) exhausts it
for the whole house. While limited, pi-hole answers `REFUSED` — Go
renders that as `server misbehaving`, so the symptom never looks like
DNS: traefik shows **"Failed to exchange auth code"** on every gated
app, pocket-id fails to send mail. `id.toscanini.me` is a *local*
`fleet.dnsHosts` record, so failing to resolve it proves pi-hole is
refusing rather than an upstream problem. Confirm in
`/var/log/pihole/FTL.log` (**not** journald): `Rate-limiting
127.0.0.1 …`. The fix (`misc.rateLimit` up) restarts pihole-ftl =
brief LAN DNS outage — ask first; tracked in FUTURE.md. Different
mechanism, same symptom: myspeed's `:00` speedtest blackhole (gotchas
below).

---

## Monitoring — essentials

prometheus.yml and the Grafana dashboards dir are nix-generated
(contributions via `fleet.prometheusScrapes` /
`grafanaDashboardsByFolder`); provisioned dashboards are read-only in
the UI — JSON files are source of truth. Alerting covers failed
units, `up == 0`, zpool state, gluetun, cert expiry, `container_up`
staleness; gatus probes each webApp's `healthPath`. Per-container
metrics DO exist (host-liveness-exporter reads the user-slice cgroups
cadvisor can't): `container_{cpu,memory,pids,oom_kills}*` at 60s
resolution — read the OOM counter, not memory-at-limit. Detail +
resource-limit traps: `.claude/rules/monitoring.md`; Grafana asset
editing traps: `.claude/rules/monitoring-assets.md`.

---

## Stacks with cross-cutting quirks

**Each module's header comment is the canonical doc for its own
stack.** This is the index of which headers to read before touching
something, and the one fact from each that reaches beyond its module.

| Stack | Read its header before… | The cross-stack fact |
|---|---|---|
| `stacks/downloads` | touching gluetun, the VPN, or any *arr | **Owns the shared netns** — ten containers ride it; only gluetun can publish ports; recreating gluetun bounces all ten. Full trap list: `.claude/rules/vpn-netns.md` |
| `stacks/tv` | media, hardlinks, Jellyfin | Content only. Jellyfin is deliberately outside the VPN and the only one on `traefik-net`. |
| `stacks/argus-vpn` | the second tunnel | A second `mkGluetunInstance`; each further instance takes the same in-netns ports +2. |
| `stacks/nextcloud` | upgrades, redis, previews | Post-install the image reads **only `config.php`**, never `POSTGRES_*`. Version bumps need manual `occ` chores — in the header. Reference use of `mkLocalImage` + `mkSecretRender`. |
| `stacks/app-db` | anything touching postgres | 16 databases share one cluster. A restart is a **fleet event** — see the pg cascade below. |
| `stacks/plane` | its auth | 12 containers; the one UI not behind the SSO gate, deliberately. |
| `stacks/minecraft` | the game server | itzg image traps (`--cap-drop=ALL` kills its privilege drop silently); backups must run as root or they lose `level.dat`. |

One netns fact that bites everywhere: **reaching the host from a netns
tenant is `host.containers.internal`, never the LAN IP** — under pasta
the host is `169.254.1.2` and `192.168.0.2` refers back to the
container itself. (The rest of the VPN/netns facts live in
`.claude/rules/vpn-netns.md`.)

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

So every stack pinned to `:latest` is frozen on whatever was pulled the
day it was first started, and updating one is always an explicit act.
Do NOT "fix" this with `pull = "newer"` — it makes every container
start depend on the registry being reachable. Pull out-of-band.

**Three ways to perform that act**, in increasing order of ceremony:

- **daedalus → System › Updates** — every digest-pinned container, its
  changelog, and a button that runs the whole cycle (resolve the
  digest, pre-pull, rewrite the pin, commit, build, switch, verify the
  container came back on the new image, revert if not, push). The
  right tool for one container whose notes you have just read. The
  same door is `POST /api/image-update {container, toTag?}`.
- **`/update-images`** — the fleet-wide audit: research every pin in
  parallel, pick by tier, then the **adoption review** the button does
  not do (what the new versions let us delete from our own config).
- By hand — `podman pull` + `systemctl restart` for a one-off probe,
  remembering it leaves the flake pin behind and a rebuild undoes it.

Per-container policy for the first two lives in `fleet.imageUpdates`:
`lockstep` (immich's two, plane's six — one release, one commit),
`ceremony` (blast radius the container's name does not carry; the UI
demands the name typed), `updatable = false` (a move that is not a pin
edit, e.g. immich-postgres's major).

### The apps platform IS continuously deployed

The one exception to the above: every `fleet.apps.<name>` has a 2-min
deploy timer that pulls from the box's own registry and restarts on a
digest change (push to main → live in ~2 min). Watch:
`journalctl -fu app-<name>-deploy.service`; last result in
`/var/lib/app-deploy/<name>`. **Deploy-and-report, not auto-rollback**
— a broken new image keeps running and the unit stays `failed`; check
`systemctl --failed`. Full mechanics: `.claude/rules/apps-platform.md`.

### Pi-hole sinkholes some registries

`docker.litellm.ai` and `docker.n8n.io` resolve to `192.168.0.2` (pi-hole
sinkhole) → traefik's default cert → `podman pull` fails with cert
mismatch. Use `docker.io` / `ghcr.io` instead. Verify with `getent
hosts <registry>`.

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

---

## Debugging protocol

`/triage` walks these. Four ways this box lies to you — each returns a
confident, wrong answer rather than an error.

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
to `stack=adhoc`. `python3` is not on PATH (`jq` is).

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
`systemctl restart podman-gluetun-<name>` (bounces every tenant).

---

## Secrets — the model

Managed by **sops-nix** (age). Two classes; full mechanics + the
dedup map: `.claude/rules/secrets-sops.md`. `/rotate-secret` walks a
rotation end-to-end.

- **Operator-managed** — `*.sops` at the stack root, encrypted,
  tracked; decrypts at activation to `/run/secrets/<name>` (tmpfs).
  Edit: `sops stacks/<stack>/env.sops`, then rebuild. Recipients: the
  host SSH key + santiago's age key (password manager = recovery).
- **Machine-generated** — `**/secrets/` dirs, gitignored, born on the
  box by bootstrap oneshots; rotate by deleting the file + rebuild.
- **⚠ The false-success trap**: a rebuild is NOT enough when a
  `mkSecretRender` unit reads the rotated secret — the render unit and
  its consumer keep serving the old value even though activation
  printed `modifying secret:` and `/run/secrets/*` is correct. Restart
  the render unit AND the consumer by hand after every rotation.
- **Nothing in the secret tree exists twice** — consumers that need a
  value under another name render it from the one source
  (`mkSecretRender`), they don't copy it. The one rotate-together set
  is the Cloudflare DNS token (traefik + cloudflared + daedalus).
- Never read decrypted secrets wholesale; the sanctioned form is
  `sudo grep '^THE_ONE_VAR=' /run/secrets/<name>`. Encrypted `*.sops`
  files are world-readable ciphertext — safe to commit.

---

## Recovery paths

- **The repo IS the system**: clone `daedalus` (the repo), restore a decryption
  identity (old host SSH key, or santiago's age key from the password
  manager), `nixos-rebuild switch --flake /etc/nixos#s2-server`. Full
  runbook in `docs/recovery.md`. Secrets included — only machine-generated
  `secrets/` state and app data need the backups below.
- **NixOS generations** — systemd-boot menu keeps the last 10
  (`boot.loader.systemd-boot.configurationLimit = 10`). Reboot, pick.
- **ZFS snapshots** — every enrolled dataset. Restore via
  `<mount>/.zfs/snapshot/<snap>/` for selective `cp`-back, or `zfs
  rollback` if you want the dataset entirely reverted (destructive —
  discards everything newer).
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
