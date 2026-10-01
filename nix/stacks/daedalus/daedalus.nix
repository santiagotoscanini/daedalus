# daedalus — the box's own control plane: its switch and options, its entry
# on the apps platform (`fleet.apps.daedalus`, from ./self.json through the
# same mapper the registry goes through), the image it runs, and the
# assertions about the names it answers on. What the container is handed —
# env and mounts — is container.nix; the per-service read keys
# dashboard-keys.nix.
#
# One Dockerfile at the engine's root builds the one image, from one of three
# sources (`fleet.daedalus.source`, nix/README.md "The control plane's
# image"): `published` pulls the engine's own image at this rev's version,
# `local` builds the whole Dockerfile on the box before the switch, and `dev`
# builds the `runtime` stage alone and mounts the engine checkout's app/ for
# Vite to serve — saving a file is the deploy.

{
  config,
  lib,
  pkgs,
  mkLocalImage,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    workspaceIconsDir
    boardsDir
    at
    haveGithubApp
    engineRoot
    ;

  # Which containers ride each VPN tunnel, derived rather than declared: a
  # netns tenant says so in its own `--network=container:<owner>` flag, and
  # that flag is the thing that actually puts it behind the tunnel. A
  # hand-kept list beside it could only ever be the same fact, less reliably.
  netnsTenantsOf =
    owner:
    lib.sort (a: b: a < b) (
      lib.attrNames (
        lib.filterAttrs (
          _: c: lib.any (o: o == "--network=container:${owner}") (c.extraOptions or [ ])
        ) config.virtualisation.oci-containers.containers
      )
    );

  # The VPN egress registry, as the dashboard consumes it. Nix knows things
  # about these tunnels that no API can answer — when the key expires, what
  # the tunnel is for, where the renewal runbook lives — and this is the one
  # place those cross the boundary.
  vpnEgress = lib.mapAttrsToList (
    _: v: v // { tenants = netnsTenantsOf v.container; }
  ) config.fleet.vpnEgress;

  # Apps with a tracked site/vault/apps/<name>-env.sops. A FACT, read from the
  # same directory listing declarations.nix reads, not a setting: this is the
  # only thing that decides whether an app gets operator secrets, so the page
  # shows it and offers no switch. The registry (apps.json) carries settings;
  # the `apps` export domain (below) carries what Nix knows — and this belongs
  # on that side.
  #
  # The site directory is handed in rather than derived from the library's
  # location — same argument as the other consumer, spelled out in the library.
  operatorSecretApps = lib.attrNames (
    import ../../platform/lib/operator-secrets-lib.nix {
      inherit lib;
      site = config.fleet.site.source;
    }
  );

  # daedalus's own registry entry — ./self.json, the same entry schema as one
  # apps.json value, mapped through the same platform/lib/registry-lib.nix the
  # committed registry goes through, so a field the registry grows cannot be
  # silently dropped here. Read twice from this one value: by
  # `fleet.apps.daedalus` and by the `apps` export domain. Not read back out of
  # `config.fleet.apps.daedalus`: that is the mapper's output, not the entry
  # the page decodes.
  #
  # self.json carries `hostLabel` where an apps.json entry carries a full
  # `hostname` (a domain is the host's fact); it is joined here, before the
  # mapper and the export, so both see the registry's shape. `stage = "lab"`
  # keeps the control plane LAN-only. `resources` is uncapped: a dev server
  # that typechecks and bundles on demand has a spiky working set.
  self =
    let
      raw = builtins.fromJSON (builtins.readFile ./self.json);
    in
    builtins.removeAttrs raw [
      "_hand"
      "hostLabel"
    ]
    // {
      hostname = at raw.hostLabel;
    };

  registryLib = import ../../platform/lib/registry-lib.nix { inherit lib; };
  selfApp = registryLib.mkApp self;

  # The address, as Settings › General edits it (platform/site.nix). self.json's
  # hostname is the fallback for a site.json that does not carry one yet.
  cp = config.fleet.controlPlane;

  # ── the control plane's image ──────────────────────────────────────────
  #
  # The two sources built on the box are both mkLocalImage, tagged by the hash
  # of exactly the files the build reads, so the tag — and with it the
  # container — moves when one of those does and never otherwise.
  source = config.fleet.daedalus.source;
  daedalusDev = source == "dev";

  # What the runtime stage copies: the entrypoint and the two design documents
  # the MCP server serves (app/src/host/mcp/docs.ts).
  runtimeFiles = [
    ../../../Dockerfile
    ../../../docker-entrypoint.sh
    ../../../ARCHITECTURE.md
    ../../../BUILDS.md
  ];

  # Dev mode: the `runtime` stage alone — node, sops, the entrypoint, the docs,
  # no bundle. The checkout's app/ is mounted at /app and the entrypoint runs
  # Vite over it, so a route edit never moves this tag.
  devRuntime = mkLocalImage {
    name = "app-daedalus-dev";
    tagPrefix = "runtime";
    contextDir = lib.fileset.toSource {
      root = ../../..;
      fileset = lib.fileset.unions runtimeFiles;
    };
    file = "Dockerfile";
    target = "runtime";
    gates = [ "podman-app-daedalus.service" ];
  };

  # `local`: the whole Dockerfile, so the context is app/ as well — minus what a
  # checkout that runs the dev server holds there (its install, its store, a
  # previous build, generated routes: the root .gitignore's app/ list). Under
  # `--override-input daedalus path:<clone>` those are on disk beside the
  # source and would otherwise be copied in; `maybeMissing` because a git
  # input has none of them. The .dockerignore is not in it: this set already
  # is the context, exactly.
  appJunk = map (p: lib.fileset.maybeMissing (../../../app + "/${p}")) [
    "node_modules"
    ".pnpm-store"
    ".corepack"
    ".vite"
    ".tanstack"
    ".output"
    "dist"
    "src/routeTree.gen.ts"
  ];
  npmMirror = config.fleet.builder.npmMirrorHost;
  localImage = mkLocalImage {
    name = "app-daedalus";
    tagPrefix = appVersion;
    contextDir = lib.fileset.toSource {
      root = ../../..;
      fileset = lib.fileset.unions (
        runtimeFiles ++ [ (lib.fileset.difference ../../../app (lib.fileset.unions appJunk)) ]
      );
    };
    file = "Dockerfile";
    # The install goes through the mirror the box publishes, the same one the
    # dev container and the app builds use. It is served by the reverse proxy
    # on the host, which a build container reaches as host-gateway (under
    # rootless podman the LAN address is the container itself).
    buildFlags = lib.optionals (npmMirror != null) [
      "--add-host=${npmMirror}:host-gateway"
      "--build-arg=NPM_REGISTRY=https://${npmMirror}/"
    ];
    # A cold build at boot (no tag yet) installs through both: the mirror
    # modules/verdaccio publishes, and the proxy in front of it.
    after = lib.optionals (npmMirror != null) [
      "podman-traefik.service"
      "podman-verdaccio.service"
    ];
    gates = [ "podman-app-daedalus.service" ];
  };

  builtImage =
    {
      dev = devRuntime;
      local = localImage;
    }
    .${source} or null;

  # The base of an image built on the box, every stage of it: the
  # Dockerfile's `ARG NODE_IMAGE=` default, the one place it is written (the
  # published image is built from the same line).
  # A plain read of a file in this repo — no import-from-derivation.
  nodeImageLine =
    lib.findFirst (lib.hasPrefix "ARG NODE_IMAGE=")
      (throw "the engine's Dockerfile has no `ARG NODE_IMAGE=` line")
      (lib.splitString "\n" (builtins.readFile ../../../Dockerfile));

  # The app's version, as the engine at this rev ships it: the published image
  # is tagged with it, so pinning the engine pins the control plane's image.
  appVersion = (builtins.fromJSON (builtins.readFile ../../../app/package.json)).version;
in

{
  options.fleet.modules.daedalus.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "The box's own control plane, and the builder that turns a push into an image.";
  };

  options.fleet.daedalus.source = lib.mkOption {
    type = lib.types.enum [
      "published"
      "local"
      "dev"
    ];
    default = "published";
    description = ''
      Where the control plane's image comes from.

      - `published`: `fleet.daedalus.image`, the engine's own published image
        at the version this engine rev ships.
      - `local`: the engine's whole Dockerfile, built on this box from the
        engine source the configuration locks, its npm install going through
        the box's own mirror (`fleet.builder.npmMirrorHost`) when there is
        one. Pinning the engine pins the control plane and the build needs no
        outside registry. The build runs before a switch stops anything, and
        a failed one refuses the switch.
      - `dev`: DEV MODE — the image's `runtime` stage, built on this box,
        with the engine checkout's `app/` mounted at /app and Vite serving
        it. Saving a file is the deploy. For the host that develops the
        engine.
    '';
  };

  options.fleet.daedalus.image = lib.mkOption {
    type = lib.types.str;
    default = "ghcr.io/santiagotoscanini/daedalus:${appVersion}";
    defaultText = lib.literalExpression ''"ghcr.io/santiagotoscanini/daedalus:<app/package.json version>"'';
    description = ''
      The control plane's image under `source = "published"`. The default is
      the engine's own published image at the version this engine rev ships
      (app/package.json): pinning the engine pins it, and the engine's update
      path (System › Updates › Engine) is the image's. Override to a digest
      pin or a mirror of it.
    '';
  };

  options.fleet.daedalus.routerProduct = lib.mkOption {
    type = lib.types.str;
    default = "";
    example = "Example AX3000";
    description = ''
      The product name printed on the LAN router, for the Network page. The one
      router fact the page cannot read off the device itself: its login page's
      build stamp carries model, hardware revision, firmware and build date,
      but not the retail name. Empty shows none.
    '';
  };

  options.fleet.daedalus.routerAdminUrl = lib.mkOption {
    type = lib.types.str;
    default = "https://${config.fleet.gateway}/";
    defaultText = lib.literalExpression ''"https://${config.fleet.gateway}/"'';
    example = lib.literalExpression ''"https://${config.fleet.gateway}/login"'';
    description = ''
      Where the Network page sends the operator to administer the LAN router:
      its admin login, over HTTPS (a person about to type a password). Every
      vendor puts the login somewhere else on the device.
    '';
  };

  options.fleet.reservedLabels = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          reason = lib.mkOption {
            type = lib.types.str;
            example = "is the project's landing page, a record this box does not own.";
            description = "Why, as the rest of a sentence that starts with the label: what the app shows the operator who tried it.";
          };
          owners = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            example = [ "fleet.cloudflareRoutes.daedalus-hooks" ];
            description = "The entries that publish the label on purpose (`fleet.<registry>.<name>`), which the check leaves alone.";
          };
        };
      }
    );
    default = { };
    description = ''
      Labels under `fleet.baseDomain` that no app, webApp, route or control
      plane address may take. The engine reserves `hooks`, the GitHub App's
      webhook; a host adds the names it publishes outside this box (a record
      at its DNS provider that no fleet hostname names, which a collision
      check would never see and the tunnel's route sync would reconcile
      away). The build asserts them, and the app refuses them at the edit.
    '';
  };

  options.fleet.daedalus.boardsDir = lib.mkOption {
    type = lib.types.str;
    readOnly = true;
    default = boardsDir;
    description = ''
      Where the System › Motherboard tab asks for the vendor pages it cannot
      read itself and finds them answered: it writes `request.json` (the pages
      it wants), and a host's own job, run as the operator, answers each as
      `<id>.json` (app/src/lib/dashboard/board-releases.ts has the shapes).
      Container-writable, so nothing root reads lives here.
    '';
  };

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # The container's two writable directories (daedalus-lib.nix): the
    # operator's, made before the container mounts them.
    fleet.statePaths.${workspaceIconsDir} = { };
    fleet.statePaths.${boardsDir} = { };

    # The identity headers count only on a request carrying traefik's proof
    # (platform/publishing-options.nix proxyProof; the app's side is
    # core/auth.ts): the app shares bridges, so being dialled proves nothing.
    fleet.webApps.daedalus.proxyProof = true;

    # The app reads traefik's API container-direct (the network pages), and
    # that API is served to named source ranges only — it prints every
    # middleware, proof secrets included (modules/traefik apiReaders). So the
    # private bridge gets a pinned subnet, high in podman's 10.89.0.0/16 pool
    # where the auto-assigned bridges of a fresh box do not reach, and that
    # subnet is the one reader.
    fleet.bridgeSubnets.iso-daedalus = "10.89.254.0/24";
    fleet.modules.traefik.apiReaders = [ config.fleet.bridgeSubnets.iso-daedalus ];

    # A reserved label is not an app's to take, whatever door the claim comes
    # through — a webApp, an app's hostname or alias, the control plane's
    # address, a route — bar the entries that publish it on purpose (its
    # `owners`). The app refuses the same labels at the edit (it reads them
    # from the publishing export); this is the build refusing them.
    assertions =
      let
        claims =
          lib.mapAttrsToList (n: w: {
            what = "fleet.webApps.${n}";
            hosts = [ w.hostname ] ++ w.aliases;
          }) config.fleet.webApps
          ++ lib.mapAttrsToList (n: a: {
            what = "fleet.apps.${n}";
            hosts = lib.optional (a.hostname != null) a.hostname ++ a.hostnameAliases;
          }) config.fleet.apps
          ++ lib.mapAttrsToList (n: r: {
            what = "fleet.traefikRoutes.${n}";
            hosts = [ r.host ] ++ r.extraHosts;
          }) config.fleet.traefikRoutes
          ++ lib.mapAttrsToList (n: r: {
            what = "fleet.cloudflareRoutes.${n}";
            hosts = [ r.hostname ];
          }) config.fleet.cloudflareRoutes;

        # One assertion per reserved label, naming whoever claimed it.
        reservedAssertions = lib.mapAttrsToList (
          label: r:
          let
            host = at label;
            offenders = map (c: c.what) (
              lib.filter (c: lib.elem host c.hosts && !(lib.elem c.what r.owners)) claims
            );
          in
          {
            assertion = offenders == [ ];
            message = "${host} is reserved: ${label} ${r.reason} ${lib.concatStringsSep ", " offenders} cannot use it.";
          }
        ) config.fleet.reservedLabels;
      in
      reservedAssertions
      ++ [
        # The spine the control plane runs on: its container is an app of the
        # apps platform, pulled from the registry, published by traefik behind
        # pocket-id, with its database on app-db. Every module here defines
        # into those without a guard of its own.
        (
          let
            missing = lib.filter (m: !config.fleet.modules.${m}.enable) [
              "apps"
              "traefik"
              "pocket-id"
              "registry"
              "app-db"
            ];
          in
          {
            assertion = missing == [ ];
            message = "fleet.modules.daedalus needs ${lib.concatStringsSep ", " missing} switched on (fleet.modules.<id>.enable).";
          }
        )
        {
          assertion = haveGithubApp -> config.fleet.github.app != null;
          message = "site/vault/github-app.sops is in the flake, but site.json has no github.app. The token minter signs as the App's clientId and finds its installation by ownerId, so the two land together: retry the Apply from Settings › Integrations › GitHub, which writes both in one commit.";
        }
      ];

    # selfApp carries everything self.json declares; layered on here is only
    # what this module alone can know — the address, the source, and the auth
    # details that name nix-side machinery. Env and mounts: container.nix.
    fleet.apps.daedalus = selfApp // {
      hostname = if cp.label != null then at cp.label else selfApp.hostname;
      # After a rename the old address keeps answering until the new one is
      # confirmed from (Settings › General), so a label that does not work
      # cannot lock the operator out.
      hostnameAliases = lib.optional (
        cp.label != null && cp.previousLabel != null && cp.previousLabel != cp.label
      ) (at cp.previousLabel);

      # In dev mode the entry says where the checkout is: a plain string, not
      # a nix path, which would be copied into the store and leave the
      # container watching a frozen snapshot.
      source = {
        dev = daedalusDev;
        path = lib.mkIf daedalusDev "${engineRoot}/app";
      };
      image = if builtImage != null then builtImage.image else config.fleet.daedalus.image;
      # The registry poll redeploys on a moved digest, which only a pulled image
      # has: an image built on the box moves with the engine rev, through the
      # rebuild that brings it.
      deploy.enable = source == "published";

      # Forward-auth: daedalus has no user model of its own and serves one
      # operator, so the Pocket ID gate stands in front of it. The headers are
      # trusted only beside traefik's proxy proof, and the strip middleware
      # blanks any client-sent copy before the gate.
      auth = selfApp.auth // {
        headers = {
          "X-Forwarded-Email" = "{{ .claims.email }}";
          # Pocket ID's user id. The Profile page finds the signed-in account
          # by it, because unlike the email it survives the person editing it.
          "X-Forwarded-User" = "{{ .claims.sub }}";
          # Which Pocket ID groups the session carries, as a JSON array
          # (`mapToJsonArray`: Go renders a bare slice as `[a b]`). The app
          # refuses a mutation from outside `admins` — defence in depth behind
          # the client's own `authGroups`. The plugin sets headers on gated
          # paths only, so every bypassed path arrives with this blank.
          "X-Forwarded-Groups" = "{{ .claims.groups | mapToJsonArray }}";
        };
        # The paths whose callers cannot hold a passkey, each written to
        # authenticate itself or to be harmless in public on the LAN
        # (ARCHITECTURE.md "Trust boundaries"): /mcp (a scoped bearer token,
        # checked before any work; deliberately not fronted by the LiteLLM
        # gateway, which would widen its reach), the icons (iOS fetches the
        # home-screen icon without the session cookie) and /api/agent/enroll
        # (a single-use, PKCE-bound code).
        authBypassRule = "PathPrefix(`/mcp`) || Path(`/icon.svg`) || Path(`/icon.png`) || Path(`/apple-icon.png`) || Path(`/api/agent/enroll`)";
      };
    };

    # The tunnel registry rides the publishing domain (platform/export.nix);
    # the tenant list comes from each container's own --network=container:
    # flag, which only this module reads.
    fleet.export.domains.publishing.data.vpnEgress = vpnEgress;
    # And the labels no app may take, for the app to refuse at the edit what
    # the assertions above refuse at the build.
    fleet.export.domains.publishing.data.reservedLabels = lib.mapAttrs (
      _: r: r.reason
    ) config.fleet.reservedLabels;

    # What only Nix knows about the app registry (app/src/host/contract/domains/
    # apps.ts): the hand-declared apps — only daedalus itself, from `self` — on
    # top of which `fleet.daedalus.source` decides the image and whether it is
    # pulled and polled; and operatorSecretApps. Read off the entry this module
    # defines, so the page and the unit cannot disagree.
    fleet.export.domains.apps.data = {
      nixManaged.daedalus = self // {
        sourceMode = if source == "published" then "registry" else "local";
        inherit (config.fleet.apps.daedalus) image;
        deploy.enable = config.fleet.apps.daedalus.deploy.enable;
      };
      inherit operatorSecretApps;
    };

    # An image built on the box is built before the container starts
    # (mkLocalImage's `gates`); a host on the published image builds nothing.
    systemd.services.app-daedalus-image-build = lib.mkIf (builtImage != null) builtImage.service;

    # `local` builds BEFORE the switch, as one of the new generation's own
    # pre-switch checks: a failed build refuses the switch with nothing
    # stopped, and a good one leaves the unit above a cache hit (the script
    # skips a tag that exists). Run for `boot` too. As the operator, in a
    # cleared environment: the image lives in their rootless store, and an
    # inherited XDG_DATA_HOME or CONTAINERS_* would point podman at another.
    # Checks run in name order, hence the `z`: after the upgrade guard and the
    # inhibitors, so a switch they refuse builds nothing.
    system.preSwitchChecks.z-daedalus-image = lib.mkIf (source == "local") ''
      case "''${2:-}" in
        dry-activate) exit 0 ;;
      esac
      ${pkgs.util-linux}/bin/setpriv --reuid ${config.fleet.operator.user} --regid ${config.fleet.operator.group} --init-groups --inh-caps=-all \
        ${pkgs.coreutils}/bin/env -i HOME=${config.fleet.operator.home} XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir} PATH=/run/wrappers/bin \
        ${localImage.service.serviceConfig.ExecStart}
    '';

    # Its base on System › Updates: the Dockerfile's node, every stage of it. A
    # different node pin from the build checks' (build-agent.nix), bumped
    # apart.
    fleet.manualPins = lib.mkIf (builtImage != null) {
      app-daedalus-node = {
        image = lib.removePrefix "ARG NODE_IMAGE=" nodeImageLine;
        containers = [ "app-daedalus" ];
        upstream = "nodejs/node";
        pinnedIn = "Dockerfile";
      };
    };

  };
}
