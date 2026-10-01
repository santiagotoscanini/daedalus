# platform/publishing.nix — the materialization of the fleet's "publish this
# service" layer (declared in platform/publishing-options.nix): each webApp
# into routes, DNS entries, tunnel CNAMEs, probes and scrapes, and the
# assertions that keep those combinations coherent. The routed half of
# `isolated` is platform/isolation.nix.
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

  # Resolve a webApp's upstream URL from whichever input is set (the
  # exactly-one assertion below enforces the shape); named-service
  # apps (`traefikService`) have no URL.
  resolveUrl =
    w: if w.serviceName != null then "http://${w.serviceName}:${toString w.port}" else w.serviceUrl;
in
{
  config = {
    # The publish registry, as daedalus renders it: the full per-webApp
    # record (upstream included, so no page has to hardcode a host port),
    # the taken-hostname list for the live collision check, and the
    # router-forwarded direct ingress. The dashboard reads
    # /export/publishing.json; see platform/export.nix.
    fleet.export.domains.publishing.data = {
      webApps = lib.mapAttrs (_: w: {
        inherit (w)
          hostname
          port
          serviceName
          serviceUrl
          exposeRemotely
          auth
          healthPath
          isolated
          aliases
          ;
      }) cfg.webApps;
      takenHostnames = lib.sort (a: b: a < b) (
        lib.concatLists (lib.mapAttrsToList (_: w: [ w.hostname ] ++ w.aliases) cfg.webApps)
      );
      directIngress = lib.mapAttrsToList (name: v: {
        inherit name;
        inherit (v) port proto note;
      }) cfg.directIngress;
    };

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
            extraHosts = w.aliases;
            middlewares =
              lib.optional w.proxyProof "proof-${n}@file"
              ++ lib.optional (w.auth == "oidc" && w.authHeaders != { }) "oidc-${n}-strip@file"
              ++ lib.optional (w.auth == "oidc") "oidc-${n}@file"
              ++ w.extraMiddlewares;
          }
          // (
            if w.traefikService != null then { service = w.traefikService; } else { serviceUrl = resolveUrl w; }
          );
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
        assertion = w.proxyProof -> w.serviceName != null;
        message = "fleet.webApps.${n}: `proxyProof` needs `serviceName` — the proof is rendered into that container's environment.";
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
            keys = lib.concatLists (
              lib.mapAttrsToList (
                _: r: map (h: "${r.entrypoint}:${h}") ([ r.host ] ++ r.extraHosts)
              ) cfg.traefikRoutes
            );
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
      }) cfg.webApps)
      ++ (lib.mapAttrsToList (n: w: {
        assertion = lib.all (
          h:
          h != w.hostname
          &&
            builtins.match "[a-z0-9]([a-z0-9-]*[a-z0-9])?\\.${lib.replaceStrings [ "." ] [ "\\." ] cfg.baseDomain}" h
            != null
        ) w.aliases;
        message = ''
          fleet.webApps.${n}: every alias must differ from `hostname` and be
          exactly one label under ${cfg.baseDomain} — the wildcard
          certificate matches one label only.
        '';
      }) cfg.webApps);

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

    fleet.dnsHosts = lib.concatLists (
      lib.mapAttrsToList (_: w: map (h: "${cfg.lanIp} ${h}") ([ w.hostname ] ++ w.aliases)) cfg.webApps
    );

    fleet.cloudflareRoutes =
      let
        remote = lib.filterAttrs (_: w: w.exposeRemotely) cfg.webApps;
      in
      lib.mapAttrs (_: w: { inherit (w) hostname; }) remote
      // lib.listToAttrs (
        lib.concatLists (
          lib.mapAttrsToList (
            n: w: lib.imap0 (i: h: lib.nameValuePair "${n}-alias-${toString i}" { hostname = h; }) w.aliases
          ) remote
        )
      );
  };
}
