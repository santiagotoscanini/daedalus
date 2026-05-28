# apps — vibe-coded app wrapper.
#
# Each entry in `myStack.apps` materializes:
#   - A container `app-<name>` on `traefik-net`, listening on the
#     hardcoded internal port 3000. Optionally joins `<name>-db-net`
#     when `postgres.enable = true`, sharing that bridge with `pg-<name>`.
#   - A webApp at `<name>.toscanini.me`. `stage = "live"` flips
#     exposeRemotely so cloudflared-route-sync upserts the public CNAME.
#   - (Optional) prometheus scrape on the app's own /metrics and, when
#     postgres is enabled, a second scrape via the shared `pg-exporter`
#     (multi-target).
#   - Grafana dashboard if supplied (in the "Apps" folder).
#   - Homepage tiles under a per-app section named after the app (e.g.
#     `Anansi`): the app, Repo, Logs.
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
# Database: `postgres.enable = true` materializes a plain Postgres
# container via stacks/app-db/. App reads `DATABASE_URL` from the
# bootstrap-generated env file
# (postgresql://app:<pwd>@pg-<name>:5432/app).
#
# Baseline secrets (always-on per app):
#   - AUTH_SECRET — random hex32, generated at first boot by
#     app-<name>-secrets-bootstrap.service, written to
#     /etc/nixos/stacks/apps/secrets/<name>/env (mode 0600, gitignored).
#     The app uses it for session signing / JWT / CSRF / etc.
#
# Optional features (opt-in; `false` by default):
#   - postgres.enable → injects DATABASE_URL (+ POSTGRES_*)
#   - litellm        → injects LITELLM_BASE_URL
#   - …future features follow the same pattern (off by default,
#     env injection conditional on opt-in).
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

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  cfg = config.myStack.apps;

  appSecretsBase = "/etc/nixos/stacks/apps/secrets";
  appDbEnvBase   = "/etc/nixos/stacks/app-db/secrets";

  # Capitalize first letter; used for the per-app homepage group.
  capitalize = s:
    (lib.toUpper (lib.substring 0 1 s))
    + (lib.substring 1 (lib.stringLength s) s);

  mkApp = name: app:
    let
      cName            = "app-${name}";
      hostname         = "${name}.toscanini.me";
      publicUrl        = "https://${hostname}";

      # Baseline (always-on) per-app secrets file.
      appSecretsFile   = "${appSecretsBase}/${name}/env";

      postgresEnabled  = app.postgres.enable;
      appDbEnvFile     = "${appDbEnvBase}/${name}/env";

      tileGroup = capitalize name;

      homepageTile = {
        name        = name;
        href        = publicUrl;
        siteMonitor = "http://${cName}:3000";
        icon        = app.homepage.icon;
      } // (lib.optionalAttrs (app.homepage.description != "") {
        description = app.homepage.description;
      });

      # service_name=<name> is set by alloy for both app-<name> AND
      # pg-<name> log streams (see stacks/logging/alloy/app/config.alloy),
      # so Drilldown shows app + DB logs interleaved under one entry.
      # The user can filter to just one via the `component` label
      # (`app` for the Next.js container, `pg` for postgres).
      logsTile = {
        name        = "Logs";
        href        = "https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore/service/${name}/logs?from=now-15m&to=now&var-ds=loki-default&var-filters=service_name%7C%3D%7C${name}";
        description = "App + DB logs (Loki / Grafana Drilldown)";
        icon        = "mdi-script-text-outline-#60a5fa";
      };

      repoTile = {
        name        = "Repo";
        href        = "https://github.com/santiagotoscanini/${name}";
        description = "Source code (github.com/santiagotoscanini/${name})";
        icon        = "mdi-github-#94a3b8";
      };

      # Per-app DB metrics dashboard (only when postgres is enabled).
      # Same shape as logsTile — direct link with `var-app=<name>` so
      # the dashboard template variable lands pre-filtered.
      dbTile = {
        name        = "DB";
        href        = "https://grafana.toscanini.me/d/pg-overview/postgres?orgId=1&var-app=${name}&refresh=30s";
        description = "Postgres metrics — ${name} DB";
        icon        = "mdi-database-outline-#10b981";
      };
    in {
      # Delegate per-app Postgres entirely to stacks/app-db/. The
      # presence of the key triggers role + database creation, the
      # per-app env file, AND the LAN TCP/SNI route + pi-hole entry
      # (`pg-<name>.toscanini.me:5432`). Nothing else here.
      myStack.appDatabases = lib.optionalAttrs postgresEnabled {
        "${name}" = { };
      };

      # Container joins traefik-net (primary) so traefik can dial it
      # via container DNS, no host port published.
      myStack.containerNetworks."${cName}" = "traefik";

      # Web exposure — hardcoded internal port 3000.
      myStack.webApps."${name}" = {
        hostname       = hostname;
        serviceName    = cName;
        port           = 3000;
        exposeRemotely = (app.stage == "live");
      };

      # Prometheus scrapes the app's own /metrics endpoint (when
      # prometheus.enable). Postgres metrics come from the single
      # shared `pg-exporter` declared in stacks/app-db/exporter.nix —
      # the dashboard breaks them out per-app via the `datname` label.
      # No per-app scrape entry here.
      myStack.prometheusScrapes =
        lib.optional app.prometheus.enable {
          job_name = cName;
          static_configs = [{
            targets = [ "${cName}:3000" ];
            labels  = { app = name; };
          }];
          metrics_path = app.prometheus.path;
        };

      # Grafana dashboard in the "Apps" folder (when supplied).
      myStack.grafanaDashboardsByFolder =
        lib.optionalAttrs (app.dashboard != null) {
          "Apps"."${cName}" =
            lib.replaceStrings [ "%APP_NAME%" ] [ name ]
              (builtins.readFile app.dashboard);
        };

      # Homepage tile lands in the per-app section.
      myStack.homepageServices."${tileGroup}" =
        [ homepageTile repoTile logsTile ]
        ++ (lib.optional postgresEnabled dbTile);

      # Baseline secrets bootstrap. Generates AUTH_SECRET on first boot
      # and writes the per-app env file. Idempotent: re-running is safe;
      # the env file is created only if missing. Delete the file +
      # rebuild to rotate (invalidates any sessions/JWTs signed with
      # the old AUTH_SECRET).
      systemd.services."app-${name}-secrets-bootstrap" = {
        description = "Bootstrap app-${name}: generate AUTH_SECRET on first boot";
        before      = [ "podman-${cName}.service" ];
        wantedBy    = [ "podman-${cName}.service" ];
        after       = [ "local-fs.target" ];
        path        = [ pkgs.openssl pkgs.coreutils ];
        serviceConfig = {
          Type            = "oneshot";
          RemainAfterExit = true;
          Restart         = "on-failure";
          RestartSec      = "5s";
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

      # Container ordering. Always wait on secrets bootstrap; when
      # postgres is on, also wait on the shared pg + the per-app
      # role/database bootstrap. With shared cluster, multiple apps
      # share `podman-pg.service` as a single ordering anchor.
      systemd.services."podman-${cName}" = {
        after =
          [ "app-${name}-secrets-bootstrap.service" ]
          ++ (lib.optionals postgresEnabled [
            "app-db-${name}-bootstrap.service"
            "podman-pg.service"
          ]);
        wants =
          [ "app-${name}-secrets-bootstrap.service" ]
          ++ (lib.optionals postgresEnabled [
            "app-db-${name}-bootstrap.service"
            "podman-pg.service"
          ]);
      };

      # The container itself — pure declarative, identical pattern to
      # every other stack on the box.
      virtualisation.oci-containers.containers."${cName}" =
        mkRootlessContainer ({
          image = app.image;

          environmentFiles =
            [ appSecretsFile ]
            ++ (lib.optional postgresEnabled appDbEnvFile)
            ++ app.environmentFiles;

          environment = {
            APP_NAME       = name;
            APP_HOSTNAME   = hostname;
            APP_PUBLIC_URL = publicUrl;
            PORT           = "3000";
            # Auth.js v5 / NextAuth sits behind traefik, so the request
            # Host is the public hostname (anansi.toscanini.me), not the
            # in-container `app-<name>:3000` the framework auto-derives.
            # Without these two, Auth.js bails on every /api/auth/* call
            # with `UntrustedHost`. Set at the platform level since every
            # reverse-proxied app on this PaaS hits the same wall.
            AUTH_TRUST_HOST = "true";
            AUTH_URL        = publicUrl;
          }
          // (lib.optionalAttrs app.litellm {
            LITELLM_BASE_URL = "http://litellm:4000";
          })
          // app.env;

          extraOptions =
            [ "--network=traefik-net" "--authfile=/etc/nixos/stacks/apps/secrets/ghcr-auth.json" ]
            ++ (lib.optional postgresEnabled "--network=app-db-net");
        }
        // (lib.optionalAttrs (app.cmd != null) { cmd = app.cmd; }));
    };
in
{
  options.myStack.apps = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule ({ name, ... }: {
      options = {
        image = lib.mkOption {
          type        = lib.types.str;
          default     = "ghcr.io/santiagotoscanini/${name}:latest";
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
          type        = lib.types.nullOr (lib.types.listOf lib.types.str);
          default     = null;
          description = ''
            Optional cmd override (escape hatch — apps should normally
            bake their start command into the image CMD).
          '';
        };

        stage = lib.mkOption {
          type        = lib.types.enum [ "lab" "live" ];
          default     = "lab";
          description = ''
            "lab" = LAN-only (<name>.toscanini.me via pi-hole + traefik).
            "live" = adds Cloudflare-tunnel exposure (public CNAME via
            cloudflared-route-sync). The *.toscanini.me wildcard cert
            covers both — no per-app cert work.
          '';
        };

        # Plain Postgres-per-app, materialized by stacks/app-db/.
        postgres = {
          enable = lib.mkOption {
            type        = lib.types.bool;
            default     = false;
            description = ''
              When true, materialize a per-app Postgres container
              (`pg-<name>`) via stacks/app-db/. The app container joins
              the private `<name>-db-net` bridge and receives
              DATABASE_URL (postgresql://app:<pwd>@pg-<name>:5432/app)
              via env file.
              See stacks/app-db/README.md.
            '';
          };
          # Per-app resource tunables are gone — the cluster is
          # shared, so cpus/memory are set once in stacks/app-db/app-db.nix.
          # For app-scoped throttling, use postgres role-level
          # settings: ALTER ROLE <name> CONNECTION LIMIT N;
          # ALTER ROLE <name> SET statement_timeout = '30s'; etc.
        };

        litellm = lib.mkOption {
          type        = lib.types.bool;
          default     = false;
          description = ''
            Opt-in: when true, sets `LITELLM_BASE_URL = http://litellm:4000`
            in the app's environment. Off by default — apps that don't
            use the LLM gateway never see the variable.

            Does NOT inject the master key. Apps that need it add
            `/etc/nixos/stacks/litellm/secrets/env` to `environmentFiles`.
          '';
        };

        prometheus = {
          enable = lib.mkOption {
            type        = lib.types.bool;
            default     = true;
            description = "Add a prometheus scrape for `<cName>:3000<path>`.";
          };
          path = lib.mkOption {
            type        = lib.types.str;
            default     = "/metrics";
            description = "metrics_path of the prometheus scrape.";
          };
        };

        dashboard = lib.mkOption {
          type        = lib.types.nullOr lib.types.path;
          default     = null;
          description = ''
            Optional Grafana dashboard JSON. `%APP_NAME%` placeholders
            are substituted with the app's name. Lands under the "Apps"
            folder.
          '';
        };

        homepage = {
          description = lib.mkOption {
            type        = lib.types.str;
            default     = "";
            description = "Tile subtitle on the homepage dashboard.";
          };
          icon = lib.mkOption {
            type        = lib.types.str;
            default     = "mdi-cube-outline-#94a3b8";
            description = "Tile icon (homepage icon syntax).";
          };
        };

        env = lib.mkOption {
          type        = lib.types.attrsOf lib.types.str;
          default     = { };
          description = ''
            Static env vars merged into the container's `environment`.
            NOT for secrets — visible in /nix/store. For secrets, add
            an env file to `environmentFiles`.
          '';
        };

        environmentFiles = lib.mkOption {
          type        = lib.types.listOf lib.types.path;
          default     = [ ];
          description = ''
            Additional env files passed via --env-file. Common uses:
            per-app secrets, third-party API keys, the litellm master
            key (/etc/nixos/stacks/litellm/secrets/env).
            Conventions: `0600 santiago:users`, under `**/secrets/`
            anywhere so the path is gitignored.
          '';
        };
      };
    }));
    default = { };
    description = ''
      Vibe-coded app wrapper — see this module's header.
    '';
  };

  config = let
    fragments = lib.mapAttrsToList mkApp cfg;
    attrsOpt = path: lib.mkMerge   (map (f: lib.attrByPath path { } f) fragments);
    listOpt  = path: lib.concatLists (map (f: lib.attrByPath path [ ] f) fragments);
  in {
    myStack = {
      appDatabases              = attrsOpt [ "myStack" "appDatabases" ];
      containerNetworks         = attrsOpt [ "myStack" "containerNetworks" ];
      webApps                   = attrsOpt [ "myStack" "webApps" ];
      tcpRoutes                 = attrsOpt [ "myStack" "tcpRoutes" ];
      prometheusScrapes         = listOpt  [ "myStack" "prometheusScrapes" ];
      grafanaDashboardsByFolder = attrsOpt [ "myStack" "grafanaDashboardsByFolder" ];
      homepageServices          = attrsOpt [ "myStack" "homepageServices" ];
    };

    virtualisation.oci-containers.containers =
      attrsOpt [ "virtualisation" "oci-containers" "containers" ];

    systemd.services = attrsOpt [ "systemd" "services" ];
  };
}
