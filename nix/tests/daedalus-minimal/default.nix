# The example host with every catalog module switched OFF except the spine the
# control plane cannot run without (asserted in stacks/daedalus/daedalus.nix), for `checks.daedalus-minimal`. The example
# host turns the whole spine on, so a reference from `stacks/daedalus` (or the
# platform) to a module it does not need — an option only that module
# declares, a container only it defines — evaluates there and fails first on a
# host that left the module off. Here it fails in CI.
#
# What stays on, and why:
#   apps      turns the control plane's own registry entry into its container
#   registry  the image every app runs is pulled from it
#   traefik   publishes the control plane's hostname
#   pocket-id gates it (forward-auth)
#   app-db    holds its database
#   gatus     not the control plane's: the example site's `modules.web` names
#             it, and a site entry for a hostname nobody publishes is refused
{
  nixpkgs,
  nixpkgs-unstable,
  sops-nix,
  engine,
  system ? "x86_64-linux",
}:
(import ../example-host {
  inherit
    nixpkgs
    nixpkgs-unstable
    sops-nix
    engine
    system
    ;
}).extendModules
  {
    modules = [
      (
        { lib, options, ... }:
        let
          keep = [
            "daedalus"
            "apps"
            "registry"
            "traefik"
            "pocket-id"
            "app-db"
            "gatus"
          ];
        in
        {
          fleet.modules = lib.genAttrs (lib.subtractLists keep (lib.attrNames options.fleet.modules)) (_: {
            enable = lib.mkForce false;
          });

          # An app not yet past `declared` that signs in with its own OIDC: it
          # has no container, so nothing may be written under one (its SSO
          # client lists no consumer until it runs).
          fleet.apps.native-declared = {
            stage = "declared";
            auth.mode = "native";
          };
        }
      )
    ];
  }
