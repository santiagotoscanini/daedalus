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
#     modules/traefik.nix.
#   - `options.myStack.traefikStaticRules`: raw YAML rule contents
#     keyed by filename, for routes that don't fit the simple shape
#     (dual-entrypoint routers, custom middlewares, api@internal).
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
