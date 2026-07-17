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

{
  config,
  lib,
  pkgs,
  ...
}:

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
  mkContainerOverride =
    name: net:
    let
      container = config.virtualisation.oci-containers.containers.${name} or { };
      volumes = container.volumes or [ ];
      # Volume strings: "host:container[:opts]" → first segment is host path.
      hostPaths = map (v: lib.head (lib.splitString ":" v)) volumes;
      s2Paths = lib.unique (lib.filter (lib.hasPrefix "/s2") hostPaths);
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
      }
      // lib.optionalAttrs (s2Paths != [ ]) {
        RequiresMountsFor = s2Paths;
      };
    }
    // (lib.optionalAttrs (net != null) {
      after = [ "podman-network-${net}-net.service" ];
      wants = [ "podman-network-${net}-net.service" ];
    });

  # Idempotent — `--ignore` returns 0 if the network already exists,
  # so this can re-run on every rebuild without churn.
  # Waits on linger-users.service so /run/user/1000 is populated before
  # rootless podman runs (otherwise newuidmap lookup fails on first boot).
  mkBridgeUnit = net: {
    description = "Create the ${net}-net podman bridge";
    after = [
      "network-online.target"
      "linger-users.service"
    ];
    wants = [
      "network-online.target"
      "linger-users.service"
    ];
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
      ExecStart = "${pkgs.podman}/bin/podman network create --ignore ${net}-net";
    };
  };

  distinctBridges = lib.unique (lib.filter (n: n != null) (lib.attrValues cfg.containerNetworks));
in
{
  options.myStack = {
    lanIp = lib.mkOption {
      type = lib.types.str;
      description = ''
        The box's static LAN IPv4 — single source of truth, set in
        configuration.nix (which also feeds it to the interface
        config). Consumed by the dnsHosts generator and any stack that
        must dial the host by IP.
      '';
      example = "192.168.0.2";
    };

    baseDomain = lib.mkOption {
      type = lib.types.str;
      description = ''
        Apex domain every published hostname sits one level under
        (`<app>.<baseDomain>`) — the shape the traefik wildcard cert
        and the CF-tunnel CNAMEs assume.
      '';
      example = "toscanini.me";
    };

    mail = {
      sender = lib.mkOption {
        type = lib.types.str;
        description = "From address every mail-sending service uses (the relay account).";
      };
      alertTo = lib.mkOption {
        type = lib.types.str;
        description = "Recipient for all alert/notification mail.";
      };
      smtpHost = lib.mkOption {
        type = lib.types.str;
        description = "SMTP relay host shared by all mail-sending services.";
      };
      smtpPort = lib.mkOption {
        type = lib.types.port;
        default = 587;
        description = "SMTP submission port (STARTTLS).";
      };
    };

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
      type = lib.types.attrsOf (
        lib.types.submodule (_: {
          options = {
            host = lib.mkOption {
              type = lib.types.str;
              description = "FQDN matched by the `Host(...)` rule.";
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
              type = lib.types.enum [
                "websecure"
                "cfweb"
              ];
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
        })
      );
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
      type = lib.types.attrsOf (
        lib.types.submodule (_: {
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
        })
      );
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
      type = lib.types.attrsOf (
        lib.types.submodule (_: {
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
        })
      );
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
      type = lib.types.attrsOf (lib.types.listOf (lib.types.attrsOf lib.types.unspecified));
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

    homepageLayout = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.unspecified);
      default = { };
      description = ''
        Per-group homepage layout, keyed by group name. Each value is
        a homepage `layout.<group>` block (`style`, `columns`,
        `icon`, `useEqualHeights`, etc.).

        Each stack that introduces a new homepage group is responsible
        for contributing its layout here, so the per-app generator in
        stacks/apps/ can add new groups without anyone editing
        settings.yaml.
      '';
      example = lib.literalExpression ''
        {
          Anansi = {
            style = "row";
            columns = 4;
            icon = "mdi-spider-#f59e0b";
            useEqualHeights = true;
          };
        }
      '';
    };
  };

  config = {
    # Decorator exposed to per-stack modules:
    #   virtualisation.oci-containers.containers.foo = mkRootlessContainer { ... };
    #
    # Injects `--security-opt=no-new-privileges:true` fleet-wide: once set,
    # no process in the container can gain privileges via a setuid/setgid
    # binary or file capabilities on execve. It does NOT strip already-granted
    # capabilities (--cap-add NET_ADMIN etc. still work), so the VPN/wireguard
    # stacks keep functioning. Opt out per-container with
    # `noNewPrivileges = false` (the key is stripped before reaching
    # oci-containers) for the rare image that legitimately needs to escalate.
    _module.args.mkRootlessContainer =
      args:
      let
        nnp = args.noNewPrivileges or true;
        cleanArgs = removeAttrs args [ "noNewPrivileges" ];
        secOpts = lib.optional nnp "--security-opt=no-new-privileges:true";
      in
      {
        autoStart = true;
        podman.user = "santiago";
      }
      // cleanArgs
      // {
        environment = {
          TZ = config.time.timeZone;
        }
        // (cleanArgs.environment or { });
        extraOptions = secOpts ++ (cleanArgs.extraOptions or [ ]);
      };

    # Container-UID -> host-UID under santiago's subuid range
    # (100000:65536): container uid 0 is santiago (1000); uid N >= 1
    # lands at 99999 + N (www-data 33 -> 100032, linuxserver abc
    # 911 -> 100910). Use for tmpfiles ownership of bind-mounted dirs
    # instead of hand-computed magic numbers.
    _module.args.hostUid = containerUid: 99999 + containerUid;

    # Standard operator-managed dotenv secret: age-encrypted file at
    # the stack root, decrypted to /run/secrets/<name> owned by
    # santiago so rootless podman reads it pre-userns-remap.
    #   sops.secrets."foo-env" = mkDotenvSecret ./env.sops;
    _module.args.mkDotenvSecret = sopsFile: {
      inherit sopsFile;
      format = "dotenv";
      key = "";
      owner = "santiago";
    };

    # Activation-render idiom: a oneshot that materializes a small file
    # on tmpfs before its consumers start — a bare token, an --env-file,
    # a DSN — sourced from an already-decrypted secret. `prep` computes
    # shell vars; `content` is the heredoc body written to `file`.
    # The dir is 0755 santiago so rootless podman can traverse it at
    # --env-file mount time (pre-userns-remap); the file itself stays
    # `mode` (default 0400).
    #   systemd.services."foo-render" = mkSecretRender { ... };
    _module.args.mkSecretRender =
      {
        description,
        gates, # consumer units; the render runs before= / wantedBy= them
        dir,
        file,
        content,
        mode ? "0400",
        prep ? "",
        after ? [ ],
        wants ? [ ],
      }:
      {
        inherit description wants;
        before = gates;
        wantedBy = gates;
        # /run/secrets/* are materialized during activation, ahead of
        # every multi-user unit — no explicit sops ordering needed.
        after = [ "local-fs.target" ] ++ after;
        path = [
          pkgs.coreutils
          pkgs.gnugrep
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          Restart = "on-failure";
          RestartSec = "5s";
        };
        script = ''
          set -eu
          install -d -m 0755 -o santiago -g users ${dir}
          umask 077
          ${prep}
          install -m ${mode} -o santiago -g users /dev/stdin ${file} <<RENDER_EOF
          ${content}
          RENDER_EOF
        '';
      };

    # systemd overrides + bridge units generated from the registry.
    # Per-stack `systemd.services.<X>` additions merge with these.
    systemd.services =
      (lib.mapAttrs' (
        name: net: lib.nameValuePair "podman-${name}" (mkContainerOverride name net)
      ) cfg.containerNetworks)
      // (lib.listToAttrs (
        map (net: lib.nameValuePair "podman-network-${net}-net" (mkBridgeUnit net)) distinctBridges
      ));

    # Materialize webApps into the lower-level options the rest of
    # the box consumes (traefik route rendering, pi-hole dns.hosts,
    # cloudflared-route-sync). Module-system merging means a stack
    # can use webApps for the common case and the lower-level options
    # for edge cases at the same time.
    myStack.traefikRoutes =
      let
        # Resolve from whichever of the two webApps inputs is set
        # (assertion below enforces exactly-one).
        resolveUrl =
          w: if w.serviceName != null then "http://${w.serviceName}:${toString w.port}" else w.serviceUrl;
        baseRoute = w: {
          host = w.hostname;
          serviceUrl = resolveUrl w;
        };
      in
      (lib.mapAttrs (_: baseRoute) cfg.webApps)
      // (lib.mapAttrs' (
        n: w:
        lib.nameValuePair "${n}-cf" (
          baseRoute w
          // {
            entrypoint = "cfweb";
          }
        )
      ) (lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps));

    # Every route declares its upstream shape explicitly — no implicit
    # `host.containers.internal` fallback.
    assertions = lib.mapAttrsToList (n: w: {
      assertion = (w.serviceName != null) != (w.serviceUrl != null);
      message = ''
        myStack.webApps.${n}: exactly one of `serviceName`
        (bridge-routed via traefik-net) or `serviceUrl` (explicit
        upstream URL, e.g. for gluetun-shared or native services)
        must be set.
      '';
    }) cfg.webApps;

    myStack.dnsHosts = lib.mapAttrsToList (_: w: "${cfg.lanIp} ${w.hostname}") cfg.webApps;

    myStack.cloudflareRoutes = lib.mapAttrs (_: w: { inherit (w) hostname; }) (
      lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps
    );
  };
}
