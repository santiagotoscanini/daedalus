{
  description = "daedalus — a control plane you import into your own NixOS config";

  # No inputs, on purpose. The engine is modules and libraries; the HOST picks
  # the nixpkgs they are evaluated against, imports sops-nix beside them, and
  # hands in `nixpkgs-unstable` where a module asks for it (specialArgs). An
  # engine that pinned its own nixpkgs would be a second opinion about the
  # system it is a guest in.
  outputs =
    { self }:
    let
      root = ./nix;

      platformModules = [
        "autoupgrade/autoupgrade.nix"
        "backup.nix"
        "bluetooth/bluetooth.nix"
        "claude-code/claude-code.nix"
        "claude-rc.nix"
        "claude.nix"
        "config-bundle.nix"
        "ddclient/ddclient.nix"
        "export.nix"
        "git/git.nix"
        "gpu.nix"
        "hc-ping/hc-ping.nix"
        "machine-state.nix"
        "mail/mail.nix"
        "operator.nix"
        "podman-prune.nix"
        "podman.nix"
        "publishing.nix"
        "sensors.nix"
        "site.nix"
        "smartd.nix"
        "sops.nix"
        "storage.nix"
        "zfs.nix"
      ];

      daedalusModules = [
        "build-agent.nix"
        "builder.nix"
        "daedalus.nix"
        "railpack.nix"
      ];
    in
    {
      # `nix/` as a path, for a host that still keeps stacks of its own and
      # needs the shared libraries: `import (enginePath + "/platform/lib/…")`.
      # Hand it to modules through `specialArgs.enginePath` — several stacks
      # import a library at module-import time, where `_module.args` cannot
      # reach.
      lib.path = root;

      nixosModules = {
        # The OS-level base every stack rides on: the container runtime and its
        # helpers, the publishing registries, the site constants read from the
        # host's `site/`, secrets, ZFS and backup mechanisms. No switches.
        platform = {
          imports = map (m: root + "/platform/${m}") platformModules;
        };

        # The control plane itself, behind `fleet.modules.daedalus.enable`.
        daedalus = {
          imports = map (m: root + "/stacks/daedalus/${m}") daedalusModules;
        };

        default = {
          imports = [
            self.nixosModules.platform
            self.nixosModules.daedalus
          ];
        };
      };
    };
}
