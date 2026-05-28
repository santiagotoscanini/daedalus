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
# Opens host TCP 80/443 (LAN HTTPS ingress) + 8888 (cfweb entrypoint
# for cloudflared, bound but not firewall-opened — internal only).
# The dashboard on :8080 is reached over traefik-net, not host-published.

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  cfg = config.myStack;

  # Activates the postgres TCP entrypoint, container port-publish,
  # firewall rule, and shared bridge attach only when at least one
  # stack declares a TCP route. See myStack.tcpRoutes in
  # platform/common.nix and stacks/apps/apps.nix for emitters.
  pgwireEnabled = cfg.tcpRoutes != { };

  # TCP YAML route — TLS terminates at traefik using the shared
  # *.toscanini.me wildcard cert (issued at entrypoint level for
  # websecure; the certResolver is shared across entrypoints). The
  # backend connection is plaintext postgres on the per-app bridge.
  mkTraefikTCPRouteContent = name: route: ''
    # Auto-generated from myStack.tcpRoutes.${name}.
    # TCP router for SNI-based routing on the postgres entrypoint.
    # `pg-tls@file` advertises the `postgresql` ALPN protocol so
    # direct-TLS clients (libpq 17+ / pgjdbc 42.7+) succeed instead of
    # getting `tlsv1 alert no application protocol`. The TLS options
    # are defined in stacks/traefik/assets/tls-opts.yml.
    tcp:
      routers:
        ${name}-tcp-rtr:
          entryPoints: [ postgres ]
          rule: "HostSNI(`${route.hostname}`)"
          service: ${name}-tcp-svc
          tls:
            certResolver: dns-cloudflare
            options: pg-tls@file
            domains:
              - main: "toscanini.me"
                sans:
                  - "*.toscanini.me"
      services:
        ${name}-tcp-svc:
          loadBalancer:
            servers:
              - address: "${route.serviceUrl}"
  '';

  mkTraefikRouteContent = name: route:
    let
      entry = route.entrypoint or "websecure";
      needsTls = entry == "websecure";
      hasCert  = route.certMain != null;
      upstreamUrl = route.serviceUrl;
      # tlsLine is substituted at the position marked `${tlsLine}  services:`
      # — must end with a newline AND include its own leading whitespace
      # (the template dedent strips 6 columns; we re-add).
      tlsLine =
        if !needsTls then ""
        else if !hasCert then
          "      tls: { options: tls-opts@file }\n"
        else
          let
            sansBlock = lib.concatMapStringsSep "\n"
              (s: "              - \"${s}\"")
              route.certSans;
          in
            "      tls:\n"
            + "        options: tls-opts@file\n"
            + "        certResolver: dns-cloudflare\n"
            + "        domains:\n"
            + "          - main: \"${route.certMain}\"\n"
            + "            sans:\n"
            + sansBlock + "\n";
    in ''
      # Auto-generated from myStack.traefikRoutes.${name}.
      # Edit the attrset (in the owning stack's module), not this file
      # (it lives in /nix/store, read-only).
      http:
        routers:
          ${name}-rtr:
            entryPoints: [ ${entry} ]
            rule: "Host(`${route.host}`)"
            service: ${name}-svc
      ${tlsLine}  services:
          ${name}-svc:
            loadBalancer:
              servers:
                - url: "${upstreamUrl}"
    '';

  # Use runCommand+cp (not symlinkJoin) so $out contains real files.
  # /rules bind mount doesn't include /nix/store; symlinks would dangle
  # and the inotify watcher errors out.
  traefikRulesDir = pkgs.runCommand "traefik-rules" { } (''
    mkdir -p $out
  '' + lib.concatStringsSep "\n" (
    (lib.mapAttrsToList (name: route:
      "cp ${pkgs.writeText "${name}.yml" (mkTraefikRouteContent name route)} $out/${name}.yml"
    ) cfg.traefikRoutes)
    ++
    (lib.mapAttrsToList (filename: contents:
      "cp ${pkgs.writeText filename contents} $out/${filename}"
    ) cfg.traefikStaticRules)
    ++
    (lib.mapAttrsToList (name: route:
      "cp ${pkgs.writeText "${name}-tcp.yml" (mkTraefikTCPRouteContent name route)} $out/${name}-tcp.yml"
    ) cfg.tcpRoutes)
  ));
in
{
  myStack.containerNetworks.traefik = "traefik";

  # Static rules that don't fit the Host->port shape. Each stack reads
  # its own asset and contributes here (e.g. nextcloud's dual-router
  # rule lives in stacks/nextcloud/).
  myStack.traefikStaticRules = {
    "tls-opts.yml"          = builtins.readFile ./assets/tls-opts.yml;
    "traefik-dashboard.yml" = builtins.readFile ./assets/dashboard-rule.yml;
  };

  # Opens TCP 80/443 — LAN HTTPS ingress.
  networking.firewall.allowedTCPPorts = [ 80 443 ];

  # Opens TCP 5432 ONLY on the LAN interface, only when a TCP route is
  # declared (postgres SNI routing). Belt-and-suspenders: the box only
  # has enp3s0, but restricting per-interface keeps any future second
  # interface (wireguard, etc.) off-limits by default.
  networking.firewall.interfaces.enp3s0.allowedTCPPorts =
    lib.optional pgwireEnabled 5432;

  myStack.dnsHosts = [ "192.168.0.2 traefik.toscanini.me" ];

  myStack.prometheusScrapes = [{
    job_name = "traefik";
    # Prometheus joins traefik-net (see monitoring.nix) and reaches the
    # api@internal/metrics endpoint by container DNS.
    static_configs = [{ targets = [ "traefik:8080" ]; }];
  }];

  myStack.homepageServices."Network" = [{
    name = "Traefik";
    href = "https://traefik.toscanini.me";
    description = "Reverse proxy — all *.s2 / *.toscanini routes";
    icon = "traefik.png";
    siteMonitor = "https://traefik.toscanini.me";
    widget = {
      type = "traefik";
      url  = "https://traefik.toscanini.me";
    };
  }];

  virtualisation.oci-containers.containers.traefik = mkRootlessContainer {
    image = "docker.io/library/traefik:v3.6";

    ports = [
      "80:80"
      "443:443"
      # cfweb — plain HTTP for the Cloudflare tunnel; CF terminates TLS
      # at the edge so a 443 hop would mean double-TLS.
      "8888:8888"
    ] ++ (lib.optional pgwireEnabled
      # postgres TCP entrypoint — SNI-routed per-app pg-<name>.toscanini.me.
      # TLS terminates here using *.toscanini.me. Backend is plaintext
      # postgres on db-exporter-net (where every pg-<name> lives too).
      "5432:5432");
    # Dashboard/metrics on :8080 reached via traefik-net only (no host port).

    volumes = [
      "${traefikRulesDir}:/rules:ro"
      "/home/santiago/selfhost/traefik/acme.json:/acme.json"
      "/home/santiago/selfhost/traefik/logs:/var/log/traefik"
    ];

    # CF_API_TOKEN — Cloudflare DNS-01 ACME challenge. Mode 0600,
    # santiago:users. TODO: migrate to sops-nix.
    environmentFiles = [
      "/etc/nixos/stacks/traefik/secrets/env"
    ];

    cmd = [
      "--api=true"
      "--api.dashboard=true"

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
    ] ++ (lib.optional pgwireEnabled
      "--entrypoints.postgres.address=:5432"
    ) ++ [

      "--entrypoints.websecure.http.tls=true"
      "--entrypoints.websecure.http.tls.options=tls-opts@file"
      "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      "--entrypoints.web.http.redirections.entrypoint.permanent=true"

      "--log=true"
      "--log.level=DEBUG"

      # File provider — shallow watch, top-level *.yml only.
      "--providers.file.directory=/rules"
      "--providers.file.watch=true"

      # ACME — Cloudflare DNS challenge.
      "--entrypoints.websecure.http.tls.certresolver=dns-cloudflare"
      "--entrypoints.websecure.http.tls.domains[0].main=s2.toscanini.me"
      "--entrypoints.websecure.http.tls.domains[0].sans=*.toscanini.me"
      "--entrypoints.websecure.http.tls.domains[1].main=toscanini.me"
      "--entrypoints.websecure.http.tls.domains[1].sans=*.toscanini.me"
      "--certificatesResolvers.dns-cloudflare.acme.storage=/acme.json"
      "--certificatesResolvers.dns-cloudflare.acme.email=nextcloud@account.toscanini.me"
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.provider=cloudflare"
      # Use CF's own resolvers — the LAN pi-hole can't see the freshly-
      # published _acme-challenge TXT before propagation.
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.resolvers=1.1.1.1:53,1.0.0.1:53"
      # 90s settle delay before lego polls — keeps us off LE's rate-limit.
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.delayBeforeCheck=90"
    ];

    extraOptions = [
      "--security-opt=no-new-privileges:true"
      "--network=traefik-net"
    ] ++ (lib.optional pgwireEnabled
      # db-exporter-net is the shared bridge where every pg-<name>
      # container also lives (see stacks/app-db/exporter.nix). Traefik
      # uses it to reach pg-<name>:5432 after SNI-routing a postgres
      # TCP connection. Bridge only exists when ≥1 app uses postgres.
      "--network=db-exporter-net"
    );
  };
}
