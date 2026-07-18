# Shared helpers + myStack.* options for the rootless-podman fleet.
# Each per-stack module contributes to these options; NixOS module-system
# merging combines all contributions across modules.
#
# Exposed:
#   - `_module.args` helpers: mkRootlessContainer (oci-containers
#     decorator applying per-host defaults: podman.user=santiago,
#     autoStart=true, TZ), mkGluetunExporter, hostUid, mkDotenvSecret,
#     mkSecretRender, mkImageBuild.
#   - Options under `myStack.*` — see each `mkOption` description below
#     for the per-option contract (containerNetworks, bridgeSubnets,
#     stateDirs, traefikRoutes, traefikStaticRules, cloudflareRoutes,
#     dnsHosts, prometheusScrapes, grafanaDashboards{,ByFolder}, webApps,
#     homepageServices, homepageLayout, lanIp, baseDomain, mail).
#     appDatabases, logStacks, emailOnFailure, and hcPings are declared
#     in their owning modules.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.myStack;

  # A containerNetworks element is "<bridge>" or "<bridge>:alias=<name>";
  # the part before the first ":" names the bridge, anything after it
  # passes through to podman's --network option syntax.
  bridgeOf = spec: lib.head (lib.splitString ":" spec);
  networkFlag =
    spec:
    let
      bridge = bridgeOf spec;
      suffix = lib.removePrefix bridge spec;
    in
    "--network=${bridge}-net${suffix}";

  # Applied to every podman-<name>.service. Without this override
  # oci-containers ships Type=notify + Restart=always, which doesn't
  # survive rootless + system-unit boundaries.
  #
  # Also emits `RequiresMountsFor` for every absolute host path in the
  # container's volumes — closes the cold-boot race where a container
  # starts before a ZFS dataset mounts, silently bind-mounting the
  # unmounted underlay (empty dir), then the dataset mounts on top
  # and the container writes into an orphan inode. Silent data loss.
  # systemd resolves each path to its nearest mount, so paths on the
  # root filesystem cost nothing.
  mkContainerOverride =
    name: nets:
    let
      container = config.virtualisation.oci-containers.containers.${name} or { };
      volumes = container.volumes or [ ];
      # Volume strings: "host:container[:opts]" → first segment is host path.
      hostPaths = map (v: lib.head (lib.splitString ":" v)) volumes;
      mountPaths = lib.unique (lib.filter (lib.hasPrefix "/") hostPaths);
      bridgeUnits = map (b: "podman-network-${b}-net.service") (lib.unique (map bridgeOf nets));
    in
    {
      serviceConfig = {
        Type = lib.mkForce "oneshot";
        RemainAfterExit = true;
        Restart = lib.mkForce "on-failure";
        RestartSec = "15s";
      };
      # StartLimit* and RequiresMountsFor are [Unit] keys; systemd drops
      # them silently from [Service], turning the guards above into no-ops.
      unitConfig = {
        # systemd default (5 in 10s) trips first-boot races where
        # app-db tenants wait on pg. 20 retries x 15s = 5 min of retry
        # headroom inside the 10-min window; slow paths converge.
        StartLimitBurst = 20;
        StartLimitIntervalSec = 600;
      }
      // lib.optionalAttrs (mountPaths != [ ]) {
        RequiresMountsFor = mountPaths;
      };
    }
    // {
      # user@1000.service in after/wants: at shutdown systemd stops each
      # container BEFORE santiago's user manager and /run/user/1000 tear
      # down. Without it, `podman stop` finds the rootless runtime gone
      # ("RunRoot not writable" → crun not found), the stop fails, and the
      # container is cgroup-killed — dirty DB shutdowns / WAL recovery next
      # boot (app-db pg is stopped last, so it is the most exposed).
      after = bridgeUnits ++ [
        "state-dirs.service"
        "user@1000.service"
      ];
      wants = bridgeUnits ++ [
        "state-dirs.service"
        "user@1000.service"
      ];
    };

  # Idempotent — `--ignore` returns 0 if the network already exists,
  # so this can re-run on every rebuild without churn. NOTE: `--ignore`
  # also means a changed `bridgeSubnets` pin does NOT renumber an
  # existing bridge — that needs a manual `podman network rm` while its
  # members are stopped.
  # Waits on linger-users.service so /run/user/1000 is populated before
  # rootless podman runs.
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
    # newuidmap is a setuid wrapper that exists only in /run/wrappers/bin;
    # the boot's first rootless podman needs it to create santiago's
    # userns, and the store-only default PATH cannot see it.
    path = [ "/run/wrappers" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "santiago";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      Restart = "on-failure";
      RestartSec = "1s";
      ExecStart = "${pkgs.podman}/bin/podman network create --ignore${
        lib.optionalString (cfg.bridgeSubnets ? ${net}) " --subnet ${cfg.bridgeSubnets.${net}}"
      } ${net}-net";
    };
  };

  distinctBridges = lib.unique (
    map bridgeOf (lib.concatLists (lib.attrValues cfg.containerNetworks))
  );

  # Resolve a webApp's upstream URL from whichever of the two inputs is
  # set (the exactly-one assertion below enforces the shape).
  resolveUrl =
    w: if w.serviceName != null then "http://${w.serviceName}:${toString w.port}" else w.serviceUrl;

  # Private ingress bridges for `webApps.<n>.isolated` (bridge short
  # name per app; traefik joins each as an extra membership).
  isolatedApps = lib.filterAttrs (_: w: w.isolated) cfg.webApps;
  isoBridge = n: "iso-${n}";

  # Body of _module.args.mkRootlessContainer — bound here so other
  # helpers (mkGluetunExporter) can compose with it.
  mkRootlessContainer =
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
      type = lib.types.attrsOf (lib.types.listOf lib.types.str);
      default = { };
      description = ''
        Map: container name -> list of bridge memberships. `[ ]` means
        default pasta networking. Elements are bridge short names
        ("traefik" -> the traefik-net bridge), optionally with a podman
        network-option suffix ("nextcloud:alias=redis" ->
        `--network=nextcloud-net:alias=redis`).

        This is the single source of bridge membership: each entry
        produces the Type=oneshot systemd unit override, injects the
        `--network=<bridge>-net` flags into the container's
        extraOptions (do NOT also write them by hand), orders the unit
        after every listed bridge, and queues each bridge for creation
        by a generated podman-network-<bridge>-net.service. Lists merge
        across modules, so another stack can append a membership to a
        container it doesn't own (app-db does this to put traefik on
        pg-wire-net).

        Non-bridge networking (`--network=host`,
        `--network=container:<owner>`) stays in extraOptions with an
        `[ ]` entry here. A key without a matching oci-container fails
        eval (the injected extraOptions define the container, whose
        mandatory `image` is then missing).

        Per-stack modules add their own containers here.
      '';
      example = lib.literalExpression ''
        {
          wealthfolio = [ ];
          nextcloud-app = [ "nextcloud" "app-db" "traefik" ];
        }
      '';
    };

    stateDirs = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule (_: {
          options = {
            uid = lib.mkOption {
              type = lib.types.int;
              default = 0;
              description = ''
                CONTAINER uid that owns the path (0 = container root =
                santiago on the host; N >= 1 maps to host 99999+N via
                the subuid range). Declaring the container-side id keeps
                the 70-vs-105 postgres class of trap visible: the value
                here must match what the image actually runs as.
              '';
            };
            gid = lib.mkOption {
              type = lib.types.nullOr lib.types.int;
              default = null;
              description = "CONTAINER gid (same mapping; 0 = users). Default: same as uid.";
            };
            mode = lib.mkOption {
              type = lib.types.str;
              default = "0755";
            };
            type = lib.mkOption {
              type = lib.types.enum [
                "d"
                "f"
              ];
              default = "d";
              description = "tmpfiles entry type: directory or (empty-if-missing) file.";
            };
          };
        })
      );
      default = { };
      description = ''
        Host paths a container binds for persistent state, keyed by
        absolute path and declared with their CONTAINER-side ownership.
        Applied by the root `state-dirs.service` oneshot with the
        subuid mapping — the single convention for pre-creating
        bind-mount sources so a fresh restore (repo clone + rebuild)
        starts every container with correctly-owned dirs instead of
        podman-created root ones. Ownership and mode are re-enforced
        (non-recursively) at boot, so a wrong uid here actively breaks
        the app: match the image.
      '';
      example = lib.literalExpression ''
        {
          "/home/santiago/selfhost/grocy/config" = { uid = 911; };
          "/home/santiago/selfhost/app-db/postgres" = { uid = 70; mode = "0700"; };
        }
      '';
    };

    bridgeSubnets = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Optional subnet pin per bridge (short name -> CIDR), passed as
        `--subnet` when the bridge is created. Pin a bridge when
        something references its addresses (e.g. TRUSTED_PROXIES
        derives from `bridgeSubnets.traefik`) so podman can't renumber
        it on a fresh install. The owning stack declares its own pin.
      '';
      example = lib.literalExpression ''
        {
          traefik = "10.89.7.0/24";
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
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                Full upstream URL traefik dials. No implicit
                `host.containers.internal` fallback; every route
                declares its upstream explicitly (exactly one of
                `serviceUrl` / `service`, enforced by an assertion).

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
            service = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                Named traefik service instead of a URL upstream — for
                built-ins like `api@internal` (the dashboard). No
                loadBalancer block is emitted.
              '';
              example = "api@internal";
            };
            middlewares = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Middleware refs attached to the generated router,
                e.g. [ "oidc-auth@file" ]. webApps materializes this
                from its `auth` option; set directly only on
                hand-declared routes.
              '';
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
        lib.types.submodule (
          { name, ... }:
          {
            options = {
              hostname = lib.mkOption {
                type = lib.types.str;
                default = "${name}.${cfg.baseDomain}";
                defaultText = lib.literalExpression ''"''${name}.''${myStack.baseDomain}"'';
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
                type = lib.types.nullOr lib.types.port;
                default = null;
                description = ''
                  Upstream port traefik dials — required with
                  `serviceName` (dials `http://''${serviceName}:''${port}`
                  over bridge DNS), meaningless with `serviceUrl` (the
                  URL already carries the port; leave null).
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
                  (`myStack.containerNetworks.<x>` lists "traefik";
                  multi-bridge stacks list it after their primary).

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

              auth = lib.mkOption {
                type = lib.types.enum [
                  "none"
                  "oidc"
                ];
                default = "none";
                description = ''
                  "oidc" gates the generated router(s) — websecure AND
                  the cfweb twin when `exposeRemotely` — behind the
                  generated `oidc-<name>@file` forward-auth middleware.
                  Each gated app is its OWN Pocket ID client (consent +
                  audit log name the service): create it via the admin
                  API and land its creds in stacks/traefik/env.sops as
                  POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET} — see AUTH.md
                  for the per-service rollout recipe. "none" for apps
                  that authenticate against Pocket ID natively or keep
                  their own auth.
                '';
              };
              authBypassRule = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Traefik rule-syntax expression; matching requests skip
                  the oidc middleware entirely. For machine endpoints
                  that carry their own auth (API keys, ping UUIDs), e.g.
                  "PathPrefix(`/api`) || HeaderRegexp(`X-Api-Key`, `.+`)".
                '';
              };
              healthPath = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Path gatus probes (`https://<hostname><healthPath>`)
                  to assert the real upstream answers. Mandatory for
                  `auth = "oidc"` apps (assertion): without it the
                  forward-auth middleware 302s every probe to Pocket ID
                  and gatus certifies the IdP, not the app. The path is
                  appended to the oidc bypass rule (exact `Path()`
                  match), so pick an endpoint that is harmless
                  unauthenticated — an app health/version endpoint or
                  /favicon.ico; a 401/403 from the app still passes the
                  probe ([STATUS] < 500) and proves the upstream is up.
                '';
                example = "/api/health";
              };
              healthHeaders = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
                description = ''
                  Extra HTTP headers gatus sends with the healthPath
                  probe (e.g. an API key), upgrading it from a liveness
                  check (a 401 passes [STATUS] < 500) to an
                  authenticated health check. Values may use gatus
                  ''${ENV_VAR} placeholders resolved from gatus's env at
                  config load — keep real secrets in gatus's env.sops,
                  never literal in the store-rendered YAML.
                '';
                example = lib.literalExpression ''
                  { "X-API-KEY" = "''${BAZARR_API_KEY}"; }
                '';
              };
              isolated = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Put the upstream on a private `iso-<name>-net` bridge
                  with traefik as the only other member, instead of the
                  shared traefik-net. For apps that blindly trust
                  reverse-proxy identity headers (authHeaders): on the
                  shared bridge any container could dial them directly
                  and forge the header; isolation makes traefik the only
                  possible caller. Requires `serviceName`. The stack's
                  own containerNetworks entry must NOT also list
                  "traefik" (that would re-open the shared path).
                  Homepage siteMonitor auto-falls back to the public
                  hostname (homepage isn't on the private bridge).
                '';
              };
              authHeaders = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
                description = ''
                  Identity headers the oidc middleware forwards upstream
                  (name -> Go-template over claims), e.g.
                  "X-Forwarded-Email" = "{{ .claims.email }}". Each named
                  header is also STRIPPED from incoming requests by a
                  companion middleware so clients can't spoof it on
                  bypassed paths — apps trust these blindly.
                '';
              };
              homepage = lib.mkOption {
                type = lib.types.nullOr (
                  lib.types.submodule (_: {
                    options = {
                      group = lib.mkOption {
                        type = lib.types.str;
                        description = "Homepage group the tile lands in.";
                        example = "Media";
                      };
                      name = lib.mkOption {
                        type = lib.types.nullOr lib.types.str;
                        default = null;
                        description = "Tile display name. Default: capitalized attr key.";
                      };
                      icon = lib.mkOption {
                        type = lib.types.str;
                        description = "Tile icon (homepage icon syntax).";
                      };
                      description = lib.mkOption {
                        type = lib.types.nullOr lib.types.str;
                        default = null;
                        description = "Tile subtitle.";
                      };
                      href = lib.mkOption {
                        type = lib.types.nullOr lib.types.str;
                        default = null;
                        description = "Link override. Default: https://<hostname>.";
                      };
                      siteMonitor = lib.mkOption {
                        type = lib.types.nullOr lib.types.str;
                        default = null;
                        description = ''
                          Liveness-probe URL override. Default: the same
                          upstream URL traefik dials. Override for apps
                          homepage must reach through traefik instead
                          (redirect-happy or --add-host-listed upstreams).
                        '';
                      };
                      widget = lib.mkOption {
                        type = lib.types.nullOr (lib.types.attrsOf lib.types.unspecified);
                        default = null;
                        description = "Optional homepage widget block, passed through verbatim.";
                      };
                      extra = lib.mkOption {
                        type = lib.types.attrsOf lib.types.unspecified;
                        default = { };
                        description = "Extra tile fields merged in verbatim (weight, ping, ...).";
                      };
                    };
                  })
                );
                default = null;
                description = ''
                  Auto-generate this app's homepage tile: href and
                  siteMonitor derive from the hostname/upstream so they're
                  declared once. null = no tile. Tiles not tied to a
                  webApp (external links, no-UI stacks) still use
                  `myStack.homepageServices` directly.
                '';
              };

              metrics = {
                enable = lib.mkOption {
                  type = lib.types.bool;
                  default = false;
                  description = ''
                    Emit a prometheus scrape for this app:
                    `<serviceName>:<metrics.port><metrics.path>`, job
                    named after the attr key. Requires `serviceName`
                    (prometheus scrapes over traefik-net by container
                    DNS). Scrapes that need auth or non-webApp targets
                    use `myStack.prometheusScrapes` directly.
                  '';
                };
                port = lib.mkOption {
                  type = lib.types.nullOr lib.types.port;
                  default = null;
                  description = "Scrape port. Default: the webApp `port`.";
                };
                path = lib.mkOption {
                  type = lib.types.str;
                  default = "/metrics";
                  description = "Scrape metrics_path.";
                };
              };
            };
          }
        )
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
    # Container runtime for the whole fleet: rootless podman as santiago
    # (subuid 100000:65536). dockerCompat installs a `docker` shim.
    virtualisation.podman = {
      enable = true;
      dockerCompat = true;
    };
    virtualisation.oci-containers.backend = "podman";

    _module.args.mkRootlessContainer = mkRootlessContainer;

    # Shared gluetun (VPN netns owner) plumbing — used by stacks/tv and
    # stacks/ipcrawl-vpn. Two separate tunnels on purpose: one WireGuard
    # key cannot run two live sessions, and their traffic must not mix.
    # One pinned image for both instances, and one exporter shape: it
    # polls the owner's control API (localhost:8000 inside the shared
    # netns) and serves metrics on :8001, host-published by the owner.
    _module.args.gluetunImage = "docker.io/qmcgaw/gluetun:latest@sha256:b0ee2135e6ba52ad3f102aae9663707cd1c9531485117067a380d3b2b6dd991d";
    _module.args.mkGluetunExporter =
      netnsOwner:
      mkRootlessContainer {
        image = "ghcr.io/thecfu/gluetun-exporter:latest@sha256:bafeabb2a9638bf6b0800c2d3d47d49c6236d879bd01eec8caea45dfca2b50c5";
        dependsOn = [ netnsOwner ];
        environment = {
          GLUETUN_URL = "http://localhost:8000";
          EXPORTER_PORT = "8001";
          EXPORTER_INTERVAL = "30";
        };
        extraOptions = [ "--network=container:${netnsOwner}" ];
      };

    # Locally-built image + its build oneshot, as one helper:
    #   inherit (mkImageBuild { ... }) image service;
    # The tag embeds the build context's store hash, so ANY change to
    # the context (base-image digest bump, Containerfile edit, asset
    # change) changes the consumer unit's ExecStart and restarts it.
    # Without that, a rebuilt image sits unused behind an unchanged tag
    # until something else happens to restart the container — a silent
    # partial deploy. Layer cache keeps no-change rebuilds ~instant.
    _module.args.mkImageBuild =
      {
        name, # localhost/<name>
        tagPrefix, # human-readable tag part (e.g. the app version)
        contextDir, # store path with the Containerfile + context
        gates, # consumer units; build runs before= / wantedBy= them
      }:
      let
        # Interpolation imports a literal path into its own
        # content-addressed store path (a derivation is already one) —
        # /nix/store/<hash32>-…, where the hash IS the fingerprint of
        # exactly this context, not of the whole repo.
        ctx = "${contextDir}";
        ctxHash = builtins.substring 11 8 ctx;
        image = "localhost/${name}:${tagPrefix}-${ctxHash}";
      in
      {
        inherit image;
        service = {
          description = "Build ${image}";
          after = [
            "network-online.target"
            "linger-users.service"
          ];
          wants = [
            "network-online.target"
            "linger-users.service"
          ];
          # newuidmap: setuid wrapper, only in /run/wrappers/bin (see
          # mkBridgeUnit) -- rootless podman build needs the userns too.
          path = [ "/run/wrappers" ];
          before = gates;
          wantedBy = gates;
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            User = "santiago";
            Group = "users";
            Environment = "XDG_RUNTIME_DIR=/run/user/1000";
            Restart = "on-failure";
            RestartSec = "1s";
            ExecStart = pkgs.writeShellScript "build-${name}-image" ''
              set -eu
              cd ${ctx}
              ${pkgs.podman}/bin/podman build \
                --tag ${image} \
                --file Containerfile \
                .
            '';
          };
        };
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
        name: nets: lib.nameValuePair "podman-${name}" (mkContainerOverride name nets)
      ) cfg.containerNetworks)
      // (lib.listToAttrs (
        map (net: lib.nameValuePair "podman-network-${net}-net" (mkBridgeUnit net)) distinctBridges
      ))
      // {
        # stateDirs → a root oneshot (subuid-mapped). NOT tmpfiles:
        # systemd-tmpfiles refuses to descend from the santiago-owned
        # /home prefix into differently-owned children ("unsafe path
        # transition") and silently skips every rule under /home.
        # Sorted paths create parents before children; ownership and
        # mode are enforced non-recursively at boot and whenever the
        # declaration changes. Every podman-<name> unit orders after
        # this via mkContainerOverride.
        #
        # Failure semantics: one bad entry logs and continues (the other
        # entries still apply), then the unit fails at the end — loud via
        # emailOnFailure + the failed-units alert. Containers deliberately
        # only `wants` this unit: `requires` would propagate every
        # state-dirs restart (any declaration change) into a fleet-wide
        # container restart.
        state-dirs = {
          description = "Create and own declared container state paths";
          wantedBy = [ "multi-user.target" ];
          unitConfig.RequiresMountsFor = lib.attrNames cfg.stateDirs;
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
          };
          script =
            "fail=0\n"
            + lib.concatMapStrings (
              path:
              let
                d = cfg.stateDirs.${path};
                mapId = id: name: if id == 0 then name else toString (99999 + id);
                owner = "${mapId d.uid "santiago"}:${mapId (if d.gid != null then d.gid else d.uid) "users"}";
                p = lib.escapeShellArg path;
              in
              ''
                { ${if d.type == "d" then "mkdir -p ${p}" else "[ -e ${p} ] || : > ${p}"} \
                  && chown ${owner} ${p} && chmod ${d.mode} ${p}; } \
                  || { echo "state-dirs: failed to apply ${p}" >&2; fail=1; }
              ''
            ) (lib.sort lib.lessThan (lib.attrNames cfg.stateDirs))
            + ''exit "$fail"'';
        };
      };

    # A broken state-dirs run means containers may start against
    # wrongly-owned dirs — make that loud.
    myStack.emailOnFailure = [ "state-dirs" ];

    # Bridge membership → --network flags, injected from the registry.
    # List options merge, so these compose with each stack's own
    # extraOptions (which keep only non-bridge flags: host/netns
    # sharing, devices, caps).
    virtualisation.oci-containers.containers = lib.mapAttrs (_: nets: {
      extraOptions = map networkFlag nets;
    }) (lib.filterAttrs (_: nets: nets != [ ]) cfg.containerNetworks);

    # Materialize webApps into the lower-level options the rest of
    # the box consumes (traefik route rendering, pi-hole dns.hosts,
    # cloudflared-route-sync). Module-system merging means a stack
    # can use webApps for the common case and the lower-level options
    # for edge cases at the same time.
    myStack.traefikRoutes =
      let
        baseRoute = n: w: {
          host = w.hostname;
          serviceUrl = resolveUrl w;
          middlewares =
            lib.optional (w.auth == "oidc" && w.authHeaders != { }) "oidc-${n}-strip@file"
            ++ lib.optional (w.auth == "oidc") "oidc-${n}@file";
        };
      in
      (lib.mapAttrs baseRoute cfg.webApps)
      // (lib.mapAttrs' (
        n: w:
        lib.nameValuePair "${n}-cf" (
          baseRoute n w
          // {
            entrypoint = "cfweb";
          }
        )
      ) (lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps));

    # Every route declares its upstream shape explicitly — no implicit
    # `host.containers.internal` fallback.
    assertions =
      (lib.mapAttrsToList (n: w: {
        assertion = (w.serviceName != null) != (w.serviceUrl != null);
        message = ''
          myStack.webApps.${n}: exactly one of `serviceName`
          (bridge-routed via traefik-net) or `serviceUrl` (explicit
          upstream URL, e.g. for gluetun-shared or native services)
          must be set.
        '';
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.serviceName != null -> w.port != null;
        message = "myStack.webApps.${n}: `serviceName` needs `port` (traefik dials http://<serviceName>:<port>).";
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.auth == "oidc" -> w.healthPath != null;
        message = ''
          myStack.webApps.${n}: oidc-gated apps must declare
          `healthPath` — otherwise the gatus probe is 302'd to Pocket
          ID and certifies the IdP instead of the app.
        '';
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.isolated -> (w.serviceName != null && !w.metrics.enable);
        message = ''
          myStack.webApps.${n}: `isolated` needs `serviceName` (traefik
          dials the private bridge by container DNS) and is incompatible
          with `metrics.enable` (prometheus only scrapes traefik-net).
        '';
      }) cfg.webApps)
      ++ [
        (
          let
            jobs = map (j: j.job_name) config.myStack.prometheusScrapes;
          in
          {
            assertion = lib.length jobs == lib.length (lib.unique jobs);
            message = ''
              myStack.prometheusScrapes: duplicate job_name (webApps
              metrics jobs are named after their attr key; a free-form
              scrape collides with one of them). Prometheus would reject
              the whole config at runtime.
            '';
          }
        )
      ]
      ++ (lib.mapAttrsToList (n: r: {
        assertion = (r.serviceUrl != null) != (r.service != null);
        message = ''
          myStack.traefikRoutes.${n}: exactly one of `serviceUrl`
          (URL upstream) or `service` (named traefik service, e.g.
          api@internal) must be set.
        '';
      }) cfg.traefikRoutes)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.metrics.enable -> (w.serviceName != null);
        message = ''
          myStack.webApps.${n}: `metrics.enable` needs `serviceName` —
          prometheus scrapes by container DNS on traefik-net. For
          serviceUrl-shaped apps declare `myStack.prometheusScrapes`
          directly.
        '';
      }) cfg.webApps);

    # Default homepage tile per webApp (see the `homepage` option).
    myStack.homepageServices =
      let
        mkTile =
          n: w:
          {
            name = if w.homepage.name != null then w.homepage.name else lib.toSentenceCase n;
            href = if w.homepage.href != null then w.homepage.href else "https://${w.hostname}";
            # Isolated upstreams aren't reachable from homepage's
            # bridges — probe through traefik via the public hostname.
            siteMonitor =
              if w.homepage.siteMonitor != null then
                w.homepage.siteMonitor
              else if w.isolated then
                "https://${w.hostname}"
              else
                resolveUrl w;
            inherit (w.homepage) icon;
          }
          // lib.optionalAttrs (w.homepage.description != null) { inherit (w.homepage) description; }
          // lib.optionalAttrs (w.homepage.widget != null) { inherit (w.homepage) widget; }
          // w.homepage.extra;
        entries = lib.mapAttrsToList (n: w: {
          inherit (w.homepage) group;
          tile = mkTile n w;
        }) (lib.filterAttrs (_: w: w.homepage != null) cfg.webApps);
      in
      lib.mapAttrs (_: es: map (e: e.tile) es) (builtins.groupBy (e: e.group) entries);

    # Auth-less scrapes per webApp (see the `metrics` option).
    myStack.prometheusScrapes = lib.mapAttrsToList (
      n: w:
      {
        job_name = n;
        static_configs = [
          {
            targets = [
              "${w.serviceName}:${toString (if w.metrics.port != null then w.metrics.port else w.port)}"
            ];
          }
        ];
      }
      // lib.optionalAttrs (w.metrics.path != "/metrics") { metrics_path = w.metrics.path; }
    ) (lib.filterAttrs (_: w: w.metrics.enable) cfg.webApps);

    myStack.dnsHosts = lib.mapAttrsToList (_: w: "${cfg.lanIp} ${w.hostname}") cfg.webApps;

    # Isolated apps: the upstream lives on its private bridge and
    # traefik joins it as an extra membership (lists merge with the
    # traefik stack's own entry).
    myStack.containerNetworks =
      (lib.mapAttrs' (n: w: lib.nameValuePair w.serviceName [ (isoBridge n) ]) isolatedApps)
      // lib.optionalAttrs (isolatedApps != { }) {
        traefik = lib.mapAttrsToList (n: _: isoBridge n) isolatedApps;
      };

    myStack.cloudflareRoutes = lib.mapAttrs (_: w: { inherit (w) hostname; }) (
      lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps
    );
  };
}
