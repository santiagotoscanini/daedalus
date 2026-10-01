# Checks

What `nix flake check` proves (locally and in CI on every push). The hosts are
evaluated, never built; `host-scripts` is the one check that runs something.

| Check | Proves | Reads |
|---|---|---|
| `checks.example-host` | The example host evaluates as a whole NixOS system — its `site.json` and non-empty `nodes.json` read by `platform/site.nix` — and every `apps.json` entry, at a version `registry-lib.nix` accepts, maps through `mkApp` | `example-host/` (`example-host/default.nix`) |
| `checks.all-modules` | The same host with every catalog module on still evaluates | `example-host/` + `all-modules/leaves.nix` |
| `checks.host-scripts` | The bridge agents, run in the sandbox against temp git repos with nixos-rebuild, curl and gpg stubbed: a refused Claude Code pin push leaves a dirty engine clone byte-for-byte; `site_commit` commits only the files it names; an Apply whose build fails restores its files and never switches | `nix/stacks/daedalus/host/` (`host-scripts/test.sh`) |

`checks.formatting` (nixfmt, statix, deadnix) is defined in `flake.nix`.
