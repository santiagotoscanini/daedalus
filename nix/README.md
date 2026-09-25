# `nix/` — the engine, as NixOS modules

This tree is the operating-system half of daedalus. The app in `app/` is
the control plane you look at; this is what it stands on and what it
drives.

| Path | What it is |
|---|---|
| `platform/` | The base every stack rides on, with no enable switches: the rootless-podman runtime and its helpers (`mkRootlessContainer`, `mkDotenvSecret`, `mkSecretRender`, `mkLocalImage`, `pinnedImage`), the publish layer (`fleet.webApps` → reverse-proxy routes, LAN DNS, tunnel routes, health probes; the observability registries), the single-sign-on interface (`identity.nix`: `fleet.sso.*`, `fleet.ssoClients`), the apps registry (`apps-options.nix`: `fleet.apps`), the site constants read from the host's `site/` directory, sops wiring, ZFS and replication mechanisms, mail, git identity, dead-man pings, the nodes (`nodes.nix`: `fleet.nodes`, `fleet.lanDomain`), the weekly lock upgrade, and the export domains the app reads its facts from. |
| `platform/lib/` | Plain libraries imported **by path**, never as modules: `gluetun-lib.nix` (`mkGluetunInstance`), `fleet-lib.nix`, `registry-lib.nix`, `operator-secrets-lib.nix`. |
| `stacks/daedalus/` | The control plane's own module behind `fleet.modules.daedalus.enable`: `daedalus.nix`, the image builder (`builder.nix`, `build-agent.nix`, `railpack.nix`), the engine's own updater (`engine-update.nix`), `self.json`, and the privileged host agents (`host/*.sh` — apply, deploy, build, image update, engine update, site write, snapshots). |
| `modules/<id>/` | The catalog: stacks that have migrated here, each behind `fleet.modules.<id>.enable`, **off by default**. A module brings the mechanism; the host brings the image pin (`fleet.images.<container>`), the secrets (`fleet.modules.<id>.*SopsFile`) and the policy (who may log in, under what name, reachable off-LAN or not). |
| `tests/` | `minimal-host/` evaluates the config template (below) as a whole system; `full-catalog/` the same host with every leaf switched on; `fixtures.nix` every schema fixture under `../fixtures/` through `platform/site.nix` and `registry-lib.nix`. All run in `nix flake check`; nothing is built. |

The root `flake.nix` exports:

- `nixosModules.platform`, `nixosModules.daedalus`, `nixosModules.catalog`,
  and `nixosModules.default` (all three);
- `templates.config` — a host to start from (`nix flake init -t
  github:santiagotoscanini/daedalus#config`), which is also the host the
  checks evaluate;
- `lib.path` — this directory as a path, for a host that keeps stacks of
  its own and needs the libraries.

Its **modules take nothing from the flake's inputs**, on purpose. The
engine is modules and libraries; the host chooses the nixpkgs they are
evaluated against, imports sops-nix beside them, and hands in
`nixpkgs-unstable` where a module asks for it. An engine that evaluated
against its own nixpkgs would be a second opinion about the system it is a
guest in. The inputs `flake.nix` does declare (`nixpkgs`, `treefmt-nix`,
and — for the checks alone — `sops-nix` and `nixpkgs-unstable`) exist for
this repo's own `nix fmt` and `nix flake check`; a host makes all four
follow its own.

The design rule throughout: **the engine declares, the host defines.**
Nothing in this tree names a user, a domain, an address or a pool. Every
such fact is an option without a default, so a host that forgets one fails
evaluation with the option's name.

## The catalog

| Module | What it is | What the host brings beside the switch |
|---|---|---|
| `apps` | The apps platform: every `fleet.apps` entry becomes a container, a route, a database, a deploy loop, scheduled tasks — the control plane's own entry included. | `site/apps.json`; per-app operator secrets in `site/vault/apps/`. The switch is declared in `platform/apps-options.nix`. |
| `app-db` | The shared Postgres cluster (with pgvector), one role and database per tenant, its exporter, a read-only role for the operator's MCP client. | `fleet.images.app-db-exporter` |
| `cloudflared` | The Cloudflare tunnel — public ingress — and the reconciler that keeps the zone's CNAMEs matching the routes. | `credentialsSopsFile`, `fleet.images.cloudflared` |
| `factorio` | The headless Factorio server behind OpenFactorioServerManager; the game port is forwarded by the router. | `version` (required), `envSopsFile`, `fleet.images.factorio` |
| `gatus` | Outside-in uptime and TLS-expiry probing of every published hostname. | `allowedSubjects` (required), `envSopsFile` (optional), `fleet.images.gatus` |
| `healthchecks` | Dead-man's-switch monitoring of the scheduled jobs. | `envSopsFile`, `fleet.images.healthchecks` |
| `logging` | Loki and the alloy shipper. Other stacks contribute `fleet.logStacks`, `fleet.logDrops`, `fleet.logFiles`. | `fleet.images.{loki,alloy}` |
| `monitoring` | Prometheus, Grafana, node-exporter, the per-container liveness sweep, the generic dashboards. | `envSopsFile`, `fleet.images.{prometheus,grafana,node-exporter}`; its own dashboards through `fleet.grafanaDashboardsByFolder` |
| `pihole` | LAN DNS and DHCP (native), every published hostname's local record. | `dhcpHostsSopsFile` (optional), `localDomain` |
| `pocket-id` | The identity provider and the convergence of every declared client. | `envSopsFile`, `exposeRemotely`, `fleet.images.pocket-id`; `fleet.sso.logoDir` for the host's own stacks' logos |
| `registry` | zot, the box's own OCI registry: builds push, deploys pull. | `envSopsFile`, `retireRepositories`, `fleet.images.zot` |
| `grocy` | Household ERP: groceries, chores, recipes. | `authGroups`, `exposeRemotely`, `fleet.images.grocy` |
| `intel-gpu-exporter` | Prometheus exporter for an Intel iGPU. | `fleet.images.intel-gpu-exporter` |
| `metube` | yt-dlp web UI. | `downloadsDir` (required), `authGroups`, `fleet.images.metube` |
| `myspeed` | Internet speed tracker. | `authGroups`, `fleet.images.myspeed` |
| `stirling-pdf` | A PDF toolbox — the first leaf, and the template for one. | `authGroups`, `fleet.images.stirling-pdf` |
| `traefik` | The reverse proxy: every published hostname, the forward-auth middlewares, the wildcard certificate. | `envSopsFile`, `fleet.images.traefik` |
| `verdaccio` | A private npm mirror; the box's builds and the control plane's dev container install through it. | nothing — its image is built on the box |
| `wg-easy` | A WireGuard server and its admin UI; the tunnel port is forwarded by the router. | `envSopsFile`, `fleet.images.wg-easy` |

The spine — everything above but the leaves (grocy, intel-gpu-exporter,
metube, myspeed, stirling-pdf, verdaccio, wg-easy) — is switched on in
`templates/config`, so a host made
from the template is a box with a control plane to log in to.

## Importing it

`nix flake init -t github:santiagotoscanini/daedalus#config` writes the
host below into an empty directory; replace every documentation value in
it (each file says which), replace `hardware-configuration.nix` with
`nixos-generate-config`'s, create the secrets (`host/sops/README.md`),
resolve the image pins, and switch. What it is, in short:

```nix
# flake.nix — the engine is one input, pinned by rev, followed on all four
# of its own inputs so importing it adds nothing to your lock
daedalus = {
  url = "github:santiagotoscanini/daedalus";
  inputs.nixpkgs.follows = "nixpkgs";
  inputs.nixpkgs-unstable.follows = "nixpkgs-unstable";
  inputs.sops-nix.follows = "sops-nix";
  inputs.treefmt-nix.follows = "treefmt-nix";
};
# …
nixosConfigurations.box = nixpkgs.lib.nixosSystem {
  specialArgs = {
    inherit nixpkgs-unstable;          # two engine modules pick a package from it
    enginePath = "${daedalus}/nix";    # for stacks of your own that import a library
  };
  modules = [ sops-nix.nixosModules.sops daedalus.nixosModules.default ./configuration.nix ];
};
```

```
configuration.nix           hardware, the operator's account, fleet.site.source = ./site
host/identity.nix           fleet.operator.*, fleet.config.repo, fleet.github.*, fleet.mail.smtpHost
host/modules.nix            fleet.modules.<id>.enable + each module's policy
host/images.nix             fleet.images.<container>, one file, full literals
host/secrets.nix            the *SopsFile options the platform and the control plane read
host/storage.nix            fleet.data (+ fleet.zfs.datasets, fleet.backup.replications)
site/                       site.json, apps.json, vault/ — what the control plane writes
```

### What the host must define

Options declared here without a default. Forgetting one is an evaluation
error naming it. The template defines every one.

| Option | What it is |
|---|---|
| `fleet.operator.user`, `.uid` | The one non-root admin: owns the rootless containers, the state tree and the checkout. Container uid 0 maps to it. |
| `fleet.operator.email` | The e-mail your identity provider asserts for that person. |
| `fleet.operator.gitName`, `.gitEmail` | Author of commits the box makes (weekly lock bump, an Apply). |
| `fleet.config.repo` | Where your configuration checkout lives on disk. |
| `fleet.github.owner` | The account your app repositories live under. |
| `fleet.github.expectedOwnerId` | That account's numeric id — the one copy the control plane cannot rewrite. |
| `fleet.site.source` | `./site`. Defaults to null, and null fails evaluation on purpose. |
| `fleet.data` | Name → path of each bulk-data root. `{ }` is a valid answer. |
| `fleet.mail.smtpHost`, `fleet.mail.passwordSopsFile` | The SMTP relay and its encrypted password. |
| `fleet.git.sshKeySopsFile` | Encrypted SSH key the box pushes to its forge with. |
| `fleet.daedalus.serviceKeysSopsFile` | Encrypted dotenv of read-only API keys for the dashboard's panels. |
| `fleet.gluetun.image`, `.exporterImage` | Only if you build a VPN tunnel with `mkGluetunInstance`: the digest-pinned images. |
| `fleet.images.<container>` | For every catalog module you switch on: the digest-pinned image of each of its containers. Forgetting one fails evaluation naming the key and the upstream repository. |
| `fleet.modules.<id>.*SopsFile`, `fleet.modules.gatus.allowedSubjects` | A module's own required inputs, read only while it is on (the catalog table). |

And from `site/site.json`, which `platform/site.nix` turns into options
(edit these from the control plane's Settings once it runs):

| `site.json` key | Becomes |
|---|---|
| `identity.baseDomain` | `fleet.baseDomain` — every published host is exactly one label under it |
| `identity.timezone` | `time.timeZone` |
| `identity.hostname`, `identity.owner`, `identity.operator.user` | asserted equal to `networking.hostName`, `fleet.github.owner`, `fleet.operator.user` |
| `network.lanIp`, `.interface`, `.gateway`, `.wanHost`, `.dnsUpstreams` | `fleet.lanIp`, `fleet.lanInterface`, `fleet.gateway`, `fleet.wanHost`, `fleet.dnsUpstreams` |
| `network.dhcp.{active,router,start,end,leaseTime}` | `fleet.dhcp.*` |
| `mail.sender`, `mail.alertTo` | `fleet.mail.sender`, `fleet.mail.alertTo` |
| `cloudflare.{accountId,tunnelId,zoneId}` | `fleet.cloudflare.*` |
| `developer.engineOverride` | read by the host agents at run time, never by nix (below) |
| `modules.enabled.<id>` | `fleet.modules.<id>.enable`, at a priority above the host's own files — only the ids the operator switched from a page; a structural module (`fleet.structuralModules`) named off fails evaluation |
| `modules.web.<webApp>.{label,public}` | `fleet.webApps.<webApp>.hostname` (as `<label>.<baseDomain>`) and `.exposeRemotely`, at the same priority — only the hostnames the operator moved from a service's cog; a webApp this host does not publish fails evaluation |
| `modules.players.<id>` | `fleet.site.players.<id>` — a game server's roster as its page wrote it: `[{ name, uuid, op }]`, both resolved from the vendor first; a stack that reads it takes it as its whole list. An id this host does not import fails evaluation |

plus files beside it: `site/apps.json` (the app registry),
`site/nodes.json` (the approved nodes — id, name, OS and what each offers,
read into `fleet.nodes`; optional, a box without machines has none) and
`site/vault/cloudflare-api-token.sops` (the one API token; the engine
renders it for every consumer).

Optional, null or empty by default: `fleet.hcPing.keySopsFile`,
`fleet.claude.mcpSopsFile`, `fleet.zfs.datasets`, `fleet.zfs.arcMaxBytes`,
`fleet.backup.replications`, `fleet.autoupgrade.inputs`,
`fleet.daedalus.routerProduct`, `fleet.builder.npmMirrorHost`,
`fleet.daedalus.dev`, `fleet.daedalus.image`.

### Moving the engine

From the control plane: **System › Updates › Engine** fast-forwards the
engine clone, re-resolves the input, builds, commits the lock, switches,
verifies the control plane answers and reverts if it does not, then pushes
(`stacks/daedalus/host/engine-update.sh`). By hand, the same thing is:

```
nix flake update daedalus      # re-pin to the newest commit
git add flake.lock
sudo nixos-rebuild test        # then: switch, commit, push
```

To try an engine checkout you are editing, without committing it: set
`developer.engineOverride` to the clone's path (Settings › Developer).
While it is set, an Apply builds and **tests** against that tree — never
switches — and the image and engine updates refuse; a banner says so on
every page, and a reboot comes up on the last switched generation. By
hand:

```
sudo nixos-rebuild build --override-input daedalus path:/path/to/your/clone
```

`build` or `test`, never `switch`: an activated override is a generation no
commit can reproduce. A flake sees only git-**tracked** files — in your
configuration and in the engine alike — except through `path:`, which
copies the directory as it stands.

### The control plane's image

One Dockerfile at the repository root builds one image; a host runs its
bundle (`fleet.daedalus.image`, by default the engine's published image at
the version this rev's `app/package.json` declares — pinning the engine
pins the control plane). The host that develops the engine sets
`fleet.daedalus.dev = true`: the image's `runtime` stage is built on the box
and the engine checkout's `app/` is mounted into it, so saving a file is the
deploy. `CONTRIBUTING.md` has the image's own story.

## What is NOT done yet

- **The rest of the reference host's stacks.** The spine — everything a
  box needs to log in to its control plane — is in the catalog, and seven
  leaves beside it. About
  twenty-three more stacks (media, home automation, the AI cluster, VPN
  tenants, small tools) are still in the reference operator's private
  configuration; each moves as `.claude/rules/nix-engine.md` §7 describes,
  and none is needed for a box to run.
- **ZFS is assumed.** `platform/zfs.nix` enables ZFS support
  unconditionally; there is no switch for a box without it.
- **The generic dashboards know no pools.** The storage and overview
  dashboards name a box's pools, so they are the host's (contributed through
  `fleet.grafanaDashboardsByFolder`); a pool-agnostic version, templated
  over `fleet.zfs.datasets`, would let them return to the engine.
- **Engine-shipped default pins were considered and declined.** A pin in
  this tree could never be moved by the control plane's updater, and two
  sources of truth for one image would drift. The host keeps every pin; a
  future `init` resolves the first set.
- **The reference host still names the engine's modules one by one** in
  its import list, interleaved with its own stacks, because list-typed
  options merge in import order and the identical-closure gate forbade a
  reorder. It adopts `nixosModules.default` in a deliberate rebuild once
  nothing of its own is left to interleave.
- **No `init`.** The template is a start; resolving pins, creating secrets
  and the first switch are by hand.

For editing this tree: `.claude/rules/nix-engine.md`.
