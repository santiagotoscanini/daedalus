# homepage — single-pane dashboard for the whole fleet (gethomepage.dev).
#
# Standalone, pasta networking. Each stack module contributes its
# tiles via `myStack.homepageServices`; this module renders them into
# a generated `services.yaml`. Homepage's `/app/config` is a writable
# host dir; the files WE care about (services + the 4 static configs)
# are layered on top as per-file read-only overlays. Anything else
# Homepage wants — the docker.yaml / kubernetes.yaml / proxmox.yaml
# skeleton stubs for integrations we don't use — Homepage auto-seeds
# into the writable host dir on first run. We don't track those.
#
# Why per-file overlays: a single read-only bind of /app/config
# breaks Homepage's "auto-copy from skeleton" startup step (it tries
# to write missing default files and fails with EROFS). Making the
# base dir writable + overlaying only the files we own is the
# cleanest middle ground: declarative for our config, runtime
# auto-seed for the rest, no zero-info stub files in nix.
#
# Secrets (per-service API keys, admin passwords) live in
# stacks/homepage/secrets/env as HOMEPAGE_VAR_* keys. Homepage
# substitutes `{{HOMEPAGE_VAR_FOO}}` placeholders in any of the
# rendered YAML files at read time, so the per-stack tile
# definitions reference placeholder strings (not actual secret
# values).
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
    # Writable host dir for /app/config. Homepage auto-seeds the
    # files we don't override (bookmarks fallback, docker.yaml,
    # kubernetes.yaml, proxmox.yaml, custom.js) into it on first run.
    "d /home/santiago/selfhost/homepage/config 0755 santiago users -"
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
      # Writable host base — Homepage owns this dir; auto-seeds any
      # file it expects but we don't pin. Logs land in logs/.
      "/home/santiago/selfhost/homepage/config:/app/config:rw"

      # Per-file RO overlays — the bits WE keep declarative.
      "${servicesYaml}:/app/config/services.yaml:ro"
      "${./assets/settings.yaml}:/app/config/settings.yaml:ro"
      "${./assets/widgets.yaml}:/app/config/widgets.yaml:ro"
      "${./assets/bookmarks.yaml}:/app/config/bookmarks.yaml:ro"
      "${./assets/custom.css}:/app/config/custom.css:ro"
    ];

    environment = {
      # Reverse-proxy host-header allow-list. Comma-separated, no
      # spaces. Localhost is always implicitly allowed.
      HOMEPAGE_ALLOWED_HOSTS = "homepage.s2.toscanini.me";
    };

    # HOMEPAGE_VAR_* placeholders referenced from services.yaml — see
    # stacks/homepage/secrets/env for the full list and where to find
    # each value.
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
