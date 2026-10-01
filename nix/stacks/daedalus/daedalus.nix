# daedalus — the box's own control plane, and the only app on the apps
# platform the box does not build through the registry loop.
#
# Everything else on the platform rides the registry loop: push to main, the
# GitHub App webhook reaches daedalus, `daedalus-build.service` builds the
# image and pushes it to the box's registry, and the deploy that build starts
# runs it. daedalus is the engine itself — this repository — and comes as ONE
# image built from the Dockerfile at the repository root (Dockerfile,
# docker-entrypoint.sh), from one of three sources (`fleet.daedalus.source`):
#
#   published (default)  `fleet.daedalus.image`, the engine's own ghcr image at
#                        the version this rev ships. Pinning the engine pins
#                        the control plane.
#   local                the whole Dockerfile, built on the box from the
#                        engine source this rev locks, its npm install going
#                        through the box's own mirror when it publishes one.
#                        Pinning the engine pins the control plane, and
#                        nothing is fetched from a registry outside the house
#                        but the sops release the Dockerfile names.
#   dev                  the image's `runtime` stage, built on the box; the
#                        engine checkout's app/ mounted at /app; Vite serving
#                        it. Saving a file IS the deploy: no commit, no build,
#                        no pull, no rebuild. For the host that develops the
#                        engine.
#
# What dev mode buys and what it costs:
#   + Edit-to-browser in under a second, from anywhere with a shell on the box.
#   + The checkout lives under /home, which the reference host snapshots and
#     mirrors — unlike its configuration repo. The engine's remote is still the
#     copy that survives a disk.
#   - No production build. Dev-server performance, on purpose: this is a
#     single-operator admin UI, not something that serves load.
#   - `pnpm install --frozen-lockfile` runs at every container start, so the
#     npm registry (the box's mirror when it publishes one, npmjs otherwise) is
#     a hard startup dependency. First boot after a fresh restore takes minutes;
#     the unit is Type=oneshot so it goes green immediately while Vite is still
#     starting, and the probe is red until it listens. Expected, not a fault.
#   - A fresh restore needs the checkout before the container will start.
#
# What `local` costs: every engine rev that touches the image's context is a
# full image build (install + vite build, minutes) at the switch that brings
# it. The build runs as a pre-switch check, BEFORE the switch stops anything:
# a failed build refuses the switch and the running container stays on the
# previous image, and a good one leaves the container's own build unit a cache
# hit, so the control plane is down only for its restart.
#
# Which rebuilds matter:
#   dev    <clone>/app/**           → nothing. Vite is watching it.
#          <clone>/app/package.json → `systemctl restart podman-app-daedalus`
#                                     (re-installs).
#          Dockerfile, docker-entrypoint.sh, ARCHITECTURE.md, BUILDS.md
#                                   → nixos-rebuild (runtime context hash → new
#                                     image tag → restart). Nothing else in the
#                                     repository reaches that context.
#   local  anything in the image's context, at the locked rev → nixos-rebuild
#          after `nix flake update daedalus` (new tag → build → restart).
#   all    this file                → nixos-rebuild.

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
  mkLocalImage,
  mkSecretRender,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    appsOn
    applyDir
    at
    hooksHost
    haveGithubApp
    githubRenderDir
    githubTokenDir
    workspaceRoot
    engineRoot
    workspacesDir
    envDir
    imageDir
    systemDir
    repoDir
    builderDir
    controllerDir
    ;

  # What the stacks show the control plane — `fleet.dashboard` (platform/
  # export.nix), read whole and never indexed by a fixed key. Each stack
  # contributes inside its own `mkIf`: a version under the name the engine
  # reads (`FACTORIO_VERSION`), an endpoint (`PIHOLE_URL`), a rendered secret
  # (`LITELLM_API_KEY`), a mount (/shotter). Switch the stack off and its
  # entry is simply absent — the page renders "unknown" or nothing — rather
  # than this module failing eval on another stack's missing container,
  # webApp or secret.
  dashboard = lib.attrValues config.fleet.dashboard;

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
  # committed registry goes through. One schema, one mapper: when the registry
  # grows a field, this entry cannot be the reader that silently drops it.
  #
  # Defined ONCE and consumed twice: by `fleet.apps.daedalus` below, and by the
  # `apps` export domain the container reads. As two literals these drift
  # within the hour — the app list rendering one description while the detail
  # page reports another. Restating this is exactly the class of bug daedalus
  # exists to catch, so it does not get to have it.
  #
  # NOT read back out of `config.fleet.apps.daedalus`, which would be the other
  # way to deduplicate: that is the mapper's OUTPUT, not the registry-schema
  # entry the page decodes, and a JSON file preserves the no-config-read
  # property registry-lib requires of its input.
  # (The one config read below is `fleet.baseDomain`, for the hostname: site.json
  # defines it and nothing under `fleet.apps` feeds it.)
  #
  # On its values: `stage = "lab"` keeps it LAN-only — a control plane for
  # this box has no business answering on a public CNAME, wildcard cert or
  # not. `postgres` puts role + database `daedalus` on the shared cluster
  # (modules/app-db), REVOKE'd from PUBLIC like every other tenant, with
  # DATABASE_URL arriving via the bootstrap-generated env file; joining
  # app-db-net for it is also how the container reaches `litellm:4000` on the
  # same bridge. `litellm` sets LITELLM_BASE_URL against the shared gateway —
  # not a second instance, so daedalus sees every model Lemonade serves with
  # no duplicated model list. `resources` is uncapped on purpose: this is a
  # Vite dev server that typechecks and bundles on demand, so its working set
  # is spiky and unlike a built app's — a cap sized from steady state would
  # OOM it on the first cold compile.
  #
  # One key differs from the registry schema: self.json carries `hostLabel`
  # where an apps.json entry carries a full `hostname`, because this file ships
  # with the engine and a domain is the host's fact (site.json), not the
  # engine's. It is joined here, BEFORE the mapper and the export, so both
  # still see the registry's `hostname` and neither learns a second schema.
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
  # One Dockerfile at the engine's root builds the one image (its header says
  # how); `fleet.daedalus.source` decides where it comes from (the header
  # above). The two sources built on the box are both mkLocalImage, tagged by
  # the hash of exactly the files the build reads, so the tag — and with it the
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

  # Labels under baseDomain that no app may publish. Mirrors RESERVED_LABELS in
  # the engine's app/src/lib/hostname.ts — the reasons are argued at the
  # assertion that reads this.
  reservedLabels = {
    hooks = "the GitHub App's webhook (stacks/daedalus, hooks-github.yml)";
    daedalus = "the project's GitHub Pages landing page, a record this box does not own";
  };
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

  options.fleet.daedalus.serviceKeysSopsFile = lib.mkOption {
    type = lib.types.path;
    example = lib.literalExpression "./sops/service-keys.sops";
    description = ''
      The sops-encrypted dotenv of per-service read-only API keys the control
      plane reads other services' numbers with (rendered as `DASH_<n>`). The
      host's file, handed in: every key in it was minted by a service on that
      box. A key missing from it renders empty and its panel shows no data.
    '';
  };

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # Reach the monitoring stack: prometheus for liveness/traffic/DB size, loki
    # for the log panels. Both live on `monitoring`. This list MERGES with the
    # one modules/apps/apps.nix contributes for this container (app-db, plus the
    # iso bridge from webApps.isolated) — bridgeMemberships is the single source
    # of membership and its lists concatenate across modules.
    #
    # Bridges are two-way: every member of `monitoring` and `app-db` can dial
    # daedalus on those bridges, not just be dialled by it. That is why the app
    # does not rest on `isolated` for who it trusts: it verifies traefik's
    # proxy proof on every request (proxyProof below) and ignores the identity
    # headers of any request without it. `isolated` still keeps it off
    # traefik-net and drops routed connections into its private subnet.
    #
    # Gated on the apps stack's switch, like every definition under another
    # stack's declaration: `fleet.apps.daedalus` is only a declaration, and the
    # `app-daedalus` container exists when the apps stack materializes it. With
    # that stack off (or not on this host yet) a membership for a container
    # nobody creates would fail evaluation on its missing image.
    fleet.bridgeMemberships."app-daedalus" = lib.mkIf appsOn [ "monitoring" ];

    # The identity headers count only on a request carrying traefik's proof
    # (platform/publishing.nix proxyProof; the app's side is core/auth.ts). The
    # webApp itself comes from fleet.apps.daedalus through the apps stack.
    fleet.webApps.daedalus.proxyProof = lib.mkIf appsOn true;

    # The app reads traefik's API container-direct (the network pages), and
    # that API is served to named source ranges only — it prints every
    # middleware, proof secrets included (modules/traefik apiReaders). So the
    # private bridge gets a pinned subnet, high in podman's 10.89.0.0/16 pool
    # where the auto-assigned bridges of a fresh box do not reach, and that
    # subnet is the one reader.
    fleet.bridgeSubnets.iso-daedalus = "10.89.254.0/24";
    fleet.modules.traefik.apiReaders = lib.mkIf appsOn [ config.fleet.bridgeSubnets.iso-daedalus ];

    # Two labels under baseDomain are not an app's to take, and they fail in
    # opposite ways.
    #
    # `hooks` is the GitHub App's public webhook name (the cfweb router and
    # tunnel route in daedalus-github.nix). Anything else claiming it would either collide with
    # that router or put a whole app behind a public CNAME the operator never
    # chose.
    #
    # `daedalus` is the project's public landing page: a hand-managed CNAME to
    # GitHub Pages (CLAUDE.md). It is deliberately NOT a fleet hostname, which is
    # exactly why it needs saying here — it never appears in the "taken" list a
    # collision check reads, so nothing else on this box would notice a claim on
    # it, and cloudflared-route-sync would reconcile the Pages record away. The
    # control-plane assertion below covers only fleet.controlPlane; an app's
    # `hostname` override reaches the same name by another door.
    #
    # The engine refuses both labels at the edit (app/src/lib/hostname.ts,
    # RESERVED_LABELS); this is the build refusing them, because the edit is not
    # the only door either.
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
          }) (builtins.removeAttrs config.fleet.cloudflareRoutes [ "daedalus-hooks" ]);

        # One assertion per reserved label, naming whoever claimed it.
        reservedAssertions = lib.mapAttrsToList (
          label: purpose:
          let
            host = at label;
            offenders = map (c: c.what) (lib.filter (c: lib.elem host c.hosts) claims);
          in
          {
            assertion = offenders == [ ];
            message = "${host} is reserved for ${purpose}: ${lib.concatStringsSep ", " offenders} cannot use it.";
          }
        ) reservedLabels;
      in
      [
        {
          assertion = cp.label != "daedalus" && cp.previousLabel != "daedalus";
          message = "fleet.controlPlane: the control plane cannot answer at daedalus.${config.fleet.baseDomain} — that name is the project's GitHub Pages landing page.";
        }
      ]
      ++ reservedAssertions
      ++ [
        {
          assertion = haveGithubApp -> config.fleet.github.app != null;
          message = "site/vault/github-app.sops is in the flake, but site.json has no github.app. The token minter signs as the App's clientId and finds its installation by ownerId, so the two land together: retry the Apply from Settings › Integrations › GitHub, which writes both in one commit.";
        }
      ];

    # selfApp carries everything self.json declares (stage, the feature flags,
    # presentation, resources) through the shared mapper; layered on here is
    # only what this module alone can know — the local source, the rendered env
    # files, and the auth details that name nix-side machinery.
    fleet.apps.daedalus = selfApp // {
      hostname = if cp.label != null then at cp.label else selfApp.hostname;
      # Serve-both-until-confirmed: after a rename the old address keeps
      # answering, so the operator can never be locked out by a label that does
      # not work. Confirming from the new address clears it (Settings › General).
      hostnameAliases = lib.optional (
        cp.label != null && cp.previousLabel != null && cp.previousLabel != cp.label
      ) (at cp.previousLabel);

      # `fleet.daedalus.source` decides. In dev mode the entry says where the
      # checkout is (a plain string, not a nix path: a path literal would be
      # copied into /nix/store and the container would watch a frozen
      # snapshot). `engineRoot` is a literal rather than derived from
      # `fleet.workspaces` on purpose: the control plane's own source must not
      # depend on the workspace feature it manages.
      source = {
        dev = daedalusDev;
        path = lib.mkIf daedalusDev "${engineRoot}/app";
      };
      image = if builtImage != null then builtImage.image else config.fleet.daedalus.image;
      # The registry poll redeploys on a moved digest, which only a pulled image
      # has: an image built on the box moves with the engine rev, through the
      # rebuild that brings it.
      deploy.enable = source == "published";

      # The dashboard keys this module renders from its own store, then the
      # env file each stack renders for it (fleet.dashboard.<id>.envFiles:
      # LITELLM_API_KEY, DASH_POCKETID_KEY, DEPLOY_HOOK_TOKEN — every one a
      # copy the owning stack makes of its own secret).
      environmentFiles = [
        "/run/daedalus-dashboard/env"
      ]
      ++ lib.concatMap (d: d.envFiles) dashboard;

      # mode/isolated/healthPath arrive from self.json via the mapper.
      # Forward-auth, because daedalus has no user model of its own and only
      # ever serves one operator — the Pocket ID gate belongs in front of it
      # rather than inside it. `isolated` puts it on a private iso-daedalus-net
      # bridge with traefik, off traefik-net; the proxy proof (above) is what
      # makes the headers trustworthy, since the app shares two more bridges.
      # `healthPath` is the one unauthenticated path — it backs the gatus probe
      # and the forward-auth bypass.
      auth = selfApp.auth // {
        # Who applied. An Apply writes a git commit, so the commit should name a
        # person rather than "daedalus". Trusting a header requires that nothing
        # else can forge one: the app reads these only on a request that carries
        # traefik's proxy proof (core/auth.ts), and the strip middleware blanks
        # any client-sent copy before the gate.
        headers = {
          "X-Forwarded-Email" = "{{ .claims.email }}";
          # Pocket ID's user id. The Profile page finds the signed-in account
          # by it, because unlike the email it survives the person editing it.
          "X-Forwarded-User" = "{{ .claims.sub }}";
          # Which Pocket ID groups the session carries, as a JSON array —
          # `mapToJsonArray` is the plugin's own helper, because Go renders a
          # bare []interface{} as `[admins family]`, which is neither JSON nor
          # comma-separated. The app parses it into the Actor and refuses a
          # mutation from someone outside `admins`.
          #
          # This is defence in depth, not the gate. The gate is one layer
          # earlier: the derived Pocket ID client allows `authGroups`, which
          # defaults to [ "admins" ], so a non-admin never gets a session and
          # the app never sees the request. What the header adds is a second
          # check at the thing that actually writes, and an audit trail — the
          # proxy proof is what makes it trustworthy, and the strip middleware
          # blanks it inbound.
          #
          # NOTE: the plugin only sets headers on gated paths, so every path in
          # authBypassRule below arrives with this blanked. /api/deploy carries
          # its own X-Deploy-Token and /mcp its own bearer token; neither must
          # ever be behind the group check, and neither reads this header — the
          # MCP writes are authorised by the token and recorded under its label
          # (core/authz.ts assertMachineActor).
          "X-Forwarded-Groups" = "{{ .claims.groups | mapToJsonArray }}";
        };
        # Five paths skip the Pocket ID gate, for the same reason healthPath
        # does — whatever fetches them cannot hold a passkey:
        #
        #   /api/deploy — zot's push events (modules/registry). Carries its own
        #                 auth instead: X-Deploy-Token, checked in the route
        #                 against DEPLOY_HOOK_TOKEN (the registry's envFiles
        #                 contribution), and it can do exactly
        #                 one thing — start an existing app's deploy unit.
        #
        #   /mcp        — the engine's MCP server, for Claude Code sessions ON
        #                 THIS BOX. Same posture as /api/deploy and for the same
        #                 reason: an agent cannot complete a passkey redirect.
        #                 The token IS the authentication on this path — a scoped
        #                 credential minted in Settings › Developer, stored only
        #                 as a SHA-256 digest, compared in constant time BEFORE
        #                 any work, and fail-closed (no token minted means every
        #                 request is refused; there is no "unconfigured is open"
        #                 state). Read tokens reach the loaders; a write token
        #                 also reaches build / cancel / deploy / image-pin /
        #                 Apply, through the same host flows the buttons use.
        #
        #                 Why the bypass is acceptable for a WRITE-capable path:
        #                 it is LAN-only — daedalus is `stage = "lab"`, so there
        #                 is no Cloudflare tunnel route and no public name — and
        #                 the token is checked before any work, whoever dials.
        #                 Deliberately NOT
        #                 registered in `fleet.mcpServers`: fronting it with the
        #                 LiteLLM gateway would hand a control plane that can
        #                 rebuild this box to Open WebUI, to every virtual key,
        #                 and — through `fleet.litellmKeys.claude.mcpServers` —
        #                 potentially to an off-box Claude key. That is a wider
        #                 blast radius than the control plane's own UI has.
        #
        #   the icons   — iOS fetches the apple-touch-icon when a page is added
        #                 to the home screen, and that fetch does not carry the
        #                 forward-auth session cookie. Gated, it is answered with
        #                 a 302 to the IdP, iOS reads HTML where it wanted a PNG,
        #                 and the home screen gets a generic letter tile instead.
        #                 The other two are here so a favicon behaves the same way
        #                 in any client that requests it outside a page load.
        #
        #   /api/agent/enroll — where a machine's agent service redeems its log-in
        #                 (the agent's enroll.rs): a root service with no browser
        #                 session behind it. It authenticates itself: a single-use
        #                 code minted minutes earlier by the operator's Confirm on
        #                 the gated enroll page, bound to the PKCE challenge the
        #                 agent sent there, redeemed only with the matching verifier
        #                 (S256) — so a code seen in transit is useless.
        #
        # A bypassed path is effectively public on the LAN, so each is written to
        # deserve it: three of these are the app's own artwork and the other
        # three authenticate themselves. Everything else on this app still needs a
        # passkey.
        authBypassRule = "Path(`/api/deploy`) || PathPrefix(`/mcp`) || Path(`/icon.svg`) || Path(`/icon.png`) || Path(`/apple-icon.png`) || Path(`/api/agent/enroll`)";
      };

      # The build log mount (volumes below) exists only once the App does, like
      # /github; BUILD_LOGS_PATH rides the same condition. mkMerge, not `//`,
      # for the stacks' contributions: a name two of them both set (or one of
      # them and this block) is a conflicting definition, never a silent
      # override.
      env = lib.mkMerge (
        map (d: d.env) dashboard
        ++ [
          (lib.optionalAttrs haveGithubApp {
            BUILD_LOGS_PATH = "/builds";
            # The builder's machinery, from daedalus-builder-snapshot.
            BUILDER_FACTS_PATH = "/builder/builder.json";
          })
          {
            # Reached over the `monitoring` bridge added above.
            PROMETHEUS_URL = "http://prometheus:9090";
            LOKI_URL = "http://loki:3100";
            # The registry nix last built: a stable path refreshed by
            # daedalus-registry-snapshot on every rebuild — so an Apply updates it
            # WITHOUT restarting this app.
            NIX_REGISTRY_PATH = "/export/applied.json";
            # The fleet.export domains (platform/export.nix): the fleet facts the
            # pages render.
            EXPORT_DIR = "/export";
            # The box's identity, read at RUN time (engine: src/host/site.ts) and
            # handed to the browser by the root loader. Not VITE_-prefixed any
            # more: Vite inlined those into the bundle, which made a built image
            # right for exactly one box. This is what lets the app carry no
            # hostname literals.
            # The per-service ones (REGISTRY_HOST, GRAFANA_URL,
            # REGISTRY_URL, PIHOLE_URL) arrive through fleet.dashboard from the
            # stack that owns each hostname, so a stack that is off leaves no
            # dangling address here.
            BASE_DOMAIN = config.fleet.baseDomain;
            GITHUB_OWNER = config.fleet.github.owner;
            # Where apply requests are dropped for the host agent.
            APPLY_DIR = "/apply";

            # The GitHub App. hooks.<baseDomain> is the webhook's public name: Vite
            # 403s any Host it was not told about (vite.config.ts allowedHosts,
            # comma-separated), so the cfweb router (daedalus-github.nix) would reach a server that
            # refuses it.
            APP_EXTRA_HOSTS = hooksHost;
            # This box's apply agent accepts vault/github-app.sops and nix consumes
            # it, so the engine may offer to create the App.
            GITHUB_APP_ENABLED = "1";
            # The token minter's installation.json and the webhook secret's dir.
            # Both mounts exist only once the App does (volumes below); until then
            # the engine reads their absence as "no App yet".
            GITHUB_TOKEN_PATH = "/github-token/installation.json";
            GITHUB_APP_DIR = "/github";

            # Dashboard: the non-secret half of what the DNS panel needs. The token
            # rides the rendered env file below; this is an identifier that appears
            # in the public dashboard URLs anyway. The box's zone (site.json); the
            # account and tunnel ids beside it are the tunnel's business and arrive
            # from modules/cloudflared through fleet.dashboard while it runs.
            CF_ZONE_ID = config.fleet.cloudflare.zoneId;
            # The product name, and ONLY that. The router serves no API, but its
            # login page carries a build stamp — model, hardware revision, firmware,
            # build date — so all four of those are read off the device and a
            # firmware bump reaches the tab with nothing edited here. What the stamp
            # does not carry is the name printed on the box, which is this.
            ROUTER_PRODUCT = config.fleet.daedalus.routerProduct;
            # Two URLs for one device, and the split is the point rather than an
            # oversight. The read is a machine fetching an unauthenticated login
            # page: the router's TLS is a self-signed certificate, so HTTPS there
            # would have to be verification-disabled, which buys nothing over plain
            # HTTP for a page that carries no secret. The LINK is a person about to
            # type an admin password, where TLS is the whole point. Both interpolate
            # the same gateway option, so neither can drift from the other.
            ROUTER_URL = "http://${config.fleet.gateway}";
            ROUTER_ADMIN_URL = "https://${config.fleet.gateway}/webpages/index.html#/login";
            # The box's own addresses (LAN IP, gateway, the split-horizon WAN name)
            # and its timezone are facts the pages render: they ride
            # /export/site.json, not env.
            # Per-service versions still read by name (FACTORIO_VERSION, …) are
            # each stack's own fleet.dashboard contribution (see its `env`
            # description in platform/export.nix); pinned tags ride
            # /export/images.json. The labels baked into the images on disk —
            # the version answer for services whose pin is a moving tag —
            # arrive as a snapshot:
            IMAGE_LABELS_PATH = "/images/labels.json";
            # The project workspaces snapshot (clones under ~/projects), published
            # by daedalus-workspace-{publish,sync}. The ROOT is bound too, display
            # only — the page says where a clone landed without restating the path.
            WORKSPACES_PATH = "/workspaces/workspaces.json";
            WORKSPACE_ROOT = workspaceRoot;
            # Digest-vs-tag freshness, published daily by daedalus-image-freshness
            # into the same read-only mount.
            IMAGE_FRESHNESS_PATH = "/images/freshness.json";
            HOST_FACTS_PATH = "/system/system.json";
            REPO_FACTS_PATH = "/repo/repo.json";
            # The committed site.json, for the diff preview and for editing: the
            # directory itself, read-only, never the repository root.
            SITE_PATH = "/site";

            # The controller's local API (controller.nix), mounted below. Not
            # read yet: the app moves its machine reads onto it next.
            CONTROLLER_SOCKET = "/controller/api.sock";

            # The VPN tunnels, the DNS upstreams, the DHCP scope and direct ingress
            # all moved to /export domains (publishing.json, network.json) — fleet
            # facts pages render, which is exactly what env is NOT for. What stays
            # here is config: how the ddns job is set up, read from the service
            # definition so a change to the poll interval cannot leave a stale
            # number on a page.
            DDNS_HOST = lib.head (config.services.ddclient.domains ++ [ "" ]);
            DDNS_INTERVAL = config.services.ddclient.interval;
            DDCLIENT_VERSION = config.services.ddclient.package.version;
          }
        ]
      );
    };

    # The tunnel registry rides the publishing domain (platform/export.nix); the
    # derivation stays HERE because the tenant list comes from each container's
    # own --network=container: flag, which this module already reads.
    fleet.export.domains.publishing.data.vpnEgress = vpnEgress;

    # What only Nix knows about the app registry (app/src/host/contract/domains/
    # apps.ts): the hand-declared apps — only daedalus itself, from `self`, and
    # therefore not editable from the UI — and operatorSecretApps. The committed
    # registry itself arrives beside it as /export/applied.json.
    fleet.export.domains.apps.data = {
      nixManaged.daedalus = self;
      inherit operatorSecretApps;
    };

    # Same list-merge idiom stacks/litellm uses to add its token mount to
    # prometheus: the stack that OWNS the file contributes the mount, rather
    # than the apps platform learning about daedalus.
    # Gated on the apps switch for the reason on bridgeMemberships above — and at
    # the `containers` level: a `mkIf false` one level down would still create
    # an `app-daedalus` entry with no image.
    virtualisation.oci-containers.containers = lib.mkIf appsOn {
      app-daedalus.volumes = [
        # The fleet.export domains (platform/export.nix): versioned, stamped JSON
        # per domain at a STABLE path — the publisher re-runs on change, the
        # container just reads new bytes, so no fact nix hands the app
        # restarts it.
        "/run/daedalus-export:/export:ro"
        "${applyDir}:/apply"
        # Last deploy result per app, written by app-<name>-deploy.service
        # (`<digest> ok|failed`). Read-only, and the DIRECTORY rather than the
        # files, so a rewritten state file is picked up without pinning an inode.
        "/var/lib/app-deploy:/deploy-state:ro"
        # The DIRECTORY, not the files: the snapshot rewrites each one, and a
        # single-file bind would pin the old inode.
        "${envDir}:/env-snapshot:ro"
        # Running image labels, published by daedalus-image-snapshot. The
        # DIRECTORY, not the file, for the same reason as above: the snapshot is
        # replaced by rename and a single-file bind would pin the old inode.
        "${imageDir}:/images:ro"
        # SMART, pools, snapshots, replication and generations, published by
        # daedalus-system-snapshot. Read-only, and no secret in it — the closest
        # thing is a drive serial, which is printed on the drive.
        "${systemDir}:/system:ro"
        # The configuration repository's state, published by
        # daedalus-repo-snapshot. Facts about the repo, never the repo: a
        # checkout can hold untracked or gitignored plaintext.
        "${repoDir}:/repo:ro"
        # site/ — the one directory daedalus writes — read-only here: the app
        # reads the committed site.json to edit against; the writes go through
        # the bridge as ever.
        "${config.fleet.site.path}:/site:ro"
        # The project workspaces snapshot — live git facts for every clone under
        # ~/projects plus each one's last sync outcome. The DIRECTORY, not the
        # file, like every snapshot here: it is replaced by rename and a
        # single-file bind would pin the old inode.
        "${workspacesDir}:/workspaces:ro"
        # The controller's socket directory (controller.nix): the DIRECTORY,
        # which holds the socket alone — the agent removes and remakes the
        # socket at each start, and a single-file bind would pin the dead one.
        # Read-write, because connecting to a unix socket is a write. tmpfiles
        # makes it before any unit starts, so the bind source exists even while
        # the controller is down; who may connect is the agent's peer check.
        "${controllerDir}:/controller"
      ]
      # The GitHub App's two read-only mounts, only once the App exists: a bind of
      # a missing source fails the whole container start. The DIRECTORIES, never
      # the files — both are replaced by rename or re-render.
      ++ lib.optionals haveGithubApp [
        # The webhook secret, alone (daedalus-github-render). Never the key.
        "${githubRenderDir}:/github:ro"
        # installation.json, from daedalus-github-token.
        "${githubTokenDir}:/github-token:ro"
        # The box builds' logs (daedalus-build, build-agent.nix): root-written,
        # already redacted, on the root filesystem so this mount never waits for the
        # builder's dataset. The directory, not a file — logs come and go.
        "${config.fleet.builder.logDir}:/builds:ro"
        # The builder's machinery (daedalus-builder-snapshot): exit codes, sizes,
        # versions and unit states — nothing secret. The directory, like every
        # snapshot mount.
        "${builderDir}:/builder:ro"
      ]
      # What the stacks mount into the control plane (fleet.dashboard.<id>.volumes):
      # pi-hole's rendered DHCP reservations at /dhcp, shotter's run archive at
      # /shotter. Each is the owner's contribution, absent with the owner.
      ++ lib.concatMap (d: d.volumes) dashboard
      # Dev mode: the whole engine checkout, read-only, for the app's tests run
      # inside the container (`pnpm vitest run`), which read files beside app/
      # (the example host's site/, host/build.sh, the Dockerfile). /app is a
      # bind of that clone's app/ subdirectory, so nothing above it is
      # reachable without this. The DIRECTORY: git replaces a file on every pull
      # and a single-file bind would pin the old inode.
      ++ lib.optional daedalusDev "${engineRoot}:/engine:ro";

      # Every source runs as container uid 0 — the operator on the host, who
      # owns /apply (the one writable mount) and the controller's socket
      # directory; the image's own `node` user owns nothing here. Dev mode
      # gets the same flag from `source.dev` (modules/apps).
      app-daedalus.extraOptions = lib.optional (!daedalusDev) "--user=0:0";
    };

    # An image built on the box is built before the container starts
    # (mkLocalImage's `gates`); a host on the published image builds nothing.
    systemd.services.app-daedalus-image-build = lib.mkIf (
      appsOn && builtImage != null
    ) builtImage.service;

    # `local` builds BEFORE the switch, as one of the new generation's own
    # pre-switch checks. Left to the unit above, the build would run in the
    # switch's start phase, after the stop phase has already taken the old
    # container down: minutes of no control plane on every engine bump, and
    # none at all when the build fails, since the new tag would name no image.
    # Here, a failed build refuses the switch with nothing stopped, the
    # previous image keeps running, and a good one leaves the unit a cache
    # hit. Skipped when the tag already exists — it names its context, so an
    # Apply that does not move the engine costs one lookup. Run for `boot`
    # too, so the first start after the reboot does not wait on the mirror.
    # As the operator: the image lives in their rootless store. Checks run in
    # name order, hence the `z`: after the upgrade guard and the inhibitors, so
    # a switch they refuse builds nothing.
    system.preSwitchChecks.z-daedalus-image = lib.mkIf (appsOn && source == "local") ''
      case "''${2:-}" in
        dry-activate) exit 0 ;;
      esac
      ${pkgs.util-linux}/bin/setpriv --reuid ${config.fleet.operator.user} --regid ${config.fleet.operator.group} --init-groups --inh-caps=-all \
        ${pkgs.coreutils}/bin/env HOME=${config.fleet.operator.home} XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir} PATH=/run/wrappers/bin \
        ${pkgs.writeShellScript "app-daedalus-image-prebuild" ''
          ${pkgs.podman}/bin/podman image exists ${localImage.image} ||
            exec ${localImage.service.serviceConfig.ExecStart}
        ''}
    '';

    # Its base on System › Updates: the Dockerfile's node, every stage of it. A
    # different node pin from the build checks' (build-agent.nix), bumped
    # apart.
    fleet.manualPins = lib.mkIf (appsOn && builtImage != null) {
      app-daedalus-node = {
        image = lib.removePrefix "ARG NODE_IMAGE=" nodeImageLine;
        containers = [ "app-daedalus" ];
        upstream = "nodejs/node";
        pinnedIn = "Dockerfile";
      };
    };

    # The fleet's per-service read-only API keys — the credentials daedalus reads
    # other services' numbers with.
    #
    # `fleet.daedalus.serviceKeysSopsFile` (the host's file) is the store: one encrypted file, all the keys minted by
    # some OTHER service and handed to the control plane to read with. Three
    # secrets are NOT in it, on purpose, because they already have an encrypted
    # home in the stack that mints them: pocket-id's read-only API key, the
    # litellm master key and the registry's deploy-hook token each reach this
    # container as an env file THAT stack renders (fleet.dashboard.<id>.envFiles
    # — pocket-id-daedalus-key, litellm-daedalus-key, registry-daedalus-token).
    # Nothing in this box's secret tree exists twice; rotation always touches
    # exactly one file, and this module never greps another stack's secret.
    #
    # `grep -m1` on each: a missing key renders empty rather than failing the
    # unit, and the panel that needs it degrades to "no data" instead of taking
    # the whole page down. That is not hypothetical — a key minted by hand in
    # some app's UI is absent until someone goes and mints it.
    #
    # The render dir is deliberately NOT /run/app-daedalus — that is the
    # container unit's RuntimeDirectory, and systemd wipes it when the container
    # stops (the trap that produced nextcloud-redis's 500s).
    sops.secrets."daedalus-service-keys" = mkDotenvSecret config.fleet.daedalus.serviceKeysSopsFile;

    # A rotation of the Cloudflare token (site/vault, rendered by
    # platform/site.nix): re-render the dashboard keys, then restart the app
    # that reads them at start.
    sops.templates."cloudflare-api-token.env".restartUnits = [
      "daedalus-dashboard-keys.service"
      "podman-app-daedalus.service"
    ];

    systemd.services."daedalus-dashboard-keys" =
      let
        store = config.sops.secrets."daedalus-service-keys".path;
        # <n> in the store → DASH_<n> in the container's environment.
        serviceKeys = [
          "JELLYFIN_API_KEY"
          "SONARR_API_KEY"
          "RADARR_API_KEY"
          "BAZARR_API_KEY"
          "PROWLARR_API_KEY"
          "SEERR_API_KEY"
          "QBT_USER"
          "QBT_PASS"
          "IMMICH_API_KEY"
          "NEXTCLOUD_KEY"
          "HASS_API_KEY"
          "GROCY_API_KEY"
          "N8N_API_KEY"
          "OPENWEBUI_KEY"
          "CALIBREWEB_USER"
          "CALIBREWEB_PASS"
          "GRAFANA_USER"
          "GRAFANA_PASS"
          "HEALTHCHECKS_API_KEY"
          "WGEASY_USER"
          "WGEASY_PASS"
          # Optional override for the GitHub reads (the add-an-app repo picker
          # and the release-notes panels): a narrow read-only PAT, taking
          # precedence over the App's installation token. Empty by default —
          # see the note after CF_TOKEN below.
          "GITHUB_REPO_TOKEN"
        ];
      in
      mkSecretRender {
        description = "Render the per-service API keys daedalus's dashboard reads";
        gates = [ "podman-app-daedalus.service" ];
        dir = "/run/daedalus-dashboard";
        file = "/run/daedalus-dashboard/env";
        prep = lib.concatStringsSep "\n" (
          map (k: "${k}=$(grep -m1 '^${k}=' ${store} | cut -d= -f2- || true)") serviceKeys
          ++ [
            # The box's one Cloudflare API token, read from its single encrypted
            # home (site/vault, rendered by platform/site.nix — platform, not a
            # stack, which is what makes this a read of the box's own secret
            # rather than another stack's). One token carries every scope
            # daedalus reads with: Zone:Read + DNS for the domain picker and
            # the DNS panel, "Cloudflare One Connector: cloudflared" Read for
            # the tunnel panels. It is DNS-edit-capable (lego and route-sync
            # need that); daedalus only ever GETs with it.
            "CF_TOKEN=$(grep -m1 '^CF_DNS_API_TOKEN=' ${config.fleet.cloudflare.tokenEnvFile} | cut -d= -f2- | tr -d '\"' || true)"
            # No general GitHub token is rendered here, on purpose: the old one
            # was a classic PAT carrying `repo` — read-WRITE on every
            # repository on the account. The GitHub reads use the App's
            # installation token (GITHUB_TOKEN_PATH); GITHUB_REPO_TOKEN above
            # is only the escape hatch for a picker that must list repos the
            # App has not been given, and should be a fine-grained read-only
            # PAT.
          ]
        );
        content = lib.concatStringsSep "\n" (
          map (k: "DASH_${k}=\${${k}}") serviceKeys ++ [ "DASH_CF_API_TOKEN=\${CF_TOKEN}" ]
        );
        # Each read above tolerates a missing key (`|| true`): a panel whose
        # key is absent says "no data" rather than the page failing.
        optional = serviceKeys ++ [ "CF_TOKEN" ];
      };
  };
}
