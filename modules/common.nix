# Shared helpers and options for the rootless-podman container fleet.
#
# Exposes:
#   - `_module.args.mkRootlessContainer`: decorator for
#     `virtualisation.oci-containers.containers.<name>` declarations
#     that applies the per-host defaults (podman.user=santiago,
#     autoStart=true, TZ env var).
#   - `options.myStack.containerNetworks`: registry of container name ->
#     bridge name (or null). Each entry generates a systemd unit
#     override (Type=oneshot etc.) and, for non-null values, a
#     podman-network-<bridge>-net.service that creates the bridge.
#   - `options.myStack.traefikRoutes`: simple
#     `Host(...) -> host.containers.internal:port` routes, consumed by
#     modules/traefik.nix. Optional `certMain`/`certSans` request a
#     per-route wildcard cert (used by stacks like supabase whose URLs
#     sit two levels under s2.toscanini.me so the default
#     *.s2.toscanini.me cert doesn't cover them).
#   - `options.myStack.traefikStaticRules`: raw YAML rule contents
#     keyed by filename, for routes that don't fit the simple shape
#     (dual-entrypoint routers, custom middlewares, api@internal).
#   - `options.myStack.dnsHosts`: lines appended to pi-hole's
#     `services.pihole-ftl.settings.dns.hosts`. Per-stack modules
#     contribute their LAN-resolvable hostnames here so adding a new
#     stack doesn't require editing modules/pihole.nix by hand.
#   - `options.myStack.prometheusScrapes`: scrape jobs merged into
#     monitoring.nix's generated prometheus.yml. One entry per scrape
#     target, raw attrset shape (passed verbatim to YAML).
#   - `options.myStack.grafanaDashboards`: dashboard JSON keyed by
#     filename-without-extension. monitoring.nix combines these with
#     the static dashboards under modules/grafana-dashboards/ and
#     bind-mounts the resulting derivation into grafana.
#
# Per-stack modules declare their own containers + network entries +
# kernel-module needs + traefik routes; NixOS's module system merges
# all definitions across modules.

{ config, lib, pkgs, ... }:

let
  cfg = config.myStack;

  # systemd unit override applied to every podman-<name>.service.
  # Without this, oci-containers ships Type=notify + Restart=always,
  # which doesn't survive rootless + system-unit boundaries (sd_notify
  # across the user-ns fails, the unit either crash-loops or hangs).
  #
  # Takes the container's NAME so it can look up the container's
  # `volumes` from the resolved oci-containers config and emit
  # `RequiresMountsFor` for any `/s2/*` host paths in those volumes.
  # That closes the cold-boot race where a container starts before
  # ZFS imports the s2-pool — without `RequiresMountsFor`, podman
  # silently bind-mounts the unmounted underlay (empty directory),
  # then the dataset mounts on top and the container is left writing
  # into the empty inode. Data loss with no error log.
  mkContainerOverride = name: net:
    let
      container = config.virtualisation.oci-containers.containers.${name} or { };
      volumes = container.volumes or [ ];
      # Volume strings are "host:container[:opts]" — split on `:` and
      # take the first segment.
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
        # Default systemd is 5 failures in 10s → unit gives up. First
        # boot races (auth/storage/pooler waiting on db ready) trip
        # that limit. 20 retries over 10 min lets slow paths converge
        # without permanently giving up.
        StartLimitBurst = 20;
        StartLimitIntervalSec = 600;
      } // lib.optionalAttrs (s2Paths != [ ]) {
        RequiresMountsFor = s2Paths;
      };
    } // (lib.optionalAttrs (net != null) {
      after = [ "podman-network-${net}-net.service" ];
      wants = [ "podman-network-${net}-net.service" ];
    });

  # Idempotent systemd oneshot that creates one podman bridge at boot.
  # `--ignore` makes re-runs safe (returns 0 if the network already
  # exists), so this can re-run on every nixos-rebuild without churn.
  mkBridgeUnit = net: {
    description = "Create the ${net}-net podman bridge";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "santiago";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      Restart = "on-failure";
      RestartSec = "5s";
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
            description = "Upstream port on host.containers.internal.";
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
              (e.g. `studio.foo.supabase.s2.toscanini.me`) where the
              default `*.s2.toscanini.me` wildcard doesn't apply.

              Only emitted on `websecure` entrypoint routers.
            '';
            example = "foo.supabase.s2.toscanini.me";
          };
          certSans = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = ''
              SANs accompanying `certMain`. Typically a single wildcard
              like `*.foo.supabase.s2.toscanini.me`. Ignored when
              `certMain` is null.
            '';
            example = [ "*.foo.supabase.s2.toscanini.me" ];
          };
        };
      }));
      default = { };
      description = ''
        Simple `Host(...) -> host.containers.internal:port` routes.
        Consumed by modules/traefik.nix to render one YAML per route
        into a /nix/store-backed rules directory bind-mounted into
        the traefik container.
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

    dnsHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Lines appended to `services.pihole-ftl.settings.dns.hosts`.
        Format: `"<IP> <hostname>"` (one space, exactly as pi-hole
        expects). Per-stack modules add their LAN-resolvable hostnames
        here so pi-hole.nix doesn't need a hand-maintained list.
      '';
      example = [ "192.168.0.2 foo.supabase.s2.toscanini.me" ];
    };

    prometheusScrapes = lib.mkOption {
      type = lib.types.listOf (lib.types.attrsOf lib.types.unspecified);
      default = [ ];
      description = ''
        Scrape jobs merged into the generated `prometheus.yml`'s
        `scrape_configs`. Each entry is the raw attrset shape that
        prometheus YAML expects, e.g.:
          { job_name = "foo";
            static_configs = [ { targets = [ "host.containers.internal:1234" ]; } ];
            metrics_path = "/metrics";  # optional
            authorization = { type = "Bearer"; credentials = "..."; };  # optional
          }
      '';
    };

    grafanaDashboards = lib.mkOption {
      type = lib.types.attrsOf lib.types.lines;
      default = { };
      description = ''
        Per-stack dashboard JSON keyed by filename (without `.json`).
        modules/monitoring.nix combines these with the static
        dashboards under modules/grafana-dashboards/ and bind-mounts
        the resulting derivation into the grafana container.
      '';
    };

    homepageServices = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf
        (lib.types.attrsOf lib.types.unspecified));
      default = { };
      description = ''
        Per-stack homepage service tiles. Outer attrset is keyed by
        group name (e.g., "Media", "Network"); each value is a list
        of service entries. Each entry MUST include a `name` field;
        remaining fields follow homepage's services.yaml schema
        (`href`, `icon`, `description`, `widget`, `siteMonitor`, …).

        modules/homepage.nix renders this into services.yaml at build
        time: the `name` field becomes the service entry's single-key
        wrapper (`{ Foo: {...} }`) that homepage expects.

        Groups merge across modules (multiple modules can contribute
        services to the same group). YAML output order is alphabetical
        — homepage's own `weight` field on a service can override the
        within-group rendering order if needed.
      '';
      example = lib.literalExpression ''
        {
          "Media" = [{
            name = "Jellyfin";
            href = "https://jellyfin.s2.toscanini.me";
            icon = "jellyfin.png";
            siteMonitor = "http://host.containers.internal:8096";
            widget = {
              type = "jellyfin";
              url  = "http://host.containers.internal:8096";
              key  = "{{HOMEPAGE_VAR_JELLYFIN_API_KEY}}";
            };
          }];
        }
      '';
    };
  };

  config = {
    # Decorator exposed to per-stack modules. Apply to oci-containers
    # declarations:
    #   virtualisation.oci-containers.containers.foo = mkRootlessContainer {
    #     image = "...";
    #     ports = [ ... ];
    #     ...
    #   };
    _module.args.mkRootlessContainer = args:
      {
        autoStart = true;
        podman.user = "santiago";
      } // args // {
        environment = { TZ = config.time.timeZone; }
          // (args.environment or { });
      };

    # Generate systemd overrides + bridge units from the registry.
    # Per-stack modules declaring additional `systemd.services.<X>`
    # are merged with these by the NixOS module system, so the old
    # `(mapAttrs' ...) // (listToAttrs ...) // { ... }` chain in
    # configuration.nix is no longer needed.
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
  };
}
