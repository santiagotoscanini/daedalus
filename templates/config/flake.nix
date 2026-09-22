{
  description = "A NixOS host run by daedalus";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    # Two engine modules pick a package from unstable; the engine never reads
    # its own copy, so this host's is the one that counts.
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # The engine. Pinned by rev in flake.lock; nothing moves it but
    # `nix flake update daedalus` — the weekly upgrade names the inputs it
    # touches and this is not one of them. `follows` on all four so importing
    # the engine adds nothing to this lock.
    daedalus = {
      url = "github:santiagotoscanini/daedalus";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.nixpkgs-unstable.follows = "nixpkgs-unstable";
      inputs.sops-nix.follows = "sops-nix";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
    # The engine's own formatter, followed only so the lock has one copy.
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
      daedalus,
      ...
    }:
    {
      # `box` is `identity.hostname` in site/site.json; rename both together.
      nixosConfigurations.box = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = {
          inherit nixpkgs-unstable;
          # The engine's `nix/` as a path, for a stack of this host's own that
          # imports one of its libraries (`import (enginePath + "/platform/lib/…")`).
          enginePath = "${daedalus}/nix";
        };
        modules = [
          sops-nix.nixosModules.sops
          daedalus.nixosModules.default
          ./configuration.nix
          # The generation records the commit it came from.
          { system.configurationRevision = self.rev or self.dirtyRev or "dirty"; }
        ];
      };
    };
}
