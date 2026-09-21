# `nix/` — the engine, as NixOS modules

This tree is the operating-system half of daedalus. The app in `app/` is
the control plane you look at; this is what it stands on and what it
drives.

| Path | What it is |
|---|---|
| `platform/` | The base every stack rides on, with no enable switches: the rootless-podman runtime and its helpers (`mkRootlessContainer`, `mkDotenvSecret`, `mkSecretRender`, `mkLocalImage`), the publish layer (`fleet.webApps` → reverse-proxy routes, LAN DNS, tunnel routes, health probes), the site constants read from the host's `site/` directory, sops wiring, ZFS and replication mechanisms, mail, git identity, dead-man pings, the weekly lock upgrade, and the export domains the app reads its facts from. |
| `platform/lib/` | Plain libraries imported **by path**, never as modules: `gluetun-lib.nix` (`mkGluetunInstance`), `fleet-lib.nix`, `registry-lib.nix`, `operator-secrets-lib.nix`. |
| `stacks/daedalus/` | The control plane's own module behind `fleet.modules.daedalus.enable`: `daedalus.nix`, the image builder (`builder.nix`, `build-agent.nix`, `railpack.nix`), `self.json`, the privileged host agents (`host/*.sh` — apply, deploy, build, image update, site write, snapshots) and the runtime image context (`assets/`). |

The root `flake.nix` exports:

- `nixosModules.platform`, `nixosModules.daedalus`, and
  `nixosModules.default` (both);
- `lib.path` — this directory as a path, for a host that keeps stacks of
  its own and needs the libraries.

It takes **no inputs**, on purpose. The engine is modules and libraries;
the host chooses the nixpkgs they are evaluated against, imports sops-nix
beside them, and hands in `nixpkgs-unstable` where a module asks for it.
An engine that pinned its own nixpkgs would be a second opinion about the
system it is a guest in.

The design rule throughout: **the engine declares, the host defines.**
Nothing in this tree names a user, a domain, an address or a pool. Every
such fact is an option without a default, so a host that forgets one fails
evaluation with the option's name.

## Importing it

Your configuration is a flake of your own. The engine is one input.

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Pin it. The lock's rev is which engine your box runs; move it with
    # `nix flake update daedalus`, never on a timer.
    daedalus.url = "github:santiagotoscanini/daedalus";
  };

  outputs =
    { self, nixpkgs, nixpkgs-unstable, sops-nix, daedalus, ... }:
    {
      nixosConfigurations.box = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = {
          # Two engine modules cherry-pick packages from unstable.
          inherit nixpkgs-unstable;
          # Where the engine's libraries are, for stacks of your own:
          #   import (enginePath + "/platform/lib/gluetun-lib.nix") { … }
          # A specialArg because it is used at import time.
          enginePath = "${daedalus}/nix";
        };
        modules = [
          ./configuration.nix
          sops-nix.nixosModules.sops
          daedalus.nixosModules.default
          { system.configurationRevision = self.rev or self.dirtyRev or null; }
        ];
      };
    };
}
```

```nix
# configuration.nix
{ config, ... }:
{
  imports = [ ./hardware-configuration.nix ];

  networking.hostName = "box";
  networking.hostId = "8425e349"; # the platform enables ZFS; ZFS wants a stable hostId

  # ── who and where ────────────────────────────────────────────────────
  fleet.operator = {
    user = "alice";
    uid = 1000;
    email = "alice@example.org";       # the OIDC e-mail claim apps match their admin on
    gitName = "Alice Example";         # author of the commits the box makes
    gitEmail = "alice@example.org";
  };
  fleet.config.repo = "/etc/nixos";    # where THIS checkout lives (run-time path)
  fleet.github.owner = "alice";

  # ── the site directory: what this box IS, as data ────────────────────
  # ./site/site.json, ./site/apps.json, ./site/vault/*.sops — the one
  # directory the control plane writes. `source` is how nix reads it.
  fleet.site.source = ./site;

  # ── storage ──────────────────────────────────────────────────────────
  # Named bulk-data roots outside the state tree; `{ }` if you have none.
  fleet.data = {
    photos = "/tank/photos";
  };
  # Optional: the dataset table zfs-converge asserts, and what mirrors where.
  # fleet.zfs.datasets."tank/photos" = { mount = "/tank/photos"; properties.recordsize = "1M"; };
  # fleet.backup.replications."zroot/state" = { target = "tank/backup/state"; slug = "backup-state"; };

  # ── credentials the engine's modules read: YOUR ciphertext, handed in ─
  fleet.mail.smtpHost = "smtp.example.org";
  fleet.mail.passwordSopsFile = ./sops/smtp-password.sops;        # binary
  fleet.git.sshKeySopsFile = ./sops/git-ssh-key.sops;             # binary
  fleet.daedalus.serviceKeysSopsFile = ./sops/service-keys.sops;  # dotenv
  # Optional:
  # fleet.hcPing.keySopsFile = ./sops/ping-key.sops;
  # fleet.claude.mcpSopsFile = ./.claude/mcp.json.sops;

  # The weekly upgrade moves only what you name — leave the engine out.
  fleet.autoupgrade.inputs = [ "nixpkgs" "nixpkgs-unstable" "sops-nix" ];

  users.users.${config.fleet.operator.user} = {
    inherit (config.fleet.operator) uid;
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    linger = true; # rootless podman needs the runtime dir at boot
  };

  system.stateVersion = "25.11";
}
```

### What the host must define

Options declared here without a default. Forgetting one is an evaluation
error naming it.

| Option | What it is |
|---|---|
| `fleet.operator.user`, `.uid` | The one non-root admin: owns the rootless containers, the state tree and the checkout. Container uid 0 maps to it. |
| `fleet.operator.email` | The e-mail your identity provider asserts for that person. |
| `fleet.operator.gitName`, `.gitEmail` | Author of commits the box makes (weekly lock bump, an Apply). |
| `fleet.config.repo` | Where your configuration checkout lives on disk. |
| `fleet.github.owner` | The account your app repositories live under. |
| `fleet.site.source` | `./site`. Defaults to null, and null fails evaluation on purpose. |
| `fleet.data` | Name → path of each bulk-data root. `{ }` is a valid answer. |
| `fleet.mail.smtpHost`, `fleet.mail.passwordSopsFile` | The SMTP relay and its encrypted password. |
| `fleet.git.sshKeySopsFile` | Encrypted SSH key the box pushes to its forge with. |
| `fleet.daedalus.serviceKeysSopsFile` | Encrypted dotenv of read-only API keys for the dashboard's panels. |
| `fleet.gluetun.image`, `.exporterImage` | Only if you build a VPN tunnel with `mkGluetunInstance`: the digest-pinned images. Pins live in YOUR repo — see below. |

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

plus two files beside it: `site/apps.json` (the app registry) and
`site/vault/cloudflare-api-token.sops` (the one API token; the engine
renders it for every consumer).

### Moving the engine

```
nix flake update daedalus      # re-pin to the newest commit
git add flake.lock
sudo nixos-rebuild test        # then: switch, commit, push
```

To try an engine checkout you are editing, without committing it:

```
sudo nixos-rebuild build --override-input daedalus path:/path/to/your/clone
```

`build`, never `switch`: an activated override is a generation no commit
can reproduce. A flake sees only git-**tracked** files — in your
configuration and in the engine alike — except through `path:`, which
copies the directory as it stands.

## What is NOT done yet

Read this before believing the example above.

- **`nixosModules.default` does not evaluate on its own today.** The
  control plane's module reads registries that are still declared by
  stacks outside this repo — `fleet.apps`, `fleet.litellmKeys`,
  `fleet.logStacks`, and the reverse proxy, identity provider, shared
  Postgres and container registry those stacks run. They live in the
  operator's private configuration and migrate here **one by one**, into
  `nix/modules/<id>`, each behind `fleet.modules.<id>.enable`. Until
  enough of them have, the example is the *shape* of a host, not a
  working one. The one box that runs this imports the engine's modules
  individually through `enginePath`, interleaved with its own stacks (see
  PLAN.md Phase 11 for why the order matters).
- **ZFS is assumed.** `platform/zfs.nix` enables ZFS support
  unconditionally; there is no switch for a box without it.
- **No formatter check.** No treefmt/`nix fmt` is wired for this tree, and
  a host's own `nix fmt` does not reach a flake input. `nixfmt` by hand.
- **No `nix flake check` in CI.** Nothing evaluates these modules on a
  push; a fixture site and the schema checks are planned.
- **`fleet.imagePins`** — an override map with engine defaults — does not
  exist. Until it does, **no oci-container digest pin lives in this
  tree**: the control plane's updater rewrites a pin in place in the
  host's repository and cannot write into a flake input. A module that
  needs a pinned image takes it as an option the host defines. (Two pins
  here are not oci-containers and are bumped by hand: the build agent's
  node image and the Railpack frontend.)
- **No `developer.engineOverride`** — the control plane's own Apply
  cannot yet be pointed at an engine checkout; only a hand-run
  `--override-input` can.
- **No "Update daedalus" button** — moving the engine is the three
  commands above.
- **No `templates.config`, no `init`.** Writing the host flake is by hand.
- One constant still assumes a single operator: `fleet.github.expectedOwnerId`
  in `platform/site.nix` is a read-only literal and has to become a
  host-defined value before a second box can register a GitHub App.

For editing this tree: `.claude/rules/nix-engine.md`.
