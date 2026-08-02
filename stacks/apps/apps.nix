# apps — vibe-coded app wrapper.
#
# Each entry in `fleet.apps` materializes:
#   - A container `app-<name>` on `traefik-net`, listening on the
#     hardcoded internal port 3000. Also joins the shared `app-db-net`
#     bridge when `postgres.enable = true` (dials the shared `pg`
#     cluster there — see stacks/app-db/).
#   - A webApp at `<name>.toscanini.me`. `stage = "live"` flips
#     exposeRemotely so cloudflared-route-sync upserts the public CNAME.
#   - (Opt-in, `prometheus.enable`) scrape on the app's own /metrics,
#     plus the per-app Grafana dashboard (in the "Apps" folder) when
#     one is supplied. Postgres metrics are separate — the shared
#     `app-db-exporter` (stacks/app-db/) covers them either way.
#   - Homepage tiles under a per-app section named after the app (e.g.
#     `Anansi`): the app, Repo, Logs.
#   - An auto-deploy timer + oneshot (`deploy.enable`, ON by default) that
#     polls the image registry and redeploys the container when the digest
#     moves. This is the "push to main and it's live" half of the platform;
#     see assets/deploy.sh for why an explicit pull is unavoidable.
#
# Convention enforced: every app container LISTENS ON PORT 3000.
# No per-app port override. The image is built by us; the rule is ours.
#
# Naming: the declaration key (e.g. `anansi`) is used verbatim for the
# hostname `anansi.toscanini.me`, the homepage group (capitalized:
# `Anansi`), the dashboard tag, the container name `app-anansi`, the
# postgres role + database `anansi` on the shared cluster (when
# `postgres.enable`), and the canonical source-code directory at
# /home/santiago/apps/anansi/.
#
# Image default: `registry.toscanini.me/<name>:latest` — the box's own
# zot (stacks/registry), fed by CI on the self-hosted runners. Override
# for forks or pinned digests.
#
# Database: `postgres.enable = true` materializes a role + database
# on the shared `pg` cluster via stacks/app-db/. App reads
# `DATABASE_URL` from the bootstrap-generated env file
# (postgresql://<name>:<pwd>@pg:5432/<name>).
#
# Baseline secrets (always-on per app):
#   - AUTH_SECRET — random hex32, generated at first boot by
#     app-<name>-secrets-bootstrap.service, written to
#     /etc/nixos/stacks/apps/secrets/<name>/env (mode 0600, gitignored).
#     The app uses it for session signing / JWT / CSRF / etc.
#
# Optional features (opt-in; `false` by default):
#   - postgres.enable   → injects DATABASE_URL (+ POSTGRES_*)
#   - storage.enable    → bind-mounts a persistent data dir at /app/data
#   - litellm           → injects LITELLM_BASE_URL
#   - prometheus.enable → /metrics scrape + per-app Grafana dashboard
#   - auth.mode         → SSO against Pocket ID, either shape (below)
#   - …future features follow the same pattern (off by default,
#     env injection conditional on opt-in).
#
# SSO — `auth.mode`, one option covering both shapes:
#
#   "proxy"  — traefik's forward-auth middleware gates the router; the
#              app never learns there is an IdP. For apps with no user
#              model of their own (ipcrawl). Zero app-side work.
#   "native" — the app IS the OIDC client: it gets OIDC_ISSUER_URL,
#              OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_PROVIDER_ID,
#              OIDC_SCOPES in its environment and OIDC_CLIENT_SECRET in
#              an env file. For apps with accounts of their own
#              (anansi), which keep per-user data isolation.
#
# Either way the client itself is declared, not clicked: the entry
# materializes `fleet.ssoClients.<name>` (stacks/pocket-id/clients.nix),
# whose oneshot creates/updates it at the IdP with the id and secret
# this repo chose. Adding SSO to an app is one option plus one key in
# stacks/pocket-id/clients.sops.
#
# Convention enforced #2: an app that needs a disk writes it to
# /app/data. Same reasoning as the port — we build the images, so we
# pick the path. `storage.enable = true` bind-mounts
# /home/santiago/selfhost/apps/<name>/data there (overridable via
# storage.hostPath); fleet.statePaths pre-creates it `santiago:users`, which is
# what container UID 0 maps to under rootless podman. This is what
# SQLite / file-backed apps need; Postgres apps use postgres.enable
# instead, and an app can use both.
#
# Environment plumbing — fully declarative:
#
#   environmentFiles = [
#     /etc/nixos/stacks/apps/secrets/<name>/env    # always (AUTH_SECRET)
#     /etc/nixos/stacks/app-db/secrets/<name>/env  # when postgres=true
#     <user-supplied per-app overlays>             # via .environmentFiles
#   ];
#   environment = {
#     APP_NAME, APP_HOSTNAME, APP_PUBLIC_URL, PORT     # always
#     LITELLM_BASE_URL = http://litellm:4000           # when litellm = true
#     <user-supplied static env>                       # via .env
#   };

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  cfg = config.fleet.apps;

  appSecretsBase = "/etc/nixos/stacks/apps/secrets";
  appDbEnvBase = "/etc/nixos/stacks/app-db/secrets";

  # Host tree backing `storage.enable`. One dir per app underneath.
  appsDataRoot = "/home/santiago/selfhost/apps";

  # GHCR classic PAT (read:packages) in podman auth.json form, passed on
  # every pull (container's implicit + the deploy oneshot's explicit).
  # The default images live on the local registry, which the authfile
  # doesn't cover — those pulls ride its anonymous-read policy and the
  # file is inert. It only bites for an `image` override pointing at a
  # private GHCR package; GHCR accepts ONLY a classic PAT there —
  # fine-grained PATs and GitHub App installation tokens are rejected.
  ghcrAuthFile = config.sops.secrets."ghcr-auth".path;

  # Last deploy result per app, `<digest> ok|failed`; a sibling
  # `<name>.pull` marker file means pulls are currently failing (the two
  # axes are independent — see deploy.sh). systemd owns the dir
  # (StateDirectory below); the state file is what keeps a failed deploy
  # loud across subsequent no-op ticks.
  deployStateDir = "/var/lib/app-deploy";

  # The deploy health-check dials traefik at the LAN IP directly rather
  # than trusting DNS, so a pi-hole hiccup can't read as a dead app.
  inherit (config.fleet) lanIp;

  mkApp =
    name: app:
    let
      cName = "app-${name}";
      hostname = "${name}.toscanini.me";
      publicUrl = "https://${hostname}";

      # Baseline (always-on) per-app secrets file.
      appSecretsFile = "${appSecretsBase}/${name}/env";

      postgresEnabled = app.postgres.enable;
      appDbEnvFile = "${appDbEnvBase}/${name}/env";

      storageEnabled = app.storage.enable;
      storageHostPath = app.storage.hostPath;

      # VPN egress: borrow a gluetun container's netns for ALL traffic
      # instead of joining traefik-net (see stacks/ipcrawl-vpn/). The
      # incompatibilities (postgres, prometheus, missing hostPort) are
      # enforced via `assertions` below.
      egressEnabled = app.egress.container != null;

      # SSO. "proxy" = traefik forward-auth in front of the router;
      # "native" = the app is the OIDC client. Both declare the Pocket
      # ID client itself via fleet.ssoClients.
      proxyAuth = app.auth.mode == "proxy";
      nativeAuth = app.auth.mode == "native";
      # Isolation only makes sense for a bridge-routed forward-auth app
      # (see the option's description); egress apps aren't on a bridge.
      isolatedAuth = proxyAuth && app.auth.isolated;
      # Where the IdP sends the browser back. The forward-auth plugin
      # owns /oidc/callback on the app's own hostname; a native app
      # mounts its framework's callback path.
      oidcCallback =
        if proxyAuth then "${publicUrl}/oidc/callback" else "${publicUrl}${app.auth.callbackPath}";

      tileGroup = lib.toSentenceCase name;

      # Pull-and-redeploy. House style (cf. cloudflared-route-sync): nix
      # injects the parameters, the bash body lives in a standalone
      # shellcheckable assets/*.sh. setpriv/env/podman are absolute because
      # the privilege-dropped child doesn't inherit this PATH — see the
      # header of deploy.sh.
      deployScript = pkgs.writeShellApplication {
        name = "app-${name}-deploy";
        runtimeInputs = [
          pkgs.curl
          pkgs.systemd
          pkgs.coreutils
          pkgs.msmtp # send_alert in deploy.sh (transition emails)
        ];
        text = ''
          APP=${lib.escapeShellArg name}
          IMAGE=${lib.escapeShellArg app.image}
          UNIT=${lib.escapeShellArg "podman-${cName}.service"}
          APP_HOST=${lib.escapeShellArg hostname}
          HEALTH_PATH=${
            lib.escapeShellArg (
              # A gated app answers 302-to-the-IdP on "/", which passes
              # (< 500) while certifying the middleware rather than the
              # new image. The auth bypass path is the one URL that
              # still reaches the real upstream, so default to it.
              if app.deploy.healthPath != null then
                app.deploy.healthPath
              else if app.auth.healthPath != null then
                app.auth.healthPath
              else
                "/"
            )
          }
          HEALTH_TIMEOUT=${toString app.deploy.healthTimeout}
          AUTHFILE=${lib.escapeShellArg ghcrAuthFile}
          LAN_IP=${lib.escapeShellArg lanIp}
          STATE=${lib.escapeShellArg "${deployStateDir}/${name}"}
          SETPRIV=${pkgs.util-linux}/bin/setpriv
          ENV_BIN=${pkgs.coreutils}/bin/env
          PODMAN=${pkgs.podman}/bin/podman
          # Deploy-failure alert relay (platform/mail msmtp -> Gmail).
          NOTIFY_FROM=${lib.escapeShellArg config.fleet.mail.sender}
          NOTIFY_TO=${lib.escapeShellArg config.fleet.mail.alertTo}

          ${builtins.readFile ./assets/deploy.sh}
        '';
      };

      homepageTile = {
        inherit name;
        href = publicUrl;
        # traefik-net DNS by default; in egress mode the app isn't on any
        # bridge, so monitor the host port gluetun publishes instead.
        siteMonitor =
          if egressEnabled then
            "http://host.containers.internal:${toString app.egress.hostPort}"
          else
            "http://${cName}:3000";
        inherit (app.homepage) icon;
      }
      // (lib.optionalAttrs (app.homepage.description != "") {
        inherit (app.homepage) description;
      });

      # service_name=<name> is set by alloy for the app-<name> container
      # (see stacks/logging/logging.nix), so Drilldown deep-links to this
      # app's log stream. DB logs live on the shared cluster under
      # stack=app-db.
      logsTile = {
        name = "Logs";
        href = "https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore/service/${name}/logs?from=now-15m&to=now&var-ds=loki-default&var-filters=service_name%7C%3D%7C${name}";
        description = "App logs";
        icon = "/icons/loki.png";
        widget = {
          type = "customapi";
          # sum(count_over_time({service_name="<app>"}[1h])) → vector
          # with [ts, "<count>"] at data.result[0].value. Empty result
          # (no log lines in the last hour) renders blank.
          url = "http://loki:3100/loki/api/v1/query?query=sum%28count_over_time%28%7Bservice_name%3D%22${name}%22%7D%5B1h%5D%29%29%20or%20vector%280%29";
          refreshInterval = 60000;
          mappings = [
            {
              field = "data.result.0.value.1";
              label = "Logs (1h)";
              format = "number";
            }
          ];
        };
      };

      repoTile = {
        name = "Repo";
        href = "https://github.com/santiagotoscanini/${name}";
        description = "Source code (github.com/santiagotoscanini/${name})";
        icon = "mdi-github-#94a3b8";
      };

      # Per-app DB metrics dashboard (only when postgres is enabled).
      # Same shape as logsTile — direct link with `var-app=<name>` so
      # the dashboard template variable lands pre-filtered.
      dbTile = {
        name = "DB";
        href = "https://grafana.toscanini.me/d/pg-overview/postgres?orgId=1&var-app=${name}&refresh=30s";
        description = "Postgres metrics — ${name} DB";
        icon = "/icons/postgres.png";
        widget = {
          type = "customapi";
          # Prometheus pg_database_size_bytes scraped from app-db's
          # postgres-exporter. Empty result (DB not yet created /
          # exporter not scraping) renders blank, which is fine.
          url = "http://prometheus:9090/api/v1/query?query=pg_database_size_bytes%7Bdatname%3D%22${name}%22%7D";
          refreshInterval = 60000;
          mappings = [
            {
              field = "data.result.0.value.1";
              label = "Size";
              format = "bytes";
            }
          ];
        };
      };
    in
    {
      assertions = [
        {
          assertion = !(egressEnabled && postgresEnabled);
          message = "fleet.apps.${name}: `egress` cannot combine with `postgres.enable` — a container sharing gluetun's netns can't also join the app-db-net bridge.";
        }
        {
          assertion = !(egressEnabled && app.egress.hostPort == null);
          message = "fleet.apps.${name}: `egress.container` is set but `egress.hostPort` is null — set the host port the netns owner publishes for this app.";
        }
        {
          assertion = !(egressEnabled && app.prometheus.enable);
          message = "fleet.apps.${name}: `egress` cannot combine with `prometheus.enable` — a netns'd app isn't reachable from monitoring-net, so the scrape target would be permanently down.";
        }
        {
          assertion = app.auth.isolated -> (proxyAuth && !egressEnabled);
          message = "fleet.apps.${name}: `auth.isolated` needs `auth.mode = \"proxy\"` and no `egress` — isolation puts the container on a private bridge whose only other member is traefik, which a netns'd app can't join and a native-OIDC app gains nothing from.";
        }
        {
          assertion = !(app.auth.isolated && app.prometheus.enable);
          message = "fleet.apps.${name}: `auth.isolated` cannot combine with `prometheus.enable` — prometheus dials the app over traefik-net, which isolation removes.";
        }
        {
          assertion = app.auth.headers != { } -> proxyAuth;
          message = "fleet.apps.${name}: `auth.headers` are set by the forward-auth middleware — they only exist under `auth.mode = \"proxy\"`.";
        }
      ];

      # The Pocket ID client for native mode — id `<name>`, secret from
      # SSO_SECRET_<NAME> in stacks/pocket-id/clients.sops. The oneshot
      # in stacks/pocket-id/clients.nix converges it at the IdP and hands
      # the container its OIDC_CLIENT_SECRET env file. Proxy mode
      # declares nothing here: its client is auto-derived from the
      # webApp's `auth = "oidc"`, like every other forward-auth'd app.
      fleet.ssoClients = lib.optionalAttrs nativeAuth {
        "${name}" = {
          displayName = tileGroup;
          description = app.homepage.description;
          launchURL = publicUrl;
          callbackURLs = [ oidcCallback ];
          logoutCallbackURLs = [ oidcCallback ];
          inherit (app.auth) allowedGroups;
          consumers = [ cName ];
        };
      };

      # Delegate per-app Postgres entirely to stacks/app-db/. The
      # presence of the key triggers role + database creation and the
      # per-app env file. LAN access is the single shared
      # `postgres.toscanini.me:5432` TCP/SNI route (stacks/app-db).
      fleet.appDatabases = lib.optionalAttrs postgresEnabled {
        "${name}" = { };
      };

      # Register in bridgeMemberships either way — that's what earns the
      # mandatory Type=oneshot systemd override (rootless podman + Type=notify
      # is broken on this box). "traefik" joins the bridge for DNS routing;
      # `[ ]` means pasta/netns with NO bridge (egress mode borrows gluetun's
      # netns via extraOptions, and traefik reaches it via the published host
      # port — see webApps below). Same shape as the TV stack's `sonarr = [ ]`.
      # `auth.isolated` swaps the shared bridge for a private one; that
      # membership comes from webApps.isolated, and listing "traefik"
      # here as well would re-open the shared path (assertion in
      # platform/publishing.nix).
      fleet.bridgeMemberships."${cName}" =
        lib.optional (!egressEnabled && !isolatedAuth) "traefik"
        ++ lib.optional postgresEnabled "app-db";

      # Web exposure — hardcoded internal port 3000. Bridge-routed by default
      # (serviceName on traefik-net). In egress mode the app can't ride
      # traefik-net, so traefik dials the host port gluetun publishes via
      # host.containers.internal — the same escape hatch the TV stack uses.
      fleet.webApps."${name}" = {
        inherit hostname;
        exposeRemotely = app.stage == "live";
      }
      // (lib.optionalAttrs proxyAuth {
        auth = "oidc";
        isolated = isolatedAuth;
        inherit (app.auth) authBypassRule;
        authHeaders = app.auth.headers;
        # The webApp is where the derived client reads its group
        # restriction from, so proxy mode routes `auth.allowedGroups`
        # through it rather than declaring the client itself.
        authGroups = app.auth.allowedGroups;
      })
      # gatus probes the real upstream on this path either way; under
      # "proxy" it doubles as the middleware's bypass (publishing.nix
      # appends it), which is what keeps the probe off the IdP.
      // (lib.optionalAttrs (app.auth.healthPath != null) { inherit (app.auth) healthPath; })
      // (
        if egressEnabled then
          { serviceUrl = "http://host.containers.internal:${toString app.egress.hostPort}"; }
        else
          {
            serviceName = cName;
            port = 3000;
          }
      );

      # Prometheus scrapes the app's own /metrics endpoint (when
      # prometheus.enable). Postgres metrics come from the single
      # shared `app-db-exporter` declared in stacks/app-db/exporter.nix —
      # the dashboard breaks them out per-app via the `datname` label.
      # No per-app scrape entry here.
      fleet.prometheusScrapes = lib.optional app.prometheus.enable {
        job_name = cName;
        static_configs = [
          {
            targets = [ "${cName}:3000" ];
            labels = {
              app = name;
            };
          }
        ];
        metrics_path = app.prometheus.path;
      };

      # Grafana dashboard in the "Apps" folder (when supplied). Gated on
      # prometheus.enable alongside the scrape: the dashboard is
      # metrics-driven, so without a scrape it would only render empty
      # panels.
      fleet.grafanaDashboardsByFolder =
        lib.optionalAttrs (app.prometheus.enable && app.prometheus.dashboard != null)
          {
            "Apps"."${cName}" = lib.replaceStrings [ "%APP_NAME%" ] [ name ] (
              builtins.readFile app.prometheus.dashboard
            );
          };

      # Homepage tile lands in the per-app section.
      fleet.homepageServices."${tileGroup}" = [
        homepageTile
        repoTile
        logsTile
      ]
      ++ (lib.optional postgresEnabled dbTile);

      # Per-group layout for the dynamically-named app group, so the
      # 3 or 4 tiles render in a row instead of stacking vertically.
      fleet.homepageLayout."${tileGroup}" = {
        style = "row";
        columns = if postgresEnabled then 4 else 3;
        inherit (app.homepage) icon;
        useEqualHeights = true;
        tab = "Apps";
      };

      # Persistent data dir — the fleet-standard statePaths convention
      # (uid 0 default = container root = santiago; state-paths.service
      # sorts paths so parents are created before children, and every
      # podman unit orders after it).
      fleet.statePaths = lib.optionalAttrs storageEnabled (
        lib.optionalAttrs (lib.hasPrefix "${appsDataRoot}/" storageHostPath) {
          "${appsDataRoot}" = { };
          "${appsDataRoot}/${name}" = { };
        }
        // {
          "${storageHostPath}" = { };
        }
      );

      # Baseline secrets bootstrap. Generates AUTH_SECRET on first boot
      # and writes the per-app env file. Idempotent: re-running is safe;
      # the env file is created only if missing. Delete the file +
      # rebuild to rotate (invalidates any sessions/JWTs signed with
      # the old AUTH_SECRET).
      systemd.services."app-${name}-secrets-bootstrap" = {
        description = "Bootstrap app-${name}: generate AUTH_SECRET on first boot";
        before = [ "podman-${cName}.service" ];
        wantedBy = [ "podman-${cName}.service" ];
        after = [ "local-fs.target" ];
        path = [
          pkgs.openssl
          pkgs.coreutils
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          Restart = "on-failure";
          RestartSec = "5s";
        };
        script = ''
          set -eu
          install -d -m 0700 -o santiago -g users "${appSecretsBase}/${name}"
          if [ ! -e "${appSecretsFile}" ]; then
            AUTH_SECRET=$(openssl rand -hex 32)
            install -m 0600 -o santiago -g users /dev/stdin "${appSecretsFile}" <<EOF
          AUTH_SECRET=$AUTH_SECRET
          EOF
          fi
        '';
      };

      # Auto-deploy. Pulls the image; restarts the container only if the
      # digest actually moved; then health-checks it through traefik. Runs as
      # root (it must restart a system unit) and drops to santiago for podman.
      #
      # No RemainAfterExit — unlike every bootstrap oneshot here, this one has
      # to run again on every tick.
      systemd.services."app-${name}-deploy" = {
        inherit (app.deploy) enable;
        description = "Redeploy app-${name} when a new image lands on the registry";
        # linger-users gates /run/user/1000 → rootless podman → newuidmap.
        after = [
          "network-online.target"
          "linger-users.service"
          "podman-${cName}.service"
        ];
        wants = [
          "network-online.target"
          "linger-users.service"
        ];
        serviceConfig = {
          Type = "oneshot";
          StateDirectory = "app-deploy";
          ExecStart = "${deployScript}/bin/app-${name}-deploy";
        };
      };

      systemd.timers."app-${name}-deploy" = {
        inherit (app.deploy) enable;
        description = "Poll the registry for a new app-${name} image";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = app.deploy.interval;
          Persistent = true; # catch up if the box was off
          RandomizedDelaySec = 45; # don't have every app hit the registry on the same second
        };
      };

      # Container ordering: the secrets bootstrap plus (egress mode) the
      # netns owner. The pg + per-app-bootstrap edges are NOT repeated
      # here — appDatabases.consumers already generates both (including
      # the transaction-proof direct podman-pg edge).
      systemd.services."podman-${cName}" = {
        after = [
          "app-${name}-secrets-bootstrap.service"
        ]
        ++ (lib.optional egressEnabled "podman-${app.egress.container}.service");
        wants = [
          "app-${name}-secrets-bootstrap.service"
        ]
        ++ (lib.optional egressEnabled "podman-${app.egress.container}.service");
      };

      # The container itself — pure declarative, identical pattern to
      # every other stack on the box.
      virtualisation.oci-containers.containers."${cName}" = mkRootlessContainer (
        {
          inherit (app) image;

          # A /s2/* hostPath additionally picks up RequiresMountsFor for
          # free — podman.nix extracts it from `volumes`, closing the
          # cold-boot race where the container starts before the ZFS
          # dataset mounts and writes into the empty underlay.
          volumes = lib.optional storageEnabled "${storageHostPath}:/app/data";

          environmentFiles = [
            appSecretsFile
          ]
          ++ (lib.optional postgresEnabled appDbEnvFile)
          ++ app.environmentFiles;

          environment = {
            APP_NAME = name;
            APP_HOSTNAME = hostname;
            APP_PUBLIC_URL = publicUrl;
            PORT = "3000";
            # Auth.js v5 / NextAuth sits behind traefik, so the request
            # Host is the public hostname (anansi.toscanini.me), not the
            # in-container `app-<name>:3000` the framework auto-derives.
            # Without these two, Auth.js bails on every /api/auth/* call
            # with `UntrustedHost`. Set at the platform level since every
            # reverse-proxied app on this PaaS hits the same wall.
            AUTH_TRUST_HOST = "true";
            AUTH_URL = publicUrl;
          }
          // (lib.optionalAttrs app.litellm.enable {
            LITELLM_BASE_URL = "http://litellm:4000";
          })
          # Native OIDC. The client secret is NOT here — it arrives as
          # OIDC_CLIENT_SECRET in a rendered env file that
          # stacks/pocket-id/clients.nix appends to this container (the
          # `consumers` entry above), so it never sits in /nix/store.
          // (lib.optionalAttrs nativeAuth {
            OIDC_ISSUER_URL = config.fleet.sso.issuerUrl;
            OIDC_CLIENT_ID = name;
            OIDC_REDIRECT_URI = oidcCallback;
            OIDC_PROVIDER_ID = app.auth.providerId;
            OIDC_PROVIDER_NAME = "Pocket ID";
            OIDC_SCOPES = app.auth.scopes;
          })
          // app.env;

          extraOptions = [
            "--authfile=${ghcrAuthFile}"
          ]
          ++ (lib.optional egressEnabled "--network=container:${app.egress.container}");
        }
        // (lib.optionalAttrs (app.cmd != null) { inherit (app) cmd; })
        # In egress mode podman needs the netns owner up first; dependsOn
        # adds Requires=+After= on its unit (same as the TV arrs on gluetun).
        // (lib.optionalAttrs egressEnabled { dependsOn = [ app.egress.container ]; })
      );
    };
in
{
  options.fleet.apps = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, ... }: {
          options = {
            image = lib.mkOption {
              type = lib.types.str;
              default = "registry.toscanini.me/${name}:latest";
              description = ''
                OCI image. Default: `registry.toscanini.me/<name>:latest` —
                the box's own zot (stacks/registry). Convention is to host
                each app at `github.com/santiagotoscanini/<name>`; its CI
                builds on the self-hosted runners and pushes the matching
                repo here. Override for placeholders, forks, or pinned
                digests (the immutable `sha-<sha>` tags CI also pushes).
              '';
              example = "registry.toscanini.me/ipcrawl:sha-89dfc4456f8b2c4531f84790cce5e179bdaeae6a";
            };

            cmd = lib.mkOption {
              type = lib.types.nullOr (lib.types.listOf lib.types.str);
              default = null;
              description = ''
                Optional cmd override (escape hatch — apps should normally
                bake their start command into the image CMD).
              '';
            };

            stage = lib.mkOption {
              type = lib.types.enum [
                "lab"
                "live"
              ];
              default = "lab";
              description = ''
                "lab" = LAN-only (<name>.toscanini.me via pi-hole + traefik).
                "live" = adds Cloudflare-tunnel exposure (public CNAME via
                cloudflared-route-sync). The *.toscanini.me wildcard cert
                covers both — no per-app cert work.
              '';
            };

            # VPN egress via a gluetun (or other netns-owning) container. See
            # stacks/ipcrawl-vpn/. When set, the app borrows that container's
            # network namespace for ALL traffic instead of joining traefik-net:
            # outbound exits the VPN (fail-closed), and traefik reaches the UI via
            # the host port the netns owner publishes
            # (`host.containers.internal:<egress.hostPort>`). Mutually exclusive
            # with `postgres.enable` and `prometheus.enable` (a netns'd app
            # isn't scrapable from monitoring-net) — enforced via assertions.
            egress = {
              container = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Name of a netns-owning container (e.g. a gluetun instance)
                  whose network namespace this app joins via
                  `--network=container:<name>`. null = normal traefik-net.
                '';
                example = "gluetun-ipcrawl";
              };
              hostPort = lib.mkOption {
                type = lib.types.nullOr lib.types.port;
                default = null;
                description = ''
                  Host port the netns owner publishes for this app's :3000,
                  which traefik dials via host.containers.internal. Required
                  when `egress.container` is set.
                '';
                example = 3100;
              };
            };

            # Plain Postgres-per-app, materialized by stacks/app-db/.
            postgres = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  When true, materialize a role + database `<name>` on
                  the shared `pg` cluster via stacks/app-db/. The app
                  container joins the shared `app-db-net` bridge and
                  receives DATABASE_URL
                  (postgresql://<name>:<pwd>@pg:5432/<name>) via env
                  file. See stacks/app-db/README.md.
                '';
              };
              # No per-app resource tunables: the cluster is shared, so
              # cpus/memory are set once in stacks/app-db/app-db.nix.
              # For app-scoped throttling, use postgres role-level
              # settings: ALTER ROLE <name> CONNECTION LIMIT N;
              # ALTER ROLE <name> SET statement_timeout = '30s'; etc.
            };

            # Persistent disk for file-backed apps (SQLite, caches, uploads).
            storage = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  When true, bind-mount `storage.hostPath` at `/app/data`
                  inside the container and pre-create it (0755 santiago:users)
                  via fleet.statePaths. Off by default — stateless apps get
                  no disk.

                  /app/data is a convention, not an option, exactly like the
                  port-3000 rule: we build the images, so we pick the path.
                '';
              };
              hostPath = lib.mkOption {
                type = lib.types.str;
                default = "${appsDataRoot}/${name}/data";
                description = ''
                  Host dir backing /app/data. The default sits on
                  `rpool/selfhost` (16K recordsize, frequent+hourly+daily
                  snapshots), which is right for a small SQLite file but
                  expensive for a large, churning blob cache — snapshot
                  deltas balloon. Point high-churn apps at `/s2/<name>`
                  instead (needs a one-time
                  `zfs create -o mountpoint=legacy s2-pool/<name>` plus an
                  entry in platform/zfs.nix).
                '';
              };
            };

            # SSO against Pocket ID. Both shapes declare the client in
            # the same place (fleet.ssoClients) — what differs is who
            # holds the credential: traefik's middleware, or the app.
            auth = {
              mode = lib.mkOption {
                type = lib.types.enum [
                  "none"
                  "proxy"
                  "native"
                ];
                default = "none";
                description = ''
                  "none" — no SSO (the app's own auth, or none at all).

                  "proxy" — traefik's generated `oidc-<name>`
                  forward-auth middleware gates the router(s); the app
                  is never reached unauthenticated and needs no code.
                  For apps with no user model (ipcrawl). Requires
                  `auth.healthPath` (the middleware would otherwise 302
                  every gatus probe to the IdP).

                  "native" — the app is the OIDC client itself. It
                  receives OIDC_ISSUER_URL, OIDC_CLIENT_ID,
                  OIDC_REDIRECT_URI, OIDC_PROVIDER_ID, OIDC_PROVIDER_NAME
                  and OIDC_SCOPES in its environment, plus
                  OIDC_CLIENT_SECRET from a rendered env file. Preferred
                  whenever the app HAS accounts, since only the app can
                  map an IdP identity onto its own per-user data
                  (AUTH.md's order of preference).
                '';
              };
              allowedGroups = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ "admins" ];
                description = ''
                  Pocket ID group names allowed to use this client —
                  authorization enforced at the IdP, before the app.
                  Admin-only by default; add "family" for shared apps.
                  `[ ]` means any account with a passkey gets in.
                '';
              };
              healthPath = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Unauthenticated path that proves the app itself is
                  serving. Becomes the webApp's gatus probe, the
                  forward-auth bypass (proxy mode), and the auto-deploy
                  health check — so a redeploy is certified by the app
                  rather than by a 302 to the IdP. Mandatory under
                  `mode = "proxy"`.
                '';
                example = "/api/healthz";
              };
              authBypassRule = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Extra traefik rule expression whose matches skip the
                  forward-auth middleware — for machine endpoints that
                  carry their own auth. Proxy mode only.
                '';
                example = "PathPrefix(`/api`)";
              };
              headers = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
                description = ''
                  Identity headers the middleware forwards upstream
                  (name -> Go template over claims). Proxy mode only,
                  and empty by default: an app that trusts a header
                  blindly should also set `auth.isolated`, since any
                  container on traefik-net could otherwise dial it
                  directly and forge one.
                '';
                example = lib.literalExpression ''
                  { "X-Forwarded-Email" = "{{ .claims.email }}"; }
                '';
              };
              isolated = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Move the container off traefik-net onto a private
                  `iso-<name>-net` bridge whose only other member is
                  traefik, so the forward-auth middleware is the only
                  possible caller. The right default for any app using
                  `auth.headers`; incompatible with `egress` and
                  `prometheus.enable`.
                '';
              };
              providerId = lib.mkOption {
                type = lib.types.str;
                default = "pocket-id";
                description = ''
                  Native mode: the provider id the app registers Pocket
                  ID under. Frameworks derive the callback path from it
                  (Auth.js: /api/auth/callback/<providerId>), so it has
                  to agree with the app's code — it is half of the
                  redirect URI registered at the IdP.
                '';
              };
              callbackPath = lib.mkOption {
                type = lib.types.str;
                default = "/api/auth/callback/pocket-id";
                description = ''
                  Native mode: path (on the app's own hostname) the IdP
                  redirects back to. The default is Auth.js's shape for
                  `providerId = "pocket-id"`. Registered as the client's
                  callback URL and handed to the app as
                  OIDC_REDIRECT_URI, so the two can never disagree.
                '';
              };
              scopes = lib.mkOption {
                type = lib.types.str;
                default = "openid profile email groups";
                description = ''
                  Native mode: space-separated scopes, passed as
                  OIDC_SCOPES. `groups` is what lets an app read the
                  user's Pocket ID groups out of the ID token.
                '';
              };
            };

            litellm.enable = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Opt-in: when true, sets `LITELLM_BASE_URL = http://litellm:4000`
                in the app's environment. Off by default — apps that don't
                use the LLM gateway never see the variable.

                Does NOT inject the master key. Apps that need it add
                the litellm sops secret
                (config.sops.secrets."litellm-env".path) to their
                `environmentFiles`.
              '';
            };

            # Auto-deploy — the "push to main and it's live" half of the platform.
            # See this module's header and assets/deploy.sh.
            deploy = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = true;
                description = ''
                  Poll the registry and redeploy the container when the image digest
                  moves. ON by default: every app here rides a moving `:latest`
                  published by CI on push-to-main, so "new image → run it" is the
                  expected behaviour, not an opt-in.

                  Turn OFF to freeze an app on whatever it's running — pair with a
                  digest- or sha-pinned `image` to hold a known-good build.
                '';
              };
              interval = lib.mkOption {
                type = lib.types.str;
                default = "*:0/2";
                description = ''
                  systemd OnCalendar for the poll. The default (every 2 min) is
                  the worst-case latency between CI publishing and the app going
                  live — well under the CI build itself, so it isn't the
                  bottleneck. A pull of an unchanged tag is one manifest request.
                '';
              };
              healthPath = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Path fetched through traefik after the restart to decide whether
                  the new image is alive. Any status < 500 counts — an Auth.js app
                  302-ing to a login page is a working app.

                  null falls back to `auth.healthPath`, else "/". That
                  fallback is what keeps the check honest on a
                  forward-auth'd app, where "/" is a 302 to the IdP that
                  a dead container would answer just as well.
                '';
              };
              healthTimeout = lib.mkOption {
                type = lib.types.int;
                default = 90;
                description = ''
                  Seconds to wait for the app to answer after the restart. On
                  timeout the new image keeps running and the unit fails loudly
                  (deploy-and-report — there is no auto-rollback).
                '';
              };
            };

            prometheus = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Add a prometheus scrape for `<cName>:3000<path>` and
                  materialize the per-app Grafana dashboard (when one is
                  supplied). Off by default — flip to true when the app
                  ships a /metrics endpoint; a scrape without one is just
                  a permanently-down target in Prometheus.
                '';
              };
              path = lib.mkOption {
                type = lib.types.str;
                default = "/metrics";
                description = "metrics_path of the prometheus scrape.";
              };
              dashboard = lib.mkOption {
                type = lib.types.nullOr lib.types.path;
                default = null;
                description = ''
                  Optional Grafana dashboard JSON. `%APP_NAME%` placeholders
                  are substituted with the app's name. Lands under the "Apps"
                  folder. Nested under `prometheus` because it only renders
                  when `enable` is on — the dashboard is metrics-driven, so
                  without the scrape it would only show empty panels.
                '';
              };
            };

            homepage = {
              description = lib.mkOption {
                type = lib.types.str;
                default = "";
                description = "Tile subtitle on the homepage dashboard.";
              };
              icon = lib.mkOption {
                type = lib.types.str;
                default = "mdi-cube-outline-#94a3b8";
                description = "Tile icon (homepage icon syntax).";
              };
            };

            env = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = ''
                Static env vars merged into the container's `environment`.
                NOT for secrets — visible in /nix/store. For secrets, add
                an env file to `environmentFiles`.
              '';
            };

            environmentFiles = lib.mkOption {
              type = lib.types.listOf lib.types.path;
              default = [ ];
              description = ''
                Additional env files passed via --env-file. Common uses:
                per-app secrets, third-party API keys, the litellm
                master key (config.sops.secrets."litellm-env".path).
                Conventions: `0600 santiago:users`; hand-managed files
                live under `**/secrets/` so the path is gitignored.
              '';
            };
          };
        }
      )
    );
    default = { };
    description = ''
      Vibe-coded app wrapper — see this module's header.
    '';
  };

  # Per-path assembly, NOT `config = lib.mkMerge fragments`: the
  # fragment list depends on `config.fleet.apps`, so a definition
  # spanning the whole `fleet` attrset would force the list while
  # resolving `fleet.apps` itself — infinite recursion. Keeping every
  # contributed path explicit (one level below fleet/systemd/...)
  # lets `fleet.apps` resolve without forcing the fragments. A new
  # output path in mkApp must be registered here too.
  config =
    let
      fragments = lib.mapAttrsToList mkApp cfg;
      attrsOpt = path: lib.mkMerge (map (f: lib.attrByPath path { } f) fragments);
      listOpt = path: lib.concatLists (map (f: lib.attrByPath path [ ] f) fragments);
      # Every key a fragment may emit, by prefix. attrNames doesn't
      # force values, so this map is recursion-safe; a mkApp output
      # key missing here fails eval below instead of being silently
      # discarded.
      registered = {
        "" = [
          "assertions"
          "fleet"
          "systemd"
          "virtualisation"
        ];
        fleet = [
          "appDatabases"
          "bridgeMemberships"
          "ssoClients"
          "statePaths"
          "webApps"
          "prometheusScrapes"
          "grafanaDashboardsByFolder"
          "homepageServices"
          "homepageLayout"
        ];
        systemd = [
          "services"
          "timers"
        ];
        virtualisation = [ "oci-containers" ];
      };
      unregistered = lib.unique (
        lib.concatMap (
          f:
          lib.subtractLists registered."" (lib.attrNames f)
          ++
            lib.concatMap
              (p: map (k: "${p}.${k}") (lib.subtractLists registered.${p} (lib.attrNames (f.${p} or { }))))
              [
                "fleet"
                "systemd"
                "virtualisation"
              ]
        ) fragments
      );
    in
    {
      assertions = listOpt [ "assertions" ] ++ [
        {
          assertion = unregistered == [ ];
          message = "stacks/apps: mkApp emits unregistered option path(s): ${lib.concatStringsSep ", " unregistered} — register them in the per-path assembly.";
        }
      ];

      # GHCR classic PAT (read:packages) in podman auth.json form —
      # sops-encrypted, used by container pulls + the deploy oneshots.
      sops.secrets."ghcr-auth" = {
        sopsFile = ./ghcr-auth.json.sops;
        format = "binary";
        owner = "santiago";
      };

      fleet = {
        appDatabases = attrsOpt [
          "fleet"
          "appDatabases"
        ];
        bridgeMemberships = attrsOpt [
          "fleet"
          "bridgeMemberships"
        ];
        ssoClients = attrsOpt [
          "fleet"
          "ssoClients"
        ];
        statePaths = attrsOpt [
          "fleet"
          "statePaths"
        ];
        webApps = attrsOpt [
          "fleet"
          "webApps"
        ];
        prometheusScrapes = listOpt [
          "fleet"
          "prometheusScrapes"
        ];
        grafanaDashboardsByFolder = attrsOpt [
          "fleet"
          "grafanaDashboardsByFolder"
        ];
        homepageServices = attrsOpt [
          "fleet"
          "homepageServices"
        ];
        homepageLayout = attrsOpt [
          "fleet"
          "homepageLayout"
        ];
      };

      virtualisation.oci-containers.containers = attrsOpt [
        "virtualisation"
        "oci-containers"
        "containers"
      ];

      systemd.services = attrsOpt [
        "systemd"
        "services"
      ];
      systemd.timers = attrsOpt [
        "systemd"
        "timers"
      ];
    };
}
