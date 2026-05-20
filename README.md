# s2-server — `/etc/nixos`

Backbone of the home server. Every running service is declared here.

## Layout

```
/etc/nixos/
├── configuration.nix      # entry point — host config + imports
├── hardware-configuration.nix
├── platform/              # OS-level infrastructure (non-stack)
│   ├── common.nix         # myStack.* options + mkRootlessContainer helper
│   ├── zfs-datasets.nix   # declarative s2-pool children
│   └── ddclient/          # dynamic DNS
│       ├── ddclient.nix
│       └── secrets/password
└── stacks/                # one folder per stack
    └── <stack>/
        ├── <stack>.nix    # the module
        ├── assets/        # tracked: non-secret config (yaml/json/templates)
        └── secrets/       # gitignored: env files, keys, passwords (mode 0600)
```

## Adding a stack

```bash
sudo mkdir -p /etc/nixos/stacks/myservice/{assets,secrets}
sudo $EDITOR /etc/nixos/stacks/myservice/myservice.nix
# Drop secrets (if any) into secrets/env, mode 0600 santiago:users
# Drop non-secret config files into assets/
sudo $EDITOR /etc/nixos/configuration.nix   # add one import line
sudo nixos-rebuild switch
```

## Rules

1. **Every stack is a folder** — no loose `.nix` files, even for single-container stacks.
2. **`assets/` is tracked; `secrets/` is gitignored** — `.gitignore` matches `**/secrets/` at any depth.
3. **No stack-name prefix inside the folder** — `stacks/immich/assets/dashboard.json`, not `stacks/immich/assets/immich-dashboard.json`. Parent folder already encodes the stack.
4. **Paired ancillaries** (an exporter coupled to a primary, etc.) live next to the primary `.nix` file in the same folder.

## Conventions referenced by the modules

- `myStack.containerNetworks`, `traefikRoutes`, `dnsHosts`, `prometheusScrapes`, `grafanaDashboards`, `grafanaDashboardsByFolder`, `homepageServices` — declared in `platform/common.nix`. Each stack module contributes; the consumer modules (traefik, pihole, monitoring, homepage, supabase) merge.

## Operator notes

For deeper operator guidance — UID mapping, ZFS layout, bootstrap quirks per stack, recovery paths — see `CLAUDE.md` at the repo root (one level up; tracked separately).
