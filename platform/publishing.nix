# platform/publishing.nix — the fleet's "publish this service" layer.
#
# Declares the fleet.* options a stack uses to expose itself — webApps
# (the primary one-block interface), the lower-level traefikRoutes /
# traefikRawRules / cloudflareRoutes / dnsHosts escape hatches, the
# observability registries (prometheusScrapes, grafanaDashboards{,ByFolder})
# and the homepage registries — plus the materialization that turns each
# webApp into routes, DNS entries, tunnel CNAMEs, probes, tiles and
# scrapes, and the assertions that keep those combinations coherent.
#
# The container-runtime side (bridgeMemberships, statePaths, the systemd
# machinery, every `mk*` helper) lives in platform/podman.nix.

{
  config,
  lib,
  ...
}:

let
  cfg = config.fleet;

  inherit (import ./fleet-lib.nix { inherit lib; }) bridgeOf;

  # Resolve a webApp's upstream URL from whichever input is set (the
  # exactly-one assertion below enforces the shape); named-service
  # apps (`traefikService`) have no URL.
  resolveUrl =
    w: if w.serviceName != null then "http://${w.serviceName}:${toString w.port}" else w.serviceUrl;

  # Private ingress bridges for `webApps.<n>.isolated` (bridge short
  # name per app; traefik joins each as an extra membership).
  # serviceName != null guard: a null name would crash the
  # bridgeMemberships materialization below before the friendly
  # "`isolated` needs `serviceName`" assertion could fire.
  isolatedApps = lib.filterAttrs (_: w: w.isolated && w.serviceName != null) cfg.webApps;
  isoBridge = n: "iso-${n}";
in
{
  options.fleet = {
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
                `serviceUrl` / `traefikService`, enforced by an assertion).

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
          };
        })
      );
      default = { };
      description = ''
        `Host(...) -> serviceUrl` routes, rendered by
        stacks/traefik/traefik.nix into one YAML per route under a
        /nix/store-backed rules dir bind-mounted into the traefik
        container. Every published hostname sits one level under
        baseDomain, so the entrypoint-level wildcard cert covers all
        routers — no per-route cert options exist.
      '';
    };

    traefikRawRules = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Raw YAML rule contents keyed by filename. For Traefik dynamic
        configs that don't fit the `traefikRoutes` shape. Current users:
        named TLS options (tls-opts), entrypoint-default middlewares
        (sec-headers), the oidc middleware file, and app-db's TCP/SNI
        postgres router.
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

        Pairs with `fleet.traefikRoutes.<name>.entrypoint = "cfweb"`
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
      example = [ "192.168.0.2 foo.toscanini.me" ];
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

    grafanaDashboardsByFolder = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.lines);
      default = { };
      description = ''
        Per-stack dashboards organized into Grafana sidebar folders.
        Outer key is folder name (rendered via Grafana's
        `foldersFromFilesStructure` provisioner mode); inner is
        dashboard JSON keyed by filename (without `.json`).
        monitoring.nix combines these with the static dashboards under
        stacks/monitoring/assets/dashboards/ and bind-mounts the
        resulting derivation into grafana.

        Use this when a stack emits multiple related dashboards
        (e.g. the apps platform's per-app dashboards, all under "Apps").
      '';
      example = lib.literalExpression ''
        {
          "Apps" = {
            "app-anansi" = builtins.readFile ./dashboard.json;
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
                defaultText = lib.literalExpression ''"''${name}.''${fleet.baseDomain}"'';
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
                  (`fleet.bridgeMemberships.<x>` lists "traefik";
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

                  Exactly one of `serviceName` / `serviceUrl` / `traefikService`
                  must be set — enforced by an assertion.
                '';
                example = "http://host.containers.internal:8989";
              };
              traefikService = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Named traefik service instead of a URL upstream — for
                  built-ins like `api@internal` (the dashboard). The full
                  webApps surface (auth gate, healthPath probe, dnsHosts,
                  homepage tile) applies; only the upstream shape differs.
                '';
                example = "api@internal";
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
                  own bridgeMemberships entry must NOT also list
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
                  `fleet.homepageServices` directly.
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
                    use `fleet.prometheusScrapes` directly.
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
        `traefikRoutes` / `traefikRawRules` / `cloudflareRoutes`
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

        stacks/homepage/homepage.nix renders this to services.yaml: the
        `name` field becomes the single-key wrapper homepage expects.

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
    # Materialize webApps into the lower-level options the rest of
    # the box consumes (traefik route rendering, pi-hole dns.hosts,
    # cloudflared-route-sync). Module-system merging means a stack
    # can use webApps for the common case and the lower-level options
    # for edge cases at the same time.
    fleet.traefikRoutes =
      let
        baseRoute =
          n: w:
          {
            host = w.hostname;
            middlewares =
              lib.optional (w.auth == "oidc" && w.authHeaders != { }) "oidc-${n}-strip@file"
              ++ lib.optional (w.auth == "oidc") "oidc-${n}@file";
          }
          // (if w.traefikService != null then { service = w.traefikService; } else { serviceUrl = resolveUrl w; });
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
        assertion =
          lib.count (x: x) [
            (w.serviceName != null)
            (w.serviceUrl != null)
            (w.traefikService != null)
          ] == 1;
        message = ''
          fleet.webApps.${n}: exactly one of `serviceName` (bridge-routed
          via traefik-net), `serviceUrl` (explicit upstream URL, e.g. for
          gluetun-shared or native services), or `traefikService` (named
          traefik service like api@internal) must be set.
        '';
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.serviceName != null -> w.port != null;
        message = "fleet.webApps.${n}: `serviceName` needs `port` (traefik dials http://<serviceName>:<port>).";
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = (w.serviceUrl != null || w.traefikService != null) -> w.port == null;
        message = "fleet.webApps.${n}: `port` only pairs with `serviceName` (a serviceUrl carries its own port; a named service has none) — leave it null.";
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion =
          (w.isolated && w.serviceName != null)
          -> !(lib.elem "traefik" (map bridgeOf (cfg.bridgeMemberships.${w.serviceName} or [ ])));
        message = ''
          fleet.webApps.${n}: `isolated` is defeated by also listing
          "traefik" in bridgeMemberships.${toString w.serviceName} — the
          shared bridge reopens the direct path isolation exists to close.
        '';
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = (w.authHeaders != { } || w.authBypassRule != null) -> w.auth == "oidc";
        message = ''
          fleet.webApps.${n}: `authHeaders`/`authBypassRule` only take
          effect with `auth = "oidc"` — without it no oidc middleware is
          generated, so nothing injects (or strips) those headers.
        '';
      }) cfg.webApps)
      ++ [
        (
          let
            keys = lib.mapAttrsToList (_: r: "${r.entrypoint}:${r.host}") cfg.traefikRoutes;
            dups = lib.unique (lib.filter (k: lib.count (x: x == k) keys > 1) keys);
          in
          {
            assertion = dups == [ ];
            message = ''
              fleet.traefikRoutes: two routers claim the same
              entrypoint+host (${lib.concatStringsSep ", " dups}) —
              traefik's pick between identical rules is nondeterministic.
            '';
          }
        )
      ]
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.auth == "oidc" -> w.healthPath != null;
        message = ''
          fleet.webApps.${n}: oidc-gated apps must declare
          `healthPath` — otherwise the gatus probe is 302'd to Pocket
          ID and certifies the IdP instead of the app.
        '';
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.isolated -> (w.serviceName != null && !w.metrics.enable);
        message = ''
          fleet.webApps.${n}: `isolated` needs `serviceName` (traefik
          dials the private bridge by container DNS) and is incompatible
          with `metrics.enable` (prometheus only scrapes traefik-net).
        '';
      }) cfg.webApps)
      ++ [
        (
          let
            jobs = map (j: j.job_name) config.fleet.prometheusScrapes;
          in
          {
            assertion = lib.length jobs == lib.length (lib.unique jobs);
            message = ''
              fleet.prometheusScrapes: duplicate job_name (webApps
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
          fleet.traefikRoutes.${n}: exactly one of `serviceUrl`
          (URL upstream) or `service` (named traefik service, e.g.
          api@internal) must be set.
        '';
      }) cfg.traefikRoutes)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = w.metrics.enable -> (w.serviceName != null);
        message = ''
          fleet.webApps.${n}: `metrics.enable` needs `serviceName` —
          prometheus scrapes by container DNS on traefik-net. For
          serviceUrl-shaped apps declare `fleet.prometheusScrapes`
          directly.
        '';
      }) cfg.webApps);

    # Default homepage tile per webApp (see the `homepage` option).
    fleet.homepageServices =
      let
        mkTile =
          n: w:
          {
            name = if w.homepage.name != null then w.homepage.name else lib.toSentenceCase n;
            href = if w.homepage.href != null then w.homepage.href else "https://${w.hostname}";
            siteMonitor =
              if w.homepage.siteMonitor != null then
                w.homepage.siteMonitor
              # Isolated and named-service upstreams aren't dialable from
              # homepage's bridges — probe through traefik instead, at the
              # oidc-bypassed healthPath: probing / on an auth-gated app
              # only certifies the forward-auth middleware (its 302 fires
              # before any upstream dial), not the app.
              else if w.isolated || w.traefikService != null then
                "https://${w.hostname}${if w.healthPath != null then w.healthPath else "/"}"
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
    fleet.prometheusScrapes = lib.mapAttrsToList (
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

    fleet.dnsHosts = lib.mapAttrsToList (_: w: "${cfg.lanIp} ${w.hostname}") cfg.webApps;

    # Isolated apps: the upstream lives on its private bridge and
    # traefik joins it as an extra membership (lists merge with the
    # traefik stack's own entry).
    fleet.bridgeMemberships =
      (lib.mapAttrs' (n: w: lib.nameValuePair w.serviceName [ (isoBridge n) ]) isolatedApps)
      // lib.optionalAttrs (isolatedApps != { }) {
        traefik = lib.mapAttrsToList (n: _: isoBridge n) isolatedApps;
      };

    fleet.cloudflareRoutes = lib.mapAttrs (_: w: { inherit (w) hostname; }) (
      lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps
    );
  };
}
