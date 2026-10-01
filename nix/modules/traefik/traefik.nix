# traefik — reverse proxy + rule generator.
#
# Per-stack modules declare `fleet.traefikRoutes` (or `fleet.webApps`
# which materializes into the same option); this file turns each entry
# into one YAML file in a /nix/store-backed dir bind-mounted at /rules,
# loaded by traefik's file provider.
#
# Bridge: `traefik-net` is the shared bridge every HTTP-only stack joins
# so traefik can reach upstreams by container DNS (aardvark-dns) instead
# of host-port publishing. Stacks set
# `fleet.webApps.<name>.serviceName = "<container>"` to opt in; the
# rule then dials `http://<container>:<in-port>`. Stacks that
# structurally can't join the bridge (a gluetun netns tenant, pi-hole
# as a native service) set `serviceUrl` to an explicit
# `host.containers.internal` URL instead.
#
# Opens host TCP 80/443 (LAN HTTPS ingress). The cfweb entrypoint
# (:8888, plain HTTP for cloudflared) and the dashboard (:8080) are
# reached over traefik-net only — no host publish.
#
# The host brings:
#   fleet.modules.traefik.enable        the switch (default off, as every catalog module)
#   fleet.modules.traefik.envSopsFile   POCKET_OIDC_COOKIE_SECRET (+ hand-made client creds)
#   fleet.images.traefik                the digest-pinned image
#   fleet.webApps.traefik-dashboard.*   policy for the dashboard (groups, label) — optional
# The forward-auth plugin (`oidcPlugin` below) is vendored by tag and bumped
# by hand, in the engine (nix-engine.md §4).

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet;

  # Activates the postgres :5432 entrypoint + LAN firewall port when
  # the app-db cluster has at least one app database. The actual TCP
  # route YAML is contributed by modules/app-db via traefikRawRules
  # (one fixed `postgres.<baseDomain>` route — no per-app fan-out).
  pgwireEnabled = config.fleet.appDatabases != { };

  yamlFormat = pkgs.formats.yaml { };

  # ── the proxy proof (webApps.<n>.proxyProof) ─────────────────────────────
  #
  # One secret per app that verifies it, so a proof that leaks from one app
  # forges nothing at another: 32 random bytes as hex, minted per boot by ONE
  # oneshot, `traefik-proxy-proof`, into its own tmpfs runtime directory
  # (`/run/proxy-proof`, the operator's, 0700). The same unit writes both
  # copies: traefik's as PROXY_PROOF_<N> in `traefik.env` (the `proof-<n>`
  # middleware's `env` template reads it when the rules load) and the app's
  # as PROXY_PROOF in `app-<n>.env`. Nothing is in the store (the rules file
  # carries only the variable's name) and nothing is on a disk a snapshot
  # takes: the proof authenticates traefik to the app per request, it is not
  # a session, so a value that lives one boot loses nothing.
  #
  # Rotate: `systemctl restart traefik-proxy-proof`. A start mints fresh
  # values; traefik and every proxyProof container are PartOf the unit, so
  # the restart reaches both sides in the same job and they come back
  # agreeing. A rebuild that changes the unit RELOADS it instead
  # (reloadIfChanged): a reload mints only what is missing (an app newly
  # declared) and rewrites the env files, so a rebuild never rotates.
  #
  # A value in a middleware is a value the API prints
  # (/api/http/middlewares), which is why the API is no longer served to
  # every bridge member (apiReaders below).
  envName = n: lib.toUpper (lib.replaceStrings [ "-" ] [ "_" ] n);
  proofApps = lib.filterAttrs (_: w: w.proxyProof) cfg.webApps;
  proofUnit = "traefik-proxy-proof";
  proofDir = "/run/proxy-proof";
  proofAppEnv = n: "${proofDir}/app-${n}.env";
  traefikProofEnv = "${proofDir}/traefik.env";
  proofConsumers = [
    "podman-traefik.service"
  ]
  ++ lib.mapAttrsToList (_: w: "podman-${w.serviceName}.service") proofApps;
  # `rotate` (a start) mints every value; `keep` (a reload) mints only the
  # missing ones. Either way both env files are rewritten from the values.
  proofScript = pkgs.writeShellScript "traefik-proxy-proof" ''
    set -eu
    mode=$1
    cd ${proofDir}
    # What the per-file renders of an earlier generation left here.
    for d in ./*/; do
      [ -d "$d" ] && rm -rf -- "$d"
    done
    : >traefik.env.new
    ${lib.concatMapStrings (n: ''
      if [ "$mode" = rotate ] || [ ! -s app-${n}.proof ]; then
        od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >app-${n}.proof.new
        mv -f app-${n}.proof.new app-${n}.proof
      fi
      v=$(cat app-${n}.proof)
      if [ "''${#v}" -ne 64 ]; then
        echo "app-${n}.proof is not 64 hex characters" >&2
        exit 1
      fi
      printf 'PROXY_PROOF=%s\n' "$v" >app-${n}.env.new
      mv -f app-${n}.env.new app-${n}.env
      printf 'PROXY_PROOF_${envName n}=%s\n' "$v" >>traefik.env.new
    '') (lib.attrNames proofApps)}
    mv -f traefik.env.new traefik.env
  '';
  # Each proxyProof app reads its own copy; the container is its own
  # module's, and environmentFiles merges.
  proofContainers = lib.mapAttrs' (
    n: w: lib.nameValuePair w.serviceName { environmentFiles = [ (proofAppEnv n) ]; }
  ) proofApps;

  # OIDC forward-auth plugin — vendored into the nix store so
  # traefik startup never fetches from the network (localPlugins loads
  # it in-process via Yaegi from /plugins-local/src/<module>).
  oidcPlugin = pkgs.fetchFromGitHub {
    owner = "sevensolutions";
    repo = "traefik-oidc-auth";
    rev = "v0.20.1";
    hash = "sha256-IhAEWiLcR5L4pqa2gE5f1DdtAYeTPWBva3zT1vS3u5U=";
  };

  # The traefik service a route's router sends to: the named one it gives,
  # or the one its file defines for its `serviceUrl`.
  routeService = name: route: if route.service != null then route.service else "${name}-svc";

  # One structured YAML file per route — no hand-rolled indentation.
  # Edit the attrset (in the owning stack's module), not the rendered
  # file (it lives in /nix/store, read-only).
  mkTraefikRouteFile =
    name: route:
    let
      entry = route.entrypoint;
      needsTls = entry == "websecure";
      internal = route.service != null;
    in
    yamlFormat.generate "${name}.yml" {
      http = {
        routers."${name}-rtr" = {
          entryPoints = [ entry ];
          # One Host() per name (the route's host, then its extraHosts).
          rule = lib.concatMapStringsSep " || " (h: "Host(`${h}`)") ([ route.host ] ++ route.extraHosts);
          service = routeService name route;
        }
        // lib.optionalAttrs (route.middlewares != [ ]) {
          inherit (route) middlewares;
        }
        // lib.optionalAttrs needsTls {
          tls.options = "tls-opts@file";
        };
      }
      // lib.optionalAttrs (!internal) {
        services.${routeService name route}.loadBalancer.servers = [ { url = route.serviceUrl; } ];
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
      ) cfg.traefikRawRules)
    )
  );
in
{
  options.fleet.modules.traefik = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Traefik — the reverse proxy every published hostname goes through.";
    };

    apiReaders = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "10.89.254.0/24" ];
      description = ''
        Source ranges (CIDR) allowed to read traefik's API container-direct on
        the `traefik` entrypoint (:8080, bridge-only). Everyone else gets a
        403 there; /metrics on the same port stays open to its scraper. The
        API prints every middleware's configuration, `proxyProof` secrets
        included, so it is no longer served to whatever shares a bridge with
        traefik. Pin the reader's bridge subnet (`fleet.bridgeSubnets`) and
        name it here. The dashboard's own route (Pocket ID-gated) is
        unaffected.
      '';
    };

    routeServices = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      default = lib.mapAttrs routeService config.fleet.traefikRoutes;
      defaultText = lib.literalMD "each route's `service`, or `<route>-svc`, the service its file defines";
      description = ''
        The traefik service each `fleet.traefikRoutes.<name>` router sends
        to (a webApp's route is named after it): what a hand-written router
        in `fleet.traefikRawRules` names to reach the same upstream.
      '';
    };

    envSopsFile = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./host/sops/traefik/env.sops";
      description = ''
        sops-encrypted dotenv carrying POCKET_OIDC_COOKIE_SECRET, the
        forward-auth session cookie's key (any 32+ random bytes), plus the
        POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET} pairs of any client created by
        hand at the identity provider. Host data: the engine carries no
        box's ciphertext. Only read while the module is on.
      '';
    };
  };

  config = lib.mkIf config.fleet.modules.traefik.enable {
    # The rules dir copies <route>.yml then raw-rule files into one
    # namespace — a raw rule named after a route would silently win.
    assertions = [
      (
        let
          clashes = lib.intersectLists (map (n: "${n}.yml") (lib.attrNames config.fleet.traefikRoutes)) (
            lib.attrNames config.fleet.traefikRawRules
          );
        in
        {
          assertion = clashes == [ ];
          message = "fleet.traefikRawRules: filename(s) ${lib.concatStringsSep ", " clashes} collide with generated route files — rename the raw rule.";
        }
      )
    ];

    # POCKET_OIDC_COOKIE_SECRET (the forward-auth session cookie), from the
    # host's sops-encrypted dotenv, decrypted to /run/secrets/traefik-env at
    # activation. The Cloudflare API token lego
    # reads for DNS-01 (CF_DNS_API_TOKEN) is deliberately NOT in this file:
    # it has exactly one home, site/vault/cloudflare-api-token.sops, rendered
    # by the platform (site.nix) and handed to the container as a second env file
    # below.
    sops.secrets."traefik-env" = mkDotenvSecret config.fleet.modules.traefik.envSopsFile;

    # lego reads the token from its env at container start, so a rotation
    # restarts traefik (the template is declared in platform/site.nix).
    sops.templates."cloudflare-api-token.env".restartUnits = [ "podman-traefik.service" ];

    # traefik-net is the shared ingress bridge; app-db appends pg-wire
    # membership to this list when the postgres TCP route is active.
    fleet.bridgeMemberships.traefik = [ "traefik" ];
    # Pinned so TRUSTED_PROXIES-style consumers can reference it (see
    # bridgeSubnets in platform/podman.nix).
    fleet.bridgeSubnets.traefik = "10.89.7.0/24";

    # Pre-creating the file 0600 keeps a fresh restore from letting podman
    # create a directory here, which breaks ACME confusingly.
    fleet.statePaths."${config.fleet.stateRoot}/traefik/acme.json" = {
      type = "f";
      mode = "0600";
    };

    # Static rules that don't fit the Host->port shape. Each stack reads
    # its own asset and contributes here (e.g. app-db's TCP/SNI route
    # lives in modules/app-db/).
    fleet.traefikRawRules."tls-opts.yml" = builtins.readFile ./assets/tls-opts.yml;

    # The API on :8080, for the readers named in apiReaders only. It used to
    # be `--api.insecure`, which served it to every member of every bridge
    # traefik sits on — the whole routing table and, with proxyProof, the
    # secrets that prove a request came through here.
    fleet.traefikRawRules."traefik-api.yml" =
      lib.mkIf (config.fleet.modules.traefik.apiReaders != [ ])
        (
          builtins.toJSON {
            http = {
              routers.traefik-api = {
                entryPoints = [ "traefik" ];
                rule = "PathPrefix(`/api`)";
                service = "api@internal";
                middlewares = [ "traefik-api-readers" ];
              };
              middlewares.traefik-api-readers.ipAllowList.sourceRange = config.fleet.modules.traefik.apiReaders;
            };
          }
        );

    # One `proof-<n>` middleware per proxyProof app, first in its routers'
    # chains (platform/publishing.nix). customRequestHeaders SETS the header,
    # so a copy the client sent is replaced, never passed through. The value
    # is traefik's own file-provider template over its environment — a Go raw
    # string, whose backticks survive toJSON unescaped — so the rendered rules
    # in the store name the variable, not the secret.
    fleet.traefikRawRules."proxy-proof.yml" = lib.mkIf (proofApps != { }) (
      builtins.toJSON {
        http.middlewares = lib.mapAttrs' (
          n: _:
          lib.nameValuePair "proof-${n}" {
            headers.customRequestHeaders."X-Proxy-Proof" = "{{ env `PROXY_PROOF_${envName n}` }}";
          }
        ) proofApps;
      }
    );

    # The one unit behind the proof (the let-block's header): minted at its
    # start, per boot; both sides are PartOf it. Runs as the operator — the
    # env files are read by rootless podman — and needs nothing else.
    systemd.services = lib.mkIf (proofApps != { }) (
      {
        ${proofUnit} = {
          description = "Mint the forward-auth proof of each proxyProof app for traefik and the app";
          before = proofConsumers;
          wantedBy = proofConsumers;
          reloadIfChanged = true;
          path = [ pkgs.coreutils ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            User = cfg.operator.user;
            Group = cfg.operator.group;
            UMask = "0077";
            RuntimeDirectory = baseNameOf proofDir;
            RuntimeDirectoryMode = "0700";
            # A stop never takes the files from under a running consumer.
            RuntimeDirectoryPreserve = "yes";
            ExecStart = "${proofScript} rotate";
            ExecReload = "${proofScript} keep";
          };
        };
      }
      // lib.genAttrs (map (lib.removeSuffix ".service") proofConsumers) (_: {
        after = [ "${proofUnit}.service" ];
        wants = [ "${proofUnit}.service" ];
        partOf = [ "${proofUnit}.service" ];
      })
    );

    # Baseline security headers, applied as the websecure entrypoint's
    # default middleware (covers every router on it — generated and
    # static — with no per-route wiring). Kept off cfweb: CF's edge sets
    # its own, and HSTS over plain HTTP is ignored anyway. No frameDeny
    # fleet-wide — some apps embed themselves; apps that want it add a
    # per-route middleware.
    fleet.traefikRawRules."sec-headers.yml" = ''
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
    # the audit log name the actual service. Creds arrive as
    # POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET} (name uppercased, dashes to
    # underscores) — from the declarative clients' render, or env.sops for
    # a hand-made client (environmentFiles below); the PLUGIN resolves the
    # ''${VAR} placeholders from
    # traefik's process env — the rendered file in /nix/store carries no
    # secrets. Session cookies stay host-scoped (no SessionCookie.Domain):
    # one silent redirect through id.* per app instead of a domain-wide
    # cookie every subdomain could replay. Emitted as JSON (valid YAML)
    # to keep this pure string templating, no IFD.
    fleet.traefikRawRules."oidc-middlewares.yml" =
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
                Url = cfg.sso.issuerUrl;
                ClientId = "\${${envPrefix n}_CLIENT_ID}";
                ClientSecret = "\${${envPrefix n}_CLIENT_SECRET}";
                UsePkce = true;
              };
              Scopes = [
                "openid"
                "profile"
                "email"
                "groups"
                # offline_access → refresh token, so the plugin renews access tokens
                # server-side (no id.* redirect / passkey) for the full 24h Pocket
                # ID session; without it re-auth is forced ~hourly at token expiry.
                "offline_access"
              ];
              # Always redirect unauthenticated requests to Pocket ID instead
              # of 401'ing AJAX (the plugin can't tell XHR from page loads;
              # Auto's 401 shows as an "Unauthorized" screen on SPA reloads
              # after logout). Safe for apps whose machine paths are bypassed
              # (`authBypassRule`), since only their top-level documents hit
              # the gate; an app without one gets a redirect on an expired
              # XHR instead of a 401.
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
          // lib.mapAttrs' (
            # Companion strippers: drop client-supplied copies of each
            # identity header BEFORE the oidc middleware runs, so bypassed
            # (API/ping) requests can't spoof the trusted header.
            _: w:
            lib.nameValuePair (lib.removeSuffix "@file" w.stripMiddleware) {
              headers.customRequestHeaders = lib.mapAttrs (_: _: "") w.authHeaders;
            }
          ) (lib.filterAttrs (_: w: w.stripMiddleware != null) cfg.webApps);
      };

    # Dashboard / API — `api@internal` serves /api/* and /dashboard/*.
    # A regular webApp: Pocket ID gate, LAN DNS entry, gatus probe
    # (/api/version is the harmless-unauthenticated bypass path, so the
    # probe certifies the dashboard, not the IdP).
    fleet.webApps.traefik-dashboard = {
      # The conventional label for the proxy's own dashboard; a host that
      # wants another defines `fleet.webApps.traefik-dashboard.hostname`.
      hostname = lib.mkDefault "traefik.${cfg.baseDomain}";
      traefikService = "api@internal";
      auth = "oidc";
      healthPath = "/api/version";
    };
    # Consent screen and Pocket ID's My Apps page.
    fleet.ssoClients.traefik-dashboard = {
      displayName = "Traefik";
      description = "Reverse proxy — all *.${cfg.baseDomain} routes";
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
    # has one NIC, but restricting per-interface keeps any future second
    # interface (wireguard, etc.) off-limits by default.
    networking.firewall.interfaces.${config.fleet.lanInterface}.allowedTCPPorts =
      lib.optional pgwireEnabled 5432;

    fleet.prometheusScrapes = [
      {
        job_name = "traefik";
        # Prometheus joins traefik-net (see monitoring.nix) and reaches the
        # api@internal/metrics endpoint by container DNS.
        static_configs = [ { targets = [ "traefik:8080" ]; } ];
      }
    ];

    # Every published hostname on this box resolves through this container,
    # including daedalus's own — so the page that starts the update is behind
    # the thing being restarted, and a failure looks like the dashboard dying
    # rather than like a rebuild rolling back.
    fleet.imageUpdates.traefik.ceremony = "fronts every published hostname, including this page — a bad switch reads as the dashboard going down";

    virtualisation.oci-containers.containers = proofContainers // {
      traefik = mkRootlessContainer {
        image = pinnedImage "traefik" "docker.io/library/traefik";

        ports = [
          # Publishing these is load-bearing beyond LAN ingress: it installs
          # the DNAT rule inside the rootless network namespace that lets
          # CONTAINERS reach traefik at the LAN IP. Pi-hole answers every
          # `*.<baseDomain>` with the LAN address, and under pasta that address is
          # the namespace's own — so gatus's probes and traefik's own OIDC
          # discovery call resolve there and depend on this rule. Handing
          # traefik systemd-bound sockets instead (which would preserve real
          # client IPs in the access log) removes it and breaks both.
          "80:80"
          "443:443"
          # cfweb (:8888) is deliberately NOT host-published: cloudflared
          # dials it over traefik-net only, so the plain-HTTP entrypoint
          # that trusts X-Forwarded-* is unreachable from host processes
          # and non-bridge containers.
        ]
        ++ (lib.optional pgwireEnabled
          # postgres TCP entrypoint — SNI route for postgres.<baseDomain>.
          # TLS terminates here with the `*.<baseDomain>` wildcard; the
          # backend is plaintext postgres (`pg`) dialed over pg-wire-net.
          "5432:5432"
        );
        # Dashboard/metrics on :8080 reached via traefik-net only (no host port).

        volumes = [
          "${traefikRulesDir}:/rules:ro"
          "${oidcPlugin}:/plugins-local/src/github.com/sevensolutions/traefik-oidc-auth:ro"
          "${config.fleet.stateRoot}/traefik/acme.json:/acme.json"
          # No /var/log/traefik mount: both app + access logs go to stdout
          # (journald -> Loki). File logging is intentionally off so nothing
          # grows unbounded under <stateRoot>/traefik.
        ];

        environmentFiles = [
          config.sops.secrets."traefik-env".path
          # CF_DNS_API_TOKEN for lego's DNS-01: the box's one Cloudflare API
          # token, rendered from site/vault by the platform (site.nix).
          cfg.cloudflare.tokenEnvFile
        ]
        # Declarative clients (fleet.ssoClients, modules/pocket-id/clients.nix)
        # render their POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET} pair here instead
        # of living in env.sops. Hand-created clients keep theirs in env.sops;
        # the two sets are disjoint, and --env-file order only matters on a
        # name collision. null when no declarative client is forward-authed —
        # podman would fail on a path that was never rendered.
        ++ lib.optional (cfg.sso.clientEnvFile != null) cfg.sso.clientEnvFile
        # PROXY_PROOF_<N>, one per proxyProof app, for the proof-<n> middlewares.
        ++ lib.optional (proofApps != { }) traefikProofEnv;

        cmd = [
          "--api=true"
          "--api.dashboard=true"
          # No `--api.insecure`: that served /api on :8080 to every bridge
          # member. The API is routed there for `apiReaders` alone
          # (traefik-api.yml above); the public dashboard route stays behind
          # the Pocket ID gate.

          # Prometheus metrics. addRoutersLabels=true adds per-router labels
          # (small cardinality cost; fine at our scale).
          "--metrics.prometheus=true"
          "--metrics.prometheus.entryPoint=traefik"
          "--metrics.prometheus.addRoutersLabels=true"
          "--metrics.prometheus.addServicesLabels=true"
          "--metrics.prometheus.addEntryPointsLabels=true"

          # Entrypoints
          "--entrypoints.web.address=:80"
          "--entrypoints.websecure.address=:443"
          "--entrypoints.traefik.address=:8080"
          "--entrypoints.cfweb.address=:8888"

          # cloudflared dials cfweb from traefik-net; trust its
          # X-Forwarded-* (proto=https from the CF edge) or OIDC
          # middlewares build http:// redirect URIs and loop. Scoped to the
          # pinned traefik-net subnet (fleet.bridgeSubnets.traefik) so other
          # bridge members can't forge client IPs into cfweb routers.
          "--entrypoints.cfweb.forwardedHeaders.trustedIPs=${config.fleet.bridgeSubnets.traefik}"

          # In-process OIDC forward-auth plugin (vendored — see oidcPlugin).
          "--experimental.localPlugins.oidc.moduleName=github.com/sevensolutions/traefik-oidc-auth"
        ]
        ++ (lib.optional pgwireEnabled "--entrypoints.postgres.address=:5432")
        ++ [

          # Traefik v3's default readTimeout is 60s for a WHOLE request body, so a
          # registry push of one large layer slower than that is cut off mid-blob.
          # Box builds push to zot through this entrypoint (never the bridge); ten
          # minutes is headroom for the slowest layer, not a measured need — a
          # 1.5 GB layer took 6s on the LAN.
          "--entrypoints.websecure.transport.respondingTimeouts.readTimeout=600s"

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

          # Keep four request headers in the access log — traefik drops all
          # headers by default, so the allowlist below is the whole story.
          # Cf-Ipcountry is the only source of client geography anywhere on
          # this box. Cf-Connecting-Ip and X-Forwarded-For are the CF edge's
          # own assertion of the client IP: cfweb already resolves
          # ClientHost from them (forwardedHeaders.trustedIPs above), so
          # they are a cross-check rather than the only copy. User-Agent
          # fingerprints scanners. These feed the Security dashboard (uid
          # s2-security); LogQL sees them as request_Cf_Connecting_Ip /
          # request_Cf_Ipcountry / request_User_Agent (| json rewrites
          # dashes to underscores).
          "--accesslog.fields.headers.defaultmode=drop"
          "--accesslog.fields.headers.names.User-Agent=keep"
          "--accesslog.fields.headers.names.Cf-Connecting-Ip=keep"
          "--accesslog.fields.headers.names.Cf-Ipcountry=keep"
          "--accesslog.fields.headers.names.X-Forwarded-For=keep"

          # File provider — shallow watch, top-level *.yml only.
          "--providers.file.directory=/rules"
          "--providers.file.watch=true"

          # ACME — Cloudflare DNS challenge. One apex+wildcard pair covers
          # every published hostname (all one level under the apex).
          "--entrypoints.websecure.http.tls.certresolver=dns-cloudflare"
          "--entrypoints.websecure.http.tls.domains[0].main=${config.fleet.baseDomain}"
          "--entrypoints.websecure.http.tls.domains[0].sans=*.${config.fleet.baseDomain}"
          "--certificatesResolvers.dns-cloudflare.acme.storage=/acme.json"
          "--certificatesResolvers.dns-cloudflare.acme.email=acme@account.${cfg.baseDomain}"
          "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.provider=cloudflare"
          # Use CF's own resolvers — the LAN pi-hole can't see the freshly-
          # published _acme-challenge TXT before propagation.
          "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.resolvers=1.1.1.1:53,1.0.0.1:53"
          # 90s settle delay before lego polls — keeps us off LE's rate-limit.
          "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.propagation.delayBeforeChecks=90"
        ];

      };
    };
  };
}
