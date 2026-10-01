# Checks

What `nix flake check` proves (locally and in CI on every push). The hosts are
evaluated, never built; `host-scripts` runs the root verbs' scripts in the sandbox
and `agent-scripts` builds them, which is when shellcheck runs.

| Check | Proves | Reads |
|---|---|---|
| `checks.example-host` | The example host evaluates as a whole NixOS system — its `site.json` and non-empty `nodes.json` read by `platform/site.nix` — and every `apps.json` entry, at a version `registry-lib.nix` accepts, maps through `mkApp` | `example-host/` (`example-host/default.nix`) |
| `checks.all-modules` | The same host with every catalog module on still evaluates | `example-host/` + `all-modules/leaves.nix` |
| `checks.daedalus-minimal` | The control plane and the platform evaluate with the catalog off but for what the control plane needs (`apps`, `registry`, `traefik`; `gatus` for the example site), so neither reaches into a module a host may leave off | `example-host/` + `daedalus-minimal/` |
| `checks.host-scripts` | The root verbs' scripts, run in the sandbox against temp git repos with nixos-rebuild, curl and gpg stubbed: a refused Claude Code pin push leaves a dirty engine clone byte-for-byte; `site_commit` commits only the files it names; an Apply whose build fails restores its files and never switches; `as_operator` under a unit that is not root runs the command itself, never setpriv | `nix/stacks/daedalus/host/` (`host-scripts/test.sh`) |
| `checks.agent-scripts` | Every host agent script mkAgent assembles from `nix/stacks/daedalus/host/` (and each app's deploy script) passes shellcheck: the scripts are BUILT, which is when `writeShellApplication` runs it. Only the scripts; their runtime inputs come from the binary cache | `example-host/` with the builder on (`agent-scripts/`) |

`checks.formatting` (nixfmt, statix, deadnix) is defined in `flake.nix`.
