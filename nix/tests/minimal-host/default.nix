# The smallest plausible host a stranger would write: the engine's
# `nixosModules.default`, sops-nix beside it, and DEFINITIONS for exactly what
# the engine declares without a default (nix/README.md, "What the host must
# define"). Nothing else — no stack of the host's own, no option stubbed.
#
# It is EVALUATED, never built: `checks.<system>.minimal-host` in the root
# flake forces `config.system.build.toplevel.drvPath`, which instantiates every
# derivation of the system and therefore proves every option read resolves and
# every assertion holds. The `*.sops` files under here are placeholders, not
# ciphertext — sops-nix takes a PATH at evaluation and validates the content
# only when its manifest is built.
#
# When this fails after an engine change, the engine grew a dependency on
# something a host has to bring. Either declare it here in the engine (an
# option, ungated, with an honest default or none) or add it to the must-define
# table AND to this file — never stub an option in this file to get green.
{
  nixpkgs,
  nixpkgs-unstable,
  sops-nix,
  engine,
  system ? "x86_64-linux",
}:
nixpkgs.lib.nixosSystem {
  inherit system;
  specialArgs = {
    # Two engine modules cherry-pick a package from unstable.
    inherit nixpkgs-unstable;
    enginePath = "${engine}/nix";
  };
  modules = [
    sops-nix.nixosModules.sops
    engine.nixosModules.default
    ./host.nix
  ];
}
