# s2-server — flake entry point.
#
# The repo is the complete system definition: `flake.lock` pins every
# input to an exact commit, so any checkout rebuilds this exact system.
#   - Build:   sudo nixos-rebuild test|switch   (auto-detects this file)
#   - Upgrade: nix flake update && sudo nixos-rebuild test   (then switch)
#   - Inputs:
#       nixpkgs           NixOS 25.11 (system packages + modules)
#       nixpkgs-unstable  newer packages cherry-picked via overlay
#                         (currently: claude-code)
#       sops-nix          age-encrypted secrets, decrypted to /run/secrets
#                         at activation (see platform/sops.nix)
{
  description = "s2-server — NixOS home server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, nixpkgs-unstable, sops-nix, ... }: {
    nixosConfigurations.s2-server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      # Hand the unstable input to modules that cherry-pick from it
      # (configuration.nix's claude-code overlay).
      specialArgs = { inherit nixpkgs nixpkgs-unstable; };
      modules = [
        ./configuration.nix
        sops-nix.nixosModules.sops
      ];
    };
  };
}
