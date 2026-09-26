# daedalus — the box's own control plane, and the only app on the apps
# platform the box does not build.
#
# Everything else on the platform rides the registry loop: push to main, the
# GitHub App webhook reaches daedalus, `daedalus-build.service` builds the
# image and pushes it to the box's registry, and the deploy that build starts
# runs it. daedalus is the engine itself — this repository — and comes as ONE
# image built from the Dockerfile at the repository root (Dockerfile,
# docker-entrypoint.sh), run one of two ways:
#
#   the published image (default)   `fleet.daedalus.image`, the engine's own
#                                   ghcr image at the version this rev ships.
#                                   Pinning the engine pins the control plane.
#   dev mode (`fleet.daedalus.dev`)  the image's `runtime` stage, built on the
#                                   box; the engine checkout's app/ mounted at
#                                   /app; Vite serving it. Saving a file IS the
#                                   deploy: no commit, no build, no pull, no
#                                   rebuild. For the host that develops the
#                                   engine.
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
# Which rebuilds matter, in dev mode:
#   <clone>/app/**           → nothing. Vite is watching it.
#   <clone>/app/package.json → `systemctl restart podman-app-daedalus` (re-installs).
#   Dockerfile, docker-entrypoint.sh
#                            → nixos-rebuild (runtime context hash → new image
#                              tag → restart). Nothing else in the repository
#                              reaches that context.
#   this file                → nixos-rebuild.

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
    claudeDir
    repoDir
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
  # the manifest carries what Nix knows — and this belongs on that side.
  #
  # The site directory is handed in rather than derived from the library's
  # location — same argument as the other consumer, spelled out in the library.
  operatorSecretApps = lib.attrNames (
    import ../../platform/lib/operator-secrets-lib.nix {
      inherit lib;
      site = config.fleet.site.source;
    }
  );

  # What only Nix knows, handed to the container as one read-only store file:
  # the hand-declared apps (`nixManaged` — only daedalus itself, from `self`
  # below, and therefore not editable from the UI) and operatorSecretApps.
  #
  # ONLY those. The committed registry (apps.json) deliberately does NOT ride
  # in here: this is a store path bound into the container, so a change to it
  # changes the unit and systemd restarts the app — which, for apps.json,
  # meant every Apply killed the page showing its progress at the "switching"
  # phase. The registry arrives through a stable path instead
  # (daedalus-registry-snapshot, daedalus-snapshots.nix → NIX_REGISTRY_PATH).
  nixManifest = pkgs.writeText "daedalus-nix-manifest.json" (
    builtins.toJSON {
      schemaVersion = 1;
      nixManaged.daedalus = self;
      inherit operatorSecretApps;
    }
  );

  # daedalus's own registry entry — ./self.json, the same entry schema as one
  # apps.json value, mapped through the same platform/lib/registry-lib.nix the
  # committed registry goes through. One schema, one mapper: when the registry
  # grows a field, this entry cannot be the reader that silently drops it.
  #
  # Defined ONCE and consumed twice: by `fleet.apps.daedalus` below, and by the
  # manifest the container reads. As two literals these drift within the hour —
  # the app list rendering one description while the detail page reports
  # another. Restating this is exactly the class of bug daedalus exists to
  # catch, so it does not get to have it.
  #
  # NOT read back out of `config.fleet.apps.daedalus`, which would be the other
  # way to deduplicate: this value feeds a volume on the container that
  # apps.nix generates from `fleet.apps`, and threading the read through that
  # is the loop the apps module's header warns about. A JSON file preserves the
  # no-config-read property — which is also what registry-lib requires of its
  # input.
  # (The one config read below is `fleet.baseDomain`, for the hostname: site.json
  # defines it and nothing under `fleet.apps` feeds it, so it is not that loop —
  # `fleet.apps.daedalus.hostname` already reads it for the Settings label.)
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
  # engine's. It is joined here, BEFORE the mapper and the manifest, so both
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
  # how); the app runs from the bundle inside it. A host that develops the
  # engine runs it in DEV MODE instead (fleet.daedalus.dev): the image's
  # `runtime` stage alone — node, sops, the entrypoint, no bundle — built on
  # the box from a context of exactly the two files that stage reads, so the
  # tag moves when the runtime changes and never when a route is edited; the
  # checkout's app/ is mounted at /app and the entrypoint runs Vite over it.
  # Saving a file is the deploy.
  daedalusDev = config.fleet.daedalus.dev;

  devRuntime = mkLocalImage {
    name = "app-daedalus-dev";
    tagPrefix = "runtime";
    contextDir = lib.fileset.toSource {
      root = ../../..;
      fileset = lib.fileset.unions [
        ../../../Dockerfile
        ../../../docker-entrypoint.sh
      ];
    };
    file = "Dockerfile";
    target = "runtime";
    gates = [ "podman-app-daedalus.service" ];
  };

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

  options.fleet.daedalus.dev = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = ''
      Run the control plane in DEV MODE: the image's `runtime` stage, built
      on this box from the engine checkout, with that checkout's `app/`
      mounted at /app and Vite serving it. Saving a file is the deploy. For
      the host that develops the engine; every other host runs the published
      image (`fleet.daedalus.image`).
    '';
  };

  options.fleet.daedalus.image = lib.mkOption {
    type = lib.types.str;
    default = "ghcr.io/santiagotoscanini/daedalus:${appVersion}";
    defaultText = lib.literalExpression ''"ghcr.io/santiagotoscanini/daedalus:<app/package.json version>"'';
    description = ''
      The control plane's image, for a host not in dev mode. The default is
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
    # It does cost some of what `auth.isolated` buys: daedalus can now dial
    # prometheus and loki. That is a deliberate trade for real status instead of
    # invented status — the isolation that matters (nothing on traefik-net can
    # reach daedalus) is unaffected, since this only adds outbound reach.
    #
    # Gated on the apps stack's switch, like every definition under another
    # stack's declaration: `fleet.apps.daedalus` is only a declaration, and the
    # `app-daedalus` container exists when the apps stack materializes it. With
    # that stack off (or not on this host yet) a membership for a container
    # nobody creates would fail evaluation on its missing image.
    fleet.bridgeMemberships."app-daedalus" = lib.mkIf appsOn [ "monitoring" ];

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

      # Dev mode or the published image — the option decides; the entry says
      # where the checkout is either way (a plain string, not a nix path: a
      # path literal would be copied into /nix/store and the container would
      # watch a frozen snapshot). `engineRoot` is a literal rather than derived
      # from `fleet.workspaces` on purpose: the control plane's own source must
      # not depend on the workspace feature it manages.
      source = {
        dev = daedalusDev;
        path = lib.mkIf daedalusDev "${engineRoot}/app";
      };
      image = if daedalusDev then devRuntime.image else config.fleet.daedalus.image;

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
      # rather than inside it, zero app-side auth code. `isolated` puts it on a
      # private iso-daedalus-net bridge with traefik as the only other member,
      # so nothing on traefik-net can dial the dev server directly and skip the
      # gate. `healthPath` is the one unauthenticated path — it backs the gatus
      # probe and the forward-auth bypass.
      auth = selfApp.auth // {
        # Who applied. An Apply writes a git commit, so the commit should name a
        # person rather than "daedalus". Trusting a header requires that nothing
        # else can dial the app and forge one — which is exactly what `isolated`
        # above guarantees, and why the platform asserts the two go together.
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
          # check at the thing that actually writes, and an audit trail —
          # `isolated` above is what makes it trustworthy, since only traefik
          # can reach the app and the strip middleware blanks it inbound.
          #
          # NOTE: the plugin only sets headers on gated paths, so every path in
          # authBypassRule below arrives with this blanked. /api/deploy carries
          # its own X-Deploy-Token and /mcp its own bearer token; neither must
          # ever be behind the group check, and neither reads this header — the
          # MCP writes are authorised by the token and recorded under its label
          # (core/authz.ts assertMachineActor).
          "X-Forwarded-Groups" = "{{ .claims.groups | mapToJsonArray }}";
        };
        # Six paths skip the Pocket ID gate, for the same reason healthPath
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
        #                 `isolated = true` means traefik is the only thing that
        #                 can dial this container at all. Deliberately NOT
        #                 registered in `fleet.mcpServers`: fronting it with the
        #                 LiteLLM gateway would hand a control plane that can
        #                 rebuild this box to Open WebUI, to every virtual key,
        #                 and — through `fleet.litellmKeys.claude.mcpServers` —
        #                 potentially to an off-box Claude key. That is a wider
        #                 blast radius than the control plane's own UI has.
        #
        #   /api/nodes/hello — the agent on another machine announcing itself
        #                 (agent/, app/src/routes/api.nodes.hello.ts). A service has
        #                 no passkey, so the path carries its own credential:
        #                 every hello is signed by the ed25519 key the agent made
        #                 at install, the box verifies the bytes, and a stranger
        #                 on the LAN can at most create a pending row an admin
        #                 will look at. No command rides the answer; nothing on
        #                 this path writes anything but that row.
        #
        #   the icons   — iOS fetches the apple-touch-icon when a page is added
        #                 to the home screen, and that fetch does not carry the
        #                 forward-auth session cookie. Gated, it is answered with
        #                 a 302 to the IdP, iOS reads HTML where it wanted a PNG,
        #                 and the home screen gets a generic letter tile instead.
        #                 The other two are here so a favicon behaves the same way
        #                 in any client that requests it outside a page load.
        #
        # A bypassed path is effectively public on the LAN, so each is written to
        # deserve it: three of these are the app's own artwork and the other
        # three authenticate themselves. Everything else on this app still needs a
        # passkey.
        authBypassRule = "Path(`/api/deploy`) || PathPrefix(`/mcp`) || Path(`/api/nodes/hello`) || Path(`/icon.svg`) || Path(`/icon.png`) || Path(`/apple-icon.png`)";
      };

      # The build log mount (volumes below) exists only once the App does, like
      # /github; BUILD_LOGS_PATH rides the same condition. mkMerge, not `//`,
      # for the stacks' contributions: a name two of them both set (or one of
      # them and this block) is a conflicting definition, never a silent
      # override.
      env = lib.mkMerge (
        map (d: d.env) dashboard
        ++ [
          (lib.optionalAttrs haveGithubApp { BUILD_LOGS_PATH = "/builds"; })
          {
            # Reached over the `monitoring` bridge added above.
            PROMETHEUS_URL = "http://prometheus:9090";
            LOKI_URL = "http://loki:3100";
            # What Nix last built. Two files, because they change at different rates:
            # the manifest is a store path (hand-written entries, rarely moves), the
            # snapshot is a stable path refreshed by daedalus-registry-snapshot on
            # every rebuild — so an Apply updates it WITHOUT restarting this app.
            NIX_MANIFEST_PATH = "/registry/manifest.json";
            NIX_REGISTRY_PATH = "/export/applied.json";
            # The fleet.export domains (platform/export.nix) — the successor to the
            # manifest and the env blobs; readers flip domain by domain.
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
            # The default route, which is the router. Bound from the site's gateway
            # (site.nix, from site.json) — the one place that says where this box
            # sends everything it cannot deliver itself, so no second copy can drift.
            GATEWAY_IP = config.fleet.gateway;
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
            # What nearly every pi-hole hosts entry points at. Bound from the option
            # that GENERATES those entries, so "this one points somewhere else" stays
            # a real distinction instead of a comparison against a stale literal.
            LAN_IP = config.fleet.lanIp;
            # The one address the game servers are reached by — the same string from
            # the sofa and from a hotel, because pi-hole answers it with the LAN
            # address and Cloudflare with the WAN one. Bound rather than typed so
            # the page cannot print a hostname this box no longer maintains.
            WAN_HOST = config.fleet.wanHost;
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
            # Where the MCP server finds ARCHITECTURE.md and BUILDS.md — the engine
            # repo root, read-only (volumes below). Named rather than hard-coded in
            # the app so the mount point is one fact, stated here.
            ENGINE_DOCS_DIR = "/engine";
            # Digest-vs-tag freshness, published daily by daedalus-image-freshness
            # into the same read-only mount.
            IMAGE_FRESHNESS_PATH = "/images/freshness.json";
            HOST_FACTS_PATH = "/system/system.json";
            CLAUDE_FACTS_PATH = "/claude/claude.json";
            REPO_FACTS_PATH = "/repo/repo.json";
            # The committed site.json, for the diff preview and for editing: the
            # directory itself, read-only, never the repository root.
            SITE_PATH = "/site";

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

    # Same list-merge idiom stacks/litellm uses to add its token mount to
    # prometheus: the stack that OWNS the file contributes the mount, rather
    # than the apps platform learning about daedalus.
    # Gated on the apps switch for the reason on bridgeMemberships above — and at
    # the `containers` level: a `mkIf false` one level down would still create
    # an `app-daedalus` entry with no image.
    virtualisation.oci-containers.containers = lib.mkIf appsOn {
      app-daedalus.volumes = [
        "${nixManifest}:/registry/manifest.json:ro"
        # The fleet.export domains (platform/export.nix): versioned, stamped JSON
        # per domain at a STABLE path — the publisher re-runs on change, the
        # container just reads new bytes. This is the successor to both the
        # manifest above and the per-fact env blobs; readers flip domain by
        # domain, then the old channels are deleted.
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
        # Remote Control's state, its live sessions and the credential clock,
        # published by daedalus-claude-snapshot. Read-only, and the credential
        # block in it is four non-secret fields copied out by name — the tokens
        # beside them in ~/.claude/.credentials.json never enter this file.
        #
        # The directory is 0700 and the file 0600, operator-owned: the one
        # snapshot here that carries a line of session content (the last prompt,
        # redacted host-side) is not readable by the build user or by anything
        # else on the box. This mount still works because the container runs as
        # container uid 0 = the operator on the host.
        "${claudeDir}:/claude:ro"
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
        # The ENGINE repository — the public one the dev server already runs from,
        # read-only, so the MCP server can hand an agent the two design documents
        # at its repo root (ARCHITECTURE.md, BUILDS.md) before it acts. /app is a
        # bind of that clone's app/ subdirectory, so nothing above it is reachable
        # without this.
        #
        # The DIRECTORY, never the two files: git replaces a file on every pull and
        # a single-file bind would pin the old inode — the same rule every snapshot
        # mount here follows. Widening the mount does NOT widen what is served: the
        # app reads a hard allowlist of two names (host/mcp/docs.ts), there is no
        # path parameter, and this is the public engine repo, not this one.
        "${engineRoot}:/engine:ro"
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
      ]
      # What the stacks mount into the control plane (fleet.dashboard.<id>.volumes):
      # pi-hole's rendered DHCP reservations at /dhcp, shotter's run archive at
      # /shotter. Each is the owner's contribution, absent with the owner.
      ++ lib.concatMap (d: d.volumes) dashboard;
    };

    # Dev mode builds the runtime stage on the box before the container starts
    # (mkLocalImage's `gates`); a host on the published image builds nothing.
    systemd.services.app-daedalus-image-build = lib.mkIf (appsOn && daedalusDev) devRuntime.service;

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
      };
  };
}
