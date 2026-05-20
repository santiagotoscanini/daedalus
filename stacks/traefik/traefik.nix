# traefik — reverse proxy for the whole fleet + the rule generator
# that turns `myStack.traefikRoutes` (defined by per-stack modules)
# into one YAML file per route in a /nix/store-backed directory
# bind-mounted into the container.
#
# Workaround context for `Type=oneshot`: the oci-containers module
# ships `Type=notify`, which doesn't survive the rootless + system-
# unit boundary (User=santiago in a system unit + podman run -d
# detached means systemd sees the parent exit before READY=1 arrives,
# and conmon migrates into the user cgroup hierarchy). modules/common.nix
# overrides every podman-<name>.service to Type=oneshot +
# RemainAfterExit=true — that override applies to traefik via
# myStack.containerNetworks.traefik = null below.
#
# Trade-off: systemd no longer detects mid-life container crashes;
# the unit stays `active (exited)` while the container is dead.
# Acceptable for traefik (very stable image); a follow-up health-
# watcher timer could close that gap if needed.

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  cfg = config.myStack;

  mkTraefikRouteContent = name: route:
    let
      entry = route.entrypoint or "websecure";
      needsTls = entry == "websecure";
      hasCert  = route.certMain != null;
      # tlsLine is substituted into the template at the position
      # marked `${tlsLine}  services:` — so it must end with a newline
      # AND its own contents already include any leading whitespace
      # they need (the template dedent has already taken 6 columns
      # off, so anything we want at YAML column N starts with N spaces
      # in the string).
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
                - url: "http://host.containers.internal:${toString route.port}"
    '';

  # Use runCommand+cp (not symlinkJoin) so $out contains real files,
  # not symlinks into /nix/store. The traefik container's bind mount
  # of /rules doesn't include /nix/store, so symlinks would dangle and
  # the file provider's inotify watcher errors out ("no such file or
  # directory" when adding the watch).
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
  ));
in
{
  myStack.containerNetworks.traefik = null;

  # Static rules that don't fit the simple Host->port shape — content
  # lives at /etc/nixos/containers/<stack>/*.yml (same convention as
  # containers/litellm/config.yaml). Nix reads each file at eval time
  # via builtins.readFile, then the runCommand below copies them into
  # the /nix/store-backed /rules dir bind-mounted into traefik.
  # The `nextcloud.yml` static rule lives in modules/nextcloud.nix,
  # declared alongside the nextcloud-app container.
  myStack.traefikStaticRules = {
    "tls-opts.yml"          = builtins.readFile ./assets/tls-opts.yml;
    "traefik-dashboard.yml" = builtins.readFile ./assets/dashboard-rule.yml;
  };


  myStack.dnsHosts = [ "192.168.0.2 traefik.toscanini.me" ];

  myStack.prometheusScrapes = [{
    job_name = "traefik";
    static_configs = [{ targets = [ "host.containers.internal:9080" ]; }];
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
      # cfweb entrypoint — plain HTTP for the Cloudflare tunnel
      # (cloudflared dials traefik on :8888 because Cloudflare
      # terminates TLS at the edge and a 443 hop would mean double-TLS).
      "8888:8888"
      # Internal API + Prometheus metrics. Loopback-only so the
      # dashboard and /metrics aren't reachable from the LAN —
      # Prometheus scrapes via host.containers.internal:8080.
      "9080:8080"
    ];

    volumes = [
      # Rules dir is generated from nix above. The legacy
      # /home/santiago/selfhost/traefik/rules/ tree is no longer used.
      "${traefikRulesDir}:/rules:ro"
      "/home/santiago/selfhost/traefik/acme.json:/acme.json"
      "/home/santiago/selfhost/traefik/logs:/var/log/traefik"
    ];

    # CF_API_TOKEN — used by Traefik's Cloudflare DNS challenge for
    # ACME. Mode 0600, santiago:users (the systemd unit runs as
    # santiago). TODO: migrate to sops-nix.
    environmentFiles = [
      "/etc/nixos/stacks/traefik/secrets/env"
    ];

    cmd = [
      # --global.checkNewVersion (default true) and
      # --global.sendAnonymousUsage (default false) are at their
      # defaults, so they're omitted.
      "--api=true"
      "--api.dashboard=true"

      # Prometheus metrics on the traefik entrypoint (:8080).
      # `addRoutersLabels=true` adds per-router labels so we can break
      # down requests by route. Slight cardinality cost; fine at our
      # scale.
      "--metrics.prometheus=true"
      "--metrics.prometheus.entryPoint=traefik"
      "--metrics.prometheus.addRoutersLabels=true"
      "--metrics.prometheus.addServicesLabels=true"
      "--metrics.prometheus.addEntryPointsLabels=true"

      # Entrypoints (ports)
      "--entryPoints.web.address=:80"
      "--entrypoints.websecure.address=:443"
      "--entrypoints.traefik.address=:8080"
      # Cloudflare entrypoint (avoids HTTP <-> HTTPS redirect loops
      # when CF does TLS termination upstream).
      "--entrypoints.cfweb.address=:8888"

      # TLS on websecure with tls-opts from /rules.
      "--entrypoints.websecure.http.tls=true"
      "--entrypoints.websecure.http.tls.options=tls-opts@file"
      # HTTP -> HTTPS permanent redirect.
      "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      "--entrypoints.web.http.redirections.entrypoint.permanent=true"

      "--log=true"
      "--log.level=DEBUG"

      # File provider (loads /rules/*.yml). `--providers.file.watch`
      # is shallow: only top-level *.yml files in /rules are picked
      # up; subdirectories are ignored.
      "--providers.file.directory=/rules"
      "--providers.file.watch=true"

      # ACME certresolver — Cloudflare DNS challenge.
      "--entrypoints.websecure.http.tls.certresolver=dns-cloudflare"
      "--entrypoints.websecure.http.tls.domains[0].main=s2.toscanini.me"
      "--entrypoints.websecure.http.tls.domains[0].sans=*.toscanini.me"
      "--entrypoints.websecure.http.tls.domains[1].main=toscanini.me"
      "--entrypoints.websecure.http.tls.domains[1].sans=*.toscanini.me"
      "--certificatesResolvers.dns-cloudflare.acme.storage=/acme.json"
      "--certificatesResolvers.dns-cloudflare.acme.email=nextcloud@account.toscanini.me"
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.provider=cloudflare"
      # Use Cloudflare's own resolvers for the DNS-01 challenge — the
      # LAN pi-hole can't see the freshly-published _acme-challenge
      # TXT before propagation, so a `local` resolver would time out.
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.resolvers=1.1.1.1:53,1.0.0.1:53"
      # 90s settle delay before lego polls for the TXT record — keeps
      # us off the Let's Encrypt rate-limit list during renewal storms.
      "--certificatesResolvers.dns-cloudflare.acme.dnsChallenge.delayBeforeCheck=90"
    ];

    extraOptions = [
      "--security-opt=no-new-privileges:true"
    ];
  };
}
