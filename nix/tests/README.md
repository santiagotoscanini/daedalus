# Checks

What `nix flake check` proves (locally and in CI on every push). Everything is
evaluated, nothing is built.

| Check | Proves | Reads |
|---|---|---|
| `checks.example-host` | The example host evaluates as a whole NixOS system — its `site.json` and non-empty `nodes.json` read by `platform/site.nix` — and every `apps.json` entry, at a version `registry-lib.nix` accepts, maps through `mkApp` | `example-host/` (`example-host/default.nix`) |
| `checks.all-modules` | The same host with every catalog module on still evaluates | `example-host/` + `all-modules/leaves.nix` |

`checks.formatting` (nixfmt, statix, deadnix) is defined in `flake.nix`.
