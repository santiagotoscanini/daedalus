{
  description = "daedalus — a control plane you import into your own NixOS config";

  # The MODULES take nothing from these inputs. The host picks the nixpkgs they
  # are evaluated against, imports sops-nix beside them, and hands in
  # `nixpkgs-unstable` where a module asks for it (specialArgs): an engine that
  # evaluated against its own nixpkgs would be a second opinion about the
  # system it is a guest in.
  #
  # The inputs exist for the repo's own tooling — `nix fmt` and `nix flake
  # check` — and a host should make both follow its own
  # (`inputs.daedalus.inputs.nixpkgs.follows = "nixpkgs"`), so importing the
  # engine adds nothing to its lock file.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # For the checks ONLY: each test host imports sops-nix beside the engine
    # and hands in `nixpkgs-unstable`, as any host does. No module reads
    # either from here. A host follows both too
    # (`inputs.daedalus.inputs.sops-nix.follows = "sops-nix"`, and the same for
    # `nixpkgs-unstable`).
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
      sops-nix,
      nixpkgs-unstable,
    }:
    let
      root = ./nix;

      # One system today: the formatter and its check are developer tooling,
      # and the engine's only box is x86_64. The modules are system-agnostic.
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # nixfmt, statix, deadnix — the settings the host's configuration uses
      # too, so a file lints the same in either repo.
      treefmtEval = treefmt-nix.lib.evalModule pkgs {
        projectRootFile = "flake.nix";
        programs.nixfmt.enable = true;
        programs.statix.enable = true;
        programs.deadnix = {
          enable = true;
          no-lambda-pattern-names = true;
          no-lambda-arg = true;
        };
      };

      platformModules = [
        "apps-options.nix"
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
        "identity.nix"
        "machine-state.nix"
        "mail/mail.nix"
        "nodes.nix"
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
        "claude-code-update.nix"
        "daedalus-github.nix"
        "daedalus-nodes.nix"
        "daedalus-snapshots.nix"
        "daedalus-verbs.nix"
        "daedalus.nix"
        "engine-update.nix"
        "railpack.nix"
        "version-update.nix"
      ];

      # The catalog: one stack per directory, `modules/<id>/…`, each behind
      # `fleet.modules.<id>.enable` — default OFF, so importing them all costs a
      # host nothing. Listed FILE by file like the two lists above, because a
      # multi-file stack keeps its files as separate entries: the module system
      # merges list-typed options in an order that depends on nesting, and a
      # host that names these files one by one in its own list (nix-engine.md
      # §6) must be able to keep each in the slot it always had.
      catalogModules = [
        "app-db/app-db.nix"
        "app-db/claude-ro.nix"
        "app-db/exporter.nix"
        "apps/apps.nix"
        "apps/declarations.nix"
        "cloudflared/cloudflared.nix"
        "factorio/factorio.nix"
        "gatus/gatus.nix"
        "grocy/grocy.nix"
        "healthchecks/healthchecks.nix"
        "intel-gpu-exporter/intel-gpu-exporter.nix"
        "logging/logging.nix"
        "metube/metube.nix"
        "monitoring/monitoring.nix"
        "myspeed/myspeed.nix"
        "pihole/pihole.nix"
        "pocket-id/clients.nix"
        "pocket-id/pocket-id.nix"
        "registry/registry.nix"
        "stirling-pdf/stirling-pdf.nix"
        "traefik/traefik.nix"
        "verdaccio/verdaccio.nix"
        "wg-easy/wg-easy.nix"
      ];
    in
    {
      # `nix/` as a path, for a host that still keeps stacks of its own and
      # needs the shared libraries: `import (enginePath + "/platform/lib/…")`.
      # Hand it to modules through `specialArgs.enginePath` — several stacks
      # import a library at module-import time, where `_module.args` cannot
      # reach.
      lib.path = root;

      formatter.${system} = treefmtEval.config.build.wrapper;

      checks.${system} = {
        formatting = treefmtEval.config.build.check self;

        # example-host/ — a stranger's smallest host — EVALUATED as written:
        # forcing the toplevel drvPath instantiates the whole system, so every
        # option the engine reads must be declared by the engine and every
        # assertion must hold. Nothing is built. See
        # nix/tests/example-host/default.nix.
        #
        # Its site/ is also the sample of the app↔nix file formats (the app's
        # vitest reads the same files): site.json and nodes.json are read by
        # platform/site.nix in that evaluation, and every apps.json entry is
        # mapped and forced through registry-lib.nix here, since the host
        # evaluation alone forces only the fields some module reads. Both
        # samples must stay populated, or they would prove nothing.
        example-host =
          let
            inherit (nixpkgs) lib;
            host = import ./nix/tests/example-host {
              inherit
                nixpkgs
                nixpkgs-unstable
                sops-nix
                system
                ;
              engine = self;
            };
            registryLib = import ./nix/platform/lib/registry-lib.nix { inherit lib; };
            appsDoc = builtins.fromJSON (builtins.readFile ./example-host/site/apps.json);
            apps =
              if !(lib.elem appsDoc.schemaVersion registryLib.acceptedSchemaVersions) then
                throw "example-host/site/apps.json declares schemaVersion ${toString appsDoc.schemaVersion}; registry-lib.nix accepts ${builtins.toJSON registryLib.acceptedSchemaVersions}"
              else if appsDoc.apps == { } then
                throw "example-host/site/apps.json has no apps; the sample must carry one"
              else
                lib.mapAttrs (_: registryLib.mkApp) appsDoc.apps;
          in
          assert
            host.config.fleet.nodes != [ ]
            || throw "example-host/site/nodes.json has no nodes; the sample must carry one";
          pkgs.runCommand "example-host-evaluates" { } (
            builtins.deepSeq apps (builtins.seq host.config.system.build.toplevel.drvPath "touch $out")
          );

        # The example host with every leaf of the catalog switched on as well:
        # the whole catalog evaluates on one host (nix/tests/all-modules).
        all-modules =
          let
            host = import ./nix/tests/all-modules {
              inherit
                nixpkgs
                nixpkgs-unstable
                sops-nix
                system
                ;
              engine = self;
            };
          in
          pkgs.runCommand "all-modules-evaluate" { } (
            builtins.seq host.config.system.build.toplevel.drvPath "touch $out"
          );
      };

      # `nix flake init -t github:santiagotoscanini/daedalus#config`: the
      # example host this flake's checks evaluate, as a starting point — every
      # value in it is a documentation value to replace (its files say which).
      templates.config = {
        path = ./example-host;
        description = "A NixOS host run by daedalus: the engine as a flake input, and the definitions a host brings";
      };

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

        # The catalog of stacks, all switched off until the host says otherwise.
        catalog = {
          imports = map (m: root + "/modules/${m}") catalogModules;
        };

        default = {
          imports = [
            self.nixosModules.platform
            self.nixosModules.daedalus
            self.nixosModules.catalog
          ];
        };
      };
    };
}
