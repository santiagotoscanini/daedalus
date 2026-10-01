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
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
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
        "claude-code/claude-code.nix"
        "claude.nix"
        "config-bundle.nix"
        "ddclient/ddclient.nix"
        "export.nix"
        "git/git.nix"
        "hc-ping/hc-ping.nix"
        "identity.nix"
        "machine-state.nix"
        "mail/mail.nix"
        "nodes.nix"
        "operator.nix"
        "podman-prune.nix"
        "podman.nix"
        "publishing.nix"
        "site.nix"
        "smartd.nix"
        "sops.nix"
        "storage.nix"
        "upgrade-guard/upgrade-guard.nix"
        "zfs.nix"
      ];

      daedalusModules = [
        "build-agent.nix"
        "builder.nix"
        "claude-code-update.nix"
        "controller.nix"
        "daedalus-github.nix"
        "daedalus-nodes.nix"
        "daedalus-snapshots.nix"
        "daedalus-verbs.nix"
        "daedalus.nix"
        "engine-update.nix"
        "railpack.nix"
        "session-host.nix"
        "version-update.nix"
      ];

      # The catalog: one stack per directory, `modules/<id>/…`, each behind
      # `fleet.modules.<id>.enable` — default OFF, so importing them all costs a
      # host nothing. Listed FILE by file like the two lists above: a module
      # never imports its siblings (nix-engine.md §6), because the module
      # system merges a module's own `imports` ahead of the level above it, so
      # a multi-file stack that did would reorder list-typed options.
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

      # A test host under nix/tests/, given what any host gives the engine:
      # sops-nix beside it and `nixpkgs-unstable` as a specialArg.
      mkTestHost =
        dir:
        import dir {
          inherit
            nixpkgs
            nixpkgs-unstable
            sops-nix
            system
            ;
          engine = self;
        };
    in
    {
      # `nix/` as a path, for a host that still keeps stacks of its own and
      # needs the shared libraries: `import (enginePath + "/platform/lib/…")`.
      # Hand it to modules through `specialArgs.enginePath` — several stacks
      # import a library at module-import time, where `_module.args` cannot
      # reach.
      lib.path = root;

      formatter.${system} = treefmtEval.config.build.wrapper;

      # A VM test, run by hand (never a check: no VM builds in CI) — the
      # container unit shape under this nixpkgs (nix/tests/oneshot-vm).
      packages.${system}.vmtest-oneshot = import ./nix/tests/oneshot-vm { inherit pkgs; };

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
            host = mkTestHost ./nix/tests/example-host;
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
            host = mkTestHost ./nix/tests/all-modules;
          in
          pkgs.runCommand "all-modules-evaluate" { } (
            builtins.seq host.config.system.build.toplevel.drvPath "touch $out"
          );

        # The example host with the catalog off but for what the control plane
        # needs (nix/tests/daedalus-minimal): the control plane and the
        # platform evaluate without the rest of the spine.
        daedalus-minimal =
          let
            host = mkTestHost ./nix/tests/daedalus-minimal;
          in
          pkgs.runCommand "daedalus-minimal-evaluates" { } (
            builtins.seq host.config.system.build.toplevel.drvPath "touch $out"
          );

        # The host agents' scripts, BUILT — the one check that builds anything:
        # writeShellApplication runs shellcheck over each script mkAgent
        # assembles from nix/stacks/daedalus/host/*.sh (and the apps deploy
        # script), and only a build runs it. The scripts are found where a box
        # finds them, in the Exec lines of the `daedalus-*` and `app-*-deploy`
        # units of the example host with the builder on (nix/tests/agent-scripts),
        # and only the scripts are built: the names below never match the agent's
        # Rust package (a version in its name) or a rendered file (a dot). Their
        # runtime inputs are nixpkgs' and come from the binary cache.
        agent-scripts =
          let
            inherit (nixpkgs) lib;
            host = mkTestHost ./nix/tests/agent-scripts;
            units = lib.filterAttrs (
              name: _: lib.hasPrefix "daedalus-" name || builtins.match "app-.*-deploy" name != null
            ) host.config.systemd.services;
            execs = lib.concatMap (
              unit:
              lib.concatMap (k: lib.toList (unit.serviceConfig.${k} or [ ])) [
                "ExecStartPre"
                "ExecStart"
                "ExecStartPost"
                "ExecStopPost"
              ]
            ) (lib.attrValues units);
            drvs = lib.unique (lib.concatMap (e: lib.attrNames (builtins.getContext (toString e))) execs);
            scripts = lib.filter (
              d: builtins.match "/nix/store/[^-]+-(daedalus-[a-z-]+|app-[a-z0-9-]+-deploy)\\.drv" d != null
            ) drvs;
            built = lib.concatMapStrings (d: builtins.appendContext "" { ${d}.outputs = [ "out" ]; }) scripts;
          in
          assert
            lib.length scripts > 30
            || throw "agent-scripts found only ${toString (lib.length scripts)} scripts";
          pkgs.runCommand "agent-scripts" { } "${built}touch $out";

        # The root helper's verb table (nix/stacks/daedalus/controller.nix,
        # `root`): the example host carries `reboot` and `workspace-clone`
        # with every assertion holding, and a verb whose unit the evaluation
        # can see is wrong is refused, naming itself. The table's own rules —
        # names, selector values, patterns, caps — are the helper's
        # (`Table::check`, tested in agent/src/root), run on the rendered
        # table at build time by `root-helper --check-table`; evaluation no
        # longer mirrors them.
        root-verbs =
          let
            inherit (nixpkgs) lib;
            host = mkTestHost ./nix/tests/example-host;
            failing =
              extra:
              map (a: a.message) (
                lib.filter (a: !a.assertion) (host.extendModules { modules = [ extra ]; }).config.assertions
              );
            refused =
              name: verb:
              lib.any (lib.hasInfix "rootVerbs.${name}:") (failing {
                fleet.daedalus.rootVerbs.${name} = {
                  description = "a test";
                  timeoutSec = 5;
                }
                // verb;
              })
              || throw "fleet.daedalus.rootVerbs.${name} should have been refused";
          in
          assert host.config.fleet.daedalus.rootVerbs ? reboot || throw "the example host has no reboot verb";
          assert
            host.config.fleet.daedalus.rootVerbs ? workspace-clone
            || throw "the example host has no workspace-clone verb";
          assert failing { } == [ ] || throw "the example host fails: ${toString (failing { })}";
          # A unit that does not exist, one a path unit starts too, a
          # template instance with no template, and one whose template is not
          # a oneshot.
          assert refused "nope" { unit = "no-such-unit.service"; };
          assert refused "sync" { unit = "daedalus-workspace-sync.service"; };
          assert refused "tpl" {
            unit = "no-such-template@{app}.service";
            selectors.app = [ "a" ];
          };
          assert refused "notoneshot" {
            unit = "daedalus-root@{app}.service";
            selectors.app = [ "a" ];
          };
          pkgs.runCommand "root-verbs" { } "touch $out";

        # The bridge agents' git and rollback behaviour, RUN against temp
        # repositories with nixos-rebuild, curl and gpg stubbed: no network,
        # no root (nix/tests/host-scripts).
        host-scripts = import ./nix/tests/host-scripts { inherit pkgs; };
      };

      # `nix flake init -t github:santiagotoscanini/daedalus#config`: the
      # example host this flake's checks evaluate, as a starting point — every
      # value in it is a documentation value to replace (its files say which).
      templates.config = {
        path = ./example-host;
        description = "A NixOS host run by daedalus: the engine as a flake input, and the definitions a host brings";
      };

      # ONE module, the whole engine: the platform (the base every stack rides
      # on, no switches), the control plane behind `fleet.modules.daedalus.enable`,
      # and the catalog, every stack off until the host switches it on. Not
      # three exports: the control plane defines options only catalog modules
      # declare, so no part evaluates without the others.
      #
      # Three nested groups, in this order: the module system merges list-typed
      # options in an order that depends on nesting, so flattening them into
      # one list would reorder every host's units.
      nixosModules.default = {
        imports = [
          { imports = map (m: root + "/platform/${m}") platformModules; }
          { imports = map (m: root + "/stacks/daedalus/${m}") daedalusModules; }
          { imports = map (m: root + "/modules/${m}") catalogModules; }
        ];
      };
    };
}
