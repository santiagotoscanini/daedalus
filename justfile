# s2-server dev tasks. Run with `just <target>` (get `just` via
# `nix run nixpkgs#just -- <target>` if it isn't on PATH).
#
# Formatting/linting is treefmt (nixfmt-rfc-style + statix + deadnix),
# wired as the flake `formatter` output — so `nix fmt` and `just fmt` do
# the same thing, and `nix flake check` gates on it in one place. No CI.

# Format + lint-fix the whole repo in place (nixfmt, statix fix, deadnix).
fmt:
    nix fmt

# Read-only lint/format check — matches what `nix flake check` enforces.
check:
    nix flake check

# Just the linters, no writes (handy before committing).
lint:
    nix run nixpkgs#statix -- check .
    nix run nixpkgs#deadnix -- --no-lambda-pattern-names --no-lambda-arg --fail .

# Build the next generation without activating (staged for next boot).
boot:
    sudo nixos-rebuild boot --flake /etc/nixos

# Build + activate now.
switch:
    sudo nixos-rebuild switch --flake /etc/nixos
