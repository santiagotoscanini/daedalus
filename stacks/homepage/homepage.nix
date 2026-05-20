# homepage — single-pane dashboard for the whole fleet (gethomepage.dev).
#
# Standalone, pasta networking. Each stack module contributes its
# tiles via `myStack.homepageServices`; this module renders them into
# a generated `services.yaml`, combines it with the static support
# files under stacks/homepage/assets/ (bookmarks, widgets, settings,
# custom.css/js, docker/kubernetes/proxmox stubs), and bind-mounts
# the resulting /nix/store directory read-only into the container.
#
# Read-only config dir + writable logs subdir: homepage writes only
# to /app/config/logs at runtime, so we bind that as a separate rw
# host path on top of the read-only config dir.
#
# Secrets (per-service API keys, admin passwords) live in
# /etc/nixos/containers/homepage/env as HOMEPAGE_VAR_* keys. Homepage
# substitutes `{{HOMEPAGE_VAR_FOO}}` placeholders in the rendered
# YAML at read time, so the per-stack tile definitions reference
# placeholder strings (not actual secret values).
#
# HOMEPAGE_ALLOWED_HOSTS gates the proxy against host-header attacks
# (defense in depth; Traefik routes by host already). localhost:3000
# and 127.0.0.1:3000 are always implicitly allowed.

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Render `myStack.homepageServices` into homepage's services.yaml
  # shape: a top-level list of single-key attrsets (group → list of
  # services), where each service is itself a single-key attrset
  # (service name → properties). We carry `name` as a regular field
  # in nix for ergonomic merging and pull it out into the wrapper key
  # here at generation time. YAML is a JSON superset, so toJSON is
  # sufficient (avoids hand-rolled YAML escaping).
  servicesYaml = pkgs.writeText "services.yaml" (builtins.toJSON (
    lib.mapAttrsToList (groupName: services: {
      "${groupName}" = map
        (svc: { "${svc.name}" = removeAttrs svc [ "name" ]; })
        services;
    }) config.myStack.homepageServices
  ));

  # Combine the generated services.yaml with the static config files
  # in /etc/nixos/stacks/homepage/assets/. The empty `logs/` subdir
  # is the bind-mount target for the writable logs volume below — it
  # must exist in the read-only base for the overlay bind to land.
  homepageConfig = pkgs.runCommand "homepage-config" { } ''
    mkdir -p $out
    cp -r ${./assets}/. $out/
    cp ${servicesYaml} $out/services.yaml
    mkdir -p $out/logs
  '';
in

{
  myStack.containerNetworks.homepage = null;
  myStack.traefikRoutes.homepage = {
    host = "homepage.s2.toscanini.me";
    port = 3001;
  };

  # Pi-hole DNS entry and homepage's own tile come through the same
  # `myStack.*` options that every other stack uses — homepage is
  # not special. (The tile here is the dashboard's link to itself,
  # which is useful when bookmarked elsewhere.)
  myStack.dnsHosts = [
    "192.168.0.2 homepage.s2.toscanini.me"
  ];


  # External / ambient network links — not tied to any container, so
  # they live in homepage.nix itself rather than a stack module.
  myStack.homepageServices."Network" = [
    {
      name = "Router";
      href = "http://192.168.0.1/webpages/index.html?t=eb9856ea#networkMap";
      description = "LAN router admin (192.168.0.1)";
      icon = "mdi-router-network-#38bdf8";
      siteMonitor = "http://192.168.0.1/";
    }
    {
      name = "Cloudflare DNS";
      href = "https://dash.cloudflare.com/c08bf36c41d7bc5db11d6b35e0b4e721/toscanini.me/dns/records";
      description = "DNS records for toscanini.me";
      icon = "cloudflare.png";
    }
    {
      name = "Namecheap";
      href = "https://ap.www.namecheap.com/Domains/DomainControlPanel/toscanini.me/advancedns";
      description = "Domain registrar — toscanini.me";
      icon = "namecheap.png";
    }
    {
      name = "ProtonVPN";
      href = "https://account.protonvpn.com/downloads";
      description = "Re-export WireGuard config when gluetun peers fail";
      icon = "proton-vpn.png";
    }
  ];

  systemd.tmpfiles.rules = [
    # Writable logs dir — homepage's winston logger writes here.
    "d /home/santiago/selfhost/homepage/logs 0755 santiago users -"
  ];

  virtualisation.oci-containers.containers.homepage = mkRootlessContainer {
    # Pin to the current upstream stable release. Bump intentionally —
    # the YAML schema has occasionally added required fields (e.g. the
    # pihole v6 / immich v2 / wgeasy v2 widget `version:` keys).
    image = "ghcr.io/gethomepage/homepage:v1.13.1";

    # 3001 host -> 3000 container (homepage is Next.js, internal :3000;
    # host :3000 is grafana).
    ports = [ "3001:3000" ];

    volumes = [
      # Generated config dir (services.yaml + static files), read-only.
      "${homepageConfig}:/app/config:ro"
      # Writable overlay for the runtime log dir.
      "/home/santiago/selfhost/homepage/logs:/app/config/logs:rw"
    ];

    environment = {
      # Reverse-proxy host-header allow-list. Comma-separated, no
      # spaces. Localhost is always implicitly allowed.
      HOMEPAGE_ALLOWED_HOSTS = "homepage.s2.toscanini.me";
    };

    # HOMEPAGE_VAR_* placeholders referenced from services.yaml — see
    # /etc/nixos/containers/homepage/env for the full list and where
    # to find each value.
    extraOptions = [
      # Map traefik.s2.toscanini.me to the pasta gateway so the
      # traefik widget can reach the api@internal router (which is
      # only served on websecure with the right Host header). The
      # wildcard cert covers this name so TLS validates.
      "--add-host=traefik.s2.toscanini.me:host-gateway"
      # Same trick for Nextcloud — its `NC_overwriteprotocol = "https"`
      # turns every plain-HTTP request from host.containers.internal into
      # a 30x redirect to https://nextcloud.toscanini.me, which homepage's
      # proxy cannot follow (http -> https redirects are forbidden). Map
      # the FQDN to the pasta gateway so the widget can hit it directly
      # over HTTPS (wildcard cert covers *.toscanini.me).
      "--add-host=nextcloud.toscanini.me:host-gateway"
      # Same trick for NZBGet — homepage's widget uses an undici-based
      # HTTP client that ECONNRESETs on the `Connection: close` response
      # NZBGet emits. Going through traefik gets keep-alive on the
      # client-facing side, sidestepping the bug.
      "--add-host=nzbget.s2.toscanini.me:host-gateway"
      # Pi-hole `/` ping + qBittorrent widget both hit the same
      # undici quirks. Route through traefik like the others above.
      "--add-host=pihole.s2.toscanini.me:host-gateway"
      "--add-host=qbittorrent.s2.toscanini.me:host-gateway"
    ];

    environmentFiles = [
      "/etc/nixos/stacks/homepage/secrets/env"
    ];
  };
}
