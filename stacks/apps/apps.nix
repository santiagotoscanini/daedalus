# apps — vibe-coded app wrapper.
#
# Each entry in `myStack.apps` materializes:
#   - A container `app-<name>` on `traefik-net`, listening on the
#     hardcoded internal port 3000. Also joins the shared `app-db-net`
#     bridge when `postgres.enable = true` (dials the shared `pg`
#     cluster there — see stacks/app-db/).
#   - A webApp at `<name>.toscanini.me`. `stage = "live"` flips
#     exposeRemotely so cloudflared-route-sync upserts the public CNAME.
#   - (Optional) prometheus scrape on the app's own /metrics and, when
#     postgres is enabled, a second scrape via the shared `pg-exporter`
#     (multi-target).
#   - Grafana dashboard if supplied (in the "Apps" folder).
#   - Homepage tiles under a per-app section named after the app (e.g.
#     `Anansi`): the app, Repo, Logs.
#   - An auto-deploy timer + oneshot (`deploy.enable`, ON by default) that
#     polls ghcr.io and redeploys the container when the image digest moves.
#     This is the "push to main and it's live" half of the platform; see
#     assets/deploy.sh for why an explicit pull is unavoidable.
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
# Image default: `ghcr.io/santiagotoscanini/<name>:latest`. Override
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
#   - postgres.enable → injects DATABASE_URL (+ POSTGRES_*)
#   - storage.enable  → bind-mounts a persistent data dir at /app/data
#   - litellm         → injects LITELLM_BASE_URL
#   - …future features follow the same pattern (off by default,
#     env injection conditional on opt-in).
#
# Convention enforced #2: an app that needs a disk writes it to
# /app/data. Same reasoning as the port — we build the images, so we
# pick the path. `storage.enable = true` bind-mounts
# /home/santiago/selfhost/apps/<name>/data there (overridable via
# storage.hostPath) and tmpfiles-owns it `santiago:users`, which is
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
  cfg = config.myStack.apps;

  appSecretsBase = "/etc/nixos/stacks/apps/secrets";
  appDbEnvBase = "/etc/nixos/stacks/app-db/secrets";

  # Host tree backing `storage.enable`. One dir per app underneath.
  appsDataRoot = "/home/santiago/selfhost/apps";

  # Classic PAT (read:packages) in podman auth.json form. Used both by the
  # container's implicit pull and by the deploy oneshot's explicit one. GHCR
  # private packages accept ONLY a classic PAT — fine-grained PATs and GitHub
  # App installation tokens are still rejected. When it expires, deploys fail
  # loudly rather than silently going stale.
  ghcrAuthFile = config.sops.secrets."ghcr-auth".path;

  # Last deploy result per app, `<digest> ok|failed`. systemd owns the dir
  # (StateDirectory below); the file is what keeps a failed deploy loud across
  # subsequent no-op ticks.
  deployStateDir = "/var/lib/app-deploy";

  # The deploy health-check dials traefik at the LAN IP directly rather
  # than trusting DNS, so a pi-hole hiccup can't read as a dead app.
  inherit (config.myStack) lanIp;

  # Capitalize first letter; used for the per-app homepage group.
  capitalize = s: (lib.toUpper (lib.substring 0 1 s)) + (lib.substring 1 (lib.stringLength s) s);

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
      # instead of joining traefik-net (see stacks/ipcrawl-vpn/). Guarded:
      # incompatible with postgres (a netns-borrowing container can't also
      # join the app-db bridge), and hostPort is mandatory when set.
      egressEnabled =
        let
          e = app.egress.container != null;
        in
        lib.throwIf (e && postgresEnabled)
          "myStack.apps.${name}: `egress` cannot combine with `postgres.enable` — a container sharing gluetun's netns can't also join the app-db-net bridge."
          (
            lib.throwIf (e && app.egress.hostPort == null)
              "myStack.apps.${name}: `egress.container` is set but `egress.hostPort` is null — set the host port the netns owner publishes for this app."
              e
          );

      tileGroup = capitalize name;

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
          HEALTH_PATH=${lib.escapeShellArg app.deploy.healthPath}
          HEALTH_TIMEOUT=${toString app.deploy.healthTimeout}
          AUTHFILE=${lib.escapeShellArg ghcrAuthFile}
          LAN_IP=${lib.escapeShellArg lanIp}
          STATE=${lib.escapeShellArg "${deployStateDir}/${name}"}
          SETPRIV=${pkgs.util-linux}/bin/setpriv
          ENV_BIN=${pkgs.coreutils}/bin/env
          PODMAN=${pkgs.podman}/bin/podman
          # Deploy-failure alert relay (platform/mail msmtp -> Gmail).
          NOTIFY_FROM=${lib.escapeShellArg config.myStack.mail.sender}
          NOTIFY_TO=${lib.escapeShellArg config.myStack.mail.alertTo}

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

      # service_name=<name> is set by alloy for both app-<name> AND
      # pg-<name> log streams (see stacks/logging/alloy/app/config.alloy),
      # so Drilldown shows app + DB logs interleaved under one entry.
      # The user can filter to just one via the `component` label
      # (`app` for the Next.js container, `pg` for postgres).
      logsTile = {
        name = "Logs";
        href = "https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore/service/${name}/logs?from=now-15m&to=now&var-ds=loki-default&var-filters=service_name%7C%3D%7C${name}";
        description = "App + DB logs (Loki / Grafana Drilldown)";
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
      # Delegate per-app Postgres entirely to stacks/app-db/. The
      # presence of the key triggers role + database creation and the
      # per-app env file. LAN access is the single shared
      # `postgres.toscanini.me:5432` TCP/SNI route (stacks/app-db).
      myStack.appDatabases = lib.optionalAttrs postgresEnabled {
        "${name}" = { };
      };

      # Register in containerNetworks either way — that's what earns the
      # mandatory Type=oneshot systemd override (rootless podman + Type=notify
      # is broken on this box). "traefik" joins the bridge for DNS routing;
      # `null` means pasta/netns with NO bridge (egress mode borrows gluetun's
      # netns via extraOptions, and traefik reaches it via the published host
      # port — see webApps below). Same shape as the TV stack's `sonarr = null`.
      myStack.containerNetworks."${cName}" = if egressEnabled then null else "traefik";

      # Web exposure — hardcoded internal port 3000. Bridge-routed by default
      # (serviceName on traefik-net). In egress mode the app can't ride
      # traefik-net, so traefik dials the host port gluetun publishes via
      # host.containers.internal — the same escape hatch the TV stack uses.
      myStack.webApps."${name}" = {
        inherit hostname;
        port = 3000;
        exposeRemotely = app.stage == "live";
      }
      // (
        if egressEnabled then
          { serviceUrl = "http://host.containers.internal:${toString app.egress.hostPort}"; }
        else
          { serviceName = cName; }
      );

      # Prometheus scrapes the app's own /metrics endpoint (when
      # prometheus.enable). Postgres metrics come from the single
      # shared `pg-exporter` declared in stacks/app-db/exporter.nix —
      # the dashboard breaks them out per-app via the `datname` label.
      # No per-app scrape entry here.
      myStack.prometheusScrapes = lib.optional app.prometheus.enable {
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

      # Grafana dashboard in the "Apps" folder (when supplied).
      myStack.grafanaDashboardsByFolder = lib.optionalAttrs (app.dashboard != null) {
        "Apps"."${cName}" = lib.replaceStrings [ "%APP_NAME%" ] [ name ] (builtins.readFile app.dashboard);
      };

      # Homepage tile lands in the per-app section.
      myStack.homepageServices."${tileGroup}" = [
        homepageTile
        repoTile
        logsTile
      ]
      ++ (lib.optional postgresEnabled dbTile);

      # Per-group layout for the dynamically-named app group, so the
      # 3 or 4 tiles render in a row instead of stacking vertically.
      myStack.homepageLayout."${tileGroup}" = {
        style = "row";
        columns = if postgresEnabled then 4 else 3;
        inherit (app.homepage) icon;
        useEqualHeights = true;
        tab = "Apps";
      };

      # Persistent data dir. 0755 santiago:users — container UID 0 maps
      # to host santiago (1000) under rootless podman, so the app can
      # write it as root-in-container. Recreated + re-owned on every
      # rebuild by systemd-tmpfiles, which is also why the mode is
      # stated here rather than left to whatever the app's umask did.
      #
      # The parent is declared explicitly, and that is load-bearing: for
      # a leaf whose parent doesn't exist, systemd-tmpfiles creates the
      # intermediate dirs as ROOT, then refuses its own santiago→root
      # ownership transition ("Detected unsafe path transition") and
      # silently never creates the leaf — leaving the container to die on
      # `statfs ...: no such file or directory`. Only walk the parents we
      # actually own: a hostPath outside the apps tree (e.g. /s2/<name>)
      # sits directly under an existing mountpoint, and emitting a rule
      # for *that* parent would chown the mountpoint itself.
      systemd.tmpfiles.rules = lib.optionals storageEnabled (
        (lib.optionals (lib.hasPrefix "${appsDataRoot}/" storageHostPath) [
          "d ${appsDataRoot}       0755 santiago users -"
          "d ${appsDataRoot}/${name} 0755 santiago users -"
        ])
        ++ [ "d ${storageHostPath} 0755 santiago users -" ]
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
        description = "Redeploy app-${name} when a new image lands on ghcr.io";
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
        description = "Poll ghcr.io for a new app-${name} image";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = app.deploy.interval;
          Persistent = true; # catch up if the box was off
          RandomizedDelaySec = 45; # don't have every app hit ghcr on the same second
        };
      };

      # Container ordering. Always wait on secrets bootstrap; when
      # postgres is on, also wait on the shared pg + the per-app
      # role/database bootstrap. With shared cluster, multiple apps
      # share `podman-pg.service` as a single ordering anchor.
      systemd.services."podman-${cName}" = {
        after = [
          "app-${name}-secrets-bootstrap.service"
        ]
        ++ (lib.optional egressEnabled "podman-${app.egress.container}.service")
        ++ (lib.optionals postgresEnabled [
          "app-db-${name}-bootstrap.service"
          "podman-pg.service"
        ]);
        wants = [
          "app-${name}-secrets-bootstrap.service"
        ]
        ++ (lib.optional egressEnabled "podman-${app.egress.container}.service")
        ++ (lib.optionals postgresEnabled [
          "app-db-${name}-bootstrap.service"
          "podman-pg.service"
        ]);
      };

      # The container itself — pure declarative, identical pattern to
      # every other stack on the box.
      virtualisation.oci-containers.containers."${cName}" = mkRootlessContainer (
        {
          inherit (app) image;

          # A /s2/* hostPath additionally picks up RequiresMountsFor for
          # free — common.nix extracts it from `volumes`, closing the
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
          // (lib.optionalAttrs app.litellm {
            LITELLM_BASE_URL = "http://litellm:4000";
          })
          // app.env;

          extraOptions = [
            (if egressEnabled then "--network=container:${app.egress.container}" else "--network=traefik-net")
            "--authfile=${ghcrAuthFile}"
          ]
          ++ (lib.optional postgresEnabled "--network=app-db-net");
        }
        // (lib.optionalAttrs (app.cmd != null) { inherit (app) cmd; })
        # In egress mode podman needs the netns owner up first; dependsOn
        # adds Requires=+After= on its unit (same as the TV arrs on gluetun).
        // (lib.optionalAttrs egressEnabled { dependsOn = [ app.egress.container ]; })
      );
    };
in
{
  options.myStack.apps = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, ... }: {
          options = {
            image = lib.mkOption {
              type = lib.types.str;
              default = "ghcr.io/santiagotoscanini/${name}:latest";
              description = ''
                OCI image. Default: `ghcr.io/santiagotoscanini/<name>:latest`.
                Convention is to host each app at
                `github.com/santiagotoscanini/<name>` and publish images to
                the matching ghcr namespace. Override for placeholders,
                forks, or pinned digests.
              '';
              example = "ghcr.io/santiagotoscanini/anansi:abc123";
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
            # with `postgres.enable`; leave `prometheus.enable = false` too (a
            # netns'd app isn't scrapable from monitoring-net).
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
              # Per-app resource tunables are gone — the cluster is
              # shared, so cpus/memory are set once in stacks/app-db/app-db.nix.
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
                  inside the container and create it (0755 santiago:users)
                  via tmpfiles. Off by default — stateless apps get no disk.

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

            litellm = lib.mkOption {
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
                  Poll ghcr.io and redeploy the container when the image digest
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
                type = lib.types.str;
                default = "/";
                description = ''
                  Path fetched through traefik after the restart to decide whether
                  the new image is alive. Any status < 500 counts — an Auth.js app
                  302-ing to a login page is a working app.
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
                default = true;
                description = "Add a prometheus scrape for `<cName>:3000<path>`.";
              };
              path = lib.mkOption {
                type = lib.types.str;
                default = "/metrics";
                description = "metrics_path of the prometheus scrape.";
              };
            };

            dashboard = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = ''
                Optional Grafana dashboard JSON. `%APP_NAME%` placeholders
                are substituted with the app's name. Lands under the "Apps"
                folder.
              '';
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
  # fragment list depends on `config.myStack.apps`, so a definition
  # spanning the whole `myStack` attrset would force the list while
  # resolving `myStack.apps` itself — infinite recursion. Keeping every
  # contributed path explicit (one level below myStack/systemd/...)
  # lets `myStack.apps` resolve without forcing the fragments. A new
  # output path in mkApp must be registered here too.
  config =
    let
      fragments = lib.mapAttrsToList mkApp cfg;
      attrsOpt = path: lib.mkMerge (map (f: lib.attrByPath path { } f) fragments);
      listOpt = path: lib.concatLists (map (f: lib.attrByPath path [ ] f) fragments);
    in
    {
      # GHCR classic PAT (read:packages) in podman auth.json form —
      # sops-encrypted, used by container pulls + the deploy oneshots.
      sops.secrets."ghcr-auth" = {
        sopsFile = ./ghcr-auth.json.sops;
        format = "binary";
        owner = "santiago";
      };

      myStack = {
        appDatabases = attrsOpt [
          "myStack"
          "appDatabases"
        ];
        containerNetworks = attrsOpt [
          "myStack"
          "containerNetworks"
        ];
        webApps = attrsOpt [
          "myStack"
          "webApps"
        ];
        prometheusScrapes = listOpt [
          "myStack"
          "prometheusScrapes"
        ];
        grafanaDashboardsByFolder = attrsOpt [
          "myStack"
          "grafanaDashboardsByFolder"
        ];
        homepageServices = attrsOpt [
          "myStack"
          "homepageServices"
        ];
        homepageLayout = attrsOpt [
          "myStack"
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
      systemd.tmpfiles.rules = listOpt [
        "systemd"
        "tmpfiles"
        "rules"
      ];
    };
}
