# The example host with the builder switched on, for `checks.agent-scripts`:
# the host agents' scripts (nix/stacks/daedalus/host/*.sh, build-stages/*) are
# assembled by mkAgent into writeShellApplication scripts, and shellcheck runs
# on each assembled script only when it is BUILT. The other checks evaluate
# and build nothing, so without this one a shellcheck finding first fails on a
# box's rebuild.
#
# The builder exists only while `site/vault/github-app.sops` is in the flake
# (daedalus-lib.nix `haveGithubApp`), and the example host's site has none —
# a stranger's first box has no GitHub App. ./site is that same site (its files
# are symlinks into example-host/site/, resolved inside the flake's source)
# plus a placeholder github-app.sops; the scratch dataset the builder mounts is
# declared here as a host's storage table would.
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
        { config, lib, ... }:
        {
          # A string into the flake's source rather than a path: a path would
          # be copied on its own, and the symlinks would dangle.
          fleet.site.source = lib.mkForce "${engine}/nix/tests/agent-scripts/site";
          fileSystems.${config.fleet.builder.root} = {
            device = "rpool/daedalus-builds";
            fsType = "zfs";
          };
        }
      )
    ];
  }
