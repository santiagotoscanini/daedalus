# Shared helpers + myStack.* options for the rootless-podman fleet.
# Each per-stack module contributes to these options; NixOS module-system
# merging combines all contributions across modules.
#
# Exposed:
#   - `_module.args.mkRootlessContainer` — oci-containers decorator
#     that applies per-host defaults (podman.user=santiago,
#     autoStart=true, TZ).
#   - Options under `myStack.*` — see each `mkOption` description below
#     for the per-option contract (containerNetworks, traefikRoutes,
#     traefikStaticRules, cloudflareRoutes, dnsHosts, prometheusScrapes,
#     grafanaDashboards{,ByFolder}, webApps, homepageServices).

{ config, lib, pkgs, ... }:

let
  cfg = config.myStack;

  # Applied to every podman-<name>.service. Without this override
  # oci-containers ships Type=notify + Restart=always, which doesn't
  # survive rootless + system-unit boundaries.
  #
  # Also emits `RequiresMountsFor` for any /s2/* host paths in the
  # container's volumes — closes the cold-boot race where a container
  # starts before ZFS imports s2-pool, silently bind-mounting the
  # unmounted underlay (empty dir), then the dataset mounts on top
  # and the container writes into an orphan inode. Silent data loss.
  mkContainerOverride = name: net:
    let
      container = config.virtualisation.oci-containers.containers.${name} or { };
      volumes = container.volumes or [ ];
      # Volume strings: "host:container[:opts]" → first segment is host path.
      hostPaths = map (v: lib.head (lib.splitString ":" v)) volumes;
      s2Paths = lib.unique
        (lib.filter (lib.hasPrefix "/s2") hostPaths);
    in
    {
      serviceConfig = {
        Type = lib.mkForce "oneshot";
        RemainAfterExit = true;
        Restart = lib.mkForce "on-failure";
        RestartSec = "5s";
      };
      # StartLimit* and RequiresMountsFor are [Unit] keys; systemd drops
      # them silently from [Service], turning the guards above into no-ops.
      unitConfig = {
        # systemd default (5 in 10s) trips first-boot races where
        # auth/storage/pooler wait on db. 20 over 10 min lets slow paths converge.
        StartLimitBurst = 20;
        StartLimitIntervalSec = 600;
      } // lib.optionalAttrs (s2Paths != [ ]) {
        RequiresMountsFor = s2Paths;
      };
    } // (lib.optionalAttrs (net != null) {
      after = [ "podman-network-${net}-net.service" ];
      wants = [ "podman-network-${net}-net.service" ];
    });

  # Idempotent — `--ignore` returns 0 if the network already exists,
  # so this can re-run on every rebuild without churn.
  # Waits on linger-users.service so /run/user/1000 is populated before
  # rootless podman runs (otherwise newuidmap lookup fails on first boot).
  mkBridgeUnit = net: {
    description = "Create the ${net}-net podman bridge";
    after = [ "network-online.target" "linger-users.service" ];
    wants = [ "network-online.target" "linger-users.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "santiago";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      Restart = "on-failure";
      # First-boot rootless-podman bootstrap fails (newuidmap)
      # for reasons that aren't yet understood; 1s recovery is cheap.
      RestartSec = "1s";
      ExecStart =
        "${pkgs.podman}/bin/podman network create --ignore ${net}-net";
    };
  };

  distinctBridges = lib.unique (lib.filter (n: n != null)
    (lib.attrValues cfg.containerNetworks));
in
{
  options.myStack = {
    containerNetworks = lib.mkOption {
      type = lib.types.attrsOf (lib.types.nullOr lib.types.str);
      default = { };
      description = ''
        Map: container name -> bridge name (or null for default
        pasta networking).

        Each entry produces a Type=oneshot systemd unit override and,
        for non-null values, queues the bridge to be created by a
        generated podman-network-<bridge>-net.service.

        Per-stack modules add their own containers here.
      '';
      example = lib.literalExpression ''
        {
          wealthfolio = null;
          nextcloud-app = "nextcloud";
        }
      '';
    };

    traefikRoutes = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule ({ ... }: {
        options = {
          host = lib.mkOption {
            type = lib.types.str;
            description = "FQDN matched by the `Host(...)` rule.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            description = ''
              Upstream port traefik dials. Used to build the default
              `host.containers.internal:port` URL when `serviceUrl` is
              null; when `serviceUrl` is set, this is informational only.
            '';
          };
          serviceUrl = lib.mkOption {
            type = lib.types.str;
            description = ''
              Full upstream URL traefik dials. Required — there is no
              implicit `host.containers.internal` fallback; every
              route declares its upstream explicitly.

              Typical shape: `http://<container-name>:<in-container-port>`
              for stacks attached to `traefik-net`. Use `https://`
              for the rare image that listens TLS internally; use
              `http://host.containers.internal:<host-port>` for the
              must-keep stacks that cannot ride `traefik-net`
              (gluetun-shared netns containers; pi-hole, which is a
              native NixOS service, not a container).

              webApps materializes this automatically from either
              `serviceName` (preferred) or `serviceUrl`.
            '';
            example = "http://grocy:80";
          };
          entrypoint = lib.mkOption {
            type = lib.types.enum [ "websecure" "cfweb" ];
            default = "websecure";
            description = ''
              Traefik entrypoint. `websecure` (default) is HTTPS with
              TLS via tls-opts@file; `cfweb` is plain HTTP on :8888
              for routes reached through the Cloudflare tunnel.
            '';
          };
          certMain = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              Optional `tls.domains[0].main` for this router. When
              non-null, the generated YAML asks Traefik to request a
              dedicated cert covering `certMain` + `certSans`. Used
              by stacks whose host is two+ levels under s2.toscanini.me
              (e.g. `studio.foo.supabase.toscanini.me`) where the
              default `*.toscanini.me` wildcard doesn't apply.

              Only emitted on `websecure` entrypoint routers.
            '';
            example = "foo.supabase.toscanini.me";
          };
          certSans = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = ''
              SANs accompanying `certMain`. Typically a single wildcard
              like `*.foo.supabase.toscanini.me`. Ignored when
              `certMain` is null.
            '';
            example = [ "*.foo.supabase.toscanini.me" ];
          };
        };
      }));
      default = { };
      description = ''
        `Host(...) -> serviceUrl` routes, rendered by modules/traefik.nix
        into one YAML per route under a /nix/store-backed rules dir
        bind-mounted into the traefik container.
      '';
    };

    traefikStaticRules = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Raw YAML rule contents keyed by filename. For Traefik dynamic
        configs that don't fit the simple `traefikRoutes` shape:
        dual-entrypoint routers (e.g. nextcloud cfweb + websecure),
        named TLS options, the dashboard router using `api@internal`.
      '';
    };

    cloudflareRoutes = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule ({ ... }: {
        options = {
          hostname = lib.mkOption {
            type = lib.types.str;
            description = ''
              Public hostname exposed via the Cloudflare tunnel
              (e.g. `nextcloud.toscanini.me`). The
              cloudflared-route-sync oneshot creates/updates the
              proxied CNAME → `<tunnel-id>.cfargotunnel.com`.
            '';
          };
          service = lib.mkOption {
            type = lib.types.str;
            default = "http://traefik:8888";
            description = ''
              Origin URL cloudflared dials when this hostname is hit.
              Default `http://traefik:8888` reaches the cfweb (plain
              HTTP) entrypoint via the bridge.
            '';
          };
        };
      }));
      default = { };
      description = ''
        Public hostnames published through the Cloudflare tunnel.
        stacks/cloudflared renders these into the tunnel's config.yml
        ingress block (with the mandatory `http_status:404` catch-all
        appended).

        Pairs with `myStack.traefikRoutes.<name>.entrypoint = "cfweb"`
        on the same hostname so traefik accepts the inbound request.
      '';
      example = lib.literalExpression ''
        {
          nextcloud = { hostname = "nextcloud.toscanini.me"; };
        }
      '';
    };

    dnsHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Lines appended to `services.pihole-ftl.settings.dns.hosts`.
        Format: `"<IP> <hostname>"`. Per-stack modules add their
        LAN-resolvable hostnames here so pi-hole.nix doesn't need a
        hand-maintained list.
      '';
      example = [ "192.168.0.2 foo.supabase.toscanini.me" ];
    };

    prometheusScrapes = lib.mkOption {
      type = lib.types.listOf (lib.types.attrsOf lib.types.unspecified);
      default = [ ];
      description = ''
        Scrape jobs merged into the generated prometheus.yml's
        scrape_configs. Each entry is the raw attrset shape that
        prometheus YAML expects:
          { job_name = "foo";
            static_configs = [ { targets = [ "foo:1234" ]; } ];
            metrics_path = "/metrics";  # optional
          }
      '';
    };

    grafanaDashboards = lib.mkOption {
      type = lib.types.attrsOf lib.types.lines;
      default = { };
      description = ''
        Per-stack dashboard JSON keyed by filename (without `.json`).
        monitoring.nix combines these with the static dashboards
        under stacks/monitoring/assets/dashboards/ and bind-mounts
        the resulting derivation into grafana.
      '';
    };

    grafanaDashboardsByFolder = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.lines);
      default = { };
      description = ''
        Per-stack dashboards organized into Grafana sidebar folders.
        Outer key is folder name (rendered via Grafana's
        `foldersFromFilesStructure` provisioner mode); inner is the
        same shape as `grafanaDashboards`.

        Use this when a stack emits multiple related dashboards
        (e.g. one per supabase project, all under "Supabase").
      '';
      example = lib.literalExpression ''
        {
          "Supabase" = {
            "supabase-anansi" = builtins.readFile ./dashboard.json;
          };
        }
      '';
    };

    webApps = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule ({ ... }: {
        options = {
          hostname = lib.mkOption {
            type = lib.types.str;
            description = ''
              Canonical FQDN clients hit (e.g. "immich.toscanini.me").
              Same hostname for LAN HTTPS (pi-hole answers
              192.168.0.2; traefik websecure with the wildcard cert)
              and, if `exposeRemotely`, the CF tunnel (CNAME →
              cfweb traefik router → same upstream).

              Must fall under one of the wildcards traefik already
              has ACME-issued (`*.toscanini.me`) for HTTPS without
              extra cert config.
            '';
          };
          port = lib.mkOption {
            type = lib.types.port;
            description = ''
              Upstream port traefik dials. With `serviceName` (preferred):
              in-container port → bridge DNS as
              `http://''${serviceName}:''${port}`. With `serviceUrl`:
              informational only (the URL already carries the port).
            '';
          };
          serviceName = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              Preferred upstream shape. When set, traefik dials via
              container DNS on traefik-net — materializes
              `traefikRoutes.<name>.serviceUrl =
              "http://''${serviceName}:''${port}"`.

              Requires the upstream container on `traefik-net`
              (`myStack.containerNetworks.<x> = "traefik"` and
              `"--network=traefik-net"` in extraOptions; multi-bridge
              stacks add it as a secondary bridge).

              For stacks that can't ride `traefik-net` (gluetun-shared
              netns, native NixOS services), leave null and set
              `serviceUrl` instead. Exactly one of the two must be set.
            '';
            example = "grocy";
          };
          serviceUrl = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              Escape-hatch upstream URL — for cases `serviceName` can't fit:

              - gluetun-shared netns (TV stack): only gluetun publishes
                ports; UIs reached via `host.containers.internal:<port>`.
              - Native NixOS services (pi-hole): no container/bridge.
              - TLS-internal upstreams: `https://name:port`.

              Exactly one of `serviceName` / `serviceUrl` must be
              set — enforced by an assertion.
            '';
            example = "http://host.containers.internal:8989";
          };
          exposeRemotely = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              When true: publish the hostname through the CF tunnel
              too. Emits a `cfweb` traefik router + a
              `cloudflareRoutes` entry → cloudflared-route-sync turns
              it into a proxied CNAME. LAN exposure is unconditional;
              no `exposeLocally` knob.
            '';
          };
        };
      }));
      default = { };
      description = ''
        High-level "publish this web app" abstraction. Materializes
        into the right combination of `traefikRoutes`, `dnsHosts`, and
        `cloudflareRoutes` for the common case.

        For custom shapes (HSTS middleware, dual-entrypoint sharing,
        per-route wildcard certs outside *.toscanini.me), use
        `traefikRoutes` / `traefikStaticRules` / `cloudflareRoutes`
        directly.
      '';
      example = lib.literalExpression ''
        {
          # Split-horizon (LAN HTTPS + CF tunnel on the same name).
          immich = {
            hostname = "immich.toscanini.me";
            serviceName = "immich";
            port = 2283;
            exposeRemotely = true;
          };
          # LAN-only (e.g. admin UIs).
          grafana = {
            hostname = "grafana.toscanini.me";
            serviceName = "grafana";
            port = 3000;
          };
        }
      '';
    };

    homepageServices = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf
        (lib.types.attrsOf lib.types.unspecified));
      default = { };
      description = ''
        Per-stack homepage tiles. Outer keyed by group name ("Media",
        "Network", …); each value is a list of service entries. Each
        entry MUST include a `name` field; remaining fields follow
        homepage's services.yaml schema (`href`, `icon`,
        `description`, `widget`, `siteMonitor`, …).

        modules/homepage.nix renders this to services.yaml: the `name`
        field becomes the single-key wrapper homepage expects.

        Groups merge across modules. YAML output order is alphabetical;
        a service's `weight` field can override within-group order.
      '';
      example = lib.literalExpression ''
        {
          "Media" = [{
            name = "Jellyfin";
            href = "https://jellyfin.toscanini.me";
            icon = "jellyfin.png";
            siteMonitor = "http://host.containers.internal:8096";
          }];
        }
      '';
    };
  };

  config = {
    # Decorator exposed to per-stack modules:
    #   virtualisation.oci-containers.containers.foo = mkRootlessContainer { ... };
    _module.args.mkRootlessContainer = args:
      {
        autoStart = true;
        podman.user = "santiago";
      } // args // {
        environment = { TZ = config.time.timeZone; }
          // (args.environment or { });
      };

    # systemd overrides + bridge units generated from the registry.
    # Per-stack `systemd.services.<X>` additions merge with these.
    systemd.services =
      (lib.mapAttrs'
        (name: net:
          lib.nameValuePair "podman-${name}" (mkContainerOverride name net))
        cfg.containerNetworks)
      //
      (lib.listToAttrs (map
        (net:
          lib.nameValuePair "podman-network-${net}-net" (mkBridgeUnit net))
        distinctBridges));

    # Materialize webApps into the lower-level options the rest of
    # the box consumes (traefik route rendering, pi-hole dns.hosts,
    # cloudflared-route-sync). Module-system merging means a stack
    # can use webApps for the common case and the lower-level options
    # for edge cases at the same time.
    myStack.traefikRoutes =
      let
        # Resolve from whichever of the two webApps inputs is set
        # (assertion below enforces exactly-one).
        resolveUrl = w:
          if w.serviceName != null
          then "http://${w.serviceName}:${toString w.port}"
          else w.serviceUrl;
        baseRoute = w: {
          host = w.hostname;
          port = w.port;
          serviceUrl = resolveUrl w;
        };
      in
      (lib.mapAttrs (_: baseRoute) cfg.webApps)
      //
      (lib.mapAttrs'
        (n: w: lib.nameValuePair "${n}-cf" (baseRoute w // {
          entrypoint = "cfweb";
        }))
        (lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps));

    # Every route declares its upstream shape explicitly — no implicit
    # `host.containers.internal` fallback.
    assertions = lib.mapAttrsToList (n: w: {
      assertion =
        (w.serviceName != null) != (w.serviceUrl != null);
      message = ''
        myStack.webApps.${n}: exactly one of `serviceName`
        (bridge-routed via traefik-net) or `serviceUrl` (explicit
        upstream URL, e.g. for gluetun-shared or native services)
        must be set.
      '';
    }) cfg.webApps;

    myStack.dnsHosts =
      lib.mapAttrsToList
        (_: w: "192.168.0.2 ${w.hostname}")
        cfg.webApps;

    myStack.cloudflareRoutes =
      lib.mapAttrs
        (_: w: { hostname = w.hostname; })
        (lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps);
  };
}
