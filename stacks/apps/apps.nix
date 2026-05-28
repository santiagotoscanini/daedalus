# apps — vibe-coded app wrapper.
#
# Each entry in `myStack.apps` materializes:
#   - A dedicated Supabase project (via `myStack.supabaseProjects`),
#     unless `supabase.enable = false`.
#   - A container `app-<name>` on `traefik-net` (+ `supabase-<name>-net`
#     as secondary when supabase enabled), listening on the hardcoded
#     internal port 3000.
#   - A webApp at `<name>.toscanini.me`. `stage = "live"` flips
#     exposeRemotely so cloudflared-route-sync upserts the public CNAME.
#   - (Optional) prometheus scrape, grafana dashboard, homepage tiles
#     (app + supabase Studio + supabase API) under a per-app section
#     named after the app (e.g. `Anansi`).
#
# Convention enforced: every app container LISTENS ON PORT 3000.
# No per-app port override. The image is built by us; the rule is ours.
#
# Naming: the declaration key (e.g. `anansi`) is used verbatim for the
# supabase project id, the hostname `anansi.toscanini.me`, the homepage
# group (capitalized: `Anansi`), the dashboard tag, the container name
# `app-anansi`, and the canonical source-code directory at
# /home/santiago/apps/anansi/.
#
# Image default: `ghcr.io/santiagotoscanini/<name>:latest`. Every app
# is conventionally hosted at github.com/santiagotoscanini/<name> with
# CI publishing images to its ghcr namespace. Override for forks or
# pinned digests.
#
# Environment plumbing — fully declarative, mirrors every other stack:
#
#   environmentFiles = [
#     /etc/nixos/stacks/supabase/secrets/<name>/env   # if supabase enabled
#     <user-supplied per-app overlays>                # via myStack.apps.<name>.environmentFiles
#   ];
#   environment = {
#     APP_NAME, APP_HOSTNAME, APP_PUBLIC_URL, PORT   # app metadata
#     SUPABASE_URL  = http://supabase-<id>-kong:8000  # internal bridge URL
#     LITELLM_BASE_URL = http://litellm:4000          # when litellm = true
#     <user-supplied static env>                      # via myStack.apps.<name>.env
#   };

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  cfg = config.myStack.apps;

  supabaseEnvBase = "/etc/nixos/stacks/supabase/secrets";

  # Capitalize first letter; used for both the homepage group (here)
  # AND in stacks/supabase/supabase.nix (must stay in sync so app and
  # its supabase tiles land in the same section).
  capitalize = s:
    (lib.toUpper (lib.substring 0 1 s))
    + (lib.substring 1 (lib.stringLength s) s);

  mkApp = name: app:
    let
      cName            = "app-${name}";
      hostname         = "${name}.toscanini.me";
      publicUrl        = "https://${hostname}";
      supabaseEnabled  = app.supabase.enable;
      supabaseId       = name;
      supabaseEnvFile  = "${supabaseEnvBase}/${supabaseId}/env";

      # One section per app; supabase tiles for the same project join it.
      tileGroup = capitalize name;

      homepageTile = {
        name        = name;
        href        = publicUrl;
        siteMonitor = "http://${cName}:3000";
        icon        = app.homepage.icon;
      } // (lib.optionalAttrs (app.homepage.description != "") {
        description = app.homepage.description;
      });

      logsTile = {
        name        = "Logs";
        href        = "https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore/service/${cName}/logs?from=now-15m&to=now&var-ds=loki-default&var-filters=service_name%7C%3D%7C${cName}";
        description = "Container logs (Loki / Grafana Explore)";
        icon        = "mdi-script-text-outline-#60a5fa";
      };

      repoTile = {
        name        = "Repo";
        href        = "https://github.com/santiagotoscanini/${name}";
        description = "Source code (github.com/santiagotoscanini/${name})";
        icon        = "mdi-github-#94a3b8";
      };
    in {
      # Delegate the full Supabase stack to the existing wrapper.
      myStack.supabaseProjects = lib.optionalAttrs supabaseEnabled {
        "${supabaseId}" = {
          id   = supabaseId;
          slot = app.supabase.slot;
        };
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

      # Prometheus scrape.
      myStack.prometheusScrapes = lib.optional app.prometheus.enable {
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
      myStack.homepageServices."${tileGroup}" = [ homepageTile repoTile logsTile ];

      # Wait for the supabase project to be up before starting the app.
      # Kong is the latest supabase container in the chain, so it's a
      # reliable "project is ready" proxy.
      systemd.services."podman-${cName}" =
        lib.optionalAttrs supabaseEnabled {
          after = [ "podman-supabase-${supabaseId}-kong.service" ];
          wants = [ "podman-supabase-${supabaseId}-kong.service" ];
        };

      # The container itself — pure declarative, identical pattern to
      # every other stack on the box.
      virtualisation.oci-containers.containers."${cName}" =
        mkRootlessContainer ({
          image = app.image;

          environmentFiles =
            (lib.optional supabaseEnabled supabaseEnvFile)
            ++ app.environmentFiles;

          environment = {
            APP_NAME       = name;
            APP_HOSTNAME   = hostname;
            APP_PUBLIC_URL = publicUrl;
            PORT           = "3000";
          }
          // (lib.optionalAttrs supabaseEnabled {
            # In-cluster URL for server-side calls. The env file already
            # carries SUPABASE_PUBLIC_URL (https://kong-... over TLS)
            # for browser-side use.
            SUPABASE_URL = "http://supabase-${supabaseId}-kong:8000";
          })
          // (lib.optionalAttrs app.litellm {
            LITELLM_BASE_URL = "http://litellm:4000";
          })
          // app.env;

          extraOptions =
            [ "--network=traefik-net" "--authfile=/etc/nixos/stacks/apps/secrets/ghcr-auth.json" ]
            ++ (lib.optional supabaseEnabled "--network=supabase-${supabaseId}-net");
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

        supabase = {
          enable = lib.mkOption {
            type        = lib.types.bool;
            default     = true;
            description = "Materialize a dedicated Supabase project for this app.";
          };
          slot = lib.mkOption {
            type        = lib.types.nullOr lib.types.ints.unsigned;
            default     = null;
            description = ''
              Supabase port slot — see stacks/supabase/supabase.nix.
              Required when supabase.enable = true. Scan existing apps
              in declarations.nix and pick a free integer.
            '';
            example = 0;
          };
        };

        litellm = lib.mkOption {
          type        = lib.types.bool;
          default     = true;
          description = ''
            When true, sets `LITELLM_BASE_URL = http://litellm:4000`.
            Does NOT inject the master key — for apps that need it, add
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
    assertions = lib.mapAttrsToList (n: a: {
      assertion = a.supabase.enable -> (a.supabase.slot != null);
      message   = ''
        myStack.apps.${n}.supabase.slot is required when
        supabase.enable = true. Pick a free integer (existing slots
        are visible in stacks/apps/declarations.nix).
      '';
    }) cfg;

    myStack = {
      supabaseProjects          = attrsOpt [ "myStack" "supabaseProjects" ];
      containerNetworks         = attrsOpt [ "myStack" "containerNetworks" ];
      webApps                   = attrsOpt [ "myStack" "webApps" ];
      prometheusScrapes         = listOpt  [ "myStack" "prometheusScrapes" ];
      grafanaDashboardsByFolder = attrsOpt [ "myStack" "grafanaDashboardsByFolder" ];
      homepageServices          = attrsOpt [ "myStack" "homepageServices" ];
    };

    virtualisation.oci-containers.containers =
      attrsOpt [ "virtualisation" "oci-containers" "containers" ];

    systemd.services = attrsOpt [ "systemd" "services" ];
  };
}
