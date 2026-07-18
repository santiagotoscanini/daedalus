# traefik — reverse proxy + rule generator.
#
# Per-stack modules declare `myStack.traefikRoutes` (or `myStack.webApps`
# which materializes into the same option); this file turns each entry
# into one YAML file in a /nix/store-backed dir bind-mounted at /rules,
# loaded by traefik's file provider.
#
# Bridge: `traefik-net` is the shared bridge every HTTP-only stack joins
# so traefik can reach upstreams by container DNS (aardvark-dns) instead
# of host-port publishing. Stacks set
# `myStack.webApps.<name>.serviceName = "<container>"` to opt in; the
# rule then dials `http://<container>:<in-port>`. Legacy stacks that
# can't join the bridge (gluetun-shared TV stack, pi-hole as a native
# service) set `serviceUrl` to an explicit `host.containers.internal`
# URL instead.
#
# Opens host TCP 80/443 (LAN HTTPS ingress). The cfweb entrypoint
# (:8888, plain HTTP for cloudflared) and the dashboard (:8080) are
# reached over traefik-net only — no host publish.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  cfg = config.myStack;

  # Activates the postgres :5432 entrypoint + LAN firewall port when
  # the app-db cluster has at least one app database. The actual TCP
  # route YAML is contributed by stacks/app-db via traefikStaticRules
  # (one fixed `postgres.toscanini.me` route — no per-app fan-out).
  pgwireEnabled = config.myStack.appDatabases != { };

  yamlFormat = pkgs.formats.yaml { };

  # OIDC forward-auth plugin (AUTH.md) — vendored into the nix store so
  # traefik startup never fetches from the network (localPlugins loads
  # it in-process via Yaegi from /plugins-local/src/<module>).
  oidcPlugin = pkgs.fetchFromGitHub {
    owner = "sevensolutions";
    repo = "traefik-oidc-auth";
    rev = "v0.20.1";
    hash = "sha256-IhAEWiLcR5L4pqa2gE5f1DdtAYeTPWBva3zT1vS3u5U=";
  };

  # One structured YAML file per route — no hand-rolled indentation.
  # Edit the attrset (in the owning stack's module), not the rendered
  # file (it lives in /nix/store, read-only).
  mkTraefikRouteFile =
    name: route:
    let
      entry = route.entrypoint;
      needsTls = entry == "websecure";
      hasCert = route.certMain != null;
      internal = route.service != null;
    in
    yamlFormat.generate "${name}.yml" {
      http = {
        routers."${name}-rtr" = {
          entryPoints = [ entry ];
          rule = "Host(`${route.host}`)";
          service = if internal then route.service else "${name}-svc";
        }
        // lib.optionalAttrs (route.middlewares != [ ]) {
          inherit (route) middlewares;
        }
        // lib.optionalAttrs needsTls {
          tls = {
            options = "tls-opts@file";
          }
          // lib.optionalAttrs hasCert {
            certResolver = "dns-cloudflare";
            domains = [
              {
                main = route.certMain;
                sans = route.certSans;
              }
            ];
          };
        };
      }
      // lib.optionalAttrs (!internal) {
        services."${name}-svc".loadBalancer.servers = [ { url = route.serviceUrl; } ];
      };
    };

  # Use runCommand+cp (not symlinkJoin) so $out contains real files.
  # /rules bind mount doesn't include /nix/store; symlinks would dangle
  # and the inotify watcher errors out.
  traefikRulesDir = pkgs.runCommand "traefik-rules" { } (
    ''
      mkdir -p $out
    ''
    + lib.concatStringsSep "\n" (
      (lib.mapAttrsToList (
        name: route: "cp ${mkTraefikRouteFile name route} $out/${name}.yml"
      ) cfg.traefikRoutes)
      ++ (lib.mapAttrsToList (
        filename: contents: "cp ${pkgs.writeText filename contents} $out/${filename}"
      ) cfg.traefikStaticRules)
    )
  );
in
{
  # CF_API_TOKEN + CF_DNS_API_TOKEN (ACME DNS-01): sops-encrypted env.sops,
  # decrypted to /run/secrets/traefik-env at activation. Edit with `sops env.sops`.
  sops.secrets."traefik-env" = mkDotenvSecret ./env.sops;

  # traefik-net is the shared ingress bridge; app-db appends pg-wire
  # membership to this list when the postgres TCP route is active.
  myStack.containerNetworks.traefik = [ "traefik" ];
  # Pinned so TRUSTED_PROXIES-style consumers can reference it (see
  # bridgeSubnets in platform/common.nix).
  myStack.bridgeSubnets.traefik = "10.89.7.0/24";

  # Pre-creating the file 0600 keeps a fresh restore from letting podman
  # create a directory here, which breaks ACME confusingly.
  myStack.stateDirs."/home/santiago/selfhost/traefik/acme.json" = {
    type = "f";
    mode = "0600";
  };

  # Static rules that don't fit the Host->port shape. Each stack reads
  # its own asset and contributes here (e.g. app-db's TCP/SNI route
  # lives in stacks/app-db/).
  myStack.traefikStaticRules."tls-opts.yml" = builtins.readFile ./assets/tls-opts.yml;

  # Baseline security headers, applied as the websecure entrypoint's
  # default middleware (covers every router on it — generated and
  # static — with no per-route wiring). Kept off cfweb: CF's edge sets
  # its own, and HSTS over plain HTTP is ignored anyway. No frameDeny
  # fleet-wide — some apps embed themselves; apps that want it add a
  # per-route middleware.
  myStack.traefikStaticRules."sec-headers.yml" = ''
    http:
      middlewares:
        sec-headers:
          headers:
            stsSeconds: 31536000
            stsIncludeSubdomains: true
            contentTypeNosniff: true
            referrerPolicy: strict-origin-when-cross-origin
  '';

  # One forward-auth middleware per gated webApp (`auth = "oidc"`),
  # each dialing Pocket ID as its OWN client, so consent screens and
  # the audit log name the actual service. Creds live in env.sops as
  # POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET} (name uppercased, dashes to
  # underscores); the PLUGIN resolves the ''${VAR} placeholders from
  # traefik's process env — the rendered file in /nix/store carries no
  # secrets. Session cookies stay host-scoped (no SessionCookie.Domain):
  # one silent redirect through id.* per app instead of a domain-wide
  # cookie every subdomain could replay. Emitted as JSON (valid YAML)
  # to keep this pure string templating, no IFD.
  myStack.traefikStaticRules."oidc-middlewares.yml" =
    let
      envPrefix = n: "POCKET_OIDC_" + lib.toUpper (lib.replaceStrings [ "-" ] [ "_" ] n);
      mkOidcMw =
        n:
        let
          w = cfg.webApps.${n} or null;
        in
        {
          plugin.oidc = {
            Secret = "\${POCKET_OIDC_COOKIE_SECRET}";
            Provider = {
              Url = "https://id.${cfg.baseDomain}";
              ClientId = "\${${envPrefix n}_CLIENT_ID}";
              ClientSecret = "\${${envPrefix n}_CLIENT_SECRET}";
              UsePkce = true;
            };
            Scopes = [
              "openid"
              "profile"
              "email"
              "groups"
            ];
            # Always redirect unauthenticated requests to Pocket ID instead
            # of 401'ing AJAX (the plugin can't tell XHR from page loads;
            # Auto's 401 shows as an "Unauthorized" screen on SPA reloads
            # after logout). Safe here: every gated app's /api* paths are
            # bypassed, so only top-level documents ever hit the gate.
            UnauthorizedBehavior = "Challenge";
            # Lax so the state cookie survives the cross-subdomain redirect
            # back from id.* to the app's /oidc/callback (top-level nav).
            SessionCookie.SameSite = "lax";
          }
          // (
            # Bypass = the app's own machine-endpoint rule plus the
            # gatus healthPath (exact match) — so probes reach the real
            # upstream instead of being 302'd to Pocket ID.
            let
              parts =
                lib.optional (w != null && w.authBypassRule != null) "(${w.authBypassRule})"
                ++ lib.optional (w != null && w.healthPath != null) "Path(`${w.healthPath}`)";
            in
            lib.optionalAttrs (parts != [ ]) {
              BypassAuthenticationRule = lib.concatStringsSep " || " parts;
            }
          )
          // lib.optionalAttrs (w != null && w.authHeaders != { }) {
            Headers = lib.mapAttrsToList (hn: hv: {
              Name = hn;
              # The file provider Go-templates every rules file before
              # parsing — wrap in a backtick literal so traefik's pass
              # emits the PLUGIN's {{ }} template verbatim (backticks,
              # unlike quotes, survive toJSON unescaped).
              Value = "{{`" + hv + "`}}";
            }) w.authHeaders;
          };
        };
    in
    builtins.toJSON {
      http.middlewares =
        (lib.mapAttrs' (n: _: lib.nameValuePair "oidc-${n}" (mkOidcMw n)) (
          lib.filterAttrs (_: w: w.auth == "oidc") cfg.webApps
        ))
        // {
          # The dashboard is a hand-declared route (api@internal), not
          # a webApp — its middleware is declared here alongside.
          oidc-traefik-dashboard = mkOidcMw "traefik-dashboard";
        }
        // lib.mapAttrs' (
          # Companion strippers: drop client-supplied copies of each
          # identity header BEFORE the oidc middleware runs, so bypassed
          # (API/ping) requests can't spoof the trusted header.
          n: w:
          lib.nameValuePair "oidc-${n}-strip" {
            headers.customRequestHeaders = lib.mapAttrs (_: _: "") w.authHeaders;
          }
        ) (lib.filterAttrs (_: w: w.auth == "oidc" && w.authHeaders != { }) cfg.webApps);
    };

  # Dashboard / API — LAN-only via pi-hole dns.hosts; `api@internal`
  # serves /api/* and /dashboard/*.
  myStack.traefikRoutes.traefik-dashboard = {
    host = "traefik.${config.myStack.baseDomain}";
    service = "api@internal";
    middlewares = [ "oidc-traefik-dashboard@file" ];
  };

  # Opens TCP 80/443 — LAN HTTPS ingress.
  networking.firewall.allowedTCPPorts = [
    80
    443
  ];

  # Let rootless pasta bind 80/443 (no CAP_NET_BIND_SERVICE for
  # rootless). Trade-off: any unprivileged process can now bind ≥80.
  # Single-user box.
  boot.kernel.sysctl."net.ipv4.ip_unprivileged_port_start" = 80;

  # Opens TCP 5432 ONLY on the LAN interface, only when a TCP route is
  # declared (postgres SNI routing). Belt-and-suspenders: the box only
  # has enp3s0, but restricting per-interface keeps any future second
  # interface (wireguard, etc.) off-limits by default.
  networking.firewall.interfaces.enp3s0.allowedTCPPorts = lib.optional pgwireEnabled 5432;

  myStack.dnsHosts = [ "${cfg.lanIp} traefik.${cfg.baseDomain}" ];

  myStack.prometheusScrapes = [
    {
      job_name = "traefik";
      # Prometheus joins traefik-net (see monitoring.nix) and reaches the
      # api@internal/metrics endpoint by container DNS.
      static_configs = [ { targets = [ "traefik:8080" ]; } ];
    }
  ];

  myStack.homepageServices."Network" = [
    {
      name = "Traefik";
      href = "https://traefik.toscanini.me";
      description = "Reverse proxy — all *.s2 / *.toscanini routes";
      icon = "traefik.png";
      widget = {
        type = "traefik";
        url = "http://traefik:8080";
      };
    }
  ];

  virtualisation.oci-containers.containers.traefik = mkRootlessContainer {
    image = "docker.io/library/traefik:v3.7.8@sha256:4299bbed850421258fc5448c2e0e6ad350981d4d335a68de11b92448aedbefe5";

    ports = [
      "80:80"
      "443:443"
      # cfweb (:8888) is deliberately NOT host-published: cloudflared
      # dials it over traefik-net only, so the plain-HTTP entrypoint
      # that trusts X-Forwarded-* is unreachable from host processes
      # and non-bridge containers.
    ]
    ++ (lib.optional pgwireEnabled
      # postgres TCP entrypoint — SNI route for postgres.toscanini.me.
      # TLS terminates here with the *.toscanini.me wildcard; the
      # backend is plaintext postgres (`pg`) dialed over pg-wire-net.
      "5432:5432"
    );
    # Dashboard/metrics on :8080 reached via traefik-net only (no host port).

    volumes = [
      "${traefikRulesDir}:/rules:ro"
      "${oidcPlugin}:/plugins-local/src/github.com/sevensolutions/traefik-oidc-auth:ro"
      "/home/santiago/selfhost/traefik/acme.json:/acme.json"
      # No /var/log/traefik mount: both app + access logs go to stdout
      # (journald -> Loki). File logging is intentionally off so nothing
      # grows unbounded under ~/selfhost/traefik/logs.
    ];

    environmentFiles = [
      config.sops.secrets."traefik-env".path
    ];

    cmd = [
      "--api=true"
      "--api.dashboard=true"
      # Serve /api on the internal :8080 entrypoint too — the homepage
      # widget reads it container-direct now that the public dashboard
      # route is behind the Pocket ID gate. :8080 is traefik-net-only
      # (never host-published), same trust boundary as /metrics.
      "--api.insecure=true"

      # Prometheus metrics. addRoutersLabels=true adds per-router labels
      # (small cardinality cost; fine at our scale).
      "--metrics.prometheus=true"
      "--metrics.prometheus.entryPoint=traefik"
      "--metrics.prometheus.addRoutersLabels=true"
      "--metrics.prometheus.addServicesLabels=true"
      "--metrics.prometheus.addEntryPointsLabels=true"

      # Entrypoints
      "--entryPoints.web.address=:80"
      "--entrypoints.websecure.address=:443"
      "--entrypoints.traefik.address=:8080"
      "--entrypoints.cfweb.address=:8888"

      # cloudflared dials cfweb from traefik-net; trust its
      # X-Forwarded-* (proto=https from the CF edge) or OIDC
      # middlewares build http:// redirect URIs and loop. /16 not /24:
      # podman renumbers bridge subnets if networks are recreated.
      "--entrypoints.cfweb.forwardedHeaders.trustedIPs=10.89.0.0/16"

      # In-process OIDC forward-auth plugin (vendored — see oidcPlugin).
      "--experimental.localPlugins.oidc.moduleName=github.com/sevensolutions/traefik-oidc-auth"
    ]
    ++ (lib.optional pgwireEnabled "--entrypoints.postgres.address=:5432")
    ++ [

      "--entrypoints.websecure.http.middlewares=sec-headers@file"
      "--entrypoints.websecure.http.tls=true"
      "--entrypoints.websecure.http.tls.options=tls-opts@file"
      "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      "--entrypoints.web.http.redirections.entrypoint.permanent=true"

      # App log -> container stdout -> journald -> alloy -> Loki. INFO, not
      # DEBUG: at DEBUG traefik emits a "Service selected by WRR" line for
      # every single request, swamping journald/Loki with noise.
      "--log=true"
      "--log.level=INFO"

      # Access log -> stdout too (no filePath => stdout, never a file), JSON
      # so LogQL can filter/aggregate by status, router, duration, host.
      "--accesslog=true"
      "--accesslog.format=json"

      # File provider — shallow watch, top-level *.yml only.
      "--providers.file.directory=/rules"
      "--providers.file.watch=true"

      # ACME — Cloudflare DNS challenge. One apex+wildcard pair covers
      # every published hostname (all one level under the apex).
      "--entrypoints.websecure.http.tls.certresolver=dns-cloudflare"
      "--entrypoints.websecure.http.tls.domains[0].main=${config.myStack.baseDomain}"
      "--entrypoints.websecure.http.tls.domains[0].sans=*.${config.myStack.baseDomain}"
      "--certificatesResolvers.dns-cloudflare.acme.storage=/acme.json"
      "--certificatesResolvers.dns-cloudflare.acme.email=nextcloud@account.toscanini.me"
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.provider=cloudflare"
      # Use CF's own resolvers — the LAN pi-hole can't see the freshly-
      # published _acme-challenge TXT before propagation.
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.resolvers=1.1.1.1:53,1.0.0.1:53"
      # 90s settle delay before lego polls — keeps us off LE's rate-limit.
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.delayBeforeCheck=90"
    ];

  };
}
