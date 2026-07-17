# s2-server — flake entry point.
#
# The repo is the complete system definition: `flake.lock` pins every
# input to an exact commit, so any checkout rebuilds this exact system.
#   - Build:   sudo nixos-rebuild test|switch   (auto-detects this file)
#   - Upgrade: nix flake update && sudo nixos-rebuild test   (then switch)
#   - Format:  nix fmt        (treefmt: nixfmt-rfc-style + statix + deadnix)
#   - Checks: nix flake check (treefmt formatting/lint gate + eval)
#   - Inputs:
#       nixpkgs           NixOS 25.11 (system packages + modules)
#       nixpkgs-unstable  newer packages cherry-picked via overlay
#                         (currently: claude-code)
#       sops-nix          age-encrypted secrets, decrypted to /run/secrets
#                         at activation (see platform/sops.nix)
#       treefmt-nix       dev-only: the `nix fmt` formatter + flake check.
#                         Not referenced by nixosConfigurations, so it never
#                         affects the built system (drv is identical with or
#                         without it).
{
  description = "s2-server — NixOS home server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      sops-nix,
      treefmt-nix,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # treefmt config: nixfmt-rfc-style formats, statix + deadnix lint
      # (both run in fix/edit mode under `nix fmt`, check mode under
      # `nix flake check`).
      treefmtEval = treefmt-nix.lib.evalModule pkgs {
        projectRootFile = "flake.nix";
        programs.nixfmt.enable = true;
        programs.statix.enable = true;
        programs.deadnix = {
          enable = true;
          # Keep the idiomatic `{ config, lib, pkgs, ... }` module args and
          # overlay `final:`/`prev:` args even when unused — flag only real
          # dead code (unused let bindings, unreachable exprs).
          no-lambda-pattern-names = true;
          no-lambda-arg = true;
        };
      };
    in
    {
      nixosConfigurations.s2-server = nixpkgs.lib.nixosSystem {
        inherit system;
        # Hand the unstable input to modules that cherry-pick from it
        # (configuration.nix's claude-code overlay).
        specialArgs = { inherit nixpkgs nixpkgs-unstable; };
        modules = [
          ./configuration.nix
          sops-nix.nixosModules.sops
        ];
      };

      # `nix fmt`
      formatter.${system} = treefmtEval.config.build.wrapper;

      # `nix flake check` fails if anything is unformatted / lint-dirty.
      checks.${system}.formatting = treefmtEval.config.build.check self;
    };
}
