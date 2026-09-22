# The smallest plausible host a stranger would write — which is exactly what
# `nix flake init -t daedalus#config` gives them: templates/config, evaluated
# here as written. The engine's `nixosModules.default`, sops-nix beside it, and
# the template's own configuration.nix with DEFINITIONS for exactly what the
# engine declares without a default (nix/README.md, "What the host must
# define"). No stack of the host's own, no option stubbed.
#
# It is EVALUATED, never built: `checks.<system>.minimal-host` in the root
# flake forces `config.system.build.toplevel.drvPath`, which instantiates every
# derivation of the system and therefore proves every option read resolves and
# every assertion holds. The template's `*.sops` files are placeholders, not
# ciphertext — sops-nix takes a PATH at evaluation and validates the content
# only when its manifest is built.
#
# When this fails after an engine change, the engine grew a dependency on
# something a host has to bring. Either declare it in the engine (an option,
# ungated, with an honest default or none) or add it to the must-define table
# AND to the template — never stub an option to get green. The template is the
# check, so a stranger's first evaluation is the one CI ran.
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
    ../../../templates/config/configuration.nix
  ];
}
