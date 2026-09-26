# The example host with EVERY catalog module switched on — the leaves the
# example host leaves off (a stranger's first box is the spine), each with a
# placeholder pin and whatever else its switch requires. Evaluated by
# `checks.all-modules`, never built: proves every module in the catalog
# evaluates, on one host, beside all the others — a registry two modules
# write the same key of, an assertion one trips on another's default, a
# container two of them both declare, all fail here rather than on a box.
#
# Adding a module to the catalog means adding it to leaves.nix with its
# placeholder inputs (nix-engine.md §7); the example host stays the spine.
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
    inherit nixpkgs-unstable;
    enginePath = "${engine}/nix";
  };
  modules = [
    sops-nix.nixosModules.sops
    engine.nixosModules.default
    ../../../example-host/configuration.nix
    ./leaves.nix
  ];
}
