# Checks

What `nix flake check` proves (locally and in CI on every push). Everything is
evaluated, nothing is built.

| Check | Proves | Reads |
|---|---|---|
| `checks.example-host` | The example host evaluates as a whole NixOS system, and its `site.json` is the current sample | `example-host/` (`example-host/default.nix`) |
| `checks.all-modules` | The same host with every catalog module on still evaluates | `example-host/` + `all-modules/leaves.nix` |
| `checks.site-formats` | Every sample version is read by `platform/site.nix` and `registry-lib.nix`; the copies agree | `site-formats/` (`site-formats.nix`) |

`checks.formatting` (nixfmt, statix, deadnix) is defined in `flake.nix`.
